"use strict";

const fs = require("fs");
const path = require("path");
const { Client } = require("pg");
require("dotenv").config({ path: path.resolve(__dirname, "..", ".env"), quiet: true });

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
    const result = await client.query(`
      SELECT
        product_id,
        torrent_url,
        downloaded_file_path,
        downloaded_at,
        status
      FROM public.xxx_tm012_sukebei_torrent_downloads
      WHERE (downloaded_at AT TIME ZONE 'Asia/Tokyo')::date
        BETWEEN DATE '2026-08-12' AND DATE '2026-08-13'
        AND status = 'downloaded'
      ORDER BY downloaded_at, product_id
    `);

    const rows = result.rows.map((row) => ({
      ...row,
      local_file_exists: Boolean(row.downloaded_file_path && fs.existsSync(row.downloaded_file_path)),
    }));
    const byDate = {};
    for (const row of rows) {
      const date = new Date(row.downloaded_at).toLocaleDateString("sv-SE", { timeZone: "Asia/Tokyo" });
      byDate[date] = (byDate[date] || 0) + 1;
    }
    process.stdout.write(`${JSON.stringify({ count: rows.length, by_date: byDate, rows }, null, 2)}\n`);
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message || error}\n`);
  process.exitCode = 1;
});
