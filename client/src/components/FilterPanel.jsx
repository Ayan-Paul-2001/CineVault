import React, { useState, memo } from "react";
import { SlidersHorizontal, ChevronDown, ChevronUp, RotateCcw, X } from "lucide-react";

const QUALITY_OPTIONS = [
  { value: "4K", label: "4K Ultra HD" },
  { value: "1080p", label: "1080p Full HD" },
  { value: "720p", label: "720p HD" },
  { value: "3D", label: "3D Movies" },
];

const AUDIO_OPTIONS = [
  { value: "dual", label: "Dual Audio" },
  { value: "multi", label: "Multi Audio" },
  { value: "hindi-dubbed", label: "Hindi Dubbed" },
];

const SERVER_OPTIONS = [
  { value: "icc", label: "ICC FTP Primary" },
  { value: "dhakaflix", label: "DhakaFlix Primary" },
  { value: "circleftp", label: "CircleFTP Primary" },
  { value: "discoveryftp", label: "DiscoveryFTP Primary" },
];

const FilterPanel = memo(function FilterPanel({
  tab,
  categories,
  years,
  languages,
  facets = null,
  filters,
  onChangeFilters,
  onReset,
}) {
  const [expanded, setExpanded] = useState(() =>
    typeof window !== "undefined" ? window.innerWidth > 768 : true
  );

  const activeCategoryObj = categories.find((c) => c.id === filters.category);

  // Build removable active filter chips for quick visibility
  const activeChips = [];
  if (filters.category) {
    activeChips.push({
      key: "category",
      label: activeCategoryObj ? activeCategoryObj.shortLabel : filters.category,
      clear: () => onChangeFilters({ category: "", page: 1 }),
    });
  }
  if (filters.year) {
    activeChips.push({
      key: "year",
      label: `Year: ${filters.year}`,
      clear: () => onChangeFilters({ year: "", page: 1 }),
    });
  }
  if (filters.quality) {
    activeChips.push({
      key: "quality",
      label: filters.quality === "4K" ? "4K UHD" : filters.quality,
      clear: () => onChangeFilters({ quality: "", page: 1 }),
    });
  }
  if (filters.audio) {
    const audioLabels = { dual: "Dual Audio", multi: "Multi Audio", "hindi-dubbed": "Hindi Dubbed" };
    activeChips.push({
      key: "audio",
      label: audioLabels[filters.audio] || filters.audio,
      clear: () => onChangeFilters({ audio: "", page: 1 }),
    });
  }
  if (filters.language) {
    activeChips.push({
      key: "language",
      label: filters.language,
      clear: () => onChangeFilters({ language: "", page: 1 }),
    });
  }
  if (filters.source) {
    const srcLabels = {
      icc: "ICC FTP",
      dhakaflix: "DhakaFlix",
      circleftp: "CircleFTP",
      discoveryftp: "DiscoveryFTP",
    };
    activeChips.push({
      key: "source",
      label: srcLabels[filters.source] || filters.source,
      clear: () => onChangeFilters({ source: "", page: 1 }),
    });
  }

  return (
    <section className="filter-panel" aria-label="Library Filters">
      {/* Header Row */}
      <div className="filter-panel-head">
        <div className="filter-head-left">
          <div className="filter-title">
            <SlidersHorizontal size={16} color="var(--accent)" />
            <span>Filters</span>
            {activeChips.length > 0 && (
              <span className="filter-count-badge">{activeChips.length}</span>
            )}
          </div>

          {activeChips.length > 0 && (
            <div className="active-chip-row">
              {activeChips.map((chip) => (
                <button
                  key={chip.key}
                  className="active-chip"
                  onClick={chip.clear}
                  title={`Remove ${chip.label} filter`}
                >
                  <span>{chip.label}</span>
                  <X size={12} />
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="filter-head-right">
          {activeChips.length > 0 && (
            <button className="filter-action-btn" onClick={onReset}>
              <RotateCcw size={13} /> Reset All
            </button>
          )}
          <button
            className="filter-action-btn"
            onClick={() => setExpanded((e) => !e)}
            aria-expanded={expanded}
          >
            {expanded ? (
              <>
                Hide <ChevronUp size={15} />
              </>
            ) : (
              <>
                Show Filters <ChevronDown size={15} />
              </>
            )}
          </button>
        </div>
      </div>

      {/* Collapsible Filter Body */}
      {expanded && (
        <div className="filter-panel-body">
          {/* Sections / Categories moved neatly inside the Filter Panel */}
          <div className="filter-group">
            <div className="filter-group-label">Section</div>
            <div className="filter-section-chips">
              <button
                className={`cat-pill ${!filters.category ? "active" : ""}`}
                onClick={() =>
                  onChangeFilters({
                    category: "",
                    sort: filters.sort === "imdb" ? (tab === "search" ? "relevance" : "recent") : filters.sort,
                    page: 1,
                  })
                }
              >
                {tab === "movies"
                  ? "All Movies"
                  : tab === "series"
                    ? "All Series"
                    : "All Sections"}
                {tab === "search" && facets && (
                  <span className="pill-count">
                    ({facets.totalUnfiltered.toLocaleString()}
                    {facets.capped ? "+" : ""})
                  </span>
                )}
              </button>
              {categories.map((c) => (
                <button
                  key={c.id}
                  className={`cat-pill ${filters.category === c.id ? "active" : ""}`}
                  onClick={() =>
                    onChangeFilters({
                      category: c.id,
                      sort:
                        c.id === "imdb-top-250"
                          ? "imdb"
                          : filters.sort === "imdb"
                            ? tab === "search"
                              ? "relevance"
                              : "recent"
                            : filters.sort,
                      page: 1,
                    })
                  }
                >
                  {c.shortLabel}
                  {c.count > 0 && (
                    <span className="pill-count">({c.count.toLocaleString()})</span>
                  )}
                </button>
              ))}
            </div>
          </div>

          <div className="filter-divider" />

          {/* Structured Filter Controls Grid */}
          <div className="filter-controls-grid">
            <label className="filter-field">
              <span className="filter-field-label">Year</span>
              <select
                className="filter-select"
                value={filters.year}
                onChange={(e) => onChangeFilters({ year: e.target.value, page: 1 })}
              >
                <option value="">All Years</option>
                {years.map((y) => {
                  const yc = facets?.yearCounts?.[y];
                  return (
                    <option key={y} value={y}>
                      {yc != null ? `${y} (${yc.toLocaleString()})` : y}
                    </option>
                  );
                })}
              </select>
            </label>

            <label className="filter-field">
              <span className="filter-field-label">Quality</span>
              <select
                className="filter-select"
                value={filters.quality}
                onChange={(e) => onChangeFilters({ quality: e.target.value, page: 1 })}
              >
                <option value="">All Quality</option>
                {QUALITY_OPTIONS.filter(
                  (o) => !facets || (facets.qualities?.[o.value] || 0) > 0 || filters.quality === o.value
                ).map((o) => {
                  const cnt = facets?.qualities?.[o.value];
                  return (
                    <option key={o.value} value={o.value}>
                      {cnt != null ? `${o.label} (${cnt.toLocaleString()})` : o.label}
                    </option>
                  );
                })}
              </select>
            </label>

            <label className="filter-field">
              <span className="filter-field-label">Audio</span>
              <select
                className="filter-select"
                value={filters.audio}
                onChange={(e) => onChangeFilters({ audio: e.target.value, page: 1 })}
              >
                <option value="">All Audio</option>
                {AUDIO_OPTIONS.filter(
                  (o) => !facets || (facets.audios?.[o.value] || 0) > 0 || filters.audio === o.value
                ).map((o) => {
                  const cnt = facets?.audios?.[o.value];
                  return (
                    <option key={o.value} value={o.value}>
                      {cnt != null ? `${o.label} (${cnt.toLocaleString()})` : o.label}
                    </option>
                  );
                })}
              </select>
            </label>

            <label className="filter-field">
              <span className="filter-field-label">Language</span>
              <select
                className="filter-select"
                value={filters.language}
                onChange={(e) => onChangeFilters({ language: e.target.value, page: 1 })}
              >
                <option value="">All Languages</option>
                {(languages || []).map((l) => (
                  <option key={l.lang} value={l.lang}>
                    {l.lang} ({l.count.toLocaleString()})
                  </option>
                ))}
              </select>
            </label>

            <label className="filter-field">
              <span className="filter-field-label">Server</span>
              <select
                className="filter-select"
                value={filters.source}
                onChange={(e) => onChangeFilters({ source: e.target.value, page: 1 })}
              >
                <option value="">All Servers (Merged)</option>
                {SERVER_OPTIONS.filter(
                  (o) => !facets || (facets.sources?.[o.value] || 0) > 0 || filters.source === o.value
                ).map((o) => {
                  const cnt = facets?.sources?.[o.value];
                  return (
                    <option key={o.value} value={o.value}>
                      {cnt != null ? `${o.label} (${cnt.toLocaleString()})` : o.label}
                    </option>
                  );
                })}
              </select>
            </label>

            <label className="filter-field">
              <span className="filter-field-label">Sort By</span>
              <select
                className="filter-select"
                value={filters.sort}
                onChange={(e) => onChangeFilters({ sort: e.target.value, page: 1 })}
              >
                {tab === "search" && <option value="relevance">Best Match</option>}
                <option value="recent">Recently Added</option>
                <option value="quality">Highest Quality First</option>
                <option value="year">Release Year (Newest)</option>
                <option value="title">Title (A → Z)</option>
                <option value="imdb">IMDb Top 250 Rank</option>
                <option value="oldest">Oldest First</option>
              </select>
            </label>
          </div>
        </div>
      )}
    </section>
  );
});

export default FilterPanel;
