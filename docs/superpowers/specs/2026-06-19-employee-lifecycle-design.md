# Employee Lifecycle — Design (#28 soft-delete + remarks · #25 registration approval · #29 returning-worker conflict)

**Date:** 2026-06-19
**Status:** Approved, ready for implementation.
**Source:** `PROJECT_STATUS.md` PENDING → "Employee lifecycle". Builds on the
existing `Request` approval subsystem (`src/routes/requests.ts`,
`src/models/Request.ts`) and `Worker` model (`src/models/Worker.ts`).

---

## Goal

Give employees a full lifecycle: a reviewed **registration** (Supervisor/PM
registrations are approved before the worker becomes active), **soft-delete**
with retained history and remarks, and **returning-worker conflict** detection
that catches someone re-registered under a new ID and routes them to admin
re-approval.

## Locked decisions

| # | Decision |
|---|---|
| Lifecycle states | `pending` / `active` / `inactive` / `deleted` (was `active`/`inactive`). |
| Remarks | Append-only log; "clear" strikes through but keeps the entry (audit). |
| Offload vs delete | Offload → `inactive` (reversible, existing). Soft-delete → `deleted` (separate admin action, mandatory reason, retained & hidden). |
| Conflict trigger | Any single strong field matches: **phone OR email OR Employee ID** against existing records. Name alone never triggers. |
| Notify | In-app: a `returning_worker_conflict` FlagEvent + the registration lands in the existing `/requests` queue with prior remarks shown. No email/SMS. |
| Approval chain | Admin group enroll directly to `active`. Supervisor/PM enrollments → `pending` → (PM recommends) → admin decides. Any conflict forces *any* registration into the chain. |
| Approval mechanism | **Approach A** — reuse the `Request` subsystem with a new `registration` type (one queue, one recommend→decide flow). |
| Build order | **#28 → #25 → #29** (foundation → approval chain → conflict routes into the real queue). Three PRs. |

---

## 1. Data model

### `Worker` (`src/models/Worker.ts`)
- `status`: `["pending", "active", "inactive", "deleted"]`. Default `active`
  (admin direct enroll); the registration flow sets `pending`.
- `remarks: [RemarkSchema]` — append-only. Each entry:
  `{ text, type, authorId, authorName, at, cleared: bool, clearedBy, clearedAt }`,
  `type ∈ note | soft_delete | offload | conflict | registration | rejection`.
- `deletedAt: Date|null`, `deletedBy: ObjectId|null` — quick audit/sort; the
  delete *reason* is a `soft_delete` remark.
- `empRegNo` stays unique across all statuses (deleted records are retained, so
  IDs are never reused; a returning worker gets a new ID, linked via the
  conflict — not by reusing the old ID).

### `Request` (`src/models/Request.ts`)
- `REQUEST_TYPES` += `"registration"`. A registration request references the
  freshly-created `pending` worker; all existing requester / recommend / decide
  fields apply. `date`/time fields stay null for this type.
- `conflictWithIds: [ObjectId]` (ref `Worker`, default `[]`) — prior matching
  records, so the queue can render their remarks.

### `FlagEvent` (`src/models/FlagEvent.ts`)
- `FLAG_TYPES` += `"returning_worker_conflict"`. Reuses `workerId`/`workerName`
  (the new pending worker) and `attemptedSiteId`/`attemptedSiteName` (the
  registration site, so existing flag scoping applies). New
  `relatedRequestId: ObjectId|null` links the flag to the registration request.
  The flag auto-resolves when that request is decided.

## 2. Soft-delete + remarks (#28 — PR1)

New routes in `src/routes/workers.ts`:
- `POST /workers/:id/delete` — capability `delete_worker` (admin group);
  **mandatory reason**; sets `status: deleted`, `deletedAt/By`, appends a
  `soft_delete` remark. No-op with a flash if already deleted.
- `POST /workers/:id/restore` — `delete_worker`; `deleted → active`, appends a
  `note` remark. Makes "soft" delete reversible.
- `POST /workers/:id/remarks` — add a `note` (capability `enroll_worker`,
  site-scoped). Empty text rejected.
- `POST /workers/:id/remarks/:idx/clear` — mark a remark `cleared`
  (`delete_worker`). Idempotent.

Employee list (`/workers`) gains status tabs:
- **Active** (default) — `status ∈ {active, inactive}` (the working roster).
- **Pending approval** — `status: pending`; links to the `/requests` queue.
- **Archived** — `status: deleted`, showing delete reason + remarks.

Edit view shows the remarks timeline (cleared entries struck through) with an
add-remark box and (admin) clear buttons; a Delete action with a required
reason; a Restore action on archived employees.

## 3. Registration approval chain (#25 — PR2)

Modify `POST /workers` (enrollment):
1. Validate + encode face (unchanged).
2. Determine the route:
   - **Admin group** (`super_admin`/`management`/`hr`) → create `active`
     directly (unchanged behavior).
   - **Supervisor** → create `pending` + a `registration` Request with status
     `pending` (→ PM recommends → admin decides).
   - **PM** → create `pending` + a `registration` Request pre-set to
     `recommended` (the PM's own act is the recommendation) → admin decides.
3. Decisions (`src/routes/requests.ts` `decide`):
   - **approve** → worker `status: active`; append a `registration` remark;
     resolve any related conflict flag.
   - **reject** → worker `status: deleted`; the rejection reason becomes a
     `rejection` remark (the pending record is retained, not hard-deleted).

The `/requests` list already filters by type-agnostic status; registration
requests appear in the existing Pending/Recommended/Decided tabs, scoped by
site. Pending workers never match at the station (scan filters `status:
active`), so they cannot clock in until approved.

## 4. Returning-worker conflict (#29 — PR3)

In `POST /workers`, before deciding the route, run a **conflict scan**: find
existing records with `status ∈ {active, inactive, deleted}` (exclude `pending`)
where `phone`, `email`, or `empRegNo` matches the submitted values (non-empty
fields only; phone/email compared case-insensitively/trimmed). Collect matches
into `conflictWithIds`.

If there are matches:
- Force the registration into the approval chain **regardless of role** (an
  admin who would normally create `active` directly instead gets a `pending`
  worker + a `registration` Request pre-set to `recommended` so they can decide
  it in the queue after seeing prior remarks).
- Raise a `returning_worker_conflict` FlagEvent linked to the new worker + the
  request.
- The `/requests` queue and the conflict flag both display the prior records'
  remarks (loaded via `conflictWithIds`).

On approve/reject the flag auto-resolves (mirrors the request decision).

## 5. Permissions & scope

- New capability `delete_worker` → `["super_admin", "management", "hr"]`.
- Registration approvals reuse `recommend_request` (PM + super_admin) and
  `decide_request` (admin group) — already defined.
- Remark add → `enroll_worker` (site-scoped); remark clear / delete / restore →
  `delete_worker`.
- Site scope unchanged: `siteScopeFilter` gates lists; `canUseSite` gates
  actions. Pending/deleted workers keep their `siteId`, so they stay scoped.

## 6. Testing (per PR; full suite stays green)

- **PR1 (#28):** extend `e2e_workers` — delete requires a reason; deleted hidden
  from the active tab, present in archived; restore returns to active; add a
  remark; clear strikes it through (entry retained).
- **PR2 (#25):** extend `e2e_requests` (or a new `e2e_registration`) —
  supervisor enroll → pending worker + pending request; PM recommends; admin
  approves → active; admin reject → deleted with a rejection remark; pending
  worker cannot be matched at the station.
- **PR3 (#29):** conflict case — enroll with a phone/email/ID matching a deleted
  worker → pending + `returning_worker_conflict` flag + request carrying
  `conflictWithIds`; queue shows prior remarks; admin approve → active + flag
  resolved. Name-only overlap does **not** trigger.

## 7. Out of scope

- Email/SMS delivery (notify is in-app only; a future hook).
- Hard delete / data purge (retention/DPDP is a separate compliance task).
- Changes to the offload flow (stays → `inactive`).
- Salary/wage and the mobile Capacitor app (separate tracks).
