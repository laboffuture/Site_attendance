/* E2E for the Supervisor work order (S2 multi-site + S3 dashboard filter/ratio).
   Verifies: a Supervisor can be assigned 2 sites; their dashboard shows the
   site dropdown, a present/total ("% present today") card, and the site filter
   narrows the scope label. Cleans up. Run: npm run e2e:supervisor */

import request from "supertest";
import mongoose from "mongoose";

import { createApp } from "../src/app";
import { connectDb } from "../src/db";
import * as db from "../src/db";
import { ProjectSiteModel, UserModel } from "../src/models";

const ADMIN_EMAIL = (process.env.SEED_ADMIN_EMAIL || "admin@trgbi.com").toLowerCase();
const ADMIN_PW = process.env.SEED_ADMIN_PASSWORD || "ChangeMe123!";
const S = Date.now().toString(36);
const SUP_EMAIL = `qa-msup-${S}@trgbi.com`;
const PW = "Pass123!";

function assert(label: string, cond: boolean): void {
  console.log(`${cond ? "PASS" : "FAIL"}: ${label}`);
  if (!cond) process.exitCode = 1;
}
async function login(app: ReturnType<typeof createApp>, email: string, pw: string) {
  const agent = request.agent(app);
  const r = await agent.post("/login").type("form").send({ email, password: pw });
  if (r.status !== 302) throw new Error(`login failed ${email}`);
  return agent;
}

async function main(): Promise<void> {
  await connectDb();
  if (!db.dbReady) { console.error("DB not reachable."); process.exit(1); }
  const app = createApp();

  const vbw = await ProjectSiteModel.findOne({ code: "VBW" });
  const pvm = await ProjectSiteModel.findOne({ code: "PVM" });
  if (!vbw || !pvm) throw new Error("Run npm run seed first.");

  const admin = await login(app, ADMIN_EMAIL, ADMIN_PW);

  // S2: create a Supervisor assigned to TWO sites — must be accepted now.
  await admin.post("/users").type("form").send({
    name: "QA MultiSup",
    email: SUP_EMAIL,
    password: PW,
    role: "supervisor",
    assignedSiteIds: [String(vbw._id), String(pvm._id)],
  });
  const sup = await UserModel.findOne({ email: SUP_EMAIL });
  assert("supervisor created", !!sup && sup.role === "supervisor");
  assert("supervisor accepted with 2 sites", !!sup && sup.assignedSiteIds.length === 2);

  // S3: their dashboard has the site dropdown + present/total + filter.
  const supAgent = await login(app, SUP_EMAIL, PW);
  const dash = await supAgent.get("/dashboard");
  assert("dashboard 200", dash.status === 200);
  assert("site dropdown present (All my sites)", dash.text.includes("All my sites"));
  assert("dropdown lists both sites", dash.text.includes("(VBW)") && dash.text.includes("(PVM)"));
  assert("present/total card shows % present", dash.text.includes("% present today"));
  assert("default scope = 2 assigned sites", dash.text.includes("2 assigned site(s)"));
  assert("assigned-locations chips shown", dash.text.includes("assigned location") && dash.text.includes("oh-loc-chip"));
  assert("present-vs-active visualization present", dash.text.includes("presenceChart") && dash.text.includes("Present vs active"));

  // filter to one site → scope label becomes that site's name.
  const filtered = await supAgent.get(`/dashboard?siteId=${vbw._id}`);
  assert("site filter narrows scope label to the site", filtered.text.includes(vbw.name));

  await UserModel.deleteOne({ email: SUP_EMAIL });
  await mongoose.connection.close();
  console.log(process.exitCode ? "\nE2E SUPERVISOR FAILED" : "\nE2E SUPERVISOR PASSED");
  process.exit(process.exitCode ?? 0);
}
main().catch((e) => { console.error("\nE2E SUPERVISOR ERROR:", e?.message ?? e); process.exit(1); });
