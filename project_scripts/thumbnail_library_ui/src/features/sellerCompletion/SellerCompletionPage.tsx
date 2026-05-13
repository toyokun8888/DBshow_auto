import { useEffect, useMemo, useState } from "react";
import type {
  MissingProduct,
  SellerMissingResponse,
  SellerSummary,
  SellerSummaryResponse,
  SellerSummarySort,
} from "./types";
import "./sellerCompletion.css";

const API_BASE = "http://localhost:3001";

export default function SellerCompletionPage() {
  const [sellers, setSellers] = useState<SellerSummary[]>([]);
  const [missingItems, setMissingItems] = useState<MissingProduct[]>([]);
  const [selectedSeller, setSelectedSeller] = useState<SellerSummary | null>(null);
  const [sellerQuery, setSellerQuery] = useState("");
  const [missingQuery, setMissingQuery] = useState("");
  const [sort, setSort] = useState<SellerSummarySort>("missing_asc");
  const [loadingSellers, setLoadingSellers] = useState(true);
  const [loadingMissing, setLoadingMissing] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");

  useEffect(() => {
    void loadSellers(sort);
  }, [sort]);

  async function loadSellers(nextSort: SellerSummarySort) {
    setLoadingSellers(true);
    setErrorMessage("");

    try {
      const response = await fetch(`${API_BASE}/api/seller-summary?sort=${nextSort}`);

      if (!response.ok) {
        throw new Error(`seller-summary HTTP ${response.status}`);
      }

      const body = (await response.json()) as SellerSummaryResponse;

      if (!body.ok) {
        throw new Error(body.message || "seller-summary failed");
      }

      setSellers(body.sellers || []);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "seller-summary network error");
      setSellers([]);
    } finally {
      setLoadingSellers(false);
    }
  }

  async function openSeller(seller: SellerSummary) {
    setSelectedSeller(seller);
    setMissingItems([]);
    setMissingQuery("");
    setLoadingMissing(true);
    setErrorMessage("");

    try {
      const encodedSellerId = encodeURIComponent(seller.sellerId);
      const response = await fetch(`${API_BASE}/api/seller-missing/${encodedSellerId}?limit=5000`);

      if (!response.ok) {
        throw new Error(`seller-missing HTTP ${response.status}`);
      }

      const body = (await response.json()) as SellerMissingResponse;

      if (!body.ok) {
        throw new Error(body.message || "seller-missing failed");
      }

      setMissingItems(body.items || []);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "seller-missing network error");
      setMissingItems([]);
    } finally {
      setLoadingMissing(false);
    }
  }

  const filteredSellers = useMemo(() => {
    const query = sellerQuery.trim().toLowerCase();

    if (!query) {
      return sellers;
    }

    return sellers.filter((seller) => {
      return (
        seller.sellerId.toLowerCase().includes(query) ||
        seller.sellerName.toLowerCase().includes(query)
      );
    });
  }, [sellers, sellerQuery]);

  const filteredMissingItems = useMemo(() => {
    const query = missingQuery.trim().toLowerCase();

    if (!query) {
      return missingItems;
    }

    return missingItems.filter((item) => {
      return (
        item.productId.toLowerCase().includes(query) ||
        item.title.toLowerCase().includes(query)
      );
    });
  }, [missingItems, missingQuery]);

  return (
    <div className="seller-completion-page">
      <aside className="seller-completion-sidebar">
        <div className="seller-completion-header">
          <div>
            <h1>Seller Completion</h1>
            <p>所持済みsellerを基準に、未所持作品を確認します。</p>
          </div>

          <button type="button" onClick={() => void loadSellers(sort)}>
            Reload
          </button>
        </div>

        <div className="seller-completion-controls">
          <input
            value={sellerQuery}
            onChange={(event) => setSellerQuery(event.target.value)}
            placeholder="seller検索"
          />

          <select
            value={sort}
            onChange={(event) => setSort(event.target.value as SellerSummarySort)}
          >
            <option value="missing_asc">未所持 少ない順</option>
            <option value="missing_desc">未所持 多い順</option>
            <option value="owned_desc">所持 多い順</option>
            <option value="total_desc">総作品 多い順</option>
          </select>
        </div>

        <div className="seller-completion-count">
          sellers: {filteredSellers.length} / {sellers.length}
        </div>

        {loadingSellers ? (
          <div className="seller-completion-loading">seller loading...</div>
        ) : (
          <div className="seller-list">
            {filteredSellers.map((seller) => {
              const selected = selectedSeller?.sellerId === seller.sellerId;

              return (
                <button
                  key={seller.sellerId}
                  type="button"
                  className={selected ? "seller-row selected" : "seller-row"}
                  onClick={() => void openSeller(seller)}
                >
                  <div className="seller-row-main">
                    <span className="seller-name">{seller.sellerName || seller.sellerId}</span>
                    <span className="seller-rate">{seller.completionRate}%</span>
                  </div>

                  <div className="seller-row-sub">
                    <span>{seller.sellerId}</span>
                    <span>
                      {seller.ownedProducts} / {seller.totalProducts}
                    </span>
                  </div>

                  <div className="seller-progress">
                    <div
                      className="seller-progress-fill"
                      style={{ width: `${Math.min(Math.max(seller.completionRate, 0), 100)}%` }}
                    />
                  </div>

                  <div className="seller-missing">missing: {seller.missingProducts}</div>
                </button>
              );
            })}
          </div>
        )}
      </aside>

      <main className="seller-completion-main">
        {errorMessage && <div className="seller-completion-error">{errorMessage}</div>}

        {!selectedSeller ? (
          <div className="seller-empty">
            <h2>sellerを選択してください</h2>
            <p>左の一覧からsellerを選ぶと、未所持作品が表示されます。</p>
          </div>
        ) : (
          <>
            <section className="selected-seller-panel">
              <div>
                <h2>{selectedSeller.sellerName || selectedSeller.sellerId}</h2>
                <p>{selectedSeller.sellerId}</p>
              </div>

              <div className="selected-seller-stats">
                <div>
                  <span>所持</span>
                  <strong>{selectedSeller.ownedProducts}</strong>
                </div>
                <div>
                  <span>総作品</span>
                  <strong>{selectedSeller.totalProducts}</strong>
                </div>
                <div>
                  <span>未所持</span>
                  <strong>{selectedSeller.missingProducts}</strong>
                </div>
                <div>
                  <span>達成率</span>
                  <strong>{selectedSeller.completionRate}%</strong>
                </div>
              </div>
            </section>

            <section className="missing-toolbar">
              <input
                value={missingQuery}
                onChange={(event) => setMissingQuery(event.target.value)}
                placeholder="未所持作品をID/タイトルで検索"
              />

              <span>
                missing: {filteredMissingItems.length} / {missingItems.length}
              </span>
            </section>

            {loadingMissing ? (
              <div className="seller-completion-loading">missing loading...</div>
            ) : (
              <section className="missing-list">
                {filteredMissingItems.map((item) => (
                  <article key={item.productId} className="missing-card">
                    <div className="missing-product-id">{item.productId}</div>
                    <div className="missing-title">{item.title || "(no title)"}</div>
                  </article>
                ))}

                {filteredMissingItems.length === 0 && (
                  <div className="seller-empty">
                    <h2>未所持なし</h2>
                    <p>このsellerはコンプリート済み、または検索条件に一致しません。</p>
                  </div>
                )}
              </section>
            )}
          </>
        )}
      </main>
    </div>
  );
}