import { Router, Request, Response } from "express";

import { requireCapability } from "../auth/middleware";
import { generateStationKey, hashStationKey } from "../lib/stationKey";
import { ProjectSiteModel } from "../models/ProjectSite";
import { SiteStationModel } from "../models/SiteStation";

const router = Router();

function flash(req: Request, type: "success" | "danger", text: string): void {
  req.session.flash = { type, text };
}

// Station management is Management-only (manage_org).
router.get("/stations", requireCapability("manage_org"), async (_req: Request, res: Response) => {
  const [stations, sites] = await Promise.all([
    SiteStationModel.find().sort({ createdAt: -1 }).lean(),
    ProjectSiteModel.find().sort({ name: 1 }).lean(),
  ]);
  const siteNameById = new Map(sites.map((s) => [String(s._id), `${s.name} (${s.code})`]));
  res.render("stations/index", {
    title: "Site Stations · " + res.locals.company,
    active: "/stations",
    stations,
    sites,
    siteNameById,
  });
});

router.post("/stations", requireCapability("manage_org"), async (req: Request, res: Response) => {
  const stationName = String(req.body.stationName ?? "").trim();
  const projectSiteId = String(req.body.projectSiteId ?? "").trim();
  if (!stationName || !projectSiteId) {
    flash(req, "danger", "Station name and site are required.");
    return res.redirect("/stations");
  }
  const site = await ProjectSiteModel.findById(projectSiteId).lean();
  if (!site) {
    flash(req, "danger", "Selected site does not exist.");
    return res.redirect("/stations");
  }

  const key = generateStationKey();
  await SiteStationModel.create({
    projectSiteId: site._id,
    stationName,
    stationKeyHash: hashStationKey(key),
    active: true,
  });

  // Show the plaintext key exactly once — it is not recoverable later.
  res.render("stations/created", {
    title: "Station created · " + res.locals.company,
    active: "/stations",
    stationName,
    siteLabel: `${site.name} (${site.code})`,
    stationKey: key,
  });
});

router.post("/stations/:id/toggle", requireCapability("manage_org"), async (req: Request, res: Response) => {
  const station = await SiteStationModel.findById(req.params.id);
  if (!station) {
    flash(req, "danger", "Station not found.");
    return res.redirect("/stations");
  }
  station.active = !station.active;
  await station.save();
  flash(req, "success", `Station "${station.stationName}" ${station.active ? "activated" : "deactivated"}.`);
  res.redirect("/stations");
});

export default router;
