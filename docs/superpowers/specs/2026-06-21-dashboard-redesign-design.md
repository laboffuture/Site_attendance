# Dashboard Redesign — Branch Boxes + Single-Site Page

**Date:** 2026-06-21
**Status:** approved (build via frontend specialist; mobile = first-class)

## Problem

The dashboard's "All sites" view shows branch→site tiles inline, and selecting a
site only *filters* the same page. The user wants a clean **drill-down**:
glanceable **branch category boxes** at the top (concept borrowed — not styling —
from the Sync-flow overview), and selecting a single site opens its **own
complete page**. Must look intentional on **web and mobile**.

## Levels

### Level 1 — All sites (`GET /dashboard`, no `siteId`)
A responsive row of **branch boxes** at the top. Each box is minimal:
- headline: **`<N> workers`** (active count for the branch)
- one sub-line: **`<present> in · OT <h>h`**
- a small **`⚑ <n>`** chip only when `flags > 0`

Clicking a branch box **expands its sites** below it (compact tiles: site name ·
workers · present), reusing the existing per-site rollup data. Keep the existing
summary charts beneath, unchanged.

### Level 2 — drill
Clicking a branch box toggles its site tiles (progressive disclosure). Clicking a
**site tile** (or choosing from the existing site `<select>`) navigates to the
single-site page.

### Level 3 — Single site (`GET /dashboard?siteId=<id>`)
Replaces the filtered view with a **dedicated, complete page** for that site:
- **Header:** site name · code · shift `start–end` · geofence radius (m).
- **Summary tiles:** `Present X / Y`, `OT <h>h`, `Flags <n>`.
- **Today's roster:** workers with In / Out / Total / OT (the attendance grid for
  the site, today).
- **OT:** the site's pending/!none OT rows.
- **Flags:** recent flag events for the site.
- A **`← All sites`** back link.

## Data
- Branch boxes + site tiles: the dashboard route already computes a `rollup`
  (branch → sites with `{active, present, otPending, flags}` totals). Reshape, do
  not recompute.
- Single-site page: scoped queries by `siteId` (Worker/Attendance/Flag/Overtime),
  honoring `siteScopeFilter` so a user only opens sites in their scope. Out of
  scope → redirect to `/dashboard`.

## Mobile (first-class)
- Branch boxes: 1–2 per row, stacked, tappable (whole box is the toggle).
- Site tiles: single column.
- Single-site roster/OT/flags tables: use the existing `oh-table--cards`
  responsive pattern (label/value cards ≤768px).
- No horizontal scrolling anywhere. Tap targets ≥44px.

## Design system
Use the project's `oh-` system only (Poppins, sharp corners, `--c-accent`). No
new CSS frameworks. Build with the **frontend-design** skill for quality. Reuse
existing classes (`oh-card`, `oh-hier`, `oh-badge`, `oh-table--cards`); add new
`oh-` classes in `public/css/theme.css` / `mobile.css` where needed.

## Testing
- Extend `scripts/e2e_hierarchy.ts` (or add `e2e_dashboard.ts`): all-sites shows
  branch boxes with the worker counts; `?siteId=` renders the single-site page
  with that site's roster; out-of-scope `siteId` redirects.
- `npm run build` clean; manual check at desktop + ≤768px widths.

## Out of scope
The other 6 backlog items (scheduled-OT request rework, multi-site sites/
employees, request category, login geofence indicator, designations mobile).
Those are separate specs.
