const fs = require("fs");
const path = require("path");
const { Client } = require("pg");

const PROJECT_ROOT = path.resolve(__dirname, "..", "..");

const CONFIG = {
  // TODO: Replace this with the real manual download folder path.
  manualDownloadDir: path.join(__dirname, "sample_workspace", "download"),

  // TODO: Replace this with the real temporary staging folder path.
  stagingDir: path.join(__dirname, "sample_workspace", "staging"),

  // TODO: Replace this with the real final storage base folder path.
  finalBaseDir: path.join(__dirname, "sample_workspace", "final"),

  // TODO: Replace this with the real unmatched folder path.
  unmatchedDir: path.join(__dirname, "sample_workspace", "unmatched"),

  // TODO: Replace this with the real hold folder path.
  holdDir: path.join(__dirname, "sample_workspace", "hold"),

  // TODO: Replace this with the real error folder path.
  errorDir: path.join(__dirname, "sample_workspace", "error"),

  // TODO: Replace this with the real CSV log folder path.
  csvLogDir: path.join(__dirname, "sample_workspace", "logs"),

  // Trial substitute for DB view xxx_vq001_moviemaster_unique.
  masterCsvPath: path.join(__dirname, "sample_workspace", "master_sample.csv"),

  // TODO: Keep this as public.xxx_vq001_moviemaster_unique unless the DB view name changes.
  dbMasterView: "public.xxx_vq001_moviemaster_unique",

  // TODO: Replace .env values directly in the project root .env file.
  envPath: path.join(PROJECT_ROOT, ".env"),

  // Use "csv" for sample trials, or "db" for PostgreSQL read-only matching.
  masterSource: "csv",

  recurse: true,
  stableWaitMs: 500,
  maxFileNameLength: 180,
  defaultUnknownSellerFolder: "未名称",
};

const CSV_COLUMNS = [
  "run_id",
  "mode",
  "source_path",
  "source_file_name",
  "detected_product_id",
  "candidate_product_ids",
  "part_label",
  "match_status",
  "master_title",
  "seller_name",
  "planned_file_name",
  "planned_final_path",
  "planned_unmatched_path",
  "planned_db_table",
  "planned_db_action",
  "status",
  "reason",
  "file_size",
  "file_modified_at",
];

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    writeUsage();
    return;
  }

  if (args.initSample) {
    initSampleWorkspace(args.sampleRoot || path.join(__dirname, "sample_workspace"));
  }

  const config = {
    ...CONFIG,
    manualDownloadDir: args.input || CONFIG.manualDownloadDir,
    masterCsvPath: args.master || CONFIG.masterCsvPath,
    dbMasterView: args.dbView || CONFIG.dbMasterView,
    envPath: args.env || CONFIG.envPath,
    masterSource: (args.masterSource || CONFIG.masterSource).toLowerCase(),
    csvLogDir: args.logDir || CONFIG.csvLogDir,
    finalBaseDir: args.finalBase || CONFIG.finalBaseDir,
    unmatchedDir: args.unmatchedDir || CONFIG.unmatchedDir,
    holdDir: args.holdDir || CONFIG.holdDir,
    errorDir: args.errorDir || CONFIG.errorDir,
  };

  const limit = Number.isInteger(args.limit) ? args.limit : null;
  const runId = args.runId || buildRunId("minimum_dry_run");

  ensureDirectory(config.csvLogDir);

  const files = listMp4Files(config.manualDownloadDir, config.recurse);
  const selectedFiles = limit ? files.slice(0, limit) : files;
  const master = await loadMaster(config, selectedFiles);
  const plannedPathSet = new Set();
  const rows = selectedFiles.map((filePath) => {
    return buildDryRunRow(filePath, master, config, runId, plannedPathSet);
  });

  const logPath = path.join(config.csvLogDir, `file_process_${runId}.csv`);
  writeCsv(logPath, rows, CSV_COLUMNS);

  const summary = summarizeRows(rows);
  process.stdout.write([
    "Minimum dry-run completed.",
    `Input files: ${files.length}`,
    `Processed files: ${rows.length}`,
    `Matched: ${summary.matched}`,
    `Unmatched: ${summary.unmatched}`,
    `Hold: ${summary.hold}`,
    `CSV: ${logPath}`,
    "",
  ].join("\n"));
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];

    if (arg === "--help" || arg === "-h") args.help = true;
    else if (arg === "--init-sample") args.initSample = true;
    else if (arg === "--sample-root") args.sampleRoot = consumeValue(arg, next, argv, ++i);
    else if (arg === "--input") args.input = consumeValue(arg, next, argv, ++i);
    else if (arg === "--master") args.master = consumeValue(arg, next, argv, ++i);
    else if (arg === "--master-source") args.masterSource = consumeValue(arg, next, argv, ++i);
    else if (arg === "--db-view") args.dbView = consumeValue(arg, next, argv, ++i);
    else if (arg === "--env") args.env = consumeValue(arg, next, argv, ++i);
    else if (arg === "--log-dir") args.logDir = consumeValue(arg, next, argv, ++i);
    else if (arg === "--final-base") args.finalBase = consumeValue(arg, next, argv, ++i);
    else if (arg === "--unmatched-dir") args.unmatchedDir = consumeValue(arg, next, argv, ++i);
    else if (arg === "--hold-dir") args.holdDir = consumeValue(arg, next, argv, ++i);
    else if (arg === "--error-dir") args.errorDir = consumeValue(arg, next, argv, ++i);
    else if (arg === "--run-id") args.runId = consumeValue(arg, next, argv, ++i);
    else if (arg === "--limit") args.limit = Number.parseInt(consumeValue(arg, next, argv, ++i), 10);
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return args;
}

function consumeValue(name, value) {
  if (!value || value.startsWith("--")) {
    throw new Error(`Missing value for ${name}`);
  }
  return value;
}

function writeUsage() {
  process.stdout.write([
    "Usage:",
    "  node minimum_dry_run.js --init-sample",
    "  node minimum_dry_run.js --input <folder> --master <csv> --log-dir <folder>",
    "  node minimum_dry_run.js --master-source db --input <folder> --log-dir <folder>",
    "",
    "This script performs a dry-run only.",
    "It does not move files, rename files, or write to PostgreSQL.",
    "",
  ].join("\n"));
}

function buildRunId(label) {
  const stamp = new Date()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\..+$/, "")
    .replace("T", "_");
  return `${stamp}_${label}`;
}

function listMp4Files(dir, recurse) {
  if (!fs.existsSync(dir)) return [];

  const result = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory() && recurse) {
      result.push(...listMp4Files(fullPath, recurse));
    } else if (entry.isFile() && path.extname(entry.name).toLowerCase() === ".mp4") {
      result.push(fullPath);
    }
  }

  return result.sort((a, b) => a.localeCompare(b, "ja"));
}

function buildDryRunRow(filePath, master, config, runId, plannedPathSet) {
  const stat = fs.statSync(filePath);
  const fileName = path.basename(filePath);
  const extraction = extractProductIds(fileName);
  const productId = extraction.primaryProductId;
  const candidateIds = extraction.candidateProductIds;
  const partLabel = extraction.partLabel;

  if (candidateIds.length > 1) {
    const plannedHoldPath = uniquePlannedPath(
      path.join(config.holdDir, fileName),
      plannedPathSet
    );
    return buildBaseRow({
      runId,
      filePath,
      fileName,
      productId: "",
      candidateIds,
      partLabel,
      matchStatus: "hold",
      plannedUnmatchedPath: plannedHoldPath,
      plannedDbTable: "xxx_tm005_unmatched_files",
      plannedDbAction: "insert_hold_candidate",
      status: "dry_run",
      reason: "multiple_product_id_candidates",
      stat,
    });
  }

  if (!productId) {
    const plannedUnmatchedPath = uniquePlannedPath(
      path.join(config.unmatchedDir, fileName),
      plannedPathSet
    );
    return buildBaseRow({
      runId,
      filePath,
      fileName,
      productId: "",
      candidateIds,
      partLabel,
      matchStatus: "unmatched",
      plannedUnmatchedPath,
      plannedDbTable: "xxx_tm005_unmatched_files",
      plannedDbAction: "insert_unmatched",
      status: "dry_run",
      reason: "product_id_not_found",
      stat,
    });
  }

  const masterRow = master.get(productId);
  if (!masterRow) {
    const plannedUnmatchedPath = uniquePlannedPath(
      path.join(config.unmatchedDir, fileName),
      plannedPathSet
    );
    return buildBaseRow({
      runId,
      filePath,
      fileName,
      productId,
      candidateIds,
      partLabel,
      matchStatus: "unmatched",
      plannedUnmatchedPath,
      plannedDbTable: "xxx_tm005_unmatched_files",
      plannedDbAction: "insert_unmatched",
      status: "dry_run",
      reason: "product_id_not_in_master",
      stat,
    });
  }

  const sellerFolder = sanitizePathSegment(
    masterRow.seller_name || masterRow.seller || masterRow.canonical_seller_name,
    config.defaultUnknownSellerFolder
  );
  const plannedFileName = buildPlannedFileName(productId, masterRow.title, partLabel, config);
  const plannedFinalPath = uniquePlannedPath(
    path.join(config.finalBaseDir, sellerFolder, plannedFileName),
    plannedPathSet
  );

  return buildBaseRow({
    runId,
    filePath,
    fileName,
    productId,
    candidateIds,
    partLabel,
    matchStatus: "matched",
    masterTitle: masterRow.title,
    sellerName: masterRow.seller_name || masterRow.seller || masterRow.canonical_seller_name || "",
    plannedFileName: path.basename(plannedFinalPath),
    plannedFinalPath,
    plannedDbTable: "xxx_tm002_owned_files",
    plannedDbAction: "insert_owned_after_successful_move",
    status: "dry_run",
    reason: "matched_by_product_id",
    stat,
  });
}

function buildBaseRow(data) {
  return {
    run_id: data.runId,
    mode: "dry_run",
    source_path: data.filePath,
    source_file_name: data.fileName,
    detected_product_id: data.productId || "",
    candidate_product_ids: (data.candidateIds || []).join("|"),
    part_label: data.partLabel || "",
    match_status: data.matchStatus || "",
    master_title: data.masterTitle || "",
    seller_name: data.sellerName || "",
    planned_file_name: data.plannedFileName || "",
    planned_final_path: data.plannedFinalPath || "",
    planned_unmatched_path: data.plannedUnmatchedPath || "",
    planned_db_table: data.plannedDbTable || "",
    planned_db_action: data.plannedDbAction || "",
    status: data.status || "dry_run",
    reason: data.reason || "",
    file_size: String(data.stat ? data.stat.size : ""),
    file_modified_at: data.stat ? data.stat.mtime.toISOString() : "",
  };
}

function extractProductIds(fileName) {
  const ext = path.extname(fileName);
  const baseNoExt = path.basename(fileName, ext);
  const partMatch = baseNoExt.match(/([_-]\d{1,2})$/);
  const partLabel = partMatch ? partMatch[1] : "";
  const mainPart = partLabel ? baseNoExt.slice(0, -partLabel.length) : baseNoExt;

  const candidates = [];
  const knownPattern = /(?:FC2[-_\s]?PPV[-_\s]?|fc2ppv[-_\s]?|fc2-ppv-|hhd800\.com@FC2-PPV-|supjav\.com@fc2ppv-)(\d{6,7})/gi;
  let match;
  while ((match = knownPattern.exec(mainPart)) !== null) {
    candidates.push(match[1]);
  }

  const leadingNumber = mainPart.match(/^(\d{6,7})(?:$|[^0-9])/);
  if (leadingNumber) candidates.push(leadingNumber[1]);

  const allNumberRuns = mainPart.match(/\d{6,7}/g) || [];
  for (const value of allNumberRuns) candidates.push(value);

  const uniqueCandidates = [...new Set(candidates)];
  return {
    primaryProductId: uniqueCandidates.length === 1 ? uniqueCandidates[0] : null,
    candidateProductIds: uniqueCandidates,
    partLabel,
  };
}

function buildPlannedFileName(productId, title, partLabel, config) {
  const safeTitle = sanitizePathSegment(title, "no_title");
  const rawName = `FC2 PPV ${productId} ${safeTitle}${partLabel}.mp4`;
  return truncateFileName(rawName, config.maxFileNameLength);
}

function sanitizePathSegment(value, fallback) {
  const cleaned = String(value || "")
    .replace(/[\\/:*?"<>|]/g, "")
    .replace(/[\u0000-\u001f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[. ]+$/g, "");
  return cleaned || fallback;
}

function truncateFileName(fileName, maxLength) {
  if (fileName.length <= maxLength) return fileName;
  const ext = path.extname(fileName);
  const base = path.basename(fileName, ext);
  return `${base.slice(0, Math.max(1, maxLength - ext.length))}${ext}`;
}

function uniquePlannedPath(targetPath, plannedPathSet) {
  const parsed = path.parse(targetPath);
  let index = 0;
  let candidate = targetPath;

  while (plannedPathSet.has(candidate.toLowerCase()) || fs.existsSync(candidate)) {
    index += 1;
    candidate = path.join(parsed.dir, `${parsed.name}(${index})${parsed.ext}`);
  }

  plannedPathSet.add(candidate.toLowerCase());
  return candidate;
}

async function loadMaster(config, selectedFiles) {
  if (config.masterSource === "csv") {
    return loadMasterCsv(config.masterCsvPath);
  }

  if (config.masterSource === "db") {
    return loadMasterFromDb(config, collectPrimaryProductIds(selectedFiles));
  }

  throw new Error(`Unknown master source: ${config.masterSource}`);
}

function collectPrimaryProductIds(filePaths) {
  const ids = new Set();

  for (const filePath of filePaths) {
    const extraction = extractProductIds(path.basename(filePath));
    if (extraction.primaryProductId) ids.add(extraction.primaryProductId);
  }

  return [...ids].sort((a, b) => a.localeCompare(b));
}

async function loadMasterFromDb(config, productIds) {
  const master = new Map();
  if (productIds.length === 0) return master;

  assertSafeQualifiedName(config.dbMasterView, "db master view");
  loadEnvFile(config.envPath);

  const client = createPgClient();
  await client.connect();

  try {
    const result = await client.query(
      `
        SELECT product_id, title, seller_id
        FROM ${config.dbMasterView}
        WHERE product_id = ANY($1::text[])
      `,
      [productIds]
    );

    for (const row of result.rows) {
      master.set(String(row.product_id), {
        product_id: String(row.product_id),
        title: row.title || "",
        seller_id: row.seller_id || "",
        seller_name: "",
        canonical_seller_name: "",
      });
    }
  } finally {
    await client.end();
  }

  return master;
}

function assertSafeQualifiedName(value, label) {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*\.[a-zA-Z_][a-zA-Z0-9_]*$/.test(value)) {
    throw new Error(`Unsafe ${label}: ${value}`);
  }
}

function loadEnvFile(envPath) {
  if (!fs.existsSync(envPath)) {
    throw new Error(`.env not found: ${envPath}`);
  }

  const text = fs.readFileSync(envPath, "utf8");
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

function requireEnv(name) {
  const value = process.env[name];
  if (!value || value.startsWith("CHANGE_ME_")) {
    throw new Error(`${name} is not configured in .env`);
  }
  return value;
}

function createPgClient() {
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

function loadMasterCsv(csvPath) {
  if (!fs.existsSync(csvPath)) {
    throw new Error(`Master CSV not found: ${csvPath}`);
  }

  const text = fs.readFileSync(csvPath, "utf8").replace(/^\uFEFF/, "");
  const rows = parseCsv(text);
  const master = new Map();

  for (const row of rows) {
    const productId = row.product_id || row.number || row.ProductId || row.productId;
    if (!productId) continue;
    master.set(String(productId), {
      product_id: String(productId),
      title: row.title || row.Title || "",
      seller_id: row.seller_id || row.sellerId || "",
      seller_name: row.seller_name || row.seller || row.Seller || "",
      canonical_seller_name: row.canonical_seller_name || "",
    });
  }

  return master;
}

function parseCsv(text) {
  const lines = text.split(/\r?\n/).filter((line) => line.length > 0);
  if (lines.length === 0) return [];

  const headers = parseCsvLine(lines[0]);
  return lines.slice(1).map((line) => {
    const values = parseCsvLine(line);
    const row = {};
    headers.forEach((header, index) => {
      row[header] = values[index] || "";
    });
    return row;
  });
}

function parseCsvLine(line) {
  const result = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    const next = line[i + 1];

    if (char === '"' && inQuotes && next === '"') {
      current += '"';
      i += 1;
    } else if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === "," && !inQuotes) {
      result.push(current);
      current = "";
    } else {
      current += char;
    }
  }

  result.push(current);
  return result;
}

function writeCsv(csvPath, rows, columns) {
  const lines = [
    columns.join(","),
    ...rows.map((row) => columns.map((column) => csvEscape(row[column])).join(",")),
  ];
  fs.writeFileSync(csvPath, `${lines.join("\n")}\n`, "utf8");
}

function csvEscape(value) {
  const text = String(value == null ? "" : value);
  return `"${text.replace(/"/g, '""')}"`;
}

function summarizeRows(rows) {
  return rows.reduce(
    (acc, row) => {
      if (row.match_status === "matched") acc.matched += 1;
      else if (row.match_status === "hold") acc.hold += 1;
      else acc.unmatched += 1;
      return acc;
    },
    { matched: 0, unmatched: 0, hold: 0 }
  );
}

function ensureDirectory(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function initSampleWorkspace(root) {
  const downloadDir = path.join(root, "download");
  const logsDir = path.join(root, "logs");
  ensureDirectory(downloadDir);
  ensureDirectory(logsDir);

  const sampleFiles = [
    "FC2-PPV-1234567_1.mp4",
    "fc2ppv-234567.mp4",
    "no-number-sample.mp4",
    "FC2PPV-3456789-extra-7654321.mp4",
  ];

  for (const name of sampleFiles) {
    const filePath = path.join(downloadDir, name);
    if (!fs.existsSync(filePath)) fs.writeFileSync(filePath, "");
  }

  const masterCsv = [
    "product_id,title,seller_name",
    csvEscape("1234567") + "," + csvEscape("Sample Title One") + "," + csvEscape("Sample Seller"),
    csvEscape("234567") + "," + csvEscape("Six Digit Sample") + "," + csvEscape(""),
  ].join("\n");
  fs.writeFileSync(path.join(root, "master_sample.csv"), `${masterCsv}\n`, "utf8");
}

main().catch((error) => {
  process.stderr.write(`Minimum dry-run failed: ${error.message}\n`);
  process.exitCode = 1;
});
