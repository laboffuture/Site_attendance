import path from "path";

import express, { Express } from "express";
import session from "express-session";
import MongoStore from "connect-mongo";
import mongoose from "mongoose";

import { config } from "./config";
import * as db from "./db";
import { loadCurrentUser } from "./auth/middleware";
import { NAV } from "./nav";
import authRouter from "./routes/auth";
import dashboardRouter from "./routes/dashboard";
import designationsRouter from "./routes/designations";
import indexRouter from "./routes/index";
import orgRouter from "./routes/org";

/**
 * Builds the Express app. Called after connectDb() so the session store can
 * use the live Mongo connection when available, and fall back to an in-memory
 * store (degraded, dev-only) when the DB is down — keeping the app bootable.
 */
export function createApp(): Express {
  const app = express();

  app.set("view engine", "ejs");
  app.set("views", path.join(__dirname, "views"));

  // Static assets need no session/user — mount first to avoid per-asset DB hits.
  app.use("/static", express.static(path.join(__dirname, "..", "public")));
  app.use(express.urlencoded({ extended: true }));

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
      cookie: { httpOnly: true, sameSite: "lax", maxAge: 60 * 60 * 24 * 14 * 1000 },
    }),
  );

  // Template defaults (set before loadCurrentUser so it can override can()).
  app.use((req, res, next) => {
    res.locals.company = config.companyName;
    res.locals.nav = NAV;
    res.locals.currentPath = req.path;
    res.locals.currentUser = null;
    res.locals.can = () => false;
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

  return app;
}
