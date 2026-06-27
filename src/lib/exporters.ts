import type { Response } from "express";
import ExcelJS from "exceljs";
import PDFDocument from "pdfkit";

import { hoursBreakdown } from "./report";

/** Report column definition, shared by xlsx + pdf. Defaults from spec §10;
 *  adjust here when the reference sheet arrives. */
const COLUMNS: { header: string; key: string; width: number; pdf: number; align?: "left" | "right" | "center" }[] = [
  { header: "Branch", key: "branchName", width: 18, pdf: 66 },
  { header: "Project", key: "siteName", width: 24, pdf: 96 },
  { header: "Emp Reg No", key: "empRegNo", width: 16, pdf: 92 }, // wide enough for the full ID (e.g. TRG-LOF-131-049)
  { header: "Name", key: "workerName", width: 18, pdf: 90 },
  { header: "Designation", key: "designationName", width: 15, pdf: 74 },
  { header: "Date", key: "date", width: 11, pdf: 54 },
  { header: "In", key: "inT", width: 7, pdf: 34, align: "right" },
  { header: "Out", key: "outT", width: 7, pdf: 34, align: "right" },
  { header: "Standard (h)", key: "standard", width: 11, pdf: 48, align: "right" },
  { header: "OT (h)", key: "otHours", width: 8, pdf: 34, align: "right" },
  { header: "Total (h)", key: "payableTotal", width: 10, pdf: 44, align: "right" },
  { header: "OT Status", key: "otStatus", width: 12, pdf: 52 },
  { header: "Source", key: "source", width: 8, pdf: 40 },
];

function ist(d: unknown): string {
  return d
    ? new Date(d as string).toLocaleTimeString("en-GB", {
        timeZone: "Asia/Kolkata",
        hour: "2-digit",
        minute: "2-digit",
      })
    : "";
}

type Row = Record<string, unknown> & { overtime?: { computedHours?: number; status?: string } };

function flat(r: Row): Record<string, string | number> {
  const h = hoursBreakdown(r as never);
  return {
    branchName: String(r.branchName ?? ""),
    siteName: String(r.siteName ?? ""),
    empRegNo: String(r.empRegNo ?? ""),
    workerName: String(r.workerName ?? ""),
    designationName: String(r.designationName ?? ""),
    date: String(r.date ?? ""),
    inT: ist(r.inTime),
    outT: ist(r.outTime),
    standard: h.worked != null ? h.standard : "",
    otHours: h.otComputed,
    payableTotal: h.payableTotal != null ? h.payableTotal : "",
    otStatus: h.otStatus,
    source: String(r.source ?? "scan"),
  };
}

export async function buildXlsxBuffer(rows: Row[], note?: string): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Attendance");
  ws.columns = COLUMNS.map((c) => ({ header: c.header, key: c.key, width: c.width }));
  ws.getRow(1).font = { bold: true };
  for (const r of rows) ws.addRow(flat(r));
  if (note) {
    const noteRow = ws.addRow([note]);
    noteRow.font = { italic: true, color: { argb: "FF996600" } };
  }
  const buf = await wb.xlsx.writeBuffer();
  return Buffer.from(buf);
}

/** Streams a CSV download. Optional trailing note row (e.g. a row-cap notice). */
export function sendCsv(res: Response, filename: string, headers: string[], rows: (string | number | null)[][], note?: string): void {
  const esc = (v: unknown) => { const s = v == null ? "" : String(v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  const lines = [headers, ...rows].map((r) => r.map(esc).join(","));
  if (note) lines.push("", esc(note));
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.send(lines.join("\n"));
}

/** Per-worker payroll sheet — mirrors the client OT sheet: identity columns, a
 *  per-day In/Out/Lunch/Total/Normal/OT block for each date, then the roll-up. */
export interface PayrollDay { inT: string; outT: string; lunch: number; total: number; normal: number; ot: number; }
export interface PayrollRow {
  empRegNo: string; name: string; designation: string; account: string; ifsc: string;
  basic: number | null; food: number; days: number; normalHrs: number; otHrs: number;
  normalPay: number; otPay: number; foodDays: number; foodAllowance: number; arrears: number; gross: number;
  byDate: Record<string, PayrollDay>;
}
export async function buildPayrollXlsx(rows: PayrollRow[], dates: string[], period: string): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Payroll");

  const head: (string | number)[] = ["S.No", "Emp Code", "Worker", "Designation", "Account No", "IFSC", "Basic", "Food"];
  for (const dt of dates) head.push(`${dt.slice(5)} Date`, "In", "Out", "Lunch", "Total", "Normal", "OT");
  head.push("Total Normal Hrs", "No. of OT Hrs", "Normal Pay", "OT Pay", "Food Count", "Food Allowance", "Arrears", "Total Pay");

  ws.addRow([`Payroll · ${period}`]);
  ws.getRow(1).font = { bold: true, size: 13 };
  ws.addRow(head).font = { bold: true };

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const row: (string | number)[] = [i + 1, r.empRegNo, r.name, r.designation, r.account, r.ifsc, r.basic ?? "", r.food];
    for (const dt of dates) {
      const d = r.byDate[dt];
      if (d) row.push(dt.slice(5), d.inT, d.outT, d.lunch, d.total, d.normal, d.ot);
      else row.push(dt.slice(5), "", "", "", "", "", "");
    }
    row.push(r.normalHrs, r.otHrs, r.normalPay, r.otPay, r.foodDays, r.foodAllowance, r.arrears, r.gross);
    ws.addRow(row);
  }

  // TOTAL row aligned to the roll-up block at the far right.
  const total = (k: keyof PayrollRow) => rows.reduce((a, r) => a + (r[k] as number), 0);
  const totalRow: (string | number)[] = new Array(head.length).fill("");
  totalRow[2] = "TOTAL";
  const rollup = 8 + dates.length * 7; // first roll-up column index
  totalRow[rollup + 2] = total("normalPay");
  totalRow[rollup + 3] = total("otPay");
  totalRow[rollup + 5] = total("foodAllowance");
  totalRow[rollup + 6] = total("arrears");
  totalRow[rollup + 7] = total("gross");
  ws.addRow(totalRow).font = { bold: true };

  ws.getColumn(3).width = 20;
  ws.getColumn(4).width = 16;
  const buf = await wb.xlsx.writeBuffer();
  return Buffer.from(buf);
}

/** A PDF column: header + the key to read off each (pre-flattened) row, its width
 *  in points for the landscape-A4 layout (usable width ≈ 786pt), and an optional
 *  text alignment (numbers read better right-aligned). */
export interface PdfColumn { header: string; key: string; pdf: number; align?: "left" | "right" | "center" }

const PDF_ACCENT = "#1c4d8c"; // brand accent (matches the app)
const PDF_ZEBRA = "#f4f6f9"; // alternating row tint
const PDF_RULE = "#e3e8ef"; // hairline row separator

function nowIST(): string {
  return new Date().toLocaleString("en-GB", { timeZone: "Asia/Kolkata", dateStyle: "medium", timeStyle: "short" });
}

/**
 * Streams a branded landscape-A4 PDF table for ANY column set + pre-flattened
 * rows. One shared primitive behind every report PDF, so they all share the look:
 *  - branded header: accent title, subtitle, "Generated <ts> IST", an accent rule;
 *  - an accent header band with white labels, repeated on every page;
 *  - zebra-striped rows with hairline separators and per-column alignment;
 *  - an optional bold TOTALS row (pass meta.totals keyed like a data row);
 *  - a "company · Page X of Y" footer on every page.
 * Overflowing cells still ellipsise — give identity columns enough width.
 */
export function streamTablePdf(
  rows: Record<string, string | number>[],
  columns: PdfColumn[],
  meta: { title: string; subtitle: string; company?: string; totals?: Record<string, string | number> },
  res: Response,
): void {
  const doc = new PDFDocument({ size: "A4", layout: "landscape", margin: 28, bufferPages: true });
  doc.pipe(res);

  const left = doc.page.margins.left;
  const totalW = columns.reduce((s, c) => s + c.pdf, 0);
  const company = meta.company || meta.title.split(" — ")[0] || "";
  const rowH = 17;
  const bottom = doc.page.height - doc.page.margins.bottom - 16; // leave room for the footer
  const alignOf = (c: PdfColumn): "left" | "right" | "center" => (c.align === "right" ? "right" : c.align === "center" ? "center" : "left");

  // ---- Branded header block ----
  doc.font("Helvetica-Bold").fontSize(16).fillColor(PDF_ACCENT).text(meta.title, left, doc.page.margins.top);
  doc.font("Helvetica").fontSize(9).fillColor("#555").text(meta.subtitle);
  doc.fontSize(8).fillColor("#9aa3ad").text(`Generated ${nowIST()} IST`);
  let y = doc.y + 4;
  doc.moveTo(left, y).lineTo(left + totalW, y).lineWidth(1.2).strokeColor(PDF_ACCENT).stroke();
  y += 6;

  const drawHeader = (yy: number): number => {
    doc.rect(left, yy, totalW, rowH).fill(PDF_ACCENT);
    doc.font("Helvetica-Bold").fontSize(8).fillColor("#ffffff");
    let x = left;
    for (const c of columns) {
      doc.text(c.header, x + 3, yy + 4.5, { width: c.pdf - 6, height: rowH, ellipsis: true, lineBreak: false, align: alignOf(c) });
      x += c.pdf;
    }
    return yy + rowH;
  };

  const drawRow = (r: Record<string, string | number>, yy: number, zebra: boolean, bold = false, topRule = false): number => {
    if (zebra && !bold) doc.rect(left, yy, totalW, rowH).fill(PDF_ZEBRA);
    if (topRule) doc.moveTo(left, yy).lineTo(left + totalW, yy).lineWidth(1).strokeColor("#b9c2cd").stroke();
    doc.font(bold ? "Helvetica-Bold" : "Helvetica").fontSize(8).fillColor("#111111");
    let x = left;
    for (const c of columns) {
      const v = r[c.key];
      doc.text(v == null ? "" : String(v), x + 3, yy + 4.5, { width: c.pdf - 6, height: rowH, ellipsis: true, lineBreak: false, align: alignOf(c) });
      x += c.pdf;
    }
    doc.moveTo(left, yy + rowH).lineTo(left + totalW, yy + rowH).lineWidth(0.5).strokeColor(PDF_RULE).stroke();
    return yy + rowH;
  };

  y = drawHeader(y);
  let i = 0;
  for (const r of rows) {
    if (y + rowH > bottom) { doc.addPage(); y = drawHeader(doc.page.margins.top); }
    y = drawRow(r, y, i % 2 === 1);
    i++;
  }
  if (meta.totals) {
    if (y + rowH > bottom) { doc.addPage(); y = drawHeader(doc.page.margins.top); }
    drawRow(meta.totals, y, false, true, true);
  }
  if (rows.length === 0) {
    doc.font("Helvetica").fontSize(11).fillColor("#666").text("No records match the selected filters.", left, y + 14);
  }

  // ---- Footer: company + "Page X of Y" on every page ----
  const range = doc.bufferedPageRange();
  for (let p = range.start; p < range.start + range.count; p++) {
    doc.switchToPage(p);
    const fy = doc.page.height - 20;
    doc.font("Helvetica").fontSize(7).fillColor("#9aa3ad");
    doc.text(company, left, fy, { lineBreak: false });
    doc.text(`Page ${p + 1} of ${range.count}`, left, fy, { width: totalW, align: "right", lineBreak: false });
  }
  doc.flushPages();
  doc.end();
}

/** Attendance PDF — the original export, now built on the generic table primitive. */
export function streamPdf(rows: Row[], meta: { title: string; subtitle: string }, res: Response): void {
  const cols: PdfColumn[] = COLUMNS.map((c) => ({ header: c.header, key: c.key, pdf: c.pdf, align: c.align }));
  streamTablePdf(rows.map(flat), cols, meta, res);
}
