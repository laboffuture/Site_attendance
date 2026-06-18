import { Schema, model, InferSchemaType } from "mongoose";

const branchSchema = new Schema(
  {
    name: { type: String, required: true, unique: true, trim: true },
  },
  { timestamps: true },
);

export type Branch = InferSchemaType<typeof branchSchema>;
export const BranchModel = model("Branch", branchSchema, "branches");
