import { Schema, model, InferSchemaType } from "mongoose";

const designationOverrideSchema = new Schema(
  {
    designationId: {
      type: Schema.Types.ObjectId,
      ref: "Designation",
      required: true,
    },
    startTime: { type: String, required: true }, // "HH:MM"
    endTime: { type: String, required: true }, // "HH:MM"
  },
  { _id: false },
);

const projectSiteSchema = new Schema(
  {
    branchId: {
      type: Schema.Types.ObjectId,
      ref: "Branch",
      required: true,
      index: true,
    },
    name: { type: String, required: true },
    code: { type: String, required: true },
    standardStartTime: { type: String, default: "09:00" },
    standardEndTime: { type: String, default: "18:00" },
    designationOverrides: { type: [designationOverrideSchema], default: [] },
  },
  { timestamps: true },
);

export type ProjectSite = InferSchemaType<typeof projectSiteSchema>;
export const ProjectSiteModel = model(
  "ProjectSite",
  projectSiteSchema,
  "project_sites",
);
