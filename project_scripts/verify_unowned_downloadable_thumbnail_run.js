const fs = require("fs");
const path = require("path");
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
  const targetCsv = process.argv[2];
  const resultCsvs = process.argv.slice(3);
  if (!targetCsv || resultCsvs.length === 0) {
    throw new Error("usage: node verify_unowned_downloadable_thumbnail_run.js <all_targets.csv> <result1.csv> [...]");
  }

  const targetIds = readProductIds(targetCsv);
  const resultSummary = summarizeResultCsvs(resultCsvs);

  const client = new Client(DB_CONFIG);
  await client.connect();
  try {
    const dbResult = await client.query(
      `
        SELECT COUNT(DISTINCT product_id)::integer AS collected_in_db
        FROM public.xxx_tm009_fc2_wiki_thumbnail_assets
        WHERE product_id = ANY($1::text[])
          AND thumbnail_status = 'collected'
          AND COALESCE(local_thumbnail_path, '') <> ''
      `,
      [targetIds]
    );

    process.stdout.write(
      `${JSON.stringify(
        {
          target_ids: targetIds.length,
          result_rows: resultSummary.rows,
          status: resultSummary.status,
          db_write_status: resultSummary.db_write_status,
          collected_in_db: dbResult.rows[0].collected_in_db,
        },
        null,
        2
      )}\n`
    );
  } finally {
    await client.end().catch(() => {});
  }
}

function readProductIds(csvPath) {
  const rows = readCsv(csvPath);
  return Array.from(new Set(rows.map((row) => String(row.product_id || "").trim()).filter(Boolean)));
}

function summarizeResultCsvs(csvPaths) {
  const summary = { rows: 0, status: {}, db_write_status: {} };
  for (const csvPath of csvPaths) {
    for (const row of readCsv(csvPath)) {
      summary.rows += 1;
      increment(summary.status, row.status || "");
      increment(summary.db_write_status, row.db_write_status || "");
    }
  }
  return summary;
}

function increment(object, key) {
  const name = key || "(blank)";
  object[name] = (object[name] || 0) + 1;
}

function readCsv(csvPath) {
  if (!fs.existsSync(csvPath)) throw new Error(`CSV not found: ${csvPath}`);
  const lines = fs.readFileSync(path.resolve(csvPath), "utf8").split(/\r?\n/).filter(Boolean);
  if (lines.length <= 1) return [];
  const headers = parseCsvLine(lines[0]);
  return lines.slice(1).map((line) => {
    const columns = parseCsvLine(line);
    return Object.fromEntries(headers.map((header, index) => [header, columns[index] || ""]));
  });
}

function parseCsvLine(line) {
  const out = [];
  let current = "";
  let inQuotes = false;
  for (let index = 0; index < line.length; index += 1) {
    const ch = line[index];
    if (ch === '"' && inQuotes && line[index + 1] === '"') {
      current += '"';
      index += 1;
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
  process.stderr.write(`${error.stack || error.message || error}\n`);
  process.exitCode = 1;
});
