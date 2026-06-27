// ~6 MB decoded — comfortably covers a 0.9-quality webcam JPEG while capping abuse.
// (The urlencoded body limit is 8 MB of base64, i.e. ~6 MB decoded.)
const MAX_DECODED_BYTES = 6 * 1024 * 1024;

/** Decodes a "data:image/...;base64,<data>" URL into a Buffer, or null. Doesn't
 *  trust the data-URL prefix: it verifies the decoded bytes are actually a JPEG or
 *  PNG (magic bytes) and caps the decoded size, so a mislabelled or oversized
 *  payload is rejected rather than passed downstream to the face decoder. */
export function dataUrlToBuffer(s: string): Buffer | null {
  const m = /^data:image\/[a-zA-Z+]+;base64,(.+)$/.exec(s ?? "");
  if (!m) return null;
  let buf: Buffer;
  try {
    buf = Buffer.from(m[1], "base64");
  } catch {
    return null;
  }
  if (buf.length < 4 || buf.length > MAX_DECODED_BYTES) return null;
  // JPEG = FF D8 FF; PNG = 89 50 4E 47. The kiosk captures JPEG; PNG is allowed too.
  const isJpeg = buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
  const isPng = buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
  if (!isJpeg && !isPng) return null;
  return buf;
}
