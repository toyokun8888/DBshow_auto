-- Sukebei FC2 torrent downloader additive schema.
-- Safe to run repeatedly. No DROP/TRUNCATE/destructive change.

CREATE TABLE IF NOT EXISTS public.xxx_tm012_sukebei_torrent_downloads (
    id bigserial PRIMARY KEY,
    product_id text NOT NULL,
    torrent_url text NOT NULL,
    torrent_page_url text,
    torrent_title text,
    downloaded_file_path text,
    status text NOT NULL DEFAULT 'reserved',
    downloaded_at timestamp with time zone,
    last_checked_at timestamp with time zone NOT NULL DEFAULT now(),
    last_error text,
    created_at timestamp with time zone NOT NULL DEFAULT now(),
    updated_at timestamp with time zone NOT NULL DEFAULT now(),
    CONSTRAINT xxx_uq_tm012_sukebei_torrent_url UNIQUE (torrent_url),
    CONSTRAINT xxx_chk_tm012_sukebei_status
        CHECK (status IN ('reserved', 'downloaded', 'dry_run', 'skipped_duplicate', 'error'))
);

CREATE INDEX IF NOT EXISTS xxx_idx_tm012_sukebei_product_id
    ON public.xxx_tm012_sukebei_torrent_downloads (product_id);

CREATE INDEX IF NOT EXISTS xxx_idx_tm012_sukebei_status
    ON public.xxx_tm012_sukebei_torrent_downloads (status);

CREATE INDEX IF NOT EXISTS xxx_idx_tm012_sukebei_downloaded_at
    ON public.xxx_tm012_sukebei_torrent_downloads (downloaded_at);

-- Current match source for Sukebei downloader:
--   public.xxx_tl005_fc2_delta_thumbnail_target_logs
--   action = 'enqueue'
--   result_status = 'pending'
--   latest 100 product_id by log id, excluding product_id already recorded as downloaded/reserved.
--
-- Preview the current eligible product_id set.
WITH latest AS (
    SELECT
        product_id,
        MAX(id) AS latest_log_id,
        MAX(recorded_at) AS latest_recorded_at
    FROM public.xxx_tl005_fc2_delta_thumbnail_target_logs
    WHERE action = 'enqueue'
      AND result_status = 'pending'
      AND product_id IS NOT NULL
    GROUP BY product_id
),
eligible AS (
    SELECT latest.*
    FROM latest
    WHERE NOT EXISTS (
        SELECT 1
        FROM public.xxx_tm012_sukebei_torrent_downloads downloaded
        WHERE downloaded.product_id = latest.product_id
          AND downloaded.status IN ('reserved', 'downloaded', 'dry_run', 'skipped_duplicate')
    )
    ORDER BY latest_log_id DESC
    LIMIT 100
)
SELECT COUNT(*) AS eligible_latest_log_products
FROM eligible;

-- Verification.
SELECT to_regclass('public.xxx_tm012_sukebei_torrent_downloads') AS sukebei_download_table;
