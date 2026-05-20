const fs = require("fs");
const path = require("path");
const { Client } = require("pg");
require("dotenv").config({ path: path.join(__dirname, "..", ".env"), quiet: true });

const PROJECT_ROOT = path.resolve(__dirname, "..");

function envValue(...names) {
  for (const name of names) {
    const value = process.env[name];
    if (value !== undefined && value !== "") return value;
  }
  return "";
}

function resolveProjectPath(value, fallback) {
  if (!value) return fallback;
  return path.isAbsolute(value) ? value : path.resolve(PROJECT_ROOT, value);
}

const CONFIG = {
  csvPath: resolveProjectPath(
    envValue("FC2_MANUAL_MASTER_IMPORT_CSV", "MANUAL_MASTER_IMPORT_CSV"),
    path.join(PROJECT_ROOT, "manual_master_import.csv")
  ),
  logDir: resolveProjectPath(
    envValue("FC2_MANUAL_MASTER_IMPORT_LOG_DIR", "MANUAL_MASTER_IMPORT_LOG_DIR"),
    path.join(PROJECT_ROOT, "project_scripts", "manual_master_import_logs")
  ),
  mode: envValue("FC2_MANUAL_MASTER_IMPORT_MODE", "MANUAL_MASTER_IMPORT_MODE") || "dry-run",
  confirmExecute: envValue(
    "FC2_MANUAL_MASTER_IMPORT_CONFIRM_EXECUTE",
    "MANUAL_MASTER_IMPORT_CONFIRM_EXECUTE"
  ),
  chunkSize: 500,
};

const RUN_ID = `manual_master_import_${new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14)}_${process.pid}`;
const SOURCE_LABEL = "manual_master_import";
const MATCHED_BY_LABEL = "manual_master_import_csv";

function printLine(message = "") {
  process.stdout.write(`${message}\n`);
}

function printError(message = "") {
  process.stderr.write(`${message}\n`);
}

function usage() {
  return [
    "Usage:",
    "  node fc2_manual_master_import.js",
    "  node project_scripts/fc2_manual_master_import.js",
    "  node project_scripts/fc2_manual_master_import.js --csv manual_master_import.csv",
    "  node project_scripts/fc2_manual_master_import.js --execute --confirm-execute YES",
    "  node project_scripts/fc2_manual_master_import.js --log-dir project_scripts/manual_master_import_logs",
    "",
    "Environment switches:",
    "  FC2_MANUAL_MASTER_IMPORT_MODE=dry-run|execute",
    "  FC2_MANUAL_MASTER_IMPORT_CONFIRM_EXECUTE=YES",
    "  FC2_MANUAL_MASTER_IMPORT_CSV=manual_master_import.csv",
    "  FC2_MANUAL_MASTER_IMPORT_LOG_DIR=project_scripts/manual_master_import_logs",
    "",
    "CSV columns:",
    "  product_id,title,seller_id",
    "",
    "Notes:",
    "  - Dry-run is the default.",
    "  - Execute mode inserts only product_id values missing from public.master.",
    "  - product_id must be 6 or 7 digits to match the 5:30 file pipeline.",
  ].join("\n");
}

function parseArgs(argv) {
  const args = { ...CONFIG };

  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];

    if (arg === "--help" || arg === "-h") {
      args.help = true;
    } else if (arg === "--csv") {
      if (!next) throw new Error("--csv requires a path");
      args.csvPath = path.resolve(next);
      i += 1;
    } else if (arg === "--log-dir") {
      if (!next) throw new Error("--log-dir requires a path");
      args.logDir = path.resolve(next);
      i += 1;
    } else if (arg === "--dry-run") {
      args.mode = "dry-run";
    } else if (arg === "--execute") {
      args.mode = "execute";
    } else if (arg === "--confirm-execute") {
      if (!next) throw new Error("--confirm-execute requires YES");
      args.confirmExecute = next;
      i += 1;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!["dry-run", "execute"].includes(args.mode)) {
    throw new Error(`Invalid mode: ${args.mode}`);
  }

  return args;
}

function createPgClient() {
  return new Client({
    host: process.env.DB_HOST || "localhost",
    port: Number(process.env.DB_PORT || 5432),
    user: process.env.DB_USER || "postgres",
    password: process.env.DB_PASSWORD || "",
    database: process.env.DB_NAME || "mp4DB",
  });
}

function readCsvText(csvPath) {
  if (!fs.existsSync(csvPath)) {
    throw new Error(`CSV not found: ${csvPath}`);
  }

  return fs.readFileSync(csvPath, "utf8").replace(/^\uFEFF/, "");
}

function escapeCsvValue(value) {
  const text = value === null || value === undefined ? "" : String(value);
  if (/[",\r\n]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

function writeResultCsv(logDir, runId, rows) {
  fs.mkdirSync(logDir, { recursive: true });
  const headers = [
    "run_id",
    "mode",
    "line_number",
    "product_id",
    "title",
    "seller_id",
    "action",
    "result_status",
    "detail",
    "processed_at",
  ];
  const outputPath = path.join(logDir, `manual_master_import_${runId}.csv`);
  const lines = [
    headers.join(","),
    ...rows.map((row) => {
      return headers.map((header) => escapeCsvValue(row[header] || "")).join(",");
    }),
  ];

  fs.writeFileSync(outputPath, `${lines.join("\n")}\n`, "utf8");
  return outputPath;
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    const next = text[i + 1];

    if (inQuotes) {
      if (ch === '"' && next === '"') {
        field += '"';
        i += 1;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        field += ch;
      }
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (ch !== "\r") {
      field += ch;
    }
  }

  if (inQuotes) {
    throw new Error("CSV has an unclosed quoted field");
  }

  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  return rows.filter((cells) => cells.some((cell) => cell.trim() !== ""));
}

function loadManualRows(csvPath) {
  const parsed = parseCsv(readCsvText(csvPath));
  if (parsed.length === 0) {
    throw new Error("CSV is empty. Required header: product_id,title,seller_id");
  }

  const headers = parsed[0].map((cell) => cell.trim());
  const required = ["product_id", "title", "seller_id"];
  const index = new Map(headers.map((header, i) => [header, i]));

  for (const header of required) {
    if (!index.has(header)) {
      throw new Error(`CSV header is missing: ${header}`);
    }
  }

  const validRows = [];
  const invalidRows = [];
  const duplicateRows = [];
  const seen = new Set();

  parsed.slice(1).forEach((cells, offset) => {
    const lineNumber = offset + 2;
    const productId = String(cells[index.get("product_id")] || "").trim();
    const title = String(cells[index.get("title")] || "").trim();
    const sellerId = String(cells[index.get("seller_id")] || "").trim();
    const errors = [];

    if (!/^[0-9]{6,7}$/.test(productId)) {
      errors.push("product_id must be 6 or 7 digits");
    }
    if (!title) {
      errors.push("title is required");
    }

    if (errors.length > 0) {
      invalidRows.push({ lineNumber, productId, title, sellerId, errors });
      return;
    }

    if (seen.has(productId)) {
      duplicateRows.push({ lineNumber, productId, title, sellerId });
      return;
    }

    seen.add(productId);
    validRows.push({ lineNumber, productId, title, sellerId });
  });

  return { validRows, invalidRows, duplicateRows };
}

function chunkArray(items, size) {
  const chunks = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

async function loadExistingProductIds(client, productIds) {
  const existing = new Set();

  for (const chunk of chunkArray(productIds, 1000)) {
    const result = await client.query(
      "SELECT product_id FROM public.master WHERE product_id = ANY($1::text[])",
      [chunk]
    );

    for (const row of result.rows) {
      existing.add(String(row.product_id));
    }
  }

  return existing;
}

async function insertMissingRows(client, rows, chunkSize) {
  const inserted = new Set();

  for (const chunk of chunkArray(rows, chunkSize)) {
    const values = [];
    const placeholders = chunk.map((row, i) => {
      const base = i * 3;
      values.push(row.productId, row.title, row.sellerId);
      return `($${base + 1}, $${base + 2}, $${base + 3})`;
    });

    const result = await client.query(
      `
        INSERT INTO public.master (product_id, title, seller_id)
        VALUES ${placeholders.join(",")}
        ON CONFLICT (product_id) DO NOTHING
        RETURNING product_id
      `,
      values
    );

    for (const row of result.rows) {
      inserted.add(String(row.product_id));
    }
  }

  return inserted;
}

async function insertDbLogs(client, rows) {
  if (rows.length === 0) return;

  for (const chunk of chunkArray(rows, 500)) {
    const values = [];
    const placeholders = chunk.map((row, i) => {
      const base = i * 8;
      values.push(
        row.run_id,
        row.product_id || null,
        row.action,
        row.result_status,
        SOURCE_LABEL,
        MATCHED_BY_LABEL,
        row.detail,
        row.processed_at
      );
      return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7}, $${base + 8}::timestamptz)`;
    });

    await client.query(
      `
        INSERT INTO public.xxx_tl001_file_process_logs
          (run_id, product_id, action, status, source, matched_by, note, processed_at)
        VALUES ${placeholders.join(",")}
      `,
      values
    );
  }
}

function buildLogRow(args, row, action, resultStatus, detail) {
  return {
    run_id: RUN_ID,
    mode: args.mode,
    line_number: row.lineNumber || "",
    product_id: row.productId || "",
    title: row.title || "",
    seller_id: row.sellerId || "",
    action,
    result_status: resultStatus,
    detail,
    processed_at: new Date().toISOString(),
  };
}

function printRowSamples(label, rows, formatter) {
  if (rows.length === 0) return;

  printLine(`${label}: ${rows.length}`);
  rows.slice(0, 10).forEach((row) => {
    printLine(`  ${formatter(row)}`);
  });
  if (rows.length > 10) {
    printLine(`  ... ${rows.length - 10} more`);
  }
}

async function run() {
  const args = parseArgs(process.argv);

  if (args.help) {
    printLine(usage());
    return;
  }

  if (args.mode === "execute" && args.confirmExecute !== "YES") {
    throw new Error('Execute mode requires "--confirm-execute YES"');
  }

  const { validRows, invalidRows, duplicateRows } = loadManualRows(args.csvPath);
  const resultRows = [];

  if (invalidRows.length > 0) {
    printRowSamples("Invalid CSV rows", invalidRows, (row) => {
      return `line ${row.lineNumber}: product_id=${row.productId || "(blank)"} errors=${row.errors.join("; ")}`;
    });
    for (const row of invalidRows) {
      resultRows.push(buildLogRow(args, row, "validate", "invalid", row.errors.join("; ")));
    }
    const outputPath = writeResultCsv(args.logDir, RUN_ID, resultRows);
    printLine(`Result CSV: ${outputPath}`);
    throw new Error("CSV validation failed. No DB changes were made.");
  }

  const client = createPgClient();
  await client.connect();

  try {
    const existing = await loadExistingProductIds(
      client,
      validRows.map((row) => row.productId)
    );
    const missingRows = validRows.filter((row) => !existing.has(row.productId));
    const existingRows = validRows.filter((row) => existing.has(row.productId));

    for (const row of existingRows) {
      resultRows.push(buildLogRow(args, row, "manual_master_import", "skipped_existing", "product_id already exists in public.master"));
    }
    for (const row of duplicateRows) {
      resultRows.push(buildLogRow(args, row, "manual_master_import", "skipped_csv_duplicate", "duplicate product_id in CSV; first row is used"));
    }

    printLine(`Mode: ${args.mode}`);
    printLine(`Run ID: ${RUN_ID}`);
    printLine(`CSV: ${args.csvPath}`);
    printLine(`Valid CSV rows: ${validRows.length}`);
    printLine(`Duplicate CSV rows skipped: ${duplicateRows.length}`);
    printLine(`Already in master: ${existingRows.length}`);
    printLine(`Missing from master: ${missingRows.length}`);

    printRowSamples("Rows that would be inserted", missingRows, (row) => {
      return `line ${row.lineNumber}: ${row.productId}, ${row.title}, ${row.sellerId}`;
    });

    if (args.mode === "dry-run") {
      for (const row of missingRows) {
        resultRows.push(buildLogRow(args, row, "manual_master_import", "would_insert", "dry-run; no DB changes were made"));
      }
      const outputPath = writeResultCsv(args.logDir, RUN_ID, resultRows);
      printLine(`Result CSV: ${outputPath}`);
      printLine("Dry-run complete. No DB changes were made.");
      return;
    }

    await client.query("BEGIN");
    try {
      const insertedProductIds = await insertMissingRows(client, missingRows, args.chunkSize);
      for (const row of missingRows) {
        if (insertedProductIds.has(row.productId)) {
          resultRows.push(buildLogRow(args, row, "manual_master_import", "inserted", "inserted into public.master"));
        } else {
          resultRows.push(buildLogRow(args, row, "manual_master_import", "skipped_conflict", "product_id was inserted by another process before this insert"));
        }
      }
      await insertDbLogs(client, resultRows);
      await client.query("COMMIT");
      const outputPath = writeResultCsv(args.logDir, RUN_ID, resultRows);
      printLine(`Result CSV: ${outputPath}`);
      printLine(`Inserted rows: ${insertedProductIds.size}`);
    } catch (error) {
      await client.query("ROLLBACK");
      for (const row of missingRows) {
        resultRows.push(buildLogRow(args, row, "manual_master_import", "error", error.message));
      }
      const outputPath = writeResultCsv(args.logDir, RUN_ID, resultRows);
      printLine(`Result CSV: ${outputPath}`);
      throw error;
    }
  } finally {
    await client.end();
  }
}

run().catch((error) => {
  printError(`manual master import failed: ${error.message}`);
  process.exitCode = 1;
});
