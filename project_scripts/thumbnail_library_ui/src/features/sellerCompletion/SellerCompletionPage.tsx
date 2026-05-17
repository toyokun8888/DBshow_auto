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

const OPEN_FOLDER_ENDPOINT = "/api/library/open-folder";
const OPEN_FILE_ENDPOINT = "/api/library/open-file";

export default function SellerCompletionPage() {
  const [sellers, setSellers] = useState<SellerSummary[]>([]);
  const [missingItems, setMissingItems] = useState<MissingProduct[]>([]);
  const [selectedSeller, setSelectedSeller] = useState<SellerSummary | null>(null);
  const [sellerQuery, setSellerQuery] = useState("");
  const [globalQuery, setGlobalQuery] = useState("");
  const [missingQuery, setMissingQuery] = useState("");
  const [hideLibraryOwned, setHideLibraryOwned] = useState(false);
  const [resultMode, setResultMode] = useState<"seller" | "global">("seller");
  const [sort, setSort] = useState<SellerSummarySort>("owned_desc");
  const [loadingSellers, setLoadingSellers] = useState(true);
  const [loadingMissing, setLoadingMissing] = useState(false);
  const [loadingFlags, setLoadingFlags] = useState(false);
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
    setResultMode("seller");
    setMissingItems([]);
    setMissingQuery("");
    setHideLibraryOwned(false);
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
      void loadSellerFlags(seller.sellerId);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "seller-missing network error");
      setMissingItems([]);
    } finally {
      setLoadingMissing(false);
    }
  }

  async function loadSellerFlags(sellerId: string) {
    if (!sellerId) return;

    setLoadingFlags(true);

    try {
      const encodedSellerId = encodeURIComponent(sellerId);
      const response = await fetch(
        `${API_BASE}/api/seller-missing/${encodedSellerId}?limit=5000&includeRapidgator=1`
      );

      if (!response.ok) {
        throw new Error(`seller flags HTTP ${response.status}`);
      }

      const body = (await response.json()) as SellerMissingResponse;

      if (!body.ok) {
        throw new Error(body.message || "seller flags failed");
      }

      const enrichByProductId = new Map(
        (body.items || []).map((item) => [item.productId, item])
      );

      setMissingItems((currentItems) =>
        currentItems.map((item) => enrichByProductId.get(item.productId) || item)
      );
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "seller flags network error");
    } finally {
      setLoadingFlags(false);
    }
  }

  async function searchAllProducts() {
    const query = globalQuery.trim();

    if (query.length < 2) {
      setErrorMessage("Search needs at least 2 characters.");
      return;
    }

    setSelectedSeller(null);
    setResultMode("global");
    setMissingItems([]);
    setMissingQuery("");
    setHideLibraryOwned(false);
    setLoadingMissing(true);
    setErrorMessage("");

    try {
      const response = await fetch(
        `${API_BASE}/api/seller-products/search?q=${encodeURIComponent(query)}&limit=5000`
      );

      if (!response.ok) {
        throw new Error(`seller-products search HTTP ${response.status}`);
      }

      const body = (await response.json()) as SellerMissingResponse;

      if (!body.ok) {
        throw new Error(body.message || "seller-products search failed");
      }

      setMissingItems(body.items || []);
    } catch (error) {
      setErrorMessage(
        error instanceof Error ? error.message : "seller-products search network error"
      );
      setMissingItems([]);
    } finally {
      setLoadingMissing(false);
    }
  }

  async function notifyError(message: string) {
    setErrorMessage(message);
    alert(message);
  }

  async function postOpen(
    endpoint: string,
    item: MissingProduct,
    actionLabel: string
  ) {
    setErrorMessage("");

    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          productId: item.productId,
          ownedFileId: null,
          fullPath: item.localFullPath || "",
        }),
      });

      const body = (await response.json().catch(() => ({}))) as {
        ok?: boolean;
        message?: string;
      };

      if (!response.ok || !body.ok) {
        const msg = body.message || `HTTP ${response.status}`;
        await notifyError(`${actionLabel} failed: ${msg}`);
      }
    } catch (error) {
      await notifyError(
        `${actionLabel} failed: ${
          error instanceof Error ? error.message : "network_error"
        }`
      );
    }
  }

  async function openFolder(item: MissingProduct) {
    await postOpen(OPEN_FOLDER_ENDPOINT, item, "Open folder");
  }

  async function openFile(item: MissingProduct) {
    await postOpen(OPEN_FILE_ENDPOINT, item, "Open file");
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
    const baseItems = hideLibraryOwned
      ? missingItems.filter((item) => !item.isLibraryOwned)
      : missingItems;

    if (!query) {
      return baseItems;
    }

    return baseItems.filter((item) => {
      return (
        item.productId.toLowerCase().includes(query) ||
        item.title.toLowerCase().includes(query) ||
        item.sellerId.toLowerCase().includes(query) ||
        item.sellerName.toLowerCase().includes(query) ||
        item.localFileName.toLowerCase().includes(query) ||
        item.localFullPath.toLowerCase().includes(query)
      );
    });
  }, [hideLibraryOwned, missingItems, missingQuery]);

  const activeStats = useMemo(() => {
    return {
      thumbnails: missingItems.filter((item) => Boolean(item.thumbnailPath)).length,
      owned: missingItems.filter((item) => item.isOwned).length,
      libraryOwned: missingItems.filter((item) => item.isLibraryOwned).length,
      missing: missingItems.filter((item) => !item.isOwned).length,
      rapidgator: missingItems.filter((item) => item.hasRapidgator).length,
    };
  }, [missingItems]);

  const hasActiveResults = selectedSeller !== null || resultMode === "global";

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

          <select
            value={selectedSeller?.sellerId || ""}
            onChange={(event) => {
              const seller = sellers.find(
                (item) => item.sellerId === event.target.value
              );

              if (seller) {
                void openSeller(seller);
              }
            }}
          >
            <option value="">Jump to seller</option>
            {filteredSellers.map((seller) => (
              <option key={seller.sellerId} value={seller.sellerId}>
                {seller.sellerName || seller.sellerId} ({seller.sellerId})
              </option>
            ))}
          </select>

          <div className="global-product-search">
            <input
              value={globalQuery}
              onChange={(event) => setGlobalQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  void searchAllProducts();
                }
              }}
              placeholder="product ID / title / seller"
            />

            <button type="button" onClick={() => void searchAllProducts()}>
              Search all
            </button>
          </div>
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
                    <span className="seller-name">
                      {seller.sellerName || seller.sellerId}
                    </span>
                    <span className="seller-rate">{seller.completionRate}%</span>
                  </div>

                  <div className="seller-row-sub">
                    <span>{seller.sellerId}</span>
                  </div>

                  <div className="seller-row-metrics">
                    <span className="seller-rate">{seller.completionRate}%</span>
                    <span>
                      {seller.ownedProducts} / {seller.totalProducts}
                    </span>
                  </div>

                  <div className="seller-progress">
                    <div
                      className="seller-progress-fill"
                      style={{
                        width: `${Math.min(
                          Math.max(seller.completionRate, 0),
                          100
                        )}%`,
                      }}
                    />
                  </div>

                  <div className="seller-missing">
                    missing: {seller.missingProducts}
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </aside>

      <main className="seller-completion-main">
        {errorMessage && (
          <div className="seller-completion-error">{errorMessage}</div>
        )}

        {!hasActiveResults ? (
          <div className="seller-empty">
            <h2>sellerを選択してください</h2>
            <p>左の一覧からsellerを選ぶと、未所持作品が表示されます。</p>
          </div>
        ) : (
          <>
            <section className="selected-seller-panel">
              <div>
                <h2>
                  {selectedSeller
                    ? selectedSeller.sellerName || selectedSeller.sellerId
                    : "Global product search"}
                </h2>
                <p>
                  {selectedSeller
                    ? selectedSeller.sellerId
                    : `query: ${globalQuery.trim()}`}
                </p>
              </div>

              <div className="selected-seller-stats">
                <div>
                  <span>所持</span>
                  <strong>{selectedSeller ? selectedSeller.ownedProducts : activeStats.owned}</strong>
                </div>
                <div>
                  <span>総作品</span>
                  <strong>{selectedSeller ? selectedSeller.totalProducts : missingItems.length}</strong>
                </div>
                <div>
                  <span>未所持</span>
                  <strong>{selectedSeller ? selectedSeller.missingProducts : activeStats.missing}</strong>
                </div>
                <div>
                  <span>達成率</span>
                  <strong>{selectedSeller ? selectedSeller.completionRate + "%" : activeStats.rapidgator}</strong>
                </div>
                <div className="selected-seller-filter">
                  <span>正規所持</span>
                  <button
                    type="button"
                    onClick={() => setHideLibraryOwned((value) => !value)}
                  >
                    {hideLibraryOwned ? "全件表示" : `除外 (${activeStats.libraryOwned})`}
                  </button>
                </div>
              </div>
            </section>

            <section className="missing-toolbar">
              <input
                value={missingQuery}
                onChange={(event) => setMissingQuery(event.target.value)}
                placeholder="未所持作品をID/タイトル/local pathで検索"
              />

              <span>
                items: {filteredMissingItems.length} / {missingItems.length} missing: {activeStats.missing}
                {hideLibraryOwned && ` library-owned excluded: ${activeStats.libraryOwned}`}
              </span>

              {selectedSeller && (
                <button
                  type="button"
                  className="missing-toolbar-button"
                  disabled={loadingMissing || loadingFlags}
                  onClick={() => void loadSellerFlags(selectedSeller.sellerId)}
                >
                  {loadingFlags ? "Loading flags..." : "Load flags"}
                </button>
              )}
            </section>

            {loadingMissing ? (
              <div className="seller-completion-loading">missing loading...</div>
            ) : (
              <section className="missing-list">
                {filteredMissingItems.map((item) => {
                  const productIdClass = item.hasMp4
                    ? "missing-product-id available"
                    : item.hasRapidgator
                      ? "missing-product-id rar-only"
                      : "missing-product-id unavailable";

                  const cardClass = item.localFileExists
                    ? "missing-card local-file-exists"
                    : "missing-card";

                  const canOpenLocalFile =
                    item.localFileExists &&
                    item.localFullPath.trim().length > 0;

                  return (
                    <article key={item.productId} className={cardClass}>
                      <div className="missing-card-header">
                        <div className="missing-card-main">
                          <div className="missing-thumb">
                            {item.thumbnailPath ? (
                              <img
                                src={`${API_BASE}${item.thumbnailPath}`}
                                alt=""
                                loading="lazy"
                              />
                            ) : (
                              <span>No Thumb</span>
                            )}
                          </div>

                          <div className="missing-card-text">
                            <div className={productIdClass}>{item.productId}</div>

                            <div className="missing-title">
                              {item.title || "(no title)"}
                            </div>

                            <div className="missing-seller">
                              {item.sellerName || item.sellerId || "seller unknown"}
                              {item.isOwned && <span>owned</span>}
                              {item.isLibraryOwned && <span>library</span>}
                              {item.thumbnailStatus && (
                                <span>thumb: {item.thumbnailStatus}</span>
                              )}
                            </div>
                          </div>
                        </div>

                        <div className="missing-actions">
                          <button
                            type="button"
                            className="missing-action-button mp4"
                            disabled={!item.rapidgatorMp4Url}
                            onClick={() => {
                              if (!item.rapidgatorMp4Url) {
                                alert("mp4ありません");
                                return;
                              }

                              window.open(item.rapidgatorMp4Url, "_blank");
                            }}
                          >
                            MP4
                          </button>

                          <button
                            type="button"
                            className="missing-action-button page"
                            disabled={!item.rapidgatorPageUrl}
                            onClick={() => {
                              if (!item.rapidgatorPageUrl) {
                                alert("pageありません");
                                return;
                              }

                              window.open(item.rapidgatorPageUrl, "_blank");
                            }}
                          >
                            PAGE
                          </button>

                          <button
                            type="button"
                            className="missing-action-button rar"
                            disabled={
                              !item.hasRar ||
                              !item.rapidgatorAllUrls ||
                              item.rapidgatorAllUrls.length === 0
                            }
                            onClick={async () => {
                              const urls = item.rapidgatorAllUrls || [];

                              if (urls.length === 0) {
                                alert("rarありません");
                                return;
                              }

                              const tabs = urls.map(() =>
                                window.open("about:blank", "_blank")
                              );

                              const blockedCount = tabs.filter((tab) => !tab).length;

                              if (blockedCount > 0) {
                                alert(
                                  `ブラウザにより ${blockedCount} 個のタブがブロックされました。ポップアップ許可を確認してください。`
                                );
                              }

                              for (let i = 0; i < urls.length; i += 1) {
                                const tab = tabs[i];

                                if (!tab) {
                                  continue;
                                }

                                const wait =
                                  2000 + Math.floor(Math.random() * 2000);

                                await new Promise((resolve) =>
                                  setTimeout(resolve, wait)
                                );

                                tab.location.href = urls[i];
                              }
                            }}
                          >
                            PARTS({item.rapidgatorRarCount})
                          </button>
                        </div>
                      </div>

                      {item.localFileExists && (
                        <div className="missing-local-file-meta">
                          <strong>実ファイル候補あり</strong>
                          <span>count: {item.localFileCount}</span>
                          {item.localFileName && <span>{item.localFileName}</span>}
                          {item.localFullPath && <span>{item.localFullPath}</span>}

                          <div className="missing-local-actions">
                            <button
                              type="button"
                              className="missing-action-button local"
                              disabled={!canOpenLocalFile}
                              onClick={() => void openFile(item)}
                            >
                              Open file
                            </button>

                            <button
                              type="button"
                              className="missing-action-button local-folder"
                              disabled={!canOpenLocalFile}
                              onClick={() => void openFolder(item)}
                            >
                              Open folder
                            </button>
                          </div>
                        </div>
                      )}

                      {item.hasRapidgator && (
                        <div className="missing-rapidgator-meta">
                          <span>total: {item.rapidgatorTotalRecords}</span>
                          <span>mp4: {item.rapidgatorMp4Count}</span>
                          <span>rar: {item.rapidgatorRarCount}</span>
                          {item.rapidgatorMp4Size && (
                            <span>{item.rapidgatorMp4Size}</span>
                          )}
                        </div>
                      )}
                    </article>
                  );
                })}

                {filteredMissingItems.length === 0 && (
                  <div className="seller-empty">
                    <h2>未所持なし</h2>
                    <p>
                      このsellerはコンプリート済み、または検索条件に一致しません。
                    </p>
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
