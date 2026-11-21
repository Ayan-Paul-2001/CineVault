import React, { useEffect, useState } from "react";
import {
  Folder,
  Film,
  FileText,
  Image as ImageIcon,
  ChevronRight,
  Play,
  Download,
  ListVideo,
  Server,
  RefreshCw,
} from "lucide-react";
import { apiGet, buildDownloadUrl, buildM3uUrl, formatBytes } from "../api.js";

const EXPLORER_NODES = [
  { id: "df-14", label: "DhakaFlix 14 (1080p / Hindi / South / K-Drama)", origin: "http://172.16.50.14", href: "/DHAKA-FLIX-14/" },
  { id: "df-7", label: "DhakaFlix 7 (English / Bangla / Foreign / 3D)", origin: "http://172.16.50.7", href: "/DHAKA-FLIX-7/" },
  { id: "df-12", label: "DhakaFlix 12 (TV & Web Series)", origin: "http://172.16.50.12", href: "/DHAKA-FLIX-12/" },
  { id: "df-10", label: "DhakaFlix 10 (Anime / Docs / Shows)", origin: "http://172.16.50.10", href: "/DHAKA-FLIX-10/" },
  { id: "disc-1", label: "DiscoveryFTP CDN-1 (Hindi / Tamil / Bangla / Animation)", origin: "https://cdn1.discoveryftp.net", href: "/Movies/" },
  { id: "disc-2", label: "DiscoveryFTP CDN-2 (Series / Anime / Docs / Shows)", origin: "https://cdn2.discoveryftp.net", href: "/" },
];

export default function ExplorerView({ onPlayRawFile }) {
  const [origin, setOrigin] = useState(EXPLORER_NODES[0].origin);
  const [href, setHref] = useState(EXPLORER_NODES[0].href);
  const [entries, setEntries] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const fetchDir = async (o, h) => {
    setLoading(true);
    setError(null);
    try {
      const res = await apiGet(
        `/api/explorer?origin=${encodeURIComponent(o)}&href=${encodeURIComponent(h)}`
      );
      setEntries(res.entries || []);
    } catch (e) {
      setError(e.message);
      setEntries([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchDir(origin, href);
  }, [origin, href]);

  const segments = href.split("/").filter(Boolean);
  const crumbs = segments.map((seg, i) => ({
    label: decodeURIComponent(seg),
    href: "/" + segments.slice(0, i + 1).join("/") + "/",
  }));

  const subsInFolder = entries.filter((e) => !e.isDir && e.kind === "subtitle");

  return (
    <div className="container">
      <div className="browse-header">
        <div className="browse-title-row">
          <div>
            <h1 className="browse-title">Direct Server Explorer</h1>
            <div className="browse-count">
              Live zero-lag directory browser across all DhakaFlix nodes — play or download any file directly.
            </div>
          </div>
          <button className="btn btn-glass btn-sm" onClick={() => fetchDir(origin, href)}>
            <RefreshCw size={14} className={loading ? "spin" : ""} /> Refresh Folder
          </button>
        </div>

        <div className="cat-pills">
          {EXPLORER_NODES.map((n) => (
            <button
              key={n.id}
              className={`cat-pill ${origin === n.origin ? "active" : ""}`}
              onClick={() => {
                setOrigin(n.origin);
                setHref(n.href);
              }}
            >
              <Server size={13} style={{ display: "inline", marginRight: 6, verticalAlign: -2 }} />
              {n.label}
            </button>
          ))}
        </div>

        <div className="explorer-shell">
          <div className="explorer-bar">
            {crumbs.map((c, idx) => (
              <React.Fragment key={c.href}>
                {idx > 0 && <ChevronRight size={14} color="var(--text-dim)" />}
                <button className="crumb-btn" onClick={() => setHref(c.href)}>
                  {c.label}
                </button>
              </React.Fragment>
            ))}
          </div>

          {loading ? (
            <div style={{ padding: 48, textAlign: "center", color: "var(--text-muted)" }}>
              <RefreshCw size={24} className="spin" style={{ marginBottom: 8 }} />
              <div>Reading live directory from {origin}...</div>
            </div>
          ) : error ? (
            <div style={{ padding: 48, textAlign: "center", color: "#fca5a5" }}>
              Could not load folder: {error}
            </div>
          ) : entries.length === 0 ? (
            <div style={{ padding: 48, textAlign: "center", color: "var(--text-muted)" }}>
              Empty directory
            </div>
          ) : (
            <div>
              {entries.map((e) => (
                <div className="explorer-row" key={e.href}>
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 12,
                      minWidth: 0,
                      flex: 1,
                      cursor: e.isDir || e.kind === "video" ? "pointer" : "default",
                    }}
                    onClick={() => {
                      if (e.isDir) setHref(e.href);
                      else if (e.kind === "video") {
                        onPlayRawFile(e, subsInFolder);
                      }
                    }}
                  >
                    {e.isDir ? (
                      <Folder size={18} color="var(--gold)" style={{ flexShrink: 0 }} />
                    ) : e.kind === "video" ? (
                      <Film size={18} color="var(--accent)" style={{ flexShrink: 0 }} />
                    ) : e.kind === "image" ? (
                      <ImageIcon size={18} color="var(--sky)" style={{ flexShrink: 0 }} />
                    ) : (
                      <FileText size={18} color="var(--text-dim)" style={{ flexShrink: 0 }} />
                    )}
                    <div style={{ minWidth: 0 }}>
                      <div
                        style={{
                          fontSize: 14,
                          fontWeight: e.isDir ? 600 : 500,
                          whiteSpace: "nowrap",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                        }}
                      >
                        {e.name}
                      </div>
                      {!e.isDir && e.size > 0 && (
                        <div style={{ fontSize: 12, color: "var(--text-muted)" }}>
                          {formatBytes(e.size)}
                        </div>
                      )}
                    </div>
                  </div>

                  {!e.isDir && (
                    <div className="file-row-actions">
                      {e.kind === "video" && (
                        <>
                          <button
                            className="icon-btn"
                            title="Play in CineVault Cinema Player"
                            onClick={() => onPlayRawFile(e, subsInFolder)}
                          >
                            <Play size={15} fill="currentColor" />
                          </button>
                          <a
                            className="icon-btn"
                            href={buildM3uUrl({ url: e.url, title: e.name })}
                            title="Open in VLC / PotPlayer"
                          >
                            <ListVideo size={15} />
                          </a>
                        </>
                      )}
                      <a className="icon-btn" href={buildDownloadUrl(e.url)} title="Download">
                        <Download size={15} />
                      </a>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
