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

    if (!query) {
      return missingItems;
    }

    return missingItems.filter((item) => {
      return (
        item.productId.toLowerCase().includes(query) ||
        item.title.toLowerCase().includes(query) ||
        item.localFileName.toLowerCase().includes(query) ||
        item.localFullPath.toLowerCase().includes(query)
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
                    <span className="seller-name">
                      {seller.sellerName || seller.sellerId}
                    </span>
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
                placeholder="未所持作品をID/タイトル/local pathで検索"
              />

              <span>
                missing: {filteredMissingItems.length} / {missingItems.length}
              </span>
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
                        <div className={productIdClass}>{item.productId}</div>

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

                      <div className="missing-title">{item.title || "(no title)"}</div>

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