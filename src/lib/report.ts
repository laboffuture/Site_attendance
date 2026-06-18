import { Types } from "mongoose";

import type { CurrentUser } from "../auth/types";
import { siteScopeFilter, canUseSite } from "./scope";
import { escapeRegex } from "./validate";

export interface ReportFilters {
  branchId?: string;
  siteId?: string;
  dateFrom?: string;
  dateTo?: string;
  designation?: string;
  q?: string;
}

const isDate = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s);
const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");

export function parseReportFilters(query: Record<string, unknown>): ReportFilters {
  return {
    branchId: str(query.branchId) || undefined,
    siteId: str(query.siteId) || undefined,
    dateFrom: isDate(str(query.dateFrom)) ? str(query.dateFrom) : undefined,
    dateTo: isDate(str(query.dateTo)) ? str(query.dateTo) : undefined,
    designation: str(query.designation) || undefined,
    q: str(query.q) || undefined,
  };
}

/** Builds an attendance query honoring the user's site scope and filters.
 *  A site filter is only applied if the user is actually allowed that site. */
export function buildAttendanceQuery(user: CurrentUser, f: ReportFilters): Record<string, unknown> {
  const query: Record<string, unknown> = { ...siteScopeFilter(user) };

  if (f.siteId && canUseSite(user, f.siteId)) {
    query.siteId = new Types.ObjectId(f.siteId);
  }
  if (f.branchId) query.branchId = new Types.ObjectId(f.branchId);

  if (f.dateFrom || f.dateTo) {
    const d: Record<string, string> = {};
    if (f.dateFrom) d.$gte = f.dateFrom;
    if (f.dateTo) d.$lte = f.dateTo;
    query.date = d;
  }
  if (f.designation) query.designationName = f.designation;
  if (f.q) {
    const rx = new RegExp(escapeRegex(f.q), "i");
    query.$or = [{ workerName: rx }, { empRegNo: rx }];
  }
  return query;
}

export interface AttendanceLean {
  branchName: string;
  siteName: string;
  [k: string]: unknown;
}

export interface SiteGroup {
  siteName: string;
  rows: AttendanceLean[];
}
export interface BranchGroup {
  branchName: string;
  sites: SiteGroup[];
}

/** Groups already-sorted (branch, site) rows into branch → site → rows. */
export function groupByBranchSite(rows: AttendanceLean[]): BranchGroup[] {
  const branches = new Map<string, Map<string, AttendanceLean[]>>();
  for (const r of rows) {
    if (!branches.has(r.branchName)) branches.set(r.branchName, new Map());
    const sites = branches.get(r.branchName)!;
    if (!sites.has(r.siteName)) sites.set(r.siteName, []);
    sites.get(r.siteName)!.push(r);
  }
  return [...branches.entries()].map(([branchName, sites]) => ({
    branchName,
    sites: [...sites.entries()].map(([siteName, rs]) => ({ siteName, rows: rs })),
  }));
}
