/* Unit test (no DB) for the shift/OT algorithm. Run: npx tsx scripts/test_shift.ts */
import { DEFAULT_SHIFTS, windowHours, selectShift, computeShiftOT } from "../src/lib/shift";

function assert(label: string, cond: boolean): void {
  console.log(`${cond ? "PASS" : "FAIL"}: ${label}`);
  if (!cond) process.exitCode = 1;
}
// IST helpers: build a Date at a given IST wall-clock on a known date.
const ist = (date: string, hm: string) => new Date(`${date}T${hm}:00+05:30`);
const MON = "2026-06-22"; // Monday
const SUN = "2026-06-21"; // Sunday
const near = (a: number, b: number) => Math.abs(a - b) < 0.02;

// windowHours: night crosses midnight
assert("windowHours day = 9", windowHours(DEFAULT_SHIFTS.day) === 9);
assert("windowHours night = 9 (crosses midnight)", windowHours(DEFAULT_SHIFTS.night) === 9);
assert("windowHours sunday = 6", windowHours(DEFAULT_SHIFTS.sunday) === 6);

// selectShift: Sunday → sunday; morning weekday → day; evening weekday → night
assert("Sunday → sunday", selectShift(DEFAULT_SHIFTS, ist(SUN, "08:05")) === "sunday");
assert("weekday morning → day", selectShift(DEFAULT_SHIFTS, ist(MON, "08:05")) === "day");
assert("weekday evening → night", selectShift(DEFAULT_SHIFTS, ist(MON, "20:10")) === "night");
assert("weekday afternoon → day", selectShift(DEFAULT_SHIFTS, ist(MON, "13:00")) === "day");

// computeShiftOT — every matrix row
const day = DEFAULT_SHIFTS.day, night = DEFAULT_SHIFTS.night, sun = DEFAULT_SHIFTS.sunday;
let r = computeShiftOT(day, ist(MON, "08:00"), ist(MON, "17:00"));
assert("day 8-5: std 8 / OT 0", near(r.standardHours, 8) && near(r.overtimeHours, 0));
r = computeShiftOT(day, ist(MON, "08:00"), ist(MON, "20:00"));
assert("day 8-8PM: std 8 / OT 3 (no break)", near(r.standardHours, 8) && near(r.overtimeHours, 3));
r = computeShiftOT(day, ist(MON, "08:00"), ist("2026-06-23", "05:00"));
assert("day 8AM->next 5AM: std 8 / OT 11 (1h break)", near(r.standardHours, 8) && near(r.overtimeHours, 11));
r = computeShiftOT(night, ist(MON, "20:00"), ist("2026-06-23", "05:00"));
assert("night 8PM-5AM: std 8 / OT 0", near(r.standardHours, 8) && near(r.overtimeHours, 0));
r = computeShiftOT(night, ist(MON, "20:00"), ist("2026-06-23", "08:00"));
assert("night 8PM-8AM: std 8 / OT 3 (no break)", near(r.standardHours, 8) && near(r.overtimeHours, 3));
r = computeShiftOT(sun, ist(SUN, "08:00"), ist(SUN, "14:00"));
assert("sunday 8-2: std 6 / OT 0", near(r.standardHours, 6) && near(r.overtimeHours, 0));
r = computeShiftOT(sun, ist(SUN, "08:00"), ist(SUN, "18:00"));
assert("sunday 8-6PM: std 6 / OT 3 (1h break, threshold 0)", near(r.standardHours, 6) && near(r.overtimeHours, 3));

console.log(process.exitCode ? "\nSHIFT TEST FAILED" : "\nSHIFT TEST PASSED");
process.exit(process.exitCode ?? 0);
