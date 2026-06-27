/* E2E for payroll reconciliation (computePayroll):
   - open (no-Out) days are EXCLUDED from days/pay and counted as unresolved
   - voided + rejected days are EXCLUDED
   - OT pays only when Management-approved (pending OT pays 0)
   Self-contained; cleans up. Run: npm run e2e:payroll */
import mongoose, { Types } from "mongoose";

import { connectDb } from "../src/db";
import * as db from "../src/db";
import { computePayroll } from "../src/lib/payroll";
import { BranchModel, ProjectSiteModel, WorkerModel, AttendanceModel, PayrollAdjustmentModel } from "../src/models";

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

  // ===== Food allowance + Management-adjusted-down OT (money components) =====
  const w2 = await WorkerModel.create({ empRegNo: `QA-PR2-${S}`, name: `QA PR Food ${S}`, designationId: new Types.ObjectId(), designationName: "Carpenter", siteId: site._id, siteName: site.name, faceEncoding: [], status: "active", dailyWage: 800, foodAllowance: { applicable: true, amount: 100 } });
  const b2 = { ...base, workerId: w2._id, empRegNo: w2.empRegNo, workerName: w2.name };
  // day A: 11h span → paid 10h (>=5h → food); OT computed 2h but Management approved only 1.5h
  await AttendanceModel.create({ ...b2, date: "2025-03-03", inTime: new Date(at(8)), outTime: new Date(at(19)), totalHours: 11, standardHours: 8, attendanceStatus: "approved", overtime: { computedHours: 2, status: "approved", approvedHours: 1.5 } });
  // day B: 3h span → paid 2h (<5h → no food), no OT
  await AttendanceModel.create({ ...b2, date: "2025-03-04", inTime: new Date(at(8)), outTime: new Date(at(11)), totalHours: 3, standardHours: 2 });
  const { workers: pw2 } = await computePayroll({ workerId: w2._id }, "2025-03-03", "2025-03-04");
  const food = pw2[0];
  assert("food counts only >=5h paid days (1 of 2)", food.foodDays === 1);
  assert("food allowance rupees = rate x foodDays (100)", food.foodAllowance === 100);
  assert("adjusted-down OT pays approved 1.5h, not computed 2h", near(food.otHrs, 1.5));
  assert("food worker gross = 1000 normal + 150 OT + 100 food", near(food.gross, 1250));

  // ===== Arrears (PayrollAdjustment) folded into gross =====
  const w3 = await WorkerModel.create({ empRegNo: `QA-PR3-${S}`, name: `QA PR Arr ${S}`, designationId: new Types.ObjectId(), designationName: "Carpenter", siteId: site._id, siteName: site.name, faceEncoding: [], status: "active", dailyWage: 800 });
  await AttendanceModel.create({ ...base, workerId: w3._id, empRegNo: w3.empRegNo, workerName: w3.name, date: "2025-03-03", ...span(9), standardHours: 8 });
  await PayrollAdjustmentModel.create({ workerId: w3._id, dateFrom: "2025-03-03", dateTo: "2025-03-03", amount: 500, note: "back pay" });
  const { workers: pw3, summary: sum3 } = await computePayroll({ workerId: w3._id }, "2025-03-03", "2025-03-03");
  const arr = pw3[0];
  assert("arrears reaches the worker row (500)", arr.arrears === 500);
  assert("arrears folded into gross (normalPay 800 + 500)", arr.gross === arr.normalPay + 500);
  assert("arrears reaches the summary (500)", sum3.arrears === 500);

  // ===== Payroll freezes on the stored breakHours, not the live site lunch =====
  // Site lunch is 1h; this day stored breakHours=2 (the lunch applied at close). An
  // 8h span priced at lunch=2 gives 6 paid h; the live-lunch bug would give 7.
  const w4 = await WorkerModel.create({ empRegNo: `QA-PR4-${S}`, name: `QA PR Frz ${S}`, designationId: new Types.ObjectId(), designationName: "Carpenter", siteId: site._id, siteName: site.name, faceEncoding: [], status: "active", dailyWage: 800 });
  await AttendanceModel.create({ ...base, workerId: w4._id, empRegNo: w4.empRegNo, workerName: w4.name, date: "2025-03-10", inTime: new Date(at(8)), outTime: new Date(at(16)), totalHours: 8, breakHours: 2 });
  const { workers: pw4 } = await computePayroll({ workerId: w4._id }, "2025-03-10", "2025-03-10");
  const frz = pw4[0].byDate["2025-03-10"];
  assert("payroll prices the day off the stored breakHours (lunch=2 not site 1 → 6 paid h)", !!frz && frz.lunch === 2 && near(frz.total, 6));

  await Promise.all([
    AttendanceModel.deleteMany({ siteId: site._id }),
    WorkerModel.deleteMany({ siteId: site._id }),
    PayrollAdjustmentModel.deleteMany({ workerId: w3._id }),
    ProjectSiteModel.deleteOne({ _id: site._id }),
    BranchModel.deleteOne({ _id: branch._id }),
  ]);
  await mongoose.connection.close();
  console.log(process.exitCode ? "\nE2E PAYROLL FAILED" : "\nE2E PAYROLL PASSED");
  process.exit(process.exitCode ?? 0);
}
main().catch((e) => { console.error("\nE2E PAYROLL ERROR:", e?.message ?? e); process.exit(1); });
