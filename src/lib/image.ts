/** Decodes a "data:image/...;base64,<data>" URL into a Buffer, or null. */
export function dataUrlToBuffer(s: string): Buffer | null {
  const m = /^data:image\/[a-zA-Z+]+;base64,(.+)$/.exec(s ?? "");
  if (!m) return null;
  try {
    return Buffer.from(m[1], "base64");
  } catch {
    return null;
  }
}
