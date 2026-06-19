/* Unit test (no DB) for the daily-sweep timing helper.
   Verifies nextFireDelayMs computes the delay to the next HH:MM IST, choosing
   today when the target is still ahead and tomorrow when it has passed.
   Run: npx tsx scripts/test_scheduler.ts */

import { nextFireDelayMs } from "../src/lib/scheduler";

function assert(label: string, cond: boolean): void {
  console.log(`${cond ? "PASS" : "FAIL"}: ${label}`);
  if (!cond) process.exitCode = 1;
}

const HOUR = 3_600_000;

// 2026-06-18 18:00 IST  ==  2026-06-18 12:30 UTC
const at1830ist = new Date("2026-06-18T12:30:00Z");

// Target 23:00 IST is 5h ahead of 18:00 IST.
assert("delay to a later time today ≈ 5h",
  Math.abs(nextFireDelayMs("23:00", at1830ist) - 5 * HOUR) < 1000);

// Target 09:00 IST already passed today → next is 09:00 IST tomorrow (15h ahead).
assert("delay to an earlier time rolls to tomorrow ≈ 15h",
  Math.abs(nextFireDelayMs("09:00", at1830ist) - 15 * HOUR) < 1000);

// Always strictly positive.
assert("delay is always positive", nextFireDelayMs("18:00", at1830ist) > 0);

console.log(process.exitCode ? "\nSCHEDULER TEST FAILED" : "\nSCHEDULER TEST PASSED");
process.exit(process.exitCode ?? 0);
