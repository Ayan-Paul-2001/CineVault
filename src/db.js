import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { DATA_DIR, DB_PATH, CATEGORY_MAP } from "./config.js";
import { computeQualityScore, normalizeTitleForMatch } from "./parser.js";

fs.mkdirSync(DATA_DIR, { recursive: true });

export const db = new DatabaseSync(DB_PATH);

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;
  PRAGMA temp_store = MEMORY;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS media_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    url TEXT UNIQUE NOT NULL,
    origin TEXT NOT NULL,
    href TEXT NOT NULL,
    category TEXT NOT NULL,
    media_type TEXT NOT NULL DEFAULT 'movie',
    sub_group TEXT,
    raw_name TEXT NOT NULL,
    title TEXT NOT NULL,
    clean_title TEXT NOT NULL,
    year INTEGER,
    quality TEXT,
    audio_tags TEXT,
    source_tag TEXT,
    language_tag TEXT,
    imdb_rank INTEGER,
    modified_at INTEGER DEFAULT 0,
    poster_url TEXT,
    poster_checked INTEGER DEFAULT 0,
    files_json TEXT,
    seasons_json TEXT,
    total_size INTEGER DEFAULT 0,
    hydrated_at INTEGER DEFAULT 0,
    meta_json TEXT,
    meta_checked INTEGER DEFAULT 0,
    discovered_at INTEGER DEFAULT 0,
    source TEXT NOT NULL DEFAULT 'dhakaflix',
    source_id TEXT,
    quality_score INTEGER DEFAULT 0,
    is_primary INTEGER DEFAULT 1,
    canonical_id INTEGER,
    categories_all TEXT,
    season_hint TEXT
  );

  CREATE TABLE IF NOT EXISTS watch_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id TEXT NOT NULL DEFAULT 'default',
    media_id INTEGER NOT NULL REFERENCES media_items(id) ON DELETE CASCADE,
    file_url TEXT NOT NULL,
    file_name TEXT,
    season_name TEXT,
    episode_label TEXT,
    position REAL DEFAULT 0,
    duration REAL DEFAULT 0,
    completed INTEGER DEFAULT 0,
    updated_at INTEGER NOT NULL,
    UNIQUE(device_id, file_url)
  );

  CREATE TABLE IF NOT EXISTS watchlist (
    device_id TEXT NOT NULL DEFAULT 'default',
    media_id INTEGER NOT NULL REFERENCES media_items(id) ON DELETE CASCADE,
    added_at INTEGER NOT NULL,
    PRIMARY KEY (device_id, media_id)
  );

  CREATE TABLE IF NOT EXISTS sync_state (
    key TEXT PRIMARY KEY,
    value TEXT
  );
`);

// Safe online schema migration for per-device watch_history & watchlist isolation
const histCols = new Set(db.prepare("PRAGMA table_info(watch_history)").all().map((c) => c.name));
if (!histCols.has("device_id")) {
  db.exec(`
    BEGIN;
    CREATE TABLE watch_history_v2 (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      device_id TEXT NOT NULL DEFAULT 'default',
      media_id INTEGER NOT NULL REFERENCES media_items(id) ON DELETE CASCADE,
      file_url TEXT NOT NULL,
      file_name TEXT,
      season_name TEXT,
      episode_label TEXT,
      position REAL DEFAULT 0,
      duration REAL DEFAULT 0,
      completed INTEGER DEFAULT 0,
      updated_at INTEGER NOT NULL,
      UNIQUE(device_id, file_url)
    );
    INSERT OR IGNORE INTO watch_history_v2 (device_id, media_id, file_url, file_name, season_name, episode_label, position, duration, completed, updated_at)
    SELECT 'default', media_id, file_url, file_name, season_name, episode_label, position, duration, completed, updated_at FROM watch_history;
    DROP TABLE watch_history;
    ALTER TABLE watch_history_v2 RENAME TO watch_history;
    COMMIT;
  `);
}
const wlCols = new Set(db.prepare("PRAGMA table_info(watchlist)").all().map((c) => c.name));
if (!wlCols.has("device_id")) {
  db.exec(`
    BEGIN;
    CREATE TABLE watchlist_v2 (
      device_id TEXT NOT NULL DEFAULT 'default',
      media_id INTEGER NOT NULL REFERENCES media_items(id) ON DELETE CASCADE,
      added_at INTEGER NOT NULL,
      PRIMARY KEY (device_id, media_id)
    );
    INSERT OR IGNORE INTO watchlist_v2 (device_id, media_id, added_at)
    SELECT 'default', media_id, added_at FROM watchlist;
    DROP TABLE watchlist;
    ALTER TABLE watchlist_v2 RENAME TO watchlist;
    COMMIT;
  `);
}
db.exec(`
  CREATE INDEX IF NOT EXISTS idx_history_device_updated ON watch_history(device_id, updated_at DESC);
  CREATE INDEX IF NOT EXISTS idx_history_media ON watch_history(media_id);
  CREATE INDEX IF NOT EXISTS idx_watchlist_device ON watchlist(device_id, added_at DESC);
`);

// Safe online schema migration for existing CineVault databases (preserves all watchlist & watch history!)
const existingCols = new Set(db.prepare("PRAGMA table_info(media_items)").all().map((c) => c.name));
const migrations = [
  ["discovered_at", "INTEGER DEFAULT 0"],
  ["source", "TEXT NOT NULL DEFAULT 'dhakaflix'"],
  ["source_id", "TEXT"],
  ["quality_score", "INTEGER DEFAULT 0"],
  ["is_primary", "INTEGER DEFAULT 1"],
  ["canonical_id", "INTEGER"],
  ["categories_all", "TEXT"],
  ["season_hint", "TEXT"],
];
for (const [col, def] of migrations) {
  if (!existingCols.has(col)) {
    db.exec(`ALTER TABLE media_items ADD COLUMN ${col} ${def}`);
  }
}

db.exec(`
  CREATE INDEX IF NOT EXISTS idx_media_category ON media_items(category);
  CREATE INDEX IF NOT EXISTS idx_media_type ON media_items(media_type);
  CREATE INDEX IF NOT EXISTS idx_media_year ON media_items(year DESC);
  CREATE INDEX IF NOT EXISTS idx_media_modified ON media_items(modified_at DESC);
  CREATE INDEX IF NOT EXISTS idx_media_clean_title ON media_items(clean_title);
  CREATE INDEX IF NOT EXISTS idx_media_imdb_rank ON media_items(imdb_rank ASC);
  CREATE INDEX IF NOT EXISTS idx_media_quality ON media_items(quality);
  CREATE INDEX IF NOT EXISTS idx_media_primary ON media_items(is_primary);
  CREATE INDEX IF NOT EXISTS idx_media_canonical ON media_items(canonical_id);
  CREATE INDEX IF NOT EXISTS idx_media_source ON media_items(source);
`);

// Backfill quality_score & clean_title on existing rows if upgrading from v1
const needsScoreBackfill = db.prepare("SELECT COUNT(*) as c FROM media_items WHERE quality_score = 0").get().c;
if (needsScoreBackfill > 0) {
  const rows = db.prepare("SELECT id, title, raw_name, quality, source_tag, audio_tags, imdb_rank, year, source, media_type, season_hint FROM media_items WHERE quality_score = 0").all();
  const upd = db.prepare("UPDATE media_items SET quality_score = ?, clean_title = ? WHERE id = ?");
  db.exec("BEGIN");
  try {
    for (const r of rows) {
      const qs = computeQualityScore({
        quality: r.quality,
        sourceTag: r.source_tag,
        audioTags: r.audio_tags,
        imdbRank: r.imdb_rank,
        year: r.year,
        source: r.source || "dhakaflix",
        mediaType: r.media_type,
        seasonHint: r.season_hint,
        rawName: r.raw_name,
      });
      upd.run(qs, normalizeTitleForMatch(r.title), r.id);
    }
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

// Enable FTS5 full-text search
let hasFts5 = false;
try {
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS media_fts USING fts5(
      title,
      raw_name,
      sub_group,
      language_tag,
      audio_tags,
      category,
      content='media_items',
      content_rowid='id',
      tokenize='unicode61 remove_diacritics 2'
    );

    CREATE TRIGGER IF NOT EXISTS media_items_ai AFTER INSERT ON media_items BEGIN
      INSERT INTO media_fts(rowid, title, raw_name, sub_group, language_tag, audio_tags, category)
      VALUES (new.id, new.title, new.raw_name, coalesce(new.sub_group,''), coalesce(new.language_tag,''), coalesce(new.audio_tags,''), new.category);
    END;

    CREATE TRIGGER IF NOT EXISTS media_items_ad AFTER DELETE ON media_items BEGIN
      INSERT INTO media_fts(media_fts, rowid, title, raw_name, sub_group, language_tag, audio_tags, category)
      VALUES ('delete', old.id, old.title, old.raw_name, coalesce(old.sub_group,''), coalesce(old.language_tag,''), coalesce(old.audio_tags,''), old.category);
    END;

    CREATE TRIGGER IF NOT EXISTS media_items_au AFTER UPDATE OF title, raw_name, sub_group, language_tag, audio_tags, category ON media_items BEGIN
      INSERT INTO media_fts(media_fts, rowid, title, raw_name, sub_group, language_tag, audio_tags, category)
      VALUES ('delete', old.id, old.title, old.raw_name, coalesce(old.sub_group,''), coalesce(old.language_tag,''), coalesce(old.audio_tags,''), old.category);
      INSERT INTO media_fts(rowid, title, raw_name, sub_group, language_tag, audio_tags, category)
      VALUES (new.id, new.title, new.raw_name, coalesce(new.sub_group,''), coalesce(new.language_tag,''), coalesce(new.audio_tags,''), new.category);
    END;
  `);
  hasFts5 = true;
} catch (err) {
  console.warn("[db] FTS5 unavailable, using LIKE search fallback:", err.message);
}

const stmtUpsert = db.prepare(`
  INSERT INTO media_items (
    url, origin, href, category, media_type, sub_group,
    raw_name, title, clean_title, year, quality, audio_tags,
    source_tag, language_tag, imdb_rank, modified_at,
    poster_url, discovered_at, source, source_id, quality_score,
    season_hint, categories_all
  ) VALUES (
    @url, @origin, @href, @category, @media_type, @sub_group,
    @raw_name, @title, @clean_title, @year, @quality, @audio_tags,
    @source_tag, @language_tag, @imdb_rank, @modified_at,
    @poster_url, @discovered_at, @source, @source_id, @quality_score,
    @season_hint, @categories_all
  )
  ON CONFLICT(url) DO UPDATE SET
    category = CASE
      WHEN excluded.quality_score >= media_items.quality_score THEN excluded.category
      ELSE media_items.category
    END,
    media_type = excluded.media_type,
    sub_group = COALESCE(excluded.sub_group, media_items.sub_group),
    raw_name = excluded.raw_name,
    title = excluded.title,
    clean_title = excluded.clean_title,
    year = COALESCE(excluded.year, media_items.year),
    quality = COALESCE(excluded.quality, media_items.quality),
    audio_tags = COALESCE(excluded.audio_tags, media_items.audio_tags),
    source_tag = COALESCE(excluded.source_tag, media_items.source_tag),
    language_tag = COALESCE(excluded.language_tag, media_items.language_tag),
    imdb_rank = COALESCE(excluded.imdb_rank, media_items.imdb_rank),
    poster_url = COALESCE(media_items.poster_url, excluded.poster_url),
    quality_score = MAX(media_items.quality_score, excluded.quality_score),
    season_hint = COALESCE(excluded.season_hint, media_items.season_hint),
    modified_at = CASE WHEN excluded.modified_at > media_items.modified_at THEN excluded.modified_at ELSE media_items.modified_at END
`);

let cachedStats = null;
let statsBuiltAt = 0;

export function invalidateStatsCache() {
  cachedStats = null;
}

/**
 * Load all existing URLs + modified_at + quality_score once at sync start
 * so unchanged rows skip SQLite writes & FTS5 trigger work completely!
 */
export function loadExistingUrlIndex() {
  const map = new Map();
  const rows = db.prepare("SELECT url, modified_at, quality_score FROM media_items").all();
  for (const r of rows) {
    map.set(r.url, { m: r.modified_at || 0, q: r.quality_score || 0 });
  }
  return map;
}

export function upsertMediaBatch(items, existingUrlMap = null) {
  if (!items || items.length === 0) return { processed: 0, newlyAdded: 0, written: 0 };
  const now = Date.now();
  let newlyAdded = 0;
  let written = 0;

  const toWrite = [];
  if (existingUrlMap) {
    for (const item of items) {
      const prev = existingUrlMap.get(item.url);
      if (!prev) {
        newlyAdded++;
        toWrite.push(item);
        existingUrlMap.set(item.url, { m: item.modified_at || 0, q: item.quality_score || 0 });
      } else if ((item.modified_at || 0) > prev.m || (item.quality_score || 0) > prev.q) {
        toWrite.push(item);
        existingUrlMap.set(item.url, {
          m: Math.max(prev.m, item.modified_at || 0),
          q: Math.max(prev.q, item.quality_score || 0),
        });
      }
    }
  } else {
    const stmtCheck = db.prepare("SELECT id FROM media_items WHERE url = ?");
    for (const item of items) {
      if (!stmtCheck.get(item.url)) newlyAdded++;
      toWrite.push(item);
    }
  }

  if (toWrite.length === 0) {
    return { processed: items.length, newlyAdded: 0, written: 0 };
  }

  db.exec("BEGIN");
  try {
    for (const item of toWrite) {
      stmtUpsert.run({
        poster_url: null,
        source: "dhakaflix",
        source_id: null,
        quality_score: 0,
        season_hint: null,
        categories_all: `,${item.category},`,
        ...item,
        discovered_at: now,
      });
      written++;
    }
    db.exec("COMMIT");
    invalidateStatsCache();
    return { processed: items.length, newlyAdded, written };
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

/**
 * GLOBAL ZERO-DUPLICATE, HIGHEST-QUALITY MERGE ENGINE
 *
 * Groups every movie & TV series across ALL servers (DhakaFlix + ICC FTP):
 * - Movies with same clean_title + compatible year (within 1 year or unknown year) merge into ONE canonical entry.
 * - TV series with same clean_title merge into ONE canonical entry (even if ICC listed Season 1, 2, 3 separately!).
 * - The entry with the HIGHEST `quality_score` (4K > 3D > 1080p > 720p > 480p; BluRay/WEB-DL > CAMRip) becomes `is_primary = 1`.
 * - Lower-quality duplicates become `is_primary = 0` with `canonical_id = winner.id` (hidden from all grids/search, preserved as backup mirrors/seasons!).
 * - Metadata (year, imdb_rank, categories_all, latest modified_at) is merged onto the winner so nothing is lost.
 * - Any watchlist entry pointing to a demoted duplicate is migrated to the winning higher-quality primary!
 */
export function runDeduplication() {
  const t0 = Date.now();
  const rows = db.prepare(`
    SELECT id, media_type, clean_title, year, category, quality_score, imdb_rank,
           modified_at, audio_tags, language_tag, source, season_hint,
           is_primary, canonical_id, categories_all
    FROM media_items
    ORDER BY media_type, clean_title, quality_score DESC, modified_at DESC, id ASC
  `).all();

  const watchlistIds = new Set(db.prepare("SELECT media_id FROM watchlist").all().map((r) => r.media_id));

  // Partition rows by (media_type + clean_title)
  const byTitle = new Map();
  for (const r of rows) {
    const key = `${r.media_type}::${r.clean_title}`;
    let list = byTitle.get(key);
    if (!list) {
      list = [];
      byTitle.set(key, list);
    }
    list.push(r);
  }

  const stmtUpdatePrimary = db.prepare(`
    UPDATE media_items
    SET is_primary = 1,
        canonical_id = id,
        categories_all = ?,
        year = COALESCE(year, ?),
        imdb_rank = COALESCE(imdb_rank, ?),
        language_tag = COALESCE(language_tag, ?),
        modified_at = MAX(modified_at, ?)
    WHERE id = ?
  `);

  const stmtUpdateDup = db.prepare(`
    UPDATE media_items
    SET is_primary = 0,
        canonical_id = ?
    WHERE id = ?
  `);

  const stmtMigrateWatchlist = db.prepare(`
    INSERT OR IGNORE INTO watchlist(device_id, media_id, added_at)
    SELECT device_id, ?, added_at FROM watchlist WHERE media_id = ?
  `);
  const stmtDeleteOldWatchlist = db.prepare(`DELETE FROM watchlist WHERE media_id = ?`);

  let primaryCount = 0;
  let duplicateCount = 0;
  let writes = 0;

  db.exec("BEGIN");
  try {
    for (const groupRows of byTitle.values()) {
      const clusters = buildCompatibleClusters(groupRows);

      for (const cluster of clusters) {
        cluster.sort((a, b) => {
          if (b.quality_score !== a.quality_score) return b.quality_score - a.quality_score;
          if ((b.modified_at || 0) !== (a.modified_at || 0)) return (b.modified_at || 0) - (a.modified_at || 0);
          return a.id - b.id;
        });

        const winner = cluster[0];
        primaryCount++;

        const cats = new Set();
        let bestYear = winner.year;
        let bestImdb = winner.imdb_rank;
        let bestLang = winner.language_tag;
        let maxMod = winner.modified_at || 0;

        for (const item of cluster) {
          cats.add(item.category);
          if (!bestYear && item.year) bestYear = item.year;
          if (item.imdb_rank && (!bestImdb || item.imdb_rank < bestImdb)) bestImdb = item.imdb_rank;
          if (!bestLang && item.language_tag) bestLang = item.language_tag;
          if ((item.modified_at || 0) > maxMod) maxMod = item.modified_at;
        }

        const categoriesAll = `,${[...cats].sort().join(",")},`;
        const primaryChanged =
          winner.is_primary !== 1 ||
          winner.canonical_id !== winner.id ||
          winner.categories_all !== categoriesAll ||
          (bestYear && winner.year !== bestYear) ||
          (bestImdb && winner.imdb_rank !== bestImdb) ||
          (bestLang && winner.language_tag !== bestLang) ||
          maxMod > (winner.modified_at || 0);

        if (primaryChanged) {
          stmtUpdatePrimary.run(categoriesAll, bestYear ?? null, bestImdb ?? null, bestLang ?? null, maxMod, winner.id);
          writes++;
        }

        for (let i = 1; i < cluster.length; i++) {
          const dup = cluster[i];
          duplicateCount++;
          if (dup.is_primary !== 0 || dup.canonical_id !== winner.id) {
            stmtUpdateDup.run(winner.id, dup.id);
            writes++;
          }
          if (watchlistIds.has(dup.id)) {
            stmtMigrateWatchlist.run(winner.id, dup.id);
            stmtDeleteOldWatchlist.run(dup.id);
            watchlistIds.delete(dup.id);
            watchlistIds.add(winner.id);
          }
        }
      }
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }

  const elapsedMs = Date.now() - t0;
  invalidateStatsCache();
  setSyncState("last_dedup_stats", JSON.stringify({ totalRaw: rows.length, unique: primaryCount, duplicatesHidden: duplicateCount, writes, elapsedMs }));
  console.log(`[dedup] Merged ${rows.length} raw entries -> ${primaryCount} unique highest-quality titles (${duplicateCount} duplicates merged, ${writes} updated) in ${elapsedMs}ms`);
  return { totalRaw: rows.length, unique: primaryCount, duplicatesHidden: duplicateCount, writes, elapsedMs };
}

function buildCompatibleClusters(groupRows) {
  if (groupRows.length <= 1) return [groupRows];
  const isSeries = groupRows[0].media_type === "series";
  // For TV series, merge all seasons/mirrors of the same show title into 1 unified show entry!
  if (isSeries) return [groupRows];

  // For movies: cluster entries with known years (gap <= 1 yr), then attach year-less entries (like ICC "Inception (4K)")
  const withYear = groupRows.filter((r) => r.year);
  const withoutYear = groupRows.filter((r) => !r.year);

  const clusters = [];
  for (const r of withYear) {
    const match = clusters.find((cl) => cl.some((x) => x.year && Math.abs(x.year - r.year) <= 1));
    if (match) match.push(r);
    else clusters.push([r]);
  }

  if (clusters.length === 0) {
    return [withoutYear];
  }

  // Attach year-less items to the most relevant cluster (latest remake or single match)
  clusters.sort((a, b) => {
    const ya = Math.max(...a.map((x) => x.year || 0));
    const yb = Math.max(...b.map((x) => x.year || 0));
    return yb - ya;
  });

  for (const r of withoutYear) {
    // If publish date is known and close to a specific remake year, prefer that cluster
    const pubYear = r.modified_at ? new Date(r.modified_at).getUTCFullYear() : null;
    const matchByPub = pubYear
      ? clusters.find((cl) => cl.some((x) => x.year && Math.abs(x.year - pubYear) <= 1))
      : null;
    (matchByPub || clusters[0]).push(r);
  }

  return clusters;
}

export function getSyncState(key) {
  const row = db.prepare("SELECT value FROM sync_state WHERE key = ?").get(key);
  return row ? row.value : null;
}

export function setSyncState(key, value) {
  db.prepare("INSERT INTO sync_state(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, String(value));
}

export function getItemById(id) {
  return db.prepare("SELECT * FROM media_items WHERE id = ?").get(Number(id));
}

export function getItemByUrl(url) {
  return db.prepare("SELECT * FROM media_items WHERE url = ?").get(url);
}

export function updateItemHydration(id, { posterUrl, posterChecked, filesJson, seasonsJson, totalSize, year = null }) {
  db.prepare(`
    UPDATE media_items
    SET poster_url = COALESCE(?, poster_url),
        poster_checked = ?,
        files_json = COALESCE(?, files_json),
        seasons_json = COALESCE(?, seasons_json),
        total_size = COALESCE(?, total_size),
        year = COALESCE(year, ?),
        hydrated_at = ?
    WHERE id = ?
  `).run(
    posterUrl ?? null,
    posterChecked ?? 1,
    filesJson ?? null,
    seasonsJson ?? null,
    totalSize ?? 0,
    year ?? null,
    Date.now(),
    Number(id)
  );
}

export function updateItemMetadata(id, metaObj, fallbackPoster = null) {
  db.prepare(`
    UPDATE media_items
    SET meta_json = ?,
        meta_checked = 1,
        poster_url = CASE WHEN (poster_url IS NULL OR poster_url = '') AND ? IS NOT NULL THEN ? ELSE poster_url END
    WHERE id = ?
  `).run(JSON.stringify(metaObj), fallbackPoster, fallbackPoster, Number(id));
}

/**
 * Return all deduplicated alternate copies / server mirrors linked to the same canonical title!
 */
export function getMergedMirrors(item) {
  if (!item) return [];
  const canonId = item.canonical_id || item.id;
  return db.prepare(`
    SELECT id, title, raw_name, category, media_type, year, quality, audio_tags,
           source_tag, language_tag, imdb_rank, url, source, source_id,
           quality_score, season_hint, is_primary
    FROM media_items
    WHERE canonical_id = ? AND id != ?
    ORDER BY quality_score DESC, season_hint ASC, id ASC
    LIMIT 25
  `).all(canonId, item.id);
}

export function getLibraryStats(force = false) {
  if (!force && cachedStats && Date.now() - statsBuiltAt < 15000) {
    return cachedStats;
  }

  const totalRaw = db.prepare("SELECT COUNT(*) as c FROM media_items").get().c;
  const rows = db
    .prepare("SELECT category, categories_all, media_type, source, year, language_tag FROM media_items WHERE is_primary = 1")
    .all();

  let movies = 0;
  let series = 0;
  const bySource = {};
  const byCategory = {};
  for (const catId of CATEGORY_MAP.keys()) byCategory[catId] = 0;
  const yearSet = new Set();
  const langCounts = {};

  for (const r of rows) {
    if (r.media_type === "series") series++;
    else movies++;

    bySource[r.source] = (bySource[r.source] || 0) + 1;
    if (r.year && r.year >= 1920 && r.year <= 2030) yearSet.add(r.year);
    if (r.language_tag) langCounts[r.language_tag] = (langCounts[r.language_tag] || 0) + 1;

    if (r.categories_all) {
      const parts = r.categories_all.split(",");
      for (let i = 1; i < parts.length - 1; i++) {
        const c = parts[i];
        if (c in byCategory) byCategory[c]++;
      }
    } else if (r.category in byCategory) {
      byCategory[r.category]++;
    }
  }

  const total = rows.length;
  const languages = Object.entries(langCounts)
    .filter(([, cnt]) => cnt >= 15)
    .sort((a, b) => b[1] - a[1])
    .map(([lang, count]) => ({ lang, count }));

  cachedStats = {
    total,
    totalRaw,
    duplicatesMerged: Math.max(0, totalRaw - total),
    movies,
    series,
    bySource,
    byCategory,
    years: [...yearSet].sort((a, b) => b - a),
    languages,
    lastSync: getSyncState("last_sync_at"),
  };
  statsBuiltAt = Date.now();
  return cachedStats;
}

export function normalizeDeviceId(raw) {
  const s = String(raw || "").trim();
  return /^[a-zA-Z0-9_-]{8,64}$/.test(s) ? s : "default";
}

export function queryItems({
  q = "",
  category = "",
  group = "",
  mediaType = "",
  year = "",
  quality = "",
  audio = "",
  language = "",
  source = "",
  sort = "recent",
  page = 1,
  limit = 36,
  deviceId = "default",
} = {}) {
  const safeDevice = normalizeDeviceId(deviceId);
  const where = ["m.is_primary = 1"];
  const params = [];
  let fromSql = "FROM media_items m";

  const trimmedQ = (q || "").trim();
  if (trimmedQ) {
    if (hasFts5) {
      const tokens = trimmedQ
        .replace(/["'*():^~-]/g, " ")
        .split(/\s+/)
        .filter((t) => t.length > 0)
        .slice(0, 8);
      if (tokens.length > 0) {
        const ftsExpr = tokens.map((t) => `"${t}"*`).join(" AND ");
        fromSql = "FROM media_fts f JOIN media_items m ON m.id = f.rowid";
        where.push("media_fts MATCH ?");
        params.push(ftsExpr);
      }
    } else {
      where.push("(m.title LIKE ? OR m.raw_name LIKE ? OR m.sub_group LIKE ?)");
      const like = `%${trimmedQ}%`;
      params.push(like, like, like);
    }
  }

  if (category) {
    const cats = category.split(",").map((s) => s.trim()).filter(Boolean);
    if (cats.length === 1) {
      where.push("(m.category = ? OR m.categories_all LIKE ?)");
      params.push(cats[0], `%,${cats[0]},%`);
    } else if (cats.length > 1) {
      const clauses = cats.map(() => "(m.category = ? OR m.categories_all LIKE ?)");
      where.push(`(${clauses.join(" OR ")})`);
      for (const c of cats) {
        params.push(c, `%,${c},%`);
      }
    }
  }

  if (group === "movies") {
    where.push("m.media_type = 'movie'");
  } else if (group === "series") {
    where.push("m.media_type = 'series'");
  }

  if (mediaType) {
    where.push("m.media_type = ?");
    params.push(mediaType);
  }

  if (year) {
    where.push("m.year = ?");
    params.push(Number(year));
  }

  if (quality) {
    where.push("m.quality = ?");
    params.push(quality);
  }

  if (source) {
    where.push("m.source = ?");
    params.push(source);
  }

  if (language) {
    where.push("LOWER(m.language_tag) = LOWER(?)");
    params.push(language);
  }

  if (audio === "dual") {
    where.push("m.audio_tags LIKE '%Dual%'");
  } else if (audio === "multi") {
    where.push("m.audio_tags LIKE '%Multi%'");
  } else if (audio === "hindi-dubbed") {
    where.push("m.audio_tags LIKE '%Hindi Dubbed%'");
  }

  const whereSql = `WHERE ${where.join(" AND ")}`;

  let orderSql = "ORDER BY m.modified_at DESC, COALESCE(m.year, 0) DESC, m.quality_score DESC, m.id DESC";
  if (sort === "year") orderSql = "ORDER BY COALESCE(m.year, 0) DESC, m.modified_at DESC, m.quality_score DESC";
  else if (sort === "quality") orderSql = "ORDER BY m.quality_score DESC, m.modified_at DESC, COALESCE(m.year, 0) DESC";
  else if (sort === "title") orderSql = "ORDER BY m.title COLLATE NOCASE ASC";
  else if (sort === "imdb") orderSql = "ORDER BY CASE WHEN m.imdb_rank IS NULL THEN 9999 ELSE m.imdb_rank END ASC, m.quality_score DESC";
  else if (sort === "oldest") orderSql = "ORDER BY COALESCE(m.year, 9999) ASC, m.title COLLATE NOCASE ASC";
  else if (trimmedQ && hasFts5 && sort === "relevance") orderSql = "ORDER BY bm25(media_fts), m.modified_at DESC, m.quality_score DESC";

  const safeLimit = Math.min(Math.max(Number(limit) || 36, 1), 120);
  const safePage = Math.max(Number(page) || 1, 1);
  const offset = (safePage - 1) * safeLimit;

  const totalRow = db.prepare(`SELECT COUNT(*) as total ${fromSql} ${whereSql}`).get(...params);
  const rows = db.prepare(`
    SELECT m.id, m.url, m.category, m.media_type, m.sub_group, m.title, m.raw_name,
           m.year, m.quality, m.audio_tags, m.source_tag, m.language_tag,
           m.imdb_rank, m.modified_at, m.poster_url, m.poster_checked,
           m.source, m.quality_score,
           EXISTS(SELECT 1 FROM watchlist w WHERE w.device_id = ? AND w.media_id = m.id) AS in_watchlist
    ${fromSql}
    ${whereSql}
    ${orderSql}
    LIMIT ? OFFSET ?
  `).all(safeDevice, ...params, safeLimit, offset);

  return {
    items: rows,
    total: totalRow.total,
    page: safePage,
    limit: safeLimit,
    totalPages: Math.ceil(totalRow.total / safeLimit),
  };
}

// Per-device Watchlist operations
export function toggleWatchlist(mediaId, deviceId = "default") {
  const safeDevice = normalizeDeviceId(deviceId);
  const item = getItemById(mediaId);
  const id = item?.canonical_id || Number(mediaId);
  const existing = db.prepare("SELECT media_id FROM watchlist WHERE device_id = ? AND media_id = ?").get(safeDevice, id);
  if (existing) {
    db.prepare("DELETE FROM watchlist WHERE device_id = ? AND media_id = ?").run(safeDevice, id);
    return { inWatchlist: false };
  }
  db.prepare("INSERT OR REPLACE INTO watchlist(device_id, media_id, added_at) VALUES (?, ?, ?)").run(safeDevice, id, Date.now());
  return { inWatchlist: true };
}

export function getWatchlist(deviceId = "default") {
  const safeDevice = normalizeDeviceId(deviceId);
  return db.prepare(`
    SELECT m.id, m.url, m.category, m.media_type, m.sub_group, m.title, m.raw_name,
           m.year, m.quality, m.audio_tags, m.source_tag, m.language_tag,
           m.imdb_rank, m.modified_at, m.poster_url, m.source, 1 AS in_watchlist, w.added_at
    FROM watchlist w
    JOIN media_items m ON m.id = w.media_id
    WHERE w.device_id = ?
    ORDER BY w.added_at DESC
  `).all(safeDevice);
}

export function removeFromWatchlist(mediaId, deviceId = "default") {
  const safeDevice = normalizeDeviceId(deviceId);
  const item = getItemById(mediaId);
  const canonId = item?.canonical_id || Number(mediaId);
  db.prepare(`
    DELETE FROM watchlist
    WHERE device_id = ? AND (media_id = ? OR media_id IN (SELECT id FROM media_items WHERE canonical_id = ?))
  `).run(safeDevice, Number(mediaId), canonId);
  return { ok: true };
}

export function clearWatchlist(deviceId = "default") {
  const safeDevice = normalizeDeviceId(deviceId);
  db.prepare("DELETE FROM watchlist WHERE device_id = ?").run(safeDevice);
  return { ok: true };
}

// Per-device Watch history / Continue Watching
export function upsertWatchProgress({ mediaId, fileUrl, fileName, seasonName, episodeLabel, position, duration, deviceId = "default" }) {
  const safeDevice = normalizeDeviceId(deviceId);
  const pos = Math.max(0, Number(position) || 0);
  const dur = Math.max(0, Number(duration) || 0);
  const completed = dur > 60 && pos / dur >= 0.92 ? 1 : 0;
  db.prepare(`
    INSERT INTO watch_history (device_id, media_id, file_url, file_name, season_name, episode_label, position, duration, completed, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(device_id, file_url) DO UPDATE SET
      position = excluded.position,
      duration = CASE WHEN excluded.duration > 0 THEN excluded.duration ELSE watch_history.duration END,
      completed = excluded.completed,
      updated_at = excluded.updated_at
  `).run(
    safeDevice,
    Number(mediaId),
    fileUrl,
    fileName || null,
    seasonName || null,
    episodeLabel || null,
    pos,
    dur,
    completed,
    Date.now()
  );
  return { ok: true, completed };
}

export function getContinueWatching(limit = 20, deviceId = "default") {
  const safeDevice = normalizeDeviceId(deviceId);
  const rows = db.prepare(`
    SELECT h.id AS history_id, h.file_url, h.file_name, h.season_name, h.episode_label,
           h.position, h.duration, h.completed, h.updated_at,
           COALESCE(p.id, m.id) AS id,
           COALESCE(p.url, m.url) AS url,
           COALESCE(p.category, m.category) AS category,
           COALESCE(p.media_type, m.media_type) AS media_type,
           COALESCE(p.title, m.title) AS title,
           COALESCE(p.year, m.year) AS year,
           COALESCE(p.quality, m.quality) AS quality,
           COALESCE(p.audio_tags, m.audio_tags) AS audio_tags,
           COALESCE(p.source_tag, m.source_tag) AS source_tag,
           COALESCE(p.language_tag, m.language_tag) AS language_tag,
           COALESCE(p.imdb_rank, m.imdb_rank) AS imdb_rank,
           COALESCE(p.poster_url, m.poster_url) AS poster_url,
           COALESCE(p.source, m.source) AS source,
           COALESCE(m.canonical_id, m.id) AS canon_key
    FROM watch_history h
    JOIN media_items m ON m.id = h.media_id
    LEFT JOIN media_items p ON p.id = m.canonical_id
    WHERE h.device_id = ? AND h.position > 5
    ORDER BY h.updated_at DESC
    LIMIT 100
  `).all(safeDevice);

  const seen = new Set();
  const deduped = [];
  for (const r of rows) {
    if (seen.has(r.canon_key)) continue;
    seen.add(r.canon_key);
    deduped.push(r);
    if (deduped.length >= limit) break;
  }
  return deduped;
}

export function getItemWatchHistory(mediaId, deviceId = "default") {
  const safeDevice = normalizeDeviceId(deviceId);
  const item = getItemById(mediaId);
  const canonId = item?.canonical_id || Number(mediaId);
  return db.prepare(`
    SELECT h.file_url, h.file_name, h.season_name, h.episode_label, h.position, h.duration, h.completed, h.updated_at
    FROM watch_history h
    JOIN media_items m ON m.id = h.media_id
    WHERE h.device_id = ? AND (m.id = ? OR m.canonical_id = ?)
    ORDER BY h.updated_at DESC
  `).all(safeDevice, Number(mediaId), canonId);
}

export function removeWatchHistory(fileUrl, deviceId = "default") {
  const safeDevice = normalizeDeviceId(deviceId);
  db.prepare("DELETE FROM watch_history WHERE device_id = ? AND file_url = ?").run(safeDevice, fileUrl);
}

export function removeMediaWatchHistory(mediaId, deviceId = "default") {
  const safeDevice = normalizeDeviceId(deviceId);
  const item = getItemById(mediaId);
  const canonId = item?.canonical_id || Number(mediaId);
  db.prepare(`
    DELETE FROM watch_history
    WHERE device_id = ? AND (media_id = ? OR media_id IN (SELECT id FROM media_items WHERE canonical_id = ?))
  `).run(safeDevice, Number(mediaId), canonId);
  return { ok: true };
}

export function clearWatchHistory(deviceId = "default") {
  const safeDevice = normalizeDeviceId(deviceId);
  db.prepare("DELETE FROM watch_history WHERE device_id = ?").run(safeDevice);
  return { ok: true };
}

export function getRecentlyWatchedSeriesIds(limit = 12) {
  return db.prepare(`
    SELECT DISTINCT m.id
    FROM watch_history h
    JOIN media_items m ON m.id = h.media_id
    WHERE m.media_type = 'series'
    ORDER BY h.updated_at DESC
    LIMIT ?
  `).all(limit).map((r) => r.id);
}
