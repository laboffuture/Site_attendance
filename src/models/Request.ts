import { Schema, model, InferSchemaType } from "mongoose";

export const REQUEST_TYPES = ["scheduled_ot", "offload"] as const;

// Flow: pending → recommended (by PM) → approved | rejected (by admin).
// There is no "withdrawn" — once created a request stays on record.
export const REQUEST_STATUS = ["pending", "recommended", "approved", "rejected"] as const;

const requestSchema = new Schema(
  {
    type: { type: String, enum: [...REQUEST_TYPES], required: true },
    status: { type: String, enum: [...REQUEST_STATUS], default: "pending" },

    // worker + location snapshot (denormalized)
    workerId: { type: Schema.Types.ObjectId, ref: "Worker", required: true },
    empRegNo: { type: String, required: true },
    workerName: { type: String, required: true },
    siteId: { type: Schema.Types.ObjectId, ref: "ProjectSite", required: true },
    siteName: { type: String, required: true },
    branchId: { type: Schema.Types.ObjectId, ref: "Branch", default: null },
    branchName: { type: String, default: null },

    // who raised it
    requestedBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
    requestedByName: { type: String, required: true },
    requestedAt: { type: Date, default: Date.now },
    requesterRemarks: { type: String, default: null },

    // scheduled_ot only
    date: { type: String, default: null }, // "YYYY-MM-DD"
    fromTime: { type: String, default: null }, // "HH:MM"
    toTime: { type: String, default: null }, // "HH:MM"
    hours: { type: Number, default: null },

    // PM recommendation (mandatory before an admin can approve)
    recommendedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    recommendedByName: { type: String, default: null },
    recommendedAt: { type: Date, default: null },
    recommenderRemarks: { type: String, default: null },

    // admin decision
    decidedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    decidedByName: { type: String, default: null },
    decidedAt: { type: Date, default: null },
    decisionRemarks: { type: String, default: null },
  },
  { timestamps: true },
);

requestSchema.index({ status: 1, createdAt: -1 });
requestSchema.index({ siteId: 1, status: 1 });

export const RequestModel = model("Request", requestSchema, "requests");
