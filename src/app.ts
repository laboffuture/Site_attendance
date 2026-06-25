import path from "path";

import express, { Express } from "express";
import session from "express-session";
import MongoStore from "connect-mongo";
import mongoose from "mongoose";

import { config } from "./config";
import * as db from "./db";
import { loadCurrentUser } from "./auth/middleware";
import { roleLabel } from "./auth/permissions";
import { NAV } from "./nav";
import authRouter from "./routes/auth";
import attendanceRouter from "./routes/attendance";
import regularizationRouter from "./routes/regularization";
import meRouter from "./routes/me";
import dashboardRouter from "./routes/dashboard";
import designationsRouter from "./routes/designations";
import flagsRouter from "./routes/flags";
import indexRouter from "./routes/index";
import manpowerRouter from "./routes/manpower";
import orgRouter from "./routes/org";
import overtimeRouter from "./routes/overtime";
import payrollRouter from "./routes/payroll";
import reportsRouter from "./routes/reports";
import requestsRouter from "./routes/requests";
import stationRouter from "./routes/station";
import usersRouter from "./routes/users";
import stationsRouter from "./routes/stations";
import workersRouter from "./routes/workers";

/**
 * Builds the Express app. Called after connectDb() so the session store can
 * use the live Mongo connection when available, and fall back to an in-memory
 * store (degraded, dev-only) when the DB is down — keeping the app bootable.
 */
export function createApp(): Express {
  const app = express();

  // Behind a TLS-terminating proxy in production so secure cookies work.
  if (config.isProd) app.set("trust proxy", 1);

  app.set("view engine", "ejs");
  app.set("views", path.join(__dirname, "views")); // copied into dist/ at build

  // Static assets need no session/user — mount first to avoid per-asset DB hits.
  // Persistent uploads dir is served first so it can live outside the app tree.
  app.use("/static/uploads", express.static(config.uploadDir));
  app.use("/static", express.static(path.join(__dirname, "..", "public")));
  // Larger limit so base64 webcam photos (enrollment) fit in the form body.
  app.use(express.urlencoded({ extended: true, limit: "8mb" }));

  const store = db.dbReady
    ? // Reuse the existing Mongoose connection's MongoClient. Cross-package
      // type identity differs between mongoose's mongodb and connect-mongo's,
      // so cast — the runtime object is the same MongoClient.
      MongoStore.create({
        client: mongoose.connection.getClient() as unknown as never,
        dbName: config.dbName,
        collectionName: "sessions",
        ttl: 60 * 60 * 24 * 14, // 14 days
      })
    : undefined;
  if (!store) {
    console.warn("Sessions using in-memory store (DB down) — dev only.");
  }

  app.use(
    session({
      store,
      secret: config.sessionSecret,
      resave: false,
      saveUninitialized: false,
      cookie: {
        httpOnly: true,
        sameSite: "lax",
        secure: config.isProd, // HTTPS-only cookies in production
        maxAge: 60 * 60 * 24 * 14 * 1000,
      },
    }),
  );

  // Template defaults (set before loadCurrentUser so it can override can()).
  app.use((req, res, next) => {
    res.locals.company = config.companyName;
    res.locals.nav = NAV;
    res.locals.currentPath = req.path;
    res.locals.currentUser = null;
    res.locals.can = () => false;
    res.locals.roleLabel = roleLabel;
    // One-time flash message (set by a handler, consumed on next render).
    res.locals.flash = req.session.flash ?? null;
    delete req.session.flash;
    next();
  });
  app.use(loadCurrentUser);

  app.use("/", indexRouter);
  app.use("/", authRouter);
  app.use("/", dashboardRouter);
  app.use("/", orgRouter);
  app.use("/", designationsRouter);
  app.use("/", workersRouter);
  app.use("/", stationsRouter);
  app.use("/", stationRouter);
  app.use("/", overtimeRouter);
  app.use("/", reportsRouter);
  app.use("/", payrollRouter);
  app.use("/", flagsRouter);
  app.use("/", usersRouter);
  app.use("/", requestsRouter);
  app.use("/", manpowerRouter);
  app.use("/", attendanceRouter);
  app.use("/", regularizationRouter);
  app.use("/", meRouter);

  return app;
}
