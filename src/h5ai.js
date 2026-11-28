import { safeDecode, classifyFileKind } from "./parser.js";
import { ICC_CATEGORIES, normalizeServerInputUrl } from "./config.js";

const DEFAULT_TIMEOUT_MS = 10000;

/**
 * Properly percent-encode each segment of an h5ai path while keeping `/` intact.
 * Fixes servers like DiscoveryFTP that return raw spaces or `#` characters in JSON hrefs!
 */
export function encodeHrefPath(rawHref) {
  if (!rawHref) return "/";
  const trailingSlash = rawHref.endsWith("/");
  const segs = rawHref.split("/").filter((s) => s.length > 0);
  const encoded = "/" + segs.map((s) => encodeURIComponent(safeDecode(s))).join("/");
  return trailingSlash ? (encoded === "/" ? "/" : encoded + "/") : encoded;
}

/**
 * Fetch immediate children of an h5ai directory using h5ai's native JSON API,
 * with transparent fallback to h5ai's HTML fallback <table>.
 */
export async function listDirectory(origin, href, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const normalizedHref = encodeHrefPath(href.endsWith("/") ? href : `${href}/`);
  const targetUrl = origin + normalizedHref;

  // Primary: h5ai JSON API (returns exact timestamps & byte sizes)
  try {
    const res = await fetch(targetUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json",
      },
      body: JSON.stringify({
        action: "get",
        items: { href: normalizedHref, what: 1 },
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (res.ok) {
      const contentType = res.headers.get("content-type") || "";
      if (contentType.includes("json")) {
        const data = await res.json();
        if (Array.isArray(data.items)) {
          return extractDirectChildren(origin, normalizedHref, data.items);
        }
      }
    }
  } catch (err) {
    // Fall through to GET HTML fallback if POST fails
    if (err?.name === "TimeoutError" || err?.name === "AbortError") {
      throw err;
    }
  }

  // Secondary: HTML fallback table parsing
  const htmlRes = await fetch(targetUrl, {
    method: "GET",
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!htmlRes.ok) {
    throw new Error(`HTTP ${htmlRes.status} for ${targetUrl}`);
  }
  const html = await htmlRes.text();
  return parseHtmlFallback(origin, normalizedHref, html);
}

function extractDirectChildren(origin, parentHref, items) {
  const decodedParent = safeDecode(parentHref);
  const results = [];

  for (const item of items) {
    const itemHref = item.href || "";
    if (!itemHref || itemHref === parentHref || itemHref === "/") continue;

    // Match either raw encoded prefix or decoded prefix
    let rel = null;
    if (itemHref.startsWith(parentHref)) {
      rel = itemHref.slice(parentHref.length);
    } else {
      const decodedItem = safeDecode(itemHref);
      if (decodedItem.startsWith(decodedParent) && decodedItem !== decodedParent) {
        rel = decodedItem.slice(decodedParent.length);
      }
    }
    if (!rel) continue;

    const isDir = itemHref.endsWith("/");
    const trimmed = rel.replace(/\/+$/, "");
    if (!trimmed || trimmed.includes("/")) continue;

    const name = safeDecode(trimmed);
    if (name === "." || name === ".." || name.startsWith("_h5ai") || name.toLowerCase() === "zpending") continue;

    const safeHref = encodeHrefPath(itemHref);
    results.push({
      name,
      href: safeHref,
      url: origin + safeHref,
      isDir,
      size: typeof item.size === "number" ? item.size : 0,
      time: typeof item.time === "number" ? item.time : 0,
      kind: isDir ? "dir" : classifyFileKind(name),
    });
  }

  return results;
}

function parseHtmlFallback(origin, parentHref, html) {
  const results = [];
  const rowRe = /<tr><td class="fb-i">.*?<\/td><td class="fb-n"><a href="([^"]+)">([^<]+)<\/a><\/td><td class="fb-d">([^<]*)<\/td><td class="fb-s">([^<]*)<\/td><\/tr>/gi;
  let m;
  while ((m = rowRe.exec(html)) !== null) {
    const href = m[1];
    const name = decodeHtmlEntities(m[2]).replace(/\/+$/, "").trim();
    const dateStr = m[3].trim();
    const sizeStr = m[4].trim();
    if (!href || href === ".." || name === "Parent Directory") continue;
    const isDir = href.endsWith("/");
    const absHref = encodeHrefPath(href.startsWith("/") ? href : parentHref + href);
    results.push({
      name,
      href: absHref,
      url: origin + absHref,
      isDir,
      size: parseHumanSize(sizeStr),
      time: dateStr ? Date.parse(dateStr.replace(" ", "T")) || 0 : 0,
      kind: isDir ? "dir" : classifyFileKind(name),
    });
  }
  if (results.length > 0) return results;

  // Universal fallback: standard Apache, Nginx, Caddy, IIS & generic HTTP directory autoindex listings
  return parseGenericAutoindexHtml(origin, parentHref, html);
}

export function parseGenericAutoindexHtml(origin, parentHref, html) {
  const results = [];
  const seen = new Set();
  const normParent = encodeHrefPath(parentHref.endsWith("/") ? parentHref : `${parentHref}/`);
  const baseUrl = new URL(origin + normParent);
  const linkRe = /<a\b[^>]*href=["']([^"'#]+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m;

  while ((m = linkRe.exec(html)) !== null) {
    const rawHref = decodeHtmlEntities(m[1]).trim();
    const rawLabel = decodeHtmlEntities(m[2].replace(/<[^>]+>/g, "")).trim();
    if (!rawHref || rawHref.startsWith("?") || rawHref.startsWith("javascript:") || rawHref.startsWith("mailto:")) {
      continue;
    }
    if (
      rawHref === "." ||
      rawHref === "./" ||
      rawHref === ".." ||
      rawHref === "../" ||
      /^parent directory$/i.test(rawLabel) ||
      /^name$|^last modified$|^size$|^description$/i.test(rawLabel)
    ) {
      continue;
    }

    let resolved;
    try {
      resolved = new URL(rawHref, baseUrl);
    } catch {
      continue;
    }
    if (resolved.origin !== baseUrl.origin) continue;
    if (resolved.search && !resolved.pathname.endsWith("/")) continue;

    const absPath = encodeHrefPath(resolved.pathname);
    if (absPath === normParent || absPath === "/" || !absPath.startsWith(normParent)) continue;

    const rel = absPath.slice(normParent.length);
    const isDir = absPath.endsWith("/");
    const trimmedRel = rel.replace(/\/+$/, "");
    if (!trimmedRel || trimmedRel.includes("/")) continue;

    const name = safeDecode(trimmedRel);
    if (
      !name ||
      name === "." ||
      name === ".." ||
      name.startsWith("_h5ai") ||
      name.toLowerCase() === "cgi-bin" ||
      name.toLowerCase() === "icons" ||
      name.toLowerCase() === "zpending"
    ) {
      continue;
    }

    if (seen.has(absPath)) continue;
    seen.add(absPath);

    // Optional size/date hint immediately following the </a> tag on Apache/Nginx preformatted listings
    const after = html.slice(linkRe.lastIndex, linkRe.lastIndex + 120);
    const firstLine = after.split(/[\r\n<]/)[0] || "";
    const size = parseHumanSize(firstLine);
    const dateMatch = firstLine.match(/(\d{4}-\d{2}-\d{2}|\d{1,2}-[A-Za-z]{3}-\d{4})(?:[\sT]+(\d{2}:\d{2}(?::\d{2})?))?/);
    const time = dateMatch ? Date.parse(dateMatch[0]) || 0 : 0;

    results.push({
      name,
      href: absPath,
      url: origin + absPath,
      isDir,
      size,
      time,
      kind: isDir ? "dir" : classifyFileKind(name),
    });
  }

  return results;
}

const CONTAINER_FOLDER_RE = /^(movies?|films?|cinema|videos?|media|ftp\d*|data|files?|storage|drives?|disk\d*|hdd\d*|vol\d*|server\d*|dhaka[\s_-]*flix[\s_-]*\d*|icc[\s_-]*ftp|discovery[\s_-]*ftp|south[\s_-]*indian[\s_-]*movies?|tv[\s_-]*&?[\s_-]*web[\s_-]*series|series|shows?|english[\s_-]*&?[\s_-]*hindi|all[\s_-]*movies?|new[\s_-]*uploads?|collections?|library|archive|public|share|shared|index|root|content|hd|full[\s_-]*hd)$/i;
const BUCKET_FOLDER_RE = /^\(?\s*((?:19|20)\d{2}\s*\)?(?:\s*(?:[-–—&]|and|to)\s*\(?(?:(?:19|20)\d{2}|present|now|before|older)\)?)?(?:\s+(?:4k|2160p|uhd|1080p|720p|480p|hd|full[\s-]*hd|movies?|films?|&?\s*before|and\s+before))*|before\s*(?:19|20)\d{2}|classic|older|latest|[a-z]\s*[-–—]\s*[a-z]|0\s*[-–—]\s*9|[a-z]|#|\d{4}s|season\s*\d+|s\d{1,2})\s*\)?$/i;
const TITLE_FOLDER_HINT_RE = /\S{2,}\s*\(\s*(19|20)\d{2}\s*\)|\b(2160p|1080p|720p|480p|web-?dl|webrip|bluray|bdrip|hdrip|dvdrip|x264|x265|hevc|dual[\s._-]*audio|s\d{2}e\d{2})\b/i;

export function classifyDiscoveredFolder(rawName) {
  const n = (rawName || "").toLowerCase();
  const skipDefault = /\b(games?|pc\s*games?|ps\d|xbox|nintendo|software|softwares?|apps?|apk|tutorials?|courses?|ebooks?|books?|pdf|comics?|manga|music|songs?|mp3|flac|audio\s*books?|iso|drivers?|os|windows|linux|macos|wallpapers?|fonts?|themes?|plugins?|cracks?|patches?|others?\s*files?|sample|trailers?)\b/i.test(n);

  if (/\b(4k|2160p|uhd)\b/i.test(n)) return { category: "4k-movies", mediaType: "movie", mode: "bucketed", skipDefault };
  if (/\b(imdb|top\s*250)\b/i.test(n)) return { category: "imdb-top-250", mediaType: "movie", mode: "flat", skipDefault };
  if (/\b(korean|k-?drama|kdrama)\b/i.test(n)) return { category: "korean-series", mediaType: "series", mode: "flat", skipDefault };
  if (/\b(anime|cartoon)\b/i.test(n)) return { category: "anime", mediaType: "series", mode: "bucketed", skipDefault };
  if (/\b(wwe|aew|ufc|wrestling)\b/i.test(n)) return { category: "wrestling", mediaType: "series", mode: "flat", skipDefault };
  if (/\b(award|tv\s*show|reality|stand-?up)\b/i.test(n)) return { category: "awards-shows", mediaType: "series", mode: "flat", skipDefault };
  if (/\b(documentar|docu|natgeo|discovery\s*channel)\b/i.test(n)) return { category: "documentary", mediaType: "movie", mode: "flat", skipDefault };
  if (/\b(series|season|tv\s*series|web\s*series|serial|drama|natok|sitcom|miniseries)\b/i.test(n)) return { category: "tv-series", mediaType: "series", mode: "bucketed", skipDefault };
  if (/\b(hindi\s*dubbed|dubbed)\b/i.test(n)) return { category: "south-dubbed", mediaType: "movie", mode: "bucketed", skipDefault };
  if (/\b(south|tamil|telugu|malayalam|kannada)\b/i.test(n)) return { category: "south-indian", mediaType: "movie", mode: "bucketed", skipDefault };
  if (/\b(hindi|bollywood)\b/i.test(n)) return { category: "hindi", mediaType: "movie", mode: "bucketed", skipDefault };
  if (/\b(bangla|bengali|kolkata|dhallywood)\b/i.test(n)) return { category: "bangla", mediaType: "movie", mode: "bucketed", skipDefault };
  if (/\b(animation|animated|pixar|disney)\b/i.test(n) && /\b1080p\b/i.test(n)) return { category: "animation-1080p", mediaType: "movie", mode: "flat", skipDefault };
  if (/\b(animation|animated|pixar|disney)\b/i.test(n)) return { category: "animation", mediaType: "movie", mode: "bucketed", skipDefault };
  if (/\b3d\b/i.test(n)) return { category: "3d-movies", mediaType: "movie", mode: "flat", skipDefault };
  if (/\b(english|hollywood)\b/i.test(n) && /\b1080p\b/i.test(n)) return { category: "english-1080p", mediaType: "movie", mode: "bucketed", skipDefault };
  if (/\b(english|hollywood)\b/i.test(n)) return { category: "english", mediaType: "movie", mode: "bucketed", skipDefault };
  return { category: "foreign", mediaType: "movie", mode: "bucketed", skipDefault };
}

const CATEGORY_FOLDER_WORD_RE = /\b(movies?|films?|tv[\s_-]*series|web[\s_-]*series|shows?|cartoons?|documentaries|collection|exclusive|dubbed)\b/i;
const TITLE_YEAR_RE = /\S{2,}\s*\(\s*(19|20)\d{2}\s*\)/;

export function isBucketLikeName(name) {
  return BUCKET_FOLDER_RE.test((name || "").trim());
}

function isTitleLikeName(name) {
  if (!name || isBucketLikeName(name)) return false;
  if (CATEGORY_FOLDER_WORD_RE.test(name) && !TITLE_YEAR_RE.test(name)) return false;
  return TITLE_FOLDER_HINT_RE.test(name);
}

function isContainerWrapperName(name) {
  return CONTAINER_FOLDER_RE.test((name || "").trim());
}

const FILE_EXT_PATH_RE = /\/[^/]+\.(php|html?|aspx?|jsp|cgi|cfm)$/i;
const ASSET_OR_DOC_EXT_RE = /\.(php|html?|aspx?|jsp|cgi|cfm|css|js|mjs|json|xml|txt|pdf|jpe?g|png|gif|webp|svg|ico|woff2?|ttf|eot|zip|rar|7z|tar|gz|exe|apk|iso|torrent)$/i;
const PORTAL_NAV_SKIP_RE = /^(cgi-bin|icons|css|js|images?|img|assets?|fonts?|static|zpending|login|logout|signin|signup|register|account|profile|about|contact|help|faq|terms|privacy|notice|search|cart|checkout|admin|wp-admin|wp-content|wp-includes|api|cdn-cgi|home|index)$/i;

export function normalizeServerRootHref(pathname) {
  let p = String(pathname || "/").trim();
  if (!p.startsWith("/")) p = "/" + p;
  if (FILE_EXT_PATH_RE.test(p)) {
    const lastSlash = p.lastIndexOf("/");
    p = lastSlash > 0 ? p.slice(0, lastSlash + 1) : "/";
  } else if (!p.endsWith("/")) {
    p += "/";
  }
  return encodeHrefPath(p);
}

function sameLanOrParentDomain(originA, originB) {
  try {
    const ha = new URL(originA).hostname.toLowerCase();
    const hb = new URL(originB).hostname.toLowerCase();
    if (ha === hb) return true;
    const ipA = ha.match(/^(\d+\.\d+\.\d+)\.\d+$/);
    const ipB = hb.match(/^(\d+\.\d+\.\d+)\.\d+$/);
    if (ipA && ipB) return ipA[1] === ipB[1];
    const pa = ha.split(".");
    const pb = hb.split(".");
    if (pa.length >= 2 && pb.length >= 2) {
      return pa.slice(-2).join(".") === pb.slice(-2).join(".");
    }
  } catch {}
  return false;
}

function extractPortalDirectoryLinks(origin, html) {
  const sameOriginResults = [];
  const siblingByOrigin = new Map();
  const seen = new Set();
  const linkRe = /<(?:a|iframe)\s+[^>]*(?:href|src)\s*=\s*["']([^"']+)["'][^>]*>/gi;
  let m;
  while ((m = linkRe.exec(html || "")) !== null) {
    const rawHref = (m[1] || "").trim();
    if (!rawHref || rawHref.startsWith("#") || rawHref.startsWith("?") || /^(javascript|mailto|tel|data):/i.test(rawHref)) {
      continue;
    }
    let resolved;
    try {
      resolved = new URL(rawHref, origin + "/");
    } catch {
      continue;
    }
    if (resolved.protocol !== "http:" && resolved.protocol !== "https:") continue;
    const rawPath = resolved.pathname || "/";
    if (rawPath === "/" || ASSET_OR_DOC_EXT_RE.test(rawPath)) continue;

    // Accept explicit trailing-slash directories OR clean extensionless directory paths (e.g. /movies, /tv-series)
    const normalizedPath = rawPath.endsWith("/") ? rawPath : `${rawPath}/`;
    const absPath = encodeHrefPath(normalizedPath);
    const fullKey = `${resolved.origin}${absPath}`;
    if (seen.has(fullKey)) continue;
    seen.add(fullKey);

    const segs = absPath.replace(/^\/|\/$/g, "").split("/").filter(Boolean);
    if (segs.length === 0) continue;
    const leaf = safeDecode(segs[segs.length - 1]);
    if (!leaf || leaf.startsWith("_h5ai") || PORTAL_NAV_SKIP_RE.test(leaf)) {
      continue;
    }

    const entry = {
      name: leaf,
      href: absPath,
      url: resolved.origin + absPath,
      origin: resolved.origin,
      isDir: true,
      size: 0,
      time: 0,
      kind: "dir",
    };

    if (resolved.origin === origin) {
      sameOriginResults.push(entry);
    } else if (rawPath.endsWith("/") && sameLanOrParentDomain(origin, resolved.origin)) {
      if (!siblingByOrigin.has(resolved.origin)) siblingByOrigin.set(resolved.origin, []);
      siblingByOrigin.get(resolved.origin).push(entry);
    }
  }

  if (sameOriginResults.length > 0) {
    return { origin, entries: sameOriginResults };
  }
  // If portal homepage only links to a sibling media node on the same LAN /24 or parent domain, adopt the richest one!
  let bestOrigin = origin;
  let bestEntries = [];
  for (const [sibOrigin, entries] of siblingByOrigin.entries()) {
    if (entries.length > bestEntries.length) {
      bestOrigin = sibOrigin;
      bestEntries = entries;
    }
  }
  return { origin: bestOrigin, entries: bestEntries };
}

const REAL_DIR_HTML_RE = /_h5ai|class=["']fb-n["']|<title>\s*Index of\b|<h1[^>]*>\s*Index of\b|Directory listing for\b|Parent Directory|\[To Parent Directory\]|<pre[^>]*>\s*<a\s+href=/i;

async function fetchDirectoryWithProtocol(origin, href, timeoutMs) {
  const normHref = encodeHrefPath(href.endsWith("/") ? href : `${href}/`);
  const targetUrl = origin + normHref;

  try {
    const res = await fetch(targetUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ action: "get", items: { href: normHref, what: 1 } }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.ok && (res.headers.get("content-type") || "").includes("json")) {
      const data = await res.json();
      if (Array.isArray(data.items)) {
        return {
          protocol: "h5ai",
          origin,
          href: normHref,
          redirectedExternal: false,
          isDirectoryListing: true,
          entries: extractDirectChildren(origin, normHref, data.items),
        };
      }
    }
  } catch {}

  const htmlRes = await fetch(targetUrl, { method: "GET", signal: AbortSignal.timeout(timeoutMs) });
  if (!htmlRes.ok) throw new Error(`HTTP ${htmlRes.status} from ${targetUrl}`);
  const html = await htmlRes.text();

  let effectiveOrigin = origin;
  let effectiveHref = normHref;
  let redirectedExternal = false;
  try {
    if (htmlRes.url) {
      const origU = new URL(origin);
      const fu = new URL(htmlRes.url);
      if (fu.origin === origin || fu.hostname.toLowerCase() === origU.hostname.toLowerCase()) {
        // Same host (including http -> https upgrade or / -> /movies/ redirect) — adopt it!
        effectiveOrigin = fu.origin;
        effectiveHref = normalizeServerRootHref(fu.pathname);
      } else {
        effectiveOrigin = fu.origin;
        effectiveHref = normalizeServerRootHref(fu.pathname);
        redirectedExternal = true;
      }
    }
  } catch {}

  const entries = parseHtmlFallback(effectiveOrigin, effectiveHref, html);
  const hasVideos = entries.some((e) => !e.isDir && e.kind === "video");
  const isDirectoryListing = !redirectedExternal && (REAL_DIR_HTML_RE.test(html) || hasVideos);
  const protocol = html.includes("_h5ai") || html.includes('class="fb-n"') ? "h5ai" : "autoindex";
  return {
    protocol,
    origin: effectiveOrigin,
    href: effectiveHref,
    redirectedExternal,
    isDirectoryListing,
    html,
    entries,
  };
}

async function detectIccPortal(origin, rawUrl, timeoutMs) {
  const u = new URL(rawUrl);
  const host = u.hostname.toLowerCase();
  const urlHintsIcc =
    /^10\.16\.100\.\d{1,3}$/.test(host) ||
    host.endsWith("ncisbd.com") ||
    /\/(dashboard|command|player)\.php/i.test(u.pathname);

  try {
    const r = await fetch(`${origin}/command.php`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "cSearch=a",
      signal: AbortSignal.timeout(Math.min(timeoutMs, 3500)),
    });
    if (r.ok) {
      const txt = await r.text();
      if (
        txt.includes("player.php") ||
        txt.includes("news-content") ||
        (urlHintsIcc && r.status === 200)
      ) {
        return true;
      }
    }
  } catch {}
  return false;
}

async function detectCircleFtpApi(origin, rawUrl, timeoutMs) {
  const u = new URL(rawUrl);
  const host = u.hostname.toLowerCase();
  const urlHintsCircle = host.includes("circleftp") || /^15\.1\.1\.\d{1,3}$/.test(host);
  if (!urlHintsCircle && u.pathname !== "/" && u.pathname !== "") return null;

  const candidates = [];
  if (u.port === "5000") {
    candidates.push({ apiUrl: `${origin}/api/posts?page=1&limit=1`, resolvedOrigin: origin });
  } else {
    candidates.push({ apiUrl: `http://${u.hostname}:5000/api/posts?page=1&limit=1`, resolvedOrigin: `http://${u.hostname}` });
    if (host === "circleftp.net" || host === "www.circleftp.net") {
      candidates.push({ apiUrl: "http://new.circleftp.net:5000/api/posts?page=1&limit=1", resolvedOrigin: "http://new.circleftp.net" });
    }
  }

  for (const c of candidates) {
    try {
      const r = await fetch(c.apiUrl, { signal: AbortSignal.timeout(Math.min(timeoutMs, 3000)) });
      if (r.ok) {
        const data = await r.json().catch(() => null);
        if (data && (Array.isArray(data.posts) || Array.isArray(data))) {
          return c.resolvedOrigin;
        }
      }
    } catch {}
  }
  return null;
}

/**
 * Deep automatic probe for any user-supplied HTTP/HTTPS FTP directory or BDIX portal URL.
 * Auto-detects ICC FTP, CircleFTP, h5ai, Apache/Nginx/Caddy/IIS autoindex, and HTML FTP portals,
 * and recursively discovers ALL compatible movie & series folders automatically.
 */
export async function probeDirectoryServer(rawUrl, timeoutMs = 8000) {
  const u = new URL(normalizeServerInputUrl(rawUrl));
  const origin = u.origin;
  const rootHref = normalizeServerRootHref(u.pathname);
  const t0 = Date.now();

  // 1. Live-probe specialized BDIX portals (ICC FTP & CircleFTP) first so pasting
  //    http://10.16.100.244/dashboard.php or http://circleftp.net auto-detects cleanly!
  const [isIcc, circleOrigin] = await Promise.all([
    detectIccPortal(origin, u.toString(), timeoutMs),
    detectCircleFtpApi(origin, u.toString(), timeoutMs),
  ]);

  if (isIcc) {
    const folders = ICC_CATEGORIES.map((c) => ({
      name: c.label,
      folderName: c.label,
      href: `/command.php?c=${c.iccId}`,
      url: `${origin}/command.php?c=${c.iccId}`,
      category: c.category,
      mediaType: c.mediaType,
      mode: "icc",
      childCount: 0,
      selected: true,
    }));
    return {
      ok: true,
      origin,
      rootHref: "/command.php",
      suggestedName: "ICC FTP Server",
      protocol: "icc",
      detectedAdapter: "icc",
      latencyMs: Date.now() - t0,
      folders,
      compatibleCount: folders.length,
      directVideoCount: 0,
    };
  }

  if (circleOrigin) {
    const circleSections = [
      { name: "Movies (4K / 1080p / Dual Audio)", category: "english-1080p", mediaType: "movie" },
      { name: "Hindi & Bollywood Movies", category: "hindi", mediaType: "movie" },
      { name: "South Indian & Hindi Dubbed", category: "south-dubbed", mediaType: "movie" },
      { name: "TV & Web Series", category: "tv-series", mediaType: "series" },
      { name: "Anime & Animated Series", category: "anime", mediaType: "series" },
      { name: "Documentaries & Foreign", category: "foreign", mediaType: "movie" },
    ].map((s, idx) => ({
      name: s.name,
      folderName: s.name,
      href: `/api/posts?section=${idx + 1}`,
      url: `${circleOrigin}/`,
      category: s.category,
      mediaType: s.mediaType,
      mode: "circleftp",
      childCount: 0,
      selected: true,
    }));
    return {
      ok: true,
      origin: circleOrigin,
      rootHref: "/",
      suggestedName: "CircleFTP",
      protocol: "circleftp",
      detectedAdapter: "circleftp",
      latencyMs: Date.now() - t0,
      folders: circleSections,
      compatibleCount: circleSections.length,
      directVideoCount: 0,
    };
  }

  // 2. Universal directory / h5ai / HTML FTP portal probe
  const rootProbe = await fetchDirectoryWithProtocol(origin, rootHref, timeoutMs);
  let protocol = rootProbe.protocol;
  let effectiveOrigin = rootProbe.redirectedExternal ? origin : rootProbe.origin;
  let effectiveRootHref = rootProbe.redirectedExternal ? rootHref : rootProbe.href;
  let fromPortalHomepage = false;

  let rootDirs = rootProbe.isDirectoryListing ? rootProbe.entries.filter((e) => e.isDir) : [];
  const rootVideos = rootProbe.isDirectoryListing ? rootProbe.entries.filter((e) => !e.isDir && e.kind === "video") : [];

  // Portal homepage fallback (e.g. DhakaFlix http://172.16.50.14/ W3layouts portal linking to /DHAKA-FLIX-14/...):
  // Extract candidate directory links from the portal HTML and verify each target is a REAL directory index!
  if (rootDirs.length === 0 && rootVideos.length === 0 && rootProbe.html && !rootProbe.redirectedExternal) {
    const portalRes = extractPortalDirectoryLinks(effectiveOrigin, rootProbe.html);
    if (portalRes.entries.length > 0) {
      effectiveOrigin = portalRes.origin;
      // Prioritize genuine media/FTP links (trailing-slash multi-segment paths & known category keywords)
      const portalScore = (e) => {
        let sc = 0;
        if (e.href.split("/").filter(Boolean).length >= 2) sc += 30;
        if (/dhaka-?flix|ftp|movie|film|series|hindi|english|bangla|south|anime|4k|1080p|media|data|video|cartoon/i.test(e.href)) sc += 25;
        if (classifyDiscoveredFolder(e.name).skipDefault) sc -= 50;
        return sc;
      };
      rootDirs = [...portalRes.entries].sort((a, b) => portalScore(b) - portalScore(a)).slice(0, 24);
      protocol = "portal";
      fromPortalHomepage = true;
    }
  }

  const discovered = [];
  const seenHrefs = new Set();

  const addDiscovered = (entry, displayPath, cls, detectedMode, childCount = 0) => {
    if (seenHrefs.has(entry.href)) return;
    seenHrefs.add(entry.href);
    discovered.push({
      name: displayPath,
      folderName: entry.name,
      href: entry.href,
      url: entry.url,
      category: cls.category,
      mediaType: cls.mediaType,
      mode: detectedMode || cls.mode,
      childCount,
      selected: !cls.skipDefault,
    });
  };

  // Recursively inspect folders up to depth 2 (3 levels total) to unwrap container directories
  // like `/Movies/`, `/DHAKA-FLIX-14/`, `/SOUTH INDIAN MOVIES/`, `/Media/`, etc.
  const inspectLevel = async (dirs, parentLabel, parentCls, depth) => {
    const inspectable = [];
    for (const d of dirs) {
      const cls = classifyDiscoveredFolder(d.name);
      const mergedCls =
        cls.category === "foreign" && parentCls && parentCls.category !== "foreign"
          ? { ...cls, category: parentCls.category, mediaType: parentCls.mediaType }
          : cls;
      const displayPath = parentLabel ? `${parentLabel} / ${d.name}` : d.name;

      // Immediately record skipped folders (Games, Software, etc.) as unchecked without descending
      if (mergedCls.skipDefault) {
        addDiscovered(d, displayPath, mergedCls, mergedCls.mode, 0);
        continue;
      }
      // Don't descend into year/alpha buckets or individual movie title folders
      if (isBucketLikeName(d.name) || isTitleLikeName(d.name)) {
        addDiscovered(d, displayPath, mergedCls, "flat", 0);
        continue;
      }
      if (depth >= 2) {
        addDiscovered(d, displayPath, mergedCls, mergedCls.mode, 0);
        continue;
      }
      inspectable.push({ d, displayPath, mergedCls });
    }

    if (inspectable.length === 0) return;

    await mapWithConcurrency(inspectable.slice(0, 24), 4, async ({ d, displayPath, mergedCls }) => {
      try {
        const sub = await fetchDirectoryWithProtocol(effectiveOrigin, d.href, Math.min(timeoutMs, 5500));
        // When inspecting links extracted from an HTML portal homepage, ONLY accept targets that are REAL
        // directory listings (h5ai / Apache / Nginx / Caddy / IIS / direct video files) — rejects WordPress/CMS pages!
        if (fromPortalHomepage && !sub.isDirectoryListing) {
          return;
        }
        const subDirs = sub.entries.filter((e) => e.isDir);
        const subVideos = sub.entries.filter((e) => !e.isDir && e.kind === "video");

        // Case 1: Folder directly contains video files -> flat category folder
        if (subVideos.length > 0 && subDirs.length <= 2) {
          addDiscovered(d, displayPath, mergedCls, "flat", subVideos.length);
          return;
        }
        if (subDirs.length === 0) {
          return; // Empty directory — skip noise
        }

        const bucketCount = subDirs.filter((sd) => isBucketLikeName(sd.name)).length;
        const titleCount = subDirs.filter((sd) => isTitleLikeName(sd.name)).length;
        const ratioBuckets = bucketCount / subDirs.length;
        const ratioTitles = titleCount / subDirs.length;

        // Case 2: Contains year/alpha buckets (e.g. 2026, 2025, A-Z) -> bucketed media category!
        if (ratioBuckets >= 0.45) {
          addDiscovered(d, displayPath, mergedCls, "bucketed", subDirs.length);
          return;
        }

        // Case 3: Contains movie/series release folders (e.g. "Dune (2024) 1080p") -> flat media category!
        if (ratioTitles >= 0.35 || subDirs.length >= 25) {
          addDiscovered(d, displayPath, mergedCls, "flat", subDirs.length);
          return;
        }

        // Case 4: Wrapper / grouping folder (e.g. "Movies", "DHAKA-FLIX-14", "SOUTH INDIAN MOVIES")
        // whose children are themselves sub-categories -> unwrap automatically!
        const hasKnownCategoryChildren = subDirs.some((sd) => {
          const c = classifyDiscoveredFolder(sd.name);
          return c.category !== "foreign" || c.skipDefault;
        });
        const shouldUnwrap =
          isContainerWrapperName(d.name) ||
          (subDirs.length <= 2 && depth === 0) ||
          (hasKnownCategoryChildren && subDirs.length <= 22);

        if (shouldUnwrap) {
          await inspectLevel(subDirs, displayPath, mergedCls, depth + 1);
          return;
        }

        // Default: treat as a valid media folder
        addDiscovered(d, displayPath, mergedCls, ratioBuckets > 0 ? "bucketed" : "flat", subDirs.length);
      } catch {
        if (!fromPortalHomepage) {
          addDiscovered(d, displayPath, mergedCls, mergedCls.mode, 0);
        }
      }
    });
  };

  if (rootDirs.length > 0) {
    const rootBuckets = rootDirs.filter((d) => isBucketLikeName(d.name)).length;
    const rootTitles = rootDirs.filter((d) => isTitleLikeName(d.name)).length;
    if (
      !fromPortalHomepage &&
      (rootBuckets / rootDirs.length >= 0.5 || rootTitles / rootDirs.length >= 0.45 || rootDirs.length >= 30)
    ) {
      const rootName = safeDecode(effectiveRootHref.replace(/^\/|\/$/g, "").split("/").pop() || u.hostname);
      const cls = classifyDiscoveredFolder(rootName);
      addDiscovered(
        { name: rootName, href: effectiveRootHref, url: effectiveOrigin + effectiveRootHref },
        rootName,
        cls,
        rootBuckets / rootDirs.length >= 0.5 ? "bucketed" : "flat",
        rootDirs.length
      );
    } else {
      await inspectLevel(rootDirs, "", null, 0);
    }
  }

  // Sort compatible (selected) folders first, then alphabetically
  discovered.sort((a, b) => {
    if (a.selected !== b.selected) return a.selected ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
  });

  // Derive a clean suggested server name (e.g. "DhakaFlix 14" or hostname)
  let suggestedName = u.hostname;
  const dfMatch = u.hostname.match(/^172\.16\.50\.(\d+)$/);
  if (dfMatch) suggestedName = `DhakaFlix ${dfMatch[1]}`;
  else if (u.hostname.toLowerCase().includes("discoveryftp.net")) {
    const cm = u.hostname.match(/cdn(\d+)/i);
    suggestedName = cm ? `DiscoveryFTP CDN-${cm[1]}` : "DiscoveryFTP";
  }

  return {
    ok: true,
    origin: effectiveOrigin,
    rootHref: effectiveRootHref,
    suggestedName,
    protocol,
    detectedAdapter: "directory",
    latencyMs: Date.now() - t0,
    folders: discovered,
    compatibleCount: discovered.filter((f) => f.selected).length,
    directVideoCount: rootVideos.length,
  };
}

function decodeHtmlEntities(s) {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#039;|&#39;/g, "'");
}

function parseHumanSize(s) {
  const m = (s || "").match(/([\d.]+)\s*(B|KB|MB|GB|TB)/i);
  if (!m) return 0;
  const val = parseFloat(m[1]);
  const mult = { B: 1, KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3, TB: 1024 ** 4 }[m[2].toUpperCase()] || 1;
  return Math.round(val * mult);
}

/**
 * Live upstream h5ai recursive search across a DhakaFlix server root.
 */
export async function searchUpstream(origin, rootHref, pattern, timeoutMs = 8000) {
  const res = await fetch(origin + rootHref, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Accept": "application/json" },
    body: JSON.stringify({
      action: "get",
      search: { href: rootHref, pattern, ignorecase: true },
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) return [];
  const data = await res.json();
  return (data.search || []).map((item) => {
    const isDir = item.href.endsWith("/");
    const parts = item.href.replace(/\/+$/, "").split("/");
    const name = safeDecode(parts[parts.length - 1] || "");
    const safeHref = encodeHrefPath(item.href);
    return {
      name,
      href: safeHref,
      url: origin + safeHref,
      origin,
      isDir,
      size: typeof item.size === "number" ? item.size : 0,
      time: typeof item.time === "number" ? item.time : 0,
      kind: isDir ? "dir" : classifyFileKind(name),
    };
  });
}

/**
 * Ping an h5ai server to check availability & latency.
 * Uses `pingHref` (lightweight static root when available) and generous timeout so busy nodes
 * like DhakaFlix 7 never get false-flagged as offline.
 */
export async function checkServerHealth(server) {
  const pingUrl = server.origin + (server.pingHref || server.rootHref);
  const timeoutMs = server.pingTimeoutMs || 5500;
  const t0 = Date.now();
  try {
    const res = await fetch(pingUrl, {
      method: "GET",
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
    });
    // Consume/cancel body immediately so sockets are reused cleanly
    try {
      await res.body?.cancel();
    } catch {}
    let ok = res.ok || res.status === 405;
    let reason = ok ? null : `HTTP ${res.status}`;
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("location") || "";
      if (/notice\.html|blocked|unauthorized|suspended|captive|login\.php/i.test(loc)) {
        ok = false;
        reason = "Blocked or redirected by ISP/carrier";
      } else if (loc) {
        try {
          const targetHost = new URL(loc, pingUrl).hostname.toLowerCase();
          const baseHost = new URL(pingUrl).hostname.toLowerCase();
          ok = targetHost === baseHost || sameLanOrParentDomain(new URL(loc, pingUrl).origin, server.origin);
          if (!ok) reason = "Redirected off-server";
        } catch {
          ok = true;
        }
      } else {
        ok = true;
      }
    }
    return {
      ...server,
      online: ok,
      latencyMs: ok ? Date.now() - t0 : null,
      reason,
    };
  } catch (err) {
    const code = err?.cause?.code || err?.name || "";
    const reason =
      code === "ECONNREFUSED"
        ? "Upstream server refused connection"
        : code === "TimeoutError" || code === "AbortError"
          ? "Upstream server timed out"
          : err?.message || "Unreachable";
    return {
      ...server,
      online: false,
      latencyMs: null,
      reason,
    };
  }
}

/**
 * Simple concurrency-bounded async worker pool.
 */
export async function mapWithConcurrency(items, concurrency, fn) {
  const results = new Array(items.length);
  let nextIdx = 0;

  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      const idx = nextIdx++;
      if (idx >= items.length) break;
      results[idx] = await fn(items[idx], idx);
    }
  });

  await Promise.all(workers);
  return results;
}
