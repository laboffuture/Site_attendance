import { Schema, model, InferSchemaType } from "mongoose";

// A manual payroll adjustment (arrears, +/−) for one worker for one pay period
// (identified by its exact date range), folded into that run's gross pay.
const payrollAdjustmentSchema = new Schema(
  {
    workerId: { type: Schema.Types.ObjectId, ref: "Worker", required: true },
    dateFrom: { type: String, required: true }, // "YYYY-MM-DD"
    dateTo: { type: String, required: true },
    amount: { type: Number, default: 0 }, // may be negative (deduction)
    note: { type: String, default: null, trim: true },
    updatedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    updatedByName: { type: String, default: null },
  },
  { timestamps: true },
);

// One adjustment per worker per exact period.
payrollAdjustmentSchema.index({ workerId: 1, dateFrom: 1, dateTo: 1 }, { unique: true });

export type PayrollAdjustment = InferSchemaType<typeof payrollAdjustmentSchema>;
export const PayrollAdjustmentModel = model("PayrollAdjustment", payrollAdjustmentSchema, "payroll_adjustments");
