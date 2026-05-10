# Goal 4 Thumbnail SQL Draft

`Goal 4`（サムネイル収集）用のテーブル草案です。  
`planned_sql.md` 本体を汚さずに、このファイルを先に適用できます。

## 1) Asset Master (`xxx_tm006_thumbnail_assets`)

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

## 2) Job Log (`xxx_tl002_thumbnail_jobs`)

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
