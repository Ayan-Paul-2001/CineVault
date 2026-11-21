import path from "node:path";
import { VIDEO_EXTENSIONS, SUBTITLE_EXTENSIONS, IMAGE_EXTENSIONS } from "./config.js";

const SOURCE_RE = /\b(REMUX|BluRay|BDRip|BRRip|AMZN|NF|DSNP|ATVP|HMAX|MAX|PMTP|HULU|WEB-DL|WEBRip|WEB|HDRip|DVDRip|HDTV|HDTC|HDCAM|CAMRip|CAM|TS|IMAX|UNRATED|EXTENDED)\b/i;
const QUALITY_RE = /\b(2160p|4K|UHD|1080p|720p|480p|360p)\b/i;
const LANG_PAREN_RE = /\((Tamil|Telugu|Malayalam|Kannada|Hindi|Bangla|Bengali|Korean|Japanese|Chinese|French|German|Spanish|Italian|Iranian|Turkish|Russian|Arabic|Thai|Indonesian|Swedish|Danish|Dutch|Norwegian|Polish|Brazilian|Portuguese|English|Punjabi|Pakistani)\)/i;
const LOW_RIP_RE = /\b(HDTC|HDCAM|CAMRip|CAM|HDTS|TELESYNC|TC|SCR|DVDSCR)\b/i;

export function safeDecode(str) {
  try {
    return decodeURIComponent(str);
  } catch {
    return str;
  }
}

export function classifyFileKind(fileName) {
  const ext = path.extname(fileName || "").toLowerCase();
  if (VIDEO_EXTENSIONS.has(ext)) return "video";
  if (SUBTITLE_EXTENSIONS.has(ext)) return "subtitle";
  if (IMAGE_EXTENSIONS.has(ext)) return "image";
  return "other";
}

/**
 * Normalize a movie/series title for accurate cross-server deduplication.
 * e.g. "Orphan: First Kill (4K)" and "Orphan-First Kill (2022) 1080p [Dual Audio]" -> "orphan first kill"
 */
export function normalizeTitleForMatch(title) {
  return (title || "")
    .toLowerCase()
    .replace(/\((?:4k|2160p|uhd|1080p|720p|480p|3d|dual audio|multi audio|hindi\s*\+\s*english|hindi dubbed|english|hindi|uncut|extended|remastered|completed|director'?s cut|unrated|imax)\)/gi, " ")
    .replace(/\[[^\]]+\]/g, " ")
    .replace(/\b(2160p|4k|uhd|1080p|720p|480p|3d|bluray|web-dl|webrip|camrip|hdtc|hdcam|dual audio|multi audio|hindi dubbed)\b/gi, " ")
    .replace(/&/g, " and ")
    .replace(/['’`]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * Compute deterministic quality score so deduplication ALWAYS keeps the highest quality version!
 * Higher score wins.
 */
export function computeQualityScore({
  quality = null,
  sourceTag = null,
  audioTags = null,
  imdbRank = null,
  year = null,
  source = "dhakaflix",
  mediaType = "movie",
  seasonHint = null,
  rawName = "",
} = {}) {
  let score = 0;

  // 1. Primary tier: Video resolution
  const q = (quality || "").toUpperCase();
  if (q === "4K" || q === "2160P" || q === "UHD") score += 4000;
  else if (q === "3D") score += 3050;
  else if (q === "1080P") score += 3000;
  else if (q === "720P") score += 2000;
  else if (q === "480P") score += 1000;
  else score += 1600; // Unlabeled quality sits below explicit 720p/1080p/4K so labeled HD always wins

  // 2. Source rip quality (BluRay/WEB-DL beats CAMRip/HDTC!)
  const s = (sourceTag || "").toUpperCase();
  if (LOW_RIP_RE.test(s) || LOW_RIP_RE.test(rawName || "")) {
    score -= 1500; // Blurry CAM/HDTC never overrides a clean WEB-DL/BluRay
  } else if (/REMUX|BLURAY|BDRIP|IMAX/i.test(s)) {
    score += 300;
  } else if (/WEB-DL|AMZN|NF|DSNP|ATVP|HMAX|MAX|PMTP|HULU/i.test(s)) {
    score += 220;
  } else if (/WEBRIP|HDRIP|WEB/i.test(s)) {
    score += 150;
  } else if (/DVDRIP|HDTV/i.test(s)) {
    score += 80;
  }

  // 3. Audio richness & edition bonuses (tie-breakers at same resolution)
  if (audioTags) {
    if (/Multi/i.test(audioTags)) score += 75;
    else if (/Dual/i.test(audioTags)) score += 65;
    else if (/Dubbed/i.test(audioTags)) score += 30;
  }
  if (imdbRank) score += 40;
  if (year) score += 15;

  // 4. For TV Series: full multi-season series folder/entry beats a single-season ICC entry at same resolution
  if (mediaType === "series") {
    if ((source === "dhakaflix" || source === "circleftp" || source === "discoveryftp") && !seasonHint) score += 120;
  }

  return score;
}

/**
 * Parse a CircleFTP JSON post into normalized CineVault metadata + quality score.
 */
export function parseCirclePost(post, classified) {
  const rawTitle = (post.title || post.name || "").trim();
  const qualityHintStr = `${post.quality || ""} ${rawTitle}`;

  let quality = null;
  if (/\b(2160p|4K|UHD)\b/i.test(qualityHintStr)) quality = "4K";
  else if (/\[3D\]|\b3D\b/i.test(qualityHintStr)) quality = "3D";
  else if (/\b1080p\b|Full[\s-]?HD/i.test(qualityHintStr)) quality = "1080p";
  else if (/\b720p\b/i.test(qualityHintStr)) quality = "720p";
  else if (/\b480p\b/i.test(qualityHintStr)) quality = "480p";

  const audioParts = [];
  if (/\bDual\s*Audio\b|Hin\s*\+\s*Eng|Eng\s*\+\s*Hin|Hindi\s*\+\s*English/i.test(qualityHintStr) || classified.audioHint === "Dual Audio") {
    audioParts.push("Dual Audio");
  }
  if (/\bMulti\s*Audio\b/i.test(qualityHintStr)) audioParts.push("Multi Audio");
  if (/\bHindi\s*Dubbed\b|\bDub\b/i.test(qualityHintStr) || classified.audioHint === "Hindi Dubbed") {
    if (!audioParts.includes("Dual Audio") && !audioParts.includes("Hindi Dubbed")) {
      audioParts.push("Hindi Dubbed");
    }
  }
  const audioTags = audioParts.join(" · ") || null;

  const sm = qualityHintStr.match(SOURCE_RE);
  const sourceTag = sm ? sm[1].toUpperCase() : null;

  let languageTag = classified.langHint || null;
  if (!languageTag) {
    const lm = rawTitle.match(LANG_PAREN_RE);
    if (lm) languageTag = lm[1];
  }

  let year = null;
  if (post.year) {
    const ym = String(post.year).match(/((?:19|20)\d{2})/);
    if (ym) year = parseInt(ym[1], 10);
  }
  if (!year) {
    const ym2 = rawTitle.match(/\b((?:19|20)\d{2})\b/);
    if (ym2) year = parseInt(ym2[1], 10);
  }

  // Prefer CircleFTP's structured `post.name` when clean, else parse from `post.title`
  let title = (post.name || "").trim();
  if (!title || title.length < 2 || /\.(mkv|mp4|avi)$/i.test(title)) {
    title = rawTitle
      .replace(/\.(mkv|mp4|avi|webm)$/i, "")
      .replace(/\((?:(?:TV\s+)?(?:Mini\s+)?(?:Series|Cartoon|Documentary)\s+)?(?:19|20)\d{2}[^)]*\).*$/i, "")
      .replace(/\[[^\]]+\]/g, " ")
      .replace(QUALITY_RE, " ")
      .replace(SOURCE_RE, " ")
      .replace(/[._]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }
  // Clean common CircleFTP suffixes inside `name`
  title = title
    .replace(/\((?:TV\s+(?:Mini\s+)?Series|19\d{2}|20\d{2})[^)]*\)/gi, " ")
    .replace(/\[[^\]]+\]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!title) title = rawTitle;

  // Promote 4K/3D movies to their dedicated category while preserving base category
  let category = classified.category;
  if (classified.mediaType === "movie") {
    if (quality === "4K") category = "4k-movies";
    else if (quality === "3D") category = "3d-movies";
    else if (category === "english" && quality === "1080p") category = "english-1080p";
    else if (category === "animation" && quality === "1080p") category = "animation-1080p";
  }

  const qualityScore = computeQualityScore({
    quality,
    sourceTag,
    audioTags,
    year,
    source: "circleftp",
    mediaType: classified.mediaType,
    rawName: rawTitle,
  });

  const modifiedAt = post.updatedAt
    ? Date.parse(post.updatedAt) || 0
    : post.createdAt
      ? Date.parse(post.createdAt) || 0
      : 0;

  return {
    rawName: rawTitle,
    title,
    cleanTitle: normalizeTitleForMatch(title),
    year,
    quality,
    audioTags,
    sourceTag,
    languageTag,
    category,
    mediaType: classified.mediaType,
    qualityScore,
    modifiedAt,
  };
}

/**
 * Parse a DhakaFlix folder name into crisp structured movie/series metadata.
 */
export function parseFolderName(rawName, categoryDef = null, subGroup = null, source = "dhakaflix") {
  let name = (rawName || "").replace(/\/+$/, "").trim();
  let imdbRank = null;

  if (categoryDef?.id === "imdb-top-250") {
    const rankMatch = name.match(/^(\d{1,3})\.?\s+(.+)$/);
    if (rankMatch) {
      imdbRank = parseInt(rankMatch[1], 10);
      name = rankMatch[2].trim();
    }
  }

  let quality = null;
  if (/\[3D\]|\b3D\b/i.test(name) || categoryDef?.id === "3d-movies") {
    quality = "3D";
  } else {
    const qm = name.match(QUALITY_RE);
    if (qm) {
      const q = qm[1].toUpperCase();
      quality = q === "2160P" || q === "UHD" || q === "4K" ? "4K" : qm[1].toLowerCase();
    } else if (categoryDef?.id?.includes("1080p") || /1080p/i.test(subGroup || "")) {
      quality = "1080p";
    }
  }

  const audioParts = [];
  if (/\[Dual\s*Audio\]|\bDual\s*Audio\b/i.test(name) || categoryDef?.audioHint === "Dual Audio") audioParts.push("Dual Audio");
  if (/\[Multi\s*Audio\]|\bMulti\s*Audio\b/i.test(name)) audioParts.push("Multi Audio");
  if (/Hindi\s*Dubbed/i.test(name) || categoryDef?.id === "south-dubbed" || categoryDef?.audioHint === "Hindi Dubbed") {
    if (!audioParts.includes("Hindi Dubbed")) audioParts.push("Hindi Dubbed");
  }
  if (/Bangla\s*Dubb/i.test(name) || /Bangla\s*Dubb/i.test(subGroup || "")) audioParts.push("Bangla Dubbed");
  const audioTags = audioParts.join(" · ") || null;

  const sm = name.match(SOURCE_RE);
  const sourceTag = sm ? sm[1].toUpperCase() : null;

  let languageTag = categoryDef?.langHint || null;
  const lm = name.match(LANG_PAREN_RE);
  if (lm) {
    languageTag = lm[1];
  } else if (!languageTag && categoryDef?.id === "foreign" && subGroup && !/^\d{4}$/.test(subGroup.trim())) {
    languageTag = subGroup.replace(/\s*(Language|Movies?|Film|Films)\s*/gi, "").trim() || null;
  } else if (!languageTag && categoryDef?.id === "hindi") {
    languageTag = "Hindi";
  } else if (!languageTag && categoryDef?.id === "bangla") {
    languageTag = "Bangla";
  } else if (!languageTag && categoryDef?.id === "korean-series") {
    languageTag = "Korean";
  }

  let year = null;
  let titleCutIndex = -1;

  const parenYearMatch = name.match(
    /\((?:(?:TV\s+)?(?:Mini\s+)?(?:Series|Cartoon|Documentary|Movie|Special|Short)\s+)?((?:19|20)\d{2})(?:\s*[–—-]\s*(?:(?:19|20)\d{2})?)?\s*\)/i
  );
  if (parenYearMatch) {
    year = parseInt(parenYearMatch[1], 10);
    titleCutIndex = parenYearMatch.index;
  } else if (subGroup) {
    const subYear = subGroup.match(/\b((?:19|20)\d{2})\b/);
    if (subYear && !/before|-/i.test(subGroup)) {
      year = parseInt(subYear[1], 10);
    }
  }

  let mediaType = categoryDef?.mediaType || "movie";
  if (/\(TV\s+(?:Mini\s+)?(?:Series|Cartoon)/i.test(name)) {
    mediaType = "series";
  }

  let title = titleCutIndex > 0 ? name.slice(0, titleCutIndex) : name;
  if (titleCutIndex <= 0) {
    title = title
      .replace(/\[[^\]]+\]/g, " ")
      .replace(QUALITY_RE, " ")
      .replace(SOURCE_RE, " ")
      .replace(LANG_PAREN_RE, " ");
  }

  title = title
    .replace(/^#/, "")
    .replace(/_/g, " ")
    .replace(/([a-z0-9])\-([A-Z])/g, "$1: $2")
    .replace(/\s+-\s*$/, "")
    .replace(/\s+/g, " ")
    .trim();

  if (!title) title = name;

  const qualityScore = computeQualityScore({
    quality,
    sourceTag,
    audioTags,
    imdbRank,
    year,
    source,
    mediaType,
    rawName: name,
  });

  return {
    rawName: rawName.replace(/\/+$/, "").trim(),
    title,
    cleanTitle: normalizeTitleForMatch(title),
    year,
    quality,
    audioTags,
    sourceTag,
    languageTag,
    imdbRank,
    mediaType,
    qualityScore,
  };
}

/**
 * Parse an ICC FTP card title (e.g. "Inception (4K)", "Nobody Wants This Season 03 (2026) Completed",
 * "The Beast (2026) (Hindi + English)", "Orphan First Kill (4K)").
 */
export function parseIccTitle(rawTitle, iccCat) {
  let name = (rawTitle || "").replace(/\s+/g, " ").trim();

  // Detect quality from title or ICC category hint
  let quality = iccCat?.qualityHint || null;
  if (/\(4K\)|\b2160p\b|\b4K\b|\bUHD\b/i.test(name)) {
    quality = "4K";
  } else if (/\(3D\)|\b3D\b/i.test(name)) {
    quality = "3D";
  } else if (/\b1080p\b|Full[\s-]?HD/i.test(name)) {
    quality = "1080p";
  } else if (/\b720p\b/i.test(name)) {
    quality = "720p";
  } else if (/\b480p\b/i.test(name)) {
    quality = "480p";
  }

  // Audio tags
  const audioParts = [];
  if (/Hindi\s*\+\s*English|Dual\s*Audio|English\s*\+\s*Hindi/i.test(name) || iccCat?.audioHint === "Dual Audio") {
    audioParts.push("Dual Audio");
  }
  if (/Multi\s*Audio/i.test(name)) audioParts.push("Multi Audio");
  if (/Hindi\s*Dubbed/i.test(name) || iccCat?.audioHint === "Hindi Dubbed") {
    if (!audioParts.includes("Hindi Dubbed")) audioParts.push("Hindi Dubbed");
  }
  const audioTags = audioParts.join(" · ") || null;

  // Source tag
  const sm = name.match(SOURCE_RE);
  const sourceTag = sm ? sm[1].toUpperCase() : iccCat?.sourceHint || null;

  // Language tag
  let languageTag = iccCat?.langHint || null;
  if (!languageTag) {
    const lm = name.match(LANG_PAREN_RE);
    if (lm) languageTag = lm[1];
  }

  // Extract Season hint for TV series (e.g. "Season 03", "S01")
  let seasonHint = null;
  let mediaType = iccCat?.mediaType || "movie";
  const seasonMatch = name.match(/\b(?:Season|S)\s*0?(\d{1,2})\b/i);
  if (seasonMatch) {
    seasonHint = `Season ${parseInt(seasonMatch[1], 10)}`;
    if (iccCat?.mediaType === "series" || /Episode|Completed|Ongoing|Season/i.test(name)) {
      mediaType = "series";
    }
  }

  // Extract year
  let year = null;
  const ym = name.match(/\(((?:19|20)\d{2})\)/);
  if (ym) {
    year = parseInt(ym[1], 10);
  }

  // Clean display title: strip season suffixes (for series unification), year, quality, audio & status tags
  let title = name;
  if (mediaType === "series" && seasonMatch) {
    title = title.slice(0, seasonMatch.index);
  }
  title = title
    .replace(/\(((?:19|20)\d{2})\)/g, " ")
    .replace(/\((?:4K|2160p|UHD|1080p|720p|480p|3D|Hindi\s*\+\s*English|English\s*\+\s*Hindi|Dual\s*Audio|Multi\s*Audio|Hindi\s*Dubbed|Bangla\s*Dubbed|Uncut|Extended|Completed|Ongoing|Episode[^)]*)\)/gi, " ")
    .replace(/\[[^\]]+\]/g, " ")
    .replace(/\b(Completed|Ongoing|Episode\s*\d+(?:\s*[-–]\s*\d+)?)\b/gi, " ")
    .replace(QUALITY_RE, " ")
    .replace(SOURCE_RE, " ")
    .replace(/\s*[-–:]\s*$/, "")
    .replace(/\s+/g, " ")
    .trim();

  if (!title) title = name;

  const qualityScore = computeQualityScore({
    quality,
    sourceTag,
    audioTags,
    year,
    source: "icc",
    mediaType,
    seasonHint,
    rawName: name,
  });

  return {
    rawName: name,
    title,
    cleanTitle: normalizeTitleForMatch(title),
    year,
    quality,
    audioTags,
    sourceTag,
    languageTag,
    mediaType,
    seasonHint,
    qualityScore,
  };
}

/**
 * Parse episode metadata from a video file name (e.g. "Show S01E03 Title 1080p.mkv")
 */
export function parseEpisodeFile(fileName, index = 0) {
  const base = (fileName || "").replace(/\.[^.]+$/, "");
  let season = null;
  let episode = null;
  let epTitle = null;

  const seMatch = base.match(/S(\d{1,2})\s*[.\-_ ]?\s*E(\d{1,3})(?:-E?(\d{1,3}))?/i);
  if (seMatch) {
    season = parseInt(seMatch[1], 10);
    episode = parseInt(seMatch[2], 10);
    const after = base.slice(seMatch.index + seMatch[0].length).trim();
    epTitle = cleanEpisodeTitle(after);
  } else {
    const epOnly = base.match(/(?:Episode|Ep|E)\s*[.\-_ ]?(\d{1,3})\b/i) || base.match(/\b(\d{1,3})\b/);
    if (epOnly) {
      episode = parseInt(epOnly[1], 10);
    }
  }

  const label =
    season !== null && episode !== null
      ? `S${String(season).padStart(2, "0")}E${String(episode).padStart(2, "0")}`
      : episode !== null
        ? `EP ${String(episode).padStart(2, "0")}`
        : `Part ${index + 1}`;

  return {
    season,
    episode: episode ?? index + 1,
    label,
    episodeTitle: epTitle || base.replace(/[._]/g, " ").trim(),
  };
}

function cleanEpisodeTitle(str) {
  const cleaned = (str || "")
    .replace(/[\[\(].*?[\]\)]/g, " ")
    .replace(/\b(2160p|1080p|720p|480p|BluRay|BDRip|WEBRip|WEB-DL|WEB|HDTV|x264|x265|HEVC|10bit|AAC|DDP|AC3|ESub|NF|AMZN|DSNP|H264|H265|5\.1|2\.0|6CH|Dual\s*Audio).*$/i, "")
    .replace(/[._]/g, " ")
    .replace(/^[\s\-–—:]+|[\s\-–—:]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned.length >= 2 ? cleaned : null;
}

export function bucketPriorityScore(bucketName) {
  const yr = bucketName.match(/\b(20\d{2}|19\d{2})\b/);
  if (yr && !/before|1960|1995|1999|2000\s*&/i.test(bucketName)) {
    return parseInt(yr[1], 10) * 10;
  }
  if (/2026/.test(bucketName)) return 20260;
  if (/A\s*—\s*L|A\s*—\s*F/i.test(bucketName)) return 20200;
  if (/0\s*—\s*9/i.test(bucketName)) return 20190;
  return 10000;
}
