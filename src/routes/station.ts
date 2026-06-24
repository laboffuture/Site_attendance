import { Router, Request, Response } from "express";

import { requireStation } from "../auth/station";
import { config } from "../config";
import * as db from "../db";
import { recordScan } from "../lib/attendance";
import { encodeFace, bestMatch } from "../lib/face";
import { buildGeoCapture } from "../lib/geo";
import { dataUrlToBuffer } from "../lib/image";
import { round2 } from "../lib/time";
import { hashStationKey } from "../lib/stationKey";
import { BranchModel } from "../models/Branch";
import { FlagEventModel } from "../models/FlagEvent";
import { ProjectSiteModel } from "../models/ProjectSite";
import { SiteStationModel } from "../models/SiteStation";
import { WorkerModel } from "../models/Worker";

const router = Router();

function istTime(d: Date): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata",
    hour: "2-digit",
    minute: "2-digit",
  }).format(d);
}

// ---- Station sign-in (paste the key, or open a shared ?key= link / QR) ----
router.get("/station/login", async (req: Request, res: Response) => {
  if (req.session.stationId) return res.redirect("/station");
  // A shared kiosk link / QR carries the key in the query → auto sign in.
  const key = typeof req.query.key === "string" ? req.query.key.trim() : "";
  if (key) {
    const station = db.dbReady
      ? await SiteStationModel.findOne({ stationKeyHash: hashStationKey(key), active: true })
      : null;
    if (station) {
      station.lastSeen = new Date();
      await station.save();
      req.session.stationId = String(station._id);
      return req.session.save(() => res.redirect("/station"));
    }
    return res.status(401).render("station/login", {
      title: "Station Sign-in · " + config.companyName,
      error: "Invalid or inactive station link.",
    });
  }
  res.render("station/login", { title: "Station Sign-in · " + config.companyName });
});

router.post("/station/login", async (req: Request, res: Response) => {
  if (!db.dbReady) {
    return res.status(503).render("station/login", {
      title: "Station Sign-in · " + config.companyName,
      error: "Database not connected. Try again shortly.",
    });
  }
  const key = String(req.body.stationKey ?? "").trim();
  const station = key
    ? await SiteStationModel.findOne({ stationKeyHash: hashStationKey(key), active: true })
    : null;
  if (!station) {
    return res.status(401).render("station/login", {
      title: "Station Sign-in · " + config.companyName,
      error: "Invalid or inactive station key.",
    });
  }
  station.lastSeen = new Date();
  await station.save();
  req.session.stationId = String(station._id);
  req.session.save(() => res.redirect("/station"));
});

router.post("/station/logout", (req: Request, res: Response) => {
  req.session.stationId = undefined;
  res.redirect("/station/login");
});

// ---- Kiosk capture screen ----
router.get("/station", requireStation, (req: Request, res: Response) => {
  res.render("station/capture", {
    title: "Attendance · " + config.companyName,
    station: req.station,
  });
});

// ---- Scan: identify -> location-lock -> log attendance (returns JSON) ----
router.post("/station/scan", requireStation, async (req: Request, res: Response) => {
  const station = req.station!;
  const photo = dataUrlToBuffer(String(req.body.photoData ?? ""));
  if (!photo) return res.json({ status: "error", message: "No image received." });

  let probe: number[] | null;
  try {
    probe = await encodeFace(photo);
  } catch {
    return res.json({ status: "error", message: "Could not read the image." });
  }
  if (!probe) return res.json({ status: "no_face" });

  // Match against ALL active workers (not just this site's) so a worker
  // enrolled elsewhere is still identified — and flagged — per spec §7.
  const workers = await WorkerModel.find({
    status: "active",
    "faceEncoding.0": { $exists: true },
  })
    .select("name empRegNo siteId siteIds siteName designationId designationName faceEncoding")
    .lean();

  const match = bestMatch(
    probe,
    workers.map((w) => ({ id: String(w._id), descriptor: w.faceEncoding })),
  );
  if (!match) return res.json({ status: "unknown" });

  const worker = workers.find((w) => String(w._id) === match.id)!;

  // Location-lock: the station's site must be one of the worker's assigned
  // sites (multi-site workers can clock in at any of theirs).
  if (!worker.siteIds.map(String).includes(String(station.siteId))) {
    await FlagEventModel.create({
      type: "wrong_site_scan",
      workerId: worker._id,
      workerName: worker.name,
      attemptedSiteId: station.siteId,
      attemptedSiteName: station.siteName,
      attemptedStationId: station.id,
      homeSiteId: worker.siteId,
      homeSiteName: worker.siteName,
    });
    return res.json({
      status: "wrong_site",
      workerName: worker.name,
      empRegNo: worker.empRegNo,
      homeSite: worker.siteName,
      thisSite: station.siteName,
    });
  }

  const site = await ProjectSiteModel.findById(station.siteId).lean();
  if (!site) return res.json({ status: "error", message: "Station site missing." });
  const branch = await BranchModel.findById(site.branchId).lean();

  // Capture the device GPS sent with the scan (capture-only; never blocks).
  const geo = buildGeoCapture(req.body.lat, req.body.lng, req.body.accuracy, site);

  const result = await recordScan(
    {
      _id: worker._id,
      empRegNo: worker.empRegNo,
      name: worker.name,
      designationId: worker.designationId,
      designationName: worker.designationName,
    },
    site,
    branch?.name ?? "",
    geo,
  );

  res.json({
    status: result.action, // "in" | "out"
    workerName: worker.name,
    empRegNo: worker.empRegNo,
    time: istTime(result.action === "in" ? result.inTime : result.outTime!),
    totalHours: result.totalHours,
    overtimeHours: round2(result.overtimeHours),
    overtimeStatus: result.overtimeStatus,
    geo: { available: geo.available, distanceMeters: geo.distanceMeters },
  });
});

export default router;
