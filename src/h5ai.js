import { safeDecode, classifyFileKind } from "./parser.js";

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
    const absHref = href.startsWith("/") ? href : parentHref + href;
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
  return results;
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
    const ok = res.ok || (res.status >= 300 && res.status < 400) || res.status === 405;
    return {
      ...server,
      online: ok,
      latencyMs: ok ? Date.now() - t0 : null,
      reason: ok ? null : `HTTP ${res.status}`,
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
