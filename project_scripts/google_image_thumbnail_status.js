const fs = require("fs");
const path = require("path");
const { Client } = require("pg");
require("dotenv").config({ quiet: true });

const PROJECT_ROOT = path.resolve(__dirname, "..");
const STATUS_DIR = path.join(PROJECT_ROOT, "project_scripts", "google_image_thumbnail_logs", "status");
const LATEST_STATUS_PATH = path.join(STATUS_DIR, "latest.json");

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
  const status = readLatestStatus();
  const csvRows = countCsvRows(status.csv_path || "");
  const dbCount = await countDbRowsForRecentGooglePaths();

  const summary = {
    run_id: status.run_id || "",
    mode: status.mode || "",
    resolver: status.resolver || "",
    run_status: status.run_status || "unknown",
    targets: Number(status.targets || 0),
    processed: Number(status.processed || 0),
    success: Number(status.success || 0),
    failed: Number(status.failed || 0),
    consecutive_failures: Number(status.consecutive_failures || 0),
    imgres_imgurl: Number(status.imgres_imgurl || 0),
    google_thumbnail_url: Number(status.google_thumbnail_url || 0),
    last_product_id: status.last_product_id || "",
    latest_error: status.latest_error || "",
    last_message: status.last_message || "",
    csv_path: status.csv_path || "",
    csv_rows: csvRows,
    db_google_thumbnail_rows: dbCount,
    started_at: status.started_at || "",
    updated_at: status.updated_at || "",
  };

  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

function readLatestStatus() {
  if (!fs.existsSync(LATEST_STATUS_PATH)) {
    return { run_status: "no_status_file" };
  }
  return JSON.parse(fs.readFileSync(LATEST_STATUS_PATH, "utf8"));
}

function countCsvRows(csvPath) {
  if (!csvPath || !fs.existsSync(csvPath)) return 0;
  const text = fs.readFileSync(csvPath, "utf8").trim();
  if (!text) return 0;
  return Math.max(text.split(/\r?\n/).length - 1, 0);
}

async function countDbRowsForRecentGooglePaths() {
  const client = new Client(DB_CONFIG);
  await client.connect();
  try {
    const result = await client.query(`
      SELECT COUNT(*)::integer AS count
      FROM public.xxx_tm009_fc2_wiki_thumbnail_assets
      WHERE thumbnail_status = 'collected'
        AND COALESCE(local_thumbnail_path, '') LIKE '%google_image_thumbnails%'
        AND downloaded_at >= CURRENT_DATE
        AND downloaded_at < CURRENT_DATE + INTERVAL '1 day'
    `);
    return Number(result.rows[0]?.count || 0);
  } finally {
    await client.end().catch(() => {});
  }
}

main().catch((error) => {
  process.stderr.write(`google image thumbnail status failed: ${error.message || error}\n`);
  process.exitCode = 1;
});
