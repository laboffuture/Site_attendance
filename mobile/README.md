# TRGBI Attendance — Mobile App (Build & Hosting Plan)

This directory is the **team playbook** for turning the existing TRGBI Site
Attendance system into a private Android app, while keeping the existing web
dashboard. It contains the architecture, the build approach, the screens to
build, dev setup, hosting, Play Store (private) distribution, and the
compliance/security work that gates publishing.

**Nothing here is app code yet** — it is the plan a developer can pick up and
execute. The mobile app project itself will be scaffolded under `mobile/app/`
(see `docs/04-DEV-SETUP.md`).

---

## TL;DR — the decisions already made

| Decision | Choice |
|---|---|
| Front-ends | **Two surfaces, one backend**: keep the **web dashboard** (desktop, HR/Management) + add a **mobile app** (kiosk capture + field staff). |
| Mobile build approach | **Capacitor** wrapping a responsive web UI (remote-WebView pattern). |
| Camera | Browser **`getUserMedia`** over HTTPS inside the WebView — reuses the existing kiosk capture code. |
| Face recognition | Stays **server-side** (`face-api` WASM). The phone only sends a photo. |
| Distribution | **Private / internal** via Managed Google Play (not a public listing). |
| Backend | Unchanged stack (Node/Express/TypeScript + MongoDB); add responsive mobile views + JSON where needed. |

## Why this is low-risk and high-reuse

The existing kiosk page already does `getUserMedia` → `POST /station/scan` →
server-side match. That same flow runs in a mobile browser today. Capacitor
just packages it as an installable app and grants native camera permission.
You reuse: the backend, session-cookie auth, the face engine, and the Horilla
`oh-` design system. The real work is **responsive mobile screens + a thin
native shell + cloud hosting + compliance**.

## Read in this order

1. [`docs/01-ARCHITECTURE.md`](docs/01-ARCHITECTURE.md) — system shape & key decisions
2. [`docs/02-REPO-AND-BACKEND.md`](docs/02-REPO-AND-BACKEND.md) — repo layout & backend changes
3. [`docs/03-SCREENS.md`](docs/03-SCREENS.md) — every screen to build (mapped to routes + prototype)
4. [`docs/04-DEV-SETUP.md`](docs/04-DEV-SETUP.md) — prerequisites, Capacitor scaffold, run on a device
5. [`docs/05-HOSTING.md`](docs/05-HOSTING.md) — deploy backend + MongoDB Atlas + HTTPS
6. [`docs/06-PLAY-STORE.md`](docs/06-PLAY-STORE.md) — private distribution, signing, Data Safety
7. [`docs/07-SECURITY-AND-COMPLIANCE.md`](docs/07-SECURITY-AND-COMPLIANCE.md) — DPDP/biometric consent, auth hardening
8. [`docs/08-ROADMAP.md`](docs/08-ROADMAP.md) — milestones & definition of done

## Design reference

The approved mobile UI mockups live in the repo at
`Interactive prototype questions/` (a Claude-designed clickable prototype —
`TRGBI Attendance (standalone).html`). Treat it as the **visual source of
truth**; it is a picture of the screens, not runnable code. The exact design
tokens (fonts, colors, components) are restated in `docs/03-SCREENS.md`.
