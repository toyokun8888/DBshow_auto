// ============================================================
// FC2 JavArchive thumbnail collector
//
// Modes:
// - backfill: scan every current AV Uncensored page, then collect every
//   missing eligible FC2 thumbnail (owned first, Rapidgator candidates next).
// - daily: scan pages 1-6 and collect at most 100 missing FC2 thumbnails.
//
// Safety:
// - explicit execute/DB confirmation gates
// - one shared PostgreSQL advisory lock for both modes
// - HTTPS and strict host allowlists on every redirect hop
// - bounded retries, delays, size limits, image magic validation
// - no overwrite of existing collected DB rows or thumbnail files
// - resumable CSV/status files and existing TL003/TL004 audit logs
// ============================================================

const fs = require("fs");
const path = require("path");
const https = require("https");
const crypto = require("crypto");
const { Client } = require("pg");
require("dotenv").config({ quiet: true });

const PROJECT_ROOT = path.resolve(__dirname, "..");
const OUTPUT_DIR = path.join(PROJECT_ROOT, "fc2_sum");
const LOG_ROOT = path.join(__dirname, "javarchive_thumbnail_logs");
const PAGE_ORIGIN = "https://javarchive.com";
const PAGE_HOSTS = new Set(["javarchive.com"]);
const IMAGE_HOSTS = new Set(["img.javstore.net", "img2.javstore.net"]);
const MAX_HTML_BYTES = 2 * 1024 * 1024;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const LOCK_NAMESPACE = 20260920;
const LOCK_KEY = 26092001;
const KNOWN_EXTENSIONS = [".jpg", ".jpeg", ".png", ".webp", ".gif"];

class HttpStatusError extends Error {
  constructor(statusCode, url, retryAfterMs = 0) {
    super(`HTTP ${statusCode}: ${url}`);
    this.name = "HttpStatusError";
    this.statusCode = statusCode;
    this.retryAfterMs = retryAfterMs;
  }
}

class StopRunError extends Error {
  constructor(message) {
    super(message);
    this.name = "StopRunError";
  }
}

function writeOutput(message) {
  process.stdout.write(`${message}\n`);
}

function writeError(message) {
  process.stderr.write(`${message}\n`);
}

function requireEnv(name) {
  const value = process.env[name];
  if (!value || value.startsWith("CHANGE_ME_")) {
    throw new Error(`${name} is not configured`);
  }
  return value;
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!key.startsWith("--")) continue;
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      args[key.slice(2)] = "true";
      continue;
    }
    args[key.slice(2)] = value;
    index += 1;
  }
  return args;
}

function toBoundedInt(value, fallback, minimum, maximum, name) {
  const parsed = Number.parseInt(String(value ?? fallback), 10);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return parsed;
}

function localDateStamp(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}${month}${day}`;
}

function sanitizeRunId(value) {
  const runId = String(value || "").trim();
  if (!/^[a-z0-9_-]{8,100}$/i.test(runId)) {
    throw new Error("run-id must contain only letters, numbers, underscore, or hyphen");
  }
  return runId;
}

function buildConfig() {
  const args = parseArgs(process.argv.slice(2));
  const mode = String(args.mode || process.env.FC2_JAVARCHIVE_MODE || "daily").toLowerCase();
  if (!new Set(["backfill", "daily"]).has(mode)) {
    throw new Error("mode must be backfill or daily");
  }

  const defaultRunId =
    mode === "daily"
      ? `javarchive_daily_${localDateStamp()}`
      : `javarchive_backfill_${localDateStamp()}`;
  const runId = sanitizeRunId(args["run-id"] || process.env.FC2_JAVARCHIVE_RUN_ID || defaultRunId);
  const pageMinDelayMs = toBoundedInt(
    process.env.FC2_JAVARCHIVE_PAGE_MIN_DELAY_MS,
    1500,
    1000,
    60000,
    "page min delay"
  );
  const pageMaxDelayMs = toBoundedInt(
    process.env.FC2_JAVARCHIVE_PAGE_MAX_DELAY_MS,
    3000,
    pageMinDelayMs,
    120000,
    "page max delay"
  );
  const imageMinDelayMs = toBoundedInt(
    process.env.FC2_JAVARCHIVE_IMAGE_MIN_DELAY_MS,
    2500,
    1000,
    60000,
    "image min delay"
  );
  const imageMaxDelayMs = toBoundedInt(
    process.env.FC2_JAVARCHIVE_IMAGE_MAX_DELAY_MS,
    5500,
    imageMinDelayMs,
    120000,
    "image max delay"
  );
  const maxTotalPages = toBoundedInt(
    process.env.FC2_JAVARCHIVE_MAX_TOTAL_PAGES,
    6000,
    5000,
    6000,
    "maximum total pages safety bound"
  );
  const backfillEndPage = toBoundedInt(
    process.env.FC2_JAVARCHIVE_BACKFILL_END_PAGE,
    maxTotalPages,
    1000,
    maxTotalPages,
    "backfill end page"
  );

  return {
    mode,
    runId,
    targetScope: mode === "daily" ? "javarchive_daily" : "javarchive_backfill_all_pages",
    confirmExecute: String(
      args["confirm-execute"] || process.env.FC2_JAVARCHIVE_CONFIRM_EXECUTE || "NO"
    ).toUpperCase(),
    confirmDbWrite: String(
      args["confirm-db-write"] || process.env.FC2_JAVARCHIVE_CONFIRM_DB_WRITE || "NO"
    ).toUpperCase(),
    dailyPages: toBoundedInt(process.env.FC2_JAVARCHIVE_DAILY_PAGES, 6, 1, 20, "daily pages"),
    dailyCap: toBoundedInt(process.env.FC2_JAVARCHIVE_DAILY_CAP, 100, 1, 100, "daily cap"),
    lockWaitMinutes: toBoundedInt(
      process.env.FC2_JAVARCHIVE_LOCK_WAIT_MINUTES,
      0,
      0,
      180,
      "lock wait minutes"
    ),
    maxTotalPages,
    backfillEndPage,
    pageMinDelayMs,
    pageMaxDelayMs,
    imageMinDelayMs,
    imageMaxDelayMs,
    maxAttempts: toBoundedInt(process.env.FC2_JAVARCHIVE_MAX_ATTEMPTS, 3, 1, 3, "max attempts"),
    batchPauseEvery: toBoundedInt(
      process.env.FC2_JAVARCHIVE_BATCH_PAUSE_EVERY,
      300,
      10,
      1000,
      "batch pause every"
    ),
    batchPauseMs: toBoundedInt(
      process.env.FC2_JAVARCHIVE_BATCH_PAUSE_MS,
      180000,
      1000,
      1800000,
      "batch pause ms"
    ),
    timeoutMs: toBoundedInt(process.env.FC2_JAVARCHIVE_TIMEOUT_MS, 30000, 5000, 120000, "timeout"),
    maxConsecutiveFailures: 10,
    runDir: path.join(LOG_ROOT, runId),
  };
}

function assertExecutionGates(config) {
  if (config.confirmExecute !== "YES") {
    throw new Error("execute gate failed: set FC2_JAVARCHIVE_CONFIRM_EXECUTE=YES");
  }
  if (config.confirmDbWrite !== "YES") {
    throw new Error("DB gate failed: set FC2_JAVARCHIVE_CONFIRM_DB_WRITE=YES");
  }
}

function ensureDirectories(config) {
  for (const directory of [OUTPUT_DIR, LOG_ROOT, config.runDir]) {
    if (fs.existsSync(directory) && !fs.statSync(directory).isDirectory()) {
      throw new Error(`expected directory but found file: ${directory}`);
    }
    fs.mkdirSync(directory, { recursive: true });
  }
}

function runPaths(config) {
  return {
    status: path.join(config.runDir, "status.json"),
    candidates: path.join(config.runDir, "candidates.csv"),
    selected: path.join(config.runDir, "selected.csv"),
    results: path.join(config.runDir, "results.csv"),
  };
}

function defaultStatus(config) {
  return {
    run_id: config.runId,
    mode: config.mode,
    run_status: "starting",
    phase: "starting",
    total_pages: config.mode === "daily" ? config.dailyPages : 0,
    discovery_end_page: config.mode === "daily" ? config.dailyPages : config.backfillEndPage,
    last_completed_page: 0,
    discovered_unique: 0,
    selected_targets: 0,
    processed: 0,
    collected: 0,
    existing_file: 0,
    skipped_already_collected: 0,
    failed: 0,
    latest_error: "",
    started_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
}

function readStatus(filePath, config) {
  if (!fs.existsSync(filePath)) return defaultStatus(config);
  try {
    return { ...defaultStatus(config), ...JSON.parse(fs.readFileSync(filePath, "utf8")) };
  } catch (error) {
    throw new Error(`status file is invalid: ${error.message}`);
  }
}

function writeJsonAtomic(filePath, value) {
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  try {
    fs.renameSync(tempPath, filePath);
  } catch (error) {
    try {
      if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
    } catch {
      // Only this process's uniquely named temporary file is eligible for cleanup.
    }
    throw error;
  }
}

function updateStatus(filePath, status, patch) {
  Object.assign(status, patch, { updated_at: new Date().toISOString() });
  writeJsonAtomic(filePath, status);
}

function csvEscape(value) {
  const text = String(value ?? "");
  if (!/[",\r\n]/.test(text)) return text;
  return `"${text.replace(/"/g, '""')}"`;
}

function parseCsvLine(line) {
  const values = [];
  let current = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === '"' && quoted && line[index + 1] === '"') {
      current += '"';
      index += 1;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (char === "," && !quoted) {
      values.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  values.push(current);
  return values;
}

function readCsv(filePath) {
  if (!fs.existsSync(filePath)) return [];
  const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/).filter(Boolean);
  if (lines.length <= 1) return [];
  const headers = parseCsvLine(lines[0]);
  return lines.slice(1).map((line) => {
    const values = parseCsvLine(line);
    return Object.fromEntries(headers.map((header, index) => [header, values[index] || ""]));
  });
}

function ensureCsv(filePath, headers) {
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, `${headers.join(",")}\n`, { encoding: "utf8", flag: "wx" });
  }
}

function appendCsv(filePath, headers, row) {
  ensureCsv(filePath, headers);
  fs.appendFileSync(filePath, `${headers.map((header) => csvEscape(row[header])).join(",")}\n`, "utf8");
}

function writeCsv(filePath, headers, rows) {
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  const lines = [headers.join(",")];
  for (const row of rows) {
    lines.push(headers.map((header) => csvEscape(row[header])).join(","));
  }
  fs.writeFileSync(tempPath, `${lines.join("\n")}\n`, { encoding: "utf8", flag: "wx" });
  try {
    fs.renameSync(tempPath, filePath);
  } catch (error) {
    try {
      if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
    } catch {
      // Only this process's uniquely named temporary file is eligible for cleanup.
    }
    throw error;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomBetween(minimum, maximum) {
  return minimum + Math.floor(Math.random() * (maximum - minimum + 1));
}

function maintenanceWindowDelayMs(date = new Date()) {
  const currentMinute = date.getHours() * 60 + date.getMinutes();
  const currentRemainderMs = date.getSeconds() * 1000 + date.getMilliseconds();
  const windows = [
    { start: 7 * 60 + 55, end: 9 * 60 },
    { start: 20 * 60 + 55, end: 22 * 60 + 15 },
  ];
  for (const window of windows) {
    if (currentMinute >= window.start && currentMinute < window.end) {
      return (window.end - currentMinute) * 60 * 1000 - currentRemainderMs;
    }
  }
  return 0;
}

async function waitForSafeWindow(config) {
  if (config.mode !== "backfill") return;
  let remainingMs = maintenanceWindowDelayMs();
  if (remainingMs <= 0) return;
  writeOutput(`maintenance pause: ${Math.ceil(remainingMs / 60000)} minute(s) remaining`);
  while (remainingMs > 0) {
    await sleep(Math.min(remainingMs, 60000));
    remainingMs = maintenanceWindowDelayMs();
  }
  writeOutput("maintenance pause finished");
}

function pageUrl(pageNumber) {
  return pageNumber === 1
    ? `${PAGE_ORIGIN}/81-av-uncensored-cn.html`
    : `${PAGE_ORIGIN}/81-av-uncensored-page-${pageNumber}-cn.html`;
}

function validateRemoteUrl(rawUrl, allowedHosts, label) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error(`${label} URL is invalid`);
  }
  if (parsed.protocol !== "https:") throw new Error(`${label} URL must use HTTPS`);
  if (parsed.username || parsed.password) throw new Error(`${label} URL must not contain credentials`);
  if (parsed.port && parsed.port !== "443") throw new Error(`${label} URL uses an unapproved port`);
  if (!allowedHosts.has(parsed.hostname.toLowerCase())) {
    throw new Error(`${label} host is not approved: ${parsed.hostname}`);
  }
  return parsed;
}

function retryAfterMs(value) {
  if (!value) return 0;
  const seconds = Number.parseInt(String(value), 10);
  if (Number.isInteger(seconds)) return Math.min(Math.max(seconds * 1000, 0), 120000);
  const dateValue = Date.parse(String(value));
  if (!Number.isNaN(dateValue)) return Math.min(Math.max(dateValue - Date.now(), 0), 120000);
  return 0;
}

function requestBuffer(rawUrl, options, redirects = 0) {
  const parsed = validateRemoteUrl(rawUrl, options.allowedHosts, options.label);
  if (redirects > 3) return Promise.reject(new Error(`${options.label} redirect limit exceeded`));

  return new Promise((resolve, reject) => {
    const request = https.get(
      parsed,
      {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) thumbnail-collector/1.0",
          Accept: options.accept,
          Referer: `${PAGE_ORIGIN}/`,
        },
        signal: AbortSignal.timeout(options.timeoutMs),
      },
      (response) => {
        response.on("error", reject);
        response.on("aborted", () => reject(new Error(`${options.label} response aborted`)));
        const statusCode = Number(response.statusCode || 0);
        if (new Set([301, 302, 303, 307, 308]).has(statusCode)) {
          const location = response.headers.location;
          response.resume();
          if (!location) {
            reject(new Error(`${options.label} redirect has no location`));
            return;
          }
          let redirected;
          try {
            redirected = new URL(location, parsed).href;
            validateRemoteUrl(redirected, options.allowedHosts, options.label);
          } catch (error) {
            reject(error);
            return;
          }
          requestBuffer(redirected, options, redirects + 1).then(resolve, reject);
          return;
        }

        if (statusCode !== 200) {
          const waitMs = retryAfterMs(response.headers["retry-after"]);
          response.resume();
          reject(new HttpStatusError(statusCode, parsed.href, waitMs));
          return;
        }

        const chunks = [];
        let bytes = 0;
        response.on("data", (chunk) => {
          bytes += chunk.length;
          if (bytes > options.maxBytes) {
            request.destroy(new Error(`${options.label} exceeded ${options.maxBytes} bytes`));
            return;
          }
          chunks.push(Buffer.from(chunk));
        });
        response.on("end", () => {
          resolve({
            buffer: Buffer.concat(chunks),
            contentType: String(response.headers["content-type"] || "").toLowerCase(),
            finalUrl: parsed.href,
          });
        });
      }
    );

    request.setTimeout(options.timeoutMs, () => request.destroy(new Error(`${options.label} timeout`)));
    request.on("error", reject);
  });
}

async function requestWithRetry(rawUrl, options, maxAttempts) {
  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const result = await requestBuffer(rawUrl, options);
      return { ...result, attempts: attempt };
    } catch (error) {
      lastError = error;
      if (error instanceof HttpStatusError && new Set([403, 429]).has(error.statusCode)) {
        const stopError = new StopRunError(
          `${options.label} returned HTTP ${error.statusCode}; collection stopped to protect the source`
        );
        stopError.networkAttempts = attempt;
        throw stopError;
      }
      if (attempt >= maxAttempts) break;
      const statusDelay = error instanceof HttpStatusError ? error.retryAfterMs : 0;
      const backoff = Math.max(statusDelay, 3000 * attempt);
      await sleep(backoff);
    }
  }
  throw lastError;
}

function assertHtmlResponse(result, pageNumber) {
  if (!String(result.contentType || "").includes("text/html")) {
    throw new StopRunError(
      `page ${pageNumber} returned an unexpected content-type: ${result.contentType || "(empty)"}`
    );
  }
}

function decodeHtml(value) {
  return String(value || "")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function looksLikeBlockingPage(buffer) {
  const sample = Buffer.isBuffer(buffer)
    ? buffer.subarray(0, Math.min(buffer.length, 65536)).toString("utf8")
    : String(buffer || "").slice(0, 65536);
  return /captcha|cf-chl-|cloudflare challenge|attention required/i.test(sample);
}

function extractPageData(html, pageNumber) {
  const text = String(html || "");
  if (looksLikeBlockingPage(text)) {
    throw new Error(`page ${pageNumber} contains a block or CAPTCHA response`);
  }
  const mainMatch = text.match(/<div class="news_1n">[\s\S]*?<ul>([\s\S]*?)<\/ul>/i);
  if (!mainMatch) throw new Error(`page ${pageNumber} main list was not found`);
  const itemMatches = [...mainMatch[1].matchAll(/<li\b[\s\S]*?<\/li>/gi)];
  if (itemMatches.length < 1 || itemMatches.length > 100) {
    throw new Error(`page ${pageNumber} item count is abnormal: ${itemMatches.length}`);
  }

  const candidates = [];
  for (const itemMatch of itemMatches) {
    const item = itemMatch[0];
    const ids = [
      ...new Set(
        [...item.matchAll(/FC2[\s_-]*PPV[\s_-]*(\d{5,8})/gi)].map((match) => match[1])
      ),
    ];
    const imageMatch = item.match(/<img[^>]+src=["']([^"']+)["']/i);
    if (ids.length !== 1 || !imageMatch) continue;
    const hrefMatch = item.match(/<a[^>]+href=["']([^"']+)["']/i);
    if (!hrefMatch) continue;
    const dateMatch = item.match(/news_date[^>]*>([^<]+)</i);
    const imageUrl = decodeHtml(imageMatch[1]).replace(/^http:/i, "https:");
    let sourceArticleUrl;
    try {
      validateRemoteUrl(imageUrl, IMAGE_HOSTS, "image");
      sourceArticleUrl = new URL(decodeHtml(hrefMatch[1]), PAGE_ORIGIN).href;
      validateRemoteUrl(sourceArticleUrl, PAGE_HOSTS, "article");
    } catch {
      continue;
    }
    candidates.push({
      product_id: ids[0],
      image_url: imageUrl,
      source_page_url: pageUrl(pageNumber),
      source_article_url: sourceArticleUrl,
      page_number: String(pageNumber),
      published_date: dateMatch ? decodeHtml(dateMatch[1]).trim() : "",
    });
  }

  const pageNumbers = [...text.matchAll(/81-av-uncensored-page-(\d+)-cn\.html/gi)]
    .map((match) => Number(match[1]))
    .filter(Number.isInteger);
  return {
    itemCount: itemMatches.length,
    candidates,
    detectedLastPage: pageNumbers.length > 0 ? Math.max(...pageNumbers) : 1,
  };
}

const CANDIDATE_HEADERS = [
  "product_id",
  "image_url",
  "source_page_url",
  "source_article_url",
  "page_number",
  "published_date",
];
const SELECTED_HEADERS = [...CANDIDATE_HEADERS, "priority", "priority_reason"];
const RESULT_HEADERS = [
  "run_id",
  "mode",
  "product_id",
  "priority",
  "source_page_url",
  "source_article_url",
  "thumbnail_url",
  "local_thumbnail_path",
  "local_thumbnail_file_name",
  "status",
  "bytes",
  "sha256",
  "delay_ms",
  "network_attempts",
  "error_message",
  "processed_at",
];

function loadCandidateMap(filePath) {
  const map = new Map();
  for (const row of readCsv(filePath)) {
    if (/^\d{5,8}$/.test(row.product_id) && row.image_url && !map.has(row.product_id)) {
      map.set(row.product_id, row);
    }
  }
  return map;
}

function resolveBackfillTotalPages(detectedLastPage, maxTotalPages, backfillEndPage) {
  if (detectedLastPage < 1000 || detectedLastPage > maxTotalPages) {
    throw new StopRunError(
      `detected last page is outside the approved range 1000-${maxTotalPages}: ${detectedLastPage}`
    );
  }
  return Math.min(detectedLastPage, backfillEndPage);
}

async function discoverCandidates(config, paths, status) {
  const candidates = loadCandidateMap(paths.candidates);
  let totalPages = Number(status.total_pages || 0);
  let startPage = Number(status.last_completed_page || 0) + 1;
  if (config.mode === "daily") totalPages = config.dailyPages;
  if (
    config.mode === "backfill" &&
    totalPages !== 0 &&
    (totalPages < 1000 || totalPages > config.maxTotalPages)
  ) {
    throw new StopRunError(
      `checkpoint total_pages is outside the approved range 1000-${config.maxTotalPages}: ${totalPages}`
    );
  }
  if (config.mode === "backfill" && totalPages > 0) {
    const boundedTotalPages = Math.min(totalPages, config.backfillEndPage);
    if (boundedTotalPages !== totalPages || status.discovery_end_page !== config.backfillEndPage) {
      totalPages = boundedTotalPages;
      updateStatus(paths.status, status, {
        total_pages: totalPages,
        discovery_end_page: config.backfillEndPage,
      });
    }
  }

  if (status.phase !== "discovering" && Number(status.last_completed_page || 0) === 0) {
    updateStatus(paths.status, status, { run_status: "running", phase: "discovering" });
  }

  if (startPage === 1 || totalPages < 1) {
    await waitForSafeWindow(config);
    const firstResult = await requestWithRetry(
      pageUrl(1),
      {
        allowedHosts: PAGE_HOSTS,
        label: "page",
        accept: "text/html,application/xhtml+xml",
        maxBytes: MAX_HTML_BYTES,
        timeoutMs: config.timeoutMs,
      },
      config.maxAttempts
    );
    assertHtmlResponse(firstResult, 1);
    const parsed = extractPageData(firstResult.buffer.toString("utf8"), 1);
    totalPages =
      config.mode === "daily"
        ? config.dailyPages
        : resolveBackfillTotalPages(
            parsed.detectedLastPage,
            config.maxTotalPages,
            config.backfillEndPage
          );
    for (const candidate of parsed.candidates) {
      if (candidates.has(candidate.product_id)) continue;
      candidates.set(candidate.product_id, candidate);
      appendCsv(paths.candidates, CANDIDATE_HEADERS, candidate);
    }
    updateStatus(paths.status, status, {
      total_pages: totalPages,
      discovery_end_page: config.mode === "daily" ? config.dailyPages : config.backfillEndPage,
      last_completed_page: 1,
      discovered_unique: candidates.size,
    });
    startPage = 2;
    writeOutput(`discovery page=1/${totalPages} fc2=${parsed.candidates.length} unique=${candidates.size}`);
  }

  let pageNumber = startPage;
  while (pageNumber <= totalPages) {
    await waitForSafeWindow(config);
    await sleep(randomBetween(config.pageMinDelayMs, config.pageMaxDelayMs));
    const result = await requestWithRetry(
      pageUrl(pageNumber),
      {
        allowedHosts: PAGE_HOSTS,
        label: "page",
        accept: "text/html,application/xhtml+xml",
        maxBytes: MAX_HTML_BYTES,
        timeoutMs: config.timeoutMs,
      },
      config.maxAttempts
    );
    assertHtmlResponse(result, pageNumber);
    const parsed = extractPageData(result.buffer.toString("utf8"), pageNumber);
    for (const candidate of parsed.candidates) {
      if (candidates.has(candidate.product_id)) continue;
      candidates.set(candidate.product_id, candidate);
      appendCsv(paths.candidates, CANDIDATE_HEADERS, candidate);
    }
    updateStatus(paths.status, status, {
      total_pages: totalPages,
      last_completed_page: pageNumber,
      discovered_unique: candidates.size,
    });
    writeOutput(
      `discovery page=${pageNumber}/${totalPages} items=${parsed.itemCount} fc2=${parsed.candidates.length} unique=${candidates.size}`
    );
    pageNumber += 1;
  }

  if (config.mode === "backfill") {
    await waitForSafeWindow(config);
    const finalFirstResult = await requestWithRetry(
      pageUrl(1),
      {
        allowedHosts: PAGE_HOSTS,
        label: "page",
        accept: "text/html,application/xhtml+xml",
        maxBytes: MAX_HTML_BYTES,
        timeoutMs: config.timeoutMs,
      },
      config.maxAttempts
    );
    assertHtmlResponse(finalFirstResult, 1);
    const finalFirstPage = extractPageData(finalFirstResult.buffer.toString("utf8"), 1);
    const finalTotalPages = resolveBackfillTotalPages(
      finalFirstPage.detectedLastPage,
      config.maxTotalPages,
      config.backfillEndPage
    );
    for (const candidate of finalFirstPage.candidates) {
      if (candidates.has(candidate.product_id)) continue;
      candidates.set(candidate.product_id, candidate);
      appendCsv(paths.candidates, CANDIDATE_HEADERS, candidate);
    }
    if (finalTotalPages > totalPages) {
      totalPages = finalTotalPages;
      updateStatus(paths.status, status, {
        total_pages: totalPages,
        discovery_end_page: config.backfillEndPage,
        discovered_unique: candidates.size,
      });
      while (pageNumber <= totalPages) {
        await waitForSafeWindow(config);
        await sleep(randomBetween(config.pageMinDelayMs, config.pageMaxDelayMs));
        const result = await requestWithRetry(
          pageUrl(pageNumber),
          {
            allowedHosts: PAGE_HOSTS,
            label: "page",
            accept: "text/html,application/xhtml+xml",
            maxBytes: MAX_HTML_BYTES,
            timeoutMs: config.timeoutMs,
          },
          config.maxAttempts
        );
        assertHtmlResponse(result, pageNumber);
        const parsed = extractPageData(result.buffer.toString("utf8"), pageNumber);
        for (const candidate of parsed.candidates) {
          if (candidates.has(candidate.product_id)) continue;
          candidates.set(candidate.product_id, candidate);
          appendCsv(paths.candidates, CANDIDATE_HEADERS, candidate);
        }
        updateStatus(paths.status, status, {
          total_pages: totalPages,
          last_completed_page: pageNumber,
          discovered_unique: candidates.size,
        });
        writeOutput(
          `discovery added page=${pageNumber}/${totalPages} items=${parsed.itemCount} fc2=${parsed.candidates.length} unique=${candidates.size}`
        );
        pageNumber += 1;
      }
    }
  }

  return [...candidates.values()];
}

async function acquireSharedLock(client) {
  const result = await client.query(
    "SELECT pg_try_advisory_lock($1, $2) AS acquired",
    [LOCK_NAMESPACE, LOCK_KEY]
  );
  return result.rows[0]?.acquired === true;
}

async function releaseSharedLock(client) {
  await client.query("SELECT pg_advisory_unlock($1, $2)", [LOCK_NAMESPACE, LOCK_KEY]);
}

async function upsertRunLog(client, config, targetsFound) {
  const maxDownloads = config.mode === "daily" ? config.dailyCap : Math.max(targetsFound, 0);
  const dailyCap = config.mode === "daily" ? config.dailyCap : Math.max(targetsFound, 0);
  await client.query(
    `
      INSERT INTO public.xxx_tl003_fc2_wiki_thumbnail_runs (
        run_id, run_status, target_scope, max_downloads, daily_cap,
        min_delay_ms, max_delay_ms, max_attempts, targets_found, updated_at
      )
      VALUES ($1, 'running', $2, $3, $4, $5, $6, $7, $8, now())
      ON CONFLICT (run_id) DO UPDATE SET
        run_status = 'running',
        target_scope = EXCLUDED.target_scope,
        max_downloads = EXCLUDED.max_downloads,
        daily_cap = EXCLUDED.daily_cap,
        min_delay_ms = EXCLUDED.min_delay_ms,
        max_delay_ms = EXCLUDED.max_delay_ms,
        max_attempts = EXCLUDED.max_attempts,
        targets_found = EXCLUDED.targets_found,
        last_error = NULL,
        updated_at = now()
    `,
    [
      config.runId,
      config.targetScope,
      maxDownloads,
      dailyCap,
      config.imageMinDelayMs,
      config.imageMaxDelayMs,
      config.maxAttempts,
      targetsFound,
    ]
  );
}

async function finishRunLog(client, config, status, runStatus, lastError = "") {
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
    [
      config.runId,
      runStatus,
      Number(status.collected || 0),
      Number(status.failed || 0),
      Number(status.existing_file || 0),
      String(lastError || "").slice(0, 1000),
    ]
  );
}

async function readDbCandidateStates(client, productIds) {
  const states = new Map();
  const chunkSize = 2000;
  for (let index = 0; index < productIds.length; index += chunkSize) {
    const ids = productIds.slice(index, index + chunkSize);
    const result = await client.query(
      `
        WITH requested(product_id) AS (
          SELECT unnest($1::text[])
        )
        SELECT
          r.product_id,
          COALESCE(a.thumbnail_status, '') AS thumbnail_status,
          COALESCE(a.local_thumbnail_path, '') AS local_thumbnail_path,
          EXISTS (
            SELECT 1 FROM public.xxx_vq002_owned_product_ids o
            WHERE o.product_id::text = r.product_id
          ) AS is_owned,
          EXISTS (
            SELECT 1 FROM public.xxx_vq029_owned_file_thumbnail_status o
            WHERE o.product_id = r.product_id
              AND o.owned_without_thumbnail = true
          ) AS owned_without_thumbnail,
          EXISTS (
            SELECT 1 FROM public.xxx_vq025_rapidgator_best_links b
            WHERE b.fc2_product_id::text = r.product_id
              AND (
                b.has_rapidgator = true
                OR COALESCE(b.best_mp4_url::text, '') <> ''
                OR COALESCE(b.best_page_url::text, '') <> ''
              )
          ) AS has_rapidgator_candidate
        FROM requested r
        LEFT JOIN public.xxx_tm009_fc2_wiki_thumbnail_assets a
          ON a.product_id = r.product_id
      `,
      [ids]
    );
    for (const row of result.rows) states.set(row.product_id, row);
  }
  return states;
}

async function readJavArchiveFailureCounts(client, productIds) {
  const counts = new Map();
  const chunkSize = 2000;
  for (let index = 0; index < productIds.length; index += chunkSize) {
    const ids = productIds.slice(index, index + chunkSize);
    const result = await client.query(
      `
        SELECT i.product_id, COUNT(*)::integer AS failures
        FROM public.xxx_tl004_fc2_wiki_thumbnail_run_items i
        JOIN public.xxx_tl003_fc2_wiki_thumbnail_runs r
          ON r.run_id = i.run_id
        WHERE i.product_id = ANY($1::text[])
          AND r.target_scope IN ('javarchive_daily', 'javarchive_backfill_all_pages')
          AND i.item_status = 'failed'
        GROUP BY i.product_id
      `,
      [ids]
    );
    for (const row of result.rows) counts.set(row.product_id, Number(row.failures || 0));
  }
  return counts;
}

function isCollectedState(state) {
  return state?.thumbnail_status === "collected" && Boolean(state.local_thumbnail_path);
}

async function selectTargets(client, config, candidates) {
  const productIds = candidates.map((candidate) => candidate.product_id);
  const [states, failureCounts] = await Promise.all([
    readDbCandidateStates(client, productIds),
    readJavArchiveFailureCounts(client, productIds),
  ]);
  const selected = [];

  for (const candidate of candidates) {
    const state = states.get(candidate.product_id) || {};
    if (isCollectedState(state)) continue;
    if (Number(failureCounts.get(candidate.product_id) || 0) >= config.maxAttempts) continue;

    let priority = 3;
    let priorityReason = "daily_page_missing";
    if (state.owned_without_thumbnail || state.is_owned) {
      priority = 1;
      priorityReason = "owned_missing";
    } else if (state.has_rapidgator_candidate) {
      priority = 2;
      priorityReason = "unowned_rapidgator_candidate";
    }

    if (config.mode === "backfill" && priority === 3) continue;
    selected.push({ ...candidate, priority: String(priority), priority_reason: priorityReason });
  }

  selected.sort((left, right) => {
    const priorityDiff = Number(left.priority) - Number(right.priority);
    if (priorityDiff !== 0) return priorityDiff;
    const pageDiff = Number(left.page_number) - Number(right.page_number);
    if (pageDiff !== 0) return pageDiff;
    return Number(right.product_id) - Number(left.product_id);
  });
  return config.mode === "daily" ? selected.slice(0, config.dailyCap) : selected;
}

function loadResultSummary(filePath) {
  const terminal = new Set(["collected", "existing_file", "skipped_already_collected", "failed"]);
  const processedIds = new Set();
  const summary = {
    processed: 0,
    collected: 0,
    existing_file: 0,
    skipped_already_collected: 0,
    failed: 0,
  };
  for (const row of readCsv(filePath)) {
    if (!terminal.has(row.status) || processedIds.has(row.product_id)) continue;
    processedIds.add(row.product_id);
    summary.processed += 1;
    if (Object.hasOwn(summary, row.status)) summary[row.status] += 1;
  }
  return { processedIds, summary };
}

async function readAsset(client, productId) {
  const result = await client.query(
    `
      SELECT thumbnail_status, local_thumbnail_path, local_thumbnail_file_name
      FROM public.xxx_tm009_fc2_wiki_thumbnail_assets
      WHERE product_id = $1
      LIMIT 1
    `,
    [productId]
  );
  return result.rows[0] || null;
}

function findExistingThumbnail(productId) {
  for (const extension of KNOWN_EXTENSIONS) {
    const candidatePath = path.join(OUTPUT_DIR, `${productId}${extension}`);
    if (!fs.existsSync(candidatePath)) continue;
    const stat = fs.statSync(candidatePath);
    if (!stat.isFile() || stat.size < 8) continue;
    const handle = fs.openSync(candidatePath, "r");
    const header = Buffer.alloc(12);
    let bytesRead = 0;
    try {
      bytesRead = fs.readSync(handle, header, 0, header.length, 0);
    } finally {
      fs.closeSync(handle);
    }
    try {
      const detected = detectImageMagic(header.subarray(0, bytesRead));
      const expected = extension === ".jpeg" ? ".jpg" : extension;
      if (detected.extension !== expected) continue;
      return { path: candidatePath, fileName: path.basename(candidatePath), bytes: stat.size };
    } catch {
      continue;
    }
  }
  return null;
}

function detectImageMagic(buffer) {
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return { extension: ".jpg", mime: "image/jpeg" };
  }
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return { extension: ".png", mime: "image/png" };
  }
  if (buffer.length >= 12 && buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "WEBP") {
    return { extension: ".webp", mime: "image/webp" };
  }
  if (buffer.length >= 6 && new Set(["GIF87a", "GIF89a"]).has(buffer.toString("ascii", 0, 6))) {
    return { extension: ".gif", mime: "image/gif" };
  }
  throw new Error("image magic bytes are not approved");
}

function detectImage(buffer, contentType) {
  if (!String(contentType || "").startsWith("image/")) {
    throw new Error(`unexpected content-type: ${contentType || "(empty)"}`);
  }
  return detectImageMagic(buffer);
}

function persistImage(productId, buffer, extension) {
  const existingBefore = findExistingThumbnail(productId);
  if (existingBefore) return { ...existingBefore, created: false };

  const outputPath = path.join(OUTPUT_DIR, `${productId}${extension}`);
  const tempPath = path.join(OUTPUT_DIR, `.${productId}.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(tempPath, buffer, { flag: "wx" });
  try {
    const existingAfterWrite = findExistingThumbnail(productId);
    if (existingAfterWrite) {
      fs.unlinkSync(tempPath);
      return { ...existingAfterWrite, created: false };
    }
    fs.renameSync(tempPath, outputPath);
    return { path: outputPath, fileName: path.basename(outputPath), bytes: buffer.length, created: true };
  } catch (error) {
    try {
      if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
    } catch {
      // Only this process's uniquely named temporary file is eligible for cleanup.
    }
    const racedExisting = findExistingThumbnail(productId);
    if (racedExisting) return { ...racedExisting, created: false };
    throw error;
  }
}

async function markCollected(client, target, stored) {
  const result = await client.query(
    `
      INSERT INTO public.xxx_tm009_fc2_wiki_thumbnail_assets (
        product_id, thumbnail_url, local_thumbnail_path, local_thumbnail_file_name,
        thumbnail_status, source_wiki_url, last_checked_at, downloaded_at,
        attempt_count, last_error, updated_at
      )
      VALUES ($1, $2, $3, $4, 'collected', $5, now(), now(), 1, NULL, now())
      ON CONFLICT (product_id) DO UPDATE SET
        thumbnail_url = EXCLUDED.thumbnail_url,
        local_thumbnail_path = EXCLUDED.local_thumbnail_path,
        local_thumbnail_file_name = EXCLUDED.local_thumbnail_file_name,
        thumbnail_status = 'collected',
        source_wiki_url = EXCLUDED.source_wiki_url,
        last_checked_at = now(),
        downloaded_at = now(),
        attempt_count = COALESCE(public.xxx_tm009_fc2_wiki_thumbnail_assets.attempt_count, 0) + 1,
        last_error = NULL,
        updated_at = now()
      WHERE NOT (
        public.xxx_tm009_fc2_wiki_thumbnail_assets.thumbnail_status = 'collected'
        AND COALESCE(public.xxx_tm009_fc2_wiki_thumbnail_assets.local_thumbnail_path, '') <> ''
      )
      RETURNING product_id
    `,
    [target.product_id, target.image_url, stored.path, stored.fileName, target.source_article_url]
  );
  return result.rowCount > 0;
}

async function logRunItem(client, config, target, item) {
  await client.query(
    `
      INSERT INTO public.xxx_tl004_fc2_wiki_thumbnail_run_items (
        run_id, product_id, thumbnail_url, local_thumbnail_path,
        local_thumbnail_file_name, item_status, bytes, sha256,
        delay_ms, error_message, attempt_count
      )
      SELECT $1, $2, $3, $4, $5, $6, $7, $8, $9, NULLIF($10, ''), $11
      WHERE NOT EXISTS (
        SELECT 1
        FROM public.xxx_tl004_fc2_wiki_thumbnail_run_items
        WHERE run_id = $1 AND product_id = $2
      )
    `,
    [
      config.runId,
      target.product_id,
      target.image_url,
      item.localPath || "",
      item.fileName || "",
      item.status,
      item.bytes || null,
      item.sha256 || "",
      item.delayMs || null,
      String(item.errorMessage || "").slice(0, 1000),
      item.networkAttempts || 1,
    ]
  );
}

function resultRow(config, target, item) {
  return {
    run_id: config.runId,
    mode: config.mode,
    product_id: target.product_id,
    priority: target.priority,
    source_page_url: target.source_page_url,
    source_article_url: target.source_article_url,
    thumbnail_url: target.image_url,
    local_thumbnail_path: item.localPath || "",
    local_thumbnail_file_name: item.fileName || "",
    status: item.status,
    bytes: item.bytes || "",
    sha256: item.sha256 || "",
    delay_ms: item.delayMs || "",
    network_attempts: item.networkAttempts || 1,
    error_message: item.errorMessage || "",
    processed_at: new Date().toISOString(),
  };
}

async function processTarget(client, config, target) {
  const current = await readAsset(client, target.product_id);
  if (isCollectedState(current)) {
    return { status: "skipped_already_collected", networkAttempts: 1 };
  }

  const existing = findExistingThumbnail(target.product_id);
  if (existing) {
    const updated = await markCollected(client, target, existing);
    if (!updated) return { status: "skipped_already_collected", networkAttempts: 1 };
    return {
      status: "existing_file",
      localPath: existing.path,
      fileName: existing.fileName,
      bytes: existing.bytes,
      networkAttempts: 1,
    };
  }

  const delayMs = randomBetween(config.imageMinDelayMs, config.imageMaxDelayMs);
  await waitForSafeWindow(config);
  await sleep(delayMs);
  let networkAttempts = 0;
  try {
    const response = await requestWithRetry(
      target.image_url,
      {
        allowedHosts: IMAGE_HOSTS,
        label: "image",
        accept: "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
        maxBytes: MAX_IMAGE_BYTES,
        timeoutMs: config.timeoutMs,
      },
      config.maxAttempts
    );
    networkAttempts = response.attempts;
    if (!String(response.contentType || "").startsWith("image/") && looksLikeBlockingPage(response.buffer)) {
      const stopError = new StopRunError("image response contains a block or CAPTCHA page");
      stopError.networkAttempts = response.attempts;
      throw stopError;
    }
    const detected = detectImage(response.buffer, response.contentType);
    const currentAfterDownload = await readAsset(client, target.product_id);
    if (isCollectedState(currentAfterDownload)) {
      return { status: "skipped_already_collected", networkAttempts: response.attempts, delayMs };
    }
    const stored = persistImage(target.product_id, response.buffer, detected.extension);
    const updated = await markCollected(client, target, stored);
    if (!updated) {
      return { status: "skipped_already_collected", networkAttempts: response.attempts, delayMs };
    }
    return {
      status: stored.created ? "collected" : "existing_file",
      localPath: stored.path,
      fileName: stored.fileName,
      bytes: stored.bytes,
      sha256: crypto.createHash("sha256").update(response.buffer).digest("hex"),
      delayMs,
      networkAttempts: response.attempts,
    };
  } catch (error) {
    return {
      status: "failed",
      delayMs,
      networkAttempts: Number(error.networkAttempts || networkAttempts || config.maxAttempts),
      errorMessage: `${error.name || "Error"}:${error.message || error}; page=${target.source_page_url}`,
      stopRun: error instanceof StopRunError,
    };
  }
}

async function verifyCollectedCount(client, productIds) {
  let count = 0;
  const chunkSize = 2000;
  for (let index = 0; index < productIds.length; index += chunkSize) {
    const ids = productIds.slice(index, index + chunkSize);
    const result = await client.query(
      `
        SELECT COUNT(DISTINCT product_id)::integer AS count
        FROM public.xxx_tm009_fc2_wiki_thumbnail_assets
        WHERE product_id = ANY($1::text[])
          AND thumbnail_status = 'collected'
          AND COALESCE(local_thumbnail_path, '') <> ''
      `,
      [ids]
    );
    count += Number(result.rows[0]?.count || 0);
  }
  return count;
}

async function runCollection(client, config, paths, status, selected) {
  const resultState = loadResultSummary(paths.results);
  Object.assign(status, resultState.summary);
  updateStatus(paths.status, status, {
    run_status: "running",
    phase: "downloading",
    selected_targets: selected.length,
  });

  let consecutiveFailures = 0;
  for (const target of selected) {
    if (resultState.processedIds.has(target.product_id)) continue;
    const item = await processTarget(client, config, target);
    await logRunItem(client, config, target, item);
    appendCsv(paths.results, RESULT_HEADERS, resultRow(config, target, item));
    resultState.processedIds.add(target.product_id);

    status.processed += 1;
    if (Object.hasOwn(status, item.status)) status[item.status] += 1;
    if (item.status === "failed") {
      consecutiveFailures += 1;
      status.latest_error = item.errorMessage || "unknown failure";
    } else {
      consecutiveFailures = 0;
    }
    updateStatus(paths.status, status, {});
    writeOutput(
      `download ${status.processed}/${selected.length} product=${target.product_id} priority=${target.priority} status=${item.status}`
    );

    if (item.stopRun) {
      throw new StopRunError(item.errorMessage || "source protection stop");
    }

    if (consecutiveFailures >= config.maxConsecutiveFailures) {
      throw new Error(`stopped after ${consecutiveFailures} consecutive download failures`);
    }
    if (status.processed % config.batchPauseEvery === 0 && status.processed < selected.length) {
      writeOutput(`batch pause ${config.batchPauseMs}ms after ${status.processed} items`);
      await sleep(config.batchPauseMs);
    }
  }
}

async function main() {
  const config = buildConfig();
  assertExecutionGates(config);
  ensureDirectories(config);
  const paths = runPaths(config);
  const status = readStatus(paths.status, config);

  if (status.run_status === "completed") {
    writeOutput(`already completed: ${config.runId}`);
    return;
  }

  const client = new Client({
    connectionTimeoutMillis: 15000,
    query_timeout: 60000,
    statement_timeout: 55000,
    keepAlive: true,
    host: requireEnv("PGHOST"),
    port: Number(process.env.PGPORT || 5432),
    database: requireEnv("PGDATABASE"),
    user: requireEnv("PGUSER"),
    password: requireEnv("PGPASSWORD"),
    ssl:
      (process.env.PGSSL || "false").toLowerCase() === "true"
        ? { rejectUnauthorized: false }
        : false,
  });

  let lockAcquired = false;
  let runLogCreated = false;
  let runtimeLimitMs = (config.mode === "daily" ? 2 : 6) * 60 * 60 * 1000;
  if (config.mode === "backfill") {
    const now = new Date();
    const dailyStartGuard = new Date(now);
    dailyStartGuard.setHours(0, 50, 0, 0);
    if (now >= dailyStartGuard && now.getHours() < 4) {
      writeOutput("backfill deferred: daily collection window 00:50-04:00");
      return;
    }
    if (dailyStartGuard <= now) dailyStartGuard.setDate(dailyStartGuard.getDate() + 1);
    runtimeLimitMs = Math.min(runtimeLimitMs, dailyStartGuard.getTime() - now.getTime());
  }
  // A hung asynchronous operation must not retain the shared lock for days.
  // Exiting closes the DB session; the next run resumes from persisted results.
  const runDeadline = setTimeout(() => {
    writeError(`hard runtime limit reached: mode=${config.mode}; terminating to release shared lock`);
    try {
      updateStatus(paths.status, status, {
        run_status: "failed",
        latest_error: "hard runtime limit reached; resume from persisted results",
        failed_at: new Date().toISOString(),
      });
    } finally {
      process.exit(1);
    }
  }, runtimeLimitMs);
  runDeadline.unref();
  await client.connect();
  try {
    lockAcquired = await acquireSharedLock(client);
    if (!lockAcquired && config.mode === "daily" && config.lockWaitMinutes > 0) {
      const deadline = Date.now() + config.lockWaitMinutes * 60 * 1000;
      updateStatus(paths.status, status, {
        run_status: "waiting_locked",
        phase: "waiting_locked",
        latest_error: "waiting for another JavArchive thumbnail collector to finish",
      });
      writeOutput(`wait for shared lock: up to ${config.lockWaitMinutes} minute(s)`);
      while (!lockAcquired && Date.now() < deadline) {
        await sleep(Math.min(60000, deadline - Date.now()));
        lockAcquired = await acquireSharedLock(client);
      }
      if (lockAcquired) writeOutput("shared lock acquired after waiting");
    }
    if (!lockAcquired) {
      updateStatus(paths.status, status, {
        run_status: "skipped_locked",
        phase: "skipped_locked",
        latest_error: "another JavArchive thumbnail collector is running",
      });
      writeOutput("skip: another JavArchive thumbnail collector holds the shared lock");
      return;
    }

    await upsertRunLog(client, config, Number(status.selected_targets || 0));
    runLogCreated = true;
    writeOutput(
      `start run=${config.runId} mode=${config.mode} output=${OUTPUT_DIR} run_dir=${config.runDir}`
    );

    let selected;
    if (fs.existsSync(paths.selected)) {
      selected = readCsv(paths.selected);
      writeOutput(`resume selected targets=${selected.length}`);
    } else {
      const candidates = await discoverCandidates(config, paths, status);
      updateStatus(paths.status, status, { phase: "selecting", discovered_unique: candidates.length });
      selected = await selectTargets(client, config, candidates);
      writeCsv(paths.selected, SELECTED_HEADERS, selected);
      await upsertRunLog(client, config, selected.length);
      updateStatus(paths.status, status, { selected_targets: selected.length });
      writeOutput(`selected targets=${selected.length} candidates=${candidates.length}`);
    }

    await runCollection(client, config, paths, status, selected);
    const verifiedCollected = await verifyCollectedCount(
      client,
      selected.map((target) => target.product_id)
    );
    updateStatus(paths.status, status, {
      run_status: "completed",
      phase: "completed",
      verified_collected_in_db: verifiedCollected,
      finished_at: new Date().toISOString(),
      latest_error: "",
    });
    await finishRunLog(client, config, status, "success");
    writeOutput(
      `completed run=${config.runId} selected=${selected.length} processed=${status.processed} collected=${status.collected} existing=${status.existing_file} failed=${status.failed} verified_db=${verifiedCollected}`
    );
  } catch (error) {
    updateStatus(paths.status, status, {
      run_status: "failed",
      phase: status.phase || "failed",
      latest_error: `${error.name || "Error"}:${error.message || error}`,
      failed_at: new Date().toISOString(),
    });
    if (runLogCreated) {
      try {
        await finishRunLog(client, config, status, "failed", error.message || String(error));
      } catch (logError) {
        writeError(`run log finish failed: ${logError.message || logError}`);
      }
    }
    throw error;
  } finally {
    if (lockAcquired) {
      try {
        await releaseSharedLock(client);
      } catch (error) {
        writeError(`advisory unlock failed: ${error.message || error}`);
      }
    }
    await client.end().catch(() => {});
    clearTimeout(runDeadline);
  }
}

module.exports = {
  detectImage,
  extractPageData,
  looksLikeBlockingPage,
  maintenanceWindowDelayMs,
  pageUrl,
  resolveBackfillTotalPages,
  validateRemoteUrl,
};

if (require.main === module) {
  main().catch((error) => {
    writeError(`FC2 JavArchive collector failed: ${error.stack || error.message || error}`);
    process.exitCode = 1;
  });
}
