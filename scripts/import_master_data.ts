/* Imports the TRGBI "Chennai site - Basic details" workbook into the DB:
   ensures canonical Branches / Project Sites / Designations, then loads the
   ACTIVE daily-wage workers from the Master Data sheet (identity, cleaned
   designation, best-effort current site, DOJ, bank). Inactive + staff rows are
   skipped (handled separately). Idempotent: clears workers/attendance/flags
   first, then upserts. Workers come in WITHOUT face data (enrolled later).

   Run (LOCAL):  npm run import-master
   Custom file:  IMPORT_FILE="/path/to.xlsx" npm run import-master */

import path from "path";

import ExcelJS from "exceljs";
import mongoose from "mongoose";

import { config } from "../src/config";
import { connectDb } from "../src/db";
import * as db from "../src/db";
import {
  BranchModel, DesignationModel, ProjectSiteModel, WorkerModel,
  AttendanceModel, FlagEventModel, RequestModel,
} from "../src/models";

const FILE = process.env.IMPORT_FILE ||
  "/Users/jagathguru/Downloads/Chennai site - Basic details (1).xlsx";

// ---- canonical org ----
const BRANCHES = ["Chennai", "CBE (Coimbatore)", "Kumbakonam", "Unassigned"];
const SITES = [
  { name: "VBW – T Nagar", code: "VBW-TNG", branch: "Chennai" },
  { name: "VBW – T Nagar (Joinery)", code: "VBW-JNRY", branch: "Chennai" },
  { name: "VBW – Velachery", code: "VBW-VEL", branch: "Chennai" },
  { name: "VBW – Vadapalani", code: "VBW-VPL", branch: "Chennai" },
  { name: "ECR – Ponram", code: "ECR-PNR", branch: "Chennai" },
  { name: "TRI – Factory", code: "TRI-FAC", branch: "Chennai" },
  { name: "CMIS", code: "CMIS", branch: "CBE (Coimbatore)" },
  { name: "Kumbakonam", code: "KMB", branch: "Kumbakonam" },
  { name: "Unassigned Pool", code: "POOL", branch: "Unassigned" },
];
// per-site roster sheet -> canonical site name (current allocation source)
const SHEET2SITE: Record<string, string> = {
  "VBW- T Nagar ": "VBW – T Nagar",
  "VBW - T Nagar JNRY": "VBW – T Nagar (Joinery)",
  "TRG - Toast me later @ VPalani": "VBW – Vadapalani",
  "CMIS": "CMIS",
  "TRG-PONRAM@ECR": "ECR – Ponram",
};

function cellText(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    if (o.text !== undefined) return String(o.text);
    if (o.result !== undefined) return String(o.result);
    if (Array.isArray(o.richText)) return o.richText.map((r) => (r as { text: string }).text).join("");
    if (v instanceof Date) return v.toISOString().slice(0, 10);
    return "";
  }
  return String(v).trim();
}
const normCode = (c: string) => c.toUpperCase().replace(/\s+/g, "").replace(/-+/g, "-");

/** Messy designation -> clean primary trade, or "STAFF" (becomes a user, skip). */
function canonDesig(raw: string): string {
  const s = raw.toLowerCase().replace(/\s+/g, " ").trim();
  if (/director|head -|interiors supervisor|site engineer|^supervisor$/.test(s)) return "STAFF";
  const p = s.split(/[/&(]/)[0].trim();
  if (p.startsWith("gypsum")) return "Gypsum Carpenter";
  if (p.startsWith("carpen")) return "Carpenter";
  if (p.startsWith("electric") || p.startsWith("electricain")) return "Electrician";
  if (p.startsWith("weld")) return "Welder";
  if (p.includes("helper")) return "Helper";
  if (p.startsWith("spary") || p.startsWith("paint")) return "Painter";
  if (p.startsWith("polish")) return "Polisher";
  if (p.startsWith("rigger")) return "Rigger";
  if (p.startsWith("grain") || p.startsWith("grind")) return "Grinder";
  if (p.startsWith("sofa fabric")) return "Sofa Fabric";
  if (p.startsWith("sofa tailor")) return "Sofa Tailor";
  if (p.startsWith("upholstery")) return "Upholstery Tailor";
  if (p.startsWith("technician")) return "Technician";
  return "Helper"; // safe fallback (no unmapped seen in this file)
}
/** Master "Current Location" -> canonical site name, or null if unusable. */
function canonSiteLoc(raw: string): string | null {
  const s = raw.toLowerCase().replace(/\s+/g, " ").trim();
  if (s.includes("velachery")) return "VBW – Velachery";
  if (s.includes("vadapalani") || s.includes("vadpalani") || s.includes("vpalani")) return "VBW – Vadapalani";
  if (s.includes("factory")) return "TRI – Factory";
  if (s.includes("cmis")) return "CMIS";
  if (s.includes("kumbakonam")) return "Kumbakonam";
  return null;
}
function parseDOJ(raw: string): Date | undefined {
  return /^\d{4}-\d{2}-\d{2}$/.test(raw) ? new Date(`${raw}T00:00:00+05:30`) : undefined;
}

async function main(): Promise<void> {
  await connectDb();
  if (!db.dbReady) { console.error("DB not reachable."); process.exit(1); }
  console.log(`Connected → ${config.mongodbUri.replace(/:[^:@/]+@/, ":****@")}  db="${config.dbName}"`);
  console.log(`Reading: ${path.basename(FILE)}\n`);

  // 1) clean slate — reset the roster AND the org to exactly canonical, so old
  //    seed/demo branches/sites/designations don't linger. (Users untouched.)
  const delW = await WorkerModel.deleteMany({});
  await Promise.all([
    AttendanceModel.deleteMany({}),
    FlagEventModel.deleteMany({}),
    RequestModel.deleteMany({}),
    BranchModel.deleteMany({}),
    ProjectSiteModel.deleteMany({}),
    DesignationModel.deleteMany({}),
  ]);
  console.log(`Cleared ${delW.deletedCount} workers + attendance/flags/requests + old org (branches/sites/designations).`);

  // 2) branches
  const branchId: Record<string, mongoose.Types.ObjectId> = {};
  for (const name of BRANCHES) {
    const b = await BranchModel.findOneAndUpdate({ name }, { $setOnInsert: { name } }, { upsert: true, new: true });
    branchId[name] = b!._id;
  }
  // 3) sites
  const siteByName: Record<string, { id: mongoose.Types.ObjectId; name: string }> = {};
  for (const s of SITES) {
    const doc = await ProjectSiteModel.findOneAndUpdate(
      { code: s.code },
      { $set: { name: s.name, branchId: branchId[s.branch] }, $setOnInsert: { standardStartTime: "09:00", standardEndTime: "18:00" } },
      { upsert: true, new: true },
    );
    siteByName[s.name] = { id: doc!._id, name: doc!.name };
  }

  // 4) read workbook + build code -> current site from the per-site sheets
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(FILE);
  const codeSite: Record<string, string> = {};
  for (const sh of wb.worksheets) {
    const site = SHEET2SITE[sh.name];
    if (!site) continue;
    sh.eachRow((row, rn) => {
      if (rn < 6) return;
      const code = cellText(row.getCell(3).value);
      const name = cellText(row.getCell(4).value);
      if (name && name !== "WORKERS" && code) codeSite[normCode(code)] = site;
    });
  }

  // 5) import active, non-staff workers from Master Data
  const ws = wb.getWorksheet("Master Data")!;
  const desigCache: Record<string, { id: mongoose.Types.ObjectId; name: string }> = {};
  async function ensureDesig(name: string) {
    if (!desigCache[name]) {
      const d = await DesignationModel.findOneAndUpdate({ name }, { $setOnInsert: { name } }, { upsert: true, new: true });
      desigCache[name] = { id: d!._id, name: d!.name };
    }
    return desigCache[name];
  }

  let imported = 0, skippedStaff = 0, skippedInactive = 0, skippedNoCode = 0;
  const bySite: Record<string, number> = {}, byDesig: Record<string, number> = {};
  const rows: { rn: number }[] = [];
  ws.eachRow((_row, rn) => { if (rn > 1) rows.push({ rn }); });

  for (const { rn } of rows) {
    const row = ws.getRow(rn);
    const code = cellText(row.getCell(2).value).trim();
    const name = cellText(row.getCell(3).value).trim();
    const status = cellText(row.getCell(4).value).toLowerCase();
    const rawDesig = cellText(row.getCell(5).value);
    const doj = cellText(row.getCell(6).value);
    const loc = cellText(row.getCell(7).value);
    const bankName = cellText(row.getCell(8).value);
    const acctNo = cellText(row.getCell(9).value);
    const acctName = cellText(row.getCell(10).value);
    const ifsc = cellText(row.getCell(11).value);
    if (!name) continue;
    if (status === "inactive") { skippedInactive++; continue; }
    const cd = canonDesig(rawDesig);
    if (cd === "STAFF") { skippedStaff++; continue; }
    if (!code) { skippedNoCode++; continue; }

    const desig = await ensureDesig(cd);
    const siteName = codeSite[normCode(code)] || canonSiteLoc(loc) || "Unassigned Pool";
    const site = siteByName[siteName];
    const hasBank = !!(bankName || acctNo || acctName || ifsc);
    const dojDate = parseDOJ(doj);

    await WorkerModel.updateOne(
      { empRegNo: code },
      {
        $set: {
          name, designationId: desig.id, designationName: desig.name,
          siteId: site.id, siteName: site.name, status: "active",
          bank: hasBank ? { bankName: bankName || null, accountNumber: acctNo || null, accountHolderName: acctName || null, ifsc: ifsc ? ifsc.toUpperCase() : null } : null,
          ...(dojDate ? { dateJoined: dojDate } : {}),
        },
        $setOnInsert: { faceEncoding: [] },
      },
      { upsert: true },
    );
    imported++;
    bySite[siteName] = (bySite[siteName] || 0) + 1;
    byDesig[desig.name] = (byDesig[desig.name] || 0) + 1;
  }

  // 6) report
  console.log(`\n================  IMPORT COMPLETE  ================`);
  console.log(`Branches: ${await BranchModel.countDocuments()} | Sites: ${await ProjectSiteModel.countDocuments()} | Designations: ${await DesignationModel.countDocuments()}`);
  console.log(`Workers imported (active): ${imported}`);
  console.log(`Skipped — inactive: ${skippedInactive}, staff→user: ${skippedStaff}, no code: ${skippedNoCode}`);
  console.log(`\nBy site:`);
  Object.entries(bySite).sort((a, b) => b[1] - a[1]).forEach(([k, v]) => console.log(`  ${String(v).padStart(3)}  ${k}`));
  console.log(`\nBy designation:`);
  Object.entries(byDesig).sort((a, b) => b[1] - a[1]).forEach(([k, v]) => console.log(`  ${String(v).padStart(3)}  ${k}`));
  console.log(`\nNote: imported workers have NO face yet — enrol at the kiosk before they can scan.`);

  await mongoose.connection.close();
  process.exit(0);
}
main().catch((e) => { console.error("\nIMPORT ERROR:", e?.message ?? e); process.exit(1); });
