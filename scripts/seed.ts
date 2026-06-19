/* Seed script (idempotent): creates the first Management admin and the
   organization reference data from the spec (branches, designations, sites).
   Run with: npm run seed
   Admin credentials come from env (SEED_ADMIN_EMAIL/PASSWORD/NAME) with dev
   defaults. Safe to run repeatedly — existing records are not duplicated. */

import mongoose from "mongoose";

import { connectDb } from "../src/db";
import * as db from "../src/db";
import { hashPassword } from "../src/auth/password";
import {
  BranchModel,
  DesignationModel,
  ProjectSiteModel,
  UserModel,
} from "../src/models";

const DESIGNATIONS = [
  "PM",
  "Supervisor/PE",
  "Carpenter",
  "Mason / Tile Mason",
  "Electrician",
  "Plumber",
  "Welder",
  "Sofa Maker",
  "Helper",
  "Polisher",
  "Painter",
];

const BRANCHES = ["Chennai", "Coimbatore (CBE)", "Kumbakonam"];

// branch name, site name, unique code, shift start/end
const SITES: [string, string, string, string, string][] = [
  ["Chennai", "VBW — T.Nagar / Joinery", "VBW", "09:00", "18:00"],
  ["Chennai", "PVM — Vadapalani", "PVM", "09:00", "18:00"],
  ["Chennai", "ECR — Ponraan / Kadavur", "ECR", "09:00", "18:00"],
  ["Coimbatore (CBE)", "CMS", "CMS", "09:00", "18:00"],
  ["Coimbatore (CBE)", "Joinery (separate unit)", "CBE-JNRY", "09:00", "18:00"],
  ["Kumbakonam", "Pavunnur Mall", "PVNR", "09:00", "18:00"],
];

async function main(): Promise<void> {
  await connectDb();
  if (!db.dbReady) {
    console.error("Cannot seed: database not reachable. Set MONGODB_URI in .env.");
    process.exit(1);
  }

  // Designations
  for (const name of DESIGNATIONS) {
    await DesignationModel.updateOne({ name }, { $setOnInsert: { name } }, { upsert: true });
  }
  console.log(`Designations ensured: ${DESIGNATIONS.length}`);

  // Branches
  const branchIdByName = new Map<string, mongoose.Types.ObjectId>();
  for (const name of BRANCHES) {
    const b = await BranchModel.findOneAndUpdate(
      { name },
      { $setOnInsert: { name } },
      { upsert: true, new: true },
    );
    branchIdByName.set(name, b!._id);
  }
  console.log(`Branches ensured: ${BRANCHES.length}`);

  // Project sites (keyed by unique code)
  for (const [branchName, name, code, start, end] of SITES) {
    const branchId = branchIdByName.get(branchName);
    await ProjectSiteModel.updateOne(
      { code },
      {
        $set: {
          branchId,
          name,
          standardStartTime: start,
          standardEndTime: end,
        },
        $setOnInsert: { code },
      },
      { upsert: true },
    );
  }
  console.log(`Project sites ensured: ${SITES.length}`);

  // First Super Admin (chairman / root account)
  const email = (process.env.SEED_ADMIN_EMAIL || "admin@trgbi.com").toLowerCase().trim();
  const existing = await UserModel.findOne({ email });
  if (existing) {
    console.log(`Admin already exists: ${email} (left unchanged).`);
  } else {
    const password = process.env.SEED_ADMIN_PASSWORD || "ChangeMe123!";
    await UserModel.create({
      name: process.env.SEED_ADMIN_NAME || "TRGBI Admin",
      email,
      passwordHash: await hashPassword(password),
      role: "super_admin",
      assignedSiteIds: [],
      active: true,
    });
    console.log("\nCreated Super Admin:");
    console.log(`  email:    ${email}`);
    console.log(
      `  password: ${process.env.SEED_ADMIN_PASSWORD ? "[from SEED_ADMIN_PASSWORD]" : password}`,
    );
    if (!process.env.SEED_ADMIN_PASSWORD) {
      console.log("  ** Change this password after first login. **");
    }
  }

  await mongoose.connection.close();
  console.log("\nSeed complete.");
  process.exit(0);
}

void main();
