import { Schema, model, InferSchemaType } from "mongoose";

export const FLAG_TYPES = ["wrong_site_scan", "missed_clockout", "forgot_submit"] as const;

const flagEventSchema = new Schema(
  {
    type: { type: String, enum: [...FLAG_TYPES], required: true },
    workerId: { type: Schema.Types.ObjectId, ref: "Worker", default: null },
    workerName: { type: String, default: null },
    empRegNo: { type: String, default: null }, // denormalized worker Emp ID (null for site-day flags)
    attemptedSiteId: {
      type: Schema.Types.ObjectId,
      ref: "ProjectSite",
      default: null,
    },
    attemptedSiteName: { type: String, default: null }, // denormalized
    attemptedStationId: {
      type: Schema.Types.ObjectId,
      ref: "SiteStation",
      default: null,
    },
    homeSiteId: { type: Schema.Types.ObjectId, ref: "ProjectSite", default: null },
    homeSiteName: { type: String, default: null }, // denormalized

    // missed_clockout only: links the flag to the open attendance record and
    // its site-local day, so HR knows which record/day to correct.
    attendanceId: { type: Schema.Types.ObjectId, ref: "Attendance", default: null },
    date: { type: String, default: null }, // site-local "YYYY-MM-DD"

    timestamp: { type: Date, default: Date.now },
    resolved: { type: Boolean, default: false },
  },
  { timestamps: true },
);

flagEventSchema.index({ resolved: 1, timestamp: 1 });
// At most one missed_clockout flag per attendance record (idempotent sweep).
flagEventSchema.index(
  { type: 1, attendanceId: 1 },
  { unique: true, partialFilterExpression: { attendanceId: { $type: "objectId" } } },
);
// At most one forgot_submit flag per site-day (idempotent sweep; covers only that type).
flagEventSchema.index(
  { type: 1, attemptedSiteId: 1, date: 1 },
  { unique: true, partialFilterExpression: { type: "forgot_submit" } },
);

export type FlagEvent = InferSchemaType<typeof flagEventSchema>;
export const FlagEventModel = model("FlagEvent", flagEventSchema, "flag_events");
