import path from "node:path";
import { ICC_ORIGIN, DEFAULT_ICC_SESSION } from "./config.js";
import { getSyncState, setSyncState } from "./db.js";
import { parseEpisodeFile, safeDecode, classifyFileKind } from "./parser.js";

const DEFAULT_TIMEOUT_MS = 8000;

// Global concurrency semaphore for ICC Apache (keeps Apache at peak throughput with zero timeouts!)
let iccActive = 0;
const ICC_MAX_CONCURRENCY = 10;
const iccQueue = [];

function withIccSlot(fn) {
  return new Promise((resolve, reject) => {
    const run = async () => {
      iccActive++;
      try {
        resolve(await fn());
      } catch (e) {
        reject(e);
      } finally {
        iccActive--;
        const next = iccQueue.shift();
        if (next) next();
      }
    };
    if (iccActive < ICC_MAX_CONCURRENCY) run();
    else iccQueue.push(run);
  });
}

export function getIccSession() {
  return getSyncState("icc_session") || DEFAULT_ICC_SESSION;
}

/**
 * Accept either a raw session hex token or a full ICC dashboard URL containing ?session=...
 */
export function setIccSession(input) {
  const raw = (input || "").trim();
  if (!raw) return getIccSession();
  const m = raw.match(/session=([a-f0-9]+)/i);
  const token = m ? m[1] : raw.replace(/[^a-f0-9]/gi, "");
  if (token.length >= 16) {
    setSyncState("icc_session", token);
    return token;
  }
  throw new Error("Invalid ICC session token or dashboard URL");
}

function decodeHtml(str) {
  return (str || "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#039;|&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Parse "14.09.2026" (DD.MM.YYYY) from ICC data-publish-date into epoch ms.
 */
function parseIccDate(str) {
  if (!str) return 0;
  const m = str.match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
  if (!m) return 0;
  const ts = Date.UTC(parseInt(m[3], 10), parseInt(m[2], 10) - 1, parseInt(m[1], 10));
  return Number.isFinite(ts) ? ts : 0;
}

/**
 * Parse ICC card HTML (works for both dashboard.php page 1 and command.php cpage=N fragments).
 */
export function parseIccCardsHtml(html) {
  const cards = [];
  const seenIds = new Set();

  // Only scan inside news-content when given a full dashboard page (skip top promo slider duplicates)
  const newsIdx = html.indexOf("news-content");
  const slice = newsIdx >= 0 ? html.slice(newsIdx) : html;

  const postRe =
    /<div class="post[^"]*"[^>]*data-publish-date="([^"]*)"[\s\S]*?href="player\.php\?[^"]*play=(\d+)"[\s\S]*?<img\s+src="([^"]*)"[^>]*>[\s\S]*?<div class="title">([\s\S]*?)<\/div>/gi;

  let m;
  while ((m = postRe.exec(slice)) !== null) {
    const publishDate = m[1].trim();
    const playId = m[2].trim();
    const imgRel = m[3].trim();
    const title = decodeHtml(m[4].replace(/<[^>]+>/g, " "));
    if (!playId || !title || seenIds.has(playId)) continue;
    seenIds.add(playId);

    const posterUrl = imgRel
      ? imgRel.startsWith("http")
        ? imgRel
        : `${ICC_ORIGIN}/${imgRel.replace(/^\/+/, "")}`
      : null;

    cards.push({
      playId,
      title,
      posterUrl,
      modifiedAt: parseIccDate(publishDate),
      url: `${ICC_ORIGIN}/player.php?play=${playId}`,
    });
  }

  return cards;
}

/**
 * Open an ICC category session and get its PHPSESSID cookie + page 1 cards.
 */
export async function openIccCategory(iccCatId, session = getIccSession()) {
  return withIccSlot(async () => {
    const url = `${ICC_ORIGIN}/dashboard.php?session=${encodeURIComponent(session)}&category=${iccCatId}`;
    const res = await fetch(url, {
      redirect: "manual",
      signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
    });

    if (res.status >= 300 && res.status < 400) {
      throw new Error("ICC session expired — update session URL in Server & Auto-Sync");
    }
    if (!res.ok) {
      throw new Error(`ICC HTTP ${res.status}`);
    }

    const cookies = res.headers.getSetCookie ? res.headers.getSetCookie() : [res.headers.get("set-cookie") || ""];
    const cookie = (cookies[cookies.length - 1] || "").split(";")[0];
    const html = await res.text();
    const cards = parseIccCardsHtml(html);

    const countRe = new RegExp(`category=${iccCatId}["'][^>]*>[\\s\\S]*?(\\d+)\\s*<`, "i");
    const countMatch = html.match(countRe);
    const expectedCount = countMatch ? parseInt(countMatch[1], 10) : null;

    return { cookie, cards, expectedCount };
  });
}

/**
 * Fetch a paginated ICC fragment (cpage=2, 3, ...) using the active category PHPSESSID cookie.
 */
export async function fetchIccPage(cookie, pageNum) {
  return withIccSlot(async () => {
    const res = await fetch(`${ICC_ORIGIN}/command.php`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "X-Requested-With": "XMLHttpRequest",
        Cookie: cookie,
      },
      body: `cpage=${pageNum}`,
      signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
    });
    if (!res.ok) return [];
    const html = await res.text();
    if (!html || html.trim().length < 20) return [];
    return parseIccCardsHtml(html);
  });
}

/**
 * Smart delta-aware ICC category crawler:
 * - If `prevCount` matches ICC's live sidebar count AND page 1 is already indexed -> skips all remaining pages in ~40ms!
 * - If `stopOnKnown` is true (or `prevCount` exists and only a few new items were added) -> stops as soon as 2 known pages appear!
 * - On cold crawl -> uses parallel cookie workers bounded by the global ICC Apache semaphore for peak speed & zero timeouts.
 */
export async function crawlIccCategory(
  iccCatId,
  {
    maxPages = 999,
    session = getIccSession(),
    onBatch = null,
    knownUrls = null,
    stopOnKnown = false,
    prevCount = null,
  } = {}
) {
  const first = await openIccCategory(iccCatId, session);
  const all = [...first.cards];
  if (onBatch && first.cards.length > 0) onBatch(first.cards);

  const expectedCount = first.expectedCount;
  const p1AllKnown =
    knownUrls && first.cards.length > 0 && first.cards.every((c) => knownUrls.has(c.url));

  // Delta fast-path 1: sidebar item count unchanged + page 1 already known -> 0 new uploads!
  if (prevCount && expectedCount && expectedCount <= prevCount && p1AllKnown) {
    return { cards: all, expectedCount, skippedDelta: true };
  }

  // Delta fast-path 2: quick/incremental mode & page 1 already known -> stop immediately!
  const effectiveStopOnKnown = stopOnKnown || (Boolean(prevCount) && Boolean(expectedCount));
  if (effectiveStopOnKnown && p1AllKnown) {
    return { cards: all, expectedCount, skippedDelta: true };
  }

  if (first.cards.length < 12 || maxPages <= 1 || !first.cookie) {
    return { cards: all, expectedCount, skippedDelta: false };
  }

  const estPages = expectedCount ? Math.ceil(expectedCount / 12) + 2 : maxPages;
  const limitPages = Math.min(maxPages, Math.max(estPages, 2));

  let workerCount = 1;
  if (!effectiveStopOnKnown) {
    if (limitPages >= 300) workerCount = 8;
    else if (limitPages >= 80) workerCount = 5;
    else if (limitPages >= 15) workerCount = 3;
  } else {
    workerCount = Math.min(3, limitPages);
  }

  const cookies = [first.cookie];
  if (workerCount > 1) {
    const extra = await Promise.all(
      Array.from({ length: workerCount - 1 }, () =>
        openIccCategory(iccCatId, session).then((r) => r.cookie).catch(() => null)
      )
    );
    for (const c of extra) if (c) cookies.push(c);
  }

  let nextPage = 2;
  let stop = false;
  let knownPageStreak = 0;
  const seen = new Set(all.map((c) => c.playId));

  await Promise.all(
    cookies.map(async (ck) => {
      let emptyStreak = 0;
      while (!stop) {
        const p = nextPage++;
        if (p > limitPages) break;
        try {
          const cards = await fetchIccPage(ck, p);
          if (cards.length === 0) {
            emptyStreak++;
            if (emptyStreak >= 2) {
              stop = true;
              break;
            }
            continue;
          }
          emptyStreak = 0;

          if (effectiveStopOnKnown && knownUrls) {
            const anyNew = cards.some((c) => !knownUrls.has(c.url));
            if (!anyNew) {
              knownPageStreak++;
              if (knownPageStreak >= 2) {
                stop = true;
                break;
              }
            } else {
              knownPageStreak = 0;
            }
          }

          const fresh = [];
          for (const c of cards) {
            if (!seen.has(c.playId)) {
              seen.add(c.playId);
              all.push(c);
              fresh.push(c);
            }
          }
          if (onBatch && fresh.length > 0) onBatch(fresh);
          if (cards.length < 12) {
            stop = true;
            break;
          }
        } catch {
          emptyStreak++;
          if (emptyStreak >= 3) break;
        }
      }
    })
  );

  return { cards: all, expectedCount, skippedDelta: false };
}

/**
 * Live autocomplete search against ICC FTP (works even without session token!).
 */
export async function searchIccUpstream(query, timeoutMs = 6000) {
  const res = await fetch(`${ICC_ORIGIN}/command.php`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `cSearch=${encodeURIComponent(query)}`,
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) return [];
  const text = await res.text();
  try {
    const arr = JSON.parse(text);
    if (!Array.isArray(arr)) return [];
    return arr
      .filter((x) => x.type === "1" && x.id && x.name)
      .map((x) => ({
        playId: String(x.id),
        name: x.name,
        url: `${ICC_ORIGIN}/player.php?play=${x.id}`,
        href: `/player.php?play=${x.id}`,
        origin: ICC_ORIGIN,
        isDir: false,
        kind: "icc",
        posterUrl: x.image ? `${ICC_ORIGIN}/files/${x.image}` : null,
      }));
  } catch {
    return [];
  }
}

/**
 * Check if a storage mirror URL is reachable and fetch its total byte size via quick Range ping.
 */
async function probeMirrorQuick(url, timeoutMs = 2000) {
  try {
    const r = await fetch(url, {
      headers: { Range: "bytes=0-0", Referer: `${ICC_ORIGIN}/` },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!r.ok && r.status !== 206) return { ok: false, size: 0 };
    const cr = r.headers.get("content-range") || "";
    const totalMatch = cr.match(/\/(\d+)$/);
    const size = totalMatch ? parseInt(totalMatch[1], 10) : parseInt(r.headers.get("content-length") || "0", 10) || 0;
    return { ok: true, size };
  } catch {
    return { ok: false, size: 0 };
  }
}

/**
 * Hydrate an ICC FTP item from player.php?play=<id> (NO session needed!).
 * Extracts playable video URLs, checks mirror liveness, extracts built-in metadata & trailer!
 */
export async function fetchIccPlayerDetails(playId) {
  const res = await fetch(`${ICC_ORIGIN}/player.php?play=${encodeURIComponent(playId)}`, {
    signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`ICC player HTTP ${res.status}`);
  const html = await res.text();

  // Extract <source src='...' title='...' />
  const rawSources = [];
  const srcRe = /<source\s+[^>]*src=['"]([^'"]+)['"][^>]*>/gi;
  let m;
  while ((m = srcRe.exec(html)) !== null) {
    const tag = m[0];
    const url = m[1].trim();
    if (!/^https?:\/\/10\.16\.100\.\d+/i.test(url)) continue;
    const titleMatch = tag.match(/title=['"]([^'"]*)['"]/i);
    const label = titleMatch ? decodeHtml(titleMatch[1]) : "";
    rawSources.push({ url, sourceLabel: label });
  }

  // Fallback: check direct download links if <source> was empty
  if (rawSources.length === 0) {
    const dlRe = /href=['"](https?:\/\/10\.16\.100\.\d+[^'"]+)['"]/gi;
    const seenU = new Set();
    while ((m = dlRe.exec(html)) !== null) {
      const url = m[1].trim();
      if (seenU.has(url)) continue;
      if (classifyFileKind(safeDecode(url)) === "video") {
        seenU.add(url);
        rawSources.push({ url, sourceLabel: "" });
      }
    }
  }

  // Extract subtitle <track> if any
  const subtitles = [];
  const trackRe = /<track\s+[^>]*src=['"]([^'"]+)['"][^>]*>/gi;
  while ((m = trackRe.exec(html)) !== null) {
    const rel = m[1].trim();
    const abs = rel.startsWith("http") ? rel : `${ICC_ORIGIN}/${rel.replace(/^\/+/, "")}`;
    const lbl = m[0].match(/label=['"]([^'"]*)['"]/i)?.[1] || path.basename(safeDecode(abs));
    subtitles.push({ name: lbl, url: abs, href: abs, kind: "subtitle", size: 0 });
  }

  // Extract built-in metadata table from ICC player.php!
  const getField = (field) => {
    const re = new RegExp(`<td>\\s*${field}:\\s*<\\/td>\\s*<td>([\\s\\S]*?)<\\/td>`, "i");
    const fm = html.match(re);
    if (!fm) return null;
    const val = decodeHtml(fm[1].replace(/<[^>]+>/g, " "));
    return !val || /^N\/A$/i.test(val) ? null : val;
  };

  const yearStr = getField("Year");
  const year = yearStr && /^\d{4}/.test(yearStr) ? parseInt(yearStr.slice(0, 4), 10) : null;
  const genreStr = getField("Genre");
  const runtimeStr = getField("Runtime");
  const runtimeMatch = runtimeStr?.match(/(\d+)/);
  const trailerMatch = html.match(/data-theVideo=["'](https?:\/\/[^"']+)["']/i);
  const posterMatch = html.match(/<img[^>]*src=["'](files\/[^"']+)["']/i);
  const posterUrl = posterMatch ? `${ICC_ORIGIN}/${posterMatch[1]}` : null;

  const meta = {
    overview: getField("Plot"),
    genres: genreStr ? genreStr.split(",").map((g) => g.trim()).filter(Boolean) : [],
    director: getField("Director"),
    cast: getField("Actors"),
    language: getField("Language"),
    country: getField("Country"),
    runtime: runtimeMatch ? parseInt(runtimeMatch[1], 10) : null,
    trailerUrl: trailerMatch ? trailerMatch[1] : null,
    source: "ICC FTP",
  };

  // Detect whether rawSources are Server Mirrors of the SAME movie (e.g. Server-1, Server-2)
  // vs Episodes of a TV Series (e.g. S03E01, S03E02, ...)!
  const isMirrors =
    rawSources.length >= 2 &&
    rawSources.every((s) => /^Server[-\s]?\d+$/i.test(s.sourceLabel) || s.sourceLabel === "");

  let files = rawSources.map((s, idx) => {
    const uPath = safeDecode(new URL(s.url).pathname);
    const fileName = path.basename(uPath);
    const parsed = parseEpisodeFile(fileName, idx);
    return {
      name: isMirrors && s.sourceLabel ? `${fileName} [${s.sourceLabel}]` : fileName,
      href: uPath,
      url: s.url,
      isDir: false,
      size: 0,
      time: 0,
      kind: "video",
      mirrorLabel: s.sourceLabel || null,
      ...parsed,
      label: isMirrors ? s.sourceLabel || `Mirror ${idx + 1}` : parsed.label,
    };
  });

  // For movies or mirrors (<= 4 files), probe liveness + size in parallel so offline mirrors (like .213) move below online ones (.214)!
  if (files.length > 0 && files.length <= 4) {
    const probed = await Promise.all(files.map((f) => probeMirrorQuick(f.url, 2200)));
    files = files.map((f, i) => ({
      ...f,
      size: probed[i].size || 0,
      online: probed[i].ok,
    }));
    // Put online mirrors first while preserving order!
    files.sort((a, b) => (b.online ? 1 : 0) - (a.online ? 1 : 0));
  } else if (files.length > 4) {
    // For multi-episode series, probe just episode 1 to check server size/liveness quickly
    const p0 = await probeMirrorQuick(files[0].url, 2200);
    if (p0.size > 0) files[0].size = p0.size;
  }

  return {
    files: [...files, ...subtitles],
    videoFiles: files,
    subtitles,
    isMirrors,
    posterUrl,
    year,
    meta,
    totalSize: files.reduce((acc, f) => acc + (f.size || 0), 0),
  };
}

export async function checkIccHealth() {
  const t0 = Date.now();
  try {
    const r = await fetch(`${ICC_ORIGIN}/command.php`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "cSearch=test",
      signal: AbortSignal.timeout(4000),
    });
    return { online: r.ok, latencyMs: Date.now() - t0 };
  } catch {
    return { online: false, latencyMs: null };
  }
}
