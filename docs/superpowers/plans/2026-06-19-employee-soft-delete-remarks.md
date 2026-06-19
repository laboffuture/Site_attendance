# Employee Soft-Delete + Remarks (#28) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give employees a soft-delete (mandatory reason, retained & hidden from the roster, reversible) and an append-only remarks log, as the foundation of the employee-lifecycle work.

**Architecture:** Extend the `Worker` Mongoose model with two new lifecycle states (`pending`, `deleted`) and an embedded append-only `remarks` array. Add admin-only routes for delete / restore / add-remark / clear-remark on the existing `/workers` surface, a status-tabbed list, and the matching edit-view UI. No new collection; reuses the existing `requireCapability` guard + `flash` + site-scope helpers.

**Tech Stack:** Node 22 · Express · TypeScript · Mongoose · EJS. Tests are the repo's e2e scripts (`scripts/e2e_*.ts`) run against a live local MongoDB; each prints `PASS`/`PASS` lines and exits non-zero on failure.

## Global Constraints

- Node `>=20` (`package.json` `engines`).
- All times/dates IST (`Asia/Kolkata`); not relevant to this PR (no time math).
- Follow existing patterns: `requireCapability("<cap>")` middleware, `flash(req, type, text)`, `siteScopeFilter(user)` for list queries, `canUseSite(user, siteId)` for per-record actions, `req.currentUser!` (`.id`, `.name`, `.role`).
- Build = `npm run build` (`tsc` + copy-assets). After any `.ejs` change, the dev server (`tsx watch`) serves `src/views` directly, but `npm run build` must still pass.
- This is **PR1 of 3** for the employee lifecycle (`docs/superpowers/specs/2026-06-19-employee-lifecycle-design.md`). Add the full 4-state enum now even though `pending` is only populated by PR2 (#25) — the "Pending approval" tab will simply be empty until then.
- Branch: `feature/employee-lifecycle` (already created; design doc already committed there).

---

### Task 1: Worker model (states + remarks + delete fields), `delete_worker` capability, soft-delete route + UI

**Files:**
- Modify: `src/models/Worker.ts`
- Modify: `src/auth/permissions.ts`
- Modify: `src/routes/workers.ts`
- Modify: `src/views/workers/edit.ejs`
- Test: `scripts/e2e_workers.ts`

**Interfaces:**
- Consumes: `requireCapability`, `flash`, `canUseSite`, `Types` (all already imported in `workers.ts`); `can(role, capability)` from `src/auth/permissions.ts`.
- Produces:
  - `WORKER_STATUS = ["pending","active","inactive","deleted"]`, `REMARK_TYPES = ["note","soft_delete","offload","conflict","registration","rejection"]` (exported from `Worker.ts`).
  - `Worker.remarks: { text, type, authorId, authorName, at, cleared, clearedBy, clearedAt }[]`, `Worker.deletedAt`, `Worker.deletedBy`.
  - Capability `"delete_worker"` (roles `super_admin`, `management`, `hr`).
  - Route `POST /workers/:id/delete` (form field `reason`).
  - Helper `pushRemark(worker, user, text, type)` in `workers.ts` — used by later tasks.

- [ ] **Step 1: Write the failing test** — append a new block to `scripts/e2e_workers.ts`, immediately before the `// Cleanup.` comment (line ~158). It reuses the `admin` agent and the worker `w` created earlier in the suite.

```ts
  // ---- #28: soft-delete requires a reason, sets deleted + a soft_delete remark ----
  const noReason = await admin.post(`/workers/${w!._id}/delete`).type("form").send({ reason: "" });
  assert("delete without a reason is rejected", noReason.status === 302);
  assert("worker still active after reasonless delete", (await WorkerModel.findById(w!._id))?.status === "active");

  await admin.post(`/workers/${w!._id}/delete`).type("form").send({ reason: "Left the project" });
  const deleted = await WorkerModel.findById(w!._id);
  assert("worker soft-deleted", deleted?.status === "deleted");
  assert("deletedAt + deletedBy recorded", !!deleted?.deletedAt && !!deleted?.deletedBy);
  assert("soft_delete remark appended with the reason",
    !!deleted && deleted.remarks.some((r) => r.type === "soft_delete" && r.text === "Left the project"));
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run e2e:workers`
Expected: FAIL — `POST /workers/:id/delete` 404s (route missing), so `deleted?.status` is still `"active"` and the new assertions print `FAIL`. (Earlier assertions still PASS.)

- [ ] **Step 3a: Add the states + remarks + delete fields to the model** — replace the top of `src/models/Worker.ts` (the `WORKER_STATUS` line and the `bankSchema`/`workerSchema` definitions) so it reads:

```ts
import { Schema, model, InferSchemaType } from "mongoose";

export const WORKER_STATUS = ["pending", "active", "inactive", "deleted"] as const;
export type WorkerStatus = (typeof WORKER_STATUS)[number];

export const REMARK_TYPES = ["note", "soft_delete", "offload", "conflict", "registration", "rejection"] as const;
export type RemarkType = (typeof REMARK_TYPES)[number];

// Append-only remark. "Clear" sets `cleared` (struck through, kept for audit) —
// entries are never removed or edited.
const remarkSchema = new Schema(
  {
    text: { type: String, required: true },
    type: { type: String, enum: [...REMARK_TYPES], default: "note" },
    authorId: { type: Schema.Types.ObjectId, ref: "User", default: null },
    authorName: { type: String, default: null },
    at: { type: Date, default: Date.now },
    cleared: { type: Boolean, default: false },
    clearedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    clearedAt: { type: Date, default: null },
  },
  { _id: false },
);

// Optional bank details (not mandatory at enrollment).
const bankSchema = new Schema(
  {
    accountHolderName: { type: String, default: null },
    accountNumber: { type: String, default: null },
    ifsc: { type: String, default: null },
    bankName: { type: String, default: null },
  },
  { _id: false },
);
```

Then, inside `workerSchema`, change the `status` field and add the new fields (replace the existing `status` + `dateJoined` lines):

```ts
    status: { type: String, enum: [...WORKER_STATUS], default: "active" },
    dateJoined: { type: Date, default: Date.now }, // date of joining

    // Lifecycle: append-only remarks + soft-delete audit (reason is a remark).
    remarks: { type: [remarkSchema], default: [] },
    deletedAt: { type: Date, default: null },
    deletedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
```

- [ ] **Step 3b: Add the `delete_worker` capability** — in `src/auth/permissions.ts`, add `"delete_worker"` to the `Capability` union (after `"manage_users"`) and add this entry to `CAPABILITY_ROLES` (after the `manage_users` line):

```ts
  delete_worker: ["super_admin", "management", "hr"],
```

- [ ] **Step 3c: Add the `pushRemark` helper + soft-delete route** — in `src/routes/workers.ts`, add `can` to the permissions import:

```ts
import { can, seesAllSites } from "../auth/permissions";
```

Add this helper just below the `flash` helper (after line ~24):

```ts
/** Append an audit remark to a hydrated worker doc (caller saves).
 *  Only `text` is required on the subdoc; `cleared`/`clearedBy`/`clearedAt`
 *  fall back to their schema defaults, so they're omitted here. */
function pushRemark(
  worker: InstanceType<typeof WorkerModel>,
  user: CurrentUser,
  text: string,
  type: string,
): void {
  worker.remarks.push({
    text,
    type,
    authorId: new Types.ObjectId(user.id),
    authorName: user.name,
    at: new Date(),
  });
}
```

If `tsc` rejects the partial push (Mongoose typings vary), append `as never` to the pushed object literal — the runtime shape is correct and defaults fill the rest.

Then add the route just above `export default router;`:

```ts
// ---- Soft-delete (admin) — mandatory reason, retained + hidden ----
router.post("/workers/:id/delete", requireCapability("delete_worker"), async (req: Request, res: Response) => {
  const worker = await WorkerModel.findById(req.params.id);
  if (!worker || !canUseSite(req.currentUser!, String(worker.siteId))) {
    flash(req, "danger", "Employee not found.");
    return res.redirect("/workers");
  }
  const reason = String(req.body.reason ?? "").trim();
  if (!reason) {
    flash(req, "danger", "A reason is required to delete an employee.");
    return res.redirect(`/workers/${req.params.id}/edit`);
  }
  if (worker.status === "deleted") {
    flash(req, "danger", "Employee is already deleted.");
    return res.redirect("/workers");
  }
  worker.status = "deleted";
  worker.deletedAt = new Date();
  worker.deletedBy = new Types.ObjectId(req.currentUser!.id);
  pushRemark(worker, req.currentUser!, reason, "soft_delete");
  await worker.save();
  flash(req, "success", `Employee ${worker.name} deleted.`);
  res.redirect("/workers");
});
```

- [ ] **Step 3d: Pass `canDelete` to the edit view + add the delete UI** — in `src/routes/workers.ts`, in the `GET /workers/:id/edit` handler, add `canDelete` to the render payload:

```ts
  res.render("workers/edit", {
    title: "Edit employee · " + res.locals.company,
    active: "/workers",
    worker,
    designations,
    sites,
    canDelete: can(req.currentUser!.role, "delete_worker"),
  });
```

In `src/views/workers/edit.ejs`, just before the final `<%- include('../partials/app-bottom') %>`, add a danger-zone card (shown only to admins, and only when the worker isn't already deleted):

```html
<% if (canDelete && worker.status !== 'deleted') { %>
<div class="oh-card oh-form-card" style="margin-top:1rem;border-color:var(--c-danger)">
  <h2 class="oh-section-title">Delete employee</h2>
  <p class="oh-muted">Soft-delete keeps the record and its history; the employee is hidden from the roster and can no longer clock in. A reason is required.</p>
  <form class="oh-form-inline" method="post" action="/workers/<%= worker._id %>/delete" onsubmit="return confirm('Soft-delete this employee?')">
    <div class="oh-input-group oh-grow">
      <label class="oh-label" for="reason">Reason</label>
      <input class="oh-input" id="reason" name="reason" required placeholder="e.g. left the project" />
    </div>
    <button class="oh-btn oh-btn--danger" type="submit">Delete</button>
  </form>
</div>
<% } %>
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm run build && npm run e2e:workers`
Expected: build OK; all existing PASS lines plus the new ones — `delete without a reason is rejected`, `worker still active after reasonless delete`, `worker soft-deleted`, `deletedAt + deletedBy recorded`, `soft_delete remark appended with the reason` → `E2E WORKERS PASSED`.

- [ ] **Step 5: Commit**

```bash
git add src/models/Worker.ts src/auth/permissions.ts src/routes/workers.ts src/views/workers/edit.ejs scripts/e2e_workers.ts
git commit -m "feat(employees): soft-delete with mandatory reason + remarks model"
```

---

### Task 2: Status-tabbed employee list (hide deleted from the roster; Archived + Pending tabs)

**Files:**
- Modify: `src/routes/workers.ts` (the `GET /workers` handler)
- Modify: `src/views/workers/index.ejs`
- Test: `scripts/e2e_workers.ts`

**Interfaces:**
- Consumes: `siteScopeFilter`, `WorkerModel`.
- Produces: `GET /workers?status=active|pending|archived` (default `active`); render payload gains `tab` (string) and `counts: { active, pending, archived }`.

- [ ] **Step 1: Write the failing test** — in `scripts/e2e_workers.ts`, immediately after the soft-delete block from Task 1 (the worker `w` is now `deleted`), add:

```ts
  // ---- #28: deleted worker hidden from the active roster, shown under Archived ----
  const activeList = await admin.get("/workers");
  assert("deleted worker hidden from active tab", !activeList.text.includes(w!.empRegNo));
  const archivedList = await admin.get("/workers?status=archived");
  assert("deleted worker shown under archived tab", archivedList.text.includes(w!.empRegNo));
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run e2e:workers`
Expected: FAIL — without tab filtering the active list still contains the deleted worker, so `deleted worker hidden from active tab` prints `FAIL`.

- [ ] **Step 3a: Filter the list query by tab** — in `src/routes/workers.ts`, replace the whole `GET /workers` handler with:

```ts
const STATUS_TABS: Record<string, string[]> = {
  active: ["active", "inactive"],
  pending: ["pending"],
  archived: ["deleted"],
};

// ---- List (status-tabbed) ----
router.get("/workers", requireCapability("enroll_worker"), async (req: Request, res: Response) => {
  const tab = STATUS_TABS[String(req.query.status)] ? String(req.query.status) : "active";
  const scope = siteScopeFilter(req.currentUser!);
  const [workers, active, pending, archived] = await Promise.all([
    WorkerModel.find({ ...scope, status: { $in: STATUS_TABS[tab] } }).sort({ createdAt: -1 }).lean(),
    WorkerModel.countDocuments({ ...scope, status: { $in: ["active", "inactive"] } }),
    WorkerModel.countDocuments({ ...scope, status: "pending" }),
    WorkerModel.countDocuments({ ...scope, status: "deleted" }),
  ]);
  res.render("workers/index", {
    title: "Employees · " + res.locals.company,
    active: "/workers",
    workers,
    tab,
    counts: { active, pending, archived },
  });
});
```

- [ ] **Step 3b: Render the tabs + a 4-state status badge** — in `src/views/workers/index.ejs`, add a top helper block and the tab row, and update both status badges to map all four states.

At the very top, after the `app-top` include (line 1), add:

```html
<%
  var statusBadge = { active: "success", inactive: "muted", pending: "warning", deleted: "danger" };
%>
```

Immediately after the `</div>` that closes `oh-page-header--row` (line ~11), insert:

```html
<div class="oh-filter-tabs">
  <a class="oh-filter-tab <%= tab === 'active' ? 'oh-filter-tab--active' : '' %>" href="/workers">Active (<%= counts.active %>)</a>
  <a class="oh-filter-tab <%= tab === 'pending' ? 'oh-filter-tab--active' : '' %>" href="/workers?status=pending">Pending (<%= counts.pending %>)</a>
  <a class="oh-filter-tab <%= tab === 'archived' ? 'oh-filter-tab--active' : '' %>" href="/workers?status=archived">Archived (<%= counts.archived %>)</a>
</div>
```

Replace the mobile badge (line ~27):

```html
        <span class="oh-m-badge oh-badge--<%= statusBadge[w.status] || 'muted' %>"><%= w.status %></span>
```

Replace the desktop badge (line ~60):

```html
          <span class="oh-badge oh-badge--<%= statusBadge[w.status] || 'muted' %>"><%= w.status %></span>
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm run build && npm run e2e:workers`
Expected: build OK; `deleted worker hidden from active tab` and `deleted worker shown under archived tab` PASS → `E2E WORKERS PASSED`.

- [ ] **Step 5: Commit**

```bash
git add src/routes/workers.ts src/views/workers/index.ejs scripts/e2e_workers.ts
git commit -m "feat(employees): status-tabbed roster (active/pending/archived)"
```

---

### Task 3: Restore a soft-deleted employee

**Files:**
- Modify: `src/routes/workers.ts`
- Modify: `src/views/workers/edit.ejs`
- Test: `scripts/e2e_workers.ts`

**Interfaces:**
- Consumes: `pushRemark`, `canUseSite`, `requireCapability("delete_worker")`.
- Produces: `POST /workers/:id/restore` (`deleted → active`).

- [ ] **Step 1: Write the failing test** — in `scripts/e2e_workers.ts`, after the Task 2 block (worker `w` is `deleted`), add:

```ts
  // ---- #28: restore returns a deleted worker to active ----
  await admin.post(`/workers/${w!._id}/restore`).type("form").send({});
  const restored = await WorkerModel.findById(w!._id);
  assert("restore returns worker to active", restored?.status === "active");
  assert("restore clears deletedAt", restored?.deletedAt == null);
  assert("restore appends a note remark", !!restored && restored.remarks.some((r) => r.type === "note" && /restored/i.test(r.text)));
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run e2e:workers`
Expected: FAIL — `POST /workers/:id/restore` 404s, so the worker stays `deleted` and `restore returns worker to active` prints `FAIL`.

- [ ] **Step 3a: Add the restore route** — in `src/routes/workers.ts`, just below the soft-delete route, add:

```ts
// ---- Restore (admin) — deleted → active ----
router.post("/workers/:id/restore", requireCapability("delete_worker"), async (req: Request, res: Response) => {
  const worker = await WorkerModel.findById(req.params.id);
  if (!worker || !canUseSite(req.currentUser!, String(worker.siteId))) {
    flash(req, "danger", "Employee not found.");
    return res.redirect("/workers");
  }
  if (worker.status !== "deleted") {
    flash(req, "danger", "Only a deleted employee can be restored.");
    return res.redirect("/workers");
  }
  worker.status = "active";
  worker.deletedAt = null;
  worker.deletedBy = null;
  pushRemark(worker, req.currentUser!, "Employee restored.", "note");
  await worker.save();
  flash(req, "success", `Employee ${worker.name} restored.`);
  res.redirect("/workers?status=archived");
});
```

- [ ] **Step 3b: Add the restore UI** — in `src/views/workers/edit.ejs`, just after the delete-card `<% } %>` you added in Task 1, add:

```html
<% if (canDelete && worker.status === 'deleted') { %>
<div class="oh-card oh-form-card" style="margin-top:1rem">
  <h2 class="oh-section-title">Restore employee</h2>
  <p class="oh-muted">This employee is archived (deleted). Restoring returns them to active.</p>
  <form method="post" action="/workers/<%= worker._id %>/restore">
    <button class="oh-btn oh-btn--secondary" type="submit">Restore to active</button>
  </form>
</div>
<% } %>
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm run build && npm run e2e:workers`
Expected: build OK; `restore returns worker to active`, `restore clears deletedAt`, `restore appends a note remark` PASS → `E2E WORKERS PASSED`.

- [ ] **Step 5: Commit**

```bash
git add src/routes/workers.ts src/views/workers/edit.ejs scripts/e2e_workers.ts
git commit -m "feat(employees): restore a soft-deleted employee"
```

---

### Task 4: Add + clear remarks (route + edit-view timeline)

**Files:**
- Modify: `src/routes/workers.ts`
- Modify: `src/views/workers/edit.ejs`
- Test: `scripts/e2e_workers.ts`

**Interfaces:**
- Consumes: `pushRemark`, `canUseSite`, `requireCapability`.
- Produces: `POST /workers/:id/remarks` (field `text`, capability `enroll_worker`); `POST /workers/:id/remarks/:idx/clear` (capability `delete_worker`).

- [ ] **Step 1: Write the failing test** — in `scripts/e2e_workers.ts`, after the Task 3 block (worker `w` is now `active` again), add:

```ts
  // ---- #28: add a remark, then clear it (struck through but retained) ----
  const emptyRemark = await admin.post(`/workers/${w!._id}/remarks`).type("form").send({ text: "" });
  assert("empty remark rejected", emptyRemark.status === 302);

  await admin.post(`/workers/${w!._id}/remarks`).type("form").send({ text: "Spoke to site lead" });
  let wr = await WorkerModel.findById(w!._id);
  const noteIdx = wr!.remarks.findIndex((r) => r.text === "Spoke to site lead");
  assert("note remark added", noteIdx >= 0 && wr!.remarks[noteIdx].type === "note");

  await admin.post(`/workers/${w!._id}/remarks/${noteIdx}/clear`).type("form").send({});
  wr = await WorkerModel.findById(w!._id);
  assert("remark cleared but retained", !!wr && wr.remarks.length > noteIdx && wr.remarks[noteIdx].cleared === true && wr.remarks[noteIdx].text === "Spoke to site lead");
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run e2e:workers`
Expected: FAIL — `POST /workers/:id/remarks` 404s, so `note remark added` prints `FAIL`.

- [ ] **Step 3a: Add the remark routes** — in `src/routes/workers.ts`, just below the restore route, add:

```ts
// ---- Remarks: add a note (scoped editors) ----
router.post("/workers/:id/remarks", requireCapability("enroll_worker"), async (req: Request, res: Response) => {
  const worker = await WorkerModel.findById(req.params.id);
  if (!worker || !canUseSite(req.currentUser!, String(worker.siteId))) {
    flash(req, "danger", "Employee not found.");
    return res.redirect("/workers");
  }
  const text = String(req.body.text ?? "").trim();
  if (!text) {
    flash(req, "danger", "Remark text is required.");
    return res.redirect(`/workers/${req.params.id}/edit`);
  }
  pushRemark(worker, req.currentUser!, text, "note");
  await worker.save();
  flash(req, "success", "Remark added.");
  res.redirect(`/workers/${req.params.id}/edit`);
});

// ---- Remarks: clear one (admin) — struck through, kept for audit ----
router.post("/workers/:id/remarks/:idx/clear", requireCapability("delete_worker"), async (req: Request, res: Response) => {
  const worker = await WorkerModel.findById(req.params.id);
  if (!worker || !canUseSite(req.currentUser!, String(worker.siteId))) {
    flash(req, "danger", "Employee not found.");
    return res.redirect("/workers");
  }
  const idx = Number(req.params.idx);
  if (!Number.isInteger(idx) || idx < 0 || idx >= worker.remarks.length) {
    flash(req, "danger", "Remark not found.");
    return res.redirect(`/workers/${req.params.id}/edit`);
  }
  const r = worker.remarks[idx];
  if (!r.cleared) {
    r.cleared = true;
    r.clearedBy = new Types.ObjectId(req.currentUser!.id);
    r.clearedAt = new Date();
    await worker.save();
  }
  flash(req, "success", "Remark cleared.");
  res.redirect(`/workers/${req.params.id}/edit`);
});
```

- [ ] **Step 3b: Render the remarks timeline + add box** — in `src/views/workers/edit.ejs`, just before the final `<%- include('../partials/app-bottom') %>` (after the restore card), add:

```html
<div class="oh-card oh-form-card" style="margin-top:1rem">
  <h2 class="oh-section-title">Remarks</h2>
  <% if (worker.remarks && worker.remarks.length) { %>
  <table class="oh-table">
    <tbody>
      <% worker.remarks.forEach(function (r, i) { %>
      <tr>
        <td<%= r.cleared ? ' style="text-decoration:line-through;color:var(--c-text-muted)"' : '' %>>
          <span class="oh-badge oh-badge--muted"><%= r.type %></span>
          <%= r.text %>
          <span class="oh-muted">— <%= r.authorName || 'system' %>, <%= r.at ? new Date(r.at).toLocaleString('en-GB', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' }) : '' %></span>
        </td>
        <td class="oh-col-action">
          <% if (canDelete && !r.cleared) { %>
          <form method="post" action="/workers/<%= worker._id %>/remarks/<%= i %>/clear" style="margin:0">
            <button class="oh-btn oh-btn--small" type="submit">Clear</button>
          </form>
          <% } %>
        </td>
      </tr>
      <% }); %>
    </tbody>
  </table>
  <% } else { %>
  <p class="oh-muted">No remarks yet.</p>
  <% } %>
  <form class="oh-form-inline" method="post" action="/workers/<%= worker._id %>/remarks" style="margin-top:0.75rem">
    <div class="oh-input-group oh-grow">
      <label class="oh-label" for="remarkText">Add a remark</label>
      <input class="oh-input" id="remarkText" name="text" required placeholder="note about this employee" />
    </div>
    <button class="oh-btn oh-btn--secondary" type="submit">Add</button>
  </form>
</div>
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm run build && npm run e2e:workers`
Expected: build OK; `empty remark rejected`, `note remark added`, `remark cleared but retained` PASS → `E2E WORKERS PASSED`.

- [ ] **Step 5: Run the full suite for regressions**

Run: `npm run e2e:login && npm run e2e:org && npm run e2e:workers && npm run e2e:station && npm run e2e:overtime && npm run e2e:reports && npm run e2e:users && npm run e2e:hierarchy && npm run e2e:attendance && npm run e2e:missed && npm run e2e:requests && npm run e2e:supervisor`
Expected: every suite prints its `... PASSED` line. (`e2e:geo` needs the GPS fixture; run it too if your environment has it.)

- [ ] **Step 6: Commit**

```bash
git add src/routes/workers.ts src/views/workers/edit.ejs scripts/e2e_workers.ts
git commit -m "feat(employees): add + clear remarks with audit timeline"
```

---

## Notes for PR2 / PR3 (not this plan)

- **PR2 (#25):** adds `registration` to `REQUEST_TYPES`, routes Supervisor/PM enrollment through `pending → recommend → admin decide`, and flips the worker to `active` on approve / `deleted` (with a `rejection` remark) on reject. The `pending` tab built here starts populating then.
- **PR3 (#29):** conflict scan on `POST /workers` (phone/email/empRegNo against non-pending records), `returning_worker_conflict` FlagEvent, `conflictWithIds` on the request, prior-remarks display in the queue.

Each gets its own plan via the writing-plans skill once the prior PR merges.
