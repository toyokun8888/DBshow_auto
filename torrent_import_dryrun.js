const fs = require("fs");
const path = require("path");

const PROJECT_ROOT = __dirname;
const ENV_PATH = path.join(PROJECT_ROOT, ".env");

const DEFAULTS = {
  QB_URL: "http://localhost:8080",
  QB_USERNAME: "admin",
  QB_PASSWORD: "",
  TORRENT_BASE_DIR: "P:\\hogehoge2",
  TORRENT_INBOX_DIR: "P:\\hogehoge2\\_torrent_inbox",
  TORRENT_ADDED_DIR: "P:\\hogehoge2\\_torrent_added",
  TORRENT_ERROR_DIR: "P:\\hogehoge2\\_torrent_error",
  TORRENT_LOG_DIR: "P:\\hogehoge2\\_torrent_logs",
  TORRENT_DOWNLOAD_DIR: "P:\\hogehoge2\\downloads",
  DRY_RUN: "true",
  CONFIRM_EXECUTE: "NO",
};

const CSV_COLUMNS = [
  "run_at",
  "dry_run",
  "torrent_file_name",
  "torrent_file_path",
  "planned_save_path",
  "planned_action",
  "status",
  "error_message",
];

function main() {
  loadEnvFile(ENV_PATH);
  const config = buildConfig();
  const runAt = formatDateTimeWithOffset(new Date());
  const stamp = formatDateStamp(new Date());
  const logFileName = `torrent_import_dryrun_${stamp}.csv`;

  let rows = [];
  let logPath = path.win32.join(config.logDir, logFileName);

  try {
    assertDryRunOnly(config);
    ensureRequiredDirectories(config);
    const torrentFiles = listTorrentFiles(config.inboxDir);

    rows = torrentFiles.map((torrentPath) =>
      buildDryRunRow({
        runAt,
        torrentPath,
        downloadDir: config.downloadDir,
      })
    );

    if (rows.length === 0) {
      rows.push({
        run_at: runAt,
        dry_run: "true",
        torrent_file_name: "",
        torrent_file_path: config.inboxDir,
        planned_save_path: config.downloadDir,
        planned_action: "ADD_TO_QBITTORRENT",
        status: "DRY_RUN_NO_FILES",
        error_message: "",
      });
    }

    writeCsv(logPath, rows, CSV_COLUMNS);
    writeSummary(rows, logPath);
  } catch (error) {
    const errorRow = {
      run_at: runAt,
      dry_run: String(config.dryRun),
      torrent_file_name: "",
      torrent_file_path: config.inboxDir || "",
      planned_save_path: config.downloadDir || "",
      planned_action: "ADD_TO_QBITTORRENT",
      status: "ERROR",
      error_message: error.message,
    };

    try {
      ensureDirectory(config.logDir);
      writeCsv(logPath, [errorRow], CSV_COLUMNS);
    } catch (logError) {
      logPath = path.join(PROJECT_ROOT, logFileName);
      errorRow.error_message = `${error.message}; log_fallback_reason=${logError.message}`;
      writeCsv(logPath, [errorRow], CSV_COLUMNS);
    }

    process.stderr.write(`Torrent dry-run failed. CSV: ${logPath}\n`);
    process.exitCode = 1;
  }
}

function buildConfig() {
  return {
    qbUrl: readConfig("QB_URL"),
    qbUsername: readConfig("QB_USERNAME"),
    qbPassword: readConfig("QB_PASSWORD"),
    baseDir: readConfig("TORRENT_BASE_DIR"),
    inboxDir: readConfig("TORRENT_INBOX_DIR"),
    addedDir: readConfig("TORRENT_ADDED_DIR"),
    errorDir: readConfig("TORRENT_ERROR_DIR"),
    logDir: readConfig("TORRENT_LOG_DIR"),
    downloadDir: readConfig("TORRENT_DOWNLOAD_DIR"),
    dryRun: readConfig("DRY_RUN").toLowerCase() === "true",
    confirmExecute: readConfig("CONFIRM_EXECUTE"),
  };
}

function readConfig(name) {
  return process.env[name] || DEFAULTS[name];
}

function assertDryRunOnly(config) {
  if (config.dryRun) {
    if (config.confirmExecute !== "NO") {
      throw new Error("DRY_RUN=true requires CONFIRM_EXECUTE=NO for this dry-run batch.");
    }

    return;
  }

  if (config.confirmExecute !== "YES") {
    throw new Error("DRY_RUN=false requires CONFIRM_EXECUTE=YES.");
  }

  throw new Error("This batch currently supports DRY_RUN only. Real qBittorrent import is not implemented.");
}

function ensureRequiredDirectories(config) {
  [
    config.baseDir,
    config.inboxDir,
    config.addedDir,
    config.errorDir,
    config.logDir,
    config.downloadDir,
  ].forEach(ensureDirectory);
}

function ensureDirectory(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function listTorrentFiles(inboxDir) {
  if (!fs.existsSync(inboxDir)) return [];

  return fs
    .readdirSync(inboxDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && path.extname(entry.name).toLowerCase() === ".torrent")
    .map((entry) => path.win32.join(inboxDir, entry.name))
    .sort((a, b) => a.localeCompare(b, "ja"));
}

function buildDryRunRow({ runAt, torrentPath, downloadDir }) {
  return {
    run_at: runAt,
    dry_run: "true",
    torrent_file_name: path.win32.basename(torrentPath),
    torrent_file_path: torrentPath,
    planned_save_path: downloadDir,
    planned_action: "ADD_TO_QBITTORRENT",
    status: "DRY_RUN",
    error_message: "",
  };
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

function formatDateStamp(date) {
  const parts = getLocalParts(date);
  return `${parts.year}${parts.month}${parts.day}_${parts.hour}${parts.minute}${parts.second}`;
}

function formatDateTimeWithOffset(date) {
  const parts = getLocalParts(date);
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const absMinutes = Math.abs(offsetMinutes);
  const offsetHour = pad2(Math.floor(absMinutes / 60));
  const offsetMinute = pad2(absMinutes % 60);

  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}${sign}${offsetHour}:${offsetMinute}`;
}

function getLocalParts(date) {
  return {
    year: String(date.getFullYear()),
    month: pad2(date.getMonth() + 1),
    day: pad2(date.getDate()),
    hour: pad2(date.getHours()),
    minute: pad2(date.getMinutes()),
    second: pad2(date.getSeconds()),
  };
}

function pad2(value) {
  return String(value).padStart(2, "0");
}

function writeSummary(rows, logPath) {
  const plannedCount = rows.filter((row) => row.status === "DRY_RUN").length;
  process.stdout.write([
    "Torrent dry-run completed.",
    `Detected .torrent files: ${plannedCount}`,
    `CSV: ${logPath}`,
    "",
  ].join("\n"));
}

main();
