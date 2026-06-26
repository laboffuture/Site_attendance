# Flag Resolution — Close-the-Loop Design Spec

**Date:** 2026-06-26
**Status:** Approved (diagnosed by a 3-agent trace; decisions locked)

## Problem (confirmed in code)

`/flags` shows what's wrong but you can't fix-and-clear it:
1. **The loop never closes** — setting an OUT or submitting a day never resolves the
   linked flag (record-state and flag-state are fully decoupled).
2. **"Resolve" is a blind dismiss** — `POST /flags/:id/resolve` just sets
   `resolved=true` with no check the issue is fixed.
3. **Capability mismatch** — `/flags` is viewable by Management+HR, but
   `missed_clockout` needs `correct_attendance` (HR only) and `forgot_submit` needs
   `submit_attendance` (excludes Management). So **Management dead-ends on every fix.**

## Locked decisions

- **Who can fix from the flag queue:** all four roles (Management, HR, PM, Supervisor),
  **revocable per-user** (the existing per-user capability override handles revoke).
- **Visibility:** Management + HR see all flags; **PM + Supervisor are site-scoped** to
  their assigned sites (the existing `flagScopeFilter` on `attemptedSiteId` already does this).
- **Fixing auto-resolves the flag**; a plain dismiss is allowed only as an explicit
  acknowledge (kept for `wrong_site_scan` and admin override).
- Fixing from a flag lands the day at **`submitted`** so the normal recommend→approve
  chain still runs (no approval bypass; flag-fix unblocks + clears, it does not pay/approve).

## Architecture

### A. Auto-resolve on the real fix (keystone)
Two tiny helpers in `src/lib/flagResolve.ts`:
- `resolveMissedClockout(attendanceId)` → `FlagEventModel.updateMany({ type:"missed_clockout",
  attendanceId, resolved:false }, { $set:{ resolved:true } })`
- `resolveForgotSubmit(siteId, date)` → same for `{ type:"forgot_submit", attemptedSiteId:siteId, date }`

Called wherever the underlying issue is genuinely fixed:
- **OUT set by a scan** → `closeSession` (`src/lib/attendance.ts`) resolves the record's missed_clockout.
- **OUT filled by HR** → the regularization `correct` route, after save.
- **OUT filled / day submitted by a supervisor** → `POST /attendance/submit`: resolve
  missed_clockout per filled record + `resolveForgotSubmit(siteId, date)` after the submit loop.
- **Fixed from the flag queue** → the new flag-fix routes (below).

### B. Visibility + capability
- `view_flags` → `["management","hr","pm","supervisor"]` (was `["management","hr"]`).
  Per-user revoke works automatically (`userCan`). PM/Supervisor are site-scoped by the
  existing `flagScopeFilter`; the `/flags` GET and every fix route also call `canUseSite`.
- Nav "Flagged" now shows for all four (PM/Supervisor see only their sites' flags).

### C. Fix inline, on the flag (the unblock)
New routes in `src/routes/flags.ts`, each gated `requireCapability("view_flags")` + `canUseSite`
on the flag's site, each auto-resolving the flag on success:
- `POST /flags/:id/fix-clockout` — body `outHM` (HH:MM). Loads the flag's `attendanceId`
  record; if still open + valid time → `fillOut(rec, istDateTime(rec.date, outHM), lunch,
  outSource)` (`outSource = "supervisor-filled"` for pm/supervisor else `"hr-filled"`),
  push a `corrections[]` audit entry (by = the fixer), set status `submitted`, save, then
  `resolveMissedClockout(rec._id)`. (Record-scoped via `attendanceId` — no hunting.)
- `POST /flags/:id/submit-day` — flips that site-day's `scanned` records to `submitted`
  (submittedBy = fixer), then `resolveForgotSubmit(siteId, date)`.
- `wrong_site_scan` keeps the existing acknowledge (`POST /flags/:id/resolve`).

The generic `POST /flags/:id/resolve` stays as an explicit acknowledge/override (so an
admin can dismiss e.g. a wrong-site flag), but the *primary* path is fix-and-auto-resolve.

### D. The flags view (`src/views/flags/index.ejs`)
Each actionable flag renders an inline action (desktop + mobile), shown to any viewer:
- `missed_clockout` → a small time input + **"Fix & resolve"** (posts to `/fix-clockout`),
  plus the existing "Fix attendance →" deep link as a secondary "open full editor".
- `forgot_submit` → **"Submit day"** (posts to `/submit-day`), plus the existing "Submit day →" link.
- `wrong_site_scan` → **"Acknowledge"** (the existing resolve).

## Error / edge handling
- fix-clockout on a record that already has an OUT (someone fixed it) → no-op + resolve the flag (it's stale).
- submit-day when nothing is `scanned` (already submitted) → resolve the flag (stale), no error.
- Out-of-scope flag (PM/Supervisor) → 403 via `canUseSite`.
- Invalid `outHM` → flash error, no change.

## Testing
- `e2e_missed_clockout`: after a scan OUT / HR correct / supervisor submit fills the OUT →
  the missed_clockout flag is auto-resolved. The flag `POST /flags/:id/fix-clockout` sets the
  OUT, lands `submitted`, audits, and resolves the flag; PM out-of-scope → 403; PM in-scope can fix.
- `e2e_forgot_submit` / `e2e_logscan`: submitting a day auto-resolves its forgot_submit; the flag
  `POST /flags/:id/submit-day` submits + resolves.
- `e2e_users`: `can("pm","view_flags")` / `can("supervisor","view_flags")` true.
- Full suite stays green; no approval-chain bypass.

## Out of scope
- Re-opening a resolved flag if a day regresses (a later integrity sweep could, deferred).
- Changing pay/approval logic.
