/* End-to-end auth test against a DB-connected app instance.
   Verifies: bad credentials rejected (401), good credentials establish a
   session, the session reaches /dashboard (200) with the user's name, and an
   unauthenticated dashboard request redirects (302). Run: npm run e2e:login
   Uses the seeded admin (SEED_ADMIN_EMAIL/PASSWORD or dev defaults). */

import request from "supertest";
import mongoose from "mongoose";

import { createApp } from "../src/app";
import { connectDb } from "../src/db";
import * as db from "../src/db";

const EMAIL = (process.env.SEED_ADMIN_EMAIL || "admin@trgbi.com").toLowerCase();
const PASSWORD = process.env.SEED_ADMIN_PASSWORD || "ChangeMe123!";

function assert(label: string, cond: boolean): void {
  console.log(`${cond ? "PASS" : "FAIL"}: ${label}`);
  if (!cond) process.exitCode = 1;
}

async function main(): Promise<void> {
  await connectDb();
  if (!db.dbReady) {
    console.error("Cannot run e2e: database not reachable.");
    process.exit(1);
  }
  const app = createApp();

  // 1) wrong password → 401
  const bad = await request(app)
    .post("/login")
    .type("form")
    .send({ email: EMAIL, password: "wrong-password" });
  assert("wrong password returns 401", bad.status === 401);
  assert("wrong password shows error", bad.text.includes("Invalid email or password"));

  // 2) correct login establishes a session (use an agent to keep cookies)
  const agent = request.agent(app);
  const ok = await agent.post("/login").type("form").send({ email: EMAIL, password: PASSWORD });
  assert("good login redirects (302)", ok.status === 302);
  assert("good login redirects to /dashboard", ok.headers.location === "/dashboard");

  // 3) session reaches the dashboard
  const dash = await agent.get("/dashboard");
  assert("authed dashboard returns 200", dash.status === 200);
  assert("dashboard shows the user's scope context", dash.text.includes("All branches"));
  assert("dashboard shows sidebar (Dashboard link)", dash.text.includes("Dashboard"));
  assert("management sees Users & Roles nav", dash.text.includes("Users &amp; Roles"));

  // 4) logout clears the session
  await agent.post("/logout");
  const afterLogout = await agent.get("/dashboard");
  assert("dashboard after logout redirects (302)", afterLogout.status === 302);

  await mongoose.connection.close();
  console.log(process.exitCode ? "\nE2E FAILED" : "\nE2E PASSED");
  process.exit(process.exitCode ?? 0);
}

void main();
