# Face Onboarding Sweep — Design

**Date:** 2026-06-21
**Status:** approved (build)

## Problem

The 171 active workers were imported from the master spreadsheet with **no face
data** (`faceEncoding` empty). Until each worker's face is enrolled they **cannot
be scanned** for attendance. On go-live the supervisor (and anyone above) needs a
fast way to walk their site roster and register faces one by one — and to see the
registered set grow as they go.

The capture **backend already exists**: `POST /workers/:id/face` encodes a photo,
stores `faceEncoding` + `photoUrl`, and logs a "Face enrolled" remark. The camera
widget already exists too, driven by `/static/js/enroll.js`. What's missing is the
**onboarding surface** on the Employees roster and a **focused capture page**.

## Approach (chosen)

A thin onboarding layer over the existing backend — no new face/ML code.

### 1. Roster status + sweep aids — `GET /workers` + `views/workers/index.ejs`
- Each worker row shows a **face badge**: `Registered` (success) or
  `Not registered` (warning), derived from `faceEncoding.length > 0`.
- Unregistered rows get a one-tap **Register face** button → the dedicated page.
- A **filter** `?face=unregistered` (chip near the status tabs) narrows the active
  list to workers still missing a face, so the sweep has a clean worklist.
- A **progress count** in the header: `Face registered: X / Y` (scoped to the
  user's sites), so "it grows" is visible.

### 2. Dedicated capture page — `GET /workers/:id/face` + `views/workers/face.ejs`
- Full-screen, focused: worker name + status line + the existing camera widget
  (same element IDs so `enroll.js` drives it unchanged) + **Save face**.
- A hidden `returnTo=roster` field tells the existing `POST /workers/:id/face` to
  redirect **back to `/workers?face=unregistered`** on success (continue the
  sweep) instead of the heavy Edit form. Errors re-render the face page.
- Scope: `canUseSite` — a supervisor can only register faces at their own sites.

### Capability & scope
`enroll_worker` (all roles) already gates `/workers` and the face routes;
`siteScopeFilter` / `canUseSite` already scope them. No permission changes.

## Out of scope
Bulk/CSV photo import; liveness checks; re-enrollment policy (Edit already lets
you re-capture). No changes to the scan/geofence pipeline.

## Testing — `scripts/e2e_face_onboarding.ts` (self-contained)
1. Faceless worker → roster shows `Not registered`; appears under
   `?face=unregistered`; progress count shows 0 registered.
2. `GET /workers/:id/face` → 200, shows the worker + capture form.
3. `POST /workers/:id/face` with `test/fixtures/face_single.jpg` → `faceEncoding`
   populated; 302 redirect; worker drops out of `?face=unregistered`; count → 1.
4. Scope: a supervisor at another site cannot open or post the face page.
