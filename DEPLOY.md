# Deploy / update on the server

The app runs **compiled** code from `dist/`. **A `git pull` alone does NOT apply
changes** — you must rebuild and restart. Do this every time you pull:

```bash
git pull                 # get the latest code
npm ci                   # install deps (only needed if package.json changed)
npm run build            # COMPILE src/ -> dist/  (REQUIRED — without this you run old code)
# then restart the app:
pm2 restart trg-attendance      # if using pm2
# or: systemctl restart trg-attendance
# or: stop and re-run `npm start`
```

Then **hard-refresh** the browser (Cmd/Ctrl+Shift+R).

> Symptom of skipping `npm run build` + restart: new role/nav/permission changes
> don't appear (e.g. "PM still shows Users & Roles", "Stations not visible").
> That's the old `dist/` still running.

## First-time setup

1. `.env` (never commit it):
   ```
   MONGODB_URI=...            # the ROTATED Atlas credential — not lofadmin:lof123
   DB_NAME=trgbi_attendance
   SESSION_SECRET=<long random string>
   SEED_ADMIN_PASSWORD=<the shared first-login password>
   COMPANY_NAME=TRG-Attendance
   UPLOAD_DIR=/var/data/uploads   # a persistent volume
   # optional knobs: OT_MULTIPLIER=1  PAYROLL_STANDARD_HOURS=8  ATTENDANCE_TARGET=85
   ```
2. `npm ci && npm run build`
3. `npm run seed` (creates the 5 logins + base data) — skip if restoring real data.
4. Start the app, behind **HTTPS** (camera + GPS need a secure context — the kiosk
   face-scan and geofence won't work over plain http except on `localhost`).
   If behind a reverse proxy, set Express `trust proxy` so kiosk share links use https.

## Roles (who sees what)

Set via the role each user gets; only override per-user if you must (a non-empty
per-user permission list **replaces** the role's defaults). If a user was given
custom permissions before a capability existed, re-open **Users → edit → Permissions**
and tick the new one (e.g. **Manage stations / kiosk**), or clear their custom
permissions so they follow the role.

- **Management / HR** — everything (HR keeps people-ops + payroll).
- **PM** — Dashboard, Attendance, Requests, Employees, Reports, **Stations**, recommend OT/corrections.
- **Supervisor** — Dashboard, Attendance, Requests, Employees, Reports, **Stations**.
- PM + Supervisor: open Stations → register a station → share the **kiosk link / QR**;
  workers just face the camera at that link. They do **not** get Users & Roles, Payroll, Flagged.
