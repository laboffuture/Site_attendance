# Shift & Overtime Engine (cross-midnight) — Design

**Date:** 2026-06-20
**Status:** Approved, ready for implementation.
**Source:** Rule Book v2 §2 (`docs/superpowers/specs/2026-06-20-rulebook-v2.md`) + the shift/OT matrix image. Replaces the v1 OT computation (`standardHoursForSite` = end − start, one row per calendar day).

---

## Goal

Compute attendance and overtime correctly for **day, night, and Sunday** shifts, including shifts that **cross midnight** (a worker scans In one evening and Out the next morning). Standard hours and overtime follow the matrix, with break rules. OT remains **pending** in the existing approval queue.

## Locked decisions

| # | Decision |
|---|---|
| Session model | A scan matches the worker's most-recent **open** record (no Out) within a **20h lookback** → that scan is the Out (even across midnight). Otherwise a new In. Record keyed to the **shift start date**; the `{workerId, date}` unique index is kept. |
| Shift selection | **Auto.** Sunday calendar day → `sunday`. Otherwise the In-scan time picks `day` vs `night` by nearest window start. Wrong picks are fixed later in regularization (piece #6). |
| OT break | **Per-shift threshold:** deduct `otBreakMin` once OT exceeds `otBreakThresholdHours`. day/night threshold = 5h; sunday threshold = 0h (any Sunday OT → 1h break). |
| Shift config | Per-site `shifts` (day/night/sunday); a **global default from the matrix** is applied to every site on migrate, overridable per site. |
| Scope | **Single-session** shift/OT only. Travel time + multi-site days = separate piece #7 (model shaped so segments slot in later). |
| Approval | OT still computed on the Out scan → status `pending` → existing OT approval queue. The daily submit→recommend→approve chain is separate piece #6. |

## Default shift definitions (from the matrix)

| Shift | start | end | breakMin | derived standard work | otBreakThresholdHours | otBreakMin |
|---|---|---|---|---|---|---|
| **day** | 08:00 | 17:00 | 60 | 8h (9h window − 1h) | 5 | 60 |
| **night** | 20:00 | 05:00 (next day) | 60 | 8h (9h window − 1h) | 5 | 60 |
| **sunday** | 08:00 | 14:00 | 0 | 6h (6h window − 0) | 0 | 60 |

`windowHours` = `end − start`, **+24 when end ≤ start** (night crosses midnight). Standard-work hours are **derived** (`windowHours − breakMin/60`), not stored — one source of truth.

## THE COMPLETE ALGORITHM

### A. `windowHours(shift)` → number
```
sh = hmToHours(shift.startTime)            // e.g. "20:00" → 20
eh = hmToHours(shift.endTime)              // e.g. "05:00" → 5
return eh > sh ? (eh - sh) : (eh - sh + 24)   // night: 5 - 20 + 24 = 9
```

### B. `selectShift(site, inTime)` → "day" | "night" | "sunday"
```
dow = IST day-of-week of inTime            // 0 = Sunday
if dow === 0 and site.shifts.sunday exists → return "sunday"
// nearest window start (circular over 24h)
inH = IST hour-of-day of inTime (0..24, fractional)
dDay   = circularDist(inH, hmToHours(site.shifts.day.startTime))
dNight = circularDist(inH, hmToHours(site.shifts.night.startTime))
return dNight < dDay ? "night" : "day"

circularDist(a, b): d = abs(a - b) mod 24; return min(d, 24 - d)
```
(Effectively: a morning In → day; an evening/late In → night. Ties → day.)

### C. `computeShiftOT(shift, inTime, outTime)` → { standardHours, overtimeHours, breakHours }
```
elapsedH   = (outTime - inTime) / 3_600_000        // real elapsed, spans midnight fine
winH       = windowHours(shift)                    // 9 (day/night) or 6 (sunday)
breakH     = shift.breakMin / 60                   // 1 or 0
stdWorkH   = max(0, winH - breakH)                 // 8 or 6

beyondH    = max(0, elapsedH - winH)               // clock time past the standard window
otBreakH   = beyondH > shift.otBreakThresholdHours ? shift.otBreakMin / 60 : 0
overtimeH  = round2(max(0, beyondH - otBreakH))

// standard portion actually worked (handles leaving early): cap at stdWorkH,
// and deduct the standard break only once the worker is present beyond it.
workedToWindow = min(elapsedH, winH)
standardH  = round2(min(stdWorkH, max(0, workedToWindow - breakH)))

return { standardHours: standardH, overtimeHours: overtimeH, breakHours: round2(breakH + otBreakH) }
```

### Matrix verification (every row)
| Case | elapsed | winH | beyond | otBreak | **OT** | **std** |
|---|---|---|---|---|---|---|
| Day 08:00–17:00 | 9 | 9 | 0 | 0 | **0** | **8** |
| Day 08:00–20:00 | 12 | 9 | 3 | 0 (3≤5) | **3** | **8** |
| Day 08:00→next 05:00 | 21 | 9 | 12 | 1 (12>5) | **11** | **8** |
| Night 20:00–05:00 | 9 | 9 | 0 | 0 | **0** | **8** |
| Night 20:00→08:00 | 12 | 9 | 3 | 0 | **3** | **8** |
| Sunday 08:00–14:00 | 6 | 6 | 0 | 0 | **0** | **6** |
| Sunday 08:00–18:00 | 10 | 6 | 4 | 1 (4>0) | **3** | **6** |

### D. `recordScan` (rewritten flow)
```
now = new Date()
open = AttendanceModel.findOne({ workerId, outTime: null, inTime: { >= now - 20h } })
                      .sort({ inTime: -1 })
if no open record:
    shiftType = selectShift(site, now)
    create record { date: siteLocalDate(now), inTime: now, shiftType, source:"scan", inGeo, ... }
    return { action: "in", shiftType, ... }
else:   // this scan is the Out (may be a different calendar day)
    shift = site.shifts[open.shiftType]
    { standardHours, overtimeHours, breakHours } = computeShiftOT(shift, open.inTime, now)
    open.outTime = now; open.outGeo = geo
    open.totalHours = round2((now - open.inTime)/3_600_000)
    open.standardHours = standardHours; open.breakHours = breakHours
    open.overtime = { computedHours: overtimeHours, status: overtimeHours > 0 ? "pending" : "none", ... }
    save
    return { action: "out", totalHours, overtimeHours, overtimeStatus, ... }
```
The near-simultaneous-first-scan duplicate-key guard is retained (treat the loser as an Out).

## Data model changes

- **`ProjectSite`**: add `shifts: { day, night, sunday }`, each `{ startTime, endTime, breakMin, otBreakThresholdHours, otBreakMin }`. Migration seeds the matrix default on every existing site; legacy `standardStartTime/EndTime` kept (used as the `day` default if present, else 08:00–17:00).
- **`Attendance`**: add `shiftType: "day"|"night"|"sunday"` and `breakHours: Number`. `inTime`/`outTime` already full Dates → cross-midnight needs no further change; `date` = shift start date (unchanged key, unique index kept).
- **`src/lib/shift.ts`** (new): `windowHours`, `selectShift`, `computeShiftOT` — pure, no DB, fully unit-testable.
- **`src/lib/attendance.ts`**: `recordScan` rewritten per (D); used by both the kiosk and the supervisor Log Attendance scan.

## Blast radius (kept minimal)

- Reports / daily grid / dashboard rollup group by `date` (= shift start date) — **unchanged**.
- Missed-clock-out sweep: still flags `outTime: null` records `date <= today` — **unchanged**; the open-session match closes legitimate overnight returns before the sweep would touch them.
- `standardHoursForSite` (old): superseded by `computeShiftOT`. Keep the function only if a caller outside scan still needs it; otherwise remove and update callers.

## Edge cases

- **Forgotten clock-out then next-day In:** if a worker never scanned Out and returns >20h later, the lookback misses the stale open record → the new scan is a fresh In; the stale record is flagged by the sweep (correct). Within 20h, the morning scan closes the prior session (correct for overnight).
- **Two scans seconds apart:** duplicate-key guard → second is the Out (existing behavior).
- **Leaving before the break is "earned":** `standardH` formula deducts the break only against time actually present, clamped at 0.

## Testing

- **`scripts/test_shift.ts`** (unit, no DB): every matrix row above + threshold edges + `selectShift` (morning→day, evening→night, Sunday→sunday) + `windowHours` (night crosses midnight).
- **`scripts/e2e_shift.ts`** (live DB): In at night + Out simulated next morning (backdated In) → one closed session, `shiftType:"night"`, OT per matrix, `status:"pending"`; a fresh In >20h after a stale open record → new record, stale one untouched.

## Out of scope

Travel time / multi-site segments (piece #7); the daily submit→recommend→approve regularization chain (piece #6); payroll computation. This piece computes correct hours + OT and leaves OT pending.
