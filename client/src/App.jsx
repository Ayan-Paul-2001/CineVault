import React, { useEffect, useState, useRef, useCallback } from "react";
import {
  Clapperboard,
  Home,
  Film,
  Tv,
  Bookmark,
  Search,
  X,
  RefreshCw,
  ChevronLeft,
  ChevronRight,
  Sparkles,
  Server,
  Download,
  Play,
  Trash2,
} from "lucide-react";
import { apiGet, apiPost, apiDelete, buildDownloadUrl, formatBytes } from "./api.js";
import HeroSpotlight from "./components/HeroSpotlight.jsx";
import CarouselRow from "./components/CarouselRow.jsx";
import MediaCard from "./components/MediaCard.jsx";
import DetailModal from "./components/DetailModal.jsx";
import VideoPlayer from "./components/VideoPlayer.jsx";
import SyncDrawer from "./components/SyncDrawer.jsx";
import FilterPanel from "./components/FilterPanel.jsx";

export default function App() {
  const [tab, setTab] = useState("home"); // "home" | "movies" | "series" | "mylist" | "search"
  const [homeData, setHomeData] = useState(null);
  const [categories, setCategories] = useState([]);
  const [years, setYears] = useState([]);
  const [languages, setLanguages] = useState([]);
  const [stats, setStats] = useState(null);
  const [sync, setSync] = useState({ running: false, percent: 0, autoSyncEnabled: true });

  // Browse / Search state
  const [searchInput, setSearchInput] = useState("");
  const [filters, setFilters] = useState({
    q: "",
    category: "",
    year: "",
    quality: "",
    audio: "",
    language: "",
    source: "",
    sort: "recent",
    page: 1,
  });
  const [browseResult, setBrowseResult] = useState({ items: [], total: 0, page: 1, totalPages: 1 });
  const [browseLoading, setBrowseLoading] = useState(false);

  // Upstream deep search state
  const [upstreamResults, setUpstreamResults] = useState([]);
  const [upstreamLoading, setUpstreamLoading] = useState(false);

  // My List state
  const [watchlist, setWatchlist] = useState([]);
  const [historyList, setHistoryList] = useState([]);
  const [confirmClear, setConfirmClear] = useState(null); // "history" | "watchlist" | null

  // Overlays
  const [activeDetail, setActiveDetail] = useState(null); // { id, initialPlay }
  const [playerSession, setPlayerSession] = useState(null);
  const [showSyncDrawer, setShowSyncDrawer] = useState(false);
  const [mobileSearchOpen, setMobileSearchOpen] = useState(false);
  const [toasts, setToasts] = useState([]);

  const searchInputRef = useRef(null);
  const mobileSearchInputRef = useRef(null);
  const debounceRef = useRef(null);
  const lastReloadTotalRef = useRef(0);

  const notify = useCallback((text) => {
    const id = Date.now() + Math.random();
    setToasts((prev) => [...prev.slice(-3), { id, text }]);
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 3600);
  }, []);

  const loadHome = useCallback(async () => {
    try {
      const data = await apiGet("/api/home");
      setHomeData(data);
      if (data.stats) setStats(data.stats);
      if (data.sync) setSync(data.sync);
    } catch {}
  }, []);

  const loadCategories = useCallback(async () => {
    try {
      const data = await apiGet("/api/categories");
      setCategories(data.categories || []);
      setYears(data.years || []);
      setLanguages(data.languages || []);
      if (data.stats) setStats(data.stats);
    } catch {}
  }, []);

  const loadMyList = useCallback(async () => {
    try {
      const [wl, hist] = await Promise.all([apiGet("/api/watchlist"), apiGet("/api/history")]);
      setWatchlist(wl.items || []);
      setHistoryList(hist.items || []);
    } catch {}
  }, []);

  // Initial load + Real-time SSE sync stream
  useEffect(() => {
    loadHome();
    loadCategories();

    const es = new EventSource("/api/sync/events");
    const handlePayload = (ev, isDone = false) => {
      try {
        const d = JSON.parse(ev.data);
        if (d.sync) setSync(d.sync);
        if (d.stats) {
          setStats(d.stats);
          // Refresh Home smoothly as initial titles stream in during cold-start sync
          if (
            d.stats.total > 0 &&
            (lastReloadTotalRef.current === 0 ||
              d.stats.total - lastReloadTotalRef.current >= 500 ||
              isDone)
          ) {
            lastReloadTotalRef.current = d.stats.total;
            loadHome();
            loadCategories();
          }
        }
        if (isDone && d.sync?.newlyAddedCount > 0) {
          notify(`Synced ${d.sync.newlyAddedCount.toLocaleString()} new titles across all servers!`);
        }
      } catch {}
    };

    es.addEventListener("status", (e) => handlePayload(e, false));
    es.addEventListener("progress", (e) => handlePayload(e, false));
    es.addEventListener("done", (e) => handlePayload(e, true));

    return () => es.close();
  }, [loadHome, loadCategories, notify]);

  // Global "/" or Ctrl+K shortcut to focus Search
  useEffect(() => {
    const onKey = (e) => {
      if (playerSession) return;
      if ((e.key === "/" && e.target.tagName !== "INPUT") || ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k")) {
        e.preventDefault();
        searchInputRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [playerSession]);

  // Fetch Browse / Search grid whenever tab or filters change
  useEffect(() => {
    if (tab !== "movies" && tab !== "series" && tab !== "search") return;
    let cancelled = false;
    setBrowseLoading(true);

    const p = new URLSearchParams();
    if (filters.q) p.set("q", filters.q);
    if (filters.category) p.set("category", filters.category);
    else if (tab === "movies") p.set("group", "movies");
    else if (tab === "series") p.set("group", "series");
    if (filters.year) p.set("year", filters.year);
    if (filters.quality) p.set("quality", filters.quality);
    if (filters.audio) p.set("audio", filters.audio);
    if (filters.language) p.set("language", filters.language);
    if (filters.source) p.set("source", filters.source);
    p.set("sort", filters.sort);
    p.set("page", String(filters.page));
    p.set("limit", "60");

    apiGet(`/api/items?${p.toString()}`)
      .then((res) => {
        if (!cancelled) setBrowseResult(res);
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setBrowseLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [tab, filters]);

  // Load My List when opened
  useEffect(() => {
    if (tab === "mylist") loadMyList();
  }, [tab, loadMyList]);

  // Search typing with debounce
  const handleSearchChange = (val) => {
    setSearchInput(val);
    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      const q = val.trim();
      setUpstreamResults([]);
      if (q.length > 0) {
        setTab("search");
        setFilters((prev) => ({ ...prev, q, category: "", page: 1, sort: "relevance" }));
      } else if (tab === "search") {
        setTab("home");
        setFilters((prev) => ({ ...prev, q: "", page: 1, sort: "recent" }));
      }
    }, 220);
  };

  const runLiveUpstreamSearch = async () => {
    if (!filters.q || filters.q.length < 2) return;
    setUpstreamLoading(true);
    try {
      const res = await apiGet(`/api/search/upstream?q=${encodeURIComponent(filters.q)}`);
      setUpstreamResults(res.items || []);
    } catch {
      notify("Upstream live search failed");
    } finally {
      setUpstreamLoading(false);
    }
  };

  const navigateTab = (nextTab, extraFilters = {}) => {
    setTab(nextTab);
    if (nextTab !== "search") {
      setSearchInput("");
      setMobileSearchOpen(false);
    }
    setFilters({
      q: extraFilters.q || "",
      category: extraFilters.category || "",
      year: extraFilters.year ? String(extraFilters.year) : "",
      quality: extraFilters.quality || "",
      audio: extraFilters.audio || "",
      language: extraFilters.language || "",
      source: extraFilters.source || "",
      sort: extraFilters.sort || "recent",
      page: 1,
    });
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const handleToggleWatchlist = async (mediaId) => {
    try {
      const res = await apiPost(`/api/watchlist/${mediaId}`);
      notify(res.inWatchlist ? "Added to My List" : "Removed from My List");
      loadHome();
      if (tab === "mylist") loadMyList();
      return res;
    } catch {
      return null;
    }
  };

  const handleRemoveWatchlistItem = async (item) => {
    try {
      await apiDelete(`/api/watchlist/${item.id}`);
      setWatchlist((prev) => prev.filter((w) => w.id !== item.id));
      notify(`Removed "${item.title}" from Watchlist`);
      loadHome();
    } catch {
      notify("Failed to remove from Watchlist");
    }
  };

  const handleClearWatchlist = async () => {
    if (confirmClear !== "watchlist") {
      setConfirmClear("watchlist");
      setTimeout(() => setConfirmClear((c) => (c === "watchlist" ? null : c)), 4000);
      return;
    }
    try {
      await apiDelete("/api/watchlist?all=1");
      setWatchlist([]);
      setConfirmClear(null);
      notify("Watchlist cleared");
      loadHome();
    } catch {
      notify("Failed to clear Watchlist");
    }
  };

  const handleRemoveHistoryItem = async (item) => {
    try {
      await apiDelete(`/api/history?mediaId=${item.id}`);
      setHistoryList((prev) => prev.filter((h) => h.id !== item.id));
      setHomeData((prev) =>
        prev
          ? { ...prev, continueWatching: (prev.continueWatching || []).filter((h) => h.id !== item.id) }
          : prev
      );
      notify(`Removed "${item.title}" from Watch History`);
    } catch {
      notify("Failed to remove from History");
    }
  };

  const handleClearHistory = async () => {
    if (confirmClear !== "history") {
      setConfirmClear("history");
      setTimeout(() => setConfirmClear((c) => (c === "history" ? null : c)), 4000);
      return;
    }
    try {
      await apiDelete("/api/history?all=1");
      setHistoryList([]);
      setHomeData((prev) => (prev ? { ...prev, continueWatching: [] } : prev));
      setConfirmClear(null);
      notify("Watch history cleared");
    } catch {
      notify("Failed to clear Watch History");
    }
  };

  const handleTriggerSync = async (mode) => {
    try {
      const res = await apiPost("/api/sync", { mode });
      if (res.started) {
        notify(mode === "quick" ? "Syncing new uploads across all servers..." : "Full multi-server library sync started");
      } else {
        notify("A sync is already running");
      }
    } catch (e) {
      notify("Sync error: " + e.message);
    }
  };

  const handleSelectCard = (item, progress = null, autoPlay = false) => {
    // If clicked from Continue Watching and we know the exact file URL, resume straight into Player!
    if (progress?.file_url) {
      setPlayerSession({
        item,
        file: {
          url: progress.file_url,
          name: progress.file_name || item.title,
          label: progress.episode_label,
        },
        seasonName: progress.season_name,
        startTime: progress.completed ? 0 : progress.position,
      });
      return;
    }
    setActiveDetail({ id: item.id, initialPlay: autoPlay });
  };

  const visibleCategories = categories.filter((c) => {
    if (tab === "movies") return c.group === "movies";
    if (tab === "series") return c.group === "series";
    return true;
  });

  return (
    <>
      {/* TOP GLASS NAVBAR */}
      <header className="navbar">
        <div className="nav-left">
          <button className="brand" onClick={() => navigateTab("home")}>
            <div className="brand-mark">
              <Clapperboard size={19} color="#fff" />
            </div>
            <div>
              Cine<span>Vault</span>
            </div>
          </button>

          <nav className="nav-links">
            <button className={`nav-btn ${tab === "home" ? "active" : ""}`} onClick={() => navigateTab("home")}>
              <Home size={15} /> Home
            </button>
            <button className={`nav-btn ${tab === "movies" ? "active" : ""}`} onClick={() => navigateTab("movies")}>
              <Film size={15} /> Movies
            </button>
            <button className={`nav-btn ${tab === "series" ? "active" : ""}`} onClick={() => navigateTab("series")}>
              <Tv size={15} /> TV &amp; Anime
            </button>
            <button className={`nav-btn ${tab === "mylist" ? "active" : ""}`} onClick={() => navigateTab("mylist")}>
              <Bookmark size={15} /> My List
            </button>
          </nav>
        </div>

        <div className="nav-right">
          <div className="search-box desktop-search">
            <Search size={15} className="search-icon" />
            <input
              ref={searchInputRef}
              type="text"
              placeholder="Search movies, series, anime..."
              value={searchInput}
              onChange={(e) => handleSearchChange(e.target.value)}
            />
            {searchInput ? (
              <button
                className="search-clear"
                onClick={() => handleSearchChange("")}
                aria-label="Clear search"
              >
                <X size={14} />
              </button>
            ) : (
              <span className="search-kbd">/</span>
            )}
          </div>

          <button
            className={`mobile-search-toggle ${mobileSearchOpen || searchInput ? "active" : ""}`}
            onClick={() => {
              setMobileSearchOpen((open) => {
                const next = !open;
                if (next) setTimeout(() => mobileSearchInputRef.current?.focus(), 60);
                return next;
              });
            }}
            aria-label="Toggle search"
          >
            {mobileSearchOpen ? <X size={18} /> : <Search size={18} />}
          </button>

          <button
            className={`sync-pill ${sync.running ? "syncing" : ""}`}
            onClick={() => setShowSyncDrawer(true)}
            title="Server health & auto-sync controls"
          >
            {sync.running ? (
              <>
                <RefreshCw size={14} className="spin" />
                <span className="sync-text-full">Syncing {sync.percent}%</span>
                <span className="sync-text-short">{sync.percent}%</span>
              </>
            ) : (
              <>
                <span className="status-dot" />
                <span className="sync-text-full">{(stats?.total || 0).toLocaleString()} Titles</span>
                <span className="sync-text-short">
                  {stats?.total >= 1000
                    ? `${(stats.total / 1000).toFixed(1)}K`
                    : (stats?.total || 0)}
                </span>
              </>
            )}
          </button>
        </div>
      </header>

      {/* EXPANDABLE FULL-WIDTH MOBILE SEARCH BAR */}
      {mobileSearchOpen && (
        <div className="mobile-search-bar">
          <div className="search-box mobile-search-inner">
            <Search size={16} className="search-icon" />
            <input
              ref={mobileSearchInputRef}
              type="text"
              placeholder="Search movies, series, anime..."
              value={searchInput}
              onChange={(e) => handleSearchChange(e.target.value)}
            />
            {searchInput && (
              <button
                className="search-clear"
                onClick={() => handleSearchChange("")}
                aria-label="Clear search"
              >
                <X size={15} />
              </button>
            )}
          </div>
        </div>
      )}

      {/* MAIN VIEW */}
      <main className={`main-content ${mobileSearchOpen ? "search-open" : ""}`}>
        {/* Live Sync Progress Banner */}
        {sync.running && (
          <div className="sync-banner">
            <div className="sync-banner-left">
              <RefreshCw size={15} className="spin" color="var(--sky)" />
              <span style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                <strong>Syncing All Servers:</strong> {sync.currentLabel} (
                {(stats?.total || 0).toLocaleString()} unique titles
                {sync.newlyAddedCount > 0 ? `, +${sync.newlyAddedCount.toLocaleString()} new` : ""})
              </span>
            </div>
            <div className="sync-bar-wrap">
              <div className="sync-bar-fill" style={{ width: `${sync.percent}%` }} />
            </div>
          </div>
        )}

        {/* HOME VIEW */}
        {tab === "home" && (
          <>
            {!homeData || (homeData.sections.length === 0 && !sync.running) ? (
              <div className="container">
                <div className="empty-state">
                  <Clapperboard size={44} color="var(--accent)" style={{ marginBottom: 14 }} />
                  <h2 style={{ fontFamily: "Outfit, sans-serif", fontSize: 24, marginBottom: 8 }}>
                    {sync.running ? "Building your CineVault library..." : "Ready to Sync All Servers"}
                  </h2>
                  <p style={{ maxWidth: 460, margin: "0 auto 20px", lineHeight: 1.6 }}>
                    Indexing movies, TV series, K-dramas, and anime directly across all connected
                    media servers. Titles will appear here automatically in a few seconds.
                  </p>
                  {!sync.running && (
                    <button className="btn btn-primary" onClick={() => handleTriggerSync("full")}>
                      <RefreshCw size={16} /> Sync Library Now
                    </button>
                  )}
                </div>
              </div>
            ) : (
              <>
                <HeroSpotlight
                  items={homeData.hero}
                  onSelect={handleSelectCard}
                  onToggleWatchlist={handleToggleWatchlist}
                />

                <div className="container">
                  {homeData.continueWatching?.length > 0 && (
                    <CarouselRow
                      title="Continue Watching"
                      subtitle="Pick up right where you left off"
                      items={homeData.continueWatching}
                      isContinueWatching
                      onSelect={handleSelectCard}
                      onRemove={handleRemoveHistoryItem}
                      removeTitle="Remove from Continue Watching"
                    />
                  )}

                  {homeData.sections.map((sec) => (
                    <CarouselRow
                      key={sec.id}
                      title={sec.title}
                      subtitle={sec.subtitle}
                      items={sec.items}
                      onSelect={handleSelectCard}
                      onExploreAll={() =>
                        navigateTab(
                          sec.id === "tv-series" ||
                            sec.id === "korean-series" ||
                            sec.id === "anime" ||
                            sec.id === "documentary"
                            ? "series"
                            : "movies",
                          sec.filter
                        )
                      }
                    />
                  ))}
                </div>
              </>
            )}
          </>
        )}

        {/* BROWSE / SEARCH VIEW */}
        {(tab === "movies" || tab === "series" || tab === "search") && (
          <div className="container">
            <div className="browse-header">
              <div className="browse-title-row">
                <div>
                  <h1 className="browse-title">
                    {tab === "search"
                      ? `Search: "${filters.q}"`
                      : tab === "movies"
                        ? "Movies Library"
                        : "TV Series, Anime & Shows"}
                  </h1>
                  <div className="browse-count">
                    {browseResult.total.toLocaleString()} title{browseResult.total === 1 ? "" : "s"} found
                  </div>
                </div>

                {tab === "search" && filters.q.length >= 2 && (
                  <button
                    className="btn btn-glass btn-sm"
                    onClick={runLiveUpstreamSearch}
                    disabled={upstreamLoading}
                  >
                    {upstreamLoading ? <RefreshCw size={14} className="spin" /> : <Server size={14} />}
                    Deep Live All-Server Search
                  </button>
                )}
              </div>

              {/* Unified Filter Section (Sections + Year / Quality / Audio / Language / Server / Sort) */}
              <FilterPanel
                tab={tab}
                categories={visibleCategories}
                years={years}
                languages={languages}
                filters={filters}
                onChangeFilters={(patch) => setFilters((f) => ({ ...f, ...patch }))}
                onReset={() =>
                  setFilters((f) => ({
                    ...f,
                    category: "",
                    year: "",
                    quality: "",
                    audio: "",
                    language: "",
                    source: "",
                    page: 1,
                  }))
                }
              />

              {/* Optional Live Upstream Raw File Results */}
              {upstreamResults.length > 0 && (
                <div className="explorer-shell" style={{ marginTop: 18 }}>
                  <div className="explorer-bar">
                    <Sparkles size={15} color="var(--gold)" />
                    <strong>Live All-Server Matches ({upstreamResults.length})</strong>
                  </div>
                  {upstreamResults.slice(0, 25).map((r) => (
                    <div className="explorer-row" key={r.url}>
                      <div style={{ minWidth: 0, flex: 1 }}>
                        <div style={{ fontSize: 13.5, fontWeight: 500, wordBreak: "break-word" }}>
                          {r.name}
                        </div>
                        <div style={{ fontSize: 11.5, color: "var(--text-dim)" }}>
                          {decodeURIComponent(r.href)} {r.size > 0 ? `• ${formatBytes(r.size)}` : ""}
                        </div>
                      </div>
                      {!r.isDir && (
                        <div className="file-row-actions">
                          {r.kind === "video" && (
                            <button
                              className="icon-btn"
                              onClick={() =>
                                setPlayerSession({
                                  item: { title: r.name },
                                  file: r,
                                  startTime: 0,
                                })
                              }
                            >
                              <Play size={15} fill="currentColor" />
                            </button>
                          )}
                          <a className="icon-btn" href={buildDownloadUrl(r.url)}>
                            <Download size={15} />
                          </a>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}

              {/* Results Grid */}
              {browseLoading ? (
                <div className="skeleton-grid">
                  {Array.from({ length: 24 }).map((_, i) => (
                    <div className="skeleton-card" key={i} />
                  ))}
                </div>
              ) : browseResult.items.length === 0 ? (
                <div className="empty-state">
                  <h3 style={{ marginBottom: 8 }}>No matching titles found</h3>
                  <p>Try broadening your filters or run a Deep Live All-Server Search.</p>
                </div>
              ) : (
                <>
                  <div className="media-grid">
                    {browseResult.items.map((item) => (
                      <MediaCard key={item.id} item={item} onSelect={handleSelectCard} />
                    ))}
                  </div>

                  {browseResult.totalPages > 1 && (
                    <div className="pagination">
                      <button
                        className="btn btn-glass btn-sm"
                        disabled={filters.page <= 1}
                        onClick={() => {
                          setFilters((f) => ({ ...f, page: f.page - 1 }));
                          window.scrollTo({ top: 0, behavior: "smooth" });
                        }}
                      >
                        <ChevronLeft size={16} /> Prev
                      </button>
                      <span className="page-info">
                        Page {browseResult.page} of {browseResult.totalPages}
                      </span>
                      <button
                        className="btn btn-glass btn-sm"
                        disabled={filters.page >= browseResult.totalPages}
                        onClick={() => {
                          setFilters((f) => ({ ...f, page: f.page + 1 }));
                          window.scrollTo({ top: 0, behavior: "smooth" });
                        }}
                      >
                        Next <ChevronRight size={16} />
                      </button>
                    </div>
                  )}
                </>
              )}
            </div>
          </div>
        )}

        {/* MY LIST & HISTORY VIEW */}
        {tab === "mylist" && (
          <div className="container">
            <div className="browse-header">
              <h1 className="browse-title">My Watchlist &amp; History</h1>
              <div className="browse-count">
                Saved locally in your personal CineVault database.
              </div>

              {historyList.length > 0 && (
                <CarouselRow
                  title={`Recently Watched (${historyList.length})`}
                  subtitle="Click any title to resume, or × to remove from history"
                  items={historyList}
                  isContinueWatching
                  onSelect={handleSelectCard}
                  onRemove={handleRemoveHistoryItem}
                  removeTitle="Remove from Watch History"
                  headerAction={
                    <button
                      className={`danger-outline-btn ${confirmClear === "history" ? "confirm" : ""}`}
                      onClick={handleClearHistory}
                    >
                      <Trash2 size={13} />
                      <span>{confirmClear === "history" ? "Confirm Clear History?" : "Clear History"}</span>
                    </button>
                  }
                />
              )}

              <section className="section">
                <div className="section-header">
                  <div>
                    <h2 className="section-title">Saved Watchlist ({watchlist.length})</h2>
                  </div>
                  {watchlist.length > 0 && (
                    <button
                      className={`danger-outline-btn ${confirmClear === "watchlist" ? "confirm" : ""}`}
                      onClick={handleClearWatchlist}
                    >
                      <Trash2 size={13} />
                      <span>{confirmClear === "watchlist" ? "Confirm Clear Watchlist?" : "Clear Watchlist"}</span>
                    </button>
                  )}
                </div>
                {watchlist.length === 0 ? (
                  <div className="empty-state">
                    <Bookmark size={36} style={{ marginBottom: 10, opacity: 0.4 }} />
                    <div>Your watchlist is empty. Click “+ My List” on any movie or series to save it here.</div>
                  </div>
                ) : (
                  <div className="media-grid">
                    {watchlist.map((item) => (
                      <MediaCard
                        key={item.id}
                        item={item}
                        onSelect={handleSelectCard}
                        onRemove={handleRemoveWatchlistItem}
                        removeTitle="Remove from Watchlist"
                      />
                    ))}
                  </div>
                )}
              </section>
            </div>
          </div>
        )}

      </main>

      {/* MOBILE BOTTOM NAV */}
      <nav className="mobile-tabs">
        {[
          { id: "home", label: "Home", Icon: Home },
          { id: "movies", label: "Movies", Icon: Film },
          { id: "series", label: "TV", Icon: Tv },
          { id: "mylist", label: "My List", Icon: Bookmark },
        ].map(({ id, label, Icon }) => (
          <button
            key={id}
            className={`mobile-tab-btn ${tab === id ? "active" : ""}`}
            onClick={() => navigateTab(id)}
          >
            <Icon size={18} />
            <span>{label}</span>
          </button>
        ))}
      </nav>

      {/* DETAIL MODAL */}
      {activeDetail && (
        <DetailModal
          itemId={activeDetail.id}
          initialPlay={activeDetail.initialPlay}
          onClose={() => setActiveDetail(null)}
          onOpenItem={(id) => setActiveDetail({ id, initialPlay: false })}
          onPlayFile={(session) => {
            setActiveDetail(null);
            setPlayerSession(session);
          }}
          onToggleWatchlist={handleToggleWatchlist}
          onNotify={notify}
        />
      )}

      {/* CINEMA VIDEO PLAYER */}
      {playerSession && (
        <VideoPlayer
          session={playerSession}
          onClose={() => {
            setPlayerSession(null);
            loadHome();
          }}
          onProgressSaved={loadHome}
          onSwitchEpisode={(nextIndex) => {
            const nextFile = playerSession.playlist?.[nextIndex];
            if (!nextFile) return;
            setPlayerSession((prev) => ({
              ...prev,
              file: nextFile,
              playlistIndex: nextIndex,
              startTime: 0,
            }));
          }}
          onSwitchQualityOption={(opt, resumeAt) => {
            setPlayerSession((prev) => ({
              ...prev,
              file: opt.file,
              externalSubtitles: opt.subtitles || [],
              qualityLabel: opt.quality,
              serverLabel: opt.serverLabel,
              startTime: resumeAt || 0,
            }));
          }}
        />
      )}

      {/* SYNC & SERVER SETTINGS DRAWER */}
      {showSyncDrawer && (
        <SyncDrawer
          sync={sync}
          stats={stats}
          onClose={() => setShowSyncDrawer(false)}
          onTriggerSync={handleTriggerSync}
          onNotify={notify}
        />
      )}

      {/* TOASTS */}
      <div className="toast-stack">
        {toasts.map((t) => (
          <div className="toast" key={t.id}>
            <Sparkles size={15} color="var(--gold)" />
            <span>{t.text}</span>
          </div>
        ))}
      </div>
    </>
  );
}
