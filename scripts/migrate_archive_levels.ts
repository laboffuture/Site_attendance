/* One-time migration for the two-level delete (Archives vs Deletion log):
   - Workers previously soft-deleted (status "deleted") were shown in the
     Archives tab, so they become "archived". "deleted" now means hidden
     everywhere + listed in the Deletion log.
   - Sites gain a lifecycle status; existing docs get "active" explicitly so
     status-filtered queries match them.
   Idempotent — safe to run more than once. Run: npx tsx scripts/migrate_archive_levels.ts */
import mongoose from "mongoose";

import { connectDb } from "../src/db";
import * as db from "../src/db";
import { ProjectSiteModel } from "../src/models/ProjectSite";
import { WorkerModel } from "../src/models/Worker";

async function main(): Promise<void> {
  await connectDb();
  if (!db.dbReady) {
    console.error("Database not reachable.");
    process.exit(1);
  }
  const w = await WorkerModel.updateMany({ status: "deleted" }, { $set: { status: "archived" } });
  const s = await ProjectSiteModel.updateMany({ status: { $exists: false } }, { $set: { status: "active" } });
  console.log(`Workers deleted -> archived: ${w.modifiedCount}`);
  console.log(`Sites given status "active": ${s.modifiedCount}`);
  await mongoose.connection.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
