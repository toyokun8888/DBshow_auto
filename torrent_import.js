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
  "action",
  "status",
  "qb_hash",
  "error_message",
];

async function main() {
  loadEnvFile(ENV_PATH);
  const config = buildConfig();
  const startedAt = new Date();
  const runAt = formatDateTimeWithOffset(startedAt);
  const stamp = formatDateStamp(startedAt);
  const modeLabel = config.dryRun ? "dryrun" : "execute";
  const logFileName = `torrent_import_${modeLabel}_${stamp}.csv`;
  let logPath = path.win32.join(config.logDir, logFileName);
  const rows = [];
  let managedPathsValidated = false;

  try {
    validateConfig(config);
    assertManagedPaths(config);
    managedPathsValidated = true;
    ensureRequiredDirectories(config);

    const torrentFiles = listTorrentFiles(config.inboxDir);
    if (torrentFiles.length === 0) {
      rows.push(buildRow({
        runAt,
        dryRun: config.dryRun,
        torrentPath: config.inboxDir,
        savePath: config.downloadDir,
        action: "ADD_TO_QBITTORRENT",
        status: config.dryRun ? "DRY_RUN_NO_FILES" : "SKIPPED",
      }));
      logPath = writeCsv(logPath, rows, CSV_COLUMNS);
      writeSummary(rows, logPath);
      return;
    }

    if (config.dryRun) {
      for (const torrentPath of torrentFiles) {
        rows.push(buildRow({
          runAt,
          dryRun: true,
          torrentPath,
          savePath: config.downloadDir,
          action: "ADD_TO_QBITTORRENT",
          status: "DRY_RUN",
        }));
      }
      logPath = writeCsv(logPath, rows, CSV_COLUMNS);
      writeSummary(rows, logPath);
      return;
    }

    const session = await loginToQbittorrent(config);
    let knownHashes = new Set((await getTorrents(config, session)).map((torrent) => torrent.hash));

    for (const torrentPath of torrentFiles) {
      const addResult = await addTorrent(config, session, torrentPath, knownHashes);
      rows.push(buildRow({
        runAt,
        dryRun: false,
        torrentPath,
        savePath: config.downloadDir,
        action: "ADD_TO_QBITTORRENT",
        status: addResult.ok ? "ADDED" : "ADD_FAILED",
        qbHash: addResult.qbHash,
        errorMessage: addResult.errorMessage,
      }));

      const moveDir = addResult.ok ? config.addedDir : config.errorDir;
      const moveStatus = addResult.ok ? "MOVED_TO_ADDED" : "MOVED_TO_ERROR";
      const moveAction = addResult.ok ? "MOVE_TO_ADDED" : "MOVE_TO_ERROR";

      try {
        const movedPath = moveTorrentFile(torrentPath, moveDir, config);
        rows.push(buildRow({
          runAt,
          dryRun: false,
          torrentPath: movedPath,
          savePath: config.downloadDir,
          action: moveAction,
          status: moveStatus,
          qbHash: addResult.qbHash,
        }));
      } catch (moveError) {
        rows.push(buildRow({
          runAt,
          dryRun: false,
          torrentPath,
          savePath: config.downloadDir,
          action: moveAction,
          status: "MOVE_FAILED",
          qbHash: addResult.qbHash,
          errorMessage: moveError.message,
        }));
      }

      knownHashes = new Set((await getTorrents(config, session)).map((torrent) => torrent.hash));
    }

    const finalTorrents = await getTorrents(config, session);
    for (const torrent of finalTorrents.filter((item) => knownHashes.has(item.hash))) {
      if (isTorrentInSavePath(torrent, config.downloadDir)) {
        rows.push(buildRow({
          runAt,
          dryRun: false,
          torrentPath: torrent.name || "",
          savePath: torrent.save_path || config.downloadDir,
          action: "VERIFY_QBITTORRENT_LIST",
          status: "QB_LIST_CONFIRMED",
          qbHash: torrent.hash,
        }));
      }
    }

    logPath = writeCsv(logPath, rows, CSV_COLUMNS);
    writeSummary(rows, logPath);
  } catch (error) {
    rows.push(buildRow({
      runAt,
      dryRun: config.dryRun,
      torrentPath: config.inboxDir || "",
      savePath: config.downloadDir || "",
      action: "ERROR",
      status: "ERROR",
      errorMessage: error.message,
    }));

    try {
      if (!managedPathsValidated) {
        throw new Error("managed paths were not validated");
      }
      ensureDirectory(config.logDir);
      logPath = writeCsv(logPath, rows, CSV_COLUMNS);
    } catch (logError) {
      logPath = path.join(PROJECT_ROOT, logFileName);
      rows[rows.length - 1].error_message = `${error.message}; log_fallback_reason=${logError.message}`;
      logPath = writeCsv(logPath, rows, CSV_COLUMNS);
    }

    process.stderr.write(`Torrent import failed. CSV: ${logPath}\n`);
    process.exitCode = 1;
  }
}

function buildConfig() {
  return {
    qbUrl: normalizeBaseUrl(readConfig("QB_URL")),
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

function normalizeBaseUrl(url) {
  return String(url || "").replace(/\/+$/, "");
}

function validateConfig(config) {
  if (config.dryRun) {
    if (config.confirmExecute !== "NO") {
      throw new Error("DRY_RUN=true requires CONFIRM_EXECUTE=NO.");
    }
    return;
  }

  if (config.confirmExecute !== "YES") {
    throw new Error("DRY_RUN=false requires CONFIRM_EXECUTE=YES.");
  }

  if (!isLocalQbUrl(config.qbUrl)) {
    throw new Error("QB_URL must be localhost or 127.0.0.1 for this local batch.");
  }

  if (!config.qbUsername || !config.qbPassword || config.qbPassword === "********") {
    throw new Error("QB_USERNAME and QB_PASSWORD must be configured in .env before execute mode.");
  }
}

function isLocalQbUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    return (
      url.protocol === "http:" &&
      (url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]")
    );
  } catch (_) {
    return false;
  }
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

function assertManagedPaths(config) {
  const base = normalizeForCompare(config.baseDir);
  for (const target of [config.inboxDir, config.addedDir, config.errorDir, config.logDir, config.downloadDir]) {
    if (!isPathInside(target, base)) {
      throw new Error(`Path is outside TORRENT_BASE_DIR: ${target}`);
    }
  }
}

function isPathInside(targetPath, normalizedBase) {
  const target = normalizeForCompare(targetPath);
  return target === normalizedBase || target.startsWith(`${normalizedBase}\\`);
}

function normalizeForCompare(targetPath) {
  return path.win32.resolve(targetPath).toLowerCase();
}

function listTorrentFiles(inboxDir) {
  if (!fs.existsSync(inboxDir)) return [];

  return fs
    .readdirSync(inboxDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && path.extname(entry.name).toLowerCase() === ".torrent")
    .map((entry) => path.win32.join(inboxDir, entry.name))
    .sort((a, b) => a.localeCompare(b, "ja"));
}

async function loginToQbittorrent(config) {
  const body = new URLSearchParams();
  body.set("username", config.qbUsername);
  body.set("password", config.qbPassword);

  const response = await fetch(`${config.qbUrl}/api/v2/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  const text = await response.text();
  const loginAccepted =
    response.ok && (text.trim() === "Ok." || text.trim() === "Ok" || response.status === 204);
  if (!loginAccepted) {
    throw new Error(`qBittorrent login failed: HTTP ${response.status} ${text.trim()}`);
  }

  const cookie = readSetCookie(response);
  if (!cookie) {
    throw new Error("qBittorrent login did not return a session cookie.");
  }

  return { cookie };
}

function readSetCookie(response) {
  if (typeof response.headers.getSetCookie === "function") {
    const cookies = response.headers.getSetCookie();
    if (cookies.length > 0) return cookies.map((cookie) => cookie.split(";")[0]).join("; ");
  }

  const cookie = response.headers.get("set-cookie");
  return cookie ? cookie.split(";")[0] : "";
}

async function getTorrents(config, session) {
  const response = await fetch(`${config.qbUrl}/api/v2/torrents/info`, {
    method: "GET",
    headers: { Cookie: session.cookie },
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`qBittorrent torrent list failed: HTTP ${response.status} ${text.trim()}`);
  }

  return JSON.parse(text);
}

async function addTorrent(config, session, torrentPath, knownHashes) {
  try {
    const form = new FormData();
    const bytes = fs.readFileSync(torrentPath);
    const blob = new Blob([bytes], { type: "application/x-bittorrent" });
    form.append("torrents", blob, path.win32.basename(torrentPath));
    form.append("savepath", config.downloadDir);
    form.append("autoTMM", "false");

    const response = await fetch(`${config.qbUrl}/api/v2/torrents/add`, {
      method: "POST",
      headers: { Cookie: session.cookie },
      body: form,
    });

    const text = await response.text();
    if (!response.ok || !isQbAddSuccess(text)) {
      return { ok: false, qbHash: "", errorMessage: `HTTP ${response.status} ${text.trim()}` };
    }

    const addedTorrent = await waitForAddedTorrent(config, session, knownHashes);
    if (!addedTorrent) {
      return {
        ok: false,
        qbHash: "",
        errorMessage: "qBittorrent add returned Ok, but the added torrent was not confirmed in the torrent list.",
      };
    }

    return {
      ok: true,
      qbHash: addedTorrent.hash,
      errorMessage: "",
    };
  } catch (error) {
    return { ok: false, qbHash: "", errorMessage: error.message };
  }
}

async function waitForAddedTorrent(config, session, knownHashes) {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const torrents = await getTorrents(config, session);
    const addedTorrent = findAddedTorrent(torrents, knownHashes, config.downloadDir);
    if (addedTorrent) return addedTorrent;
    await sleep(500);
  }

  return null;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isQbAddSuccess(text) {
  const normalized = text.trim().toLowerCase();
  if (normalized === "ok." || normalized === "ok") return true;

  try {
    const result = JSON.parse(text);
    return Number(result.success_count || 0) > 0 && Number(result.failure_count || 0) === 0;
  } catch (_) {
    return false;
  }
}

function findAddedTorrent(torrents, knownHashes, downloadDir) {
  const added = torrents.filter((torrent) => !knownHashes.has(torrent.hash));
  const inSavePath = added.find((torrent) => isTorrentInSavePath(torrent, downloadDir));
  return inSavePath || null;
}

function isTorrentInSavePath(torrent, downloadDir) {
  const savePath = torrent.save_path || torrent.savePath || "";
  return normalizeForCompare(savePath) === normalizeForCompare(downloadDir);
}

function moveTorrentFile(sourcePath, destinationDir, config) {
  if (!isPathInside(sourcePath, normalizeForCompare(config.inboxDir))) {
    throw new Error(`Source path is outside inbox: ${sourcePath}`);
  }

  if (!isPathInside(destinationDir, normalizeForCompare(config.baseDir))) {
    throw new Error(`Destination path is outside base dir: ${destinationDir}`);
  }

  ensureDirectory(destinationDir);
  const destinationPath = buildCollisionSafePath(path.win32.join(destinationDir, path.win32.basename(sourcePath)));
  fs.renameSync(sourcePath, destinationPath);
  return destinationPath;
}

function buildCollisionSafePath(targetPath) {
  if (!fs.existsSync(targetPath)) return targetPath;

  const parsed = path.win32.parse(targetPath);
  let index = 1;
  let candidate = path.win32.join(parsed.dir, `${parsed.name}(${index})${parsed.ext}`);
  while (fs.existsSync(candidate)) {
    index += 1;
    candidate = path.win32.join(parsed.dir, `${parsed.name}(${index})${parsed.ext}`);
  }
  return candidate;
}

function buildRow({ runAt, dryRun, torrentPath, savePath, action, status, qbHash, errorMessage }) {
  return {
    run_at: runAt,
    dry_run: String(dryRun),
    torrent_file_name: path.win32.basename(torrentPath || ""),
    torrent_file_path: torrentPath || "",
    planned_save_path: savePath || "",
    action: action || "",
    status: status || "",
    qb_hash: qbHash || "",
    error_message: errorMessage || "",
  };
}

function writeCsv(csvPath, rows, columns) {
  const safeCsvPath = buildCollisionSafePath(csvPath);
  const lines = [
    columns.join(","),
    ...rows.map((row) => columns.map((column) => csvEscape(row[column])).join(",")),
  ];
  fs.writeFileSync(safeCsvPath, `${lines.join("\n")}\n`, { encoding: "utf8", flag: "wx" });
  return safeCsvPath;
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
  const added = rows.filter((row) => row.status === "ADDED").length;
  const failed = rows.filter((row) => row.status === "ADD_FAILED").length;
  const moved = rows.filter((row) => row.status === "MOVED_TO_ADDED").length;
  const dryRun = rows.filter((row) => row.status === "DRY_RUN").length;
  process.stdout.write([
    "Torrent import completed.",
    `Added: ${added}`,
    `Add failed: ${failed}`,
    `Moved to added: ${moved}`,
    `Dry-run planned: ${dryRun}`,
    `CSV: ${logPath}`,
    "",
  ].join("\n"));
}

main();
