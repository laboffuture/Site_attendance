/* Geolocation capture (capture-only — never blocks attendance).
 *
 * The kiosk sends the device's GPS (lat/lng/accuracy) with a scan. We store it
 * on the attendance record and, if the site has coordinates, the distance from
 * the site. No geofence enforcement in v1 — distance is informational. */

export interface GeoCapture {
  available: boolean; // false = device denied / had no fix
  lat: number | null;
  lng: number | null;
  accuracy: number | null; // metres, as reported by the browser
  distanceMeters: number | null; // from the site centre, if site has coords
  capturedAt: Date | null;
}

const EARTH_RADIUS_M = 6_371_000;

/** Great-circle distance between two lat/lng points, in metres. */
export function haversineMeters(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(a)));
}

function toNum(v: unknown): number | null {
  const n = typeof v === "string" ? parseFloat(v) : typeof v === "number" ? v : NaN;
  return Number.isFinite(n) ? n : null;
}

export type GeofenceResult = "off" | "inside" | "outside" | "no_fix";

/**
 * Geofence decision for a scan at `site` given a captured `geo`.
 *  - "off"      — the site has no geofence configured → no enforcement.
 *  - "no_fix"   — geofence is configured but no usable GPS fix was sent.
 *  - "inside"   — within the radius (allow).
 *  - "outside"  — beyond the radius (block).
 * A site is "configured" only when latitude, longitude AND a positive radius
 * are all set; otherwise enforcement stays off (capture-only).
 */
export function checkGeofence(
  site: { latitude?: number | null; longitude?: number | null; geofenceRadiusMeters?: number | null },
  geo: { available: boolean; distanceMeters: number | null },
): GeofenceResult {
  const configured =
    typeof site.latitude === "number" &&
    typeof site.longitude === "number" &&
    typeof site.geofenceRadiusMeters === "number" &&
    site.geofenceRadiusMeters > 0;
  if (!configured) return "off";
  if (!geo.available || geo.distanceMeters == null) return "no_fix";
  return geo.distanceMeters <= (site.geofenceRadiusMeters as number) ? "inside" : "outside";
}

/** Builds the geo sub-document from raw request values + the (optional) site
 *  coordinates. Returns `available:false` when no valid fix was sent. */
export function buildGeoCapture(
  rawLat: unknown,
  rawLng: unknown,
  rawAccuracy: unknown,
  site?: { latitude?: number | null; longitude?: number | null },
): GeoCapture {
  const lat = toNum(rawLat);
  const lng = toNum(rawLng);
  const accuracy = toNum(rawAccuracy);

  const valid = lat !== null && lng !== null && lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180;
  if (!valid) {
    return { available: false, lat: null, lng: null, accuracy: null, distanceMeters: null, capturedAt: null };
  }

  let distanceMeters: number | null = null;
  if (site && typeof site.latitude === "number" && typeof site.longitude === "number") {
    distanceMeters = Math.round(haversineMeters(lat!, lng!, site.latitude, site.longitude));
  }
  return { available: true, lat, lng, accuracy, distanceMeters, capturedAt: new Date() };
}
