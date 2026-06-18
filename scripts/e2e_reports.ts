/* End-to-end test for dashboards + reports + exports + flags.
   Verifies the dashboard renders stats/charts/flags; the reports page filters
   and groups; xlsx + pdf exports return real binary files; and flags list +
   resolve respect site scope. Seeds + cleans its own data. Run: npm run e2e:reports */

import request from "supertest";
import mongoose, { Types } from "mongoose";

import { createApp } from "../src/app";
import { connectDb } from "../src/db";
import * as db from "../src/db";
import { hashPassword } from "../src/auth/password";
import { siteLocalDate } from "../src/lib/time";
import {
  AttendanceModel, FlagEventModel, ProjectSiteModel, UserModel,
} from "../src/models";

const ADMIN_EMAIL = (process.env.SEED_ADMIN_EMAIL || "admin@trgbi.com").toLowerCase();
const ADMIN_PW = process.env.SEED_ADMIN_PASSWORD || "ChangeMe123!";
const S = Date.now().toString(36);
const SUP_EMAIL = `qa-rsup-${S}@trgbi.com`;
const PW = "Pass123!";

function assert(label: string, cond: boolean): void {
  console.log(`${cond ? "PASS" : "FAIL"}: ${label}`);
  if (!cond) process.exitCode = 1;
}
const binaryParser = (res: import("http").IncomingMessage, cb: (err: Error | null, body: Buffer) => void) => {
  const chunks: Buffer[] = [];
  res.on("data", (c: Buffer) => chunks.push(Buffer.from(c)));
  res.on("end", () => cb(null, Buffer.concat(chunks)));
};
async function login(app: ReturnType<typeof createApp>, email: string, password: string) {
  const agent = request.agent(app);
  const r = await agent.post("/login").type("form").send({ email, password });
  if (r.status !== 302) throw new Error(`login failed for ${email} (${r.status})`);
  return agent;
}

async function main(): Promise<void> {
  await connectDb();
  if (!db.dbReady) { console.error("DB not reachable."); process.exit(1); }
  const app = createApp();

  const vbw = await ProjectSiteModel.findOne({ code: "VBW" });
  const pvm = await ProjectSiteModel.findOne({ code: "PVM" });
  if (!vbw || !pvm) throw new Error("Seed data missing — run npm run seed.");
  const today = siteLocalDate();

  async function mkAttendance(tag: string, status: string, ot: number): Promise<void> {
    await AttendanceModel.create({
      date: today, workerId: new Types.ObjectId(),
      empRegNo: `QA-RPT-${S}-${tag}`, workerName: `QA RPT ${tag}`,
      designationId: new Types.ObjectId(), designationName: "Carpenter",
      siteId: vbw!._id, siteName: vbw!.name, branchId: vbw!.branchId, branchName: "Chennai",
      inTime: new Date(`${today}T03:30:00Z`), outTime: new Date(`${today}T14:30:00Z`),
      totalHours: 11, standardHours: 9,
      overtime: { computedHours: ot, status },
    });
  }
  await mkAttendance("a", "pending", 2);
  await mkAttendance("b", "approved", 1.5);

  const flagVbw = await FlagEventModel.create({
    type: "wrong_site_scan", workerName: `QA Flag ${S}`,
    attemptedSiteId: vbw._id, attemptedSiteName: vbw.name,
    homeSiteId: pvm._id, homeSiteName: pvm.name, resolved: false,
  });
  const flagPvm = await FlagEventModel.create({
    type: "wrong_site_scan", workerName: `QA FlagP ${S}`,
    attemptedSiteId: pvm._id, attemptedSiteName: pvm.name,
    homeSiteId: vbw._id, homeSiteName: vbw.name, resolved: false,
  });

  await UserModel.create({ name: "QA RSup", email: SUP_EMAIL, passwordHash: await hashPassword(PW), role: "supervisor", assignedSiteIds: [vbw._id], active: true });

  const admin = await login(app, ADMIN_EMAIL, ADMIN_PW);

  // Dashboard
  const dash = await admin.get("/dashboard");
  assert("dashboard 200", dash.status === 200);
  assert("dashboard embeds chart data", dash.text.includes("window.__CHARTS__"));
  assert("dashboard shows a flag", dash.text.includes(`QA Flag ${S}`));

  // Reports
  const rep = await admin.get("/reports");
  assert("reports 200", rep.status === 200);
  assert("reports shows VBW site", rep.text.includes(vbw.name));
  assert("reports shows seeded worker", rep.text.includes(`QA-RPT-${S}-a`));
  const filtered = await admin.get("/reports?q=nonexistentworkerxyz");
  assert("filter with no match shows empty state", filtered.text.includes("No attendance records"));

  // Exports
  const xlsx = await admin.get(`/reports/export.xlsx?dateFrom=${today}&dateTo=${today}`).buffer().parse(binaryParser);
  assert("xlsx content-type", (xlsx.headers["content-type"] || "").includes("spreadsheetml"));
  assert("xlsx is a real workbook (PK header)", Buffer.isBuffer(xlsx.body) && xlsx.body.slice(0, 2).toString() === "PK");
  const pdf = await admin.get(`/reports/export.pdf?dateFrom=${today}&dateTo=${today}`).buffer().parse(binaryParser);
  assert("pdf content-type", (pdf.headers["content-type"] || "").includes("application/pdf"));
  assert("pdf has %PDF header", Buffer.isBuffer(pdf.body) && pdf.body.slice(0, 4).toString() === "%PDF");

  // Flags + resolve
  const flags = await admin.get("/flags");
  assert("flags page shows VBW flag", flags.text.includes(`QA Flag ${S}`));
  await admin.post(`/flags/${flagVbw._id}/resolve`).type("form").send({});
  assert("flag resolved", (await FlagEventModel.findById(flagVbw._id))?.resolved === true);

  // Scope: VBW supervisor must not see/resolve the PVM flag.
  const sup = await login(app, SUP_EMAIL, PW);
  const supFlags = await sup.get("/flags");
  assert("supervisor flags exclude other-site flag", !supFlags.text.includes(`QA FlagP ${S}`));
  const supResolve = await sup.post(`/flags/${flagPvm._id}/resolve`).type("form").send({});
  assert("supervisor cannot resolve out-of-scope flag (403)", supResolve.status === 403);
  assert("PVM flag still unresolved", (await FlagEventModel.findById(flagPvm._id))?.resolved === false);

  // Cleanup
  await Promise.all([
    AttendanceModel.deleteMany({ empRegNo: new RegExp(`^QA-RPT-${S}-`) }),
    FlagEventModel.deleteMany({ _id: { $in: [flagVbw._id, flagPvm._id] } }),
    UserModel.deleteOne({ email: SUP_EMAIL }),
  ]);

  await mongoose.connection.close();
  console.log(process.exitCode ? "\nE2E REPORTS FAILED" : "\nE2E REPORTS PASSED");
  process.exit(process.exitCode ?? 0);
}

main().catch((e) => { console.error("\nE2E REPORTS ERROR:", e?.message ?? e); process.exit(1); });
