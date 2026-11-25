import React, { useEffect, useState, memo } from "react";
import { Play, Info, Sparkles, Plus, Check } from "lucide-react";
import { CATEGORY_LABELS } from "../api.js";

const HeroSpotlight = memo(function HeroSpotlight({ items, onSelect, onToggleWatchlist }) {
  const [index, setIndex] = useState(0);

  useEffect(() => {
    if (!items || items.length <= 1) return;
    const t = setInterval(() => {
      setIndex((prev) => (prev + 1) % items.length);
    }, 8500);
    return () => clearInterval(t);
  }, [items?.length]);

  if (!items || items.length === 0) return null;
  const active = items[index % items.length];
  const posterUrl = `/api/poster/${active.id}`;

  return (
    <section className="hero">
      <div className="hero-bg" style={{ backgroundImage: `url(${posterUrl})` }} />
      <div className="hero-vignette" />

      <div className="hero-inner">
        <div className="hero-info">
          <div className="hero-kicker">
            <Sparkles size={14} />
            {active.imdb_rank
              ? `IMDb Top 250 • Rank #${active.imdb_rank}`
              : `Featured on CineVault • ${CATEGORY_LABELS[active.category] || active.category}`}
          </div>

          <h1 className="hero-title">{active.title}</h1>

          <div className="hero-badges">
            {active.year && <span className="badge">{active.year}</span>}
            {active.quality && <span className="badge badge-hd">{active.quality}</span>}
            {active.audio_tags && <span className="badge badge-sky">{active.audio_tags}</span>}
            {active.source_tag && <span className="badge">{active.source_tag}</span>}
            {active.language_tag && <span className="badge badge-gold">{active.language_tag}</span>}
          </div>

          <p className="hero-desc">
            Stream instantaneously from your merged DhakaFlix, ICC FTP, CircleFTP &amp; DiscoveryFTP
            library in up to 4K UHD with live audio track switching, subtitles, and zero-buffering
            LAN playback.
          </p>

          <div className="hero-actions">
            <button className="btn btn-primary" onClick={() => onSelect(active, null, true)}>
              <Play size={18} fill="currentColor" /> Play Now
            </button>
            <button className="btn btn-glass" onClick={() => onSelect(active)}>
              <Info size={18} /> Details
            </button>
            <button
              className="btn btn-glass hero-wl-btn"
              onClick={() => onToggleWatchlist(active.id)}
              aria-label={active.in_watchlist ? "Remove from My List" : "Add to My List"}
            >
              {active.in_watchlist ? <Check size={18} /> : <Plus size={18} />}
              <span className="hero-wl-text">{active.in_watchlist ? "In List" : "My List"}</span>
            </button>
          </div>
        </div>

        <div className="hero-poster-wrap" onClick={() => onSelect(active)}>
          <img src={posterUrl} alt={active.title} />
        </div>
      </div>

      {items.length > 1 && (
        <div className="hero-dots">
          {items.map((it, idx) => (
            <button
              key={it.id}
              className={`hero-dot ${idx === index % items.length ? "active" : ""}`}
              onClick={() => setIndex(idx)}
              aria-label={`Spotlight ${idx + 1}`}
            />
          ))}
        </div>
      )}
    </section>
  );
});

export default HeroSpotlight;
