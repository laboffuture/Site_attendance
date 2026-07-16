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
    // Lifecycle: "archived" = signed off (hidden from active lists, restorable
    // from the Sites Archived tab). "deleted" = hidden everywhere; retained for
    // history and listed only in the Deletion log.
    status: { type: String, enum: ["active", "archived", "deleted"], default: "active" },
    archivedAt: { type: Date, default: null },
    archivedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    archivedByName: { type: String, default: null },
    deletedAt: { type: Date, default: null },
    deletedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    standardStartTime: { type: String, default: "09:00" },
    standardEndTime: { type: String, default: "18:00" },
    // Max overtime hours allowed per day (cap; null = no explicit cap).
    allowedOtHours: { type: Number, default: null },
    // Payroll lunch deduction (hours) subtracted from each day's worked hours
    // before normal/OT are split — matches the client OT sheet's lunch column.
    lunchHours: { type: Number, default: 1 },
    // Per-site overrides for the in/out exception rules (null → global config).
    maxShiftHours: { type: Number, default: null },
    forgotGraceHours: { type: Number, default: null },
    scanDebounceSeconds: { type: Number, default: null },
    designationOverrides: { type: [designationOverrideSchema], default: [] },

    // Per-site day/night/sunday shift definitions (matrix defaults on create).
    shifts: { type: siteShiftsSchema, default: () => JSON.parse(JSON.stringify(DEFAULT_SHIFTS)) },

    // Optional site coordinates — when set, each scan records its distance from
    // here, and the supervisor Log-Attendance flow enforces the geofence.
    latitude: { type: Number, default: null },
    longitude: { type: Number, default: null },
    geofenceRadiusMeters: { type: Number, default: null },
    // Polygon geofence (drawn rectangle/shape) as [[lat, lng], ...]. When set
    // (>= 3 points), enforcement uses point-in-polygon; otherwise the circle
    // (lat/lng + radius) is used. Empty = no polygon.
    geofencePolygon: { type: [[Number]], default: [] },

    // Site profile (optional, captured at create/edit).
    address: { type: String, default: null, trim: true },
    inChargeName: { type: String, default: null, trim: true },
    inChargePhone: { type: String, default: null, trim: true },
    clientName: { type: String, default: null, trim: true },
    nightShiftEnabled: { type: Boolean, default: false },
  },
  { timestamps: true },
);

export type ProjectSite = InferSchemaType<typeof projectSiteSchema>;
export const ProjectSiteModel = model(
  "ProjectSite",
  projectSiteSchema,
  "project_sites",
);
