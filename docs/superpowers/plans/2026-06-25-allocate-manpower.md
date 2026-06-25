# Allocate Manpower Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A staffing module where sites request workers (role × qty × shift × dates) and admins allocate specific people to fill them; allocating an enrolled worker also assigns the site to them so they can scan there.

**Architecture:** Two new Mongoose models (`ManpowerRequest`, `OutsourceEmployee`) + a `lib/manpower.ts` (code minting + status derivation) + one route module `routes/manpower.ts` mounted at `/manpower` + EJS views, following the existing `requests.ts`/`oh-` patterns. Reuses Designations (roles), Workers (`siteIds`), Sites/Branches, the capability/scope system, and the CSV/PDF exporters.

**Tech Stack:** Express + TypeScript + Mongoose + server-rendered EJS. Tests are self-contained scripts run via `npm run e2e:<suite>` that `assert`/`process.exit`.

## Global Constraints

- Roles: **PM/Supervisor/admins raise** (`request_manpower`); **Management/HR allocate** (`allocate_manpower`); all four **view** (`view_manpower`, scoped).
- Allocating a **worker** does `$addToSet` of the request's `siteId` into `Worker.siteIds` (can scan there). **Outsource** allocations are plan-only (no site change).
- Allocation is **per role line** (`lineDesignationId`).
- `reqCode` = `MPA-NNNNNN`, outsource `code` = `OUT-NNNN` — sequential via the `Counter` model.
- Status derived on save: `open` (0 allocs) → `partial` → `fulfilled` (every line filled); `cancelled` is explicit and sticky.
- PM/Supervisor scoped via `siteScopeFilter(u)` / `canUseSite(u, siteId)` on `siteId`; out-of-scope → 403.
- `oh-` design system (Poppins, accent `#1c4d8c`, sharp corners, 1px borders); mobile-safe (dual-DOM or `oh-table--cards`).
- After every change: `npm run build` (0 TS errors).

---

### Task 1: Capabilities + nav + permission editor

**Files:**
- Modify: `src/auth/permissions.ts` (Capability union + CAPABILITY_ROLES)
- Modify: `src/nav.ts` (NAV item)
- Modify: `src/routes/users.ts` (PERMISSION_GROUPS — new "Manpower" group)
- Test: `scripts/e2e_users.ts`

**Interfaces:**
- Produces: caps `"view_manpower"`, `"request_manpower"`, `"allocate_manpower"`; `can("hr","allocate_manpower")===true`, `can("pm","allocate_manpower")===false`, `can("pm","request_manpower")===true`.

- [ ] **Step 1: Extend e2e.** In `scripts/e2e_users.ts`, near the other `can(...)` asserts, add:
```ts
assert("HR can allocate manpower", can("hr", "allocate_manpower"));
assert("PM cannot allocate manpower", !can("pm", "allocate_manpower"));
assert("PM can request manpower", can("pm", "request_manpower"));
assert("Supervisor sees manpower (scoped)", can("supervisor", "view_manpower"));
```

- [ ] **Step 2: Run — expect FAIL.** `npm run e2e:users` → FAIL/TS error (caps don't exist).

- [ ] **Step 3: Implement.** In `src/auth/permissions.ts`, add to the `Capability` union (after `"correct_attendance"`):
```ts
  | "view_manpower"
  | "request_manpower"
  | "allocate_manpower"
```
Add to `CAPABILITY_ROLES` (after `correct_attendance`):
```ts
  // Allocate Manpower: PM/Supervisor raise requests for their site; Management/HR allocate.
  view_manpower: ["management", "hr", "pm", "supervisor"],
  request_manpower: ["management", "hr", "pm", "supervisor"],
  allocate_manpower: ["management", "hr"],
```
In `src/nav.ts`, add after the Requests item (line 18):
```ts
  { label: "Allocate Manpower", href: "/manpower", icon: "engineering", cap: "view_manpower", ready: true },
```
In `src/routes/users.ts` `PERMISSION_GROUPS`, add a group (after the Requests group):
```ts
  { group: "Manpower", caps: [
    { cap: "view_manpower", label: "View allocate manpower" },
    { cap: "request_manpower", label: "Request manpower" },
    { cap: "allocate_manpower", label: "Allocate workers (HR/Mgmt)" },
  ] },
```

- [ ] **Step 4: Run — expect PASS.** `npm run e2e:users` → PASS.

- [ ] **Step 5: Commit.**
```bash
npm run build
git add src/auth/permissions.ts src/nav.ts src/routes/users.ts scripts/e2e_users.ts
git commit -m "feat(manpower): view/request/allocate_manpower capabilities + nav + permission editor"
```

---

### Task 2: Models + lib helpers (codes, status)

**Files:**
- Create: `src/models/ManpowerRequest.ts`
- Create: `src/models/OutsourceEmployee.ts`
- Create: `src/lib/manpower.ts`
- Modify: `src/models/index.ts`
- Test: `scripts/e2e_manpower.ts` (new)

**Interfaces:**
- Produces: `ManpowerRequestModel`, `OutsourceEmployeeModel`, `MANPOWER_STATUS`; `nextCode(prefix, key, pad?) → Promise<string>`; `computeStatus(req) → "open"|"partial"|"fulfilled"|"cancelled"`.

- [ ] **Step 1: Write the model + helpers.**

`src/lib/manpower.ts`:
```ts
import { CounterModel } from "../models/Counter";

/** Mint the next sequential code like MPA-000123 / OUT-0007 (atomic via Counter). */
export async function nextCode(prefix: string, key: string, pad = 6): Promise<string> {
  const c = await CounterModel.findOneAndUpdate({ key }, { $inc: { seq: 1 } }, { upsert: true, new: true });
  return `${prefix}-${String(c!.seq).padStart(pad, "0")}`;
}

interface StatusInput {
  status?: string;
  lines: { designationId: unknown; qty: number }[];
  allocations: { lineDesignationId: unknown }[];
}
/** Derive status from lines vs allocations. `cancelled` is sticky. */
export function computeStatus(req: StatusInput): "open" | "partial" | "fulfilled" | "cancelled" {
  if (req.status === "cancelled") return "cancelled";
  if (req.allocations.length === 0) return "open";
  const allFilled = req.lines.every(
    (l) => req.allocations.filter((a) => String(a.lineDesignationId) === String(l.designationId)).length >= l.qty,
  );
  return allFilled ? "fulfilled" : "partial";
}
```

`src/models/ManpowerRequest.ts`:
```ts
import { Schema, model, InferSchemaType } from "mongoose";

export const MANPOWER_STATUS = ["open", "partial", "fulfilled", "cancelled"] as const;

const lineSchema = new Schema(
  {
    designationId: { type: Schema.Types.ObjectId, ref: "Designation", required: true },
    designationName: { type: String, required: true },
    qty: { type: Number, required: true, min: 1 },
  },
  { _id: false },
);

const allocationSchema = new Schema(
  {
    kind: { type: String, enum: ["worker", "outsource"], required: true },
    refId: { type: Schema.Types.ObjectId, required: true }, // Worker or OutsourceEmployee
    code: { type: String, default: null }, // empRegNo or OUT-code
    name: { type: String, required: true },
    lineDesignationId: { type: Schema.Types.ObjectId, ref: "Designation", required: true },
    designationName: { type: String, default: null },
    allocatedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    allocatedByName: { type: String, default: null },
    allocatedAt: { type: Date, default: Date.now },
  },
  { _id: false },
);

const manpowerRequestSchema = new Schema(
  {
    reqCode: { type: String, required: true, unique: true },
    siteId: { type: Schema.Types.ObjectId, ref: "ProjectSite", required: true },
    siteName: { type: String, required: true },
    branchId: { type: Schema.Types.ObjectId, ref: "Branch", default: null },
    branchName: { type: String, default: null },
    shiftType: { type: String, enum: ["day", "night", "sunday"], default: "day" },
    dateFrom: { type: String, required: true }, // YYYY-MM-DD
    dateTo: { type: String, required: true },
    lines: { type: [lineSchema], default: [] },
    allocations: { type: [allocationSchema], default: [] },
    status: { type: String, enum: [...MANPOWER_STATUS], default: "open" },
    requestedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    requestedByName: { type: String, default: null },
    requestedAt: { type: Date, default: Date.now },
    requesterRemarks: { type: String, default: null },
    notes: { type: String, default: null },
  },
  { timestamps: true },
);
manpowerRequestSchema.index({ siteId: 1, status: 1 });
manpowerRequestSchema.index({ status: 1, createdAt: -1 });

export type ManpowerRequest = InferSchemaType<typeof manpowerRequestSchema>;
export const ManpowerRequestModel = model("ManpowerRequest", manpowerRequestSchema, "manpower_requests");
```

`src/models/OutsourceEmployee.ts`:
```ts
import { Schema, model, InferSchemaType } from "mongoose";

const outsourceEmployeeSchema = new Schema(
  {
    code: { type: String, required: true, unique: true }, // OUT-NNNN
    name: { type: String, required: true, trim: true },
    designationId: { type: Schema.Types.ObjectId, ref: "Designation", default: null },
    designationName: { type: String, default: null },
    outsourceCompany: { type: String, default: null, trim: true },
    payRate: { type: Number, default: null }, // per day
    phone: { type: String, default: null, trim: true },
    active: { type: Boolean, default: true },
  },
  { timestamps: true },
);

export type OutsourceEmployee = InferSchemaType<typeof outsourceEmployeeSchema>;
export const OutsourceEmployeeModel = model("OutsourceEmployee", outsourceEmployeeSchema, "outsource_employees");
```

In `src/models/index.ts`, add:
```ts
export * from "./ManpowerRequest";
export * from "./OutsourceEmployee";
```

- [ ] **Step 2: Write the e2e (`scripts/e2e_manpower.ts`).** Self-contained, mirrors `e2e_payroll.ts` (direct DB; no supertest yet for this task). Assert helpers + status logic:
```ts
import mongoose, { Types } from "mongoose";
import { connectDb } from "../src/db";
import * as db from "../src/db";
import { nextCode, computeStatus } from "../src/lib/manpower";
import { ManpowerRequestModel, OutsourceEmployeeModel } from "../src/models";

const S = Date.now().toString(36);
function assert(label: string, cond: boolean): void { console.log(`${cond ? "PASS" : "FAIL"}: ${label}`); if (!cond) process.exitCode = 1; }

async function main(): Promise<void> {
  await connectDb();
  if (!db.dbReady) { console.error("DB not reachable."); process.exit(1); }

  const d1 = new Types.ObjectId(), d2 = new Types.ObjectId();
  // computeStatus
  assert("open when no allocations", computeStatus({ lines: [{ designationId: d1, qty: 2 }], allocations: [] }) === "open");
  assert("partial when some filled", computeStatus({ lines: [{ designationId: d1, qty: 2 }], allocations: [{ lineDesignationId: d1 }] }) === "partial");
  assert("fulfilled when all lines filled", computeStatus({ lines: [{ designationId: d1, qty: 1 }, { designationId: d2, qty: 1 }], allocations: [{ lineDesignationId: d1 }, { lineDesignationId: d2 }] }) === "fulfilled");
  assert("cancelled is sticky", computeStatus({ status: "cancelled", lines: [{ designationId: d1, qty: 1 }], allocations: [{ lineDesignationId: d1 }] }) === "cancelled");

  // nextCode sequential + format
  const c1 = await nextCode("MPA", `qa-mpa-${S}`);
  const c2 = await nextCode("MPA", `qa-mpa-${S}`);
  assert("code format MPA-000001", /^MPA-\d{6}$/.test(c1));
  assert("code increments", Number(c2.slice(4)) === Number(c1.slice(4)) + 1);

  await mongoose.connection.close();
  console.log(process.exitCode ? "\nE2E MANPOWER FAILED" : "\nE2E MANPOWER PASSED");
  process.exit(process.exitCode ?? 0);
}
main().catch((e) => { console.error("\nE2E MANPOWER ERROR:", (e as Error)?.message ?? e); process.exit(1); });
```
Register the script in `package.json`: `"e2e:manpower": "tsx scripts/e2e_manpower.ts"`.

- [ ] **Step 3: Run — expect PASS.** `npm run build` (0 errors), `npm run e2e:manpower` → all PASS.

- [ ] **Step 4: Commit.**
```bash
git add src/models/ManpowerRequest.ts src/models/OutsourceEmployee.ts src/lib/manpower.ts src/models/index.ts scripts/e2e_manpower.ts package.json
git commit -m "feat(manpower): ManpowerRequest + OutsourceEmployee models, code/status helpers"
```

---

### Task 3: Core routes (list / new / create / detail) + mount + views

**Files:**
- Create: `src/routes/manpower.ts`
- Modify: `src/app.ts` (import + mount)
- Create: `src/views/manpower/index.ejs`, `src/views/manpower/new.ejs`, `src/views/manpower/detail.ejs`
- Test: `scripts/e2e_manpower.ts`

**Interfaces:**
- Consumes: `ManpowerRequestModel`, `nextCode`, `computeStatus`, `siteScopeFilter`, `canUseSite`, `DesignationModel`, `ProjectSiteModel`, `BranchModel`.
- Produces: routes `GET /manpower`, `GET /manpower/new`, `POST /manpower`, `GET /manpower/:id`.

- [ ] **Step 1: Create `src/routes/manpower.ts`** (the create handler — mirror requests.ts):
```ts
import { Router, Request, Response } from "express";
import { Types } from "mongoose";

import { requireCapability } from "../auth/middleware";
import { nextCode, computeStatus } from "../lib/manpower";
import { siteScopeFilter, canUseSite } from "../lib/scope";
import { BranchModel } from "../models/Branch";
import { DesignationModel } from "../models/Designation";
import { ManpowerRequestModel } from "../models/ManpowerRequest";
import { ProjectSiteModel } from "../models/ProjectSite";

const router = Router();
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
function flash(req: Request, type: "success" | "danger", text: string): void { req.session.flash = { type, text }; }

// ---- List (scoped + status filter) ----
router.get("/manpower", requireCapability("view_manpower"), async (req: Request, res: Response) => {
  const u = req.currentUser!;
  const scope = siteScopeFilter(u);
  const tab = ["open", "partial", "fulfilled", "cancelled", "all"].includes(String(req.query.tab)) ? String(req.query.tab) : "open";
  const query: Record<string, unknown> = { ...scope };
  if (tab !== "all") query.status = tab;
  const [requests, countAgg] = await Promise.all([
    ManpowerRequestModel.find(query).sort({ createdAt: -1 }).limit(500).lean(),
    ManpowerRequestModel.aggregate([{ $match: { ...scope } }, { $group: { _id: "$status", n: { $sum: 1 } } }]),
  ]);
  const byStatus = new Map<string, number>(countAgg.map((c) => [c._id as string, c.n as number]));
  res.render("manpower/index", {
    title: "Allocate Manpower · " + res.locals.company, active: "/manpower", tab,
    requests: requests.map((r) => ({ ...r, id: String(r._id), needed: r.lines.reduce((a: number, l: { qty: number }) => a + l.qty, 0), filled: r.allocations.length })),
    counts: { open: byStatus.get("open") ?? 0, partial: byStatus.get("partial") ?? 0, fulfilled: byStatus.get("fulfilled") ?? 0, cancelled: byStatus.get("cancelled") ?? 0 },
    canRequest: res.locals.can("request_manpower"),
    canAllocate: res.locals.can("allocate_manpower"),
  });
});

// ---- New request form ----
router.get("/manpower/new", requireCapability("request_manpower"), async (req: Request, res: Response) => {
  const u = req.currentUser!;
  const [sites, designations] = await Promise.all([
    ProjectSiteModel.find(siteScopeFilter(u)).sort({ name: 1 }).select("name").lean(),
    DesignationModel.find().sort({ name: 1 }).lean(),
  ]);
  res.render("manpower/new", { title: "New manpower request · " + res.locals.company, active: "/manpower", sites, designations });
});

// ---- Create ----
router.post("/manpower", requireCapability("request_manpower"), async (req: Request, res: Response) => {
  const u = req.currentUser!;
  const siteId = String(req.body.siteId ?? "");
  const shiftType = ["day", "night", "sunday"].includes(String(req.body.shiftType)) ? String(req.body.shiftType) : "day";
  const dateFrom = String(req.body.dateFrom ?? "").trim();
  const dateTo = String(req.body.dateTo ?? "").trim();
  if (!Types.ObjectId.isValid(siteId) || !canUseSite(u, siteId) || !DATE_RE.test(dateFrom) || !DATE_RE.test(dateTo) || dateFrom > dateTo) {
    flash(req, "danger", "Pick a site in your scope and a valid date range.");
    return res.redirect("/manpower/new");
  }
  // lines: parallel arrays designationId[] + qty[]
  const ids = ([] as string[]).concat(req.body.lineDesignationId ?? []);
  const qtys = ([] as string[]).concat(req.body.lineQty ?? []);
  const desigs = await DesignationModel.find({ _id: { $in: ids.filter((x) => Types.ObjectId.isValid(x)) } }).lean();
  const dmap = new Map(desigs.map((d) => [String(d._id), d.name]));
  const lines = ids.map((id, i) => ({ id, qty: Math.max(0, Number(qtys[i]) || 0) }))
    .filter((l) => Types.ObjectId.isValid(l.id) && l.qty > 0 && dmap.has(l.id))
    .map((l) => ({ designationId: new Types.ObjectId(l.id), designationName: dmap.get(l.id)!, qty: l.qty }));
  if (!lines.length) { flash(req, "danger", "Add at least one role with a quantity."); return res.redirect("/manpower/new"); }

  const site = await ProjectSiteModel.findById(siteId).lean();
  const branch = site ? await BranchModel.findById(site.branchId).lean() : null;
  const reqCode = await nextCode("MPA", "manpowerReq");
  await ManpowerRequestModel.create({
    reqCode, siteId: site!._id, siteName: site!.name, branchId: site!.branchId, branchName: branch?.name ?? null,
    shiftType, dateFrom, dateTo, lines, allocations: [], status: "open",
    requestedBy: new Types.ObjectId(u.id), requestedByName: u.name, requestedAt: new Date(),
    requesterRemarks: String(req.body.requesterRemarks ?? "").trim() || null,
  });
  flash(req, "success", `Request ${reqCode} created.`);
  res.redirect("/manpower");
});

// ---- Detail ----
router.get("/manpower/:id", requireCapability("view_manpower"), async (req: Request, res: Response) => {
  const u = req.currentUser!;
  const r = await ManpowerRequestModel.findById(req.params.id).lean();
  if (!r || !canUseSite(u, String(r.siteId))) { flash(req, "danger", "Request not found or out of scope."); return res.redirect("/manpower"); }
  const lines = r.lines.map((l) => ({ ...l, designationId: String(l.designationId), filled: r.allocations.filter((a) => String(a.lineDesignationId) === String(l.designationId)).length }));
  res.render("manpower/detail", {
    title: r.reqCode + " · " + res.locals.company, active: "/manpower",
    r: { ...r, id: String(r._id) }, lines,
    canAllocate: res.locals.can("allocate_manpower"),
    workers: [], outsource: [], // filled in Task 4
  });
});

export default router;
```
(Task 4 adds the allocate/deallocate/cancel routes and the `workers`/`outsource` pickers to the detail render.)

- [ ] **Step 2: Mount in `src/app.ts`.** Add `import manpowerRouter from "./routes/manpower";` with the other route imports, and `app.use("/", manpowerRouter);` in the route list (after `requestsRouter`).

- [ ] **Step 3: Create the three views** under `src/views/manpower/` matching the `oh-` system and `views/requests/*` for structure:
  - `index.ejs`: page header with a "New request" button (when `canRequest`), status filter tabs (`oh-filter-tabs`), and an `oh-people oh-table--cards` table of requests (cols: Req code, Site, Shift, Dates, Needed/Filled, Status badge) — each row links to `/manpower/<id>`. Mobile: card pattern (add `data-label`s). Empty state via `oh-empty`.
  - `new.ejs`: a form posting to `/manpower` with: site `<select name="siteId">` (from `sites`), shift `<select name="shiftType">` (Day/Night/Sunday), `dateFrom`/`dateTo` (`type="date"`), a dynamic **role-lines** block — repeated rows of `<select name="lineDesignationId">` (from `designations`) + `<input name="lineQty" type="number" min="1">`, with a small "+ Add role" button (vanilla JS clones the last row), and `requesterRemarks`. Use `oh-form-card`/`oh-form-inline`.
  - `detail.ejs`: header showing `reqCode`, site, shift, dates, status badge, requester. A per-line table: role, needed, filled, and (when `canAllocate`) an "Allocate" control per line (filled in Task 4). An allocations list (name, code, role, by/at) with a Remove button when `canAllocate`. A "Cancel request" button when `canAllocate` and not cancelled.

- [ ] **Step 4: Add a create+list assertion to the e2e.** Extend `scripts/e2e_manpower.ts` to use supertest (mirror `e2e_correction.ts` login helper). Create a branch/site/designation + an HR user; login; POST `/manpower` with one line; assert 302, a request exists with `reqCode` matching `/^MPA-\d{6}$/`, status `open`, and `GET /manpower` returns 200 containing the reqCode. Add cleanup.

- [ ] **Step 5: Build + run + commit.**
```bash
npm run build
npm run e2e:manpower   # all PASS
git add src/routes/manpower.ts src/app.ts src/views/manpower/ scripts/e2e_manpower.ts
git commit -m "feat(manpower): request list/create/detail routes + views, mounted at /manpower"
```

---

### Task 4: Allocate / deallocate / cancel (+ site assignment)

**Files:**
- Modify: `src/routes/manpower.ts` (add routes + fill the detail pickers)
- Modify: `src/views/manpower/detail.ejs` (allocate controls)
- Test: `scripts/e2e_manpower.ts`

**Interfaces:**
- Consumes: `WorkerModel`, `OutsourceEmployeeModel`, `computeStatus`.
- Produces: `POST /manpower/:id/allocate`, `POST /manpower/:id/deallocate`, `POST /manpower/:id/cancel`.

- [ ] **Step 1: Extend the detail GET** to pass pickers — replace `workers: [], outsource: []` with:
```ts
  const [workers, outsource] = await Promise.all([
    WorkerModel.find({ status: "active" }).select("name empRegNo designationId designationName siteName").sort({ name: 1 }).lean(),
    OutsourceEmployeeModel.find({ active: true }).select("name code designationName").sort({ name: 1 }).lean(),
  ]);
```
and pass `workers: workers.map((w) => ({ id: String(w._id), name: w.name, empRegNo: w.empRegNo, designationId: String(w.designationId), designationName: w.designationName })), outsource: outsource.map((o) => ({ id: String(o._id), name: o.name, code: o.code }))`. Add the imports `WorkerModel`, `OutsourceEmployeeModel`.

- [ ] **Step 2: Add the routes** (before `export default router;`):
```ts
async function loadOwned(req: Request, res: Response) {
  const u = req.currentUser!;
  const r = await ManpowerRequestModel.findById(req.params.id);
  if (!r || !canUseSite(u, String(r.siteId))) { flash(req, "danger", "Request not found or out of scope."); res.redirect("/manpower"); return null; }
  return r;
}

router.post("/manpower/:id/allocate", requireCapability("allocate_manpower"), async (req: Request, res: Response) => {
  const r = await loadOwned(req, res); if (!r) return;
  if (r.status === "cancelled") { flash(req, "danger", "Request is cancelled."); return res.redirect(`/manpower/${r._id}`); }
  const u = req.currentUser!;
  const lineDesignationId = String(req.body.lineDesignationId ?? "");
  const kind = String(req.body.kind ?? "");
  const refId = String(req.body.refId ?? "");
  const line = r.lines.find((l) => String(l.designationId) === lineDesignationId);
  if (!line || !["worker", "outsource"].includes(kind) || !Types.ObjectId.isValid(refId)) { flash(req, "danger", "Pick a role line and a person."); return res.redirect(`/manpower/${r._id}`); }
  if (r.allocations.some((a) => String(a.refId) === refId && String(a.lineDesignationId) === lineDesignationId)) { flash(req, "danger", "Already allocated to this role."); return res.redirect(`/manpower/${r._id}`); }
  if (kind === "worker") {
    const w = await WorkerModel.findById(refId).lean();
    if (!w) { flash(req, "danger", "Worker not found."); return res.redirect(`/manpower/${r._id}`); }
    r.allocations.push({ kind: "worker", refId: w._id, code: w.empRegNo, name: w.name, lineDesignationId: line.designationId, designationName: line.designationName, allocatedBy: new Types.ObjectId(u.id), allocatedByName: u.name, allocatedAt: new Date() });
    await WorkerModel.updateOne({ _id: w._id }, { $addToSet: { siteIds: r.siteId } }); // can now scan at this site
  } else {
    const o = await OutsourceEmployeeModel.findById(refId).lean();
    if (!o) { flash(req, "danger", "Outsource person not found."); return res.redirect(`/manpower/${r._id}`); }
    r.allocations.push({ kind: "outsource", refId: o._id, code: o.code, name: o.name, lineDesignationId: line.designationId, designationName: line.designationName, allocatedBy: new Types.ObjectId(u.id), allocatedByName: u.name, allocatedAt: new Date() });
  }
  r.status = computeStatus(r);
  await r.save();
  flash(req, "success", "Allocated.");
  res.redirect(`/manpower/${r._id}`);
});

router.post("/manpower/:id/deallocate", requireCapability("allocate_manpower"), async (req: Request, res: Response) => {
  const r = await loadOwned(req, res); if (!r) return;
  const refId = String(req.body.refId ?? "");
  const lineDesignationId = String(req.body.lineDesignationId ?? "");
  r.allocations = r.allocations.filter((a) => !(String(a.refId) === refId && String(a.lineDesignationId) === lineDesignationId)) as typeof r.allocations;
  r.status = computeStatus(r);
  await r.save();
  flash(req, "success", "Allocation removed.");
  res.redirect(`/manpower/${r._id}`);
});

router.post("/manpower/:id/cancel", requireCapability("allocate_manpower"), async (req: Request, res: Response) => {
  const r = await loadOwned(req, res); if (!r) return;
  r.status = "cancelled";
  await r.save();
  flash(req, "success", "Request cancelled.");
  res.redirect(`/manpower/${r._id}`);
});
```

- [ ] **Step 3: Detail view allocate controls.** For each line when `canAllocate`, render a small form posting to `/manpower/<r.id>/allocate` with hidden `lineDesignationId`, a `kind` select (Worker/Outsource), a `refId` select populated from `workers` (suggest those whose `designationId` matches the line first) and `outsource`, and a Submit. Each allocation row gets a Remove form posting to `/deallocate` (hidden `refId` + `lineDesignationId`). A "Cancel request" form posts to `/cancel`.

- [ ] **Step 4: Extend the e2e** (supertest, HR session). Create a site + designation + an enrolled worker (designation = the line) + an outsource employee. Create a request with one line (qty 2). Then:
```ts
// allocate the worker → site added to worker.siteIds, status partial
await hr.post(`/manpower/${reqId}/allocate`).type("form").send({ lineDesignationId, kind: "worker", refId: workerId });
const w = await WorkerModel.findById(workerId).lean();
assert("worker site assigned on allocate", (w!.siteIds || []).map(String).includes(String(siteId)));
let r = await ManpowerRequestModel.findById(reqId).lean();
assert("status partial after 1 of 2", r!.status === "partial" && r!.allocations.length === 1);
// allocate the outsource → no site change, fills the line → fulfilled
await hr.post(`/manpower/${reqId}/allocate`).type("form").send({ lineDesignationId, kind: "outsource", refId: outsourceId });
r = await ManpowerRequestModel.findById(reqId).lean();
assert("status fulfilled after 2 of 2", r!.status === "fulfilled");
// PM cannot allocate (403)
const denied = await pm.post(`/manpower/${reqId}/allocate`).type("form").send({ lineDesignationId, kind: "worker", refId: workerId });
assert("PM blocked from allocating (403)", denied.status === 403);
```
(Create a site-scoped PM user assigned to the site for the 403 check; ensure the PM IS scoped to the site so the 403 is the capability gate, not scope.)

- [ ] **Step 5: Build + run + commit.**
```bash
npm run build && npm run e2e:manpower   # all PASS
git add src/routes/manpower.ts src/views/manpower/detail.ejs scripts/e2e_manpower.ts
git commit -m "feat(manpower): allocate/deallocate/cancel; allocating a worker assigns the site (can scan)"
```

---

### Task 5: Outsource employees (list / create / edit)

**Files:**
- Modify: `src/routes/manpower.ts` (outsource routes)
- Create: `src/views/manpower/outsource.ejs`
- Test: `scripts/e2e_manpower.ts`

**Interfaces:**
- Consumes: `OutsourceEmployeeModel`, `nextCode`, `DesignationModel`.
- Produces: `GET /manpower/outsource`, `POST /manpower/outsource`, `POST /manpower/outsource/:id`.

- [ ] **Step 1: Add routes** (before `export default router;`):
```ts
router.get("/manpower/outsource", requireCapability("allocate_manpower"), async (req: Request, res: Response) => {
  const [people, designations] = await Promise.all([
    OutsourceEmployeeModel.find().sort({ active: -1, name: 1 }).lean(),
    DesignationModel.find().sort({ name: 1 }).lean(),
  ]);
  res.render("manpower/outsource", { title: "Outsource employees · " + res.locals.company, active: "/manpower", people, designations });
});

router.post("/manpower/outsource", requireCapability("allocate_manpower"), async (req: Request, res: Response) => {
  const name = String(req.body.name ?? "").trim();
  if (!name) { flash(req, "danger", "Name is required."); return res.redirect("/manpower/outsource"); }
  const designationId = Types.ObjectId.isValid(String(req.body.designationId)) ? new Types.ObjectId(String(req.body.designationId)) : null;
  const desig = designationId ? await DesignationModel.findById(designationId).lean() : null;
  const code = await nextCode("OUT", "outsourceEmp", 4);
  await OutsourceEmployeeModel.create({
    code, name, designationId, designationName: desig?.name ?? null,
    outsourceCompany: String(req.body.outsourceCompany ?? "").trim() || null,
    payRate: Number(req.body.payRate) || null, phone: String(req.body.phone ?? "").trim() || null, active: true,
  });
  flash(req, "success", `Added ${name} (${code}).`);
  res.redirect("/manpower/outsource");
});

router.post("/manpower/outsource/:id", requireCapability("allocate_manpower"), async (req: Request, res: Response) => {
  const o = await OutsourceEmployeeModel.findById(req.params.id);
  if (!o) { flash(req, "danger", "Not found."); return res.redirect("/manpower/outsource"); }
  if (String(req.body.action) === "toggle") o.active = !o.active;
  else {
    o.name = String(req.body.name ?? o.name).trim() || o.name;
    o.outsourceCompany = String(req.body.outsourceCompany ?? "").trim() || null;
    o.payRate = Number(req.body.payRate) || null;
    o.phone = String(req.body.phone ?? "").trim() || null;
  }
  await o.save();
  flash(req, "success", "Saved.");
  res.redirect("/manpower/outsource");
});
```

- [ ] **Step 2: Create `outsource.ejs`** — an `oh-form-inline` "Add outsource employee" form (name, designation select, company, pay rate, phone) + an `oh-people oh-table--cards` list (Code, Name, Role, Company, Pay/day, Active toggle). A link to this page from `manpower/index.ejs` and `detail.ejs` (when `canAllocate`).

- [ ] **Step 3: Extend the e2e** — HR creates an outsource employee via POST, assert it exists with `code` matching `/^OUT-\d{4}$/` and `active===true`; toggle it inactive.

- [ ] **Step 4: Build + run + commit.**
```bash
npm run build && npm run e2e:manpower
git add src/routes/manpower.ts src/views/manpower/outsource.ejs scripts/e2e_manpower.ts
git commit -m "feat(manpower): outsource employees register (add/edit/toggle)"
```

---

### Task 6: Calendar board

**Files:**
- Modify: `src/routes/manpower.ts` (board route)
- Create: `src/views/manpower/board.ejs`
- Test: `scripts/e2e_manpower.ts`

**Interfaces:**
- Produces: `GET /manpower/board?siteId=&from=&to=`.

- [ ] **Step 1: Add the route** (place BEFORE `/manpower/:id` so "board" isn't captured as an id):
```ts
router.get("/manpower/board", requireCapability("view_manpower"), async (req: Request, res: Response) => {
  const u = req.currentUser!;
  const sites = await ProjectSiteModel.find(siteScopeFilter(u)).sort({ name: 1 }).select("name").lean();
  const siteId = String(req.query.siteId ?? (sites[0] ? String(sites[0]._id) : ""));
  if (!siteId || !Types.ObjectId.isValid(siteId) || !canUseSite(u, siteId)) {
    return res.render("manpower/board", { title: "Manpower board · " + res.locals.company, active: "/manpower", sites, siteId: "", days: [], rows: [], from: "", to: "" });
  }
  const today = new Date();
  const from = DATE_RE.test(String(req.query.from)) ? String(req.query.from) : new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(today);
  const toD = new Date(today); toD.setDate(toD.getDate() + 6);
  const to = DATE_RE.test(String(req.query.to)) ? String(req.query.to) : new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(toD);
  const days: string[] = [];
  for (let d = new Date(from + "T00:00:00"), end = new Date(to + "T00:00:00"); d <= end; d.setDate(d.getDate() + 1)) days.push(new Intl.DateTimeFormat("en-CA").format(d));
  // active (non-cancelled) requests overlapping the range
  const reqs = await ManpowerRequestModel.find({ siteId, status: { $ne: "cancelled" }, dateFrom: { $lte: to }, dateTo: { $gte: from } }).lean();
  // rows = one per (request line); cell = needed/filled on a given day (a request covers all days in its span)
  const rows = reqs.flatMap((r) => r.lines.map((l) => ({
    reqId: String(r._id), reqCode: r.reqCode, role: l.designationName, qty: l.qty,
    filled: r.allocations.filter((a) => String(a.lineDesignationId) === String(l.designationId)).length,
    spanFrom: r.dateFrom, spanTo: r.dateTo,
  })));
  res.render("manpower/board", { title: "Manpower board · " + res.locals.company, active: "/manpower", sites, siteId, from, to, days, rows });
});
```

- [ ] **Step 2: Create `board.ejs`** — a site `<select>` + from/to date filter (GET form). A grid: header row of `days` (short `MM-DD`), left column = `role (reqCode)`. Each cell: if the row's request span covers that day, show `filled/qty` (colour: `oh-badge--success` when filled≥qty else `oh-badge--warning`) linking to `/manpower/<reqId>`; else blank. Horizontal-scroll the grid inside an `oh-card` on mobile (the existing `.oh-card { overflow-x:auto }` handles it). Empty state when no rows.

- [ ] **Step 3: Extend the e2e** — GET `/manpower/board?siteId=<id>&from=&to=` as HR → 200, body contains the created request's `reqCode`.

- [ ] **Step 4: Build + run + commit.**
```bash
npm run build && npm run e2e:manpower
git add src/routes/manpower.ts src/views/manpower/board.ejs scripts/e2e_manpower.ts
git commit -m "feat(manpower): calendar board (site × days × role, filled/needed, click to allocate)"
```

---

### Task 7: Allocations report + CSV/PDF + Reports-hub tile

**Files:**
- Modify: `src/routes/manpower.ts` (report route)
- Create: `src/views/manpower/report.ejs`
- Modify: `src/routes/reports.ts` (hub tile)
- Test: `scripts/e2e_manpower.ts`

**Interfaces:**
- Consumes: `sendCsv`, `streamTablePdf` (from `lib/exporters`), `siteScopeFilter`.
- Produces: `GET /manpower/allocations` (+ `?format=csv|pdf`).

- [ ] **Step 1: Add the route** (BEFORE `/manpower/:id`):
```ts
router.get("/manpower/allocations", requireCapability("view_manpower"), async (req: Request, res: Response) => {
  const u = req.currentUser!;
  const reqs = await ManpowerRequestModel.find({ ...siteScopeFilter(u), status: { $ne: "cancelled" } }).sort({ createdAt: -1 }).limit(2000).lean();
  // one row per allocation
  const rows = reqs.flatMap((r) => r.allocations.map((a) => ({
    reqCode: r.reqCode, site: r.siteName, shift: r.shiftType, dateFrom: r.dateFrom, dateTo: r.dateTo,
    role: a.designationName ?? "", kind: a.kind, name: a.name, code: a.code ?? "", allocatedByName: a.allocatedByName ?? "",
  })));
  const format = String(req.query.format ?? "");
  if (format === "csv") {
    sendCsv(res, `allocations-${Date.now()}.csv`,
      ["Req", "Site", "Shift", "From", "To", "Role", "Type", "Name", "Code", "Allocated by"],
      rows.map((x) => [x.reqCode, x.site, x.shift, x.dateFrom, x.dateTo, x.role, x.kind, x.name, x.code, x.allocatedByName]));
    return;
  }
  if (format === "pdf") {
    const cols = [
      { header: "Req", key: "reqCode", pdf: 78 }, { header: "Site", key: "site", pdf: 110 }, { header: "Shift", key: "shift", pdf: 50 },
      { header: "From", key: "dateFrom", pdf: 64 }, { header: "To", key: "dateTo", pdf: 64 }, { header: "Role", key: "role", pdf: 90 },
      { header: "Type", key: "kind", pdf: 54 }, { header: "Name", key: "name", pdf: 120 }, { header: "Code", key: "code", pdf: 70 }, { header: "By", key: "allocatedByName", pdf: 80 },
    ];
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="allocations-${Date.now()}.pdf"`);
    streamTablePdf(rows.map((x) => ({ ...x })), cols, { title: `${res.locals.company} — Allocations`, subtitle: `${rows.length} allocations` }, res);
    return;
  }
  res.render("manpower/report", { title: "Allocations report · " + res.locals.company, active: "/manpower", rows, query: req.originalUrl.includes("?") ? req.originalUrl.slice(req.originalUrl.indexOf("?")) : "" });
});
```
Add imports at the top of manpower.ts: `import { sendCsv, streamTablePdf } from "../lib/exporters";`.

- [ ] **Step 2: Create `report.ejs`** — header + CSV/PDF buttons (links to `?format=csv` / `?format=pdf`, carrying `query`) + an `oh-people oh-table--cards` table of the rows (Req, Site, Shift, Dates, Role, Type, Name, Code, By). Empty state.

- [ ] **Step 3: Reports-hub tile.** In `src/routes/reports.ts` hub handler, after the existing tiles, push (gated by `view_manpower`):
```ts
  if (res.locals.can("view_manpower")) {
    reports.push({ href: "/manpower/allocations", icon: "engineering", title: "Allocations report",
      metric: "", unit: "", sub: "who is allocated where",
      desc: "Manpower allocations by site, role & date — CSV / PDF." });
  }
```
(Match the existing `reports.push({...})` shape; if `metric` must be non-empty, set a small count via a cheap `ManpowerRequestModel.countDocuments(siteScopeFilter(u))`.)

- [ ] **Step 4: Extend the e2e** — GET `/manpower/allocations` → 200 contains an allocated name; GET `?format=pdf` → 200, `content-type` includes `pdf`, body starts `%PDF`; GET `?format=csv` → 200, `content-type` includes `csv`.

- [ ] **Step 5: Build + run + commit.**
```bash
npm run build && npm run e2e:manpower
git add src/routes/manpower.ts src/views/manpower/report.ejs src/routes/reports.ts scripts/e2e_manpower.ts
git commit -m "feat(manpower): allocations report with CSV/PDF + reports-hub tile"
```

---

### Task 8: Full verification + push

- [ ] **Step 1: Full e2e.** Run every `npm run e2e:*` suite incl. `e2e:manpower`, `e2e:users`, `e2e:reports`. All PASS. Fix regressions.
- [ ] **Step 2: Build + doctor.** `npm run build` (0 errors); `npx react-doctor@latest --score --scope changed` — no regression.
- [ ] **Step 3: Mobile spot-check.** Headless screenshot `/manpower`, `/manpower/new`, a detail page, `/manpower/board` at the ≤768 layout (per the in/out mobile pass method): tables card-stack, board scrolls inside its card, forms stack. Fix overflow with the existing `oh-table--cards` / spine-card helper.
- [ ] **Step 4: Commit + push both branches.**
```bash
git push
git push origin feature/face-onboarding:main
```

---

## Self-Review

**Spec coverage:** caps+nav (T1) ✓; models+helpers (T2) ✓; request list/create/detail (T3) ✓; allocate/deallocate/cancel + site-assignment (T4) ✓; outsource employees (T5) ✓; calendar board (T6) ✓; allocations report + CSV/PDF + hub tile (T7) ✓; verification + mobile + push (T8) ✓. Decision 1 (worker allocation `$addToSet` siteIds; outsource plan-only) in T4. Decision 3 (per-line `lineDesignationId`) in models (T2) + allocate (T4).

**Type consistency:** `computeStatus(req)` + `nextCode(prefix,key,pad)` defined T2, used T3/T4/T5. `ManpowerRequestModel`/`OutsourceEmployeeModel` T2 → consumed T3–T7. Allocation shape `{kind,refId,code,name,lineDesignationId,designationName,allocatedBy,allocatedByName,allocatedAt}` consistent T2/T4. Caps `view_manpower`/`request_manpower`/`allocate_manpower` T1 → used in every route. Route ordering: `/manpower/board`, `/manpower/outsource`, `/manpower/allocations` declared BEFORE `/manpower/:id` (T6/T5/T7 note this).

**Placeholder scan:** route handlers are complete code; views are described with concrete components, post targets, and column lists. No "TBD"/"handle edge cases" in logic.
