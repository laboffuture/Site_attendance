import { Schema, model, InferSchemaType } from "mongoose";

// Records a PM/Supervisor's location relative to their assigned site(s) when
// they open the portal — so off-site logins are tracked, not just shown.
const loginGeoCheckSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    userName: { type: String, required: true },
    role: { type: String, required: true },
    latitude: { type: Number, default: null },
    longitude: { type: Number, default: null },
    accuracyMeters: { type: Number, default: null },
    // off = no geofenced site assigned; no_fix = no GPS; inside/outside = result.
    status: { type: String, enum: ["off", "no_fix", "inside", "outside"], required: true },
    nearestSiteId: { type: Schema.Types.ObjectId, ref: "ProjectSite", default: null },
    nearestSiteName: { type: String, default: null },
    distanceMeters: { type: Number, default: null },
  },
  { timestamps: true },
);

export type LoginGeoCheck = InferSchemaType<typeof loginGeoCheckSchema>;
export const LoginGeoCheckModel = model("LoginGeoCheck", loginGeoCheckSchema, "login_geo_checks");
