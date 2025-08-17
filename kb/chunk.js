export function chunkText(text, max = 900, overlap = 100) {
  const t = (text || '').replace(/\r/g, '');
  const out = [];
  let i = 0;
  while (i < t.length) {
    const end = Math.min(t.length, i + max);
    out.push(t.slice(i, end));
    i = end - overlap;
    if (i < 0) i = 0;
  }
  return out;
}
