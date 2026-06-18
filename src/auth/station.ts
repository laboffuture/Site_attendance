import { RequestHandler } from "express";

import * as db from "../db";
import { ProjectSiteModel } from "../models/ProjectSite";
import { SiteStationModel } from "../models/SiteStation";

/**
 * Gate for the kiosk surface: requires a valid station session and attaches
 * req.station (id + bound site). For the AJAX scan endpoint it answers 401
 * JSON; for pages it redirects to the station sign-in.
 */
export const requireStation: RequestHandler = async (req, res, next) => {
  const wantsJson = (req.get("accept") ?? "").includes("application/json");
  const fail = () =>
    wantsJson ? res.status(401).json({ status: "unauthorized" }) : res.redirect("/station/login");

  if (!req.session.stationId || !db.dbReady) return fail();

  const station = await SiteStationModel.findById(req.session.stationId).lean();
  if (!station || !station.active) {
    req.session.stationId = undefined;
    return fail();
  }
  const site = await ProjectSiteModel.findById(station.projectSiteId).lean();
  if (!site) return fail();

  req.station = {
    id: String(station._id),
    name: station.stationName,
    siteId: String(site._id),
    siteName: site.name,
  };
  next();
};
