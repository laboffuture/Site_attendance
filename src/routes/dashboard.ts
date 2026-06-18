import { Router, Request, Response } from "express";

import { requireAuth } from "../auth/middleware";
import { siteScopeFilter, flagScopeFilter } from "../lib/scope";
import { siteLocalDate, round2 } from "../lib/time";
import { AttendanceModel } from "../models/Attendance";
import { FlagEventModel } from "../models/FlagEvent";
import { WorkerModel } from "../models/Worker";

const router = Router();

router.get("/dashboard", requireAuth, async (req: Request, res: Response) => {
  const u = req.currentUser!;
  const scope = siteScopeFilter(u);
  const flagScope = flagScopeFilter(u);
  const today = siteLocalDate();

  let scopeLabel: string;
  if (u.role === "management" || u.role === "hr") scopeLabel = "All branches & sites";
  else if (u.role === "pm") scopeLabel = `${u.assignedSiteIds.length} assigned site(s)`;
  else scopeLabel = "Own site";

  // Summary stats
  const [todayCount, pendingOT, activeWorkers, unresolvedFlags] = await Promise.all([
    AttendanceModel.countDocuments({ ...scope, date: today }),
    AttendanceModel.countDocuments({ ...scope, "overtime.status": "pending" }),
    WorkerModel.countDocuments({ ...scope, status: "active" }),
    FlagEventModel.countDocuments({ ...flagScope, resolved: false }),
  ]);

  // Chart 1: attendance trend (last 14 days)
  const days: string[] = [];
  for (let i = 13; i >= 0; i--) days.push(siteLocalDate(new Date(Date.now() - i * 86_400_000)));
  const trendAgg = await AttendanceModel.aggregate([
    { $match: { ...scope, date: { $gte: days[0] } } },
    { $group: { _id: "$date", count: { $sum: 1 } } },
  ]);
  const trendMap = new Map(trendAgg.map((t) => [t._id as string, t.count as number]));
  const trend = { labels: days, data: days.map((d) => trendMap.get(d) ?? 0) };

  // Chart 2: overtime hours by site (pending + approved)
  const otAgg = await AttendanceModel.aggregate([
    { $match: { ...scope, "overtime.status": { $in: ["pending", "approved"] } } },
    { $group: { _id: "$siteName", hours: { $sum: "$overtime.computedHours" } } },
    { $sort: { hours: -1 } },
    { $limit: 10 },
  ]);
  const otBySite = {
    labels: otAgg.map((o) => o._id as string),
    data: otAgg.map((o) => round2(o.hours as number)),
  };

  // Chart 3: active headcount by designation
  const desigAgg = await WorkerModel.aggregate([
    { $match: { ...scope, status: "active" } },
    { $group: { _id: "$designationName", count: { $sum: 1 } } },
    { $sort: { count: -1 } },
    { $limit: 12 },
  ]);
  const byDesignation = {
    labels: desigAgg.map((d) => d._id as string),
    data: desigAgg.map((d) => d.count as number),
  };

  // Recent unresolved flags
  const flags = await FlagEventModel.find({ ...flagScope, resolved: false })
    .sort({ timestamp: -1 })
    .limit(8)
    .lean();

  res.render("dashboard", {
    title: "Dashboard · " + res.locals.company,
    active: "/dashboard",
    scopeLabel,
    stats: { todayCount, pendingOT, activeWorkers, unresolvedFlags },
    charts: { trend, otBySite, byDesignation },
    flags,
  });
});

export default router;
