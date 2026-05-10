const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const { Client } = require("pg");

const PROJECT_ROOT = path.resolve(__dirname, "..", "..");

const CONFIG = {
  mode: "dry-run", // dry-run | execute

  // TODO: Replace with your actual input folder.
  inputDir: path.join(__dirname, "sample_workspace", "input"),

  // TODO: Replace with your actual final base folder.
  finalBaseDir: path.join(__dirname, "sample_workspace", "final"),

  // TODO: Replace with your actual unmatched/hold/error folders.
  unmatchedDir: path.join(__dirname, "sample_workspace", "unmatched"),
  holdDir: path.join(__dirname, "sample_workspace", "hold"),
  errorDir: path.join(__dirname, "sample_workspace", "error"),

  // TODO: Replace with your actual CSV log folder.
  csvLogDir: path.join(__dirname, "sample_workspace", "logs"),

  // DB read source for master
  masterSource: "db", // db | csv
  masterCsvPath: path.join(__dirname, "sample_workspace", "master_sample.csv"),
  dbMasterView: "public.xxx_vq001_moviemaster_unique",

  // DB write targets
  dbOwnedTable: "public.xxx_tm002_owned_files",
  dbUnmatchedTable: "public.xxx_tm005_unmatched_files",
  dbLogTable: "public.xxx_tl001_file_process_logs",

  // metadata
  sourceLabel: "phase2_file_pipeline",
  matchedByLabel: "product_id_master_unique",
  unknownSellerFolder: "未名称",
  maxFileNameLength: 180,
  envPath: path.join(PROJECT_ROOT, ".env"),
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
  "planned_path",
  "status",
  "reason",
  "db_result",
  "file_size",
  "file_modified_at",
];

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) return writeUsage();
  if (args.initSample) initSampleWorkspace(path.join(__dirname, "sample_workspace"));

  const config = buildConfig(args);
  ensureDirectory(config.csvLogDir);
  ensureDirectory(config.finalBaseDir);
  ensureDirectory(config.unmatchedDir);
  ensureDirectory(config.holdDir);
  ensureDirectory(config.errorDir);

  const runId = args.runId || buildRunId("phase2_file_pipeline");
  const recoverySqlPath = path.join(config.csvLogDir, `manual_recovery_${runId}.sql`);
  const files = listMp4Files(config.inputDir);
  const selected = Number.isInteger(args.limit) ? files.slice(0, args.limit) : files;
  const master = await loadMaster(config, selected);

  const plannedPathSet = new Set();
  const rows = [];
  const dbClient = config.mode === "execute" ? await connectDb(config) : null;

  try {
    for (const filePath of selected) {
      const row = await processOne({
        filePath,
        runId,
        recoverySqlPath,
        config,
        master,
        dbClient,
        plannedPathSet,
      });
      rows.push(row);
    }
  } finally {
    if (dbClient) await dbClient.end();
  }

  const csvPath = path.join(config.csvLogDir, `file_process_${runId}.csv`);
  writeCsv(csvPath, rows, CSV_COLUMNS);

  const summary = summarize(rows);
  process.stdout.write(
    [
      `Phase2 pipeline completed (${config.mode}).`,
      `Processed: ${rows.length}`,
      `Matched: ${summary.matched}`,
      `Unmatched: ${summary.unmatched}`,
      `Hold: ${summary.hold}`,
      `Error: ${summary.error}`,
      `CSV: ${csvPath}`,
      "",
    ].join("\n")
  );
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    const next = argv[i + 1];
    if (key === "--help" || key === "-h") args.help = true;
    else if (key === "--init-sample") args.initSample = true;
    else if (key === "--mode") args.mode = consumeValue(key, next, argv, ++i);
    else if (key === "--input") args.input = consumeValue(key, next, argv, ++i);
    else if (key === "--master-source") args.masterSource = consumeValue(key, next, argv, ++i);
    else if (key === "--master") args.master = consumeValue(key, next, argv, ++i);
    else if (key === "--db-view") args.dbView = consumeValue(key, next, argv, ++i);
    else if (key === "--log-dir") args.logDir = consumeValue(key, next, argv, ++i);
    else if (key === "--final-base") args.finalBase = consumeValue(key, next, argv, ++i);
    else if (key === "--unmatched-dir") args.unmatchedDir = consumeValue(key, next, argv, ++i);
    else if (key === "--hold-dir") args.holdDir = consumeValue(key, next, argv, ++i);
    else if (key === "--error-dir") args.errorDir = consumeValue(key, next, argv, ++i);
    else if (key === "--run-id") args.runId = consumeValue(key, next, argv, ++i);
    else if (key === "--confirm-execute") args.confirmExecute = consumeValue(key, next, argv, ++i);
    else if (key === "--limit") args.limit = Number.parseInt(consumeValue(key, next, argv, ++i), 10);
    else throw new Error(`Unknown argument: ${key}`);
  }
  return args;
}

function buildConfig(args) {
  const mode = (args.mode || CONFIG.mode).toLowerCase();
  if (!["dry-run", "execute"].includes(mode)) throw new Error(`Invalid mode: ${mode}`);
  if (mode === "execute" && String(args.confirmExecute || "").toUpperCase() !== "YES") {
    throw new Error("execute mode requires --confirm-execute YES");
  }
  return {
    ...CONFIG,
    mode,
    inputDir: args.input || CONFIG.inputDir,
    masterSource: (args.masterSource || CONFIG.masterSource).toLowerCase(),
    masterCsvPath: args.master || CONFIG.masterCsvPath,
    dbMasterView: args.dbView || CONFIG.dbMasterView,
    csvLogDir: args.logDir || CONFIG.csvLogDir,
    finalBaseDir: args.finalBase || CONFIG.finalBaseDir,
    unmatchedDir: args.unmatchedDir || CONFIG.unmatchedDir,
    holdDir: args.holdDir || CONFIG.holdDir,
    errorDir: args.errorDir || CONFIG.errorDir,
  };
}

async function processOne(ctx) {
  const { filePath, runId, recoverySqlPath, config, master, dbClient, plannedPathSet } = ctx;
  const stat = await fsp.stat(filePath);
  const fileName = path.basename(filePath);
  const extracted = extractProductIds(fileName);

  const base = {
    run_id: runId,
    mode: config.mode,
    source_path: filePath,
    source_file_name: fileName,
    detected_product_id: extracted.primaryProductId || "",
    candidate_product_ids: extracted.candidateProductIds.join("|"),
    part_label: extracted.partLabel,
    match_status: "",
    planned_path: "",
    status: "",
    reason: "",
    db_result: "",
    file_size: String(stat.size),
    file_modified_at: stat.mtime.toISOString(),
  };

  if (extracted.candidateProductIds.length > 1) {
    const planned = uniquePlannedPath(path.join(config.holdDir, fileName), plannedPathSet);
    return finalizeRow(base, "hold", planned, "multiple_product_id_candidates", dbClient, config, stat, extracted, null, recoverySqlPath);
  }

  if (!extracted.primaryProductId) {
    const planned = uniquePlannedPath(path.join(config.unmatchedDir, fileName), plannedPathSet);
    return finalizeRow(base, "unmatched", planned, "product_id_not_found", dbClient, config, stat, extracted, null, recoverySqlPath);
  }

  const masterRow = master.get(extracted.primaryProductId);
  if (!masterRow) {
    const planned = uniquePlannedPath(path.join(config.unmatchedDir, fileName), plannedPathSet);
    return finalizeRow(base, "unmatched", planned, "product_id_not_in_master", dbClient, config, stat, extracted, null, recoverySqlPath);
  }

  const sellerName = sanitizePathSegment(
    masterRow.seller_name || masterRow.seller || masterRow.canonical_seller_name,
    config.unknownSellerFolder
  );
  const plannedName = buildPlannedFileName(extracted.primaryProductId, masterRow.title, extracted.partLabel, config.maxFileNameLength);
  const planned = uniquePlannedPath(path.join(config.finalBaseDir, sellerName, plannedName), plannedPathSet);
  return finalizeRow(base, "matched", planned, "matched_by_product_id", dbClient, config, stat, extracted, masterRow, recoverySqlPath);
}

async function finalizeRow(base, matchStatus, targetPath, reason, dbClient, config, sourceStat, extraction, masterRow, recoverySqlPath) {
  base.match_status = matchStatus;
  base.planned_path = targetPath;
  base.reason = reason;

  if (config.mode === "dry-run") {
    base.status = "dry_run";
    base.db_result = "not_written";
    return base;
  }

  let moved = false;
  try {
    ensureDirectory(path.dirname(targetPath));
    await moveFileNoCrossDeviceDelete(base.source_path, targetPath);
    moved = true;
    const targetStat = await fsp.stat(targetPath);

    if (dbClient) {
      try {
        await dbClient.query("BEGIN");

        if (matchStatus === "matched") {
          await insertOwned(dbClient, config, {
            productId: extraction.primaryProductId,
            currentPath: targetPath,
            currentFileName: path.basename(targetPath),
            source: config.sourceLabel,
            matchedBy: config.matchedByLabel,
            fileSize: targetStat.size,
            fileModifiedAt: targetStat.mtime,
          });
        } else {
          await insertUnmatched(dbClient, config, {
            runId: base.run_id,
            detectedPath: base.source_path,
            currentPath: targetPath,
            detectedFileName: base.source_file_name,
            currentFileName: path.basename(targetPath),
            extractedProductId: extraction.primaryProductId || "",
            reason,
            status: matchStatus === "hold" ? "pending" : "unmatched",
            source: config.sourceLabel,
            fileSize: targetStat.size,
            fileModifiedAt: targetStat.mtime,
          });
        }

        await insertLog(dbClient, config, {
          runId: base.run_id,
          oldPath: base.source_path,
          newPath: targetPath,
          oldFileName: base.source_file_name,
          newFileName: path.basename(targetPath),
          action: "Moved+Renamed",
          status: "success",
          source: config.sourceLabel,
          matchedBy: matchStatus === "matched" ? config.matchedByLabel : "unmatched_flow",
          note: reason,
        });

        await dbClient.query("COMMIT");
      } catch (dbError) {
        try {
          await dbClient.query("ROLLBACK");
        } catch {
          // noop: preserve original dbError as main cause
        }
        throw dbError;
      }
    }

    base.status = "success";
    base.db_result = "written";
    base.file_size = String(targetStat.size);
    base.file_modified_at = targetStat.mtime.toISOString();
    return base;
  } catch (error) {
    base.status = "error";
    base.db_result = `error:${error.message}`;
    if (config.mode === "execute") {
      const recoverySql = buildRecoverySql({
        config,
        base,
        matchStatus,
        reason,
        extraction,
        moved,
      });
      await appendRecoverySql(recoverySqlPath, recoverySql);
      base.db_result = `error:${error.message};recovery_sql:${path.basename(recoverySqlPath)}`;
    }
    return base;
  }
}

async function moveFileNoCrossDeviceDelete(sourcePath, destPath) {
  try {
    await fsp.rename(sourcePath, destPath);
  } catch (error) {
    if (error && error.code === "EXDEV") {
      throw new Error("cross_device_move_blocked");
    }
    throw error;
  }
}

async function loadMaster(config, filePaths) {
  if (config.masterSource === "csv") return loadMasterCsv(config.masterCsvPath);
  if (config.masterSource === "db") return loadMasterFromDb(config, collectPrimaryProductIds(filePaths));
  throw new Error(`Unknown master source: ${config.masterSource}`);
}

function collectPrimaryProductIds(filePaths) {
  const ids = new Set();
  for (const filePath of filePaths) {
    const ext = extractProductIds(path.basename(filePath));
    if (ext.primaryProductId) ids.add(ext.primaryProductId);
  }
  return [...ids].sort((a, b) => a.localeCompare(b));
}

async function loadMasterFromDb(config, productIds) {
  const map = new Map();
  if (productIds.length === 0) return map;
  assertSafeQualifiedName(config.dbMasterView, "db master view");
  loadEnvFile(config.envPath);
  const client = createPgClient();
  await client.connect();
  try {
    const result = await client.query(
      `SELECT product_id, title, seller_id FROM ${config.dbMasterView} WHERE product_id = ANY($1::text[])`,
      [productIds]
    );
    for (const row of result.rows) {
      map.set(String(row.product_id), {
        product_id: String(row.product_id),
        title: row.title || "",
        seller_id: row.seller_id || "",
        seller_name: "",
      });
    }
  } finally {
    await client.end();
  }
  return map;
}

function loadMasterCsv(csvPath) {
  if (!fs.existsSync(csvPath)) throw new Error(`Master CSV not found: ${csvPath}`);
  const text = fs.readFileSync(csvPath, "utf8").replace(/^\uFEFF/, "");
  const rows = parseCsv(text);
  const map = new Map();
  for (const row of rows) {
    const productId = row.product_id || row.number || row.ProductId || row.productId;
    if (!productId) continue;
    map.set(String(productId), {
      product_id: String(productId),
      title: row.title || "",
      seller_id: row.seller_id || "",
      seller_name: row.seller_name || row.seller || "",
    });
  }
  return map;
}

async function connectDb(config) {
  loadEnvFile(config.envPath);
  assertSafeQualifiedName(config.dbOwnedTable, "owned table");
  assertSafeQualifiedName(config.dbUnmatchedTable, "unmatched table");
  assertSafeQualifiedName(config.dbLogTable, "log table");
  const client = createPgClient();
  await client.connect();
  return client;
}

async function insertOwned(client, config, row) {
  await client.query(
    `INSERT INTO ${config.dbOwnedTable}
      (product_id, current_path, current_file_name, source, matched_by, status, file_size, file_modified_at, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,'owned',$6,$7,NOW(),NOW())`,
    [row.productId, row.currentPath, row.currentFileName, row.source, row.matchedBy, row.fileSize, row.fileModifiedAt]
  );
}

async function insertUnmatched(client, config, row) {
  await client.query(
    `INSERT INTO ${config.dbUnmatchedTable}
      (run_id, detected_path, current_path, detected_file_name, current_file_name, extracted_product_id, reason, status, source, file_size, file_modified_at, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NOW(),NOW())`,
    [
      row.runId,
      row.detectedPath,
      row.currentPath,
      row.detectedFileName,
      row.currentFileName,
      row.extractedProductId,
      row.reason,
      row.status,
      row.source,
      row.fileSize,
      row.fileModifiedAt,
    ]
  );
}

async function insertLog(client, config, row) {
  await client.query(
    `INSERT INTO ${config.dbLogTable}
      (run_id, old_path, new_path, old_file_name, new_file_name, action, status, source, matched_by, note)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [
      row.runId,
      row.oldPath,
      row.newPath,
      row.oldFileName,
      row.newFileName,
      row.action,
      row.status,
      row.source,
      row.matchedBy,
      row.note,
    ]
  );
}

function listMp4Files(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isFile() && path.extname(d.name).toLowerCase() === ".mp4")
    .map((d) => path.join(dir, d.name))
    .sort((a, b) => a.localeCompare(b, "ja"));
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
  while ((match = knownPattern.exec(mainPart)) !== null) candidates.push(match[1]);
  const leadingNumber = mainPart.match(/^(\d{6,7})(?:$|[^0-9])/);
  if (leadingNumber) candidates.push(leadingNumber[1]);
  const allRuns = mainPart.match(/\d{6,7}/g) || [];
  for (const value of allRuns) candidates.push(value);
  const unique = [...new Set(candidates)];
  return {
    primaryProductId: unique.length === 1 ? unique[0] : null,
    candidateProductIds: unique,
    partLabel,
  };
}

function buildPlannedFileName(productId, title, partLabel, maxLength) {
  const safeTitle = sanitizePathSegment(title, "no_title");
  const raw = `FC2 PPV ${productId} ${safeTitle}${partLabel}.mp4`;
  if (raw.length <= maxLength) return raw;
  const ext = path.extname(raw);
  const base = path.basename(raw, ext);
  return `${base.slice(0, Math.max(1, maxLength - ext.length))}${ext}`;
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

function summarize(rows) {
  return rows.reduce(
    (acc, row) => {
      if (row.status === "error") acc.error += 1;
      if (row.match_status === "matched") acc.matched += 1;
      else if (row.match_status === "hold") acc.hold += 1;
      else acc.unmatched += 1;
      return acc;
    },
    { matched: 0, unmatched: 0, hold: 0, error: 0 }
  );
}

async function appendRecoverySql(recoverySqlPath, sqlText) {
  const header = `-- manual recovery SQL generated at ${new Date().toISOString()}\n`;
  if (!fs.existsSync(recoverySqlPath)) {
    await fsp.writeFile(recoverySqlPath, header, "utf8");
  }
  await fsp.appendFile(recoverySqlPath, `${sqlText}\n`, "utf8");
}

function buildRecoverySql({ config, base, matchStatus, reason, extraction, moved }) {
  const q = sqlLiteral;
  if (!moved) {
    return [
      `-- ${base.source_file_name}`,
      `-- no SQL generated: file move not completed, verify file state manually`,
    ].join("\n");
  }

  if (matchStatus === "matched") {
    return [
      `-- ${base.source_file_name}`,
      `INSERT INTO ${config.dbOwnedTable} (product_id, current_path, current_file_name, source, matched_by, status, file_size, file_modified_at, created_at, updated_at)`,
      `VALUES (${q(extraction.primaryProductId || "")}, ${q(base.planned_path)}, ${q(path.basename(base.planned_path))}, ${q(config.sourceLabel)}, ${q(config.matchedByLabel)}, 'owned', ${Number(base.file_size || 0)}, ${q(base.file_modified_at)}::timestamptz, NOW(), NOW());`,
      `INSERT INTO ${config.dbLogTable} (run_id, old_path, new_path, old_file_name, new_file_name, action, status, source, matched_by, note)`,
      `VALUES (${q(base.run_id)}, ${q(base.source_path)}, ${q(base.planned_path)}, ${q(base.source_file_name)}, ${q(path.basename(base.planned_path))}, 'Moved+Renamed', 'success', ${q(config.sourceLabel)}, ${q(config.matchedByLabel)}, ${q(reason)});`,
    ].join("\n");
  }
  return [
    `-- ${base.source_file_name}`,
    `INSERT INTO ${config.dbUnmatchedTable} (run_id, detected_path, current_path, detected_file_name, current_file_name, extracted_product_id, reason, status, source, file_size, file_modified_at, created_at, updated_at)`,
    `VALUES (${q(base.run_id)}, ${q(base.source_path)}, ${q(base.planned_path)}, ${q(base.source_file_name)}, ${q(path.basename(base.planned_path))}, ${q(extraction.primaryProductId || "")}, ${q(reason)}, ${q(matchStatus === "hold" ? "pending" : "unmatched")}, ${q(config.sourceLabel)}, ${Number(base.file_size || 0)}, ${q(base.file_modified_at)}::timestamptz, NOW(), NOW());`,
    `INSERT INTO ${config.dbLogTable} (run_id, old_path, new_path, old_file_name, new_file_name, action, status, source, matched_by, note)`,
    `VALUES (${q(base.run_id)}, ${q(base.source_path)}, ${q(base.planned_path)}, ${q(base.source_file_name)}, ${q(path.basename(base.planned_path))}, 'Moved+Renamed', 'success', ${q(config.sourceLabel)}, 'unmatched_flow', ${q(reason)});`,
  ].join("\n");
}

function sqlLiteral(value) {
  return `'${String(value == null ? "" : value).replace(/'/g, "''")}'`;
}

function writeCsv(csvPath, rows, columns) {
  const lines = [columns.join(",")];
  for (const row of rows) lines.push(columns.map((c) => csvEscape(row[c])).join(","));
  fs.writeFileSync(csvPath, `${lines.join("\n")}\n`, "utf8");
}

function csvEscape(value) {
  const text = String(value == null ? "" : value);
  return `"${text.replace(/"/g, '""')}"`;
}

function parseCsv(text) {
  const lines = text.split(/\r?\n/).filter((line) => line.length > 0);
  if (lines.length === 0) return [];
  const headers = parseCsvLine(lines[0]);
  return lines.slice(1).map((line) => {
    const values = parseCsvLine(line);
    const row = {};
    headers.forEach((header, idx) => {
      row[header] = values[idx] || "";
    });
    return row;
  });
}

function parseCsvLine(line) {
  const out = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    const next = line[i + 1];
    if (ch === '"' && inQuotes && next === '"') {
      cur += '"';
      i += 1;
    } else if (ch === '"') inQuotes = !inQuotes;
    else if (ch === "," && !inQuotes) {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

function buildRunId(label) {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "").replace("T", "_");
  return `${stamp}_${label}`;
}

function assertSafeQualifiedName(value, label) {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*\.[a-zA-Z_][a-zA-Z0-9_]*$/.test(value)) {
    throw new Error(`Unsafe ${label}: ${value}`);
  }
}

function loadEnvFile(envPath) {
  if (!fs.existsSync(envPath)) throw new Error(`.env not found: ${envPath}`);
  const text = fs.readFileSync(envPath, "utf8");
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator === -1) continue;
    const key = line.slice(0, separator).trim();
    const value = unquoteEnvValue(line.slice(separator + 1).trim());
    if (key && process.env[key] === undefined) process.env[key] = value;
  }
}

function unquoteEnvValue(value) {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}

function requireEnv(name) {
  const value = process.env[name];
  if (!value || value.startsWith("CHANGE_ME_")) throw new Error(`${name} is not configured in .env`);
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

function consumeValue(name, value) {
  if (!value || value.startsWith("--")) throw new Error(`Missing value for ${name}`);
  return value;
}

function ensureDirectory(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function writeUsage() {
  process.stdout.write(
    [
      "Usage:",
      "  node phase2_file_pipeline.js --mode dry-run --input <folder> --master-source db --log-dir <folder>",
      "  node phase2_file_pipeline.js --mode execute --input <folder> --master-source db --log-dir <folder>",
      "",
      "Notes:",
      "  - execute mode moves files and writes DB rows.",
      "  - cross-device move (EXDEV) is blocked for safety in this version.",
      "",
    ].join("\n")
  );
}

function initSampleWorkspace(root) {
  const input = path.join(root, "input");
  const logs = path.join(root, "logs");
  ensureDirectory(input);
  ensureDirectory(logs);
  const samples = ["FC2-PPV-1234567_1.mp4", "fc2ppv-234567.mp4", "no-number-sample.mp4"];
  for (const file of samples) {
    const p = path.join(input, file);
    if (!fs.existsSync(p)) fs.writeFileSync(p, "sample", "utf8");
  }
  const masterCsv = [
    "product_id,title,seller_name",
    `"1234567","Sample Title One","Sample Seller"`,
    `"234567","Six Digit Sample",""`,
  ].join("\n");
  fs.writeFileSync(path.join(root, "master_sample.csv"), `${masterCsv}\n`, "utf8");
}

main().catch((error) => {
  process.stderr.write(`Phase2 pipeline failed: ${error.message}\n`);
  process.exitCode = 1;
});
