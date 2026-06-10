const fs = require("fs");
const path = require("path");
const { Client } = require("pg");

const PROJECT_ROOT = path.resolve(__dirname, "..");
const ENV_PATH = path.join(PROJECT_ROOT, ".env");
const DOWNLOAD_TABLE = "public.xxx_tm012_sukebei_torrent_downloads";
const START_AT = "2026-05-25T18:00:00+09:00";
const END_AT = "2026-05-25T18:30:00+09:00";
const TARGET_PRODUCT_IDS = [
  "2526023",
  "4907364",
  "2552230",
  "4891706",
  "4898659",
  "4906677",
  "4906679",
  "4906712",
  "4906732",
  "4906954",
  "4907388",
  "4907423",
  "1593427",
  "1603706",
];

async function main() {
  loadEnvFile(ENV_PATH);
  const applyDelete = process.env.APPLY_DELETE === "YES";
  const client = createPgClient();
  await client.connect();

  try {
    await ensureTableExists(client);
    const beforeRows = await selectCandidates(client);
    printRows(applyDelete ? "DELETE candidates" : "Dry-run candidates", beforeRows);

    if (!applyDelete) {
      process.stdout.write("Dry-run only. Set APPLY_DELETE=YES to delete these rows.\n");
      return;
    }

    await client.query("BEGIN");
    const deleted = await deleteCandidates(client);
    await client.query("COMMIT");
    printRows("Deleted rows", deleted);

    const afterRows = await selectCandidates(client);
    process.stdout.write(`Post-check remaining candidates: ${afterRows.length}\n`);
    if (afterRows.length !== 0) {
      process.exitCode = 1;
    }
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch (_) {
      // Ignore rollback errors when no transaction is active.
    }
    throw error;
  } finally {
    await client.end();
  }
}

async function ensureTableExists(client) {
  const result = await client.query("SELECT to_regclass($1) AS table_name", [DOWNLOAD_TABLE]);
  if (!result.rows[0]?.table_name) {
    throw new Error(`${DOWNLOAD_TABLE} does not exist`);
  }
}

async function selectCandidates(client) {
  const result = await client.query(
    `
      SELECT
        id,
        product_id,
        torrent_url,
        status,
        downloaded_file_path,
        created_at,
        downloaded_at
      FROM ${DOWNLOAD_TABLE}
      WHERE product_id = ANY($1::text[])
        AND created_at >= $2::timestamptz
        AND created_at < $3::timestamptz
      ORDER BY id
    `,
    [TARGET_PRODUCT_IDS, START_AT, END_AT]
  );
  return result.rows;
}

async function deleteCandidates(client) {
  const result = await client.query(
    `
      DELETE FROM ${DOWNLOAD_TABLE}
      WHERE product_id = ANY($1::text[])
        AND created_at >= $2::timestamptz
        AND created_at < $3::timestamptz
      RETURNING
        id,
        product_id,
        torrent_url,
        status,
        downloaded_file_path,
        created_at,
        downloaded_at
    `,
    [TARGET_PRODUCT_IDS, START_AT, END_AT]
  );
  return result.rows;
}

function printRows(label, rows) {
  process.stdout.write(`${label}: ${rows.length}\n`);
  for (const row of rows) {
    process.stdout.write(
      [
        `id=${row.id}`,
        `product_id=${row.product_id}`,
        `status=${row.status}`,
        `created_at=${formatDbDate(row.created_at)}`,
        `downloaded_at=${formatDbDate(row.downloaded_at)}`,
        `file=${row.downloaded_file_path || ""}`,
      ].join(" | ") + "\n"
    );
  }
}

function createPgClient() {
  const databaseUrl = envValue("DATABASE_URL");
  if (databaseUrl) {
    return new Client({ connectionString: databaseUrl });
  }

  const sslValue = (process.env.PGSSL || "false").toLowerCase();
  return new Client({
    host: requireEnv("PGHOST"),
    port: Number(process.env.PGPORT || 5432),
    database: requireEnv("PGDATABASE"),
    user: requireEnv("PGUSER"),
    password: requireEnv("PGPASSWORD"),
    ssl: sslValue === "true" ? { rejectUnauthorized: false } : false,
  });
}

function loadEnvFile(envPath) {
  if (!fs.existsSync(envPath)) return;
  const text = fs.readFileSync(envPath, "utf8").replace(/^\uFEFF/, "");
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separatorIndex = line.indexOf("=");
    if (separatorIndex === -1) continue;
    const key = line.slice(0, separatorIndex).trim();
    const value = unquoteEnvValue(line.slice(separatorIndex + 1).trim());
    if (key && process.env[key] === undefined) process.env[key] = value;
  }
}

function unquoteEnvValue(value) {
  if (
    (value.startsWith("\"") && value.endsWith("\"")) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function envValue(name) {
  const value = process.env[name];
  if (!value || value.startsWith("CHANGE_ME_")) return "";
  return value;
}

function requireEnv(name) {
  const value = process.env[name];
  if (!value || value.startsWith("CHANGE_ME_")) {
    throw new Error(`${name} is not configured in .env`);
  }
  return value;
}

function formatDbDate(value) {
  return value instanceof Date ? value.toISOString() : String(value || "");
}

main().catch((error) => {
  process.stderr.write(`rollback failed: ${error.message}\n`);
  process.exitCode = 1;
});
