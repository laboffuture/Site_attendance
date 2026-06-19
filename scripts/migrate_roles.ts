/* One-off migration for the role-hierarchy change (2026-06-19):
   - PE is removed → convert any `pe` users to `supervisor` (same capabilities).
   - Super Admin is the new top tier → promote the bootstrap admin
     (SEED_ADMIN_EMAIL) from `management` to `super_admin` so there is a
     chairman account. Idempotent. Run: npm run migrate-roles */
import mongoose from "mongoose";

import { connectDb } from "../src/db";
import * as db from "../src/db";
import { UserModel } from "../src/models";

async function main(): Promise<void> {
  await connectDb();
  if (!db.dbReady) { console.error("DB not reachable."); process.exit(1); }

  const peRes = await UserModel.updateMany({ role: "pe" }, { $set: { role: "supervisor" } });
  console.log(`PE → Supervisor: ${peRes.modifiedCount} user(s) converted.`);

  const adminEmail = (process.env.SEED_ADMIN_EMAIL || "admin@trgbi.com").toLowerCase().trim();
  const admin = await UserModel.findOne({ email: adminEmail });
  if (admin && admin.role !== "super_admin") {
    admin.role = "super_admin" as never;
    await admin.save();
    console.log(`Promoted ${adminEmail} → Super Admin.`);
  } else if (admin) {
    console.log(`${adminEmail} already Super Admin.`);
  } else {
    console.log(`Bootstrap admin ${adminEmail} not found (run npm run seed).`);
  }

  // Safety: report any users left on an unknown role.
  const known = ["super_admin", "management", "hr", "pm", "supervisor"];
  const orphans = await UserModel.find({ role: { $nin: known } }).select("email role").lean();
  if (orphans.length) {
    console.log("\n⚠ Users on unknown roles (review):");
    orphans.forEach((o) => console.log(`  ${o.email} → ${o.role}`));
  }

  await mongoose.connection.close();
  console.log("\nRole migration complete.");
  process.exit(0);
}
main().catch((e) => { console.error(e?.message ?? e); process.exit(1); });
