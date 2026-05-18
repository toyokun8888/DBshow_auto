// ============================================================
// fc2_manual_thumbnail_import_operational.js
// Import manually prepared FC2 thumbnail images into the normal library.
//
// Purpose:
// - Read JPEG files from ./fc2_sum_hand
// - Use the 6 or 7 digit file name as product_id
// - Move accepted files into ./fc2_sum as {product_id}.jpg
// - Register them in xxx_tm009_fc2_wiki_thumbnail_assets as collected
// - Leave CSV and DB run logs for reconciliation
//
// Safety:
// - dry-run by default
// - execute requires --confirm-execute YES or env confirmation
// - no overwrite of existing thumbnail files
// - no DELETE, DROP, TRUNCATE, or cleanup
// - only .jpg/.jpeg files with JPEG magic bytes are accepted
// ============================================================

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { Client } = require("pg");
require("dotenv").config({ quiet: true });

const INPUT_DIR = path.resolve(__dirname, "fc2_sum_hand");
const OUTPUT_DIR = path.resolve(__dirname, "fc2_sum");
const LOG_DIR = path.resolve(__dirname, "manual_thumbnail_import_logs");

const RUN_ID = `fc2_manual_thumb_${new Date().toISOString().replace(/[-:T.]/g, "").slice(0, 14)}_${process.pid}`;
const TARGET_SCOPE = "manual_import";
const VALID_NAME_RE = /^(\d{6,7})\.(jpe?g)$/i;
const IGNORED_INPUT_EXTENSIONS = new Set([".bat", ".cmd"]);
const OUTPUT_EXTENSIONS = [".jpg", ".jpeg", ".png", ".webp"];

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

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i += 1) {
    const key = argv[i];
    const next = argv[i + 1];
    if (key === "--mode") {
      args.mode = next;
      i += 1;
    } else if (key === "--confirm-execute") {
      args.confirmExecute = next;
      i += 1;
    } else if (key === "--help" || key === "-h") {
      args.help = true;
    } else {
      throw new Error(`Unknown argument: ${key}`);
    }
  }
  return args;
}

function buildConfig() {
  const args = parseArgs(process.argv);
  if (args.help) {
    printHelp();
    process.exit(0);
  }

  const mode =
    args.mode ||
    process.env.FC2_MANUAL_THUMB_IMPORT_MODE ||
    "dry-run";
  const confirmExecute =
    args.confirmExecute ||
    process.env.FC2_MANUAL_THUMB_IMPORT_CONFIRM_EXECUTE ||
    "NO";

  if (!["dry-run", "execute"].includes(mode)) {
    throw new Error("mode must be dry-run or execute");
  }
  if (mode === "execute" && String(confirmExecute).toUpperCase() !== "YES") {
    throw new Error("execute mode requires --confirm-execute YES");
  }

  return {
    mode,
    confirmExecute,
  };
}

function printHelp() {
  console.log([
    "Usage:",
    "  node fc2_manual_thumbnail_import_operational.js --mode dry-run",
    "  node fc2_manual_thumbnail_import_operational.js --mode execute --confirm-execute YES",
    "",
    "Input:",
    `  ${INPUT_DIR}`,
    "",
    "Accepted file names:",
    "  123456.jpg",
    "  1234567.jpeg",
  ].join("\n"));
}

function ensureDirs() {
  if (!fs.existsSync(INPUT_DIR)) {
    fs.mkdirSync(INPUT_DIR, { recursive: true });
  }
  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  }
  if (!fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR, { recursive: true });
  }

  for (const dirPath of [INPUT_DIR, OUTPUT_DIR, LOG_DIR]) {
    if (!fs.statSync(dirPath).isDirectory()) {
      throw new Error(`Not a directory: ${dirPath}`);
    }
  }
}

function assertUnderDir(filePath, rootDir) {
  const resolvedFile = path.resolve(filePath);
  const resolvedRoot = path.resolve(rootDir);
  const relative = path.relative(resolvedRoot, resolvedFile);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Path is outside expected root: ${resolvedFile}`);
  }
  return resolvedFile;
}

function escCsv(value) {
  return `"${String(value ?? "").replace(/"/g, '""')}"`;
}

function csvLine(values) {
  return values.map(escCsv).join(",") + "\n";
}

function initCsvLog() {
  const filePath = path.join(LOG_DIR, `manual_thumbnail_import_${RUN_ID}.csv`);
  const headers = [
    "run_id",
    "product_id",
    "source_path",
    "dest_path",
    "status",
    "reason",
    "bytes",
    "sha256",
    "db_status",
    "processed_at",
  ];
  fs.writeFileSync(filePath, csvLine(headers), "utf8");
  return filePath;
}

function appendCsvLog(filePath, row) {
  fs.appendFileSync(
    filePath,
    csvLine([
      RUN_ID,
      row.productId || "",
      row.sourcePath || "",
      row.destPath || "",
      row.status || "",
      row.reason || "",
      row.bytes || "",
      row.sha256 || "",
      row.dbStatus || "",
      new Date().toISOString(),
    ]),
    "utf8"
  );
}

function listInputFiles() {
  return fs
    .readdirSync(INPUT_DIR, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .filter((fileName) => !IGNORED_INPUT_EXTENSIONS.has(path.extname(fileName).toLowerCase()))
    .sort((a, b) => a.localeCompare(b, "en"));
}

function parseInputFileName(fileName) {
  const match = String(fileName || "").match(VALID_NAME_RE);
  if (!match) return null;
  return {
    productId: match[1],
  };
}

function readFileInfo(filePath) {
  const buffer = fs.readFileSync(filePath);
  const isJpeg =
    buffer.length >= 3 &&
    buffer[0] === 0xff &&
    buffer[1] === 0xd8 &&
    buffer[2] === 0xff;
  const sha256 = crypto.createHash("sha256").update(buffer).digest("hex");
  return {
    bytes: buffer.length,
    sha256,
    isJpeg,
  };
}

function findExistingOutputFiles(productId) {
  return OUTPUT_EXTENSIONS
    .map((ext) => path.join(OUTPUT_DIR, `${productId}${ext}`))
    .filter((candidate) => fs.existsSync(candidate));
}

async function getExistingAsset(client, productId) {
  const result = await client.query(
    `
      SELECT
        product_id,
        thumbnail_status,
        local_thumbnail_path,
        local_thumbnail_file_name,
        attempt_count
      FROM public.xxx_tm009_fc2_wiki_thumbnail_assets
      WHERE product_id = $1
      LIMIT 1
    `,
    [productId]
  );
  return result.rows[0] || null;
}

async function createRunLog(client, targetsFound) {
  await client.query(
    `
      INSERT INTO public.xxx_tl003_fc2_wiki_thumbnail_runs (
        run_id,
        run_status,
        target_scope,
        max_downloads,
        daily_cap,
        min_delay_ms,
        max_delay_ms,
        max_attempts,
        targets_found,
        updated_at
      )
      VALUES ($1, 'running', $2, $3, $3, 0, 0, 1, $3, now())
    `,
    [RUN_ID, TARGET_SCOPE, targetsFound]
  );
}

async function finishRunLog(client, status, successCount, failedCount, skippedCount, lastError = "") {
  await client.query(
    `
      UPDATE public.xxx_tl003_fc2_wiki_thumbnail_runs
      SET
        run_finished_at = now(),
        run_status = $2,
        success_count = $3,
        failed_count = $4,
        existing_file_count = $5,
        last_error = NULLIF($6, ''),
        updated_at = now()
      WHERE run_id = $1
    `,
    [RUN_ID, status, successCount, failedCount, skippedCount, String(lastError || "").slice(0, 1000)]
  );
}

async function markCollected(client, item) {
  await client.query(
    `
      INSERT INTO public.xxx_tm009_fc2_wiki_thumbnail_assets (
        product_id,
        thumbnail_url,
        local_thumbnail_path,
        local_thumbnail_file_name,
        thumbnail_status,
        source_wiki_url,
        last_checked_at,
        downloaded_at,
        attempt_count,
        last_error,
        updated_at
      )
      VALUES ($1, $2, $3, $4, 'collected', 'manual_import', now(), now(), 1, NULL, now())
      ON CONFLICT (product_id) DO UPDATE SET
        thumbnail_url = EXCLUDED.thumbnail_url,
        local_thumbnail_path = EXCLUDED.local_thumbnail_path,
        local_thumbnail_file_name = EXCLUDED.local_thumbnail_file_name,
        thumbnail_status = 'collected',
        source_wiki_url = 'manual_import',
        last_checked_at = now(),
        downloaded_at = now(),
        attempt_count = public.xxx_tm009_fc2_wiki_thumbnail_assets.attempt_count + 1,
        last_error = NULL,
        updated_at = now()
    `,
    [
      item.productId,
      `manual://fc2_sum_hand/${encodeURIComponent(path.basename(item.sourcePath))}`,
      item.destPath,
      path.basename(item.destPath),
    ]
  );
}

async function logRunItem(client, item, status, errorMessage = "") {
  await client.query(
    `
      INSERT INTO public.xxx_tl004_fc2_wiki_thumbnail_run_items (
        run_id,
        product_id,
        thumbnail_url,
        local_thumbnail_path,
        local_thumbnail_file_name,
        item_status,
        bytes,
        sha256,
        delay_ms,
        error_message,
        attempt_count
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 0, NULLIF($9, ''), $10)
    `,
    [
      RUN_ID,
      item.productId || "",
      item.thumbnailUrl || "",
      item.destPath || "",
      item.destPath ? path.basename(item.destPath) : "",
      status,
      item.bytes || null,
      item.sha256 || "",
      String(errorMessage || "").slice(0, 1000),
      Number(item.existingAttemptCount || 0) + 1,
    ]
  );
}

function moveFile(sourcePath, destPath) {
  fs.renameSync(sourcePath, destPath);
}

async function buildPlan(client) {
  const names = listInputFiles();
  const items = [];

  for (const fileName of names) {
    const sourcePath = assertUnderDir(path.join(INPUT_DIR, fileName), INPUT_DIR);
    const parsed = parseInputFileName(fileName);
    if (!parsed) {
      items.push({
        fileName,
        sourcePath,
        productId: "",
        destPath: "",
        status: "skipped",
        reason: "skipped_invalid_name",
      });
      continue;
    }

    const productId = parsed.productId;
    const destPath = assertUnderDir(path.join(OUTPUT_DIR, `${productId}.jpg`), OUTPUT_DIR);
    const info = readFileInfo(sourcePath);
    if (!info.isJpeg) {
      items.push({
        fileName,
        sourcePath,
        productId,
        destPath,
        status: "skipped",
        reason: "skipped_invalid_jpeg",
        bytes: info.bytes,
        sha256: info.sha256,
      });
      continue;
    }

    const existingFiles = findExistingOutputFiles(productId);
    if (existingFiles.length > 0) {
      items.push({
        fileName,
        sourcePath,
        productId,
        destPath,
        status: "skipped",
        reason: `skipped_existing_file:${existingFiles.map((p) => path.basename(p)).join("|")}`,
        bytes: info.bytes,
        sha256: info.sha256,
      });
      continue;
    }

    const existingAsset = await getExistingAsset(client, productId);
    const existingPath = String(existingAsset?.local_thumbnail_path || "");
    const existingCollected = existingAsset?.thumbnail_status === "collected";
    const existingPathExists = existingPath ? fs.existsSync(existingPath) : false;
    if (existingCollected && existingPathExists) {
      items.push({
        fileName,
        sourcePath,
        productId,
        destPath,
        status: "skipped",
        reason: "skipped_existing_db_collected",
        bytes: info.bytes,
        sha256: info.sha256,
        existingAttemptCount: existingAsset?.attempt_count || 0,
      });
      continue;
    }

    items.push({
      fileName,
      sourcePath,
      productId,
      destPath,
      status: "ready",
      reason: existingCollected ? "ready_repair_missing_db_file" : "ready",
      bytes: info.bytes,
      sha256: info.sha256,
      existingAttemptCount: existingAsset?.attempt_count || 0,
      thumbnailUrl: `manual://fc2_sum_hand/${encodeURIComponent(fileName)}`,
    });
  }

  return items;
}

async function executeItem(client, item) {
  let moved = false;
  await client.query("BEGIN");
  try {
    moveFile(item.sourcePath, item.destPath);
    moved = true;
    await markCollected(client, item);
    await logRunItem(client, item, "manual_imported");
    await client.query("COMMIT");
    return {
      ...item,
      status: "imported",
      reason: "ok",
      dbStatus: "committed",
    };
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // ignore rollback failure and report original error
    }
    if (moved && fs.existsSync(item.destPath) && !fs.existsSync(item.sourcePath)) {
      try {
        fs.renameSync(item.destPath, item.sourcePath);
        moved = false;
      } catch (rollbackMoveError) {
        return {
          ...item,
          status: "error",
          reason: `db_or_move_error:${error.message}; move_back_failed:${rollbackMoveError.message}`,
          dbStatus: "rolled_back_move_back_failed",
        };
      }
    }
    return {
      ...item,
      status: "error",
      reason: `db_or_move_error:${error.message}`,
      dbStatus: moved ? "rolled_back_file_still_moved" : "rolled_back",
    };
  }
}

function printSummary(config, items, results = []) {
  const source = results.length > 0 ? results : items;
  const counts = source.reduce((acc, item) => {
    acc[item.status] = (acc[item.status] || 0) + 1;
    return acc;
  }, {});

  console.log("======================================================================");
  console.log("FC2 Manual Thumbnail Import");
  console.log(`mode       : ${config.mode}`);
  console.log(`input      : ${INPUT_DIR}`);
  console.log(`output     : ${OUTPUT_DIR}`);
  console.log(`runId      : ${RUN_ID}`);
  console.log(`total      : ${source.length}`);
  Object.keys(counts)
    .sort()
    .forEach((key) => console.log(`${key.padEnd(11)}: ${counts[key]}`));
  console.log("======================================================================");
}

async function main() {
  const config = buildConfig();
  ensureDirs();
  const csvPath = initCsvLog();

  const client = new Client(DB_CONFIG);
  await client.connect();

  let runLogCreated = false;
  let lastError = "";
  const results = [];

  try {
    const items = await buildPlan(client);
    printSummary(config, items);

    for (const item of items) {
      if (item.status !== "ready") {
        appendCsvLog(csvPath, item);
      }
    }

    const readyItems = items.filter((item) => item.status === "ready");
    if (config.mode === "dry-run") {
      for (const item of readyItems) {
        appendCsvLog(csvPath, {
          ...item,
          status: "dry_run_ready",
          dbStatus: "not_written",
        });
      }
      console.log(`CSV log: ${csvPath}`);
      return;
    }

    await createRunLog(client, readyItems.length);
    runLogCreated = true;

    for (const item of readyItems) {
      const result = await executeItem(client, item);
      results.push(result);
      appendCsvLog(csvPath, result);
      console.log(`${result.productId} ${result.status} ${result.reason}`);
    }

    const successCount = results.filter((item) => item.status === "imported").length;
    const failedCount = results.filter((item) => item.status === "error").length;
    const skippedCount = items.filter((item) => item.status === "skipped").length;
    await finishRunLog(
      client,
      failedCount > 0 ? "partial_failed" : "completed",
      successCount,
      failedCount,
      skippedCount,
      lastError
    );

    printSummary(config, items, [...items.filter((item) => item.status === "skipped"), ...results]);
    console.log(`CSV log: ${csvPath}`);
  } catch (error) {
    lastError = error.message;
    if (runLogCreated) {
      try {
        await finishRunLog(client, "failed", 0, 1, 0, lastError);
      } catch {
        // ignore logging failure
      }
    }
    throw error;
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
