# 04 · Developer setup & Capacitor scaffold

## Prerequisites

| Tool | Why | Notes |
|---|---|---|
| **Node 22+** & npm | backend + Capacitor CLI | repo targets Node 22 |
| **Android Studio** (latest) | emulator, SDK, signing, build `.aab` | install "Android SDK" + a system image |
| **JDK 17** | Android Gradle builds | bundled with recent Android Studio |
| **MongoDB** (local) | dev database | or point at an Atlas dev cluster |
| A physical Android phone (optional) | real camera testing | enable USB debugging |

> macOS note: Android builds need only Android Studio + JDK. iOS (a later
> phase) additionally requires Xcode on macOS.

## Run the backend locally (already works)

```bash
# from repo root
npm install
cp .env.example .env        # set MONGODB_URI, SESSION_SECRET, COMPANY_NAME
npm run seed                # first admin + org data
npm run dev                 # http://localhost:3000
```

For a phone/emulator to reach your dev machine, serve over HTTPS on a LAN URL
or a tunnel (e.g. a dev tunnel / ngrok). `getUserMedia` requires a **secure
context** — `http://localhost` is OK on the same machine, but a device needs
HTTPS.

## Scaffold the Capacitor app (one time)

```bash
mkdir -p mobile/app && cd mobile/app
npm init -y
npm install @capacitor/core @capacitor/cli @capacitor/android
npx cap init "TRGBI Attendance" com.trgbi.attendance --web-dir=www
mkdir -p www && echo "redirecting..." > www/index.html   # placeholder; real UI is remote
npx cap add android
```

### Point the WebView at the hosted site (remote pattern)

`mobile/app/capacitor.config.ts`:

```ts
import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.trgbi.attendance',
  appName: 'TRGBI Attendance',
  webDir: 'www',
  server: {
    // Dev: your tunnel/LAN HTTPS URL. Prod: the deployed backend URL.
    url: 'https://<your-backend-host>',
    cleartext: false,            // HTTPS only
    androidScheme: 'https',
  },
};
export default config;
```

### Grant camera permission (Android)

In `mobile/app/android/app/src/main/AndroidManifest.xml`:

```xml
<uses-permission android:name="android.permission.CAMERA" />
<uses-feature android:name="android.hardware.camera" android:required="false" />
```

The WebView must auto-grant `getUserMedia` permission requests. Add a small
`MainActivity` override (or the `@capacitor-community/camera`/WebView config) so
`onPermissionRequest` grants `RESOURCE_VIDEO_CAPTURE`. Document the exact
snippet in code review when implemented.

## Build & run

```bash
cd mobile/app
npx cap sync android         # after any config/plugin change
npx cap open android         # opens Android Studio → Run on emulator/device
```

To produce a release bundle for distribution:
```bash
# in Android Studio: Build > Generate Signed Bundle / APK > Android App Bundle (.aab)
```
See `06-PLAY-STORE.md` for signing and private distribution.

## Smoke test checklist (per device)
- [ ] App opens to login over HTTPS (no cleartext warning).
- [ ] Staff login → dashboard renders, bottom nav works, role-scoped items.
- [ ] Station login with a key → kiosk capture screen.
- [ ] Camera permission prompt appears once; live preview shows.
- [ ] Scan returns IN/OUT/wrong-site/unknown banners correctly.
- [ ] Enrollment capture + upload both produce a valid face encoding.
- [ ] Session persists across app background/resume.
