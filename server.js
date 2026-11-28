import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import zlib from "node:zlib";
import { PORT, HOST, DATA_DIR, DIST_DIR, PUBLIC_DIR, CATEGORIES, isAllowedUrl, isSafeServerUrl, normalizeServerInputUrl } from "./src/config.js";
import {
  getCatalogVersion,
  getLibraryStats,
  queryItems,
  getItemById,
  getMergedMirrors,
  runDeduplication,
  toggleWatchlist,
  getWatchlist,
  getWatchlistIds,
  removeFromWatchlist,
  clearWatchlist,
  upsertWatchProgress,
  getContinueWatching,
  getItemWatchHistory,
  removeWatchHistory,
  removeMediaWatchHistory,
  clearWatchHistory,
  getAllServers,
  getEnabledServers,
  addOrUpdateCustomServer,
  setServerEnabled,
  deleteServerAndPurgeMedia,
  resetDefaultServers,
  getServerFilterOptions,
  isMediaRowFromEnabledServer,
} from "./src/db.js";
import {
  startSync,
  getSyncStatus,
  syncEvents,
  getServersHealth,
  invalidateHealthCache,
  scheduleAutoSync,
  updateAutoSyncSettings,
} from "./src/indexer.js";
import { hydrateItem, hydrateAllEditions, enrichItemMetadata, servePoster, safeJson } from "./src/metadata.js";
import { listDirectory, searchUpstream, probeDirectoryServer } from "./src/h5ai.js";
import { searchIccUpstream, getIccSession, setIccSession } from "./src/icc.js";
import { searchCircleUpstream } from "./src/circleftp.js";
import {
  detectMediaTools,
  getMediaToolsStatus,
  probeMedia,
  proxyDirectStream,
  streamViaFfmpeg,
  streamSubtitleCues,
  serveSubtitleVtt,
  buildM3uPlaylist,
} from "./src/streamer.js";

const STATIC_MIMES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".webp": "image/webp",
};

const STATIC_CACHE = new Map();

function sendJson(res, data, status = 200) {
  const raw = Buffer.from(JSON.stringify(data), "utf8");
  const acceptEnc = String(res.req?.headers?.["accept-encoding"] || "");
  if (raw.length >= 1024 && acceptEnc.includes("gzip")) {
    const gz = zlib.gzipSync(raw, { level: 4 });
    res.writeHead(status, {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Encoding": "gzip",
      "Content-Length": gz.length,
      "Cache-Control": "private, no-store",
      Vary: "Accept-Encoding, X-CineVault-Device-Id",
    });
    res.end(gz);
    return;
  }
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": raw.length,
    "Cache-Control": "private, no-store",
    Vary: "Accept-Encoding, X-CineVault-Device-Id",
  });
  res.end(raw);
}

async function readJsonBody(req) {
  const chunks = [];
  let len = 0;
  for await (const chunk of req) {
    len += chunk.length;
    if (len > 1024 * 1024) throw new Error("Payload too large");
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : {};
}

function getLanAddresses() {
  const nets = os.networkInterfaces();
  const addrs = [];
  for (const list of Object.values(nets)) {
    for (const net of list || []) {
      if (net.family === "IPv4" && !net.internal) {
        addrs.push(net.address);
      }
    }
  }
  return addrs;
}

let cachedHome = null;
let cachedHomeAt = 0;
let cachedHomeVersion = -1;

function invalidateHomeCache() {
  cachedHome = null;
  cachedHomeVersion = -1;
}

function getRequestDeviceId(req) {
  const raw = String(req.headers["x-cinevault-device-id"] || "").trim();
  return /^[a-zA-Z0-9_-]{8,64}$/.test(raw) ? raw : "default";
}

function buildHomePayload(deviceId = "default") {
  const ver = getCatalogVersion();
  let shared = cachedHome;
  if (!shared || cachedHomeVersion !== ver || Date.now() - cachedHomeAt >= 300000) {
    const HOME_ROW_LIMIT = 20;
    const recentlyAdded = queryItems({ sort: "recent", limit: HOME_ROW_LIMIT, skipCount: true }).items;
    const latestMovies = queryItems({ mediaType: "movie", sort: "recent", limit: HOME_ROW_LIMIT, skipCount: true }).items;
    const latestSeries = queryItems({ mediaType: "series", sort: "recent", limit: HOME_ROW_LIMIT, skipCount: true }).items;
    const latest2026 = queryItems({ year: 2026, mediaType: "movie", sort: "recent", limit: HOME_ROW_LIMIT, skipCount: true }).items;
    const uhd4k = queryItems({ category: "4k-movies", sort: "recent", limit: HOME_ROW_LIMIT, skipCount: true }).items;
    const hindi = queryItems({ category: "hindi", sort: "recent", limit: HOME_ROW_LIMIT, skipCount: true }).items;
    const southIndian = queryItems({ category: "south-indian,south-dubbed", sort: "recent", limit: HOME_ROW_LIMIT, skipCount: true }).items;
    const koreanSeries = queryItems({ category: "korean-series", sort: "recent", limit: HOME_ROW_LIMIT, skipCount: true }).items;
    const anime = queryItems({ category: "anime", sort: "recent", limit: HOME_ROW_LIMIT, skipCount: true }).items;
    const animation = queryItems({ category: "animation-1080p,animation", sort: "recent", limit: HOME_ROW_LIMIT, skipCount: true }).items;
    const documentary = queryItems({ category: "documentary", sort: "recent", limit: HOME_ROW_LIMIT, skipCount: true }).items;
    const imdbTop250 = queryItems({ category: "imdb-top-250", sort: "imdb", limit: HOME_ROW_LIMIT, skipCount: true }).items;

    const heroPool = [
      ...latest2026.filter((i) => i.quality === "4K" || i.quality === "1080p").slice(0, 3),
      ...recentlyAdded.filter((i) => i.quality === "4K" || i.quality === "1080p").slice(0, 3),
      ...latestSeries.slice(0, 2),
      ...uhd4k.slice(0, 2),
    ];
    const heroSeen = new Set();
    const hero = [];
    for (const h of heroPool) {
      if (!heroSeen.has(h.id)) {
        heroSeen.add(h.id);
        hero.push(h);
      }
      if (hero.length >= 6) break;
    }

    shared = {
      hero,
      sections: [
        { id: "recent", title: "Recently Added Across All Servers", subtitle: "Newest movies & series uploaded across all servers", filter: { sort: "recent" }, items: recentlyAdded },
        { id: "latest-movies", title: "Latest Movies", subtitle: "Most recently uploaded movies in highest available quality", filter: { sort: "recent" }, items: latestMovies },
        { id: "tv-series", title: "Latest TV, Web Series & Anime", subtitle: "Most recently updated series & episodes across all servers", filter: { sort: "recent" }, items: latestSeries },
        { id: "latest-2026", title: "2026 New Releases", subtitle: "Newest 2026 releases sorted by latest uploads", filter: { year: 2026, sort: "recent" }, items: latest2026 },
        { id: "4k-movies", title: "4K Ultra HD Collection", subtitle: "Latest 2160p UHD cinema (deduplicated)", filter: { category: "4k-movies", sort: "recent" }, items: uhd4k },
        { id: "hindi", title: "Bollywood & Hindi Cinema", subtitle: "Latest Hindi uploads first", filter: { category: "hindi", sort: "recent" }, items: hindi },
        { id: "south", title: "South Indian Blockbusters", subtitle: "Latest Tamil, Telugu, Malayalam & Hindi Dubbed", filter: { category: "south-indian,south-dubbed", sort: "recent" }, items: southIndian },
        { id: "korean-series", title: "Korean TV & Web Series", subtitle: "Latest K-Dramas & originals", filter: { category: "korean-series", sort: "recent" }, items: koreanSeries },
        { id: "anime", title: "Anime & Cartoon Series", subtitle: "Latest Dual & Multi-Audio series", filter: { category: "anime", sort: "recent" }, items: anime },
        { id: "animation", title: "Animation Movies", subtitle: "Latest 4K & 1080p animated features", filter: { category: "animation-1080p,animation", sort: "recent" }, items: animation },
        { id: "documentary", title: "Documentaries", subtitle: "Latest real-world stories & specials", filter: { category: "documentary", sort: "recent" }, items: documentary },
        { id: "imdb-top-250", title: "IMDb Top 250 Masterpieces", subtitle: "Best available quality (4K / 1080p)", filter: { category: "imdb-top-250", sort: "imdb" }, items: imdbTop250 },
      ].filter((s) => s.items.length > 0),
      stats: getLibraryStats(),
    };
    cachedHome = shared;
    cachedHomeVersion = ver;
    cachedHomeAt = Date.now();
  }

  // Per-device private Watchlist flags & Continue Watching history
  const deviceWlIds = getWatchlistIds(deviceId);
  const hasWl = deviceWlIds.size > 0;
  const mapWl = (item) => (hasWl && deviceWlIds.has(item.id) ? { ...item, in_watchlist: 1 } : item);

  return {
    hero: hasWl ? shared.hero.map(mapWl) : shared.hero,
    continueWatching: getContinueWatching(24, deviceId),
    sections: hasWl ? shared.sections.map((s) => ({ ...s, items: s.items.map(mapWl) })) : shared.sections,
    stats: shared.stats,
    sync: getSyncStatus(),
  };
}

const server = http.createServer(async (req, res) => {
  try {
    const reqUrl = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    const pathname = reqUrl.pathname;
    const method = req.method || "GET";

    // --- API ROUTES ---
    if (pathname.startsWith("/api/")) {
      // 1. Health & Network Info
      if (pathname === "/api/health" && method === "GET") {
        const force = reqUrl.searchParams.get("force") === "1";
        const servers = await getServersHealth(force);
        return sendJson(res, {
          ok: true,
          port: PORT,
          lanUrls: getLanAddresses().map((ip) => `http://${ip}:${PORT}`),
          tools: getMediaToolsStatus(),
          stats: getLibraryStats(),
          sync: getSyncStatus(),
          iccSessionPreview: getIccSession().slice(0, 12) + "…",
          servers,
        });
      }

      // 2. Categories with counts, years, languages & dynamic active servers
      if (pathname === "/api/categories" && method === "GET") {
        const stats = getLibraryStats();
        return sendJson(res, {
          categories: CATEGORIES.map((c) => ({
            ...c,
            count: stats.byCategory[c.id] || 0,
          })),
          years: stats.years,
          languages: stats.languages || [],
          servers: getServerFilterOptions(),
          stats,
        });
      }

      // 2b. Dynamic Server Manager CRUD (List / Probe / Add / Toggle / Delete / Reset Defaults)
      if (pathname === "/api/servers" && method === "GET") {
        const force = reqUrl.searchParams.get("force") === "1";
        const servers = await getServersHealth(force);
        return sendJson(res, { servers, serverFilters: getServerFilterOptions() });
      }
      if (pathname === "/api/servers/probe" && method === "POST") {
        const body = await readJsonBody(req).catch(() => ({}));
        const rawUrl = normalizeServerInputUrl(body.url);
        if (!isSafeServerUrl(rawUrl)) {
          return sendJson(res, { error: "Please enter a valid FTP server URL (loopback addresses blocked)." }, 400);
        }
        try {
          const probe = await probeDirectoryServer(rawUrl, 8500);
          return sendJson(res, probe);
        } catch (err) {
          return sendJson(res, { error: err.message || "Could not reach server" }, 502);
        }
      }
      if (pathname === "/api/servers" && method === "POST") {
        const body = await readJsonBody(req).catch(() => ({}));
        try {
          let targetUrl = normalizeServerInputUrl(body.url);
          if (!isSafeServerUrl(targetUrl)) {
            return sendJson(res, { error: "Please enter a valid FTP server URL (loopback addresses blocked)." }, 400);
          }
          let adapter = ["icc", "circleftp", "directory"].includes(body.adapter) ? body.adapter : "directory";
          let folders = Array.isArray(body.folders) ? body.folders : [];
          let resolvedName = body.name;
          let resolvedRootHref = null;
          // Fully automatic detection of protocol (ICC / CircleFTP / h5ai / Apache / Nginx / Portal) & ALL compatible folders!
          if ((folders.length === 0 || body.adapter === "auto" || !body.adapter) && body.autoDiscover !== false) {
            try {
              const probe = await probeDirectoryServer(targetUrl, 8000);
              if (probe?.ok) {
                if (probe.detectedAdapter) adapter = probe.detectedAdapter;
                if (probe.origin) targetUrl = probe.origin + (probe.rootHref || "/");
                if (probe.rootHref) resolvedRootHref = probe.rootHref;
                if (!resolvedName && probe.suggestedName) resolvedName = probe.suggestedName;
                if (Array.isArray(probe.folders) && probe.folders.length > 0) {
                  folders = probe.folders.filter((f) => f.selected !== false);
                }
              }
            } catch {}
          }
          const created = addOrUpdateCustomServer({
            id: body.id || null,
            name: resolvedName,
            url: targetUrl,
            adapter,
            folders,
            rootHrefOverride: resolvedRootHref,
          });
          invalidateHealthCache();
          invalidateHomeCache();
          let syncRes = null;
          if (body.syncNow !== false) {
            syncRes = await startSync("full", created.id);
          }
          return sendJson(res, { ok: true, server: created, sync: syncRes, servers: getAllServers(), stats: getLibraryStats(true) });
        } catch (err) {
          return sendJson(res, { error: err.message || "Failed to save server" }, 400);
        }
      }
      if (pathname === "/api/servers/reset" && method === "POST") {
        const servers = resetDefaultServers();
        invalidateHealthCache();
        invalidateHomeCache();
        return sendJson(res, { ok: true, servers, stats: getLibraryStats(true) });
      }
      const srvToggleMatch = pathname.match(/^\/api\/servers\/([^/]+)\/toggle$/);
      if (srvToggleMatch && method === "POST") {
        const id = decodeURIComponent(srvToggleMatch[1]);
        const body = await readJsonBody(req).catch(() => ({}));
        try {
          const updated = setServerEnabled(id, Boolean(body.enabled));
          invalidateHealthCache();
          invalidateHomeCache();
          return sendJson(res, { ok: true, server: updated, servers: getAllServers(), stats: getLibraryStats(true) });
        } catch (err) {
          return sendJson(res, { error: err.message }, 404);
        }
      }
      const srvDeleteMatch = pathname.match(/^\/api\/servers\/([^/]+)$/);
      if (srvDeleteMatch && method === "DELETE") {
        const id = decodeURIComponent(srvDeleteMatch[1]);
        try {
          const result = deleteServerAndPurgeMedia(id);
          invalidateHealthCache();
          invalidateHomeCache();
          return sendJson(res, {
            ok: true,
            deletedRows: result.deletedRows,
            servers: getAllServers(),
            stats: getLibraryStats(true),
          });
        } catch (err) {
          return sendJson(res, { error: err.message }, 404);
        }
      }

      // 3. Home curated feed (per-device private Continue Watching & Watchlist)
      const deviceId = getRequestDeviceId(req);
      if (pathname === "/api/home" && method === "GET") {
        return sendJson(res, buildHomePayload(deviceId));
      }

      // 4. Browse / Search / Filter (100% deduplicated highest-quality catalog)
      if (pathname === "/api/items" && method === "GET") {
        const p = reqUrl.searchParams;
        const result = queryItems({
          q: p.get("q") || "",
          category: p.get("category") || "",
          group: p.get("group") || "",
          mediaType: p.get("type") || "",
          year: p.get("year") || "",
          quality: p.get("quality") || "",
          audio: p.get("audio") || "",
          language: p.get("language") || "",
          source: p.get("source") || "",
          sort: p.get("sort") || (p.get("q") ? "relevance" : "recent"),
          page: p.get("page") || 1,
          limit: p.get("limit") || 36,
          deviceId,
        });
        return sendJson(res, result);
      }

      // 5. Live upstream search across enabled servers
      if (pathname === "/api/search/upstream" && method === "GET") {
        const q = (reqUrl.searchParams.get("q") || "").trim();
        if (q.length < 2) return sendJson(res, { items: [] });
        const enabled = getEnabledServers();
        const h5aiServers = enabled.filter((s) => s.adapter === "dhakaflix" || s.adapter === "discoveryftp" || s.adapter === "directory");
        const hasIcc = enabled.some((s) => s.adapter === "icc");
        const hasCircle = enabled.some((s) => s.adapter === "circleftp");
        const [h5aiBatches, iccResults, circleResults] = await Promise.all([
          Promise.all(h5aiServers.map((s) => searchUpstream(s.origin, s.rootHref, q, 6000).catch(() => []))),
          hasIcc ? searchIccUpstream(q, 6000).catch(() => []) : Promise.resolve([]),
          hasCircle ? searchCircleUpstream(q, 6000).catch(() => []) : Promise.resolve([]),
        ]);
        const combined = [...circleResults, ...iccResults, ...h5aiBatches.flat()].slice(0, 100);
        return sendJson(res, { items: combined });
      }

      // 6. Single Item Detail (hydrates ALL merged server qualities/editions + seasons + metadata!)
      const itemMatch = pathname.match(/^\/api\/item\/(\d+)$/);
      if (itemMatch && method === "GET") {
        const id = Number(itemMatch[1]);
        const force = reqUrl.searchParams.get("refresh") === "1";
        const enrich = reqUrl.searchParams.get("enrich") !== "0";
        let item = await hydrateItem(id, { deep: true, force });
        if (!item || !isMediaRowFromEnabledServer(item)) {
          return sendJson(res, { error: "Item unavailable (server disabled or removed)" }, 404);
        }

        const mirrors = getMergedMirrors(item);
        const [editions, enrichedMeta] = await Promise.all([
          hydrateAllEditions(item, mirrors, { force }),
          (async () => {
            const existing = safeJson(item.meta_json, null);
            if (enrich && (!item.meta_checked || !existing?.overview)) {
              return enrichItemMetadata(item);
            }
            return existing || {};
          })(),
        ]);

        item = getItemById(id);
        const files = safeJson(item.files_json, []);
        const seasons = safeJson(item.seasons_json, []);
        const history = getItemWatchHistory(id, deviceId);
        const wl = getWatchlistIds(deviceId).has(item.canonical_id || id);

        // If primary edition lacked ICC plot/director/trailer but one of the merged ICC editions has it, pull it in!
        let mergedMeta = { ...(enrichedMeta || {}) };
        if (!mergedMeta.overview || !mergedMeta.trailerUrl) {
          for (const ed of editions) {
            if (ed.id === id) continue;
            const edRow = getItemById(ed.id);
            const edMeta = safeJson(edRow?.meta_json, null);
            if (edMeta) {
              if (!mergedMeta.overview && edMeta.overview) mergedMeta.overview = edMeta.overview;
              if (!mergedMeta.director && edMeta.director) mergedMeta.director = edMeta.director;
              if (!mergedMeta.cast && edMeta.cast) mergedMeta.cast = edMeta.cast;
              if (!mergedMeta.trailerUrl && edMeta.trailerUrl) mergedMeta.trailerUrl = edMeta.trailerUrl;
              if ((!mergedMeta.genres || mergedMeta.genres.length === 0) && edMeta.genres?.length) {
                mergedMeta.genres = edMeta.genres;
              }
            }
          }
        }

        return sendJson(res, {
          item: {
            id: item.id,
            url: item.url,
            origin: item.origin,
            href: item.href,
            source: item.source,
            category: item.category,
            media_type: item.media_type,
            sub_group: item.sub_group,
            raw_name: item.raw_name,
            title: item.title,
            year: item.year,
            quality: item.quality,
            audio_tags: item.audio_tags,
            source_tag: item.source_tag,
            language_tag: item.language_tag,
            imdb_rank: item.imdb_rank,
            modified_at: item.modified_at,
            total_size: item.total_size,
            quality_score: item.quality_score,
            in_watchlist: wl ? 1 : 0,
          },
          files,
          seasons,
          editions,
          siblings: mirrors,
          history,
          meta: mergedMeta,
        });
      }

      // 7. Poster proxy (DhakaFlix + ICC FTP + external fallback + SVG)
      const posterMatch = pathname.match(/^\/api\/poster\/(\d+)$/);
      if (posterMatch && method === "GET") {
        return await servePoster(Number(posterMatch[1]), res);
      }

      // 8. Media Probe (FFprobe audio/video/subtitle streams)
      if (pathname === "/api/media/probe" && method === "GET") {
        const url = reqUrl.searchParams.get("url");
        if (!url || !isAllowedUrl(url)) return sendJson(res, { error: "Invalid media URL" }, 400);
        try {
          const info = await probeMedia(url);
          return sendJson(res, info);
        } catch (err) {
          return sendJson(res, { error: err.message, ffmpegAvailable: getMediaToolsStatus().ffmpeg }, 500);
        }
      }

      // 9. Direct Stream Proxy (Range support)
      if (pathname === "/api/stream/direct" && (method === "GET" || method === "HEAD")) {
        const url = reqUrl.searchParams.get("url");
        return await proxyDirectStream(url, req, res, { download: false });
      }

      // 10. Direct Download Proxy (Full BDIX Speed)
      if (pathname === "/api/stream/download" && method === "GET") {
        const url = reqUrl.searchParams.get("url");
        return await proxyDirectStream(url, req, res, { download: true });
      }

      // 11. Smart FFmpeg Transmux / Transcode Stream
      if (pathname === "/api/stream/play" && method === "GET") {
        const url = reqUrl.searchParams.get("url");
        return streamViaFfmpeg(
          url,
          {
            mode: reqUrl.searchParams.get("mode") || "transcode",
            start: reqUrl.searchParams.get("start") || "0",
            audio: reqUrl.searchParams.get("audio") || "0",
            quality: reqUrl.searchParams.get("quality") || "original",
          },
          req,
          res
        );
      }

      // 12. Streaming Subtitles (Instant-Seek SSE Cues) & Legacy WebVTT Endpoint
      if (pathname === "/api/subtitles/stream" && method === "GET") {
        return await streamSubtitleCues(
          {
            url: reqUrl.searchParams.get("url"),
            streamIndex: reqUrl.searchParams.get("stream") ?? undefined,
            externalUrl: reqUrl.searchParams.get("external") ?? undefined,
            start: reqUrl.searchParams.get("start") || "0",
          },
          req,
          res
        );
      }
      if (pathname === "/api/subtitles" && method === "GET") {
        return await serveSubtitleVtt(
          {
            url: reqUrl.searchParams.get("url"),
            streamIndex: reqUrl.searchParams.get("stream") ?? undefined,
            externalUrl: reqUrl.searchParams.get("external") ?? undefined,
            offset: reqUrl.searchParams.get("offset") || "0",
          },
          res
        );
      }

      // 13. M3U Playlist generator for VLC / PotPlayer / MPV
      if (pathname === "/api/playlist.m3u" && method === "GET") {
        const singleUrl = reqUrl.searchParams.get("url");
        const title = reqUrl.searchParams.get("title") || "CineVault Stream";
        const itemId = reqUrl.searchParams.get("id");
        let entries = [];

        if (singleUrl && isAllowedUrl(singleUrl)) {
          entries = [{ title, url: singleUrl }];
        } else if (itemId) {
          const item = await hydrateItem(Number(itemId), { deep: true });
          if (item) {
            const files = safeJson(item.files_json, []).filter((f) => f.kind === "video");
            const seasons = safeJson(item.seasons_json, []);
            for (const f of files) entries.push({ title: `${item.title} - ${f.name}`, url: f.url });
            for (const s of seasons) {
              for (const ep of s.episodes || []) {
                entries.push({ title: `${item.title} ${s.name} - ${ep.label} ${ep.episodeTitle || ""}`.trim(), url: ep.url });
              }
            }
          }
        }

        if (entries.length === 0) {
          res.writeHead(404);
          res.end("No playable files");
          return;
        }
        const m3u = buildM3uPlaylist(entries);
        const safeFile = title.replace(/[^a-z0-9._ -]/gi, "_").slice(0, 60) || "playlist";
        res.writeHead(200, {
          "Content-Type": "audio/x-mpegurl; charset=utf-8",
          "Content-Disposition": `attachment; filename="${safeFile}.m3u"`,
        });
        res.end(m3u);
        return;
      }

      // 14. Live Raw Server Directory Explorer
      if (pathname === "/api/explorer" && method === "GET") {
        const origin = reqUrl.searchParams.get("origin");
        const href = reqUrl.searchParams.get("href");
        if (!origin || !href) {
          return sendJson(res, {
            servers: getEnabledServers().filter(
              (s) => s.adapter === "dhakaflix" || s.adapter === "discoveryftp" || s.adapter === "directory"
            ),
          });
        }
        if (!isAllowedUrl(origin + "/")) {
          return sendJson(res, { error: "Origin not allowed" }, 403);
        }
        try {
          const entries = await listDirectory(origin, href, 10000);
          entries.sort((a, b) => {
            if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
            return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });
          });
          return sendJson(res, { origin, href, entries });
        } catch (err) {
          return sendJson(res, { error: err.message, entries: [] }, 502);
        }
      }

      // 15. Per-Device Watchlist
      if (pathname === "/api/watchlist" && method === "GET") {
        return sendJson(res, { items: getWatchlist(deviceId) });
      }
      if (pathname === "/api/watchlist" && method === "DELETE") {
        clearWatchlist(deviceId);
        return sendJson(res, { ok: true });
      }
      const wlMatch = pathname.match(/^\/api\/watchlist\/(\d+)$/);
      if (wlMatch && method === "POST") {
        return sendJson(res, toggleWatchlist(Number(wlMatch[1]), deviceId));
      }
      if (wlMatch && method === "DELETE") {
        removeFromWatchlist(Number(wlMatch[1]), deviceId);
        return sendJson(res, { ok: true, inWatchlist: false });
      }

      // 16. Per-Device Watch Progress / Continue Watching
      if (pathname === "/api/history" && method === "GET") {
        return sendJson(res, { items: getContinueWatching(40, deviceId) });
      }
      if (pathname === "/api/history" && method === "DELETE") {
        const all = reqUrl.searchParams.get("all");
        const mediaId = reqUrl.searchParams.get("mediaId");
        const fileUrl = reqUrl.searchParams.get("fileUrl");
        if (all === "1" || (!mediaId && !fileUrl)) {
          clearWatchHistory(deviceId);
        } else if (mediaId) {
          removeMediaWatchHistory(Number(mediaId), deviceId);
        } else if (fileUrl) {
          removeWatchHistory(fileUrl, deviceId);
        }
        return sendJson(res, { ok: true });
      }
      if (pathname === "/api/progress" && method === "POST") {
        const body = await readJsonBody(req);
        if (!body.mediaId || !body.fileUrl) return sendJson(res, { error: "Missing fields" }, 400);
        return sendJson(res, upsertWatchProgress({ ...body, deviceId }));
      }

      // 17. Sync Controls, ICC Session Updater, Auto-Sync Settings & SSE Progress Stream
      if (pathname === "/api/sync/status" && method === "GET") {
        return sendJson(res, { sync: getSyncStatus(), stats: getLibraryStats() });
      }
      if (pathname === "/api/sync/settings" && method === "POST") {
        const body = await readJsonBody(req).catch(() => ({}));
        return sendJson(res, { sync: updateAutoSyncSettings(body) });
      }
      if (pathname === "/api/sync/icc-session" && method === "POST") {
        const body = await readJsonBody(req).catch(() => ({}));
        try {
          const token = setIccSession(body.session);
          return sendJson(res, { ok: true, iccSessionPreview: token.slice(0, 12) + "…" });
        } catch (err) {
          return sendJson(res, { error: err.message }, 400);
        }
      }
      if (pathname === "/api/sync" && method === "POST") {
        const body = await readJsonBody(req).catch(() => ({}));
        const mode = ["quick", "full", "icc", "circle", "discovery", "custom"].includes(body.mode) ? body.mode : "full";
        const targetId = body.serverId ? String(body.serverId) : null;
        return sendJson(res, await startSync(mode, targetId));
      }
      if (pathname === "/api/sync/events" && method === "GET") {
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });
        const sendEvent = (type, payload) => {
          res.write(`event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`);
        };
        sendEvent("status", { sync: getSyncStatus(), stats: getLibraryStats(false, 10000) });

        const onProgress = (st) => sendEvent("progress", { sync: st, stats: getLibraryStats(false, 10000) });
        const onDone = (st) => {
          invalidateHomeCache();
          sendEvent("done", { sync: st, stats: getLibraryStats(true) });
        };
        syncEvents.on("start", onProgress);
        syncEvents.on("progress", onProgress);
        syncEvents.on("done", onDone);

        const ping = setInterval(() => res.write(": keepalive\n\n"), 20000);
        req.on("close", () => {
          clearInterval(ping);
          syncEvents.off("start", onProgress);
          syncEvents.off("progress", onProgress);
          syncEvents.off("done", onDone);
        });
        return;
      }

      return sendJson(res, { error: "Unknown API route" }, 404);
    }

    // --- STATIC REACT APP (serves built Vite dist/ with SPA fallback) ---
    const staticRoot = fs.existsSync(path.join(DIST_DIR, "index.html")) ? DIST_DIR : PUBLIC_DIR;
    const relPath = pathname === "/" ? "/index.html" : pathname === "/favicon.ico" ? "/favicon.svg" : pathname;
    const safeRel = path.normalize(relPath).replace(/^(\.\.[/\\])+/, "");
    let filePath = path.join(staticRoot, safeRel);

    if (!filePath.startsWith(staticRoot)) {
      res.writeHead(403);
      res.end("Forbidden");
      return;
    }

    if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
      filePath = path.join(staticRoot, "index.html");
    }

    const ext = path.extname(filePath).toLowerCase();
    const isHashedAsset = safeRel.includes("assets");
    let cachedStatic = STATIC_CACHE.get(filePath);
    if (!cachedStatic || !isHashedAsset) {
      const stat = fs.statSync(filePath);
      if (!cachedStatic || cachedStatic.mtimeMs !== stat.mtimeMs) {
        const raw = fs.readFileSync(filePath);
        const compressible = ext === ".html" || ext === ".js" || ext === ".css" || ext === ".svg" || ext === ".json";
        const gz = compressible && raw.length >= 1024 ? zlib.gzipSync(raw, { level: 6 }) : null;
        cachedStatic = { mtimeMs: stat.mtimeMs, raw, gz };
        STATIC_CACHE.set(filePath, cachedStatic);
      }
    }
    const acceptEnc = String(req.headers["accept-encoding"] || "");
    const useGzip = Boolean(cachedStatic.gz && acceptEnc.includes("gzip"));
    const body = useGzip ? cachedStatic.gz : cachedStatic.raw;
    const headers = {
      "Content-Type": STATIC_MIMES[ext] || "application/octet-stream",
      "Content-Length": body.length,
      "Cache-Control": isHashedAsset ? "public, max-age=31536000, immutable" : "no-cache",
      Vary: "Accept-Encoding",
    };
    if (useGzip) headers["Content-Encoding"] = "gzip";
    res.writeHead(200, headers);
    res.end(body);
  } catch (err) {
    console.error("[server] Error:", err);
    if (!res.headersSent) {
      sendJson(res, { error: err.message || "Internal server error" }, 500);
    }
  }
});

// Boot sequence
const PID_FILE = path.join(DATA_DIR, "server.pid");
const cleanupPid = () => {
  try {
    if (fs.existsSync(PID_FILE) && fs.readFileSync(PID_FILE, "utf8").trim() === String(process.pid)) {
      fs.unlinkSync(PID_FILE);
    }
  } catch {}
};

process.on("SIGINT", () => {
  cleanupPid();
  process.exit(0);
});
process.on("SIGTERM", () => {
  cleanupPid();
  process.exit(0);
});
process.on("exit", cleanupPid);

const tools = await detectMediaTools();
server.keepAliveTimeout = 65000;
server.headersTimeout = 66000;
server.listen(PORT, HOST, () => {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(PID_FILE, String(process.pid), "utf8");
  } catch {}

  // Ensure existing catalog is deduplicated on boot (zero duplicates guaranteed!)
  let stats = getLibraryStats();
  if (stats.totalRaw > 0 && stats.duplicatesMerged === 0) {
    runDeduplication();
    stats = getLibraryStats();
  }

  const lanUrls = getLanAddresses().map((ip) => `http://${ip}:${PORT}`);

  console.log("");
  console.log("  ╔══════════════════════════════════════════════════════════╗");
  console.log("  ║           CINEVAULT — All in One Movie Server            ║");
  console.log("  ║  DhakaFlix + ICC + CircleFTP + DiscoveryFTP • Merged HD  ║");
  console.log("  ╚══════════════════════════════════════════════════════════╝");
  console.log(`  Local:    http://localhost:${PORT}`);
  for (const u of lanUrls) console.log(`  Network:  ${u}  (watch on Phone / TV / Tablet!)`);
  console.log(`  FFmpeg:   ${tools.ffmpeg ? "Enabled (Smart Audio/HEVC/Subtitle Engine)" : "Not found (Direct Play & VLC mode)"}`);
  console.log(`  Library:  ${stats.total} unique titles (${stats.movies} movies, ${stats.series} series | ${stats.duplicatesMerged} lower-quality duplicates merged)`);
  console.log("");

  scheduleAutoSync();

  const lastSync = Number(stats.lastSync || 0);
  const enabledList = getEnabledServers();
  const hasEnabledIcc = enabledList.some((s) => s.adapter === "icc");
  const hasEnabledCircle = enabledList.some((s) => s.adapter === "circleftp");
  const hasEnabledDisc = enabledList.some((s) => s.adapter === "discoveryftp");
  const hasIcc = (stats.bySource?.icc || 0) > 0;
  const hasCircle = (stats.bySource?.circleftp || 0) > 0;
  const hasDiscovery = (stats.bySource?.discoveryftp || 0) > 0;
  if (stats.total === 0 && enabledList.length > 0) {
    console.log("  [indexer] First launch detected — starting full multi-server sync...");
    startSync("full");
  } else if (hasEnabledDisc && !hasDiscovery) {
    console.log("  [indexer] DiscoveryFTP enabled — syncing DiscoveryFTP & merging highest quality...");
    startSync("discovery");
  } else if (hasEnabledCircle && !hasCircle) {
    console.log("  [indexer] CircleFTP enabled — syncing CircleFTP & merging highest quality...");
    startSync("circle");
  } else if (hasEnabledIcc && !hasIcc) {
    console.log("  [indexer] ICC FTP server enabled — syncing ICC FTP & merging highest quality...");
    startSync("icc");
  } else if (enabledList.length > 0 && Date.now() - lastSync > 1000 * 60 * 60) {
    console.log("  [indexer] Running quick incremental sync for newly uploaded files...");
    startSync("quick");
  }
});
