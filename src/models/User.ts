import { Schema, model, InferSchemaType } from "mongoose";

export const ROLES = ["management", "hr", "pm", "pe", "supervisor"] as const;
export type Role = (typeof ROLES)[number];

const userSchema = new Schema(
  {
    name: { type: String, required: true },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    passwordHash: { type: String, required: true },
    role: { type: String, enum: [...ROLES], required: true },
    // Scope rule: [] = all sites (Management/HR); [N ids] = PM's sites;
    // [1 id] = PE/Supervisor's single site. Gates every dashboard query.
    assignedSiteIds: {
      type: [Schema.Types.ObjectId],
      ref: "ProjectSite",
      default: [],
    },
    active: { type: Boolean, default: true },
  },
  { timestamps: true },
);

export type User = InferSchemaType<typeof userSchema>;
export const UserModel = model("User", userSchema, "users");
