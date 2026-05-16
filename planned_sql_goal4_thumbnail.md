# Goal 4 Thumbnail SQL Draft

## 重要: このファイルは旧採番の草案

このファイル内のSQLは、このまま適用しない。実行前に `TM` / `TL` 番号を再決定し、SQL内のテーブル名とインデックス名を更新する。

現行DBでは `TM006` は `xxx_tm006_fc2_article_master_full` / stage系、`TL002` は `xxx_tl002_rapidgator_raw` が使用している。

`Goal 4`（サムネイル収集）用のテーブル草案です。  
`planned_sql.md` 本体を汚さずに、このファイルを先に適用できます。

## 2026-05-16 Note

このSQL案は旧採番のまま残っている。現行DB確認では、`xxx_tm006_thumbnail_assets` と `xxx_tl002_thumbnail_jobs` は未作成だった。

ただし、`TM006` はすでに `xxx_tm006_fc2_article_master_full` / stage系が使用しており、`TL002` は `xxx_tl002_rapidgator_raw` が使用している。実行前にサムネイル系の正式番号を再決定すること。

現時点の推奨:

- asset master: `xxx_tm007_thumbnail_assets` など、次の空き `TM` 番号へ変更する。
- job log: `xxx_tl003_thumbnail_jobs` など、次の空き `TL` 番号へ変更する。
- コード側の `xxx_tm006_thumbnail_assets` 参照変更は、DB作成SQLの採番決定後に同じ作業単位で行う。

## 1) Asset Master 旧案 (`xxx_tm006_thumbnail_assets`)

```sql
CREATE TABLE IF NOT EXISTS public.xxx_tm006_thumbnail_assets (
    product_id text PRIMARY KEY,
    priority_bucket text NOT NULL,
    source_name text,
    thumbnail_path text,
    thumbnail_file_name text,
    collect_status text NOT NULL, -- queued | collected | failed | skipped
    error_message text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);
```

```sql
CREATE INDEX IF NOT EXISTS xxx_idx_tm006_collect_status
    ON public.xxx_tm006_thumbnail_assets (collect_status);

CREATE INDEX IF NOT EXISTS xxx_idx_tm006_priority_bucket
    ON public.xxx_tm006_thumbnail_assets (priority_bucket);
```

## 2) Job Log 旧案 (`xxx_tl002_thumbnail_jobs`)

```sql
CREATE TABLE IF NOT EXISTS public.xxx_tl002_thumbnail_jobs (
    id bigserial PRIMARY KEY,
    run_id text NOT NULL,
    product_id text NOT NULL,
    priority_bucket text,
    source_name text,
    status text NOT NULL, -- success | error | dry_run
    thumbnail_path text,
    error_message text,
    processed_at timestamptz NOT NULL DEFAULT now()
);
```

```sql
CREATE INDEX IF NOT EXISTS xxx_idx_tl002_run_id
    ON public.xxx_tl002_thumbnail_jobs (run_id);

CREATE INDEX IF NOT EXISTS xxx_idx_tl002_product_id
    ON public.xxx_tl002_thumbnail_jobs (product_id);

CREATE INDEX IF NOT EXISTS xxx_idx_tl002_status
    ON public.xxx_tl002_thumbnail_jobs (status);
```
