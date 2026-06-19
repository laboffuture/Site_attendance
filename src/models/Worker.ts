import { Schema, model, InferSchemaType } from "mongoose";

export const WORKER_STATUS = ["active", "inactive"] as const;
export type WorkerStatus = (typeof WORKER_STATUS)[number];

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
    siteId: { type: Schema.Types.ObjectId, ref: "ProjectSite", required: true },
    siteName: { type: String, required: true }, // denormalized

    // Contact (all optional)
    phone: { type: String, default: null },
    emergencyPhone: { type: String, default: null },
    email: { type: String, default: null },

    // Bank details (optional)
    bank: { type: bankSchema, default: null },

    faceEncoding: { type: [Number], default: [] }, // 128-d
    photoUrl: { type: String, default: null },
    status: { type: String, enum: [...WORKER_STATUS], default: "active" },
    dateJoined: { type: Date, default: Date.now }, // date of joining
  },
  { timestamps: true },
);

workerSchema.index({ siteId: 1, status: 1 });

export type Worker = InferSchemaType<typeof workerSchema>;
export const WorkerModel = model("Worker", workerSchema, "workers");
