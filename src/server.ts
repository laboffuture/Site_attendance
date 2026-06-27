import mongoose from "mongoose";

import { createApp } from "./app";
import { config, assertProdConfig } from "./config";
import { connectDb } from "./db";
import { initFace } from "./lib/face";
import { startDailySweep } from "./lib/scheduler";
import "./models"; // register all Mongoose models

// Crash-safety nets. Registering an unhandledRejection handler overrides Node's
// default (terminate) so a stray rejection logs instead of killing the process —
// a backstop alongside express-async-errors in app.ts. A truly uncaught exception
// leaves the process in an unknown state, so we log and exit for a clean restart.
process.on("unhandledRejection", (reason) => {
  console.error("Unhandled promise rejection:", reason);
});
process.on("uncaughtException", (err) => {
  console.error("Uncaught exception — exiting for a clean restart:", err);
  process.exit(1);
});

async function main(): Promise<void> {
  assertProdConfig(); // refuse to boot prod with an insecure SESSION_SECRET
  await connectDb(); // tolerant: logs and continues if DB is down
  const app = createApp();
  const server = app.listen(config.port, () => {
    console.log(`TRGBI Attendance running at http://localhost:${config.port}`);
    // Warm the face models in the background so the first enrollment is fast.
    initFace().catch((e) => console.warn("Face model warm-up failed:", e?.message ?? e));
    // Schedule the nightly missed-clock-out sweep (also runnable via `npm run sweep`).
    startDailySweep();
  });

  // Graceful shutdown: stop accepting new connections, let in-flight payroll /
  // attendance writes finish, close Mongo, then exit. Force-exit after 10s if a
  // connection hangs, so PM2/systemd can restart cleanly.
  const shutdown = (signal: string): void => {
    console.log(`${signal} received — shutting down gracefully…`);
    server.close(async () => {
      try {
        await mongoose.connection.close();
      } catch (e) {
        console.warn("Error closing Mongo:", (e as Error)?.message ?? e);
      }
      process.exit(0);
    });
    setTimeout(() => {
      console.error("Forced shutdown after timeout.");
      process.exit(1);
    }, 10_000).unref();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

void main();
