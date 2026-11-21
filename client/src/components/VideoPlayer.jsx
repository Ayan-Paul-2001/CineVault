import React, { useEffect, useRef, useState, useCallback, useMemo } from "react";
import {
  X,
  Play,
  Pause,
  Volume2,
  VolumeX,
  Maximize,
  Minimize,
  SkipBack,
  SkipForward,
  Settings,
  Subtitles,
  AudioLines,
  Download,
  ListVideo,
  Loader2,
  ChevronRight,
  Check,
  AlertTriangle,
  Upload,
} from "lucide-react";
import {
  apiGet,
  apiPost,
  buildStreamUrl,
  buildDownloadUrl,
  buildM3uUrl,
  formatDuration,
} from "../api.js";

function parseLocalSubtitleFile(rawText) {
  const clean = (rawText || "").replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const blocks = clean.split(/\n{2,}/);
  const cues = [];
  const toSec = (ts) => {
    const p = ts.trim().replace(",", ".").split(":");
    if (p.length === 3) return parseInt(p[0], 10) * 3600 + parseInt(p[1], 10) * 60 + parseFloat(p[2]);
    if (p.length === 2) return parseInt(p[0], 10) * 60 + parseFloat(p[1]);
    return NaN;
  };
  const cleanText = (str) =>
    str
      .replace(/\{\\[^}]*\}/g, "")
      .replace(/<[^>]+>/g, "")
      .replace(/&amp;/gi, "&")
      .replace(/&lt;/gi, "<")
      .replace(/&gt;/gi, ">")
      .replace(/&quot;/gi, '"')
      .replace(/&#39;|&apos;/gi, "'")
      .replace(/&nbsp;/gi, " ")
      .replace(/\\N/gi, "\n")
      .replace(/\\h/g, " ")
      .trim();

  for (const b of blocks) {
    const lines = b.split("\n").map((l) => l.trim()).filter(Boolean);
    const ti = lines.findIndex((l) => l.includes("-->"));
    if (ti < 0) continue;
    const m = lines[ti].match(/([\d:.,]+)\s*-->\s*([\d:.,]+)/);
    if (!m) continue;
    const start = toSec(m[1]);
    const end = toSec(m[2]);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
    const text = cleanText(lines.slice(ti + 1).join("\n"));
    if (text) cues.push({ start, end, text });
  }

  if (cues.length === 0 && /^Dialogue:/m.test(clean)) {
    for (const line of clean.split("\n")) {
      if (!line.startsWith("Dialogue:")) continue;
      const parts = line.slice(9).split(",");
      if (parts.length < 10) continue;
      const start = toSec(parts[1]);
      const end = toSec(parts[2]);
      if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
      const text = cleanText(parts.slice(9).join(","));
      if (text) cues.push({ start, end, text });
    }
  }
  return cues;
}

const SUB_SIZES = [
  { id: "sm", label: "S" },
  { id: "md", label: "M" },
  { id: "lg", label: "L" },
  { id: "xl", label: "XL" },
];

export default function VideoPlayer({
  session,
  onClose,
  onSwitchEpisode,
  onSwitchQualityOption,
  onProgressSaved,
}) {
  const {
    item,
    file,
    externalSubtitles = [],
    seasonName,
    playlist,
    playlistIndex = 0,
    qualityLabel,
    serverLabel,
    qualityOptions = [],
    startTime = 0,
  } = session;

  const containerRef = useRef(null);
  const videoRef = useRef(null);
  const fileInputRef = useRef(null);
  const idleTimerRef = useRef(null);
  const lastSavedRef = useRef(0);
  const cueMapRef = useRef(new Map());
  const manualSubRef = useRef(false);
  const triedSubStreamsRef = useRef(new Set());

  const [probe, setProbe] = useState(null);
  const [probing, setProbing] = useState(true);
  const [mode, setMode] = useState("transcode"); // "direct" | "remux" | "transcode"
  const [audioIdx, setAudioIdx] = useState(0);
  const [quality, setQuality] = useState("original");
  const [streamOffset, setStreamOffset] = useState(Math.floor(startTime || 0));

  // Cinema Subtitle Engine state
  const [selectedSub, setSelectedSub] = useState(null); // { type: "embedded"|"external"|"local", streamIndex?, url?, label, cues? }
  const [localSubs, setLocalSubs] = useState([]);
  const [subCues, setSubCues] = useState([]);
  const [subStatus, setSubStatus] = useState("idle"); // "idle" | "loading" | "streaming" | "ready" | "error"
  const [subSeekNonce, setSubSeekNonce] = useState(0);
  const [subAnchorSec, setSubAnchorSec] = useState(Math.floor(startTime || 0));
  const [subOffsetSec, setSubOffsetSec] = useState(0);
  const [subSize, setSubSize] = useState(() => {
    try {
      return localStorage.getItem("cinevault_sub_size") || "md";
    } catch {
      return "md";
    }
  });

  const [playing, setPlaying] = useState(false);
  const [buffering, setBuffering] = useState(true);
  const [currentTime, setCurrentTime] = useState(startTime || 0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(1);
  const [muted, setMuted] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [idle, setIdle] = useState(false);
  const [activeMenu, setActiveMenu] = useState(null); // "settings" | "audio" | "subs" | null
  const [streamError, setStreamError] = useState(null);

  const hasNext = Array.isArray(playlist) && playlistIndex < playlist.length - 1;
  const isFfmpegMode = mode !== "direct";

  // Step 1: Probe file streams with FFprobe
  useEffect(() => {
    let cancelled = false;
    setProbing(true);
    setStreamError(null);
    setStreamOffset(Math.floor(startTime || 0));
    setSubAnchorSec(Math.floor(startTime || 0));
    setCurrentTime(startTime || 0);
    setSelectedSub(null);
    manualSubRef.current = false;
    triedSubStreamsRef.current = new Set();
    cueMapRef.current.clear();
    setSubCues([]);

    apiGet(`/api/media/probe?url=${encodeURIComponent(file.url)}`)
      .then((info) => {
        if (cancelled) return;
        setProbe(info);
        setDuration(info.duration || 0);
        setMode(info.recommendedMode || "transcode");
        setAudioIdx(info.defaultAudioIndex ?? 0);

        const autoPref = (() => {
          try {
            return localStorage.getItem("cinevault_sub_on") !== "0";
          } catch {
            return true;
          }
        })();

        if (externalSubtitles.length > 0) {
          setSelectedSub({
            type: "external",
            url: externalSubtitles[0].url,
            label: externalSubtitles[0].name,
          });
        } else if (autoPref && info.subtitleTracks?.length > 0) {
          // ALWAYS prefer FULL non-forced English dialogue track (never Forced signs-only!)
          const chosen =
            (info.defaultSubtitleStreamIndex != null
              ? info.subtitleTracks.find((s) => s.streamIndex === info.defaultSubtitleStreamIndex)
              : null) ||
            info.subtitleTracks.find((s) => !s.forced && (/^eng/i.test(s.language) || /english/i.test(s.label))) ||
            info.subtitleTracks.find((s) => !s.forced) ||
            info.subtitleTracks[0];
          if (chosen) {
            triedSubStreamsRef.current.add(chosen.streamIndex);
            setSelectedSub({
              type: "embedded",
              streamIndex: chosen.streamIndex,
              language: chosen.language,
              forced: Boolean(chosen.forced),
              label: `${chosen.label} (Embedded)`,
            });
          }
        } else {
          setSelectedSub(null);
        }
      })
      .catch(() => {
        if (cancelled) return;
        setProbe(null);
        setMode("direct");
      })
      .finally(() => {
        if (!cancelled) setProbing(false);
      });

    return () => {
      cancelled = true;
    };
  }, [file.url]);

  // Step 2: Live Streaming Subtitle Extractor (SSE with instant HTTP-Range seek!)
  useEffect(() => {
    if (!selectedSub) {
      setSubStatus("idle");
      return;
    }

    if (selectedSub.type === "local") {
      setSubCues(selectedSub.cues || []);
      setSubStatus("ready");
      return;
    }

    const p = new URLSearchParams();
    if (selectedSub.type === "external") {
      p.set("external", selectedSub.url);
    } else {
      p.set("url", file.url);
      p.set("stream", String(selectedSub.streamIndex));
      p.set("start", String(Math.max(0, Math.floor(subAnchorSec))));
    }

    setSubStatus("loading");
    const es = new EventSource(`/api/subtitles/stream?${p.toString()}`);

    es.addEventListener("cues", (ev) => {
      try {
        const { cues } = JSON.parse(ev.data);
        if (!Array.isArray(cues) || cues.length === 0) return;
        let changed = false;
        for (const c of cues) {
          const k = `${c.start}:${c.end}`;
          if (!cueMapRef.current.has(k)) {
            cueMapRef.current.set(k, c);
            changed = true;
          }
        }
        if (changed) {
          const sorted = [...cueMapRef.current.values()].sort((a, b) => a.start - b.start);
          setSubCues(sorted);
        }
        setSubStatus("streaming");
      } catch {}
    });

    es.addEventListener("done", () => {
      setSubStatus("ready");
      es.close();
    });

    es.addEventListener("error", () => {
      setSubStatus((prev) => (prev === "streaming" || prev === "ready" ? "ready" : "error"));
      es.close();
    });

    // Smart Auto-Fallback: if an auto-selected embedded track yields 0 cues after 5s
    // (e.g. an unlabeled signs/forced track), automatically try the next full track!
    let fallbackTimer = null;
    if (selectedSub.type === "embedded" && !manualSubRef.current && probe?.subtitleTracks?.length > 1) {
      fallbackTimer = setTimeout(() => {
        if (cueMapRef.current.size > 0) return;
        const alt =
          probe.subtitleTracks.find(
            (s) =>
              !s.forced &&
              !triedSubStreamsRef.current.has(s.streamIndex) &&
              s.language === selectedSub.language
          ) ||
          probe.subtitleTracks.find(
            (s) => !s.forced && !triedSubStreamsRef.current.has(s.streamIndex)
          );
        if (alt) {
          triedSubStreamsRef.current.add(alt.streamIndex);
          es.close();
          setSelectedSub({
            type: "embedded",
            streamIndex: alt.streamIndex,
            language: alt.language,
            forced: Boolean(alt.forced),
            label: `${alt.label} (Embedded)`,
          });
        }
      }, 5000);
    }

    return () => {
      if (fallbackTimer) clearTimeout(fallbackTimer);
      es.close();
    };
  }, [selectedSub, file.url, subAnchorSec, subSeekNonce]);

  // Smooth high-frequency clock (100ms) while playing so subtitles never lag behind HTML5 timeupdate (~250ms)!
  useEffect(() => {
    if (!playing || !selectedSub) return;
    const t = setInterval(() => {
      const v = videoRef.current;
      if (!v) return;
      const raw = v.currentTime || 0;
      setCurrentTime(isFfmpegMode ? streamOffset + raw : raw);
    }, 90);
    return () => clearInterval(t);
  }, [playing, selectedSub, isFfmpegMode, streamOffset]);

  // Compute active subtitle lines at current timestamp + user sync offset
  const activeSubtitleLines = useMemo(() => {
    if (!selectedSub || subCues.length === 0) return [];
    const t = currentTime + subOffsetSec;
    const matches = [];
    for (let i = 0; i < subCues.length; i++) {
      const c = subCues[i];
      if (c.start > t + 0.06) break;
      if (t >= c.start - 0.05 && t <= c.end + 0.12) {
        matches.push(c.text);
      }
    }
    return matches;
  }, [selectedSub, subCues, currentTime, subOffsetSec]);

  const selectSubtitleTrack = useCallback(
    (sub) => {
      manualSubRef.current = true;
      cueMapRef.current.clear();
      setSubCues([]);
      setSubAnchorSec(Math.floor(currentTime));
      setSelectedSub(sub);
      try {
        localStorage.setItem("cinevault_sub_on", sub ? "1" : "0");
      } catch {}
    },
    [currentTime]
  );

  const handleUploadLocalSub = (e) => {
    const f = e.target.files?.[0];
    if (!f) return;
    const reader = new FileReader();
    reader.onload = () => {
      const parsed = parseLocalSubtitleFile(String(reader.result || ""));
      const subObj = {
        type: "local",
        id: `local-${Date.now()}`,
        label: `${f.name} (Uploaded)`,
        cues: parsed,
      };
      setLocalSubs((prev) => [...prev, subObj]);
      selectSubtitleTrack(subObj);
      setActiveMenu(null);
    };
    reader.readAsText(f);
    e.target.value = "";
  };

  // Compute active video src
  const streamSrc = probing
    ? ""
    : buildStreamUrl({
        url: file.url,
        mode,
        audio: audioIdx,
        start: isFfmpegMode ? streamOffset : 0,
        quality,
      });

  // Auto-play when streamSrc changes
  useEffect(() => {
    const v = videoRef.current;
    if (!v || !streamSrc) return;
    setBuffering(true);
    setStreamError(null);
    v.load();
    const onCanPlay = () => {
      if (!isFfmpegMode && startTime > 3 && v.currentTime < 2 && lastSavedRef.current === 0) {
        v.currentTime = startTime;
      }
      v.play().catch(() => {});
    };
    v.addEventListener("canplay", onCanPlay, { once: true });
    return () => v.removeEventListener("canplay", onCanPlay);
  }, [streamSrc]);

  // Save watch progress periodically to SQLite
  const saveProgress = useCallback(
    (pos, dur) => {
      if (!item?.id || !file?.url || pos < 5) return;
      apiPost("/api/progress", {
        mediaId: item.id,
        fileUrl: file.url,
        fileName: file.name,
        seasonName: seasonName || null,
        episodeLabel: file.label || null,
        position: pos,
        duration: dur || duration,
      })
        .then(() => onProgressSaved?.())
        .catch(() => {});
    },
    [item?.id, file?.url, file?.name, file?.label, seasonName, duration, onProgressSaved]
  );

  // Seek handler (native seek in Direct mode; instant HTTP-Range FFmpeg seek in Remux/Transcode + re-anchors embedded subtitles if needed!)
  const seekTo = useCallback(
    (targetSec) => {
      const clamped = Math.max(0, Math.min(duration > 0 ? duration - 1 : targetSec, targetSec));
      const v = videoRef.current;
      if (!v) return;
      if (!isFfmpegMode) {
        v.currentTime = clamped;
        setCurrentTime(clamped);
      } else {
        setBuffering(true);
        setStreamOffset(Math.floor(clamped));
        setCurrentTime(clamped);
      }

      // If embedded subtitle hasn't cached cues near `clamped` yet, re-anchor the instant-seek subtitle stream right here!
      if (selectedSub?.type === "embedded") {
        const hasNearby = [...cueMapRef.current.values()].some(
          (c) => Math.abs(c.start - clamped) <= 35
        );
        if (!hasNearby) {
          setSubAnchorSec(Math.floor(clamped));
          setSubSeekNonce((n) => n + 1);
        }
      }
    },
    [duration, isFfmpegMode, selectedSub]
  );

  const togglePlay = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) v.play().catch(() => {});
    else v.pause();
  }, []);

  const toggleFullscreen = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    if (!document.fullscreenElement) {
      el.requestFullscreen?.().catch(() => {});
    } else {
      document.exitFullscreen?.().catch(() => {});
    }
  }, []);

  useEffect(() => {
    const onFs = () => setIsFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener("fullscreenchange", onFs);
    return () => document.removeEventListener("fullscreenchange", onFs);
  }, []);

  const pokeActivity = useCallback(() => {
    setIdle(false);
    if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
    idleTimerRef.current = setTimeout(() => {
      if (!activeMenu) setIdle(true);
    }, 3200);
  }, [activeMenu]);

  useEffect(() => {
    pokeActivity();
    return () => clearTimeout(idleTimerRef.current);
  }, [pokeActivity]);

  const allSubs = useMemo(
    () => [
      ...localSubs,
      ...externalSubtitles.map((s) => ({ type: "external", url: s.url, label: `${s.name} (External)` })),
      ...(probe?.subtitleTracks || []).map((s) => ({
        type: "embedded",
        streamIndex: s.streamIndex,
        language: s.language,
        forced: Boolean(s.forced),
        label: `${s.label} (Embedded)`,
      })),
    ],
    [localSubs, externalSubtitles, probe?.subtitleTracks]
  );

  // Keyboard shortcuts
  useEffect(() => {
    const onKey = (e) => {
      if (e.target.tagName === "INPUT" || e.target.tagName === "SELECT") return;
      pokeActivity();
      if (e.key === "Escape") {
        if (activeMenu) setActiveMenu(null);
        else {
          saveProgress(currentTime, duration);
          onClose();
        }
      } else if (e.key === " " || e.key.toLowerCase() === "k") {
        e.preventDefault();
        togglePlay();
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        seekTo(currentTime + 10);
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        seekTo(currentTime - 10);
      } else if (e.key.toLowerCase() === "l") {
        seekTo(currentTime + 30);
      } else if (e.key.toLowerCase() === "j") {
        seekTo(currentTime - 30);
      } else if (e.key.toLowerCase() === "f") {
        toggleFullscreen();
      } else if (e.key.toLowerCase() === "c") {
        if (selectedSub) selectSubtitleTrack(null);
        else if (allSubs.length > 0) selectSubtitleTrack(allSubs[0]);
      } else if (e.key.toLowerCase() === "m") {
        setMuted((m) => {
          if (videoRef.current) videoRef.current.muted = !m;
          return !m;
        });
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setVolume((vol) => {
          const next = Math.min(1, +(vol + 0.1).toFixed(2));
          if (videoRef.current) videoRef.current.volume = next;
          return next;
        });
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        setVolume((vol) => {
          const next = Math.max(0, +(vol - 0.1).toFixed(2));
          if (videoRef.current) videoRef.current.volume = next;
          return next;
        });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [
    activeMenu,
    allSubs,
    currentTime,
    duration,
    onClose,
    pokeActivity,
    saveProgress,
    seekTo,
    selectedSub,
    selectSubtitleTrack,
    toggleFullscreen,
    togglePlay,
  ]);

  const switchStreamSetting = (updater) => {
    const pos = Math.floor(currentTime);
    setStreamOffset(pos);
    updater();
    setActiveMenu(null);
  };

  const handleClose = () => {
    saveProgress(currentTime, duration);
    onClose();
  };

  const pct = duration > 0 ? Math.min(100, (currentTime / duration) * 100) : 0;
  const audioTracks = probe?.audioTracks || [];
  const controlsHidden = idle && playing;

  return (
    <div
      ref={containerRef}
      className={`player-overlay ${controlsHidden ? "idle-controls" : ""}`}
      onMouseMove={pokeActivity}
      onClick={() => {
        if (activeMenu) setActiveMenu(null);
      }}
    >
      <input
        ref={fileInputRef}
        type="file"
        accept=".srt,.vtt,.ass,.txt"
        style={{ display: "none" }}
        onChange={handleUploadLocalSub}
      />

      <div className="player-stage">
        {/* Top Overlay Bar */}
        <div className="player-top-bar" onClick={(e) => e.stopPropagation()}>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontFamily: "Outfit, sans-serif", fontSize: 20, fontWeight: 700 }}>
              {item?.title || file.name}
              {seasonName ? ` • ${seasonName}` : ""}
              {file.label ? ` • ${file.label}` : ""}
              {qualityLabel && (
                <span
                  className="badge badge-gold"
                  style={{ marginLeft: 10, verticalAlign: 2, fontSize: 11 }}
                >
                  {qualityLabel}
                  {serverLabel ? ` · ${serverLabel}` : ""}
                </span>
              )}
            </div>
            <div style={{ fontSize: 12.5, color: "var(--text-muted)", marginTop: 3 }}>
              {file.episodeTitle || file.name}
              {probe?.video && (
                <span>
                  {" "}
                  • {probe.video.width}×{probe.video.height} {probe.video.codec?.toUpperCase()} •{" "}
                  {mode === "direct"
                    ? "Direct Play"
                    : mode === "remux"
                      ? "Fast Remux (Video Copy)"
                      : `Universal H.264${quality !== "original" ? ` (${quality}p)` : ""}`}
                </span>
              )}
            </div>
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <a
              className="p-btn"
              href={buildM3uUrl({ url: file.url, title: item?.title || file.name })}
              title="Open directly in VLC / PotPlayer (Raw Full Quality)"
            >
              <ListVideo size={17} /> VLC
            </a>
            <a className="p-btn" href={buildDownloadUrl(file.url)} title="Download File">
              <Download size={17} />
            </a>
            <button className="p-btn" onClick={handleClose} aria-label="Close player">
              <X size={22} />
            </button>
          </div>
        </div>

        {/* Video Element */}
        <video
          ref={videoRef}
          className="player-video"
          src={streamSrc}
          playsInline
          onClick={togglePlay}
          onDoubleClick={toggleFullscreen}
          onPlay={() => setPlaying(true)}
          onPause={() => {
            setPlaying(false);
            saveProgress(currentTime, duration);
          }}
          onWaiting={() => setBuffering(true)}
          onPlaying={() => {
            setBuffering(false);
            setStreamError(null);
          }}
          onLoadedMetadata={(e) => {
            const vd = e.currentTarget.duration;
            if (Number.isFinite(vd) && vd > 0 && !isFfmpegMode) {
              setDuration(vd);
            }
          }}
          onTimeUpdate={(e) => {
            const raw = e.currentTarget.currentTime || 0;
            const actual = isFfmpegMode ? streamOffset + raw : raw;
            setCurrentTime(actual);
            if (Math.abs(actual - lastSavedRef.current) >= 8) {
              lastSavedRef.current = actual;
              saveProgress(actual, duration);
            }
          }}
          onEnded={() => {
            saveProgress(duration || currentTime, duration);
            if (hasNext) {
              onSwitchEpisode(playlistIndex + 1);
            }
          }}
          onError={() => {
            if (mode !== "transcode" && probe?.ffmpegAvailable) {
              setMode("transcode");
            } else {
              setBuffering(false);
              setStreamError("Browser could not decode this stream. Try Universal H.264 mode or open in VLC.");
            }
          }}
        />

        {/* CUSTOM CINEMA SUBTITLE OVERLAY (100% reliable on Desktop, Mobile & Fullscreen!) */}
        {selectedSub && activeSubtitleLines.length > 0 && (
          <div
            className={`cinema-subtitles sub-size-${subSize} ${controlsHidden ? "lowered" : ""}`}
            aria-live="polite"
          >
            {activeSubtitleLines.map((line, idx) => (
              <div className="cinema-sub-cue" key={idx}>
                {line.split("\n").map((row, rIdx) => (
                  <React.Fragment key={rIdx}>
                    {rIdx > 0 && <br />}
                    {row.replace(/<\/?(?:i|b)>/gi, "")}
                  </React.Fragment>
                ))}
              </div>
            ))}
          </div>
        )}

        {/* Buffering / Probing Spinner */}
        {(probing || buffering) && !streamError && (
          <div className="player-spinner">
            <Loader2 size={28} className="spin" color="var(--accent)" />
            <span>
              {probing
                ? "Inspecting audio & subtitle tracks..."
                : mode === "transcode"
                  ? "Starting Universal H.264 stream..."
                  : "Buffering stream..."}
            </span>
          </div>
        )}

        {/* Error fallback */}
        {streamError && (
          <div className="player-spinner" style={{ maxWidth: 420, textAlign: "center" }}>
            <AlertTriangle size={28} color="var(--gold)" />
            <div>{streamError}</div>
            <div style={{ display: "flex", gap: 8, marginTop: 6 }}>
              <button
                className="btn btn-primary btn-sm"
                onClick={() => switchStreamSetting(() => setMode("transcode"))}
              >
                Use Universal H.264
              </button>
              <a
                className="btn btn-glass btn-sm"
                href={buildM3uUrl({ url: file.url, title: item?.title || file.name })}
              >
                Open in VLC
              </a>
            </div>
          </div>
        )}

        {/* Popover Menus (Audio / Subtitles / Playback Engine) */}
        {activeMenu && (
          <div className="player-popover" onClick={(e) => e.stopPropagation()}>
            {activeMenu === "audio" && (
              <>
                <div className="pop-section-title">Audio Tracks (Dual / Multi Audio)</div>
                {audioTracks.length === 0 ? (
                  <div style={{ fontSize: 13, color: "var(--text-muted)", padding: 6 }}>
                    Default audio track active
                  </div>
                ) : (
                  audioTracks.map((a) => (
                    <button
                      key={a.audioIndex}
                      className={`pop-option ${audioIdx === a.audioIndex ? "selected" : ""}`}
                      onClick={() =>
                        switchStreamSetting(() => {
                          setAudioIdx(a.audioIndex);
                          if (mode === "direct") setMode("remux");
                        })
                      }
                    >
                      <span>{a.label}</span>
                      {audioIdx === a.audioIndex && <Check size={15} />}
                    </button>
                  ))
                )}
              </>
            )}

            {activeMenu === "subs" && (
              <>
                <div className="pop-section-title" style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <span>Subtitles</span>
                  {selectedSub && (
                    <span style={{ color: subStatus === "error" ? "#fca5a5" : "var(--green)", fontWeight: 600, textTransform: "none", letterSpacing: 0 }}>
                      {subStatus === "loading"
                        ? "Extracting..."
                        : subStatus === "error"
                          ? "Failed"
                          : `${subCues.length} lines`}
                    </span>
                  )}
                </div>

                <button
                  className={`pop-option ${!selectedSub ? "selected" : ""}`}
                  onClick={() => {
                    selectSubtitleTrack(null);
                    setActiveMenu(null);
                  }}
                >
                  <span>Off</span>
                  {!selectedSub && <Check size={15} />}
                </button>

                {allSubs.map((s, idx) => {
                  const isSelected =
                    selectedSub &&
                    selectedSub.type === s.type &&
                    (s.type === "external"
                      ? selectedSub.url === s.url
                      : s.type === "local"
                        ? selectedSub.id === s.id
                        : selectedSub.streamIndex === s.streamIndex);
                  return (
                    <button
                      key={idx}
                      className={`pop-option ${isSelected ? "selected" : ""}`}
                      onClick={() => {
                        selectSubtitleTrack(s);
                        setActiveMenu(null);
                      }}
                    >
                      <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{s.label}</span>
                      {isSelected && <Check size={15} />}
                    </button>
                  );
                })}

                <button
                  className="pop-option"
                  style={{ marginTop: 4, color: "var(--sky)" }}
                  onClick={() => fileInputRef.current?.click()}
                >
                  <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                    <Upload size={14} /> Load .SRT / .VTT from device
                  </span>
                </button>

                {selectedSub && (
                  <>
                    <div className="pop-section-title">Subtitle Size</div>
                    <div style={{ display: "flex", gap: 6 }}>
                      {SUB_SIZES.map((sz) => (
                        <button
                          key={sz.id}
                          className={`cat-pill ${subSize === sz.id ? "active" : ""}`}
                          style={{ flex: 1, padding: "5px 0", textAlign: "center", fontSize: 12 }}
                          onClick={() => {
                            setSubSize(sz.id);
                            try {
                              localStorage.setItem("cinevault_sub_size", sz.id);
                            } catch {}
                          }}
                        >
                          {sz.label}
                        </button>
                      ))}
                    </div>

                    <div className="pop-section-title">
                      Timing Sync ({subOffsetSec >= 0 ? `+${subOffsetSec.toFixed(1)}s` : `${subOffsetSec.toFixed(1)}s`})
                    </div>
                    <div style={{ display: "flex", gap: 5 }}>
                      {[-2, -0.5, 0, 0.5, 2].map((delta) => (
                        <button
                          key={delta}
                          className="cat-pill"
                          style={{ flex: 1, padding: "5px 0", textAlign: "center", fontSize: 11.5 }}
                          onClick={() =>
                            setSubOffsetSec((prev) => (delta === 0 ? 0 : +(prev + delta).toFixed(1)))
                          }
                        >
                          {delta === 0 ? "Reset" : delta > 0 ? `+${delta}s` : `${delta}s`}
                        </button>
                      ))}
                    </div>
                  </>
                )}
              </>
            )}

            {activeMenu === "settings" && (
              <>
                {qualityOptions.length > 1 && onSwitchQualityOption && (
                  <>
                    <div className="pop-section-title">Server &amp; Quality Source</div>
                    {qualityOptions.map((opt, idx) => {
                      const active = opt.file.url === file.url;
                      return (
                        <button
                          key={`${opt.editionId}-${idx}`}
                          className={`pop-option ${active ? "selected" : ""}`}
                          onClick={() => {
                            setActiveMenu(null);
                            if (!active) {
                              saveProgress(currentTime, duration);
                              onSwitchQualityOption(opt, Math.floor(currentTime));
                            }
                          }}
                        >
                          <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>
                            {opt.label}
                          </span>
                          {active && <Check size={15} />}
                        </button>
                      );
                    })}
                  </>
                )}

                <div className="pop-section-title">Playback Engine</div>
                {[
                  { id: "transcode", label: "Universal H.264 (Best Compatibility)" },
                  { id: "remux", label: "Fast Remux (0% Video CPU + AAC Audio)" },
                  { id: "direct", label: "Direct Play (Raw Server Proxy)" },
                ].map((opt) => (
                  <button
                    key={opt.id}
                    className={`pop-option ${mode === opt.id ? "selected" : ""}`}
                    onClick={() => switchStreamSetting(() => setMode(opt.id))}
                  >
                    <span>{opt.label}</span>
                    {mode === opt.id && <Check size={15} />}
                  </button>
                ))}

                {mode === "transcode" && (
                  <>
                    <div className="pop-section-title">Stream Quality</div>
                    {[
                      { id: "original", label: "Original Resolution" },
                      { id: "1080", label: "1080p Full HD" },
                      { id: "720", label: "720p HD (Lighter CPU)" },
                      { id: "480", label: "480p SD (Mobile / Fast)" },
                    ].map((q) => (
                      <button
                        key={q.id}
                        className={`pop-option ${quality === q.id ? "selected" : ""}`}
                        onClick={() => switchStreamSetting(() => setQuality(q.id))}
                      >
                        <span>{q.label}</span>
                        {quality === q.id && <Check size={15} />}
                      </button>
                    ))}
                  </>
                )}
              </>
            )}
          </div>
        )}

        {/* Bottom Controls */}
        <div className="player-bottom-bar" onClick={(e) => e.stopPropagation()}>
          <div
            className="seek-bar-container"
            onClick={(e) => {
              const rect = e.currentTarget.getBoundingClientRect();
              const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
              if (duration > 0) seekTo(ratio * duration);
            }}
          >
            <div className="seek-track">
              <div className="seek-fill" style={{ width: `${pct}%` }} />
            </div>
          </div>

          <div className="controls-row">
            <div className="controls-group">
              <button className="p-btn" onClick={togglePlay} aria-label={playing ? "Pause" : "Play"}>
                {playing ? <Pause size={21} fill="currentColor" /> : <Play size={21} fill="currentColor" />}
              </button>
              <button className="p-btn" onClick={() => seekTo(currentTime - 10)} title="Back 10s (←)">
                <SkipBack size={18} />
              </button>
              <button className="p-btn" onClick={() => seekTo(currentTime + 10)} title="Forward 10s (→)">
                <SkipForward size={18} />
              </button>

              <button
                className="p-btn"
                onClick={() => {
                  const next = !muted;
                  setMuted(next);
                  if (videoRef.current) videoRef.current.muted = next;
                }}
              >
                {muted || volume === 0 ? <VolumeX size={19} /> : <Volume2 size={19} />}
              </button>
              <input
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={muted ? 0 : volume}
                onChange={(e) => {
                  const v = parseFloat(e.target.value);
                  setVolume(v);
                  setMuted(v === 0);
                  if (videoRef.current) {
                    videoRef.current.volume = v;
                    videoRef.current.muted = v === 0;
                  }
                }}
                style={{ width: 76, accentColor: "var(--accent)", cursor: "pointer" }}
              />

              <span className="player-time">
                {formatDuration(currentTime)} / {duration > 0 ? formatDuration(duration) : "--:--"}
              </span>
            </div>

            <div className="controls-group">
              {hasNext && (
                <button
                  className="p-btn"
                  onClick={() => {
                    saveProgress(currentTime, duration);
                    onSwitchEpisode(playlistIndex + 1);
                  }}
                >
                  Next Ep <ChevronRight size={16} />
                </button>
              )}

              <button
                className={`p-btn ${activeMenu === "audio" ? "active" : ""}`}
                onClick={() => setActiveMenu((m) => (m === "audio" ? null : "audio"))}
                title="Switch Audio Track (Dual Audio)"
              >
                <AudioLines size={18} />
                <span>
                  {audioTracks[audioIdx]?.langLabel || "Audio"}
                  {audioTracks.length > 1 ? ` (${audioTracks.length})` : ""}
                </span>
              </button>

              <button
                className={`p-btn ${activeMenu === "subs" || selectedSub ? "active" : ""}`}
                onClick={() => setActiveMenu((m) => (m === "subs" ? null : "subs"))}
                title="Subtitles (C)"
              >
                <Subtitles size={18} />
                <span>
                  {selectedSub
                    ? subStatus === "loading"
                      ? "CC…"
                      : "CC On"
                    : allSubs.length > 0
                      ? `CC (${allSubs.length})`
                      : "CC"}
                </span>
              </button>

              <button
                className={`p-btn ${activeMenu === "settings" ? "active" : ""}`}
                onClick={() => setActiveMenu((m) => (m === "settings" ? null : "settings"))}
                title="Engine & Quality"
              >
                <Settings size={18} />
              </button>

              <button className="p-btn" onClick={toggleFullscreen} title="Fullscreen (F)">
                {isFullscreen ? <Minimize size={18} /> : <Maximize size={18} />}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
