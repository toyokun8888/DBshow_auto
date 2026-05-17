const { Pool } = require("pg");
const fs = require("fs");
const path = require("path");

const PROJECT_ROOT = path.resolve(__dirname, "..", "..", "..");
const ENV_PATH = path.resolve(PROJECT_ROOT, ".env");

function loadEnvFile(envPath) {
  if (!fs.existsSync(envPath)) {
    throw new Error(`.env not found: ${envPath}`);
  }

  const text = fs.readFileSync(envPath, "utf8");

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const separatorIndex = line.indexOf("=");
    if (separatorIndex === -1) continue;

    const key = line.slice(0, separatorIndex).trim();
    const value = line.slice(separatorIndex + 1).trim().replace(/^['"]|['"]$/g, "");
    if (key && process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

function requireEnv(name) {
  const value = process.env[name];
  if (!value || value.startsWith("CHANGE_ME_")) {
    throw new Error(`${name} is not configured in .env`);
  }
  return value;
}

function createDbPool() {
  const sslValue = (process.env.PGSSL || "false").toLowerCase();
  return new Pool({
    host: requireEnv("PGHOST"),
    port: Number(process.env.PGPORT || 5432),
    database: requireEnv("PGDATABASE"),
    user: requireEnv("PGUSER"),
    password: requireEnv("PGPASSWORD"),
    ssl: sslValue === "true" ? { rejectUnauthorized: false } : false,
  });
}

async function main() {
  loadEnvFile(ENV_PATH);
  const db = createDbPool();

  try {
    await db.query(`
      CREATE TABLE IF NOT EXISTS public.xxx_tm010_seller_completion_product_cache (
        product_id text PRIMARY KEY,
        seller_id text NOT NULL,
        seller_name text NOT NULL,
        title text NOT NULL,
        is_owned boolean NOT NULL DEFAULT false,
        source_updated_at timestamp without time zone,
        cache_updated_at timestamp without time zone NOT NULL DEFAULT now()
      )
    `);

    await db.query(`
      CREATE INDEX IF NOT EXISTS xxx_idx_tm010_seller_completion_seller_id
      ON public.xxx_tm010_seller_completion_product_cache (seller_id)
    `);

    await db.query(`
      CREATE INDEX IF NOT EXISTS xxx_idx_tm010_seller_completion_owned
      ON public.xxx_tm010_seller_completion_product_cache (is_owned)
    `);

    await db.query(`
      CREATE INDEX IF NOT EXISTS xxx_idx_tm010_seller_completion_title
      ON public.xxx_tm010_seller_completion_product_cache (title)
    `);

    const startedAt = Date.now();
    await db.query(`
      INSERT INTO public.xxx_tm010_seller_completion_product_cache (
        product_id,
        seller_id,
        seller_name,
        title,
        is_owned,
        source_updated_at,
        cache_updated_at
      )
      WITH seller_alias_map AS (
        SELECT
          master_seller_id,
          MAX(wiki_seller_id) AS wiki_seller_id,
          MAX(wiki_seller_name) AS wiki_seller_name
        FROM (
          SELECT
            master_seller_id,
            wiki_seller_id::text AS wiki_seller_id,
            wiki_seller_name
          FROM public.xxx_vq026_wiki_article_master_enriched
          WHERE COALESCE(master_seller_id, '') <> ''
            AND wiki_seller_id IS NOT NULL
        ) aliases
        GROUP BY master_seller_id
        HAVING COUNT(DISTINCT wiki_seller_id) = 1
      ),
      source_products AS (
        SELECT
          w.product_id,
          COALESCE(w.wiki_seller_id::text, w.master_seller_id::text, '') AS seller_id,
          COALESCE(w.wiki_seller_name, w.wiki_seller_id::text, w.master_seller_id::text, '') AS seller_name,
          COALESCE(w.display_title, w.master_title, w.wiki_title, '') AS title,
          w.updated_at AS source_updated_at,
          1 AS source_priority
        FROM public.xxx_vq026_wiki_article_master_enriched w
        WHERE w.product_id IS NOT NULL
          AND COALESCE(w.wiki_seller_id::text, w.master_seller_id::text, '') <> ''

        UNION ALL

        SELECT
          m.product_id,
          COALESCE(a.wiki_seller_id, NULLIF(m.seller_id::text, ''), 'master_unknown') AS seller_id,
          COALESCE(a.wiki_seller_name, a.wiki_seller_id, NULLIF(m.seller_id::text, ''), 'master_unknown') AS seller_name,
          COALESCE(m.title, '') AS title,
          NULL::timestamp without time zone AS source_updated_at,
          2 AS source_priority
        FROM public.master m
        LEFT JOIN seller_alias_map a
          ON a.master_seller_id = m.seller_id
        WHERE m.product_id IS NOT NULL
      ),
      selected_products AS (
        SELECT DISTINCT ON (product_id)
          product_id,
          seller_id,
          seller_name,
          title,
          source_updated_at
        FROM source_products
        ORDER BY
          product_id,
          source_priority ASC,
          source_updated_at DESC NULLS LAST
      )
      SELECT
        s.product_id,
        s.seller_id,
        s.seller_name,
        s.title,
        (o.product_id IS NOT NULL) AS is_owned,
        s.source_updated_at,
        now() AS cache_updated_at
      FROM selected_products s
      LEFT JOIN public.xxx_vq002_owned_product_ids o
        ON o.product_id::text = s.product_id
      ON CONFLICT (product_id) DO UPDATE SET
        seller_id = EXCLUDED.seller_id,
        seller_name = EXCLUDED.seller_name,
        title = EXCLUDED.title,
        is_owned = EXCLUDED.is_owned,
        source_updated_at = EXCLUDED.source_updated_at,
        cache_updated_at = now()
    `);

    const result = await db.query(`
      SELECT
        COUNT(*)::bigint AS rows,
        COUNT(DISTINCT seller_id)::bigint AS sellers,
        COUNT(*) FILTER (WHERE is_owned)::bigint AS owned,
        COUNT(*) FILTER (WHERE NOT is_owned)::bigint AS missing
      FROM public.xxx_tm010_seller_completion_product_cache
    `);

    console.log(JSON.stringify({
      ok: true,
      elapsedMs: Date.now() - startedAt,
      ...result.rows[0],
    }));
  } finally {
    await db.end();
  }
}

main().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
});
