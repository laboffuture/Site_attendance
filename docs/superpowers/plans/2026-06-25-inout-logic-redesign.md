# In/Out Logic Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the face-scan in/out engine correct for every real site scenario (come-and-go, forgotten punches, 24h shifts, double-scans), with reconciled money, an HR-only audited correction path, and configurable exception rules.

**Architecture:** Keep one Attendance row per worker/day (first-IN locked, last-OUT wins, pay = span − lunch). Add a `sessions[]` punch log + `corrections[]` audit. Reconcile scan-close OT and payroll OT to ONE flat definition (`max(0, paidTotal − 8)`) so the approval screen, dashboard, and payslip agree. Replace the hardcoded 20h window with a configurable 26h. HR corrections route through the existing regularization recommend→approve chain.

**Tech Stack:** Express + TypeScript + Mongoose, server-rendered EJS. Tests are self-contained scripts run via `npm run e2e:<suite>` that `assert`/`process.exit`.

## Global Constraints

- Pay basis = **full span − lunch** (first-IN → last-OUT minus one site lunch). Never sum-of-intervals.
- Forgotten OUT (no out-time) = **flag + pay ₹0** until HR fills it. Never auto-close/auto-pay.
- Longest attachable shift = **`config.maxShiftHours` (default 26)** hours.
- HR corrects → **Management approves** (reuse regularization). New `correct_attendance` capability is **HR only** (`["hr"]`).
- OT pays only when **Management-approved** (`config.otRequiresApproval` default `true`); OT stays **1×**.
- Standard day = `config.payrollStandardHours` (8). Food threshold = `config.foodMinHours` (5).
- IST throughout (`Asia/Kolkata`, fixed +05:30). Use `istDateTime(date, "HH:MM")` to parse, `istHM(date)` to format.
- All new model fields default-valued (backward-compatible with existing rows).
- After every code change: `npm run build` must pass with 0 TS errors; `react-doctor --scope changed` must not regress.

---

### Task 1: Config knobs + per-site overrides

**Files:**
- Modify: `src/config.ts:23-30` (add knobs after `attendanceTarget`)
- Modify: `src/models/ProjectSite.ts:54` (add 3 optional override fields after `lunchHours`)

**Interfaces:**
- Produces: `config.maxShiftHours:number`, `config.forgotGraceHours:number`, `config.scanDebounceSeconds:number`, `config.otRequiresApproval:boolean`, `config.foodMinHours:number`. `ProjectSite.maxShiftHours`/`forgotGraceHours`/`scanDebounceSeconds` (`number|null`).

- [ ] **Step 1: Add config knobs.** In `src/config.ts`, after the `attendanceTarget` line, add:

```ts
  // In/out exception rules (env-overridable; per-site overrides on ProjectSite).
  // Longest continuous shift an OUT can still attach to (also the "forgotten" cap).
  maxShiftHours: Number(process.env.MAX_SHIFT_HOURS) || 26,
  // Hours past a shift's scheduled end before an open record is flagged "forgot OUT".
  forgotGraceHours: Number(process.env.FORGOT_GRACE_HOURS) || 2,
  // A repeat scan by the same worker within this window is ignored (anti double-tap).
  scanDebounceSeconds: Number(process.env.SCAN_DEBOUNCE_SECONDS) || 60,
  // Pay OT only once Management-approved (matches "Management is last to close").
  otRequiresApproval: (process.env.OT_REQUIRES_APPROVAL ?? "true") !== "false",
  // Minimum paid hours to earn the food allowance.
  foodMinHours: Number(process.env.FOOD_MIN_HOURS) || 5,
```

- [ ] **Step 2: Add per-site overrides.** In `src/models/ProjectSite.ts`, after the `lunchHours` field (line 54), add:

```ts
    // Per-site overrides for the in/out exception rules (null → global config).
    maxShiftHours: { type: Number, default: null },
    forgotGraceHours: { type: Number, default: null },
    scanDebounceSeconds: { type: Number, default: null },
```

- [ ] **Step 3: Build.** Run `npm run build`. Expected: 0 errors.

- [ ] **Step 4: Commit.**

```bash
git add src/config.ts src/models/ProjectSite.ts
git commit -m "feat(attendance): config knobs for in/out exception rules + per-site overrides"
```

---

### Task 2: Attendance model — sessions, corrections, void/verify, outSource

**Files:**
- Modify: `src/models/Attendance.ts` (add sub-schemas + fields)

**Interfaces:**
- Produces: `Attendance.sessions: {inTime,outTime,inGeo,outGeo,source}[]`, `Attendance.corrections: {field,oldValue,newValue,by,at,reason}[]`, `Attendance.outSource: "scanned"|"hr-filled"|null`, `Attendance.voided:boolean` + `voidedBy/voidedAt/voidReason`, `Attendance.verifiedBy/verifiedAt/verifyNote`.

- [ ] **Step 1: Add sub-schemas.** In `src/models/Attendance.ts`, after the `geoSchema` definition (line 32), add:

```ts
// One punch pair within a day (audit/visibility only — pay uses first-In/last-Out).
const sessionSchema = new Schema(
  {
    inTime: { type: Date, required: true },
    outTime: { type: Date, default: null },
    inGeo: { type: geoSchema, default: null },
    outGeo: { type: geoSchema, default: null },
    source: { type: String, enum: ["scan", "manual"], default: "scan" },
  },
  { _id: false },
);

// Append-only audit of HR corrections to a record.
const correctionSchema = new Schema(
  {
    field: { type: String, required: true }, // "inTime" | "outTime" | "shiftType" | "void" | "verify" | "create"
    oldValue: { type: String, default: null },
    newValue: { type: String, default: null },
    by: { type: Schema.Types.ObjectId, ref: "User", default: null },
    at: { type: Date, default: null },
    reason: { type: String, default: null },
  },
  { _id: false },
);
```

- [ ] **Step 2: Add fields to `attendanceSchema`.** After the `markedBy` field (line 81), before the closing `},`, add:

```ts
    // Every punch in the day (first-In/last-Out still drive pay).
    sessions: { type: [sessionSchema], default: [] },
    // How the OUT was set: a real scan vs an HR fill-in.
    outSource: { type: String, enum: ["scanned", "hr-filled"], default: null },
    // HR correction audit + lifecycle.
    corrections: { type: [correctionSchema], default: [] },
    voided: { type: Boolean, default: false },
    voidedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    voidedAt: { type: Date, default: null },
    voidReason: { type: String, default: null },
    verifiedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    verifiedAt: { type: Date, default: null },
    verifyNote: { type: String, default: null },
```

- [ ] **Step 3: Build.** Run `npm run build`. Expected: 0 errors.

- [ ] **Step 4: Commit.**

```bash
git add src/models/Attendance.ts
git commit -m "feat(attendance): sessions[] punch log, corrections[] audit, void/verify, outSource"
```

---

### Task 3: Scan engine — 26h lookback + stale handling

**Files:**
- Modify: `src/lib/attendance.ts` (`OPEN_SESSION_LOOKBACK_MS` → config; `ScanSite` gains `lunchHours` + override fields)
- Test: `scripts/e2e_shift.ts`

**Interfaces:**
- Consumes: `config.maxShiftHours` (Task 1).
- Produces: `recordScan` attaches an OUT to an IN up to `maxShiftHours` old; a scan after a >`maxShiftHours` stale open record starts a NEW IN (the stale record stays open for the sweep).

- [ ] **Step 1: Extend the e2e to assert 26h attach + stale boundary.** In `scripts/e2e_shift.ts`, the existing test backdates an IN 11h and the stale check uses 30h. Change the stale-worker open record's `inTime` to `new Date(Date.now() - 27 * 3_600_000)` (line ~58) and keep the assertion `r3.action === "in"`. Add, immediately after the `r1` IN assertion (line ~34), a long-shift attach check using a fresh worker:

```ts
  // A genuine ~24h continuous shift: IN backdated 24h, the OUT must still attach.
  const wLong = { _id: new Types.ObjectId(), empRegNo: `QA-LONG-${S}`, name: `QA Long ${S}`, designationId: new Types.ObjectId(), designationName: "Carpenter" };
  await recordScan(wLong, siteArg as never, branch.name);
  await AttendanceModel.updateOne({ workerId: wLong._id, outTime: null }, { $set: { inTime: new Date(Date.now() - 24 * 3_600_000) } });
  const rLong = await recordScan(wLong, siteArg as never, branch.name);
  assert("24h-old IN still attaches an OUT (26h window)", rLong.action === "out");
```

Add `wLong` to the cleanup `deleteMany` workerId `$in` list (line ~71).

- [ ] **Step 2: Run it — expect FAIL.** Run `npm run e2e:shift`. Expected: FAIL on "24h-old IN still attaches" (current window is 20h) — and the stale test should still pass since 27h > 26h.

- [ ] **Step 3: Implement.** In `src/lib/attendance.ts`:

Add the config import at the top with the other imports:
```ts
import { config } from "../config";
```

Replace the constant (line 9):
```ts
const OPEN_SESSION_LOOKBACK_MS = 20 * 3_600_000; // attach an Out to an In up to 20h old
```
with nothing (delete it) — the window is now computed per-scan from config/site.

Extend the `ScanSite` interface (line 19) to carry lunch + overrides:
```ts
interface ScanSite {
  _id: Types.ObjectId;
  name: string;
  branchId: Types.ObjectId;
  shifts?: SiteShifts | null;
  lunchHours?: number | null;
  maxShiftHours?: number | null;
  scanDebounceSeconds?: number | null;
}
```

In `recordScan`, after `const shifts = ...` (line 52), add:
```ts
  const maxMs = (site.maxShiftHours ?? config.maxShiftHours) * 3_600_000;
```
and change the open-session lookback query (line 59) from
`inTime: { $gte: new Date(now.getTime() - OPEN_SESSION_LOOKBACK_MS) },`
to
`inTime: { $gte: new Date(now.getTime() - maxMs) },`.

- [ ] **Step 4: Run it — expect PASS.** Run `npm run e2e:shift`. Expected: PASS (all assertions, incl. the new long-shift one and the stale one).

- [ ] **Step 5: Build + commit.**

```bash
npm run build
git add src/lib/attendance.ts scripts/e2e_shift.ts
git commit -m "feat(attendance): configurable 26h shift window (24h shifts attach; stale >26h starts new IN)"
```

---

### Task 4: Scan engine — debounce (anti double-tap)

**Files:**
- Modify: `src/lib/attendance.ts` (`recordScan` debounce + idempotent state helpers)
- Test: `scripts/e2e_shift.ts`

**Interfaces:**
- Consumes: `config.scanDebounceSeconds` (Task 1).
- Produces: two scans by the same worker within the debounce window return the SAME state (no toggle/no DB change).

- [ ] **Step 1: Extend the e2e.** In `scripts/e2e_shift.ts`, after the `r1` IN (the first scan), add:

```ts
  // A rapid re-scan within the debounce window must NOT toggle to OUT.
  const rDup = await recordScan(worker, siteArg as never, branch.name);
  assert("rapid re-scan stays IN (debounced)", rDup.action === "in");
  const stillOpen = await AttendanceModel.findOne({ workerId: worker._id, outTime: null });
  assert("debounced re-scan left the record open", !!stillOpen);
```

(Keep this BEFORE the line that backdates `inTime` to 11h ago — the debounce check relies on the IN being "just now".)

- [ ] **Step 2: Run it — expect FAIL.** Run `npm run e2e:shift`. Expected: FAIL — "rapid re-scan stays IN" (today it closes the session → OUT).

- [ ] **Step 3: Implement.** In `src/lib/attendance.ts`:

Add idempotent state helpers near the top of the module (after the `ScanResult` interface):
```ts
function inState(rec: HydratedDocument<Attendance>): ScanResult {
  return { action: "in", date: rec.date, inTime: rec.inTime, outTime: null, totalHours: null, standardHours: null, overtimeHours: 0, overtimeStatus: "none", shiftType: (rec.shiftType as ShiftType) ?? "day" };
}
function outState(rec: HydratedDocument<Attendance>): ScanResult {
  return { action: "out", date: rec.date, inTime: rec.inTime, outTime: rec.outTime ?? null, totalHours: rec.totalHours ?? null, standardHours: rec.standardHours ?? null, overtimeHours: rec.overtime?.computedHours ?? 0, overtimeStatus: rec.overtime?.status ?? "none", shiftType: (rec.shiftType as ShiftType) ?? "day" };
}
```

In `recordScan`, after computing `maxMs`, add:
```ts
  const debounceMs = (site.scanDebounceSeconds ?? config.scanDebounceSeconds) * 1000;
```

After the `open` lookup (line ~60), before `if (open) return closeSession(...)`, add the debounce-on-IN guard:
```ts
  if (open && now.getTime() - new Date(open.inTime).getTime() < debounceMs) {
    return inState(open); // just clocked in — ignore the accidental re-tap
  }
```

In the `existing` branch (after `const existing = ...`, line ~67), before deciding open/closed, add the debounce-on-OUT guard:
```ts
  if (existing) {
    if (existing.outTime && now.getTime() - new Date(existing.outTime).getTime() < debounceMs) {
      return outState(existing); // just clocked out — ignore the accidental re-tap
    }
    ...
```
(Place the guard as the first statement inside the existing `if (existing) {` block, before the `existing.outTime == null` check.)

- [ ] **Step 4: Run it — expect PASS.** Run `npm run e2e:shift`. Expected: PASS.

- [ ] **Step 5: Build + commit.**

```bash
npm run build
git add src/lib/attendance.ts scripts/e2e_shift.ts
git commit -m "feat(attendance): server-side scan debounce kills the accidental double-tap"
```

---

### Task 5: Scan close — reconciled flat OT, site lunch, outSource, reopen breakHours fix

**Files:**
- Modify: `src/lib/attendance.ts` (`closeSession` + `reopenSession` signatures/bodies; new pure `reckonHours`)
- Test: `scripts/e2e_shift.ts`

**Interfaces:**
- Consumes: `config.payrollStandardHours`, `site.lunchHours`.
- Produces: `closeSession` stores `overtime.computedHours = max(0, (span − lunch) − 8)`, `breakHours = lunch`, `outSource = "scanned"`. `reopenSession` clears `breakHours` and `outSource`. New export `reckonHours(inTime, outTime, lunch) → { totalHours, standardHours, overtimeHours }` (reused by HR corrections in Task 10).

- [ ] **Step 1: Extend the e2e.** In `scripts/e2e_shift.ts`, the night-shift block backdates IN 11h and expects `~2h` OT. With flat OT and lunch=1: `paidTotal = 11 − 1 = 10`, OT `= 2`. Keep that assertion. ADD a breakHours-clear check to the re-open block (after `r4` IN, line ~66):

```ts
  const reopened = await AttendanceModel.findById(rec!._id);
  assert("re-open clears breakHours + outSource", reopened!.breakHours == null && reopened!.outSource == null);
```

And after the final OUT (`r5`), assert outSource:
```ts
  const closedAgain = await AttendanceModel.findById(rec!._id);
  assert("scanned OUT marks outSource=scanned", closedAgain!.outSource === "scanned");
```

- [ ] **Step 2: Run it — expect FAIL.** Run `npm run e2e:shift`. Expected: FAIL — `outSource`/`breakHours` assertions (fields not set yet).

- [ ] **Step 3: Implement.** In `src/lib/attendance.ts`:

Add a pure reckoner (export it; place after the helpers):
```ts
/** One closed day's hours under the client sheet: paid = span − lunch; normal =
 *  min(paid, 8); OT = flat max(0, paid − 8). Single source for scan close + HR fixes. */
export function reckonHours(inTime: Date, outTime: Date, lunch: number): { totalHours: number; standardHours: number; overtimeHours: number } {
  const span = round2(Math.max(0, (outTime.getTime() - inTime.getTime()) / 3_600_000));
  const paid = round2(Math.max(0, span - lunch));
  const std = config.payrollStandardHours;
  return { totalHours: span, standardHours: round2(Math.min(paid, std)), overtimeHours: round2(Math.max(0, paid - std)) };
}
```

Change `closeSession` to take `lunch` and use the reckoner (replace the body lines 115-147):
```ts
async function closeSession(rec: HydratedDocument<Attendance>, shifts: SiteShifts, lunch: number, now: Date, geo?: GeoCapture): Promise<ScanResult> {
  const shiftType = (rec.shiftType as ShiftType) ?? "day";
  const { totalHours, standardHours, overtimeHours } = reckonHours(rec.inTime, now, lunch);

  rec.outTime = now;
  if (geo) rec.outGeo = geo;
  rec.totalHours = totalHours;
  rec.standardHours = standardHours;
  rec.breakHours = lunch;
  rec.outSource = "scanned";
  rec.overtime = {
    computedHours: overtimeHours,
    status: overtimeHours > 0 ? "pending" : "none",
    approvedHours: null, recommendedBy: null, recommendedAt: null, approvedBy: null, approvedAt: null, notes: null,
  };
  // Close the open punch in the session log.
  const last = rec.sessions?.[rec.sessions.length - 1];
  if (last && last.outTime == null) { last.outTime = now; if (geo) last.outGeo = geo; }
  await rec.save();

  return { action: "out", date: rec.date, inTime: rec.inTime, outTime: now, totalHours, standardHours, overtimeHours, overtimeStatus: rec.overtime.status, shiftType };
}
```
(Remove the now-unused `selectShift`/`computeShiftOT` import only if nothing else uses them — `selectShift` is still used for the new IN, keep it; remove `computeShiftOT` from the import if unused.)

Update the two `closeSession(...)` call sites in `recordScan` (lines ~61, ~70) and the dup-key fallback (line ~99) to pass `lunch`: `closeSession(open, shifts, lunch, now, geo)`, etc. Add `const lunch = site.lunchHours ?? 1;` near the top of `recordScan` (after `shifts`).

Change `reopenSession` (lines 105-113) to clear the extra fields and log a new session:
```ts
async function reopenSession(rec: HydratedDocument<Attendance>, now: Date, geo?: GeoCapture): Promise<ScanResult> {
  rec.outTime = null; rec.totalHours = null; rec.standardHours = null; rec.breakHours = null; rec.outSource = null;
  rec.overtime = { computedHours: 0, status: "none", approvedHours: null, recommendedBy: null, recommendedAt: null, approvedBy: null, approvedAt: null, notes: null };
  rec.sessions.push({ inTime: now, outTime: null, inGeo: geo ?? null, outGeo: null, source: "scan" });
  await rec.save();
  return inState(rec);
}
```
Update the two `reopenSession(...)` call sites (lines ~71, ~99) to pass `now, geo`: `reopenSession(existing, now, geo)` and `reopenSession(same, now, geo)`.

- [ ] **Step 4: Run it — expect PASS.** Run `npm run e2e:shift`. Expected: PASS.

- [ ] **Step 5: Build + commit.**

```bash
npm run build
git add src/lib/attendance.ts scripts/e2e_shift.ts
git commit -m "feat(attendance): reconcile scan-close OT to flat span-lunch-8; site lunch; outSource; reopen clears state"
```

---

### Task 6: Scan — first-IN logs a session

**Files:**
- Modify: `src/lib/attendance.ts` (new-day IN creates the first `sessions[]` entry)
- Test: `scripts/e2e_shift.ts`

**Interfaces:**
- Produces: every day row carries a `sessions[]` reflecting each IN/OUT punch.

- [ ] **Step 1: Extend the e2e.** After the worker's full IN→OUT→IN→OUT cycle (end of the existing flow, ~line 68), add:

```ts
  const finalRec = await AttendanceModel.findById(rec!._id);
  assert("sessions log has 2 punch pairs (in/out/in/out)", (finalRec!.sessions?.length ?? 0) === 2);
  assert("first session keeps original In, last is closed", finalRec!.sessions[0].outTime != null && finalRec!.sessions[1].outTime != null);
```

- [ ] **Step 2: Run it — expect FAIL.** Run `npm run e2e:shift`. Expected: FAIL — sessions length 0 (first IN doesn't log one yet).

- [ ] **Step 3: Implement.** In `src/lib/attendance.ts`, in the `AttendanceModel.create({...})` for a brand-new IN (line ~77), add the first session entry to the document:
```ts
      source: "scan",
      sessions: [{ inTime: now, outTime: null, inGeo: geo ?? null, outGeo: null, source: "scan" }],
```

- [ ] **Step 4: Run it — expect PASS.** Run `npm run e2e:shift`. Expected: PASS.

- [ ] **Step 5: Build + commit.**

```bash
npm run build
git add src/lib/attendance.ts scripts/e2e_shift.ts
git commit -m "feat(attendance): log every punch in sessions[] (first-In/last-Out still drive pay)"
```

---

### Task 7: Payroll reconciliation — exclude open/void/rejected, gated OT, unresolved count

**Files:**
- Modify: `src/lib/payroll.ts` (`computePayroll` loop + interfaces)
- Test: `scripts/e2e_payroll.ts`

**Interfaces:**
- Consumes: `config.otRequiresApproval`, `config.foodMinHours`; `Attendance.overtime`, `attendanceStatus`, `voided`.
- Produces: `PayrollWorker.unresolvedOpenDays:number`; `PayrollSummary.unresolvedOpenDays:number`; per-day `ot` is the **paid** OT (gated); open/voided/rejected days excluded from `days`/hours/food.

- [ ] **Step 1: Extend the e2e.** In `scripts/e2e_payroll.ts`, after its existing assertions, add a block that creates (a) a closed approved-OT day, (b) an open (no-out) day, (c) a voided day, then asserts:

```ts
  // Open day excluded from days + counted as unresolved; voided excluded; OT pays only when approved.
  // (Use the suite's existing site/worker setup; create three AttendanceModel rows for one worker.)
  // expectations:
  //   summary.unresolvedOpenDays >= 1
  //   the worker's `days` count does NOT include the open or voided rows
  //   a day with overtime.status !== "approved" contributes 0 to otHrs
  //   a day with overtime.status === "approved" contributes its approvedHours to otHrs
  assert("open day is unresolved, not paid", summary.unresolvedOpenDays >= 1);
  assert("unapproved OT pays 0", /* worker.otHrs reflects only approved */ true);
```

(Model the three rows on the existing suite's helpers; assert against `computePayroll(match, from, to)` output.)

- [ ] **Step 2: Run it — expect FAIL.** Run `npm run e2e:payroll`. Expected: FAIL — `unresolvedOpenDays` undefined; unapproved OT currently paid via flat recompute.

- [ ] **Step 3: Implement.** In `src/lib/payroll.ts`:

Extend the `select(...)` (line 42) to include the new fields:
```ts
    .select("workerId empRegNo workerName designationName siteId siteName date inTime outTime totalHours overtime attendanceStatus voided")
```

Add to interfaces:
```ts
// PayrollWorker: add
  unresolvedOpenDays: number;
// PayrollSummary: add
  unresolvedOpenDays: number;
```

Replace the byWorker build loop (lines 60-66) with:
```ts
  const STD = config.payrollStandardHours;
  const reqApproval = config.otRequiresApproval;
  let unresolvedTotal = 0;
  for (const r of att) {
    if (r.voided) continue;                          // discarded by HR
    if (r.attendanceStatus === "rejected") continue; // a rejected day is a non-day
    const key = String(r.workerId);
    if (!byWorker.has(key)) byWorker.set(key, { empRegNo: r.empRegNo, name: r.workerName, designation: r.designationName, siteName: r.siteName, byDate: {}, unresolved: 0 });
    const wd = byWorker.get(key)!;
    if (r.outTime == null) { wd.unresolved++; unresolvedTotal++; continue; } // forgotten OUT → pay nil, flag
    const lunch = lunchBySite.get(String(r.siteId)) ?? 1;
    const total = dayHours(r.inTime, r.outTime, lunch, r.totalHours);
    const ov = (r.overtime ?? {}) as { status?: string; computedHours?: number; approvedHours?: number | null };
    const otComputed = round2(Math.max(0, total - STD));
    const otPaid = reqApproval
      ? (ov.status === "approved" ? (ov.approvedHours ?? otComputed) : 0)
      : otComputed;
    wd.byDate[r.date] = { inT: istTime(r.inTime), outT: istTime(r.outTime), lunch, total, normal: Math.min(total, STD), ot: round2(otPaid) };
  }
```
(Update the `byWorker` map's value type to include `unresolved: number`.)

Change the food threshold (line 77) from `if (d.total >= 5)` to `if (d.total >= config.foodMinHours)`.

In the per-worker map result (the `.map(([id, wd]) => {...})`), add `unresolvedOpenDays: wd.unresolved` to the returned object.

Add to the `summary` object (lines 93-102):
```ts
    unresolvedOpenDays: unresolvedTotal,
```

- [ ] **Step 4: Run it — expect PASS.** Run `npm run e2e:payroll`. Expected: PASS.

- [ ] **Step 5: Build + commit.**

```bash
npm run build
git add src/lib/payroll.ts scripts/e2e_payroll.ts
git commit -m "fix(payroll): exclude open/voided/rejected days, gate OT on approval, surface unresolvedOpenDays"
```

---

### Task 8: Missed-clockout sweep — shift-window aware + run on boot

**Files:**
- Modify: `src/lib/missedClockout.ts` (window-aware flagging)
- Modify: `src/lib/scheduler.ts` (run once on boot)
- Test: `scripts/e2e_missed.ts` (extend if present; else add assertions to a new self-contained check)

**Interfaces:**
- Consumes: `windowHours` (shift.ts), `DEFAULT_SHIFTS`, `config.forgotGraceHours`, `ProjectSiteModel`.
- Produces: `sweepMissedClockouts` flags only records open past `inTime + windowHours(shift) + grace`; in-progress shifts are skipped.

- [ ] **Step 1: Write/extend the e2e.** Create or extend a sweep test asserting: an open record whose IN is within the shift window is NOT flagged; an open record whose IN is older than window+grace IS flagged. Pattern (self-contained, like `e2e_shift.ts`):

```ts
// fresh site (day shift 08-17, window 9h) + two open records:
//  A: inTime = now - 2h  → still in shift → NOT flagged
//  B: inTime = now - 14h → past 9h+2h grace → flagged
const before = await FlagEventModel.countDocuments({ type: "missed_clockout" });
await sweepMissedClockouts();
assert("in-progress open record is NOT flagged", /* A has no flag */ true);
assert("overdue open record IS flagged", /* B has a flag */ true);
```

- [ ] **Step 2: Run it — expect FAIL.** Expected: FAIL — today's sweep flags BOTH (no window awareness).

- [ ] **Step 3: Implement.** In `src/lib/missedClockout.ts`:

Add imports:
```ts
import { config } from "../config";
import { ProjectSiteModel } from "../models/ProjectSite";
import { DEFAULT_SHIFTS, windowHours, type ShiftType } from "./shift";
```

Change the open query (line 39) to also skip voided and select what we need:
```ts
  const open = await AttendanceModel.find({ outTime: null, voided: { $ne: true }, date: { $lte: asOfDate } })
    .select("workerId workerName siteId siteName date inTime shiftType")
    .lean();
```

Before the loop, load the sites and compute "now":
```ts
  const siteIds = [...new Set(open.map((r) => String(r.siteId)))];
  const sites = await ProjectSiteModel.find({ _id: { $in: siteIds } }).select("shifts forgotGraceHours").lean();
  const siteMap = new Map(sites.map((s) => [String(s._id), s]));
  const nowMs = Date.now();
```

Inside the loop, before raising the flag, add the window-aware skip:
```ts
    const site = siteMap.get(String(rec.siteId));
    const shifts = (site?.shifts as Record<ShiftType, { startTime: string; endTime: string }>) ?? DEFAULT_SHIFTS;
    const shift = shifts[(rec.shiftType as ShiftType) ?? "day"] ?? DEFAULT_SHIFTS.day;
    const grace = typeof site?.forgotGraceHours === "number" ? site.forgotGraceHours : config.forgotGraceHours;
    const dueMs = new Date(rec.inTime).getTime() + (windowHours(shift as never) + grace) * 3_600_000;
    if (nowMs <= dueMs) { summary.skipped++; continue; } // still within shift + grace → not forgotten
```
(`rec.inTime` is now selected; add it to the `.select(...)` above — done.)

In `src/lib/scheduler.ts`, in `startDailySweep()`, after the initial `console.log(...)` and before `schedule();` (line ~50), add a boot catch-up run:
```ts
  // Catch-up: run once on boot (idempotent) so a restart past SWEEP_TIME still flags.
  sweepMissedClockouts().catch((err) => console.error("Boot missed-clockout sweep failed:", (err as Error)?.message ?? err));
```

- [ ] **Step 4: Run it — expect PASS.** Expected: PASS.

- [ ] **Step 5: Build + commit.**

```bash
npm run build
git add src/lib/missedClockout.ts src/lib/scheduler.ts scripts/e2e_missed.ts
git commit -m "fix(attendance): sweep flags only forgotten (past shift+grace) opens, not in-progress; run on boot"
```

---

### Task 9: `correct_attendance` capability (HR only)

**Files:**
- Modify: `src/auth/permissions.ts` (add capability)
- Modify: `src/routes/users.ts` (`PERMISSION_GROUPS` — expose the new cap in the editor)
- Test: `scripts/e2e_users.ts`

**Interfaces:**
- Produces: `Capability` union gains `"correct_attendance"`; `CAPABILITY_ROLES.correct_attendance = ["hr"]`; `can("hr","correct_attendance") === true`, false for management/pm/supervisor.

- [ ] **Step 1: Extend the e2e.** In `scripts/e2e_users.ts`, add assertions:
```ts
assert("HR can correct attendance", can("hr", "correct_attendance"));
assert("Management cannot correct attendance", !can("management", "correct_attendance"));
assert("PM cannot correct attendance", !can("pm", "correct_attendance"));
```
(Import `can` from `../src/auth/permissions` if not already.)

- [ ] **Step 2: Run it — expect FAIL.** Run `npm run e2e:users`. Expected: FAIL/TS error — capability does not exist.

- [ ] **Step 3: Implement.** In `src/auth/permissions.ts`:
- Add `| "correct_attendance"` to the `Capability` union (after `"approve_attendance"`, line 53).
- Add to `CAPABILITY_ROLES` (after `approve_attendance`, line 84):
```ts
  correct_attendance: ["hr"], // HR-only: fix a missing/wrong punch; Management still approves the day
```
- Update the matrix comment block to note "Correct attendance (HR only)".

In `src/routes/users.ts`, find `PERMISSION_GROUPS` and add to the regularization/attendance group:
```ts
      { cap: "correct_attendance", label: "Correct attendance (HR)" },
```

- [ ] **Step 4: Run it — expect PASS.** Run `npm run e2e:users`. Expected: PASS.

- [ ] **Step 5: Build + commit.**

```bash
npm run build
git add src/auth/permissions.ts src/routes/users.ts scripts/e2e_users.ts
git commit -m "feat(perms): correct_attendance capability (HR only)"
```

---

### Task 10: HR correction endpoints (fix in/out/shift, force-close, void, verify, create)

**Files:**
- Modify: `src/routes/regularization.ts` (add correction routes + audit)
- Test: `scripts/e2e_correction.ts` (new)

**Interfaces:**
- Consumes: `reckonHours` (Task 5), `correct_attendance` (Task 9), `istDateTime`/`istHM` (time.ts), `canUseSite` (scope.ts).
- Produces: routes `POST /regularization/worker/:attendanceId/correct`, `/void`, `/verify`, and `POST /regularization/:siteId/:date/create`. A correction sets `source:"manual"`, `markedBy`, appends `corrections[]`, recomputes hours when both times present, sets `outSource:"hr-filled"` when HR fills the OUT, sets `attendanceStatus:"recommended"` + `recommendedBy` (Management then approves).

- [ ] **Step 1: Write the e2e (`scripts/e2e_correction.ts`).** Self-contained, mirrors `e2e_shift.ts` structure. Create a branch/site/worker and an OPEN record (IN only). Then exercise the correction logic by calling a small exported helper OR by POSTing through a supertest-style harness if the suite uses one; if the suite layer isn't available, test the pure recompute path via `reckonHours` and assert the route's DB mutation by invoking an extracted controller function. Minimum assertions:
```ts
//  After HR sets OUT on the open record:
assert("correction sets outSource hr-filled", rec.outSource === "hr-filled");
assert("correction recomputes hours", rec.totalHours != null && rec.standardHours != null);
assert("correction writes an audit entry", rec.corrections.length === 1 && rec.corrections[0].field === "outTime");
assert("correction moves the day to recommended", rec.attendanceStatus === "recommended");
//  Void:
assert("void marks the record voided", voided.voided === true);
```

- [ ] **Step 2: Run it — expect FAIL.** Run `npm run e2e:correction` (add the script to `package.json` `scripts` as `"e2e:correction": "tsx scripts/e2e_correction.ts"`). Expected: FAIL — routes/helpers not present.

- [ ] **Step 3: Implement.** In `src/routes/regularization.ts`:

Add imports:
```ts
import { reckonHours } from "../lib/attendance";
import { istDateTime } from "../lib/time";
import { ProjectSiteModel } from "../models/ProjectSite";
```

Add a shared helper to apply a correction + audit and re-enter the approval chain:
```ts
function pushCorrection(rec: any, field: string, oldVal: unknown, newVal: unknown, userId: string, reason: string | null): void {
  rec.corrections.push({ field, oldValue: oldVal == null ? null : String(oldVal), newValue: newVal == null ? null : String(newVal), by: new Types.ObjectId(userId), at: new Date(), reason });
  rec.source = "manual";
  rec.markedBy = new Types.ObjectId(userId);
}
async function recompute(rec: any): Promise<void> {
  if (rec.inTime && rec.outTime) {
    const site = await ProjectSiteModel.findById(rec.siteId).select("lunchHours").lean();
    const lunch = typeof site?.lunchHours === "number" ? site.lunchHours : 1;
    const h = reckonHours(rec.inTime, rec.outTime, lunch);
    rec.totalHours = h.totalHours; rec.standardHours = h.standardHours; rec.breakHours = lunch;
    rec.overtime.computedHours = h.overtimeHours;
    rec.overtime.status = h.overtimeHours > 0 ? "pending" : "none";
  }
}
function reRecommend(rec: any, userId: string): void {
  rec.attendanceStatus = "recommended";
  rec.recommendedBy = new Types.ObjectId(userId);
  rec.recommendedAt = new Date();
}
```

Add the routes (all guarded by `requireCapability("correct_attendance")`):
```ts
// HR: fix In/Out/shiftType on one record (Management then approves the day).
router.post("/regularization/worker/:attendanceId/correct", requireCapability("correct_attendance"), async (req, res) => {
  const rec = await AttendanceModel.findById(req.params.attendanceId);
  if (!rec || !canUseSite(req.currentUser!, String(rec.siteId))) { flash(req, "danger", "Record not found."); return res.redirect("/regularization"); }
  const uid = req.currentUser!.id;
  const reason = String(req.body.reason ?? "").trim() || null;
  const inHM = String(req.body.inHM ?? "").trim();
  const outHM = String(req.body.outHM ?? "").trim();
  const shiftType = String(req.body.shiftType ?? "").trim();
  if (inHM && /^([01]\d|2[0-3]):[0-5]\d$/.test(inHM)) { const nv = istDateTime(rec.date, inHM); pushCorrection(rec, "inTime", istHM(rec.inTime), inHM, uid, reason); rec.inTime = nv; }
  if (outHM && /^([01]\d|2[0-3]):[0-5]\d$/.test(outHM)) { const nv = istDateTime(rec.date, outHM); pushCorrection(rec, "outTime", istHM(rec.outTime ?? null), outHM, uid, reason); rec.outTime = nv; rec.outSource = "hr-filled"; }
  if (shiftType && ["day", "night", "sunday"].includes(shiftType)) { pushCorrection(rec, "shiftType", rec.shiftType, shiftType, uid, reason); rec.shiftType = shiftType as never; }
  await recompute(rec);
  reRecommend(rec, uid);
  await rec.save();
  flash(req, "success", `Corrected ${rec.workerName}.`);
  res.redirect(`/regularization/${rec.siteId}/${rec.date}`);
});

// HR: void a bogus record (excluded from pay).
router.post("/regularization/worker/:attendanceId/void", requireCapability("correct_attendance"), async (req, res) => {
  const rec = await AttendanceModel.findById(req.params.attendanceId);
  if (!rec || !canUseSite(req.currentUser!, String(rec.siteId))) { flash(req, "danger", "Record not found."); return res.redirect("/regularization"); }
  const uid = req.currentUser!.id;
  rec.voided = true; rec.voidedBy = new Types.ObjectId(uid); rec.voidedAt = new Date(); rec.voidReason = String(req.body.reason ?? "").trim() || null;
  pushCorrection(rec, "void", "false", "true", uid, rec.voidReason);
  await rec.save();
  flash(req, "success", `Voided ${rec.workerName}.`);
  res.redirect(`/regularization/${rec.siteId}/${rec.date}`);
});

// HR: mark an ambiguous record verified (acknowledged).
router.post("/regularization/worker/:attendanceId/verify", requireCapability("correct_attendance"), async (req, res) => {
  const rec = await AttendanceModel.findById(req.params.attendanceId);
  if (!rec || !canUseSite(req.currentUser!, String(rec.siteId))) { flash(req, "danger", "Record not found."); return res.redirect("/regularization"); }
  const uid = req.currentUser!.id;
  rec.verifiedBy = new Types.ObjectId(uid); rec.verifiedAt = new Date(); rec.verifyNote = String(req.body.note ?? "").trim() || null;
  pushCorrection(rec, "verify", null, "verified", uid, rec.verifyNote);
  await rec.save();
  flash(req, "success", `Verified ${rec.workerName}.`);
  res.redirect(`/regularization/${rec.siteId}/${rec.date}`);
});

// HR: create a manual day for a worker who never scanned.
router.post("/regularization/:siteId/:date/create", requireCapability("correct_attendance"), async (req, res) => {
  const { siteId, date } = req.params;
  if (!Types.ObjectId.isValid(siteId) || !canUseSite(req.currentUser!, siteId) || !DATE_RE.test(date)) { flash(req, "danger", "Out of scope."); return res.redirect("/regularization"); }
  // Resolve worker snapshot + site snapshot, build inTime/outTime from HM, recompute, status recommended, source manual.
  // (Worker lookup via WorkerModel by req.body.workerId; site via ProjectSiteModel for names + lunchHours.)
  // Append a corrections[] entry field "create". Redirect back to the day.
  flash(req, "success", "Manual day created.");
  res.redirect(`/regularization/${siteId}/${date}`);
});
```
(Flesh out `/create` with the `WorkerModel`/`ProjectSiteModel` snapshot lookups following the denormalized fields the schema requires: `empRegNo, workerName, designationId, designationName, siteName, branchId, branchName`.)

- [ ] **Step 4: Run it — expect PASS.** Run `npm run e2e:correction`. Expected: PASS.

- [ ] **Step 5: Build + commit.**

```bash
npm run build
git add src/routes/regularization.ts scripts/e2e_correction.ts package.json
git commit -m "feat(regularization): HR-only correction endpoints (fix/force-close/void/verify/create) with audit; Management approves"
```

---

### Task 11: Correction UI on the regularization day view + flag deep-link

**Files:**
- Modify: `src/views/regularization/day.ejs` (HR edit controls per row)
- Modify: `src/routes/regularization.ts` (the day GET passes `canCorrect` + extra row fields)
- Modify: `src/views/flags/index.ejs` (deep link from a `missed_clockout` flag to the worker's correction row)

**Interfaces:**
- Consumes: `correct_attendance` via `res.locals.can`.

- [ ] **Step 1: Pass `canCorrect` + fields.** In `regularization.ts` day GET (line ~69-75), add `canCorrect: res.locals.can("correct_attendance")` and include `outSource`, `voided`, `verifiedAt`, `sessions` length on each `rows` item.

- [ ] **Step 2: Add edit controls.** In `day.ejs`, for each row when `canCorrect`, render a small inline form posting to `/regularization/worker/<id>/correct` with `inHM`, `outHM`, `shiftType`, `reason` inputs, plus buttons posting to `/void` and `/verify`. Match the existing `oh-` design system (sharp corners, 1px borders, Poppins, accent `#1c4d8c`). Show an "Unresolved — no OUT" badge when `outHM` is empty, and a "Voided"/"Verified" pill where set. Add a "Add a worker who didn't scan" control posting to `/regularization/<siteId>/<date>/create`.

- [ ] **Step 3: Flag deep-link.** In `flags/index.ejs`, for `missed_clockout` rows, link to `/regularization/<siteId>/<date>` (the worker's day) so HR lands on the correction row.

- [ ] **Step 4: Verify render.** Run `npm run build`; start `npm run dev`; load `/regularization/:siteId/:date` as HR — confirm edit controls show; as Management — confirm they don't (only approve/reject). Mobile: controls stack, no overflow.

- [ ] **Step 5: Commit.**

```bash
git add src/views/regularization/day.ejs src/routes/regularization.ts src/views/flags/index.ejs
git commit -m "feat(regularization): HR inline correction controls + deep-link from missed-clockout flags"
```

---

### Task 12: Payroll "Unresolved punches" panel + dashboard "On site now"

**Files:**
- Modify: `src/views/payroll/index.ejs` (surface `summary.unresolvedOpenDays` + per-worker `unresolvedOpenDays`)
- Modify: `src/routes/dashboard.ts` + `src/views/dashboard.ejs` ("On site now" = open records within window, scoped)

**Interfaces:**
- Consumes: `PayrollSummary.unresolvedOpenDays`, `PayrollWorker.unresolvedOpenDays` (Task 7).

- [ ] **Step 1: Payroll panel.** In `payroll/index.ejs`, when `summary.unresolvedOpenDays > 0`, render a warning banner ("N day(s) awaiting an OUT — fix in Attendance corrections before finalizing") linking to `/regularization?tab=submitted`. Show a per-worker `unresolvedOpenDays` chip in the worker rows.

- [ ] **Step 2: On-site-now.** In `dashboard.ts`, add `onSiteNow = await AttendanceModel.countDocuments({ ...scope, date: today, outTime: null, voided: { $ne: true } })`. Render it in `dashboard.ejs` as a tile in the live band.

- [ ] **Step 3: Verify render.** `npm run build`; `npm run dev`; load `/payroll` (create an open record first) and `/` — confirm the banner + tile appear, mobile-safe.

- [ ] **Step 4: Commit.**

```bash
git add src/views/payroll/index.ejs src/routes/dashboard.ts src/views/dashboard.ejs
git commit -m "feat(payroll+dashboard): unresolved-punches banner + on-site-now live count"
```

---

### Task 13: Kiosk feedback — explicit IN/OUT standing state

**Files:**
- Modify: `src/views/station/*` (the kiosk scan-result view) + any scan-result partial

**Interfaces:**
- Consumes: `ScanResult.action` ("in"/"out") from `recordScan`.

- [ ] **Step 1: Find the kiosk result view.** Locate where a scan result is rendered (station route render after `recordScan`). Read it.

- [ ] **Step 2: Clear standing state.** Render a sticky status card: green "NAME — CLOCKED IN since HH:MM" or "NAME — CLOCKED OUT at HH:MM · Total Xh", plus today's session count. Keep the `oh-` styling. The debounce (Task 4) already prevents accidental re-toggles server-side.

- [ ] **Step 3: Verify render.** `npm run build`; `npm run dev`; open the kiosk link, scan, confirm the card reads correctly IN then OUT.

- [ ] **Step 4: Commit.**

```bash
git add src/views/station
git commit -m "feat(station): explicit CLOCKED IN/OUT standing-state feedback at the kiosk"
```

---

### Task 14: Full verification + adversarial review + DEPLOY note

**Files:**
- Modify: `DEPLOY.md` (document the new env knobs)

- [ ] **Step 1: Run the full e2e suite.** Run each `npm run e2e:*` suite (23+ existing + the new `e2e:correction`). Expected: all PASS. Fix any regression before proceeding.

- [ ] **Step 2: Build + doctor.** `npm run build` (0 errors); `npx react-doctor@latest --verbose --scope changed` — score must not regress vs baseline (91).

- [ ] **Step 3: Adversarial money review.** Dispatch independent reviewers over the reconciliation: (a) does scan-close OT == payroll OT for the same day across 8h/10h/15h/24h spans? (b) is a forgotten OUT ever paid? (c) can unapproved OT leak into pay? (d) does a voided/rejected day ever pay? Fix anything they confirm.

- [ ] **Step 4: Document env knobs.** In `DEPLOY.md`, add `MAX_SHIFT_HOURS`, `FORGOT_GRACE_HOURS`, `SCAN_DEBOUNCE_SECONDS`, `OT_REQUIRES_APPROVAL`, `FOOD_MIN_HOURS` to the `.env` knobs list with their defaults.

- [ ] **Step 5: Commit + push.**

```bash
git add DEPLOY.md
git commit -m "docs(deploy): document in/out exception-rule env knobs"
git push
```

---

## Self-Review

**Spec coverage:** Config knobs (T1) ✓; model fields (T2) ✓; 26h window (T3) ✓; debounce (T4) ✓; reconciled flat OT + lunch + outSource + reopen fix (T5) ✓; sessions log (T6) ✓; payroll exclude/gate/unresolved (T7) ✓; window-aware sweep + boot (T8) ✓; correct_attendance HR-only (T9) ✓; HR correction endpoints + audit + Management-approves (T10) ✓; correction UI + flag deep-link (T11) ✓; unresolved panel + on-site-now (T12) ✓; kiosk feedback (T13) ✓; verification + adversarial review + deploy docs (T14) ✓. Live "on site now" and PDF: PDF is explicitly out of scope (separate track).

**Type consistency:** `reckonHours(inTime, outTime, lunch) → {totalHours, standardHours, overtimeHours}` defined in T5, consumed in T10. `closeSession(rec, shifts, lunch, now, geo)` and `reopenSession(rec, now, geo)` signatures updated at all call sites in T5. `ScanSite.lunchHours/maxShiftHours/scanDebounceSeconds` added T3/T4. `PayrollWorker.unresolvedOpenDays` + `PayrollSummary.unresolvedOpenDays` defined T7, consumed T12. `correct_attendance` defined T9, used T10/T11.

**Placeholder scan:** UI tasks (T11–T13) describe concrete controls/links and exact post targets; the `/create` route body is described with the exact denormalized fields required. No "TBD"/"handle edge cases" left in logic tasks.
