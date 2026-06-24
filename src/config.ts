import path from "path";

import dotenv from "dotenv";

dotenv.config();

const nodeEnv = process.env.NODE_ENV || "development";

export const config = {
  nodeEnv,
  isProd: nodeEnv === "production",
  port: Number(process.env.PORT) || 3000,
  mongodbUri: process.env.MONGODB_URI || "mongodb://localhost:27017",
  dbName: process.env.DB_NAME || "trgbi_attendance",
  sessionSecret: process.env.SESSION_SECRET || "change-me-to-a-long-random-string",
  companyName: process.env.COMPANY_NAME || "TRG-Attendance",
  // Daily missed-clock-out sweep fires at this IST "HH:MM".
  sweepTime: process.env.SWEEP_TIME || "23:00",
  // Payroll, matching the client's Chennai OT sheet:
  //  - a standard working day is this many hours (normal capped here, OT beyond);
  //  - OT is paid at this multiple of the hourly rate (the sheet pays 1× — i.e.
  //    OT hour = BASIC ÷ standardDay, no premium). Both overridable via env.
  payrollStandardHours: Number(process.env.PAYROLL_STANDARD_HOURS) || 8,
  otMultiplier: Number(process.env.OT_MULTIPLIER) || 1,
  // Where worker enrollment photos are stored. Point this at a persistent
  // volume in production so uploads survive redeploys; served at /static/uploads.
  uploadDir: process.env.UPLOAD_DIR || path.join(process.cwd(), "public", "uploads"),
};
