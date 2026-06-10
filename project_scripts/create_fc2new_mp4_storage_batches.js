const fs = require("fs");
const path = require("path");

const PROJECT_ROOT = path.resolve(__dirname, "..");
const ENV_PATH = path.join(PROJECT_ROOT, ".env");
const TARGET_DIR_NAME = "fc2new_mp4";

function parseArgs(argv) {
  const args = { mode: "dry-run" };
  for (let i = 2; i < argv.length; i += 1) {
    const key = argv[i];
    const value = argv[i + 1];
    if (key === "--mode") {
      args.mode = value;
      i += 1;
    } else {
      throw new Error(`Unknown argument: ${key}`);
    }
  }
  if (!["dry-run", "execute"].includes(args.mode)) {
    throw new Error(`Invalid mode: ${args.mode}`);
  }
  return args;
}

function readEnv() {
  const values = {};
  const text = fs.readFileSync(ENV_PATH, "utf8").replace(/^\uFEFF/, "");
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separatorIndex = line.indexOf("=");
    if (separatorIndex === -1) continue;
    const key = line.slice(0, separatorIndex).trim();
    const value = line.slice(separatorIndex + 1).trim().replace(/^['"]|['"]$/g, "");
    if (key) values[key] = value;
  }
  return values;
}

function normalizeMediaRoot(value) {
  const trimmed = String(value || "").trim().replace(/\//g, "\\").replace(/^\\+([A-Za-z]:)/, "$1");
  return trimmed.replace(/^([A-Za-z]):(?!\\)/, "$1:\\");
}

function resolveStorageDrives(env) {
  const rawRoots = String(env.MEDIA_ALLOWED_ROOTS || "");
  const drives = new Map();
  for (const rawRoot of rawRoots.split(";")) {
    const root = normalizeMediaRoot(rawRoot);
    const match = root.match(/^([A-Za-z]):\\all_fc2(?:\\|$)/i);
    if (!match) continue;
    const drive = match[1].toUpperCase();
    drives.set(drive, `${drive}:\\`);
  }
  return [...drives.keys()].sort((a, b) => a.localeCompare(b));
}

function buildBatchText(drive) {
  const driveRoot = `${drive}:\\`;
  const finalBase = `${drive}:\\all_fc2`;
  const trashBase = `${drive}:\\trash\\fc2new_mp4`;
  const batchName = `run_fc2new_mp4_${drive}.bat`;

  return [
    "@echo off",
    "setlocal EnableExtensions",
    "chcp 65001 >nul",
    "",
    `set "STORAGE_DRIVE=${drive}:"`,
    `set "PROJECT_ROOT=${PROJECT_ROOT}"`,
    "set \"INPUT_DIR=%~dp0.\"",
    `set "FINAL_BASE=${finalBase}"`,
    `set "TRASH_BASE=${trashBase}"`,
    "set \"LOG_DIR=%TRASH_BASE%\\logs\"",
    "set \"UNMATCHED_DIR=%TRASH_BASE%\\unmatched\"",
    "set \"HOLD_DIR=%TRASH_BASE%\\hold\"",
    "set \"ERROR_DIR=%TRASH_BASE%\\error\"",
    "set \"INSPECTION_DIR=%TRASH_BASE%\\inspection\"",
    "",
    "echo ============================================================",
    `echo FC2 new mp4 manual import (${driveRoot}${TARGET_DIR_NAME})`,
    "echo 1. Dry-run scans this folder and subfolders.",
    "echo 2. Execute moves matched files to %FINAL_BASE% and writes DB.",
    "echo 3. Browser sync updates local_mp4_ids_raw.",
    "echo ============================================================",
    "echo.",
    "",
    "if not exist \"%PROJECT_ROOT%\\.env\" (",
    "  echo ERROR: .env not found: %PROJECT_ROOT%\\.env",
    "  pause",
    "  exit /b 1",
    ")",
    "",
    "if not exist \"%LOG_DIR%\" mkdir \"%LOG_DIR%\"",
    "if not exist \"%UNMATCHED_DIR%\" mkdir \"%UNMATCHED_DIR%\"",
    "if not exist \"%HOLD_DIR%\" mkdir \"%HOLD_DIR%\"",
    "if not exist \"%ERROR_DIR%\" mkdir \"%ERROR_DIR%\"",
    "if not exist \"%INSPECTION_DIR%\" mkdir \"%INSPECTION_DIR%\"",
    "",
    "cd /d \"%PROJECT_ROOT%\"",
    "",
    "echo [1/5] Dry-run",
    "node \"%PROJECT_ROOT%\\project_scripts\\phase2_execute\\phase2_file_pipeline2.js\" --mode dry-run --input \"%INPUT_DIR%\" --master-source db --db-view public.xxx_vq001_moviemaster_unique --final-base \"%FINAL_BASE%\" --unmatched-dir \"%UNMATCHED_DIR%\" --hold-dir \"%HOLD_DIR%\" --error-dir \"%ERROR_DIR%\" --inspection-dir \"%INSPECTION_DIR%\" --log-dir \"%LOG_DIR%\" --ignore-non-video-exts bat,cmd,ps1",
    "if errorlevel 1 goto :failed",
    "",
    "echo.",
    "choice /C YN /N /M \"Dry-run OK. Execute now? [Y/N] \"",
    "if errorlevel 2 goto :cancelled",
    "",
    "echo.",
    "echo [2/5] Execute move/rename and owned DB registration",
    "node \"%PROJECT_ROOT%\\project_scripts\\phase2_execute\\phase2_file_pipeline2.js\" --mode execute --confirm-execute YES --input \"%INPUT_DIR%\" --master-source db --db-view public.xxx_vq001_moviemaster_unique --final-base \"%FINAL_BASE%\" --unmatched-dir \"%UNMATCHED_DIR%\" --hold-dir \"%HOLD_DIR%\" --error-dir \"%ERROR_DIR%\" --inspection-dir \"%INSPECTION_DIR%\" --log-dir \"%LOG_DIR%\" --ignore-non-video-exts bat,cmd,ps1",
    "if errorlevel 1 goto :failed",
    "",
    "echo.",
    "echo [3/5] Browser sync dry-run",
    "set \"SYNC_TARGET_ROOT=%FINAL_BASE%\"",
    "set \"SYNC_PRODUCT_ID=\"",
    "node \"%PROJECT_ROOT%\\project_scripts\\sync_owned_files_to_local_mp4_raw.js\" --mode dry-run",
    "if errorlevel 1 goto :failed",
    "",
    "echo.",
    "echo [4/5] Browser sync execute",
    "node \"%PROJECT_ROOT%\\project_scripts\\sync_owned_files_to_local_mp4_raw.js\" --mode execute --confirm-execute YES",
    "if errorlevel 1 goto :failed",
    "",
    "echo.",
    "echo [5/5] Restart browser services if PM2 is available",
    "where pm2.cmd >nul 2>nul",
    "if errorlevel 1 (",
    "  echo PM2 not found. Please refresh browser manually if needed.",
    ") else (",
    "  pm2.cmd restart always-thumbnail-library-api --update-env",
    "  pm2.cmd restart always-thumbnail-library-web --update-env",
    ")",
    "",
    "echo.",
    "echo DONE. Check http://127.0.0.1/ in the browser.",
    "pause",
    "exit /b 0",
    "",
    ":cancelled",
    "echo Cancelled after dry-run. No execute was run.",
    "pause",
    "exit /b 0",
    "",
    ":failed",
    "echo.",
    "echo ERROR: stopped. Check the messages above and CSV logs in %LOG_DIR%.",
    "pause",
    "exit /b 1",
    "",
  ].join("\r\n");
}

function backupExisting(filePath, drive) {
  if (!fs.existsSync(filePath)) return "";
  const backupDir = `${drive}:\\trash\\fc2new_mp4\\batch_backups`;
  fs.mkdirSync(backupDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:T.Z]/g, "").slice(0, 14);
  const backupPath = path.join(backupDir, `${path.basename(filePath)}.bak_${stamp}`);
  fs.copyFileSync(filePath, backupPath);
  return backupPath;
}

function main() {
  const args = parseArgs(process.argv);
  const env = readEnv();
  const drives = resolveStorageDrives(env);
  const results = [];

  for (const drive of drives) {
    const driveRoot = `${drive}:\\`;
    const exists = fs.existsSync(driveRoot);
    const directory = path.join(driveRoot, TARGET_DIR_NAME);
    const batchPath = path.join(directory, `run_fc2new_mp4_${drive}.bat`);

    if (!exists) {
      results.push({ drive, status: "skipped_drive_not_found", directory, batchPath });
      continue;
    }

    if (args.mode === "execute") {
      fs.mkdirSync(directory, { recursive: true });
      const backupPath = backupExisting(batchPath, drive);
      fs.writeFileSync(batchPath, buildBatchText(drive), "utf8");
      results.push({ drive, status: "written", directory, batchPath, backupPath });
    } else {
      results.push({
        drive,
        status: fs.existsSync(batchPath) ? "would_update" : "would_create",
        directory,
        batchPath,
      });
    }
  }

  process.stdout.write(`${JSON.stringify({ ok: true, mode: args.mode, drives, results }, null, 2)}\n`);
}

main();
