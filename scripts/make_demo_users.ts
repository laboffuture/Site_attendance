/* Creates one demo login per non-top role (HR, PM, Supervisor), scoped to the
   IMPORTED sites so each role-scoped dashboard shows real data. Idempotent.
   The top tier (Management / super_admin) is the seeded admin@trgbi.com.
   Run: npm run demo-staff */
import mongoose from "mongoose";

import { connectDb } from "../src/db";
import * as db from "../src/db";
import { hashPassword } from "../src/auth/password";
import { ProjectSiteModel, UserModel } from "../src/models";

async function siteIds(codes: string[]): Promise<mongoose.Types.ObjectId[]> {
  const sites = await ProjectSiteModel.find({ code: { $in: codes } }).select("_id code").lean();
  const found = new Set(sites.map((s) => s.code));
  const missing = codes.filter((c) => !found.has(c));
  if (missing.length) throw new Error(`Sites not found: ${missing.join(", ")} — run npm run import-master first.`);
  return sites.map((s) => s._id);
}

async function main(): Promise<void> {
  await connectDb();
  if (!db.dbReady) { console.error("DB not reachable."); process.exit(1); }

  const chennai = await siteIds(["VBW-TNG", "VBW-JNRY", "VBW-VEL", "VBW-VPL", "ECR-PNR", "TRI-FAC"]);
  const supervisorSites = await siteIds(["VBW-TNG", "VBW-VPL"]); // multi-site supervisor

  const pw = await hashPassword("Demo123!");
  const users = [
    { name: "Hema (HR)", email: "hr@trgbi.com", role: "hr", assignedSiteIds: [] as mongoose.Types.ObjectId[], scope: "all sites" },
    { name: "Priya (PM)", email: "pm@trgbi.com", role: "pm", assignedSiteIds: chennai, scope: "Chennai sites (6)" },
    { name: "Saran (Supervisor)", email: "supervisor@trgbi.com", role: "supervisor", assignedSiteIds: supervisorSites, scope: "T Nagar + Vadapalani" },
  ];
  for (const u of users) {
    await UserModel.updateOne(
      { email: u.email },
      { $set: { name: u.name, role: u.role, assignedSiteIds: u.assignedSiteIds, active: true, passwordHash: pw } },
      { upsert: true },
    );
  }

  console.log("\n==============  DEMO LOGINS (password: Demo123!)  ==============");
  console.log("  Management :  admin@trgbi.com        / ChangeMe123!   (top — all access)");
  for (const u of users) {
    console.log(`  ${u.role.toUpperCase().padEnd(11)}:  ${u.email.padEnd(22)} / Demo123!   (${u.scope})`);
  }
  console.log("================================================================\n");

  await mongoose.connection.close();
  process.exit(0);
}
main().catch((e) => { console.error(e?.message ?? e); process.exit(1); });
