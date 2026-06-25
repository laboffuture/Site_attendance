# In/Out Logic Redesign — Design Spec

**Date:** 2026-06-25
**Status:** Approved (client decisions locked)
**Author:** TRG-Attendance team

## Goal

Make the face-scan in/out engine handle every real construction-site scenario
correctly — workers who come and go many times a day, forgotten punches,
overnight/24h shifts, double-scans — with money that always reconciles, an
HR-only correction path with audit, and the exception rules made configurable.

## Why

A multi-agent analysis catalogued **119 scenarios** (45 blockers). The simple
"in at 8, out at 5" case works; the failures cluster exactly where the client
flagged them:

1. A forgotten OUT **silently pays ₹0** *and* still increments the day-count —
   no flag, corrupt totals. (`payroll.ts` includes open records in `days`.)
2. **Two OT numbers.** The approval screen / dashboard read the shift engine's
   `overtime.computedHours`; the payslip recomputes a flat `(total−8)`. They
   diverge on long shifts. Money doesn't reconcile.
3. **A 24h shift breaks** — the 20h `OPEN_SESSION_LOOKBACK_MS` won't attach an
   8 AM-tomorrow OUT to an 8 AM-today IN.
4. **No HR fix-it path** exists at all — HR cannot add a missing punch, fix a
   time, force-close, or void; and there is **no audit trail**.
5. **A rapid double-scan** instantly turns an IN into a 0-hour OUT — no debounce.
6. **"Still working" vs "forgot to log out"** is not distinguished — the sweep
   flags in-progress shifts too.

## Locked client decisions

| # | Decision | Choice |
|---|----------|--------|
| 1 | Pay basis for come-and-go days | **Full span − lunch** (first-IN → last-OUT, gaps paid). Matches the Chennai OT sheet. |
| 2 | Forgotten OUT, before HR fixes it | **Flag for HR, pay ₹0** for that day. No fabricated/auto-closed pay. |
| 3 | Longest real continuous shift | **~26 hours** (covers true 24h + slop). Beyond this = forgotten OUT. |
| 4 | HR correction authority | **HR corrects → Management approves** (reuses the existing regularization recommend→close chain). |

Two things explicitly **unchanged** (only made tunable): lunch stays deducted
as today (the span−lunch rule), and OT stays **1×**.

## Architecture

The day record stays **one row per worker per day** (the unique
`workerId+date` index). The first IN is locked; the last OUT wins; pay =
`(lastOut − firstIn) − lunch`. We **add** a `sessions[]` punch log to that row
for audit/visibility (it does **not** change pay). A new HR correction path
edits the same row and routes through the existing approval chain. Payroll and
the scan engine are reconciled to ONE definition of a day's hours.

### One definition of a day's hours (used by scan close AND payroll)

```
lunch       = site.lunchHours              // the single lunch source
spanHours   = (lastOut − firstIn) / 3600s  // raw, stored as totalHours
paidTotal   = max(0, spanHours − lunch)
normalHours = min(paidTotal, STD=8)
otComputed  = max(0, paidTotal − STD)      // FLAT — matches the client sheet
foodDay     = paidTotal >= foodMinHours(5)
```

`closeSession` stores `overtime.computedHours = otComputed` so the approval
screen, dashboard `otExposure`, and the payslip all read the **same** OT. The
shift engine's window/ot-break math is retired *for pay* (the client sheet uses
flat `total−8`); `selectShift` is still used to classify day/night/sunday and
`shiftType` is still stored.

### OT payment gate

```
otPaidHours(day) =
  if outTime == null OR voided OR attendanceStatus == "rejected": 0
  else if otRequiresApproval:
    overtime.status == "approved" ? (overtime.approvedHours ?? computedHours) : 0
  else: computedHours
```

`otRequiresApproval` defaults **true** (matches "Management is last to close").
Normal hours pay on any non-rejected, non-open, non-voided day.

## Components

### 1. Config knobs (`src/config.ts`)

New global env-overridable values (per-site overrides on `ProjectSite` where
noted):

| Knob | Default | Purpose |
|------|---------|---------|
| `maxShiftHours` | 26 | Open-session attach window (replaces hardcoded 20h) + the "forgotten" cap. Per-site override. |
| `forgotGraceHours` | 2 | Hours past a shift's scheduled end before an open record is flagged "forgot OUT". Per-site override. |
| `scanDebounceSeconds` | 60 | A repeat scan by the same worker within this window is ignored (anti double-tap). Per-site override. |
| `otRequiresApproval` | true | Pay OT only once Management-approved. |
| `foodMinHours` | 5 | Min paid hours to earn the food allowance (was a hardcoded `5`). |

### 2. Attendance model (`src/models/Attendance.ts`)

Add to the day row (all backward-compatible, defaulted):

- `sessions: [{ inTime, outTime, inGeo, outGeo, source }]` — every punch logged;
  first-IN/last-OUT still drive pay.
- `corrections: [{ field, oldValue, newValue, by, at, reason }]` — append-only
  HR-edit audit.
- `outSource: enum["scanned","hr-filled"] default null` — how the OUT was set.
- `voided: Boolean`, `voidedBy`, `voidedAt`, `voidReason` — HR discard of a bogus
  record (excluded from pay).
- `verifiedBy`, `verifiedAt`, `verifyNote` — HR reviewed/acknowledged a record.

`ProjectSite` gains optional `maxShiftHours`, `forgotGraceHours`,
`scanDebounceSeconds` (null → fall back to global config).

### 3. Scan engine (`src/lib/attendance.ts`)

`recordScan` becomes:

1. **Debounce** — if the worker's last accepted scan (max of today's
   `inTime`/`outTime`) is within `scanDebounceSeconds`, return the current state
   unchanged (no toggle).
2. **Open session within `maxShiftHours`** → this scan is the **OUT**
   (`closeSession`, reconciled hours, `outSource:"scanned"`, push the OUT to the
   last `sessions[]` entry).
3. **Already OUT today** → **IN** via `reopenSession` (punch-clock; first IN
   stays; push a new `sessions[]` entry). Fix: also reset `breakHours = null`.
4. **Open but older than `maxShiftHours`** (stale) → do **not** weld it on; leave
   it open (the sweep will flag it), start a fresh **IN** today.
5. **No record today** → first **IN** (new `sessions[]` entry).

`closeSession` uses `site.lunchHours` (passed in via the scan site) so its OT
equals payroll's. `ScanSite` gains `lunchHours`.

### 4. Payroll reconciliation (`src/lib/payroll.ts`)

`computePayroll`:

- **Exclude** records with `outTime == null` (open/forgotten) — do not count in
  `days`, hours, or food. Tally a per-worker + per-run `unresolvedOpenDays`.
- **Exclude** `voided` records entirely.
- **Exclude** `attendanceStatus == "rejected"` days from pay.
- Read OT from `overtime` through the **OT payment gate** (above) instead of the
  flat recompute; normal = `min(paidTotal, STD)`.
- `select(...)` must add `overtime attendanceStatus voided`.
- `PayrollSummary` gains `unresolvedOpenDays`.

### 5. Missed-clockout sweep (`src/lib/missedClockout.ts` + `scheduler.ts`)

- **Shift-window aware:** flag an open record only when
  `now > inTime + windowHours(shift) + forgotGraceHours`. A night shift still in
  its window is **not** flagged. (Today it flags every open record.)
- Run the sweep **on boot** as well as at `sweepTime` (idempotent).
- A "still on site now" view = open records *within* their window (not flagged).

### 6. HR correction module (`permissions.ts`, `routes/regularization.ts`, views)

- New capability **`correct_attendance`** — **HR only** (`["hr"]`).
- HR actions on a record (all write `source:"manual"`, `markedBy`, append a
  `corrections[]` entry, recompute hours, then set the record to
  `attendanceStatus:"recommended"` + `recommendedBy:HR` so **Management approves**
  via the existing route before pay counts):
  - Set/fix **IN** time, **OUT** time, or `shiftType` (re-runs the hours math).
  - **Force-close** a forgotten session (HR types the OUT; `outSource:"hr-filled"`).
  - **Create** a full manual day for a worker who never scanned.
  - **Void** a bogus record.
  - **Mark verified** (acknowledge an ambiguous record).
- **UI:** HR-only edit controls inline on the regularization day view
  (`views/regularization/day.ejs`), plus a deep link from each `missed_clockout`
  flag to that worker's correction row. The payroll screen shows the
  **"Unresolved punches"** panel driven by `unresolvedOpenDays`.

### 7. Live presence + kiosk feedback (lower priority, same release)

- Dashboard / attendance: an **"On site now"** count = open records within
  window (scoped).
- Kiosk: explicit **"You are now CLOCKED IN / CLOCKED OUT"** with today's
  session count, and the debounce prevents accidental re-toggles.

## Data flow

```
face scan ─▶ recordScan ─(debounce? open? stale? back?)─▶ IN | OUT | ignored
                                   │
                       closeSession (lunch, flat OT) ─▶ Attendance row + sessions[]
                                   │
        nightly/boot sweep ─▶ flag open-past-window ─▶ missed_clockout queue
                                   │
                 HR correction (audit) ─▶ status "recommended" ─▶ Management approve
                                   │
                       computePayroll (exclude open/void/rejected, gated OT)
                                   │
                       Payroll page  ·  Dashboard money board  (one OT number)
```

## Error / edge handling

- **Forgotten OUT:** flagged, excluded from pay, surfaced in HR queue + payroll
  "Unresolved punches". Never auto-paid.
- **24h shift:** OUT attaches within 26h; whole span credited to the **start
  date**; OT = flat `(span−lunch)−8`.
- **Double-scan:** ignored within `scanDebounceSeconds`; idempotent.
- **Stale >26h open:** not welded to a new scan; flagged for HR; new day starts
  clean.
- **Voided / rejected:** excluded from pay.
- **Missing wage:** existing soft `missingWage` flag retained.

## Testing

- `e2e_shift` — extend: 26h lookback attaches a true long-shift OUT; debounce
  ignores a rapid re-scan; stale >26h starts a new IN; reopen clears `breakHours`.
- `e2e_payroll` — extend: open day excluded from `days`/pay and counted in
  `unresolvedOpenDays`; OT pays only when approved; voided/rejected excluded;
  span−lunch over a multi-punch day.
- `e2e_correction` (new) — HR sets a missing OUT → record `recommended`, audit
  entry written, `outSource:"hr-filled"`; Management approve → pays; void
  excludes from pay; non-HR is 403.
- `npm run build` (0 TS errors) + `react-doctor --scope changed` no regression.

## Out of scope (separate track, next)

- **PDF report downloads** — server-side branded PDF export on the report pages.
  Tracked separately after this lands.
- Multi-session *sum-of-intervals* pay (gaps unpaid) — client chose span; the
  `sessions[]` log makes a future switch possible without a migration.
- Sunday/holiday premium multiplier — keep 1× unless the client asks.
