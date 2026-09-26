const fs = require("fs");
const path = require("path");
const { Client } = require("pg");
require("dotenv").config({ path: path.resolve(__dirname, "../.env"), quiet: true });

const COLUMNS = [
  "global_seq", "csv_part_no", "file_seq", "source_page_url", "folder_id",
  "folder_name", "page_number", "row_index_in_page", "file_title", "file_url",
  "file_size", "file_ext", "group_key", "group_rule", "fc2_product_id",
  "part_no", "part_label", "part_type", "base_title_without_part", "collected_at",
];
function cliValue(name) {
  const index = process.argv.indexOf(name);
  if (index < 0) return "";
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`Missing value for ${name}`);
  return value;
}

const FOLDER_ID = cliValue("--folder-id") || "3330879";
const FOLDER_NAME = cliValue("--folder-name") || "movie";
const START_PAGE = Number(cliValue("--start-page") || 5855);
const END_PAGE = Number(cliValue("--end-page") || 6097);

function parseCsv(filePath) {
  const source = fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, "");
  const records = [];
  let record = [];
  let field = "";
  let quoted = false;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (quoted) {
      if (char === '"' && source[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        field += char;
      }
    } else if (char === '"') {
      if (field) throw new Error(`Malformed CSV quote: ${filePath}`);
      quoted = true;
    } else if (char === ",") {
      record.push(field);
      field = "";
    } else if (char === "\n") {
      record.push(field.replace(/\r$/, ""));
      records.push(record);
      record = [];
      field = "";
    } else {
      field += char;
    }
  }
  if (quoted) throw new Error(`Unclosed CSV quote: ${filePath}`);
  if (record.length || field) {
    record.push(field);
    records.push(record);
  }
  const [headers, ...body] = records;
  if (!headers) throw new Error(`Empty CSV: ${filePath}`);
  if (body.some((row) => row.length !== headers.length)) throw new Error(`CSV column mismatch: ${filePath}`);
  return { headers, rows: body.map((row) => Object.fromEntries(headers.map((header, index) => [header, row[index]]))) };
}

function csvCell(value) {
  return `"${String(value ?? "").replace(/"/g, '""')}"`;
}

function writeCsv(filePath, rows) {
  const lines = [COLUMNS, ...rows.map((row) => COLUMNS.map((name) => row[name]))];
  fs.writeFileSync(filePath, lines.map((row) => row.map(csvCell).join(",")).join("\n") + "\n", "utf8");
}

function validateCollection(directory, selectedRun) {
  const names = fs.readdirSync(directory);
  const masters = names.filter((name) => /^rapidgator_master_\d{14}_part001\.csv$/.test(name) &&
    (!selectedRun || name.includes(`_${selectedRun}_`))).sort();
  const progresses = names.filter((name) => /^rapidgator_progress_\d{14}\.csv$/.test(name) &&
    (!selectedRun || name.includes(`_${selectedRun}.`)));
  if (masters.length !== 1 || progresses.length !== 1) {
    throw new Error(`Expected one master CSV and one progress CSV, got ${masters.length} and ${progresses.length}`);
  }
  const masterRun = masters[0].match(/^rapidgator_master_(\d{14})_part001\.csv$/)?.[1];
  const progressRun = progresses[0].match(/^rapidgator_progress_(\d{14})\.csv$/)?.[1];
  if (!masterRun || masterRun !== progressRun) throw new Error("Master and progress CSV run IDs differ");
  const progress = parseCsv(path.join(directory, progresses[0]));
  const progressColumns = ["page_number", "source_page_url", "processed_at", "rows_found", "total_global_seq", "csv_part_no", "file_seq", "status", "note"];
  if (progress.headers.join(",") !== progressColumns.join(",")) throw new Error("Unexpected progress CSV columns");
  const expectedByPage = new Map();
  for (const row of progress.rows) {
    const page = Number(row.page_number);
    const expectedPageUrl = `https://rapidgator.net/folder/${FOLDER_ID}/${FOLDER_NAME}.html?page=${page}`;
    const expected = Number(row.rows_found);
    if (row.status !== "done" || !Number.isSafeInteger(page) || page < START_PAGE || page > END_PAGE ||
        row.source_page_url !== expectedPageUrl || !Number.isSafeInteger(expected) || expected < 1 ||
        expectedByPage.has(page)) {
      throw new Error(`Invalid or duplicate progress entry for page ${row.page_number}`);
    }
    expectedByPage.set(page, expected);
  }
  const missingPages = [];
  for (let page = START_PAGE; page <= END_PAGE; page += 1) {
    if (!expectedByPage.has(page)) missingPages.push(page);
  }
  if (missingPages.length) throw new Error(`Collection incomplete, missing pages: ${missingPages.join(", ")}`);
  const master = parseCsv(path.join(directory, masters[0]));
  if (COLUMNS.join(",") !== master.headers.join(",")) throw new Error("Unexpected master CSV columns");
  const seen = new Set();
  const uniqueRows = [];
  const actualByPage = new Map();
  let fileRows = 0;
  let skippedFolders = 0;
  for (const row of master.rows) {
    const page = Number(row.page_number);
    const expectedPageUrl = `https://rapidgator.net/folder/${FOLDER_ID}/${FOLDER_NAME}.html?page=${page}`;
    const validFileUrl = /^https:\/\/rapidgator\.net\/file\/[0-9a-f]+\//i.test(row.file_url);
    const validFolderUrl = /^https:\/\/rapidgator\.net\/folder\/\d+\/[^/?#]+\.html(?:\?.*)?$/i.test(row.file_url);
    if (row.folder_id !== FOLDER_ID || row.folder_name !== FOLDER_NAME ||
        !Number.isSafeInteger(page) || page < START_PAGE || page > END_PAGE || row.source_page_url !== expectedPageUrl ||
        !(validFileUrl || validFolderUrl) || !row.file_title || !Number.isFinite(Date.parse(row.collected_at))) {
      throw new Error(`Invalid collection row at page ${row.page_number}, sequence ${row.global_seq}`);
    }
    actualByPage.set(page, (actualByPage.get(page) || 0) + 1);
    if (validFolderUrl) {
      skippedFolders += 1;
      continue;
    }
    fileRows += 1;
    if (!seen.has(row.file_url)) {
      seen.add(row.file_url);
      uniqueRows.push(row);
    }
  }
  for (const [page, expected] of expectedByPage) {
    if ((actualByPage.get(page) || 0) !== expected) {
      throw new Error(`Master/progress count mismatch at page ${page}: expected ${expected}, found ${actualByPage.get(page) || 0}`);
    }
  }
  return { runId: masterRun, sourceRows: master.rows.length, skippedFolders, duplicateInCsv: fileRows - uniqueRows.length, rows: uniqueRows };
}

function dbClient() {
  return new Client({
    host: process.env.PGHOST,
    port: Number(process.env.PGPORT || 5432),
    database: process.env.PGDATABASE,
    user: process.env.PGUSER,
    password: process.env.PGPASSWORD,
    ssl: String(process.env.PGSSL || "false").toLowerCase() === "true"
      ? { rejectUnauthorized: false } : false,
  });
}

async function knownUrls(client, urls) {
  const result = await client.query(`
    SELECT DISTINCT file_url
    FROM public.xxx_tl002_rapidgator_raw
    WHERE file_url = ANY($1::text[])
  `, [urls]);
  return new Set(result.rows.map((row) => row.file_url));
}

async function insertNewRows(client, rows) {
  if (!rows.length) return 0;
  const arrays = COLUMNS.map((name) => rows.map((row) => row[name]));
  const unnests = COLUMNS.map((_, index) => `$${index + 1}::text[]`).join(", ");
  const names = COLUMNS.join(", ");
  const selected = COLUMNS.map((name) => name === "collected_at" ? "input.collected_at::timestamptz" : `input.${name}`).join(", ");
  const result = await client.query(`
    WITH input AS (
      SELECT * FROM unnest(${unnests}) AS item(${names})
    ), existing AS (
      SELECT DISTINCT file_url FROM public.xxx_tl002_rapidgator_raw
      WHERE file_url = ANY($10::text[])
    )
    INSERT INTO public.xxx_tl002_rapidgator_raw (${names})
    SELECT ${selected}
    FROM input LEFT JOIN existing ON existing.file_url = input.file_url
    WHERE existing.file_url IS NULL
    RETURNING file_url
  `, arrays);
  return result.rows.length;
}

async function main() {
  if (!/^\d+$/.test(FOLDER_ID) || !/^[A-Za-z0-9_-]+$/.test(FOLDER_NAME) ||
      !Number.isSafeInteger(START_PAGE) || !Number.isSafeInteger(END_PAGE) ||
      START_PAGE < 1 || END_PAGE < START_PAGE) {
    throw new Error("Invalid folder or page range");
  }
  const directory = path.resolve(process.argv[2] || "");
  const execute = process.argv.includes("--execute");
  if (!process.argv[2] || !fs.statSync(directory).isDirectory()) {
    throw new Error("Usage: node import_rapidgator_delta.js <collection-directory> [--execute]");
  }
  const collection = validateCollection(directory, cliValue("--run-id"));
  const client = dbClient();
  await client.connect();
  try {
    const known = await knownUrls(client, collection.rows.map((row) => row.file_url));
    const newRows = collection.rows.filter((row) => !known.has(row.file_url));
    const report = {
      mode: execute ? "execute" : "dry_run",
      run_id: collection.runId,
      folder: `${FOLDER_ID}/${FOLDER_NAME}`,
      pages: `${START_PAGE}-${END_PAGE}`,
      collected_rows: collection.sourceRows,
      skipped_folder_links: collection.skippedFolders,
      duplicate_urls_in_csv: collection.duplicateInCsv,
      already_in_db: collection.rows.length - newRows.length,
      new_urls: newRows.length,
      new_fc2_rows: newRows.filter((row) => row.fc2_product_id).length,
      new_fc2_product_ids: new Set(newRows.map((row) => row.fc2_product_id).filter(Boolean)).size,
    };
    const deltaPath = path.join(directory, `rapidgator_delta_new_${collection.runId}.csv`);
    if (!execute) writeCsv(deltaPath, newRows);
    if (execute) {
      let appliedRows = [];
      await client.query("BEGIN");
      try {
        await client.query("SET LOCAL lock_timeout = '10s'");
        await client.query("LOCK TABLE public.xxx_tl002_rapidgator_raw IN SHARE ROW EXCLUSIVE MODE");
        const currentKnown = await knownUrls(client, collection.rows.map((row) => row.file_url));
        const currentNewRows = collection.rows.filter((row) => !currentKnown.has(row.file_url));
        appliedRows = currentNewRows;
        report.rechecked_new_urls = currentNewRows.length;
        report.inserted = await insertNewRows(client, currentNewRows);
        if (report.inserted !== currentNewRows.length) {
          throw new Error(`Inserted ${report.inserted} rows but expected ${currentNewRows.length}`);
        }
        const duplicateCheck = await client.query(`
          SELECT file_url, COUNT(*)::integer AS copies
          FROM public.xxx_tl002_rapidgator_raw
          WHERE file_url = ANY($1::text[])
          GROUP BY file_url
          HAVING COUNT(*) > 1
          LIMIT 1
        `, [currentNewRows.map((row) => row.file_url)]);
        if (duplicateCheck.rows.length) {
          throw new Error(`Duplicate file URL after insert: ${duplicateCheck.rows[0].file_url}`);
        }
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
      const after = await knownUrls(client, newRows.map((row) => row.file_url));
      report.verified_urls_in_db = after.size;
      if (after.size !== newRows.length) throw new Error("Post-check URL count did not match planned delta");
      if (appliedRows.length) {
        report.applied_csv = path.join(directory, `rapidgator_delta_applied_${collection.runId}.csv`);
        writeCsv(report.applied_csv, appliedRows);
      }
    }
    process.stdout.write(JSON.stringify({ ...report, delta_csv: execute ? undefined : deltaPath }, null, 2) + "\n");
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  process.stderr.write(`Rapidgator delta import failed: ${error.message}\n`);
  process.exitCode = 1;
});
