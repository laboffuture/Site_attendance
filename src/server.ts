import { createApp } from "./app";
import { config } from "./config";
import { connectDb } from "./db";
import { initFace } from "./lib/face";
import { startDailySweep } from "./lib/scheduler";
import "./models"; // register all Mongoose models

async function main(): Promise<void> {
  await connectDb(); // tolerant: logs and continues if DB is down
  const app = createApp();
  app.listen(config.port, () => {
    console.log(`TRGBI Attendance running at http://localhost:${config.port}`);
    // Warm the face models in the background so the first enrollment is fast.
    initFace().catch((e) => console.warn("Face model warm-up failed:", e?.message ?? e));
    // Schedule the nightly missed-clock-out sweep (also runnable via `npm run sweep`).
    startDailySweep();
  });
}

void main();
