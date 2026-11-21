<div align="center">

<img src="client/public/favicon.svg" alt="CineVault Logo" width="84" height="84" />

# CineVault — All in One Movie Server

**A self-hosted, multi-server movie, TV series, and anime streaming hub with automatic cross-server deduplication, highest-quality selection, instant FFmpeg playback, and streaming subtitles.**

![Node.js](https://img.shields.io/badge/Node.js-%3E%3D22.5-339933?style=flat-square&logo=nodedotjs&logoColor=white)
![React](https://img.shields.io/badge/React-19-61DAFB?style=flat-square&logo=react&logoColor=black)
![Vite](https://img.shields.io/badge/Vite-6-646CFF?style=flat-square&logo=vite&logoColor=white)
![SQLite](https://img.shields.io/badge/SQLite-FTS5%20Built--in-003B57?style=flat-square&logo=sqlite&logoColor=white)
![FFmpeg](https://img.shields.io/badge/FFmpeg-Streaming%20Engine-007808?style=flat-square&logo=ffmpeg&logoColor=white)
![Android](https://img.shields.io/badge/Android-Java%2017%20%2B%20Media3-3DDC84?style=flat-square&logo=android&logoColor=black)

</div>

---

## Overview

**CineVault** aggregates multiple BDIX and local HTTP media servers into a single, modern web interface built with **React 19**, **Vite**, **Node.js (built-in `node:sqlite` + FTS5)**, and **FFmpeg**.

Instead of browsing separate FTP portals or seeing duplicate listings across servers, CineVault indexes all configured servers into one local SQLite catalog, merges duplicate movies and multi-season TV shows automatically, displays the **highest available quality** in browse and search views, and exposes **every quality and server mirror** inside each title's detail modal for direct streaming, downloading, or external playback.

---

## Merged Source Servers

CineVault unifies four media server families out of the box (non-media categories such as Games, Software, Tutorials, Music, Comics, and E-Books are intentionally excluded):

| Server | Protocol / Interface | Indexed Content |
|---|---|---|
| **DhakaFlix** (`172.16.50.14`, `.7`, `.12`, `.10`) | h5ai JSON API | 1080p/720p/3D Movies, IMDb Top 250, Hindi, South Indian, Bangla, Animation, Foreign, TV & Web Series, K-Drama, Anime, Documentaries, Shows & Wrestling |
| **ICC FTP** (`10.16.100.244`) | Web portal & session API | 4K UHD, Exclusive Full-HD, Dual Audio, Regional Movies, Multi-Season Serials, Anime & Documentaries |
| **CircleFTP** (`new.circleftp.net`) | REST JSON API (`:5000/api`) | Movies, Dual/Multi-Audio, Hindi Dubbed, TV & Web Series, Anime, Documentaries & Shows |
| **DiscoveryFTP** (`discoveryftp.net` / `cdn1`–`cdn5`) | h5ai JSON API | Multi-quality Movies (4K + 1080p), Hindi/Bangla/South/Dubbed Web Series, Anime, Documentaries & Shows |

> **Network Requirement:** Because these are BDIX / ISP-local media servers, they must be reachable from your ISP or local network. Any upstream node that is temporarily unreachable is automatically skipped during health checks without slowing down the rest of the sync.

---

## Key Features

### Unified Zero-Duplicate Catalog
- **Highest Quality Wins:** Ranks duplicates deterministically (`4K UHD > 3D > 1080p > 720p > 480p`; `REMUX / BluRay / WEB-DL > CAMRip / HDTC`) so every movie and series appears once in Home, Browse, and Search.
- **All Qualities Inside Details:** Opening any title displays every available resolution and server mirror (including multi-file folders with both 4K and 1080p) with per-quality Play, Download, VLC export, and mid-playback source switching.
- **Unified Multi-Season TV Shows:** Combines separate season entries across servers under one show card with season tabs.

### Recents-First Discovery & Filtering
- **Newest Uploads First:** Home carousels (Hero Spotlight, Recently Added, Latest Movies, Latest TV/Series/Anime, 2026 Releases, 4K UHD, Regional & Genre sections) and library tabs prioritize the most recently uploaded files first.
- **Unified Filter Panel:** Collapsible filter bar with Section chips, Release Year, Quality, Audio (`Dual Audio`, `Multi Audio`, `Hindi Dubbed`), Language, Primary Server, and Sort order.
- **Instant Full-Text Search:** Powered by SQLite FTS5 (`/` or `Ctrl + K`), plus an optional **Deep Live All-Server Search** that queries upstream servers in real time.

### High-Speed Delta Sync Engine
- Pre-flight parallel server health checks with per-origin concurrency limits.
- Delta checkpoints (folder `mtime`, category counts, and max post IDs) allow incremental syncs to complete in seconds.
- Real-time progress updates streamed over Server-Sent Events (`/api/sync/events`).
- Configurable background auto-sync scheduler (`15 min` to `6 hours`) and live ICC session token updater in the Server & Auto-Sync drawer.

### FFmpeg Cinema Web Player
- **Automatic Stream Probing:** Inspects `.mkv`, `.mp4`, `.avi`, and `.webm` streams via `ffprobe` for codec, resolution, bit depth, audio tracks, and embedded subtitles.
- **Three Playback Engines:**
  - **Universal H.264 (Live Transcode):** Re-encodes HEVC / 10-bit / non-browser formats to H.264 + AAC Stereo with optional `1080p / 720p / 480p` downscaling.
  - **Fast Remux (Stream Copy):** Copies video untouched (`0%` video CPU) while converting Dolby AC3 / EAC3 / DTS audio to AAC.
  - **Direct Play (Raw Proxy):** Zero-CPU HTTP Range passthrough for browser-native MP4/WebM files.
- **Live Audio Switching:** Switch between Dual / Multi-Audio tracks mid-playback while preserving your timestamp.
- **Instant-Seek Streaming Subtitles:**
  - Extracts embedded MKV/MP4 text subtitles (`SRT`, `WebVTT`, `ASS`, `SSA`, `mov_text`) starting directly at your playback timestamp (`-ss` + `-copyts`) over SSE with sub-second startup.
  - Custom **Cinema Subtitle Overlay** rendered inside the player stage (works consistently across Desktop, Mobile, and Fullscreen).
  - Automatically prioritizes full dialogue tracks over Forced/Signs-only tracks, with a 5-second auto-fallback for unlabeled tracks.
  - Built-in controls for **Subtitle Size** (`S / M / L / XL`), **Timing Sync Offset** (`-2s / -0.5s / Reset / +0.5s / +2s`), and **local `.srt / .vtt / .ass` upload**.
- **External Players & Downloads:** 1-click `.m3u` playlist export for VLC, PotPlayer, or MPV and full-speed range-proxied downloads.

### Personal Library & Responsive Design
- **Watch History & Watchlist:** Persistent Continue Watching progress and saved Watchlist stored locally in SQLite, with per-item deletion and two-step Clear All controls.
- **Full-Width Adaptive Layout:** Fluid edge-to-edge grids and carousels that scale smoothly across browser zoom levels, ultrawide monitors, tablets, and mobile phones.
- **Local Network Streaming:** Binds to `0.0.0.0:3000` so any phone, tablet, or smart TV on the same Wi-Fi network can stream directly from your PC.

---

## Project Structure

```text
.
├── server.js                    # HTTP API server, SSE endpoints, static frontend host
├── package.json                 # Dependencies and scripts
├── vite.config.js               # Vite frontend build & dev proxy configuration
├── Start-Movie-Server.bat       # Windows one-click launcher
├── Stop-Movie-Server.bat        # Windows clean stopper
├── src/
│   ├── config.js                # Server definitions, category mappings, SSRF URL allowlist
│   ├── db.js                    # Node.js built-in SQLite + FTS5 schema, deduplication, queries
│   ├── indexer.js               # Parallel delta-aware sync engine and auto-sync scheduler
│   ├── h5ai.js                  # h5ai JSON API + HTML fallback client (DhakaFlix, DiscoveryFTP)
│   ├── icc.js                   # ICC FTP portal & player metadata crawler
│   ├── circleftp.js             # CircleFTP REST API crawler
│   ├── parser.js                # Filename/folder metadata parser & quality scoring
│   ├── metadata.js              # Multi-edition hydration, poster proxy, IMDb/TVMaze/Wiki enrichment
│   └── streamer.js              # FFprobe inspector, FFmpeg remux/transcode, SSE subtitle engine
├── client/
│   ├── index.html               # HTML shell and page title
│   ├── public/favicon.svg       # CineVault vector logo / favicon
│   └── src/
│       ├── App.jsx              # Main application state, routing, and views
│       ├── api.js               # API helpers and URL builders
│       ├── styles.css           # Full-width responsive theme & mobile styles
│       └── components/
│           ├── HeroSpotlight.jsx
│           ├── CarouselRow.jsx
│           ├── MediaCard.jsx
│           ├── FilterPanel.jsx
│           ├── DetailModal.jsx
│           ├── VideoPlayer.jsx
│           └── SyncDrawer.jsx
├── android-app/                 # Standalone Native Java + SQLite FTS5 + Media3 Android app
│   ├── build.gradle             # Root Gradle configuration (AGP 8.7.3)
│   ├── app/
│   │   ├── build.gradle         # Dependencies (Media3 ExoPlayer, FFmpeg audio, OkHttp, Glide)
│   │   └── src/
│   │       ├── main/
│   │       │   ├── AndroidManifest.xml          # Minimal-permission Play-Protect-safe manifest
│   │       │   ├── res/xml/network_security_config.xml  # Scoped BDIX cleartext allowlist
│   │       │   └── java/com/cinevault/app/
│   │       │       ├── data/    # SQLite FTS5 DB, 4-server crawlers, metadata & updater
│   │       │       └── ui/      # Home, Browse, Filters, My List, Servers, Detail, Player
│   │       └── test/            # JUnit tests for parser, quality scoring, updater & allowlists
└── public release/              # Version-control release manifest, signed APK & checksums
    ├── version.json             # Auto-update & accessControl version-control manifest
    ├── CineVault.apk            # Signed standalone Android release APK
    ├── SHA256SUMS.txt           # Verified SHA-256 checksum for CineVault.apk
    └── README.md                # Release publishing and auto-update workflow guide
```

---

## Android App

CineVault includes a fully standalone native Android application in [`android-app/`](android-app/README.md) built in **Java 17** with **Android SQLite (WAL + FTS5)**, **AndroidX Media3 ExoPlayer**, and the **Jellyfin Media3 FFmpeg Audio Decoder**. It connects directly to all four local BDIX media servers from your phone or tablet with no PC or Node.js server required.

### Android Capabilities
- **On-Device SQLite + FTS5 Catalog:** Native WAL-mode SQLite database with FTS5 full-text search, cross-server zero-duplicate highest-quality merging, and persistent Watchlist and Continue Watching history.
- **Native Media3 + FFmpeg Audio Engine:** Hardware-accelerated H.264/HEVC/10-bit video playback paired with FFmpeg software audio decoding for Dolby AC3, EAC3, DTS, TrueHD, and FLAC tracks inside MKV/MP4 files, plus 1-tap VLC external player fallback.
- **Smart Subtitle & Audio Controls:** Automatically selects full dialogue subtitle tracks over Forced/Signs-only tracks, with Dual/Multi-Audio track switching, custom Cinema Subtitle Overlay with live size scaling and timing sync offset, mid-playback quality/server switching, and Next Episode auto-advance.
- **Recents-First UI & Dedicated Servers Tab:** Matches the web experience with Hero Spotlight, Continue Watching, 12 recents-first carousels, Unified Collapsible Filter Panel, multi-server Detail view, and a dedicated **Servers** button in the bottom navigation bar for server health, background auto-sync scheduling, ICC session setup, and version-control updates.

### Security & Antivirus Scan Safety
The Android build is structured to pass Google Play Protect and antivirus scanners cleanly without false positives:
- **Minimal Permissions Only:** Requests only `INTERNET` and `ACCESS_NETWORK_STATE`. Omits in-app APK install permissions, external storage permissions, location, and package-query permissions.
- **Scoped Network Security Config:** Enforces HTTPS by default (`cleartextTrafficPermitted="false"`) for GitHub, IMDb, TVMaze, Wikipedia, and all public internet traffic, while restricting HTTP cleartext exclusively to the explicit local BDIX server allowlist in `android-app/app/src/main/res/xml/network_security_config.xml`.
- **Hardened Manifest & Clean Packaging:** Disables Android cloud/device backup (`allowBackup="false"`), exports only `MainActivity`, builds non-debuggable release APKs without obfuscation packers, stores zero hardcoded session credentials, and validates every playback and update URL against strict allowlists.

### Building the Android App

```bash
cd android-app
gradle testDebugUnitTest assembleRelease -PGITHUB_REPO=<owner>/<repo>
```

See [`android-app/README.md`](android-app/README.md) for keystore signing instructions and architecture details.

---

## Public Releases & Version-Control Auto-Update

Public Android releases and version-control update metadata live in the dedicated [`public release/`](public%20release/README.md) folder.

### How In-App Auto-Update Works
1. **Embedded Version-Control Manifest (`version.json`):** The public release endpoint is embedded internally in the app (hidden from the frontend UI) and checks `version.json` over HTTPS automatically in the background every **60 minutes**.
2. **3-Second Popup & Manual Check:** When a new version is published, CineVault displays a **3-second update popup** and keeps the download option available under **Servers -> App Updates**, where users can also tap **Check for Updates** manually anytime.
3. **Optional & Mandatory Updates (`accessControl`):** Supports both optional updates and mandatory locks (`forceUpdateEnabled`, `forceAppUpdate`, `minAppVersion`, `lockTitle`, `lockMessage`), handing off the verified HTTPS `CineVault.apk` download cleanly to Android's system browser.

### Publishing a New Release

1. Update `versionCode` and `versionName` in `android-app/app/build.gradle` (for example, `1.0.2`).
2. Compile the signed APK into `public release/CineVault.apk`, update `public release/version.json` (`appVersion`, `appDisplayVersion`, `appVersionCode`, `version`, `displayVersion`, `versionCode`, `sha256`, `updatedAt`, and optional `accessControl`), and update `public release/SHA256SUMS.txt`.
3. Push to your public repository — installed apps detect the update directly from `public release/version.json`. See [`public release/README.md`](public%20release/README.md) for full details.

---

## Requirements

- **Node.js `>= 22.5.0`** (uses built-in `node:sqlite`; no native compiler required)
- **FFmpeg & FFprobe** available on system `PATH` (required for MKV remuxing, HEVC transcoding, dual audio, and embedded subtitle extraction; Direct Play and VLC export work even without FFmpeg)

---

## Quick Start

### 1. Install and Build

```bash
git clone <your-repo-url>
cd cinevault
npm install
npm run build
npm start
```

Open **`http://localhost:3000`** in your browser. On first launch, CineVault automatically syncs all reachable servers and builds your local catalog in `data/cinevault.db`.

### 2. Windows One-Click Launchers

- Double-click **`Start-Movie-Server.bat`** to start the server and open CineVault in your browser.
- Double-click **`Stop-Movie-Server.bat`** to shut down the background server cleanly.

### 3. Watch on Phone, Tablet, or Smart TV

On startup, the console prints your local Wi-Fi URLs (also viewable inside the **Server & Auto-Sync** drawer):

```text
Local:    http://localhost:3000
Network:  http://192.168.x.x:3000
```

Open the `Network` URL on any device connected to the same Wi-Fi network.

### 4. Development Mode (Hot Reload)

```bash
# Terminal 1: Backend API + FFmpeg Streaming Server (port 3000)
npm run server

# Terminal 2: React Vite Dev Server (port 5173, proxies /api -> :3000)
npm run dev:client
```

---

## Configuration

Optional environment variables:

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | HTTP port for the web UI and API |
| `HOST` | `0.0.0.0` | Network interface to bind (`0.0.0.0` enables LAN access) |
| `ICC_SESSION` | *(see `src/config.js`)* | Session token for ICC FTP (can also be updated anytime from the UI drawer) |

---

## Player Keyboard Shortcuts

| Key | Action |
|---|---|
| `Space` / `K` | Play / Pause |
| `Left` / `Right` | Seek backward / forward 10 seconds |
| `J` / `L` | Seek backward / forward 30 seconds |
| `Up` / `Down` | Volume up / down |
| `M` | Mute / Unmute |
| `C` | Toggle Subtitles |
| `F` | Toggle Fullscreen |
| `Esc` | Close active menu or exit player |
| `/` or `Ctrl + K` | Focus Search (outside player) |

---

## API Endpoints

| Endpoint | Method | Purpose |
|---|---|---|
| `/api/health` | `GET` | Server node health, latency, LAN URLs, FFmpeg status, library stats |
| `/api/home` | `GET` | Curated recents-first Hero Spotlight, Continue Watching, and Home rows |
| `/api/items` | `GET` | Deduplicated search, filter, sort, and pagination |
| `/api/item/:id` | `GET` | Hydrated title details with all merged server qualities, seasons, and metadata |
| `/api/media/probe` | `GET` | `ffprobe` video, audio, and subtitle stream metadata |
| `/api/stream/play` | `GET` | Live FFmpeg `remux` or `transcode` fragmented MP4 stream |
| `/api/stream/direct` | `GET` | Zero-CPU HTTP Range passthrough proxy |
| `/api/stream/download` | `GET` | Range-proxied direct file download |
| `/api/subtitles/stream` | `GET` | Instant-seek SSE subtitle cue stream (embedded or external) |
| `/api/playlist.m3u` | `GET` | M3U playlist generator for VLC / PotPlayer / MPV |
| `/api/sync` | `POST` | Trigger `quick`, `full`, `icc`, `circle`, or `discovery` sync |
| `/api/sync/events` | `GET` | Real-time SSE sync progress stream |
| `/api/watchlist` / `/api/history` | `GET / POST / DELETE` | Watchlist and Continue Watching management |

---

## Security & Privacy

- **SSRF Protection:** All proxied streams, posters, downloads, and subtitle fetches are validated against the strict origin allowlist (`isAllowedUrl`) in `src/config.js`.
- **Local-Only State:** Watch history, watchlist, cached metadata, and SQLite database files live strictly inside `data/` (excluded via `.gitignore`).

---

## Disclaimer

CineVault does not host, store, or distribute any media files. It is a local indexing and playback interface designed to browse and stream media from servers already accessible on your own local network or ISP. Users are responsible for ensuring compliance with applicable laws and server terms of use.
