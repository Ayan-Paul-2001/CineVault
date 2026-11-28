import React, { useEffect, useState, useRef } from "react";
import {
  X,
  RefreshCw,
  Server,
  Wifi,
  Clock,
  CheckCircle2,
  XCircle,
  Zap,
  Database,
  Copy,
  Plus,
  Trash2,
  RotateCcw,
  FolderOpen,
  Sparkles,
  EyeOff,
  Globe,
  Check,
  Layers,
} from "lucide-react";
import { apiGet, apiPost, apiDelete, formatRelativeDate, CATEGORY_LABELS } from "../api.js";

const BUILTIN_SOURCE_LABELS = {
  dhakaflix: "DhakaFlix",
  icc: "ICC FTP",
  circleftp: "CircleFTP",
  discoveryftp: "DiscoveryFTP",
};

export default function SyncDrawer({
  sync,
  stats,
  autoStartBdixScan = false,
  onAutoStartHandled,
  onClose,
  onTriggerSync,
  onServersChanged,
  onNotify,
}) {
  const [health, setHealth] = useState(null);
  const [checking, setChecking] = useState(false);

  // Built-in BDIX Wi-Fi Server Scanner (https://bdix.link/test/server) state
  const [bdixScan, setBdixScan] = useState(null);
  const [showBdixResults, setShowBdixResults] = useState(false);
  const [bdixFilter, setBdixFilter] = useState("open"); // "open" | "all"
  const prevBdixRunningRef = useRef(false);

  // Add Server Studio state (100% automatic protocol & directory detection — zero manual protocol picker!)
  const [showAddForm, setShowAddForm] = useState(false);
  const [newName, setNewName] = useState("");
  const [newUrl, setNewUrl] = useState("");
  const [probing, setProbing] = useState(false);
  const [probeResult, setProbeResult] = useState(null);
  const [probeFolders, setProbeFolders] = useState([]);
  const [probeError, setProbeError] = useState("");
  const [savingServer, setSavingServer] = useState(false);

  // Per-row action states
  const [confirmDeleteId, setConfirmDeleteId] = useState(null);
  const [busyServerId, setBusyServerId] = useState(null);
  const [confirmReset, setConfirmReset] = useState(false);
  const prevSyncRunningRef = useRef(Boolean(sync?.running));

  const loadHealth = async (force = false) => {
    setChecking(true);
    try {
      const h = await apiGet(`/api/health${force ? "?force=1" : ""}`);
      setHealth(h);
    } catch {}
    setChecking(false);
  };

  useEffect(() => {
    loadHealth(false);
    apiGet("/api/servers/bdix-scan/status")
      .then((res) => {
        if (res?.scan) {
          setBdixScan(res.scan);
          if (res.scan.running || res.scan.results?.length > 0) setShowBdixResults(true);
        }
      })
      .catch(() => {});
  }, []);

  const handleStartBdixScan = async () => {
    setShowBdixResults(true);
    try {
      const res = await apiPost("/api/servers/bdix-scan", { autoSync: true });
      if (res?.status) setBdixScan(res.status);
      onNotify("Scanning BDIX servers open on your Wi-Fi...");
    } catch (err) {
      onNotify("BDIX scan failed: " + err.message);
    }
  };

  useEffect(() => {
    if (autoStartBdixScan) {
      onAutoStartHandled?.();
      handleStartBdixScan();
    }
  }, [autoStartBdixScan]);

  // Poll BDIX scan status smoothly while running (and auto-refresh servers list when done!)
  useEffect(() => {
    if (!bdixScan?.running) {
      if (prevBdixRunningRef.current) {
        loadHealth(true);
        onServersChanged?.();
      }
      prevBdixRunningRef.current = false;
      return;
    }
    prevBdixRunningRef.current = true;
    const timer = setInterval(async () => {
      try {
        const res = await apiGet("/api/servers/bdix-scan/status");
        if (res?.scan) setBdixScan(res.scan);
      } catch {}
    }, 650);
    return () => clearInterval(timer);
  }, [bdixScan?.running]);

  // Automatically refresh server item counts & statuses as soon as any sync finishes!
  useEffect(() => {
    const nowRunning = Boolean(sync?.running);
    if (prevSyncRunningRef.current && !nowRunning) {
      loadHealth(true);
      onServersChanged?.();
    }
    prevSyncRunningRef.current = nowRunning;
  }, [sync?.running, onServersChanged]);

  const updateSettings = async (patch) => {
    try {
      await apiPost("/api/sync/settings", patch);
      onNotify("Auto-sync settings updated");
    } catch (e) {
      onNotify("Failed to update settings: " + e.message);
    }
  };

  const resetAddForm = () => {
    setNewName("");
    setNewUrl("");
    setProbeResult(null);
    setProbeFolders([]);
    setProbeError("");
  };

  const handleProbeServer = async (overrideUrl = null) => {
    const trimmed = String(overrideUrl ?? newUrl).trim();
    if (!trimmed) {
      setProbeError("Enter an FTP or server URL first.");
      return null;
    }
    setProbing(true);
    setProbeError("");
    setProbeResult(null);
    setProbeFolders([]);
    try {
      const res = await apiPost("/api/servers/probe", { url: trimmed });
      setProbeResult(res);
      setProbeFolders(res.folders || []);
      if (!newName.trim()) {
        if (res.suggestedName) {
          setNewName(res.suggestedName);
        } else if (res.origin) {
          try {
            setNewName(new URL(res.origin).hostname);
          } catch {}
        }
      }
      return res;
    } catch (err) {
      setProbeError(err.message || "Could not reach server");
      return null;
    } finally {
      setProbing(false);
    }
  };

  const toggleProbeFolder = (href) => {
    setProbeFolders((prev) =>
      prev.map((f) => (f.href === href ? { ...f, selected: !f.selected } : f))
    );
  };

  const setAllProbeFolders = (mode) => {
    setProbeFolders((prev) =>
      prev.map((f) => {
        if (mode === "all") return { ...f, selected: true };
        if (mode === "none") return { ...f, selected: false };
        // "media": select everything not flagged skipDefault (re-infer via initial compatible list)
        const low = (f.name || "").toLowerCase();
        const isJunk = /\b(games?|pc\s*games?|software|apps?|apk|tutorials?|ebooks?|music|mp3|iso|drivers?|wallpapers?)\b/i.test(low);
        return { ...f, selected: !isJunk };
      })
    );
  };

  const handleSaveServer = async (e) => {
    e?.preventDefault();
    const trimmedUrl = newUrl.trim();
    if (!trimmedUrl) {
      setProbeError("Server URL is required.");
      return;
    }
    setSavingServer(true);
    setProbeError("");
    try {
      // Fully automatic protocol + folder detection — no manual protocol picker required!
      const selectedFolders = probeFolders.filter((f) => f.selected);
      const res = await apiPost("/api/servers", {
        name: newName.trim() || undefined,
        url: probeResult?.origin && probeResult?.rootHref ? `${probeResult.origin}${probeResult.rootHref}` : trimmedUrl,
        adapter: probeResult?.detectedAdapter || "auto",
        folders: probeResult ? selectedFolders : [],
        autoDiscover: !probeResult,
        syncNow: true,
      });
      const discoveredCount = res.server?.folders?.length || 0;
      onNotify(
        discoveredCount > 0
          ? `Added "${res.server?.name}" (${discoveredCount} folders auto-detected) & started syncing`
          : `Added "${res.server?.name || "Server"}" & started syncing`
      );
      resetAddForm();
      setShowAddForm(false);
      await loadHealth(true);
      onServersChanged?.();
    } catch (err) {
      setProbeError(err.message || "Failed to save server");
    } finally {
      setSavingServer(false);
    }
  };

  const handleToggleServer = async (srv) => {
    setBusyServerId(srv.id);
    try {
      const nextEnabled = !srv.enabled;
      await apiPost(`/api/servers/${encodeURIComponent(srv.id)}/toggle`, { enabled: nextEnabled });
      onNotify(`${srv.name} ${nextEnabled ? "enabled — files visible" : "disabled — files hidden"}`);
      await loadHealth(true);
      onServersChanged?.();
    } catch (err) {
      onNotify("Toggle failed: " + err.message);
    } finally {
      setBusyServerId(null);
    }
  };

  const handleDeleteServer = async (srv) => {
    if (confirmDeleteId !== srv.id) {
      setConfirmDeleteId(srv.id);
      setTimeout(() => setConfirmDeleteId((cur) => (cur === srv.id ? null : cur)), 4500);
      return;
    }
    setBusyServerId(srv.id);
    setConfirmDeleteId(null);
    try {
      const res = await apiDelete(`/api/servers/${encodeURIComponent(srv.id)}`);
      if (res?.error) throw new Error(res.error);
      const removed = res?.deletedRows || 0;
      onNotify(
        removed > 0
          ? `Removed "${srv.name}" & cleaned ${removed.toLocaleString()} indexed items`
          : `Removed "${srv.name}"`
      );
      await loadHealth(true);
      onServersChanged?.();
    } catch (err) {
      onNotify("Remove failed: " + err.message);
    } finally {
      setBusyServerId(null);
    }
  };

  const handleResetDefaults = async () => {
    if (!confirmReset) {
      setConfirmReset(true);
      setTimeout(() => setConfirmReset(false), 4500);
      return;
    }
    setConfirmReset(false);
    setChecking(true);
    try {
      await apiPost("/api/servers/reset", {});
      onNotify("Default FTP servers restored & visible");
      await loadHealth(true);
      onServersChanged?.();
    } catch (err) {
      onNotify("Reset failed: " + err.message);
    } finally {
      setChecking(false);
    }
  };

  const nextSyncMins =
    sync?.autoSyncEnabled && sync?.nextAutoSyncAt
      ? Math.max(1, Math.round((sync.nextAutoSyncAt - Date.now()) / 60000))
      : null;

  const servers = health?.servers || [];
  const enabledCount = servers.filter((s) => s.enabled).length;
  const onlineCount = servers.filter((s) => s.enabled && s.online).length;
  const hiddenCount = servers.filter((s) => !s.enabled).length;

  const sourceNameLookup = { ...BUILTIN_SOURCE_LABELS };
  for (const s of servers) {
    if (s.source && !sourceNameLookup[s.source]) {
      sourceNameLookup[s.source] = s.name;
    }
  }
  const sourceEntries = Object.entries(stats?.bySource || {}).filter(([, count]) => count > 0);
  const selectedProbeCount = probeFolders.filter((f) => f.selected).length;

  return (
    <div
      className="drawer-backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="drawer-panel srv-drawer-panel">
        {/* Drawer Header */}
        <div className="srv-drawer-header">
          <div style={{ display: "flex", alignItems: "center", gap: 11 }}>
            <div className="srv-header-icon">
              <Server size={18} color="#fff" />
            </div>
            <div>
              <h2 style={{ fontFamily: "Outfit, sans-serif", fontSize: 19, fontWeight: 700, lineHeight: 1.15 }}>
                FTP Servers &amp; Sync
              </h2>
              <div style={{ fontSize: 11.5, color: "var(--text-muted)", marginTop: 2 }}>
                Add, toggle, or remove any server live
              </div>
            </div>
          </div>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            <X size={18} />
          </button>
        </div>

        {/* Library Catalog & Sync Controls */}
        <div className="drawer-card srv-catalog-card">
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, fontWeight: 600, fontSize: 14 }}>
              <Database size={16} color="var(--sky)" /> Library Catalog
            </div>
            <span className="srv-meta-pill">
              {stats?.lastSync ? `Synced ${formatRelativeDate(stats.lastSync)}` : "Not synced yet"}
            </span>
          </div>

          <div className="srv-metrics-grid">
            <div className="srv-metric-tile">
              <div className="srv-metric-val">{(stats?.total || 0).toLocaleString()}</div>
              <div className="srv-metric-lbl">Active Titles</div>
            </div>
            <div className="srv-metric-tile">
              <div className="srv-metric-val">{(stats?.movies || 0).toLocaleString()}</div>
              <div className="srv-metric-lbl">Movies</div>
            </div>
            <div className="srv-metric-tile">
              <div className="srv-metric-val">{(stats?.series || 0).toLocaleString()}</div>
              <div className="srv-metric-lbl">TV &amp; Anime</div>
            </div>
          </div>

          {sourceEntries.length > 0 && (
            <div className="srv-source-pills">
              {sourceEntries.map(([src, cnt]) => (
                <span className="srv-source-chip" key={src}>
                  <span>{sourceNameLookup[src] || src}</span>
                  <strong>{cnt.toLocaleString()}</strong>
                </span>
              ))}
              {(stats?.duplicatesMerged || 0) > 0 && (
                <span className="srv-source-chip gold">
                  <Layers size={11} />
                  <span>Merged</span>
                  <strong>{(stats?.duplicatesMerged || 0).toLocaleString()}</strong>
                </span>
              )}
            </div>
          )}

          {sync?.running && (
            <div className="srv-live-sync-box">
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 12, marginBottom: 6 }}>
                <span style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
                  <RefreshCw size={12} className="spin" color="var(--sky)" style={{ flexShrink: 0 }} />
                  <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {sync.currentLabel}
                  </span>
                </span>
                <strong style={{ color: "var(--sky)", marginLeft: 8 }}>{sync.percent}%</strong>
              </div>
              <div className="sync-bar-wrap" style={{ width: "100%", height: 6 }}>
                <div className="sync-bar-fill" style={{ width: `${sync.percent}%` }} />
              </div>
            </div>
          )}

          <div style={{ display: "flex", gap: 8, marginTop: 14 }}>
            <button
              className="btn btn-primary btn-sm"
              style={{ flex: 1 }}
              disabled={sync?.running}
              onClick={() => onTriggerSync("quick")}
            >
              <Zap size={15} /> Sync New Files
            </button>
            <button
              className="btn btn-glass btn-sm"
              style={{ flex: 1 }}
              disabled={sync?.running}
              onClick={() => onTriggerSync("full")}
            >
              <RefreshCw size={15} className={sync?.running ? "spin" : ""} /> Full Rescan
            </button>
          </div>
        </div>

        {/* Built-in Wi-Fi BDIX Server Scanner (https://bdix.link/test/server) */}
        <div className="drawer-card bdix-scanner-card">
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
            <div style={{ minWidth: 0 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 7, fontWeight: 700, fontSize: 14 }}>
                <Wifi size={15} color="var(--sky)" />
                <span>Wi-Fi BDIX Server Scanner</span>
              </div>
              <div style={{ fontSize: 11.5, color: "var(--text-muted)", marginTop: 2 }}>
                Tests open FTP servers on your current Wi-Fi via bdix.link &amp; auto-syncs only open servers
              </div>
            </div>
          </div>

          <button
            type="button"
            className="btn btn-sky btn-sm"
            style={{ width: "100%", height: 38, marginTop: 11, justifyContent: "center" }}
            disabled={Boolean(bdixScan?.running)}
            onClick={handleStartBdixScan}
          >
            {bdixScan?.running ? (
              <>
                <RefreshCw size={14} className="spin" />
                Testing {bdixScan.tested || 0}/{bdixScan.total || "..."} Servers ({bdixScan.openCount || 0} Open)
              </>
            ) : (
              <>
                <Sparkles size={14} /> Run Wi-Fi BDIX Server Test &amp; Auto-Sync
              </>
            )}
          </button>

          {bdixScan && (bdixScan.running || bdixScan.total > 0) && (
            <div className="bdix-scan-progress-box">
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 11.5, gap: 8 }}>
                <span style={{ color: bdixScan.phase === "error" ? "#fca5a5" : "var(--text-muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {bdixScan.message}
                </span>
                <strong style={{ color: "var(--sky)", flexShrink: 0 }}>{bdixScan.percent || 0}%</strong>
              </div>
              <div className="sync-bar-wrap" style={{ width: "100%", height: 5, marginTop: 6 }}>
                <div className="sync-bar-fill" style={{ width: `${bdixScan.percent || 0}%` }} />
              </div>

              {bdixScan.results?.length > 0 && (
                <>
                  <div className="bdix-result-toolbar">
                    <div style={{ display: "flex", gap: 6 }}>
                      <button
                        type="button"
                        className={`bdix-filter-pill ${bdixFilter === "open" ? "active" : ""}`}
                        onClick={() => setBdixFilter("open")}
                      >
                        Open ({bdixScan.openCount || 0})
                      </button>
                      <button
                        type="button"
                        className={`bdix-filter-pill ${bdixFilter === "all" ? "active" : ""}`}
                        onClick={() => setBdixFilter("all")}
                      >
                        All ({bdixScan.results.length})
                      </button>
                    </div>
                    <button
                      type="button"
                      className="bdix-filter-pill"
                      onClick={() => setShowBdixResults((v) => !v)}
                    >
                      {showBdixResults ? "Hide List" : "Show List"}
                    </button>
                  </div>

                  {showBdixResults && (
                    <div className="bdix-results-list">
                      {(bdixFilter === "open"
                        ? bdixScan.results.filter((r) => r.open)
                        : bdixScan.results
                      ).map((r) => (
                        <div className={`bdix-result-row ${r.syncable ? "synced" : r.open ? "open" : "closed"}`} key={`${r.url}-${r.title}`}>
                          <div style={{ minWidth: 0, flex: 1 }}>
                            <div className="bdix-row-title">{r.title}</div>
                            <div className="bdix-row-url">{r.url}</div>
                          </div>
                          <span className={`bdix-row-pill ${r.syncable ? "synced" : r.open ? "open" : "closed"}`}>
                            {r.syncable
                              ? `Synced · ${r.latencyMs ?? 0}ms`
                              : r.open
                                ? (r.status === "web-only" ? "Web Portal" : `Open · ${r.latencyMs ?? 0}ms`)
                                : "Closed"}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </>
              )}
            </div>
          )}
        </div>

        {/* Dynamic FTP Servers Manager */}
        <div className="drawer-card srv-manager-card">
          <div className="srv-section-head">
            <div>
              <div style={{ fontWeight: 700, fontSize: 14.5, display: "flex", alignItems: "center", gap: 7 }}>
                <Globe size={15} color="var(--accent)" />
                <span>Connected FTP Servers</span>
              </div>
              <div className="srv-health-strip">
                <span className="srv-strip-dot online">{onlineCount} Online</span>
                <span>·</span>
                <span>{enabledCount} Active</span>
                {hiddenCount > 0 && (
                  <>
                    <span>·</span>
                    <span className="srv-strip-dot hidden">{hiddenCount} Hidden</span>
                  </>
                )}
              </div>
            </div>

            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <button
                className={`server-mini-btn ${showAddForm ? "" : "accent"}`}
                onClick={() => {
                  setShowAddForm((v) => !v);
                  setProbeError("");
                }}
                title="Add custom HTTP/FTP directory server"
              >
                <Plus size={13} /> {showAddForm ? "Close" : "Add Server"}
              </button>
              <button
                className={`server-mini-btn ${confirmReset ? "danger" : ""}`}
                onClick={handleResetDefaults}
                title="Restore built-in default FTP servers"
              >
                <RotateCcw size={12} /> {confirmReset ? "Confirm?" : "Defaults"}
              </button>
              <button
                className="server-mini-btn"
                onClick={() => loadHealth(true)}
                disabled={checking}
                title="Ping all servers"
              >
                <RefreshCw size={12} className={checking ? "spin" : ""} />
              </button>
            </div>
          </div>

          {/* Add Server Studio Panel */}
          {showAddForm && (
            <form className="add-server-studio" onSubmit={handleSaveServer}>
              <div className="add-studio-head">
                <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
                  <Sparkles size={15} color="var(--sky)" />
                  <strong>Add Custom FTP Server</strong>
                </div>
                <span style={{ fontSize: 11, color: "var(--text-dim)" }}>Auto-detects folders</span>
              </div>
              <p className="add-studio-desc">
                Paste any FTP URL playable on your Wi-Fi (h5ai, Apache, Nginx, Caddy, or BDIX portal).
                CineVault automatically detects all compatible movie &amp; series directories and merges them into your library.
              </p>

              <label className="add-server-label">
                <span>FTP Server URL</span>
                <div className="add-url-row">
                  <input
                    type="text"
                    className="add-server-input"
                    placeholder="http://172.16.50.14/ or ftp.myisp.net/movies/"
                    value={newUrl}
                    onChange={(e) => {
                      setNewUrl(e.target.value);
                      if (probeResult) {
                        setProbeResult(null);
                        setProbeFolders([]);
                      }
                    }}
                    required
                  />
                  <button
                    type="button"
                    className="add-detect-btn"
                    disabled={probing || !newUrl.trim()}
                    onClick={() => handleProbeServer()}
                  >
                    <Sparkles size={13} className={probing ? "spin" : ""} />
                    <span>{probing ? "Scanning" : "Detect"}</span>
                  </button>
                </div>
              </label>

              <label className="add-server-label">
                <span>Display Name (optional — auto-detected)</span>
                <input
                  type="text"
                  className="add-server-input"
                  placeholder="Auto from server"
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  maxLength={80}
                />
              </label>

              {probing && (
                <div className="probe-scanning-banner">
                  <RefreshCw size={13} className="spin" color="var(--sky)" />
                  <span>Scanning server &amp; recursively discovering compatible media folders...</span>
                </div>
              )}

              {probeError && <div className="probe-error-banner">{probeError}</div>}

              {probeResult && (
                <div className="probe-summary">
                  <div className="probe-summary-top">
                    <span className="probe-status-pill">
                      <Check size={12} /> {probeResult.protocol?.toUpperCase()} · {probeResult.latencyMs}ms
                    </span>
                    <span style={{ fontSize: 11.5, color: "var(--text-muted)" }}>
                      <strong style={{ color: "#fff" }}>{selectedProbeCount}</strong> / {probeFolders.length} folders
                      {probeResult.directVideoCount > 0 ? ` · ${probeResult.directVideoCount} videos` : ""}
                    </span>
                  </div>

                  {probeFolders.length > 0 && (
                    <>
                      <div className="probe-quick-actions">
                        <button type="button" onClick={() => setAllProbeFolders("media")}>
                          Compatible Only
                        </button>
                        <button type="button" onClick={() => setAllProbeFolders("all")}>
                          Select All
                        </button>
                        <button type="button" onClick={() => setAllProbeFolders("none")}>
                          Clear
                        </button>
                      </div>
                      <div className="probe-folder-list">
                        {probeFolders.map((f) => (
                          <label className={`probe-folder-row ${f.selected ? "checked" : ""}`} key={f.href}>
                            <input
                              type="checkbox"
                              checked={Boolean(f.selected)}
                              onChange={() => toggleProbeFolder(f.href)}
                            />
                            <FolderOpen size={13} color={f.selected ? "var(--sky)" : "var(--text-dim)"} style={{ flexShrink: 0 }} />
                            <div className="probe-folder-info">
                              <span className="probe-folder-name" title={f.name}>
                                {f.name}
                              </span>
                              <span className="probe-folder-meta">
                                {f.mode === "bucketed" ? "Year/A-Z buckets" : "Direct titles"}
                                {f.childCount > 0 ? ` · ${f.childCount} entries` : ""}
                              </span>
                            </div>
                            <span className="probe-folder-cat">
                              {CATEGORY_LABELS[f.category] || f.category}
                            </span>
                          </label>
                        ))}
                      </div>
                    </>
                  )}
                </div>
              )}

              <button
                type="submit"
                className="btn btn-primary btn-sm"
                style={{ width: "100%", height: 38, marginTop: 12, justifyContent: "center" }}
                disabled={savingServer || probing || !newUrl.trim()}
              >
                {savingServer ? (
                  <>
                    <RefreshCw size={14} className="spin" /> Auto-Detecting &amp; Saving...
                  </>
                ) : (
                  <>
                    <Plus size={14} /> Add Server &amp; Auto-Sync
                  </>
                )}
              </button>
            </form>
          )}

          {/* Server Cards List */}
          <div className="srv-cards-list">
            {servers.length === 0 ? (
              <div className="srv-empty-box">
                <Server size={24} style={{ opacity: 0.4, marginBottom: 6 }} />
                <div>No FTP servers configured.</div>
                <div style={{ fontSize: 11.5, color: "var(--text-dim)", marginTop: 2 }}>
                  Click <strong>Add Server</strong> or <strong>Defaults</strong> above to connect servers.
                </div>
              </div>
            ) : (
              servers.map((s) => {
                const isBusy = busyServerId === s.id;
                const isConfirmingDelete = confirmDeleteId === s.id;
                const stateClass = !s.enabled
                  ? "state-hidden"
                  : s.online
                    ? "state-online"
                    : s.optional
                      ? "state-warn"
                      : "state-offline";
                const folderCount = Array.isArray(s.folders) ? s.folders.length : 0;

                return (
                  <div className={`srv-card ${stateClass}`} key={s.id} title={s.reason || ""}>
                    <div className="srv-card-top">
                      <div style={{ minWidth: 0, flex: 1 }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                          <span className="srv-card-name">{s.name}</span>
                          {!s.isBuiltin && <span className="server-custom-tag">Custom</span>}
                        </div>
                        <div className="srv-card-url">
                          {s.origin}
                          {s.rootHref && s.rootHref !== "/" ? decodeURIComponent(s.rootHref) : ""}
                        </div>
                      </div>

                      <div className={`srv-status-pill ${stateClass}`}>
                        {!s.enabled ? (
                          <>
                            <EyeOff size={12} /> Hidden
                          </>
                        ) : s.online ? (
                          <>
                            <CheckCircle2 size={12} /> {s.latencyMs}ms
                          </>
                        ) : s.optional ? (
                          <>
                            <Clock size={12} /> Upstream
                          </>
                        ) : (
                          <>
                            <XCircle size={12} /> Offline
                          </>
                        )}
                      </div>
                    </div>

                    <div className="srv-card-stats">
                      {s.itemCount > 0 && (
                        <span className="srv-stat-badge">
                          {s.itemCount.toLocaleString()} indexed
                        </span>
                      )}
                      {!s.isBuiltin && folderCount > 0 && (
                        <span className="srv-stat-badge sky">
                          <FolderOpen size={11} /> {folderCount} folder{folderCount === 1 ? "" : "s"}
                        </span>
                      )}
                      {!s.enabled ? (
                        <span className="srv-reason-text">Disabled — files hidden</span>
                      ) : !s.online ? (
                        <span className="srv-reason-text">Offline — content hidden{s.reason ? ` (${s.reason})` : ""}</span>
                      ) : null}
                    </div>

                    <div className="srv-card-footer">
                      <label className="srv-toggle-label">
                        <button
                          type="button"
                          className={`toggle-switch sm ${s.enabled ? "on" : ""}`}
                          disabled={isBusy}
                          onClick={() => handleToggleServer(s)}
                          aria-label={`Toggle ${s.name}`}
                        />
                        <span>{s.enabled ? "Visible" : "Hidden"}</span>
                      </label>

                      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                        {s.enabled && (
                          <button
                            type="button"
                            className="server-mini-btn"
                            disabled={sync?.running || isBusy}
                            onClick={() => onTriggerSync("full", s.id)}
                            title={`Sync only ${s.name}`}
                          >
                            <RefreshCw size={11} /> Sync
                          </button>
                        )}
                        <button
                          type="button"
                          className={`server-mini-btn ${isConfirmingDelete ? "danger" : ""}`}
                          disabled={isBusy}
                          onClick={() => handleDeleteServer(s)}
                          title={`Remove ${s.name} and purge its titles`}
                        >
                          <Trash2 size={11} /> {isConfirmingDelete ? "Confirm?" : "Remove"}
                        </button>
                      </div>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>

        {/* Auto-Sync Scheduler */}
        <div className="drawer-card">
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, fontWeight: 600, fontSize: 14 }}>
              <Clock size={16} color="var(--green)" /> Auto-Sync Schedule
            </div>
            <button
              className={`toggle-switch ${sync?.autoSyncEnabled ? "on" : ""}`}
              onClick={() => updateSettings({ enabled: !sync?.autoSyncEnabled })}
              aria-label="Toggle auto sync"
            />
          </div>
          <p style={{ fontSize: 12.5, color: "var(--text-muted)", lineHeight: 1.5, marginBottom: 12 }}>
            Automatically scans all enabled FTP servers for newly uploaded movies, series, and
            episodes — keeping the highest quality across mirrors.
          </p>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
            <span style={{ fontSize: 13 }}>Check every:</span>
            <select
              className="filter-select"
              value={sync?.autoSyncIntervalMin || 30}
              onChange={(e) => updateSettings({ intervalMin: Number(e.target.value) })}
            >
              <option value={15}>15 minutes</option>
              <option value={30}>30 minutes</option>
              <option value={60}>1 hour</option>
              <option value={180}>3 hours</option>
              <option value={360}>6 hours</option>
            </select>
          </div>
          {nextSyncMins && (
            <div style={{ fontSize: 12, color: "var(--text-dim)", marginTop: 10 }}>
              Next automatic check in ~{nextSyncMins} min
            </div>
          )}
        </div>

        {/* Watch on Phone / Smart TV */}
        {health?.lanUrls?.length > 0 && (
          <div className="drawer-card">
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10, fontWeight: 600, fontSize: 14 }}>
              <Wifi size={16} color="var(--gold)" /> Watch on Phone, Tablet or TV
            </div>
            <p style={{ fontSize: 12.5, color: "var(--text-muted)", marginBottom: 10 }}>
              Open any of these URLs on devices connected to the same Wi-Fi network:
            </p>
            {health.lanUrls.map((u) => (
              <div
                key={u}
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  background: "rgba(255,255,255,0.05)",
                  padding: "8px 12px",
                  borderRadius: 9,
                  marginBottom: 6,
                  fontSize: 13,
                }}
              >
                <code>{u}</code>
                <button
                  className="icon-btn"
                  style={{ width: 28, height: 28 }}
                  onClick={() => {
                    navigator.clipboard?.writeText(u);
                    onNotify(`Copied ${u}`);
                  }}
                >
                  <Copy size={13} />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
