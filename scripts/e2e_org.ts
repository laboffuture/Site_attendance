/* End-to-end test for the Org CRUD module. Verifies create + validation +
   duplicate rejection for branches/sites/designations, and that the
   permission matrix holds (a Supervisor is blocked from the org screens but
   allowed to add designations). Creates uniquely-named test records and
   deletes them at the end so the run is repeatable. Run: npm run e2e:org */

import request from "supertest";
import mongoose from "mongoose";

import { createApp } from "../src/app";
import { connectDb } from "../src/db";
import * as db from "../src/db";
import { hashPassword } from "../src/auth/password";
import { BranchModel, ProjectSiteModel, DesignationModel, UserModel } from "../src/models";

const ADMIN_EMAIL = (process.env.SEED_ADMIN_EMAIL || "admin@trgbi.com").toLowerCase();
const ADMIN_PW = process.env.SEED_ADMIN_PASSWORD || "ChangeMe123!";

const S = Date.now().toString(36);
const BRANCH = `QA Branch ${S}`;
const SITE = `QA Site ${S}`;
const CODE = `QA${S.slice(-4)}`.toUpperCase();
const TRADE = `QA Trade ${S}`;
const SUP_EMAIL = `qa-sup-${S}@trgbi.com`;
const SUP_PW = "SupPass123!";

function assert(label: string, cond: boolean): void {
  console.log(`${cond ? "PASS" : "FAIL"}: ${label}`);
  if (!cond) process.exitCode = 1;
}

async function login(app: ReturnType<typeof createApp>, email: string, password: string) {
  const agent = request.agent(app);
  const r = await agent.post("/login").type("form").send({ email, password });
  if (r.status !== 302) throw new Error(`login failed for ${email} (${r.status})`);
  return agent;
}

async function main(): Promise<void> {
  await connectDb();
  if (!db.dbReady) {
    console.error("Cannot run e2e: database not reachable.");
    process.exit(1);
  }
  const app = createApp();

  // Supervisor (scoped to VBW) for the permission checks.
  const vbwSite = await ProjectSiteModel.findOne({ code: "VBW" });
  await UserModel.create({
    name: "QA Supervisor",
    email: SUP_EMAIL,
    passwordHash: await hashPassword(SUP_PW),
    role: "supervisor",
    assignedSiteIds: vbwSite ? [vbwSite._id] : [],
    active: true,
  });

  const admin = await login(app, ADMIN_EMAIL, ADMIN_PW);

  // Org page loads and shows seeded data.
  const org = await admin.get("/org");
  assert("admin GET /org returns 200", org.status === 200);
  assert("sites ledger shows the summary strip", org.text.includes("oh-statstrip"));
  assert("sites ledger lists the seeded 'Chennai' branch", org.text.includes("Chennai"));
  const newSiteForm = await admin.get("/org/sites/new");
  assert("add-site form has the map picker + in-charge autocomplete", newSiteForm.text.includes('id="site-map"') && newSiteForm.text.includes("leaflet") && newSiteForm.text.includes('id="incharge-list"'));
  assert("add-site form exposes night-shift + allowed-OT fields", newSiteForm.text.includes('name="nightStartTime"') && newSiteForm.text.includes('name="allowedOtHours"'));

  // Create a branch.
  await admin.post("/org/branches").type("form").send({ name: BRANCH });
  const branchDoc = await BranchModel.findOne({ name: BRANCH });
  assert("branch created in DB", !!branchDoc);

  // Create a site under it.
  await admin.post("/org/sites").type("form").send({
    branchId: String(branchDoc!._id),
    name: SITE,
    code: CODE,
    standardStartTime: "09:00",
    standardEndTime: "18:00",
    nightShiftEnabled: "on", nightStartTime: "20:00", nightEndTime: "05:00", allowedOtHours: "4",
    address: "12 Mount Rd", inChargeName: "R. Kumar", inChargePhone: "+91 90000 00000",
    clientName: "Acme Builders",
  });
  const siteDoc = await ProjectSiteModel.findOne({ code: CODE });
  assert("site created in DB", !!siteDoc);
  assert("site code stored uppercase", siteDoc?.code === CODE);
  assert("site profile fields stored", siteDoc?.address === "12 Mount Rd" && siteDoc?.inChargeName === "R. Kumar" && siteDoc?.clientName === "Acme Builders" && siteDoc?.nightShiftEnabled === true);
  assert("night-shift times + allowed OT stored", siteDoc?.shifts?.night?.startTime === "20:00" && siteDoc?.shifts?.night?.endTime === "05:00" && siteDoc?.allowedOtHours === 4);

  // Site detail page (template D) + the branches page.
  const siteView = await admin.get(`/org/sites/${siteDoc!._id}`);
  assert("site detail page → 200 with breadcrumb + code", siteView.status === 200 && siteView.text.includes("View Site") && siteView.text.includes(CODE));
  const branchesPage = await admin.get("/org/branches");
  assert("branches page → 200 and lists the QA branch", branchesPage.status === 200 && branchesPage.text.includes(BRANCH));

  // Duplicate site code is rejected (flash shows on the next render).
  await admin.post("/org/sites").type("form").send({
    branchId: String(branchDoc!._id),
    name: SITE + " dup",
    code: CODE,
    standardStartTime: "09:00",
    standardEndTime: "18:00",
  });
  const afterDup = await admin.get("/org");
  assert("duplicate site code rejected with message", afterDup.text.includes("already exists"));
  assert("no duplicate site persisted", (await ProjectSiteModel.countDocuments({ code: CODE })) === 1);

  // Invalid shift times rejected.
  await admin.post("/org/sites").type("form").send({
    branchId: String(branchDoc!._id),
    name: SITE + " bad",
    code: CODE + "X",
    standardStartTime: "18:00",
    standardEndTime: "09:00",
  });
  assert("end-before-start site not persisted", (await ProjectSiteModel.countDocuments({ code: CODE + "X" })) === 0);

  // HR can add a SITE (manage_sites) but not a BRANCH (manage_org).
  const HR_EMAIL = `qa-orghr-${S}@trgbi.com`;
  await UserModel.create({ name: "QA Org HR", email: HR_EMAIL, passwordHash: await hashPassword(SUP_PW), role: "hr", assignedSiteIds: [], active: true });
  const hr = await login(app, HR_EMAIL, SUP_PW);
  await hr.post("/org/sites").type("form").send({ branchId: String(branchDoc!._id), name: SITE + " HR", code: CODE + "H", standardStartTime: "09:00", standardEndTime: "18:00" });
  assert("HR can create a site (manage_sites)", !!(await ProjectSiteModel.findOne({ code: CODE + "H" })));
  await hr.post("/org/branches").type("form").send({ name: "HR Branch " + S });
  assert("HR can now create a branch (manage_org)", !!(await BranchModel.findOne({ name: "HR Branch " + S })));

  // Designation create + case-insensitive duplicate guard.
  await admin.post("/designations").type("form").send({ name: TRADE });
  assert("designation created", !!(await DesignationModel.findOne({ name: TRADE })));
  const dupDesig = await admin.post("/designations").type("form").send({ name: TRADE.toLowerCase() });
  const afterDesigDup = await admin.get("/designations");
  assert("case-insensitive duplicate designation rejected", afterDesigDup.text.includes("already exists"));
  assert("no duplicate designation persisted", (await DesignationModel.countDocuments({ name: new RegExp(`^${TRADE}$`, "i") })) === 1);
  void dupDesig;

  // Delete guards (admin = management): a branch with sites is blocked; an empty
  // branch and an unstaffed site delete cleanly.
  await admin.post(`/org/branches/${branchDoc!._id}/delete`).type("form").send({});
  assert("branch with sites cannot be deleted", !!(await BranchModel.findById(branchDoc!._id)));
  const hrBranchDoc = await BranchModel.findOne({ name: "HR Branch " + S });
  await admin.post(`/org/branches/${hrBranchDoc!._id}/delete`).type("form").send({});
  assert("empty branch deleted", !(await BranchModel.findById(hrBranchDoc!._id)));
  await admin.post(`/org/sites/${siteDoc!._id}/delete`).type("form").send({});
  assert("unstaffed site deleted", !(await ProjectSiteModel.findById(siteDoc!._id)));

  // Permission matrix: supervisor has READ-ONLY org (scoped to own sites),
  // cannot manage, and can add designations.
  const sup = await login(app, SUP_EMAIL, SUP_PW);
  const supOrg = await sup.get("/org");
  assert("supervisor GET /org → 200 (read-only)", supOrg.status === 200);
  assert("supervisor org shows own site (VBW)", supOrg.text.includes("VBW"));
  assert("supervisor org hides unrelated QA branch", !supOrg.text.includes(BRANCH));
  const supPost = await sup.post("/org/branches").type("form").send({ name: "Sneaky " + S });
  assert("supervisor POST /org/branches → 403 (cannot manage)", supPost.status === 403);
  assert("supervisor branch not created", !(await BranchModel.findOne({ name: "Sneaky " + S })));
  const supSite = await sup.post("/org/sites").type("form").send({ branchId: String(branchDoc!._id), name: "Sneaky Site", code: CODE + "S", standardStartTime: "09:00", standardEndTime: "18:00" });
  assert("supervisor POST /org/sites → 403 (cannot add sites)", supSite.status === 403);
  const supDesig = await sup.get("/designations");
  assert("supervisor GET /designations → 200 (allowed)", supDesig.status === 200);

  // Cleanup.
  await Promise.all([
    BranchModel.deleteMany({ name: { $in: [BRANCH, "HR Branch " + S] } }),
    ProjectSiteModel.deleteMany({ code: new RegExp(`^${CODE}`) }),
    DesignationModel.deleteMany({ name: new RegExp(`^${TRADE}$`, "i") }),
    UserModel.deleteMany({ email: { $in: [SUP_EMAIL, `qa-orghr-${S}@trgbi.com`] } }),
  ]);

  await mongoose.connection.close();
  console.log(process.exitCode ? "\nE2E ORG FAILED" : "\nE2E ORG PASSED");
  process.exit(process.exitCode ?? 0);
}

void main();
