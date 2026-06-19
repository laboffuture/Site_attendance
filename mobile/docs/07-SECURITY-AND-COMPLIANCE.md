# 07 · Security & compliance (publishing gates)

These items **gate any non-test rollout** of a biometric app. Treat them as
blockers, not polish.

## Biometrics & India's DPDP Act (highest priority)

Face encodings are **sensitive personal data**. Before real users:

1. **Consent capture at enrollment**
   - Add a required, explicit consent step in the enroll flow (worker/their
     representative agrees to face capture for attendance).
   - Store consent: a `consentGivenAt` timestamp (+ who recorded it) on the
     worker record. Block enrollment without it.
2. **Retention & deletion policy**
   - Define how long encodings/photos are kept after a worker leaves.
   - Provide a deletion path (deactivate + purge encoding/photo) and document
     it in the privacy policy.
3. **Encryption**
   - TLS in transit (hosting requirement).
   - Encrypt at rest where the platform allows (Atlas encryption at rest;
     consider field-level handling for the encoding/photo).
4. **Access control & audit**
   - Encodings are only ever matched server-side; never exposed to the client.
   - Log who enrolled/edited/deleted a worker (the schema already records
     `markedBy` on attendance; extend to enrollment changes).
5. **Privacy policy** — a public URL describing all of the above (required by
   Play; see `06-PLAY-STORE.md`).

> This is a legal/compliance review, not just code. Get sign-off before rollout.

## Anti-spoofing / liveness (fraud control)

The current face match accepts any image — **a held-up photo would pass**, which
is buddy-punching risk for a payroll system. Before relying on attendance for
pay, add a liveness/anti-spoofing step (e.g. blink/turn challenge, or a
server-side liveness model). Track as a dedicated feature.

## Auth hardening (currently missing)

| Gap | Action |
|---|---|
| No password reset | Add a reset flow (email or admin-initiated) |
| No login rate-limiting | Add per-IP / per-account throttling + lockout/backoff |
| Session fixation | Regenerate session id on login (verify) |
| Weak secret risk | Enforce a strong `SESSION_SECRET` in prod (already env-driven) |

## App & transport security
- **HTTPS only**, cleartext disabled in the Capacitor config.
- **No secrets in the app bundle** — remote-WebView ships none; keep it so.
- Set sensible security headers on the backend (CSP that still allows the
  camera + needed inline scripts; `X-Content-Type-Options`, etc.).
- Validate the camera permission is requested with a clear in-app rationale.

## Pre-rollout security checklist
- [ ] Consent capture implemented + stored.
- [ ] Retention/deletion policy written + deletion path works.
- [ ] Privacy policy URL live (biometric-specific).
- [ ] Liveness/anti-spoofing in place (or risk formally accepted in writing).
- [ ] Password reset + login rate-limiting shipped.
- [ ] HTTPS enforced; no cleartext; no bundled secrets.
- [ ] Atlas encryption at rest + backups on.
