# 02 · Repo layout & backend changes

## Where code lives

The mobile work stays in this same Git repo so everything versions together.

```
Site_attendance/
├── src/                         # existing backend (Express + TS) — extended, not replaced
│   ├── routes/                  #   add a mobile route group (or make views responsive)
│   ├── views/
│   │   ├── (existing desktop EJS)
│   │   └── mobile/              #   NEW: responsive mobile screens (see 03-SCREENS.md)
│   └── ...
├── public/
│   ├── css/theme.css            # existing design tokens — reuse
│   └── css/mobile.css           #   NEW: mobile layout overrides (bottom nav, card lists)
├── mobile/
│   ├── README.md                # this plan
│   ├── docs/                    # these documents
│   └── app/                     #   NEW: the Capacitor project (created in 04-DEV-SETUP.md)
└── Interactive prototype questions/   # design mockups (visual reference only)
```

> Keep the `Interactive prototype questions/` folder as read-only design
> reference. Do not build on top of the prototype HTML — re-implement those
> screens as responsive EJS under `src/views/mobile/`.

## How the mobile UI is served (remote-WebView)

The Capacitor app points its WebView at the hosted site. Two clean ways to
serve mobile-shaped pages from the same Express app:

- **Option A — responsive views (recommended).** One set of EJS pages that
  adapt with CSS (`public/css/mobile.css` + media queries). The desktop
  dashboard and the mobile app render the same routes; layout differs by
  viewport. Least duplication.
- **Option B — a `/m/*` route group.** Dedicated mobile templates mounted under
  `/m`. Use this only where a screen is so different on mobile that shared
  responsive markup gets messy (e.g. the kiosk, or table→card lists).

Most screens go with Option A; the kiosk capture and the data-table screens are
the likely Option B candidates.

## Backend changes needed (checklist)

These are additive — existing behaviour is untouched.

1. **Responsive layout** — add `public/css/mobile.css` and viewport-aware
   partials: convert the 230px sidebar into a bottom tab bar + "More" drawer on
   small screens; convert data tables into stacked cards. Keep all `oh-` tokens.
2. **Camera permission context** — ensure the kiosk + enrollment pages are
   served over HTTPS (required for `getUserMedia`). No code change beyond
   hosting, but verify the Content-Security-Policy/headers don't block the
   camera or inline scripts the WebView needs.
3. **Session cookie settings for WebView** — under `NODE_ENV=production` the app
   already enables `trust proxy` + secure cookies. Confirm `SameSite` is
   compatible with the WebView origin (same-origin remote URL → fine; verify
   after first device test).
4. **JSON where a screen is interactive** — the scan endpoint already returns
   JSON (`POST /station/scan`). If any mobile screen becomes a SPA-like
   interaction, add a sibling JSON endpoint rather than scraping HTML. Keep JSON
   endpoints under a consistent prefix (e.g. `/api/...`) if you add several.
5. **Consent capture at enrollment** — add a required consent step + stored
   consent flag/timestamp on the worker record (see `07-SECURITY-AND-COMPLIANCE.md`).
6. **Auth hardening** — password reset flow + login rate-limiting before
   publishing (currently absent).

## If offline support is later required

Switch Capacitor to the **bundled-assets** pattern: ship the web UI inside the
app and talk to the backend through a JSON API (`/api/*`). This is a larger
effort (build an API for every screen + client-side rendering + a local
cache/queue for scans). Do **not** do this for v1 unless a site genuinely lacks
reliable internet.
