import type { Response } from "express";
import ExcelJS from "exceljs";
import PDFDocument from "pdfkit";

import { hoursBreakdown } from "./report";

/** Report column definition, shared by xlsx + pdf. Defaults from spec §10;
 *  adjust here when the reference sheet arrives. */
const COLUMNS: { header: string; key: string; width: number; pdf: number }[] = [
  { header: "Branch", key: "branchName", width: 18, pdf: 70 },
  { header: "Project", key: "siteName", width: 24, pdf: 100 },
  { header: "Emp Reg No", key: "empRegNo", width: 14, pdf: 66 },
  { header: "Name", key: "workerName", width: 18, pdf: 88 },
  { header: "Designation", key: "designationName", width: 15, pdf: 74 },
  { header: "Date", key: "date", width: 11, pdf: 54 },
  { header: "In", key: "inT", width: 7, pdf: 34 },
  { header: "Out", key: "outT", width: 7, pdf: 34 },
  { header: "Standard (h)", key: "standard", width: 11, pdf: 48 },
  { header: "OT (h)", key: "otHours", width: 8, pdf: 34 },
  { header: "Total (h)", key: "payableTotal", width: 10, pdf: 44 },
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

/** Streams a landscape A4 PDF table directly to the response. */
export function streamPdf(rows: Row[], meta: { title: string; subtitle: string }, res: Response): void {
  const doc = new PDFDocument({ size: "A4", layout: "landscape", margin: 28 });
  doc.pipe(res);

  doc.fontSize(15).fillColor("#000").text(meta.title);
  doc.fontSize(9).fillColor("#666").text(meta.subtitle);
  doc.moveDown(0.5);
  doc.fillColor("#000");

  const left = doc.page.margins.left;
  const rowH = 16;
  const bottom = doc.page.height - doc.page.margins.bottom;

  const drawRow = (vals: (string | number)[], y: number, header: boolean) => {
    if (header) {
      const totalW = COLUMNS.reduce((s, c) => s + c.pdf, 0);
      doc.rect(left, y - 2, totalW, rowH).fill("#eeeeee");
      doc.fillColor("#000");
    }
    doc.fontSize(8).font(header ? "Helvetica-Bold" : "Helvetica");
    let x = left;
    COLUMNS.forEach((c, i) => {
      doc.text(String(vals[i] ?? ""), x + 2, y + 2, { width: c.pdf - 4, height: rowH, ellipsis: true, lineBreak: false });
      x += c.pdf;
    });
  };

  let y = doc.y;
  drawRow(COLUMNS.map((c) => c.header), y, true);
  y += rowH;

  for (const r of rows) {
    if (y + rowH > bottom) {
      doc.addPage();
      y = doc.page.margins.top;
      drawRow(COLUMNS.map((c) => c.header), y, true);
      y += rowH;
    }
    const f = flat(r);
    drawRow(COLUMNS.map((c) => f[c.key]), y, false);
    y += rowH;
  }

  if (rows.length === 0) {
    doc.moveDown(2).fontSize(11).fillColor("#666").text("No records match the selected filters.");
  }
  doc.end();
}
