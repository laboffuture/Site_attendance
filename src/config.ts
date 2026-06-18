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
  companyName: process.env.COMPANY_NAME || "TRGBI",
  // Daily missed-clock-out sweep fires at this IST "HH:MM".
  sweepTime: process.env.SWEEP_TIME || "23:00",
};
