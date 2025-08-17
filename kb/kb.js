import { qdrant, KB_COLLECTION, ensureKbCollection } from './qdrant.js';
import { embed } from './embed.js';
import { chunkText } from './chunk.js';
import crypto from 'node:crypto';

const SCORE_MIN = 0.18; // below treat as 'no knowledge'

export async function kbReady() {
  return await ensureKbCollection();
}

export async function kbAddDoc({ title, text, source = 'manual', lang = 'en' }) {
  if (!qdrant) return { ok: false, reason: 'no-qdrant' };
  const chunks = chunkText(text);
  const vectors = await embed(chunks);
  const points = chunks.map((chunk, idx) => ({
    id: crypto.randomUUID(),
    vector: vectors[idx],
    payload: { title, text: chunk, source, lang, at: Date.now() }
  }));
  await qdrant.upsert(KB_COLLECTION, { points });
  return { ok: true, chunks: points.length };
}

export async function kbSearch(query, limit = 5) {
  if (!qdrant) return [];
  const [qv] = await embed(query);
  const res = await qdrant.search(KB_COLLECTION, {
    vector: qv,
    limit,
    with_payload: true
  });
  return (res || [])
    .map(({ payload, score }) => ({ ...payload, score }))
    .filter(x => (x?.score ?? 0) >= SCORE_MIN);
}
