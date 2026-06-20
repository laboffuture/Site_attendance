# Shift & Overtime Engine (cross-midnight) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Compute attendance + overtime for day/night/Sunday shifts including shifts that cross midnight, per the matrix, leaving OT pending in the existing approval queue.

**Architecture:** A new pure library (`src/lib/shift.ts`) holds the algorithm (`windowHours`, `selectShift`, `computeShiftOT`) with zero DB access. `ProjectSite` gains a per-site `shifts` config (matrix defaults seeded by a migration). `recordScan` is rewritten to match the worker's open session within a 20h lookback (so an Out scan attaches across midnight) and compute via the library. `Attendance` gains `shiftType` + `breakHours`.

**Tech Stack:** Node 22 · Express · TypeScript · Mongoose. Tests = repo e2e/unit scripts run against a live local MongoDB (`npm run e2e:*`) or pure (`npx tsx`), printing `PASS:`/`FAIL:` lines, non-zero exit on failure.

## Global Constraints

- Node `>=20`; `npm run build` (tsc + copy-assets) must pass after each task.
- All times IST (`Asia/Kolkata`, fixed +05:30, no DST).
- Default shift definitions (verbatim): **day** `08:00–17:00`, break 60, otBreakThreshold 5h, otBreak 60 · **night** `20:00–05:00`, break 60, otBreakThreshold 5h, otBreak 60 · **sunday** `08:00–14:00`, break 0, otBreakThreshold 0h, otBreak 60.
- `windowHours` = `end − start`, **+24 when end ≤ start** (night).
- OT-break is **per-shift**: deduct `otBreakMin/60` only when `beyondWindowHours > otBreakThresholdHours`.
- Session matching: a scan attaches to the worker's most-recent record with `outTime: null` and `inTime ≥ now − 20h`; else new In. Record `date` = shift start date; keep the `{workerId, date}` unique index.
- OT lands `status: "pending"` (or `"none"` when 0) — the existing OT approval queue is unchanged. Travel/multi-site and the regularization chain are OUT of scope.
- Reuse `round2`, `hmToHours` from `src/lib/time.ts`.
- Branch: `feature/log-attendance` (current). Spec: `docs/superpowers/specs/2026-06-20-shift-ot-engine-design.md`.

---

### Task 1: Pure shift library + IST helpers (algorithm, fully unit-tested, no DB)

**Files:**
- Modify: `src/lib/time.ts` (add `istHourOfDay`, `istDayOfWeek`)
- Create: `src/lib/shift.ts`
- Test: `scripts/test_shift.ts`

**Interfaces:**
- Consumes: `hmToHours`, `round2`, `istHM` from `src/lib/time.ts`.
- Produces:
  - `time.ts`: `istHourOfDay(d: Date): number` (0–24 fractional, IST); `istDayOfWeek(d: Date): number` (0=Sun…6=Sat, IST).
  - `shift.ts`: `ShiftType = "day"|"night"|"sunday"`; `interface ShiftDef { startTime; endTime; breakMin; otBreakThresholdHours; otBreakMin }`; `DEFAULT_SHIFTS: Record<ShiftType, ShiftDef>`; `type SiteShifts = Record<ShiftType, ShiftDef>`; `windowHours(shift: ShiftDef): number`; `selectShift(shifts: SiteShifts, inTime: Date): ShiftType`; `computeShiftOT(shift: ShiftDef, inTime: Date, outTime: Date): { standardHours: number; overtimeHours: number; breakHours: number }`.

- [ ] **Step 1: Write the failing test** — create `scripts/test_shift.ts`:

```ts
/* Unit test (no DB) for the shift/OT algorithm. Run: npx tsx scripts/test_shift.ts */
import { DEFAULT_SHIFTS, windowHours, selectShift, computeShiftOT } from "../src/lib/shift";

function assert(label: string, cond: boolean): void {
  console.log(`${cond ? "PASS" : "FAIL"}: ${label}`);
  if (!cond) process.exitCode = 1;
}
// IST helpers: build a Date at a given IST wall-clock on a known date.
const ist = (date: string, hm: string) => new Date(`${date}T${hm}:00+05:30`);
const MON = "2026-06-22"; // Monday
const SUN = "2026-06-21"; // Sunday
const near = (a: number, b: number) => Math.abs(a - b) < 0.02;

// windowHours: night crosses midnight
assert("windowHours day = 9", windowHours(DEFAULT_SHIFTS.day) === 9);
assert("windowHours night = 9 (crosses midnight)", windowHours(DEFAULT_SHIFTS.night) === 9);
assert("windowHours sunday = 6", windowHours(DEFAULT_SHIFTS.sunday) === 6);

// selectShift: Sunday → sunday; morning weekday → day; evening weekday → night
assert("Sunday → sunday", selectShift(DEFAULT_SHIFTS, ist(SUN, "08:05")) === "sunday");
assert("weekday morning → day", selectShift(DEFAULT_SHIFTS, ist(MON, "08:05")) === "day");
assert("weekday evening → night", selectShift(DEFAULT_SHIFTS, ist(MON, "20:10")) === "night");
assert("weekday afternoon → day", selectShift(DEFAULT_SHIFTS, ist(MON, "13:00")) === "day");

// computeShiftOT — every matrix row
const day = DEFAULT_SHIFTS.day, night = DEFAULT_SHIFTS.night, sun = DEFAULT_SHIFTS.sunday;
let r = computeShiftOT(day, ist(MON, "08:00"), ist(MON, "17:00"));
assert("day 8-5: std 8 / OT 0", near(r.standardHours, 8) && near(r.overtimeHours, 0));
r = computeShiftOT(day, ist(MON, "08:00"), ist(MON, "20:00"));
assert("day 8-8PM: std 8 / OT 3 (no break)", near(r.standardHours, 8) && near(r.overtimeHours, 3));
r = computeShiftOT(day, ist(MON, "08:00"), ist("2026-06-23", "05:00"));
assert("day 8AM->next 5AM: std 8 / OT 11 (1h break)", near(r.standardHours, 8) && near(r.overtimeHours, 11));
r = computeShiftOT(night, ist(MON, "20:00"), ist("2026-06-23", "05:00"));
assert("night 8PM-5AM: std 8 / OT 0", near(r.standardHours, 8) && near(r.overtimeHours, 0));
r = computeShiftOT(night, ist(MON, "20:00"), ist("2026-06-23", "08:00"));
assert("night 8PM-8AM: std 8 / OT 3 (no break)", near(r.standardHours, 8) && near(r.overtimeHours, 3));
r = computeShiftOT(sun, ist(SUN, "08:00"), ist(SUN, "14:00"));
assert("sunday 8-2: std 6 / OT 0", near(r.standardHours, 6) && near(r.overtimeHours, 0));
r = computeShiftOT(sun, ist(SUN, "08:00"), ist(SUN, "18:00"));
assert("sunday 8-6PM: std 6 / OT 3 (1h break, threshold 0)", near(r.standardHours, 6) && near(r.overtimeHours, 3));

console.log(process.exitCode ? "\nSHIFT TEST FAILED" : "\nSHIFT TEST PASSED");
process.exit(process.exitCode ?? 0);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx scripts/test_shift.ts`
Expected: FAIL — `Cannot find module '../src/lib/shift'` (file not created yet).

- [ ] **Step 3a: Add IST helpers to `src/lib/time.ts`** — append after `istHM` (keep `hmToHours`/`round2` where they are):

```ts
/** IST hour-of-day as a fractional number 0–24 (e.g. 20:30 → 20.5). */
export function istHourOfDay(d: Date): number {
  return hmToHours(istHM(d));
}

/** IST day of week: 0 = Sunday … 6 = Saturday. */
export function istDayOfWeek(d: Date): number {
  const wd = new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Kolkata", weekday: "short" }).format(d);
  return ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(wd);
}
```

- [ ] **Step 3b: Create `src/lib/shift.ts`**:

```ts
/* Shift & overtime engine (pure — no DB). day/night/Sunday definitions, shift
 * selection by scan time, and OT computation with per-shift break rules.
 * See docs/superpowers/specs/2026-06-20-shift-ot-engine-design.md. */
import { hmToHours, round2, istHourOfDay, istDayOfWeek } from "./time";

export type ShiftType = "day" | "night" | "sunday";

export interface ShiftDef {
  startTime: string; // "HH:MM" IST
  endTime: string; // "HH:MM" IST; if <= start, the shift crosses midnight
  breakMin: number; // standard break within the window
  otBreakThresholdHours: number; // OT beyond this many hours loses a break
  otBreakMin: number; // break deducted from OT once over threshold
}
export type SiteShifts = Record<ShiftType, ShiftDef>;

export const DEFAULT_SHIFTS: SiteShifts = {
  day: { startTime: "08:00", endTime: "17:00", breakMin: 60, otBreakThresholdHours: 5, otBreakMin: 60 },
  night: { startTime: "20:00", endTime: "05:00", breakMin: 60, otBreakThresholdHours: 5, otBreakMin: 60 },
  sunday: { startTime: "08:00", endTime: "14:00", breakMin: 0, otBreakThresholdHours: 0, otBreakMin: 60 },
};

/** Clock-hours of the shift window; +24 when it crosses midnight (night). */
export function windowHours(shift: ShiftDef): number {
  const s = hmToHours(shift.startTime);
  const e = hmToHours(shift.endTime);
  return e > s ? e - s : e - s + 24;
}

/** Circular distance between two hour-of-day values (0–24). */
function circularDist(a: number, b: number): number {
  const d = Math.abs(a - b) % 24;
  return Math.min(d, 24 - d);
}

/** Pick the shift for an In-scan: Sunday calendar day → sunday; otherwise the
 *  day/night whose start is nearest the scan time (ties → day). */
export function selectShift(shifts: SiteShifts, inTime: Date): ShiftType {
  if (istDayOfWeek(inTime) === 0) return "sunday";
  const h = istHourOfDay(inTime);
  const dDay = circularDist(h, hmToHours(shifts.day.startTime));
  const dNight = circularDist(h, hmToHours(shifts.night.startTime));
  return dNight < dDay ? "night" : "day";
}

/** Standard + overtime hours for one worked session (handles cross-midnight). */
export function computeShiftOT(
  shift: ShiftDef,
  inTime: Date,
  outTime: Date,
): { standardHours: number; overtimeHours: number; breakHours: number } {
  const elapsedH = (outTime.getTime() - inTime.getTime()) / 3_600_000;
  const winH = windowHours(shift);
  const breakH = shift.breakMin / 60;
  const stdWorkH = Math.max(0, winH - breakH);

  const beyondH = Math.max(0, elapsedH - winH);
  const otBreakH = beyondH > shift.otBreakThresholdHours ? shift.otBreakMin / 60 : 0;
  const overtimeHours = round2(Math.max(0, beyondH - otBreakH));

  const workedToWindow = Math.min(Math.max(0, elapsedH), winH);
  const standardHours = round2(Math.min(stdWorkH, Math.max(0, workedToWindow - breakH)));

  return { standardHours, overtimeHours, breakHours: round2(breakH + otBreakH) };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx scripts/test_shift.ts && npm run build`
Expected: all `PASS:` lines → `SHIFT TEST PASSED`; build clean.

- [ ] **Step 5: Commit**

```bash
git add src/lib/shift.ts src/lib/time.ts scripts/test_shift.ts
git commit -m "feat(shift): pure shift/OT engine (day/night/sunday, cross-midnight) + IST helpers"
```

---

### Task 2: Per-site `shifts` config + migration

**Files:**
- Modify: `src/models/ProjectSite.ts`
- Create: `scripts/migrate_shifts.ts`
- Modify: `package.json` (add `"migrate-shifts"` script)

**Interfaces:**
- Consumes: `DEFAULT_SHIFTS`, `SiteShifts` from `src/lib/shift.ts`.
- Produces: `ProjectSite.shifts: SiteShifts` (every doc has all three shift defs); `npm run migrate-shifts` seeds it on existing sites.

- [ ] **Step 1: Write the failing test** — create `scripts/migrate_shifts.ts` AND its inline self-check is the run output; but first add a guard test by extending `scripts/test_shift.ts` with a model-default check is NOT possible (no DB in that test). Instead, this task is verified by the migration's own report + Task 3's e2e. Write the migration now (Step 3), then Step 4 runs it and asserts via `mongosh`. (No separate failing unit test — the deliverable is config + migration, validated by running it and by Task 3.)

Skip to Step 3.

- [ ] **Step 3a: Add `shifts` to `src/models/ProjectSite.ts`** — add the import and subdocs. Insert at the top (after the existing `import`):

```ts
import { DEFAULT_SHIFTS } from "../lib/shift";
```

Add these schemas above `projectSiteSchema`:

```ts
const shiftDefSchema = new Schema(
  {
    startTime: { type: String, required: true },
    endTime: { type: String, required: true },
    breakMin: { type: Number, default: 60 },
    otBreakThresholdHours: { type: Number, default: 5 },
    otBreakMin: { type: Number, default: 60 },
  },
  { _id: false },
);
const siteShiftsSchema = new Schema(
  {
    day: { type: shiftDefSchema, required: true },
    night: { type: shiftDefSchema, required: true },
    sunday: { type: shiftDefSchema, required: true },
  },
  { _id: false },
);
```

Add the field inside `projectSiteSchema` (after `designationOverrides`):

```ts
    // Per-site day/night/sunday shift definitions (matrix defaults on create).
    shifts: { type: siteShiftsSchema, default: () => JSON.parse(JSON.stringify(DEFAULT_SHIFTS)) },
```

- [ ] **Step 3b: Create `scripts/migrate_shifts.ts`**:

```ts
/* Seeds per-site shift definitions on existing project sites that lack them.
   Idempotent. The `day` window is seeded from any legacy standardStartTime/
   EndTime; night + sunday use the matrix defaults. Run: npm run migrate-shifts */
import mongoose from "mongoose";

import { connectDb } from "../src/db";
import * as db from "../src/db";
import { DEFAULT_SHIFTS } from "../src/lib/shift";
import { ProjectSiteModel } from "../src/models";

async function main(): Promise<void> {
  await connectDb();
  if (!db.dbReady) { console.error("DB not reachable."); process.exit(1); }

  const sites = await ProjectSiteModel.find({}).lean();
  let updated = 0;
  for (const s of sites) {
    if (s.shifts && (s.shifts as { day?: unknown }).day) continue; // already has shifts
    const day = {
      ...DEFAULT_SHIFTS.day,
      startTime: (s as { standardStartTime?: string }).standardStartTime || DEFAULT_SHIFTS.day.startTime,
      endTime: (s as { standardEndTime?: string }).standardEndTime || DEFAULT_SHIFTS.day.endTime,
    };
    await ProjectSiteModel.updateOne(
      { _id: s._id },
      { $set: { shifts: { day, night: DEFAULT_SHIFTS.night, sunday: DEFAULT_SHIFTS.sunday } } },
    );
    updated++;
  }
  console.log(`Shift migration: ${updated} site(s) seeded, ${sites.length - updated} already had shifts.`);
  await mongoose.connection.close();
  process.exit(0);
}
main().catch((e) => { console.error("MIGRATE SHIFTS ERROR:", e?.message ?? e); process.exit(1); });
```

- [ ] **Step 3c: Add the npm script** — in `package.json`, after the `"migrate-roles"` line:

```json
    "migrate-shifts": "tsx scripts/migrate_shifts.ts",
```

- [ ] **Step 4: Run the migration + verify**

Run:
```bash
npm run build && npm run migrate-shifts
mongosh --quiet "mongodb://localhost:27017/trgbi_attendance" --eval 'var s=db.project_sites.findOne({}); print("has day shift:", !!(s.shifts && s.shifts.day), "| night end:", s.shifts && s.shifts.night && s.shifts.night.endTime)'
```
Expected: build clean; migration prints a seeded count; mongosh prints `has day shift: true | night end: 05:00`. Re-running `migrate-shifts` reports 0 newly seeded (idempotent).

- [ ] **Step 5: Commit**

```bash
git add src/models/ProjectSite.ts scripts/migrate_shifts.ts package.json
git commit -m "feat(shift): per-site shift definitions + seed migration"
```

---

### Task 3: Attendance fields + `recordScan` rewrite + e2e

**Files:**
- Modify: `src/models/Attendance.ts` (add `shiftType`, `breakHours`)
- Modify: `src/lib/attendance.ts` (rewrite `recordScan`)
- Create: `scripts/e2e_shift.ts`
- Modify: `package.json` (add `"e2e:shift"`)

**Interfaces:**
- Consumes: `selectShift`, `computeShiftOT`, `SiteShifts`, `ShiftType`, `DEFAULT_SHIFTS` from `src/lib/shift.ts`; `siteLocalDate`, `round2` from `src/lib/time.ts`.
- Produces: `Attendance.shiftType: ShiftType|null`, `Attendance.breakHours: number|null`. `recordScan(worker, site, branchName, geo?)` keeps its signature + `ScanResult` shape, but `ScanSite` now also carries `shifts?: SiteShifts`, and the result adds `shiftType?: ShiftType`.

- [ ] **Step 1: Write the failing test** — create `scripts/e2e_shift.ts`:

```ts
/* E2E for the shift/OT engine via recordScan: an overnight session (In one
   evening, Out next morning) attaches across midnight and computes night OT;
   a fresh scan >20h after a stale open record starts a NEW session. Self-
   contained; cleans up. Run: npm run e2e:shift */
import mongoose, { Types } from "mongoose";

import { connectDb } from "../src/db";
import * as db from "../src/db";
import { recordScan } from "../src/lib/attendance";
import { DEFAULT_SHIFTS } from "../src/lib/shift";
import { BranchModel, ProjectSiteModel, AttendanceModel } from "../src/models";

const S = Date.now().toString(36);
function assert(label: string, cond: boolean): void {
  console.log(`${cond ? "PASS" : "FAIL"}: ${label}`);
  if (!cond) process.exitCode = 1;
}
const near = (a: number | null, b: number) => a != null && Math.abs(a - b) < 0.05;

async function main(): Promise<void> {
  await connectDb();
  if (!db.dbReady) { console.error("DB not reachable."); process.exit(1); }

  const branch = await BranchModel.create({ name: `QA SHIFT ${S}` });
  const site = await ProjectSiteModel.create({
    branchId: branch._id, name: `QA Shift Site ${S}`, code: `QASH${S}`.toUpperCase(),
    standardStartTime: "08:00", standardEndTime: "17:00", shifts: DEFAULT_SHIFTS,
  });
  const siteArg = { _id: site._id, name: site.name, branchId: branch._id, shifts: DEFAULT_SHIFTS };
  const worker = { _id: new Types.ObjectId(), empRegNo: `QA-SH-${S}`, name: `QA Sh ${S}`, designationId: new Types.ObjectId(), designationName: "Carpenter" };

  // First scan → IN (no open session yet)
  const r1 = await recordScan(worker, siteArg as never, branch.name);
  assert("first scan → in", r1.action === "in");
  const rec = await AttendanceModel.findOne({ workerId: worker._id, outTime: null });
  assert("open record created with a shiftType", !!rec && !!rec.shiftType);

  // Simulate a night shift: backdate the In to 11h ago at 20:00-ish so the Out
  // (now) lands the "next morning" and beyond the 9h window → ~2h OT.
  const inAt = new Date(Date.now() - 11 * 3_600_000);
  await AttendanceModel.updateOne({ _id: rec!._id }, { $set: { inTime: inAt, shiftType: "night" } });

  // Second scan → OUT, attaches to the open session across the gap
  const r2 = await recordScan(worker, siteArg as never, branch.name);
  assert("second scan → out (session matched)", r2.action === "out");
  assert("total ~11h", near(r2.totalHours, 11));
  assert("night OT ~2h, no break (2<5)", near(r2.overtimeHours, 2) && r2.overtimeStatus === "pending");
  const closed = await AttendanceModel.findById(rec!._id);
  assert("record closed with outTime + breakHours set", !!closed && !!closed.outTime && closed.breakHours != null);

  // A stale open record >20h old must NOT capture a new scan.
  await AttendanceModel.create({
    date: "2000-01-01", workerId: worker._id, empRegNo: worker.empRegNo, workerName: worker.name,
    designationId: worker.designationId, designationName: "Carpenter",
    siteId: site._id, siteName: site.name, branchId: branch._id, branchName: branch.name,
    inTime: new Date(Date.now() - 30 * 3_600_000), shiftType: "day", source: "scan",
  });
  const r3 = await recordScan(worker, siteArg as never, branch.name);
  assert("scan >20h after a stale open record → new in (not out)", r3.action === "in");

  await Promise.all([
    AttendanceModel.deleteMany({ workerId: worker._id }),
    ProjectSiteModel.deleteOne({ _id: site._id }),
    BranchModel.deleteOne({ _id: branch._id }),
  ]);
  await mongoose.connection.close();
  console.log(process.exitCode ? "\nE2E SHIFT FAILED" : "\nE2E SHIFT PASSED");
  process.exit(process.exitCode ?? 0);
}
main().catch((e) => { console.error("\nE2E SHIFT ERROR:", e?.message ?? e); process.exit(1); });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run e2e:shift` (after adding the script in Step 3c) — or `npx tsx scripts/e2e_shift.ts`.
Expected: FAIL — `recordScan` still keys on today's date, so the second scan does not match the backdated open session (`second scan → out` fails), and `shiftType`/`breakHours` are absent.

- [ ] **Step 3a: Add fields to `src/models/Attendance.ts`** — add after the `standardHours` line (before `overtime`):

```ts
    shiftType: { type: String, enum: ["day", "night", "sunday"], default: null },
    breakHours: { type: Number, default: null },
```

- [ ] **Step 3b: Rewrite `recordScan` in `src/lib/attendance.ts`** — replace the whole file with:

```ts
import { Types } from "mongoose";

import { AttendanceModel } from "../models/Attendance";
import type { GeoCapture } from "./geo";
import { selectShift, computeShiftOT, DEFAULT_SHIFTS, type SiteShifts, type ShiftType } from "./shift";
import { isDuplicateKeyError } from "./validate";
import { siteLocalDate, round2 } from "./time";

const OPEN_SESSION_LOOKBACK_MS = 20 * 3_600_000; // attach an Out to an In up to 20h old

interface ScanWorker {
  _id: Types.ObjectId;
  empRegNo: string;
  name: string;
  designationId: Types.ObjectId;
  designationName: string;
}

interface ScanSite {
  _id: Types.ObjectId;
  name: string;
  branchId: Types.ObjectId;
  shifts?: SiteShifts;
}

export interface ScanResult {
  action: "in" | "out";
  date: string;
  inTime: Date;
  outTime: Date | null;
  totalHours: number | null;
  standardHours: number | null;
  overtimeHours: number;
  overtimeStatus: string;
  shiftType?: ShiftType;
}

/**
 * Records a scan. A scan attaches to the worker's most-recent OPEN record (no
 * Out) whose In is within the last 20h — that scan becomes the Out, even across
 * midnight. Otherwise it's a new In, keyed to the shift's start date, with the
 * shift auto-selected from the scan time. On Out, standard + overtime are
 * computed via the shift engine; OT is left pending until approved.
 */
export async function recordScan(
  worker: ScanWorker,
  site: ScanSite,
  branchName: string,
  geo?: GeoCapture,
): Promise<ScanResult> {
  const now = new Date();
  const shifts = site.shifts ?? DEFAULT_SHIFTS;

  // Find an open session to close (across midnight). Newest first.
  const open = await AttendanceModel.findOne({
    workerId: worker._id,
    outTime: null,
    inTime: { $gte: new Date(now.getTime() - OPEN_SESSION_LOOKBACK_MS) },
  }).sort({ inTime: -1 });

  if (!open) {
    const shiftType = selectShift(shifts, now);
    const date = siteLocalDate(now);
    try {
      await AttendanceModel.create({
        date,
        workerId: worker._id,
        empRegNo: worker.empRegNo,
        workerName: worker.name,
        designationId: worker.designationId,
        designationName: worker.designationName,
        siteId: site._id,
        siteName: site.name,
        branchId: site.branchId,
        branchName,
        inTime: now,
        shiftType,
        inGeo: geo ?? undefined,
        source: "scan",
      });
      return { action: "in", date, inTime: now, outTime: null, totalHours: null, standardHours: null, overtimeHours: 0, overtimeStatus: "none", shiftType };
    } catch (err) {
      // Two near-simultaneous first scans: unique {workerId,date} rejects the
      // second — fall through and close the just-created record as the Out.
      if (!isDuplicateKeyError(err)) throw err;
      const dupe = await AttendanceModel.findOne({ workerId: worker._id, date, outTime: null });
      if (!dupe) throw err;
      return closeSession(dupe, shifts, now, geo);
    }
  }

  return closeSession(open, shifts, now, geo);
}

type OpenRec = NonNullable<Awaited<ReturnType<typeof AttendanceModel.findOne>>>;

async function closeSession(rec: OpenRec, shifts: SiteShifts, now: Date, geo?: GeoCapture): Promise<ScanResult> {
  const shiftType = (rec.shiftType as ShiftType) ?? "day";
  const shift = shifts[shiftType] ?? DEFAULT_SHIFTS[shiftType];
  const { standardHours, overtimeHours, breakHours } = computeShiftOT(shift, rec.inTime, now);
  const totalHours = round2((now.getTime() - rec.inTime.getTime()) / 3_600_000);

  rec.outTime = now;
  if (geo) rec.outGeo = geo;
  rec.totalHours = totalHours;
  rec.standardHours = standardHours;
  rec.breakHours = breakHours;
  rec.overtime = {
    computedHours: overtimeHours,
    status: overtimeHours > 0 ? "pending" : "none",
    approvedHours: null,
    approvedBy: null,
    approvedAt: null,
    notes: null,
  };
  await rec.save();

  return {
    action: "out",
    date: rec.date,
    inTime: rec.inTime,
    outTime: now,
    totalHours,
    standardHours,
    overtimeHours,
    overtimeStatus: rec.overtime.status,
    shiftType,
  };
}
```

- [ ] **Step 3c: Pass `shifts` from the scan routes + add the npm script.**

In `package.json`, after the `"e2e:logscan"` line, add:
```json
    "e2e:shift": "tsx scripts/e2e_shift.ts",
```

In `src/routes/station.ts`, the scan handler loads `const site = await ProjectSiteModel.findById(station.siteId).lean();` then calls `recordScan({...}, site, branch?.name ?? "", geo)`. The lean `site` already includes `shifts`, so `recordScan` picks it up via `site.shifts` — **no change needed** beyond confirming `site` is passed whole (it is). Do the same check in `src/routes/attendance.ts` `POST /attendance/scan` (it passes the lean `site` to `recordScan` — `shifts` flows through). Confirm both compile; no code edit required if they already pass the full lean `site`.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm run build && npm run e2e:shift`
Expected: build clean; `first scan → in`, `open record created with a shiftType`, `second scan → out (session matched)`, `total ~11h`, `night OT ~2h, no break (2<5)`, `record closed with outTime + breakHours set`, `scan >20h after a stale open record → new in (not out)` all PASS → `E2E SHIFT PASSED`.

- [ ] **Step 5: Run the scan regressions (recordScan is shared)**

Run: `npm run e2e:station && npm run e2e:logscan`
Expected: both print `... PASSED`. (These exercise recordScan via the kiosk and the supervisor scan; they enrol fresh fixtures so they're independent of seed drift. If `e2e:station` fails on seed data, run `npm run seed` first — it needs the VBW/PVM fixtures.)

- [ ] **Step 6: Commit**

```bash
git add src/models/Attendance.ts src/lib/attendance.ts scripts/e2e_shift.ts package.json
git commit -m "feat(shift): cross-midnight session matching + shift OT in recordScan"
```

---

## Self-review notes (addressed)

- **Spec coverage:** §"complete algorithm" → Task 1 (`windowHours`/`selectShift`/`computeShiftOT`, every matrix row tested); §shift config + migration → Task 2; §`recordScan` rewrite + Attendance fields + session matching + e2e → Task 3. All covered.
- **Type consistency:** `SiteShifts`, `ShiftType`, `ShiftDef`, `DEFAULT_SHIFTS`, `computeShiftOT`, `selectShift`, `windowHours`, `istHourOfDay`, `istDayOfWeek` used identically across tasks. `recordScan` keeps its 4-arg signature; `ScanSite.shifts` is optional so existing callers passing a lean `site` (which now includes `shifts`) work unchanged.
- **Out of scope confirmed:** no travel/segments, no regularization, no payroll — OT only flows to the existing pending queue.
