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

  // Supervisor for the permission checks.
  await UserModel.create({
    name: "QA Supervisor",
    email: SUP_EMAIL,
    passwordHash: await hashPassword(SUP_PW),
    role: "supervisor",
    assignedSiteIds: [],
    active: true,
  });

  const admin = await login(app, ADMIN_EMAIL, ADMIN_PW);

  // Org page loads and shows seeded data.
  const org = await admin.get("/org");
  assert("admin GET /org returns 200", org.status === 200);
  assert("org page lists seeded 'Chennai' branch", org.text.includes("Chennai"));

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
  });
  const siteDoc = await ProjectSiteModel.findOne({ code: CODE });
  assert("site created in DB", !!siteDoc);
  assert("site code stored uppercase", siteDoc?.code === CODE);

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

  // Designation create + case-insensitive duplicate guard.
  await admin.post("/designations").type("form").send({ name: TRADE });
  assert("designation created", !!(await DesignationModel.findOne({ name: TRADE })));
  const dupDesig = await admin.post("/designations").type("form").send({ name: TRADE.toLowerCase() });
  const afterDesigDup = await admin.get("/designations");
  assert("case-insensitive duplicate designation rejected", afterDesigDup.text.includes("already exists"));
  assert("no duplicate designation persisted", (await DesignationModel.countDocuments({ name: new RegExp(`^${TRADE}$`, "i") })) === 1);
  void dupDesig;

  // Permission matrix: supervisor blocked from org, allowed designations.
  const sup = await login(app, SUP_EMAIL, SUP_PW);
  const supOrg = await sup.get("/org");
  assert("supervisor GET /org → 403", supOrg.status === 403);
  const supPost = await sup.post("/org/branches").type("form").send({ name: "Sneaky " + S });
  assert("supervisor POST /org/branches → 403", supPost.status === 403);
  assert("supervisor branch not created", !(await BranchModel.findOne({ name: "Sneaky " + S })));
  const supDesig = await sup.get("/designations");
  assert("supervisor GET /designations → 200 (allowed)", supDesig.status === 200);

  // Cleanup.
  await Promise.all([
    BranchModel.deleteOne({ name: BRANCH }),
    ProjectSiteModel.deleteOne({ code: CODE }),
    DesignationModel.deleteMany({ name: new RegExp(`^${TRADE}$`, "i") }),
    UserModel.deleteOne({ email: SUP_EMAIL }),
  ]);

  await mongoose.connection.close();
  console.log(process.exitCode ? "\nE2E ORG FAILED" : "\nE2E ORG PASSED");
  process.exit(process.exitCode ?? 0);
}

void main();
