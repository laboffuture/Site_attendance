/* Unit test (no DB) for geofence enforcement. Run: npx tsx scripts/test_geofence.ts */
import { checkGeofence } from "../src/lib/geo";

function assert(label: string, cond: boolean): void {
  console.log(`${cond ? "PASS" : "FAIL"}: ${label}`);
  if (!cond) process.exitCode = 1;
}

const noCoords = { latitude: null, longitude: null, geofenceRadiusMeters: null };
const fenced = { latitude: 13.04, longitude: 80.23, geofenceRadiusMeters: 200 };
const fix = (d: number | null) => ({ available: d != null, distanceMeters: d });

assert("unconfigured site → off (no enforcement)", checkGeofence(noCoords, fix(5000)) === "off");
assert("inside the radius → inside", checkGeofence(fenced, fix(150)) === "inside");
assert("exactly at the radius → inside", checkGeofence(fenced, fix(200)) === "inside");
assert("beyond the radius → outside", checkGeofence(fenced, fix(450)) === "outside");
assert("configured but no GPS fix → no_fix", checkGeofence(fenced, { available: false, distanceMeters: null }) === "no_fix");

console.log(process.exitCode ? "\nGEOFENCE TEST FAILED" : "\nGEOFENCE TEST PASSED");
process.exit(process.exitCode ?? 0);
