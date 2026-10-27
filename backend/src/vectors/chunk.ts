/**
 * Paragraph-aware chunking (~500 tokens ≈ 2,000 characters of Latin-script text such
 * as English or Indonesian) with a small overlap so facts spanning a boundary
 * still land in one chunk.
 */
export function chunkText(text: string, maxChars = 2000, overlapChars = 200): string[] {
  const clean = text.replace(/\r/g, '').trim();
  if (!clean) return [];
  if (clean.length <= maxChars) return [clean];

  const paragraphs = clean.split(/\n{2,}/).flatMap((p) => splitLong(p.trim(), maxChars));
  const chunks: string[] = [];
  let current = '';
  for (const p of paragraphs) {
    if (!p) continue;
    if (current && current.length + p.length + 2 > maxChars) {
      chunks.push(current);
      const tail = current.slice(-overlapChars);
      current = `${tail.slice(tail.indexOf(' ') + 1)}\n\n${p}`;
    } else {
      current = current ? `${current}\n\n${p}` : p;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

function splitLong(paragraph: string, maxChars: number): string[] {
  if (paragraph.length <= maxChars) return [paragraph];
  const sentences = paragraph.split(/(?<=[.!?])\s+/);
  const out: string[] = [];
  let cur = '';
  for (const s of sentences) {
    if (cur && cur.length + s.length + 1 > maxChars) {
      out.push(cur);
      cur = s;
    } else cur = cur ? `${cur} ${s}` : s;
    while (cur.length > maxChars) {
      out.push(cur.slice(0, maxChars));
      cur = cur.slice(maxChars);
    }
  }
  if (cur) out.push(cur);
  return out;
}
