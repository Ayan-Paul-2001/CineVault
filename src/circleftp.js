import path from "node:path";
import { CIRCLEFTP_ORIGIN, CIRCLEFTP_API } from "./config.js";
import { parseEpisodeFile, safeDecode, classifyFileKind } from "./parser.js";
import { mapWithConcurrency } from "./h5ai.js";

const DEFAULT_TIMEOUT_MS = 10000;

// Categories to exclude (Games, Software, Tutorials, Books, Others)
export const CIRCLEFTP_BLOCKED_CAT_IDS = new Set([10, 11, 12, 13, 14, 36, 250]);

// Map CircleFTP main category IDs to CineVault unified categories
export const CIRCLEFTP_CAT_MAP = {
  1: { category: "animation", mediaType: "movie" },
  2: { category: "hindi", mediaType: "movie", langHint: "Hindi" },
  3: { category: "south-dubbed", mediaType: "movie", audioHint: "Hindi Dubbed" },
  4: { category: "south-indian", mediaType: "movie" },
  5: { category: "tv-series", mediaType: "series", langHint: "Hindi" },
  6: { category: "english", mediaType: "movie" },
  7: { category: "english-1080p", mediaType: "movie", audioHint: "Dual Audio" },
  8: { category: "foreign", mediaType: "movie" },
  9: { category: "tv-series", mediaType: "series" },
  15: { category: "wrestling", mediaType: "series" },
  20: { category: "animation", mediaType: "movie", audioHint: "Dual Audio" },
  21: { category: "anime", mediaType: "series" },
  22: { category: "tv-series", mediaType: "series", audioHint: "Dual Audio" },
  85: { category: "documentary", mediaType: "movie" },
  238: { category: "awards-shows", mediaType: "series", langHint: "Hindi" },
  251: { category: "awards-shows", mediaType: "series" },
};

export function circlePosterUrl(post) {
  const img = post?.image || post?.imageSm;
  if (!img) return null;
  if (img.startsWith("http")) return img;
  return `${CIRCLEFTP_ORIGIN}:5000/uploads/${img.replace(/^\/+/, "")}`;
}

/**
 * Determine whether a CircleFTP post is a valid movie/series (excluding Games, Software, Books, Tutorials).
 */
export function classifyCirclePost(post) {
  if (!post || !post.id) return null;
  if (post.type !== "singleVideo" && post.type !== "series") return null;

  const cats = Array.isArray(post.categories) ? post.categories : [];
  for (const c of cats) {
    if (CIRCLEFTP_BLOCKED_CAT_IDS.has(Number(c.id)) || CIRCLEFTP_BLOCKED_CAT_IDS.has(Number(c.parentId))) {
      return null;
    }
  }

  let mapped = null;
  for (const c of cats) {
    const cid = Number(c.parentId || c.id);
    if (CIRCLEFTP_CAT_MAP[cid]) {
      mapped = CIRCLEFTP_CAT_MAP[cid];
      break;
    }
  }

  const isSeries = post.type === "series" || mapped?.mediaType === "series";
  const category = mapped?.category || (isSeries ? "tv-series" : "english");
  const subGroup = cats.find((c) => c.type === "sub")?.name || cats[0]?.name || "CircleFTP";

  return {
    category,
    mediaType: isSeries ? "series" : "movie",
    audioHint: mapped?.audioHint || null,
    langHint: mapped?.langHint || null,
    subGroup,
  };
}

/**
 * Fetch a page of CircleFTP posts (newest first via order=desc, 500 per page!).
 */
export async function fetchCirclePostsPage(page = 1, limit = 500) {
  const res = await fetch(
    `${CIRCLEFTP_API}/posts?limit=${limit}&page=${page}&order=desc`,
    { signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS) }
  );
  if (!res.ok) throw new Error(`CircleFTP HTTP ${res.status}`);
  return await res.json();
}

/**
 * High-speed delta-aware CircleFTP crawler!
 * - `limit=500` with `order=desc` means ALL ~54,000 posts are only ~109 JSON requests (~4s at concurrency 8!).
 * - When `stopOnKnown = true` (Quick Sync OR incremental Full Sync when CircleFTP already synced once),
 *   stops immediately once all valid posts on a page are already in our DB (< 0.3s!!).
 */
export async function crawlCircleFtp({
  knownUrls = null,
  stopOnKnown = false,
  prevMaxId = 0,
  onBatch = null,
  onProgress = null,
} = {}) {
  const first = await fetchCirclePostsPage(1, 500);
  const firstPosts = Array.isArray(first.posts) ? first.posts : [];
  const totalPages = Math.max(1, Number(first.pagination?.pages) || 1);
  const highestId = firstPosts.reduce((mx, p) => Math.max(mx, Number(p.id) || 0), 0);

  if (onBatch && firstPosts.length > 0) onBatch(firstPosts);
  if (onProgress) onProgress(1, totalPages, highestId);

  // Delta fast-path: highest post ID unchanged -> 0 new posts on CircleFTP!
  if (prevMaxId > 0 && highestId > 0 && highestId <= prevMaxId) {
    return { totalPages: 1, highestId, skippedDelta: true };
  }

  // Stop immediately if page 1 already crossed below prevMaxId (all new posts were on page 1!)
  const p1MinId = firstPosts.reduce((mn, p) => Math.min(mn, Number(p.id) || Infinity), Infinity);
  if (stopOnKnown && prevMaxId > 0 && p1MinId <= prevMaxId) {
    return { totalPages: 1, highestId, skippedDelta: false };
  }

  if (totalPages <= 1) {
    return { totalPages: 1, highestId, skippedDelta: false };
  }

  // If incremental with prevMaxId, step forward sequentially (usually just 1-3 pages!)
  if (stopOnKnown && prevMaxId > 0) {
    for (let p = 2; p <= Math.min(totalPages, 25); p++) {
      const data = await fetchCirclePostsPage(p, 500);
      const posts = Array.isArray(data.posts) ? data.posts : [];
      if (posts.length === 0) break;
      if (onBatch) onBatch(posts);
      if (onProgress) onProgress(p, totalPages, highestId);
      const minId = posts.reduce((mn, x) => Math.min(mn, Number(x.id) || Infinity), Infinity);
      const allKnown =
        knownUrls &&
        posts.every((x) => x.type === "singleFile" || knownUrls.has(`${CIRCLEFTP_API}/posts/${x.id}`));
      if (minId <= prevMaxId || allKnown) break;
    }
    return { totalPages, highestId, skippedDelta: false };
  }

  // Full cold crawl: 8 concurrent JSON page workers -> ~109 pages in ~3.5 seconds!
  const pageNums = Array.from({ length: totalPages - 1 }, (_, i) => i + 2);
  let done = 1;
  await mapWithConcurrency(pageNums, 8, async (p) => {
    try {
      const data = await fetchCirclePostsPage(p, 500);
      const posts = Array.isArray(data.posts) ? data.posts : [];
      if (onBatch && posts.length > 0) onBatch(posts);
    } catch {}
    done++;
    if (onProgress) onProgress(done, totalPages, highestId);
  });

  return { totalPages, highestId, skippedDelta: false };
}

/**
 * Live search against CircleFTP REST API.
 */
export async function searchCircleUpstream(query, timeoutMs = 6000) {
  const res = await fetch(
    `${CIRCLEFTP_API}/posts?searchTerm=${encodeURIComponent(query)}&limit=25`,
    { signal: AbortSignal.timeout(timeoutMs) }
  );
  if (!res.ok) return [];
  const data = await res.json();
  const posts = Array.isArray(data.posts) ? data.posts : [];
  return posts
    .filter((p) => classifyCirclePost(p) !== null)
    .map((p) => ({
      name: p.title || p.name,
      url: `${CIRCLEFTP_API}/posts/${p.id}`,
      href: `/api/posts/${p.id}`,
      origin: `${CIRCLEFTP_ORIGIN}:5000`,
      isDir: false,
      size: 0,
      kind: "circleftp",
      postId: String(p.id),
      posterUrl: circlePosterUrl(p),
    }));
}

async function probeSizeQuick(url, timeoutMs = 2000) {
  try {
    const r = await fetch(url, {
      headers: { Range: "bytes=0-0" },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!r.ok && r.status !== 206) return { ok: false, size: 0 };
    const cr = r.headers.get("content-range") || "";
    const totalMatch = cr.match(/\/(\d+)$/);
    const size = totalMatch
      ? parseInt(totalMatch[1], 10)
      : parseInt(r.headers.get("content-length") || "0", 10) || 0;
    return { ok: true, size };
  } catch {
    return { ok: false, size: 0 };
  }
}

/**
 * Hydrate a CircleFTP post from GET /api/posts/:id.
 * Handles both `singleVideo` (direct video URL) and `series` (all seasons + episodes!).
 */
export async function fetchCirclePostDetails(postId) {
  const res = await fetch(`${CIRCLEFTP_API}/posts/${encodeURIComponent(postId)}`, {
    signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`CircleFTP post HTTP ${res.status}`);
  const post = await res.json();

  const posterUrl = circlePosterUrl(post);
  const year = post.year ? parseInt(String(post.year).slice(0, 4), 10) || null : null;

  // Parse watchTime ("2h 28m") into minutes
  let runtime = null;
  if (post.watchTime) {
    const hm = String(post.watchTime).match(/(?:(\d+)\s*h)?\s*(?:(\d+)\s*m)?/i);
    if (hm && (hm[1] || hm[2])) {
      runtime = (parseInt(hm[1] || "0", 10) * 60) + parseInt(hm[2] || "0", 10);
    }
  }

  const meta = {
    overview: post.metaData ? String(post.metaData).trim() : null,
    runtime,
    source: "CircleFTP",
  };

  let files = [];
  let seasons = [];
  let totalSize = 0;

  if (typeof post.content === "string" && post.content.startsWith("http")) {
    const videoUrl = post.content.trim();
    const uPath = safeDecode(new URL(videoUrl).pathname);
    const fileName = path.basename(uPath) || post.title || "video.mkv";
    const probe = await probeSizeQuick(videoUrl, 2200);
    totalSize = probe.size || 0;
    files = [
      {
        name: fileName,
        href: uPath,
        url: videoUrl,
        isDir: false,
        size: probe.size || 0,
        time: post.updatedAt ? Date.parse(post.updatedAt) || 0 : 0,
        kind: classifyFileKind(fileName) === "other" ? "video" : classifyFileKind(fileName),
        online: probe.ok,
        ...parseEpisodeFile(fileName, 0),
      },
    ];
  } else if (Array.isArray(post.content)) {
    seasons = post.content
      .map((s, sIdx) => {
        const sName = (s.seasonName || s.title || `Season ${sIdx + 1}`).trim();
        const rawEps = Array.isArray(s.episodes) ? s.episodes : [];
        const episodes = rawEps
          .filter((ep) => ep?.link && /^https?:\/\//i.test(ep.link))
          .map((ep, idx) => {
            const url = ep.link.trim();
            let fileName = ep.title || `Episode ${idx + 1}`;
            try {
              const pName = path.basename(safeDecode(new URL(url).pathname));
              if (pName) fileName = pName;
            } catch {}
            return {
              name: fileName,
              href: url,
              url,
              isDir: false,
              size: 0,
              time: 0,
              kind: "video",
              ...parseEpisodeFile(fileName, idx),
            };
          });
        return {
          name: sName,
          href: `${CIRCLEFTP_API}/posts/${postId}#${sIdx}`,
          url: `${CIRCLEFTP_ORIGIN}/content/${postId}`,
          source: "circleftp",
          episodes,
          subtitles: [],
        };
      })
      .filter((s) => s.episodes.length > 0)
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }));

    // Quick probe first episode size so UI knows file size / liveness
    if (seasons[0]?.episodes?.[0]?.url) {
      const p0 = await probeSizeQuick(seasons[0].episodes[0].url, 2200);
      if (p0.size > 0) {
        seasons[0].episodes[0].size = p0.size;
        totalSize = p0.size;
      }
    }
  }

  return {
    files,
    seasons,
    posterUrl,
    year,
    meta,
    totalSize,
  };
}

export async function checkCircleHealth() {
  const t0 = Date.now();
  try {
    const r = await fetch(`${CIRCLEFTP_API}/posts?limit=1&page=1`, {
      signal: AbortSignal.timeout(3500),
    });
    if (!r.ok) return { online: false, latencyMs: null };
    const text = (await r.text()).trim();
    const valid = text.startsWith("{") && text.includes('"posts"');
    return { online: valid, latencyMs: valid ? Date.now() - t0 : null };
  } catch {
    return { online: false, latencyMs: null };
  }
}
