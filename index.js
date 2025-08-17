import 'dotenv/config';

// Discord and HTTP libraries
import {
  Client,
  GatewayIntentBits,
  Partials,
  REST,
  Routes,
  SlashCommandBuilder,
  ChannelType,
  PermissionsBitField
} from 'discord.js';
import OpenAI from 'openai';
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { google } from 'googleapis';
// Import the entire gamedig module as a namespace. The CommonJS module does not
// provide a default export, so using `import * as Gamedig` avoids a runtime
// SyntaxError in Node ESM.
import * as Gamedig from 'gamedig';

/*
 * SGServers Discord Bot
 *
 * Rewritten to replace a truncated original file. Implements:
 * - ask / ask-pro commands using OpenAI
 * - report and reply-ferox commands
 * - language preferences, daily limits and logging
 * - status polling and announcements
 * - simple express server for Render
 */

// ========= Config =========
const ALLOWED_PRO_ROLES = ['admini', 'Community Helper', 'Mastercraft', 'Journeyman', 'Apprentice', 'Ramshackle'];
const OWNER_ID = process.env.OWNER_DISCORD_ID || '';
const MODELS = { ASK: 'gpt-4o-mini', PRO: 'gpt-4o' };
const LIMITS = { GLOBAL_PER_DAY: 50, USER_PER_DAY: 5, ELEVATED_PER_DAY: 20 };

// ========= Helpers =========
function isBillingInactiveError(err) {
  return (
    err?.code === 'billing_not_active' ||
    err?.error?.code === 'billing_not_active' ||
    (err?.status === 429 && /billing/i.test(err?.error?.message || err?.message || ''))
  );
}
async function safeReply(interaction, content, ephemeral = true) {
  try {
    if (interaction.deferred) return interaction.editReply(content);
    if (interaction.replied) return interaction.followUp({ content, ephemeral });
    return interaction.reply({ content, ephemeral });
  } catch (e) {
    console.error('safeReply', e);
  }
}

// ========= OpenAI =========
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
async function askLLM(model, system, user) {
  const r = await openai.chat.completions.create({
    model,
    temperature: 0.4,
    max_tokens: 600,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user }
    ]
  });
  return { text: r.choices?.[0]?.message?.content?.trim() || 'No response.', usage: r.usage };
}

// ========= Limits (in-memory) =========
const userDaily = new Map();
let globalDayKey = new Date().toISOString().slice(0, 10);
let globalUsed = 0;
function dayKeyNow() { return new Date().toISOString().slice(0, 10); }
function resetIfNewDay() {
  const k = dayKeyNow();
  if (k !== globalDayKey) {
    globalDayKey = k;
    globalUsed = 0;
    userDaily.clear();
  }
}
function canUse(userId, elevated = false, isOwnerHelper = false) {
  resetIfNewDay();
  if (isOwnerHelper) return { ok: true };
  if (globalUsed >= LIMITS.GLOBAL_PER_DAY) return { ok: false, reason: 'global' };
  const e = userDaily.get(userId) || { used: 0, usedPro: 0 };
  const per = elevated ? LIMITS.ELEVATED_PER_DAY : LIMITS.USER_PER_DAY;
  const used = elevated ? e.usedPro : e.used;
  if (used >= per) return { ok: false, reason: 'user' };
  return { ok: true };
}
function consume(userId, elevated = false, isOwnerHelper = false) {
  if (isOwnerHelper) return;
  globalUsed++;
  const e = userDaily.get(userId) || { used: 0, usedPro: 0 };
  if (elevated) e.usedPro++; else e.used++;
  userDaily.set(userId, e);
}
function remainingFor(userId, elevated = false) {
  resetIfNewDay();
  const e = userDaily.get(userId) || { used: 0, usedPro: 0 };
  const per = elevated ? LIMITS.ELEVATED_PER_DAY : LIMITS.USER_PER_DAY;
  const used = elevated ? e.usedPro : e.used;
  return Math.max(0, per - used);
}

// ========= Logging =========
const LOG_DIR = path.join(process.cwd(), 'logs');
const LOG_FILE = path.join(LOG_DIR, 'usage.csv');
function ensureLogSetup() {
  try {
    if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR);
    const header = 'ts,guildId,channelId,userId,command,model,promptTokens,completionTokens,totalTokens,elevated,globalUsed,userUsed,userProUsed\n';
    if (!fs.existsSync(LOG_FILE)) fs.writeFileSync(LOG_FILE, header);
  } catch (e) {
    console.error('log setup', e);
  }
}
ensureLogSetup();
function csv(val) {
  if (val == null) return '""';
  const s = String(val).replaceAll('"', '""');
  return '"' + s + '"';
}
let sheetsClient = null;
async function getSheets() {
  if (sheetsClient) return sheetsClient;
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  const sheetId = process.env.GOOGLE_SHEETS_ID;
  if (!raw || !sheetId) return null;
  try {
    let creds;
    try { creds = JSON.parse(Buffer.from(raw, 'base64').toString('utf8')); }
    catch { creds = JSON.parse(raw); }
    const auth = new google.auth.JWT(creds.client_email, null, creds.private_key, ['https://www.googleapis.com/auth/spreadsheets']);
    await auth.authorize();
    const sheets = google.sheets({ version: 'v4', auth });
    sheetsClient = { sheets, sheetId };
    return sheetsClient;
  } catch (e) {
    console.error('sheets auth', e);
    return null;
  }
}
async function appendSheet(values) {
  const cli = await getSheets();
  if (!cli) return;
  try {
    await cli.sheets.spreadsheets.values.append({
      spreadsheetId: cli.sheetId,
      range: 'Usage!A1',
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [values] }
    });
  } catch (e) {
    console.error('sheets append', e);
  }
}
async function logToChannel(client, content) {
  const chanId = process.env.LOG_CHANNEL_ID;
  if (!chanId) return;
  try {
    const ch = await client.channels.fetch(chanId);
    await ch.send({ content });
  } catch (e) {
    console.error('log channel', e);
  }
}
async function logUsage({ client, ctx, command, model, usage, elevated }) {
  const ts = new Date().toISOString();
  const guildId = ctx.guild?.id || ctx.guildId || '';
  const channelId = ctx.channel?.id || ctx.channelId || '';
  const userId = ctx.user?.id || ctx.author?.id || '';
  const e = userDaily.get(userId) || { used: 0, usedPro: 0 };
  const row = [ts, guildId, channelId, userId, command, model, usage?.prompt_tokens || '', usage?.completion_tokens || '', usage?.total_tokens || '', elevated ? '1' : '0', globalUsed, e.used, e.usedPro].map(csv).join(',');
  try { fs.appendFileSync(LOG_FILE, row + '\n'); } catch (err) { console.error('csv write', err); }
  appendSheet([ts, guildId, channelId, userId, command, model, usage?.prompt_tokens || '', usage?.completion_tokens || '', usage?.total_tokens || '', elevated ? 1 : 0, globalUsed, e.used, e.usedPro]);
  logToChannel(client, `🧾 **Log** ${command} by <@${userId}> | model ${model} | tokens: ${usage?.total_tokens ?? '?' } | global ${globalUsed}/${LIMITS.GLOBAL_PER_DAY}`);
}

// ========= Language preference =========
const userLang = new Map();
function detectLang(text, userId) {
  const pref = userLang.get(userId);
  if (pref) return pref;
  return /[ąćęłńóśźż]/i.test(text) ? 'pl' : 'en';
}

// ========= Status =========
function parsePairs(env) {
  if (!env) return [];
  return env.split(',').map((s) => s.trim()).filter(Boolean).map((p) => {
    const [name, rest] = p.split('|');
    return { name: name?.trim() || rest, value: rest?.trim() || '' };
  });
}
function parseServerPairs(env) {
  if (!env) return [];
  return env.split(',').map((s) => s.trim()).filter(Boolean).map((p) => {
    const [nameRaw, restRaw] = p.split('|');
    const name = (nameRaw || '').trim();
    let right = (restRaw || '').trim();
    // Default type is ARK: Survival Evolved (GameDig id 'arkse'). We'll override
    // this based on parameters or the server name.
    let type = 'arkse';
    let hintType = null;
    // Check for semicolon parameters appended to the host:port part, e.g.
    // "ip:port;type=ase". Only the first part before the semicolon is the
    // host:port; subsequent parts are key=value parameters.
    if (right.includes(';')) {
      const parts = right.split(';').map((x) => x.trim()).filter(Boolean);
      right = parts[0];
      for (let i = 1; i < parts.length; i++) {
        const [k, v] = parts[i].split('=');
        if ((k || '').trim().toLowerCase() === 'type' && v) {
          hintType = v.trim().toLowerCase();
        }
      }
    }
    // If no explicit type provided, attempt to derive from the server name
    // (e.g. "DOX EASY (ASE)" => hintType = "ase").
    if (!hintType) {
      const match = name.match(/\(([^)]+)\)/);
      if (match) {
        hintType = match[1].trim().toLowerCase();
      }
    }
    if (hintType) {
      type = hintType;
    }
    // Normalize common synonyms. 'ase' and 'asa' both map to 'arkse'.
    if (type === 'ase' || type === 'asa') type = 'arkse';
    const [host, portStr] = right.split(':');
    const port = Number(portStr);
    return { name: name || right, host: (host || '').trim(), port, type };
  });
}
async function queryGame(type, host, port) {
  try {
    const r = await Gamedig.query({ type, host, port: Number(port) });
    const playerCount = Array.isArray(r.players) ? r.players.length : (r.players || 0);
    return { ok: true, name: r.name, map: r.map, players: playerCount, max: r.maxplayers || 0, ping: r.ping };
  } catch (e) { return { ok: false, error: String(e.message || e) }; }
}
async function queryHttp(url) {
  try {
    const res = await fetch(url, { method: 'GET' });
    const ok = res.status >= 200 && res.status < 400;
    return { ok, status: res.status };
  } catch (e) { return { ok: false, error: String(e.message || e) }; }
}
const lastStatus = new Map();
function iconForType(type) {
  const t = (type || '').toLowerCase();
  if (t === 'scum') return '🎯';
  if (t === 'arkse') return '🦖';
  return '🎮';
}
function iconForHttp() { return '🌐'; }
async function buildStatusSummary() {
  const serverDefs = parseServerPairs(process.env.STATUS_SERVERS);
  const httpDefs = parsePairs(process.env.STATUS_HTTP_URLS);
  const lines = [];
  for (const d of serverDefs) {
    if (!d.host || !d.port) { lines.push(`❔ **${d.name}** — invalid host/port`); continue; }
    const r = await queryGame(d.type || 'arkse', d.host, d.port);
    const icon = iconForType(d.type || 'arkse');
    if (r.ok) lines.push(`✅ ${icon} **${d.name}** — ${r.players}/${r.max} players, ping ${r.ping}ms`);
    else lines.push(`❌ ${icon} **${d.name}** — offline`);
    lastStatus.set(`game:${d.type}:${d.name}`, r.ok);
  }
  for (const d of httpDefs) {
    const r = await queryHttp(d.value);
    const icon = iconForHttp();
    if (r.ok) lines.push(`✅ ${icon} **${d.name}** — HTTP ${r.status}`);
    else lines.push(`❌ ${icon} **${d.name}** — HTTP ${r.status ?? 'error'}`);
    lastStatus.set(`http:${d.name}`, r.ok);
  }
  return lines.join('\n');
}
async function startAutoStatus() {
  const chanId = process.env.STATUS_CHANNEL_ID;
  if (!chanId) return;
  const postIfChanged = async () => {
    const chan = await client.channels.fetch(chanId);
    const before = new Map(lastStatus);
    const text = await buildStatusSummary();
    let changed = !before.size;
    for (const [k, v] of lastStatus) {
      if (before.get(k) !== v) { changed = true; break; }
    }
    if (changed) {
      await chan.send({ content: `📊 **Server status**\n${text}` });
    }
  };
  setTimeout(postIfChanged, 10000);
  setInterval(postIfChanged, 5 * 60 * 1000);
}

// ========= Announcements =========
function userHasAnnouncePerm(member) {
  try {
    return member.permissions.has(PermissionsBitField.Flags.ManageGuild) ||
           member.roles.cache.some(r => ALLOWED_PRO_ROLES.includes(r.name)) ||
           (member.roles.cache.some(r => r.name === 'Helper') && member.id === OWNER_ID);
  } catch { return false; }
}
function buildAnnouncement({ type, lang, title, when, details }) {
  const isPL = lang === 'pl';
  const lines = [];
  if (type === 'event') lines.push(isPL ? `🎉 **Wydarzenie**: ${title}` : `🎉 **Event**: ${title}`);
  else if (type === 'restart') lines.push(isPL ? `🔁 **Restart serwera**: ${title}` : `🔁 **Server restart**: ${title}`);
  else lines.push(isPL ? `🛠 **Aktualizacja**: ${title}` : `🛠 **Update**: ${title}`);
  if (when) lines.push(`🗓 ${when}`);
  if (details) { lines.push(''); lines.push(details); }
  return lines.join('\n');
}

// ========= Discord Client =========
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
  partials: [Partials.Channel]
});

// ========= Slash Commands =========
const commands = [
  new SlashCommandBuilder().setName('ask').setDescription('Ask the SGServers AI bot (gpt-4o-mini)').addStringOption(o => o.setName('message').setDescription('Your question').setRequired(true)),
  new SlashCommandBuilder().setName('ask-pro').setDescription('Ask the SGServers AI bot (gpt-4o)').addStringOption(o => o.setName('message').setDescription('Your question').setRequired(true)),
  new SlashCommandBuilder().setName('report').setDescription('Submit a server issue report to admins.').addStringOption(o => o.setName('title').setDescription('Short title').setRequired(true)).addStringOption(o => o.setName('details').setDescription('Describe the problem').setRequired(true)),
  new SlashCommandBuilder().setName('reply-ferox').setDescription('Post the prepared Ferox taming bug update for players.'),
  new SlashCommandBuilder().setName('set-lang').setDescription('Set your preferred language for bot responses.').addStringOption(o => o.setName('language').setDescription('pl or en').setRequired(true).addChoices({ name: 'Polski', value: 'pl' }, { name: 'English', value: 'en' })),
  new SlashCommandBuilder().setName('limits').setDescription('Show your remaining daily limits'),
  new SlashCommandBuilder().setName('status').setDescription('Show SGServers status (ARK/HTTP) now.'),
  new SlashCommandBuilder().setName('announce').setDescription('Post a templated announcement (PL/EN).')
    .addStringOption(o => o.setName('type').setDescription('Template type').setRequired(true).addChoices({ name: 'event', value: 'event' }, { name: 'update', value: 'update' }, { name: 'restart', value: 'restart' }))
    .addStringOption(o => o.setName('lang').setDescription('Language').setRequired(true).addChoices({ name: 'Polski', value: 'pl' }, { name: 'English', value: 'en' }))
    .addStringOption(o => o.setName('title').setDescription('Title').setRequired(true))
    .addStringOption(o => o.setName('when').setDescription('When? (optional)'))
    .addStringOption(o => o.setName('details').setDescription('Details (optional)'))
    .addChannelOption(o => o.setName('channel').setDescription('Target channel (optional)').addChannelTypes(ChannelType.GuildText))
].map(c => c.toJSON());

async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_BOT_TOKEN);
  const app = await client.application?.fetch();
  const appId = app?.id;
  if (!appId) throw new Error('Cannot determine application ID');
  await rest.put(Routes.applicationCommands(appId), { body: commands });
  console.log('✅ Slash commands registered globally.');
}

client.once('ready', async () => {
  console.log(`🤖 Logged in as ${client.user.tag}`);
  try { await registerCommands(); } catch (e) { console.error('Register commands', e); }
  try { startAutoStatus(); } catch (e) { console.error('auto-status', e); }
});

// ========= Interaction handler =========
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  try {
    // set-lang
    if (interaction.commandName === 'set-lang') {
      const lang = interaction.options.getString('language', true);
      userLang.set(interaction.user.id, lang);
      return interaction.reply({ content: lang === 'pl' ? '✅ Ustawiono język na **polski**.' : '✅ Language set to **English**.', ephemeral: true });
    }
    // limits
    if (interaction.commandName === 'limits') {
      resetIfNewDay();
      const member = await interaction.guild.members.fetch(interaction.user.id);
      const hasProRole = member.roles.cache.some(r => ALLOWED_PRO_ROLES.includes(r.name));
      const isOwnerHelper = member.roles.cache.some(r => r.name === 'Helper') && interaction.user.id === OWNER_ID;
      const remUser = remainingFor(interaction.user.id, false);
      const remPro = hasProRole ? remainingFor(interaction.user.id, true) : 0;
      const remGlobal = Math.max(0, LIMITS.GLOBAL_PER_DAY - globalUsed);
      const lines = [
        `Global left: **${remGlobal}/${LIMITS.GLOBAL_PER_DAY}**`,
        `Your /ask left: **${remUser}/${LIMITS.USER_PER_DAY}**`
      ];
      if (hasProRole) lines.push(`Your /ask-pro left: **${remPro}/${LIMITS.ELEVATED_PER_DAY}**`);
      if (isOwnerHelper) lines.push('(Helper bypass active)');
      return interaction.reply({ content: lines.join('\n'), ephemeral: true });
    }
    // status
    if (interaction.commandName === 'status') {
      await interaction.deferReply({ ephemeral: true });
      const text = await buildStatusSummary();
      return interaction.editReply(text || 'No status sources configured.');
    }
    // announce
    if (interaction.commandName === 'announce') {
      const member = await interaction.guild.members.fetch(interaction.user.id);
      if (!userHasAnnouncePerm(member)) {
        return interaction.reply({ content: '⛔ Brak uprawnień do ogłoszeń.', ephemeral: true });
      }
      const type = interaction.options.getString('type', true);
      const lang = interaction.options.getString('lang', true);
      const title = interaction.options.getString('title', true);
      const when = interaction.options.getString('when');
      const details = interaction.options.getString('details');
      const targetChannel = interaction.options.getChannel('channel') || (process.env.ANNOUNCE_CHANNEL_ID ? await interaction.client.channels.fetch(process.env.ANNOUNCE_CHANNEL_ID) : interaction.channel);
      const content = buildAnnouncement({ type, lang, title, when, details });
      await targetChannel.send({ content });
      return interaction.reply({ content: lang === 'pl' ? '✅ Ogłoszenie wysłane.' : '✅ Announcement sent.', ephemeral: true });
    }
    // report
    if (interaction.commandName === 'report') {
      const title = interaction.options.getString('title', true);
      const details = interaction.options.getString('details', true);
      const reportsChannelId = process.env.REPORTS_CHANNEL_ID;
      if (!reportsChannelId) {
        return interaction.reply({ content: '⚠️ Report channel is not configured.', ephemeral: true });
      }
      try {
        const reportsChannel = await interaction.client.channels.fetch(reportsChannelId);
        await reportsChannel.send({ content: `🚨 **New Report**\nTitle: ${title}\nDetails: ${details}\nReporter: <@${interaction.user.id}>` });
        return interaction.reply({ content: '✅ Zgłoszenie wysłane. Dzięki!', ephemeral: true });
      } catch (e) {
        console.error('report send', e);
        return interaction.reply({ content: '⚠️ Nie udało się wysłać zgłoszenia.', ephemeral: true });
      }
    }
    // reply-ferox
    if (interaction.commandName === 'reply-ferox') {
      const update = '🦖 **Ferox taming bug update**\nPL: Aktualizacja dotycząca błędu oswajania Feroxa została opublikowana. Sprawdź naszego Discorda lub patch notes, aby uzyskać więcej informacji.\nEN: The update regarding the Ferox taming bug has been published. Check our Discord or the patch notes for details.';
      await interaction.channel.send({ content: update });
      return interaction.reply({ content: '✅ Update posted.', ephemeral: true });
    }
    // ask / ask-pro
    if (interaction.commandName === 'ask' || interaction.commandName === 'ask-pro') {
      const isPro = interaction.commandName === 'ask-pro';
      const member = await interaction.guild.members.fetch(interaction.user.id);
      const hasProRole = member.roles.cache.some(r => ALLOWED_PRO_ROLES.includes(r.name));
      const isOwnerHelper = member.roles.cache.some(r => r.name === 'Helper') && interaction.user.id === OWNER_ID;
      if (isPro && !hasProRole && !isOwnerHelper) {
        return interaction.reply({ content: '⛔ Nie masz uprawnień do `/ask-pro`. Użyj `/ask`.', ephemeral: true });
      }
      const msg = interaction.options.getString('message', true);
      const lang = detectLang(msg, interaction.user.id);
      const system = lang === 'pl'
        ? (isPro ? 'Jesteś Lumenem, profesjonalnym pomocnikiem Discord SGServers. Odpowiadaj szczegółowo i precyzyjnie po polsku.' : 'Jesteś Lumenem, pomocnym asystentem Discord SGServers. Odpowiadaj krótko, po polsku, rzeczowo i przyjaźnie.')
        : (isPro ? 'You are Lumen, a professional assistant for the SGServers Discord. Answer thoroughly and precisely in English.' : 'You are Lumen, a helpful assistant for the SGServers Discord. Answer briefly, politely, and to the point in English.');
      const model = isPro ? MODELS.PRO : MODELS.ASK;
      const limit = canUse(interaction.user.id, isPro, isOwnerHelper);
      if (!limit.ok) {
        const reasonMsg = limit.reason === 'global' ? (lang === 'pl' ? 'Limit globalny wyczerpany.' : 'Global limit reached.') : (lang === 'pl' ? 'Twój limit został wykorzystany.' : 'Your personal limit has been reached.');
        return interaction.reply({ content: `⛔ ${reasonMsg}`, ephemeral: true });
      }
      await interaction.deferReply();
      try {
        const { text, usage } = await askLLM(model, system, msg);
        consume(interaction.user.id, isPro, isOwnerHelper);
        await logUsage({ client, ctx: interaction, command: interaction.commandName, model, usage, elevated: isPro });
        return interaction.editReply(text);
      } catch (e) {
        console.error('ask', e);
        if (isBillingInactiveError(e)) {
          return safeReply(interaction, lang === 'pl' ? '⚠️ Nasza subskrypcja OpenAI jest nieaktywna. Spróbuj ponownie później.' : '⚠️ Our OpenAI subscription is inactive. Please try again later.', true);
        }
        return safeReply(interaction, lang === 'pl' ? '⚠️ Wystąpił błąd podczas przetwarzania twojego zapytania.' : '⚠️ An error occurred while processing your request.', true);
      }
    }
  } catch (e) {
    console.error('interaction handler', e);
    try { await safeReply(interaction, '⚠️ An unexpected error occurred.', true); } catch (err) { console.error('error replying', err); }
  }
});

// ========= Start the bot and HTTP server =========
const app = express();
app.get('/', (req, res) => res.send('OK'));
const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`🌐 Express server listening on port ${port}`);
});
client.login(process.env.DISCORD_BOT_TOKEN).catch((e) => {
  console.error('Discord login failed', e);
});
