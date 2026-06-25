/* E2E for Allocate Manpower: code/status helpers + the request/allocate/outsource
   /report routes. Self-contained; cleans up. Run: npm run e2e:manpower */
import request from "supertest";
import mongoose, { Types } from "mongoose";

import { createApp } from "../src/app";
import { connectDb } from "../src/db";
import * as db from "../src/db";
import { hashPassword } from "../src/auth/password";
import { nextCode, computeStatus } from "../src/lib/manpower";
import {
  BranchModel, ProjectSiteModel, DesignationModel, WorkerModel, UserModel,
  ManpowerRequestModel, OutsourceEmployeeModel,
} from "../src/models";

const S = Date.now().toString(36);
const HR_EMAIL = `qa-mp-hr-${S}@trgbi.com`;
const PM_EMAIL = `qa-mp-pm-${S}@trgbi.com`;
const PW = "Pass123!";

function assert(label: string, cond: boolean): void {
  console.log(`${cond ? "PASS" : "FAIL"}: ${label}`);
  if (!cond) process.exitCode = 1;
}
async function login(app: ReturnType<typeof createApp>, email: string) {
  const agent = request.agent(app);
  const r = await agent.post("/login").type("form").send({ email, password: PW });
  if (r.status !== 302) throw new Error(`login failed ${email} (${r.status})`);
  return agent;
}
const raw = (agent: ReturnType<typeof request.agent>, url: string) => agent.get(url).buffer(true).parse((res, cb) => {
  const chunks: Buffer[] = []; res.on("data", (c: Buffer) => chunks.push(c)); res.on("end", () => cb(null, Buffer.concat(chunks)));
});

async function main(): Promise<void> {
  await connectDb();
  if (!db.dbReady) { console.error("DB not reachable."); process.exit(1); }

  // ---- helpers (pure) ----
  const d1 = new Types.ObjectId(), d2 = new Types.ObjectId();
  assert("open when no allocations", computeStatus({ lines: [{ designationId: d1, qty: 2 }], allocations: [] }) === "open");
  assert("partial when some filled", computeStatus({ lines: [{ designationId: d1, qty: 2 }], allocations: [{ lineDesignationId: d1 }] }) === "partial");
  assert("fulfilled when every line filled", computeStatus({ lines: [{ designationId: d1, qty: 1 }, { designationId: d2, qty: 1 }], allocations: [{ lineDesignationId: d1 }, { lineDesignationId: d2 }] }) === "fulfilled");
  assert("cancelled is sticky", computeStatus({ status: "cancelled", lines: [{ designationId: d1, qty: 1 }], allocations: [{ lineDesignationId: d1 }] }) === "cancelled");
  const c1 = await nextCode("MPA", `qa-mpa-${S}`), c2 = await nextCode("MPA", `qa-mpa-${S}`);
  assert("code format + increments", /^MPA-\d{6}$/.test(c1) && Number(c2.slice(4)) === Number(c1.slice(4)) + 1);

  // ---- fixtures ----
  const app = createApp();
  const branch = await BranchModel.create({ name: `QA MP ${S}` });
  const site = await ProjectSiteModel.create({ branchId: branch._id, name: `QA MP Site ${S}`, code: `QAMP${S}`.toUpperCase() });
  const desig = await DesignationModel.findOneAndUpdate({ name: "Carpenter" }, { $setOnInsert: { name: "Carpenter" } }, { upsert: true, new: true });
  const worker = await WorkerModel.create({ empRegNo: `QA-MPW-${S}`, name: `QA MP Worker ${S}`, designationId: desig!._id, designationName: "Carpenter", siteId: site._id, siteName: site.name, faceEncoding: [], status: "active" });
  const outsource = await OutsourceEmployeeModel.create({ code: `QAOUT-${S}`, name: `QA Out ${S}`, designationName: "Carpenter", active: true });
  await UserModel.create({ name: "QA MP HR", email: HR_EMAIL, passwordHash: await hashPassword(PW), role: "hr", assignedSiteIds: [], active: true });
  await UserModel.create({ name: "QA MP PM", email: PM_EMAIL, passwordHash: await hashPassword(PW), role: "pm", assignedSiteIds: [site._id], active: true });

  const hr = await login(app, HR_EMAIL);
  const pm = await login(app, PM_EMAIL);

  // ---- create a request (one Carpenter ×2 line) ----
  const created = await hr.post("/manpower").type("form").send({
    siteId: String(site._id), shiftType: "day", dateFrom: "2026-07-01", dateTo: "2026-07-07",
    lineDesignationId: String(desig!._id), lineQty: "2", requesterRemarks: "site ramp-up",
  });
  assert("create request redirects", created.status === 302);
  const reqDoc = await ManpowerRequestModel.findOne({ siteId: site._id });
  assert("request created (MPA code, open, 1 line qty 2)", !!reqDoc && /^MPA-\d{6}$/.test(reqDoc.reqCode) && reqDoc.status === "open" && reqDoc.lines.length === 1 && reqDoc.lines[0].qty === 2);
  const reqId = String(reqDoc!._id);
  const line = String(reqDoc!.lines[0].designationId);

  // ---- allocate the worker → site added to siteIds, status partial ----
  const a1 = await hr.post(`/manpower/${reqId}/allocate`).type("form").send({ lineDesignationId: line, kind: "worker", refId: String(worker._id) });
  assert("allocate worker redirects", a1.status === 302);
  const w = await WorkerModel.findById(worker._id).lean();
  assert("worker site assigned on allocate (can scan)", (w!.siteIds || []).map(String).includes(String(site._id)));
  let r = await ManpowerRequestModel.findById(reqId).lean();
  assert("status partial after 1 of 2", r!.status === "partial" && r!.allocations.length === 1);

  // ---- allocate the outsource person → no site change, fills line → fulfilled ----
  await hr.post(`/manpower/${reqId}/allocate`).type("form").send({ lineDesignationId: line, kind: "outsource", refId: String(outsource._id) });
  r = await ManpowerRequestModel.findById(reqId).lean();
  assert("status fulfilled after 2 of 2", r!.status === "fulfilled" && r!.allocations.length === 2);
  assert("outsource allocation is plan-only (no worker doc touched)", r!.allocations.some((a) => a.kind === "outsource"));

  // ---- PM is blocked from allocating (capability gate → 403) ----
  const denied = await pm.post(`/manpower/${reqId}/allocate`).type("form").send({ lineDesignationId: line, kind: "worker", refId: String(worker._id) });
  assert("PM blocked from allocating (403)", denied.status === 403);

  // ---- outsource register: HR creates one ----
  const oc = await hr.post("/manpower/outsource").type("form").send({ name: `QA Out2 ${S}`, outsourceCompany: "ACME Labour", payRate: "650" });
  assert("create outsource redirects", oc.status === 302);
  const o2 = await OutsourceEmployeeModel.findOne({ name: `QA Out2 ${S}` });
  assert("outsource created (OUT code, active)", !!o2 && /^OUT-\d{4}$/.test(o2.code) && o2.active === true);

  // ---- allocations report export (no view needed) ----
  const csv = await hr.get("/manpower/allocations?format=csv");
  assert("allocations CSV streams", csv.status === 200 && String(csv.headers["content-type"]).includes("csv"));
  const pdf = await raw(hr, "/manpower/allocations?format=pdf");
  assert("allocations PDF streams (%PDF)", pdf.status === 200 && String(pdf.headers["content-type"]).includes("pdf") && Buffer.isBuffer(pdf.body) && pdf.body.slice(0, 4).toString("latin1") === "%PDF");

  // ---- cleanup ----
  await Promise.all([
    ManpowerRequestModel.deleteMany({ siteId: site._id }),
    OutsourceEmployeeModel.deleteMany({ name: { $in: [`QA Out ${S}`, `QA Out2 ${S}`] } }),
    WorkerModel.deleteOne({ _id: worker._id }),
    UserModel.deleteMany({ email: { $in: [HR_EMAIL, PM_EMAIL] } }),
    ProjectSiteModel.deleteOne({ _id: site._id }),
    BranchModel.deleteOne({ _id: branch._id }),
  ]);
  await mongoose.connection.close();
  console.log(process.exitCode ? "\nE2E MANPOWER FAILED" : "\nE2E MANPOWER PASSED");
  process.exit(process.exitCode ?? 0);
}
main().catch((e) => { console.error("\nE2E MANPOWER ERROR:", (e as Error)?.message ?? e); process.exit(1); });
