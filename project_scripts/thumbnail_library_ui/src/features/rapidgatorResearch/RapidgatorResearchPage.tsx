import { useEffect, useMemo, useState } from "react";

import "./rapidgatorResearch.css";

import type {
  RapidgatorGroupItem,
  RapidgatorGroupSummary,
  RapidgatorGroupItemsResponse,
  RapidgatorGroupSummaryResponse,
} from "./types";

function RapidgatorResearchPage() {
  const [groups, setGroups] = useState<RapidgatorGroupSummary[]>([]);
  const [selectedGroup, setSelectedGroup] =
    useState<RapidgatorGroupSummary | null>(null);

  const [items, setItems] = useState<RapidgatorGroupItem[]>([]);

  const [loadingGroups, setLoadingGroups] = useState(false);
  const [loadingItems, setLoadingItems] = useState(false);

  const [error, setError] = useState("");

  const [groupSearch, setGroupSearch] = useState("");
  const [itemSearch, setItemSearch] = useState("");

  useEffect(() => {
    loadGroups();
  }, []);

  async function loadGroups() {
    try {
      setLoadingGroups(true);
      setError("");

      const response = await fetch(
        "http://localhost:3001/api/rapidgator/groups"
      );

      const data: RapidgatorGroupSummaryResponse =
        await response.json();

      if (!data.ok) {
        throw new Error(data.message || "group load failed");
      }

      setGroups(data.groups);
    } catch (err) {
      console.error(err);

      setError(
        err instanceof Error
          ? err.message
          : "group load error"
      );
    } finally {
      setLoadingGroups(false);
    }
  }

  async function loadItems(groupKey: string) {
    try {
      setLoadingItems(true);
      setError("");

      const response = await fetch(
        `http://localhost:3001/api/rapidgator/group/${encodeURIComponent(
          groupKey
        )}/items`
      );

      const data: RapidgatorGroupItemsResponse =
        await response.json();

      if (!data.ok) {
        throw new Error(data.message || "item load failed");
      }

      setItems(data.items);
    } catch (err) {
      console.error(err);

      setError(
        err instanceof Error
          ? err.message
          : "item load error"
      );
    } finally {
      setLoadingItems(false);
    }
  }

  const filteredGroups = useMemo(() => {
    const keyword = groupSearch.trim().toLowerCase();

    if (!keyword) {
      return groups;
    }

    return groups.filter((group) => {
      return (
        group.groupKey.toLowerCase().includes(keyword) ||
        group.groupRule.toLowerCase().includes(keyword)
      );
    });
  }, [groups, groupSearch]);

  const filteredItems = useMemo(() => {
    const keyword = itemSearch.trim().toLowerCase();

    if (!keyword) {
      return items;
    }

    return items.filter((item) => {
      return (
        item.fileTitle.toLowerCase().includes(keyword) ||
        item.baseTitle.toLowerCase().includes(keyword)
      );
    });
  }, [items, itemSearch]);

  return (
    <div className="rapidgator-research-page">
      <aside className="rapidgator-research-sidebar">
        <div className="rapidgator-research-header">
          <div>
            <h1>Rapidgator Research</h1>

            <p>
              グループ別にDL可能ファイルを調査
            </p>
          </div>

          <button onClick={loadGroups}>
            Reload
          </button>
        </div>

        <div className="rapidgator-research-controls">
          <input
            type="text"
            placeholder="group search..."
            value={groupSearch}
            onChange={(e) =>
              setGroupSearch(e.target.value)
            }
          />
        </div>

        <div className="rapidgator-research-count">
          {filteredGroups.length.toLocaleString()} groups
        </div>

        {loadingGroups ? (
          <div className="rapidgator-research-loading">
            loading...
          </div>
        ) : (
          <div className="rapidgator-group-list">
            {filteredGroups.map((group) => {
              const selected =
                selectedGroup?.groupKey ===
                group.groupKey;

              return (
                <button
                  key={group.groupKey}
                  type="button"
                  className={`rapidgator-group-row ${
                    selected ? "selected" : ""
                  }`}
                  onClick={() => {
                    setSelectedGroup(group);
                    loadItems(group.groupKey);
                  }}
                >
                  <div className="rapidgator-group-row-main">
                    <div className="rapidgator-group-name">
                      {group.groupKey || "(unknown)"}
                    </div>

                    <div className="rapidgator-group-count">
                      {group.totalRecords.toLocaleString()}
                    </div>
                  </div>

                  <div className="rapidgator-group-row-sub">
                    <span>
                      mp4 {group.mp4Count}
                    </span>

                    <span>
                      rar {group.rarCount}
                    </span>
                  </div>

                  <div className="rapidgator-group-exts">
                    {group.fileExtList.join(", ")}
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </aside>

      <main className="rapidgator-research-main">
        {error && (
          <div className="rapidgator-research-error">
            {error}
          </div>
        )}

        {!selectedGroup ? (
          <div className="rapidgator-research-empty">
            <h2>Group Select</h2>

            <p>
              左からgroupを選択してください
            </p>
          </div>
        ) : (
          <>
            <div className="rapidgator-selected-group-panel">
              <div>
                <h2>
                  {selectedGroup.groupKey}
                </h2>

                <p>
                  {selectedGroup.groupRule}
                </p>
              </div>

              <div className="rapidgator-selected-group-stats">
                <div>
                  <span>Total</span>

                  <strong>
                    {selectedGroup.totalRecords.toLocaleString()}
                  </strong>
                </div>

                <div>
                  <span>mp4</span>

                  <strong>
                    {selectedGroup.mp4Count.toLocaleString()}
                  </strong>
                </div>

                <div>
                  <span>rar</span>

                  <strong>
                    {selectedGroup.rarCount.toLocaleString()}
                  </strong>
                </div>

                <div>
                  <span>Titles</span>

                  <strong>
                    {selectedGroup.uniqueTitles.toLocaleString()}
                  </strong>
                </div>
              </div>
            </div>

            <div className="rapidgator-items-toolbar">
              <input
                type="text"
                placeholder="title search..."
                value={itemSearch}
                onChange={(e) =>
                  setItemSearch(e.target.value)
                }
              />

              <span>
                {filteredItems.length.toLocaleString()} items
              </span>
            </div>

            {loadingItems ? (
              <div className="rapidgator-research-loading">
                loading items...
              </div>
            ) : (
              <div className="rapidgator-item-list">
                {filteredItems.map((item, index) => (
                  <div
                    key={`${item.baseTitle}_${index}`}
                    className="rapidgator-item-card"
                  >
                    <div className="rapidgator-item-header">
                      <div>
                        <div className="rapidgator-item-title">
                          {item.baseTitle}
                        </div>

                        <div className="rapidgator-item-file">
                          {item.fileTitle}
                        </div>
                      </div>

                      <div className="rapidgator-item-actions">
                        <button
                          type="button"
                          className="rapidgator-action-button mp4"
                          disabled={
                            !item.rapidgatorMp4Url
                          }
                          onClick={() => {
                            if (
                              !item.rapidgatorMp4Url
                            ) {
                              alert(
                                "mp4ありません"
                              );

                              return;
                            }

                            window.open(
                              item.rapidgatorMp4Url,
                              "_blank"
                            );
                          }}
                        >
                          MP4
                        </button>

                        <button
                          type="button"
                          className="rapidgator-action-button page"
                          disabled={
                            !item.rapidgatorPageUrl
                          }
                          onClick={() => {
                            if (
                              !item.rapidgatorPageUrl
                            ) {
                              alert(
                                "pageありません"
                              );

                              return;
                            }

                            window.open(
                              item.rapidgatorPageUrl,
                              "_blank"
                            );
                          }}
                        >
                          PAGE
                        </button>

                        <button
                          type="button"
                          className="rapidgator-action-button rar"
                          disabled={
                            !item.hasRar ||
                            !item.rapidgatorAllUrls ||
                            item.rapidgatorAllUrls
                              .length === 0
                          }
                          onClick={async () => {
                            const urls =
                              item.rapidgatorAllUrls ||
                              [];

                            if (
                              urls.length === 0
                            ) {
                              alert(
                                "rarありません"
                              );

                              return;
                            }

                            const tabs =
                              urls.map(() =>
                                window.open(
                                  "about:blank",
                                  "_blank"
                                )
                              );

                            for (
                              let i = 0;
                              i < urls.length;
                              i += 1
                            ) {
                              const tab =
                                tabs[i];

                              if (!tab) {
                                continue;
                              }

                              const wait =
                                2000 +
                                Math.floor(
                                  Math.random() *
                                    2000
                                );

                              await new Promise(
                                (resolve) =>
                                  setTimeout(
                                    resolve,
                                    wait
                                  )
                              );

                              tab.location.href =
                                urls[i];
                            }
                          }}
                        >
                          PARTS(
                          {item.rarCount})
                        </button>
                      </div>
                    </div>

                    <div className="rapidgator-item-meta">
                      <span>
                        ext: {item.fileExt}
                      </span>

                      <span>
                        size: {item.fileSize}
                      </span>

                      <span>
                        total:{" "}
                        {item.totalRecords}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </main>
    </div>
  );
}

export default RapidgatorResearchPage;