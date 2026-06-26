# Explicit IN/OUT Scanning — Design Spec

**Date:** 2026-06-26
**Status:** Approved (design + impact-mapped across the whole codebase)

## Goal

Stop the scan engine from *guessing* IN vs OUT. The worker/supervisor states the
action explicitly, so a worker who forgot to clock out yesterday and clocks IN
this morning gets a clean new IN (yesterday is left open + flagged) instead of
silently closing yesterday's session. Make the daily close-out reliable: flag
forgotten clock-outs and forgotten submissions, and let the on-site supervisor
verify + fix a forgotten OUT before submitting, with HR/Management approving.

## The bug being fixed

`recordScan` auto-decides IN vs OUT. To support a real 24h shift (8 AM → 8 AM) the
open-session lookup spans `config.maxShiftHours` (26h). So a worker's still-open IN
from yesterday morning is within 26h of this morning's scan → today's scan is
treated as the OUT → "clocked out." His intended IN never happens. A real 24h
shift and a "forgot yesterday → clock in today" are indistinguishable by elapsed
time — so the engine must stop guessing.

## Locked decisions

| # | Decision |
|---|----------|
| 1 | Explicit IN/OUT on **both** the face kiosk and the supervisor Log-Attendance. |
| 2 | Kiosk UX: **two big buttons** (CLOCK IN / CLOCK OUT), then face scan. |
| 3 | The **supervisor** verifies + sets a forgotten OUT at submit time → submits → HR/PM recommend → Management approve. (Refines HR-only correction; HR keeps full powers.) |
| 4 | Next-day flags: **forgot-to-clock-out** (exists) + **forgot-to-submit** (new). |
| 5 | No change to first-In/last-Out + `sessions[]` storage; no pay-logic change. |

## Architecture

### A. Engine — `recordScan(worker, site, branchName, action, geo?)`

`action: "in" | "out"`. Returns `ScanResult` with a new `outcome` field:
`"in" | "out" | "already_in" | "not_clocked_in"` (plus the existing times/hours,
present only for `in`/`out`). The route maps `outcome` → JSON `status`.

**State machine** (`siteLocalDate(now)` = today; `debounceMs` per site/config):

`action = "in"`:
1. Today's record exists and **open** (outTime null) → `already_in` (no change, no dup).
2. Today's record exists and **closed** → **reopen** as IN (`outcome:"in"`); first-In stays.
   (An IN right after an OUT is a deliberate re-entry/correction — honored.)
3. No record today → **create** new IN (`outcome:"in"`). **A prior-day open record is
   NOT consulted or touched** — this is the fix.

`action = "out"`:
1. Find the open session (`outTime:null`, `inTime ≥ now − maxShiftHours`), newest first.
2. Found → **close** (`outcome:"out"`) via `closeSession` (also closes a real 24h shift).
3. Not found, but today's record is **closed within `debounceMs`** (accidental OUT
   double-tap) → re-show `outcome:"out"` (no change).
4. Otherwise → `not_clocked_in` (no record created/changed).

Debounce is **same-action**: a same-action re-tap inside the window is idempotent;
an immediate **opposite** tap is honored as a correction. The dup-key race fallback
branches on `action`, not on `outTime`. `closeSession`/`reopenSession`/`reckonHours`
are unchanged in their hours math.

### B. Face kiosk (`/station/scan`)

- `routes/station.ts`: read + validate `req.body.action` (`in`/`out`, else 400/error
  JSON); pass to `recordScan`; map `already_in`/`not_clocked_in` to JSON statuses; fix
  the `outTime!` assertion so a no-record outcome doesn't throw.
- `public/js/station.js`: two buttons set the active action; `doScan` appends
  `action`; `render()` gains `already_in` / `not_clocked_in` cases; the auto-scan loop
  only fires once an action is chosen (and idempotent `already_in` on a held face).
- `views/station/capture.ejs`: two big CLOCK IN (green) / CLOCK OUT (blue) buttons;
  idle copy prompts "pick IN or OUT". `theme.css`: button styling.

### C. Supervisor Log-Attendance (`/attendance/scan`)

- `routes/attendance.ts`: same `action` plumbing as the kiosk.
- `public/js/attendance-scan.js`: IN/OUT selector; send `action`; render the new states.
- `views/attendance/scan.ejs`: IN/OUT selector before marking.

### D. Supervisor close-out (forgotten OUT at submit)

- `views/attendance/submit.ejs`: for rows with no OUT (`outTime==null`), render an
  `<input type="time" name="outHM_<workerId>">` so the supervisor verifies + fills the
  forgotten OUT. In/closed-OUT stay read-only.
- `routes/attendance.ts` submit handler: for each `scanned` row with `outTime==null`
  and a valid `outHM_<id>`, set `rec.outTime = istDateTime(rec.date, outHM)`,
  `rec.outSource = "supervisor-filled"`, recompute hours via the shared reckoner, close
  the trailing open `sessions[]` entry, then flip `scanned → submitted` as today.
- Gate: **no new capability** — folded into `submit_attendance` (HR/PM/Supervisor),
  strictly scoped to `outTime==null` + status `scanned`. `correct_attendance` stays
  HR-only with full powers. The supervisor fill lands at **submitted** (not
  `recommended`) so it still flows PM/HR-recommend → Management-approve.
- `models/Attendance.ts`: add `"supervisor-filled"` to the `outSource` enum.
- Extract the recompute logic (currently private in `regularization.ts`) into a shared
  `lib` function used by **both** the submit fill and HR `/correct`, so the submit
  screen, approval screen, and payslip never disagree on hours/OT.

### E. Forgot-to-submit sweep + flag

- `models/FlagEvent.ts`: add `"forgot_submit"` to `FLAG_TYPES`; add a partial-unique
  index `{ type, attemptedSiteId, date }` for idempotency of the per-site-day flag.
- New sweep (`lib/forgotSubmit.ts` or beside the existing one): find records with
  `attendanceStatus:"scanned"`, `voided:{$ne:true}`, `date:{ $lt: siteLocalDate() }`
  (strictly **before** today — never flag the current day), grouped by site+date; raise
  one `forgot_submit` flag per group, scoped with `attemptedSiteId` so non-admins see it.
- `lib/scheduler.ts` + `scripts/sweep.ts`: run the new sweep alongside the missed-clockout
  sweep (timer + boot + manual), each in its own try/catch.
- `views/flags/index.ejs` + `views/dashboard-site.ejs`: add a `forgot_submit` label + a
  "Submit day →" deep link to `/attendance/submit?siteId=<homeSiteId>&date=<date>`.

### F. Downstream — confirmed unaffected (no change)

`lib/payroll.ts`, `lib/report.ts`, `routes/dashboard.ts`, `routes/reports.ts`,
`lib/missedClockout.ts` all read the **stored record**, not the scan decision.
Behavioral note: because prior-day opens are no longer silently auto-closed, the count
of open records, `unresolvedOpenDays`, and `missed_clockout` flags will rise — intended.
The missed-clockout sweep still works unchanged (an explicit IN with no OUT still has
`outTime:null`).

## Error / edge handling

- IN when already in → `already_in` (clear message, no dup).
- OUT when not clocked in → `not_clocked_in` (no record).
- Accidental same-action double-tap → debounced/idempotent; opposite tap → honored.
- Actionless POST (stale client) → route rejects with a clear error (never an
  ambiguous engine call).
- Forgotten OUT left by explicit IN → flagged; supervisor fills at submit, or HR
  force-closes. No fabricated OUT.

## Testing / regression checklist

Update (pass explicit `action`): `e2e_shift` (8 `recordScan` calls + rewrite the
toggle assertions), `e2e_station`, `e2e_geo`, `e2e_logscan`, `demo_enroll_scan`.
Add new cases: `action:"in"` while already in → `already_in` no dup; `action:"out"`
while not clocked in → `not_clocked_in` no record; **Teja:** a prior-day open record
+ `action:"in"` today → new IN created, yesterday still open (not closed) + flagged.
New: `e2e` for the supervisor OUT-fill at submit (→ submitted, `supervisor-filled`,
hours recomputed) and the `forgot_submit` sweep (a prior-day `scanned` site-day →
flagged; today's not flagged). Unaffected (must stay green): `e2e_attendance`,
`e2e_facecapture`, `e2e_missed_clockout`, `e2e_correction`, plus all non-scan suites.

## Out of scope

- Auto-fabricating an OUT (stays supervisor/HR).
- Pay-logic changes. Multi-site "transfer" semantics. Drag-drop anything.
