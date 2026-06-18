import { createApp } from "./app";
import { config } from "./config";
import { connectDb } from "./db";
import "./models"; // register all Mongoose models

async function main(): Promise<void> {
  await connectDb(); // tolerant: logs and continues if DB is down
  const app = createApp();
  app.listen(config.port, () => {
    console.log(`TRGBI Attendance running at http://localhost:${config.port}`);
  });
}

void main();
