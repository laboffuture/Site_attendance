/* Reconciles MongoDB indexes with the current Mongoose schemas.
   syncIndexes() drops indexes not defined on the model and creates missing
   ones. Useful after schema changes — and required here to remove stale
   snake_case indexes (worker_id, emp_reg_no, …) left behind by the discarded
   Python/Beanie experiment that shared this dev database. Run: npm run sync-indexes */

import mongoose from "mongoose";

import { connectDb } from "../src/db";
import * as db from "../src/db";
import {
  BranchModel, DesignationModel, ProjectSiteModel, SiteStationModel,
  UserModel, WorkerModel, AttendanceModel, FlagEventModel, CounterModel,
  RequestModel, PayrollAdjustmentModel, ManpowerRequestModel,
  OutsourceEmployeeModel, LoginGeoCheckModel,
} from "../src/models";

async function main(): Promise<void> {
  await connectDb();
  if (!db.dbReady) {
    console.error("Cannot sync indexes: database not reachable.");
    process.exit(1);
  }
  const models = [
    BranchModel, DesignationModel, ProjectSiteModel, SiteStationModel,
    UserModel, WorkerModel, AttendanceModel, FlagEventModel, CounterModel,
    RequestModel, PayrollAdjustmentModel, ManpowerRequestModel,
    OutsourceEmployeeModel, LoginGeoCheckModel,
  ];
  for (const M of models) {
    const dropped = await M.syncIndexes();
    console.log(`${M.collection.name}: dropped [${dropped.join(", ") || "—"}]`);
  }
  await mongoose.connection.close();
  console.log("\nIndexes synced.");
  process.exit(0);
}

main().catch((e) => { console.error(e?.message ?? e); process.exit(1); });
