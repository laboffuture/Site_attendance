import { Schema, model, InferSchemaType } from "mongoose";

import { DEFAULT_SHIFTS } from "../lib/shift";

const designationOverrideSchema = new Schema(
  {
    designationId: {
      type: Schema.Types.ObjectId,
      ref: "Designation",
      required: true,
    },
    startTime: { type: String, required: true }, // "HH:MM"
    endTime: { type: String, required: true }, // "HH:MM"
  },
  { _id: false },
);

// Per-site day/night/sunday shift definition (matrix defaults on create).
const shiftDefSchema = new Schema(
  {
    startTime: { type: String, required: true },
    endTime: { type: String, required: true },
    breakMin: { type: Number, default: 60 },
    otBreakThresholdHours: { type: Number, default: 5 },
    otBreakMin: { type: Number, default: 60 },
  },
  { _id: false },
);
const siteShiftsSchema = new Schema(
  {
    day: { type: shiftDefSchema, required: true },
    night: { type: shiftDefSchema, required: true },
    sunday: { type: shiftDefSchema, required: true },
  },
  { _id: false },
);

const projectSiteSchema = new Schema(
  {
    branchId: {
      type: Schema.Types.ObjectId,
      ref: "Branch",
      required: true,
      index: true,
    },
    name: { type: String, required: true, trim: true },
    code: { type: String, required: true, unique: true, trim: true, uppercase: true },
    standardStartTime: { type: String, default: "09:00" },
    standardEndTime: { type: String, default: "18:00" },
    designationOverrides: { type: [designationOverrideSchema], default: [] },

    // Per-site day/night/sunday shift definitions (matrix defaults on create).
    shifts: { type: siteShiftsSchema, default: () => JSON.parse(JSON.stringify(DEFAULT_SHIFTS)) },

    // Optional site coordinates — when set, each scan records its distance from
    // here. (Geofence radius is stored for future enforcement; not enforced in v1.)
    latitude: { type: Number, default: null },
    longitude: { type: Number, default: null },
    geofenceRadiusMeters: { type: Number, default: null },
  },
  { timestamps: true },
);

export type ProjectSite = InferSchemaType<typeof projectSiteSchema>;
export const ProjectSiteModel = model(
  "ProjectSite",
  projectSiteSchema,
  "project_sites",
);
