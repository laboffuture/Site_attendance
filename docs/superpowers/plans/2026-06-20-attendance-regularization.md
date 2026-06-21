# Daily Attendance Approval / Regularization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A daily attendance approval chain — Supervisor submits the day (+per-worker remarks) → PM recommends → HR/Management approves (final, and approves the day's OT in one step) — with no time edits.

**Architecture:** A per-record `attendanceStatus` lifecycle on `Attendance`; supervisor "Submit the day" batch-flips a `{siteId,date}` group; a `/regularization` queue drives PM-recommend / HR-approve / per-worker-reject. Approving a day also flips `overtime.status`, so `/overtime` becomes read-only.

**Tech Stack:** Node 22 · Express · TypeScript · Mongoose · EJS. Tests = repo e2e scripts vs a live local MongoDB (`npm run e2e:*`), printing `PASS:`/`FAIL:`, non-zero exit on failure.

## Global Constraints

- Node `>=20`; `npm run build` (tsc + copy-assets) passes after each task.
- Lifecycle (verbatim): `scanned → submitted → recommended → approved`, plus `rejected` (per-worker, terminal). Default `scanned`.
- **No time edits anywhere** — scanned In/Out are immutable; PM/HR only approve/reject.
- **Grain:** whole site-day batch, with per-worker reject.
- **OT subsumed:** on day-**approve**, every record with `overtime.computedHours > 0` gets `overtime.status = "approved"`; on per-worker **reject**, that record's `overtime.status = "rejected"`. `/overtime` keeps no approve/reject of its own.
- Capabilities (exact): `submit_attendance: [supervisor, pm, hr, management, super_admin]`, `view_regularization: [pm, hr, management, super_admin]`, `recommend_attendance: [pm, management, super_admin]`, `approve_attendance: [hr, management, super_admin]`.
- Reuse existing patterns: `requireCapability`, `flash(req,type,text)`, `siteScopeFilter(user)`, `canUseSite(user,siteId)`, `req.currentUser!` (`.id/.name/.role`), `res.locals.can(cap)` in views.
- Branch: `feature/attendance-regularization`. Spec: `docs/superpowers/specs/2026-06-20-attendance-regularization-design.md`.

---

### Task 1: Lifecycle fields + capabilities + Supervisor "Submit the day"

**Files:**
- Modify: `src/models/Attendance.ts`
- Modify: `src/auth/permissions.ts`
- Modify: `src/routes/attendance.ts`
- Create: `src/views/attendance/submit.ejs`
- Modify: `src/views/attendance/index.ejs` (add a "Submit day" link)
- Modify: `src/nav.ts`
- Test: `scripts/e2e_regularization.ts`
- Modify: `package.json` (add `e2e:regularization`)

**Interfaces:**
- Produces: `Attendance.attendanceStatus` (`scanned|submitted|recommended|approved|rejected`), `.dailyRemark`, `.submittedBy/At`, `.recommendedBy/At`, `.decidedBy/At`, `.rejectReason`. Capabilities `submit_attendance`, `view_regularization`, `recommend_attendance`, `approve_attendance`. Routes `GET/POST /attendance/submit`.

- [ ] **Step 1: Write the failing test** — create `scripts/e2e_regularization.ts`:

```ts
/* E2E for the daily attendance regularization chain: supervisor submits the
   day (+remarks) → PM recommends → HR approves (OT approved too); per-worker
   reject excludes one. Self-contained; cleans up. Run: npm run e2e:regularization */
import request from "supertest";
import mongoose, { Types } from "mongoose";

import { createApp } from "../src/app";
import { connectDb } from "../src/db";
import * as db from "../src/db";
import { hashPassword } from "../src/auth/password";
import { siteLocalDate } from "../src/lib/time";
import { BranchModel, ProjectSiteModel, WorkerModel, UserModel, AttendanceModel } from "../src/models";

const S = Date.now().toString(36);
const PW = "Pass123!";
const today = siteLocalDate();

function assert(label: string, cond: boolean): void {
  console.log(`${cond ? "PASS" : "FAIL"}: ${label}`);
  if (!cond) process.exitCode = 1;
}
async function login(app: ReturnType<typeof createApp>, email: string) {
  const a = request.agent(app);
  const r = await a.post("/login").type("form").send({ email, password: PW });
  if (r.status !== 302) throw new Error(`login failed ${email}`);
  return a;
}

async function main(): Promise<void> {
  await connectDb();
  if (!db.dbReady) { console.error("DB not reachable."); process.exit(1); }
  const app = createApp();

  const branch = await BranchModel.create({ name: `QA REG ${S}` });
  const site = await ProjectSiteModel.create({ branchId: branch._id, name: `QA Reg Site ${S}`, code: `QAREG${S}`.toUpperCase(), standardStartTime: "09:00", standardEndTime: "18:00" });
  const desig = new Types.ObjectId();
  async function worker(reg: string, otH: number) {
    const w = await WorkerModel.create({ empRegNo: reg, name: `W ${reg}`, designationId: desig, designationName: "Carpenter", siteId: site._id, siteName: site.name, faceEncoding: [], status: "active" });
    await AttendanceModel.create({
      date: today, workerId: w._id, empRegNo: reg, workerName: w.name, designationId: desig, designationName: "Carpenter",
      siteId: site._id, siteName: site.name, branchId: branch._id, branchName: branch.name,
      inTime: new Date(Date.now() - 9 * 3_600_000), outTime: new Date(), totalHours: 9, standardHours: 8,
      overtime: { computedHours: otH, status: otH > 0 ? "pending" : "none" }, source: "scan",
    });
    return w;
  }
  const wa = await worker(`QA-RG-A-${S}`, 2); // has OT
  const wb = await worker(`QA-RG-B-${S}`, 0); // no OT

  const sup = `qa-rgsup-${S}@trgbi.com`, pm = `qa-rgpm-${S}@trgbi.com`, hr = `qa-rghr-${S}@trgbi.com`;
  await UserModel.create({ name: "RG Sup", email: sup, passwordHash: await hashPassword(PW), role: "supervisor", assignedSiteIds: [site._id], active: true });
  await UserModel.create({ name: "RG PM", email: pm, passwordHash: await hashPassword(PW), role: "pm", assignedSiteIds: [site._id], active: true });
  await UserModel.create({ name: "RG HR", email: hr, passwordHash: await hashPassword(PW), role: "hr", assignedSiteIds: [], active: true });

  // --- Supervisor submits the day with remarks ---
  const sa = await login(app, sup);
  const form = await sa.get(`/attendance/submit?siteId=${site._id}&date=${today}`);
  assert("submit screen lists the workers", form.text.includes(`QA-RG-A-${S}`) && form.text.includes(`QA-RG-B-${S}`));
  const submit = await sa.post("/attendance/submit").type("form").send({ siteId: String(site._id), date: today, [`remark_${wa._id}`]: "Tiling done", [`remark_${wb._id}`]: "Helper" });
  assert("submit redirects", submit.status === 302);
  const recA = await AttendanceModel.findOne({ workerId: wa._id, date: today });
  assert("records flipped to submitted with remark + audit", recA?.attendanceStatus === "submitted" && recA?.dailyRemark === "Tiling done" && !!recA?.submittedBy);

  // Cleanup
  await Promise.all([
    AttendanceModel.deleteMany({ siteId: site._id }),
    WorkerModel.deleteMany({ siteId: site._id }),
    UserModel.deleteMany({ email: { $in: [sup, pm, hr] } }),
    ProjectSiteModel.deleteOne({ _id: site._id }),
    BranchModel.deleteOne({ _id: branch._id }),
  ]);
  await mongoose.connection.close();
  console.log(process.exitCode ? "\nE2E REGULARIZATION FAILED" : "\nE2E REGULARIZATION PASSED");
  process.exit(process.exitCode ?? 0);
}
main().catch((e) => { console.error("\nE2E REGULARIZATION ERROR:", e?.message ?? e); process.exit(1); });
```

Add to `package.json` after `"e2e:shift"`: `"e2e:regularization": "tsx scripts/e2e_regularization.ts",`

- [ ] **Step 2: Run test to verify it fails** — `npm run e2e:regularization` → FAIL (no `/attendance/submit` route; `attendanceStatus` undefined).

- [ ] **Step 3a: Add lifecycle fields to `src/models/Attendance.ts`** — insert after the `overtime` field line:

```ts
    // Daily approval / regularization lifecycle (governs the day's attendance).
    attendanceStatus: { type: String, enum: ["scanned", "submitted", "recommended", "approved", "rejected"], default: "scanned" },
    dailyRemark: { type: String, default: null }, // per-worker, set by the supervisor at submit
    submittedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    submittedAt: { type: Date, default: null },
    recommendedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    recommendedAt: { type: Date, default: null },
    decidedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    decidedAt: { type: Date, default: null },
    rejectReason: { type: String, default: null },
```

- [ ] **Step 3b: Add capabilities to `src/auth/permissions.ts`** — add to the `Capability` union (after `"decide_request"`):

```ts
  | "submit_attendance"
  | "view_regularization"
  | "recommend_attendance"
  | "approve_attendance"
```

And to `CAPABILITY_ROLES` (after the `decide_request` entry):

```ts
  submit_attendance: ["super_admin", "management", "hr", "pm", "supervisor"],
  view_regularization: ["super_admin", "management", "hr", "pm"],
  recommend_attendance: ["super_admin", "management", "pm"],
  approve_attendance: ["super_admin", "management", "hr"],
```

- [ ] **Step 3c: Add the submit routes to `src/routes/attendance.ts`** — insert before `export default router;` (reuses `allowedSites`, `siteLocalDate`, `istHM`, `DATE_RE`, `canUseSite`, `Types`, `flash`, `WorkerModel`, `AttendanceModel` already imported in the file):

```ts
// ---- Supervisor: submit the day for regularization ----
router.get("/attendance/submit", requireCapability("submit_attendance"), async (req: Request, res: Response) => {
  const user = req.currentUser!;
  const sites = await allowedSites(user);
  const site = sites.find((s) => String(s._id) === String(req.query.siteId)) ?? sites[0] ?? null;
  const date = DATE_RE.test(String(req.query.date ?? "")) ? String(req.query.date) : siteLocalDate();
  const records = site ? await AttendanceModel.find({ siteId: site._id, date }).sort({ workerName: 1 }).lean() : [];
  const rows = records.map((r) => ({
    id: String(r._id), workerName: r.workerName, empRegNo: r.empRegNo,
    inHM: istHM(r.inTime ?? null), outHM: istHM(r.outTime ?? null),
    totalHours: r.totalHours, otHours: r.overtime?.computedHours ?? 0,
    status: r.attendanceStatus, remark: r.dailyRemark ?? "",
    open: !r.outTime,
  }));
  const submitted = records.length > 0 && records.every((r) => r.attendanceStatus !== "scanned");
  res.render("attendance/submit", { title: "Submit attendance · " + res.locals.company, active: "/attendance", sites, site, date, rows, submitted });
});

router.post("/attendance/submit", requireCapability("submit_attendance"), async (req: Request, res: Response) => {
  const user = req.currentUser!;
  const siteId = String(req.body.siteId ?? "");
  const date = String(req.body.date ?? "");
  if (!Types.ObjectId.isValid(siteId) || !canUseSite(user, siteId) || !DATE_RE.test(date)) {
    flash(req, "danger", "Pick a site you're assigned to and a valid date.");
    return res.redirect("/attendance/submit");
  }
  const records = await AttendanceModel.find({ siteId, date, attendanceStatus: "scanned" });
  for (const rec of records) {
    rec.attendanceStatus = "submitted";
    rec.dailyRemark = String(req.body[`remark_${rec._id}`] ?? "").trim() || null;
    rec.submittedBy = new Types.ObjectId(user.id);
    rec.submittedAt = new Date();
    await rec.save();
  }
  flash(req, "success", `Submitted ${records.length} record(s) for ${date}.`);
  res.redirect(`/attendance/submit?siteId=${siteId}&date=${date}`);
});
```

- [ ] **Step 3d: Create `src/views/attendance/submit.ejs`**:

```html
<%- include('../partials/app-top', { title: title, active: active }) %>

<div class="oh-page-header">
  <h1 class="oh-page-title">Submit attendance</h1>
  <p class="oh-page-subtitle">Add a remark per worker and submit the day for PM → HR approval. Times are read-only (scan record).</p>
</div>

<% if (!sites.length) { %>
<div class="oh-card"><p class="oh-muted">No sites are assigned to you.</p></div>
<% } else { %>
<div class="oh-card oh-stack">
  <form class="oh-form-inline" method="get" action="/attendance/submit">
    <div class="oh-input-group">
      <label class="oh-label" for="siteId">Site</label>
      <select class="oh-select" id="siteId" name="siteId" onchange="this.form.submit()">
        <% sites.forEach(function (s) { %><option value="<%= s._id %>" <%= site && String(s._id) === String(site._id) ? "selected" : "" %>><%= s.name %> (<%= s.code %>)</option><% }); %>
      </select>
    </div>
    <div class="oh-input-group">
      <label class="oh-label" for="date">Date</label>
      <input class="oh-input" id="date" type="date" name="date" value="<%= date %>" onchange="this.form.submit()" />
    </div>
  </form>

  <% if (!rows.length) { %>
  <p class="oh-muted">No attendance scanned for this site/date.</p>
  <% } else if (submitted) { %>
  <p class="oh-muted">This day is already submitted — it's now in the regularization queue.</p>
  <table class="oh-table">
    <thead><tr><th>Worker</th><th>In</th><th>Out</th><th>OT</th><th>Status</th><th>Remark</th></tr></thead>
    <tbody><% rows.forEach(function (r) { %>
      <tr><td><%= r.workerName %><br/><span class="oh-muted"><%= r.empRegNo %></span></td><td><%= r.inHM || "—" %></td><td><%= r.outHM || "—" %></td><td><%= r.otHours > 0 ? r.otHours + "h" : "—" %></td><td><span class="oh-badge oh-badge--muted"><%= r.status %></span></td><td><%= r.remark || "—" %></td></tr>
    <% }); %></tbody>
  </table>
  <% } else { %>
  <form method="post" action="/attendance/submit">
    <input type="hidden" name="siteId" value="<%= site._id %>" />
    <input type="hidden" name="date" value="<%= date %>" />
    <table class="oh-table">
      <thead><tr><th>Worker</th><th>In</th><th>Out</th><th>OT</th><th>Remark (what they did today)</th></tr></thead>
      <tbody><% rows.forEach(function (r) { %>
        <tr>
          <td><%= r.workerName %><br/><span class="oh-muted"><%= r.empRegNo %></span><% if (r.open) { %> <span class="oh-badge oh-badge--warning">open</span><% } %></td>
          <td><%= r.inHM || "—" %></td><td><%= r.outHM || "—" %></td><td><%= r.otHours > 0 ? r.otHours + "h" : "—" %></td>
          <td><input class="oh-input" name="remark_<%= r.id %>" value="<%= r.remark %>" placeholder="optional" /></td>
        </tr>
      <% }); %></tbody>
    </table>
    <div class="oh-form-actions" style="margin-top:0.75rem">
      <button class="oh-btn oh-btn--secondary" type="submit" onclick="return confirm('Submit this day for approval? You can\'t edit after submitting.')">Submit day</button>
    </div>
  </form>
  <% } %>
</div>
<% } %>

<%- include('../partials/app-bottom') %>
```

- [ ] **Step 3e: Add a "Submit day" link on the Attendance page** — in `src/views/attendance/index.ejs`, in the `oh-page-header--row` action area, add next to the Log Attendance button:

```html
  <a class="oh-btn oh-btn--small" href="/attendance/submit">Submit day</a>
```

- [ ] **Step 3f: Add the Regularization nav item** — in `src/nav.ts`, add to the `NAV` array after the Overtime entry:

```ts
  { label: "Regularization", href: "/regularization", icon: "fact_check", cap: "view_regularization", ready: true },
```

- [ ] **Step 4: Run the test to verify it passes** — `npm run build && npm run e2e:regularization` → `submit screen lists the workers`, `submit redirects`, `records flipped to submitted with remark + audit` PASS → `E2E REGULARIZATION PASSED`.

- [ ] **Step 5: Commit**

```bash
git add src/models/Attendance.ts src/auth/permissions.ts src/routes/attendance.ts src/views/attendance/submit.ejs src/views/attendance/index.ejs src/nav.ts scripts/e2e_regularization.ts package.json
git commit -m "feat(attendance): lifecycle fields + supervisor submit-the-day"
```

---

### Task 2: Regularization queue — PM recommend / HR approve / per-worker reject (+ OT subsumption)

**Files:**
- Create: `src/routes/regularization.ts`
- Modify: `src/app.ts` (mount the router)
- Create: `src/views/regularization/index.ejs`, `src/views/regularization/day.ejs`
- Test: extend `scripts/e2e_regularization.ts`

**Interfaces:**
- Consumes: capabilities + `attendanceStatus` from Task 1.
- Produces: `GET /regularization` (list of site-days by status), `GET /regularization/:siteId/:date` (one day), `POST /regularization/:siteId/:date/recommend`, `POST /regularization/:siteId/:date/approve`, `POST /regularization/worker/:attendanceId/reject`.

- [ ] **Step 1: Extend the failing test** — in `scripts/e2e_regularization.ts`, replace the `// Cleanup` block's preceding lines (i.e. after the submit assertions, before Cleanup) by inserting:

```ts
  // --- PM recommends the day ---
  const pa = await login(app, pm);
  assert("PM sees the submitted day", (await pa.get("/regularization")).text.includes(`QA Reg Site ${S}`));
  await pa.post(`/regularization/${site._id}/${today}/recommend`).type("form").send({});
  assert("day recommended", (await AttendanceModel.findOne({ workerId: wa._id, date: today }))?.attendanceStatus === "recommended");

  // --- per-worker reject (B) then HR approve the day ---
  const ha = await login(app, hr);
  const rb = await AttendanceModel.findOne({ workerId: wb._id, date: today });
  await ha.post(`/regularization/worker/${rb!._id}/reject`).type("form").send({ reason: "absent disputed" });
  assert("worker B rejected + OT rejected", (await AttendanceModel.findById(rb!._id))?.attendanceStatus === "rejected");
  await ha.post(`/regularization/${site._id}/${today}/approve`).type("form").send({});
  const fa = await AttendanceModel.findOne({ workerId: wa._id, date: today });
  assert("worker A approved", fa?.attendanceStatus === "approved");
  assert("worker A OT approved (subsumed)", fa?.overtime.status === "approved");
  const fb = await AttendanceModel.findById(rb!._id);
  assert("rejected worker B stays rejected after approve", fb?.attendanceStatus === "rejected");

  // scope: a PM at another site can't recommend this day
  const pm2 = `qa-rgpm2-${S}@trgbi.com`;
  const otherSite = await ProjectSiteModel.create({ branchId: branch._id, name: `QA Reg Other ${S}`, code: `QARGO${S}`.toUpperCase(), standardStartTime: "09:00", standardEndTime: "18:00" });
  await UserModel.create({ name: "RG PM2", email: pm2, passwordHash: await hashPassword(PW), role: "pm", assignedSiteIds: [otherSite._id], active: true });
  const p2 = await login(app, pm2);
  const blocked = await p2.post(`/regularization/${site._id}/${today}/recommend`).type("form").send({});
  assert("out-of-scope PM cannot act on the day", blocked.status === 403 || blocked.status === 302);
  await Promise.all([UserModel.deleteOne({ email: pm2 }), ProjectSiteModel.deleteOne({ _id: otherSite._id })]);
```

- [ ] **Step 2: Run test to verify it fails** — `npm run e2e:regularization` → FAIL (`/regularization` 404; `day recommended` fails).

- [ ] **Step 3a: Create `src/routes/regularization.ts`**:

```ts
import { Router, Request, Response } from "express";
import { Types } from "mongoose";

import { requireCapability } from "../auth/middleware";
import { canUseSite, siteScopeFilter } from "../lib/scope";
import { istHM } from "../lib/time";
import { AttendanceModel } from "../models/Attendance";

const router = Router();
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function flash(req: Request, type: "success" | "danger", text: string): void {
  req.session.flash = { type, text };
}

const TABS: Record<string, string[]> = {
  submitted: ["submitted"],
  recommended: ["recommended"],
  decided: ["approved", "rejected"],
};

// ---- Queue: site-days grouped by status (scoped) ----
router.get("/regularization", requireCapability("view_regularization"), async (req: Request, res: Response) => {
  const tab = TABS[String(req.query.tab)] ? String(req.query.tab) : "submitted";
  const days = await AttendanceModel.aggregate([
    { $match: { ...siteScopeFilter(req.currentUser!), attendanceStatus: { $in: TABS[tab] } } },
    { $group: { _id: { siteId: "$siteId", siteName: "$siteName", date: "$date" }, n: { $sum: 1 }, ot: { $sum: "$overtime.computedHours" } } },
    { $sort: { "_id.date": -1, "_id.siteName": 1 } },
    { $limit: 300 },
  ]);
  res.render("regularization/index", {
    title: "Regularization · " + res.locals.company,
    active: "/regularization",
    tab,
    days: days.map((d) => ({ siteId: String(d._id.siteId), siteName: d._id.siteName, date: d._id.date, n: d.n, ot: d.ot })),
  });
});

// ---- One site-day ----
router.get("/regularization/:siteId/:date", requireCapability("view_regularization"), async (req: Request, res: Response) => {
  const { siteId, date } = req.params;
  if (!Types.ObjectId.isValid(siteId) || !canUseSite(req.currentUser!, siteId) || !DATE_RE.test(date)) {
    flash(req, "danger", "Not found or out of scope.");
    return res.redirect("/regularization");
  }
  const records = await AttendanceModel.find({ siteId, date }).sort({ workerName: 1 }).lean();
  const rows = records.map((r) => ({
    id: String(r._id), workerName: r.workerName, empRegNo: r.empRegNo,
    inHM: istHM(r.inTime ?? null), outHM: istHM(r.outTime ?? null),
    totalHours: r.totalHours, otHours: r.overtime?.computedHours ?? 0,
    status: r.attendanceStatus, remark: r.dailyRemark ?? "", rejectReason: r.rejectReason ?? "",
  }));
  const status = records[0]?.attendanceStatus ?? "scanned";
  res.render("regularization/day", {
    title: "Regularization · " + res.locals.company, active: "/regularization",
    siteName: records[0]?.siteName ?? "", siteId, date, rows, status,
    canRecommend: res.locals.can("recommend_attendance"),
    canApprove: res.locals.can("approve_attendance"),
  });
});

async function transition(req: Request, res: Response, from: string, to: string, set: Record<string, unknown>) {
  const { siteId, date } = req.params;
  if (!Types.ObjectId.isValid(siteId) || !canUseSite(req.currentUser!, siteId) || !DATE_RE.test(date)) {
    return res.status(403).render("error", { title: "Access denied", active: "", code: 403, message: "Out of your site scope." });
  }
  const r = await AttendanceModel.updateMany(
    { siteId, date, attendanceStatus: from },
    { $set: set },
  );
  flash(req, "success", `${r.modifiedCount} record(s) ${to}.`);
  res.redirect(`/regularization/${siteId}/${date}`);
}

// ---- PM recommend: submitted → recommended ----
router.post("/regularization/:siteId/:date/recommend", requireCapability("recommend_attendance"), (req, res) =>
  transition(req, res, "submitted", "recommended", {
    attendanceStatus: "recommended",
    recommendedBy: new Types.ObjectId(req.currentUser!.id),
    recommendedAt: new Date(),
  }),
);

// ---- HR approve: recommended → approved (+ subsume OT) ----
router.post("/regularization/:siteId/:date/approve", requireCapability("approve_attendance"), async (req: Request, res: Response) => {
  const { siteId, date } = req.params;
  if (!Types.ObjectId.isValid(siteId) || !canUseSite(req.currentUser!, siteId) || !DATE_RE.test(date)) {
    return res.status(403).render("error", { title: "Access denied", active: "", code: 403, message: "Out of your site scope." });
  }
  const now = new Date();
  const by = new Types.ObjectId(req.currentUser!.id);
  await AttendanceModel.updateMany(
    { siteId, date, attendanceStatus: "recommended" },
    { $set: { attendanceStatus: "approved", decidedBy: by, decidedAt: now } },
  );
  // Subsume OT approval: approve OT on the day's approved records that have OT.
  await AttendanceModel.updateMany(
    { siteId, date, attendanceStatus: "approved", "overtime.computedHours": { $gt: 0 }, "overtime.status": "pending" },
    { $set: { "overtime.status": "approved", "overtime.approvedBy": by, "overtime.approvedAt": now } },
  );
  flash(req, "success", "Day approved.");
  res.redirect(`/regularization/${siteId}/${date}`);
});

// ---- Per-worker reject (either step) ----
router.post("/regularization/worker/:attendanceId/reject", requireCapability("recommend_attendance"), async (req: Request, res: Response) => {
  const rec = await AttendanceModel.findById(req.params.attendanceId);
  if (!rec || !canUseSite(req.currentUser!, String(rec.siteId))) {
    flash(req, "danger", "Record not found.");
    return res.redirect("/regularization");
  }
  rec.attendanceStatus = "rejected";
  rec.rejectReason = String(req.body.reason ?? "").trim() || null;
  rec.decidedBy = new Types.ObjectId(req.currentUser!.id);
  rec.decidedAt = new Date();
  if (rec.overtime.computedHours > 0) {
    rec.overtime.status = "rejected";
    rec.overtime.approvedBy = new Types.ObjectId(req.currentUser!.id);
    rec.overtime.approvedAt = new Date();
  }
  await rec.save();
  flash(req, "success", `Rejected ${rec.workerName}.`);
  res.redirect(`/regularization/${rec.siteId}/${rec.date}`);
});

export default router;
```

- [ ] **Step 3b: Mount the router in `src/app.ts`** — import it with the other routers and add `app.use("/", regularizationRouter);` alongside the existing `app.use("/", ...)` mounts. Add the import:

```ts
import regularizationRouter from "./routes/regularization";
```
and the mount line next to `app.use("/", attendanceRouter);`:
```ts
  app.use("/", regularizationRouter);
```

- [ ] **Step 3c: Create `src/views/regularization/index.ejs`**:

```html
<%- include('../partials/app-top', { title: title, active: active }) %>
<div class="oh-page-header"><h1 class="oh-page-title">Regularization</h1>
  <p class="oh-page-subtitle">Approve each site's day: submitted → PM recommend → HR approve. Approving a day approves its overtime.</p></div>
<div class="oh-filter-tabs">
  <a class="oh-filter-tab <%= tab==='submitted'?'oh-filter-tab--active':'' %>" href="/regularization?tab=submitted">Submitted (PM)</a>
  <a class="oh-filter-tab <%= tab==='recommended'?'oh-filter-tab--active':'' %>" href="/regularization?tab=recommended">Recommended (HR)</a>
  <a class="oh-filter-tab <%= tab==='decided'?'oh-filter-tab--active':'' %>" href="/regularization?tab=decided">Decided</a>
</div>
<div class="oh-card">
  <% if (days.length) { %>
  <table class="oh-table">
    <thead><tr><th>Date</th><th>Site</th><th class="num">Records</th><th class="num">OT (h)</th><th class="oh-col-action"></th></tr></thead>
    <tbody><% days.forEach(function (d) { %>
      <tr><td><%= d.date %></td><td><%= d.siteName %></td><td class="num"><%= d.n %></td><td class="num"><%= d.ot %></td>
        <td class="oh-col-action"><a class="oh-btn oh-btn--small" href="/regularization/<%= d.siteId %>/<%= d.date %>">Open</a></td></tr>
    <% }); %></tbody>
  </table>
  <% } else { %><p class="oh-muted">Nothing in this queue.</p><% } %>
</div>
<%- include('../partials/app-bottom') %>
```

- [ ] **Step 3d: Create `src/views/regularization/day.ejs`**:

```html
<%- include('../partials/app-top', { title: title, active: active }) %>
<% var badge = { scanned:"muted", submitted:"warning", recommended:"secondary", approved:"success", rejected:"danger" }; %>
<div class="oh-page-header oh-page-header--row">
  <div><h1 class="oh-page-title"><%= siteName %> · <%= date %></h1>
    <p class="oh-page-subtitle">Day status: <span class="oh-badge oh-badge--<%= badge[status]||'muted' %>"><%= status %></span> · times are read-only.</p></div>
  <div class="oh-form-actions">
    <% if (status === "submitted" && canRecommend) { %>
    <form method="post" action="/regularization/<%= siteId %>/<%= date %>/recommend" style="margin:0"><button class="oh-btn oh-btn--secondary" type="submit">Recommend</button></form>
    <% } %>
    <% if (status === "recommended" && canApprove) { %>
    <form method="post" action="/regularization/<%= siteId %>/<%= date %>/approve" style="margin:0"><button class="oh-btn oh-btn--success" type="submit">Approve day</button></form>
    <% } %>
    <a class="oh-btn oh-btn--small" href="/regularization">Back</a>
  </div>
</div>
<div class="oh-card">
  <table class="oh-table">
    <thead><tr><th>Worker</th><th>In</th><th>Out</th><th>Total</th><th>OT</th><th>Status</th><th>Remark</th><th class="oh-col-action"></th></tr></thead>
    <tbody><% rows.forEach(function (r) { %>
      <tr>
        <td><%= r.workerName %><br/><span class="oh-muted"><%= r.empRegNo %></span></td>
        <td><%= r.inHM || "—" %></td><td><%= r.outHM || "—" %></td><td><%= r.totalHours != null ? r.totalHours + "h" : "—" %></td>
        <td><%= r.otHours > 0 ? r.otHours + "h" : "—" %></td>
        <td><span class="oh-badge oh-badge--<%= badge[r.status]||'muted' %>"><%= r.status %></span></td>
        <td><%= r.remark || "—" %><% if (r.rejectReason) { %><br/><span class="oh-muted">✗ <%= r.rejectReason %></span><% } %></td>
        <td class="oh-col-action">
          <% if (r.status !== "rejected" && r.status !== "approved" && (canRecommend || canApprove)) { %>
          <form method="post" action="/regularization/worker/<%= r.id %>/reject" style="margin:0" onsubmit="return confirm('Reject this worker for the day?')">
            <input type="hidden" name="reason" value="rejected at regularization" />
            <button class="oh-btn oh-btn--small oh-btn--danger" type="submit">Reject</button>
          </form><% } %>
        </td>
      </tr>
    <% }); %></tbody>
  </table>
</div>
<%- include('../partials/app-bottom') %>
```

- [ ] **Step 4: Run the test to verify it passes** — `npm run build && npm run e2e:regularization` → all assertions through `out-of-scope PM cannot act on the day` PASS → `E2E REGULARIZATION PASSED`.

- [ ] **Step 5: Commit**

```bash
git add src/routes/regularization.ts src/app.ts src/views/regularization/ scripts/e2e_regularization.ts
git commit -m "feat(attendance): regularization queue — PM recommend / HR approve / per-worker reject (+ OT subsumed)"
```

---

### Task 3: Make `/overtime` read-only (approval now lives in regularization)

**Files:**
- Modify: `src/routes/overtime.ts` (remove approve/reject routes)
- Modify: `src/views/overtime/index.ejs` (remove the approve/reject form actions; link to /regularization)
- Test: rewrite `scripts/e2e_overtime.ts`

**Interfaces:**
- Consumes: regularization approval (Task 2) as the only path that sets `overtime.status`.

- [ ] **Step 1: Rewrite the failing test** — replace `scripts/e2e_overtime.ts` with a self-contained suite asserting the page is read-only and that day-approval (not /overtime) sets OT approved:

```ts
/* E2E: /overtime is now a READ-ONLY view; OT approval happens via regularization.
   Self-contained; cleans up. Run: npm run e2e:overtime */
import request from "supertest";
import mongoose, { Types } from "mongoose";

import { createApp } from "../src/app";
import { connectDb } from "../src/db";
import * as db from "../src/db";
import { hashPassword } from "../src/auth/password";
import { siteLocalDate } from "../src/lib/time";
import { BranchModel, ProjectSiteModel, WorkerModel, UserModel, AttendanceModel } from "../src/models";

const S = Date.now().toString(36);
const PW = "Pass123!";
const today = siteLocalDate();
function assert(label: string, cond: boolean): void { console.log(`${cond ? "PASS" : "FAIL"}: ${label}`); if (!cond) process.exitCode = 1; }
async function login(app: ReturnType<typeof createApp>, email: string) {
  const a = request.agent(app); const r = await a.post("/login").type("form").send({ email, password: PW });
  if (r.status !== 302) throw new Error(`login ${email}`); return a;
}

async function main(): Promise<void> {
  await connectDb();
  if (!db.dbReady) { console.error("DB not reachable."); process.exit(1); }
  const app = createApp();
  const branch = await BranchModel.create({ name: `QA OT ${S}` });
  const site = await ProjectSiteModel.create({ branchId: branch._id, name: `QA OT Site ${S}`, code: `QAOT${S}`.toUpperCase(), standardStartTime: "09:00", standardEndTime: "18:00" });
  const w = await WorkerModel.create({ empRegNo: `QA-OT-${S}`, name: `W ${S}`, designationId: new Types.ObjectId(), designationName: "Carpenter", siteId: site._id, siteName: site.name, faceEncoding: [], status: "active" });
  const rec = await AttendanceModel.create({
    date: today, workerId: w._id, empRegNo: w.empRegNo, workerName: w.name, designationId: w.designationId, designationName: "Carpenter",
    siteId: site._id, siteName: site.name, branchId: branch._id, branchName: branch.name,
    inTime: new Date(Date.now() - 11 * 3_600_000), outTime: new Date(), totalHours: 11, standardHours: 8,
    overtime: { computedHours: 2, status: "pending" }, attendanceStatus: "recommended", source: "scan",
  });
  const hr = `qa-othr-${S}@trgbi.com`;
  await UserModel.create({ name: "OT HR", email: hr, passwordHash: await hashPassword(PW), role: "hr", assignedSiteIds: [], active: true });
  const ha = await login(app, hr);

  const page = await ha.get("/overtime");
  assert("overtime page 200 + lists the OT record", page.status === 200 && page.text.includes(`QA-OT-${S}`));
  assert("overtime page is read-only (no approve form)", !page.text.includes('action="/overtime/'));
  assert("legacy approve route is gone (404)", (await ha.post(`/overtime/${rec._id}/approve`).type("form").send({})).status === 404);

  // Approval via regularization flips OT to approved.
  await ha.post(`/regularization/${site._id}/${today}/approve`).type("form").send({});
  assert("day-approval set OT approved", (await AttendanceModel.findById(rec._id))?.overtime.status === "approved");

  await Promise.all([
    AttendanceModel.deleteMany({ siteId: site._id }), WorkerModel.deleteMany({ siteId: site._id }),
    UserModel.deleteOne({ email: hr }), ProjectSiteModel.deleteOne({ _id: site._id }), BranchModel.deleteOne({ _id: branch._id }),
  ]);
  await mongoose.connection.close();
  console.log(process.exitCode ? "\nE2E OVERTIME FAILED" : "\nE2E OVERTIME PASSED");
  process.exit(process.exitCode ?? 0);
}
main().catch((e) => { console.error("\nE2E OVERTIME ERROR:", e?.message ?? e); process.exit(1); });
```

- [ ] **Step 2: Run test to verify it fails** — `npm run e2e:overtime` → FAIL (`legacy approve route is gone` fails — the route still exists; the page still has the form).

- [ ] **Step 3a: Remove the approve/reject routes from `src/routes/overtime.ts`** — delete both `router.post("/overtime/:id/approve", …)` and `router.post("/overtime/:id/reject", …)` handlers entirely, and the now-unused `flash` helper, `Types` import, and `round2` import. The GET handler stays but drop `canApprove` from its render payload. The file becomes just the imports it still needs (`Router`, `requireCapability`, `siteScopeFilter`, `AttendanceModel`) + the GET route + `export default router;`.

```ts
import { Router, Request, Response } from "express";

import { requireCapability } from "../auth/middleware";
import { siteScopeFilter } from "../lib/scope";
import { AttendanceModel } from "../models/Attendance";

const router = Router();
const FILTERS = ["pending", "approved", "rejected", "all"] as const;

// Read-only OT view. Approval happens in /regularization (approving a day
// approves its overtime). Scoped to the user's sites.
router.get("/overtime", requireCapability("view_overtime"), async (req: Request, res: Response) => {
  const filter = FILTERS.includes(req.query.status as never) ? (req.query.status as string) : "pending";
  const query: Record<string, unknown> = { ...siteScopeFilter(req.currentUser!) };
  query["overtime.status"] = filter === "all" ? { $in: ["pending", "approved", "rejected"] } : filter;
  const records = await AttendanceModel.find(query).sort({ date: -1, createdAt: -1 }).limit(500).lean();
  res.render("overtime/index", { title: "Overtime · " + res.locals.company, active: "/overtime", records, filter });
});

export default router;
```

- [ ] **Step 3b: Remove the approve/reject controls from `src/views/overtime/index.ejs`** — delete any `<form method="post" action="/overtime/<...>/approve">` / `/reject` blocks and the adjust-hours inputs, and the `<% if (canApprove) { %>` wrapper. Replace the action column with a read-only OT-status badge, and add a one-line note under the page header:

```html
<p class="oh-muted">Read-only — overtime is approved when its day is approved in <a href="/regularization">Regularization</a>.</p>
```

(Read the file first; keep the table/filter tabs, only strip the per-row action form + any `canApprove` references.)

- [ ] **Step 4: Run the test to verify it passes** — `npm run build && npm run e2e:overtime` → `overtime page is read-only (no approve form)`, `legacy approve route is gone (404)`, `day-approval set OT approved` PASS → `E2E OVERTIME PASSED`.

- [ ] **Step 5: Run the regression sweep**

```bash
npm run seed   # legacy suites need VBW/PVM fixtures (the import reset the org)
for s in login org workers station overtime reports users hierarchy attendance missed requests supervisor logscan facecapture payfields shift regularization; do npm run e2e:$s 2>&1 | grep -E "PASSED|FAILED" | tail -1; done
```
Expected: every suite prints `... PASSED`. (`e2e:reports` may assert OT approval via the old buttons — if it fails, re-point its approval step to a `/regularization/:siteId/:date/approve` call, same as `e2e_overtime` does.)

- [ ] **Step 6: Commit**

```bash
git add src/routes/overtime.ts src/views/overtime/index.ejs scripts/e2e_overtime.ts
git commit -m "refactor(overtime): read-only view — approval moved to regularization"
```

---

## Self-review (addressed)

- **Spec coverage:** lifecycle + fields → Task 1; submit (+remarks, batch) → Task 1; queue + recommend/approve/per-worker-reject + OT subsumption → Task 2; `/overtime` read-only → Task 3; caps + nav → Task 1/2; testing → each task's e2e + the sweep. The missed-clock-out flag is documented as out-of-scope (no task — correct).
- **Type consistency:** `attendanceStatus` values, capability keys, and route paths are identical across tasks; `transition()` helper + the approve route both use `updateMany` with the same `{siteId,date,attendanceStatus}` shape.
- **Out of scope confirmed:** no time edits, no travel/segments, no payroll computation; OT only flips via the regularization approve/reject.
