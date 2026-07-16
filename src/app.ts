import path from "path";

import express, { Express } from "express";
import "express-async-errors"; // routes async rejections to the error handler (Express 4)
import session from "express-session";
import MongoStore from "connect-mongo";
import helmet from "helmet";
import morgan from "morgan";
import rateLimit from "express-rate-limit";
import mongoose from "mongoose";

import { config } from "./config";
import * as db from "./db";
import { csrfGuard } from "./auth/csrf";
import { loadCurrentUser } from "./auth/middleware";
import { roleLabel } from "./auth/permissions";
import { NAV } from "./nav";
import authRouter from "./routes/auth";
import attendanceRouter from "./routes/attendance";
import regularizationRouter from "./routes/regularization";
import meRouter from "./routes/me";
import dashboardRouter from "./routes/dashboard";
import deletionlogRouter from "./routes/deletionlog";
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

// Brute-force throttles on the unauthenticated entry points. Only FAILED attempts
// count (skipSuccessfulRequests) so a busy office sharing one IP isn't locked out
// by legitimate logins. Keyed on client IP (correct behind the prod trust-proxy).
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 50,
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  message: "Too many sign-in attempts. Please wait a few minutes and try again.",
});

// The kiosk scan is CPU-heavy (server-side face match). Generous per-IP cap — a
// busy kiosk scans well under this; it only blunts automated amplification abuse.
const scanLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
});

/**
 * Builds the Express app. Called after connectDb() so the session store can
 * use the live Mongo connection when available, and fall back to an in-memory
 * store (degraded, dev-only) when the DB is down — keeping the app bootable.
 */
export function createApp(): Express {
  const app = express();

  // Behind a TLS-terminating proxy in production so secure cookies work.
  if (config.isProd) app.set("trust proxy", 1);

  // Security headers. CSP is tuned to the app's real origins: self-hosted JS/CSS,
  // Google Fonts + Material Icons, jsDelivr (Bootstrap), data:/blob: for QR codes
  // and webcam captures, and the site-picker map (Leaflet from unpkg/cdnjs, OSM
  // tiles, Nominatim search). Face matching is server-side, so the client needs no
  // wasm/eval. COEP off (would block the cross-origin fonts + getUserMedia).
  const MAP_CDNS = ["https://unpkg.com", "https://cdnjs.cloudflare.com"];
  app.use(
    helmet({
      contentSecurityPolicy: {
        useDefaults: false,
        directives: {
          defaultSrc: ["'self'"],
          baseUri: ["'self'"],
          fontSrc: ["'self'", "https://fonts.gstatic.com", "data:"],
          formAction: ["'self'"],
          frameAncestors: ["'self'"],
          imgSrc: ["'self'", "data:", "blob:", "https://*.tile.openstreetmap.org", "https://unpkg.com"],
          objectSrc: ["'none'"],
          scriptSrc: ["'self'", "'unsafe-inline'", ...MAP_CDNS],
          styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com", "https://cdn.jsdelivr.net", ...MAP_CDNS],
          connectSrc: ["'self'", "https://nominatim.openstreetmap.org"],
          workerSrc: ["'self'", "blob:"],
          ...(config.isProd ? { upgradeInsecureRequests: [] } : {}),
        },
      },
      crossOriginEmbedderPolicy: false,
      hsts: config.isProd ? { maxAge: 15_552_000, includeSubDomains: true } : false,
    }),
  );

  app.set("view engine", "ejs");
  app.set("views", path.join(__dirname, "views")); // copied into dist/ at build

  // Static assets need no session/user — mount first to avoid per-asset DB hits.
  // Persistent uploads dir is served first so it can live outside the app tree.
  app.use("/static/uploads", express.static(config.uploadDir));
  app.use("/static", express.static(path.join(__dirname, "..", "public")));
  // HTTP access logging — mounted after static so per-asset noise is skipped.
  app.use(morgan(config.isProd ? "combined" : "dev"));
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

  // CSRF: reject cross-site state-changing requests by Origin/Referer (defense in
  // depth over the sameSite:lax cookie). Same-origin forms + kiosk AJAX are unaffected.
  app.use(csrfGuard);

  // Throttle the unauthenticated / CPU-heavy entry points before the routers.
  app.use("/login", loginLimiter);
  app.use("/station/login", loginLimiter);
  app.use("/station/scan", scanLimiter);

  app.use("/", indexRouter);
  app.use("/", authRouter);
  app.use("/", dashboardRouter);
  app.use("/", orgRouter);
  app.use("/", designationsRouter);
  app.use("/", workersRouter);
  app.use("/", deletionlogRouter);
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

  // 404 — unmatched route renders the standalone branded error page. It uses
  // "error-basic" (no app shell) because this handler also runs for unauthenticated
  // requests, where the authed sidebar/topbar would dereference a null currentUser.
  app.use((_req, res) => {
    res.status(404).render("error-basic", { title: "Not found", code: 404, message: "That page doesn't exist." });
  });

  // Central error handler — async route rejections reach here via express-async-errors,
  // so a transient DB error no longer escapes as an unhandled rejection. Logs the
  // error server-side and renders the standalone 500 page; never leaks internals.
  app.use((err: Error, req: express.Request, res: express.Response, next: express.NextFunction) => {
    console.error(`Unhandled error on ${req.method} ${req.originalUrl}:`, err?.stack ?? err);
    if (res.headersSent) return next(err);
    try {
      res.status(500).render("error-basic", { title: "Something went wrong", code: 500, message: "Something went wrong on our end. Please try again." });
    } catch {
      res.status(500).type("text").send("Internal Server Error");
    }
  });

  return app;
}
