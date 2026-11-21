import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { Readable } from "node:stream";
import { isAllowedUrl, ICC_ORIGIN } from "./config.js";
import { safeDecode } from "./parser.js";

function isIccMediaUrl(url) {
  try {
    return /^10\.16\.100\.\d{1,3}$/.test(new URL(url).hostname);
  } catch {
    return false;
  }
}

const execFileAsync = promisify(execFile);

let ffmpegAvailable = false;
let ffprobeAvailable = false;

export async function detectMediaTools() {
  try {
    await execFileAsync("ffmpeg", ["-version"], { timeout: 4000 });
    ffmpegAvailable = true;
  } catch {
    ffmpegAvailable = false;
  }
  try {
    await execFileAsync("ffprobe", ["-version"], { timeout: 4000 });
    ffprobeAvailable = true;
  } catch {
    ffprobeAvailable = false;
  }
  return { ffmpeg: ffmpegAvailable, ffprobe: ffprobeAvailable };
}

export function getMediaToolsStatus() {
  return { ffmpeg: ffmpegAvailable, ffprobe: ffprobeAvailable };
}

const probeCache = new Map();
const subtitleCache = new Map();

function setLru(map, key, val, maxSize = 200) {
  if (map.size >= maxSize) {
    const oldest = map.keys().next().value;
    map.delete(oldest);
  }
  map.set(key, val);
}

const BROWSER_SAFE_AUDIO = new Set(["aac", "mp3", "opus", "vorbis", "flac"]);
const BROWSER_SAFE_VIDEO = new Set(["h264", "vp8", "vp9", "av1"]);
const TEXT_SUB_CODECS = new Set(["subrip", "srt", "ass", "ssa", "webvtt", "mov_text", "text", "tx3g"]);

const LANG_NAMES = {
  eng: "English",
  hin: "Hindi",
  ben: "Bengali",
  tam: "Tamil",
  tel: "Telugu",
  mal: "Malayalam",
  kan: "Kannada",
  kor: "Korean",
  jpn: "Japanese",
  chi: "Chinese",
  zho: "Chinese",
  fra: "French",
  fre: "French",
  spa: "Spanish",
  deu: "German",
  ger: "German",
  ita: "Italian",
  rus: "Russian",
  ara: "Arabic",
  tur: "Turkish",
  por: "Portuguese",
  und: "Default",
};

function formatLang(code) {
  if (!code) return null;
  return LANG_NAMES[code.toLowerCase()] || code.toUpperCase();
}

/**
 * Probe remote DhakaFlix video streams directly via HTTP Range requests using ffprobe.
 */
export async function probeMedia(videoUrl) {
  if (!isAllowedUrl(videoUrl)) {
    throw new Error("Blocked URL origin");
  }
  if (probeCache.has(videoUrl)) {
    return probeCache.get(videoUrl);
  }

  const ext = path.extname(safeDecode(new URL(videoUrl).pathname)).toLowerCase();
  if (!ffprobeAvailable) {
    return {
      url: videoUrl,
      ext,
      duration: 0,
      video: null,
      audioTracks: [],
      subtitleTracks: [],
      recommendedMode: ext === ".mp4" || ext === ".webm" ? "direct" : "direct",
      ffmpegAvailable,
    };
  }

  const { stdout } = await execFileAsync(
    "ffprobe",
    [
      "-v", "quiet",
      "-print_format", "json",
      "-show_format",
      "-show_streams",
      "-analyzeduration", "5000000",
      "-probesize", "5000000",
      videoUrl,
    ],
    { timeout: 15000, maxBuffer: 4 * 1024 * 1024 }
  );

  const raw = JSON.parse(stdout);
  const streams = raw.streams || [];
  const duration = parseFloat(raw.format?.duration || "0") || 0;
  const size = parseInt(raw.format?.size || "0", 10) || 0;

  const vStream = streams.find((s) => s.codec_type === "video" && s.disposition?.attached_pic !== 1);
  const video = vStream
    ? {
      index: vStream.index,
      codec: vStream.codec_name,
      profile: vStream.profile || null,
      width: vStream.width || 0,
      height: vStream.height || 0,
      pixFmt: vStream.pix_fmt || "",
      isHevc: vStream.codec_name === "hevc" || vStream.codec_name === "h265",
      is10Bit: /10le|10be|p10/i.test(vStream.pix_fmt || ""),
      browserSafe: BROWSER_SAFE_VIDEO.has(vStream.codec_name),
    }
    : null;

  const audioStreams = streams.filter((s) => s.codec_type === "audio");
  const audioTracks = audioStreams.map((a, idx) => {
    const lang = formatLang(a.tags?.language);
    const title = a.tags?.title || null;
    const ch = a.channels === 6 ? "5.1" : a.channels === 8 ? "7.1" : a.channels === 2 ? "Stereo" : a.channels ? `${a.channels}ch` : "";
    const parts = [lang || `Track ${idx + 1}`];
    if (title && (!lang || !title.toLowerCase().includes(lang.toLowerCase()))) parts.push(title);
    if (ch) parts.push(ch);
    parts.push((a.codec_name || "").toUpperCase());
    return {
      streamIndex: a.index,
      audioIndex: idx,
      codec: a.codec_name,
      channels: a.channels || 2,
      language: a.tags?.language || "und",
      langLabel: lang || `Track ${idx + 1}`,
      title,
      label: parts.join(" · "),
      browserSafe: BROWSER_SAFE_AUDIO.has(a.codec_name),
    };
  });

  const subStreams = streams.filter((s) => s.codec_type === "subtitle");
  const SPAM_SUB_TITLE_RE = /^(hdhub4u|katmovie|moviesverse|vegamovies|filmyzilla|mkvcinemas|bollyflix|uhdmovies|olamovies|psa|yify|rarbg|tgx|galaxy|worldfree4u|downloadhub|1tamilmv|tamilrockers|mlsbd|circleftp|dhakaflix|discoveryftp)[\w.-]*$/i;

  const rawSubs = subStreams
    .filter((s) => TEXT_SUB_CODECS.has(s.codec_name))
    .map((s, idx) => {
      const langCode = (s.tags?.language || "und").toLowerCase();
      const lang = formatLang(langCode) || `Subtitle ${idx + 1}`;
      const rawTitle = (s.tags?.title || "").trim();
      const forced = s.disposition?.forced === 1 || /\bforced\b/i.test(rawTitle);
      const sdh = s.disposition?.hearing_impaired === 1 || /\b(sdh|cc|hearing\s*impaired)\b/i.test(rawTitle);
      const isDefault = s.disposition?.default === 1;
      const isEnglish = /^eng/i.test(langCode) || /\benglish\b/i.test(rawTitle);
      const cleanTitle = rawTitle && !SPAM_SUB_TITLE_RE.test(rawTitle) ? rawTitle : "";

      let baseLabel = lang;
      if (cleanTitle && !cleanTitle.toLowerCase().includes(lang.toLowerCase())) {
        baseLabel = `${lang} (${cleanTitle})`;
      } else if (cleanTitle) {
        baseLabel = cleanTitle;
      }

      if (forced && !/forced/i.test(baseLabel)) {
        baseLabel += " (Forced · Signs Only)";
      } else if (sdh && !/\bsdh\b/i.test(baseLabel)) {
        baseLabel += " (SDH)";
      }

      return {
        streamIndex: s.index,
        codec: s.codec_name,
        language: langCode,
        langName: lang,
        forced,
        sdh,
        isDefault,
        isEnglish,
        baseLabel,
        origIdx: idx,
      };
    });

  // Sort FULL non-forced dialogue tracks FIRST (English Full -> Other Full -> SDH -> Forced LAST!)
  rawSubs.sort((a, b) => {
    const rank = (x) => {
      if (x.forced) return 400; // NEVER auto-pick Forced signs-only over full dialogue!
      if (x.isEnglish && !x.sdh) return 10;
      if (x.isEnglish && x.sdh) return 20;
      if (x.isDefault && !x.sdh) return 30;
      if (!x.sdh) return 50;
      return 80;
    };
    const diff = rank(a) - rank(b);
    return diff !== 0 ? diff : a.origIdx - b.origIdx;
  });

  // Disambiguate identical labels (e.g. 3 Full English tracks -> "English", "English #2", "English #3")
  const labelTotals = new Map();
  for (const s of rawSubs) {
    labelTotals.set(s.baseLabel, (labelTotals.get(s.baseLabel) || 0) + 1);
  }
  const labelSeen = new Map();
  const subtitleTracks = rawSubs.map((s) => {
    const count = (labelSeen.get(s.baseLabel) || 0) + 1;
    labelSeen.set(s.baseLabel, count);
    const label =
      labelTotals.get(s.baseLabel) > 1
        ? `${s.baseLabel} #${count}`
        : !s.forced && !s.sdh && rawSubs.some((o) => o.langName === s.langName && o.forced)
          ? `${s.baseLabel} (Full)`
          : s.baseLabel;
    return {
      streamIndex: s.streamIndex,
      codec: s.codec,
      language: s.language,
      forced: s.forced,
      sdh: s.sdh,
      isDefault: s.isDefault,
      label,
    };
  });

  const defaultSub =
    subtitleTracks.find((s) => !s.forced && /^eng/i.test(s.language)) ||
    subtitleTracks.find((s) => !s.forced) ||
    subtitleTracks[0] ||
    null;

  // Smart playback recommendation:
  // - MP4/WebM with H.264/VP9 + AAC/Opus + single track => direct (0% CPU, native instant seek)
  // - H.264 MKV or non-AAC audio => remux (0% video CPU, AAC audio + audio track picker!)
  // - HEVC MKV => remux first if user wants speed, or transcode for guaranteed compatibility
  let recommendedMode = "remux";
  const firstAudio = audioTracks[0];
  if ((ext === ".mp4" || ext === ".webm") && video?.browserSafe && (!firstAudio || firstAudio.browserSafe) && audioTracks.length <= 1) {
    recommendedMode = "direct";
  } else if (video && !video.browserSafe) {
    // HEVC / MPEG4 / AVI: default to universal transcode so EVERY browser plays with picture + sound!
    // Users with hardware HEVC (Edge/Chrome on Windows) can also click "Remux (Fast)" for 0% CPU.
    recommendedMode = "transcode";
  }

  // Default audio track: prefer English if Dual Audio, else Track 0
  let defaultAudioIndex = 0;
  const engIdx = audioTracks.findIndex((a) => /^eng/i.test(a.language) || /english/i.test(a.title || ""));
  if (engIdx >= 0) defaultAudioIndex = engIdx;

  const result = {
    url: videoUrl,
    ext,
    duration,
    size,
    video,
    audioTracks,
    subtitleTracks,
    defaultSubtitleStreamIndex: defaultSub ? defaultSub.streamIndex : null,
    recommendedMode,
    defaultAudioIndex,
    ffmpegAvailable,
  };

  setLru(probeCache, videoUrl, result, 150);
  return result;
}

const MIME_BY_EXT = {
  ".mp4": "video/mp4",
  ".m4v": "video/mp4",
  ".webm": "video/webm",
  ".mkv": "video/x-matroska",
  ".avi": "video/x-msvideo",
  ".mov": "video/quicktime",
  ".ts": "video/mp2t",
};

/**
 * Zero-CPU HTTP Range Passthrough proxy (for Direct Play and Full-Speed Download).
 */
export async function proxyDirectStream(videoUrl, req, res, { download = false } = {}) {
  if (!isAllowedUrl(videoUrl)) {
    res.writeHead(403);
    res.end("Forbidden origin");
    return;
  }

  const controller = new AbortController();
  req.on("close", () => controller.abort());

  const headers = {};
  if (isIccMediaUrl(videoUrl)) {
    headers.Referer = `${ICC_ORIGIN}/`;
  }
  if (!download && req.headers.range) {
    headers.Range = req.headers.range;
  }

  try {
    const upstream = await fetch(videoUrl, {
      method: req.method === "HEAD" ? "HEAD" : "GET",
      headers,
      signal: controller.signal,
    });

    const pathname = safeDecode(new URL(videoUrl).pathname);
    const fileName = path.basename(pathname);
    const ext = path.extname(fileName).toLowerCase();
    const contentType = download ? "application/octet-stream" : MIME_BY_EXT[ext] || "video/mp4";

    const outHeaders = {
      "Content-Type": contentType,
      "Accept-Ranges": upstream.headers.get("accept-ranges") || "bytes",
    };
    const cl = upstream.headers.get("content-length");
    if (cl) outHeaders["Content-Length"] = cl;
    const cr = upstream.headers.get("content-range");
    if (cr) outHeaders["Content-Range"] = cr;
    if (download) {
      const safeName = fileName.replace(/["\r\n]/g, "");
      outHeaders["Content-Disposition"] = `attachment; filename="${safeName}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
    }

    res.writeHead(upstream.status, outHeaders);
    if (req.method === "HEAD" || !upstream.body) {
      res.end();
      return;
    }

    const nodeStream = Readable.fromWeb(upstream.body);
    nodeStream.on("error", () => {
      if (!res.writableEnded) res.end();
    });
    res.on("close", () => {
      nodeStream.destroy();
      controller.abort();
    });
    nodeStream.pipe(res);
  } catch (err) {
    if (err.name === "AbortError") return;
    if (!res.headersSent) {
      res.writeHead(502);
      res.end("Upstream error: " + err.message);
    }
  }
}

/**
 * Live FFmpeg smart transmux / transcode stream into fragmented MP4 for universal browser playback,
 * instant seeking (-ss before -i uses HTTP Range!), and Dual Audio track selection!
 */
export function streamViaFfmpeg(videoUrl, opts, req, res) {
  if (!isAllowedUrl(videoUrl)) {
    res.writeHead(403);
    res.end("Forbidden origin");
    return;
  }
  if (!ffmpegAvailable) {
    return proxyDirectStream(videoUrl, req, res);
  }

  const mode = opts.mode === "remux" ? "remux" : "transcode";
  const start = Math.max(0, parseFloat(opts.start || "0") || 0);
  const audioIdx = Math.max(0, parseInt(opts.audio ?? "0", 10) || 0);
  const quality = opts.quality || "original"; // "original" | "1080" | "720" | "480"

  const args = [
    "-hide_banner",
    "-loglevel", "error",
    "-reconnect", "1",
    "-reconnect_streamed", "1",
    "-reconnect_delay_max", "2",
  ];
  if (isIccMediaUrl(videoUrl)) {
    args.push("-headers", `Referer: ${ICC_ORIGIN}/\r\n`);
  }

  // Put -ss BEFORE -i for near-instant HTTP range seeking on DhakaFlix!
  if (start > 0.5) {
    args.push("-ss", start.toFixed(2));
  }

  args.push(
    "-i", videoUrl,
    "-map", "0:v:0",
    "-map", `0:a:${audioIdx}?`,
    "-sn" // subtitles are delivered cleanly as WebVTT tracks!
  );

  if (mode === "remux") {
    args.push(
      "-c:v", "copy",
      "-c:a", "aac",
      "-ac", "2",
      "-b:a", "192k",
      "-avoid_negative_ts", "make_zero"
    );
  } else {
    // Universal browser H.264 transcode (handles 10-bit HEVC MKV effortlessly in real-time!)
    args.push(
      "-c:v", "libx264",
      "-preset", "veryfast",
      "-tune", "zerolatency",
      "-crf", quality === "480" ? "25" : quality === "720" ? "23" : "22",
      "-pix_fmt", "yuv420p",
      "-g", "48",
      "-threads", "0"
    );
    if (quality === "720") {
      args.push("-vf", "scale=-2:min(720\\,ih)");
    } else if (quality === "480") {
      args.push("-vf", "scale=-2:min(480\\,ih)");
    } else if (quality === "1080") {
      args.push("-vf", "scale=-2:min(1080\\,ih)");
    }
    args.push(
      "-c:a", "aac",
      "-ac", "2",
      "-b:a", "160k"
    );
  }

  args.push(
    "-f", "mp4",
    "-movflags", "frag_keyframe+empty_moov+default_base_moof",
    "pipe:1"
  );

  const proc = spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] });
  let closed = false;
  let stderrTail = "";

  const killProc = () => {
    if (closed) return;
    closed = true;
    try {
      proc.stdout?.destroy();
      proc.kill("SIGKILL");
    } catch { }
  };

  req.on("close", killProc);
  res.on("close", killProc);

  proc.stderr.on("data", (chunk) => {
    stderrTail = (stderrTail + chunk.toString()).slice(-500);
  });

  let headersSent = false;
  proc.stdout.on("data", (chunk) => {
    if (closed) return;
    if (!headersSent) {
      headersSent = true;
      res.writeHead(200, {
        "Content-Type": "video/mp4",
        "Cache-Control": "no-store",
        "X-Stream-Mode": mode,
      });
    }
    if (!res.write(chunk)) {
      proc.stdout.pause();
      res.once("drain", () => {
        if (!closed) proc.stdout.resume();
      });
    }
  });

  proc.stdout.on("end", () => {
    if (!closed && !res.writableEnded) res.end();
  });

  proc.on("close", (code) => {
    if (!headersSent && !closed) {
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end(`FFmpeg stream error (code ${code}): ${stderrTail}`);
    } else if (!res.writableEnded) {
      res.end();
    }
  });

  proc.on("error", (err) => {
    if (!headersSent && !closed) {
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end("Failed to start FFmpeg: " + err.message);
    }
  });
}

// Per-track parsed subtitle cue cache: key -> Map<startKey, { start, end, text }>
const cueTrackCache = new Map();
const completedCueKeys = new Set();

function getOrCreateCueStore(key) {
  if (!cueTrackCache.has(key)) {
    if (cueTrackCache.size >= 40) {
      const oldest = cueTrackCache.keys().next().value;
      cueTrackCache.delete(oldest);
      completedCueKeys.delete(oldest);
    }
    cueTrackCache.set(key, new Map());
  }
  return cueTrackCache.get(key);
}

/**
 * Strip messy ASS/SSA/HTML subtitle formatting tags while keeping clean readable text + line breaks.
 */
function cleanSubtitleText(raw) {
  return (raw || "")
    .replace(/\{\\[^}]*\}/g, "") // strip ASS {\an8}, {\pos(...)}, {\fn...}
    .replace(/<[^>]+>/gi, "") // strip HTML tags like <font>, <i>, <b>
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&nbsp;/gi, " ")
    .replace(/\\N/gi, "\n")
    .replace(/\\h/g, " ")
    .replace(/\r/g, "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .join("\n")
    .trim();
}

function parseSrtOrVttTimestamp(ts) {
  const clean = (ts || "").trim().replace(",", ".");
  const parts = clean.split(":");
  if (parts.length === 3) {
    return parseInt(parts[0], 10) * 3600 + parseInt(parts[1], 10) * 60 + parseFloat(parts[2]);
  }
  if (parts.length === 2) {
    return parseInt(parts[0], 10) * 60 + parseFloat(parts[1]);
  }
  return NaN;
}

/**
 * Parse a complete SRT, WebVTT, or ASS/SSA string into normalized [{ start, end, text }] cues.
 */
export function parseSubtitleBlocks(rawText) {
  const clean = (rawText || "").replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const blocks = clean.split(/\n{2,}/);
  const cues = [];

  for (const block of blocks) {
    const lines = block.split("\n").map((l) => l.trim()).filter(Boolean);
    if (lines.length < 2) continue;

    let timeIdx = lines.findIndex((l) => l.includes("-->"));
    if (timeIdx < 0) continue;

    const tm = lines[timeIdx].match(/([\d:.,]+)\s*-->\s*([\d:.,]+)/);
    if (!tm) continue;

    const start = parseSrtOrVttTimestamp(tm[1]);
    const end = parseSrtOrVttTimestamp(tm[2]);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;

    const text = cleanSubtitleText(lines.slice(timeIdx + 1).join("\n"));
    if (!text) continue;

    cues.push({ start: +start.toFixed(3), end: +end.toFixed(3), text });
  }

  // Fallback parser for raw ASS/SSA files (Dialogue: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text)
  if (cues.length === 0 && /^Dialogue:/m.test(clean)) {
    for (const line of clean.split("\n")) {
      if (!line.startsWith("Dialogue:")) continue;
      const parts = line.slice(9).split(",");
      if (parts.length < 10) continue;
      const start = parseSrtOrVttTimestamp(parts[1]);
      const end = parseSrtOrVttTimestamp(parts[2]);
      if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
      const text = cleanSubtitleText(parts.slice(9).join(","));
      if (text) cues.push({ start: +start.toFixed(3), end: +end.toFixed(3), text });
    }
  }

  return cues;
}

function decodeSubtitleBuffer(buf) {
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return buf.subarray(2).toString("utf16le");
  }
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    const swapped = Buffer.allocUnsafe(buf.length - 2);
    for (let i = 2; i + 1 < buf.length; i += 2) {
      swapped[i - 2] = buf[i + 1];
      swapped[i - 1] = buf[i];
    }
    return swapped.toString("utf16le");
  }
  return buf.toString("utf8");
}

/**
 * Instant-start Live Streaming Subtitle Engine (SSE):
 * - External .srt/.vtt: fetches, parses, caches, and emits ALL cues in ~20ms.
 * - Embedded MKV/MP4 track: uses `ffmpeg -ss <start-5> -copyts -vn -an -map 0:<idx> -f srt -flush_packets 1`
 *   to HTTP-Range seek directly to the user's playback position and stream frame-accurate absolute cues
 *   in ~300ms while reading ahead and caching the rest of the movie in memory!
 */
export async function streamSubtitleCues({ url, streamIndex, externalUrl, start = 0 }, req, res) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  let clientClosed = false;
  const send = (event, payload) => {
    if (clientClosed || res.writableEnded) return;
    res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
  };

  req.on("close", () => {
    clientClosed = true;
  });

  // 1. External .srt / .vtt subtitle file
  if (externalUrl) {
    if (!isAllowedUrl(externalUrl)) {
      send("error", { message: "Forbidden subtitle origin" });
      res.end();
      return;
    }
    const cacheKey = `ext-cues:${externalUrl}`;
    const store = getOrCreateCueStore(cacheKey);
    if (store.size > 0) {
      send("cues", { cues: [...store.values()] });
      send("done", { total: store.size, cached: true });
      res.end();
      return;
    }
    try {
      const headers = isIccMediaUrl(externalUrl) ? { Referer: `${ICC_ORIGIN}/` } : {};
      const upstream = await fetch(externalUrl, { headers, signal: AbortSignal.timeout(10000) });
      if (!upstream.ok) {
        send("error", { message: `Subtitle HTTP ${upstream.status}` });
        res.end();
        return;
      }
      const text = decodeSubtitleBuffer(Buffer.from(await upstream.arrayBuffer()));
      const cues = parseSubtitleBlocks(text);
      for (const c of cues) store.set(`${c.start}:${c.end}`, c);
      send("cues", { cues });
      send("done", { total: cues.length });
    } catch (err) {
      send("error", { message: err.message });
    }
    res.end();
    return;
  }

  // 2. Embedded MKV / MP4 subtitle track via instant-seek FFmpeg streaming
  if (!url || streamIndex === undefined || !isAllowedUrl(url) || !ffmpegAvailable) {
    send("error", { message: "Embedded subtitle extraction unavailable" });
    res.end();
    return;
  }

  const sIdx = parseInt(streamIndex, 10);
  const seekStart = Math.max(0, Math.floor((parseFloat(start || "0") || 0) - 6));
  const cacheKey = `emb-cues:${url}:${sIdx}`;
  const store = getOrCreateCueStore(cacheKey);

  // Immediately confirm stream opened + deliver any previously cached cues (0ms!)
  send("ready", { seekStart, cachedCount: store.size });
  if (store.size > 0) {
    send("cues", { cues: [...store.values()] });
    if (completedCueKeys.has(cacheKey)) {
      send("done", { total: store.size, cached: true });
      res.end();
      return;
    }
  }

  const args = [
    "-hide_banner",
    "-loglevel", "error",
    "-reconnect", "1",
    "-reconnect_streamed", "1",
    "-reconnect_delay_max", "2",
  ];
  if (isIccMediaUrl(url)) {
    args.push("-headers", `Referer: ${ICC_ORIGIN}/\r\n`);
  }
  if (seekStart > 0) {
    args.push("-ss", String(seekStart));
  }
  args.push(
    "-copyts",
    "-i", url,
    "-vn",
    "-an",
    "-map", `0:${sIdx}`,
    "-f", "srt",
    "-flush_packets", "1",
    "pipe:1"
  );

  const proc = spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] });
  let closed = false;
  const killProc = () => {
    if (closed) return;
    closed = true;
    try {
      proc.stdout?.destroy();
      proc.kill("SIGKILL");
    } catch {}
  };
  req.on("close", killProc);
  res.on("close", killProc);

  let textBuf = "";
  let pendingBatch = [];
  let flushTimer = null;
  let sentCount = 0;

  const flushBatch = () => {
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    if (pendingBatch.length === 0) return;
    const batch = pendingBatch;
    pendingBatch = [];
    sentCount += batch.length;
    send("cues", { cues: batch });
  };

  const ingestBlocks = (rawBlocks) => {
    const parsed = parseSubtitleBlocks(rawBlocks);
    for (const c of parsed) {
      const k = `${c.start}:${c.end}`;
      if (!store.has(k)) {
        store.set(k, c);
        pendingBatch.push(c);
      } else {
        // Also send if it arrived fresh on this seek stream and wasn't sent yet
        if (sentCount === 0) pendingBatch.push(c);
      }
    }
    // Emit first cues IMMEDIATELY for <400ms startup latency, then batch smoothly every 150ms
    if (sentCount < 10 && pendingBatch.length > 0) {
      flushBatch();
    } else if (pendingBatch.length >= 25) {
      flushBatch();
    } else if (pendingBatch.length > 0 && !flushTimer) {
      flushTimer = setTimeout(flushBatch, 150);
    }
  };

  proc.stdout.on("data", (chunk) => {
    if (closed) return;
    textBuf += chunk.toString("utf8").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    const lastBreak = textBuf.lastIndexOf("\n\n");
    if (lastBreak !== -1) {
      const complete = textBuf.slice(0, lastBreak);
      textBuf = textBuf.slice(lastBreak + 2);
      ingestBlocks(complete);
    }
  });

  proc.on("close", (code) => {
    if (!closed && textBuf.trim()) {
      ingestBlocks(textBuf);
    }
    flushBatch();
    if (!closed && seekStart === 0 && code === 0 && store.size > 0) {
      completedCueKeys.add(cacheKey);
    }
    if (!clientClosed && !res.writableEnded) {
      send("done", { total: store.size });
      res.end();
    }
    closed = true;
  });

  proc.on("error", (err) => {
    if (!clientClosed && !res.writableEnded) {
      send("error", { message: err.message });
      res.end();
    }
    closed = true;
  });
}

/**
 * Serve embedded MKV subtitles OR external .srt files cleanly as WebVTT (legacy/download endpoint).
 */
export async function serveSubtitleVtt({ url, streamIndex, externalUrl, offset = 0 }, res) {
  const shift = Math.max(0, parseFloat(offset || "0") || 0);
  let rawVtt = null;

  if (externalUrl) {
    if (!isAllowedUrl(externalUrl)) {
      res.writeHead(403);
      res.end("Forbidden");
      return;
    }
    const cacheKey = `ext:${externalUrl}`;
    if (subtitleCache.has(cacheKey)) {
      rawVtt = subtitleCache.get(cacheKey);
    } else {
      const upstream = await fetch(externalUrl, { signal: AbortSignal.timeout(8000) });
      if (!upstream.ok) {
        res.writeHead(404);
        res.end("Subtitle not found");
        return;
      }
      const text = await upstream.text();
      rawVtt = srtToVtt(text);
      setLru(subtitleCache, cacheKey, rawVtt, 60);
    }
  } else if (url && streamIndex !== undefined) {
    if (!isAllowedUrl(url) || !ffmpegAvailable) {
      res.writeHead(400);
      res.end("Unavailable");
      return;
    }
    const sIdx = parseInt(streamIndex, 10);
    const cacheKey = `emb:${url}:${sIdx}`;
    if (subtitleCache.has(cacheKey)) {
      rawVtt = subtitleCache.get(cacheKey);
    } else {
      try {
        const { stdout } = await execFileAsync(
          "ffmpeg",
          ["-hide_banner", "-loglevel", "error", "-i", url, "-map", `0:${sIdx}`, "-f", "webvtt", "pipe:1"],
          { timeout: 45000, maxBuffer: 12 * 1024 * 1024 }
        );
        rawVtt = stdout;
        setLru(subtitleCache, cacheKey, rawVtt, 40);
      } catch (err) {
        res.writeHead(500);
        res.end("Subtitle extraction failed: " + err.message);
        return;
      }
    }
  } else {
    res.writeHead(400);
    res.end("Missing subtitle params");
    return;
  }

  const finalVtt = shift > 0.1 ? shiftVttTimestamps(rawVtt, shift) : rawVtt;
  res.writeHead(200, {
    "Content-Type": "text/vtt; charset=utf-8",
    "Cache-Control": "public, max-age=3600",
  });
  res.end(finalVtt);
}

function srtToVtt(text) {
  const clean = text.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  if (clean.trimStart().startsWith("WEBVTT")) return clean;
  const converted = clean.replace(/(\d{2}:\d{2}:\d{2}),(\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2}),(\d{3})/g, "$1.$2 --> $3.$4");
  return "WEBVTT\n\n" + converted;
}

function parseVttTime(ts) {
  const parts = ts.split(":");
  if (parts.length === 3) {
    return parseInt(parts[0], 10) * 3600 + parseInt(parts[1], 10) * 60 + parseFloat(parts[2]);
  }
  return parseInt(parts[0], 10) * 60 + parseFloat(parts[1]);
}

function formatVttTime(sec) {
  const s = Math.max(0, sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const rem = (s % 60).toFixed(3).padStart(6, "0");
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${rem}`;
}

function shiftVttTimestamps(vtt, offsetSec) {
  const lines = vtt.split(/\r?\n/);
  const out = [];
  let skipCue = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const m = line.match(/^((?:\d{2}:)?\d{2}:\d{2}\.\d{3})\s*-->\s*((?:\d{2}:)?\d{2}:\d{2}\.\d{3})(.*)$/);
    if (m) {
      const start = parseVttTime(m[1]) - offsetSec;
      const end = parseVttTime(m[2]) - offsetSec;
      if (end <= 0) {
        skipCue = true;
        continue;
      }
      skipCue = false;
      out.push(`${formatVttTime(Math.max(0, start))} --> ${formatVttTime(end)}${m[3] || ""}`);
    } else if (skipCue) {
      if (line.trim() === "") skipCue = false;
    } else {
      out.push(line);
    }
  }
  return out.join("\n");
}

/**
 * Generate an M3U playlist for 1-click VLC / PotPlayer / MPV native BDIX streaming!
 */
export function buildM3uPlaylist(entries) {
  const lines = ["#EXTM3U"];
  for (const e of entries) {
    const label = (e.title || e.name || "Video").replace(/[\r\n]/g, " ");
    lines.push(`#EXTINF:-1,${label}`);
    lines.push(e.url);
  }
  return lines.join("\r\n") + "\r\n";
}
