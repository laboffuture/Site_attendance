import "express-session";
import type { CurrentUser } from "../auth/types";

declare module "express-session" {
  interface SessionData {
    userId?: string;
    stationId?: string;
    flash?: { type: "success" | "danger" | "info" | "warning"; text: string };
  }
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      currentUser?: CurrentUser;
      station?: { id: string; name: string; siteId: string; siteName: string };
    }
  }
}

export {};
