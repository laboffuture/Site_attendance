/* Logs in as each role and prints what their dashboard renders: the scope
   label, the clickable sidebar items, and the live stat-card values.
   Demonstrates the per-role (hierarchy) scoping. Run: tsx scripts/show_role_dashboards.ts */
import request from "supertest";
import mongoose from "mongoose";

import { createApp } from "../src/app";
import { connectDb } from "../src/db";
import * as db from "../src/db";

const ACCOUNTS: [string, string, string][] = [
  ["Management", "admin@trgbi.com", "ChangeMe123!"],
  ["PM", "pm@trgbi.com", "Demo123!"],
  ["PE", "pe@trgbi.com", "Demo123!"],
  ["Supervisor", "supervisor@trgbi.com", "Demo123!"],
];

function between(html: string, re: RegExp): string {
  const m = re.exec(html);
  return m ? m[1].replace(/\s+/g, " ").trim() : "—";
}

async function main(): Promise<void> {
  await connectDb();
  if (!db.dbReady) { console.error("DB not reachable."); process.exit(1); }
  const app = createApp();

  for (const [label, email, pw] of ACCOUNTS) {
    const agent = request.agent(app);
    const login = await agent.post("/login").type("form").send({ email, password: pw });
    if (login.status !== 302) { console.log(`${label}: LOGIN FAILED (${login.status})`); continue; }

    const html = (await agent.get("/dashboard")).text;
    const scope = between(html, /Scope:\s*([^<]+)</);
    const nav = [...html.matchAll(/<span>([^<]+)<\/span>\s*<\/a>/g)].map((m) => m[1]);
    const cards = [...html.matchAll(/oh-card__label">([^<]+)<\/div>\s*<div class="oh-card__value">([^<]+)</g)]
      .map((m) => `${m[1].trim()}=${m[2].trim()}`);

    console.log(`\n===== ${label}  <${email}> =====`);
    console.log(`  scope    : ${scope}`);
    console.log(`  sidebar  : ${nav.join(", ")}`);
    console.log(`  stats    : ${cards.join("  ·  ")}`);

    // Hierarchy rollup rows (branch totals + indented sites), if present.
    if (html.includes("By branch")) {
      console.log("  hierarchy rollup:");
      const rowRe = /<tr class="oh-rollup-(branch|site)"[\s\S]*?<\/tr>/g;
      for (const m of html.matchAll(rowRe)) {
        const cells = [...m[0].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((c) =>
          c[1].replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&#9660;/g, "").replace(/\s+/g, " ").trim(),
        );
        const indent = m[1] === "site" ? "      - " : "    ";
        console.log(`${indent}${cells[0].padEnd(26)} present=${cells[1]} active=${cells[2]} otPend=${cells[3]} flags=${cells[4]}`);
      }
    } else {
      console.log("  hierarchy rollup: (none — single-site role)");
    }
  }

  await mongoose.connection.close();
  process.exit(0);
}
main().catch((e) => { console.error(e?.message ?? e); process.exit(1); });
