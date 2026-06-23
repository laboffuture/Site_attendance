import { Schema, model, InferSchemaType } from "mongoose";

// Top to bottom. Management is the single top tier (super_admin merged in). PE removed.
export const ROLES = ["management", "hr", "pm", "supervisor"] as const;
export type Role = (typeof ROLES)[number];

const userSchema = new Schema(
  {
    name: { type: String, required: true },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    // Contact number (HR/management reach-out). Free-form to allow +country
    // codes and spacing (e.g. "+971 50 000 0000"); optional.
    phone: { type: String, default: null, trim: true },
    passwordHash: { type: String, required: true },
    role: { type: String, enum: [...ROLES], required: true },
    // Scope rule: [] = all sites (Management/HR); [N ids] = PM's sites;
    // [1 id] = PE/Supervisor's single site. Gates every dashboard query.
    assignedSiteIds: {
      type: [Schema.Types.ObjectId],
      ref: "ProjectSite",
      default: [],
    },
    // Per-user capability overrides. Empty = follow the role's defaults
    // (CAPABILITY_ROLES); a non-empty list is the user's exact granted set.
    capabilities: { type: [String], default: [] },
    active: { type: Boolean, default: true },
  },
  { timestamps: true },
);

export type User = InferSchemaType<typeof userSchema>;
export const UserModel = model("User", userSchema, "users");
