const fs = require("fs");
const path = require("path");

const PROJECT_ROOT = __dirname;
const ENV_PATH = path.join(PROJECT_ROOT, ".env");

const DEFAULTS = {
  QB_URL: "http://localhost:8080",
  QB_USERNAME: "admin",
  QB_PASSWORD: "",
  TORRENT_BASE_DIR: "P:\\hogehoge",
  TORRENT_LOG_DIR: "P:\\hogehoge\\_torrent_logs",
  TORRENT_DOWNLOAD_DIR: "P:\\hogehoge\\downloads",
  QB_COMPLETED_CLEANUP_DRY_RUN: "true",
  QB_COMPLETED_CLEANUP_CONFIRM_EXECUTE: "NO",
};

const CSV_COLUMNS = [
  "run_at",
  "dry_run",
  "torrent_name",
  "qb_hash",
  "save_path",
  "progress",
  "state",
  "action",
  "status",
  "error_message",
];

async function main() {
  loadEnvFile(ENV_PATH);
  const config = buildConfig();
  const startedAt = new Date();
  const runAt = formatDateTimeWithOffset(startedAt);
  const stamp = formatDateStamp(startedAt);
  const modeLabel = config.dryRun ? "dryrun" : "execute";
  const logFileName = `qb_completed_cleanup_${modeLabel}_${stamp}.csv`;
  let logPath = path.win32.join(config.logDir, logFileName);
  const rows = [];
  let managedPathsValidated = false;

  try {
    validateConfig(config);
    assertManagedPaths(config);
    managedPathsValidated = true;
    ensureDirectory(config.logDir);

    const session = await loginToQbittorrent(config);
    const torrents = await getTorrents(config, session);
    const targets = torrents.filter((torrent) => isCleanupTarget(torrent, config));

    if (targets.length === 0) {
      rows.push(buildRow({
        runAt,
        dryRun: config.dryRun,
        action: "DELETE_COMPLETED_TORRENT_REGISTRATION",
        status: "SKIPPED_NO_COMPLETED",
      }));
      logPath = writeCsv(logPath, rows, CSV_COLUMNS);
      writeSummary(rows, logPath);
      return;
    }

    for (const torrent of targets) {
      rows.push(buildRow({
        runAt,
        dryRun: config.dryRun,
        torrent,
        action: "DELETE_COMPLETED_TORRENT_REGISTRATION",
        status: config.dryRun ? "DRY_RUN" : "PLANNED",
      }));
    }

    if (!config.dryRun) {
      await deleteTorrents(config, session, targets.map((torrent) => torrent.hash));
      for (const torrent of targets) {
        rows.push(buildRow({
          runAt,
          dryRun: false,
          torrent,
          action: "DELETE_COMPLETED_TORRENT_REGISTRATION",
          status: "DELETED_FROM_QBITTORRENT_UI",
        }));
      }
    }

    logPath = writeCsv(logPath, rows, CSV_COLUMNS);
    writeSummary(rows, logPath);
  } catch (error) {
    rows.push(buildRow({
      runAt,
      dryRun: config.dryRun,
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

    process.stderr.write(`qBittorrent completed cleanup failed. CSV: ${logPath}\n`);
    process.exitCode = 1;
  }
}

function buildConfig() {
  return {
    qbUrl: normalizeBaseUrl(readConfig("QB_URL")),
    qbUsername: readConfig("QB_USERNAME"),
    qbPassword: readConfig("QB_PASSWORD"),
    baseDir: readConfig("TORRENT_BASE_DIR"),
    logDir: readConfig("TORRENT_LOG_DIR"),
    downloadDir: readConfig("TORRENT_DOWNLOAD_DIR"),
    dryRun: readConfig("QB_COMPLETED_CLEANUP_DRY_RUN").toLowerCase() === "true",
    confirmExecute: readConfig("QB_COMPLETED_CLEANUP_CONFIRM_EXECUTE"),
  };
}

function readConfig(name) {
  return process.env[name] || DEFAULTS[name];
}

function normalizeBaseUrl(url) {
  return String(url || "").replace(/\/+$/, "");
}

function validateConfig(config) {
  if (!isLocalQbUrl(config.qbUrl)) {
    throw new Error("QB_URL must be localhost or 127.0.0.1 for this local cleanup.");
  }

  if (config.dryRun) {
    if (config.confirmExecute !== "NO") {
      throw new Error("QB_COMPLETED_CLEANUP_DRY_RUN=true requires QB_COMPLETED_CLEANUP_CONFIRM_EXECUTE=NO.");
    }
    return;
  }

  if (config.confirmExecute !== "YES") {
    throw new Error("QB_COMPLETED_CLEANUP_DRY_RUN=false requires QB_COMPLETED_CLEANUP_CONFIRM_EXECUTE=YES.");
  }

  if (!config.qbUsername || !config.qbPassword || config.qbPassword === "********") {
    throw new Error("QB_USERNAME and QB_PASSWORD must be configured in .env before cleanup execute mode.");
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

function assertManagedPaths(config) {
  const base = normalizeForCompare(config.baseDir);
  for (const target of [config.logDir, config.downloadDir]) {
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

function isCleanupTarget(torrent, config) {
  const progress = Number(torrent.progress || 0);
  if (progress < 1) return false;

  const savePath = torrent.save_path || torrent.savePath || "";
  if (normalizeForCompare(savePath) !== normalizeForCompare(config.downloadDir)) return false;

  return isCompletedState(torrent.state);
}

function isCompletedState(state) {
  return [
    "uploading",
    "stalledUP",
    "queuedUP",
    "pausedUP",
    "forcedUP",
    "checkingUP",
  ].includes(String(state || ""));
}

async function deleteTorrents(config, session, hashes) {
  if (hashes.length === 0) return;

  const body = new URLSearchParams();
  body.set("hashes", hashes.join("|"));
  body.set("deleteFiles", "false");

  const response = await fetch(`${config.qbUrl}/api/v2/torrents/delete`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Cookie: session.cookie,
    },
    body,
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`qBittorrent delete failed: HTTP ${response.status} ${text.trim()}`);
  }
}

function buildRow({ runAt, dryRun, torrent, action, status, errorMessage }) {
  return {
    run_at: runAt,
    dry_run: String(dryRun),
    torrent_name: torrent ? torrent.name || "" : "",
    qb_hash: torrent ? torrent.hash || "" : "",
    save_path: torrent ? torrent.save_path || "" : "",
    progress: torrent ? String(torrent.progress || "") : "",
    state: torrent ? torrent.state || "" : "",
    action: action || "",
    status: status || "",
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

function csvEscape(value) {
  const text = String(value == null ? "" : value);
  return `"${text.replace(/"/g, '""')}"`;
}

function ensureDirectory(dir) {
  fs.mkdirSync(dir, { recursive: true });
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
  const planned = rows.filter((row) => row.status === "PLANNED").length;
  const deleted = rows.filter((row) => row.status === "DELETED_FROM_QBITTORRENT_UI").length;
  const dryRun = rows.filter((row) => row.status === "DRY_RUN").length;
  process.stdout.write([
    "qBittorrent completed cleanup finished.",
    `Planned: ${planned}`,
    `Deleted UI registrations: ${deleted}`,
    `Dry-run planned: ${dryRun}`,
    `CSV: ${logPath}`,
    "",
  ].join("\n"));
}

main();
