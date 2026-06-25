import { Schema, model, InferSchemaType } from "mongoose";

// Non-enrolled labour that can be allocated to a manpower request (plan-only —
// outsource people don't scan attendance).
const outsourceEmployeeSchema = new Schema(
  {
    code: { type: String, required: true, unique: true }, // OUT-NNNN
    name: { type: String, required: true, trim: true },
    designationId: { type: Schema.Types.ObjectId, ref: "Designation", default: null },
    designationName: { type: String, default: null },
    outsourceCompany: { type: String, default: null, trim: true },
    payRate: { type: Number, default: null }, // per day
    phone: { type: String, default: null, trim: true },
    active: { type: Boolean, default: true },
  },
  { timestamps: true },
);

export type OutsourceEmployee = InferSchemaType<typeof outsourceEmployeeSchema>;
export const OutsourceEmployeeModel = model("OutsourceEmployee", outsourceEmployeeSchema, "outsource_employees");
