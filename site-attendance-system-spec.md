# Site attendance & workforce management system — build specification

This document is the complete functional and technical spec for a daily-wage construction workforce attendance system, built from a series of planning discussions. It is written to be handed directly to an AI coding agent (Claude Code) as the source of truth for the build.

---

## 1. Project overview

A centralized system that tracks attendance for daily-wage construction/interior workers across multiple branches and project sites. Attendance is captured by face recognition at a fixed station per site (no manual marking), validated against the worker's assigned location, and rolled up through a role hierarchy into payroll-ready reports for HR and Management. Overtime is computed automatically but requires explicit approval before it is treated as final.

Company name: `[TRG-India / PRI-India — confirm exact spelling before go-live, source notes were ambiguous]`

---

## 2. Organization structure

The company has three branches. Each branch has its own project sites, and each project site has an assigned site lead (PE or Supervisor) responsible for day-to-day attendance.

| Branch | Project site / code | Assigned lead(s) |
|---|---|---|
| Chennai | VBW — T.Nagar / Joinery | Vijay |
| Chennai | PVM — Vadapalani | Saran |
| Chennai | ECR — Ponraan / Kadavur (also referenced: Sekar / Gopi) | Hari, Raja |
| CBE (Coimbatore) | CMS | Jayasurya |
| CBE (Coimbatore) | Joinery (separate unit) | — |
| Kumbakonam | Pavunnur Mall | Jeeva (project), Sasi Ganesh |

**Build requirement:** branches and project sites must be database-driven, not hardcoded. Management (and HR) need a screen to add new branches and new project sites as the company expands or moves to new locations. Each project site record should store its standard shift start/end time (see section 6).

---

## 3. Role hierarchy & permissions

Five-tier hierarchy, top to bottom:

1. **Management** — Super Admin. Full access to everything: branches, sites, designations, all user accounts, all reports. Approves overtime.
2. **HR** — Admin. Manages worker records, generates the final attendance/payroll report, approves overtime, hands off to Audit/Accounts.
3. **PM (Project Manager)** — oversees PE(s) and their project sites at a higher level; sees aggregated reports across the sites under them.
4. **PE (Project Engineer)** — senior to Supervisor; oversees day-to-day site operations, marks attendance, manages workers for their site, can add new designations.
5. **Supervisor** — site-level; marks attendance day to day, can add new designations on the spot when a new trade joins the site.

Daily-wage workers (Carpenter, Electrician, etc.) are **not** system users and never log in — they exist only as records matched via face recognition at the site station.

Permission matrix (best-fit interpretation — adjust during the auth-system build if any cell is wrong):

| Action | Management | HR | PM | PE | Supervisor |
|---|---|---|---|---|---|
| Manage branches / sites | Yes | View only | View only | No | No |
| Manage HR/PM/PE/Supervisor accounts | Yes | Yes (below HR) | No | No | No |
| Add new worker designation | Yes | Yes | Yes | Yes | Yes |
| Enroll new worker (face capture) | Yes | Yes | Yes | Yes | Yes |
| Mark / override attendance | Yes | Yes | Yes | Yes | Yes |
| Approve overtime | Yes | Yes | View only | No | No |
| View dashboard / reports | All sites | All sites | Own sites | Own site | Own site |

---

## 4. Worker designations (seed list — extensible)

PM, Supervisor/PE, Carpenter, Mason / Tile Mason, Electrician, Plumber, Welder, Sofa Maker, Helper, Polisher, Painter

Designations live in their own database table (not an enum/hardcoded list) since Supervisor and above can create a new one at any time.

---

## 5. Worker (employee) data model

Each worker record:

- Employee Registration Number — unique, system-generated
- Name
- Designation — FK to designations table
- Assigned Project Site — FK (this drives the location lock in section 7)
- Enrolled face data — photo + face embedding/encoding, captured at onboarding
- Status — active / inactive
- Date joined

---

## 6. Shift timing & standard hours

Standard hours are **not** a single fixed number system-wide:

- Observed shift starts vary by site — e.g. T.Nagar starts at 9:00, while some site/role combinations (Polisher, Helper, Painter) run a 9:00–9:30 start window.
- End-of-day marking was observed around 6:00–6:30.

**Build requirement:** each Project Site stores a configurable standard start/end time, used to compute Total Standard Hours and Overtime per day. Allow an optional per-designation override at the same site if needed later.

---

## 7. Attendance capture flow (face recognition, location-locked)

Each project site has exactly one webcam/laptop station ("Site Station") registered to that site — it is not a roaming kiosk, it is bound to a fixed Project Site ID in its own configuration.

Daily flow:

1. Worker faces the webcam at their site's station.
2. System captures the face and matches it against enrolled worker face data.
3. System checks whether the matched worker's **assigned Project Site** equals **this station's Project Site**.
   - Match → proceed to log attendance.
   - Mismatch (worker enrolled at a different site) → **reject** the event, log no time, and raise a flag visible to that site's PE/Supervisor (and above) that someone attempted to mark attendance from the wrong location.
4. On a successful match: log the timestamp as In Time (first scan of the day for that worker) or Out Time (if an In Time already exists for that day).
5. On Out Time: compute Total Hours = Out Time − In Time, compare against the site's Standard Hours.
6. Any hours beyond Standard Hours become **Overtime Hours**, status = pending (see section 8) — not yet final.

---

## 8. Overtime computation & approval workflow

- Overtime is computed automatically the moment Out Time is logged, but it is **not final** until approved.
- Pending overtime sits in an approval queue visible to HR and Management.
- HR or Management explicitly approves, adjusts, or rejects each pending overtime entry.
- Only approved overtime is included in the final report used for payroll/Audit/Accounts.
- Anywhere overtime appears in a report or dashboard, its status (pending / approved / rejected) must be visible — never shown as if final until it actually is.

---

## 9. New worker onboarding (enrollment)

- Available to Supervisor and above.
- Required at enrollment: Name, Designation (pick existing or create new on the spot), assigned Project Site, captured face photo (via the site station's webcam, or upload).
- System auto-generates the Employee Registration Number.
- From the next scan onward, the worker is recognized automatically at their assigned site's station.

---

## 10. Dashboard & reporting (HR / Management only)

Only HR and Management get a dashboard, accessed via a web browser on a PC. PM/PE/Supervisor interact only through the site capture and enrollment screens — no separate dashboard for them in this version.

Minimum dashboard contents:

- Attendance records, filterable by branch, project site, date range, designation, worker
- Per-worker summary: In Time, Out Time, Total Hours, Standard Hours, Overtime (pending vs approved)
- Overtime approval queue with approve / adjust / reject actions
- Flagged events (wrong-site scan attempts, missed clock-outs)
- Exportable report matching the payroll output format

**Report/output format:** pending — placeholder only. Known columns so far: Project, Employee Reg No, Name, Designation, In Time, Out Time, Total Time, OT Hours. Replace this section with the exact layout once the reference sheet is provided.

---

## 11. Recommended tech stack

This wasn't fixed by the requirements, so here's a concrete recommendation Claude Code can run with (swap freely if you have a different preference):

- **Backend:** Python + Django — built-in auth, admin, and ORM make a CRUD-heavy system like this fast to scaffold, and Django's Group/permission system maps cleanly onto the five-tier role hierarchy.
- **Database:** PostgreSQL.
- **Face recognition:** `face_recognition` (built on dlib) for v1 — simple API (`compare_faces`, `face_encodings`), well documented. Can be swapped for `DeepFace` later if accuracy needs improving.
- **Site Station capture UI:** Django templates + vanilla JS using the browser's `getUserMedia` for webcam access — no native app needed, the site laptop just needs a browser.
- **HR/Management dashboard:** Django templates + Chart.js to start; can be upgraded to a separate React frontend later if it outgrows server-rendered pages.
- **Auth:** Django's built-in auth + custom Groups (Management, HR, PM, PE, Supervisor) for permissions.
- **Hosting:** any standard cloud VPS (Render, Railway, DigitalOcean) — internet is reliable at every site, so one central deployment is sufficient; no offline-sync logic needed.

---

## 12. Data model / schema sketch

```
branches
  id, name

project_sites
  id, branch_id (FK), name, code, standard_start_time, standard_end_time

site_stations
  id, project_site_id (FK), station_name

designations
  id, name

users                          -- Management / HR / PM / PE / Supervisor only
  id, name, email, password_hash, role,
  assigned_project_site_id (FK, nullable — PE/Supervisor tied to one site)

pm_site_assignments            -- if a PM oversees multiple sites
  pm_user_id (FK), project_site_id (FK)

workers
  id, emp_reg_no (unique), name, designation_id (FK),
  project_site_id (FK), face_encoding, photo_path, status, date_joined

attendance_records
  id, worker_id (FK), project_site_id (FK), date,
  in_time, out_time, total_hours, standard_hours,
  overtime_hours, overtime_status [none/pending/approved/rejected],
  flagged_mismatch (bool), created_at

overtime_approvals
  id, attendance_record_id (FK), approved_by_user_id (FK),
  approved_hours, status, approved_at, notes
```

---

## 13. Screens / pages needed

- Login (role-based redirect)
- Site Station capture screen — webcam view, scan result, in/out confirmation
- Worker enrollment screen
- Designation management (add/view)
- Branch & project site management (Management only)
- User/role management (Management only)
- HR/Management dashboard — filters, tables, summary stats
- Overtime approval queue
- Report export

---

## 14. Open items & assumptions to confirm

- Exact company name spelling (TRG-India vs PRI-India).
- Final report/output column layout — pending the reference sheet.
- Exact PM-to-site cardinality (one PM per branch vs. per multiple sites) — modeled flexibly via `pm_site_assignments`, can be tightened once confirmed.
- Worker face photos are biometric data — worth getting clarity on consent capture and data retention before go-live, given how India's data protection law (DPDP Act) treats biometric data as sensitive personal data. This is a flag for legal/compliance review, not something to decide in code.

---

## 15. Suggested build order

1. Project scaffold (Django app, PostgreSQL connection, settings)
2. Auth & role-based access control (five tiers + permission matrix from section 3)
3. Branch / Project Site / Designation management (admin CRUD)
4. Worker enrollment, including face capture and encoding storage
5. Site Station capture flow — face match + location-lock logic (section 7)
6. Attendance logging + standard hours / overtime computation
7. Overtime approval workflow and queue
8. HR/Management dashboard and reports
9. Polish, test, deploy

---

## 16. How to hand this to Claude Code

Save this file as `PROJECT_SPEC.md` in the project's root directory, then start the Claude Code session with something like:

> Read PROJECT_SPEC.md in this repo and scaffold a new Django + PostgreSQL project implementing it, starting with step 1 of the build order in section 15. Ask me before making assumptions on anything listed under section 14 (open items).
