# TRG-Attendance — Team Handoff

Construction-site labour **attendance + payroll** platform. Express + TypeScript +
Mongoose + server-rendered EJS. Face-recognition kiosk scan, GPS/geofence, role-based
approval chain, payroll export.

> Branches `main` and `feature/face-onboarding` are kept in sync on
> `github.com/laboffuture/Site_attendance`. Work off `main`.

---

## 1. Get it running (new machine)

```bash
git clone https://github.com/laboffuture/Site_attendance.git
cd Site_attendance
npm ci
cp .env.example .env          # then fill in the values (see below)
npm run build                 # tsc -> dist/ + copy views/assets
npm run seed                  # creates the 5 role logins + base data (dev only)
npm run dev                   # tsx watch on http://localhost:3000
```

**`.env` you must set** (see `.env.example` for the full list):
- `MONGODB_URI` — a MongoDB you can reach (local `mongodb://localhost:27017` or Atlas).
- `DB_NAME=trgbi_attendance`
- `SESSION_SECRET` — any long random string in dev; **required** in prod (app refuses to boot without it).
- `SEED_ADMIN_PASSWORD` — the first-login admin password (dev default `ChangeMe123!`; **required** in prod).

Seed admin login: `admin@trgbi.com` / `<SEED_ADMIN_PASSWORD>` (role: management).

**Tests** (need a reachable MongoDB): `npm run e2e:<suite>` — e.g. `e2e:payroll`,
`e2e:hardening`, `e2e:regularization`, `e2e:reports`. There are ~30 suites; each is
self-contained and prints `PASS:`/`FAIL:` + `... PASSED`/`FAILED`. No aggregate runner —
loop them, or run the ones near your change.

---

## 2. Codebase map

- `src/routes/*` — one router per area (attendance, regularization, overtime, payroll,
  reports, org, workers, users, stations, station (kiosk), manpower, flags, requests, me).
- `src/lib/*` — the logic: `attendance.ts` (scan engine), `payroll.ts`, `report.ts`,
  `exporters.ts` (xlsx/csv/**pdf**), `geo.ts` (geofence), `flagResolve.ts`, `scope.ts`
  (site scoping), `missedClockout.ts` + `forgotSubmit.ts` (nightly sweeps), `scheduler.ts`.
- `src/models/*` — Mongoose schemas. `src/auth/*` — `permissions.ts` (capability RBAC
  matrix), `middleware.ts` (`requireCapability`), `csrf.ts` (Origin guard).
- `src/views/*` — EJS. `public/js|css` — client JS + `theme.css` (the "oh-" design system).
- `src/app.ts` — Express wiring (helmet CSP, rate limits, CSRF, error handlers).

**Key concepts**: capability-based RBAC (`can`/`userCan`/`requireCapability`, per-user
overrides); site-scoping (`canUseSite`/`siteScopeFilter` — PM/Supervisor limited to
`assignedSiteIds`, Management/HR see all); explicit IN/OUT scan (one record per
worker/day, flat OT); a flag queue (`wrong_site_scan`/`missed_clockout`/`forgot_submit`)
that auto-resolves when the underlying record is fixed ("close the loop").

---

## 3. What's completed (recent hardening + polish)

- **Security/ops hardening**: helmet CSP, rate limiting (`/login`, `/station/scan`),
  morgan logging, `/healthz` 503-when-DB-down, graceful shutdown + crash-safety nets,
  fail-fast on missing prod secrets, **Origin-based CSRF guard** (proxy-tolerant, see §5).
- **Correctness fixes**: night-shift manual OUT no longer pays 0h; payroll freezes on the
  stored lunch (breakHours), not live config; stations + overtime cross-site IDORs closed;
  scan re-open resets a submitted day to `scanned`; void clears dangling flags; site/
  designation rename propagates the denormalized names.
- **UI**: regularization day/correction screen restructured (clean read table + single
  edit drawer); flags queue shows Emp ID.
- **PDF export upgraded**: full Emp ID (no truncation), branded header, accent header
  band, zebra rows, right-aligned money, TOTALS row, `Page X of Y` footer.
- **Map fix**: CSP was blocking the Leaflet site-picker map — now allowed.
- Test coverage added for payroll money math, close-the-loop, scan re-open, renames,
  deactivation, CSRF, IDORs. Full suite green (28 suites).

---

## 4. Open work / logical gaps (pick up here)

**Business-logic decisions (captured but NOT enforced — need a product call, then wiring):**
- **OT daily cap** — each site has an `allowedOtHours` field on the form, but payroll/
  `reckonHours` never applies it. Decide: cap daily OT at that value? Then wire it in.
- **Sunday premium** — a `sunday` shift pays the flat rate like any day; no premium
  multiplier. Decide the rate, then apply in the pay math.

**Big open design — co-located sites (< 100 m apart):** GPS can't reliably tell which of
several nearby sites a worker is at (accuracy 5–30 m). Proposed layered fix: fixed kiosk
per site (device = site, already supported), **rotating QR/TOTP** or **NFC tap** as
proof-of-presence, polygon geofence + accuracy gate, and automated cross-site anomaly
flags. Needs a design/spec before building.

**Go-live ops (not code — deployment):**
- Rotate the Atlas credential, set real `SESSION_SECRET` + `SEED_ADMIN_PASSWORD`.
- HTTPS at the reverse proxy; forward `Host` + `X-Forwarded-*` (see §5); `NODE_ENV=production`.
- Mongo + `UPLOAD_DIR` backups; blank-slate the DB before real data.

**Nice-to-have:**
- PDF next tier: company logo, payroll cover/summary page, signature block.
- Phase 2 modules (not started): Assets, Vehicles, Tasks, Staff-vs-Worker.
- Minor: `empRegNo` case-insensitive uniqueness; `exceljs → uuid@8` moderate advisory
  (only triggers with a `buf` arg; fix is a breaking exceljs downgrade).

---

## 5. Deploying behind a reverse proxy (important)

The app reasons about "what host am I?" for CSRF, secure cookies, and kiosk share-links.
Behind nginx/Apache you MUST forward the real host + scheme, and set `NODE_ENV=production`:

**nginx** (in the `location` block):
```nginx
proxy_set_header Host              $host;
proxy_set_header X-Forwarded-Host  $host;
proxy_set_header X-Forwarded-Proto $scheme;
proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
```
**Apache**: `ProxyPreserveHost On` + `RequestHeader set X-Forwarded-Proto "https"`.

If the CSRF guard blocks legit form posts ("Request blocked: cross-site origin not
allowed."), the server logs the exact host mismatch. Immediate escape hatch:
`TRUSTED_HOSTS=your-domain.com` in `.env`. See `DEPLOY.md` for the full runbook
(build → `sync-indexes` → restart, roles, backups, health check).
