/* Shift & overtime engine (pure — no DB). day/night/Sunday definitions, shift
 * selection by scan time, and OT computation with per-shift break rules.
 * See docs/superpowers/specs/2026-06-20-shift-ot-engine-design.md. */
import { hmToHours, round2, istHourOfDay, istDayOfWeek } from "./time";

export type ShiftType = "day" | "night" | "sunday";

export interface ShiftDef {
  startTime: string; // "HH:MM" IST
  endTime: string; // "HH:MM" IST; if <= start, the shift crosses midnight
  breakMin: number; // standard break within the window
  otBreakThresholdHours: number; // OT beyond this many hours loses a break
  otBreakMin: number; // break deducted from OT once over threshold
}
export type SiteShifts = Record<ShiftType, ShiftDef>;

export const DEFAULT_SHIFTS: SiteShifts = {
  day: { startTime: "08:00", endTime: "17:00", breakMin: 60, otBreakThresholdHours: 5, otBreakMin: 60 },
  night: { startTime: "20:00", endTime: "05:00", breakMin: 60, otBreakThresholdHours: 5, otBreakMin: 60 },
  sunday: { startTime: "08:00", endTime: "14:00", breakMin: 0, otBreakThresholdHours: 0, otBreakMin: 60 },
};

/** Clock-hours of the shift window; +24 when it crosses midnight (night). */
export function windowHours(shift: ShiftDef): number {
  const s = hmToHours(shift.startTime);
  const e = hmToHours(shift.endTime);
  return e > s ? e - s : e - s + 24;
}

/** Circular distance between two hour-of-day values (0–24). */
function circularDist(a: number, b: number): number {
  const d = Math.abs(a - b) % 24;
  return Math.min(d, 24 - d);
}

/** Pick the shift for an In-scan: Sunday calendar day → sunday; otherwise the
 *  day/night whose start is nearest the scan time (ties → day). */
export function selectShift(shifts: SiteShifts, inTime: Date): ShiftType {
  if (istDayOfWeek(inTime) === 0) return "sunday";
  const h = istHourOfDay(inTime);
  const dDay = circularDist(h, hmToHours(shifts.day.startTime));
  const dNight = circularDist(h, hmToHours(shifts.night.startTime));
  return dNight < dDay ? "night" : "day";
}

/** Standard + overtime hours for one worked session (handles cross-midnight). */
export function computeShiftOT(
  shift: ShiftDef,
  inTime: Date,
  outTime: Date,
): { standardHours: number; overtimeHours: number; breakHours: number } {
  const elapsedH = (outTime.getTime() - inTime.getTime()) / 3_600_000;
  const winH = windowHours(shift);
  const breakH = shift.breakMin / 60;
  const stdWorkH = Math.max(0, winH - breakH);

  const beyondH = Math.max(0, elapsedH - winH);
  const otBreakH = beyondH > shift.otBreakThresholdHours ? shift.otBreakMin / 60 : 0;
  const overtimeHours = round2(Math.max(0, beyondH - otBreakH));

  const workedToWindow = Math.min(Math.max(0, elapsedH), winH);
  const standardHours = round2(Math.min(stdWorkH, Math.max(0, workedToWindow - breakH)));

  return { standardHours, overtimeHours, breakHours: round2(breakH + otBreakH) };
}
