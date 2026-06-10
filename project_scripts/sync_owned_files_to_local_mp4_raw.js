const fs = require("fs");
const path = require("path");
const { Client } = require("pg");

const PRODUCT_ID = process.env.SYNC_PRODUCT_ID || "";
const TARGET_ROOT = process.env.SYNC_TARGET_ROOT || "Q:\\all_fc2";

function writeLine(value = "") {
  process.stdout.write(`${value}\n`);
}

function writeRows(label, rows) {
  writeLine(label);
  process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
}

function loadEnvFile(envPath) {
  const text = fs.readFileSync(envPath, "utf8").replace(/^\uFEFF/, "");
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separatorIndex = line.indexOf("=");
    if (separatorIndex === -1) continue;
    const key = line.slice(0, separatorIndex).trim();
    const value = line.slice(separatorIndex + 1).trim();
    if (key && process.env[key] === undefined) process.env[key] = value;
  }
}

function parseArgs(argv) {
  const args = { mode: "dry-run" };
  for (let index = 2; index < argv.length; index += 1) {
    const key = argv[index];
    const value = argv[index + 1];
    if (key === "--mode") {
      args.mode = value;
      index += 1;
    } else if (key === "--confirm-execute") {
      args.confirmExecute = value;
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${key}`);
    }
  }
  if (!["dry-run", "execute"].includes(args.mode)) {
    throw new Error(`Invalid mode: ${args.mode}`);
  }
  if (args.mode === "execute" && args.confirmExecute !== "YES") {
    throw new Error("execute mode requires --confirm-execute YES");
  }
  return args;
}

function createClient() {
  const sslValue = String(process.env.PGSSL || "false").toLowerCase();
  return new Client({
    host: process.env.PGHOST,
    port: Number(process.env.PGPORT || 5432),
    database: process.env.PGDATABASE,
    user: process.env.PGUSER,
    password: process.env.PGPASSWORD,
    ssl: sslValue === "true" ? { rejectUnauthorized: false } : false,
  });
}

function normalizeForCompare(value) {
  return path.win32.resolve(String(value || "")).toLowerCase();
}

function isUnderTargetRoot(filePath) {
  const root = normalizeForCompare(TARGET_ROOT).replace(/[\\]+$/, "");
  const target = normalizeForCompare(filePath);
  return target === root || target.startsWith(`${root}\\`);
}

async function readColumns(client) {
  const result = await client.query(
    `
      select column_name, data_type, is_nullable
      from information_schema.columns
      where table_schema = 'public'
        and table_name = 'local_mp4_ids_raw'
      order by ordinal_position
    `
  );
  return result.rows;
}

async function readCandidates(client) {
  const params = [];
  let productClause = "";
  if (PRODUCT_ID) {
    params.push(PRODUCT_ID);
    productClause = `and product_id = $${params.length}`;
  }

  const result = await client.query(
    `
      select product_id, current_file_name, current_path, file_size, file_modified_at
      from public.xxx_tm002_owned_files
      where status = 'owned'
        and current_path is not null
        and current_path <> ''
        ${productClause}
      order by product_id, id desc
    `,
    params
  );

  return result.rows
    .filter((row) => isUnderTargetRoot(row.current_path))
    .map((row) => ({
      product_id: String(row.product_id || ""),
      file_name: String(row.current_file_name || path.win32.basename(row.current_path)),
      full_path: String(row.current_path || ""),
      file_size: row.file_size == null ? null : Number(row.file_size),
      last_write_time: row.file_modified_at,
    }));
}

async function filterMissing(client, candidates) {
  const missing = [];
  for (const row of candidates) {
    const exists = await client.query(
      `
        select 1
        from public.local_mp4_ids_raw
        where product_id = $1
          and full_path = $2
        limit 1
      `,
      [row.product_id, row.full_path]
    );
    if (exists.rowCount === 0) missing.push(row);
  }
  return missing;
}

async function insertRows(client, rows) {
  for (const row of rows) {
    await client.query(
      `
        insert into public.local_mp4_ids_raw
          (product_id, file_name, full_path, file_size, last_write_time)
        values ($1, $2, $3, $4, $5)
      `,
      [
        row.product_id,
        row.file_name,
        row.full_path,
        row.file_size,
        row.last_write_time,
      ]
    );
  }
}

async function main() {
  const args = parseArgs(process.argv);
  loadEnvFile(".env");

  const client = createClient();
  await client.connect();
  try {
    const columns = await readColumns(client);
    writeRows("local_mp4_ids_raw columns", columns);

    const candidates = await readCandidates(client);
    const missing = await filterMissing(client, candidates);
    writeLine(`mode=${args.mode}`);
    writeLine(`target_root=${TARGET_ROOT}`);
    writeLine(`product_filter=${PRODUCT_ID || "(none)"}`);
    writeLine(`candidates=${candidates.length}`);
    writeLine(`missing=${missing.length}`);
    writeRows("missing_sample", missing.slice(0, 20));

    if (args.mode === "dry-run") return;

    await client.query("BEGIN");
    try {
      await insertRows(client, missing);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }

    const remaining = await filterMissing(client, candidates);
    writeLine(`inserted=${missing.length}`);
    writeLine(`remaining_missing=${remaining.length}`);
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
