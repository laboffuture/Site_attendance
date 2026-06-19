# Deployment — Linux + PM2 + MongoDB Atlas

Target for TRGBI: a **Linux server (no Docker)** running the Node app under
**PM2**, data in **MongoDB Atlas**, sitting **behind an existing reverse
proxy/load balancer that terminates TLS** (HTTPS). The app trusts the proxy and
issues secure cookies when `NODE_ENV=production`.

> HTTPS is mandatory — the kiosk/enrollment camera (`getUserMedia`) refuses to
> run over plain HTTP, even on an internal network.

---

## 0. Prerequisites (one time)
- Node.js **≥ 20** (22 recommended) and `git` on the server.
- PM2: `sudo npm install -g pm2`
- Outbound HTTPS/DNS from the server to Atlas (`*.mongodb.net`, port 27017 SRV).
- A persistent directory for worker photos, e.g. `/var/lib/trgbi/uploads`.

## 1. MongoDB Atlas (managed database)
1. Create a project + cluster (the free **M0** tier is fine to start; size up later).
2. **Database Access** → add a user (e.g. `trgbi_app`) with a strong password and
   "Read and write to any database" (or scoped to the app DB).
3. **Network Access** → allowlist the **server's public IP** (avoid `0.0.0.0/0`
   in production).
4. **Connect → Drivers → Node.js** → copy the `mongodb+srv://…` connection
   string. You'll put it in `.env` as `MONGODB_URI`. The database name is taken
   from `DB_NAME` (you don't need it in the URI path).

## 2. Get the code + build
```bash
git clone https://github.com/laboffuture/Site_attendance.git
cd Site_attendance
npm ci
npm run build          # tsc + copies EJS views into dist/
```

## 3. Configure `.env` (production)
Create `.env` in the project root (it is git-ignored — never commit it):
```ini
NODE_ENV=production
PORT=3000                      # internal port; the proxy forwards to this
MONGODB_URI=mongodb+srv://trgbi_app:<password>@<cluster>.xxxx.mongodb.net/?retryWrites=true&w=majority
DB_NAME=trgbi_attendance
SESSION_SECRET=<run: node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))">
COMPANY_NAME=TRGBI
SWEEP_TIME=23:00               # IST, nightly missed-clock-out sweep
UPLOAD_DIR=/var/lib/trgbi/uploads
# First admin (created once by the seed step below):
SEED_ADMIN_NAME=TRGBI Admin
SEED_ADMIN_EMAIL=admin@trgbi.com
SEED_ADMIN_PASSWORD=<a strong one-time password>
```
Ensure the upload dir exists and is writable by the app user:
```bash
sudo mkdir -p /var/lib/trgbi/uploads && sudo chown "$USER" /var/lib/trgbi/uploads
```

## 4. Initialize the database (once)
```bash
npm run sync-indexes   # create/reconcile indexes (incl. the unique ones)
npm run seed           # first Management admin + branches/sites/designations
```
Then sign in once and **change the admin password**.

## 5. Run under PM2
```bash
pm2 start ecosystem.config.cjs
pm2 save
pm2 startup            # run the printed command (sudo) so PM2 restarts on boot
pm2 install pm2-logrotate   # optional: cap log size
```
Verify locally on the box:
```bash
curl -s http://127.0.0.1:3000/healthz   # -> {"status":"ok","dbReady":true}
```

## 6. Reverse proxy (TLS already handled by your infra)
Point your existing HTTPS proxy/LB at `http://127.0.0.1:3000` and forward the
standard headers. The app already sets `trust proxy` in production, so secure
cookies work as long as the proxy sends `X-Forwarded-Proto: https`.

Reference Nginx server block (adapt to your setup):
```nginx
server {
    server_name attendance.trgbi.example;        # your domain
    # ... your TLS cert directives ...
    client_max_body_size 12m;                     # base64 webcam photos
    location / {
        proxy_pass         http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header   Host              $host;
        proxy_set_header   X-Real-IP         $remote_addr;
        proxy_set_header   X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto $scheme;   # required for secure cookies
    }
}
```
> If a Content-Security-Policy is enforced at the proxy, ensure it allows the
> camera and the small inline scripts the kiosk/dashboard use, plus the
> jsDelivr CDN (Bootstrap/Chart.js) and Google Fonts — or self-host those.

## 7. Smoke test (over HTTPS, from a phone)
1. Browse to `https://<your-domain>/` → login page renders.
2. Sign in as admin → dashboard.
3. **Stations** → register a station → open `/station/login` on a phone, paste
   the key → the camera prompt appears and a scan reaches the server.

## 8. Updating / redeploying
```bash
git pull
npm ci
npm run build
pm2 reload trgbi-attendance     # zero-downtime restart
```
Run `npm run sync-indexes` again only if models/indexes changed.

---

## Operational notes
- **Backups**: enable Atlas automated backups (cluster → Backup). Photos in
  `UPLOAD_DIR` are not in Mongo — back that directory up too.
- **Logs**: `pm2 logs trgbi-attendance`; rotate with `pm2-logrotate`.
- **Scaling**: this is one app instance (the nightly sweep runs in-process). The
  sweep is idempotent, so adding instances later is safe, but the cleaner path
  at scale is to disable the in-process timer and run `npm run sweep` from a
  single system cron. Face matching is a linear scan over enrolled workers —
  fine for hundreds; revisit (candidate scoping / vector index) at thousands.
- **Secrets**: `.env` only; never commit it. Rotate `SESSION_SECRET` only during
  a maintenance window (it invalidates active sessions).

## systemd alternative (instead of PM2)
If you prefer systemd, skip PM2 and use a unit like:
```ini
# /etc/systemd/system/trgbi-attendance.service
[Unit]
Description=TRGBI Attendance
After=network-online.target

[Service]
WorkingDirectory=/opt/Site_attendance
ExecStart=/usr/bin/node dist/server.js
EnvironmentFile=/opt/Site_attendance/.env
Restart=always
User=trgbi

[Install]
WantedBy=multi-user.target
```
`sudo systemctl enable --now trgbi-attendance`.
