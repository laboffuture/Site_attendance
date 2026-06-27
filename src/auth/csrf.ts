import { RequestHandler } from "express";

const UNSAFE = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * Origin-based CSRF protection — OWASP's "verify origin with standard headers".
 *
 * A browser always attaches an `Origin` header to a cross-site state-changing
 * request, so a forged POST submitted from another site (`Origin: https://evil`)
 * is rejected on host mismatch. Same-origin form posts and our own kiosk AJAX
 * carry a matching Origin and pass. Non-browser clients (the health check, any
 * server-to-server call, the e2e suites) send no Origin/Referer at all and are
 * allowed — they are not a CSRF vector, since CSRF requires riding a victim
 * browser's cookies. This layers on top of the sameSite:lax session cookie and
 * needs no per-form tokens.
 *
 * `req.get("host")` resolves to the forwarded host behind the production
 * trust-proxy, so the comparison works the same in dev and behind TLS.
 */
export const csrfGuard: RequestHandler = (req, res, next) => {
  if (!UNSAFE.has(req.method)) return next();

  const source = req.get("origin") || req.get("referer");
  if (!source) return next(); // no browser-supplied origin → not a CSRF vector

  const host = req.get("host");
  let sourceHost: string | null = null;
  try {
    sourceHost = new URL(source).host;
  } catch {
    sourceHost = null; // malformed / "null" origin → fall through to block
  }
  if (sourceHost && host && sourceHost === host) return next();

  // Minimal, render-free response: this only fires on an actual cross-site
  // attempt (or a proxy misconfiguration), so a plain 403 is the safe answer.
  return res.status(403).type("text").send("Request blocked: cross-site origin not allowed.");
};
