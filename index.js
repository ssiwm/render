import 'dotenv/config';
import { Client, GatewayIntentBits, Partials, REST, Routes, SlashCommandBuilder } from 'discord.js';
import OpenAI from 'openai';
import express from 'express';

// ========= Config =========
const ALLOWED_PRO_ROLES = ['admini', 'Community Helper', 'Mastercraft', 'Journeyman', 'Apprentice', 'Ramshackle'];
const OWNER_ID = process.env.OWNER_DISCORD_ID || '';
const MODELS = { ASK: 'gpt-4o-mini', PRO: 'gpt-4o' };
const LIMITS = { GLOBAL_PER_DAY: 50, USER_PER_DAY: 5, ELEVATED_PER_DAY: 20 };

// ========= OpenAI =========
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
async function askOpenAI(model, system, user) {
  const r = await openai.chat.completions.create({
    model,
    temperature: 0.4,
    max_tokens: 600,
    messages: [ { role: 'system', content: system }, { role: 'user', content: user } ]
  });
  return r.choices?.[0]?.message?.content?.trim() || 'No response.';
}

// ========= Limits (in-memory) =========
const userDaily = new Map(); // userId -> { used, usedPro }
let globalDayKey = new Date().toISOString().slice(0,10);
let globalUsed = 0;
function dayKeyNow(){ return new Date().toISOString().slice(0,10); }
function resetIfNewDay(){
  const k = dayKeyNow();
  if (k !== globalDayKey){ globalDayKey = k; globalUsed = 0; userDaily.clear(); }
}
function canUse(userId, elevated=false, isOwnerHelper=false){
  resetIfNewDay();
  if (isOwnerHelper) return { ok: true };
  if (globalUsed >= LIMITS.GLOBAL_PER_DAY) return { ok:false, reason:'global' };
  const e = userDaily.get(userId) || { used:0, usedPro:0 };
  const per = elevated ? LIMITS.ELEVATED_PER_DAY : LIMITS.USER_PER_DAY;
  const used = elevated ? e.usedPro : e.used;
  if (used >= per) return { ok:false, reason:'user' };
  return { ok:true };
}
function consume(userId, elevated=false, isOwnerHelper=false){
  if (isOwnerHelper) return;
  globalUsed++;
  const e = userDaily.get(userId) || { used:0, usedPro:0 };
  elevated ? e.usedPro++ : e.used++;
  userDaily.set(userId, e);
}
function remainingFor(userId, elevated=false){
  resetIfNewDay();
  const e = userDaily.get(userId) || { used:0, usedPro:0 };
  const per = elevated ? LIMITS.ELEVATED_PER_DAY : LIMITS.USER_PER_DAY;
  const used = elevated ? e.usedPro : e.used;
  return Math.max(0, per - used);
}

// ========= Language pref =========
const userLang = new Map(); // userId -> 'pl' | 'en'
function detectLang(text, userId){
  const pref = userLang.get(userId);
  if (pref) return pref;
  return /[ąćęłńóśźż]/i.test(text) ? 'pl' : 'en';
}

// ========= Discord Client =========
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
  partials: [Partials.Channel]
});

// ========= Slash Commands =========
const commands = [
  new SlashCommandBuilder().setName('ask').setDescription('Ask the SGServers AI bot (gpt-4o-mini)').addStringOption(o=>o.setName('message').setDescription('Your question').setRequired(true)),
  new SlashCommandBuilder().setName('ask-pro').setDescription('Ask the SGServers AI bot (gpt-4o)').addStringOption(o=>o.setName('message').setDescription('Your question').setRequired(true)),
  new SlashCommandBuilder().setName('report').setDescription('Submit a server issue report to admins.').addStringOption(o=>o.setName('title').setDescription('Short title').setRequired(true)).addStringOption(o=>o.setName('details').setDescription('Describe the problem').setRequired(true)),
  new SlashCommandBuilder().setName('reply-ferox').setDescription('Post the prepared Ferox taming bug update for players.'),
  new SlashCommandBuilder().setName('set-lang').setDescription('Set your preferred language for bot responses.').addStringOption(o=>o.setName('language').setDescription('pl or en').setRequired(true).addChoices({name:'Polski',value:'pl'},{name:'English',value:'en'})),
  new SlashCommandBuilder().setName('limits').setDescription('Show your remaining daily limits')
].map(c=>c.toJSON());

async function registerCommands(){
  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_BOT_TOKEN);
  const app = await client.application?.fetch();
  const appId = app?.id;
  if (!appId) throw new Error('Cannot determine application ID');
  await rest.put(Routes.applicationCommands(appId), { body: commands });
  console.log('✅ Slash commands registered globally.');
}

client.once('ready', async () => {
  console.log(`🤖 Logged in as ${client.user.tag}`);
  try { await registerCommands(); } catch (e) { console.error(e); }
});

client.on('interactionCreate', async (interaction) => {
  try {
    if (!interaction.isChatInputCommand()) return;

    if (interaction.commandName === 'set-lang'){
      const lang = interaction.options.getString('language', true);
      userLang.set(interaction.user.id, lang);
      return interaction.reply({ content: lang==='pl' ? '✅ Ustawiono język na **polski**.' : '✅ Language set to **English**.', ephemeral: true });
    }

    if (interaction.commandName === 'limits'){
      resetIfNewDay();
      const member = await interaction.guild.members.fetch(interaction.user.id);
      const hasProRole = member.roles.cache.some(r=>ALLOWED_PRO_ROLES.includes(r.name));
      const isOwnerHelper = member.roles.cache.some(r=>r.name==='Helper') && interaction.user.id===OWNER_ID;
      const remUser = remainingFor(interaction.user.id, false);
      const remPro = hasProRole ? remainingFor(interaction.user.id, true) : 0;
      const remGlobal = Math.max(0, LIMITS.GLOBAL_PER_DAY - globalUsed);

      const lines = [
        `Global left: **${remGlobal}/${LIMITS.GLOBAL_PER_DAY}**`,
        `Your /ask left: **${remUser}/${LIMITS.USER_PER_DAY}**`,
      ];
      if (hasProRole) lines.push(`Your /ask-pro left: **${remPro}/${LIMITS.ELEVATED_PER_DAY}**`);
      if (isOwnerHelper) lines.push('(Helper bypass active)');

      const msg = lines.join('
');
      return interaction.reply({ content: msg, ephemeral: true });
    }

    if (interaction.commandName === 'ask' || interaction.commandName === 'ask-pro'){
      const isPro = interaction.commandName === 'ask-pro';
      const member = await interaction.guild.members.fetch(interaction.user.id);
      const hasProRole = member.roles.cache.some(r=>ALLOWED_PRO_ROLES.includes(r.name));
      const isOwnerHelper = member.roles.cache.some(r=>r.name==='Helper') && interaction.user.id===OWNER_ID;
      if (isPro && !hasProRole && !isOwnerHelper){
        return interaction.reply({ content: '⛔ Nie masz uprawnień do `/ask-pro`. Użyj `/ask`.', ephemeral: true });
      }

      const msg = interaction.options.getString('message', true);
      const lang = detectLang(msg, interaction.user.id);
      const system = lang==='pl'
        ? (isPro ? 'Jesteś Lumenem, profesjonalnym pomocnikiem Discord SGServers. Odpowiadaj szczegółowo i precyzyjnie po polsku.' : 'Jesteś Lumenem, pomocnym asystentem Discord SGServers. Odpowiadaj krótko, po polsku, rzeczowo i przyjaźnie.')
        : (isPro ? 'You are Lumen, a professional Discord helper for SGServers. Provide detailed, accurate answers.' : 'You are Lumen, a friendly Discord helper for SGServers. Keep answers concise, helpful, and game-focused.');

      const gate = canUse(interaction.user.id, isPro, isOwnerHelper);
      if (!gate.ok){
        const why = gate.reason==='global' ? `Global limit reached (${LIMITS.GLOBAL_PER_DAY}/day). Try later.` : `Daily limit reached. Use \`/limits\` to check.`;
        return interaction.reply({ content: `⛔ ${why}`, ephemeral: true });
      }

      await interaction.deferReply();
      const model = isPro ? MODELS.PRO : MODELS.ASK;
      const answer = await askOpenAI(model, system, msg);
      consume(interaction.user.id, isPro, isOwnerHelper);

      if (isPro){
        const role = member.roles.cache.find(r=>ALLOWED_PRO_ROLES.includes(r.name))?.name;
        const prefix = isOwnerHelper ? '✅ (Helper bypass)' : role ? `✅ You have **${role}**` : '';
        return interaction.editReply(prefix ? `${prefix}

${answer}` : answer);
      }
      return interaction.editReply(answer);
    }

    if (interaction.commandName === 'report'){
      await interaction.deferReply({ ephemeral: true });
      const title = interaction.options.getString('title', true);
      const details = interaction.options.getString('details', true);
      const targetChannelId = process.env.REPORTS_CHANNEL_ID || interaction.channelId;
      const channel = await interaction.client.channels.fetch(targetChannelId);
      await channel.send({ content: `📣 **New Player Report**
**From:** ${interaction.user}
**Title:** ${title}
**Details:** ${details}` });
      return interaction.editReply('Dzięki! Twoje zgłoszenie zostało przesłane do administracji. ✅');
    }

    if (interaction.commandName === 'reply-ferox'){
      const text = `**📢 Ferox Taming Issue – Update & Workarounds**

Hey everyone 👋 Thanks a lot for reporting the Ferox taming problem and sharing details 🙏

Here’s what we know so far:

🔎 **The issue**
- After feeding **5–6 element**, the Ferox suddenly **despawns/disappears**.
- Happens even when you keep aggro and move it to a safe spot.
- This looks very similar to a known vanilla ARK bug where Ferox falls through terrain or poofs mid-tame.

🛠 **Workarounds you can try:**
1. **Tame in an open, flat area** – avoid caves, uneven ground, or bases.
2. **Use a Cryopod immediately after taming** – helps prevent later despawns.
3. **Be careful around server restarts** – pod them before restart just in case.

📨 **What’s next**
- I’ve already reported the issue to the DOX devs with all your info (server ID + mod list).
- Waiting to hear back if this is DOX-related or just a base-game Ferox bug.
- I’ll keep you updated as soon as we get feedback. 👍

❤️ Thanks again for helping spot this. I know taming Ferox is already tough, and it sucks when bugs get in the way – hopefully we’ll get a fix or at least a clear answer soon!`;
      return interaction.reply({ content: text });
    }
  } catch (err) {
    console.error(err);
    if (interaction.isRepliable()){
      const msg = 'Coś poszło nie tak. Spróbuj ponownie lub pingnij admina.';
      interaction.replied ? interaction.followUp({ content: msg, ephemeral: true }) : interaction.reply({ content: msg, ephemeral: true });
    }
  }
});

// Mentions (no regex to avoid escapes in templates)
client.on('messageCreate', async (msg) => {
  try {
    if (msg.author.bot) return;
    const mentioned = msg.mentions.users.has(client.user.id);
    if (!mentioned) return;

    const mention1 = `<@${client.user.id}>`;
    const mention2 = `<@!${client.user.id}>`;
    const text = msg.content.replaceAll(mention1, '').replaceAll(mention2, '').trim();
    if (!text) return msg.reply('Hi! Use `/ask` to talk to me, or type your question after mentioning me.');

    const lang = detectLang(text, msg.author.id);
    const system = lang==='pl' ? 'Jesteś Lumenem, pomocnym asystentem Discord SGServers. Odpowiadaj po polsku, zwięźle i przyjaźnie.' : 'You are Lumen, a friendly Discord helper for SGServers. Keep answers concise, helpful, and game-focused.';

    const gate = canUse(msg.author.id, false, false);
    if (!gate.ok) return msg.reply('⛔ Limit dzienny został osiągnięty. Użyj `/limits`.');

    await msg.channel.sendTyping();
    const answer = await askOpenAI(MODELS.ASK, system, text);
    consume(msg.author.id, false, false);
    await msg.reply(answer);
  } catch (e) { console.error('mention handler error', e); }
});

client.login(process.env.DISCORD_BOT_TOKEN);

// Optional tiny HTTP server (helps if service type = Web)
const PORT = process.env.PORT;
if (PORT){
  const app = express();
  app.get('/', (_,res)=>res.send('SGServers Discord bot is running.'));
  app.listen(PORT, ()=>console.log('HTTP health on', PORT));
}
