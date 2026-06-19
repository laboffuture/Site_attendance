# 08 · Roadmap & definition of done

Build in this order. Do not jump to the Play Store before the gates in
milestones M1 and M2 are met.

## Milestones

### M0 — Foundations (backend ready for two front-ends)
- [ ] Decide responsive-views vs `/m/*` group per screen (`02`).
- [ ] Add `public/css/mobile.css` + responsive partials (bottom nav, drawer).
- [ ] Confirm `getUserMedia` + session cookies work in a mobile browser over HTTPS.

### M1 — Compliance & hardening (publishing gate) 🔴
- [ ] Consent capture + retention/deletion (`07`).
- [ ] Liveness/anti-spoofing (or a written, signed risk acceptance).
- [ ] Password reset + login rate-limiting.
- [ ] Privacy policy URL live (biometric-specific).

### M2 — Hosting (publishing gate)
- [ ] Backend deployed to cloud + MongoDB Atlas + HTTPS (`05`).
- [ ] Persistent uploads storage.
- [ ] Seed prod admin + change password; `sync-indexes` run.

### M3 — Mobile screens
- [ ] All kiosk + auth screens (`03`).
- [ ] All staff screens (dashboard, attendance, overtime, workers, reports, flags).
- [ ] Component sheet parity with the prototype.

### M4 — Capacitor app
- [ ] Scaffold `mobile/app/` (`04`).
- [ ] `server.url` → prod; camera permission wired.
- [ ] Smoke test on real Android devices (checklist in `04`).

### M5 — Private distribution
- [ ] Play Developer account + Play App Signing (`06`).
- [ ] Data Safety form + permission justifications.
- [ ] Internal testing track install verified.
- [ ] Roll out via Managed Google Play (private).

## Definition of done (v1)
- A field staff member installs the private app, logs in, and sees role-scoped
  dashboards/approvals on a phone.
- A site runs the kiosk capture on a phone/tablet: workers scan, IN/OUT logged,
  location lock + flags work, overtime computed, missed clock-outs swept.
- HR/Management continue to use the web dashboard on PC against the same data.
- All M1/M2 compliance + hosting gates are satisfied.

## Known follow-ups beyond v1
- Offline-first kiosk (bundled assets + JSON API + scan queue).
- iOS build (Xcode, same Capacitor project).
- Leave/holiday + wage/pay calculation (turns attendance into full payroll).
- Push notifications (pending OT, flags, daily summaries).

## Current backend status (context for the team)
The web backend is v1 feature-complete: auth + 5 roles, org CRUD, enrollment +
server-side face, kiosk capture + location lock, overtime approval, dashboards/
reports/exports, users & roles, hierarchy rollup, manual attendance override,
and the nightly missed-clock-out sweep. 10 e2e suites pass (`npm run e2e:*`).
The mobile effort is additive on top of this.
