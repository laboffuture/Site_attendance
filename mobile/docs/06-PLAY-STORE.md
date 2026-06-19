# 06 · Private distribution on Google Play

Distribution is **private/internal** (Managed Google Play), not a public
listing. This is the right model for an internal biometric tool: far less
review friction and the app is not publicly discoverable.

## Account & distribution model

| Option | Use when | Notes |
|---|---|---|
| **Managed Google Play (private app)** ✅ | Company-managed Android devices / Workspace | Publish privately to your organization only |
| **Internal testing track** | Early team testing (up to 100 testers by email) | Fast, no full review; good for the first installs |
| **Closed testing** | Wider pilot before rollout | Tester lists/groups |

Start on the **internal testing track** during development, then move to the
private/managed channel for rollout.

## One-time setup
1. **Google Play Developer account** — $25 one-time. For managed private apps,
   also have the organization's Google Workspace / managed Play set up.
2. **App signing** — enroll in **Play App Signing** (Google holds the signing
   key; you upload with an upload key). Back up the upload keystore securely;
   losing it blocks future updates.
3. **Application ID** — `com.trgbi.attendance` (set at Capacitor init; must stay
   stable forever).

## Required store metadata (even for private)
- **Privacy Policy URL** — mandatory. Must explicitly describe **face /
  biometric data**: what is collected, why, retention, and deletion. See
  `07-SECURITY-AND-COMPLIANCE.md`.
- **Data Safety form** — declare collection of biometric data, photos, and
  account info; how it is used, shared (not shared), encrypted in transit, and
  whether users can request deletion.
- **Permissions justification** — explain the `CAMERA` permission (attendance
  face capture).
- App name, icon, short/full description, screenshots (use the prototype
  screens), content rating questionnaire.

## Build the release bundle
1. In `mobile/app`, ensure `capacitor.config.ts` `server.url` points at the
   **production** backend (HTTPS).
2. `npx cap sync android`
3. Android Studio → **Build > Generate Signed Bundle / APK > Android App Bundle
   (.aab)** with the upload key.
4. Upload the `.aab` to the chosen track in the Play Console.

## Compliance gates (Google may reject otherwise)
- **Target API level** — Google requires a recent Android target each year;
  keep `targetSdkVersion` current.
- **Cleartext traffic disabled** — backend is HTTPS only (`cleartext: false`).
- **No secrets in the bundle** — the remote-WebView pattern ships no API keys;
  keep it that way.
- **Sensitive data policy** — biometric handling must match the declared
  privacy policy and Data Safety answers.

## Release checklist
- [ ] Production backend deployed + HTTPS verified (`05-HOSTING.md`).
- [ ] `server.url` = production URL; `npx cap sync` run.
- [ ] Signed `.aab` built with the upload key (keystore backed up).
- [ ] Privacy policy URL live and biometric-specific.
- [ ] Data Safety form completed.
- [ ] Camera permission justified.
- [ ] Internal testing install verified on a real device.
- [ ] Consent + retention implemented (`07`) before any non-test rollout.
