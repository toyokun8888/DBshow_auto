const { Client } = require("pg");
require("dotenv").config({ quiet: true });

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
  const logCsvPath = process.argv[2] || "";
  const client = new Client(DB_CONFIG);
  await client.connect();
  try {
    const result = await client.query(`
      SELECT COUNT(DISTINCT product_id)::integer AS remaining
      FROM public.xxx_vq029_owned_file_thumbnail_status
      WHERE owned_without_thumbnail = true
        AND product_id ~ '^[0-9]{6,8}$'
    `);
    const output = { ...result.rows[0] };

    if (logCsvPath) {
      const logIds = readIdsByStatus(logCsvPath, (status) => status === "not_found");
      const collectedIds = readIdsByStatus(logCsvPath, (status) => status === "collected" || status === "collected_existing");
      if (logIds.length > 0) {
        const check = await client.query(
          `
            SELECT COUNT(DISTINCT product_id)::integer AS still_remaining_from_log
            FROM public.xxx_vq029_owned_file_thumbnail_status
            WHERE owned_without_thumbnail = true
              AND product_id = ANY($1::text[])
          `,
          [logIds]
        );
        output.log_not_found_ids = logIds.length;
        output.still_remaining_from_log = check.rows[0].still_remaining_from_log;
      }
      if (collectedIds.length > 0) {
        const check = await client.query(
          `
            SELECT COUNT(DISTINCT product_id)::integer AS collected_still_remaining_from_log
            FROM public.xxx_vq029_owned_file_thumbnail_status
            WHERE owned_without_thumbnail = true
              AND product_id = ANY($1::text[])
          `,
          [collectedIds]
        );
        output.log_collected_ids = collectedIds.length;
        output.collected_still_remaining_from_log = check.rows[0].collected_still_remaining_from_log;
      }
    }

    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  } finally {
    await client.end().catch(() => {});
  }
}

function readIdsByStatus(csvPath, statusPredicate) {
  const fs = require("fs");
  if (!fs.existsSync(csvPath)) throw new Error(`CSV not found: ${csvPath}`);
  const lines = fs.readFileSync(csvPath, "utf8").split(/\r?\n/).filter(Boolean);
  if (lines.length <= 1) return [];
  const headers = parseCsvLine(lines[0]);
  const productIndex = headers.indexOf("product_id");
  const statusIndex = headers.indexOf("status");
  if (productIndex < 0 || statusIndex < 0) return [];
  const ids = new Set();
  for (const line of lines.slice(1)) {
    const cols = parseCsvLine(line);
    if (statusPredicate(cols[statusIndex] || "")) ids.add(cols[productIndex]);
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
