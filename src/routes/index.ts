import { Router, Request, Response } from "express";

import * as db from "../db";

const router = Router();

// Readiness probe: 200 only when the DB is connected, 503 when degraded, so a
// load balancer / PM2 can route around an instance booted without Mongo.
router.get("/healthz", (_req: Request, res: Response) => {
  res.status(db.dbReady ? 200 : 503).json({ status: db.dbReady ? "ok" : "degraded", dbReady: db.dbReady });
});

export default router;
