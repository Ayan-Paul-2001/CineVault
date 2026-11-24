import React, { useEffect, useState, useMemo } from "react";
import {
  X,
  Play,
  Download,
  ExternalLink,
  Plus,
  Check,
  RefreshCw,
  Film,
  Tv,
  Star,
  Clock,
  Server,
  ListVideo,
  Subtitles,
  Layers,
} from "lucide-react";
import {
  apiGet,
  buildDownloadUrl,
  buildM3uUrl,
  formatBytes,
  formatDuration,
} from "../api.js";

function buildQualityOptionsFromEditions(editions) {
  const opts = [];
  for (const ed of editions || []) {
    if (!ed.hasPlayable || !ed.files?.length) continue;
    for (const f of ed.files) {
      const fq = f.quality || ed.quality;
      opts.push({
        editionId: ed.id,
        quality: fq,
        serverLabel: ed.serverLabel,
        audioTags: ed.audioTags,
        file: f,
        subtitles: ed.subtitles || [],
        label: `${fq} · ${ed.serverLabel}${ed.audioTags ? ` · ${ed.audioTags}` : ""}${f.size ? ` (${formatBytes(f.size)})` : ""}`,
      });
    }
  }
  return opts;
}

function seasonServerLabel(source) {
  if (source === "icc") return "ICC FTP";
  if (source === "circleftp") return "CircleFTP";
  if (source === "discoveryftp") return "DiscoveryFTP";
  return "DhakaFlix";
}

function findPrimaryPlayable(d) {
  const hist = d.history?.[0];
  const editions = d.editions || [];
  const qualityOptions = buildQualityOptionsFromEditions(editions);

  if (hist) {
    for (const s of d.seasons || []) {
      const idx = (s.episodes || []).findIndex((e) => e.url === hist.file_url);
      if (idx >= 0) {
        return {
          item: d.item,
          file: s.episodes[idx],
          externalSubtitles: s.subtitles || [],
          seasonName: s.name,
          playlist: s.episodes,
          playlistIndex: idx,
          qualityLabel: d.item.quality || "HD",
          serverLabel: seasonServerLabel(s.source),
          startTime: hist.completed ? 0 : hist.position,
        };
      }
    }
    const qMatch = qualityOptions.find((o) => o.file.url === hist.file_url);
    if (qMatch) {
      return {
        item: d.item,
        file: qMatch.file,
        externalSubtitles: qMatch.subtitles,
        qualityLabel: qMatch.quality,
        serverLabel: qMatch.serverLabel,
        qualityOptions,
        startTime: hist.completed ? 0 : hist.position,
      };
    }
  }

  if (qualityOptions.length > 0) {
    const best = qualityOptions[0];
    return {
      item: d.item,
      file: best.file,
      externalSubtitles: best.subtitles,
      qualityLabel: best.quality,
      serverLabel: best.serverLabel,
      qualityOptions,
      startTime: 0,
    };
  }

  const firstSeasonWithEps = (d.seasons || []).find((s) => (s.episodes || []).length > 0);
  if (firstSeasonWithEps) {
    return {
      item: d.item,
      file: firstSeasonWithEps.episodes[0],
      externalSubtitles: firstSeasonWithEps.subtitles || [],
      seasonName: firstSeasonWithEps.name,
      playlist: firstSeasonWithEps.episodes,
      playlistIndex: 0,
      qualityLabel: d.item.quality || "HD",
      serverLabel: seasonServerLabel(firstSeasonWithEps.source),
      startTime: 0,
    };
  }

  return null;
}

function qualityBadgeClass(q) {
  const u = (q || "").toUpperCase();
  if (u === "4K" || u === "2160P") return "q-badge q-4k";
  if (u === "1080P") return "q-badge q-1080";
  if (u === "3D") return "q-badge q-3d";
  if (u === "720P") return "q-badge q-720";
  return "q-badge";
}

export default function DetailModal({
  itemId,
  initialPlay = false,
  onClose,
  onPlayFile,
  onRequestDownload,
  onToggleWatchlist,
  onNotify,
}) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [qualityFilter, setQualityFilter] = useState("ALL");
  const [selectedSeriesEdition, setSelectedSeriesEdition] = useState("unified");
  const [selectedSeason, setSelectedSeason] = useState(0);

  const load = async (refresh = false) => {
    setLoading(true);
    setError(null);
    try {
      const res = await apiGet(`/api/item/${itemId}${refresh ? "?refresh=1" : ""}`);
      setData(res);
      setQualityFilter("ALL");
      setSelectedSeriesEdition("unified");
      setSelectedSeason(0);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load(false);
  }, [itemId]);

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  useEffect(() => {
    if (!initialPlay || !data) return;
    const primary = findPrimaryPlayable(data);
    if (primary) onPlayFile(primary);
  }, [initialPlay, data]);

  const item = data?.item;
  const meta = data?.meta || {};
  const editions = data?.editions || [];
  const unifiedSeasons = data?.seasons || [];
  const historyMap = new Map((data?.history || []).map((h) => [h.file_url, h]));

  const qualityOptions = useMemo(() => buildQualityOptionsFromEditions(editions), [editions]);
  const primaryPlayable = useMemo(() => (data ? findPrimaryPlayable(data) : null), [data]);

  // Movie file editions across ALL servers (sorted highest quality first!)
  const movieEditions = useMemo(
    () => editions.filter((ed) => (ed.files || []).length > 0),
    [editions]
  );

  // Distinct available qualities for filter pills ("4K", "1080p", "720p", "3D", etc.)
  const availableQualities = useMemo(() => {
    const set = new Set();
    for (const ed of movieEditions) {
      for (const f of ed.files || []) {
        const fq = f.quality || ed.quality;
        if (fq) set.add(fq);
      }
    }
    return [...set];
  }, [movieEditions]);

  const filteredMovieEditions = useMemo(() => {
    if (qualityFilter === "ALL") return movieEditions;
    return movieEditions
      .map((ed) => ({
        ...ed,
        files: (ed.files || []).filter((f) => (f.quality || ed.quality) === qualityFilter),
      }))
      .filter((ed) => ed.files.length > 0);
  }, [movieEditions, qualityFilter]);

  // Series editions that have seasons
  const seriesEditions = useMemo(
    () => editions.filter((ed) => (ed.seasons || []).length > 0),
    [editions]
  );

  const displayedSeasons = useMemo(() => {
    if (selectedSeriesEdition === "unified") return unifiedSeasons;
    const match = seriesEditions.find((e) => String(e.id) === String(selectedSeriesEdition));
    return match ? match.seasons : unifiedSeasons;
  }, [selectedSeriesEdition, seriesEditions, unifiedSeasons]);

  const activeSeason = displayedSeasons[selectedSeason] || displayedSeasons[0] || null;

  const handleToggleWl = async () => {
    if (!item) return;
    const res = await onToggleWatchlist(item.id);
    if (res) {
      setData((prev) =>
        prev ? { ...prev, item: { ...prev.item, in_watchlist: res.inWatchlist ? 1 : 0 } } : prev
      );
    }
  };

  return (
    <div
      className="modal-backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="detail-modal">
        <button className="detail-close" onClick={onClose} aria-label="Close details">
          <X size={20} />
        </button>

        {loading && !data ? (
          <div style={{ padding: 56, textAlign: "center", color: "var(--text-muted)" }}>
            <RefreshCw size={28} className="spin" style={{ marginBottom: 12 }} />
            <div>Loading all available qualities across all servers...</div>
          </div>
        ) : error ? (
          <div style={{ padding: 56, textAlign: "center" }}>
            <p style={{ color: "#fca5a5", marginBottom: 16 }}>Failed to load details: {error}</p>
            <button className="btn btn-glass btn-sm" onClick={() => load(true)}>
              Retry
            </button>
          </div>
        ) : (
          <div className="detail-scroll">
            <div className="detail-hero">
              <div
                className="detail-hero-bg"
                style={{ backgroundImage: `url(/api/poster/${item.id})` }}
              />
              <div className="detail-hero-content">
                <div className="detail-poster">
                  <img src={`/api/poster/${item.id}`} alt={item.title} />
                </div>

                <div className="detail-info">
                  <h2 className="detail-title">{item.title}</h2>

                  <div className="hero-badges">
                    {item.imdb_rank && (
                      <span className="badge badge-gold">
                        <Star size={12} fill="currentColor" /> IMDb Top 250 #{item.imdb_rank}
                      </span>
                    )}
                    {meta.rating && (
                      <span className="badge badge-gold">
                        <Star size={12} fill="currentColor" /> {meta.rating}/10
                      </span>
                    )}
                    {item.year && <span className="badge">{item.year}</span>}
                    {availableQualities.length > 0 ? (
                      availableQualities.map((q) => (
                        <span
                          key={q}
                          className={`badge ${q === "4K" ? "badge-gold" : q === "1080p" ? "badge-hd" : "badge-sky"}`}
                        >
                          {q}
                        </span>
                      ))
                    ) : (
                      item.quality && (
                        <span className={`badge ${item.quality === "4K" ? "badge-gold" : "badge-hd"}`}>
                          {item.quality}
                        </span>
                      )
                    )}
                    {editions.length > 1 && (
                      <span className="badge">
                        <Server size={11} /> {editions.length} Server Sources
                      </span>
                    )}
                    {meta.runtime && (
                      <span className="badge">
                        <Clock size={12} /> {meta.runtime}m
                      </span>
                    )}
                  </div>

                  {meta.genres?.length > 0 && (
                    <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 10 }}>
                      {meta.genres.map((g) => (
                        <span
                          key={g}
                          style={{
                            fontSize: 12,
                            color: "var(--text-muted)",
                            background: "rgba(255,255,255,0.06)",
                            padding: "2px 9px",
                            borderRadius: 99,
                          }}
                        >
                          {g}
                        </span>
                      ))}
                    </div>
                  )}

                  {meta.overview && <p className="detail-overview">{meta.overview}</p>}

                  {meta.director && (
                    <div className="detail-cast" style={{ marginBottom: 6 }}>
                      <strong>Director:</strong> {meta.director}
                    </div>
                  )}

                  {meta.cast && (
                    <div className="detail-cast">
                      <strong>Starring:</strong> {meta.cast}
                    </div>
                  )}

                  <div className="hero-actions" style={{ marginTop: 14 }}>
                    {primaryPlayable && (
                      <button
                        className="btn btn-primary"
                        onClick={() => onPlayFile(primaryPlayable)}
                      >
                        <Play size={17} fill="currentColor" />
                        {primaryPlayable.startTime > 10
                          ? `Resume (${formatDuration(primaryPlayable.startTime)})`
                          : `Play Best (${primaryPlayable.qualityLabel || "HD"})`}
                      </button>
                    )}

                    <button className="btn btn-glass btn-sm" onClick={handleToggleWl}>
                      {item.in_watchlist ? <Check size={16} /> : <Plus size={16} />}
                      {item.in_watchlist ? "In My List" : "My List"}
                    </button>

                    <a
                      className="btn btn-glass btn-sm"
                      href={buildM3uUrl({ id: item.id, title: item.title })}
                      title="Open playlist in VLC, PotPlayer, or MPV at full raw speed"
                    >
                      <ListVideo size={16} /> VLC
                    </a>

                    {meta.trailerUrl && (
                      <a
                        className="btn btn-glass btn-sm"
                        href={meta.trailerUrl}
                        target="_blank"
                        rel="noreferrer"
                      >
                        <ExternalLink size={15} /> Trailer
                      </a>
                    )}

                    {meta.imdbId && (
                      <a
                        className="btn btn-glass btn-sm"
                        href={`https://www.imdb.com/title/${meta.imdbId}/`}
                        target="_blank"
                        rel="noreferrer"
                      >
                        <ExternalLink size={15} /> IMDb
                      </a>
                    )}

                    <button
                      className="icon-btn"
                      title="Refresh all server qualities"
                      onClick={() => load(true)}
                    >
                      <RefreshCw size={15} className={loading ? "spin" : ""} />
                    </button>
                  </div>
                </div>
              </div>
            </div>

            <div className="detail-body">
              {/* ALL AVAILABLE QUALITIES ACROSS ALL SERVERS (MOVIES & DIRECT FILES) */}
              {movieEditions.length > 0 && (
                <div style={{ marginBottom: 26 }}>
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      flexWrap: "wrap",
                      gap: 10,
                      marginBottom: 14,
                    }}
                  >
                    <div className="sub-heading" style={{ marginBottom: 0 }}>
                      <Layers size={17} color="var(--gold)" />
                      Available Qualities Across Servers ({movieEditions.length})
                    </div>

                    {availableQualities.length > 1 && (
                      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                        <button
                          className={`cat-pill ${qualityFilter === "ALL" ? "active" : ""}`}
                          style={{ padding: "4px 11px", fontSize: 12 }}
                          onClick={() => setQualityFilter("ALL")}
                        >
                          All ({movieEditions.length})
                        </button>
                        {availableQualities.map((q) => (
                          <button
                            key={q}
                            className={`cat-pill ${qualityFilter === q ? "active" : ""}`}
                            style={{ padding: "4px 11px", fontSize: 12 }}
                            onClick={() => setQualityFilter(q)}
                          >
                            {q}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>

                  <div className="file-list">
                    {filteredMovieEditions.map((ed) =>
                      ed.files.map((f, idx) => {
                        const fq = f.quality || ed.quality;
                        const hist = historyMap.get(f.url);
                        const isOffline = f.online === false;
                        return (
                          <div
                            className={`file-row quality-row ${ed.isPrimary && idx === 0 ? "is-best" : ""}`}
                            key={`${ed.id}-${f.url}`}
                          >
                            <div
                              className="file-row-main"
                              onClick={() =>
                                onPlayFile({
                                  item,
                                  file: f,
                                  externalSubtitles: ed.subtitles || [],
                                  qualityLabel: fq,
                                  serverLabel: ed.serverLabel,
                                  qualityOptions,
                                  startTime: hist && !hist.completed ? hist.position : 0,
                                })
                              }
                            >
                              <div className={qualityBadgeClass(fq)}>
                                {fq}
                              </div>

                              <div className="file-row-text">
                                <div
                                  style={{
                                    display: "flex",
                                    alignItems: "center",
                                    gap: 7,
                                    flexWrap: "wrap",
                                    marginBottom: 3,
                                  }}
                                >
                                  <span
                                    className={`server-chip ${ed.source === "icc"
                                      ? "chip-icc"
                                      : ed.source === "circleftp"
                                        ? "chip-circle"
                                        : ed.source === "discoveryftp"
                                          ? "chip-discovery"
                                          : "chip-df"
                                      }`}
                                  >
                                    {ed.serverLabel}
                                  </span>
                                  {ed.audioTags && (
                                    <span className="server-chip chip-audio">{ed.audioTags}</span>
                                  )}
                                  {ed.sourceTag && (
                                    <span className="server-chip">{ed.sourceTag}</span>
                                  )}
                                  {ed.subtitles?.length > 0 && (
                                    <span className="server-chip chip-audio">
                                      <Subtitles size={11} /> External Sub
                                    </span>
                                  )}
                                  {ed.isPrimary && idx === 0 && (
                                    <span className="server-chip chip-best">Highest Quality</span>
                                  )}
                                  {isOffline && (
                                    <span className="server-chip chip-offline">Mirror Offline</span>
                                  )}
                                </div>

                                <div className="file-row-title" title={f.name}>
                                  {f.name}
                                </div>

                                <div className="file-row-sub">
                                  {f.size > 0 ? formatBytes(f.size) : "Stream ready"}
                                  {hist && hist.position > 5 && (
                                    <span style={{ color: "var(--sky)", marginLeft: 10 }}>
                                      •{" "}
                                      {hist.completed
                                        ? "Watched"
                                        : `Resume at ${formatDuration(hist.position)}`}
                                    </span>
                                  )}
                                </div>
                              </div>
                            </div>

                            <div className="file-row-actions">
                              <button
                                className="btn btn-primary btn-sm"
                                style={{ height: 34, padding: "0 12px" }}
                                onClick={() =>
                                  onPlayFile({
                                    item,
                                    file: f,
                                    externalSubtitles: ed.subtitles || [],
                                    qualityLabel: fq,
                                    serverLabel: ed.serverLabel,
                                    qualityOptions,
                                    startTime: hist && !hist.completed ? hist.position : 0,
                                  })
                                }
                              >
                                <Play size={14} fill="currentColor" /> Play
                              </button>
                              <button
                                className="icon-btn"
                                onClick={() =>
                                  onRequestDownload
                                    ? onRequestDownload({
                                      title: item.title,
                                      fileName: f.name,
                                      url: f.url,
                                      size: f.size || 0,
                                      quality: fq,
                                      serverLabel: ed.serverLabel,
                                    })
                                    : (window.location.href = buildDownloadUrl(f.url))
                                }
                                title={`Download ${fq} from ${ed.serverLabel} inside CineVault`}
                              >
                                <Download size={16} />
                              </button>
                              <a
                                className="icon-btn"
                                href={buildM3uUrl({
                                  url: f.url,
                                  title: `${item.title} [${fq} - ${ed.serverLabel}]`,
                                })}
                                title={`Open ${fq} in VLC / PotPlayer`}
                              >
                                <ListVideo size={16} />
                              </a>
                            </div>
                          </div>
                        );
                      })
                    )}
                  </div>
                </div>
              )}

              {/* TV SERIES: SERVER/QUALITY SWITCHER + SEASONS & EPISODES */}
              {displayedSeasons.length > 0 && (
                <div style={{ marginBottom: 24 }}>
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      flexWrap: "wrap",
                      gap: 10,
                      marginBottom: 12,
                    }}
                  >
                    <div className="sub-heading" style={{ marginBottom: 0 }}>
                      <Tv size={17} color="var(--accent)" />
                      Seasons &amp; Episodes ({displayedSeasons.length} Season
                      {displayedSeasons.length > 1 ? "s" : ""})
                    </div>

                    {seriesEditions.length > 1 && (
                      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                        <button
                          className={`cat-pill ${selectedSeriesEdition === "unified" ? "active" : ""}`}
                          style={{ padding: "4px 11px", fontSize: 12 }}
                          onClick={() => {
                            setSelectedSeriesEdition("unified");
                            setSelectedSeason(0);
                          }}
                        >
                          All Merged Seasons
                        </button>
                        {seriesEditions.map((ed) => (
                          <button
                            key={ed.id}
                            className={`cat-pill ${String(selectedSeriesEdition) === String(ed.id) ? "active" : ""}`}
                            style={{ padding: "4px 11px", fontSize: 12 }}
                            onClick={() => {
                              setSelectedSeriesEdition(String(ed.id));
                              setSelectedSeason(0);
                            }}
                          >
                            {ed.quality} · {ed.serverLabel}
                            {ed.audioTags ? ` · ${ed.audioTags}` : ""}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>

                  <div className="season-tabs">
                    {displayedSeasons.map((s, idx) => (
                      <button
                        key={`${s.url}-${idx}`}
                        className={`cat-pill ${idx === selectedSeason ? "active" : ""}`}
                        onClick={() => setSelectedSeason(idx)}
                      >
                        {s.name} ({s.episodes?.length || 0})
                      </button>
                    ))}
                  </div>

                  {activeSeason && (
                    <div className="file-list">
                      {(activeSeason.episodes || []).length === 0 ? (
                        <div style={{ color: "var(--text-muted)", fontSize: 13.5, padding: 12 }}>
                          No direct video files inside this folder.{" "}
                          <a
                            href={activeSeason.url}
                            target="_blank"
                            rel="noreferrer"
                            style={{ color: "var(--sky)", textDecoration: "underline" }}
                          >
                            Open raw server folder
                          </a>
                        </div>
                      ) : (
                        activeSeason.episodes.map((ep, idx) => {
                          const hist = historyMap.get(ep.url);
                          const epServer = seasonServerLabel(activeSeason.source);
                          return (
                            <div className="file-row" key={ep.url}>
                              <div
                                className="file-row-main"
                                onClick={() =>
                                  onPlayFile({
                                    item,
                                    file: ep,
                                    externalSubtitles: activeSeason.subtitles || [],
                                    seasonName: activeSeason.name,
                                    playlist: activeSeason.episodes,
                                    playlistIndex: idx,
                                    qualityLabel: item.quality || "HD",
                                    serverLabel: epServer,
                                    startTime: hist && !hist.completed ? hist.position : 0,
                                  })
                                }
                              >
                                <div className="ep-badge">{ep.label}</div>
                                <div className="file-row-text">
                                  <div className="file-row-title" title={ep.name}>
                                    {ep.episodeTitle || ep.name}
                                  </div>
                                  <div className="file-row-sub">
                                    <span>{epServer}</span>
                                    {ep.size > 0 && <span> • {formatBytes(ep.size)}</span>}
                                    {hist && hist.position > 5 && (
                                      <span style={{ color: "var(--sky)", marginLeft: 10 }}>
                                        •{" "}
                                        {hist.completed
                                          ? "Watched"
                                          : `Resume ${formatDuration(hist.position)}`}
                                      </span>
                                    )}
                                  </div>
                                </div>
                              </div>

                              <div className="file-row-actions">
                                <a
                                  className="icon-btn"
                                  href={buildM3uUrl({
                                    url: ep.url,
                                    title: `${item.title} ${ep.label}`,
                                  })}
                                  title="Open in VLC / PotPlayer"
                                >
                                  <ListVideo size={16} />
                                </a>
                                <button
                                  className="icon-btn"
                                  onClick={() =>
                                    onRequestDownload
                                      ? onRequestDownload({
                                        title: item.title,
                                        fileName: ep.name,
                                        url: ep.url,
                                        size: ep.size || 0,
                                        quality: item.quality || "HD",
                                        serverLabel: epServer,
                                        seasonName: activeSeason.name,
                                        episodeLabel: ep.label,
                                      })
                                      : (window.location.href = buildDownloadUrl(ep.url))
                                  }
                                  title={`Download from ${epServer} inside CineVault`}
                                >
                                  <Download size={16} />
                                </button>
                              </div>
                            </div>
                          );
                        })
                      )}
                    </div>
                  )}
                </div>
              )}

              {movieEditions.length === 0 && displayedSeasons.length === 0 && (
                <div className="empty-state" style={{ padding: 32 }}>
                  <Film size={28} style={{ marginBottom: 8, opacity: 0.5 }} />
                  <div>No playable files returned by the upstream server right now.</div>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
