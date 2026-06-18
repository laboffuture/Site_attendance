import { Schema, model, InferSchemaType } from "mongoose";

const siteStationSchema = new Schema(
  {
    projectSiteId: {
      type: Schema.Types.ObjectId,
      ref: "ProjectSite",
      required: true,
      index: true,
    },
    stationName: { type: String, required: true },
    stationKeyHash: { type: String, required: true },
    active: { type: Boolean, default: true },
    lastSeen: { type: Date, default: null },
  },
  { timestamps: true },
);

export type SiteStation = InferSchemaType<typeof siteStationSchema>;
export const SiteStationModel = model(
  "SiteStation",
  siteStationSchema,
  "site_stations",
);
