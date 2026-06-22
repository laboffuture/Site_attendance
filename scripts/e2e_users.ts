/* End-to-end test for Users & Roles management (new hierarchy:
   Super Admin → Management → HR → PM → Supervisor; PE removed).
   Verifies create + site rules + unique email; assignment authority by tier
   (Super Admin all; Management all-but-super_admin; HR below HR); list scoping;
   and self-lockout. Creates QA users and cleans them up. Run: npm run e2e:users */

import request from "supertest";
import mongoose from "mongoose";

import { createApp } from "../src/app";
import { connectDb } from "../src/db";
import * as db from "../src/db";
import { ProjectSiteModel, UserModel } from "../src/models";

const ADMIN_EMAIL = (process.env.SEED_ADMIN_EMAIL || "admin@trgbi.com").toLowerCase();
const ADMIN_PW = process.env.SEED_ADMIN_PASSWORD || "ChangeMe123!";
const S = Date.now().toString(36);
const MGMT = `qa-mgmt-${S}@trgbi.com`;
const HR = `qa-hr-${S}@trgbi.com`;
const PM = `qa-pm-${S}@trgbi.com`;
const SUP = `qa-sup-${S}@trgbi.com`;
const SUPER = `qa-super-${S}@trgbi.com`;
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
  assert("bootstrap admin is management (super_admin merged in)", adminUser?.role === "management");

  const admin = await login(app, ADMIN_EMAIL, ADMIN_PW);
  assert("admin (management) GET /users → 200", (await admin.get("/users")).status === 200);

  // Top admin (Management) can create Management and HR.
  await admin.post("/users").type("form").send({ name: "QA Mgmt", email: MGMT, password: PW, role: "management" });
  assert("super admin can create Management", (await UserModel.findOne({ email: MGMT }))?.role === "management");
  await admin.post("/users").type("form").send({ name: "QA HR", email: HR, password: PW, role: "hr", phone: "+1 555 0100" });
  const hr = await UserModel.findOne({ email: HR });
  assert("HR created with no sites (all)", !!hr && hr.role === "hr" && hr.assignedSiteIds.length === 0);
  assert("phone stored on create", hr?.phone === "+1 555 0100");
  assert("phone shown in the list", (await admin.get("/users")).text.includes("+1 555 0100"));
  // Edit can change the phone.
  await admin.post(`/users/${hr!._id}`).type("form").send({ name: "QA HR", email: HR, role: "hr", phone: "555 0199" });
  assert("phone updated on edit", (await UserModel.findById(hr!._id))?.phone === "555 0199");

  // PM requires at least one site.
  await admin.post("/users").type("form").send({ name: "QA PM noSite", email: PM, password: PW, role: "pm" });
  assert("PM without a site is rejected", !(await UserModel.findOne({ email: PM })));
  await admin.post("/users").type("form").send({ name: "QA PM", email: PM, password: PW, role: "pm", assignedSiteIds: String(vbw._id) });
  assert("PM with a site is created", (await UserModel.findOne({ email: PM }))?.role === "pm");

  // Duplicate email rejected.
  const before = await UserModel.countDocuments({ email: HR });
  await admin.post("/users").type("form").send({ name: "Dup", email: HR, password: PW, role: "hr" });
  assert("duplicate email rejected", (await UserModel.countDocuments({ email: HR })) === before);

  // Self-lockout: the top admin cannot deactivate own account.
  await admin.post(`/users/${adminUser!._id}/toggle`).type("form").send({});
  assert("top admin cannot deactivate self", (await UserModel.findById(adminUser!._id))?.active === true);

  // Management is the top tier: creates any role (incl. Management) and sees everyone.
  const mgmtAgent = await login(app, MGMT, PW);
  await mgmtAgent.post("/users").type("form").send({ name: "QA Sup", email: SUP, password: PW, role: "supervisor", assignedSiteIds: String(vbw._id) });
  assert("Management can create a Supervisor", !!(await UserModel.findOne({ email: SUP })));
  await mgmtAgent.post("/users").type("form").send({ name: "QA Mgmt3", email: SUPER, password: PW, role: "management" });
  assert("Management can create another Management", (await UserModel.findOne({ email: SUPER }))?.role === "management");
  assert("Management list includes other Management", (await mgmtAgent.get("/users")).text.includes(ADMIN_EMAIL));

  // HR authority: below HR only; cannot create Management or open its edit.
  const hrAgent = await login(app, HR, PW);
  assert("HR GET /users → 200", (await hrAgent.get("/users")).status === 200);
  await hrAgent.post("/users").type("form").send({ name: "QA Mgmt2", email: `qa-m2-${S}@trgbi.com`, password: PW, role: "management" });
  assert("HR cannot create Management", !(await UserModel.findOne({ email: `qa-m2-${S}@trgbi.com` })));
  assert("HR cannot open a Management user's edit", (await hrAgent.get(`/users/${(await UserModel.findOne({ email: MGMT }))!._id}/edit`)).status === 302);

  // Supervisor has no access to user management.
  const supAgent = await login(app, SUP, PW);
  assert("Supervisor GET /users → 403", (await supAgent.get("/users")).status === 403);

  // Cleanup.
  await UserModel.deleteMany({ email: { $in: [MGMT, HR, PM, SUP, SUPER, `qa-m2-${S}@trgbi.com`] } });

  await mongoose.connection.close();
  console.log(process.exitCode ? "\nE2E USERS FAILED" : "\nE2E USERS PASSED");
  process.exit(process.exitCode ?? 0);
}

main().catch((e) => { console.error("\nE2E USERS ERROR:", e?.message ?? e); process.exit(1); });
