import { Types } from "mongoose";

import type { CurrentUser } from "../auth/types";

/**
 * Mongo filter fragment limiting a query to the sites a user may see, applied
 * to a `siteId` field. Management/HR see everything; everyone else is limited
 * to their assignedSiteIds (an empty list therefore sees nothing — safer than
 * accidentally exposing all sites to a misconfigured PE/Supervisor).
 */
export function siteScopeFilter(user: CurrentUser): Record<string, unknown> {
  if (user.role === "management" || user.role === "hr") return {};
  return { siteId: { $in: user.assignedSiteIds.map((id) => new Types.ObjectId(id)) } };
}

/** True if the user is allowed to act on the given site. */
export function canUseSite(user: CurrentUser, siteId: string): boolean {
  if (user.role === "management" || user.role === "hr") return true;
  return user.assignedSiteIds.includes(siteId);
}
