import crypto from "crypto";

/** A station key is high-entropy, so a fast deterministic hash (sha256) is
 *  appropriate — and lets us look a station up by hash in O(1), unlike bcrypt. */
export function generateStationKey(): string {
  return crypto.randomBytes(24).toString("base64url");
}

export function hashStationKey(key: string): string {
  return crypto.createHash("sha256").update(key).digest("hex");
}
