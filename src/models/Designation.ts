import { Schema, model, InferSchemaType } from "mongoose";

const designationSchema = new Schema(
  {
    name: { type: String, required: true, unique: true, trim: true },
  },
  { timestamps: true },
);

export type Designation = InferSchemaType<typeof designationSchema>;
export const DesignationModel = model(
  "Designation",
  designationSchema,
  "designations",
);
