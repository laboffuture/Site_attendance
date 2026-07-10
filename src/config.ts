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
  // Dashboard attendance target (% of active workers present) — drives the
  // health verdict colour and the exception-ranked site list.
  attendanceTarget: Number(process.env.ATTENDANCE_TARGET) || 85,
  // In/out exception rules (env-overridable; per-site overrides on ProjectSite).
  // Longest continuous shift an Out can still attach to (also the "forgotten" cap)
  // — covers a true 24h shift + slop. Beyond this an open record is "forgot Out".
  maxShiftHours: Number(process.env.MAX_SHIFT_HOURS) || 26,
  // Hours past a shift's scheduled end before an open record is flagged "forgot Out".
  forgotGraceHours: Number(process.env.FORGOT_GRACE_HOURS) || 2,
  // A repeat scan by the same worker within this window is ignored (anti double-tap).
  scanDebounceSeconds: Number(process.env.SCAN_DEBOUNCE_SECONDS) || 60,
  // Pay OT only once Management-approved (matches "Management is last to close").
  otRequiresApproval: (process.env.OT_REQUIRES_APPROVAL ?? "true") !== "false",
  // Minimum paid hours on a day to earn the food allowance.
  foodMinHours: Number(process.env.FOOD_MIN_HOURS) || 5,
  // Face matching (Euclidean distance in the 128-d descriptor space; lower =
  // more similar). Measured on this deployment's enrollments: different people
  // commonly sit 0.42–0.65 apart, so 0.5 let strangers false-match.
  //  - faceMatchThreshold: hard ceiling — beyond this, always "unknown".
  //  - faceStrongMatch: at or below this the match is accepted outright.
  //  - faceMatchMargin: between the two, the best candidate must beat the
  //    runner-up by this margin, else the scan is ambiguous → "unknown".
  faceMatchThreshold: Number(process.env.FACE_MATCH_THRESHOLD) || 0.45,
  faceStrongMatch: Number(process.env.FACE_STRONG_MATCH) || 0.4,
  faceMatchMargin: Number(process.env.FACE_MATCH_MARGIN) || 0.05,
  // Where worker enrollment photos are stored. Point this at a persistent
  // volume in production so uploads survive redeploys; served at /static/uploads.
  uploadDir: process.env.UPLOAD_DIR || path.join(process.cwd(), "public", "uploads"),
};

/**
 * Refuse to start a production server with the committed placeholder session
 * secret — signing cookies with a public default undermines session integrity.
 * Called from the server entrypoint before binding the port (not at import
 * time), so dev tooling, tests and one-off scripts are unaffected.
 */
export function assertProdConfig(): void {
  if (!config.isProd) return;
  if (!process.env.SESSION_SECRET || config.sessionSecret === "change-me-to-a-long-random-string") {
    console.error("Refusing to start: SESSION_SECRET must be set to a long random string in production.");
    process.exit(1);
  }
}
