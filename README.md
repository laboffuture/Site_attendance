# TRGBI Site Attendance & Workforce Management

Face-recognition attendance for daily-wage construction workers across branches and project sites, with location-locked scanning, automatic overtime computation, an HR/Management approval workflow, and role-scoped dashboards.

- **Spec:** [`site-attendance-system-spec.md`](site-attendance-system-spec.md)
- **Design:** [`docs/superpowers/specs/2026-06-18-site-attendance-design.md`](docs/superpowers/specs/2026-06-18-site-attendance-design.md)

## Stack
Node 22 · Express · TypeScript · MongoDB Atlas (Mongoose) · server-rendered EJS templates (Horilla `oh-` design) · express-session auth · vanilla JS `getUserMedia` · Chart.js.

## Setup (Windows / PowerShell)

```powershell
npm install
Copy-Item .env.example .env   # then edit .env (MONGODB_URI, SESSION_SECRET)
npm run dev                   # http://localhost:3000
```

The server boots even if the database is unreachable (so the login page renders); set a real `MONGODB_URI` to enable data features.

## Scripts
- `npm run dev` — dev server with hot reload (tsx watch)
- `npm run build` — type-check & compile to `dist/`
- `npm start` — run compiled server
- `npm run smoke` — quick boot smoke test

## Status
Scaffolding in progress — see the design doc's build order.
