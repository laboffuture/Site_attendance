# 01 · Architecture

## One backend, two front-ends

```
                 ┌─────────────────────────────────────┐
                 │   Node/Express + TypeScript backend  │
                 │   • MongoDB Atlas (managed)          │  ← single source of truth
                 │   • express-session (connect-mongo)  │     cloud-hosted, HTTPS only
                 │   • server-side face match (face-api)│
                 │   • EJS views + JSON endpoints       │
                 └───────────────┬─────────────────────-┘
        HTML + session cookie    │    HTML + session cookie + getUserMedia
        ┌────────────────────────┴─────────────────────────┐
        │                                                   │
┌───────▼──────────┐                          ┌─────────────▼────────────┐
│  WEB DASHBOARD   │                          │  MOBILE APP (Capacitor)   │
│  existing desktop│                          │  Android WebView →        │
│  EJS sidebar app │                          │  hosted responsive pages  │
│  HR / Management │                          │  • Kiosk capture (camera) │
│  (make responsive)                          │  • Field staff dashboards │
└──────────────────┘                          └───────────────────────────┘
```

Both front-ends talk to the **same** Express server and the **same** MongoDB.
There is no second database and no duplicated business logic.

## Key decisions and the reasoning

### 1. Capacitor, remote-WebView pattern
The Android app is a thin native shell whose WebView loads the hosted site
(`server.url` in `capacitor.config.ts`). Benefits for this project:
- **Maximum reuse** — the existing EJS pages, session auth, CSS, and the
  server-side face engine are used as-is.
- **Instant content updates** — changing a screen is a backend deploy, not a
  new Play Store release.
- **One codebase** for Android now and iOS later.

Trade-off: the app needs connectivity. That is acceptable — the system spec
states internet is reliable at every site, so no offline-sync layer is built
in v1. (If offline becomes a hard requirement later, switch to Capacitor's
bundled-assets + JSON-API pattern; see `02-REPO-AND-BACKEND.md`.)

### 2. Camera via `getUserMedia`, not the native single-shot plugin
The kiosk needs a **live** video preview and repeated scans. `getUserMedia`
(already used in `public/js/station.js`) provides that and runs in the WebView
over HTTPS once the Android `CAMERA` permission is granted. The native
Capacitor Camera plugin is single-shot and is only a fallback for enrollment
photo upload.

### 3. Face recognition stays server-side
The phone captures a JPEG frame and `POST`s it to `/station/scan`; the server
matches against all enrolled workers and applies the location lock. No on-device
ML model is shipped. This keeps the app small, keeps encodings centralized, and
means accuracy/threshold tuning happens in one place.

### 4. Auth is unchanged (session cookies)
`express-session` + `connect-mongo` cookies work inside the WebView. The mobile
app does not need a separate token scheme for v1. (If a future pure-native app
is built, add token/JWT auth then.)

## The two mobile roles in one app

| Role at runtime | Entry | Screens | Camera |
|---|---|---|---|
| **Site Station (kiosk)** | `/station/login` with a station key | Capture/scan screen | Yes (live) |
| **Field staff** (Mgmt/HR/PM/PE/Supervisor) | `/login` with email+password | Dashboard, attendance, overtime, workers, reports, flags (role-scoped) | Enrollment only |

The app decides which surface to show based on which session is active, exactly
as the web app already does. No separate builds.

## What is reused vs. what is new

| Reused (no rewrite) | New work |
|---|---|
| Express routes, models, permissions | Responsive mobile EJS views (from the prototype) |
| `express-session` auth | Capacitor project (`mobile/app/`) |
| Server-side face engine + `/station/scan` | Android camera permission wiring |
| MongoDB schema, missed-clockout sweep, OT workflow | Cloud hosting + HTTPS + Atlas |
| Horilla `oh-` design tokens / `theme.css` | Mobile nav (bottom tabs + drawer), table→card layouts |
| | DPDP consent capture + auth hardening |
