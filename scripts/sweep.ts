/* Manual / cron entry point for the missed clock-out sweep.
   Connects to the DB, raises missed_clockout flags for any open attendance
   records, logs the summary, and exits. Safe to re-run (idempotent).
   Run: npm run sweep */

import mongoose from "mongoose";

import { connectDb } from "../src/db";
import * as db from "../src/db";
import { sweepMissedClockouts } from "../src/lib/missedClockout";
import "../src/models"; // register all Mongoose models

async function main(): Promise<void> {
  await connectDb();
  if (!db.dbReady) {
    console.error("Cannot sweep: database not reachable.");
    process.exit(1);
  }
  await sweepMissedClockouts();
  await mongoose.connection.close();
  process.exit(0);
}

main().catch((e) => { console.error("Sweep error:", e?.message ?? e); process.exit(1); });
