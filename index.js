// index.js — SGServers Discord bot (status + KB + sync-commands)
// ESM, Node 18–22 compatible

import express from "express";
import axios from "axios";
import crypto from "crypto";
import { setTimeout as delay } from "timers/promises";
import * as Gamedig from "gamedig";
import {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  MessageFlags,
  EmbedBuilder,
} from "discord.js";
import OpenAI from "openai";
import { QdrantClient } from "@qdrant/js-client-rest";

// ---------- Env ----------
const {
  PORT = 10000,
  DISCORD_TOKEN,
  OWNER_ID,
  STATUS_SERVERS,           // e.g. "DOX EASY (ASE)|5.9.83.87:27016,PUGNACIA (ASE)|5.9.83.87:27015"
  WEBSITE_URL = "https://sgservers.eu/",
  QDRANT_URL,
  QDRANT_API_KEY,
  KB_COLLECTION = "sg_kb",
  EMBEDDING_MODEL = "text-embedding-3-small",
  OPENAI_API_KEY,
} = process.env;

// Express keepalive (for Render)
const app = express();
app.get("/", (_req, res) => res.status(200).send("OK"));
app.listen(PORT, () => {
  console.log(`🌐 Express server listening on port ${PORT}`);
});

// ---------- OpenAI / Qdrant (optional) ----------
let kbReady = false;
let qdrant = null;
let openai = null;

async function ensureKb() {
  if (!QDRANT_URL) {
    console.log("[KB] QDRANT_URL not set. Knowledge features will be disabled.");
    return;
  }
  qdrant = new QdrantClient({ url: QDRANT_URL, apiKey: QDRANT_API_KEY || undefined });
  // text-embedding-3-small -> 1536 dims
  const vectorSize = 1536;
  // Create collection if not exists
  try {
    const collections = await qdrant.getCollections();
    const exists = (collections?.collections || []).some(c => c.name === KB_COLLECTION);
    if (!exists) {
      await qdrant.createCollection(KB_COLLECTION, {
        vectors: { size: vectorSize, distance: "Cosine" },
      });
      console.log(`[KB] Created collection ${KB_COLLECTION}`);
    }
    kbReady = true;
    console.log("📚 KB (Qdrant) ready.");
  } catch (err) {
    console.error("[KB] init error", err);
  }

  if (OPENAI_API_KEY) {
    openai = new OpenAI({ apiKey: OPENAI_API_KEY });
  }
}

function embedTextFrom(title, content) {
  return `${title}\n\n${content}`.slice(0, 8000); // safety
}

async function kbUpsert({ title, content, url }) {
  if (!kbReady || !qdrant) throw new Error("KB not ready");
  if (!openai) throw new Error("OPENAI_API_KEY missing");

  const text = embedTextFrom(title, content);
  const emb = await openai.embeddings.create({ model: EMBEDDING_MODEL, input: text });
  const vector = emb.data[0].embedding;
  const id = crypto.randomUUID();

  await qdrant.upsert(KB_COLLECTION, {
    wait: true,
    points: [{
      id,
      vector,
      payload: {
        title, content, url: url || null,
        createdAt: new Date().toISOString(),
      },
    }],
  });
  return id;
}

async function kbSearch(query, limit = 5) {
  if (!kbReady || !qdrant) throw new Error("KB not ready");
  if (!openai) throw new Error("OPENAI_API_KEY missing");
  const emb = await openai.embeddings.create({ model: EMBEDDING_MODEL, input: query });
  const vector = emb.data[0].embedding;
  const results = await qdrant.search(KB_COLLECTION, {
    vector,
    limit,
    with_payload: true,
  });
  return results.map(r => ({
    id: r.id, score: r.score, payload: r.payload,
  }));
}

// ---------- Utilities ----------
const EMOJI = {
  ok: "🟢",
  bad: "❌",
  warn: "🟡",
  site: "✅",
};

const withTimeout = (p, ms, label = "operation") =>
  Promise.race([
    p,
    delay(ms).then(() => { throw new Error(`${label} timed out after ${ms}ms`); })
  ]);

function parseServers(envStr) {
  // "Name|ip:port,Name2|ip:port"
  if (!envStr) return [];
  return envStr.split(",").map(s => {
    const [name, addr] = s.split("|");
    const [host, portStr] = (addr || "").split(":");
    return { name: (name || "").trim(), host: (host || "").trim(), port: Number(portStr) || 27015 };
  }).filter(x => x.name && x.host && x.port);
}

async function queryArk(host, port) {
  // Try native 'arkse' first (ASE/ASA), then Valve fallback
  try {
    const res = await withTimeout(Gamedig.query({
      type: "arkse",
      host,
      port,
      socketTimeout: 2500,
      givenPortOnly: true,
    }), 3000, "arkse");
    return { ok: true, name: res.name, map: res.map, players: res.players.length, maxPlayers: res.maxplayers };
  } catch (e1) {
    try {
      const res = await withTimeout(Gamedig.query({
        type: "valve",
        host,
        port,
        socketTimeout: 2500,
        givenPortOnly: true,
      }), 3000, "valve");
      return { ok: true, name: res.name, map: res.map, players: res.players.length, maxPlayers: res.maxplayers };
    } catch (e2) {
      return { ok: false, error: e2?.message || e1?.message || "Query failed" };
    }
  }
}

async function checkWebsite(url) {
  try {
    const r = await withTimeout(axios.get(url, { timeout: 3000, validateStatus: () => true }), 4000, "website");
    return `${EMOJI.site} Website — HTTP ${r.status}`;
  } catch {
    return `${EMOJI.bad} Website — offline`;
  }
}

// ---------- Discord ----------
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

// Commands JSON (global)
const Commands = [
  {
    name: "status",
    description: "Show server status",
  },
  {
    name: "kb-add",
    description: "Add an entry to the knowledge base",
    options: [
      { name: "title", description: "Title", type: 3, required: true },
      { name: "content", description: "Content", type: 3, required: true },
      { name: "url", description: "URL (optional)", type: 3, required: false },
    ],
  },
  {
    name: "kb-search",
    description: "Search the knowledge base",
    options: [
      { name: "query", description: "Your query", type: 3, required: true },
    ],
  },
  {
    name: "sync-commands",
    description: "Owner: re-register global commands",
  },
];

async function registerCommands(appId) {
  const rest = new REST({ version: "10" }).setToken(DISCORD_TOKEN);
  // Purge guild-level commands to prevent duplicates
  try {
    const guilds = await client.guilds.fetch();
    for (const [gid] of guilds) {
      await rest.put(Routes.applicationGuildCommands(appId, gid), { body: [] });
    }
  } catch (err) {
    console.warn("Guild purge warning:", err?.message || err);
  }
  // Register global
  await rest.put(Routes.applicationCommands(appId), { body: Commands });
  console.log("✅ Slash commands registered globally.");
}

client.on("ready", async () => {
  try {
    const app = await client.application?.fetch();
    const appId = app?.id;
    if (!appId) console.log("⚠️ Could not resolve application ID from token.");
    await ensureKb();
    if (DISCORD_TOKEN) await registerCommands(appId);
    console.log(`🤖 Logged in as ${client.user.tag}`);
  } catch (err) {
    console.error("Failed to register slash commands:", err);
  }
});

client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand?.()) return;

  // Always defer quickly to avoid "Unknown interaction"
  let deferred = false;
  try {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    deferred = true;
  } catch (e) {
    console.warn("deferReply warn:", e?.message || e);
  }

  const name = interaction.commandName;
  try {
    if (name === "status") {
      const servers = parseServers(STATUS_SERVERS);
      const parts = [`**Server status**`];

      // Limit concurrency
      const BATCH = 4;
      for (let i = 0; i < servers.length; i += BATCH) {
        const chunk = servers.slice(i, i + BATCH);
        // query
        // eslint-disable-next-line no-await-in-loop
        const results = await Promise.all(chunk.map(s => queryArk(s.host, s.port)));
        results.forEach((r, idx) => {
          const label = servers[i + idx].name;
          if (r.ok) {
            parts.push(`${EMOJI.ok} **${label}** — ${r.players}/${r.maxPlayers || "?"} players ${r.map ? `(${r.map})` : ""}`);
          } else {
            parts.push(`${EMOJI.bad} **${label}** — offline`);
          }
        });
      }
      parts.push(await checkWebsite(WEBSITE_URL));
      const msg = parts.join("\n");
      if (deferred) await interaction.editReply({ content: msg });
      else await interaction.reply({ content: msg, flags: MessageFlags.Ephemeral });
    }

    if (name === "kb-add") {
      const title = interaction.options.getString("title", true);
      const content = interaction.options.getString("content", true);
      const url = interaction.options.getString("url", false) || undefined;

      if (!kbReady) throw new Error("KB disabled (missing QDRANT_URL).");
      const id = await withTimeout(kbUpsert({ title, content, url }), 15000, "kb-upsert");

      const embed = new EmbedBuilder()
        .setTitle("KB: Item added")
        .setDescription(`**${title}**\nID: \`${id}\``)
        .setColor(0x00cc66);

      await interaction.editReply({ embeds: [embed] });
    }

    if (name === "kb-search") {
      const query = interaction.options.getString("query", true);
      if (!kbReady) throw new Error("KB disabled (missing QDRANT_URL).");
      const hits = await withTimeout(kbSearch(query), 15000, "kb-search");
      if (!hits.length) {
        await interaction.editReply({ content: "No results." });
      } else {
        const lines = hits.map((h, i) => {
          const p = h.payload || {};
          return `**${i + 1}. ${p.title || "(no title)"}** — score: ${h.score.toFixed(3)}\n${(p.url || "").toString()}`.trim();
        }).join("\n\n");
        await interaction.editReply({ content: lines });
      }
    }

    if (name === "sync-commands") {
      if (!OWNER_ID || interaction.user.id !== OWNER_ID) {
        await interaction.editReply({ content: "Owner only." });
        return;
      }
      const app = await client.application?.fetch();
      await registerCommands(app.id);
      await interaction.editReply({ content: "Commands synced globally and guild commands purged." });
    }
  } catch (err) {
    const msg = (err?.message || String(err)).slice(0, 1900);
    if (deferred) {
      try { await interaction.editReply({ content: `⚠️ ${msg}` }); }
      catch {}
    } else {
      try { await interaction.reply({ content: `⚠️ ${msg}`, flags: MessageFlags.Ephemeral }); }
      catch {}
    }
    console.error("interaction handler", err);
  }
});

if (!DISCORD_TOKEN) {
  console.log("Missing DISCORD_TOKEN or DISCORD_CLIENT_ID env.");
} else {
  client.login(DISCORD_TOKEN).catch(err => {
    console.error(err);
    process.exit(1);
  });
}