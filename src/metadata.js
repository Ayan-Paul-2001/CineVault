import { listDirectory, mapWithConcurrency } from "./h5ai.js";
import { fetchIccPlayerDetails } from "./icc.js";
import { fetchCirclePostDetails } from "./circleftp.js";
import { parseEpisodeFile } from "./parser.js";
import { getItemById, getMergedMirrors, updateItemHydration, updateItemMetadata } from "./db.js";
import { isAllowedUrl, ICC_ORIGIN } from "./config.js";

const inFlightHydrations = new Map();
const inFlightEnrichments = new Map();
let activeHydrateSlots = 0;
const MAX_HYDRATE_CONCURRENCY = 10;
const waitQueue = [];

function acquireSlot() {
  if (activeHydrateSlots < MAX_HYDRATE_CONCURRENCY) {
    activeHydrateSlots++;
    return Promise.resolve();
  }
  return new Promise((resolve) => waitQueue.push(resolve));
}

function releaseSlot() {
  const next = waitQueue.shift();
  if (next) next();
  else activeHydrateSlots = Math.max(0, activeHydrateSlots - 1);
}

function pickBestPoster(images) {
  if (!images || images.length === 0) return null;
  const sorted = [...images].sort((a, b) => {
    const score = (img) => {
      let s = 0;
      if (/poster|cover|folder|a_al_|a_vl_/i.test(img.name)) s += 500000;
      if (/\.jpe?g$/i.test(img.name)) s += 100000;
      s += Math.min(img.size || 0, 1000000);
      return s;
    };
    return score(b) - score(a);
  });
  return sorted[0].url;
}

/**
 * Hydrate an item from either DhakaFlix (h5ai folder) or ICC FTP (player.php).
 * For merged TV series, automatically unifies seasons from linked ICC/DhakaFlix copies!
 */
export async function hydrateItem(id, { deep = false, force = false } = {}) {
  const item = getItemById(id);
  if (!item) return null;

  const hasFiles = Boolean(item.files_json);
  const hasSeasons = Boolean(item.seasons_json);
  const isFresh = item.hydrated_at && Date.now() - item.hydrated_at < 1000 * 60 * 60 * 24;

  if (!force && isFresh && (hasFiles || hasSeasons)) {
    if (!deep) return item;
    const seasons = safeJson(item.seasons_json, []);
    const allSeasonsPopulated = seasons.length === 0 || seasons.every((s) => Array.isArray(s.episodes));
    if (allSeasonsPopulated) return item;
  }

  const key = `${id}:${deep ? "deep" : "shallow"}`;
  if (inFlightHydrations.has(key)) {
    return inFlightHydrations.get(key);
  }

  const promise = (async () => {
    await acquireSlot();
    try {
      if (item.source === "icc") {
        return await hydrateIccItem(item, { deep });
      }
      if (item.source === "circleftp") {
        return await hydrateCircleItem(item, { deep });
      }
      return await hydrateDhakaFlixItem(item, { deep });
    } catch {
      updateItemHydration(item.id, { posterChecked: 1 });
      return getItemById(item.id);
    } finally {
      releaseSlot();
      inFlightHydrations.delete(key);
    }
  })();

  inFlightHydrations.set(key, promise);
  return promise;
}

async function hydrateCircleItem(item) {
  const postId = item.source_id || item.url.match(/\/posts\/(\d+)/)?.[1];
  if (!postId) return item;

  const details = await fetchCirclePostDetails(postId);

  updateItemHydration(item.id, {
    posterUrl: details.posterUrl || item.poster_url,
    posterChecked: 1,
    filesJson: JSON.stringify(details.files),
    seasonsJson: JSON.stringify(details.seasons),
    totalSize: details.totalSize,
    year: details.year,
  });

  if (details.meta && (details.meta.overview || details.meta.runtime)) {
    const existingMeta = safeJson(item.meta_json, {});
    updateItemMetadata(item.id, { ...existingMeta, ...details.meta }, details.posterUrl);
  }

  return getItemById(item.id);
}

async function hydrateIccItem(item, { deep = false } = {}) {
  const playId = item.source_id || item.url.match(/play=(\d+)/)?.[1];
  if (!playId) return item;

  const details = await fetchIccPlayerDetails(playId);
  let files = details.files;
  let seasons = [];
  let totalSize = details.totalSize;

  // If this is a TV series (or has multiple episodes / merged ICC season siblings), organize cleanly into Season tabs!
  if (item.media_type === "series" && deep) {
    const seasonMap = new Map();
    const ownSeasonName = item.season_hint || (details.videoFiles.length > 1 ? "Season 1" : null);

    if (ownSeasonName && details.videoFiles.length > 0) {
      seasonMap.set(ownSeasonName.toLowerCase(), {
        name: ownSeasonName,
        href: item.href,
        url: item.url,
        source: "icc",
        episodes: details.videoFiles,
        subtitles: details.subtitles,
      });
      files = [];
    }

    // Hydrate any merged ICC season siblings (e.g. Season 1, Season 2, Season 3) under the same canonical show!
    const mirrors = getMergedMirrors(item).filter((m) => m.source === "icc" && m.source_id);
    const seasonSiblings = mirrors.filter((m) => m.season_hint).slice(0, 12);
    if (seasonSiblings.length > 0) {
      await mapWithConcurrency(seasonSiblings, 4, async (sib) => {
        const sKey = sib.season_hint.toLowerCase();
        if (seasonMap.has(sKey)) return;
        try {
          const sibDetails = await fetchIccPlayerDetails(sib.source_id);
          if (sibDetails.videoFiles.length > 0) {
            totalSize += sibDetails.totalSize;
            seasonMap.set(sKey, {
              name: sib.season_hint,
              href: sib.href,
              url: sib.url,
              source: "icc",
              episodes: sibDetails.videoFiles,
              subtitles: sibDetails.subtitles,
            });
          }
        } catch {}
      });
    }

    seasons = [...seasonMap.values()].sort((a, b) =>
      a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" })
    );
  }

  updateItemHydration(item.id, {
    posterUrl: details.posterUrl || item.poster_url,
    posterChecked: 1,
    filesJson: JSON.stringify(files),
    seasonsJson: JSON.stringify(seasons),
    totalSize,
    year: details.year,
  });

  // Save built-in ICC Plot / Genre / Director / Cast / Trailer immediately!
  if (details.meta && (details.meta.overview || details.meta.cast || details.meta.genres?.length)) {
    const existingMeta = safeJson(item.meta_json, {});
    updateItemMetadata(item.id, { ...existingMeta, ...details.meta }, details.posterUrl);
  }

  return getItemById(item.id);
}

async function hydrateDhakaFlixItem(item, { deep = false } = {}) {
  const entries = await listDirectory(item.origin, item.href, 10000);
  const images = entries.filter((e) => !e.isDir && e.kind === "image");
  const videos = entries.filter((e) => !e.isDir && e.kind === "video");
  const subtitles = entries.filter((e) => !e.isDir && e.kind === "subtitle");
  const subDirs = entries.filter((e) => e.isDir);

  let posterUrl = pickBestPoster(images);
  const files = [
    ...videos.map((v, idx) => ({
      ...v,
      ...parseEpisodeFile(v.name, idx),
      quality: inferQualityFromText(v.name),
    })),
    ...subtitles.map((s) => ({ ...s })),
  ];

  let seasons = [];
  let totalSize = videos.reduce((acc, v) => acc + (v.size || 0), 0);

  if (subDirs.length > 0) {
    const sortedDirs = [...subDirs].sort((a, b) =>
      a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" })
    );

    if (deep) {
      seasons = await mapWithConcurrency(sortedDirs, 4, async (dir) => {
        try {
          const sEntries = await listDirectory(item.origin, dir.href, 10000);
          const sVideos = sEntries
            .filter((e) => !e.isDir && e.kind === "video")
            .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }));
          const sSubs = sEntries.filter((e) => !e.isDir && e.kind === "subtitle");
          if (!posterUrl) {
            const sImgs = sEntries.filter((e) => !e.isDir && e.kind === "image");
            posterUrl = pickBestPoster(sImgs);
          }
          const episodes = sVideos.map((v, idx) => ({
            ...v,
            ...parseEpisodeFile(v.name, idx),
            quality: inferQualityFromText(v.name),
          }));
          totalSize += sVideos.reduce((acc, v) => acc + (v.size || 0), 0);
          return {
            name: dir.name,
            href: dir.href,
            url: dir.url,
            source: item.source || "dhakaflix",
            episodes,
            subtitles: sSubs,
          };
        } catch {
          return { name: dir.name, href: dir.href, url: dir.url, source: item.source || "dhakaflix", episodes: [], subtitles: [] };
        }
      });

      // Bonus: if ICC FTP has a newer season not yet uploaded to DhakaFlix, merge it seamlessly!
      const existingSeasonNums = new Set(
        seasons.map((s) => s.name.match(/\d+/)?.[0]).filter(Boolean)
      );
      const iccExtraSeasons = getMergedMirrors(item)
        .filter((m) => m.source === "icc" && m.source_id && m.season_hint)
        .filter((m) => {
          const num = m.season_hint.match(/\d+/)?.[0];
          return num && !existingSeasonNums.has(num);
        })
        .slice(0, 4);

      if (iccExtraSeasons.length > 0) {
        const added = await mapWithConcurrency(iccExtraSeasons, 3, async (sib) => {
          try {
            const sibDetails = await fetchIccPlayerDetails(sib.source_id);
            if (sibDetails.videoFiles.length === 0) return null;
            return {
              name: `${sib.season_hint} (ICC)`,
              href: sib.href,
              url: sib.url,
              source: "icc",
              episodes: sibDetails.videoFiles,
              subtitles: sibDetails.subtitles,
            };
          } catch {
            return null;
          }
        });
        for (const a of added) if (a) seasons.push(a);
        seasons.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }));
      }
    } else {
      seasons = sortedDirs.map((dir) => ({
        name: dir.name,
        href: dir.href,
        url: dir.url,
      }));
    }
  }

  updateItemHydration(item.id, {
    posterUrl,
    posterChecked: 1,
    filesJson: JSON.stringify(files),
    seasonsJson: JSON.stringify(seasons),
    totalSize,
  });

  return getItemById(item.id);
}

/**
 * Enrich movie/TV details using free, zero-API-key metadata APIs (TVMaze, IMDb Suggest, Wikipedia).
 */
export async function enrichItemMetadata(item) {
  if (!item) return {};
  const existing = safeJson(item.meta_json, {});
  if (item.meta_checked && existing.overview) {
    return existing;
  }
  if (inFlightEnrichments.has(item.id)) {
    return inFlightEnrichments.get(item.id);
  }

  const promise = (async () => {
    const meta = { ...existing };
    let fallbackPoster = null;

    try {
      const cleanQuery = item.title.replace(/[:\-–—]/g, " ").replace(/\s+/g, " ").trim();

      if (item.media_type === "series" && !meta.overview) {
        try {
          const r = await fetch(
            `https://api.tvmaze.com/search/shows?q=${encodeURIComponent(cleanQuery)}`,
            { signal: AbortSignal.timeout(4500), headers: { "User-Agent": "CineVault/1.0" } }
          );
          if (r.ok) {
            const list = await r.json();
            const match = pickBestTvMazeMatch(list, item.year);
            if (match?.show) {
              const s = match.show;
              meta.overview = meta.overview || stripHtml(s.summary);
              meta.genres = meta.genres?.length ? meta.genres : Array.isArray(s.genres) ? s.genres : [];
              meta.rating = meta.rating || s.rating?.average || null;
              meta.runtime = meta.runtime || s.averageRuntime || s.runtime || null;
              meta.status = s.status || null;
              meta.network = s.network?.name || s.webChannel?.name || null;
              meta.imdbId = meta.imdbId || s.externals?.imdb || null;
              meta.source = meta.source || "TVMaze";
              if (s.image?.original || s.image?.medium) {
                fallbackPoster = s.image.original || s.image.medium;
              }
            }
          }
        } catch {}
      }

      if (!meta.imdbId || !meta.cast) {
        try {
          const qNorm = cleanQuery.toLowerCase().replace(/[^a-z0-9 ]/g, "").trim();
          const firstChar = /^[a-z0-9]/.test(qNorm) ? qNorm[0] : "x";
          const slug = encodeURIComponent(qNorm.slice(0, 60));
          const r = await fetch(
            `https://v3.sg.media-imdb.com/suggestion/${firstChar}/${slug}.json`,
            { signal: AbortSignal.timeout(4500), headers: { "User-Agent": "CineVault/1.0" } }
          );
          if (r.ok) {
            const data = await r.json();
            const best = pickBestImdbMatch(data.d || [], item.year, item.media_type);
            if (best) {
              if (!meta.imdbId && best.id?.startsWith("tt")) meta.imdbId = best.id;
              if (!meta.cast && best.s) meta.cast = best.s;
              if (!meta.source) meta.source = "IMDb";
              if (!fallbackPoster && best.i?.imageUrl) {
                fallbackPoster = best.i.imageUrl.replace(/\._V1_.*\.jpg$/i, "._V1_UX600_.jpg");
              }
            }
          }
        } catch {}
      }

      if (!meta.overview) {
        const wikiCandidates = [
          item.year ? `${item.title} (${item.year} film)` : null,
          `${item.title} (film)`,
          item.title,
        ].filter(Boolean);

        for (const candidate of wikiCandidates) {
          try {
            const r = await fetch(
              `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(candidate.replace(/\s+/g, "_"))}`,
              { signal: AbortSignal.timeout(3500), headers: { "User-Agent": "CineVault/1.0 (personal-media-server)" } }
            );
            if (r.ok) {
              const w = await r.json();
              if (w.type === "standard" && w.extract && !/may refer to/i.test(w.extract)) {
                if (item.media_type === "movie" && !/film|movie|directed|starring|series|documentary|animated|drama|comedy|thriller|action/i.test(w.extract)) {
                  continue;
                }
                meta.overview = w.extract.length > 480 ? w.extract.slice(0, 477) + "..." : w.extract;
                meta.wikiUrl = w.content_urls?.desktop?.page || null;
                break;
              }
            }
          } catch {}
        }
      }
    } finally {
      updateItemMetadata(item.id, meta, fallbackPoster);
      inFlightEnrichments.delete(item.id);
    }

    return meta;
  })();

  inFlightEnrichments.set(item.id, promise);
  return promise;
}

function pickBestTvMazeMatch(list, year) {
  if (!Array.isArray(list) || list.length === 0) return null;
  if (!year) return list[0];
  const exact = list.find((e) => e.show?.premiered && Math.abs(parseInt(e.show.premiered.slice(0, 4), 10) - year) <= 1);
  return exact || list[0];
}

function pickBestImdbMatch(list, year, mediaType) {
  const titles = list.filter((x) => x.id?.startsWith("tt"));
  if (titles.length === 0) return null;
  const preferSeries = mediaType === "series";
  const scored = titles.map((t) => {
    let score = 0;
    const isTv = /tv|series|mini/i.test(t.qid || t.q || "");
    if (preferSeries === isTv) score += 30;
    if (year && t.y) {
      const diff = Math.abs(t.y - year);
      if (diff === 0) score += 50;
      else if (diff === 1) score += 25;
      else score -= Math.min(diff, 20);
    }
    if (t.i?.imageUrl) score += 10;
    return { t, score };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored[0]?.t || null;
}

function stripHtml(html) {
  if (!html) return null;
  return html.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim() || null;
}

/**
 * Serve poster from DhakaFlix / ICC FTP (or external fallback, or generated Cinema SVG poster).
 */
export async function servePoster(id, res) {
  let item = getItemById(id);
  if (!item) {
    res.writeHead(404);
    res.end("Not found");
    return;
  }

  if (!item.poster_url && !item.poster_checked) {
    item = await hydrateItem(id, { deep: false });
  }

  if (item && !item.poster_url && !item.meta_checked) {
    await enrichItemMetadata(item);
    item = getItemById(id);
  }

  const posterUrl = item?.poster_url;
  if (
    posterUrl &&
    (isAllowedUrl(posterUrl) ||
      posterUrl.startsWith("https://m.media-amazon.com/") ||
      posterUrl.startsWith("https://static.tvmaze.com/"))
  ) {
    try {
      const headers = posterUrl.startsWith(ICC_ORIGIN) ? { Referer: `${ICC_ORIGIN}/` } : {};
      const upstream = await fetch(posterUrl, { headers, signal: AbortSignal.timeout(7000) });
      if (upstream.ok) {
        const contentType = upstream.headers.get("content-type") || "image/jpeg";
        const buf = Buffer.from(await upstream.arrayBuffer());
        if (buf.length > 500) {
          res.writeHead(200, {
            "Content-Type": contentType,
            "Content-Length": buf.length,
            "Cache-Control": "public, max-age=604800, immutable",
          });
          res.end(buf);
          return;
        }
      }
    } catch {}
  }

  const svg = generateFallbackPosterSvg(item);
  res.writeHead(200, {
    "Content-Type": "image/svg+xml; charset=utf-8",
    "Cache-Control": "public, max-age=3600",
  });
  res.end(svg);
}

function generateFallbackPosterSvg(item) {
  const title = item?.title || "Untitled";
  const year = item?.year ? String(item.year) : "";
  const badge = item?.quality || (item?.media_type === "series" ? "SERIES" : "MOVIE");

  let hash = 0;
  for (let i = 0; i < title.length; i++) hash = (hash * 31 + title.charCodeAt(i)) >>> 0;
  const palettes = [
    ["#1a1f36", "#3b1d38", "#e50914"],
    ["#0f2027", "#203a43", "#f59e0b"],
    ["#1b1429", "#372152", "#ec4899"],
    ["#102026", "#1b3b4b", "#38bdf8"],
    ["#231515", "#4a1c1c", "#ef4444"],
    ["#12221a", "#1f3d2e", "#10b981"],
  ];
  const [c1, c2, accent] = palettes[hash % palettes.length];

  const words = title.split(/\s+/);
  const lines = [];
  let current = "";
  for (const w of words) {
    if ((current + " " + w).trim().length <= 16) {
      current = (current + " " + w).trim();
    } else {
      if (current) lines.push(current);
      current = w.slice(0, 18);
      if (lines.length >= 3) break;
    }
  }
  if (current && lines.length < 4) lines.push(current);

  const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const lineEls = lines
    .map((l, i) => `<text x="28" y="${260 + i * 34}" fill="#f8fafc" font-family="system-ui,-apple-system,Segoe UI,sans-serif" font-weight="700" font-size="26">${esc(l)}</text>`)
    .join("");

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 450" width="300" height="450">
    <defs>
      <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0%" stop-color="${c1}"/>
        <stop offset="100%" stop-color="${c2}"/>
      </linearGradient>
      <radialGradient id="glow" cx="80%" cy="20%" r="65%">
        <stop offset="0%" stop-color="${accent}" stop-opacity="0.32"/>
        <stop offset="100%" stop-color="${accent}" stop-opacity="0"/>
      </radialGradient>
    </defs>
    <rect width="300" height="450" fill="url(#bg)"/>
    <rect width="300" height="450" fill="url(#glow)"/>
    <rect x="24" y="24" width="6" height="42" rx="3" fill="${accent}"/>
    <text x="42" y="45" fill="#94a3b8" font-family="system-ui,sans-serif" font-size="13" font-weight="600" letter-spacing="2">CINEVAULT</text>
    <text x="42" y="64" fill="#cbd5e1" font-family="system-ui,sans-serif" font-size="12">${esc(badge)}${year ? " • " + esc(year) : ""}</text>
    ${lineEls}
    <rect x="28" y="408" width="60" height="4" rx="2" fill="${accent}" opacity="0.85"/>
  </svg>`;
}

export function getServerDisplayName(item) {
  if (!item) return "Server";
  if (item.source === "discoveryftp" || (item.origin || "").includes("discoveryftp.net")) {
    const cm = (item.origin || "").match(/cdn(\d+)\.discoveryftp\.net/i);
    return cm ? `DiscoveryFTP CDN-${cm[1]}` : "DiscoveryFTP";
  }
  if (item.source === "circleftp" || (item.origin || "").includes("circleftp.net")) return "CircleFTP";
  if (item.source === "icc" || (item.origin || "").includes("10.16.100.")) return "ICC FTP";
  const m = (item.origin || "").match(/172\.16\.50\.(\d+)/);
  if (m) return `DhakaFlix ${m[1]}`;
  return "DhakaFlix";
}

export function inferQualityFromText(text, fallback = null) {
  const s = text || "";
  if (/\b(2160p|4K|UHD)\b/i.test(s)) return "4K";
  if (/\[3D\]|\b3D\b/i.test(s)) return "3D";
  if (/\b1080p\b/i.test(s)) return "1080p";
  if (/\b720p\b/i.test(s)) return "720p";
  if (/\b480p\b/i.test(s)) return "480p";
  return fallback || null;
}

function qualityRankValue(q) {
  const u = (q || "").toUpperCase();
  if (u === "4K" || u === "2160P") return 500;
  if (u === "3D") return 420;
  if (u === "1080P") return 400;
  if (u === "720P") return 300;
  if (u === "480P") return 200;
  return 100;
}

/**
 * Hydrate an item AND all of its deduplicated quality/server editions in parallel
 * so DetailModal can display EVERY available quality across DhakaFlix & ICC FTP
 * with direct Play / Download / VLC controls pointing to each quality's server!
 */
export async function hydrateAllEditions(primaryItem, mirrors = [], { force = false } = {}) {
  const candidates = [primaryItem, ...mirrors.slice(0, 10)];

  const hydrated = await mapWithConcurrency(candidates, 6, async (cand) => {
    try {
      const h = await hydrateItem(cand.id, { deep: true, force });
      return h || cand;
    } catch {
      return cand;
    }
  });

  const seenVideoUrls = new Set();
  const editions = [];

  for (const h of hydrated) {
    const rawFiles = safeJson(h.files_json, []);
    const videoFiles = rawFiles.filter((f) => f.kind === "video");
    const subtitles = rawFiles.filter((f) => f.kind === "subtitle");
    const seasons = safeJson(h.seasons_json, []);

    // Infer crisp resolution directly from actual video filename if catalog title lacked one
    const firstFileName = videoFiles[0]?.name || seasons[0]?.episodes?.[0]?.name || h.raw_name;
    const detectedQuality =
      h.quality || inferQualityFromText(firstFileName) || inferQualityFromText(h.raw_name) || "HD";

    // Infer extra audio tag from actual filename (e.g. "[Dual Audio][Hindi 5.1+English 5.1]")
    let audioTags = h.audio_tags;
    if (!audioTags && /Dual[\s.]*Audio|Hindi.*English|English.*Hindi/i.test(firstFileName || "")) {
      audioTags = "Dual Audio";
    } else if (!audioTags && /Multi[\s.]*Audio/i.test(firstFileName || "")) {
      audioTags = "Multi Audio";
    }

    // Deduplicate identical video URLs across mirrors & infer crisp per-file quality (handles folders with both 4K & 1080p!)
    const uniqueVideos = videoFiles
      .filter((v) => {
        if (seenVideoUrls.has(v.url)) return false;
        seenVideoUrls.add(v.url);
        return true;
      })
      .map((v) => {
        const fq = v.quality || inferQualityFromText(v.name) || detectedQuality;
        return { ...v, quality: fq, qualityRank: qualityRankValue(fq) };
      })
      .sort((a, b) => (b.qualityRank - a.qualityRank) || ((b.size || 0) - (a.size || 0)));

    const bestEditionQuality = uniqueVideos[0]?.quality || detectedQuality;
    const hasPlayable = uniqueVideos.length > 0 || seasons.some((s) => (s.episodes || []).length > 0);
    const anyOnline = uniqueVideos.length === 0 ? true : uniqueVideos.some((v) => v.online !== false);

    editions.push({
      id: h.id,
      isPrimary: h.id === primaryItem.id,
      source: h.source || "dhakaflix",
      serverLabel: getServerDisplayName(h),
      category: h.category,
      rawName: h.raw_name,
      url: h.url,
      quality: bestEditionQuality,
      qualityRank: qualityRankValue(bestEditionQuality),
      qualityScore: h.quality_score || 0,
      audioTags: audioTags || null,
      sourceTag: h.source_tag || null,
      imdbRank: h.imdb_rank || null,
      seasonHint: h.season_hint || null,
      totalSize: h.total_size || uniqueVideos.reduce((acc, v) => acc + (v.size || 0), 0),
      files: uniqueVideos,
      subtitles,
      seasons,
      hasPlayable,
      online: anyOnline,
    });
  }

  // Sort editions: playable & online first, then Highest Quality first (4K > 3D > 1080p > 720p > HD), then Dual Audio / score
  editions.sort((a, b) => {
    if (a.hasPlayable !== b.hasPlayable) return a.hasPlayable ? -1 : 1;
    if (a.online !== b.online) return a.online ? -1 : 1;
    if (b.qualityRank !== a.qualityRank) return b.qualityRank - a.qualityRank;
    if (b.qualityScore !== a.qualityScore) return b.qualityScore - a.qualityScore;
    return (b.totalSize || 0) - (a.totalSize || 0);
  });

  return editions;
}

export function safeJson(str, fallback) {
  if (!str) return fallback;
  try {
    return JSON.parse(str);
  } catch {
    return fallback;
  }
}
