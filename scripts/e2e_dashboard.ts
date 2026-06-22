/* E2E for the dashboard redesign: (a) the all-sites view shows a branch box with
   the branch's active worker count; (b) ?siteId=<id> renders the dedicated
   single-site page (site name + today's roster); (c) an out-of-scope siteId and
   an invalid siteId both redirect back to /dashboard. Self-contained; cleans up.
   Run: npm run e2e:dashboard */
import request from "supertest";
import mongoose, { Types } from "mongoose";

import { createApp } from "../src/app";
import { connectDb } from "../src/db";
import * as db from "../src/db";
import { hashPassword } from "../src/auth/password";
import { siteLocalDate } from "../src/lib/time";
import { BranchModel, ProjectSiteModel, WorkerModel, UserModel, AttendanceModel } from "../src/models";

const S = Date.now().toString(36);
const PW = "Pass123!";
const today = siteLocalDate();
const BRANCH = `QA DASH ${S}`;

function assert(label: string, cond: boolean): void {
  console.log(`${cond ? "PASS" : "FAIL"}: ${label}`);
  if (!cond) process.exitCode = 1;
}
async function login(app: ReturnType<typeof createApp>, email: string) {
  const a = request.agent(app);
  const r = await a.post("/login").type("form").send({ email, password: PW });
  if (r.status !== 302) throw new Error(`login failed ${email}`);
  return a;
}

async function main(): Promise<void> {
  await connectDb();
  if (!db.dbReady) { console.error("DB not reachable."); process.exit(1); }
  const app = createApp();

  // --- fixtures: one branch, one site, two active workers, one attendance row ---
  const branch = await BranchModel.create({ name: BRANCH });
  const site = await ProjectSiteModel.create({
    branchId: branch._id, name: `QA Dash Site ${S}`, code: `QADSH${S}`.toUpperCase(),
    standardStartTime: "09:00", standardEndTime: "18:00", geofenceRadiusMeters: 120,
  });
  const desig = new Types.ObjectId();
  async function worker(reg: string) {
    return WorkerModel.create({ empRegNo: reg, name: `W ${reg}`, designationId: desig, designationName: "Carpenter", siteId: site._id, siteName: site.name, faceEncoding: [], status: "active" });
  }
  const wa = await worker(`QA-DSH-A-${S}`);
  await worker(`QA-DSH-B-${S}`); // second active worker → branch active count = 2
  await AttendanceModel.create({
    date: today, workerId: wa._id, empRegNo: wa.empRegNo, workerName: wa.name, designationId: desig, designationName: "Carpenter",
    siteId: site._id, siteName: site.name, branchId: branch._id, branchName: branch.name,
    inTime: new Date(Date.now() - 9 * 3_600_000), outTime: new Date(), totalHours: 9, standardHours: 8,
    overtime: { computedHours: 1.5, status: "pending" }, source: "scan",
  });

  // A management user sees all sites; a supervisor scoped to ANOTHER site does not.
  const mgr = `qa-dshmgr-${S}@trgbi.com`, sup = `qa-dshsup-${S}@trgbi.com`;
  await UserModel.create({ name: "Dash Mgr", email: mgr, passwordHash: await hashPassword(PW), role: "management", assignedSiteIds: [], active: true });
  const otherSite = await ProjectSiteModel.create({ branchId: branch._id, name: `QA Dash Other ${S}`, code: `QADSO${S}`.toUpperCase(), standardStartTime: "09:00", standardEndTime: "18:00" });
  await UserModel.create({ name: "Dash Sup", email: sup, passwordHash: await hashPassword(PW), role: "supervisor", assignedSiteIds: [otherSite._id], active: true });

  // --- (a) all-sites view: branch box with the branch's active worker count ---
  const ma = await login(app, mgr);
  const home = await ma.get("/dashboard");
  assert("all-sites view renders", home.status === 200);
  assert("all-sites shows the branch box", home.text.includes("oh-dash-box") && home.text.includes(BRANCH));
  assert("executive gauges added on top (ApexCharts)", home.text.includes('class="oh-gauge"') && home.text.includes("apexcharts"));
  assert("branch box carries the active worker count (2 workers)", /oh-dash-box__count[^<]*>\s*2\s*<span/.test(home.text));
  assert("site tile links into the single-site page", home.text.includes(`/dashboard?siteId=${site._id}`));

  // --- (b) single-site page: site name + today's roster ---
  const single = await ma.get(`/dashboard?siteId=${site._id}`);
  assert("single-site page renders (200, not a redirect)", single.status === 200);
  assert("single-site page shows the back link", single.text.includes('href="/dashboard"') && single.text.includes("All sites"));
  assert("single-site page shows the site name", single.text.includes(`QA Dash Site ${S}`));
  // Header shows the site's day-shift window (per-site shifts.day, matrix default 08:00–17:00).
  assert("single-site page shows the shift window", single.text.includes("08:00") && single.text.includes("17:00"));
  assert("single-site page shows the geofence radius", single.text.includes("120 m"));
  assert("single-site roster lists the scanned-in worker", single.text.includes(`QA-DSH-A-${S}`));
  assert("single-site roster uses the responsive card table", single.text.includes("oh-table--cards") && single.text.includes('data-label="In"'));

  // --- (c) out-of-scope siteId redirects (supervisor at a different site) ---
  const sa = await login(app, sup);
  const blocked = await sa.get(`/dashboard?siteId=${site._id}`);
  assert("out-of-scope siteId redirects to /dashboard", blocked.status === 302 && blocked.headers.location === "/dashboard");

  // invalid siteId (well-formed request, bogus id) also redirects
  const bogus = await ma.get(`/dashboard?siteId=not-an-id`);
  assert("invalid siteId redirects to /dashboard", bogus.status === 302 && bogus.headers.location === "/dashboard");
  const ghost = await ma.get(`/dashboard?siteId=${new Types.ObjectId()}`);
  assert("unknown (valid-shaped) siteId redirects to /dashboard", ghost.status === 302 && ghost.headers.location === "/dashboard");

  // Cleanup
  await Promise.all([
    AttendanceModel.deleteMany({ siteId: { $in: [site._id, otherSite._id] } }),
    WorkerModel.deleteMany({ siteId: site._id }),
    UserModel.deleteMany({ email: { $in: [mgr, sup] } }),
    ProjectSiteModel.deleteMany({ _id: { $in: [site._id, otherSite._id] } }),
    BranchModel.deleteOne({ _id: branch._id }),
  ]);
  await mongoose.connection.close();
  console.log(process.exitCode ? "\nE2E DASHBOARD FAILED" : "\nE2E DASHBOARD PASSED");
  process.exit(process.exitCode ?? 0);
}
main().catch((e) => { console.error("\nE2E DASHBOARD ERROR:", e?.message ?? e); process.exit(1); });
