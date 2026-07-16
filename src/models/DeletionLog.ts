import { Schema, model, InferSchemaType } from "mongoose";

/**
 * Append-only register of deletions (employees and sites). A "delete" in the
 * app never erases the underlying record — it hides it and writes one of
 * these entries so HR/Management always have an answer to "who deleted X,
 * when, and why". Entries are never edited or removed; a Management-only
 * Undo marks the entry restored (and un-hides the record) but keeps it.
 */
const deletionLogSchema = new Schema(
  {
    entityType: { type: String, enum: ["worker", "site"], required: true },
    entityId: { type: Schema.Types.ObjectId, required: true, index: true },
    name: { type: String, required: true }, // worker name / site name
    detail: { type: String, default: null }, // empRegNo / site code
    siteName: { type: String, default: null }, // worker's site (workers only)
    photoUrl: { type: String, default: null }, // workers only

    deletedById: { type: Schema.Types.ObjectId, ref: "User", required: true },
    deletedByName: { type: String, required: true },
    reason: { type: String, required: true },

    // Site deletions: how many of its employees were cascaded where.
    cascadeArchived: { type: Number, default: null },
    cascadeDeleted: { type: Number, default: null },

    restoredAt: { type: Date, default: null },
    restoredById: { type: Schema.Types.ObjectId, ref: "User", default: null },
    restoredByName: { type: String, default: null },
  },
  { timestamps: true },
);

deletionLogSchema.index({ createdAt: -1 });

export type DeletionLog = InferSchemaType<typeof deletionLogSchema>;
export const DeletionLogModel = model("DeletionLog", deletionLogSchema, "deletion_log");
