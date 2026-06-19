# 05 · Hosting the backend

HTTPS is **mandatory** — the camera (`getUserMedia`) and the Capacitor WebView
both require a secure context, and Play distribution requires it.

## Components

| Component | Recommended | Alternatives |
|---|---|---|
| App server (Node/Express) | **Render** or **Railway** (simplest) | Fly.io, DigitalOcean App Platform, AWS (ECS/Elastic Beanstalk) |
| Database | **MongoDB Atlas** (managed, backups) | self-managed Mongo (not recommended) |
| File storage (worker photos) | persistent disk or **S3-compatible bucket** | — |
| TLS | platform-managed certificate (auto) | Cloudflare / Let's Encrypt behind a proxy |

## Steps

1. **Provision MongoDB Atlas**
   - Create a cluster, a database user, and network access (allow the app
     host's egress IPs, or VPC peering).
   - Copy the `mongodb+srv://...` connection string.

2. **Deploy the Node app**
   - Build command: `npm install && npm run build`
   - Start command: `npm start` (runs `dist/server.js`)
   - Node version: 22.
   - The app boots even if the DB is briefly unreachable (login page still
     renders), so health checks won't flap during a deploy.

3. **Set environment variables** (never commit these — see `.env.example`):
   ```
   NODE_ENV=production
   PORT=<provided by host>
   MONGODB_URI=<Atlas srv string>
   DB_NAME=trgbi_attendance
   SESSION_SECRET=<48+ random bytes>
   COMPANY_NAME=TRGBI
   SWEEP_TIME=23:00          # nightly missed-clock-out sweep (IST)
   ```
   `NODE_ENV=production` turns on `trust proxy` + secure session cookies — TLS
   must be terminated at the platform/proxy in front of the app.

4. **Persistent uploads** — `public/uploads/` (worker photos) is git-ignored.
   Mount a persistent volume or switch the upload path to an S3 bucket. Do not
   rely on ephemeral container storage.

5. **First-run seeding** (once, against production)
   ```bash
   npm run seed        # creates first Management admin + org reference data
   ```
   Then **change the seeded admin password** immediately.

6. **Index sync after schema changes**
   ```bash
   npm run sync-indexes
   ```

7. **Scheduled sweep** — the nightly missed-clock-out sweep runs in-process via
   the app. If you run multiple app instances, either keep the scheduler on one
   instance or move it to a single external cron calling `npm run sweep` to
   avoid redundant (idempotent, but noisy) runs.

## Post-deploy verification
- [ ] `https://<host>/` serves the login page over TLS (valid cert).
- [ ] Login works; session cookie is `Secure` + `HttpOnly`.
- [ ] A test scan against `/station/scan` matches and logs attendance.
- [ ] Uploads survive a restart/redeploy.
- [ ] Atlas backups are enabled.
