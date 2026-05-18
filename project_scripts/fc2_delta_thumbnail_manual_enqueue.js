const { Client } = require("pg");
require("dotenv").config({ quiet: true });

const TABLE_FULL = "xxx_tm006_fc2_article_master_full";
const TABLE_TARGETS = "xxx_tm010_fc2_delta_thumbnail_targets";
const TABLE_TARGET_LOGS = "xxx_tl005_fc2_delta_thumbnail_target_logs";
const TABLE_WIKI_SELLERS = "xxx_tm007_fc2_wiki_sellers";
const TABLE_THUMBNAIL_ASSETS = "xxx_tm009_fc2_wiki_thumbnail_assets";

const MODE = process.env.FC2_DELTA_MANUAL_ENQUEUE_MODE || "preview";
const LOOKBACK_HOURS = Math.min(
  Math.max(Number(process.env.FC2_DELTA_MANUAL_ENQUEUE_LOOKBACK_HOURS || 12), 1),
  72
);
const MAX_PAGE = Math.min(
  Math.max(Number(process.env.FC2_DELTA_MANUAL_ENQUEUE_MAX_PAGE || 25), 1),
  100
);
const SOURCE_RUN_ID =
  process.env.FC2_DELTA_MANUAL_ENQUEUE_RUN_ID ||
  `manual_delta_thumbnail_enqueue_${new Date().toISOString().replace(/[-:T.]/g, "").slice(0, 14)}_${process.pid}`;

const DB_CONFIG = {
  host: requireEnv("PGHOST"),
  port: Number(process.env.PGPORT || 5432),
  database: requireEnv("PGDATABASE"),
  user: requireEnv("PGUSER"),
  password: requireEnv("PGPASSWORD"),
  ssl:
    (process.env.PGSSL || "false").toLowerCase() === "true"
      ? { rejectUnauthorized: false }
      : false,
};

function requireEnv(name) {
  const value = process.env[name];
  if (!value || value.startsWith("CHANGE_ME_")) {
    throw new Error(`${name} is not configured`);
  }
  return value;
}

async function ensureTables(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS public.${TABLE_TARGETS} (
      product_id text PRIMARY KEY,
      source_run_id text NOT NULL,
      source_collected_at timestamptz,
      article_url text,
      search_page_url text,
      page_number integer,
      row_index_in_page integer,
      article_seller_id text,
      article_seller_name text,
      wiki_seller_id bigint,
      wiki_seller_name text,
      target_status text NOT NULL DEFAULT 'pending',
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
  `);

  await client.query(`
    CREATE TABLE IF NOT EXISTS public.${TABLE_TARGET_LOGS} (
      id bigserial PRIMARY KEY,
      run_id text NOT NULL,
      product_id text NOT NULL,
      article_seller_id text,
      article_seller_name text,
      wiki_seller_id bigint,
      wiki_seller_name text,
      action text NOT NULL,
      result_status text NOT NULL,
      detail text,
      recorded_at timestamptz NOT NULL DEFAULT now()
    );
  `);
}

async function printRecentBuckets(client) {
  const result = await client.query(
    `
      SELECT
        date_trunc('hour', collected_at) AS collected_hour,
        count(*) AS rows,
        count(DISTINCT product_id) AS products,
        min(page_number) AS min_page,
        max(page_number) AS max_page,
        count(DISTINCT page_number) AS pages,
        max(CASE WHEN product_id ~ '^\\d+$' THEN product_id::numeric END) AS max_product_id
      FROM public.${TABLE_FULL}
      WHERE collected_at >= now() - ($1::int * interval '1 hour')
      GROUP BY 1
      ORDER BY 1 DESC
    `,
    [LOOKBACK_HOURS]
  );

  console.table(result.rows);
}

async function enqueueTargets(client) {
  const insertTargets = await client.query(
    `
      INSERT INTO public.${TABLE_TARGETS} (
        product_id,
        source_run_id,
        source_collected_at,
        article_url,
        search_page_url,
        page_number,
        row_index_in_page,
        article_seller_id,
        article_seller_name,
        wiki_seller_id,
        wiki_seller_name,
        target_status,
        updated_at
      )
      SELECT DISTINCT ON (f.product_id)
        f.product_id,
        $1,
        f.collected_at,
        f.article_url,
        f.search_page_url,
        f.page_number,
        f.row_index_in_page,
        f.seller_id,
        f.seller_name,
        ws.id,
        ws.seller_name,
        'pending',
        now()
      FROM public.${TABLE_FULL} f
      JOIN public.${TABLE_WIKI_SELLERS} ws
        ON ws.seller_name = f.seller_name
       AND ws.is_active = true
       AND ws.is_archived = false
      LEFT JOIN public.${TABLE_THUMBNAIL_ASSETS} ta
        ON ta.product_id = f.product_id
       AND ta.thumbnail_status = 'collected'
      WHERE f.collected_at >= now() - ($2::int * interval '1 hour')
        AND f.page_number BETWEEN 1 AND $3
        AND ta.product_id IS NULL
      ORDER BY
        f.product_id,
        f.page_number ASC NULLS LAST,
        f.row_index_in_page ASC NULLS LAST,
        f.collected_at DESC
      ON CONFLICT (product_id) DO UPDATE SET
        source_run_id = EXCLUDED.source_run_id,
        source_collected_at = EXCLUDED.source_collected_at,
        article_url = EXCLUDED.article_url,
        search_page_url = EXCLUDED.search_page_url,
        page_number = EXCLUDED.page_number,
        row_index_in_page = EXCLUDED.row_index_in_page,
        article_seller_id = EXCLUDED.article_seller_id,
        article_seller_name = EXCLUDED.article_seller_name,
        wiki_seller_id = EXCLUDED.wiki_seller_id,
        wiki_seller_name = EXCLUDED.wiki_seller_name,
        target_status = 'pending',
        updated_at = now()
    `,
    [SOURCE_RUN_ID, LOOKBACK_HOURS, MAX_PAGE]
  );

  const insertLogs = await client.query(
    `
      INSERT INTO public.${TABLE_TARGET_LOGS} (
        run_id,
        product_id,
        article_seller_id,
        article_seller_name,
        wiki_seller_id,
        wiki_seller_name,
        action,
        result_status,
        detail
      )
      SELECT DISTINCT ON (f.product_id)
        $1,
        f.product_id,
        f.seller_id,
        f.seller_name,
        ws.id,
        ws.seller_name,
        'manual_enqueue',
        'pending',
        'manual recovery from recent article full records'
      FROM public.${TABLE_FULL} f
      JOIN public.${TABLE_WIKI_SELLERS} ws
        ON ws.seller_name = f.seller_name
       AND ws.is_active = true
       AND ws.is_archived = false
      LEFT JOIN public.${TABLE_THUMBNAIL_ASSETS} ta
        ON ta.product_id = f.product_id
       AND ta.thumbnail_status = 'collected'
      WHERE f.collected_at >= now() - ($2::int * interval '1 hour')
        AND f.page_number BETWEEN 1 AND $3
        AND ta.product_id IS NULL
      ORDER BY
        f.product_id,
        f.page_number ASC NULLS LAST,
        f.row_index_in_page ASC NULLS LAST,
        f.collected_at DESC
    `,
    [SOURCE_RUN_ID, LOOKBACK_HOURS, MAX_PAGE]
  );

  return {
    targets: insertTargets.rowCount,
    logs: insertLogs.rowCount,
  };
}

async function printQueuedSummary(client) {
  const result = await client.query(`
    SELECT
      target_status,
      count(*) AS rows,
      min(source_collected_at) AS min_source_collected_at,
      max(source_collected_at) AS max_source_collected_at,
      min(page_number) AS min_page,
      max(page_number) AS max_page
    FROM public.${TABLE_TARGETS}
    GROUP BY target_status
    ORDER BY target_status
  `);

  console.table(result.rows);
}

async function main() {
  if (!["preview", "execute"].includes(MODE)) {
    throw new Error("FC2_DELTA_MANUAL_ENQUEUE_MODE must be preview or execute");
  }

  const client = new Client(DB_CONFIG);
  await client.connect();

  try {
    console.log("======================================================================");
    console.log("FC2 Delta Thumbnail Manual Enqueue");
    console.log(`mode          : ${MODE}`);
    console.log(`lookbackHours : ${LOOKBACK_HOURS}`);
    console.log(`maxPage       : ${MAX_PAGE}`);
    console.log(`sourceRunId   : ${SOURCE_RUN_ID}`);
    console.log("======================================================================");

    await ensureTables(client);
    await printRecentBuckets(client);

    await client.query("BEGIN");
    const counts = await enqueueTargets(client);
    await printQueuedSummary(client);

    if (MODE === "execute") {
      await client.query("COMMIT");
      console.log(`COMMIT targets=${counts.targets} logs=${counts.logs}`);
    } else {
      await client.query("ROLLBACK");
      console.log(`ROLLBACK preview targets=${counts.targets} logs=${counts.logs}`);
    }
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // ignore rollback errors after failed setup or committed transaction
    }
    throw error;
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
