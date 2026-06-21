# Daily Attendance Approval / Regularization — Design

**Date:** 2026-06-20
**Status:** Approved, ready for implementation.
**Source:** Rule Book v2 §4 + the role-responsibility image (Supervisor submits daily → PM recommends regularization → HR/Management approves). Builds on the scan-only attendance + shift/OT engine.

---

## Goal

Govern attendance through a daily approval chain: the **Site Supervisor submits** the day's scanned attendance (with a remark per worker) → the **PM recommends** it → **HR/Management approves** it, making it final for payroll. **Approval is the single path** — approving a day also approves its overtime. **No times are ever edited** (pure scan integrity).

## Locked decisions

| # | Decision |
|---|---|
| OT relationship | **Regularization subsumes OT approval.** Approving a day approves its OT in one step. The `/overtime` page becomes a **read-only filtered view** (records with OT + their regularization status); its approve/adjust/reject buttons are removed. |
| Corrections | **None.** PM/HR can only **approve or reject** what was scanned — no time edits anywhere. Scanned In/Out are immutable. |
| Grain | **Whole site-day batch**, with **per-worker reject**. Supervisor submits the site's day; PM recommends / HR approves the day in one action; a single bad worker-record can be rejected (with a reason) so it's excluded while the rest proceed. |
| State location | Per-record `attendanceStatus` on the `Attendance` doc; batch actions flip every record for a `{siteId, date}`. |

## Lifecycle

```
scanned ──submit(Supervisor)──▶ submitted ──recommend(PM)──▶ recommended ──approve(HR/Mgmt)──▶ approved
                                    │                              │
                                    └────── reject(per-worker, with reason) ──────▶ rejected (excluded)
```
`approved` is final for payroll; `rejected` is terminal (excluded, carries a reason).

## Data model (`Attendance`)

Add:
- `attendanceStatus: "scanned" | "submitted" | "recommended" | "approved" | "rejected"` (default `scanned`).
- `dailyRemark: String | null` (per-worker, "what they did today" — entered by the supervisor at submit).
- `submittedBy/At`, `recommendedBy/At`, `decidedBy/At` (ObjectId ref User + Date), `rejectReason: String | null`.

No time fields change. The existing `overtime.status` is driven by the chain: on **approve**, records with `overtime.computedHours > 0` get `overtime.status = "approved"`; on per-worker **reject**, `overtime.status = "rejected"`.

## Components

### 1. Supervisor — submit the day (`/attendance/submit`)
- Cap `submit_attendance` (supervisor, pm, hr, management). GET: pick site + date (their scoped sites) → roster of that site/date's records, each showing **read-only** scanned In/Out/total/OT + a **remark input per worker**.
- POST `/attendance/submit`: validates the site is in scope, then batch-sets every `Attendance` for `{siteId, date}` from `scanned → submitted`, storing each `dailyRemark`, `submittedBy`, `submittedAt`. One-way (already-submitted days are not re-submittable). Open/incomplete records (In, no Out) are carried through and shown flagged.

### 2. PM & HR — regularization queue (`/regularization`)
- Cap `view_regularization` (pm, hr, management). List `{siteId, date}` groups by status (a small aggregation over `Attendance`), scoped (`siteScopeFilter`): PM/HR/Mgmt per their sites; admins all. Tabs: **Submitted** (awaiting PM), **Recommended** (awaiting HR), **Decided**.
- POST `/regularization/:siteId/:date/recommend` — cap `recommend_attendance` (pm, management, super_admin): `submitted → recommended` for that site-day (records not individually rejected), set `recommendedBy/At`.
- POST `/regularization/:siteId/:date/approve` — cap `approve_attendance` (hr, management): `recommended → approved`; also flip `overtime.status` to approved for OT records; set `decidedBy/At`.
- POST `/regularization/worker/:attendanceId/reject` — cap `recommend_attendance` or `approve_attendance` (either step): one record `→ rejected` with `rejectReason`, `overtime.status = "rejected"`; excluded from the batch going forward.

### 3. `/overtime` becomes read-only
- The route still lists records with OT, showing `overtime.status` (now driven by regularization). The approve/adjust/reject form actions are removed; the page links to `/regularization` for action. (The OT model + `overtime.status` are unchanged; only the *approval entry point* moves.)

## Permissions (add to `src/auth/permissions.ts`)

- `submit_attendance: [supervisor, pm, hr, management, super_admin]`
- `view_regularization: [pm, hr, management, super_admin]`
- `recommend_attendance: [pm, management, super_admin]`
- `approve_attendance: [hr, management, super_admin]`

Site scope via existing `siteScopeFilter` / `canUseSite`. Nav: add **Regularization** (cap `view_regularization`) and a **Submit day** entry point on the Attendance page (cap `submit_attendance`).

## Reports

Reports already show OT status; add an **attendance-status filter** (approved vs pending) so payroll exports can be limited to `approved`. The "payable" total counts only `approved`.

## Testing

- `e2e_regularization` (new): supervisor submit (with remarks) → records `submitted`; PM recommend → `recommended`; HR approve → `approved` + OT `approved`; per-worker reject → that record `rejected`/excluded while the rest approve; scope (a PM can't act on another site's day).
- Rewrite `e2e_overtime`: assert the page is **read-only** (no approve/reject form) and that **day-approval** is what sets `overtime.status = approved`.
- Touch `e2e_reports` if it approves OT via the old buttons (re-point to the regularization approval).

## Out of scope / flag

- **No in-app fix for a missed clock-out.** With scan-only capture *and* no regularization edits, an open record (In, no Out) can't be completed or approved into payroll — the nightly sweep flags it and it stays unresolved. **Decide a sweep policy** separately (auto-close to shift end, or a narrow admin "close + reason"). Not built here.
- Travel/multi-site segments (#7) and MEP-supervisor mapping (#8) remain separate pieces.
