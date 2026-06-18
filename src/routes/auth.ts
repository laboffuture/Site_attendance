import { Router, Request, Response } from "express";

import { config } from "../config";
import * as db from "../db";
import { verifyPassword } from "../auth/password";
import { UserModel } from "../models/User";

const router = Router();

function loginLocals(extra: Record<string, unknown> = {}) {
  return { title: "Sign In · " + config.companyName, dbReady: db.dbReady, ...extra };
}

router.get("/", (req: Request, res: Response) => {
  if (req.currentUser) return res.redirect("/dashboard");
  res.render("login", loginLocals());
});

router.post("/login", async (req: Request, res: Response) => {
  if (!db.dbReady) {
    return res
      .status(503)
      .render("login", loginLocals({ error: "Database not connected. Try again shortly." }));
  }

  const email = String(req.body.email ?? "").toLowerCase().trim();
  const password = String(req.body.password ?? "");

  const user = await UserModel.findOne({ email });
  // Generic message — don't reveal whether the email exists.
  if (!user || !user.active || !(await verifyPassword(password, user.passwordHash))) {
    return res.status(401).render("login", loginLocals({ error: "Invalid email or password." }));
  }

  // Regenerate the session on login to prevent session fixation.
  req.session.regenerate((err) => {
    if (err) {
      return res
        .status(500)
        .render("login", loginLocals({ error: "Could not start session. Try again." }));
    }
    req.session.userId = String(user._id);
    req.session.save(() => res.redirect("/dashboard"));
  });
});

router.post("/logout", (req: Request, res: Response) => {
  req.session.destroy(() => res.redirect("/"));
});

export default router;
