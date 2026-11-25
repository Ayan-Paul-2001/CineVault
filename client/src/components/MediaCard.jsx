import React, { memo } from "react";
import { Play, Tv, Film, X } from "lucide-react";
import { CATEGORY_LABELS, formatDuration } from "../api.js";

const MediaCard = memo(function MediaCard({ item, onSelect, onRemove = null, removeTitle = "Remove", progress = null }) {
  const pct =
    progress && progress.duration > 0
      ? Math.min(100, Math.max(3, Math.round((progress.position / progress.duration) * 100)))
      : 0;

  return (
    <div
      className="media-card"
      onClick={() => onSelect(item, progress)}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect(item, progress);
        }
      }}
    >
      <div className="poster-frame">
        <img
          className="poster-img"
          src={`/api/poster/${item.id}`}
          alt={item.title}
          loading="lazy"
          decoding="async"
          fetchPriority="low"
        />

        {onRemove && (
          <button
            className="card-remove-btn"
            title={removeTitle}
            aria-label={removeTitle}
            onClick={(e) => {
              e.stopPropagation();
              onRemove(item, progress);
            }}
          >
            <X size={14} />
          </button>
        )}

        <div className={`poster-top-badges ${onRemove ? "has-remove" : ""}`}>
          <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
            {item.imdb_rank && (
              <span className="pill-tag pill-gold">#{item.imdb_rank}</span>
            )}
            {item.quality && (
              <span
                className={`pill-tag ${item.quality === "4K"
                    ? "pill-gold"
                    : item.quality === "1080p"
                      ? "pill-1080"
                      : ""
                  }`}
              >
                {item.quality}
              </span>
            )}
          </div>
          {item.audio_tags && /Dual|Multi/i.test(item.audio_tags) && (
            <span className="pill-tag pill-dual">
              {/Multi/i.test(item.audio_tags) ? "MULTI" : "DUAL"}
            </span>
          )}
        </div>

        <div className="poster-overlay">
          <div className="poster-play-fab">
            <Play size={20} fill="currentColor" style={{ marginLeft: 2 }} />
          </div>
          {progress && (
            <div style={{ fontSize: 11.5, color: "#e2e8f0", fontWeight: 600 }}>
              {progress.episode_label ? `${progress.episode_label} • ` : ""}
              Resume at {formatDuration(progress.position)}
            </div>
          )}
        </div>

        {pct > 0 && (
          <div className="card-progress-bar">
            <div className="card-progress-fill" style={{ width: `${pct}%` }} />
          </div>
        )}
      </div>

      <div className="card-meta">
        <div className="card-title" title={item.title}>
          {item.title}
        </div>
        <div className="card-sub">
          {item.media_type === "series" ? <Tv size={12} /> : <Film size={12} />}
          <span>{item.year || "—"}</span>
          <span>•</span>
          <span>{CATEGORY_LABELS[item.category] || item.category}</span>
        </div>
      </div>
    </div>
  );
});

export default MediaCard;
