import { Router, Request, Response } from "express";
import { Types } from "mongoose";

import { requireAuth } from "../auth/middleware";
import { seesAllSites } from "../auth/permissions";
import { buildHierarchyRollup } from "../lib/hierarchy";
import { canUseSite, siteScopeFilter, flagScopeFilter } from "../lib/scope";
import { siteLocalDate, istHM, round2 } from "../lib/time";
import { AttendanceModel } from "../models/Attendance";
import { FlagEventModel } from "../models/FlagEvent";
import { ProjectSiteModel } from "../models/ProjectSite";
import { WorkerModel } from "../models/Worker";

const router = Router();

router.get("/dashboard", requireAuth, async (req: Request, res: Response) => {
  const u = req.currentUser!;
  const today = siteLocalDate();

  // Sites the user can pick in the dashboard filter.
  const mySites = seesAllSites(u.role)
    ? await ProjectSiteModel.find().sort({ name: 1 }).lean()
    : await ProjectSiteModel.find({
        _id: { $in: u.assignedSiteIds.map((id) => new Types.ObjectId(id)) },
      })
        .sort({ name: 1 })
        .lean();

  // Optional single-site filter (only a site the user actually has).
  const requestedSiteId = typeof req.query.siteId === "string" ? req.query.siteId : "";
  const selectedSiteId =
    requestedSiteId && mySites.some((s) => String(s._id) === requestedSiteId) ? requestedSiteId : "";

  // ---------------------------------------------------------------------------
  // Level 3 — a dedicated, complete page for one site. An out-of-scope or
  // unknown siteId redirects back to the all-sites view with a danger flash,
  // rather than silently falling through to the rollup.
  // ---------------------------------------------------------------------------
  if (requestedSiteId) {
    const valid = Types.ObjectId.isValid(requestedSiteId);
    if (!valid || !canUseSite(u, requestedSiteId) || !selectedSiteId) {
      req.session.flash = { type: "danger", text: "That site isn't in your scope." };
      return res.redirect("/dashboard");
    }

    const site = mySites.find((s) => String(s._id) === selectedSiteId)!;
    const siteOid = new Types.ObjectId(selectedSiteId);
    const siteScope = { siteId: siteOid };

    const [activeWorkers, todayRows, otRows, siteFlags] = await Promise.all([
      WorkerModel.countDocuments({ ...siteScope, status: "active" }),
      AttendanceModel.find({ ...siteScope, date: today }).sort({ inTime: 1 }).lean(),
      AttendanceModel.find({ ...siteScope, "overtime.status": { $in: ["pending", "approved"] } })
        .sort({ date: -1, inTime: -1 })
        .limit(50)
        .lean(),
      FlagEventModel.find({ attemptedSiteId: siteOid, resolved: false })
        .sort({ timestamp: -1 })
        .limit(8)
        .lean(),
    ]);

    // Today's roster rows in the shape the view renders (In/Out/Total/OT).
    const roster = todayRows.map((r) => ({
      workerName: r.workerName,
      empRegNo: r.empRegNo,
      inTime: istHM(r.inTime),
      outTime: istHM(r.outTime),
      totalHours: r.totalHours != null ? round2(r.totalHours) : null,
      otHours: r.overtime?.computedHours ? round2(r.overtime.computedHours) : 0,
      otStatus: r.overtime?.status ?? "none",
    }));

    const ot = otRows.map((r) => ({
      date: r.date,
      workerName: r.workerName,
      empRegNo: r.empRegNo,
      inTime: istHM(r.inTime),
      outTime: istHM(r.outTime),
      computedHours: round2(r.overtime?.computedHours ?? 0),
      approvedHours: r.overtime?.approvedHours != null ? round2(r.overtime.approvedHours) : null,
      status: r.overtime?.status ?? "none",
    }));

    const present = todayRows.length;
    const otHoursTotal = round2(
      otRows
        .filter((r) => r.overtime?.status === "pending")
        .reduce((sum, r) => sum + (r.overtime?.computedHours ?? 0), 0),
    );

    const shift = site.shifts?.day;
    return res.render("dashboard-site", {
      title: `${site.name} · ${res.locals.company}`,
      active: "/dashboard",
      site: {
        id: String(site._id),
        name: site.name,
        code: site.code,
        startTime: shift?.startTime || site.standardStartTime || "—",
        endTime: shift?.endTime || site.standardEndTime || "—",
        geofenceRadiusMeters: site.geofenceRadiusMeters ?? null,
      },
      summary: { present, active: activeWorkers, otHours: otHoursTotal, flags: siteFlags.length },
      roster,
      ot,
      flags: siteFlags,
    });
  }

  const scope = siteScopeFilter(u);
  const flagScope = flagScopeFilter(u);

  let scopeLabel: string;
  if (seesAllSites(u.role)) {
    scopeLabel = "All branches & sites";
  } else {
    scopeLabel = `${u.assignedSiteIds.length} assigned site(s)`;
  }

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
  const senior = seesAllSites(u.role) || u.role === "pm";
  const rollup = senior ? await buildHierarchyRollup(u) : null;

  // Present-vs-active per site (visual bar) — across the sites in scope. Drawn
  // for any multi-site user (PM/Supervisor included) and when not filtered to one.
  let presenceBySite: { labels: string[]; present: number[]; active: number[] } | null = null;
  if (mySites.length > 1) {
    const siteIds = mySites.map((s) => s._id);
    const [presentAgg, activeAgg] = await Promise.all([
      AttendanceModel.aggregate([
        { $match: { siteId: { $in: siteIds }, date: today } },
        { $group: { _id: "$siteId", n: { $sum: 1 } } },
      ]),
      WorkerModel.aggregate([
        { $match: { siteId: { $in: siteIds }, status: "active" } },
        { $group: { _id: "$siteId", n: { $sum: 1 } } },
      ]),
    ]);
    const presentMap = new Map(presentAgg.map((a) => [String(a._id), a.n as number]));
    const activeMap = new Map(activeAgg.map((a) => [String(a._id), a.n as number]));
    presenceBySite = {
      labels: mySites.map((s) => s.code || s.name),
      present: mySites.map((s) => presentMap.get(String(s._id)) ?? 0),
      active: mySites.map((s) => activeMap.get(String(s._id)) ?? 0),
    };
  }

  // The user's assigned locations, shown as chips on the dashboard.
  const myLocations = mySites.map((s) => `${s.name} (${s.code})`);

  res.render("dashboard", {
    title: "Dashboard · " + res.locals.company,
    active: "/dashboard",
    scopeLabel,
    mySites,
    selectedSiteId,
    myLocations,
    seesAll: seesAllSites(u.role),
    stats: { todayCount, pendingOT, activeWorkers, unresolvedFlags },
    charts: { trend, otBySite, byDesignation, presenceBySite },
    flags,
    rollup,
  });
});

export default router;
