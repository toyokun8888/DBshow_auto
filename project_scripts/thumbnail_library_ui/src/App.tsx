import { useEffect, useMemo, useState } from "react";
import "./App.css";

type CollectStatus = "collected" | "failed" | "queued" | "unknown";
type SortKey = "updated_desc" | "updated_asc" | "product_asc" | "product_desc";

type LibraryItem = {
  ownedFileId?: number;
  productId: string;
  title: string;
  sellerName: string;
  pathHint?: string;
  thumbnailPath?: string;
  collectStatus: CollectStatus;
  updatedAt?: string;
};

const PAGE_SIZE = 24;
const LIBRARY_API_ENDPOINT = "/api/library/items";
const OPEN_FOLDER_ENDPOINT = "/api/library/open-folder";
const OPEN_FILE_ENDPOINT = "/api/library/open-file";

function App() {
  const [items, setItems] = useState<LibraryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [idQuery, setIdQuery] = useState("");
  const [titleQuery, setTitleQuery] = useState("");
  const [sellerFilter, setSellerFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState<CollectStatus | "all">("all");
  const [sortKey, setSortKey] = useState<SortKey>("updated_desc");
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<LibraryItem | null>(null);
  const [lastError, setLastError] = useState("");

  useEffect(() => {
    void loadItems();
  }, []);

  useEffect(() => {
    setPage(1);
  }, [idQuery, titleQuery, sellerFilter, statusFilter, sortKey]);

  async function loadItems() {
    setLoading(true);
    setLastError("");
    try {
      const response = await fetch(LIBRARY_API_ENDPOINT);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = (await response.json()) as { items?: LibraryItem[] };
      setItems(body.items ?? []);
    } catch (error: any) {
      await notifyError(`List load failed: ${error?.message || "network_error"}`);
      setItems([]);
    } finally {
      setLoading(false);
    }
  }

  async function notifyError(message: string) {
    setLastError(message);
    if (!("Notification" in window)) {
      alert(message);
      return;
    }
    if (Notification.permission === "granted") {
      new Notification("Error", { body: message });
      return;
    }
    if (Notification.permission !== "denied") {
      const permission = await Notification.requestPermission();
      if (permission === "granted") {
        new Notification("Error", { body: message });
        return;
      }
    }
    alert(message);
  }

  const sellers = useMemo(
    () => [...new Set(items.map((v) => v.sellerName).filter(Boolean))].sort((a, b) => a.localeCompare(b)),
    [items]
  );

  const filtered = useMemo(() => {
    const iq = idQuery.trim().toLowerCase();
    const tq = titleQuery.trim().toLowerCase();
    const f = items.filter((v) => {
      if (sellerFilter !== "all" && v.sellerName !== sellerFilter) return false;
      if (statusFilter !== "all" && v.collectStatus !== statusFilter) return false;
      if (iq && !v.productId.toLowerCase().includes(iq)) return false;
      if (tq && !v.title.toLowerCase().includes(tq)) return false;
      return true;
    });
    return [...f].sort((a, b) => sortItems(a, b, sortKey));
  }, [items, idQuery, titleQuery, sellerFilter, statusFilter, sortKey]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const paged = useMemo(() => filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE), [filtered, page]);

  async function postOpen(endpoint: string, item: LibraryItem, actionLabel: string) {
    setLastError("");
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          productId: item.productId,
          ownedFileId: item.ownedFileId ?? null,
        }),
      });
      const body = (await response.json().catch(() => ({}))) as { ok?: boolean; message?: string };
      if (!response.ok || !body.ok) {
        const msg = body.message || `HTTP ${response.status}`;
        await notifyError(`${actionLabel} failed: ${msg}`);
      }
    } catch (error: any) {
      await notifyError(`${actionLabel} failed: ${error?.message || "network_error"}`);
    }
  }

  async function openFolder(item: LibraryItem) {
    await postOpen(OPEN_FOLDER_ENDPOINT, item, "Open folder");
  }

  async function openFile(item: LibraryItem) {
    await postOpen(OPEN_FILE_ENDPOINT, item, "Open file");
  }

  return (
    <div className="app">
      <header className="topbar">
        <h1>Local Library</h1>
        <button onClick={() => void loadItems()} className="icon-btn" title="Reload">
          R
        </button>
      </header>

      <section className="controls">
        <input value={idQuery} onChange={(e) => setIdQuery(e.target.value)} placeholder="Search ID" />
        <input value={titleQuery} onChange={(e) => setTitleQuery(e.target.value)} placeholder="Search title" />
        <select value={sellerFilter} onChange={(e) => setSellerFilter(e.target.value)}>
          <option value="all">All sellers</option>
          {sellers.map((seller) => (
            <option key={seller} value={seller}>
              {seller}
            </option>
          ))}
        </select>
        <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as CollectStatus | "all")}>
          <option value="all">All status</option>
          <option value="collected">collected</option>
          <option value="failed">failed</option>
          <option value="queued">queued</option>
          <option value="unknown">unknown</option>
        </select>
        <select value={sortKey} onChange={(e) => setSortKey(e.target.value as SortKey)}>
          <option value="updated_desc">Updated desc</option>
          <option value="updated_asc">Updated asc</option>
          <option value="product_asc">Product asc</option>
          <option value="product_desc">Product desc</option>
        </select>
      </section>

      <section className="summary">
        <span>Total: {filtered.length}</span>
        <span>
          Page: {page} / {totalPages}
        </span>
      </section>
      {lastError && <section className="summary">{lastError}</section>}

      {loading ? (
        <div className="loading">Loading...</div>
      ) : (
        <main className="grid">
          {paged.map((item) => (
            <article key={`${item.productId}-${item.ownedFileId ?? item.title}`} className="card">
              <button className="thumb" onClick={() => setSelected(item)} title="Details">
                <div className="placeholder">{item.thumbnailPath ? "Thumb" : "No Thumb"}</div>
              </button>
              <div className="meta">
                <div className="product">{item.productId}</div>
                <div className="title" title={item.title}>
                  {item.title}
                </div>
                <div className="seller">{item.sellerName || "unknown"}</div>
                <div className={`status status-${item.collectStatus}`}>{item.collectStatus}</div>
              </div>
            </article>
          ))}
        </main>
      )}

      <footer className="pager">
        <button disabled={page <= 1} onClick={() => setPage((v) => v - 1)}>
          Prev
        </button>
        <button disabled={page >= totalPages} onClick={() => setPage((v) => v + 1)}>
          Next
        </button>
      </footer>

      {selected && (
        <div className="dialog-backdrop" onClick={() => setSelected(null)}>
          <div className="dialog" onClick={(e) => e.stopPropagation()}>
            <h2>{selected.productId}</h2>
            <p>{selected.title}</p>
            <p>{selected.sellerName || "unknown"}</p>
            <p className="path">{selected.pathHint || "(path hidden)"}</p>
            <div className="dialog-actions">
              <button onClick={() => void openFolder(selected)}>Open folder</button>
              <button onClick={() => void openFile(selected)}>Open file</button>
              <button onClick={() => setSelected(null)}>Close</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function sortItems(a: LibraryItem, b: LibraryItem, sortKey: SortKey): number {
  if (sortKey === "product_asc") return a.productId.localeCompare(b.productId);
  if (sortKey === "product_desc") return b.productId.localeCompare(a.productId);
  if (sortKey === "updated_asc") return byUpdated(a, b);
  return byUpdated(b, a);
}

function byUpdated(a: LibraryItem, b: LibraryItem): number {
  const at = a.updatedAt ? Date.parse(a.updatedAt) : 0;
  const bt = b.updatedAt ? Date.parse(b.updatedAt) : 0;
  return at - bt;
}

export default App;
