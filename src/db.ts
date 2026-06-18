import mongoose from "mongoose";

import { config } from "./config";

export let dbReady = false;

/**
 * Connect to MongoDB. Tolerant by design: if the database is unreachable
 * (e.g. no MONGODB_URI set yet), the server still boots so the login page
 * renders. Data features stay disabled until a reachable URI is configured.
 */
export async function connectDb(): Promise<void> {
  try {
    await mongoose.connect(config.mongodbUri, {
      dbName: config.dbName,
      serverSelectionTimeoutMS: 3000,
    });
    dbReady = true;
    console.log(`Connected to MongoDB database '${config.dbName}'.`);
  } catch (err) {
    dbReady = false;
    console.warn(
      `MongoDB not reachable (${(err as Error).message}). Booting without DB.`,
    );
  }
}
