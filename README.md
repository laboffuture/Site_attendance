# TRGBI Site Attendance & Workforce Management

Face-recognition attendance for daily-wage construction workers across branches and project sites — with **location-locked** scanning, automatic **overtime** computation, an HR/Management **approval** workflow, role-scoped **dashboards**, and **PDF / Excel** report exports.

- **Spec:** [`site-attendance-system-spec.md`](site-attendance-system-spec.md)
- **Design & build log:** [`docs/superpowers/specs/2026-06-18-site-attendance-design.md`](docs/superpowers/specs/2026-06-18-site-attendance-design.md)

## Stack
Node 22 · Express · TypeScript · MongoDB (Mongoose) · server-rendered EJS in the Horilla `oh-` design (LOF-blue accent) · `express-session` (+ connect-mongo) auth · face recognition via `@vladmandic/face-api` on the TensorFlow.js **WASM** backend (pure JS — no native build) · Chart.js · ExcelJS + PDFKit.

## How it works
- **Five roles** (Management ▸ HR ▸ PM ▸ PE ▸ Supervisor). Daily-wage **workers are not users** — they exist only as face-enrolled records.
- A **Site Station** (a fixed laptop) signs in once with a station key and is bound to one project site.
- A worker scans → the server matches the face against *all* enrolled workers, then applies the **location lock**: the matched worker's assigned site must equal the station's site, or the scan is **rejected and flagged**.
- First scan of the day = **In**; later scans update **Out** (last-scan-wins). On Out, **overtime = max(0, total − site standard hours)** is computed and left **pending** until HR/Management approve it. Only approved overtime reaches reports.

## Setup (Windows / PowerShell)

```powershell
npm install
Copy-Item .env.example .env     # then edit: MONGODB_URI, SESSION_SECRET, COMPANY_NAME
npm run seed                    # first Management admin + branches/sites/designations
npm run dev                     # http://localhost:3000
```

The server boots even if the database is unreachable (the login page still renders); set a reachable `MONGODB_URI` to enable data features. Default dev admin (change after first login): `admin@trgbi.com` / `ChangeMe123!`.

### Setting up a Site Station (kiosk)
1. Sign in as Management → **Stations** → register a station for a site. Copy the **station key** shown once.
2. On the site laptop, open `/station/login` and paste the key.
3. The laptop now shows the **capture screen** for that site at `/station`. Enroll workers under **Workers → Enroll**, then scan.

## Scripts
| Command | What it does |
|---|---|
| `npm run dev` | Dev server with hot reload (tsx watch) |
| `npm run build` | Type-check & compile to `dist/` |
| `npm start` | Run the compiled server (`dist/server.js`) |
| `npm run seed` | Create the first admin + seed org reference data |
| `npm run sweep` | Raise `missed_clockout` flags for any open (In-only) attendance records — also runs automatically nightly |
| `npm run sync-indexes` | Reconcile MongoDB indexes with the schemas |
| `npm run e2e:login \| org \| workers \| station \| overtime \| reports \| users \| hierarchy \| attendance \| missed` | End-to-end test suites |

All suites are runnable against a local MongoDB; together they cover auth, permissions, org CRUD, enrollment + face encoding, capture + location-lock + OT, the approval queue, dashboards/reports/exports, and user management.

## Deployment
- Set `NODE_ENV=production` (enables `trust proxy` + secure session cookies — terminate TLS at a proxy/load balancer), a strong `SESSION_SECRET`, and a managed `MONGODB_URI` (e.g. MongoDB Atlas).
- `npm run build && npm start`.
- Run `npm run seed` once against the production DB, then change the admin password.
- `public/uploads/` (worker photos) and `.env` are git-ignored — provide persistent storage for uploads in production.

## Notes & follow-ups
- **Report columns** use sensible defaults (Branch, Project, Emp Reg No, Name, Designation, Date, In, Out, Total, OT, OT Status); adjust in `src/lib/exporters.ts` to match a final reference sheet.
- **Missed clock-outs**: a nightly in-process sweep (default **23:00 IST**, set `SWEEP_TIME`) raises a `missed_clockout` flag for any record left open (In scanned, no Out); it never invents an out-time — HR corrects it on the Attendance page. Runnable on demand via `npm run sweep`.
- **Biometrics**: face encodings are sensitive personal data under India's DPDP Act — confirm consent capture and retention policy before go-live (compliance review, not a code task).
