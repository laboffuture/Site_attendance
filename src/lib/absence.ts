import { Types } from "mongoose";

import type { CurrentUser } from "../auth/types";
import { AttendanceModel } from "../models/Attendance";
import { BranchModel } from "../models/Branch";
import { ProjectSiteModel } from "../models/ProjectSite";
import { WorkerModel } from "../models/Worker";
import type { ReportFilters } from "./report";
import { canUseSite, workerScopeFilter } from "./scope";
import { siteLocalDate } from "./time";

/** The attendance report only computes absentees over a bounded, sane range —
 *  an unbounded "All records" query would mean synthesizing a row for every
 *  worker on every day since they joined. */
export const ABSENCE_MAX_SPAN_DAYS = 31;
/** Hard ceiling on synthetic rows generated in one request, independent of the
 *  display cap — guards a very large roster even within the day-span limit. */
const ABSENCE_ROW_CAP = 5000;

/** Inclusive list of "YYYY-MM-DD" calendar dates, UTC-anchored so it's immune
 *  to server timezone/DST — these are plain calendar dates, not instants. */
function dateRange(from: string, to: string, maxDays: number): string[] {
  const [fy, fm, fd] = from.split("-").map(Number);
  const [ty, tm, td] = to.split("-").map(Number);
  const start = Date.UTC(fy, fm - 1, fd);
  const end = Date.UTC(ty, tm - 1, td);
  const out: string[] = [];
  for (let t = start; t <= end && out.length < maxDays; t += 86400000) {
    const dt = new Date(t);
    out.push(`${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, "0")}-${String(dt.getUTCDate()).padStart(2, "0")}`);
  }
  return out;
}

export type AbsentRow = {
  date: string;
  workerId: Types.ObjectId;
  empRegNo: string;
  workerName: string;
  designationName: string;
  siteId: Types.ObjectId;
  siteName: string;
  branchId: Types.ObjectId;
  branchName: string;
  inTime: null;
  outTime: null;
  totalHours: null;
  standardHours: null;
  overtime: { computedHours: 0; status: "none" };
  source: "absent";
};

/**
 * Synthesizes one row per (worker, date) in range with no attendance record —
 * "absent" — so the report doesn't silently skip people who never scanned.
 * Only runs for a bounded date range (`ABSENCE_MAX_SPAN_DAYS` or fewer); a
 * wider/unbounded range returns `skipped: true` instead of scanning history.
 * A worker only counts as eligible from their join date onward, up to today
 * (never into the future), and only if they're currently active/inactive —
 * the same roster the day-grid and dashboards use.
 */
export async function computeAbsentRows(
  user: CurrentUser,
  filters: ReportFilters,
): Promise<{ rows: AbsentRow[]; skipped: boolean; capped: boolean }> {
  if (!filters.dateFrom || !filters.dateTo || filters.dateFrom > filters.dateTo) {
    return { rows: [], skipped: true, capped: false };
  }
  const dates = dateRange(filters.dateFrom, filters.dateTo, ABSENCE_MAX_SPAN_DAYS + 1);
  if (dates.length > ABSENCE_MAX_SPAN_DAYS) {
    return { rows: [], skipped: true, capped: false };
  }
  const today = siteLocalDate();
  const eligibleDates = dates.filter((d) => d <= today);
  if (!eligibleDates.length) return { rows: [], skipped: false, capped: false };

  // Workers in scope, honoring the same site/designation/search filters as
  // the attendance query — so the absentee list matches what's on screen.
  const workerFilter: Record<string, unknown> = {
    ...workerScopeFilter(user),
    status: { $in: ["active", "inactive"] },
  };
  if (filters.designation) workerFilter.designationName = filters.designation;
  if (filters.q) {
    const rx = new RegExp(filters.q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    workerFilter.$or = [{ name: rx }, { empRegNo: rx }];
  }
  const siteFilterActive = !!filters.siteId && canUseSite(user, filters.siteId);
  if (siteFilterActive) workerFilter.siteIds = new Types.ObjectId(filters.siteId!);

  const workers = await WorkerModel.find(workerFilter)
    .select("empRegNo name designationName siteId siteIds dateJoined")
    .lean();
  if (!workers.length) return { rows: [], skipped: false, capped: false };

  // Attribute each worker to ONE site for absence purposes (they can only be
  // absent from one place per day): the filtered site if one is active,
  // otherwise their primary site — never both, to avoid double-counting a
  // multi-site worker as absent twice on the same day.
  const siteIds = [...new Set(workers.map((w) => String(siteFilterActive ? filters.siteId : w.siteId)))]
    .map((id) => new Types.ObjectId(id));
  const [sites, branches] = await Promise.all([
    ProjectSiteModel.find({ _id: { $in: siteIds } }).select("name branchId status").lean(),
    BranchModel.find().select("name").lean(),
  ]);
  const branchNameById = new Map(branches.map((b) => [String(b._id), b.name]));
  const siteMeta = new Map(
    sites.map((s) => [String(s._id), { name: s.name, branchId: s.branchId, branchName: branchNameById.get(String(s.branchId)) || "—" }]),
  );
  if (filters.branchId) {
    for (const [id, m] of siteMeta) if (String(m.branchId) !== filters.branchId) siteMeta.delete(id);
  }

  const workerIds = workers.map((w) => w._id);
  const present = await AttendanceModel.find({ workerId: { $in: workerIds }, date: { $in: eligibleDates } })
    .select("workerId date")
    .lean();
  const presentSet = new Set(present.map((p) => `${p.workerId}|${p.date}`));

  const rows: AbsentRow[] = [];
  let capped = false;
  outer: for (const w of workers) {
    const siteId = String(siteFilterActive ? filters.siteId : w.siteId);
    const meta = siteMeta.get(siteId);
    if (!meta) continue; // filtered out by branch, or site not in scope
    const joined = w.dateJoined ? siteLocalDate(new Date(w.dateJoined)) : "0000-00-00";
    for (const date of eligibleDates) {
      if (date < joined) continue;
      if (presentSet.has(`${w._id}|${date}`)) continue;
      if (rows.length >= ABSENCE_ROW_CAP) { capped = true; break outer; }
      rows.push({
        date,
        workerId: w._id,
        empRegNo: w.empRegNo,
        workerName: w.name,
        designationName: w.designationName,
        siteId: new Types.ObjectId(siteId),
        siteName: meta.name,
        branchId: meta.branchId,
        branchName: meta.branchName,
        inTime: null,
        outTime: null,
        totalHours: null,
        standardHours: null,
        overtime: { computedHours: 0, status: "none" },
        source: "absent",
      });
    }
  }
  return { rows, skipped: false, capped };
}
