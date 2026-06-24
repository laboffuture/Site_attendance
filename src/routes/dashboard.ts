import { Router, Request, Response } from "express";
import { Types } from "mongoose";

import { requireAuth } from "../auth/middleware";
import { seesAllSites } from "../auth/permissions";
import { config } from "../config";
import { buildHierarchyRollup } from "../lib/hierarchy";
import { computePayroll, otExposure, ymd } from "../lib/payroll";
import { canUseSite, siteScopeFilter, flagScopeFilter } from "../lib/scope";
import { siteLocalDate, istHM, round2 } from "../lib/time";
import { AttendanceModel } from "../models/Attendance";
import { FlagEventModel } from "../models/FlagEvent";
import { ProjectSiteModel } from "../models/ProjectSite";
import { RequestModel } from "../models/Request";
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
  // Level 3 — a dedicated, complete page for one site.
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

  // ===========================================================================
  // All-sites executive briefing.
  // ===========================================================================
  const scope = siteScopeFilter(u);
  const flagScope = flagScopeFilter(u);
  const seesAll = seesAllSites(u.role);
  const STD = config.payrollStandardHours;
  const MULT = config.otMultiplier;
  const TARGET = config.attendanceTarget;
  const scopeLabel = seesAll ? "All branches & sites" : `${u.assignedSiteIds.length} assigned site(s)`;

  const monthStart = today.slice(0, 8) + "01";
  const wkd = new Date(today + "T00:00:00");
  const mon = new Date(wkd);
  mon.setDate(wkd.getDate() - ((wkd.getDay() + 6) % 7));
  const weekStart = ymd(mon);

  // NEEDS-YOU counters + headline figures.
  const [todayCount, pendingOT, activeWorkers, unresolvedFlags, pendingReg, pendingReq, otExp] = await Promise.all([
    AttendanceModel.countDocuments({ ...scope, date: today }),
    AttendanceModel.countDocuments({ ...scope, "overtime.status": "pending" }),
    WorkerModel.countDocuments({ ...scope, status: "active" }),
    FlagEventModel.countDocuments({ ...flagScope, resolved: false }),
    AttendanceModel.countDocuments({ ...scope, attendanceStatus: { $in: ["submitted", "recommended"] } }),
    RequestModel.countDocuments({ ...scope, status: { $in: ["pending", "recommended"] } }),
    otExposure({ ...scope, "overtime.status": "pending" }),
  ]);
  const pct = activeWorkers ? Math.round((todayCount / activeWorkers) * 100) : 0;
  const needsYouTotal = pendingOT + pendingReg + pendingReq + unresolvedFlags;
  const verdictTone =
    pct < TARGET - 10 || unresolvedFlags > 0 ? "danger" : pct < TARGET || needsYouTotal > 0 ? "warning" : "success";

  // Money board (management/HR only) — uses the shared payroll engine so the
  // figures match the Payroll page exactly.
  let money: { grossMonth: number; grossWeek: number; otCostMonth: number; otHrsMonth: number } | null = null;
  if (seesAll) {
    const [m, w] = await Promise.all([
      computePayroll({ ...scope, date: { $gte: monthStart, $lte: today } }, monthStart, today),
      computePayroll({ ...scope, date: { $gte: weekStart, $lte: today } }, weekStart, today),
    ]);
    money = { grossMonth: m.summary.gross, otCostMonth: m.summary.otCost, otHrsMonth: m.summary.otHrs, grossWeek: w.summary.gross };
  }

  // OT-cost (₹) 14-day trend — the one chart.
  const days: string[] = [];
  for (let i = 13; i >= 0; i--) days.push(siteLocalDate(new Date(Date.now() - i * 86_400_000)));
  const otTrendAgg = await AttendanceModel.aggregate([
    { $match: { ...scope, date: { $gte: days[0] }, "overtime.status": { $in: ["pending", "approved"] } } },
    { $lookup: { from: "workers", localField: "workerId", foreignField: "_id", as: "w" } },
    { $addFields: { wage: { $ifNull: [{ $arrayElemAt: ["$w.dailyWage", 0] }, 0] }, h: { $ifNull: ["$overtime.computedHours", 0] } } },
    { $group: { _id: "$date", cost: { $sum: { $multiply: ["$h", { $divide: ["$wage", STD] }, MULT] } } } },
  ]);
  const otCostMap = new Map(otTrendAgg.map((t) => [t._id as string, Math.round(t.cost as number)]));
  const otData = days.map((d) => otCostMap.get(d) ?? 0);
  const trendLabels = days.map((d) =>
    new Intl.DateTimeFormat("en-GB", { day: "2-digit", month: "short", timeZone: "Asia/Kolkata" }).format(new Date(`${d}T00:00:00+05:30`)),
  );
  const last7 = otData.slice(-7).reduce((a, b) => a + b, 0);
  const prev7 = otData.slice(-14, -7).reduce((a, b) => a + b, 0);
  let deltaDir: "up" | "down" | "flat" = "flat";
  let deltaPct = 0;
  if (prev7 > 0) {
    deltaPct = Math.round(((last7 - prev7) / prev7) * 100);
    deltaDir = deltaPct > 0 ? "up" : deltaPct < 0 ? "down" : "flat";
  } else if (last7 > 0) deltaDir = "up";
  const otTrend = {
    labels: trendLabels,
    data: otData,
    today: otData[otData.length - 1],
    avg: Math.round(otData.reduce((a, b) => a + b, 0) / otData.length),
    deltaDir,
    deltaPct,
  };

  // Exception-ranked sites (worst-first) from the scoped hierarchy rollup.
  const rollup = await buildHierarchyRollup(u);
  const allSites: Record<string, unknown>[] = (rollup ?? []).flatMap((b) => ((b.sites ?? []) as unknown[]) as Record<string, unknown>[]);
  const scored = allSites.map((s) => {
    const active = Number(s.active) || 0;
    const present = Number(s.present) || 0;
    const otPending = Number(s.otPending) || 0;
    const flags = Number(s.flags) || 0;
    const sitePct = active > 0 ? Math.round((present / active) * 100) : 0;
    return { siteId: String(s.siteId), siteName: String(s.siteName), code: String(s.code), present, active, otPending, flags, pct: sitePct, score: (TARGET - sitePct) * 10 + flags * 5 + otPending };
  });
  const exceptionSites = scored.filter((s) => s.pct < TARGET || s.flags > 0 || s.otPending > 0).sort((a, b) => b.score - a.score).slice(0, 5);
  const below = scored.filter((s) => s.pct < TARGET).sort((a, b) => a.pct - b.pct);
  const worstSite = below.length ? { id: below[0].siteId, name: below[0].siteName, pct: below[0].pct } : null;

  // Recent unresolved flags.
  const flags = await FlagEventModel.find({ ...flagScope, resolved: false }).sort({ timestamp: -1 }).limit(5).lean();

  res.render("dashboard", {
    title: "Dashboard · " + res.locals.company,
    active: "/dashboard",
    scopeLabel,
    mySites,
    selectedSiteId,
    seesAll,
    stats: { todayCount, pendingOT, activeWorkers, unresolvedFlags, pendingReg, pendingReq },
    pct,
    target: TARGET,
    needsYouTotal,
    verdictTone,
    otExposure: otExp,
    money,
    otTrend,
    exceptionSites,
    worstSite,
    totalSites: scored.length,
    flags,
  });
});

export default router;
