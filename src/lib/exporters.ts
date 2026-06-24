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

/** Per-worker payroll sheet (matches the client OT-sheet roll-up columns). */
export interface PayrollRow {
  empRegNo: string; name: string; designation: string; account: string; ifsc: string;
  basic: number | null; food: number; days: number; normalHrs: number; otHrs: number;
  normalPay: number; otPay: number; foodDays: number; foodAllowance: number; gross: number;
}
export async function buildPayrollXlsx(rows: PayrollRow[], period: string): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Payroll");
  const cols = [
    { header: "S.No", key: "n", width: 6 }, { header: "Emp Code", key: "empRegNo", width: 16 },
    { header: "Worker", key: "name", width: 20 }, { header: "Designation", key: "designation", width: 18 },
    { header: "Account No", key: "account", width: 18 }, { header: "IFSC", key: "ifsc", width: 14 },
    { header: "Basic", key: "basic", width: 9 }, { header: "Food", key: "food", width: 8 },
    { header: "Days", key: "days", width: 7 }, { header: "Normal Hrs", key: "normalHrs", width: 11 },
    { header: "OT Hrs", key: "otHrs", width: 9 }, { header: "Normal Pay", key: "normalPay", width: 12 },
    { header: "OT Pay", key: "otPay", width: 10 }, { header: "Food Count", key: "foodDays", width: 11 },
    { header: "Food Allowance", key: "foodAllowance", width: 14 }, { header: "Total Pay", key: "gross", width: 12 },
  ];
  ws.columns = cols;
  ws.getRow(1).font = { bold: true };
  ws.spliceRows(1, 0, [`Payroll · ${period}`]);
  ws.getRow(1).font = { bold: true, size: 13 };
  rows.forEach((r, i) => ws.addRow({ ...r, n: i + 1, basic: r.basic ?? "" }));
  const totals = rows.reduce((a, r) => ({ normalPay: a.normalPay + r.normalPay, otPay: a.otPay + r.otPay, foodAllowance: a.foodAllowance + r.foodAllowance, gross: a.gross + r.gross }), { normalPay: 0, otPay: 0, foodAllowance: 0, gross: 0 });
  const tr = ws.addRow({ name: "TOTAL", normalPay: totals.normalPay, otPay: totals.otPay, foodAllowance: totals.foodAllowance, gross: totals.gross });
  tr.font = { bold: true };
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
