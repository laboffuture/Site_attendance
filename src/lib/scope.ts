import { Types } from "mongoose";

import type { CurrentUser } from "../auth/types";
import { seesAllSites } from "../auth/permissions";

/**
 * Mongo filter fragment limiting a query to the sites a user may see, applied
 * to a `siteId` field. Super Admin / Management / HR see everything; everyone
 * else is limited to their assignedSiteIds (an empty list therefore sees
 * nothing — safer than accidentally exposing all sites to a misconfigured
 * PM/Supervisor).
 */
export function siteScopeFilter(user: CurrentUser): Record<string, unknown> {
  if (seesAllSites(user.role)) return {};
  return { siteId: { $in: user.assignedSiteIds.map((id) => new Types.ObjectId(id)) } };
}

/** True if the user is allowed to act on the given site. */
export function canUseSite(user: CurrentUser, siteId: string): boolean {
  if (seesAllSites(user.role)) return true;
  return user.assignedSiteIds.includes(siteId);
}

/** Like siteScopeFilter but for flag_events, which key the site as
 *  `attemptedSiteId` (the station's site where the scan happened). */
export function flagScopeFilter(user: CurrentUser): Record<string, unknown> {
  if (seesAllSites(user.role)) return {};
  return { attemptedSiteId: { $in: user.assignedSiteIds.map((id) => new Types.ObjectId(id)) } };
}
