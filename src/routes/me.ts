import { Router, Request, Response } from "express";
import { Types } from "mongoose";

import { requireAuth } from "../auth/middleware";
import { haversineMeters } from "../lib/geo";
import { LoginGeoCheckModel } from "../models/LoginGeoCheck";
import { ProjectSiteModel } from "../models/ProjectSite";

const router = Router();

function num(v: unknown): number | null {
  const n = typeof v === "string" ? parseFloat(v) : typeof v === "number" ? v : NaN;
  return Number.isFinite(n) ? n : null;
}

// Portal-open location check (PM/Supervisor): are they at an assigned site?
// Returns a status the banner reflects, and records the check so off-site
// logins are tracked. Never blocks — purely informational.
router.post("/me/location-check", requireAuth, async (req: Request, res: Response) => {
  const user = req.currentUser!;
  const lat = num(req.body.lat);
  const lng = num(req.body.lng);
  const accuracy = num(req.body.accuracy);

  const ids = user.assignedSiteIds.map((id) => new Types.ObjectId(id));
  const sites = ids.length
    ? await ProjectSiteModel.find({
        _id: { $in: ids },
        latitude: { $ne: null },
        longitude: { $ne: null },
        geofenceRadiusMeters: { $gt: 0 },
      })
        .select("name latitude longitude geofenceRadiusMeters")
        .lean()
    : [];

  let status: "off" | "no_fix" | "inside" | "outside";
  let nearest: { id: Types.ObjectId; name: string; distance: number; radius: number } | null = null;

  if (!sites.length) {
    status = "off"; // no geofenced site assigned → nothing to check
  } else if (lat === null || lng === null || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
    status = "no_fix";
  } else {
    for (const s of sites) {
      const d = Math.round(haversineMeters(lat, lng, s.latitude as number, s.longitude as number));
      if (!nearest || d < nearest.distance) {
        nearest = { id: s._id as Types.ObjectId, name: s.name, distance: d, radius: s.geofenceRadiusMeters as number };
      }
    }
    status = nearest && nearest.distance <= nearest.radius ? "inside" : "outside";
  }

  await LoginGeoCheckModel.create({
    userId: new Types.ObjectId(user.id),
    userName: user.name,
    role: user.role,
    latitude: lat,
    longitude: lng,
    accuracyMeters: accuracy,
    status,
    nearestSiteId: nearest?.id ?? null,
    nearestSiteName: nearest?.name ?? null,
    distanceMeters: nearest?.distance ?? null,
  });

  res.json({ status, siteName: nearest?.name ?? null, distanceMeters: nearest?.distance ?? null, radius: nearest?.radius ?? null });
});

export default router;
