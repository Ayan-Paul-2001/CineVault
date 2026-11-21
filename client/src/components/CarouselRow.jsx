import React, { useRef } from "react";
import { ChevronLeft, ChevronRight, ArrowRight } from "lucide-react";
import MediaCard from "./MediaCard.jsx";

export default function CarouselRow({
  title,
  subtitle,
  items,
  onSelect,
  onRemove = null,
  removeTitle = "Remove",
  headerAction = null,
  onExploreAll,
  isContinueWatching = false,
}) {
  const trackRef = useRef(null);

  if (!items || items.length === 0) return null;

  const scrollBy = (dir) => {
    const el = trackRef.current;
    if (!el) return;
    el.scrollBy({ left: dir * Math.max(el.clientWidth * 0.78, 360), behavior: "smooth" });
  };

  return (
    <section className="section">
      <div className="section-header">
        <div>
          <h2 className="section-title">{title}</h2>
          {subtitle && <div className="section-sub">{subtitle}</div>}
        </div>
        <div className="section-controls">
          {headerAction}
          {onExploreAll && (
            <button className="see-all-btn" onClick={onExploreAll}>
              See all <ArrowRight size={14} />
            </button>
          )}
          <button className="scroll-arrow" onClick={() => scrollBy(-1)} aria-label="Scroll left">
            <ChevronLeft size={18} />
          </button>
          <button className="scroll-arrow" onClick={() => scrollBy(1)} aria-label="Scroll right">
            <ChevronRight size={18} />
          </button>
        </div>
      </div>

      <div className="carousel-track" ref={trackRef}>
        {items.map((entry) => (
          <MediaCard
            key={isContinueWatching ? `cw-${entry.history_id}` : entry.id}
            item={entry}
            progress={isContinueWatching ? entry : null}
            onSelect={onSelect}
            onRemove={onRemove}
            removeTitle={removeTitle}
          />
        ))}
      </div>
    </section>
  );
}
