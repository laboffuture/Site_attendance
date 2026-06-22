# Management Experience — Design (living)

**Date:** 2026-06-22
**Status:** approved (build A→B→C; dashboard viz parked on user's sample)

Refine the app for the **Management/Chairman** role: declutter, segregate, and
remove actions Management never performs. Built in pieces; this doc grows as the
user adds checklist items.

## A. Role-tuning — Management does not log attendance or request OT
- Remove `mark_attendance` and `submit_attendance` from **management** in the
  capability matrix → the **Attendance** nav item, **Log Attendance** scan, and
  **Submit day** disappear for Management. They verify via **Regularization** +
  Dashboard and approve via Overtime/Regularization. (HR keeps these for now —
  revisit when we do the HR page.)
- **Requests:** Management may **not** create a *Scheduled OT* request, but **may**
  suggest an *Offload*, and approves/rejects what comes from below. Enforced in
  the new-request view (hide the Scheduled-OT tab for management) and the POST
  route (reject `type=scheduled_ot` from a management actor).

## B. Overtime — segregate by site + status
- `/overtime` already has status tabs (pending/approved/rejected/all). Within the
  active tab, **group rows by site** under a clear site header/breaker so
  Management scans per location and approves/declines fast. Mobile: the existing
  card layout, grouped by the same site headers. No data/logic change — view-only
  grouping of the same scoped records.

## C. Branches & Sites rework + HR org access
- **Map location picker** on the site add/edit form: Leaflet + OpenStreetMap
  (free, no API key). Search an address (Nominatim) or click to drop a pin →
  fills the existing `latitude`/`longitude` fields. Manual entry stays as a
  fallback. Loaded only on the org pages.
- **In-charge autocomplete:** the in-charge name field offers a `<datalist>` of
  in-charge names already used on other sites (distinct `inChargeName`s).
- **HR org access:** add `hr` to `manage_org` so HR can add **Branches** and
  **Stations** (HR already has `manage_sites`). HR becomes full org-management
  alongside Management.

## Parked (await input)
- **Dashboard visualization** — overall site status + site-wise segregation,
  decluttered, laid out per the **sample the user will share**. Not started.
- HR attendance role-tuning (mirror of A) — when we work the HR page.
- Further Management checklist items the user is still dictating.

## Testing
- e2e: management cannot GET /attendance or /attendance/submit (403/redirect) and
  cannot POST a scheduled_ot request, but can create an offload + approve;
  HR can now create a branch + register a station. Overtime grouping is a render
  check. Map picker verified by the asset loading + lat/lng round-trip.
- Full suite green after each piece.
