import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { DATA_DIR, DB_PATH, CATEGORY_MAP, SERVERS, setDynamicServerRegistry, isSafeServerUrl, normalizeServerInputUrl } from "./config.js";
import { computeQualityScore, normalizeTitleForMatch } from "./parser.js";

fs.mkdirSync(DATA_DIR, { recursive: true });

export const db = new DatabaseSync(DB_PATH);

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;
  PRAGMA busy_timeout = 5000;
  PRAGMA temp_store = MEMORY;
  PRAGMA cache_size = -64000;
  PRAGMA mmap_size = 268435456;
  PRAGMA wal_autocheckpoint = 2000;
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

  CREATE TABLE IF NOT EXISTS servers (
    id TEXT PRIMARY KEY,
    source TEXT NOT NULL,
    name TEXT NOT NULL,
    adapter TEXT NOT NULL DEFAULT 'directory',
    origin TEXT NOT NULL,
    root_href TEXT NOT NULL DEFAULT '/',
    ping_href TEXT,
    enabled INTEGER NOT NULL DEFAULT 1,
    is_builtin INTEGER NOT NULL DEFAULT 0,
    optional INTEGER NOT NULL DEFAULT 0,
    ping_timeout_ms INTEGER NOT NULL DEFAULT 5500,
    folders_json TEXT,
    created_at INTEGER NOT NULL DEFAULT 0
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
  CREATE TABLE IF NOT EXISTS media_categories (
    category TEXT NOT NULL,
    media_id INTEGER NOT NULL REFERENCES media_items(id) ON DELETE CASCADE,
    modified_at INTEGER NOT NULL DEFAULT 0,
    year INTEGER NOT NULL DEFAULT 0,
    quality_score INTEGER NOT NULL DEFAULT 0,
    imdb_rank INTEGER,
    PRIMARY KEY (category, media_id)
  ) WITHOUT ROWID;

  CREATE INDEX IF NOT EXISTS idx_mc_cat_recent ON media_categories(category, modified_at DESC, year DESC, quality_score DESC, media_id DESC);
  CREATE INDEX IF NOT EXISTS idx_mc_cat_imdb ON media_categories(category, imdb_rank ASC, quality_score DESC, media_id DESC);
  CREATE INDEX IF NOT EXISTS idx_mc_media_id ON media_categories(media_id);

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

  CREATE INDEX IF NOT EXISTS idx_primary_recent ON media_items(modified_at DESC, year DESC, quality_score DESC, id DESC) WHERE is_primary = 1;
  CREATE INDEX IF NOT EXISTS idx_primary_type_recent ON media_items(media_type, modified_at DESC, year DESC, quality_score DESC, id DESC) WHERE is_primary = 1;
  CREATE INDEX IF NOT EXISTS idx_primary_type_year_recent ON media_items(media_type, year DESC, modified_at DESC, quality_score DESC, id DESC) WHERE is_primary = 1;
  CREATE INDEX IF NOT EXISTS idx_primary_year_recent ON media_items(year DESC, modified_at DESC, quality_score DESC, id DESC) WHERE is_primary = 1;
  CREATE INDEX IF NOT EXISTS idx_primary_quality_recent ON media_items(quality, modified_at DESC, quality_score DESC) WHERE is_primary = 1;
  CREATE INDEX IF NOT EXISTS idx_primary_source_recent ON media_items(source, modified_at DESC, quality_score DESC) WHERE is_primary = 1;
  CREATE INDEX IF NOT EXISTS idx_primary_score_recent ON media_items(quality_score DESC, modified_at DESC, year DESC) WHERE is_primary = 1;
  CREATE INDEX IF NOT EXISTS idx_primary_title ON media_items(title COLLATE NOCASE ASC) WHERE is_primary = 1;
  CREATE INDEX IF NOT EXISTS idx_primary_imdb ON media_items(imdb_rank ASC, quality_score DESC) WHERE is_primary = 1 AND imdb_rank IS NOT NULL;
  CREATE INDEX IF NOT EXISTS idx_primary_lang ON media_items(language_tag COLLATE NOCASE, modified_at DESC) WHERE is_primary = 1 AND language_tag IS NOT NULL;
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
let catalogVersion = 1;
const searchFacetCache = new Map(); // cacheKey -> { ver, facets }

export function getCatalogVersion() {
  return catalogVersion;
}

export function invalidateStatsCache() {
  cachedStats = null;
  searchFacetCache.clear();
  catalogVersion++;
}

const stmtUpsertMediaCat = db.prepare(`
  INSERT OR REPLACE INTO media_categories(category, media_id, modified_at, year, quality_score, imdb_rank)
  VALUES (?, ?, ?, ?, ?, ?)
`);

const stmtSyncPrimaryCatByUrl = db.prepare(`
  INSERT OR REPLACE INTO media_categories(category, media_id, modified_at, year, quality_score, imdb_rank)
  SELECT category, id, COALESCE(modified_at, 0), COALESCE(year, 0), COALESCE(quality_score, 0), imdb_rank
  FROM media_items
  WHERE url = ? AND is_primary = 1
`);

/**
 * Rebuild covering media_categories table from primary media_items rows.
 * Enables <1ms category browse & Home section queries with zero LIKE full-table scans.
 */
export function rebuildMediaCategories() {
  const t0 = Date.now();
  const rows = db.prepare(`
    SELECT id, category, categories_all, modified_at, year, quality_score, imdb_rank
    FROM media_items
    WHERE is_primary = 1
  `).all();

  db.exec("BEGIN");
  try {
    db.exec("DELETE FROM media_categories");
    for (const r of rows) {
      const mod = r.modified_at || 0;
      const yr = r.year || 0;
      const qs = r.quality_score || 0;
      const rank = r.imdb_rank ?? null;
      if (r.categories_all) {
        const parts = r.categories_all.split(",");
        let inserted = false;
        for (let i = 1; i < parts.length - 1; i++) {
          const c = parts[i];
          if (c) {
            stmtUpsertMediaCat.run(c, r.id, mod, yr, qs, rank);
            inserted = true;
          }
        }
        if (!inserted && r.category) {
          stmtUpsertMediaCat.run(r.category, r.id, mod, yr, qs, rank);
        }
      } else if (r.category) {
        stmtUpsertMediaCat.run(r.category, r.id, mod, yr, qs, rank);
      }
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
  return { rows: rows.length, elapsedMs: Date.now() - t0 };
}

// One-time startup optimization: populate media_categories, optimize FTS5, checkpoint WAL & ANALYZE
(() => {
  try {
    const primaryCount = db.prepare("SELECT COUNT(*) AS c FROM media_items WHERE is_primary = 1").get().c;
    const catCount = db.prepare("SELECT COUNT(*) AS c FROM media_categories").get().c;
    const perfFlag = db.prepare("SELECT value FROM sync_state WHERE key = 'perf_v2_migrated'").get()?.value;

    if (primaryCount > 0 && (catCount === 0 || perfFlag !== "1")) {
      const mc = rebuildMediaCategories();
      if (hasFts5) {
        try {
          db.exec("INSERT INTO media_fts(media_fts) VALUES('optimize')");
        } catch {}
      }
      try {
        db.exec("ANALYZE;");
      } catch {}
      try {
        db.exec("PRAGMA wal_checkpoint(PASSIVE);");
      } catch {}
      db.prepare("INSERT INTO sync_state(key, value) VALUES ('perf_v2_migrated', '1') ON CONFLICT(key) DO UPDATE SET value = '1'").run();
      console.log(`[db] Speed indexes & media_categories built (${mc.rows} titles in ${mc.elapsedMs}ms)`);
    }
  } catch (err) {
    console.warn("[db] Perf index bootstrap warning:", err.message);
  }
})();

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
      stmtSyncPrimaryCatByUrl.run(item.url);
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
  const enabledSets = getEnabledServerSets();
  const rows = db.prepare(`
    SELECT id, media_type, clean_title, year, category, quality_score, imdb_rank,
           modified_at, audio_tags, language_tag, source, origin, season_hint,
           is_primary, canonical_id, categories_all
    FROM media_items
    ORDER BY media_type, clean_title, quality_score DESC, modified_at DESC, id ASC
  `).all();

  const watchlistIds = new Set(db.prepare("SELECT media_id FROM watchlist").all().map((r) => r.media_id));

  // Partition enabled rows by (media_type + clean_title); hide disabled server rows completely
  const byTitle = new Map();
  const disabledRows = [];
  for (const r of rows) {
    if (!isMediaRowFromEnabledServer(r, enabledSets)) {
      disabledRows.push(r);
      continue;
    }
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
    // Demote & unlink all rows from disabled servers so they vanish from grids, search, facets & mirrors
    for (const dis of disabledRows) {
      if (dis.is_primary !== 0 || dis.canonical_id !== dis.id) {
        stmtUpdateDup.run(dis.id, dis.id);
        writes++;
      }
    }

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

  rebuildMediaCategories();
  if (hasFts5 && writes > 250) {
    try {
      db.exec("INSERT INTO media_fts(media_fts) VALUES('optimize')");
    } catch {}
  }
  try {
    db.exec("PRAGMA wal_checkpoint(PASSIVE);");
  } catch {}

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
  const enabledSets = getEnabledServerSets();
  return db.prepare(`
    SELECT id, title, raw_name, category, media_type, year, quality, audio_tags,
           source_tag, language_tag, imdb_rank, url, origin, source, source_id,
           quality_score, season_hint, is_primary
    FROM media_items
    WHERE canonical_id = ? AND id != ?
    ORDER BY quality_score DESC, season_hint ASC, id ASC
    LIMIT 25
  `).all(canonId, item.id).filter((r) => isMediaRowFromEnabledServer(r, enabledSets));
}

export function getLibraryStats(force = false, maxAgeMs = 300000) {
  if (!force && cachedStats && Date.now() - statsBuiltAt < maxAgeMs) {
    return cachedStats;
  }

  const enabledSets = getEnabledServerSets();
  if (enabledSets.origins.size === 0 && enabledSets.sources.size === 0) {
    const emptyCats = {};
    for (const catId of CATEGORY_MAP.keys()) emptyCats[catId] = 0;
    cachedStats = {
      total: 0,
      totalRaw: 0,
      duplicatesMerged: 0,
      movies: 0,
      series: 0,
      bySource: {},
      byCategory: emptyCats,
      years: [],
      languages: [],
      lastSync: getSyncState("last_sync_at"),
    };
    statsBuiltAt = Date.now();
    return cachedStats;
  }

  let totalRaw = 0;
  for (const r of db.prepare("SELECT source, origin, COUNT(*) AS c FROM media_items GROUP BY source, origin").all()) {
    if (isMediaRowFromEnabledServer(r, enabledSets)) totalRaw += r.c;
  }

  let movies = 0;
  let series = 0;
  for (const r of db.prepare("SELECT media_type, COUNT(*) AS c FROM media_items WHERE is_primary = 1 GROUP BY media_type").all()) {
    if (r.media_type === "series") series += r.c;
    else movies += r.c;
  }
  const total = movies + series;

  const bySource = {};
  for (const r of db.prepare("SELECT source, COUNT(*) AS c FROM media_items WHERE is_primary = 1 GROUP BY source").all()) {
    if (r.source) bySource[r.source] = r.c;
  }

  const byCategory = {};
  for (const catId of CATEGORY_MAP.keys()) byCategory[catId] = 0;
  for (const r of db.prepare("SELECT category, COUNT(*) AS c FROM media_categories GROUP BY category").all()) {
    if (r.category in byCategory) byCategory[r.category] = r.c;
  }

  const years = db
    .prepare("SELECT DISTINCT year FROM media_items WHERE is_primary = 1 AND year >= 1920 AND year <= 2030 ORDER BY year DESC")
    .all()
    .map((r) => r.year);

  const languages = db
    .prepare(
      "SELECT language_tag AS lang, COUNT(*) AS count FROM media_items WHERE is_primary = 1 AND language_tag IS NOT NULL AND language_tag != '' GROUP BY language_tag HAVING count >= 15 ORDER BY count DESC"
    )
    .all();

  cachedStats = {
    total,
    totalRaw,
    duplicatesMerged: Math.max(0, totalRaw - total),
    movies,
    series,
    bySource,
    byCategory,
    years,
    languages,
    lastSync: getSyncState("last_sync_at"),
  };
  statsBuiltAt = Date.now();
  return cachedStats;
}

export function getWatchlistIds(deviceId = "default") {
  const safeDevice = normalizeDeviceId(deviceId);
  const rows = db.prepare("SELECT media_id FROM watchlist WHERE device_id = ?").all(safeDevice);
  const set = new Set();
  for (const r of rows) set.add(r.media_id);
  return set;
}

export function normalizeDeviceId(raw) {
  const s = String(raw || "").trim();
  return /^[a-zA-Z0-9_-]{8,64}$/.test(s) ? s : "default";
}

function computeSearchFacets(trimmedQ, singleCharPrefix, usedFts, searchFromSql, searchWhere, searchParams) {
  const cacheKey = trimmedQ.toLowerCase();
  const cached = searchFacetCache.get(cacheKey);
  if (cached && cached.ver === catalogVersion) {
    return cached.facets;
  }

  const whereSql = `WHERE ${searchWhere.join(" AND ")}`;
  const rows = db.prepare(`
    SELECT m.category, m.categories_all, m.year, m.quality, m.audio_tags, m.language_tag, m.source
    ${searchFromSql}
    ${whereSql}
    LIMIT 6000
  `).all(...searchParams);

  const byCategory = {};
  const yearCounts = {};
  const qualities = {};
  const audios = { dual: 0, multi: 0, "hindi-dubbed": 0 };
  const langCounts = {};
  const sources = {};

  for (const r of rows) {
    if (r.categories_all) {
      const parts = r.categories_all.split(",");
      let added = false;
      for (let i = 1; i < parts.length - 1; i++) {
        const c = parts[i];
        if (c) {
          byCategory[c] = (byCategory[c] || 0) + 1;
          added = true;
        }
      }
      if (!added && r.category) {
        byCategory[r.category] = (byCategory[r.category] || 0) + 1;
      }
    } else if (r.category) {
      byCategory[r.category] = (byCategory[r.category] || 0) + 1;
    }

    if (r.year && r.year >= 1920 && r.year <= 2030) {
      yearCounts[r.year] = (yearCounts[r.year] || 0) + 1;
    }
    if (r.quality) {
      qualities[r.quality] = (qualities[r.quality] || 0) + 1;
    }
    if (r.audio_tags) {
      if (r.audio_tags.includes("Dual")) audios.dual++;
      if (r.audio_tags.includes("Multi")) audios.multi++;
      if (r.audio_tags.includes("Hindi Dubbed")) audios["hindi-dubbed"]++;
    }
    if (r.language_tag) {
      langCounts[r.language_tag] = (langCounts[r.language_tag] || 0) + 1;
    }
    if (r.source) {
      sources[r.source] = (sources[r.source] || 0) + 1;
    }
  }

  const years = Object.keys(yearCounts)
    .map(Number)
    .sort((a, b) => b - a);
  const languages = Object.entries(langCounts)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([lang, count]) => ({ lang, count }));

  const facets = {
    totalUnfiltered: rows.length,
    capped: rows.length >= 6000,
    byCategory,
    years,
    yearCounts,
    qualities,
    audios,
    languages,
    sources,
  };

  if (searchFacetCache.size >= 30) {
    const oldest = searchFacetCache.keys().next().value;
    if (oldest !== undefined) searchFacetCache.delete(oldest);
  }
  searchFacetCache.set(cacheKey, { ver: catalogVersion, facets });
  return facets;
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
  skipCount = false,
} = {}) {
  const safeLimit0 = Math.min(120, Math.max(1, parseInt(limit, 10) || 36));
  const safePage0 = Math.max(1, parseInt(page, 10) || 1);
  const enabledSets = getEnabledServerSets();
  if (enabledSets.origins.size === 0 && enabledSets.sources.size === 0) {
    return {
      items: [],
      total: 0,
      page: safePage0,
      limit: safeLimit0,
      totalPages: 0,
      ...(q && String(q).trim()
        ? {
            facets: {
              totalUnfiltered: 0,
              capped: false,
              byCategory: {},
              years: [],
              yearCounts: {},
              qualities: {},
              audios: { dual: 0, multi: 0, "hindi-dubbed": 0 },
              languages: [],
              sources: {},
            },
          }
        : {}),
    };
  }
  const safeDevice = normalizeDeviceId(deviceId);
  const where = [];
  const params = [];
  let fromSql = "FROM media_items m";
  let usedFts = false;
  let usedSingleCategoryDriver = false;
  let singleCharPrefix = false;

  const trimmedQ = (q || "").trim();
  const cats = category
    ? category
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    : [];

  if (trimmedQ) {
    if (trimmedQ.length === 1) {
      singleCharPrefix = true;
      where.push("m.is_primary = 1");
      if (/^[a-z0-9]$/i.test(trimmedQ)) {
        const ch = trimmedQ.toLowerCase();
        const nextCh = String.fromCharCode(ch.charCodeAt(0) + 1);
        where.push("m.title >= ? COLLATE NOCASE AND m.title < ? COLLATE NOCASE");
        params.push(ch, nextCh);
      } else {
        where.push("m.title LIKE ? COLLATE NOCASE");
        params.push(`${trimmedQ}%`);
      }
    } else if (hasFts5) {
      const tokens = trimmedQ
        .replace(/["'*():^~-]/g, " ")
        .split(/\s+/)
        .filter((t) => t.length > 0)
        .slice(0, 8);
      if (tokens.length > 0) {
        const ftsExpr = tokens.map((t) => `"${t}"*`).join(" AND ");
        // CROSS JOIN guarantees SQLite drives from FTS5 index first instead of scanning 73k primary rows!
        fromSql = "FROM media_fts f CROSS JOIN media_items m ON m.id = f.rowid";
        where.push("media_fts MATCH ?");
        params.push(ftsExpr);
        where.push("m.is_primary = 1");
        usedFts = true;
      } else {
        where.push("m.is_primary = 1");
      }
    } else {
      where.push("m.is_primary = 1");
      where.push("(m.title LIKE ? OR m.raw_name LIKE ? OR m.sub_group LIKE ?)");
      const like = `%${trimmedQ}%`;
      params.push(like, like, like);
    }
  } else if (cats.length === 1) {
    // Drive directly from covering media_categories index (eliminates LIKE full-table scan!)
    fromSql = "FROM media_categories mc CROSS JOIN media_items m ON m.id = mc.media_id";
    where.push("mc.category = ?");
    params.push(cats[0]);
    where.push("m.is_primary = 1");
    usedSingleCategoryDriver = true;
  } else {
    where.push("m.is_primary = 1");
  }

  let facets = null;
  if (trimmedQ && !skipCount) {
    // Capture search-only base clauses BEFORE category/year/quality/audio/language/source narrowing
    facets = computeSearchFacets(trimmedQ, singleCharPrefix, usedFts, fromSql, [...where], [...params]);
  }

  if (cats.length > 0 && !usedSingleCategoryDriver) {
    if (cats.length === 1) {
      where.push("EXISTS(SELECT 1 FROM media_categories mc WHERE mc.media_id = m.id AND mc.category = ?)");
      params.push(cats[0]);
    } else {
      const ph = cats.map(() => "?").join(",");
      if (usedFts) {
        where.push(`EXISTS(SELECT 1 FROM media_categories mc WHERE mc.media_id = m.id AND mc.category IN (${ph}))`);
      } else {
        where.push(`m.id IN (SELECT media_id FROM media_categories WHERE category IN (${ph}))`);
      }
      params.push(...cats);
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
    where.push("m.language_tag = ? COLLATE NOCASE");
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

  const safeLimit = Math.min(Math.max(Number(limit) || 36, 1), 120);
  const safePage = Math.max(Number(page) || 1, 1);
  const offset = (safePage - 1) * safeLimit;

  const hasExtraFilters = Boolean(group || mediaType || year || quality || source || language || audio);

  let total = 0;
  if (!skipCount) {
    if (usedSingleCategoryDriver && !hasExtraFilters) {
      total = db.prepare("SELECT COUNT(*) as total FROM media_categories WHERE category = ?").get(cats[0]).total;
    } else {
      total = db.prepare(`SELECT COUNT(*) as total ${fromSql} ${whereSql}`).get(...params).total;
    }
  }

  let orderSql = "ORDER BY m.modified_at DESC, m.year DESC, m.quality_score DESC, m.id DESC";
  const extraOrderParams = [];

  if (usedSingleCategoryDriver && !hasExtraFilters && sort === "recent") {
    orderSql = "ORDER BY mc.modified_at DESC, mc.year DESC, mc.quality_score DESC, mc.media_id DESC";
  } else if (usedSingleCategoryDriver && !hasExtraFilters && sort === "imdb") {
    orderSql = "ORDER BY CASE WHEN mc.imdb_rank IS NULL THEN 9999 ELSE mc.imdb_rank END ASC, mc.quality_score DESC, mc.media_id DESC";
  } else if (sort === "year") {
    orderSql = "ORDER BY m.year DESC, m.modified_at DESC, m.quality_score DESC, m.id DESC";
  } else if (sort === "quality") {
    orderSql = "ORDER BY m.quality_score DESC, m.modified_at DESC, m.year DESC";
  } else if (sort === "title" || (singleCharPrefix && sort === "relevance")) {
    orderSql = "ORDER BY m.title COLLATE NOCASE ASC";
  } else if (sort === "imdb") {
    orderSql = "ORDER BY CASE WHEN m.imdb_rank IS NULL THEN 9999 ELSE m.imdb_rank END ASC, m.quality_score DESC";
  } else if (sort === "oldest") {
    orderSql = "ORDER BY CASE WHEN m.year IS NULL THEN 9999 ELSE m.year END ASC, m.title COLLATE NOCASE ASC";
  } else if (usedFts && sort === "relevance") {
    if (!skipCount && total > 1500) {
      // Broad 2-char prefix matching thousands of docs: prioritize exact title prefix without heavy bm25 scan
      orderSql = "ORDER BY CASE WHEN m.title LIKE ? COLLATE NOCASE THEN 0 ELSE 1 END, m.modified_at DESC, m.quality_score DESC";
      extraOrderParams.push(`${trimmedQ}%`);
    } else {
      // Exact title -> prefix match -> weighted FTS5 bm25 (title weighted 10x)
      orderSql =
        "ORDER BY CASE WHEN LOWER(m.title) = LOWER(?) THEN 0 WHEN m.title LIKE ? COLLATE NOCASE THEN 1 ELSE 2 END, bm25(media_fts, 10.0, 2.0, 1.5, 1.0, 0.5, 0.5), m.modified_at DESC, m.quality_score DESC";
      extraOrderParams.push(trimmedQ, `${trimmedQ}%`);
    }
  }

  const rows = db.prepare(`
    SELECT m.id, m.url, m.category, m.media_type, m.sub_group, m.title, m.raw_name,
           m.year, m.quality, m.audio_tags, m.source_tag, m.language_tag,
           m.imdb_rank, m.modified_at, m.poster_url, m.poster_checked,
           m.source, m.quality_score
    ${fromSql}
    ${whereSql}
    ${orderSql}
    LIMIT ? OFFSET ?
  `).all(...params, ...extraOrderParams, safeLimit, offset);

  const wlIds = skipCount ? null : getWatchlistIds(safeDevice);
  if (wlIds && wlIds.size > 0) {
    for (const r of rows) r.in_watchlist = wlIds.has(r.id) ? 1 : 0;
  } else {
    for (const r of rows) r.in_watchlist = 0;
  }

  return {
    items: rows,
    total: skipCount ? rows.length : total,
    page: safePage,
    limit: safeLimit,
    totalPages: skipCount ? 1 : Math.ceil(total / safeLimit),
    ...(facets ? { facets } : {}),
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
  const enabledSets = getEnabledServerSets();
  if (enabledSets.origins.size === 0 && enabledSets.sources.size === 0) return [];
  return db.prepare(`
    SELECT m.id, m.url, m.origin, m.category, m.media_type, m.sub_group, m.title, m.raw_name,
           m.year, m.quality, m.audio_tags, m.source_tag, m.language_tag,
           m.imdb_rank, m.modified_at, m.poster_url, m.source, 1 AS in_watchlist, w.added_at
    FROM watchlist w
    JOIN media_items m ON m.id = w.media_id
    WHERE w.device_id = ? AND m.is_primary = 1
    ORDER BY w.added_at DESC
  `).all(safeDevice).filter((r) => isMediaRowFromEnabledServer(r, enabledSets));
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
  const enabledSets = getEnabledServerSets();
  const rows = db.prepare(`
    SELECT h.id AS history_id, h.file_url, h.file_name, h.season_name, h.episode_label,
           h.position, h.duration, h.completed, h.updated_at,
           COALESCE(p.id, m.id) AS id,
           COALESCE(p.url, m.url) AS url,
           COALESCE(p.origin, m.origin) AS origin,
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
    WHERE h.device_id = ? AND h.position > 5 AND COALESCE(p.is_primary, m.is_primary) = 1
    ORDER BY h.updated_at DESC
    LIMIT 100
  `).all(safeDevice);

  const seen = new Set();
  const deduped = [];
  for (const r of rows) {
    if (!isMediaRowFromEnabledServer(r, enabledSets)) continue;
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

// =========================================================================
// DYNAMIC FTP / DIRECTORY SERVER REGISTRY (Add / Toggle / Remove / Reset)
// =========================================================================

const srvCols = new Set(db.prepare("PRAGMA table_info(servers)").all().map((c) => c.name));
if (!srvCols.has("is_online")) {
  db.exec("ALTER TABLE servers ADD COLUMN is_online INTEGER NOT NULL DEFAULT 0");
}

function rowToServerObj(r) {
  let folders = [];
  if (r.folders_json) {
    try {
      const parsed = JSON.parse(r.folders_json);
      if (Array.isArray(parsed)) folders = parsed;
    } catch {}
  }
  return {
    id: r.id,
    source: r.source,
    name: r.name,
    adapter: r.adapter || "directory",
    origin: r.origin,
    rootHref: r.root_href || "/",
    pingHref: r.ping_href || null,
    enabled: Boolean(r.enabled),
    online: Boolean(r.is_online),
    isBuiltin: Boolean(r.is_builtin),
    optional: Boolean(r.optional),
    pingTimeoutMs: r.ping_timeout_ms || 5500,
    folders,
    createdAt: r.created_at || 0,
  };
}

function seedBuiltinServersIfNeeded() {
  const seeded = getSyncState("servers_seeded_v1");
  const count = db.prepare("SELECT COUNT(*) AS c FROM servers").get().c;
  if (seeded === "1" || count > 0) {
    syncDynamicServerRegistry();
    return;
  }
  const now = Date.now();
  const stmt = db.prepare(`
    INSERT OR IGNORE INTO servers (
      id, source, name, adapter, origin, root_href, ping_href,
      enabled, is_builtin, optional, ping_timeout_ms, folders_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, 1, ?, ?, NULL, ?)
  `);
  db.exec("BEGIN");
  try {
    for (const s of SERVERS) {
      stmt.run(
        s.id,
        s.source,
        s.name,
        s.source,
        s.origin,
        s.rootHref || "/",
        s.pingHref || null,
        s.optional ? 1 : 0,
        s.pingTimeoutMs || 5500,
        now
      );
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
  setSyncState("servers_seeded_v1", "1");
  syncDynamicServerRegistry();
}

export function syncDynamicServerRegistry() {
  const rows = db.prepare("SELECT * FROM servers ORDER BY is_builtin DESC, created_at ASC, id ASC").all();
  setDynamicServerRegistry(rows.map(rowToServerObj));
}

export function getAllServers() {
  const rows = db.prepare("SELECT * FROM servers ORDER BY is_builtin DESC, created_at ASC, id ASC").all();
  const countByOrigin = new Map();
  const countBySource = new Map();
  for (const r of db.prepare("SELECT origin, COUNT(*) AS c FROM media_items GROUP BY origin").all()) {
    countByOrigin.set(r.origin, r.c);
  }
  for (const r of db.prepare("SELECT source, COUNT(*) AS c FROM media_items GROUP BY source").all()) {
    countBySource.set(r.source, r.c);
  }
  return rows.map((r) => {
    const srv = rowToServerObj(r);
    const isMultiNode = srv.source === "dhakaflix" || srv.source === "discoveryftp";
    srv.itemCount = isMultiNode ? (countByOrigin.get(srv.origin) || 0) : (countBySource.get(srv.source) || countByOrigin.get(srv.origin) || 0);
    return srv;
  });
}

export function getEnabledServers() {
  return getAllServers().filter((s) => s.enabled);
}

export function getServerById(id) {
  const r = db.prepare("SELECT * FROM servers WHERE id = ?").get(String(id || ""));
  return r ? rowToServerObj(r) : null;
}

export function addOrUpdateCustomServer({ id = null, name, url, adapter = "directory", folders = [], rootHrefOverride = null }) {
  const normalizedUrl = normalizeServerInputUrl(url);
  if (!isSafeServerUrl(normalizedUrl)) {
    throw new Error("Invalid or unsafe server URL (only HTTP/HTTPS non-loopback servers are allowed)");
  }
  const u = new URL(normalizedUrl);
  const origin = u.origin;
  const safeAdapter = ["directory", "icc", "circleftp"].includes(adapter) ? adapter : "directory";

  // Clean file-extension URLs like /dashboard.php or /index.html — NEVER turn them into /dashboard.php/!
  let rootHref = rootHrefOverride || u.pathname || "/";
  if (safeAdapter === "icc") {
    rootHref = "/command.php";
  } else if (safeAdapter === "circleftp") {
    rootHref = "/";
  } else {
    if (/\/[^/]+\.(php|html?|aspx?|jsp|cgi|cfm)$/i.test(rootHref)) {
      const idx = rootHref.lastIndexOf("/");
      rootHref = idx > 0 ? rootHref.slice(0, idx + 1) : "/";
    } else if (!rootHref.endsWith("/")) {
      rootHref += "/";
    }
  }

  // If upgrading a previously broken custom directory entry (e.g. http://10.16.100.244/dashboard.php/)
  // to its auto-detected adapter (icc / circleftp), remove the stale empty duplicate first!
  if (!id && (safeAdapter === "icc" || safeAdapter === "circleftp")) {
    db.prepare("DELETE FROM servers WHERE origin = ? AND is_builtin = 0 AND adapter = 'directory'").run(origin);
  }

  // If an existing server with the same origin + adapter (or same origin + rootHref) already exists,
  // re-enable & update it cleanly instead of creating duplicates!
  let existingSame = null;
  if (!id) {
    existingSame = db.prepare("SELECT * FROM servers WHERE origin = ? AND adapter = ? LIMIT 1").get(origin, safeAdapter);
    if (!existingSame && safeAdapter === "directory") {
      existingSame = db.prepare("SELECT * FROM servers WHERE origin = ? AND root_href = ? LIMIT 1").get(origin, rootHref);
    }
  }

  const cleanName = String(name || existingSame?.name || (safeAdapter === "icc" ? "ICC FTP Server" : safeAdapter === "circleftp" ? "CircleFTP" : u.hostname))
    .trim()
    .slice(0, 80) || u.hostname;
  const slug = cleanName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 28) || "ftp";
  const serverId = id || existingSame?.id || `custom-${slug}-${Date.now().toString(36).slice(-4)}`;
  const sourceKey =
    safeAdapter === "icc"
      ? "icc"
      : safeAdapter === "circleftp"
        ? "circleftp"
        : existingSame?.source || serverId;

  const cleanFolders = Array.isArray(folders)
    ? folders
        .filter((f) => f && f.href && f.selected !== false)
        .map((f) => ({
          name: String(f.name || "Folder").slice(0, 80),
          href: String(f.href),
          category: String(f.category || "foreign"),
          mediaType: f.mediaType === "series" ? "series" : "movie",
          mode: f.mode === "flat" ? "flat" : "bucketed",
        }))
    : [];

  db.prepare(`
    INSERT INTO servers (
      id, source, name, adapter, origin, root_href, ping_href,
      enabled, is_online, is_builtin, optional, ping_timeout_ms, folders_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, NULL, 1, 1, 0, 0, 5500, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      adapter = excluded.adapter,
      origin = excluded.origin,
      root_href = excluded.root_href,
      folders_json = CASE WHEN excluded.adapter = 'directory' THEN excluded.folders_json ELSE servers.folders_json END,
      enabled = 1,
      is_online = 1
  `).run(serverId, sourceKey, cleanName, safeAdapter, origin, rootHref, JSON.stringify(cleanFolders), Date.now());

  syncDynamicServerRegistry();
  // If re-enabling or updating an existing server whose titles are already in DB, restore them right away!
  if (existingSame) {
    runDeduplication();
  } else {
    invalidateStatsCache();
  }
  return getServerById(serverId);
}

export function updateServerFolders(id, folders = []) {
  if (!id || !Array.isArray(folders)) return;
  const cleanFolders = folders
    .filter((f) => f && f.href && f.selected !== false)
    .map((f) => ({
      name: String(f.name || "Folder").slice(0, 80),
      href: String(f.href),
      category: String(f.category || "foreign"),
      mediaType: f.mediaType === "series" ? "series" : "movie",
      mode: f.mode === "flat" ? "flat" : "bucketed",
    }));
  db.prepare("UPDATE servers SET folders_json = ? WHERE id = ?").run(JSON.stringify(cleanFolders), id);
}

function getEnabledServerSets() {
  // ONLY enabled AND currently online servers expose content in the catalog (offline servers are automatically hidden!)
  const rows = db.prepare("SELECT source, origin FROM servers WHERE enabled = 1 AND is_online = 1").all();
  const origins = new Set();
  const sources = new Set();
  for (const s of rows) {
    if (s.origin) origins.add(s.origin);
    if (s.source) sources.add(s.source);
  }
  return { origins, sources };
}

function hasVisibilityMismatch(enabledSets = null) {
  const sets = enabledSets || getEnabledServerSets();
  const visibleGroups = db.prepare("SELECT DISTINCT source, origin FROM media_items WHERE is_primary = 1").all();
  if (sets.origins.size === 0 && sets.sources.size === 0) {
    return visibleGroups.length > 0;
  }
  for (const g of visibleGroups) {
    if (!isMediaRowFromEnabledServer(g, sets)) return true;
  }
  // Also check if an online server has indexed media rows while ZERO primary titles are currently visible
  if (visibleGroups.length === 0) {
    const allGroups = db.prepare("SELECT DISTINCT source, origin FROM media_items").all();
    for (const g of allGroups) {
      if (isMediaRowFromEnabledServer(g, sets)) return true;
    }
  }
  return false;
}

/**
 * Persist live online/offline reachability for servers.
 * Whenever ANY server flips online <-> offline (OR stale preloaded visibility doesn't match online state),
 * immediately re-runs deduplication so offline servers' content disappears and online servers reappear!
 */
export function updateServersOnlineStatus(onlineById = {}) {
  const existing = db.prepare("SELECT id, enabled, is_online FROM servers").all();
  const changes = [];
  for (const row of existing) {
    if (!Object.prototype.hasOwnProperty.call(onlineById, row.id)) continue;
    const nextOnline = row.enabled && onlineById[row.id] ? 1 : 0;
    if ((row.is_online ? 1 : 0) !== nextOnline) {
      changes.push([nextOnline, row.id]);
    }
  }
  if (changes.length > 0) {
    const stmt = db.prepare("UPDATE servers SET is_online = ? WHERE id = ?");
    db.exec("BEGIN");
    try {
      for (const [val, id] of changes) stmt.run(val, id);
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }
  const mismatch = changes.length === 0 && hasVisibilityMismatch();
  if (changes.length === 0 && !mismatch) {
    return { changed: false, updatedCount: 0 };
  }
  runDeduplication();
  return { changed: true, updatedCount: changes.length };
}

export function getActiveOnlineServers() {
  return getAllServers().filter((s) => s.enabled && s.online);
}

export function isMediaRowFromEnabledServer(row, sets = null) {
  if (!row) return false;
  const { origins, sources } = sets || getEnabledServerSets();
  if (row.source === "dhakaflix" || row.source === "discoveryftp") {
    return origins.has(row.origin);
  }
  return sources.has(row.source);
}

export function setServerEnabled(id, enabled) {
  const srv = getServerById(id);
  if (!srv) throw new Error("Server not found");
  db.prepare("UPDATE servers SET enabled = ? WHERE id = ?").run(enabled ? 1 : 0, srv.id);
  syncDynamicServerRegistry();
  // Immediately hide disabled server files (and promote surviving mirrors) or restore when re-enabled!
  runDeduplication();
  return getServerById(srv.id);
}

export function deleteServerAndPurgeMedia(id) {
  const srv = getServerById(id);
  if (!srv) throw new Error("Server not found");

  const isMultiNode = srv.source === "dhakaflix" || srv.source === "discoveryftp";
  let deletedRows = 0;

  db.exec("BEGIN");
  try {
    db.prepare("DELETE FROM servers WHERE id = ?").run(srv.id);
    if (isMultiNode) {
      const r = db.prepare("DELETE FROM media_items WHERE origin = ?").run(srv.origin);
      deletedRows = Number(r.changes || 0);
    } else {
      const r = db.prepare("DELETE FROM media_items WHERE source = ? OR origin = ?").run(srv.source, srv.origin);
      deletedRows = Number(r.changes || 0);
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }

  // Clean cached delta state for this server so re-adding later performs a fresh full scan
  if (srv.source === "circleftp") setSyncState("circle_max_id", "0");
  if (srv.source === "icc") setSyncState("icc_cat_counts", "{}");
  try {
    const customMtimes = JSON.parse(getSyncState("custom_bucket_mtimes") || "{}");
    for (const k of Object.keys(customMtimes)) {
      if (k.startsWith(srv.origin)) delete customMtimes[k];
    }
    setSyncState("custom_bucket_mtimes", JSON.stringify(customMtimes));
  } catch {}

  syncDynamicServerRegistry();
  if (deletedRows > 0) {
    runDeduplication();
  } else {
    invalidateStatsCache();
  }
  return { deletedServer: srv, deletedRows };
}

export function resetDefaultServers() {
  const now = Date.now();
  const stmt = db.prepare(`
    INSERT INTO servers (
      id, source, name, adapter, origin, root_href, ping_href,
      enabled, is_builtin, optional, ping_timeout_ms, folders_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, 1, ?, ?, NULL, ?)
    ON CONFLICT(id) DO UPDATE SET enabled = 1, name = excluded.name, origin = excluded.origin, root_href = excluded.root_href
  `);
  db.exec("BEGIN");
  try {
    for (const s of SERVERS) {
      stmt.run(
        s.id,
        s.source,
        s.name,
        s.source,
        s.origin,
        s.rootHref || "/",
        s.pingHref || null,
        s.optional ? 1 : 0,
        s.pingTimeoutMs || 5500,
        now
      );
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
  setSyncState("servers_seeded_v1", "1");
  syncDynamicServerRegistry();
  runDeduplication();
  return getAllServers();
}

export function getServerFilterOptions() {
  const active = getActiveOnlineServers();
  const stats = getLibraryStats();
  const bySource = new Map();
  const builtinLabelMap = {
    dhakaflix: "DhakaFlix",
    icc: "ICC FTP",
    circleftp: "CircleFTP",
    discoveryftp: "DiscoveryFTP",
  };
  for (const s of active) {
    if (!bySource.has(s.source)) {
      bySource.set(s.source, {
        value: s.source,
        label: builtinLabelMap[s.source] || s.name,
        count: stats.bySource?.[s.source] || 0,
      });
    }
  }
  return [...bySource.values()];
}

seedBuiltinServersIfNeeded();
