/* E2E for Allocate Manpower: code/status helpers (Task 2), then routes
   (create/allocate/outsource/board/report) added in later tasks.
   Self-contained; cleans up. Run: npm run e2e:manpower */
import mongoose, { Types } from "mongoose";

import { connectDb } from "../src/db";
import * as db from "../src/db";
import { nextCode, computeStatus } from "../src/lib/manpower";

const S = Date.now().toString(36);
function assert(label: string, cond: boolean): void {
  console.log(`${cond ? "PASS" : "FAIL"}: ${label}`);
  if (!cond) process.exitCode = 1;
}

async function main(): Promise<void> {
  await connectDb();
  if (!db.dbReady) { console.error("DB not reachable."); process.exit(1); }

  const d1 = new Types.ObjectId(), d2 = new Types.ObjectId();
  // computeStatus
  assert("open when no allocations", computeStatus({ lines: [{ designationId: d1, qty: 2 }], allocations: [] }) === "open");
  assert("partial when some filled", computeStatus({ lines: [{ designationId: d1, qty: 2 }], allocations: [{ lineDesignationId: d1 }] }) === "partial");
  assert("fulfilled when every line filled", computeStatus({ lines: [{ designationId: d1, qty: 1 }, { designationId: d2, qty: 1 }], allocations: [{ lineDesignationId: d1 }, { lineDesignationId: d2 }] }) === "fulfilled");
  assert("not fulfilled if one line short", computeStatus({ lines: [{ designationId: d1, qty: 1 }, { designationId: d2, qty: 1 }], allocations: [{ lineDesignationId: d1 }] }) === "partial");
  assert("cancelled is sticky", computeStatus({ status: "cancelled", lines: [{ designationId: d1, qty: 1 }], allocations: [{ lineDesignationId: d1 }] }) === "cancelled");

  // nextCode: format + sequential
  const c1 = await nextCode("MPA", `qa-mpa-${S}`);
  const c2 = await nextCode("MPA", `qa-mpa-${S}`);
  assert("code format MPA-000001", /^MPA-\d{6}$/.test(c1));
  assert("code increments", Number(c2.slice(4)) === Number(c1.slice(4)) + 1);
  const o1 = await nextCode("OUT", `qa-out-${S}`, 4);
  assert("outsource code format OUT-0001", /^OUT-\d{4}$/.test(o1));

  await mongoose.connection.close();
  console.log(process.exitCode ? "\nE2E MANPOWER FAILED" : "\nE2E MANPOWER PASSED");
  process.exit(process.exitCode ?? 0);
}
main().catch((e) => { console.error("\nE2E MANPOWER ERROR:", (e as Error)?.message ?? e); process.exit(1); });
