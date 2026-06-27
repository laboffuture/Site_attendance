import { Schema, model, InferSchemaType } from "mongoose";

export const WORKER_STATUS = ["pending", "active", "inactive", "deleted"] as const;
export type WorkerStatus = (typeof WORKER_STATUS)[number];

export const REMARK_TYPES = ["note", "soft_delete", "offload", "conflict", "registration", "rejection"] as const;
export type RemarkType = (typeof REMARK_TYPES)[number];

// Append-only remark. "Clear" sets `cleared` (struck through, kept for audit) —
// entries are never removed or edited.
const remarkSchema = new Schema(
  {
    text: { type: String, required: true },
    type: { type: String, enum: [...REMARK_TYPES], default: "note" },
    authorId: { type: Schema.Types.ObjectId, ref: "User", default: null },
    authorName: { type: String, default: null },
    at: { type: Date, default: Date.now },
    cleared: { type: Boolean, default: false },
    clearedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    clearedAt: { type: Date, default: null },
  },
  { _id: false },
);

// Pay (per-day wage + optional food allowance). Feeds payroll-ready reports.
const foodAllowanceSchema = new Schema(
  {
    applicable: { type: Boolean, default: false },
    amount: { type: Number, default: null, min: 0 }, // per day, when applicable
  },
  { _id: false },
);

// Optional bank details (not mandatory at enrollment).
const bankSchema = new Schema(
  {
    accountHolderName: { type: String, default: null },
    accountNumber: { type: String, default: null },
    ifsc: { type: String, default: null },
    bankName: { type: String, default: null },
  },
  { _id: false },
);

const workerSchema = new Schema(
  {
    empRegNo: { type: String, required: true, unique: true, trim: true }, // manual Employee ID
    name: { type: String, required: true },
    designationId: {
      type: Schema.Types.ObjectId,
      ref: "Designation",
      required: true,
    },
    designationName: { type: String, required: true }, // denormalized
    // Primary site — used for pay, display, and dashboard headcount. Always the
    // first entry of siteIds (kept in sync by the pre-save hook below).
    siteId: { type: Schema.Types.ObjectId, ref: "ProjectSite", required: true },
    siteName: { type: String, required: true }, // denormalized
    // Multi-site assignment: every site this worker may clock in at. The first
    // is the primary (mirrored into siteId). Existing single-site records get
    // siteIds = [siteId] via the pre-save hook / the import upsert.
    siteIds: { type: [Schema.Types.ObjectId], ref: "ProjectSite", default: [] },

    // Contact (all optional)
    phone: { type: String, default: null },
    emergencyPhone: { type: String, default: null },
    email: { type: String, default: null },

    // Pay (optional at enrollment; required before payroll use)
    dailyWage: { type: Number, default: null, min: 0 }, // INR per day
    foodAllowance: { type: foodAllowanceSchema, default: () => ({}) },

    // Bank details (optional)
    bank: { type: bankSchema, default: null },

    faceEncoding: { type: [Number], default: [] }, // 128-d
    photoUrl: { type: String, default: null },
    status: { type: String, enum: [...WORKER_STATUS], default: "active" },
    dateJoined: { type: Date, default: Date.now }, // date of joining

    // Lifecycle: append-only remarks + soft-delete audit (reason is a remark).
    remarks: { type: [remarkSchema], default: [] },
    deletedAt: { type: Date, default: null },
    deletedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
  },
  { timestamps: true },
);

workerSchema.index({ siteId: 1, status: 1 });
workerSchema.index({ siteIds: 1, status: 1 });

// Keep the primary siteId and the siteIds list in sync, so every existing
// `WorkerModel.create({ siteId })` (tests, seed, demo) auto-populates siteIds —
// and any code that sets siteIds gets a correct primary siteId for free.
// Runs on `validate` (before `save`) so the synced siteId satisfies its
// `required` check even when only siteIds was supplied.
workerSchema.pre("validate", function syncSiteIds() {
  if (Array.isArray(this.siteIds) && this.siteIds.length > 0) {
    // siteIds is authoritative when provided → primary is its first entry.
    this.siteId = this.siteIds[0];
  } else if (this.siteId) {
    // Single-site path (most callers) → seed the list from the primary.
    this.siteIds = [this.siteId];
  }
});

export type Worker = InferSchemaType<typeof workerSchema>;
export const WorkerModel = model("Worker", workerSchema, "workers");
