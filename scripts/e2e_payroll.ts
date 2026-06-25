/* E2E for payroll reconciliation (computePayroll):
   - open (no-Out) days are EXCLUDED from days/pay and counted as unresolved
   - voided + rejected days are EXCLUDED
   - OT pays only when Management-approved (pending OT pays 0)
   Self-contained; cleans up. Run: npm run e2e:payroll */
import mongoose, { Types } from "mongoose";

import { connectDb } from "../src/db";
import * as db from "../src/db";
import { computePayroll } from "../src/lib/payroll";
import { BranchModel, ProjectSiteModel, WorkerModel, AttendanceModel } from "../src/models";

const S = Date.now().toString(36);
function assert(label: string, cond: boolean): void {
  console.log(`${cond ? "PASS" : "FAIL"}: ${label}`);
  if (!cond) process.exitCode = 1;
}
const near = (a: number, b: number) => Math.abs(a - b) < 0.01;

async function main(): Promise<void> {
  await connectDb();
  if (!db.dbReady) { console.error("DB not reachable."); process.exit(1); }

  const branch = await BranchModel.create({ name: `QA PR ${S}` });
  const site = await ProjectSiteModel.create({ branchId: branch._id, name: `QA PR Site ${S}`, code: `QAPR${S}`.toUpperCase(), lunchHours: 1 });
  const worker = await WorkerModel.create({ empRegNo: `QA-PR-${S}`, name: `QA PR ${S}`, designationId: new Types.ObjectId(), designationName: "Carpenter", siteId: site._id, siteName: site.name, faceEncoding: [], status: "active", dailyWage: 800 });

  const base = { workerId: worker._id, empRegNo: worker.empRegNo, workerName: worker.name, designationId: worker.designationId, designationName: "Carpenter", siteId: site._id, siteName: site.name, branchId: branch._id, branchName: branch.name, source: "scan" as const };
  const at = (h: number) => new Date("2025-03-03T00:00:00+05:30").getTime() + h * 3_600_000;
  // A closed `hours`-long span (lunch 1h → paid = hours-1; OT = paid-8).
  const span = (hours: number) => ({ inTime: new Date(at(8)), outTime: new Date(at(8 + hours)), totalHours: hours });

  // date1: closed 10h day (paid 9 → 8 normal + 1 OT), OT APPROVED → pays 1h OT
  await AttendanceModel.create({ ...base, date: "2025-03-03", ...span(10), standardHours: 8, attendanceStatus: "approved", overtime: { computedHours: 1, status: "approved", approvedHours: 1 } });
  // date2: closed 10h day, OT PENDING → pays 0 OT
  await AttendanceModel.create({ ...base, date: "2025-03-04", ...span(10), standardHours: 8, overtime: { computedHours: 1, status: "pending" } });
  // date3: OPEN day (no Out) → excluded, counted unresolved
  await AttendanceModel.create({ ...base, date: "2025-03-05", inTime: new Date(at(8)), outTime: null });
  // date4: voided day → excluded
  await AttendanceModel.create({ ...base, date: "2025-03-06", ...span(10), voided: true });
  // date5: rejected day → excluded
  await AttendanceModel.create({ ...base, date: "2025-03-07", ...span(10), attendanceStatus: "rejected" });

  const { workers, summary } = await computePayroll({ workerId: worker._id }, "2025-03-03", "2025-03-07");
  const w = workers[0] as typeof workers[0] & { unresolvedOpenDays: number };
  assert("one worker in the run", workers.length === 1 && !!w);
  assert("only 2 closed/non-void/non-rejected days counted", w.days === 2);
  assert("open day counted as unresolved (worker)", w.unresolvedOpenDays === 1);
  assert("open day counted as unresolved (summary)", (summary as typeof summary & { unresolvedOpenDays: number }).unresolvedOpenDays === 1);
  assert("normal hours = 16 (8+8)", near(w.normalHrs, 16));
  assert("only approved OT pays (1h; pending excluded)", near(w.otHrs, 1));

  await Promise.all([
    AttendanceModel.deleteMany({ workerId: worker._id }),
    WorkerModel.deleteOne({ _id: worker._id }),
    ProjectSiteModel.deleteOne({ _id: site._id }),
    BranchModel.deleteOne({ _id: branch._id }),
  ]);
  await mongoose.connection.close();
  console.log(process.exitCode ? "\nE2E PAYROLL FAILED" : "\nE2E PAYROLL PASSED");
  process.exit(process.exitCode ?? 0);
}
main().catch((e) => { console.error("\nE2E PAYROLL ERROR:", e?.message ?? e); process.exit(1); });
