import { Router, Request, Response } from "express";

import * as db from "../db";

const router = Router();

router.get("/healthz", (_req: Request, res: Response) => {
  res.json({ status: "ok", dbReady: db.dbReady });
});

export default router;
