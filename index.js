// index.js — Open AI Bot (Discord) with Qdrant KB and fallback query for ARK/ASA
import 'dotenv/config';
import express from 'express';
import axios from 'axios';
import OpenAI from 'openai';
import { QdrantClient } from '@qdrant/js-client-rest';
import {
  Client,
  GatewayIntentBits,
  Partials,
  REST,
  Routes,
  SlashCommandBuilder,
  ChannelType,
  MessageFlags,
  Options,
  EmbedBuilder,
} from 'discord.js';
import Gamedig from 'gamedig';
import { randomUUID } from 'crypto';

// Configuration from environment
const TOKEN = process.env.DISCORD_TOKEN;
const OWNER_ID = process.env.OWNER_ID || '';
const STATUS_SERVERS = (process.env.STATUS_SERVERS || '').trim();
const STATUS_WEBSITE_URL = process.env.STATUS_WEBSITE_URL || process.env.WEBSITE_URL || '';
const QDRANT_URL = process.env.QDRANT_URL || '';
const QDRANT_API_KEY = process.env.QDRANT_API_KEY || '';
const KB_COLLECTION = process.env.KB_COLLECTION || 'sg_kb';
const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL || 'text-embedding-3-small';
const CHAT_MODEL = process.env.MODEL || 'gpt-4o-mini';
const PRO_MODEL = process.env.PRO_MODEL || 'gpt-4o';
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const ALLOWED_PRO_ROLES = (process.env.ALLOWED_PRO_ROLES || 'Admin,Moderator,Helper,Pro')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
// Optional timeouts (ms)
const KB_TIMEOUT_MS = Number(process.env.KB_TIMEOUT_MS || 25_000);
const LLM_TIMEOUT_MS = Number(process.env.LLM_TIMEOUT_MS || 35_000);

// Express server for health checks
const app = express();
const PORT = Number(process.env.PORT || 10000);
app.get('/', (req, res) => res.status(200).send('OK'));
app.listen(PORT, () => console.log(`🌐 Express server listening on port ${PORT}`));

// Create Discord client with limited caches and sweepers to reduce memory usage
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Channel, Partials.Message],
  makeCache: Options.cacheWithLimits({
    ApplicationCommandManager: 0,
    AutoModerationRuleManager: 0,
    BaseGuildEmojiManager: 0,
    GuildBanManager: 0,
    GuildInviteManager: 0,
    GuildStickerManager: 0,
    PresenceManager: 0,
    ReactionManager: 0,
    VoiceStateManager: 0,
    GuildMemberManager: { maxSize: 100 },
    MessageManager: { maxSize: 50 },
    ThreadManager: { maxSize: 10 },
  }),
  sweepers: {
    messages: { interval: 300, lifetime: 900 },
    users: { interval: 3600, filter: () => (user) => !user.bot },
    threads: { interval: 3600, lifetime: 3600 },
  },
});

// Utility functions for interactions
async function ack(interaction, flags = MessageFlags.Ephemeral) {
  try {
    if (interaction.deferred || interaction.replied) return false;
    await interaction.deferReply({ flags });
    return true;
  } catch (e) {
    const code = e?.code || e?.rawError?.code;
    console.warn('[ack] failed', code, e?.message || e);
    return false;
  }
}

async function respond(interaction, payload) {
  try {
    if (interaction.deferred) return await interaction.editReply(payload);
    if (interaction.replied)
      return await interaction.followUp({ ...payload, flags: MessageFlags.Ephemeral });
    return await interaction.reply({ ...payload, flags: MessageFlags.Ephemeral });
  } catch (e) {
    const code = e?.code || e?.rawError?.code;
    if (code === 40060) {
      try {
        return await interaction.followUp({ ...payload, flags: MessageFlags.Ephemeral });
      } catch {}
    }
    console.error('[respond] error', e);
  }
}

function withTimeout(promise, ms, label = 'operation') {
  let timer;
  const timeout = new Promise((_, rej) => {
    timer = setTimeout(() => rej(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    timeout,
  ]);
}

// OpenAI and Qdrant initialization
let openai = null;
if (OPENAI_API_KEY) {
  try {
    openai = new OpenAI({ apiKey: OPENAI_API_KEY });
  } catch (e) {
    console.error('Failed to initialize OpenAI:', e);
  }
}

let qdrant = null;
let KB_READY = false;
async function initQdrant() {
  if (!QDRANT_URL) return;
  try {
    qdrant = new QdrantClient({ url: QDRANT_URL, apiKey: QDRANT_API_KEY || undefined });
    const dim = 1536;
    const list = await qdrant.getCollections();
    const exists = list.collections.find((c) => c.name === KB_COLLECTION);
    if (!exists) {
      await qdrant.createCollection(KB_COLLECTION, {
        vectors: { size: dim, distance: 'Cosine' },
      });
      console.log(`[KB] Created collection ${KB_COLLECTION}`);
    }
    KB_READY = true;
    console.log('📚 KB (Qdrant) ready.');
  } catch (e) {
    console.warn('[KB] init failed:', e);
  }
}
initQdrant();

async function embedTexts(texts) {
  if (!openai) throw new Error('OpenAI API key not configured');
  const res = await openai.embeddings.create({ model: EMBEDDING_MODEL, input: texts });
  return res.data.map((d) => d.embedding);
}

async function kbUpsert(items) {
  if (!KB_READY) throw new Error('KB not ready');
  const points = items.map((it) => ({
    id: it.id || randomUUID(),
    vector: it.vec,
    payload: {
      title: it.title,
      content: it.content,
      author: it.author || null,
      ts: it.ts || Date.now(),
    },
  }));
  await qdrant.upsert(KB_COLLECTION, { wait: true, points });
}

async function kbSearch(query, limit = 5) {
  if (!KB_READY) return [];
  const [vec] = await embedTexts([query]);
  const res = await qdrant.search(KB_COLLECTION, { vector: vec, limit });
  return res.map((r) => ({ score: r.score, ...r.payload }));
}

// Chunk text with overlap
function chunkText(text, max = 1200, overlap = 150) {
  const out = [];
  let i = 0;
  while (i < text.length) {
    const end = Math.min(text.length, i + max);
    out.push(text.slice(i, end));
    if (end === text.length) break;
    i = end - overlap;
  }
  return out;
}

// Query ARK server with fallback to 'valve' type
async function queryArkServer(host, port) {
  const base = {
    host,
    port: Number(port),
    maxAttempts: 2,
    socketTimeout: 2000,
    udpTimeout: 2000,
    masterTimeout: 2000,
  };
  try {
    return await Gamedig.query({ type: 'arkse', ...base });
  } catch {
    try {
      return await Gamedig.query({ type: 'valve', ...base });
    } catch {
      return await Gamedig.query({
        type: 'valve',
        ...base,
        socketTimeout: 3500,
        udpTimeout: 3500,
      });
    }
  }
}

// Helper to check pro roles
function isProAllowed(member) {
  if (!member) return false;
  if (OWNER_ID && member.id === OWNER_ID) return true;
  return (
    member.roles?.cache?.some((r) => ALLOWED_PRO_ROLES.includes(r.name)) || false
  );
}

// Build commands definitions
const askCmd = new SlashCommandBuilder()
  .setName('ask')
  .setDescription('Ask with optional KB context')
  .addStringOption((o) =>
    o.setName('question').setDescription('Your question').setRequired(true)
  )
  .addBooleanOption((o) =>
    o
      .setName('use_kb')
      .setDescription('Use knowledge base (default: true)')
      .setRequired(false)
  );

const askProCmd = new SlashCommandBuilder()
  .setName('ask-pro')
  .setDescription('Ask with KB context (pro – needs role)')
  .addStringOption((o) =>
    o.setName('question').setDescription('Your question').setRequired(true)
  );

const syncCmd = new SlashCommandBuilder()
  .setName('sync-commands')
  .setDescription('Purge and re-register commands (owner only)');

const statusCmd = new SlashCommandBuilder().setName('status').setDescription('Check ARK servers & website status');

const websiteCmd = new SlashCommandBuilder().setName('website').setDescription('Check website HTTP status');

const kbAddCmd = new SlashCommandBuilder()
  .setName('kb-add')
  .setDescription('Add an entry to the knowledge base')
  .addStringOption((o) => o.setName('title').setDescription('Title').setRequired(true))
  .addStringOption((o) => o.setName('content').setDescription('Content').setRequired(true));

const kbSearchCmd = new SlashCommandBuilder()
  .setName('kb-search')
  .setDescription('Search the knowledge base')
  .addStringOption((o) => o.setName('query').setDescription('Your query').setRequired(true));

const kbImportPinsCmd = new SlashCommandBuilder()
  .setName('kb-import-pins')
  .setDescription('Import pinned messages from a channel into the KB')
  .addChannelOption((o) =>
    o.setName('channel').setDescription('Channel').addChannelTypes(ChannelType.GuildText).setRequired(true)
  );

const readChannelCmd = new SlashCommandBuilder()
  .setName('read-channel')
  .setDescription('Read last N messages from a channel (no store)')
  .addChannelOption((o) =>
    o.setName('channel').setDescription('Channel').addChannelTypes(ChannelType.GuildText).setRequired(true)
  )
  .addIntegerOption((o) =>
    o
      .setName('limit')
      .setDescription('How many messages (max 500)')
      .setRequired(false)
  );

const commands = [
  statusCmd,
  websiteCmd,
  kbAddCmd,
  kbSearchCmd,
  kbImportPinsCmd,
  readChannelCmd,
  askCmd,
  askProCmd,
  syncCmd,
].map((c) => c.toJSON());

// Dynamic registration on ready
client.once('ready', async () => {
  console.log(`🤖 Logged in as ${client.user.tag}`);
  // Determine application id from token
  await client.application?.fetch?.();
  const appId = client.application?.id;
  console.log(`🆔 Application ID (from token): ${appId}`);
  const invite = `https://discord.com/api/oauth2/authorize?client_id=${appId}&permissions=274877975552&scope=bot%20applications.commands`;
  console.log(`🔗 Invite: ${invite}`);
  // Warn if env client id mismatches
  if (process.env.DISCORD_CLIENT_ID && process.env.DISCORD_CLIENT_ID !== appId) {
    console.warn(
      `⚠️ DISCORD_CLIENT_ID env (${process.env.DISCORD_CLIENT_ID}) != application.id (${appId}). Ignoring env.`
    );
  }
  const rest = new REST({ version: '10' }).setToken(TOKEN);
  try {
    // Optionally purge commands globally if env var set
    if (process.env.PURGE_COMMANDS === '1') {
      await rest.put(Routes.applicationCommands(appId), { body: [] });
      console.log('🧹 Purged ALL global commands');
    }
    // Register global commands
    await rest.put(Routes.applicationCommands(appId), { body: commands });
    console.log('✅ Slash commands registered globally.');
  } catch (e) {
    console.error('Global register failed:', e);
  }
  // Fallback register commands per guild (makes commands available immediately)
  try {
    const guilds = await client.guilds.fetch();
    for (const guild of guilds.values()) {
      try {
        await rest.put(Routes.applicationGuildCommands(appId, guild.id), { body: commands });
        console.log(`✅ Guild commands registered in ${guild.id}`);
      } catch (err) {
        console.error(`Guild register failed in ${guild.id}:`, err?.code || err?.message || err);
      }
    }
  } catch (e) {
    console.error('Guild fetch/register fallback failed:', e);
  }
});

// Helper functions for RAG and chat
async function chatComplete(model, messages) {
  if (!openai) throw new Error('OpenAI API key not configured');
  const res = await openai.chat.completions.create({ model, messages, temperature: 0.2 });
  return res.choices?.[0]?.message?.content?.trim() || 'No answer.';
}

async function answerWithRAG({ question, useKb, model }) {
  let context = '';
  if (useKb && KB_READY && OPENAI_API_KEY) {
    try {
      const hits = await withTimeout(kbSearch(question, 5), KB_TIMEOUT_MS, 'kbSearch');
      if (hits.length) {
        context = hits
          .map((h, i) => `Source ${i + 1}: ${h.title}\n${h.content}`.slice(0, 1000))
          .join('\n\n');
      }
    } catch (e) {
      console.warn('KB search failed:', e?.message || e);
    }
  }
  const sys =
    'You are a concise assistant for ARK/ASA game servers and SGServers. Provide clear answers. If context is provided, use it.';
  const messages = [
    { role: 'system', content: sys },
    ...(context ? [{ role: 'system', content: context }] : []),
    { role: 'user', content: question },
  ];
  return await withTimeout(
    chatComplete(model, messages),
    LLM_TIMEOUT_MS,
    'chatComplete'
  );
}

// Interaction handler
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  const name = interaction.commandName;
  try {
    // /status
    if (name === 'status') {
      await ack(interaction);
      const lines = [];
      if (STATUS_SERVERS) {
        const pairs = STATUS_SERVERS.split(',').map((s) => s.trim()).filter(Boolean);
        for (const p of pairs) {
          const [name, addr] = p.split('|').map((x) => x.trim());
          const [host, port] = addr.split(':');
          try {
            const st = await withTimeout(queryArkServer(host, port), 5000, 'queryArkServer');
            if (st && st.online) {
              lines.push(`🟢 **${name}** — ${st.players}/${st.maxplayers} players (${st.map || 'map?'})`);
            } else {
              lines.push(`❌ **${name}** — offline`);
            }
          } catch (e) {
            lines.push(`❌ **${name}** — offline`);
          }
        }
      } else {
        lines.push('ℹ️ No STATUS_SERVERS configured.');
      }
      if (STATUS_WEBSITE_URL) {
        try {
          const res = await withTimeout(
            axios.get(STATUS_WEBSITE_URL, { timeout: 4000 }),
            5000,
            'website'
          );
          lines.push(`✅ **Website** — HTTP ${res.status}`);
        } catch {
          lines.push('❌ **Website** — offline');
        }
      }
      const embed = new EmbedBuilder()
        .setTitle('Server status')
        .setDescription(lines.join('\n'))
        .setColor(0x2b8a3e)
        .setTimestamp(new Date());
      return respond(interaction, { embeds: [embed] });
    }

    // /website
    if (name === 'website') {
      await ack(interaction);
      if (!STATUS_WEBSITE_URL) return respond(interaction, { content: 'No STATUS_WEBSITE_URL set.' });
      try {
        const res = await withTimeout(
          axios.get(STATUS_WEBSITE_URL, { timeout: 4000 }),
          5000,
          'website'
        );
        return respond(interaction, { content: `✅ Website — HTTP ${res.status}` });
      } catch (e) {
        return respond(interaction, { content: `❌ Website offline (${e?.message || e})` });
      }
    }

    // /kb-add
    if (name === 'kb-add') {
      await ack(interaction);
      if (!KB_READY) return respond(interaction, { content: 'KB disabled (no QDRANT_URL).' });
      if (!OPENAI_API_KEY) return respond(interaction, { content: 'OPENAI_API_KEY not set.' });
      const title = interaction.options.getString('title', true);
      const content = interaction.options.getString('content', true);
      const MAX_CHARS = 20000;
      if (content.length > MAX_CHARS) {
        return respond(interaction, { content: `⛔ Content too big (${content.length}). Max ${MAX_CHARS}.` });
      }
      const chunks = chunkText(content);
      const BATCH = 32;
      let inserted = 0;
      for (let i = 0; i < chunks.length; i += BATCH) {
        const slice = chunks.slice(i, i + BATCH);
        const vecs = await withTimeout(embedTexts(slice), KB_TIMEOUT_MS, 'embed');
        const items = vecs.map((vec, idx) => ({
          title,
          content: slice[idx],
          vec,
          author: interaction.user.tag,
          ts: Date.now(),
        }));
        await kbUpsert(items);
        inserted += items.length;
      }
      return respond(interaction, { content: `✅ Added to KB: **${title}** (${inserted} chunks).` });
    }

    // /kb-search
    if (name === 'kb-search') {
      await ack(interaction);
      if (!KB_READY) return respond(interaction, { content: 'KB disabled.' });
      const query = interaction.options.getString('query', true);
      try {
        const hits = await withTimeout(kbSearch(query, 5), KB_TIMEOUT_MS, 'kbSearch');
        if (!hits.length) return respond(interaction, { content: 'No results.' });
        const lines = hits.map(
          (h, i) => `**${i + 1}. ${h.title || '(no title)'}** — ${(h.content || '').slice(0, 120)}…  _score:${h.score.toFixed(3)}_`
        );
        return respond(interaction, { content: lines.join('\n') });
      } catch (e) {
        return respond(interaction, { content: `⛔ ${e?.message || e}` });
      }
    }

    // /kb-import-pins
    if (name === 'kb-import-pins') {
      await ack(interaction);
      if (!KB_READY) return respond(interaction, { content: 'KB disabled.' });
      if (!OPENAI_API_KEY) return respond(interaction, { content: 'OPENAI_API_KEY not set.' });
      const channel = interaction.options.getChannel('channel', true);
      if (channel.type !== ChannelType.GuildText) return respond(interaction, { content: 'Choose a text channel.' });
      const pins = await channel.messages.fetchPinned();
      if (!pins.size) return respond(interaction, { content: 'No pinned messages.' });
      const texts = pins.map(
        (m) => `Author: ${m.author?.tag}\nDate: ${m.createdAt?.toISOString()}\n\n${m.content || ''}`
      );
      const chunks = texts.flatMap((t) => chunkText(t));
      const BATCH = 32;
      let inserted = 0;
      for (let i = 0; i < chunks.length; i += BATCH) {
        const slice = chunks.slice(i, i + BATCH);
        const vecs = await withTimeout(embedTexts(slice), KB_TIMEOUT_MS, 'embed');
        const items = vecs.map((vec, idx) => ({
          title: `Pin from #${channel.name}`,
          content: slice[idx],
          vec,
          author: interaction.user.tag,
          ts: Date.now(),
        }));
        await kbUpsert(items);
        inserted += items.length;
      }
      return respond(interaction, { content: `✅ Imported ${inserted} chunks from pinned messages.` });
    }

    // /read-channel
    if (name === 'read-channel') {
      await ack(interaction);
      const channel = interaction.options.getChannel('channel', true);
      const limit = Math.min(Math.max(interaction.options.getInteger('limit') || 200, 1), 500);
      if (channel.type !== ChannelType.GuildText) return respond(interaction, { content: 'Choose a text channel.' });
      let fetched = 0;
      let lastId;
      while (fetched < limit) {
        const page = await channel.messages.fetch({ limit: Math.min(100, limit - fetched), before: lastId });
        if (page.size === 0) break;
        lastId = page.last().id;
        fetched += page.size;
      }
      return respond(interaction, { content: `📖 Read ${fetched} messages from #${channel.name} (preview disabled).` });
    }

    // /ask and /ask-pro
    if (name === 'ask' || name === 'ask-pro') {
      await ack(interaction);
      const isPro = name === 'ask-pro';
      // Pro gating
      if (isPro && !isProAllowed(interaction.member)) {
        return respond(interaction, { content: 'Only pro/staff can use /ask-pro.' });
      }
      const question = interaction.options.getString('question', false);
      if (!question) {
        return respond(interaction, {
          content: 'Please provide a question, e.g. `/ask question:\"What are the rates?\"`',
        });
      }
      const useKb = isPro ? true : interaction.options.getBoolean('use_kb') ?? true;
      const model = isPro ? PRO_MODEL : CHAT_MODEL;
      try {
        const answer = await answerWithRAG({ question, useKb, model });
        return respond(interaction, { content: answer.slice(0, 1900) });
      } catch (e) {
        return respond(interaction, { content: `⛔ Error: ${e?.message || e}` });
      }
    }

    // /sync-commands
    if (name === 'sync-commands') {
      // Owner only
      if (interaction.user.id !== OWNER_ID) {
        return respond(interaction, { content: 'Only owner can sync commands.' });
      }
      await ack(interaction);
      try {
        await client.application?.fetch?.();
        const appId = client.application?.id;
        const rest = new REST({ version: '10' }).setToken(TOKEN);
        // Purge global and guild commands
        await rest.put(Routes.applicationCommands(appId), { body: [] });
        const guilds = await client.guilds.fetch();
        for (const guild of guilds.values()) {
          await rest.put(Routes.applicationGuildCommands(appId, guild.id), { body: [] });
        }
        // Register again
        await rest.put(Routes.applicationCommands(appId), { body: commands });
        for (const guild of guilds.values()) {
          await rest.put(Routes.applicationGuildCommands(appId, guild.id), { body: commands });
        }
        return respond(interaction, { content: '✅ Commands purged & re-registered.' });
      } catch (e) {
        console.error('sync-commands error', e);
        return respond(interaction, { content: `⛔ Failed to sync: ${e?.message || e}` });
      }
    }
  } catch (err) {
    console.error('interaction handler', err);
    try {
      await respond(interaction, { content: `⛔ Error: ${err?.message || err}` });
    } catch {}
  }
});

// Login
if (!TOKEN) {
  console.error('Missing DISCORD_TOKEN env.');
  process.exit(1);
}
client.login(TOKEN);
