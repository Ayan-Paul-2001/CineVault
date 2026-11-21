# CineVault Android (Native Java)

Standalone native Android edition of **CineVault — All in One Movie Server**, built in **Java 17** with **Android SQLite (WAL + FTS5)**, **AndroidX Media3 ExoPlayer**, and **Jellyfin Media3 FFmpeg Audio Decoder**.

Runs directly on your Android phone or tablet over local BDIX / ISP Wi-Fi with zero PC or Node.js backend required.

---

## Architecture

- **Data Layer (`app/src/main/java/com/cinevault/app/data/`):**
  - `AppDatabase.java`: Native Android SQLite (`SQLiteOpenHelper`) with WAL mode, FTS5 full-text search, cross-server zero-duplicate highest-quality merging, Watchlist, and Watch History.
  - `H5aiService.java`, `IccService.java`, `CircleFtpService.java`: Direct parallel crawlers and delta sync clients for DhakaFlix, ICC FTP, CircleFTP, and DiscoveryFTP.
  - `MetadataService.java`: Multi-edition hydration across all 4 servers plus TVMaze, IMDb, and Wikipedia enrichment.
  - `UpdateService.java`: HTTPS-only version-control auto-update engine reading `public release/version.json` (including `accessControl` mandatory update enforcement) with GitHub Releases fallback.
  - `MediaRepository.java`: Parallel 4-server delta sync coordinator, background auto-sync scheduler, and recents-first Home feed builder.
- **UI Layer (`app/src/main/java/com/cinevault/app/ui/`):**
  - `MainActivity.java`: Edge-to-edge WindowInsets-aware shell hosting Recents-first Home (Hero Spotlight, Continue Watching, 12 category carousels), Movies and TV & Anime Browse with Collapsible Unified Filter Panel, instant FTS5 Search, My List (Recently Watched + Saved Watchlist), and the dedicated **Servers** menu bar tab (Library stats, Sync New / Full Rescan, Auto-Sync toggle & interval, live 10-node Server Health monitor, ICC FTP session setup, and Public Release Version Control updater).
  - `DetailActivity.java`: All merged server qualities with filter chips, unified Seasons/Episodes, plot/cast metadata, Play, VLC external play, Download, Copy URL, and Watchlist toggle.
  - `PlayerActivity.java`: Hardware-accelerated Media3 ExoPlayer with FFmpeg audio decoding (AC3/EAC3/DTS/TrueHD/FLAC), Dual/Multi-Audio switching, automatic full-dialogue-first subtitle selection, custom Cinema Subtitle Overlay with size and timing sync controls, quality switcher, Next Episode, and auto-resume.

---

## Security & Antivirus Scan Hardening

Designed to remain clean in Google Play Protect, VirusTotal, and OEM antivirus scanners:

1. **Minimal Permissions Only:** Requests only `android.permission.INTERNET` and `android.permission.ACCESS_NETWORK_STATE`. Omits in-app package installer permissions, external storage permissions, location, contacts, and package queries.
2. **Scoped Network Security Config:** Uses `<base-config cleartextTrafficPermitted="false">` globally (enforcing HTTPS for GitHub, IMDb, TVMaze, Wikipedia, and all public endpoints) and scopes HTTP cleartext strictly to the explicit local BDIX server allowlist in `app/src/main/res/xml/network_security_config.xml`.
3. **Hardened Manifest & Clean Packaging:** Sets `allowBackup="false"`, `fullBackupContent="false"`, Android 12+ `data_extraction_rules.xml`, exports only `MainActivity`, sets `debuggable false` and `minifyEnabled false` in release builds, stores zero hardcoded credentials (`DEFAULT_ICC_SESSION = ""`), and enforces strict URL allowlists (`ServerConfig.isAllowedUrl` and `ServerConfig.isTrustedUpdateUrl`).
4. **Safe GitHub Updates:** Checks GitHub Releases over HTTPS, verifies download URLs belong to `https://github.com/` or `https://objects.githubusercontent.com/`, shows changelog and SHA-256 checksums, and opens downloads in Android's system browser.

---

## Building Locally

### Prerequisites

- JDK 17 (Eclipse Temurin)
- Android SDK (API 35)
- Gradle 8.11.1

### Build Release APK

```bash
cd android-app
gradle testDebugUnitTest assembleRelease -PGITHUB_REPO=owner/repo
```

Compiled APK output: `android-app/app/build/outputs/apk/release/app-release.apk`.

### Release Signing Keystore

Generate a persistent release keystore once (outside Git):

```bash
keytool -genkeypair -v -keystore release.jks -keyalg RSA -keysize 2048 -validity 10000 -alias cinevault
```

Create `android-app/key.properties` (excluded from Git):

```properties
storeFile=path/to/release.jks
storePassword=YOUR_STORE_PASSWORD
keyAlias=cinevault
keyPassword=YOUR_KEY_PASSWORD
```
