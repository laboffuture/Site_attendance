# TRGBI Site Attendance & Workforce Management — Design

**Date:** 2026-06-18
**Status:** Living document. Sections 1–2 approved; building started at user direction. Stack pivoted to **Node + TypeScript (Express)** per user preference. Sections 3–6 validated just-in-time before each module is built.
**Source spec:** `site-attendance-system-spec.md` (functional source of truth).

---

## Locked decisions

| Area | Decision |
|---|---|
| Company name | **TRGBI** (resolves spec §1 ambiguity) |
| Backend | **Express + TypeScript** (Node 22) |
| Database | **MongoDB Atlas** (cloud), accessed via **Mongoose** ODM |
| Frontend | **Server-rendered EJS templates** in the Horilla `oh-` design system; vanilla JS `getUserMedia` for webcam; Chart.js dashboards |
| Auth | **express-session** cookies (+ connect-mongo store) + bcryptjs hashing + 5-role permission middleware |
| Face recognition | **Server-side** matching via `face-api.js` (TensorFlow.js); optional Python micro-service if accuracy needs it |
| Dev workflow | `npm run dev` (tsx watch, hot reload) |
| Dashboards | **All five roles** get a dashboard, scoped by role. OT approval stays **HR/Management only** |
| Locations | Branches & sites are **DB-driven**, added via a UI dropdown as the company expands |
| Report export | **Download** as PDF and `.xlsx` (no Google API integration) |
| Report column layout | **Pending** — user will supply the exact reference sheet |

---

## 1. Architecture

One central Express app on a cloud server → MongoDB Atlas. All clients are browsers; nothing to install.

Two browser surfaces, one app:
- **Site Station** — fixed site laptop. Capture + enrollment screens. Authenticated as a *station identity* bound to one site.
- **Role dashboard** — Management/HR (all sites), PM (their sites), PE & Supervisor (own site).

**Station ↔ site binding (location-lock foundation):** Each `site_stations` record carries a hashed station key mapped to one `projectSiteId`. The laptop signs in once with that key → long-lived station session → the capture screen always knows "I am Station-X → Site-Y." On scan: face match → compare matched worker's `siteId` to the station's `siteId`. Mismatch → reject, log no time, raise a `flag_event`. Enrollment at a station auto-assigns the new worker to that station's site.

## 2. Data model (MongoDB / Mongoose)

Four document-model moves vs. the spec's relational sketch:
1. **Embed overtime into the attendance record** (1:1) → removes the `overtime_approvals` table.
2. **Embed a PM's site list** as `assignedSiteIds` on the user → removes the `pm_site_assignments` join table.
3. **Denormalize** worker/designation/site/branch *names* onto each attendance record → fast grouped reports without joins/populate.
4. **Wrong-site scans are `flag_events`**, not a flag on attendance (a rejected scan logs no time, so there's no attendance row to flag).

Collections: `branches`, `designations`, `project_sites` (embeds optional per-designation shift overrides), `site_stations`, `users` (`assignedSiteIds`: `[]`=all, `[N]`=PM, `[1]`=PE/Supervisor), `workers` (128-float `faceEncoding`, `photoUrl`), `attendance` (embedded `overtime`, denormalized names), `flag_events`, `counters` (atomic `empRegNo` → `TRGBI-0001`).

**Scope rule:** `assignedSiteIds` on the user gates every dashboard query — `[]` → all sites, else `siteId ∈ assignedSiteIds`.

**Key indexes:** `attendance` {siteId,date}, {workerId,date} unique, {branchId,date}, {"overtime.status"}; `workers` unique empRegNo + {siteId,status}; `users` unique email; `counters` unique key.

## 3. Capture + face-match + location-lock flow  — ✅ RESOLVED & BUILT
Station signs in once with a key (sha256-hashed) → station session bound to one site. Scan → encode probe → `bestMatch` against **all** active workers (so off-site workers are still identified) → location-lock: matched worker's site must equal the station's site, else reject + `flag_event` (no time logged). Day boundary = **IST (Asia/Kolkata)**. First scan of the day = In; later scans update Out (**last-scan-wins**). Missed-clockout detection deferred to a later sweep.

## 4. Overtime computation & approval  — _compute ✅ BUILT; approval = step 7_
On Out: `total = Out − In`; standard hours = site shift (end − start), **no break deduction** (+ optional per-designation override); `overtime = max(0, total − standard)`, status **pending** if >0. Approval workflow (HR/Management approve/adjust/reject) is step 7.

## 5. Dashboards & reporting  — _TBD, validate before build_
Role-scoped views; **grouping by branch → site → supervisor**; OT status always visible (pending/approved/rejected); flagged events; filters (branch/site/date/designation/worker); PDF + xlsx export. Exact column layout pending user's reference sheet.

## 6. Design-system integration & build order  — _in progress_
Replicate the Horilla `oh-` library (sharp corners, 80% base font, BEM `oh-` classes) via EJS templates + a `theme.css` token set. Accent currently LOF blue `#1C4D8C` (single variable, swappable to a TRGBI brand color if provided).

Build order (✅ = done, verified):
1. ✅ Scaffold (Express + TS + Mongoose + EJS; login page; 9 models)
2. ✅ Auth + 5-role permissions (sessions in Mongo, bcrypt, capability matrix, route guards, seed script, app shell with role-scoped sidebar) — verified by `npm run e2e:login`
3. ✅ Org CRUD — branches / project sites (unique codes, shift times) / designations; flash messages; view-only for HR/PM, manage for Management — verified by `npm run e2e:org`
4. ✅ Worker enrollment — webcam/upload capture, 128-d face encoding, auto empRegNo (TRGBI-####), denormalized names, site-scoped list/edit; faceless photos rejected — verified by `npm run e2e:workers`
5. ✅ Site Station capture + location-lock — station key sign-in, kiosk scan screen, match-all + location-lock + flag events — verified by `npm run e2e:station`
6. ✅ Attendance logging + standard-hours / OT computation — In/Out (last-scan-wins, IST), OT = max(0, total − site standard) pending; computed on the Out scan
7. ✅ OT approval queue — pending/approved/rejected filters; HR/Management approve / adjust hours / reject (records approvedBy/at/notes); PM view-only, Supervisor blocked — verified by `npm run e2e:overtime`
8. ✅ Role-scoped dashboards + reports + PDF/xlsx export — dashboard stats + Chart.js (attendance trend, OT by site, headcount by designation) + flags panel; /reports filter + branch→site grouping + .xlsx/.pdf download; /flags list + resolve (scoped) — verified by `npm run e2e:reports`
9a. ✅ Users & Roles management — create/edit/deactivate staff; Management manages all roles, HR manages below-HR only; site rules (PM ≥1, PE/Supervisor =1); self-lockout guard — verified by `npm run e2e:users`
9b. ⬜ Polish + deploy (prod cookie hardening, README, deploy checklist; missed-clockout sweep is a documented follow-up)

**Verification commands:** `npm run build` (type-check) · `npm run smoke` (boot, no DB) · `npm run seed` (admin + org data) · `npm run e2e:login` (auth) · `npm run e2e:org` (org CRUD + permissions) · `npm run e2e:workers` (enrollment + face + scope) · `npm run e2e:station` (capture + location-lock + OT) · `npm run e2e:overtime` (approval queue) · `npm run e2e:reports` (dashboard + reports + exports + flags) · `npm run e2e:users` (users & roles) · `npm run sync-indexes` (reconcile DB indexes) · `npm run dev` (live at :3000).

## Open items
- Exact report/output column layout — pending user's reference sheet.
- Brand accent — LOF blue default; confirm if TRGBI has its own color.
- Face-recognition approach — RESOLVED: `@vladmandic/face-api` **node-wasm build** on the TensorFlow.js **WASM backend** (tfjs-node's native binding does not load on Node 22). Pure JS, no native build, ~0.5s/encode, 128-d descriptors, self-hosted. Engine is behind `src/lib/face.ts` (`encodeFace`/`bestMatch`) so a Python micro-service can replace it later if accuracy demands. Model weights committed under `models/face/`.
- Biometric data (face encodings) under India's DPDP Act — flag for legal/compliance review (consent capture + retention), not a code decision.
