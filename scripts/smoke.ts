/* Quick boot smoke test: does the app start and render the login page?
   Uses supertest against the in-process Express app (no port needed).
   Note: this imports the app only (not the server), so it does not connect
   to MongoDB — the db-not-connected banner is expected here. */

import request from "supertest";

import { createApp } from "../src/app";

async function main(): Promise<void> {
  const app = createApp();

  const h = await request(app).get("/healthz");
  console.log("healthz:", h.status, h.body);

  const r = await request(app).get("/");
  console.log("root:", r.status, "bytes:", r.text.length);
  console.log("  has 'Sign In':", r.text.includes("Sign In"));
  console.log("  has db-not-connected banner:", r.text.includes("Database not connected"));

  const guarded = await request(app).get("/dashboard");
  console.log("dashboard (unauthed):", guarded.status, "→ location:", guarded.headers.location);

  const css = await request(app).get("/static/css/theme.css");
  console.log("theme.css:", css.status, "bytes:", (css.text ?? "").length);
}

void main();
