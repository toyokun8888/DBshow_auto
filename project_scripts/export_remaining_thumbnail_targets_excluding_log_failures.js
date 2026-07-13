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
  const excludeCsv = process.argv[2];
  if (!excludeCsv) throw new Error("Usage: node project_scripts/export_remaining_thumbnail_targets_excluding_log_failures.js <exclude-log.csv>");

  const failedIds = readFailedIds(path.resolve(excludeCsv));
  const outputPath = path.join(
    LOG_DIR,
    `remaining_thumbnail_targets_excluding_failures_${new Date().toISOString().replace(/[-:T.]/g, "").slice(0, 14)}.csv`
  );

  const client = new Client(DB_CONFIG);
  await client.connect();
  try {
    const result = await client.query(
      `
        SELECT DISTINCT product_id
        FROM public.xxx_vq029_owned_file_thumbnail_status
        WHERE owned_without_thumbnail = true
          AND product_id ~ '^[0-9]{6,8}$'
          AND NOT (product_id = ANY($1::text[]))
        ORDER BY product_id DESC
      `,
      [failedIds]
    );

    const columns = ["product_id"];
    fs.writeFileSync(outputPath, `${columns.join(",")}\n`, "utf8");
    for (const row of result.rows) {
      fs.appendFileSync(outputPath, `"${String(row.product_id).replace(/"/g, '""')}"\n`, "utf8");
    }

    process.stdout.write(
      `${JSON.stringify(
        {
          remaining_after_exclusion: result.rowCount,
          excluded_failed_ids: failedIds.length,
          output_path: outputPath,
        },
        null,
        2
      )}\n`
    );
  } finally {
    await client.end().catch(() => {});
  }
}

function readFailedIds(csvPath) {
  if (!fs.existsSync(csvPath)) throw new Error(`CSV not found: ${csvPath}`);
  const lines = fs.readFileSync(csvPath, "utf8").split(/\r?\n/).filter(Boolean);
  if (lines.length <= 1) return [];
  const headers = parseCsvLine(lines[0]);
  const productIndex = headers.indexOf("product_id");
  const statusIndex = headers.indexOf("status");
  if (productIndex < 0 || statusIndex < 0) throw new Error("CSV must include product_id and status columns");

  const ids = new Set();
  for (const line of lines.slice(1)) {
    const cols = parseCsvLine(line);
    const status = cols[statusIndex] || "";
    const productId = cols[productIndex] || "";
    if (status !== "collected" && status !== "collected_existing" && /^[0-9]{6,8}$/.test(productId)) {
      ids.add(productId);
    }
  }
  return Array.from(ids);
}

function parseCsvLine(line) {
  const out = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '"' && inQuotes && line[i + 1] === '"') {
      current += '"';
      i += 1;
    } else if (ch === '"') {
      inQuotes = !inQuotes;
    } else if (ch === "," && !inQuotes) {
      out.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  out.push(current);
  return out;
}

main().catch((error) => {
  process.stderr.write(`${error.message || error}\n`);
  process.exitCode = 1;
});
