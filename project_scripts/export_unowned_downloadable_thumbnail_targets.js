const fs = require("fs");
const path = require("path");
const { Client } = require("pg");
require("dotenv").config({ quiet: true });

const PROJECT_ROOT = path.resolve(__dirname, "..");
const LOG_DIR = path.join(PROJECT_ROOT, "project_scripts", "google_image_thumbnail_logs");
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

async function main() {
  const chunkSize = parsePositiveInt(getArg("--chunk-size") || "5000", "--chunk-size");
  const timestamp = new Date().toISOString().replace(/[-:T.]/g, "").slice(0, 14);
  const outDir = path.join(LOG_DIR, `unowned_downloadable_thumbnail_targets_${timestamp}`);
  fs.mkdirSync(outDir, { recursive: true });

  const client = new Client(DB_CONFIG);
  await client.connect();
  try {
    const result = await client.query(`
      SELECT
        b.fc2_product_id::text AS product_id,
        b.best_mp4_url::text AS best_mp4_url,
        b.best_page_url::text AS best_page_url,
        b.normalized_group_key::text AS normalized_group_key
      FROM public.xxx_vq025_rapidgator_best_links b
      LEFT JOIN public.xxx_vq002_owned_product_ids o
        ON o.product_id::text = b.fc2_product_id::text
      LEFT JOIN public.xxx_tm009_fc2_wiki_thumbnail_assets t
        ON t.product_id = b.fc2_product_id::text
      WHERE b.fc2_product_id::text ~ '^[0-9]{6,8}$'
        AND (
          b.has_rapidgator = true
          OR COALESCE(b.best_mp4_url::text, '') <> ''
          OR COALESCE(b.best_page_url::text, '') <> ''
        )
        AND o.product_id IS NULL
        AND (
          t.product_id IS NULL
          OR (
            COALESCE(t.thumbnail_status, '') <> 'collected'
            AND COALESCE(t.local_thumbnail_path, '') = ''
          )
        )
      GROUP BY b.fc2_product_id, b.best_mp4_url, b.best_page_url, b.normalized_group_key
      ORDER BY b.fc2_product_id::bigint DESC
    `);

    const rows = result.rows;
    const allPath = path.join(outDir, "all_targets.csv");
    writeCsv(allPath, rows);

    const chunkPaths = [];
    for (let index = 0; index < rows.length; index += chunkSize) {
      const chunkNo = Math.floor(index / chunkSize) + 1;
      const chunkRows = rows.slice(index, index + chunkSize);
      const chunkPath = path.join(outDir, `targets_chunk_${String(chunkNo).padStart(2, "0")}.csv`);
      writeCsv(chunkPath, chunkRows);
      chunkPaths.push({ path: chunkPath, rows: chunkRows.length });
    }

    process.stdout.write(
      `${JSON.stringify(
        {
          out_dir: outDir,
          all_targets_csv: allPath,
          total_rows: rows.length,
          chunk_size: chunkSize,
          chunks: chunkPaths,
        },
        null,
        2
      )}\n`
    );
  } finally {
    await client.end().catch(() => {});
  }
}

function writeCsv(filePath, rows) {
  const columns = ["product_id", "best_mp4_url", "best_page_url", "normalized_group_key"];
  const lines = [columns.join(",")];
  for (const row of rows) {
    lines.push(columns.map((column) => csvEscape(row[column] || "")).join(","));
  }
  fs.writeFileSync(filePath, `${lines.join("\n")}\n`, "utf8");
}

function getArg(name) {
  const index = process.argv.indexOf(name);
  if (index < 0) return "";
  return process.argv[index + 1] || "";
}

function parsePositiveInt(value, name) {
  const number = Number.parseInt(value, 10);
  if (!Number.isInteger(number) || number < 1) throw new Error(`${name} must be a positive integer`);
  return number;
}

function csvEscape(value) {
  const text = String(value ?? "");
  if (!/[",\r\n]/.test(text)) return text;
  return `"${text.replace(/"/g, '""')}"`;
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message || error}\n`);
  process.exitCode = 1;
});
