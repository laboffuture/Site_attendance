import { Schema, model, InferSchemaType } from "mongoose";

export const MANPOWER_STATUS = ["open", "partial", "fulfilled", "cancelled"] as const;

// One role demand on a request: N workers of a designation.
const lineSchema = new Schema(
  {
    designationId: { type: Schema.Types.ObjectId, ref: "Designation", required: true },
    designationName: { type: String, required: true },
    qty: { type: Number, required: true, min: 1 },
  },
  { _id: false },
);

// One person allocated to a role line (enrolled worker OR outsource employee).
const allocationSchema = new Schema(
  {
    kind: { type: String, enum: ["worker", "outsource"], required: true },
    refId: { type: Schema.Types.ObjectId, required: true }, // Worker or OutsourceEmployee
    code: { type: String, default: null }, // worker empRegNo or outsource OUT-code
    name: { type: String, required: true },
    lineDesignationId: { type: Schema.Types.ObjectId, ref: "Designation", required: true },
    designationName: { type: String, default: null },
    allocatedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    allocatedByName: { type: String, default: null },
    allocatedAt: { type: Date, default: Date.now },
  },
  { _id: false },
);

const manpowerRequestSchema = new Schema(
  {
    reqCode: { type: String, required: true, unique: true }, // MPA-NNNNNN
    siteId: { type: Schema.Types.ObjectId, ref: "ProjectSite", required: true },
    siteName: { type: String, required: true },
    branchId: { type: Schema.Types.ObjectId, ref: "Branch", default: null },
    branchName: { type: String, default: null },
    shiftType: { type: String, enum: ["day", "night", "sunday"], default: "day" },
    dateFrom: { type: String, required: true }, // YYYY-MM-DD
    dateTo: { type: String, required: true },
    lines: { type: [lineSchema], default: [] },
    allocations: { type: [allocationSchema], default: [] },
    status: { type: String, enum: [...MANPOWER_STATUS], default: "open" },
    requestedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    requestedByName: { type: String, default: null },
    requestedAt: { type: Date, default: Date.now },
    requesterRemarks: { type: String, default: null },
    notes: { type: String, default: null },
  },
  { timestamps: true },
);
manpowerRequestSchema.index({ siteId: 1, status: 1 });
manpowerRequestSchema.index({ status: 1, createdAt: -1 });

export type ManpowerRequest = InferSchemaType<typeof manpowerRequestSchema>;
export const ManpowerRequestModel = model("ManpowerRequest", manpowerRequestSchema, "manpower_requests");
