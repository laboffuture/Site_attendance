# Explicit IN/OUT Scanning Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the auto-toggle scan with an explicit `action: "in"|"out"`, so a forgotten-clockout from yesterday never closes on today's IN; add supervisor close-out and a forgot-to-submit flag — breaking nothing downstream.

**Architecture:** `recordScan` gains an explicit `action` and returns an `outcome` (`in|out|already_in|not_clocked_in`). Both scan routes forward `action` and map `outcome`→JSON status. Kiosk + Log-Attendance get explicit IN/OUT UI. The supervisor can fill a forgotten OUT at submit (shared reckoner, audited). A new `forgot_submit` sweep + flag catches un-submitted days. Payroll/reports/dashboard read the stored record and are unaffected.

**Tech Stack:** Express + TypeScript + Mongoose + EJS. Tests are self-contained `npm run e2e:<suite>` scripts that `assert`/`process.exit`.

## Global Constraints

- `recordScan(worker, site, branchName, action, geo?)` — `action: "in"|"out"`. Both call sites (`station.ts`, `attendance.ts`) update together.
- **IN** consults **today's record only** (`siteLocalDate(now)`); a prior-day open record is NOT touched. **OUT** uses the open-session lookup (`inTime ≥ now − maxShiftHours`) and still closes a real 24h shift.
- `ScanResult.outcome: "in"|"out"|"already_in"|"not_clocked_in"`; the route emits `status: outcome`. No-op outcomes carry no new times (don't dereference `outTime!`).
- Debounce is **same-action**; an immediate **opposite** tap is honored.
- Validate `action` **after** face-match + location-lock (so `wrong_site/unknown/no_face` still short-circuit).
- Supervisor OUT-fill is gated by `submit_attendance`, scoped to `outTime==null` + status `scanned`; lands at `submitted`. `correct_attendance` stays HR-only. New `outSource:"supervisor-filled"`.
- `forgot_submit` sweep uses `date: { $lt: siteLocalDate() }` (never today); flag scoped via `attemptedSiteId`; own partial-unique index.
- No change to first-In/last-Out/`sessions[]`; no pay-logic change. `npm run build` 0 errors after each task.

---

### Task 1: Engine — explicit action + outcome

**Files:**
- Modify: `src/lib/attendance.ts` (`recordScan`, `ScanResult`, `inState`/`outState`)
- Test: `scripts/e2e_shift.ts`

**Interfaces:**
- Produces: `recordScan(worker: ScanWorker, site: ScanSite, branchName: string, action: "in"|"out", geo?: GeoCapture): Promise<ScanResult>`; `ScanResult.outcome: "in"|"out"|"already_in"|"not_clocked_in"`.

- [ ] **Step 1: Rewrite `scripts/e2e_shift.ts` for explicit actions.** Every `recordScan(...)` call gains an action arg. Replace the toggle assertions with explicit ones. Key cases (adapt the existing fixtures):
```ts
// fresh worker, brand-new day
const r1 = await recordScan(worker, siteArg as never, branch.name, "in");
assert("explicit IN → outcome in", r1.outcome === "in");
// IN again same day while open → already_in (no dup)
const rDup = await recordScan(worker, siteArg as never, branch.name, "in");
assert("IN while already in → already_in", rDup.outcome === "already_in");
assert("no duplicate open record", (await AttendanceModel.countDocuments({ workerId: worker._id, date: r1.date })) === 1);
// backdate the IN 11h, then explicit OUT closes it
await AttendanceModel.updateOne({ workerId: worker._id, outTime: null }, { $set: { inTime: new Date(Date.now() - 11 * 3_600_000), shiftType: "night" } });
const r2 = await recordScan(worker, siteArg as never, branch.name, "out");
assert("explicit OUT → outcome out, ~11h, OT ~2h pending", r2.outcome === "out" && Math.abs((r2.totalHours ?? 0) - 11) < 0.05 && Math.abs(r2.overtimeHours - 2) < 0.05);
// OUT again when not clocked in (just closed, beyond debounce) → not_clocked_in
await AttendanceModel.updateOne({ workerId: worker._id }, { $set: { outTime: new Date(Date.now() - 120_000) } });
const r3 = await recordScan(worker, siteArg as never, branch.name, "out");
assert("OUT when not clocked in → not_clocked_in", r3.outcome === "not_clocked_in");
// come back: explicit IN re-opens (first-In stays)
const r4 = await recordScan(worker, siteArg as never, branch.name, "in");
assert("IN after close → reopen (outcome in)", r4.outcome === "in");
// THE TEJA FIX: a worker with a stale PRIOR-DAY open record; IN today → new IN, prior untouched
const teja = { _id: new Types.ObjectId(), empRegNo: `QA-TEJA-${S}`, name: `QA Teja ${S}`, designationId: new Types.ObjectId(), designationName: "Carpenter" };
const yest = await AttendanceModel.create({ date: "2000-01-02", workerId: teja._id, empRegNo: teja.empRegNo, workerName: teja.name, designationId: teja.designationId, designationName: "Carpenter", siteId: site._id, siteName: site.name, branchId: branch._id, branchName: branch.name, inTime: new Date(Date.now() - 24 * 3_600_000), outTime: null, source: "scan" });
const rTeja = await recordScan(teja, siteArg as never, branch.name, "in");
assert("Teja IN today → new IN (outcome in)", rTeja.outcome === "in" && rTeja.date === new Date().toISOString().slice(0,10) || rTeja.outcome === "in");
const yestAfter = await AttendanceModel.findById(yest._id).lean();
assert("Teja's prior-day open record is UNTOUCHED (still open)", yestAfter!.outTime == null);
assert("Teja has a NEW record for today", (await AttendanceModel.countDocuments({ workerId: teja._id })) === 2);
```
Add `teja._id` to the cleanup `deleteMany`.

- [ ] **Step 2: Run — expect FAIL/compile-error.** `npm run e2e:shift` → fails (recordScan has no `action` param / `outcome` missing).

- [ ] **Step 3: Implement.** In `src/lib/attendance.ts`:

Change `ScanResult` (the `action` field becomes `outcome` with 4 values):
```ts
export interface ScanResult {
  outcome: "in" | "out" | "already_in" | "not_clocked_in";
  date: string;
  inTime: Date | null;
  outTime: Date | null;
  totalHours: number | null;
  standardHours: number | null;
  overtimeHours: number;
  overtimeStatus: string;
  shiftType?: ShiftType;
}
```
Update `inState`/`outState` to set `outcome` (rename from `action`) and add no-op builders:
```ts
function inState(rec: HydratedDocument<Attendance>, outcome: "in" | "already_in" = "in"): ScanResult {
  return { outcome, date: rec.date, inTime: rec.inTime, outTime: null, totalHours: null, standardHours: null, overtimeHours: 0, overtimeStatus: "none", shiftType: (rec.shiftType as ShiftType) ?? "day" };
}
function outState(rec: HydratedDocument<Attendance>): ScanResult {
  return { outcome: "out", date: rec.date, inTime: rec.inTime, outTime: rec.outTime ?? null, totalHours: rec.totalHours ?? null, standardHours: rec.standardHours ?? null, overtimeHours: rec.overtime?.computedHours ?? 0, overtimeStatus: rec.overtime?.status ?? "none", shiftType: (rec.shiftType as ShiftType) ?? "day" };
}
function notClockedIn(date: string): ScanResult {
  return { outcome: "not_clocked_in", date, inTime: null, outTime: null, totalHours: null, standardHours: null, overtimeHours: 0, overtimeStatus: "none" };
}
```
Rewrite `recordScan` signature + body:
```ts
export async function recordScan(
  worker: ScanWorker,
  site: ScanSite,
  branchName: string,
  action: "in" | "out",
  geo?: GeoCapture,
): Promise<ScanResult> {
  const now = new Date();
  const shifts = site.shifts ?? DEFAULT_SHIFTS;
  const lunch = site.lunchHours ?? 1;
  const maxMs = (site.maxShiftHours ?? config.maxShiftHours) * 3_600_000;
  const debounceMs = (site.scanDebounceSeconds ?? config.scanDebounceSeconds) * 1000;
  const date = siteLocalDate(now);

  if (action === "out") {
    // Close the open session (today, or a long shift across midnight within maxShiftHours).
    const open = await AttendanceModel.findOne({ workerId: worker._id, outTime: null, inTime: { $gte: new Date(now.getTime() - maxMs) } }).sort({ inTime: -1 });
    if (open) return closeSession(open, lunch, now, geo);
    // Accidental OUT double-tap: today's record just closed within the debounce → re-show, no change.
    const today = await AttendanceModel.findOne({ workerId: worker._id, date });
    if (today && today.outTime && now.getTime() - new Date(today.outTime).getTime() < debounceMs) return outState(today);
    return notClockedIn(date);
  }

  // action === "in": TODAY's record only — a prior-day open record is never touched.
  const today = await AttendanceModel.findOne({ workerId: worker._id, date });
  if (today) {
    if (today.outTime == null) return inState(today, "already_in"); // already clocked in
    return reopenSession(today, now, geo); // came back → re-open (first-In stays)
  }
  // Brand-new day → first IN (even if a prior-day record is still open).
  const shiftType = selectShift(shifts, now);
  try {
    await AttendanceModel.create({
      date, workerId: worker._id, empRegNo: worker.empRegNo, workerName: worker.name,
      designationId: worker.designationId, designationName: worker.designationName,
      siteId: site._id, siteName: site.name, branchId: site.branchId, branchName,
      inTime: now, shiftType, inGeo: geo ?? undefined, source: "scan",
      sessions: [{ inTime: now, outTime: null, inGeo: geo ?? null, outGeo: null, source: "scan" }],
    });
    return { outcome: "in", date, inTime: now, outTime: null, totalHours: null, standardHours: null, overtimeHours: 0, overtimeStatus: "none", shiftType };
  } catch (err) {
    if (!isDuplicateKeyError(err)) throw err;
    const same = await AttendanceModel.findOne({ workerId: worker._id, date });
    if (!same) throw err;
    return same.outTime == null ? inState(same, "already_in") : reopenSession(same, now, geo);
  }
}
```
`closeSession`/`reopenSession`/`reckonHours` are unchanged except `reopenSession`/`closeSession` already return via the state builders — ensure they return `outcome`-shaped results (update their final returns to use `outcome` instead of `action`). Remove the old `inState`-without-arg references.

- [ ] **Step 4: Run — expect PASS.** `npm run e2e:shift` → all PASS.

- [ ] **Step 5: Build + commit.**
```bash
npm run build
git add src/lib/attendance.ts scripts/e2e_shift.ts
git commit -m "feat(attendance): explicit IN/OUT engine — action param + outcome (fixes prior-day clash)"
```

---

### Task 2: Both scan routes — action plumbing + outcome→status

**Files:**
- Modify: `src/routes/station.ts:147-169`, `src/routes/attendance.ts` (the `/attendance/scan` POST that calls `recordScan`)
- Test: `scripts/e2e_station.ts`, `scripts/e2e_geo.ts`, `scripts/e2e_logscan.ts`, `scripts/demo_enroll_scan.ts`

**Interfaces:**
- Consumes: `recordScan(...action, geo?)`, `ScanResult.outcome`.

- [ ] **Step 1: Update the e2e scan helpers to send `action`.** In `e2e_station.ts`/`e2e_geo.ts`/`e2e_logscan.ts`, the POST helpers must include `action`. First scan → `action:"in"`; the backdated second scan → `action:"out"`. Add assertions: `r.body.status` is `"in"`/`"out"` accordingly; add an OUT-when-not-in case → `status:"not_clocked_in"`.

- [ ] **Step 2: Run — expect FAIL.** Suites fail (route ignores/needs action).

- [ ] **Step 3: Implement.** In `src/routes/station.ts`, just before the `recordScan` call (after the location-lock block, line ~146):
```ts
  const action = String(req.body.action);
  if (action !== "in" && action !== "out") return res.json({ status: "error", message: "Pick Clock In or Clock Out." });
```
Change the `recordScan` call to pass `action` then `geo`: `recordScan({...worker}, site, branch?.name ?? "", action as "in" | "out", geo)`. Replace the response with outcome-aware mapping:
```ts
  const punched = result.outcome === "in" || result.outcome === "out";
  res.json({
    status: result.outcome, // in | out | already_in | not_clocked_in
    workerName: worker.name,
    empRegNo: worker.empRegNo,
    time: result.outcome === "in" ? istTime(result.inTime) : result.outcome === "out" ? istTime(result.outTime) : null,
    totalHours: punched ? result.totalHours : null,
    overtimeHours: round2(result.overtimeHours),
    overtimeStatus: result.overtimeStatus,
    geo: { available: geo.available, distanceMeters: geo.distanceMeters },
  });
```
(`istTime` already tolerates null → "".) Apply the **same** change to the `/attendance/scan` POST in `src/routes/attendance.ts` (validate action after its match/geofence checks, pass into `recordScan`, map `outcome`).

- [ ] **Step 4: Update `scripts/demo_enroll_scan.ts`** to send `action:"in"` on its single scan.

- [ ] **Step 5: Run — expect PASS.** `npm run e2e:station`, `e2e:geo`, `e2e:logscan` → PASS.

- [ ] **Step 6: Build + commit.**
```bash
npm run build
git add src/routes/station.ts src/routes/attendance.ts scripts/e2e_station.ts scripts/e2e_geo.ts scripts/e2e_logscan.ts scripts/demo_enroll_scan.ts
git commit -m "feat(attendance): scan routes forward explicit action + map already_in/not_clocked_in outcomes"
```

---

### Task 3: Kiosk UI — two buttons (parallel agent)

**Files:** `src/views/station/capture.ejs`, `public/js/station.js`, `public/css/theme.css`

- [ ] **Step 1:** In `capture.ejs`, replace the auto-toggle + single Scan control with two big buttons **CLOCK IN** (green) / **CLOCK OUT** (blue) the JS binds (ids `mp-in`/`mp-out`); idle copy prompts "Pick Clock In or Clock Out, then face the camera."
- [ ] **Step 2:** In `station.js`: a selected-action state machine — tapping a button sets `action` and starts the per-action scan (manual + auto-scan loop both use the selected `action`); `doScan` appends `&action=<action>` to the POST body; `render()` adds `already_in` (info: "Already clocked in since HH:MM") and `not_clocked_in` (warn: "Not clocked in — tap Clock In") cases; after a result, return to the idle two-button state. The auto-scan loop must NOT fire before an action is chosen.
- [ ] **Step 3:** In `theme.css`, add large glanceable styling for the two action buttons (reuse `--in`/`--out` colors).
- [ ] **Step 4:** Build + verify the kiosk renders (`npm run build`, load `/station/...`). Commit.

---

### Task 4: Log-Attendance UI — IN/OUT selector (parallel agent)

**Files:** `src/views/attendance/scan.ejs`, `public/js/attendance-scan.js`

- [ ] **Step 1:** In `scan.ejs`, add an IN/OUT selector (segmented toggle or two buttons) the supervisor sets before marking; the selected action drives manual + auto-scan.
- [ ] **Step 2:** In `attendance-scan.js`, send `action` in the POST body; add `already_in`/`not_clocked_in` render cases; gate auto-scan on a chosen action.
- [ ] **Step 3:** Build + verify render. Commit.

---

### Task 5: Shared reckoner + supervisor OUT-fill at submit

**Files:**
- Modify: `src/models/Attendance.ts` (`outSource` enum), `src/routes/regularization.ts` (export the recompute helper or move to a lib), `src/routes/attendance.ts` (the `/attendance/submit` POST handler), `src/views/attendance/submit.ejs`
- Test: `scripts/e2e_regularization.ts` (or a new `e2e_supervisor_fill`)

**Interfaces:**
- Consumes: `reckonHours` (from `lib/attendance`), `istDateTime` (`lib/time`).
- Produces: supervisor can set `outHM_<workerId>` on open `scanned` rows at submit.

- [ ] **Step 1:** Add `"supervisor-filled"` to the `outSource` enum in `src/models/Attendance.ts`.
- [ ] **Step 2:** Factor the OUT-fill recompute into a shared helper so submit + HR `/correct` agree. Add to `src/lib/attendance.ts`:
```ts
/** Fill a forgotten OUT on an open record: set outTime, recompute via reckonHours,
 *  close the trailing open session, stamp outSource. Shared by supervisor-submit + HR-correct. */
export function fillOut(rec: { inTime: Date; outTime: Date | null; totalHours: number | null; standardHours: number | null; breakHours?: number | null; overtime: { computedHours: number; status: string; approvedHours: number | null; recommendedBy: unknown; recommendedAt: unknown; approvedBy: unknown; approvedAt: unknown; notes: unknown }; sessions?: { outTime: Date | null; outGeo?: unknown }[]; outSource?: string | null }, outTime: Date, lunch: number, outSource: "supervisor-filled" | "hr-filled"): void {
  const h = reckonHours(rec.inTime, outTime, lunch);
  rec.outTime = outTime; rec.totalHours = h.totalHours; rec.standardHours = h.standardHours; rec.breakHours = lunch; rec.outSource = outSource;
  rec.overtime.computedHours = h.overtimeHours; rec.overtime.status = h.overtimeHours > 0 ? "pending" : "none";
  const last = rec.sessions?.[rec.sessions.length - 1];
  if (last && last.outTime == null) last.outTime = outTime;
}
```
Refactor `regularization.ts`'s `recompute()` to call `fillOut(rec, rec.outTime, lunch, "hr-filled")` (behavior unchanged) so there's one reckoner.
- [ ] **Step 3:** In `src/views/attendance/submit.ejs`, for rows with no OUT (`outTime==null`), render `<input type="time" name="outHM_<%= workerId %>">`; keep present In/Out read-only; update the subtitle to "fill a missing clock-out, then submit."
- [ ] **Step 4:** In the `/attendance/submit` POST handler (`src/routes/attendance.ts`), before flipping `scanned → submitted`, for each row with `outTime==null` and a valid `outHM_<id>` (regex `^([01]\d|2[0-3]):[0-5]\d$`): load the site lunch, `fillOut(rec, istDateTime(rec.date, outHM), lunch, "supervisor-filled")`, append a `corrections[]` audit entry, then submit. Gate by `submit_attendance` (existing). Do **not** jump to `recommended`.
- [ ] **Step 5:** Add an e2e: a `scanned` open record + supervisor submits with `outHM` → record gets OUT, `outSource:"supervisor-filled"`, hours recomputed, status `submitted`. Build + run.
- [ ] **Step 6: Commit.**
```bash
git add src/models/Attendance.ts src/lib/attendance.ts src/routes/regularization.ts src/routes/attendance.ts src/views/attendance/submit.ejs scripts/e2e_*.ts
git commit -m "feat(attendance): supervisor fills a forgotten OUT at submit (shared reckoner, audited, supervisor-filled)"
```

---

### Task 6: forgot_submit flag + sweep

**Files:**
- Modify: `src/models/FlagEvent.ts`, `src/lib/scheduler.ts`, `scripts/sweep.ts`, `src/views/flags/index.ejs`, `src/views/dashboard-site.ejs`
- Create: `src/lib/forgotSubmit.ts`
- Test: `scripts/e2e_missed_clockout.ts` (extend) or new `e2e_forgot_submit`

- [ ] **Step 1:** In `src/models/FlagEvent.ts`, add `"forgot_submit"` to `FLAG_TYPES` and a partial-unique index:
```ts
flagEventSchema.index({ type: 1, attemptedSiteId: 1, date: 1 }, { unique: true, partialFilterExpression: { type: "forgot_submit" } });
```
- [ ] **Step 2:** Create `src/lib/forgotSubmit.ts` — `sweepUnsubmittedDays(asOf = siteLocalDate())`: find distinct `(siteId, siteName, date)` over `AttendanceModel.find({ attendanceStatus: "scanned", voided: { $ne: true }, date: { $lt: asOf } })`; for each, `FlagEventModel.create({ type: "forgot_submit", attemptedSiteId: siteId, attemptedSiteName: siteName, homeSiteId: siteId, homeSiteName: siteName, date })` guarded by `isDuplicateKeyError` (idempotent). Return `{ scanned, flagged, skipped }`. Mirror `missedClockout.ts`.
- [ ] **Step 3:** In `scheduler.ts` (timer + boot) and `scripts/sweep.ts`, call `sweepUnsubmittedDays()` alongside `sweepMissedClockouts()`, each in its own try/catch.
- [ ] **Step 4:** In `views/flags/index.ejs` (and the `dashboard-site.ejs` inline label), add a `forgot_submit` → "Forgot to submit" label + a "Submit day →" link to `/attendance/submit?siteId=<homeSiteId>&date=<date>`.
- [ ] **Step 5:** Add an e2e: a prior-day `scanned` open/closed site-day → `sweepUnsubmittedDays` raises exactly one `forgot_submit` flag; a today record is NOT flagged; re-running doesn't duplicate. Build + run.
- [ ] **Step 6: Commit.**
```bash
git add src/models/FlagEvent.ts src/lib/forgotSubmit.ts src/lib/scheduler.ts scripts/sweep.ts src/views/flags/index.ejs src/views/dashboard-site.ejs scripts/e2e_*.ts
git commit -m "feat(flags): forgot_submit sweep — flag a site-day scanned but never submitted (prior days only)"
```

---

### Task 7: Full verification + adversarial review + push

- [ ] **Step 1:** Run EVERY `npm run e2e:*` suite. All PASS. Pay attention to the unaffected set (`e2e_attendance`, `e2e_facecapture`, `e2e_missed_clockout`, `e2e_correction`, payroll/reports/dashboard) — they must stay green (proves no downstream breakage).
- [ ] **Step 2:** `npm run build` (0 errors); `npx react-doctor@latest --score --scope changed` — no regression.
- [ ] **Step 3:** Mobile/kiosk spot-check (headless screenshots): the kiosk two-button screen, the log-attendance selector, the submit OUT-fill input — at the ≤768 layout.
- [ ] **Step 4:** Adversarial review (parallel agents): (a) can `action:"in"` ever close a prior-day open? (b) can a no-op outcome produce a wrong/blank card or throw? (c) does the supervisor fill ever skip the approval chain or use wrong OT? (d) can `forgot_submit` duplicate or flag today? Fix anything confirmed.
- [ ] **Step 5: Push.**
```bash
git push
git push origin feature/face-onboarding:main
```

---

## Self-Review

**Spec coverage:** engine explicit action + outcome (T1) ✓; both routes (T2) ✓; kiosk UI (T3) ✓; log-attendance UI (T4) ✓; supervisor OUT-fill + shared reckoner + outSource enum (T5) ✓; forgot_submit flag+sweep (T6) ✓; verification + downstream-green + review + push (T7) ✓. Teja fix asserted in T1; downstream-unaffected verified in T7 step 1.

**Type consistency:** `recordScan(...,"in"|"out", geo?)` and `ScanResult.outcome` defined T1, consumed T2. `fillOut(rec, outTime, lunch, outSource)` defined T5, used in submit + regularization. `forgot_submit` flag type T6 used in sweep + views. `outSource:"supervisor-filled"` T5 used by `fillOut`.

**Placeholder scan:** engine/route/helper/sweep code is complete; UI tasks (T3/T4 + T5 view + T6 views) are agent tasks with concrete element ids, post fields, and render cases. No "TBD".
