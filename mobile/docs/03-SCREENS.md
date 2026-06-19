# 03 · Screens to build & design system

Build every screen below as responsive mobile UI. Each maps to an existing
backend route, so the data and permissions already exist. The visual source of
truth is the prototype in `Interactive prototype questions/`.

## Design tokens (must match exactly)

**Fonts** (Google Fonts): UI = **Poppins** (400, 600). Numeric/secondary =
**Inter** (400, 700). Mono (keys/codes) = **Courier New**. Icons = **Material
Icons (Outlined)**.

**Type:** web base `12.8px`. On mobile use **14px / line-height 1.4**, keeping
the same scale ratios. Minimum touch target **44×44px**.

**Shape:** `border-radius: 0` everywhere (the signature). The only round element
is the worker avatar (`50%`). Flat 1px borders; card shadow only
`rgba(0,0,0,.1) 0 1px 3px, rgba(0,0,0,.06) 0 1px 2px`.

**Colors:**

| Token | Hex | | Token | Hex |
|---|---|---|---|---|
| text | `#1c1c1c` | | accent (LOF blue) | `#1c4d8c` |
| canvas | `#f9f9f9` | | accent-dark | `#163d70` |
| surface | `#ffffff` | | danger | `#ff3b38` |
| brand (dark nav) | `#212121` | | warning | `#f5b438` |
| brand-light | `#333333` | | success | `#21c06b` |
| border | `#cdd5df` | | info | `#2e97db` |
| border-light | `#e8ecf1` | | placeholder | `#94a0b3` |
| text-muted | `#737373` | | icon grey | `#5f6368` |

Soft status fills: success `#e1fbe9`/`#1f7a44` · info `#ebf3fd`/`#1d4ed8` ·
warning `#fff8e1`/`#8a6d1b` · danger `#fdebeb`/`#b3261e`.

All of the above already exist as CSS variables in `public/css/theme.css` —
reuse that file; do not redefine tokens.

## Mobile navigation

- Desktop 230px dark sidebar → **bottom tab bar** (dark `#212121`, active item =
  LOF-blue accent indicator + white text) with primary tabs: **Dashboard**
  (`dashboard`), **Attendance** (`schedule`), **Overtime** (`more_time`),
  **More** (`menu`).
- **More** opens a drawer with: Workers (`groups`), Designations (`badge`),
  Branches & Sites (`apartment`), Stations (`desktop_windows`), Users & Roles
  (`manage_accounts`), Reports (`description`), Flagged (`flag`).
- Top app bar (56px, white, 1px bottom border): screen title left, user name +
  logout right.
- Items are **role-scoped** — show only what the user's capabilities allow
  (the existing `nav.ts` + permission middleware already drives this).

## Screen list (route → screen)

### Auth & kiosk (standalone, no nav)
| Route | Screen | Notes |
|---|---|---|
| `GET /` | **Login** | email + password (with show/hide), accent "Sign in" button, alert states |
| `GET /station/login` | **Station sign-in** | paste station key, "Connect station" |
| `GET /station` | **Kiosk capture** | full-screen dark; live mirrored video; big scan button; 5-state result banner (idle/IN/OUT/warn/error). Reuses `public/js/station.js`. |

### Main app (bottom nav + app bar)
| Route | Screen | Mobile layout |
|---|---|---|
| `GET /dashboard` | **Dashboard** | stat card grid (2-up), Chart.js cards, Branch→Site rollup (expandable rows) |
| `GET /attendance` | **Attendance** | filter sheet (site+date); roster as **stacked worker cards** with Mark In / Add Out / Correct |
| `GET /overtime` | **Overtime queue** | filter tabs (Pending/Approved/Rejected); OT cards with Approve/Adjust/Reject; status badge always shown; PM = view-only |
| `GET /workers` | **Workers list** | search; worker cards (round avatar, reg no, designation, site, status); "Enroll" action |
| `GET /workers/new` | **Enroll worker** | name, designation (+add new), site; **face capture** (webcam preview + shot, capture/upload); validation for no-face |
| `GET /workers/edit/:id` | **Edit worker** | prefilled + status + re-capture |
| `GET /designations` | **Designations** | list + inline "add designation" |
| `GET /org` | **Branches & Sites** | branches with their sites (code, shift start/end); edit forms (site has per-designation override) |
| `GET /stations` | **Stations** | list (name, site, last-seen, active); register form |
| `GET /stations` (created) | **Station key** | one-time key in dark mono **keybox** + "shown once" warning + copy |
| `GET /users` | **Users & Roles** | staff list (role badge, sites, active); add/edit form; role rules (PM ≥1 site, PE/Supervisor =1) |
| `GET /reports` | **Reports** | filter sheet (branch/site/date/designation/search); Branch→Site grouped records as cards; **Download PDF / Excel** |
| `GET /flags` | **Flagged events** | Unresolved/Resolved tabs; flag cards (type badge incl. "Missed clock-out", worker, site, Resolve) |
| error | **Access denied / Not found** | centered card with code + message |

## Component sheet (build each with all states)

Buttons (default grey, accent/secondary, success, danger, small, full-width;
default/hover/pressed/disabled) · inputs (text, select, password-with-toggle,
code, xs, time; focus = 2px `#212121` inset) · labels & input groups · cards
(stat, link, note, content) · **table→card** stacked-row pattern · badges
(secondary, muted, success, warning, danger; square, 0.7rem 600) · alerts
(warning/info/danger/success soft fills) · filter tabs (active = accent) ·
avatar thumbnail (36px circle) · kiosk result banner (5 states) · keybox (dark
mono) · bottom nav + drawer + top app bar.

## Sample data for mockups
Use realistic Indian site data: sites "VBW — T.Nagar", "PVM — Vadapalani",
"CMS (CBE)"; designations Carpenter / Mason / Electrician / Helper; worker reg
nos like `TRGBI-0001`.
