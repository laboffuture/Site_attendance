# TRGBI Site Attendance & Workforce Management

**Face-recognition attendance & workforce management for daily-wage construction crews**, built for TRGBI across multiple branches and project sites.

Workers clock in and out by having their face scanned at a fixed **Site Station** (a laptop bound to one site). The server matches the face against every enrolled worker and enforces a **location lock** — a worker can only be marked present at the site they're assigned to, otherwise the scan is rejected and flagged. From there the system computes **overtime**, runs a multi-role **recommend → approve** workflow (overtime, attendance regularization, requests, manpower allocation), surfaces role-scoped **dashboards**, and exports **PDF / Excel / CSV** reports and payroll.

- **Product spec:** [`site-attendance-system-spec.md`](site-attendance-system-spec.md)
- **Design & build log:** [`docs/superpowers/specs/2026-06-18-site-attendance-design.md`](docs/superpowers/specs/2026-06-18-site-attendance-design.md)
- **Current status:** [`PROJECT_STATUS.md`](PROJECT_STATUS.md)

---

## Contents

- [What it does](#what-it-does)
- [Tech stack](#tech-stack)
- [Roles](#roles)
- [Getting started](#getting-started)
- [Environment variables](#environment-variables)
- [Project structure](#project-structure)
- [Deployment](#deployment)
- [API surface](#api-surface)
- [Hub / module contract](#hub--module-contract)
- [Deeper docs](#deeper-docs)

---

## What it does

- **Face-based clock in/out** — a worker scans at a Site Station; the server matches the face server-side against all enrolled workers (no client-side model needed for matching).
- **Location lock** — the matched worker's assigned site must equal the station's site, or the scan is **rejected and flagged** (`wrong_site`).
- **In / Out logic** — first accepted scan of the day = **In**; a later scan sets **Out** (last-scan-wins). On Out, **overtime = max(0, total − site standard hours)** is computed and left **pending**. Only *approved* overtime reaches reports and payroll.
- **Missed clock-out sweep** — a nightly in-process job (default **23:00 IST**, `SWEEP_TIME`) raises a `missed_clockout` flag for any record left open (In, no Out). It never invents an out-time — HR corrects it.
- **Approval workflows** — overtime, daily **attendance regularization**, **requests** (scheduled OT / offload), and **manpower allocation** each follow a *submit/recommend → close* chain (see [Roles](#roles)).
- **Employees (workers)** — enrollment with a captured face photo/encoding, designations, soft-delete + restore, and per-worker remarks.
- **Org & stations** — branches → project sites → site stations (kiosk keys), plus users & roles with per-user capability overrides.
- **Dashboards & reports** — role-scoped home dashboard; a Reports hub with attendance / employees / overtime / manpower reports and **PDF / Excel / CSV** exports; a payroll page with arrears and exports.

## Tech stack

| Layer | Choice |
|---|---|
| Runtime | **Node 22**, **TypeScript** (`tsx` in dev, `tsc` build) |
| Web | **Express 4** (`express-async-errors`, `express-rate-limit`, `helmet`, `morgan`) |
| Views | Server-rendered **EJS** in the Horilla `oh-` design system (LOF-blue accent) |
| Data | **MongoDB** via **Mongoose 8** |
| Auth / session | `express-session` + **connect-mongo** store; bcrypt password hashing; Origin/Referer **CSRF guard** |
| Face recognition | `@vladmandic/face-api` on the **TensorFlow.js WASM** backend (pure JS — no native build) |
| Reports | **ExcelJS** (xlsx), **PDFKit** (pdf), CSV; **Chart.js** for dashboards; **qrcode** for station links |
| Process mgmt | **PM2** (`ecosystem.config.cjs`) |

## Roles

Four roles, defined in `src/models/User.ts` and enforced by the capability matrix in [`src/auth/permissions.ts`](src/auth/permissions.ts). **Management + HR see all sites; PM + Supervisor are scoped to their `assignedSiteIds`.** Daily-wage **workers are not users** — they exist only as face-enrolled records.

| Capability area | Management | HR | PM | Supervisor |
|---|:---:|:---:|:---:|:---:|
| Dashboard / Reports | ✅ | ✅ | ✅ | ✅ |
| Attendance (log + submit) | log only | ✅ | ✅ | ✅ |
| Enroll employees | ✅ | ✅ | ✅ | ✅ |
| Requests / Manpower (raise) | ✅ | ✅ | ✅ | ✅ |
| Stations (key + share) | ✅ | ✅ | ✅ | ✅ |
| **Recommend** OT / Reg / Requests | — | ✅ | ✅ | — |
| **Approve / close** (all workflows) | ✅ | — | — | — |
| Users & Roles, Designations, Branches & Sites | ✅ | ✅ | — | — |
| Payroll, Flagged, Manpower allocation | ✅ | ✅ | — | — |

**Approval authority:** HR + PM **recommend** across Overtime / Regularization / Requests; **Management is the last to close** (approve / decide). Supervisor logs & submits but does not recommend. A user can also be granted an explicit per-user capability list that overrides their role defaults (`userCan`).

## Getting started

**Prerequisites:** Node ≥ 20 (22 recommended) and a reachable MongoDB (local or Atlas).

```powershell
npm install
Copy-Item .env.example .env     # then edit MONGODB_URI, SESSION_SECRET, COMPANY_NAME
npm run seed                    # first Management admin + branches/sites/designations
npm run dev                     # http://localhost:3000
```

The server boots even if the database is unreachable (the login page still renders); point `MONGODB_URI` at a reachable DB to enable data features. Default dev admin (change after first login): `admin@trgbi.com` / `ChangeMe123!`.

**Set up a Site Station (kiosk):**
1. Sign in as Management → **Stations** → register a station for a site. Copy the **station key** shown once.
2. On the site laptop, open `/station/login` and paste the key.
3. The laptop now shows the **capture screen** for that site at `/station`. Enroll workers under **Employees → Enroll**, then scan.

**Common scripts:**

| Command | What it does |
|---|---|
| `npm run dev` | Dev server with hot reload (`tsx watch`) |
| `npm run build` | Type-check & compile to `dist/` (also copies EJS views) |
| `npm start` | Run the compiled server (`dist/server.js`) |
| `npm run seed` | Create the first admin + seed org reference data |
| `npm run sweep` | Raise `missed_clockout` flags for open records (also runs nightly) |
| `npm run sync-indexes` | Reconcile MongoDB indexes with the schemas |
| `npm run migrate-roles` / `migrate-shifts` | One-off data migrations |
| `npm run e2e:*` | End-to-end suites (login, org, workers, station, overtime, reports, attendance, payroll, manpower, regularization, …) |

## Environment variables

All configuration comes from `.env` (git-ignored). The canonical list is [`.env.example`](.env.example) — copy it and fill in real values.

| Variable | Purpose | Default (dev) |
|---|---|---|
| `PORT` | HTTP port | `3000` |
| `MONGODB_URI` | MongoDB connection string (local or `mongodb+srv://` Atlas) | `mongodb://localhost:27017` |
| `DB_NAME` | Database name | `trgbi_attendance` |
| `SESSION_SECRET` | Long random string for signing session cookies | `change-me-to-a-long-random-string` |
| `COMPANY_NAME` | Branding shown across the UI | `TRGBI` |
| `UPLOAD_DIR` | Where enrollment photos are stored (served at `/static/uploads`); point at a persistent volume in prod | *(commented)* |
| `SWEEP_TIME` | IST `HH:MM` the nightly missed-clock-out sweep fires | `23:00` |
| `SEED_ADMIN_NAME` / `SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD` | First Management admin created by `npm run seed` | `admin@trgbi.com` / `ChangeMe123!` |

## Project structure

```
Site_attendance/
├── src/
│   ├── app.ts               # Express app factory: middleware, security, router mounts
│   ├── server.ts            # boot: connect DB → createApp → listen; nightly sweep
│   ├── config.ts            # env → typed config
│   ├── db.ts                # Mongoose connection + dbReady flag
│   ├── nav.ts               # sidebar NavItem[] (label, href, icon, cap, ready)
│   ├── auth/                # permissions matrix, middleware, CSRF, password, station auth
│   ├── models/              # Mongoose schemas (User, Worker, Attendance, ProjectSite, …)
│   ├── lib/                 # domain logic (attendance, payroll, report, shift, geo, face, …)
│   ├── routes/              # one router per module (see API surface)
│   ├── views/               # EJS templates + partials (app shell, sidebar, topbar)
│   └── types/               # ambient d.ts augmentations
├── public/                  # static assets served at /static (js, css, img, vendor, models)
├── models/face/             # face-api model weights (server-side matching)
├── scripts/                 # seed, sweep, migrations, e2e/* suites, dev utilities
├── docs/                    # DEPLOYMENT.md + superpowers specs & plans
├── mobile/                  # mobile app design docs (roadmap)
├── brand/                   # logo assets
├── ecosystem.config.cjs     # PM2 process config
└── .env.example             # environment variable template
```

## Deployment

**Full step-by-step:** [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) — Linux + PM2 + MongoDB Atlas behind a TLS-terminating proxy.

In short:
- Set `NODE_ENV=production` (enables `trust proxy` + secure session cookies — terminate TLS at a proxy/load balancer), a strong `SESSION_SECRET`, a managed `MONGODB_URI` (Atlas), and `UPLOAD_DIR` on a persistent volume.
- `npm ci && npm run build` (the build copies EJS views into `dist/`), then run `dist/server.js` via PM2 (`pm2 start ecosystem.config.cjs`) or systemd.
- Run `npm run sync-indexes` then `npm run seed` once against the production DB, then change the admin password.
- **Health probe:** `GET /healthz` returns `200 {status:"ok"}` when the DB is connected, `503 {status:"degraded"}` otherwise — wire it to your load balancer.
- `.env` and the uploads dir are git-ignored — keep secrets in `.env`; back up the uploads volume + Atlas.
- **Biometrics note:** face encodings are sensitive personal data under India's DPDP Act — confirm consent capture and retention policy before go-live.

## API surface

Server-rendered routes (return HTML unless noted). State-changing `POST`s are same-origin form/AJAX and pass the CSRF Origin guard. Every route is capability-gated per [Roles](#roles).

**System**
- `GET /healthz` — readiness probe (JSON; 200 ok / 503 degraded)

**Auth & self**
- `GET /` · `POST /login` · `POST /logout`
- `POST /me/location-check`

**Site Station (kiosk)**
- `GET,POST /station/login` · `POST /station/logout` · `GET /station`
- `POST /station/scan` — face scan → In/Out (rate-limited)

**Attendance & regularization**
- `GET /attendance` · `GET,POST /attendance/scan` · `POST /attendance/geocheck` · `GET,POST /attendance/submit`
- `GET /regularization` · `GET /regularization/:siteId/:date`
- `POST /regularization/:siteId/:date/{recommend,approve,create}`
- `POST /regularization/worker/:attendanceId/{reject,correct,void,verify}`

**Overtime**
- `GET /overtime` · `POST /overtime/:id/{recommend,approve,reject}`

**Requests**
- `GET /requests` · `GET /requests/new` · `POST /requests`
- `POST /requests/:id/{recommend,approve,reject}`

**Manpower allocation**
- `GET /manpower` · `GET /manpower/new` · `GET /manpower/board` · `GET /manpower/allocations` · `GET /manpower/:id`
- `POST /manpower` · `POST /manpower/:id/{allocate,deallocate,cancel}`
- `GET,POST /manpower/outsource` · `POST /manpower/outsource/:id`

**Employees (workers)**
- `GET /workers` · `GET /workers/new` · `POST /workers` · `GET /workers/:id` · `GET /workers/:id/edit` · `POST /workers/:id`
- `POST /workers/:id/{delete,restore}` · `POST /workers/:id/remarks` · `POST /workers/:id/remarks/:idx/clear`
- `GET,POST /workers/:id/face`

**Org, stations, designations, users**
- `GET /org` · branches: `GET /org/branches` · `POST /org/branches` · `GET /org/branches/:id/edit` · `POST /org/branches/:id` · `POST /org/branches/:id/delete`
- sites: `GET /org/sites/new` · `POST /org/sites` · `GET /org/sites/:id` · `GET /org/sites/:id/edit` · `POST /org/sites/:id` · `POST /org/sites/:id/delete`
- `GET /stations` · `GET /stations/new` · `POST /stations` · `POST /stations/:id/{regenerate,toggle,delete}`
- `GET /designations` · `POST /designations` · `GET /designations/:id/edit` · `POST /designations/:id` · `POST /designations/:id/delete`
- `GET /users` · `GET /users/new` · `POST /users` · `GET /users/:id` · `GET /users/:id/edit` · `POST /users/:id` · `POST /users/:id/toggle`

**Dashboard, reports, payroll, flags**
- `GET /dashboard`
- `GET /reports` (hub) · `GET /reports/attendance` · `GET /reports/employees` · `GET /reports/overtime` — each with `export.{xlsx,csv,pdf}` variants
- `GET /payroll` · `POST /payroll/arrears` · `GET /payroll/export.{csv,xlsx,pdf}`
- `GET /flags` · `POST /flags/:id/{resolve,fix-clockout,submit-day}`

## Hub / module contract

The app is a set of self-contained **modules**, each mounted at `/` in `src/app.ts`. To be a first-class module (and appear in the sidebar / respect permissions), a module follows this contract:

1. **Capability** — declare a `Capability` string in [`src/auth/permissions.ts`](src/auth/permissions.ts) and map it to the roles allowed (`CAPABILITY_ROLES`). This is the single source of truth for both route guards and nav visibility.
2. **Nav entry** — add a `NavItem` to `NAV` in [`src/nav.ts`](src/nav.ts): `{ label, href, icon, cap, ready }`. The sidebar shows an item only if the current user's capability allows it. `ready: false` renders the item greyed with a "soon" tag — **no dead links**.
3. **Router** — create `src/routes/<module>.ts` exporting an Express `Router`, guard each handler with the capability (via the auth middleware / `userCan`), and mount it in `createApp()` (`app.use("/", <module>Router)`).
4. **Views** — put EJS under `src/views/<module>/`; they render inside the shared app shell (`partials/` sidebar + topbar), which reads `res.locals.nav`, `currentUser`, `can`, and `flash`.
5. **Scoping** — for site-scoped roles (PM/Supervisor), filter data by the user's `assignedSiteIds`; `seesAllSites(role)` short-circuits for Management/HR.
6. **Reports hub tile** *(optional)* — a module that produces a report registers a tile in the **Reports hub** handler (`src/routes/reports.ts`), gated by its capability, so its headline metric and export links appear alongside the others.

Cross-cutting middleware every request already passes through (set up in `createApp`): security headers (helmet + CSP), rate limits on auth/scan, session load, `loadCurrentUser`, and the CSRF Origin guard. Template defaults (`company`, `nav`, `currentUser`, `can`, `roleLabel`, `flash`) are injected before routing, so views don't need to wire them.

## Deeper docs

| Doc | What's inside |
|---|---|
| [`site-attendance-system-spec.md`](site-attendance-system-spec.md) | Full product specification |
| [`PROJECT_STATUS.md`](PROJECT_STATUS.md) | Current build status & follow-ups |
| [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) | Production deployment (Linux + PM2 + Atlas) |
| [`docs/superpowers/specs/`](docs/superpowers/specs/) | Design specs — site attendance, employee lifecycle, shift/OT engine, regularization, dashboard, face onboarding, management experience, manpower, in/out logic, flag resolution |
| [`docs/superpowers/plans/`](docs/superpowers/plans/) | Implementation plans behind each feature |
| [`mobile/README.md`](mobile/README.md) + [`mobile/docs/`](mobile/docs/) | Mobile app architecture, screens, hosting, Play Store, security & roadmap |

---

*Built for TRGBI · Lab of Future (LOF).*
