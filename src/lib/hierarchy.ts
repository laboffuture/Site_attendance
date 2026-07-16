import { Types } from "mongoose";

import type { CurrentUser } from "../auth/types";
import { seesAllSites } from "../auth/permissions";
import { AttendanceModel } from "../models/Attendance";
import { BranchModel } from "../models/Branch";
import { FlagEventModel } from "../models/FlagEvent";
import { ProjectSiteModel } from "../models/ProjectSite";
import { WorkerModel } from "../models/Worker";
import { siteLocalDate, round2 } from "./time";

export interface SiteRollup {
  siteId: string;
  siteName: string;
  code: string;
  present: number; // distinct workers with an attendance row today
  active: number; // active enrolled workers
  otPending: number; // pending overtime hours
  flags: number; // unresolved wrong-site/anomaly flags
}

export interface BranchRollup {
  branchName: string;
  sites: SiteRollup[];
  totals: { present: number; active: number; otPending: number; flags: number };
}

/**
 * Builds the Branch → Site rollup shown on senior-role dashboards. Every site
 * in the user's scope appears (even with zero activity); numbers are computed
 * with four small grouped aggregations rather than per-site queries.
 */
export async function buildHierarchyRollup(user: CurrentUser): Promise<BranchRollup[]> {
  const all = seesAllSites(user.role);
  const siteFilter: Record<string, unknown> = all
    ? {}
    : { _id: { $in: user.assignedSiteIds.map((id) => new Types.ObjectId(id)) } };
  siteFilter.status = "active";

  const sites = await ProjectSiteModel.find(siteFilter).sort({ name: 1 }).lean();
  if (!sites.length) return [];

  const siteIds = sites.map((s) => s._id);
  const inScope = { siteId: { $in: siteIds } };
  const today = siteLocalDate();

  const [presentAgg, activeAgg, otAgg, flagAgg, branches] = await Promise.all([
    AttendanceModel.aggregate([
      { $match: { ...inScope, date: today } },
      { $group: { _id: "$siteId", n: { $sum: 1 } } },
    ]),
    WorkerModel.aggregate([
      { $match: { ...inScope, status: "active" } },
      { $group: { _id: "$siteId", n: { $sum: 1 } } },
    ]),
    AttendanceModel.aggregate([
      { $match: { ...inScope, "overtime.status": "pending" } },
      { $group: { _id: "$siteId", h: { $sum: "$overtime.computedHours" } } },
    ]),
    FlagEventModel.aggregate([
      { $match: { attemptedSiteId: { $in: siteIds }, resolved: false } },
      { $group: { _id: "$attemptedSiteId", n: { $sum: 1 } } },
    ]),
    BranchModel.find().lean(),
  ]);

  const present = new Map(presentAgg.map((a) => [String(a._id), a.n as number]));
  const active = new Map(activeAgg.map((a) => [String(a._id), a.n as number]));
  const ot = new Map(otAgg.map((a) => [String(a._id), a.h as number]));
  const flags = new Map(flagAgg.map((a) => [String(a._id), a.n as number]));
  const branchName = new Map(branches.map((b) => [String(b._id), b.name]));

  const byBranch = new Map<string, SiteRollup[]>();
  for (const s of sites) {
    const id = String(s._id);
    const row: SiteRollup = {
      siteId: id,
      siteName: s.name,
      code: s.code,
      present: present.get(id) ?? 0,
      active: active.get(id) ?? 0,
      otPending: round2(ot.get(id) ?? 0),
      flags: flags.get(id) ?? 0,
    };
    const bn = branchName.get(String(s.branchId)) ?? "—";
    if (!byBranch.has(bn)) byBranch.set(bn, []);
    byBranch.get(bn)!.push(row);
  }

  return [...byBranch.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([name, siteRows]) => ({
      branchName: name,
      sites: siteRows,
      totals: siteRows.reduce(
        (t, s) => ({
          present: t.present + s.present,
          active: t.active + s.active,
          otPending: round2(t.otPending + s.otPending),
          flags: t.flags + s.flags,
        }),
        { present: 0, active: 0, otPending: 0, flags: 0 },
      ),
    }));
}
