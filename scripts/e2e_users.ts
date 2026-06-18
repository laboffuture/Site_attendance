/* End-to-end test for Users & Roles management.
   Verifies create + site rules + unique email; HR's limited authority (manage
   below HR only, can't see/manage Management); and self-lockout protection.
   Creates QA users and cleans them up. Run: npm run e2e:users */

import request from "supertest";
import mongoose from "mongoose";

import { createApp } from "../src/app";
import { connectDb } from "../src/db";
import * as db from "../src/db";
import { ProjectSiteModel, UserModel } from "../src/models";

const ADMIN_EMAIL = (process.env.SEED_ADMIN_EMAIL || "admin@trgbi.com").toLowerCase();
const ADMIN_PW = process.env.SEED_ADMIN_PASSWORD || "ChangeMe123!";
const S = Date.now().toString(36);
const PE = `qa-pe-${S}@trgbi.com`;
const HR = `qa-hr-${S}@trgbi.com`;
const SUP = `qa-sup-${S}@trgbi.com`;
const MGMT = `qa-mgmt-${S}@trgbi.com`;
const PW = "Pass123!";

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
  if (!db.dbReady) { console.error("DB not reachable."); process.exit(1); }
  const app = createApp();

  const vbw = await ProjectSiteModel.findOne({ code: "VBW" });
  if (!vbw) throw new Error("Seed data missing — run npm run seed.");
  const adminUser = await UserModel.findOne({ email: ADMIN_EMAIL });

  const admin = await login(app, ADMIN_EMAIL, ADMIN_PW);

  assert("admin GET /users → 200", (await admin.get("/users")).status === 200);

  // Create a PE with exactly one site.
  await admin.post("/users").type("form").send({ name: "QA PE", email: PE, password: PW, role: "pe", assignedSiteIds: String(vbw._id) });
  const pe = await UserModel.findOne({ email: PE });
  assert("PE created", !!pe && pe.role === "pe");
  assert("PE assigned exactly one site", !!pe && pe.assignedSiteIds.length === 1 && String(pe.assignedSiteIds[0]) === String(vbw._id));

  // PE with no site is rejected.
  await admin.post("/users").type("form").send({ name: "QA PE2", email: `qa-pe2-${S}@trgbi.com`, password: PW, role: "pe" });
  assert("PE without a site is rejected", !(await UserModel.findOne({ email: `qa-pe2-${S}@trgbi.com` })));

  // Create an HR (Management may).
  await admin.post("/users").type("form").send({ name: "QA HR", email: HR, password: PW, role: "hr" });
  const hr = await UserModel.findOne({ email: HR });
  assert("HR created with no sites (all)", !!hr && hr.role === "hr" && hr.assignedSiteIds.length === 0);

  // Duplicate email rejected.
  const before = await UserModel.countDocuments({ email: PE });
  await admin.post("/users").type("form").send({ name: "Dup", email: PE, password: PW, role: "pe", assignedSiteIds: String(vbw._id) });
  assert("duplicate email rejected", (await UserModel.countDocuments({ email: PE })) === before);

  // Self-lockout: admin cannot deactivate own account.
  await admin.post(`/users/${adminUser!._id}/toggle`).type("form").send({});
  assert("admin cannot deactivate self", (await UserModel.findById(adminUser!._id))?.active === true);

  // HR authority.
  const hrAgent = await login(app, HR, PW);
  const hrList = await hrAgent.get("/users");
  assert("HR GET /users → 200", hrList.status === 200);
  assert("HR list excludes Management admin", !hrList.text.includes(ADMIN_EMAIL));
  await hrAgent.post("/users").type("form").send({ name: "QA Sup", email: SUP, password: PW, role: "supervisor", assignedSiteIds: String(vbw._id) });
  assert("HR can create a Supervisor", !!(await UserModel.findOne({ email: SUP })));
  await hrAgent.post("/users").type("form").send({ name: "QA Mgmt", email: MGMT, password: PW, role: "management" });
  assert("HR cannot create Management", !(await UserModel.findOne({ email: MGMT })));
  assert("HR cannot open Management user's edit", (await hrAgent.get(`/users/${adminUser!._id}/edit`)).status === 302);

  // A PE has no access to user management.
  const peAgent = await login(app, PE, PW);
  assert("PE GET /users → 403", (await peAgent.get("/users")).status === 403);

  // Cleanup.
  await UserModel.deleteMany({ email: { $in: [PE, HR, SUP, MGMT, `qa-pe2-${S}@trgbi.com`] } });

  await mongoose.connection.close();
  console.log(process.exitCode ? "\nE2E USERS FAILED" : "\nE2E USERS PASSED");
  process.exit(process.exitCode ?? 0);
}

main().catch((e) => { console.error("\nE2E USERS ERROR:", e?.message ?? e); process.exit(1); });
