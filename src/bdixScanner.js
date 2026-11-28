import { EventEmitter } from "node:events";
import { SERVERS, isSafeServerUrl, normalizeServerInputUrl } from "./config.js";
import { probeDirectoryServer, mapWithConcurrency } from "./h5ai.js";
import { checkIccHealth } from "./icc.js";
import { checkCircleHealth } from "./circleftp.js";
import {
  getAllServers,
  addOrUpdateCustomServer,
  setServerEnabled,
  updateServersOnlineStatus,
  getLibraryStats,
} from "./db.js";
import { startSync, invalidateHealthCache, getServersHealth } from "./indexer.js";

export const BDIX_DIRECTORY_URL = "https://bdix.link/test/server";
export const bdixScanEvents = new EventEmitter();
bdixScanEvents.setMaxListeners(40);

// Clean curated fallback catalog used only if https://bdix.link/test/server itself is temporarily unreachable
const FALLBACK_BDIX_SITES = [
  { title: "DhakaFlix 14", category: "FTP", url: "http://172.16.50.14" },
  { title: "DhakaFlix 7", category: "FTP", url: "http://172.16.50.7" },
  { title: "DhakaFlix 12", category: "FTP", url: "http://172.16.50.12" },
  { title: "DhakaFlix 10", category: "FTP", url: "http://172.16.50.10" },
  { title: "ICC FTP", category: "Video", url: "http://10.16.100.244" },
  { title: "CircleFTP", category: "Video", url: "http://new.circleftp.net" },
  { title: "DiscoveryFTP CDN-1", category: "FTP", url: "https://cdn1.discoveryftp.net/Movies/" },
  { title: "DiscoveryFTP CDN-2", category: "FTP", url: "https://cdn2.discoveryftp.net/" },
  { title: "Sam Online", category: "FTP", url: "https://samftp.com" },
  { title: "FTPBD", category: "FTP", url: "http://ftpbd.net" },
  { title: "Free Media BD", category: "FTP", url: "http://www.freemediabd.com" },
  { title: "Movie Bazar", category: "FTP", url: "http://moviebazar.net" },
  { title: "Plex BD", category: "FTP", url: "http://203.96.191.70" },
  { title: "BossBD FTP", category: "FTP", url: "http://cdn1.bossbd.net" },
  { title: "FILE EBOX", category: "FTP", url: "http://fileserver.ebox.live" },
  { title: "FS Ebox Live", category: "FTP", url: "http://fs.ebox.live" },
  { title: "CTG Fun Media", category: "FTP", url: "http://media.ctgfun.com/media" },
  { title: "Carnival FTP", category: "FTP", url: "http://nagordola.com.bd" },
  { title: "Media FTP", category: "FTP", url: "http://10.1.1.1/Data" },
  { title: "Surzo Mama", category: "FTP", url: "http://103.85.235.254" },
];

const scanState = {
  running: false,
  phase: "idle", // "idle" | "fetching" | "testing" | "probing" | "syncing" | "done" | "error"
  sourceLabel: BDIX_DIRECTORY_URL,
  total: 0,
  tested: 0,
  openCount: 0,
  syncableCount: 0,
  addedCount: 0,
  startedAt: 0,
  finishedAt: 0,
  message: "",
  error: null,
  results: [], // [{ title, category, url, origin, open, latencyMs, status, syncable, adapter, folderCount, serverId }]
};

export function getBdixScanStatus() {
  return {
    ...scanState,
    percent: scanState.total > 0 ? Math.min(100, Math.round((scanState.tested / scanState.total) * 100)) : 0,
  };
}

function emitScanUpdate() {
  bdixScanEvents.emit("update", getBdixScanStatus());
}

/**
 * Fetch the live BDIX server list from https://bdix.link/test/server (FTP & Video servers only),
 * merged cleanly with CineVault's known high-speed BDIX nodes without duplicates.
 */
export async function fetchBdixDirectorySites(timeoutMs = 9000) {
  let rawSites = [];
  let fetchedLive = false;
  try {
    const res = await fetch(BDIX_DIRECTORY_URL, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        Accept: "text/html,application/xhtml+xml",
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.ok) {
      const html = await res.text();
      const m = html.match(/const\s+sites\s*=\s*(\[[\s\S]*?\]);/);
      if (m) {
        const parsed = JSON.parse(m[1]);
        if (Array.isArray(parsed) && parsed.length > 0) {
          rawSites = parsed;
          fetchedLive = true;
        }
      }
    }
  } catch {}

  const combined = [];
  const seenOrigin = new Set();
  const pushCandidate = (title, category, rawUrl, builtinId = null) => {
    const norm = normalizeServerInputUrl(rawUrl);
    if (!isSafeServerUrl(norm)) return;
    let origin = "";
    try {
      const u = new URL(norm);
      const lowHost = u.hostname.toLowerCase();
      // Unify circleftp.net / www.circleftp.net / new.circleftp.net into one single candidate
      origin =
        lowHost === "circleftp.net" || lowHost === "www.circleftp.net" || lowHost === "new.circleftp.net"
          ? "http://new.circleftp.net"
          : u.origin.toLowerCase();
      if (seenOrigin.has(origin)) return;
      seenOrigin.add(origin);
    } catch {
      return;
    }
    combined.push({
      title: String(title || origin).trim(),
      category: String(category || "FTP").trim(),
      url: norm,
      origin,
      builtinId,
    });
  };

  // 1. Always include CineVault's verified BDIX nodes first so exact paths/CDNs are tested cleanly
  for (const s of SERVERS) {
    const fullUrl = s.origin + (s.rootHref && s.rootHref !== "/command.php" ? s.rootHref : "/");
    pushCandidate(s.name.split(" (")[0], s.source === "icc" || s.source === "circleftp" ? "Video" : "FTP", fullUrl, s.id);
  }

  // 2. Append all FTP & Video entries from live https://bdix.link/test/server (or fallback if offline)
  const listSource = rawSites.length > 0 ? rawSites : FALLBACK_BDIX_SITES;
  for (const item of listSource) {
    const cat = String(item.category || "").trim();
    if (cat && !/^(ftp|video)$/i.test(cat)) continue; // Skip Live TV & Game sites
    if (!item.url) continue;
    pushCandidate(item.title, cat || "FTP", item.url, null);
  }

  return { sites: combined, fetchedLive };
}

async function testSingleSiteOnLocalWifi(site) {
  const t0 = Date.now();
  const lowHost = (() => {
    try { return new URL(site.url).hostname.toLowerCase(); } catch { return ""; }
  })();

  // Fast protocol-specific health probes for ICC FTP & CircleFTP
  if (/^10\.16\.100\.\d{1,3}$/.test(lowHost)) {
    const h = await checkIccHealth();
    return { open: Boolean(h.online), latencyMs: h.latencyMs ?? (Date.now() - t0), specialized: "icc" };
  }
  if (lowHost === "circleftp.net" || lowHost === "www.circleftp.net" || lowHost === "new.circleftp.net") {
    const h = await checkCircleHealth();
    return { open: Boolean(h.online), latencyMs: h.latencyMs ?? (Date.now() - t0), specialized: "circleftp" };
  }

  try {
    const res = await fetch(site.url, {
      method: "GET",
      redirect: "follow",
      signal: AbortSignal.timeout(2600),
    });
    const finalUrl = res.url || site.url;
    try { await res.body?.cancel(); } catch {}
    // Reject ISP block notices, MikroTik billing logins, and parked-domain redirectors (ww9.*, ww547.*)
    if (/notice\.html|blocked|unauthorized|suspended|captive|login\.php|^https?:\/\/ww\d+\./i.test(finalUrl)) {
      return { open: false, latencyMs: null, specialized: null };
    }
    const ok = (res.status >= 200 && res.status < 300) || res.status === 405;
    return { open: ok, latencyMs: ok ? Date.now() - t0 : null, specialized: null };
  } catch {
    return { open: false, latencyMs: null, specialized: null };
  }
}

/**
 * Full Wi-Fi BDIX Server Test & Auto-Sync Pipeline:
 * 1. Loads live BDIX server list from https://bdix.link/test/server
 * 2. Tests reachability of every server directly from THIS user's Wi-Fi in parallel
 * 3. Probes open servers to verify compatible indexable media directories (rejecting web-only/WordPress pages)
 * 4. Registers/enables open compatible servers, marks closed servers offline (hiding their content immediately),
 *    and automatically launches a sync of ONLY the open servers!
 */
export async function startBdixWifiScan({ autoSync = true } = {}) {
  if (scanState.running) {
    return { started: false, reason: "already_running", status: getBdixScanStatus() };
  }

  scanState.running = true;
  scanState.phase = "fetching";
  scanState.total = 0;
  scanState.tested = 0;
  scanState.openCount = 0;
  scanState.syncableCount = 0;
  scanState.addedCount = 0;
  scanState.startedAt = Date.now();
  scanState.finishedAt = 0;
  scanState.error = null;
  scanState.results = [];
  scanState.message = "Fetching BDIX server directory from bdix.link...";
  emitScanUpdate();

  runBdixWifiScanInternal({ autoSync }).catch((err) => {
    scanState.running = false;
    scanState.phase = "error";
    scanState.error = err?.message || "BDIX Wi-Fi scan failed";
    scanState.message = scanState.error;
    scanState.finishedAt = Date.now();
    emitScanUpdate();
  });

  return { started: true, status: getBdixScanStatus() };
}

async function runBdixWifiScanInternal({ autoSync }) {
  const { sites, fetchedLive } = await fetchBdixDirectorySites(9000);
  scanState.total = sites.length;
  scanState.phase = "testing";
  scanState.message = fetchedLive
    ? `Testing ${sites.length} BDIX servers on your Wi-Fi (from bdix.link)...`
    : `Testing ${sites.length} BDIX servers on your Wi-Fi...`;
  emitScanUpdate();

  const openEntries = [];
  const allResults = [];

  await mapWithConcurrency(sites, 16, async (site) => {
    const check = await testSingleSiteOnLocalWifi(site);
    scanState.tested++;
    const row = {
      title: site.title,
      category: site.category,
      url: site.url,
      origin: site.origin,
      builtinId: site.builtinId,
      open: check.open,
      latencyMs: check.latencyMs,
      specialized: check.specialized,
      status: check.open ? "open" : "closed",
      syncable: false,
      adapter: null,
      folderCount: 0,
      serverId: null,
    };
    if (check.open) {
      scanState.openCount++;
      openEntries.push(row);
    }
    allResults.push(row);
    scanState.results = [...allResults].sort((a, b) => {
      if (a.syncable !== b.syncable) return a.syncable ? -1 : 1;
      if (a.open !== b.open) return a.open ? -1 : 1;
      return (a.latencyMs ?? 99999) - (b.latencyMs ?? 99999);
    });
    if (scanState.tested % 4 === 0 || scanState.tested === scanState.total) {
      scanState.message = `Testing Wi-Fi servers (${scanState.tested}/${scanState.total}) · ${scanState.openCount} open`;
      emitScanUpdate();
    }
  });

  // Step 3: Probe open servers to discover indexable media folders & register/enable them cleanly
  scanState.phase = "probing";
  scanState.message = `Inspecting ${openEntries.length} open server${openEntries.length === 1 ? "" : "s"} for compatible movie & series folders...`;
  emitScanUpdate();

  const existingServers = getAllServers();
  const existingByOrigin = new Map();
  for (const s of existingServers) {
    if (s.origin) existingByOrigin.set(s.origin.toLowerCase(), s);
  }

  const onlineServerIds = new Set();

  await mapWithConcurrency(openEntries, 5, async (entry) => {
    try {
      // Match an existing built-in server directly if already registered & open (re-enable if disabled!)
      const existing = existingByOrigin.get(entry.origin);
      if (existing && existing.isBuiltin) {
        if (!existing.enabled) {
          setServerEnabled(existing.id, true);
          existing.enabled = true;
        }
        entry.syncable = true;
        entry.adapter = existing.adapter;
        entry.status = "synced";
        entry.serverId = existing.id;
        onlineServerIds.add(existing.id);
        scanState.syncableCount++;
        return;
      }

      // Probe for ICC / CircleFTP / h5ai / Apache / Nginx / Portal compatible directories
      const probed = await probeDirectoryServer(entry.url, 6500);
      if (!probed?.ok) return;

      const compatFolders = (probed.folders || []).filter((f) => f.selected !== false);
      const isIndexable =
        probed.detectedAdapter === "icc" ||
        probed.detectedAdapter === "circleftp" ||
        compatFolders.length > 0 ||
        (probed.directVideoCount || 0) > 0;

      if (!isIndexable) {
        entry.status = "web-only";
        return;
      }

      // Check again by resolved origin (e.g. circleftp.net -> http://new.circleftp.net or portal redirect)
      const resolvedOrig = (probed.origin || entry.origin).toLowerCase();
      const existingResolved = existingByOrigin.get(resolvedOrig);
      if (existingResolved && existingResolved.isBuiltin) {
        if (!existingResolved.enabled) {
          setServerEnabled(existingResolved.id, true);
          existingResolved.enabled = true;
        }
        entry.syncable = true;
        entry.adapter = existingResolved.adapter;
        entry.folderCount = compatFolders.length;
        entry.status = "synced";
        entry.serverId = existingResolved.id;
        onlineServerIds.add(existingResolved.id);
        scanState.syncableCount++;
        return;
      }

      // Register or re-enable this open Wi-Fi FTP server automatically!
      const saved = addOrUpdateCustomServer({
        name: entry.title || probed.suggestedName,
        url: (probed.origin || entry.origin) + (probed.rootHref || "/"),
        adapter: probed.detectedAdapter || "directory",
        folders: compatFolders,
        rootHrefOverride: probed.rootHref || "/",
      });
      existingByOrigin.set(saved.origin.toLowerCase(), saved);
      entry.syncable = true;
      entry.adapter = saved.adapter;
      entry.folderCount = compatFolders.length;
      entry.status = "synced";
      entry.serverId = saved.id;
      onlineServerIds.add(saved.id);
      scanState.syncableCount++;
      if (!existingResolved) scanState.addedCount++;
    } catch {
      entry.status = "web-only";
    }
  });

  // Step 4: Refresh exact online/offline status across ALL configured servers (hiding closed ones immediately!)
  invalidateHealthCache();
  const finalHealth = await getServersHealth(true);
  const onlineMap = {};
  for (const h of finalHealth) {
    onlineMap[h.id] = Boolean(h.enabled && (h.online || onlineServerIds.has(h.id)));
  }
  updateServersOnlineStatus(onlineMap);

  scanState.results = [...allResults].sort((a, b) => {
    if (a.syncable !== b.syncable) return a.syncable ? -1 : 1;
    if (a.open !== b.open) return a.open ? -1 : 1;
    return (a.latencyMs ?? 99999) - (b.latencyMs ?? 99999);
  });

  // Step 5: Automatically start syncing ONLY the open servers!
  let syncStarted = false;
  if (autoSync && finalHealth.some((h) => h.enabled && h.online)) {
    scanState.phase = "syncing";
    scanState.message = `Found ${scanState.openCount} open (${scanState.syncableCount} compatible FTP) — syncing open servers...`;
    emitScanUpdate();
    const sRes = await startSync("full");
    syncStarted = Boolean(sRes?.started);
  }

  scanState.running = false;
  scanState.phase = "done";
  scanState.finishedAt = Date.now();
  const secs = ((scanState.finishedAt - scanState.startedAt) / 1000).toFixed(1);
  scanState.message =
    scanState.syncableCount > 0
      ? `Scanned ${scanState.total} servers in ${secs}s · ${scanState.openCount} open · ${scanState.syncableCount} compatible synced${syncStarted ? " (sync running)" : ""}`
      : `Scanned ${scanState.total} servers in ${secs}s · ${scanState.openCount} open · 0 indexable FTP servers found on this Wi-Fi`;
  emitScanUpdate();

  const st = getLibraryStats(true);
  console.log(
    `[bdix-scan] Complete in ${secs}s (${fetchedLive ? "live bdix.link" : "fallback"}): ${scanState.openCount}/${scanState.total} open, ${scanState.syncableCount} compatible (+${scanState.addedCount} added), active catalog=${st.total}`
  );
}
