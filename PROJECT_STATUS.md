# TRGBI Site Attendance — Project Status

_Last updated: 2026-06-19 · Repo: `laboffuture/Site_attendance` (branch `main`) · Latest commit: `d5d013c`_

A face-recognition attendance system for daily-wage construction workers across branches and project sites — location-locked scanning, automatic overtime with an approval workflow, role-scoped dashboards, a request/approval subsystem, and a responsive web UI (mobile layout below 768px).

**Stack:** Node 22 · Express · TypeScript · MongoDB (Mongoose) · server-rendered EJS (Horilla `oh-` design, LOF-blue) · face recognition via `@vladmandic/face-api` on the TensorFlow.js WASM backend (pure JS, no native build) · Chart.js · ExcelJS + PDFKit.

**Verification:** 13 end-to-end test suites, all passing (`npm run e2e:*`). Every feature below was committed only after its suite + the full suite passed.

---

## ✅ DONE (built, tested, pushed)

### Foundation
- **Scaffold & boot** — Express + TS + Mongoose + EJS; tolerant DB boot; compiled `npm start` works (views copied into `dist/`).
- **Auth & sessions** — email + bcrypt login, Mongo-backed sessions (connect-mongo), session-fixation guard.

### Roles & permissions (current hierarchy)
- **Super Admin → Management → HR → PM → Supervisor.** (PE removed; "Super Admin / Management / HR" act as one admin approval group.)
- Capability matrix in one place (`src/auth/permissions.ts`); route guards + nav visibility driven by it.
- Site scoping: admins see all sites; PM & Supervisor limited to assigned sites (one or more).
- Migration script (`npm run migrate-roles`) converts old data (pe→supervisor, bootstrap admin→super_admin).

### Organization
- **Branches / Project sites / Designations** CRUD (Management); unique codes, configurable shift times, optional per-designation overrides, per-site GPS coordinates.
- **Site Stations** — register a capture device bound to one site; one-time station key.
- Supervisor gets **read-only Branches & Sites**, scoped to their sites.

### Employees (formerly "Workers")
- Enrollment with **manual unique Employee ID**, designation, site, **phone, emergency phone, email, optional bank details (a/c holder, number, IFSC, bank)**, date of joining, face capture (webcam/upload, single-face required).
- Employee list + edit, active/inactive, site-scoped.

### Attendance
- **Site Station kiosk:** webcam scan → server face-match against all enrolled → **location-lock** (worker's site must equal station's site, else reject + flag).
- In/Out (last-scan-wins, IST day); **overtime computed** on Out.
- **GPS capture** at scan (capture-only, never blocks; distance-from-site shown).
- **Manual mark/override** page (per-site daily grid) for failed scans / corrections; entries tagged `manual`.
- **Nightly missed-clock-out sweep** (default 23:00 IST; `npm run sweep`); raises flags, never invents an out-time.

### Overtime
- **Approval queue** — pending/approved/rejected; approve / adjust hours / reject (records approver + notes). Approval = admin group; PM view-only.
- **Reports split:** Standard ("work done", capped at site shift) vs Overtime; **OT red until approved, green once approved**; displayed Total counts only **approved** OT (pending shown separately).

### Requests subsystem (`/requests`)
- **Scheduled overtime requests** (future OT: worker, date, from–to, remarks; hours auto-computed).
- **Offload suggestions** (Supervisor can only suggest, reason required; PM can initiate).
- Flow: create → **PM recommends (mandatory)** → admin approves/rejects. **No withdraw** once raised. Offload approval deactivates the worker.

### Dashboards & reporting
- Role-scoped dashboard: stat cards, **present/total + % present**, Chart.js (attendance trend, OT by site, headcount by designation), **assigned-location chips**, **present-vs-active by-site chart**, **branch→site rollup** (senior roles), recent flags.
- Dashboard **site filter** for multi-site users.
- **Reports**: filter by date/site/designation/worker, grouped branch→site; **PDF + Excel download**; flagged-events page (list + resolve, scoped).

### Users & Roles
- Create/edit/deactivate staff; assignment authority by tier; self-lockout guard; friendly role labels.

### UI / platform
- **Responsive mobile UI** below 768px (bottom-nav + "More" bottom-sheet drawer; table→card layouts on Dashboard, Employees, Attendance, Overtime, Flagged, Users, Reports, Requests). Desktop unchanged.
- Richer attendance-trend card (area + headline KPI).
- **Deployment ready:** `docs/DEPLOYMENT.md` (Linux + PM2 + MongoDB Atlas behind a TLS proxy), `ecosystem.config.cjs`, configurable `UPLOAD_DIR`, production cookie hardening.
- Mobile **app plan** docs under `mobile/` (Capacitor wrapping the responsive web — not yet built).

---

## ⏳ PENDING

### Employee lifecycle (unblocked — roles now settled)
- **#28 Onboarding + remarks + soft-delete** — a remarks field; soft-delete (retain history) with mandatory reason; cancel/clear a remark. _(Offload approval already sets inactive; this is the fuller plumbing.)_
- **#29 Returning-worker conflict + notify** — on re-registration, match prior/deleted records by **phone + ID + name + email**; if flagged, raise a conflict showing prior remarks and route to admin for re-approval + notification.
- **#25 Employee registration approval chain** — Supervisor registers → PM recommends → HR/admin final-approves → active (pending until then).

### Reporting
- **#35 Flexible downloads** — per-person / site / location/branch / group-based report files.
- **#27 Site-wise export + exact Google-Sheet format** — _waiting on the exact column layout you will provide._

### UI polish
- **#21 Mobile forms + auth/kiosk polish** — finish card-ifying the remaining admin tables (Designations / Stations) on mobile.
- Attendance-page visualization (locations + active workers) — light, planned next.

### Compliance / hardening (before real rollout)
- DPDP biometric **consent capture** + retention policy (face data + GPS are sensitive personal data).
- **Liveness / anti-spoofing** (server-verified blink) — designed, queued; stops held-up-photo cheating.
- Password reset + login rate-limiting.
- Optional **geofence enforcement** (per-site radius already stored, not enforced).

### Platform (future)
- Salary module (daily wage + food allowance) — deferred per request.
- Mobile **Capacitor app** build (the `mobile/` plan).
- Cloud deploy onto TRGBI infrastructure (artifacts ready; needs Atlas URI + server access).
- TRGBI brand color (currently LOF blue).

---

## How to run / verify

```bash
npm install
cp .env.example .env          # set MONGODB_URI, SESSION_SECRET
npm run sync-indexes          # reconcile DB indexes
npm run seed                  # first Super Admin + branches/sites/designations
npm run dev                   # http://localhost:3000   (default admin: admin@trgbi.com / ChangeMe123!)
```

**Tests:** `npm run e2e:login | org | workers | station | overtime | reports | users | hierarchy | attendance | missed | geo | supervisor | requests`
**Demo data:** `npm run demo-prep` (seeds sample data + a station key) · `npm run clean_demo`-equivalent via `scripts/clean_demo.ts` (remove demo data — required before face suites).

See also: `README.md`, `docs/DEPLOYMENT.md`, and the design log `docs/superpowers/specs/2026-06-18-site-attendance-design.md`.
