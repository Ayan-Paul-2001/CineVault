import { EventEmitter } from "node:events";
import {
  CATEGORIES,
  ICC_CATEGORIES,
  DISCOVERY_CATEGORIES,
  SERVERS,
  DHAKAFLIX_ORIGINS,
  ICC_ORIGIN,
  CIRCLEFTP_ORIGIN,
  CIRCLEFTP_API,
} from "./config.js";
import { listDirectory, mapWithConcurrency, checkServerHealth } from "./h5ai.js";
import { crawlIccCategory, checkIccHealth, getIccSession } from "./icc.js";
import {
  crawlCircleFtp,
  checkCircleHealth,
  classifyCirclePost,
  circlePosterUrl,
} from "./circleftp.js";
import {
  parseFolderName,
  parseIccTitle,
  parseCirclePost,
  bucketPriorityScore,
  safeDecode,
} from "./parser.js";
import {
  upsertMediaBatch,
  loadExistingUrlIndex,
  runDeduplication,
  setSyncState,
  getSyncState,
  getLibraryStats,
  getRecentlyWatchedSeriesIds,
} from "./db.js";
import { hydrateItem } from "./metadata.js";

export const syncEvents = new EventEmitter();
syncEvents.setMaxListeners(50);

const state = {
  running: false,
  mode: "idle", // "quick" | "full" | "icc" | "circle" | "idle"
  startedAt: null,
  finishedAt: null,
  totalTasks: 0,
  completedTasks: 0,
  indexedCount: 0,
  newlyAddedCount: 0,
  lastNewCount: Number(getSyncState("last_new_count") || 0),
  currentLabel: "",
  errors: [],
  autoSyncEnabled: getSyncState("auto_sync_enabled") !== "false",
  autoSyncIntervalMin: Math.max(5, Number(getSyncState("auto_sync_interval_min") || 30)),
  nextAutoSyncAt: null,
};

let autoSyncTimer = null;
let lastProgressEmitAt = 0;

const originLimiters = new Map();
function withOriginSlot(origin, maxConcurrent, fn) {
  let lim = originLimiters.get(origin);
  if (!lim) {
    lim = { active: 0, queue: [] };
    originLimiters.set(origin, lim);
  }
  return new Promise((resolve, reject) => {
    const run = async () => {
      lim.active++;
      try {
        resolve(await fn());
      } catch (e) {
        reject(e);
      } finally {
        lim.active--;
        const next = lim.queue.shift();
        if (next) next();
      }
    };
    if (lim.active < maxConcurrent) run();
    else lim.queue.push(run);
  });
}

function loadJsonState(key, fallback) {
  try {
    const raw = getSyncState(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

export function getSyncStatus() {
  return {
    ...state,
    percent:
      state.totalTasks > 0
        ? Math.min(100, Math.round((state.completedTasks / state.totalTasks) * 100))
        : 0,
  };
}

function emitProgress(event = "progress", force = false) {
  const now = Date.now();
  if (!force && event === "progress" && now - lastProgressEmitAt < 250) {
    return;
  }
  lastProgressEmitAt = now;
  syncEvents.emit(event, getSyncStatus());
}

export function scheduleAutoSync() {
  if (autoSyncTimer) {
    clearInterval(autoSyncTimer);
    autoSyncTimer = null;
  }
  if (!state.autoSyncEnabled) {
    state.nextAutoSyncAt = null;
    emitProgress("status", true);
    return;
  }
  const intervalMs = state.autoSyncIntervalMin * 60 * 1000;
  state.nextAutoSyncAt = Date.now() + intervalMs;
  autoSyncTimer = setInterval(() => {
    state.nextAutoSyncAt = Date.now() + intervalMs;
    if (!state.running) {
      console.log("[indexer] Auto-sync triggered: delta checking DhakaFlix + ICC FTP + CircleFTP...");
      startSync("quick");
    }
  }, intervalMs);
  autoSyncTimer.unref?.();
  emitProgress("status", true);
}

export function updateAutoSyncSettings({ enabled, intervalMin }) {
  if (typeof enabled === "boolean") {
    state.autoSyncEnabled = enabled;
    setSyncState("auto_sync_enabled", String(enabled));
  }
  if (intervalMin !== undefined) {
    const clamped = Math.min(720, Math.max(5, parseInt(intervalMin, 10) || 30));
    state.autoSyncIntervalMin = clamped;
    setSyncState("auto_sync_interval_min", String(clamped));
  }
  scheduleAutoSync();
  return getSyncStatus();
}

async function discoverExtraDhakaFlixCategories() {
  const extras = [];
  try {
    const res = await fetch("http://172.16.50.7/", { signal: AbortSignal.timeout(3500) });
    if (!res.ok) return extras;
    const html = await res.text();
    const knownUrls = new Set(
      CATEGORIES.filter((c) => c.href).map((c) => (c.origin + c.href).toLowerCase())
    );
    const linkRe = /href="(http:\/\/172\.16\.50\.\d+\/DHAKA-FLIX-\d+\/[^"]+)"/gi;
    let m;
    while ((m = linkRe.exec(html)) !== null) {
      const fullUrl = m[1].endsWith("/") ? m[1] : `${m[1]}/`;
      if (knownUrls.has(fullUrl.toLowerCase())) continue;
      if (/Games|Software|Tutorial|Satyajit/i.test(fullUrl)) continue;
      try {
        const u = new URL(fullUrl);
        if (!DHAKAFLIX_ORIGINS.has(u.origin)) continue;
        knownUrls.add(fullUrl.toLowerCase());
        const seg = safeDecode(u.pathname.replace(/\/+$/, "").split("/").pop() || "extra");
        const id = "discovered-" + seg.toLowerCase().replace(/[^a-z0-9]+/g, "-");
        const isSeries = /series|tv|anime|show|drama/i.test(seg);
        extras.push({
          id,
          label: seg,
          shortLabel: seg,
          group: isSeries ? "series" : "movies",
          mediaType: isSeries ? "series" : "movie",
          origin: u.origin,
          href: u.pathname,
          mode: "bucketed",
          priority: 50,
        });
      } catch {}
    }
  } catch {}
  return extras;
}

/**
 * Ultra-fast delta-aware parallel sync engine across DhakaFlix + ICC FTP + CircleFTP.
 * mode: "quick" | "full" | "icc" | "circle"
 */
export async function startSync(mode = "full") {
  if (state.running) {
    return { started: false, reason: "already_running", status: getSyncStatus() };
  }

  state.running = true;
  state.mode = mode;
  state.startedAt = Date.now();
  state.finishedAt = null;
  state.totalTasks = 1;
  state.completedTasks = 0;
  state.indexedCount = 0;
  state.newlyAddedCount = 0;
  state.currentLabel = "Checking online servers...";
  state.errors = [];
  emitProgress("start", true);

  runUnifiedCrawl(mode).catch((err) => {
    state.errors.push(err.message);
    state.running = false;
    state.mode = "idle";
    state.finishedAt = Date.now();
    emitProgress("done", true);
  });

  return { started: true, status: getSyncStatus() };
}

async function runUnifiedCrawl(mode) {
  const isQuick = mode === "quick";
  const runDf = mode === "full" || mode === "quick";
  const runIcc = mode === "full" || mode === "quick" || mode === "icc";
  const runCircle = mode === "full" || mode === "quick" || mode === "circle";
  const runDiscovery = mode === "full" || mode === "quick" || mode === "discovery";

  const existingUrlMap = loadExistingUrlIndex();
  const bucketMtimes = loadJsonState("df_bucket_mtimes", {});
  const discBucketMtimes = loadJsonState("disc_bucket_mtimes", {});
  const iccCatCounts = loadJsonState("icc_cat_counts", {});
  let circleMaxId = Number(getSyncState("circle_max_id") || 0);

  const hasExistingIcc = [...existingUrlMap.keys()].some((u) => u.startsWith(ICC_ORIGIN));
  const hasExistingCircle = [...existingUrlMap.keys()].some((u) => u.startsWith(CIRCLEFTP_API));
  const hasExistingDisc = [...existingUrlMap.keys()].some((u) => u.includes("discoveryftp.net"));

  // Step 0: Fast parallel health check so offline nodes never stall sync
  const health = await getServersHealth(true);
  const onlineOrigins = new Set(health.filter((s) => s.online).map((s) => s.origin));
  const iccOnline = runIcc && onlineOrigins.has(ICC_ORIGIN);
  const circleOnline = runCircle && onlineOrigins.has(CIRCLEFTP_ORIGIN);

  const dfBaseCats = runDf
    ? CATEGORIES.filter((c) => c.href && onlineOrigins.has(c.origin))
    : [];

  const discCats = runDiscovery
    ? DISCOVERY_CATEGORIES.filter((c) => onlineOrigins.has(c.origin)).sort((a, b) => a.priority - b.priority)
    : [];

  const QUICK_ICC_IDS = new Set([74, 44, 43, 2, 19, 73, 32, 33, 36, 72, 37, 78]);
  const iccTargets = iccOnline
    ? ICC_CATEGORIES.filter((c) => !isQuick || QUICK_ICC_IDS.has(c.iccId)).sort((a, b) => a.priority - b.priority)
    : [];

  const circleTaskWeight = circleOnline ? (hasExistingCircle && circleMaxId > 0 ? 1 : 20) : 0;
  state.totalTasks = Math.max(1, dfBaseCats.length + discCats.length + iccTargets.length + circleTaskWeight);
  emitProgress("progress", true);

  let totalWritten = 0;
  let bucketsSkipped = 0;
  let discSkipped = 0;
  let iccSkipped = 0;
  let circleSkipped = false;
  let writeBuffer = [];

  const flushBuffer = (force = false) => {
    if (writeBuffer.length === 0) return;
    if (!force && writeBuffer.length < 500) return;
    const batch = writeBuffer;
    writeBuffer = [];
    const { processed, newlyAdded, written } = upsertMediaBatch(batch, existingUrlMap);
    state.indexedCount += processed;
    state.newlyAddedCount += newlyAdded;
    totalWritten += written;
  };

  // Run DhakaFlix, ICC FTP, AND CircleFTP simultaneously!
  const dfTask =
    dfBaseCats.length === 0
      ? Promise.resolve()
      : (async () => {
          const discovered =
            !isQuick && onlineOrigins.has("http://172.16.50.7")
              ? await discoverExtraDhakaFlixCategories()
              : [];
          const dfCategories = [...dfBaseCats, ...discovered].sort((a, b) => a.priority - b.priority);
          const crawlQueue = [];

          await mapWithConcurrency(dfCategories, 8, async (cat) => {
            try {
              state.currentLabel = `DhakaFlix › ${cat.shortLabel}`;
              emitProgress();
              const children = await withOriginSlot(cat.origin, 5, () =>
                listDirectory(cat.origin, cat.href, 10000)
              );
              const dirs = children.filter((c) => c.isDir);

              if (cat.mode === "flat") {
                if (dirs.length > 0) {
                  writeBuffer.push(...dirs.map((d) => buildDhakaFlixRow(d, cat, null)));
                  flushBuffer();
                }
                state.completedTasks++;
                emitProgress();
              } else {
                let buckets = dirs.sort(
                  (a, b) => bucketPriorityScore(b.name) - bucketPriorityScore(a.name)
                );
                if (isQuick) buckets = buckets.slice(0, 2);

                for (const b of buckets) {
                  const prevTime = bucketMtimes[b.url];
                  if (prevTime && b.time && b.time <= prevTime && existingUrlMap.size > 0) {
                    bucketsSkipped++;
                    continue;
                  }
                  crawlQueue.push({
                    cat,
                    bucket: b,
                    score: (100 - cat.priority) * 100000 + bucketPriorityScore(b.name),
                  });
                }
                state.completedTasks++;
                emitProgress();
              }
            } catch (err) {
              state.errors.push(`DhakaFlix ${cat.shortLabel}: ${err.message}`);
              state.completedTasks++;
              emitProgress();
            }
          });

          if (crawlQueue.length > 0) {
            state.totalTasks += crawlQueue.length;
            crawlQueue.sort((a, b) => b.score - a.score);

            await mapWithConcurrency(crawlQueue, 12, async (task) => {
              const { cat, bucket } = task;
              try {
                state.currentLabel = `DhakaFlix › ${cat.shortLabel} › ${bucket.name}`;
                const entries = await withOriginSlot(cat.origin, 5, () =>
                  listDirectory(cat.origin, bucket.href, 10000)
                );
                const subDirs = entries.filter((e) => e.isDir);
                const directVideos = entries.filter((e) => !e.isDir && e.kind === "video");

                if (subDirs.length > 0) {
                  writeBuffer.push(...subDirs.map((d) => buildDhakaFlixRow(d, cat, bucket.name)));
                } else if (directVideos.length > 0) {
                  writeBuffer.push(buildDhakaFlixRow(bucket, cat, null));
                }
                if (bucket.time) bucketMtimes[bucket.url] = bucket.time;
                flushBuffer();
              } catch (err) {
                state.errors.push(`DhakaFlix ${cat.shortLabel}/${bucket.name}: ${err.message}`);
              } finally {
                state.completedTasks++;
                emitProgress();
              }
            });
          }
        })();

  const iccTask =
    iccTargets.length === 0
      ? Promise.resolve()
      : (async () => {
          const iccSession = getIccSession();
          await mapWithConcurrency(iccTargets, 6, async (iccCat) => {
            try {
              state.currentLabel = `ICC FTP › ${iccCat.label}`;
              emitProgress();

              const prevCount = iccCatCounts[iccCat.iccId] || (hasExistingIcc ? 1 : null);
              const maxPages = isQuick ? Math.max(iccCat.maxQuickPages || 3, 4) : 2000;

              const res = await crawlIccCategory(iccCat.iccId, {
                maxPages,
                session: iccSession,
                knownUrls: existingUrlMap,
                stopOnKnown: isQuick || hasExistingIcc,
                prevCount: hasExistingIcc ? prevCount : null,
                onBatch: (cards) => {
                  writeBuffer.push(...cards.map((c) => buildIccRow(c, iccCat)));
                  flushBuffer();
                  state.currentLabel = `ICC FTP › ${iccCat.label}`;
                  emitProgress();
                },
              });

              if (res.skippedDelta) iccSkipped++;
              if (res.expectedCount) iccCatCounts[iccCat.iccId] = res.expectedCount;
            } catch (err) {
              state.errors.push(`${iccCat.label}: ${err.message}`);
            } finally {
              state.completedTasks++;
              emitProgress();
            }
          });
        })();

  const circleTask = !circleOnline
    ? Promise.resolve()
    : (async () => {
        let reportedWeight = 0;
        try {
          state.currentLabel = "CircleFTP › Fetching latest posts...";
          emitProgress();
          const res = await crawlCircleFtp({
            knownUrls: existingUrlMap,
            stopOnKnown: hasExistingCircle && circleMaxId > 0,
            prevMaxId: hasExistingCircle ? circleMaxId : 0,
            onBatch: (posts) => {
              const rows = [];
              for (const p of posts) {
                const row = buildCircleRow(p);
                if (row) rows.push(row);
              }
              if (rows.length > 0) {
                writeBuffer.push(...rows);
                flushBuffer();
              }
            },
            onProgress: (done, total) => {
              const targetWeight = Math.min(circleTaskWeight, Math.floor((done / Math.max(1, total)) * circleTaskWeight));
              if (targetWeight > reportedWeight) {
                state.completedTasks += targetWeight - reportedWeight;
                reportedWeight = targetWeight;
              }
              state.currentLabel = `CircleFTP › Page ${done}/${total}`;
              emitProgress();
            },
          });
          circleSkipped = res.skippedDelta;
          if (res.highestId > circleMaxId) circleMaxId = res.highestId;
        } catch (err) {
          state.errors.push(`CircleFTP: ${err.message}`);
        } finally {
          if (reportedWeight < circleTaskWeight) {
            state.completedTasks += circleTaskWeight - reportedWeight;
          }
          emitProgress();
        }
      })();

  const discoveryTask =
    discCats.length === 0
      ? Promise.resolve()
      : (async () => {
          const discQueue = [];
          await mapWithConcurrency(discCats, 6, async (cat) => {
            try {
              state.currentLabel = `DiscoveryFTP › ${cat.shortLabel}`;
              emitProgress();
              const children = await withOriginSlot(cat.origin, 5, () =>
                listDirectory(cat.origin, cat.href, 8000)
              );
              const dirs = children.filter((c) => c.isDir);

              if (cat.mode === "flat") {
                if (dirs.length > 0) {
                  writeBuffer.push(...dirs.map((d) => buildH5aiRow(d, cat, null, "discoveryftp")));
                  flushBuffer();
                }
                state.completedTasks++;
                emitProgress();
              } else {
                let buckets = dirs.sort(
                  (a, b) => bucketPriorityScore(b.name) - bucketPriorityScore(a.name)
                );
                if (isQuick && hasExistingDisc) buckets = buckets.slice(0, 2);

                for (const b of buckets) {
                  const prevTime = discBucketMtimes[b.url];
                  if (prevTime && b.time && b.time <= prevTime && hasExistingDisc) {
                    discSkipped++;
                    continue;
                  }
                  discQueue.push({
                    cat,
                    bucket: b,
                    score: (100 - cat.priority) * 100000 + bucketPriorityScore(b.name),
                  });
                }
                state.completedTasks++;
                emitProgress();
              }
            } catch (err) {
              state.errors.push(`DiscoveryFTP ${cat.shortLabel}: ${err.message}`);
              state.completedTasks++;
              emitProgress();
            }
          });

          if (discQueue.length > 0) {
            state.totalTasks += discQueue.length;
            discQueue.sort((a, b) => b.score - a.score);

            await mapWithConcurrency(discQueue, 8, async ({ cat, bucket }) => {
              try {
                state.currentLabel = `DiscoveryFTP › ${cat.shortLabel} › ${bucket.name}`;
                const entries = await withOriginSlot(cat.origin, 5, () =>
                  listDirectory(cat.origin, bucket.href, 8000)
                );
                const subDirs = entries.filter((e) => e.isDir);
                const directVideos = entries.filter((e) => !e.isDir && e.kind === "video");

                if (subDirs.length > 0) {
                  writeBuffer.push(
                    ...subDirs.map((d) => buildH5aiRow(d, cat, bucket.name, "discoveryftp"))
                  );
                } else if (directVideos.length > 0) {
                  writeBuffer.push(buildH5aiRow(bucket, cat, null, "discoveryftp"));
                }
                if (bucket.time) discBucketMtimes[bucket.url] = bucket.time;
                flushBuffer();
              } catch (err) {
                state.errors.push(`DiscoveryFTP ${cat.shortLabel}/${bucket.name}: ${err.message}`);
              } finally {
                state.completedTasks++;
                emitProgress();
              }
            });
          }
        })();

  await Promise.all([dfTask, iccTask, circleTask, discoveryTask]);
  flushBuffer(true);

  setSyncState("df_bucket_mtimes", JSON.stringify(bucketMtimes));
  setSyncState("disc_bucket_mtimes", JSON.stringify(discBucketMtimes));
  setSyncState("icc_cat_counts", JSON.stringify(iccCatCounts));
  if (circleMaxId > 0) setSyncState("circle_max_id", String(circleMaxId));

  let dedupSummary = null;
  if (totalWritten > 0) {
    state.currentLabel = "Merging all 4 servers & selecting highest quality...";
    emitProgress("progress", true);
    dedupSummary = runDeduplication();
  }

  const watchedSeriesIds = getRecentlyWatchedSeriesIds(8);
  if (watchedSeriesIds.length > 0) {
    state.currentLabel = "Checking watched TV series for new episodes...";
    emitProgress("progress", true);
    await mapWithConcurrency(watchedSeriesIds, 4, async (id) => {
      try {
        await hydrateItem(id, { deep: true, force: true });
      } catch {}
    });
  }

  setSyncState("last_sync_at", Date.now());
  setSyncState("last_sync_mode", mode);
  setSyncState("last_new_count", state.newlyAddedCount);

  state.lastNewCount = state.newlyAddedCount;
  state.running = false;
  state.mode = "idle";
  state.finishedAt = Date.now();
  const secs = ((state.finishedAt - state.startedAt) / 1000).toFixed(1);
  state.currentLabel =
    state.newlyAddedCount > 0
      ? `Synced +${state.newlyAddedCount.toLocaleString()} new in ${secs}s`
      : `Up to date (${secs}s)`;
  if (state.autoSyncEnabled) {
    state.nextAutoSyncAt = Date.now() + state.autoSyncIntervalMin * 60 * 1000;
  }
  emitProgress("done", true);

  const stats = getLibraryStats(true);
  console.log(
    `[indexer] ${mode} delta sync complete in ${secs}s: ${stats.total} unique titles (${stats.duplicatesMerged} duplicates merged, +${state.newlyAddedCount} new, ${totalWritten} written, skipped ${bucketsSkipped} DF / ${discSkipped} Discovery / ${iccSkipped} ICC${circleSkipped ? " / CircleFTP unchanged" : ""}${dedupSummary ? `, dedup ${dedupSummary.elapsedMs}ms` : ""})`
  );
}

function buildH5aiRow(dirEntry, cat, subGroup, source = "dhakaflix") {
  const parsed = parseFolderName(dirEntry.name, cat, subGroup, source);
  return {
    url: dirEntry.url,
    origin: cat.origin,
    href: dirEntry.href,
    category: cat.id,
    media_type: parsed.mediaType,
    sub_group: subGroup || null,
    raw_name: parsed.rawName,
    title: parsed.title,
    clean_title: parsed.cleanTitle,
    year: parsed.year,
    quality: parsed.quality,
    audio_tags: parsed.audioTags,
    source_tag: parsed.sourceTag,
    language_tag: parsed.languageTag,
    imdb_rank: parsed.imdbRank,
    modified_at: dirEntry.time || 0,
    poster_url: null,
    source,
    source_id: null,
    quality_score: parsed.qualityScore,
    season_hint: null,
    categories_all: `,${cat.id},`,
  };
}

function buildDhakaFlixRow(dirEntry, cat, subGroup) {
  return buildH5aiRow(dirEntry, cat, subGroup, "dhakaflix");
}

function buildIccRow(card, iccCat) {
  const parsed = parseIccTitle(card.title, iccCat);
  return {
    url: card.url,
    origin: ICC_ORIGIN,
    href: `/player.php?play=${card.playId}`,
    category: iccCat.category,
    media_type: parsed.mediaType,
    sub_group: iccCat.label,
    raw_name: parsed.rawName,
    title: parsed.title,
    clean_title: parsed.cleanTitle,
    year: parsed.year,
    quality: parsed.quality,
    audio_tags: parsed.audioTags,
    source_tag: parsed.sourceTag,
    language_tag: parsed.languageTag,
    imdb_rank: null,
    modified_at: card.modifiedAt || 0,
    poster_url: card.posterUrl || null,
    source: "icc",
    source_id: card.playId,
    quality_score: parsed.qualityScore,
    season_hint: parsed.seasonHint,
    categories_all: `,${iccCat.category},`,
  };
}

function buildCircleRow(post) {
  const classified = classifyCirclePost(post);
  if (!classified) return null;
  const parsed = parseCirclePost(post, classified);
  if (!parsed.cleanTitle) return null;

  const cats = new Set([parsed.category, classified.category]);
  return {
    url: `${CIRCLEFTP_API}/posts/${post.id}`,
    origin: CIRCLEFTP_ORIGIN,
    href: `/api/posts/${post.id}`,
    category: parsed.category,
    media_type: parsed.mediaType,
    sub_group: classified.subGroup,
    raw_name: parsed.rawName,
    title: parsed.title,
    clean_title: parsed.cleanTitle,
    year: parsed.year,
    quality: parsed.quality,
    audio_tags: parsed.audioTags,
    source_tag: parsed.sourceTag,
    language_tag: parsed.languageTag,
    imdb_rank: null,
    modified_at: parsed.modifiedAt,
    poster_url: circlePosterUrl(post),
    source: "circleftp",
    source_id: String(post.id),
    quality_score: parsed.qualityScore,
    season_hint: null,
    categories_all: `,${[...cats].sort().join(",")},`,
  };
}

let cachedHealth = null;
let healthCheckedAt = 0;

export async function getServersHealth(force = false) {
  if (!force && cachedHealth && Date.now() - healthCheckedAt < 30000) {
    return cachedHealth;
  }
  const results = await Promise.all(
    SERVERS.map(async (s) => {
      if (s.source === "icc") {
        const icc = await checkIccHealth();
        return { ...s, ...icc };
      }
      if (s.source === "circleftp") {
        const cf = await checkCircleHealth();
        return { ...s, ...cf };
      }
      return checkServerHealth(s);
    })
  );
  cachedHealth = results;
  healthCheckedAt = Date.now();
  return results;
}
