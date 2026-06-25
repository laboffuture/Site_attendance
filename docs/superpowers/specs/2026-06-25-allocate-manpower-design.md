# Allocate Manpower — Design Spec (V1)

**Date:** 2026-06-25
**Status:** Approved scope (pending spec review)
**Adapts:** Top Rock "Manpower Management" → *Allocate/Request Manpower* (Req IDs `MPA-…`).

## Goal

Plan site staffing: a site requests workers (role × quantity × shift × date range),
an admin allocates specific people to fill it, and everyone sees **needed vs filled**.
Separate from attendance (who actually showed up). Allocating an enrolled worker also
**assigns the site to them** so they can scan/attend there immediately.

## Locked decisions

| # | Decision | Choice |
|---|----------|--------|
| 1 | Allocation effect | Allocating an **enrolled worker** adds the request's site to `Worker.siteIds` → they can scan there. Outsource people are plan-only (no scanning). |
| 2 | V1 scope | Core request→allocate **+ outsource employees + calendar board**. Staff-vs-worker split is **out**. |
| 3 | Allocation granularity | Per **line** (role): you fill a specific role line with a worker of that role. |

## Architecture

Two new collections + one new route module + a Reports-hub tile. Reuses existing
Designations (= roles), Workers (multi-site via `siteIds`), Sites/Branches,
capability/scope system, and the report exporters (CSV/PDF) shipped earlier.

### Data model

**`ManpowerRequest`** (collection `manpower_requests`):
- `reqCode` — unique, `MPA-NNNNNN` (sequential via the existing `Counter` model)
- `siteId, siteName, branchId, branchName` — where workers are needed (denormalized)
- `shiftType` — `"day" | "night" | "sunday"`
- `dateFrom, dateTo` — `"YYYY-MM-DD"`
- `lines: [{ designationId, designationName, qty }]` — roles × quantity needed
- `allocations: [{ kind: "worker"|"outsource", refId, code, name, lineDesignationId,
  designationName, allocatedBy, allocatedByName, allocatedAt }]`
  — `code` = worker empRegNo or outsource code; `lineDesignationId` = the role line it fills
- `status` — `"open" | "partial" | "fulfilled" | "cancelled"` (derived on save; cancelled is explicit)
- `requestedBy, requestedByName, requestedAt, requesterRemarks, notes`
- timestamps

Status derivation: per line, `filled = allocations where lineDesignationId === line.designationId`.
`fulfilled` when every line `filled >= qty`; `open` when 0 allocations; else `partial`.

**`OutsourceEmployee`** (collection `outsource_employees`):
- `code` — `OUT-NNNN` (sequential)
- `name`, `designationId` (nullable), `designationName`
- `outsourceCompany` (string), `payRate` (number, per day), `phone` (nullable)
- `active` (bool, default true), timestamps

### Permissions (new capabilities — `src/auth/permissions.ts`)

- `view_manpower` → `[management, hr, pm, supervisor]` (scoped)
- `request_manpower` → `[management, hr, pm, supervisor]` (raise a request for your site)
- `allocate_manpower` → `[management, hr]` (allocate from the full pool; also manage outsource employees)

PM/Supervisor are site-scoped via `siteScopeFilter`/`canUseSite` on `siteId`. Added to the
per-user permission editor (`PERMISSION_GROUPS`) and the sidebar nav (`view_manpower`).

### Routes (`src/routes/manpower.ts`, mounted at `/manpower`)

- `GET  /manpower` — request queue (scoped), status filter chips, link to the board.
- `GET  /manpower/new` — create form: site, shift, date range, dynamic role×qty lines.
- `POST /manpower` — create (`request_manpower`); generates `reqCode`, status `open`.
- `GET  /manpower/:id` — detail: per-line needed/filled, allocation list, allocate controls.
- `POST /manpower/:id/allocate` — (`allocate_manpower`) body: `lineDesignationId`, `kind`,
  `refId`. Pushes an allocation; if `kind==="worker"`, `$addToSet` the site into
  `Worker.siteIds`; recomputes status.
- `POST /manpower/:id/deallocate` — (`allocate_manpower`) remove an allocation by index/refId.
  Does **not** auto-remove the site from the worker (manual cleanup via worker edit) — avoids
  accidental unassignment.
- `POST /manpower/:id/cancel` — (`allocate_manpower`) set status `cancelled`.
- `GET  /manpower/board` — calendar board (see below).
- `GET  /manpower/outsource` — outsource employees list + add form (`allocate_manpower`).
- `POST /manpower/outsource` — create (`allocate_manpower`).
- `POST /manpower/outsource/:id` — edit / toggle active (`allocate_manpower`).
- `GET  /manpower/allocations` — Allocations report (scoped) + `?format=csv|pdf` export via
  the existing `sendCsv` / `streamTablePdf`. A Reports-hub tile links here (gated `view_manpower`).

### Calendar board

`GET /manpower/board?siteId=&from=&to=` (defaults: a site in scope + the current week).
A grid: **rows = role lines across the site's active requests**, **columns = the days in
range**. Each cell shows `filled/needed` for that role on that day (a request covers
`dateFrom..dateTo`, so it contributes to every day in its span). Cells are colour-coded
(under-filled = warning). Clicking a cell deep-links to that request's detail to allocate.
Server-rendered; **no SPA drag-drop in V1** (click-to-allocate). Drag-drop is a noted later polish.

## Data flow

```
PM/Supervisor → create ManpowerRequest (role×qty, shift, dates)  → status open
Management/HR → allocate worker/outsource to a line
                 ├─ worker  → push allocation + $addToSet site into Worker.siteIds (can scan)
                 └─ outsource → push allocation (plan-only)
                 → recompute status (open/partial/fulfilled)
Board view ─── per-day filled/needed heat grid (click → detail)
Allocations report ─── who is allocated where, by site/role/date → CSV/PDF
```

## Error / edge handling

- Allocating the same worker twice to the same request line → rejected (dup guard on refId+line).
- Allocating a worker whose designation ≠ the line's role → allowed but the admin picks the line
  explicitly (the picker suggests matching-role workers first).
- Cancelled requests are read-only; excluded from the board's needed counts.
- Out-of-scope site (PM/Supervisor) → 403, mirroring the regularization routes.
- Date range invalid (`from > to`) → form error.

## Testing (`scripts/e2e_manpower.ts`, `npm run e2e:manpower`)

- Create a request (role×qty) → status `open`, `reqCode` generated.
- Allocate a worker → allocation recorded, **site added to `Worker.siteIds`**, line `filled` ++,
  status → `partial`/`fulfilled`.
- Allocate an outsource employee → recorded, **no** site change.
- Fill all lines → status `fulfilled`.
- PM scoped: sees only their site's requests; `allocate_manpower` denied (403) for PM.
- Allocations report renders + CSV/PDF stream (`%PDF`).
- Capability matrix: `allocate_manpower` is `[management, hr]` only.

## Out of scope (V1)

- Staff-vs-worker employee split.
- Full HTML5 drag-and-drop on the board (click-to-allocate ships; drag-drop later).
- Transfer-site as a distinct feature (allocation already moves a worker's site assignment).
- Auto-removing a site from a worker when an allocation is deleted.
