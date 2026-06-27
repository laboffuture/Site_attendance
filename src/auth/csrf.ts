import { RequestHandler } from "express";

const UNSAFE = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * Extra hostnames to accept as same-origin, for deployments where the app's
 * Host header doesn't equal the public hostname (a reverse proxy that doesn't
 * forward Host, a www/non-www split, an IP-vs-domain mix). Comma-separated
 * hostnames, no scheme or port. e.g. TRUSTED_HOSTS="attendance.example.com,www.attendance.example.com"
 */
const TRUSTED_HOSTS = (process.env.TRUSTED_HOSTS || "")
  .split(",")
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

/** The hostname (no scheme, no port) of an Origin/Referer value, or null. */
function hostnameOf(value: string): string | null {
  try {
    return new URL(value).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Origin-based CSRF protection — OWASP's "verify origin with standard headers".
 *
 * A browser always attaches an `Origin` (or at least a `Referer`) to a cross-site
 * state-changing request, so a forged POST from another site is rejected on a
 * hostname mismatch. Same-origin form posts and the kiosk AJAX match and pass.
 * Non-browser clients (the health check, server-to-server calls, the e2e suites)
 * send neither header and are allowed — they can't ride a victim browser's
 * cookies, so they are not a CSRF vector. Layers on the sameSite:lax cookie; no
 * per-form tokens.
 *
 * Robustness: we compare HOSTNAMES (port-insensitive) using `req.hostname`, which
 * resolves to the forwarded host (X-Forwarded-Host) behind the production
 * trust-proxy and falls back to the Host header otherwise. If a proxy can't be
 * made to present the right host, set TRUSTED_HOSTS to the public hostname(s).
 * Every block is logged with the actual values so a misconfiguration is visible.
 */
export const csrfGuard: RequestHandler = (req, res, next) => {
  if (!UNSAFE.has(req.method)) return next();

  const source = req.get("origin") || req.get("referer");
  if (!source) return next(); // no browser-supplied origin → not a CSRF vector

  const sourceHost = hostnameOf(source);
  if (!sourceHost) return next(); // unparseable/"null" origin → can't prove cross-site; sameSite:lax still guards

  const reqHost = (req.hostname || "").toLowerCase();
  if (sourceHost === reqHost || TRUSTED_HOSTS.includes(sourceHost)) return next();

  console.warn(
    `CSRF block: ${req.method} ${req.originalUrl} — request Origin/Referer host "${sourceHost}" ` +
      `does not match the server host "${reqHost}". If this is legitimate, make the proxy forward the ` +
      `public Host header (or set TRUSTED_HOSTS="${sourceHost}").`,
  );
  return res.status(403).type("text").send("Request blocked: cross-site origin not allowed.");
};
