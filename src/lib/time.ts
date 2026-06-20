const SITE_TZ = "Asia/Kolkata"; // all sites are in India (IST)

/** The site-local calendar day as "YYYY-MM-DD" (used as the attendance key). */
export function siteLocalDate(d: Date = new Date()): string {
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: SITE_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

/** A site-local (IST) calendar date + "HH:MM" as a Date.
 *  India is a fixed UTC+05:30 offset (no DST), so this is unambiguous. */
export function istDateTime(date: string, hm: string): Date {
  return new Date(`${date}T${hm}:00+05:30`);
}

/** A Date rendered as IST "HH:MM" (or "" for null). */
export function istHM(d: Date | null | undefined): string {
  return d
    ? new Intl.DateTimeFormat("en-GB", {
        timeZone: SITE_TZ,
        hour: "2-digit",
        minute: "2-digit",
      }).format(d)
    : "";
}

/** "HH:MM" → decimal hours (e.g. "09:30" → 9.5). */
export function hmToHours(hm: string): number {
  const [h, m] = hm.split(":").map(Number);
  return (h || 0) + (m || 0) / 60;
}

/** IST hour-of-day as a fractional number 0–24 (e.g. 20:30 → 20.5). */
export function istHourOfDay(d: Date): number {
  return hmToHours(istHM(d));
}

/** IST day of week: 0 = Sunday … 6 = Saturday. */
export function istDayOfWeek(d: Date): number {
  const wd = new Intl.DateTimeFormat("en-US", { timeZone: SITE_TZ, weekday: "short" }).format(d);
  return ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(wd);
}

export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Standard (non-overtime) hours for a site, honoring an optional
 *  per-designation shift override. Structural type so it accepts both lean
 *  docs and plain objects. */
export function standardHoursForSite(
  site: {
    standardStartTime: string;
    standardEndTime: string;
    designationOverrides?: { designationId: unknown; startTime: string; endTime: string }[];
  },
  designationId?: string,
): number {
  if (designationId && site.designationOverrides?.length) {
    const ov = site.designationOverrides.find(
      (o) => String(o.designationId) === String(designationId),
    );
    if (ov) return Math.max(0, hmToHours(ov.endTime) - hmToHours(ov.startTime));
  }
  return Math.max(0, hmToHours(site.standardEndTime) - hmToHours(site.standardStartTime));
}
