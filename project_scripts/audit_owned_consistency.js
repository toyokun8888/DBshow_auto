const path = require("path");
const { Client } = require("pg");
require("dotenv").config({ path: path.resolve(__dirname, "../.env"), quiet: true });

async function main() {
  const client = new Client({
    host: process.env.PGHOST,
    port: Number(process.env.PGPORT || 5432),
    database: process.env.PGDATABASE,
    user: process.env.PGUSER,
    password: process.env.PGPASSWORD,
    ssl: String(process.env.PGSSL || "false").toLowerCase() === "true"
      ? { rejectUnauthorized: false } : false,
  });
  await client.connect();
  try {
    const summary = await client.query(`
      WITH library_ids AS (
        SELECT DISTINCT product_id::text AS product_id
        FROM public.xxx_tm002_owned_files
        WHERE status = 'owned'
      )
      SELECT
        COUNT(*)::integer AS library_ids,
        COUNT(*) FILTER (WHERE length(l.product_id) = 6)::integer AS six_digit,
        COUNT(*) FILTER (WHERE length(l.product_id) = 7)::integer AS seven_digit,
        COUNT(*) FILTER (WHERE c.product_id IS NULL)::integer AS missing_from_cache,
        COUNT(*) FILTER (WHERE c.product_id IS NOT NULL AND NOT c.is_owned)::integer AS cache_false,
        COUNT(*) FILTER (WHERE c.is_owned)::integer AS cache_true
      FROM library_ids l
      LEFT JOIN public.xxx_tm010_seller_completion_product_cache c
        ON c.product_id = l.product_id
    `);
    const examples = await client.query(`
      WITH library_ids AS (
        SELECT DISTINCT product_id::text AS product_id
        FROM public.xxx_tm002_owned_files
        WHERE status = 'owned'
      )
      SELECT l.product_id, c.seller_id, c.is_owned AS cache_is_owned,
             c.cache_updated_at
      FROM library_ids l
      LEFT JOIN public.xxx_tm010_seller_completion_product_cache c
        ON c.product_id = l.product_id
      WHERE c.product_id IS NULL OR NOT c.is_owned
      ORDER BY c.product_id NULLS LAST, l.product_id
      LIMIT 20
    `);
    const cache = await client.query(`
      SELECT COUNT(*)::integer AS rows,
             MIN(cache_updated_at) AS oldest_update,
             MAX(cache_updated_at) AS newest_update
      FROM public.xxx_tm010_seller_completion_product_cache
    `);
    const samples = await client.query(`
      SELECT DISTINCT product_id::text AS product_id
      FROM public.xxx_tm002_owned_files
      WHERE status = 'owned' AND length(product_id::text) = 6
      ORDER BY product_id
      LIMIT 5
    `);
    process.stdout.write(JSON.stringify({
      summary: summary.rows[0],
      cache: cache.rows[0],
      examples: examples.rows,
      six_digit_samples: samples.rows,
    }, null, 2) + "\n");
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  process.stderr.write(`Owned audit failed: ${error.message}\n`);
  process.exitCode = 1;
});
