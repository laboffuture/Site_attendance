import { Schema, model, InferSchemaType } from "mongoose";

export const OVERTIME_STATUS = ["none", "pending", "approved", "rejected"] as const;
export type OvertimeStatus = (typeof OVERTIME_STATUS)[number];

const overtimeSchema = new Schema(
  {
    computedHours: { type: Number, default: 0 },
    status: { type: String, enum: [...OVERTIME_STATUS], default: "none" },
    approvedHours: { type: Number, default: null },
    approvedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    approvedAt: { type: Date, default: null },
    notes: { type: String, default: null },
  },
  { _id: false },
);

const attendanceSchema = new Schema(
  {
    date: { type: String, required: true }, // site-local day, "YYYY-MM-DD"

    // worker snapshot (denormalized for join-free reports)
    workerId: { type: Schema.Types.ObjectId, ref: "Worker", required: true },
    empRegNo: { type: String, required: true },
    workerName: { type: String, required: true },
    designationId: {
      type: Schema.Types.ObjectId,
      ref: "Designation",
      required: true,
    },
    designationName: { type: String, required: true },

    // location snapshot (denormalized)
    siteId: { type: Schema.Types.ObjectId, ref: "ProjectSite", required: true },
    siteName: { type: String, required: true },
    branchId: { type: Schema.Types.ObjectId, ref: "Branch", required: true },
    branchName: { type: String, required: true },

    inTime: { type: Date, required: true },
    outTime: { type: Date, default: null },
    totalHours: { type: Number, default: null },
    standardHours: { type: Number, default: null },
    overtime: { type: overtimeSchema, default: () => ({}) },

    // Audit: how this record was created/last changed. Scan = face kiosk;
    // manual = marked/corrected by a user on the Attendance page.
    source: { type: String, enum: ["scan", "manual"], default: "scan" },
    markedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
  },
  { timestamps: true },
);

attendanceSchema.index({ siteId: 1, date: 1 });
attendanceSchema.index({ workerId: 1, date: 1 }, { unique: true }); // one row/worker/day
attendanceSchema.index({ branchId: 1, date: 1 });
attendanceSchema.index({ "overtime.status": 1 });

export type Attendance = InferSchemaType<typeof attendanceSchema>;
export const AttendanceModel = model("Attendance", attendanceSchema, "attendance");
