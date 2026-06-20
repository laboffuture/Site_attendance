/* Seeds per-site shift definitions on existing project sites that lack them.
   Idempotent. The `day` window is seeded from any legacy standardStartTime/
   EndTime; night + sunday use the matrix defaults. Run: npm run migrate-shifts */
import mongoose from "mongoose";

import { connectDb } from "../src/db";
import * as db from "../src/db";
import { DEFAULT_SHIFTS } from "../src/lib/shift";
import { ProjectSiteModel } from "../src/models";

async function main(): Promise<void> {
  await connectDb();
  if (!db.dbReady) { console.error("DB not reachable."); process.exit(1); }

  const sites = await ProjectSiteModel.find({}).lean();
  let updated = 0;
  for (const s of sites) {
    if (s.shifts && (s.shifts as { day?: unknown }).day) continue; // already has shifts
    const day = {
      ...DEFAULT_SHIFTS.day,
      startTime: (s as { standardStartTime?: string }).standardStartTime || DEFAULT_SHIFTS.day.startTime,
      endTime: (s as { standardEndTime?: string }).standardEndTime || DEFAULT_SHIFTS.day.endTime,
    };
    await ProjectSiteModel.updateOne(
      { _id: s._id },
      { $set: { shifts: { day, night: DEFAULT_SHIFTS.night, sunday: DEFAULT_SHIFTS.sunday } } },
    );
    updated++;
  }
  console.log(`Shift migration: ${updated} site(s) seeded, ${sites.length - updated} already had shifts.`);
  await mongoose.connection.close();
  process.exit(0);
}
main().catch((e) => { console.error("MIGRATE SHIFTS ERROR:", e?.message ?? e); process.exit(1); });
