/* In-process daily scheduler for the missed clock-out sweep.
 *
 * Plain setTimeout (no cron dependency): compute the delay to the next
 * SWEEP_TIME in IST, fire, run the sweep, then reschedule for the next day.
 * A failed run is logged and never stops future runs. The same
 * sweepMissedClockouts() is also runnable on demand via `npm run sweep`.
 */
import { config } from "../config";
import { sweepMissedClockouts } from "./missedClockout";
import { istDateTime, siteLocalDate } from "./time";

const DAY_MS = 86_400_000;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Milliseconds from `now` until the next occurrence of `hm` ("HH:MM") in IST.
 *  If today's target has already passed (or is exactly now), rolls to tomorrow,
 *  so the result is always strictly positive. */
export function nextFireDelayMs(hm: string, now: Date = new Date()): number {
  let target = istDateTime(siteLocalDate(now), hm);
  if (target.getTime() <= now.getTime()) {
    target = istDateTime(siteLocalDate(new Date(now.getTime() + DAY_MS)), hm);
  }
  return target.getTime() - now.getTime();
}

/** Starts the recurring daily sweep. Returns nothing; the timer unrefs so it
 *  never holds the process open on its own. */
export function startDailySweep(): void {
  const hm = TIME_RE.test(config.sweepTime) ? config.sweepTime : "23:00";
  if (hm !== config.sweepTime) {
    console.warn(`Invalid SWEEP_TIME "${config.sweepTime}"; using ${hm} IST.`);
  }

  const schedule = (): void => {
    const delay = nextFireDelayMs(hm);
    const timer = setTimeout(async () => {
      try {
        await sweepMissedClockouts();
      } catch (err) {
        console.error("Missed-clockout sweep failed:", (err as Error)?.message ?? err);
      } finally {
        schedule(); // always reschedule, even after a failed run
      }
    }, delay);
    timer.unref();
  };

  const mins = Math.round(nextFireDelayMs(hm) / 60000);
  console.log(`Missed-clockout sweep scheduled for ${hm} IST daily (next in ~${mins} min).`);
  schedule();
}
