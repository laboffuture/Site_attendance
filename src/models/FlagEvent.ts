import { Schema, model, InferSchemaType } from "mongoose";

export const FLAG_TYPES = ["wrong_site_scan", "missed_clockout"] as const;
export type FlagType = (typeof FLAG_TYPES)[number];

const flagEventSchema = new Schema(
  {
    type: { type: String, enum: [...FLAG_TYPES], required: true },
    workerId: { type: Schema.Types.ObjectId, ref: "Worker", default: null },
    workerName: { type: String, default: null },
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
    timestamp: { type: Date, default: Date.now },
    resolved: { type: Boolean, default: false },
  },
  { timestamps: true },
);

flagEventSchema.index({ resolved: 1, timestamp: 1 });

export type FlagEvent = InferSchemaType<typeof flagEventSchema>;
export const FlagEventModel = model("FlagEvent", flagEventSchema, "flag_events");
