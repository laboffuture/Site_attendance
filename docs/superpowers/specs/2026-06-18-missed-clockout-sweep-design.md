# Missed Clock-Out Sweep — Design

**Date:** 2026-06-18
**Status:** Approved, ready for implementation.
**Source spec:** `site-attendance-system-spec.md` (§10 lists "missed clock-outs" as a flagged event); `README.md` and the v1 design log both record the end-of-day sweep as a planned follow-up.

---

## Problem

A worker who scans **In** but never scans **Out** leaves an attendance record open forever: `outTime`, `totalHours`, and overtime stay `null`. Nothing surfaces this gap, so HR has no signal to correct it. The `FlagEvent` model already defines a `missed_clockout` type, but no job ever creates one.

## Locked decisions

| Area | Decision |
|---|---|
| Action on an open record | **Flag only** — raise a `missed_clockout` flag; do **not** modify the attendance record. HR corrects the real out-time on the existing `/attendance` page. No out-time is invented. |
| Timing | **Once nightly at a fixed IST time**, default **23:00**, configurable via a `SWEEP_TIME` env var (`"HH:MM"`). |
| Trigger | **Both** a standalone idempotent `npm run sweep` script **and** an in-process daily scheduler, both calling the same library function. |
| Scope per run | All open records with `date <= today` (site-local IST), so a missed run (app down) is recovered on the next run. Idempotency prevents duplicate flags. |

## Data-model change

Add two fields to `FlagEvent` (used only by `missed_clockout` flags; `wrong_site_scan` flags leave them null):

- `date: String` — site-local `"YYYY-MM-DD"` of the open record, so HR knows which day to fix.
- `attendanceId: ObjectId` (ref `Attendance`) — links the flag to the exact record.

Add a **partial unique index** on `{ type: 1, attendanceId: 1 }` filtered to `attendanceId` existing, so a given open record can be flagged at most once regardless of how many times the sweep runs (in-app timer + a manual `npm run sweep` on the same night are both safe). Existing `wrong_site_scan` flags (no `attendanceId`) are unaffected.

## Components

- **`src/lib/missedClockout.ts`** — pure logic. `sweepMissedClockouts(asOfDate?: string): Promise<{ scanned: number; flagged: number; skipped: number }>`. Queries `attendance` for `{ outTime: null, date: { $lte: asOf } }`, creates a `missed_clockout` flag per record (denormalizing `workerName`, `homeSiteId`/`homeSiteName` from the record's site), tolerating the duplicate-key error as "already flagged" (counted in `skipped`). No-ops with a logged warning if `db.dbReady` is false. `asOfDate` defaults to `siteLocalDate()`.
- **`scripts/sweep.ts`** + `"sweep"` npm script — connects to DB, calls `sweepMissedClockouts()`, logs the summary, disconnects, exits. Manually runnable and cron/CI-friendly.
- **`src/lib/scheduler.ts`** — `startDailySweep()`: computes ms until the next `SWEEP_TIME` (IST) using the helpers in `time.ts`, fires via `setTimeout`, runs the sweep, then reschedules for the next day. Plain `setTimeout` — no new dependency. Started from `src/server.ts` after the server boots.

## Error handling

- DB not ready → lib function logs a warning and returns a zero summary; never throws.
- Scheduler catches and logs any sweep error, then always reschedules — one bad night never crashes the web process or halts future runs.
- Duplicate-key on flag insert is caught via the existing `isDuplicateKeyError` helper and counted as `skipped`.

## Testing

`scripts/e2e_missed_clockout.ts` + `e2e:missed` npm script, matching the existing e2e style:

1. An open In-only record → exactly one flag raised; the attendance record is left unchanged (`outTime` still null).
2. A completed record (has `outTime`) → no flag.
3. Running the sweep twice → still exactly one flag (idempotency via the unique index).
4. The raised flag appears in the existing `/flags` list and is role-scoped (an out-of-scope site's flag is hidden from a single-site Supervisor).

The flag surfaces automatically in the existing dashboard flags panel and `/flags` page, which already render `missed_clockout`.

## Out of scope

- Auto-closing records / guessing an out-time (explicitly rejected — flag-only).
- Notifications (email/SMS) on missed clock-outs — a separate future feature.
- Per-site shift-end-based timing — a single nightly run is sufficient for flag-only behavior.
