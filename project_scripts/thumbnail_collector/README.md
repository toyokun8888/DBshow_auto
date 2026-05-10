# Thumbnail Collector (Goal 4)

`Goal 4` 向けのサムネイル収集スクリプトです。  
優先順で `product_id` をキュー化し、`dry-run` / `execute` で動かせます。

## File

- [thumbnail_collector.js](/C:/Users/toyoaki/Desktop/filedatachange/project_scripts/thumbnail_collector/thumbnail_collector.js)

## 先に変更する場所（コメント付き）

`thumbnail_collector.js` 内の以下コメントを目印に、あとで実値に置き換えてください。

- `TODO(CONFIG_PATH)`  
  - `thumbnailRootDir`
  - `csvLogDir`
  - `knownPriorityListPath`
  - `wishListPath`
- `TODO(DB)`  
  - `dbMasterView`
  - `dbOwnedTable`
  - `dbThumbnailTable`
  - `dbThumbnailJobLogTable`
- `TODO(DB_QUERY)`  
  - `sqlPriorityOwned`
  - `sqlPriorityRest`
- `TODO(API_CONFIG)`  
  - `.env` の `GOOGLE_CSE_API_KEY`
  - `.env` の `GOOGLE_CSE_CX`
  - `.env` の `SCRAPE_API_ENDPOINT`

## 実行

サンプルワークスペース作成:

```powershell
node project_scripts\thumbnail_collector\thumbnail_collector.js --init-sample
```

dry-run:

```powershell
node project_scripts\thumbnail_collector\thumbnail_collector.js --mode dry-run --daily-limit 100
```

本実行:

```powershell
node project_scripts\thumbnail_collector\thumbnail_collector.js --mode execute --confirm-execute YES --daily-limit 100
```

## 出力

- CSV: `thumbnail_collect_{run_id}.csv`
- `execute` 時:
  - サムネイル画像を保存
  - `xxx_tm006_thumbnail_assets` にUPSERT
  - `xxx_tl002_thumbnail_jobs` にログINSERT

## 参考（公式）

- Google Custom Search JSON API overview  
  https://developers.google.com/custom-search/v1/overview
- Google Custom Search `cse.list` (image検索は `searchType=image`)  
  https://developers.google.com/custom-search/v1/reference/rest/v1/cse/list
- Node.js `fetch` / globals  
  https://nodejs.org/api/globals.html
