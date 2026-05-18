const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const { spawn } = require("child_process");
const { Client } = require("pg");
const ffprobe = require("ffprobe-static");

const PROJECT_ROOT = path.resolve(__dirname, "..", "..");

const CONFIG = {
  mode: "dry-run", // dry-run | execute

  // ============================================================
  // ★★★ 対象フォルダ ★★★
  // このフォルダ以下の全階層をスキャンします
  // ============================================================
  inputDir: path.join(__dirname, "sample_workspace", "input"),

  // ============================================================
  // ★★★ mp4 の移動先 ★★★
  // matched は finalBaseDir / seller_id / リネーム後ファイル名 に移動
  // ============================================================
  finalBaseDir: path.join(__dirname, "sample_workspace", "final"),

  // ============================================================
  // ★★★ mp4 の振り分け先 ★★★
  // DBマスターに無いもの、IDが取れないもの、候補が複数あるものなど
  // ============================================================
  unmatchedDir: path.join(__dirname, "sample_workspace", "unmatched"),
  holdDir: path.join(__dirname, "sample_workspace", "hold"),
  errorDir: path.join(__dirname, "sample_workspace", "error"),

  // ============================================================
  // ★★★ mp4以外の検査用フォルダ ★★★
  // txt, csv, jpg, zip などはDBに書かず、ここへカテゴリ別に移動
  // ============================================================
  inspectionDir: path.join(__dirname, "sample_workspace", "inspection"),

  // ============================================================
  // ★★★ CSVログ出力先 ★★★
  // ============================================================
  csvLogDir: path.join(__dirname, "sample_workspace", "logs"),

  // ============================================================
  // ★★★ DB read source for master ★★★
  // ============================================================
  masterSource: "db", // db | csv
  masterCsvPath: path.join(__dirname, "sample_workspace", "master_sample.csv"),
  dbMasterView: "public.xxx_vq001_moviemaster_unique",

  // ============================================================
  // ★★★ DB write targets ★★★
  // execute時のみ書き込みます
  // ============================================================
  dbOwnedTable: "public.xxx_tm002_owned_files",
  dbUnmatchedTable: "public.xxx_tm005_unmatched_files",
  dbLogTable: "public.xxx_tl001_file_process_logs",
  dbVideoMetadataTable: "public.xxx_tm011_owned_file_video_metadata",

  // ============================================================
  // ★★★ metadata ★★★
  // ============================================================
  sourceLabel: "phase2_file_pipeline_recursive",
  matchedByLabel: "product_id_master_unique",
  unknownSellerFolder: "未名称",
  maxFileNameLength: 180,
  envPath: path.join(PROJECT_ROOT, ".env"),
  ffprobeTimeoutMs: 30000,

  // mp4以外のリネーム接頭辞
  nonMp4Prefix: "inspection",
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

const NON_MP4_CSV_COLUMNS = [
  "run_id",
  "mode",
  "source_path",
  "source_file_name",
  "extension",
  "category",
  "planned_path",
  "status",
  "reason",
  "file_size",
  "file_modified_at",
];

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) return writeUsage();
  if (args.initSample) initSampleWorkspace(path.join(__dirname, "sample_workspace"));

  loadEnvFile(CONFIG.envPath);

  const config = buildConfig(args);

  ensureDirectory(config.csvLogDir);
  ensureDirectory(config.finalBaseDir);
  ensureDirectory(config.unmatchedDir);
  ensureDirectory(config.holdDir);
  ensureDirectory(config.errorDir);
  ensureDirectory(config.inspectionDir);

  const runId = args.runId || buildRunId(config.sourceLabel);
  const recoverySqlPath = path.join(config.csvLogDir, `manual_recovery_${runId}.sql`);

  const excludeDirs = buildExcludeDirs(config);

  const allFiles = listFilesRecursive(config.inputDir, excludeDirs);

  const mp4Files = allFiles.filter(
    (filePath) => path.extname(filePath).toLowerCase() === ".mp4"
  );

  const nonMp4Files = allFiles.filter(
    (filePath) => path.extname(filePath).toLowerCase() !== ".mp4"
  );

  const selectedMp4Files = Number.isInteger(args.limit)
    ? mp4Files.slice(0, args.limit)
    : mp4Files;

  const master = await loadMaster(config, selectedMp4Files);

  const plannedPathSet = new Set();
  const rows = [];
  const nonMp4Rows = [];

  const dbClient = config.mode === "execute" ? await connectDb(config) : null;

  try {
    for (const filePath of selectedMp4Files) {
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

    const selectedMp4Set = new Set(selectedMp4Files.map((p) => path.resolve(p).toLowerCase()));

    const nonMp4Targets =
      Number.isInteger(args.limit)
        ? nonMp4Files.filter((p) => !selectedMp4Set.has(path.resolve(p).toLowerCase()))
        : nonMp4Files;

    for (const filePath of nonMp4Targets) {
      const row = await processNonMp4File({
        filePath,
        runId,
        config,
        plannedPathSet,
      });
      nonMp4Rows.push(row);
    }
  } finally {
    if (dbClient) await dbClient.end();
  }

  if (config.mode === "execute") {
    await removeEmptyDirectories(config.inputDir, excludeDirs);
  }

  const csvPath = path.join(config.csvLogDir, `file_process_${runId}.csv`);
  writeCsv(csvPath, rows, CSV_COLUMNS);

  const nonMp4CsvPath = path.join(config.csvLogDir, `non_mp4_process_${runId}.csv`);
  writeCsv(nonMp4CsvPath, nonMp4Rows, NON_MP4_CSV_COLUMNS);

  const summary = summarize(rows);
  const nonMp4Summary = summarizeNonMp4(nonMp4Rows);

  process.stdout.write(
    [
      `Phase2 recursive pipeline completed (${config.mode}).`,
      `MP4 Processed: ${rows.length}`,
      `MP4 Matched: ${summary.matched}`,
      `MP4 Unmatched: ${summary.unmatched}`,
      `MP4 Hold: ${summary.hold}`,
      `MP4 Error: ${summary.error}`,
      `Non-MP4 Processed: ${nonMp4Rows.length}`,
      `Non-MP4 Moved/DryRun: ${nonMp4Summary.ok}`,
      `Non-MP4 Error: ${nonMp4Summary.error}`,
      `MP4 CSV: ${csvPath}`,
      `Non-MP4 CSV: ${nonMp4CsvPath}`,
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
    else if (key === "--inspection-dir") args.inspectionDir = consumeValue(key, next, argv, ++i);
    else if (key === "--run-id") args.runId = consumeValue(key, next, argv, ++i);
    else if (key === "--confirm-execute") args.confirmExecute = consumeValue(key, next, argv, ++i);
    else if (key === "--limit") args.limit = Number.parseInt(consumeValue(key, next, argv, ++i), 10);
    else if (key === "--ffprobe-timeout-ms") args.ffprobeTimeoutMs = Number.parseInt(consumeValue(key, next, argv, ++i), 10);
    else throw new Error(`Unknown argument: ${key}`);
  }

  return args;
}

function buildConfig(args) {
  const mode = (
    args.mode ||
    envValue("PHASE2_FILE_PIPELINE_MODE") ||
    CONFIG.mode
  ).toLowerCase();
  const confirmExecute =
    args.confirmExecute || envValue("PHASE2_FILE_PIPELINE_CONFIRM_EXECUTE");

  if (!["dry-run", "execute"].includes(mode)) {
    throw new Error(`Invalid mode: ${mode}`);
  }

  if (mode === "execute" && String(confirmExecute || "").toUpperCase() !== "YES") {
    throw new Error("execute mode requires --confirm-execute YES");
  }

  return {
    ...CONFIG,
    mode,
    inputDir: args.input || envValue("PHASE2_FILE_PIPELINE_INPUT_DIR") || CONFIG.inputDir,
    masterSource: (
      args.masterSource ||
      envValue("PHASE2_FILE_PIPELINE_MASTER_SOURCE") ||
      CONFIG.masterSource
    ).toLowerCase(),
    masterCsvPath: args.master || envValue("PHASE2_FILE_PIPELINE_MASTER_CSV") || CONFIG.masterCsvPath,
    dbMasterView: args.dbView || envValue("PHASE2_FILE_PIPELINE_DB_VIEW") || CONFIG.dbMasterView,
    csvLogDir: args.logDir || envValue("PHASE2_FILE_PIPELINE_LOG_DIR") || CONFIG.csvLogDir,
    finalBaseDir: args.finalBase || envValue("PHASE2_FILE_PIPELINE_FINAL_BASE") || CONFIG.finalBaseDir,
    unmatchedDir: args.unmatchedDir || envValue("PHASE2_FILE_PIPELINE_UNMATCHED_DIR") || CONFIG.unmatchedDir,
    holdDir: args.holdDir || envValue("PHASE2_FILE_PIPELINE_HOLD_DIR") || CONFIG.holdDir,
    errorDir: args.errorDir || envValue("PHASE2_FILE_PIPELINE_ERROR_DIR") || CONFIG.errorDir,
    inspectionDir: args.inspectionDir || envValue("PHASE2_FILE_PIPELINE_INSPECTION_DIR") || CONFIG.inspectionDir,
    ffprobeTimeoutMs:
      parsePositiveInt(args.ffprobeTimeoutMs) ||
      parsePositiveInt(envValue("PHASE2_FILE_PIPELINE_FFPROBE_TIMEOUT_MS")) ||
      CONFIG.ffprobeTimeoutMs,
  };
}

function parsePositiveInt(value) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function buildExcludeDirs(config) {
  return [
    config.finalBaseDir,
    config.unmatchedDir,
    config.holdDir,
    config.errorDir,
    config.inspectionDir,
    config.csvLogDir,
  ];
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
    return finalizeRow(
      base,
      "hold",
      planned,
      "multiple_product_id_candidates",
      dbClient,
      config,
      stat,
      extracted,
      null,
      recoverySqlPath
    );
  }

  if (!extracted.primaryProductId) {
    const planned = uniquePlannedPath(path.join(config.unmatchedDir, fileName), plannedPathSet);
    return finalizeRow(
      base,
      "unmatched",
      planned,
      "product_id_not_found",
      dbClient,
      config,
      stat,
      extracted,
      null,
      recoverySqlPath
    );
  }

  const masterRow = master.get(extracted.primaryProductId);

  if (!masterRow) {
    const planned = uniquePlannedPath(path.join(config.unmatchedDir, fileName), plannedPathSet);
    return finalizeRow(
      base,
      "unmatched",
      planned,
      "product_id_not_in_master",
      dbClient,
      config,
      stat,
      extracted,
      null,
      recoverySqlPath
    );
  }

  const sellerName = sanitizePathSegment(masterRow.seller_id, config.unknownSellerFolder);
  const plannedName = buildPlannedFileName(
    extracted.primaryProductId,
    masterRow.title,
    extracted.partLabel,
    config.maxFileNameLength
  );

  const planned = uniquePlannedPath(
    path.join(config.finalBaseDir, sellerName, plannedName),
    plannedPathSet
  );

  return finalizeRow(
    base,
    "matched",
    planned,
    "matched_by_product_id",
    dbClient,
    config,
    stat,
    extracted,
    masterRow,
    recoverySqlPath
  );
}

async function finalizeRow(
  base,
  matchStatus,
  targetPath,
  reason,
  dbClient,
  config,
  sourceStat,
  extraction,
  masterRow,
  recoverySqlPath
) {
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
    const videoMetadata = await inspectVideoMetadata(targetPath, config.ffprobeTimeoutMs);

    if (dbClient) {
      try {
        await dbClient.query("BEGIN");

        let ownedFileId = null;

        if (matchStatus === "matched") {
          ownedFileId = await insertOwned(dbClient, config, {
            productId: extraction.primaryProductId,
            currentPath: targetPath,
            currentFileName: path.basename(targetPath),
            source: config.sourceLabel,
            matchedBy: config.matchedByLabel,
            fileSize: targetStat.size,
            fileModifiedAt: targetStat.mtime,
          });

          await upsertVideoMetadata(dbClient, config, {
            ownedFileId,
            productId: extraction.primaryProductId,
            currentPath: targetPath,
            currentFileName: path.basename(targetPath),
            fileSize: targetStat.size,
            fileModifiedAt: targetStat.mtime,
            videoMetadata,
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
          ownedFileId,
          productId: extraction.primaryProductId || null,
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
          // noop
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

async function processNonMp4File({ filePath, runId, config, plannedPathSet }) {
  const stat = await fsp.stat(filePath);
  const fileName = path.basename(filePath);
  const ext = path.extname(fileName).toLowerCase();
  const category = getNonMp4Category(ext);

  const plannedPath = uniquePlannedPath(
    path.join(config.inspectionDir, category, fileName),
    plannedPathSet
  );

  const row = {
    run_id: runId,
    mode: config.mode,
    source_path: filePath,
    source_file_name: fileName,
    extension: ext || "",
    category,
    planned_path: plannedPath,
    status: "",
    reason: "",
    file_size: String(stat.size),
    file_modified_at: stat.mtime.toISOString(),
  };

  if (config.mode === "dry-run") {
    row.status = "dry_run";
    row.reason = "non_mp4_file_would_be_moved_to_inspection";
    return row;
  }

  try {
    ensureDirectory(path.dirname(plannedPath));
    await moveFileNoCrossDeviceDelete(filePath, plannedPath);

    const targetStat = await fsp.stat(plannedPath);
    row.status = "success";
    row.reason = "non_mp4_file_moved_to_inspection";
    row.file_size = String(targetStat.size);
    row.file_modified_at = targetStat.mtime.toISOString();

    return row;
  } catch (error) {
    row.status = "error";
    row.reason = `error:${error.message}`;
    return row;
  }
}

function getNonMp4Category(ext) {
  if (!ext) return "no_extension";

  const clean = ext.replace(".", "").toLowerCase();

  if (["txt", "csv", "json", "xml", "log", "md", "ini", "yaml", "yml"].includes(clean)) {
    return "text";
  }

  if (["jpg", "jpeg", "png", "gif", "webp", "bmp", "svg"].includes(clean)) {
    return "image";
  }

  if (["zip", "rar", "7z", "tar", "gz"].includes(clean)) {
    return "archive";
  }

  if (["srt", "ass", "vtt"].includes(clean)) {
    return "subtitle";
  }

  if (["pdf"].includes(clean)) {
    return "pdf";
  }

  if (["exe", "msi", "bat", "cmd", "ps1"].includes(clean)) {
    return "executable";
  }

  return clean;
}

function listFilesRecursive(rootDir, excludeDirs = []) {
  if (!fs.existsSync(rootDir)) return [];

  const root = path.resolve(rootDir);
  const excludes = excludeDirs.map((d) => path.resolve(d).toLowerCase());
  const out = [];

  function shouldExclude(dir) {
    const resolved = path.resolve(dir).toLowerCase();

    return excludes.some((ex) => {
      return resolved === ex || resolved.startsWith(ex + path.sep);
    });
  }

  function walk(dir) {
    if (shouldExclude(dir)) return;

    const entries = fs.readdirSync(dir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.isFile()) {
        out.push(fullPath);
      }
    }
  }

  walk(root);

  return out.sort((a, b) => a.localeCompare(b, "ja"));
}

async function removeEmptyDirectories(rootDir, excludeDirs = []) {
  if (!fs.existsSync(rootDir)) return;

  const root = path.resolve(rootDir);
  const excludes = excludeDirs.map((d) => path.resolve(d).toLowerCase());

  function shouldExclude(dir) {
    const resolved = path.resolve(dir).toLowerCase();

    return excludes.some((ex) => {
      return resolved === ex || resolved.startsWith(ex + path.sep);
    });
  }

  async function walk(dir) {
    if (shouldExclude(dir)) return;

    const entries = await fsp.readdir(dir, { withFileTypes: true });

    for (const entry of entries) {
      if (entry.isDirectory()) {
        await walk(path.join(dir, entry.name));
      }
    }

    if (path.resolve(dir) === root) return;

    const remaining = await fsp.readdir(dir);

    if (remaining.length === 0) {
      await fsp.rmdir(dir);
    }
  }

  await walk(rootDir);
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

    if (ext.primaryProductId) {
      ids.add(ext.primaryProductId);
    }
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
  if (!fs.existsSync(csvPath)) {
    throw new Error(`Master CSV not found: ${csvPath}`);
  }

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
  assertSafeQualifiedName(config.dbVideoMetadataTable, "video metadata table");

  const client = createPgClient();
  await client.connect();
  await ensureVideoMetadataTable(client, config);

  return client;
}

async function ensureVideoMetadataTable(client, config) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS ${config.dbVideoMetadataTable} (
      owned_file_id bigint PRIMARY KEY,
      product_id text NOT NULL,
      current_path text NOT NULL,
      current_file_name text,
      file_size bigint,
      file_modified_at timestamptz,
      video_width integer,
      video_height integer,
      resolution_class text,
      probe_status text NOT NULL,
      probe_error text,
      probed_at timestamptz NOT NULL DEFAULT now(),
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT xxx_chk_tm011_resolution_class
        CHECK (resolution_class IS NULL OR resolution_class IN ('4K', 'HD', 'LOW')),
      CONSTRAINT xxx_chk_tm011_probe_status
        CHECK (probe_status IN ('ok', 'failed', 'file_missing', 'path_not_allowed'))
    )
  `);

  await client.query(`
    CREATE INDEX IF NOT EXISTS xxx_idx_tm011_video_metadata_product_id
      ON ${config.dbVideoMetadataTable} (product_id)
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS xxx_idx_tm011_video_metadata_resolution_class
      ON ${config.dbVideoMetadataTable} (resolution_class)
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS xxx_idx_tm011_video_metadata_probe_status
      ON ${config.dbVideoMetadataTable} (probe_status)
  `);
}

async function insertOwned(client, config, row) {
  const result = await client.query(
    `INSERT INTO ${config.dbOwnedTable}
      (product_id, current_path, current_file_name, source, matched_by, status, file_size, file_modified_at, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,'owned',$6,$7,NOW(),NOW())
     RETURNING id`,
    [
      row.productId,
      row.currentPath,
      row.currentFileName,
      row.source,
      row.matchedBy,
      row.fileSize,
      row.fileModifiedAt,
    ]
  );

  return result.rows[0]?.id || null;
}

async function upsertVideoMetadata(client, config, row) {
  if (!row.ownedFileId) return;

  await client.query(
    `INSERT INTO ${config.dbVideoMetadataTable}
      (owned_file_id, product_id, current_path, current_file_name, file_size, file_modified_at,
       video_width, video_height, resolution_class, probe_status, probe_error, probed_at, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NOW(),NOW(),NOW())
     ON CONFLICT (owned_file_id) DO UPDATE SET
       product_id = EXCLUDED.product_id,
       current_path = EXCLUDED.current_path,
       current_file_name = EXCLUDED.current_file_name,
       file_size = EXCLUDED.file_size,
       file_modified_at = EXCLUDED.file_modified_at,
       video_width = EXCLUDED.video_width,
       video_height = EXCLUDED.video_height,
       resolution_class = EXCLUDED.resolution_class,
       probe_status = EXCLUDED.probe_status,
       probe_error = EXCLUDED.probe_error,
       probed_at = NOW(),
       updated_at = NOW()`,
    [
      row.ownedFileId,
      row.productId,
      row.currentPath,
      row.currentFileName,
      row.fileSize,
      row.fileModifiedAt,
      row.videoMetadata.videoWidth || null,
      row.videoMetadata.videoHeight || null,
      row.videoMetadata.resolutionClass || null,
      row.videoMetadata.probeStatus,
      row.videoMetadata.probeError || null,
    ]
  );
}

async function inspectVideoMetadata(filePath, timeoutMs) {
  if (!fs.existsSync(filePath)) {
    return {
      probeStatus: "file_missing",
      probeError: "file_missing",
    };
  }

  try {
    const metadata = await runFfprobe(filePath, timeoutMs);
    const videoStream = (metadata.streams || []).find((stream) => stream.codec_type === "video");
    const width = Number(videoStream?.width || 0);
    const height = Number(videoStream?.height || 0);

    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
      return {
        probeStatus: "failed",
        probeError: "video_dimensions_not_found",
      };
    }

    return {
      probeStatus: "ok",
      videoWidth: width,
      videoHeight: height,
      resolutionClass: classifyResolution(width, height),
    };
  } catch (error) {
    return {
      probeStatus: "failed",
      probeError: String(error?.message || error).slice(0, 1000),
    };
  }
}

function runFfprobe(filePath, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      ffprobe.path,
      [
        "-v",
        "error",
        "-select_streams",
        "v:0",
        "-show_entries",
        "stream=codec_type,width,height",
        "-of",
        "json",
        filePath,
      ],
      { windowsHide: true }
    );

    let stdout = "";
    let stderr = "";
    let settled = false;
    let timer;

    const finishReject = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    };

    const finishResolve = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.once("error", finishReject);

    timer = setTimeout(() => {
      child.kill("SIGKILL");
      finishReject(new Error(`ffprobe_timeout_${timeoutMs}ms`));
    }, timeoutMs);

    child.once("close", (code) => {
      if (code !== 0) {
        finishReject(new Error(stderr.trim() || `ffprobe_exit_${code}`));
        return;
      }

      try {
        finishResolve(JSON.parse(stdout || "{}"));
      } catch (error) {
        finishReject(error);
      }
    });
  });
}

function classifyResolution(width, height) {
  const maxSide = Math.max(width, height);
  const minSide = Math.min(width, height);

  if (maxSide >= 3840 || minSide >= 2160) return "4K";
  if (maxSide >= 1280 || minSide >= 720) return "HD";
  return "LOW";
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
      (run_id, owned_file_id, product_id, old_path, new_path, old_file_name, new_file_name, action, status, source, matched_by, note)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [
      row.runId,
      row.ownedFileId,
      row.productId,
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

function extractProductIds(fileName) {
  const ext = path.extname(fileName);
  const baseNoExt = path.basename(fileName, ext);

  const partMatch = baseNoExt.match(/([_-]\d{1,2})$/);
  const partLabel = partMatch ? partMatch[1] : "";
  const mainPart = partLabel ? baseNoExt.slice(0, -partLabel.length) : baseNoExt;

  const candidates = [];

  const knownPattern =
    /(?:FC2[-_\s]?PPV[-_\s]?|fc2ppv[-_\s]?|fc2-ppv-|hhd800\.com@FC2-PPV-|supjav\.com@fc2ppv-)(\d{6,7})/gi;

  let match;

  while ((match = knownPattern.exec(mainPart)) !== null) {
    candidates.push(match[1]);
  }

  const leadingNumber = mainPart.match(/^(\d{6,7})(?:$|[^0-9])/);

  if (leadingNumber) {
    candidates.push(leadingNumber[1]);
  }

  const allRuns = mainPart.match(/\d{6,7}/g) || [];

  for (const value of allRuns) {
    candidates.push(value);
  }

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

function sanitizeFileName(value, fallback) {
  const parsed = path.parse(String(value || ""));
  const safeBase = sanitizePathSegment(parsed.name, fallback);
  const safeExt = String(parsed.ext || "")
    .replace(/[\\/:*?"<>|]/g, "")
    .replace(/[\u0000-\u001f]/g, "")
    .trim();

  return `${safeBase}${safeExt}`;
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

function summarizeNonMp4(rows) {
  return rows.reduce(
    (acc, row) => {
      if (row.status === "error") acc.error += 1;
      else acc.ok += 1;

      return acc;
    },
    { ok: 0, error: 0 }
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

  for (const row of rows) {
    lines.push(columns.map((c) => csvEscape(row[c])).join(","));
  }

  fs.writeFileSync(csvPath, `${lines.join("\n")}\n`, "utf8");
}

function csvEscape(value) {
  const text = String(value == null ? "" : "");

  if (value != null) {
    return `"${String(value).replace(/"/g, '""')}"`;
  }

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
    } else if (ch === '"') {
      inQuotes = !inQuotes;
    } else if (ch === "," && !inQuotes) {
      out.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }

  out.push(cur);

  return out;
}

function buildRunId(label) {
  const stamp = new Date()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\..+$/, "")
    .replace("T", "_");

  return `${stamp}_${label}`;
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

    const separator = line.indexOf("=");

    if (separator === -1) continue;

    const key = line.slice(0, separator).trim();
    const value = unquoteEnvValue(line.slice(separator + 1).trim());

    if (key && process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

function unquoteEnvValue(value) {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
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
  if (!value || value.startsWith("--")) {
    throw new Error(`Missing value for ${name}`);
  }

  return value;
}

function ensureDirectory(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function writeUsage() {
  process.stdout.write(
    [
      "Usage:",
      "  node phase2_file_pipeline2.js",
      "  node phase2_file_pipeline2.js --mode dry-run --input <folder> --master-source db --log-dir <folder>",
      "  node phase2_file_pipeline2.js --mode execute --confirm-execute YES --input <folder> --master-source db --log-dir <folder>",
      "",
      "Options:",
      "  --input <folder>            Target folder. All subdirectories are scanned.",
      "  --final-base <folder>       Destination base folder for matched mp4 files.",
      "  --unmatched-dir <folder>    Destination folder for unmatched mp4 files.",
      "  --hold-dir <folder>         Destination folder for hold mp4 files.",
      "  --error-dir <folder>        Destination folder for error files.",
      "  --inspection-dir <folder>   Destination folder for non-mp4 files.",
      "  --log-dir <folder>          CSV log output folder.",
      "  --limit <number>            Limit mp4 processing count. Non-mp4 files are still scanned.",
      "  --ffprobe-timeout-ms <ms>   Timeout for ffprobe-static resolution probing.",
      "",
      "Notes:",
      "  - CLI args override PHASE2_FILE_PIPELINE_* values in .env.",
      "  - dry-run writes CSV only. It does not move files and does not write DB rows.",
      "  - execute mode moves files and writes DB rows for mp4 only.",
      "  - matched mp4 rows also write resolution metadata with ffprobe-static.",
      "  - non-mp4 files are moved to inspection folder only. DB is not written.",
      "  - empty directories under input folder are removed after execute.",
      "  - cross-device move (EXDEV) is blocked for safety in this version.",
      "",
    ].join("\n")
  );
}

function initSampleWorkspace(root) {
  const input = path.join(root, "input");
  const nested = path.join(input, "nested", "deep");
  const logs = path.join(root, "logs");

  ensureDirectory(input);
  ensureDirectory(nested);
  ensureDirectory(logs);

  const samples = [
    path.join(input, "FC2-PPV-1234567_1.mp4"),
    path.join(nested, "fc2ppv-234567.mp4"),
    path.join(nested, "no-number-sample.mp4"),
    path.join(nested, "memo.txt"),
    path.join(nested, "image.jpg"),
  ];

  for (const p of samples) {
    if (!fs.existsSync(p)) {
      fs.writeFileSync(p, "sample", "utf8");
    }
  }

  const masterCsv = [
    "product_id,title,seller_id",
    `"1234567","Sample Title One","Sample Seller"`,
    `"234567","Six Digit Sample",""`,
  ].join("\n");

  fs.writeFileSync(path.join(root, "master_sample.csv"), `${masterCsv}\n`, "utf8");
}

main().catch((error) => {
  process.stderr.write(`Phase2 recursive pipeline failed: ${error.message}\n`);
  process.exitCode = 1;
});
