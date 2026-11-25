const DEVICE_ID_KEY = "cinevault_device_id";

export function getDeviceId() {
  try {
    let id = localStorage.getItem(DEVICE_ID_KEY);
    if (!id || !/^[a-zA-Z0-9_-]{8,64}$/.test(id)) {
      id =
        typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
          ? crypto.randomUUID()
          : `dev_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 12)}`;
      localStorage.setItem(DEVICE_ID_KEY, id);
    }
    return id;
  } catch {
    return "default";
  }
}

function deviceHeaders(extra = {}) {
  return { "X-CineVault-Device-Id": getDeviceId(), ...extra };
}

export async function apiGet(path, opts = {}) {
  const res = await fetch(path, { headers: deviceHeaders(), signal: opts.signal });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
    throw new Error(err.error || `HTTP ${res.status}`);
  }
  return res.json();
}

export async function apiPost(path, body = {}) {
  const res = await fetch(path, {
    method: "POST",
    headers: deviceHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
    throw new Error(err.error || `HTTP ${res.status}`);
  }
  return res.json();
}

export async function apiDelete(path) {
  const res = await fetch(path, { method: "DELETE", headers: deviceHeaders() });
  return res.json().catch(() => ({}));
}

export function formatBytes(bytes) {
  if (!bytes || bytes <= 0) return "";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  let val = bytes;
  while (val >= 1024 && i < units.length - 1) {
    val /= 1024;
    i++;
  }
  return `${val.toFixed(i >= 2 ? 2 : 0)} ${units[i]}`;
}

export function formatDuration(seconds) {
  const s = Math.max(0, Math.floor(seconds || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) {
    return `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
  }
  return `${m}:${String(sec).padStart(2, "0")}`;
}

export function formatRelativeDate(ms) {
  if (!ms) return "";
  const diff = Date.now() - Number(ms);
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "Just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(Number(ms)).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

export function buildStreamUrl({ url, mode, audio = 0, start = 0, quality = "original" }) {
  if (mode === "direct") {
    return `/api/stream/direct?url=${encodeURIComponent(url)}`;
  }
  const p = new URLSearchParams({
    url,
    mode,
    audio: String(audio),
    start: String(Math.floor(start || 0)),
    quality,
  });
  return `/api/stream/play?${p.toString()}`;
}

export function buildDownloadUrl(url) {
  return `/api/stream/download?url=${encodeURIComponent(url)}`;
}

export function buildM3uUrl({ id, url, title }) {
  const p = new URLSearchParams();
  if (id) p.set("id", String(id));
  if (url) p.set("url", url);
  if (title) p.set("title", title);
  return `/api/playlist.m3u?${p.toString()}`;
}

export const CATEGORY_LABELS = {
  "4k-movies": "4K UHD",
  "imdb-top-250": "IMDb Top 250",
  "english-1080p": "English 1080p",
  english: "English",
  hindi: "Hindi",
  "south-indian": "South Indian",
  "south-dubbed": "South Hindi Dubbed",
  bangla: "Bangla",
  "animation-1080p": "Animation 1080p",
  animation: "Animation",
  foreign: "Foreign",
  "3d-movies": "3D",
  "tv-series": "TV Series",
  "korean-series": "K-Drama",
  anime: "Anime",
  documentary: "Documentary",
  "awards-shows": "TV Shows",
  wrestling: "Wrestling",
};
