import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const PORT = Number(process.env.PORT || 3000);
export const HOST = process.env.HOST || "0.0.0.0";
export const ROOT_DIR = path.resolve(__dirname, "..");
export const DATA_DIR = path.join(ROOT_DIR, "data");
export const DB_PATH = path.join(DATA_DIR, "cinevault.db");
export const DIST_DIR = path.join(ROOT_DIR, "dist");
export const PUBLIC_DIR = path.join(ROOT_DIR, "public");

export const DHAKAFLIX_ORIGINS = new Set([
  "http://172.16.50.7",
  "http://172.16.50.10",
  "http://172.16.50.12",
  "http://172.16.50.14",
]);

export const ICC_ORIGIN = "http://10.16.100.244";
export const DEFAULT_ICC_SESSION = process.env.ICC_SESSION || "cinevault";

export const CIRCLEFTP_ORIGIN = "http://new.circleftp.net";
export const CIRCLEFTP_API = "http://new.circleftp.net:5000/api";

export const DISCOVERY_ORIGINS = new Set([
  "https://cdn1.discoveryftp.net",
  "https://cdn2.discoveryftp.net",
  "https://cdn4.discoveryftp.net",
  "https://cdn5.discoveryftp.net",
]);

export const SERVERS = [
  { id: "df-14", source: "dhakaflix", name: "DhakaFlix 14 (1080p / Hindi / South / K-Drama)", origin: "http://172.16.50.14", rootHref: "/DHAKA-FLIX-14/" },
  { id: "df-7",  source: "dhakaflix", name: "DhakaFlix 7 (English / Bangla / Foreign / 3D)",  origin: "http://172.16.50.7",  rootHref: "/DHAKA-FLIX-7/", pingHref: "/" },
  { id: "df-12", source: "dhakaflix", name: "DhakaFlix 12 (TV & Web Series)",                 origin: "http://172.16.50.12", rootHref: "/DHAKA-FLIX-12/" },
  { id: "df-10", source: "dhakaflix", name: "DhakaFlix 10 (Anime / Docs / Shows)",            origin: "http://172.16.50.10", rootHref: "/DHAKA-FLIX-10/" },
  { id: "icc-main", source: "icc",    name: "ICC FTP Server (4K / Full-HD / Movies / Serials)", origin: ICC_ORIGIN, rootHref: "/command.php" },
  { id: "circle-main", source: "circleftp", name: "CircleFTP (Movies / Dubbed / TV Series / Anime)", origin: CIRCLEFTP_ORIGIN, rootHref: "/" },
  { id: "disc-1", source: "discoveryftp", name: "DiscoveryFTP CDN-1 (Hindi / Tamil / Bangla / Animation)", origin: "https://cdn1.discoveryftp.net", rootHref: "/Movies/" },
  { id: "disc-2", source: "discoveryftp", name: "DiscoveryFTP CDN-2 (Web Series / Anime / Dubbed / Docs)", origin: "https://cdn2.discoveryftp.net", rootHref: "/" },
  { id: "disc-4", source: "discoveryftp", name: "DiscoveryFTP CDN-4 (English Movies)", origin: "https://cdn4.discoveryftp.net", rootHref: "/Movies/English/", optional: true, pingTimeoutMs: 2500 },
  { id: "disc-5", source: "discoveryftp", name: "DiscoveryFTP CDN-5 (Foreign TV Series)", origin: "https://cdn5.discoveryftp.net", rootHref: "/Foreign%20Tv%20Series/", optional: true, pingTimeoutMs: 2500 },
];

/**
 * Unified media categories across DhakaFlix + ICC FTP (Games & Software excluded).
 */
export const CATEGORIES = [
  {
    id: "4k-movies",
    label: "4K Ultra HD Movies",
    shortLabel: "4K UHD",
    group: "movies",
    mediaType: "movie",
    origin: ICC_ORIGIN,
    href: null,
    mode: "icc",
    priority: 0,
  },
  {
    id: "imdb-top-250",
    label: "IMDb Top 250",
    shortLabel: "Top 250",
    group: "movies",
    mediaType: "movie",
    origin: "http://172.16.50.14",
    href: "/DHAKA-FLIX-14/IMDb%20Top-250%20Movies/",
    mode: "flat",
    priority: 1,
  },
  {
    id: "english-1080p",
    label: "English Movies (1080p)",
    shortLabel: "English 1080p",
    group: "movies",
    mediaType: "movie",
    origin: "http://172.16.50.14",
    href: "/DHAKA-FLIX-14/English%20Movies%20%281080p%29/",
    mode: "bucketed",
    priority: 2,
  },
  {
    id: "hindi",
    label: "Hindi Movies",
    shortLabel: "Hindi",
    group: "movies",
    mediaType: "movie",
    origin: "http://172.16.50.14",
    href: "/DHAKA-FLIX-14/Hindi%20Movies/",
    mode: "bucketed",
    priority: 3,
  },
  {
    id: "tv-series",
    label: "TV & Web Series",
    shortLabel: "TV Series",
    group: "series",
    mediaType: "series",
    origin: "http://172.16.50.12",
    href: "/DHAKA-FLIX-12/TV-WEB-Series/",
    mode: "bucketed",
    priority: 4,
  },
  {
    id: "korean-series",
    label: "Korean TV & Web Series",
    shortLabel: "K-Drama",
    group: "series",
    mediaType: "series",
    origin: "http://172.16.50.14",
    href: "/DHAKA-FLIX-14/KOREAN%20TV%20%26%20WEB%20Series/",
    mode: "flat",
    priority: 5,
  },
  {
    id: "anime",
    label: "Anime & Cartoon Series",
    shortLabel: "Anime",
    group: "series",
    mediaType: "series",
    origin: "http://172.16.50.10",
    href: "/DHAKA-FLIX-10/Anime%20%26%20Cartoon%20TV%20Series/",
    mode: "bucketed",
    priority: 6,
  },
  {
    id: "south-indian",
    label: "South Indian Movies",
    shortLabel: "South Indian",
    group: "movies",
    mediaType: "movie",
    origin: "http://172.16.50.14",
    href: "/DHAKA-FLIX-14/SOUTH%20INDIAN%20MOVIES/South%20Movies/",
    mode: "bucketed",
    priority: 7,
  },
  {
    id: "south-dubbed",
    label: "South Movies (Hindi Dubbed)",
    shortLabel: "South Dubbed",
    group: "movies",
    mediaType: "movie",
    origin: "http://172.16.50.14",
    href: "/DHAKA-FLIX-14/SOUTH%20INDIAN%20MOVIES/Hindi%20Dubbed/",
    mode: "bucketed",
    priority: 8,
  },
  {
    id: "animation-1080p",
    label: "Animation Movies (1080p)",
    shortLabel: "Animation 1080p",
    group: "movies",
    mediaType: "movie",
    origin: "http://172.16.50.14",
    href: "/DHAKA-FLIX-14/Animation%20Movies%20%281080p%29/",
    mode: "flat",
    priority: 9,
  },
  {
    id: "english",
    label: "English Movies (720p / Classic)",
    shortLabel: "English",
    group: "movies",
    mediaType: "movie",
    origin: "http://172.16.50.7",
    href: "/DHAKA-FLIX-7/English%20Movies/",
    mode: "bucketed",
    priority: 10,
  },
  {
    id: "animation",
    label: "Animation Movies",
    shortLabel: "Animation",
    group: "movies",
    mediaType: "movie",
    origin: "http://172.16.50.14",
    href: "/DHAKA-FLIX-14/Animation%20Movies/",
    mode: "bucketed",
    priority: 11,
  },
  {
    id: "bangla",
    label: "Kolkata Bangla Movies",
    shortLabel: "Bangla",
    group: "movies",
    mediaType: "movie",
    origin: "http://172.16.50.7",
    href: "/DHAKA-FLIX-7/Kolkata%20Bangla%20Movies/",
    mode: "bucketed",
    priority: 12,
  },
  {
    id: "foreign",
    label: "Foreign Language Movies",
    shortLabel: "Foreign",
    group: "movies",
    mediaType: "movie",
    origin: "http://172.16.50.7",
    href: "/DHAKA-FLIX-7/Foreign%20Language%20Movies/",
    mode: "bucketed",
    priority: 13,
  },
  {
    id: "documentary",
    label: "Documentaries",
    shortLabel: "Documentary",
    group: "series",
    mediaType: "movie",
    origin: "http://172.16.50.10",
    href: "/DHAKA-FLIX-10/Documentary/",
    mode: "flat",
    priority: 14,
  },
  {
    id: "3d-movies",
    label: "3D Movies",
    shortLabel: "3D",
    group: "movies",
    mediaType: "movie",
    origin: "http://172.16.50.7",
    href: "/DHAKA-FLIX-7/3D%20Movies/",
    mode: "flat",
    priority: 15,
  },
  {
    id: "awards-shows",
    label: "Awards & TV Shows",
    shortLabel: "TV Shows",
    group: "series",
    mediaType: "series",
    origin: "http://172.16.50.10",
    href: "/DHAKA-FLIX-10/Awards%20%26%20TV%20Shows/",
    mode: "bucketed",
    priority: 16,
  },
  {
    id: "wrestling",
    label: "WWE & AEW Wrestling",
    shortLabel: "Wrestling",
    group: "series",
    mediaType: "series",
    origin: "http://172.16.50.10",
    href: "/DHAKA-FLIX-10/WWE%20%26%20AEW%20Wrestling/",
    mode: "bucketed",
    priority: 17,
  },
];

/**
 * ICC FTP (10.16.100.244) media category mappings.
 * Games, Software, E-Books, and Learning categories are intentionally excluded.
 */
export const ICC_CATEGORIES = [
  { iccId: 74, label: "ICC 4K Movies",            category: "4k-movies",     mediaType: "movie",  qualityHint: "4K",    priority: 1,  maxQuickPages: 4 },
  { iccId: 44, label: "ICC Exclusive Full-HD",    category: "english-1080p", mediaType: "movie",  qualityHint: "1080p", sourceHint: "BLURAY", priority: 2, maxQuickPages: 3 },
  { iccId: 43, label: "ICC Dual Audio Movies",    category: "english-1080p", mediaType: "movie",  audioHint: "Dual Audio", priority: 3, maxQuickPages: 4 },
  { iccId: 2,  label: "ICC Hindi Movies",         category: "hindi",         mediaType: "movie",  langHint: "Hindi",   priority: 4,  maxQuickPages: 4 },
  { iccId: 19, label: "ICC English Movies",       category: "english",       mediaType: "movie",  priority: 5,  maxQuickPages: 5 },
  { iccId: 73, label: "ICC South Indian Movies",  category: "south-indian",  mediaType: "movie",  priority: 6,  maxQuickPages: 3 },
  { iccId: 32, label: "ICC South Hindi Dubbed",   category: "south-dubbed",  mediaType: "movie",  audioHint: "Hindi Dubbed", priority: 7, maxQuickPages: 3 },
  { iccId: 33, label: "ICC Animated Movies",      category: "animation",     mediaType: "movie",  priority: 8,  maxQuickPages: 3 },
  { iccId: 83, label: "ICC Anime Movies",         category: "animation",     mediaType: "movie",  langHint: "Japanese", priority: 9, maxQuickPages: 2 },
  { iccId: 9,  label: "ICC 3D Movies",            category: "3d-movies",     mediaType: "movie",  qualityHint: "3D",    priority: 10, maxQuickPages: 2 },
  { iccId: 36, label: "ICC English TV Series",    category: "tv-series",     mediaType: "series", priority: 11, maxQuickPages: 4 },
  { iccId: 72, label: "ICC Dual Audio Series",    category: "tv-series",     mediaType: "series", audioHint: "Dual Audio", priority: 12, maxQuickPages: 3 },
  { iccId: 37, label: "ICC Hindi TV Series",      category: "tv-series",     mediaType: "series", langHint: "Hindi",   priority: 13, maxQuickPages: 3 },
  { iccId: 78, label: "ICC Anime Series",         category: "anime",         mediaType: "series", priority: 14, maxQuickPages: 3 },
  { iccId: 82, label: "ICC Animation Series",     category: "anime",         mediaType: "series", priority: 15, maxQuickPages: 2 },
  { iccId: 66, label: "ICC Cartoon Series",       category: "anime",         mediaType: "series", priority: 16, maxQuickPages: 2 },
  { iccId: 70, label: "ICC Other TV Series",      category: "tv-series",     mediaType: "series", priority: 17, maxQuickPages: 2 },
  { iccId: 41, label: "ICC Documentaries",        category: "documentary",   mediaType: "movie",  priority: 18, maxQuickPages: 2 },
  { iccId: 81, label: "ICC Documentary Series",   category: "documentary",   mediaType: "series", priority: 19, maxQuickPages: 2 },
  { iccId: 75, label: "ICC Korean Movies",        category: "foreign",       mediaType: "movie",  langHint: "Korean",  priority: 20, maxQuickPages: 2 },
  { iccId: 76, label: "ICC Chinese Movies",       category: "foreign",       mediaType: "movie",  langHint: "Chinese", priority: 21, maxQuickPages: 2 },
  { iccId: 80, label: "ICC Japanese Movies",      category: "foreign",       mediaType: "movie",  langHint: "Japanese", priority: 22, maxQuickPages: 2 },
  { iccId: 79, label: "ICC Indonesian Movies",    category: "foreign",       mediaType: "movie",  langHint: "Indonesian", priority: 23, maxQuickPages: 2 },
  { iccId: 71, label: "ICC Punjabi Movies",       category: "foreign",       mediaType: "movie",  langHint: "Punjabi", priority: 24, maxQuickPages: 2 },
  { iccId: 77, label: "ICC Pakistani Movies",     category: "foreign",       mediaType: "movie",  langHint: "Pakistani", priority: 25, maxQuickPages: 2 },
  { iccId: 64, label: "ICC Other Foreign Movies", category: "foreign",       mediaType: "movie",  priority: 26, maxQuickPages: 3 },
  { iccId: 38, label: "ICC Awards",               category: "awards-shows",  mediaType: "series", priority: 27, maxQuickPages: 2 },
  { iccId: 52, label: "ICC WWE Wrestling",        category: "wrestling",     mediaType: "series", priority: 28, maxQuickPages: 2 },
];

/**
 * DiscoveryFTP (discoveryftp.net) h5ai CDN categories.
 * CDN-3 (Games, Software, Tutorials, Music) and CDN-1 Comics/E-Books are intentionally excluded.
 */
export const DISCOVERY_CATEGORIES = [
  { id: "hindi",        shortLabel: "Discovery Hindi",         origin: "https://cdn1.discoveryftp.net", href: "/Movies/Hindi/",                  mode: "bucketed", mediaType: "movie",  langHint: "Hindi",  priority: 1 },
  { id: "south-indian", shortLabel: "Discovery Tamil/South",   origin: "https://cdn1.discoveryftp.net", href: "/Movies/Tamil/",                  mode: "bucketed", mediaType: "movie",  langHint: "Tamil",  priority: 2 },
  { id: "bangla",       shortLabel: "Discovery Bangla",        origin: "https://cdn1.discoveryftp.net", href: "/Movies/Bangla/",                 mode: "bucketed", mediaType: "movie",  langHint: "Bangla", priority: 3 },
  { id: "animation",    shortLabel: "Discovery Animation",     origin: "https://cdn1.discoveryftp.net", href: "/Movies/Animation/",              mode: "bucketed", mediaType: "movie",  priority: 4 },
  { id: "foreign",      shortLabel: "Discovery Other Movies",  origin: "https://cdn1.discoveryftp.net", href: "/Movies/Others/",                 mode: "bucketed", mediaType: "movie",  priority: 5 },
  { id: "english",      shortLabel: "Discovery English",       origin: "https://cdn4.discoveryftp.net", href: "/Movies/English/",                mode: "bucketed", mediaType: "movie",  langHint: "English", priority: 6 },
  { id: "tv-series",    shortLabel: "Discovery Hindi Series",  origin: "https://cdn2.discoveryftp.net", href: "/Hindi%20Web%20Series/",          mode: "flat",     mediaType: "series", langHint: "Hindi",  priority: 7 },
  { id: "tv-series",    shortLabel: "Discovery Dubbed Series", origin: "https://cdn2.discoveryftp.net", href: "/Dubbed%20Tv%20Series/",          mode: "flat",     mediaType: "series", audioHint: "Hindi Dubbed", priority: 8 },
  { id: "tv-series",    shortLabel: "Discovery Bangla Series", origin: "https://cdn2.discoveryftp.net", href: "/Bangla%20Web%20Series/",         mode: "flat",     mediaType: "series", langHint: "Bangla", priority: 9 },
  { id: "tv-series",    shortLabel: "Discovery South Series",  origin: "https://cdn2.discoveryftp.net", href: "/South%20Indian%20Tv%20Series/",  mode: "flat",     mediaType: "series", priority: 10 },
  { id: "anime",        shortLabel: "Discovery Anime Series",  origin: "https://cdn2.discoveryftp.net", href: "/Animation%20Tv%20Series/",       mode: "flat",     mediaType: "series", priority: 11 },
  { id: "documentary",  shortLabel: "Discovery Documentary",   origin: "https://cdn2.discoveryftp.net", href: "/Documentry/",                    mode: "flat",     mediaType: "series", priority: 12 },
  { id: "awards-shows", shortLabel: "Discovery Awards & TV",   origin: "https://cdn2.discoveryftp.net", href: "/Awards%20Tv%20Shows/",           mode: "flat",     mediaType: "series", priority: 13 },
  { id: "awards-shows", shortLabel: "Discovery TV Specials",   origin: "https://cdn2.discoveryftp.net", href: "/Tv%20Special%20%26%20Shows/",    mode: "flat",     mediaType: "series", priority: 14 },
  { id: "wrestling",    shortLabel: "Discovery Wrestling",     origin: "https://cdn2.discoveryftp.net", href: "/WWE%20And%20AEW%20Wrestling/",   mode: "flat",     mediaType: "series", priority: 15 },
  { id: "tv-series",    shortLabel: "Discovery Foreign TV",    origin: "https://cdn5.discoveryftp.net", href: "/Foreign%20Tv%20Series/",         mode: "flat",     mediaType: "series", priority: 16 },
];

export const CATEGORY_MAP = new Map(CATEGORIES.map((c) => [c.id, c]));

export const VIDEO_EXTENSIONS = new Set([
  ".mkv", ".mp4", ".webm", ".avi", ".mov", ".m4v", ".ts", ".flv", ".wmv", ".mpg", ".mpeg",
]);
export const SUBTITLE_EXTENSIONS = new Set([".srt", ".vtt", ".ass", ".ssa", ".sub"]);
export const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".webp", ".gif"]);

/**
 * SSRF protection: only allow DhakaFlix (172.16.50.x), ICC FTP + storage nodes (10.16.100.x),
 * CircleFTP (*.circleftp.net, 15.1.1.x), and DiscoveryFTP (*.discoveryftp.net, 172.16.16.x).
 */
export function isAllowedUrl(rawUrl) {
  try {
    const u = new URL(rawUrl);
    if (u.protocol !== "http:" && u.protocol !== "https:") return false;
    if (DHAKAFLIX_ORIGINS.has(u.origin)) return true;
    if (/^10\.16\.100\.\d{1,3}$/.test(u.hostname)) return true;
    if (u.hostname === "circleftp.net" || u.hostname.endsWith(".circleftp.net")) return true;
    if (/^15\.1\.1\.\d{1,3}$/.test(u.hostname)) return true;
    if (u.hostname === "discoveryftp.net" || u.hostname.endsWith(".discoveryftp.net")) return true;
    if (/^172\.16\.16\.\d{1,3}$/.test(u.hostname)) return true;
    return false;
  } catch {
    return false;
  }
}
