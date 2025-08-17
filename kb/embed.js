import OpenAI from 'openai';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const MODEL = process.env.EMBEDDING_MODEL || 'text-embedding-3-small';

export async function embed(text) {
  const input = Array.isArray(text) ? text : [text];
  const res = await openai.embeddings.create({ model: MODEL, input });
  return res.data.map(d => d.embedding);
}
