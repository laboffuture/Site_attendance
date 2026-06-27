import { Router, Request, Response } from "express";
import { Types } from "mongoose";
import QRCode from "qrcode";

import { requireCapability } from "../auth/middleware";
import { seesAllSites } from "../auth/permissions";
import type { CurrentUser } from "../auth/types";
import { canUseSite } from "../lib/scope";
import { generateStationKey, hashStationKey } from "../lib/stationKey";
import { ProjectSiteModel } from "../models/ProjectSite";
import { SiteStationModel } from "../models/SiteStation";

const router = Router();

function flash(req: Request, type: "success" | "danger", text: string): void {
  req.session.flash = { type, text };
}

function forbid(res: Response): void {
  res.status(403).render("error", { title: "Access denied", active: "", code: 403, message: "This station is outside your site scope." });
}

/** Stations limited to the user's sites (top admins: all). Keyed on projectSiteId. */
function stationScope(user: CurrentUser): Record<string, unknown> {
  if (seesAllSites(user.role)) return {};
  return { projectSiteId: { $in: user.assignedSiteIds.map((id) => new Types.ObjectId(id)) } };
}

/** Project sites the user may register/see stations for (top admins: all). */
function siteScope(user: CurrentUser): Record<string, unknown> {
  if (seesAllSites(user.role)) return {};
  return { _id: { $in: user.assignedSiteIds.map((id) => new Types.ObjectId(id)) } };
}

/** A shareable kiosk link (opens /station with the key) + a QR of it, built
 *  from the plaintext key (only available at create/regenerate time). */
async function kioskShare(req: Request, key: string): Promise<{ shareUrl: string; qrDataUrl: string }> {
  const shareUrl = `${req.protocol}://${req.get("host")}/station/login?key=${encodeURIComponent(key)}`;
  const qrDataUrl = await QRCode.toDataURL(shareUrl, { margin: 1, width: 260, color: { dark: "#1c4d8c", light: "#ffffff" } });
  return { shareUrl, qrDataUrl };
}

// Station management (manage_stations). Management/HR see every site; PM + Supervisor
// are scoped to their assignedSiteIds — they can only see/act on their own stations.
router.get("/stations", requireCapability("manage_stations"), async (req: Request, res: Response) => {
  const user = req.currentUser!;
  const [stations, sites] = await Promise.all([
    SiteStationModel.find(stationScope(user)).sort({ createdAt: -1 }).lean(),
    ProjectSiteModel.find(siteScope(user)).sort({ name: 1 }).lean(),
  ]);
  const siteNameById = new Map(sites.map((s) => [String(s._id), `${s.name} (${s.code})`]));
  const active = stations.filter((s) => s.active).length;
  const sitesCovered = new Set(stations.map((s) => String(s.projectSiteId))).size;
  res.render("stations/index", {
    title: "Site Stations · " + res.locals.company,
    active: "/stations",
    stations,
    siteNameById,
    hasSites: sites.length > 0,
    summary: { total: stations.length, active, inactive: stations.length - active, sitesCovered },
  });
});

// Register form — only offers sites the user is scoped to.
router.get("/stations/new", requireCapability("manage_stations"), async (req: Request, res: Response) => {
  const sites = await ProjectSiteModel.find(siteScope(req.currentUser!)).sort({ name: 1 }).lean();
  res.render("stations/new", {
    title: "Register station · " + res.locals.company,
    active: "/stations",
    sites,
  });
});

router.post("/stations", requireCapability("manage_stations"), async (req: Request, res: Response) => {
  const stationName = String(req.body.stationName ?? "").trim();
  const projectSiteId = String(req.body.projectSiteId ?? "").trim();
  if (!stationName || !projectSiteId) {
    flash(req, "danger", "Station name and site are required.");
    return res.redirect("/stations/new");
  }
  // Scope-gate the chosen site BEFORE creating — a PM/Supervisor may only register
  // a kiosk at one of their own sites.
  if (!Types.ObjectId.isValid(projectSiteId) || !canUseSite(req.currentUser!, projectSiteId)) {
    flash(req, "danger", "Select a site you're assigned to.");
    return res.redirect("/stations/new");
  }
  const site = await ProjectSiteModel.findById(projectSiteId).lean();
  if (!site) {
    flash(req, "danger", "Selected site does not exist.");
    return res.redirect("/stations/new");
  }

  const key = generateStationKey();
  await SiteStationModel.create({
    projectSiteId: site._id,
    stationName,
    stationKeyHash: hashStationKey(key),
    active: true,
  });

  // Show the plaintext key exactly once — it is not recoverable later.
  const share = await kioskShare(req, key);
  res.render("stations/created", {
    title: "Station created · " + res.locals.company,
    active: "/stations",
    stationName,
    siteLabel: `${site.name} (${site.code})`,
    stationKey: key,
    shareUrl: share.shareUrl,
    qrDataUrl: share.qrDataUrl,
    regenerated: false,
  });
});

// Regenerate the key — the old key stops working; show the new one once.
router.post("/stations/:id/regenerate", requireCapability("manage_stations"), async (req: Request, res: Response) => {
  const station = await SiteStationModel.findById(req.params.id);
  if (!station) {
    flash(req, "danger", "Station not found.");
    return res.redirect("/stations");
  }
  if (!canUseSite(req.currentUser!, String(station.projectSiteId))) return forbid(res);
  const key = generateStationKey();
  station.stationKeyHash = hashStationKey(key);
  await station.save();
  const site = await ProjectSiteModel.findById(station.projectSiteId).lean();
  const share = await kioskShare(req, key);
  res.render("stations/created", {
    title: "Station key regenerated · " + res.locals.company,
    active: "/stations",
    stationName: station.stationName,
    siteLabel: site ? `${site.name} (${site.code})` : "—",
    stationKey: key,
    shareUrl: share.shareUrl,
    qrDataUrl: share.qrDataUrl,
    regenerated: true,
  });
});

router.post("/stations/:id/toggle", requireCapability("manage_stations"), async (req: Request, res: Response) => {
  const station = await SiteStationModel.findById(req.params.id);
  if (!station) {
    flash(req, "danger", "Station not found.");
    return res.redirect("/stations");
  }
  if (!canUseSite(req.currentUser!, String(station.projectSiteId))) return forbid(res);
  station.active = !station.active;
  await station.save();
  flash(req, "success", `Station "${station.stationName}" ${station.active ? "activated" : "deactivated"}.`);
  res.redirect("/stations");
});

router.post("/stations/:id/delete", requireCapability("manage_stations"), async (req: Request, res: Response) => {
  const station = await SiteStationModel.findById(req.params.id);
  if (!station) {
    flash(req, "danger", "Station not found.");
    return res.redirect("/stations");
  }
  if (!canUseSite(req.currentUser!, String(station.projectSiteId))) return forbid(res);
  await station.deleteOne();
  flash(req, "success", `Station "${station.stationName}" deleted.`);
  res.redirect("/stations");
});

export default router;
