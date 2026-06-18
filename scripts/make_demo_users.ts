/* Creates one demo user per non-admin role, scoped to seeded sites, so the
   per-role dashboards can be viewed. Idempotent. Run: tsx scripts/make_demo_users.ts */
import mongoose from "mongoose";

import { connectDb } from "../src/db";
import * as db from "../src/db";
import { hashPassword } from "../src/auth/password";
import { ProjectSiteModel, UserModel } from "../src/models";

async function main(): Promise<void> {
  await connectDb();
  if (!db.dbReady) { console.error("DB not reachable."); process.exit(1); }

  const vbw = await ProjectSiteModel.findOne({ code: "VBW" });
  const pvm = await ProjectSiteModel.findOne({ code: "PVM" });
  if (!vbw || !pvm) throw new Error("Run npm run seed first.");

  const pw = await hashPassword("Demo123!");
  const users = [
    { name: "Priya (PM)", email: "pm@trgbi.com", role: "pm", assignedSiteIds: [vbw._id, pvm._id] },
    { name: "Vijay (PE)", email: "pe@trgbi.com", role: "pe", assignedSiteIds: [vbw._id] },
    { name: "Saran (Supervisor)", email: "supervisor@trgbi.com", role: "supervisor", assignedSiteIds: [vbw._id] },
  ];
  for (const u of users) {
    await UserModel.updateOne(
      { email: u.email },
      { $set: { name: u.name, role: u.role, assignedSiteIds: u.assignedSiteIds, active: true, passwordHash: pw } },
      { upsert: true },
    );
    console.log(`ensured ${u.role.padEnd(11)} ${u.email}  (Demo123!)`);
  }
  await mongoose.connection.close();
  process.exit(0);
}
main().catch((e) => { console.error(e?.message ?? e); process.exit(1); });
