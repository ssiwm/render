import { QdrantClient } from '@qdrant/js-client-rest';

const QDRANT_URL = process.env.QDRANT_URL;
const QDRANT_API_KEY = process.env.QDRANT_API_KEY;
export const KB_COLLECTION = process.env.KB_COLLECTION || 'sg_kb';
export const KB_VECTOR_SIZE = 1536; // text-embedding-3-small
export const KB_DISTANCE = 'Cosine';

if (!QDRANT_URL) {
  console.warn('[KB] QDRANT_URL not set. Knowledge features will be disabled.');
}

export const qdrant = QDRANT_URL
  ? new QdrantClient({ url: QDRANT_URL, apiKey: QDRANT_API_KEY })
  : null;

export async function ensureKbCollection() {
  if (!qdrant) return false;
  try {
    const list = await qdrant.getCollections();
    const exists = (list?.collections || []).some(c => c.name === KB_COLLECTION);
    if (!exists) {
      await qdrant.createCollection(KB_COLLECTION, {
        vectors: { size: KB_VECTOR_SIZE, distance: KB_DISTANCE },
      });
      console.log(`[KB] Created collection ${KB_COLLECTION}`);
    }
    return true;
  } catch (e) {
    console.error('[KB] ensureKbCollection', e);
    return false;
  }
}
