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
      ? { rejectUnauthorized: false }
      : false,
  });
  await client.connect();
  try {
    const folders = await client.query(`
      SELECT
        folder_id,
        folder_name,
        COUNT(*)::integer AS rows,
        COUNT(DISTINCT file_url)::integer AS distinct_urls,
        MIN(page_number::integer)::integer AS min_page,
        MAX(page_number::integer)::integer AS max_page,
        MIN(collected_at) AS first_collected_at,
        MAX(collected_at) AS last_collected_at,
        MAX(inserted_at) AS last_inserted_at
      FROM public.xxx_tl002_rapidgator_raw
      WHERE folder_id ~ '^\\d+$'
        AND folder_name ~ '^[A-Za-z0-9_-]+$'
        AND page_number ~ '^\\d+$'
      GROUP BY folder_id, folder_name
      ORDER BY folder_id, folder_name
    `);
    const recent = await client.query(`
      SELECT
        (inserted_at AT TIME ZONE 'Asia/Tokyo')::date AS inserted_day_jst,
        COUNT(*)::integer AS rows,
        COUNT(DISTINCT file_url)::integer AS distinct_urls
      FROM public.xxx_tl002_rapidgator_raw
      WHERE inserted_at >= now() - interval '7 days'
      GROUP BY 1
      ORDER BY 1 DESC
    `);
    process.stdout.write(JSON.stringify({ folders: folders.rows, recent: recent.rows }, null, 2) + "\n");
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  process.stderr.write(`Rapidgator daily audit failed: ${error.message}\n`);
  process.exitCode = 1;
});
