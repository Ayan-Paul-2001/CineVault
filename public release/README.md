# CineVault Public Release & Version-Control Auto-Update

This directory holds the signed public Android release package (`CineVault.apk`), the version-control update manifest (`version.json`), and SHA-256 verification checksums (`SHA256SUMS.txt`).

## Contents

- `CineVault.apk` — Signed standalone Android release APK (`applicationId: com.cinevault.app`).
- `version.json` — Version-control auto-update manifest read directly by CineVault over HTTPS.
- `SHA256SUMS.txt` — Verified SHA-256 digest for `CineVault.apk`.

## How Version-Control Auto-Update Works

1. In the Android app, open the **Servers** tab in the bottom menu bar and scroll to **App Updates (Public Release)**.
2. Enter your public GitHub repository (`owner/repo`) or the direct raw HTTPS URL to `public release/version.json`, then tap **Save Source**.
3. On startup (and whenever you tap **Check Updates**), CineVault fetches `public release/version.json` over HTTPS and compares:
   - `appVersion` / `version` (semantic version comparison)
   - `appVersionCode` / `versionCode` (Android build code comparison)
   - `accessControl` (`forceUpdateEnabled`, `forceAppUpdate`, `minAppVersion`, `minVersion`, `lockTitle`, `lockMessage`)
4. When a newer version is published:
   - **Normal Update:** Displays an in-app update banner and changelog with verified SHA-256 and opens the HTTPS `apkPackage` (`CineVault.apk`) download in Android's system browser.
   - **Mandatory Update (`accessControl`):** If `forceUpdateEnabled` / `forceAppUpdate` is `true` or the installed version is below `minAppVersion`, CineVault shows a blocking update dialog using `lockTitle` and `lockMessage` directing the user to install the latest `CineVault.apk`.

## Publishing a Future Version

1. Increment `versionCode` and `versionName` in `android-app/app/build.gradle`.
2. Build the signed release APK with the same persistent signing keystore so users upgrade seamlessly without uninstalling:

```bash
cd android-app
gradle testDebugUnitTest assembleRelease -PGITHUB_REPO=owner/repo
```

3. Copy `android-app/app/build/outputs/apk/release/app-release.apk` to `public release/CineVault.apk`.
4. Update `public release/version.json` (`appVersion`, `appDisplayVersion`, `appVersionCode`, `version`, `displayVersion`, `versionCode`, `apkSizeBytes`, `sha256`, `updatedAt`, and `accessControl` if enforcing a minimum version) and regenerate `public release/SHA256SUMS.txt`.
5. Commit and push to your public repository.
