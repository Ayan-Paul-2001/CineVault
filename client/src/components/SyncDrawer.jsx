import React, { useEffect, useState } from "react";
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
} from "lucide-react";
import { apiGet, apiPost, formatRelativeDate } from "../api.js";

export default function SyncDrawer({ sync, stats, onClose, onTriggerSync, onNotify }) {
  const [health, setHealth] = useState(null);
  const [checking, setChecking] = useState(false);

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
  }, []);

  const updateSettings = async (patch) => {
    try {
      await apiPost("/api/sync/settings", patch);
      onNotify("Auto-sync settings updated");
    } catch (e) {
      onNotify("Failed to update settings: " + e.message);
    }
  };

  const nextSyncMins =
    sync?.autoSyncEnabled && sync?.nextAutoSyncAt
      ? Math.max(1, Math.round((sync.nextAutoSyncAt - Date.now()) / 60000))
      : null;

  return (
    <div
      className="drawer-backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="drawer-panel">
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <Server size={20} color="var(--accent)" />
            <h2 style={{ fontFamily: "Outfit, sans-serif", fontSize: 20, fontWeight: 700 }}>
              Server &amp; Auto-Sync
            </h2>
          </div>
          <button className="icon-btn" onClick={onClose}>
            <X size={18} />
          </button>
        </div>

        {/* Library Summary */}
        <div className="drawer-card">
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12, fontWeight: 600 }}>
            <Database size={16} color="var(--sky)" /> Library Catalog
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 10, textAlign: "center" }}>
            <div style={{ background: "rgba(255,255,255,0.04)", padding: 10, borderRadius: 10 }}>
              <div style={{ fontSize: 20, fontWeight: 800, fontFamily: "Outfit, sans-serif" }}>
                {(stats?.total || 0).toLocaleString()}
              </div>
              <div style={{ fontSize: 11.5, color: "var(--text-muted)" }}>Total Titles</div>
            </div>
            <div style={{ background: "rgba(255,255,255,0.04)", padding: 10, borderRadius: 10 }}>
              <div style={{ fontSize: 20, fontWeight: 800, fontFamily: "Outfit, sans-serif" }}>
                {(stats?.movies || 0).toLocaleString()}
              </div>
              <div style={{ fontSize: 11.5, color: "var(--text-muted)" }}>Movies</div>
            </div>
            <div style={{ background: "rgba(255,255,255,0.04)", padding: 10, borderRadius: 10 }}>
              <div style={{ fontSize: 20, fontWeight: 800, fontFamily: "Outfit, sans-serif" }}>
                {(stats?.series || 0).toLocaleString()}
              </div>
              <div style={{ fontSize: 11.5, color: "var(--text-muted)" }}>TV &amp; Anime</div>
            </div>
          </div>

          <div style={{ marginTop: 12, fontSize: 12.5, color: "var(--text-muted)", lineHeight: 1.6 }}>
            <div>
              Duplicates merged (highest quality kept):{" "}
              <strong style={{ color: "var(--gold)" }}>
                {(stats?.duplicatesMerged || 0).toLocaleString()}
              </strong>
            </div>
            <div>
              Primary sources: <strong>{(stats?.bySource?.dhakaflix || 0).toLocaleString()}</strong>{" "}
              DhakaFlix · <strong>{(stats?.bySource?.icc || 0).toLocaleString()}</strong> ICC ·{" "}
              <strong>{(stats?.bySource?.circleftp || 0).toLocaleString()}</strong> CircleFTP ·{" "}
              <strong>{(stats?.bySource?.discoveryftp || 0).toLocaleString()}</strong> DiscoveryFTP
            </div>
            <div>
              Last synced:{" "}
              <strong>{stats?.lastSync ? formatRelativeDate(stats.lastSync) : "Never"}</strong>
              {sync?.lastNewCount > 0 && (
                <span style={{ color: "var(--green)", marginLeft: 8 }}>
                  (+{sync.lastNewCount.toLocaleString()} new)
                </span>
              )}
            </div>
          </div>

          {sync?.running && (
            <div style={{ marginTop: 12 }}>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, marginBottom: 5 }}>
                <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {sync.currentLabel}
                </span>
                <span>{sync.percent}%</span>
              </div>
              <div className="sync-bar-wrap" style={{ width: "100%" }}>
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

        {/* Auto-Sync Scheduler */}
        <div className="drawer-card">
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, fontWeight: 600 }}>
              <Clock size={16} color="var(--green)" /> Auto-Sync New Uploads
            </div>
            <button
              className={`toggle-switch ${sync?.autoSyncEnabled ? "on" : ""}`}
              onClick={() => updateSettings({ enabled: !sync?.autoSyncEnabled })}
              aria-label="Toggle auto sync"
            />
          </div>
          <p style={{ fontSize: 12.5, color: "var(--text-muted)", lineHeight: 1.5, marginBottom: 12 }}>
            Automatically scans <strong>DhakaFlix</strong>, <strong>ICC FTP</strong>,{" "}
            <strong>CircleFTP</strong> &amp; <strong>DiscoveryFTP</strong> for newly uploaded movies,
            series, and episodes — automatically keeping the highest quality.
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
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10, fontWeight: 600 }}>
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

        {/* Source Nodes */}
        <div className="drawer-card">
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
            <span style={{ fontWeight: 600, fontSize: 14 }}>Merged Source Servers</span>
            <button className="see-all-btn" onClick={() => loadHealth(true)} disabled={checking}>
              <RefreshCw size={13} className={checking ? "spin" : ""} /> Ping
            </button>
          </div>
          {(health?.servers || []).map((s) => (
            <div className="server-node-row" key={s.id} title={s.reason || ""}>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontWeight: 500, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                  {s.name}
                </div>
                <div style={{ fontSize: 11.5, color: "var(--text-dim)" }}>
                  {s.origin}
                  {!s.online && s.reason ? ` · ${s.reason}` : ""}
                </div>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 6, flexShrink: 0 }}>
                {s.online ? (
                  <>
                    <span style={{ fontSize: 12, color: "var(--green)" }}>{s.latencyMs}ms</span>
                    <CheckCircle2 size={16} color="var(--green)" />
                  </>
                ) : s.optional ? (
                  <>
                    <span style={{ fontSize: 11.5, color: "var(--gold)" }}>Upstream Down</span>
                    <Clock size={15} color="var(--gold)" />
                  </>
                ) : (
                  <>
                    <span style={{ fontSize: 12, color: "var(--text-dim)" }}>Offline</span>
                    <XCircle size={16} color="#ef4444" />
                  </>
                )}
              </div>
            </div>
          ))}
          {(health?.servers || []).some((s) => !s.online && s.optional) && (
            <div style={{ fontSize: 11.5, color: "var(--text-dim)", marginTop: 8, lineHeight: 1.45 }}>
              Nodes marked <strong style={{ color: "var(--gold)" }}>Upstream Down</strong> are currently down on
              their remote host (your English Movies &amp; Foreign Series remain covered by DhakaFlix, ICC FTP &amp;
              CircleFTP, and CineVault will auto-sync them once they return online).
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
