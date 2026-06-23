import type { Role } from "../models/User";

/** Minimal, view-safe snapshot of the signed-in user, loaded per request. */
export interface CurrentUser {
  id: string;
  name: string;
  email: string;
  role: Role;
  assignedSiteIds: string[];
  capabilities: string[]; // explicit per-user overrides; [] = follow role
}
