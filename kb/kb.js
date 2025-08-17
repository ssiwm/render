
// index.js — Open AI Bot (Discord) with Qdrant KB
// - Safer interaction handling (ack/respond) to avoid 10062 / 40060
// - Reduced memory footprint via cache limits & sweepers
// - KB: Qdrant (upsert/search), embeddings via OpenAI
// - Commands: /status, /website, /ask, /ask-pro, /kb-add, /kb-search, /kb-import-pins, /read-channel
// Node: ESM enabled via "type": "module" in package.json

import 'dotenv/config';
import express from 'express';
import axios from 'axios';
import OpenAI from 'openai';
import { QdrantClient } from '@qdrant/js-client-rest';
import {
  Client, GatewayIntentBits, Partials, REST, Routes, SlashCommandBuilder, ChannelType,
  PermissionFlagsBits, EmbedBuilder, MessageFlags, Options, time
} from 'discord.js';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const Gamedig = require('gamedig');

// --------------------------- Config ---------------------------

const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.DISCORD_CLIENT_ID; // App ID
const OWNER_ID = process.env.OWNER_ID || '';
const STATUS_WEBSITE_URL = process.env.STATUS_WEBSITE_URL || process.env.WEBSITE_URL || '';
const STATUS_SERVERS = (process.env.STATUS_SERVERS || '').trim(); // "Name|ip:port,Name2|ip:port"
const QDRANT_URL = process.env.QDRANT_URL || '';
const QDRANT_API_KEY = process.env.QDRANT_API_KEY || '';
const KB_COLLECTION = process.env.KB_COLLECTION || 'sg_kb';
const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL || 'text-embedding-3-small';
const CHAT_MODEL = process.env.CHAT_MODEL || 'gpt-4o-mini';
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';

const KB_TIMEOUT_MS = Number(process.env.KB_TIMEOUT_MS || 25_000);
const LLM_TIMEOUT_MS = Number(process.env.LLM_TIMEOUT_MS || 35_000);

const ALLOWED_PRO_ROLES = (process.env.ALLOWED_PRO_ROLES || 'Helper,Admin,Moderator,Owner')
  .split(',').map(s => s.trim()).filter(Boolean);

// --------------------------- Express (health) ---------------------------

const app = express();
const PORT = Number(process.env.PORT || 10000);
app.get('/', (req, res) => res.status(200).send('OK'));
app.listen(PORT, () => console.log(`🌐 Express server listening on port ${PORT}`));

// --------------------------- Discord client with memory-friendly cache ---------------------------

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent, // needed for reading content in /read-channel (limited)
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
    // keep modest caches:
    GuildMemberManager: { maxSize: 100 },
    MessageManager: { maxSize: 50 },
    ThreadManager: { maxSize: 10 },
  }),
  sweepers: {
    messages: { interval: 5 * 60, lifetime: 15 * 60 },
    users:    { interval: 60 * 60, filter: () => user => !user.bot },
    threads:  { interval: 60 * 60, lifetime: 60 * 60 },
  }
});

// Optional memory logger (off by default)
if (process.env.MEMLOG === '1') {
  setInterval(() => {
    const m = process.memoryUsage();
    console.log(`[mem] rss=${(m.rss/1e6).toFixed(0)}MB heap=${(m.heapUsed/1e6).toFixed(0)}/${(m.heapTotal/1e6).toFixed(0)}MB ext=${(m.external/1e6).toFixed(0)}MB`);
  }, 60_000);
}

// --------------------------- Helpers: ack/respond, timeout ---------------------------

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
    if (interaction.replied)  return await interaction.followUp({ ...payload, flags: MessageFlags.Ephemeral });
    return await interaction.reply({ ...payload, flags: MessageFlags.Ephemeral });
  } catch (e) {
    const code = e?.code || e?.rawError?.code;
    if (code === 40060) { // already acknowledged
      try { return await interaction.followUp({ ...payload, flags: MessageFlags.Ephemeral }); } catch {}
    }
    console.error('[respond] error', e);
  }
}

function withTimeout(promise, ms, label = 'op') {
  let t;
  const timeout = new Promise((_, rej) => {
    t = setTimeout(() => rej(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise.finally(() => clearTimeout(t)), timeout]);
}

// --------------------------- OpenAI and Embeddings ---------------------------

let openai = null;
if (OPENAI_API_KEY) {
  try {
    openai = new OpenAI({ apiKey: OPENAI_API_KEY });
  } catch (e) {
    console.warn('OpenAI init failed:', e);
  }
}

// Chunking helper for embeddings
function chunkText(text, chunkSize = 1200, overlap = 150) {
  const chunks = [];
  let i = 0;
  while (i < text.length) {
    const end = Math.min(i + chunkSize, text.length);
    chunks.push(text.slice(i, end));
    if (end === text.length) break;
    i = end - overlap;
  }
  return chunks;
}

async function embed(texts) {
  if (!openai) throw new Error('OPENAI_API_KEY not set');
  const res = await openai.embeddings.create({ model: EMBEDDING_MODEL, input: texts });
  return res.data.map(d => d.embedding);
}

// --------------------------- Qdrant ---------------------------

let qdrant = null;
let KB_READY = false;
if (QDRANT_URL) {
  try {
    qdrant = new QdrantClient({ url: QDRANT_URL, apiKey: QDRANT_API_KEY || undefined });
    // Ensure collection exists (1536 dims for text-embedding-3-small)
    const dim = 1536;
    const exists = await qdrant.getCollections().then(r => r.collections.find(c => c.name === KB_COLLECTION)).catch(() => null);
    if (!exists) {
      await qdrant.createCollection(KB_COLLECTION, { vectors: { size: dim, distance: 'Cosine' } });
      console.log(`[KB] Created collection ${KB_COLLECTION}`);
    }
    KB_READY = true;
    console.log('📚 KB (Qdrant) ready.');
  } catch (e) {
    console.warn('[KB] init failed:', e?.message || e);
  }
} else {
  console.log('[KB] QDRANT_URL not set. Knowledge features will be disabled.');
}

// Upsert to KB
async function kbUpsert(items) {
  if (!KB_READY) throw new Error('KB not ready');
  const points = items.map((it, idx) => ({
    id: it.id || undefined,
    vector: it.vec,
    payload: { title: it.title, content: it.content, author: it.author || null, ts: it.ts || Date.now() }
  }));
  await qdrant.upsert(KB_COLLECTION, { wait: true, points });
}

// Search KB
async function kbSearch(query, limit = 5) {
  if (!KB_READY) return [];
  const [vec] = await embed([query]);
  const res = await qdrant.search(KB_COLLECTION, { vector: vec, limit });
  return res.map(r => ({ score: r.score, ...r.payload }));
}

// --------------------------- Gamedig: status ---------------------------

function parseServers(envStr) {
  return envStr.split(',')
    .map(s => s.trim())
    .filter(Boolean)
    .map(pair => {
      const [name, addr] = pair.split('|').map(x => x.trim());
      return { name, addr };
    });
}

async function queryArk(addr) {
  const [host, portStr] = addr.split(':');
  const port = Number(portStr);
  try {
    const res = await Gamedig.query({ type: 'arkse', host, port, maxRetries: 1, socketTimeout: 2500 });
    return { online: true, name: res.name || '', players: res.players?.length || 0, maxplayers: res.maxplayers || 0, map: res.map || '' };
  } catch {
    return { online: false };
  }
}

// --------------------------- Slash commands ---------------------------

const commands = [
  new SlashCommandBuilder()
    .setName('status')
    .setDescription('Check ARK servers & website status'),

  new SlashCommandBuilder()
    .setName('website')
    .setDescription('Check website HTTP status'),

  new SlashCommandBuilder()
    .setName('kb-add')
    .setDescription('Add a note to the knowledge base')
    .addStringOption(o => o.setName('title').setDescription('Title').setRequired(true))
    .addStringOption(o => o.setName('content').setDescription('Content').setRequired(true)),

  new SlashCommandBuilder()
    .setName('kb-search')
    .setDescription('Search the knowledge base')
    .addStringOption(o => o.setName('query').setDescription('Your query').setRequired(true)),

  new SlashCommandBuilder()
    .setName('kb-import-pins')
    .setDescription('Import pinned messages from a channel to KB')
    .addChannelOption(o => o.setName('channel').setDescription('Channel').addChannelTypes(ChannelType.GuildText).setRequired(true)),

  new SlashCommandBuilder()
    .setName('read-channel')
    .setDescription('Read last N messages from a channel (no store)')
    .addChannelOption(o => o.setName('channel').setDescription('Channel').addChannelTypes(ChannelType.GuildText).setRequired(true))
    .addIntegerOption(o => o.setName('limit').setDescription('How many (max 500)').setRequired(false)),

  new SlashCommandBuilder()
    .setName('ask')
    .setDescription('Ask with KB context')
    .addStringOption(o => o.setName('question').setDescription('Your question').setRequired(true)),

  new SlashCommandBuilder()
    .setName('ask-pro')
    .setDescription('Ask with KB context (pro – needs role)')
    .addStringOption(o => o.setName('question').setDescription('Your question').setRequired(true)),
].map(c => c.toJSON());

// Register global commands once on ready
client.once('ready', async () => {
  console.log(`🤖 Logged in as ${client.user.tag}`);
  try {
    const rest = new REST({ version: '10' }).setToken(TOKEN);
    await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
    console.log('✅ Slash commands registered globally.');
  } catch (e) {
    console.error('Failed to register slash commands:', e);
  }
});

// --------------------------- Interaction handler ---------------------------

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  try {
    // /status
    if (interaction.commandName === 'status') {
      await ack(interaction);
      const lines = [];

      if (STATUS_SERVERS) {
        const servers = parseServers(STATUS_SERVERS);
        for (const s of servers) {
          const st = await withTimeout(queryArk(s.addr), 4500, 'gamedig');
          if (st.online) {
            lines.push(`🟢 **${s.name}** — ${st.players}/${st.maxplayers} players (${st.map || 'map?'})`);
          } else {
            lines.push(`❌ **${s.name}** — offline`);
          }
        }
      } else {
        lines.push('ℹ️ No STATUS_SERVERS env configured.');
      }

      if (STATUS_WEBSITE_URL) {
        try {
          const res = await withTimeout(axios.get(STATUS_WEBSITE_URL, { timeout: 4000 }), 4500, 'website');
          lines.push(`✅ **Website** — HTTP ${res.status}`);
        } catch {
          lines.push(`❌ **Website** — offline`);
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
    if (interaction.commandName === 'website') {
      await ack(interaction);
      if (!STATUS_WEBSITE_URL) return respond(interaction, { content: 'No STATUS_WEBSITE_URL set.' });
      try {
        const res = await withTimeout(axios.get(STATUS_WEBSITE_URL, { timeout: 4000 }), 4500, 'website');
        return respond(interaction, { content: `✅ Website — HTTP ${res.status}` });
      } catch (e) {
        return respond(interaction, { content: `❌ Website offline (${e?.message || e})` });
      }
    }

    // /kb-add
    if (interaction.commandName === 'kb-add') {
      await ack(interaction);
      if (!KB_READY) return respond(interaction, { content: 'KB disabled (no QDRANT_URL).' });
      const title = interaction.options.getString('title', true);
      const content = interaction.options.getString('content', true);

      const MAX_ADD_CHARS = 20_000;
      if (content.length > MAX_ADD_CHARS) {
        return respond(interaction, { content: `⛔ Content too big (${content.length}). Max ${MAX_ADD_CHARS}.` });
      }

      if (!OPENAI_API_KEY) return respond(interaction, { content: '⛔ No OPENAI_API_KEY set for embeddings.' });

      const chunks = chunkText(content);
      const BATCH = 32;
      let inserted = 0;
      for (let i = 0; i < chunks.length; i += BATCH) {
        const slice = chunks.slice(i, i + BATCH);
        const vecs = await withTimeout(embed(slice), KB_TIMEOUT_MS, 'embed');
        const items = vecs.map((vec, idx) => ({
          title,
          content: slice[idx],
          vec,
          author: interaction.user.tag,
          ts: Date.now()
        }));
        await kbUpsert(items);
        inserted += items.length;
      }
      return respond(interaction, { content: `✅ Added to KB: **${title}** (${inserted} chunks).` });
    }

    // /kb-search
    if (interaction.commandName === 'kb-search') {
      await ack(interaction);
      if (!KB_READY) return respond(interaction, { content: 'KB disabled (no QDRANT_URL).' });
      const query = interaction.options.getString('query', true);
      try {
        const hits = await withTimeout(kbSearch(query, 5), KB_TIMEOUT_MS, 'kbSearch');
        if (!hits.length) return respond(interaction, { content: 'No results.' });
        const lines = hits.map((h, i) => `**${i+1}. ${h.title || '(no title)'}** – ${(h.content || '').slice(0, 140)}…  _score:${h.score.toFixed(3)}_`);
        return respond(interaction, { content: lines.join('\n') });
      } catch (e) {
        return respond(interaction, { content: `⛔ ${e?.message || e}` });
      }
    }

    // /kb-import-pins
    if (interaction.commandName === 'kb-import-pins') {
      await ack(interaction);
      if (!KB_READY) return respond(interaction, { content: 'KB disabled (no QDRANT_URL).' });
      if (!OPENAI_API_KEY) return respond(interaction, { content: '⛔ No OPENAI_API_KEY for embeddings.' });

      const channel = interaction.options.getChannel('channel', true);
      if (channel.type !== ChannelType.GuildText) return respond(interaction, { content: 'Choose a text channel.' });

      const pins = await channel.messages.fetchPinned();
      if (!pins.size) return respond(interaction, { content: 'No pinned messages.' });

      const texts = pins.map(m => `Author: ${m.author?.tag}\nDate: ${m.createdAt?.toISOString()}\n\n${m.content || ''}`);
      const chunks = texts.flatMap(t => chunkText(t));
      const BATCH = 32;
      let inserted = 0;
      for (let i = 0; i < chunks.length; i += BATCH) {
        const slice = chunks.slice(i, i + BATCH);
        const vecs = await withTimeout(embed(slice), KB_TIMEOUT_MS, 'embed');
        const items = vecs.map((vec, idx) => ({
          title: `Pin from #${channel.name}`,
          content: slice[idx],
          vec,
          author: interaction.user.tag,
          ts: Date.now()
        }));
        await kbUpsert(items);
        inserted += items.length;
      }
      return respond(interaction, { content: `✅ Imported ${inserted} chunks from pinned messages.` });
    }

    // /read-channel
    if (interaction.commandName === 'read-channel') {
      await ack(interaction);
      const channel = interaction.options.getChannel('channel', true);
      const limit = Math.min(Math.max(interaction.options.getInteger('limit') || 200, 1), 500);
      if (channel.type !== ChannelType.GuildText) return respond(interaction, { content: 'Choose a text channel.' });

      let fetched = 0, lastId = undefined;
      while (fetched < limit) {
        const page = await channel.messages.fetch({ limit: Math.min(100, limit - fetched), before: lastId });
        if (page.size === 0) break;
        lastId = page.last().id;
        fetched += page.size;
      }
      return respond(interaction, { content: `📖 Read ${fetched} messages from #${channel.name} (preview disabled).` });
    }

    // /ask & /ask-pro
    if (interaction.commandName === 'ask' || interaction.commandName === 'ask-pro') {
      await ack(interaction);
      const isPro = interaction.commandName === 'ask-pro';
      const member = interaction.member; // no GuildMembers intent
      const hasProRole = member?.roles?.cache?.some(r => ALLOWED_PRO_ROLES.includes(r.name)) || false;
      const canPro = hasProRole || (interaction.user.id === OWNER_ID);

      if (isPro && !canPro) {
        return respond(interaction, { content: '⛔ /ask-pro requires a pro role.' });
      }
      const question = interaction.options.getString('question', true);

      // KB context
      let contexts = [];
      if (KB_READY && OPENAI_API_KEY) {
        try {
          const hits = await withTimeout(kbSearch(question, isPro ? 8 : 5), KB_TIMEOUT_MS, 'kbSearch');
          contexts = hits.map(h => `Title: ${h.title}\nContent: ${h.content}`);
        } catch (e) {
          console.warn('kbSearch failed:', e?.message || e);
        }
      }

      // If no OpenAI key, just return KB snippets
      if (!openai) {
        const reply = contexts.length
          ? `🔎 KB snippets:\n\n${contexts.slice(0, 3).map((c, i) => `**${i+1}.** ${c.slice(0, 300)}…`).join('\n\n')}`
          : 'ℹ️ OPENAI_API_KEY not set; returning KB snippets disabled.';
        return respond(interaction, { content: reply });
      }

      // Build prompt
      const sys = `You are a helpful assistant for ARK/ASA game servers. Answer briefly and use KB context if relevant. If unsure, say you are unsure.`;
      const user = `Question:\n${question}\n\nKB Context:\n${contexts.join('\n\n')}`.slice(0, 12_000);

      try {
        const completion = await withTimeout(openai.chat.completions.create({
          model: CHAT_MODEL,
          messages: [{ role: 'system', content: sys }, { role: 'user', content: user }],
          temperature: 0.2,
        }), LLM_TIMEOUT_MS, 'chat');

        const text = completion.choices?.[0]?.message?.content?.trim() || 'No answer.';
        return respond(interaction, { content: text.slice(0, 1900) });
      } catch (e) {
        return respond(interaction, { content: `⛔ LLM error: ${e?.message || e}` });
      }
    }

  } catch (err) {
    console.error('interaction handler', err);
    try { await respond(interaction, { content: `⛔ Error: ${err?.message || err}` }); } catch {}
  }
});

// --------------------------- Login ---------------------------

if (!TOKEN || !CLIENT_ID) {
  console.error('Missing DISCORD_TOKEN or DISCORD_CLIENT_ID env.');
  process.exit(1);
}
client.login(TOKEN);
