import { Schema, model, InferSchemaType } from "mongoose";

export const WORKER_STATUS = ["active", "inactive"] as const;
export type WorkerStatus = (typeof WORKER_STATUS)[number];

const workerSchema = new Schema(
  {
    empRegNo: { type: String, required: true, unique: true }, // e.g. "TRGBI-0001"
    name: { type: String, required: true },
    designationId: {
      type: Schema.Types.ObjectId,
      ref: "Designation",
      required: true,
    },
    designationName: { type: String, required: true }, // denormalized
    siteId: { type: Schema.Types.ObjectId, ref: "ProjectSite", required: true },
    siteName: { type: String, required: true }, // denormalized
    faceEncoding: { type: [Number], default: [] }, // 128-d
    photoUrl: { type: String, default: null },
    status: { type: String, enum: [...WORKER_STATUS], default: "active" },
    dateJoined: { type: Date, default: Date.now },
  },
  { timestamps: true },
);

workerSchema.index({ siteId: 1, status: 1 });

export type Worker = InferSchemaType<typeof workerSchema>;
export const WorkerModel = model("Worker", workerSchema, "workers");
