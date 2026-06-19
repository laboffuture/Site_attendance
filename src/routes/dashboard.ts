import { Router, Request, Response } from "express";

import { requireAuth } from "../auth/middleware";
import { buildHierarchyRollup } from "../lib/hierarchy";
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
  const trendData = days.map((d) => trendMap.get(d) ?? 0);
  // Short, readable x-axis labels ("16 Jun") from the YYYY-MM-DD day keys.
  const trendLabels = days.map((d) =>
    new Intl.DateTimeFormat("en-GB", { day: "2-digit", month: "short", timeZone: "Asia/Kolkata" }).format(
      new Date(`${d}T00:00:00+05:30`),
    ),
  );
  // Headline figures for the card: today, daily average, and week-over-week trend.
  const trendSum = trendData.reduce((a, b) => a + b, 0);
  const trendAvg = Math.round((trendSum / trendData.length) * 10) / 10;
  const last7 = trendData.slice(-7).reduce((a, b) => a + b, 0);
  const prev7 = trendData.slice(-14, -7).reduce((a, b) => a + b, 0);
  let deltaDir: "up" | "down" | "flat" = "flat";
  let deltaPct = 0;
  if (prev7 > 0) {
    deltaPct = Math.round(((last7 - prev7) / prev7) * 100);
    deltaDir = deltaPct > 0 ? "up" : deltaPct < 0 ? "down" : "flat";
  } else if (last7 > 0) {
    deltaDir = "up";
  }
  const trend = {
    labels: trendLabels,
    data: trendData,
    today: trendData[trendData.length - 1],
    avg: trendAvg,
    deltaDir,
    deltaPct,
  };

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

  // Branch → site hierarchy rollup for senior roles (multi-site view).
  const senior = u.role === "management" || u.role === "hr" || u.role === "pm";
  const rollup = senior ? await buildHierarchyRollup(u) : null;

  res.render("dashboard", {
    title: "Dashboard · " + res.locals.company,
    active: "/dashboard",
    scopeLabel,
    stats: { todayCount, pendingOT, activeWorkers, unresolvedFlags },
    charts: { trend, otBySite, byDesignation },
    flags,
    rollup,
  });
});

export default router;
