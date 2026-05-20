const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const axios = require("axios");
const cheerio = require("cheerio");
const { Client } = require("pg");

const PROJECT_ROOT = __dirname;
const ENV_PATH = path.join(PROJECT_ROOT, ".env");
const SUKEBEI_BASE_URL = "https://sukebei.nyaa.si";
const PRODUCT_ID_RE = /FC2-PPV-(\d{7,})/i;

const DEFAULTS = {
  SUKEBEI_DRY_RUN: "true",
  SUKEBEI_CONFIRM_EXECUTE: "NO",
  SUKEBEI_MAX_PAGE_SAFE_LIMIT: "30",
  SUKEBEI_MAX_DOWNLOADS: "5",
  SUKEBEI_TORRENT_DOWNLOAD_DIR: "P:\\hogehoge",
  SUKEBEI_CSV_LOG_DIR: "P:\\hogehoge\\_torrent_logs",
  SUKEBEI_MATCH_SOURCE: "target_table",
  SUKEBEI_MATCH_TABLE: "public.xxx_tm010_fc2_delta_thumbnail_targets",
  SUKEBEI_MATCH_PRODUCT_ID_COLUMN: "product_id",
  SUKEBEI_MATCH_STATUS_COLUMN: "target_status",
  SUKEBEI_MATCH_REQUIRED_STATUS: "pending",
  SUKEBEI_MATCH_LOG_TABLE: "public.xxx_tl005_fc2_delta_thumbnail_target_logs",
  SUKEBEI_MATCH_LOG_ACTION: "enqueue",
  SUKEBEI_MATCH_LOG_STATUS: "pending",
  SUKEBEI_MATCH_LOG_LIMIT: "100",
  SUKEBEI_DOWNLOAD_TABLE: "public.xxx_tm012_sukebei_torrent_downloads",
  SUKEBEI_REQUEST_TIMEOUT_MS: "20000",
  SUKEBEI_RETRY_COUNT: "3",
  SUKEBEI_WAIT_MIN_MS: "2000",
  SUKEBEI_WAIT_MAX_MS: "5000",
  SUKEBEI_USER_AGENT:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36",
};

const CSV_COLUMNS = [
  "run_id",
  "run_at",
  "dry_run",
  "page",
  "posted_date",
  "product_id",
  "title",
  "view_url",
  "torrent_url",
  "seed_count",
  "candidate_count",
  "selected_seed",
  "selection_note",
  "matched_db",
  "duplicate",
  "planned_file_path",
  "status",
  "error_message",
];

async function main() {
  loadEnvFile(ENV_PATH);
  const config = buildConfig();
  const runAtDate = new Date();
  const runAt = formatDateTimeWithOffset(runAtDate);
  const todayDate = formatLocalDate(runAtDate);
  const runId = `sukebei_fc2_${formatDateStamp(runAtDate)}`;
  const csvPath = path.join(config.csvLogDir, `sukebei_fc2_torrent_${config.dryRun ? "dryrun" : "execute"}_${formatDateStamp(runAtDate)}.csv`);
  const rows = [];

  validateConfig(config);
  ensureDirectory(config.csvLogDir);
  ensureDirectory(config.downloadDir);

  const client = createPgClient();
  await client.connect();

  try {
    if (!config.dryRun) {
      await ensureDownloadTable(client, config);
    }

    process.stdout.write(`Sukebei FC2 torrent downloader started. run_id=${runId} dry_run=${config.dryRun}\n`);
    process.stdout.write(`Today date: ${todayDate}\n`);
    process.stdout.write(`Max page safe limit: ${config.maxPageSafeLimit}\n`);
    process.stdout.write(`Download dir: ${config.downloadDir}\n`);
    process.stdout.write(`Match source: ${config.matchSource}\n`);
    process.stdout.write(`Match table: ${config.matchTable}\n`);
    process.stdout.write(`Match log table: ${config.matchLogTable}\n`);
    process.stdout.write(`Download table: ${config.downloadTable}\n`);

    const matchContext = await loadMatchContext(client, config);
    if (matchContext.type === "delta_log_latest") {
      process.stdout.write(`Eligible product_id from latest log: ${matchContext.productIds.size}/${config.matchLogLimit}\n`);
    }

    const rawCandidates = [];

    for (let page = 1; page <= config.maxPageSafeLimit; page += 1) {
      await randomWait(config, `before page ${page}`);
      const pageUrl = `${SUKEBEI_BASE_URL}/?c=2_2&p=${page}`;
      process.stdout.write(`Fetch page ${page}: ${pageUrl}\n`);

      let items = [];
      try {
        const html = await fetchTextWithRetry(pageUrl, config);
        const parsed = parsePageItemsByDate(html, page, todayDate);
        items = parsed.items;
        rawCandidates.push(...items);
        if (parsed.todayRowCount > 0) {
          const message = `today row found page=${page} date=${todayDate} row_count=${parsed.todayRowCount}`;
          process.stdout.write(`${message}\n`);
          rows.push(buildRow({
            runId,
            runAt,
            dryRun: config.dryRun,
            page,
            postedDate: todayDate,
            status: "TODAY_ROW_FOUND",
            selectionNote: message,
          }));
        }
        process.stdout.write(`Page ${page}: found today FC2 candidates=${items.length}\n`);
        if (parsed.oldDateDetected) {
          const oldDateMessage = `old date detected page=${page} row_date=${parsed.oldDate} today=${todayDate}`;
          const stopMessage = `stop crawling page=${page} reason=old_date_detected`;
          process.stdout.write(`${oldDateMessage}\n`);
          process.stdout.write(`${stopMessage}\n`);
          rows.push(buildRow({
            runId,
            runAt,
            dryRun: config.dryRun,
            page,
            postedDate: parsed.oldDate,
            status: "OLD_DATE_DETECTED",
            selectionNote: oldDateMessage,
          }));
          rows.push(buildRow({
            runId,
            runAt,
            dryRun: config.dryRun,
            page,
            postedDate: parsed.oldDate,
            status: "STOP_CRAWLING",
            selectionNote: stopMessage,
          }));
          break;
        }
      } catch (error) {
        rows.push(buildRow({
          runId,
          runAt,
          dryRun: config.dryRun,
          page,
          status: "PAGE_FETCH_ERROR",
          errorMessage: error.message,
        }));
        continue;
      }

      if (page === config.maxPageSafeLimit) {
        const message = `stop crawling page=${page} reason=max_page_safe_limit`;
        process.stdout.write(`${message}\n`);
        rows.push(buildRow({
          runId,
          runAt,
          dryRun: config.dryRun,
          page,
          status: "STOP_CRAWLING",
          selectionNote: message,
        }));
      }
    }

    const selectedItems = selectHighestSeedCandidates(rawCandidates, rows, { runId, runAt, dryRun: config.dryRun });
    let executedDownloads = 0;

    for (const item of selectedItems) {
      const plannedFilePath = buildCollisionSafePath(
        path.join(config.downloadDir, `${sanitizeFileName(item.productId)}_${path.basename(new URL(item.torrentUrl).pathname)}`)
      );
      const baseRow = {
        runId,
        runAt,
        dryRun: config.dryRun,
        page: item.page,
        postedDate: item.postedDate,
        productId: item.productId,
        title: item.title,
        viewUrl: item.viewUrl,
        torrentUrl: item.torrentUrl,
        seedCount: item.seedCount,
        candidateCount: item.candidateCount,
        selectedSeed: item.selectedSeed,
        selectionNote: item.selectionNote,
        plannedFilePath,
      };

      let matched = false;
      let duplicate = false;
      let reserved = false;

      try {
        matched = await hasProductIdInMatchSource(client, config, matchContext, item.productId);
        if (!matched) {
          rows.push(buildRow({ ...baseRow, matchedDb: false, duplicate: false, status: "SKIPPED_NOT_IN_MATCH_TABLE" }));
          continue;
        }

        duplicate = await isAlreadyDownloaded(client, config, item.torrentUrl);
        if (duplicate) {
          rows.push(buildRow({ ...baseRow, matchedDb: true, duplicate: true, status: "SKIPPED_DUPLICATE" }));
          continue;
        }

        if (config.dryRun) {
          rows.push(buildRow({ ...baseRow, matchedDb: true, duplicate: false, status: "DRY_RUN_MATCHED" }));
          continue;
        }

        if (executedDownloads >= config.maxDownloads) {
          rows.push(buildRow({ ...baseRow, matchedDb: true, duplicate: false, status: "SKIPPED_LIMIT_REACHED" }));
          continue;
        }

        reserved = await reserveDownload(client, config, {
          productId: item.productId,
          torrentUrl: item.torrentUrl,
          torrentPageUrl: item.viewUrl,
          torrentTitle: item.title,
        });
        if (!reserved) {
          rows.push(buildRow({ ...baseRow, matchedDb: true, duplicate: true, status: "SKIPPED_DUPLICATE" }));
          continue;
        }

        await randomWait(config, `before torrent download product_id=${item.productId}`);
        const finalFilePath = await downloadTorrent(item.torrentUrl, plannedFilePath, config);
        await markDownloaded(client, config, {
          torrentUrl: item.torrentUrl,
          downloadedFilePath: finalFilePath,
        });
        executedDownloads += 1;
        rows.push(buildRow({
          ...baseRow,
          matchedDb: true,
          duplicate: false,
          plannedFilePath: finalFilePath,
          status: "DOWNLOADED",
        }));
        process.stdout.write(`Downloaded ${executedDownloads}/${config.maxDownloads}: ${finalFilePath}\n`);
      } catch (error) {
        rows.push(buildRow({
          ...baseRow,
          matchedDb: matched,
          duplicate,
          status: "ERROR",
          errorMessage: error.message,
        }));
        if (!config.dryRun && reserved) {
          await upsertError(client, config, {
            productId: item.productId,
            torrentUrl: item.torrentUrl,
            torrentPageUrl: item.viewUrl,
            torrentTitle: item.title,
            status: "error",
            lastError: error.message,
          });
        }
      }
    }
  } finally {
    await client.end();
  }

  const writtenCsvPath = writeCsv(csvPath, rows, CSV_COLUMNS);
  const summary = summarize(rows);
  process.stdout.write([
    "Sukebei FC2 torrent downloader finished.",
    `CSV: ${writtenCsvPath}`,
    `Rows: ${rows.length}`,
    `Matched dry-run: ${summary.dryRunMatched}`,
    `Downloaded: ${summary.downloaded}`,
    `Duplicates: ${summary.duplicates}`,
    `Errors: ${summary.errors}`,
    "",
  ].join("\n"));
}

function buildConfig() {
  const dryRunValue = envValue("SUKEBEI_DRY_RUN") || envValue("DRY_RUN") || DEFAULTS.SUKEBEI_DRY_RUN;
  return {
    dryRun: String(dryRunValue).toLowerCase() === "true",
    confirmExecute: envValue("SUKEBEI_CONFIRM_EXECUTE") || "NO",
    maxPageSafeLimit: parsePositiveInt(envValue("SUKEBEI_MAX_PAGE_SAFE_LIMIT") || DEFAULTS.SUKEBEI_MAX_PAGE_SAFE_LIMIT),
    maxDownloads: parsePositiveInt(envValue("SUKEBEI_MAX_DOWNLOADS") || DEFAULTS.SUKEBEI_MAX_DOWNLOADS),
    downloadDir: envValue("SUKEBEI_TORRENT_DOWNLOAD_DIR") || envValue("TORRENT_DOWNLOAD_DIR") || DEFAULTS.SUKEBEI_TORRENT_DOWNLOAD_DIR,
    csvLogDir: envValue("SUKEBEI_CSV_LOG_DIR") || envValue("TORRENT_LOG_DIR") || DEFAULTS.SUKEBEI_CSV_LOG_DIR,
    matchSource: envValue("SUKEBEI_MATCH_SOURCE") || DEFAULTS.SUKEBEI_MATCH_SOURCE,
    matchTable: envValue("SUKEBEI_MATCH_TABLE") || DEFAULTS.SUKEBEI_MATCH_TABLE,
    matchProductIdColumn: envValue("SUKEBEI_MATCH_PRODUCT_ID_COLUMN") || DEFAULTS.SUKEBEI_MATCH_PRODUCT_ID_COLUMN,
    matchStatusColumn: envValue("SUKEBEI_MATCH_STATUS_COLUMN") || DEFAULTS.SUKEBEI_MATCH_STATUS_COLUMN,
    matchRequiredStatus: envValue("SUKEBEI_MATCH_REQUIRED_STATUS") || DEFAULTS.SUKEBEI_MATCH_REQUIRED_STATUS,
    matchLogTable: envValue("SUKEBEI_MATCH_LOG_TABLE") || DEFAULTS.SUKEBEI_MATCH_LOG_TABLE,
    matchLogAction: envValue("SUKEBEI_MATCH_LOG_ACTION") || DEFAULTS.SUKEBEI_MATCH_LOG_ACTION,
    matchLogStatus: envValue("SUKEBEI_MATCH_LOG_STATUS") || DEFAULTS.SUKEBEI_MATCH_LOG_STATUS,
    matchLogLimit: parsePositiveInt(envValue("SUKEBEI_MATCH_LOG_LIMIT") || DEFAULTS.SUKEBEI_MATCH_LOG_LIMIT),
    downloadTable: envValue("SUKEBEI_DOWNLOAD_TABLE") || DEFAULTS.SUKEBEI_DOWNLOAD_TABLE,
    timeoutMs: parsePositiveInt(envValue("SUKEBEI_REQUEST_TIMEOUT_MS") || DEFAULTS.SUKEBEI_REQUEST_TIMEOUT_MS),
    retryCount: parsePositiveInt(envValue("SUKEBEI_RETRY_COUNT") || DEFAULTS.SUKEBEI_RETRY_COUNT),
    waitMinMs: parsePositiveInt(envValue("SUKEBEI_WAIT_MIN_MS") || DEFAULTS.SUKEBEI_WAIT_MIN_MS),
    waitMaxMs: parsePositiveInt(envValue("SUKEBEI_WAIT_MAX_MS") || DEFAULTS.SUKEBEI_WAIT_MAX_MS),
    userAgent: envValue("SUKEBEI_USER_AGENT") || DEFAULTS.SUKEBEI_USER_AGENT,
  };
}

function validateConfig(config) {
  if (config.maxPageSafeLimit < 1 || config.maxPageSafeLimit > 30) {
    throw new Error("SUKEBEI_MAX_PAGE_SAFE_LIMIT must be between 1 and 30.");
  }
  if (config.waitMinMs < 1000 || config.waitMaxMs < config.waitMinMs) {
    throw new Error("Invalid wait range. Use at least 1000ms and max >= min.");
  }
  if (!config.dryRun && config.confirmExecute !== "YES") {
    throw new Error("Execute requires SUKEBEI_DRY_RUN=false and SUKEBEI_CONFIRM_EXECUTE=YES.");
  }
  if (!["target_table", "delta_log_latest"].includes(config.matchSource)) {
    throw new Error(`Invalid SUKEBEI_MATCH_SOURCE: ${config.matchSource}`);
  }
  assertSafeQualifiedName(config.matchTable, "match table");
  assertProjectTableName(config.matchTable, "match table");
  assertSafeIdentifier(config.matchProductIdColumn, "match product id column");
  assertSafeIdentifier(config.matchStatusColumn, "match status column");
  assertSafeQualifiedName(config.matchLogTable, "match log table");
  assertProjectDbObjectName(config.matchLogTable, "match log table", /^xxx_tl\d{3}_[a-zA-Z0-9_]+$/);
  if (config.matchLogLimit < 1 || config.matchLogLimit > 500) {
    throw new Error("SUKEBEI_MATCH_LOG_LIMIT must be between 1 and 500.");
  }
  assertSafeQualifiedName(config.downloadTable, "download table");
  assertProjectTableName(config.downloadTable, "download table");
}

function parsePageItemsByDate(html, page, todayDate) {
  const $ = cheerio.load(html);
  const byTorrentUrl = new Map();
  let todayRowCount = 0;
  let oldDateDetected = false;
  let oldDate = "";

  $("tr").each((_, rowElement) => {
    if (oldDateDetected) return;

    const row = $(rowElement);
    const postedDate = extractPostedDate(row, $);
    if (!postedDate) return;

    if (postedDate !== todayDate) {
      oldDateDetected = true;
      oldDate = postedDate;
      return;
    }

    todayRowCount += 1;
    row.find("a[href^='/download/'][href$='.torrent']").each((__, link) => {
      const href = String($(link).attr("href") || "");
      const titleLink = row.find("a[href^='/view/'][title]").first();
      const title = String(titleLink.attr("title") || titleLink.text() || "").trim();
      const match = title.match(PRODUCT_ID_RE);
      if (!match) return;

      const viewHref = String(titleLink.attr("href") || "");
      const torrentUrl = new URL(href, SUKEBEI_BASE_URL).toString();
      const seedCount = extractSeedCount(row, $);
      byTorrentUrl.set(torrentUrl, {
        page,
        postedDate,
        productId: match[1],
        title,
        viewUrl: viewHref ? new URL(viewHref, SUKEBEI_BASE_URL).toString() : "",
        torrentUrl,
        seedCount,
      });
    });
  });

  return {
    items: [...byTorrentUrl.values()].sort((a, b) => a.productId.localeCompare(b.productId)),
    todayRowCount,
    oldDateDetected,
    oldDate,
  };
}

function extractPostedDate(row, $) {
  let postedDate = "";
  row.find("td.text-center").each((_, cell) => {
    if (postedDate) return;
    const text = String($(cell).text() || "").trim();
    const candidate = text.slice(0, 10);
    if (/^\d{4}-\d{2}-\d{2}$/.test(candidate)) {
      postedDate = candidate;
    }
  });
  return postedDate;
}

function extractSeedCount(row, $) {
  const values = [];
  row.find("td.text-center").each((_, cell) => {
    const parsed = Number.parseInt(String($(cell).text() || "").replace(/,/g, "").trim(), 10);
    values.push(Number.isFinite(parsed) ? parsed : 0);
  });

  if (values.length >= 3) return values[values.length - 3];
  if (values.length > 0) return values[0];
  return 0;
}

function selectHighestSeedCandidates(items, rows, context) {
  const groups = new Map();
  for (const item of items) {
    if (!groups.has(item.productId)) groups.set(item.productId, []);
    groups.get(item.productId).push(item);
  }

  const selected = [];
  for (const [productId, candidates] of groups) {
    const sorted = [...candidates].sort((a, b) => {
      const seedDiff = Number(b.seedCount || 0) - Number(a.seedCount || 0);
      if (seedDiff !== 0) return seedDiff;
      return a.torrentUrl.localeCompare(b.torrentUrl);
    });
    const winner = sorted[0];
    winner.candidateCount = sorted.length;
    winner.selectedSeed = Number(winner.seedCount || 0);
    winner.selectionNote = sorted.length > 1 ? "selected_highest_seed_torrent" : "single_candidate";

    if (sorted.length > 1) {
      const message = [
        "duplicate candidates found",
        "selected highest seed torrent",
        `product_id=${productId}`,
        `selected_seed=${winner.selectedSeed}`,
        `candidate_count=${sorted.length}`,
      ].join("; ");
      process.stdout.write(`${message}\n`);

      for (const loser of sorted.slice(1)) {
        rows.push(buildRow({
          runId: context.runId,
          runAt: context.runAt,
          dryRun: context.dryRun,
          page: loser.page,
          postedDate: loser.postedDate,
          productId: loser.productId,
          title: loser.title,
          viewUrl: loser.viewUrl,
          torrentUrl: loser.torrentUrl,
          seedCount: loser.seedCount,
          candidateCount: sorted.length,
          selectedSeed: winner.selectedSeed,
          selectionNote: message,
          status: "SKIPPED_LOWER_SEED_DUPLICATE",
        }));
      }
    }

    selected.push(winner);
  }

  return selected;
}

async function fetchTextWithRetry(url, config) {
  const response = await requestWithRetry(() =>
    axios.get(url, {
      responseType: "text",
      timeout: config.timeoutMs,
      headers: buildHeaders(config),
      validateStatus: (status) => status >= 200 && status < 300,
    }), config, `GET ${url}`
  );
  return response.data;
}

async function downloadTorrent(url, plannedPath, config) {
  const finalPath = buildCollisionSafePath(plannedPath);
  const response = await requestWithRetry(() =>
    axios.get(url, {
      responseType: "arraybuffer",
      timeout: config.timeoutMs,
      headers: buildHeaders(config),
      validateStatus: (status) => status >= 200 && status < 300,
    }), config, `GET ${url}`
  );
  await fsp.writeFile(finalPath, Buffer.from(response.data), { flag: "wx" });
  return finalPath;
}

function buildHeaders(config) {
  return {
    "User-Agent": config.userAgent,
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  };
}

async function requestWithRetry(fn, config, label) {
  let lastError;
  for (let attempt = 1; attempt <= config.retryCount; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      const status = error.response ? ` HTTP ${error.response.status}` : "";
      process.stdout.write(`${label} failed attempt ${attempt}/${config.retryCount}${status}: ${error.message}\n`);
      if (attempt < config.retryCount) {
        await sleep(config.waitMinMs * attempt);
      }
    }
  }
  throw lastError;
}

async function randomWait(config, reason) {
  const ms = randomInt(config.waitMinMs, config.waitMaxMs);
  process.stdout.write(`Wait ${ms}ms (${reason})\n`);
  await sleep(ms);
}

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function ensureDownloadTable(client, config) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS ${config.downloadTable} (
      id bigserial PRIMARY KEY,
      product_id text NOT NULL,
      torrent_url text NOT NULL,
      torrent_page_url text,
      torrent_title text,
      downloaded_file_path text,
      status text NOT NULL DEFAULT 'reserved',
      downloaded_at timestamptz,
      last_checked_at timestamptz NOT NULL DEFAULT now(),
      last_error text,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT xxx_uq_tm012_sukebei_torrent_url UNIQUE (torrent_url),
      CONSTRAINT xxx_chk_tm012_sukebei_status
        CHECK (status IN ('reserved', 'downloaded', 'dry_run', 'skipped_duplicate', 'error'))
    )
  `);
  await client.query(`CREATE INDEX IF NOT EXISTS xxx_idx_tm012_sukebei_product_id ON ${config.downloadTable} (product_id)`);
  await client.query(`CREATE INDEX IF NOT EXISTS xxx_idx_tm012_sukebei_status ON ${config.downloadTable} (status)`);
  await client.query(`CREATE INDEX IF NOT EXISTS xxx_idx_tm012_sukebei_downloaded_at ON ${config.downloadTable} (downloaded_at)`);
}

async function loadMatchContext(client, config) {
  if (config.matchSource === "target_table") {
    return { type: "target_table" };
  }

  const downloadTableExists = await tableExists(client, config.downloadTable);
  const rows = downloadTableExists
    ? await loadLatestLogProductIdsExcludingDownloaded(client, config)
    : await loadLatestLogProductIds(client, config);

  return {
    type: "delta_log_latest",
    productIds: new Set(rows.map((row) => String(row.product_id))),
    rows,
  };
}

async function loadLatestLogProductIds(client, config) {
  const result = await client.query(
    `SELECT latest.product_id
     FROM (
       SELECT
         product_id,
         MAX(id) AS latest_log_id,
         MAX(recorded_at) AS latest_recorded_at
       FROM ${config.matchLogTable}
       WHERE action = $1
         AND result_status = $2
         AND product_id IS NOT NULL
       GROUP BY product_id
     ) latest
     ORDER BY latest.latest_log_id DESC
     LIMIT $3`,
    [config.matchLogAction, config.matchLogStatus, config.matchLogLimit]
  );
  return result.rows;
}

async function loadLatestLogProductIdsExcludingDownloaded(client, config) {
  const result = await client.query(
    `SELECT latest.product_id
     FROM (
       SELECT
         product_id,
         MAX(id) AS latest_log_id,
         MAX(recorded_at) AS latest_recorded_at
       FROM ${config.matchLogTable}
       WHERE action = $1
         AND result_status = $2
         AND product_id IS NOT NULL
       GROUP BY product_id
     ) latest
     WHERE NOT EXISTS (
       SELECT 1
       FROM ${config.downloadTable} downloaded
       WHERE downloaded.product_id = latest.product_id
         AND downloaded.status IN ('reserved', 'downloaded', 'dry_run', 'skipped_duplicate')
     )
     ORDER BY latest.latest_log_id DESC
     LIMIT $3`,
    [config.matchLogAction, config.matchLogStatus, config.matchLogLimit]
  );
  return result.rows;
}

async function hasProductIdInMatchSource(client, config, matchContext, productId) {
  if (matchContext.type === "delta_log_latest") {
    return matchContext.productIds.has(String(productId));
  }
  return hasProductIdInMatchTable(client, config, productId);
}

async function hasProductIdInMatchTable(client, config, productId) {
  const sql = `SELECT 1 FROM ${config.matchTable} WHERE ${config.matchProductIdColumn} = $1 AND ${config.matchStatusColumn} = $2 LIMIT 1`;
  const result = await client.query(sql, [productId, config.matchRequiredStatus]);
  return result.rowCount > 0;
}

async function isAlreadyDownloaded(client, config, torrentUrl) {
  const exists = await tableExists(client, config.downloadTable);
  if (!exists) return false;

  const result = await client.query(
    `SELECT 1 FROM ${config.downloadTable}
     WHERE torrent_url = $1
       AND status IN ('reserved', 'downloaded', 'dry_run', 'skipped_duplicate')
     LIMIT 1`,
    [torrentUrl]
  );
  return result.rowCount > 0;
}

async function reserveDownload(client, config, row) {
  const result = await client.query(
    `INSERT INTO ${config.downloadTable}
      (product_id, torrent_url, torrent_page_url, torrent_title, status, last_checked_at, created_at, updated_at)
     VALUES ($1,$2,$3,$4,'reserved',NOW(),NOW(),NOW())
     ON CONFLICT (torrent_url) DO NOTHING
     RETURNING id`,
    [
      row.productId,
      row.torrentUrl,
      row.torrentPageUrl,
      row.torrentTitle,
    ]
  );

  return result.rowCount === 1;
}

async function markDownloaded(client, config, row) {
  await client.query(
    `UPDATE ${config.downloadTable}
     SET status = 'downloaded',
         downloaded_file_path = $2,
         downloaded_at = NOW(),
         last_checked_at = NOW(),
         last_error = '',
         updated_at = NOW()
     WHERE torrent_url = $1`,
    [row.torrentUrl, row.downloadedFilePath]
  );
}

async function upsertError(client, config, row) {
  await client.query(
    `INSERT INTO ${config.downloadTable}
      (product_id, torrent_url, torrent_page_url, torrent_title, status, last_checked_at, last_error, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,NOW(),$6,NOW(),NOW())
     ON CONFLICT (torrent_url) DO UPDATE SET
       status = EXCLUDED.status,
       last_checked_at = NOW(),
       last_error = EXCLUDED.last_error,
       updated_at = NOW()`,
    [row.productId, row.torrentUrl, row.torrentPageUrl, row.torrentTitle, row.status, row.lastError]
  );
}

async function tableExists(client, qualifiedName) {
  const result = await client.query("SELECT to_regclass($1) AS table_name", [qualifiedName]);
  return Boolean(result.rows[0]?.table_name);
}

function createPgClient() {
  const databaseUrl = envValue("DATABASE_URL");
  if (databaseUrl) {
    return new Client({ connectionString: databaseUrl });
  }

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

function buildRow(data) {
  return {
    run_id: data.runId || "",
    run_at: data.runAt || "",
    dry_run: String(data.dryRun),
    page: String(data.page || ""),
    posted_date: data.postedDate || "",
    product_id: data.productId || "",
    title: data.title || "",
    view_url: data.viewUrl || "",
    torrent_url: data.torrentUrl || "",
    seed_count: String(data.seedCount == null ? "" : data.seedCount),
    candidate_count: String(data.candidateCount == null ? "" : data.candidateCount),
    selected_seed: String(data.selectedSeed == null ? "" : data.selectedSeed),
    selection_note: data.selectionNote || "",
    matched_db: String(Boolean(data.matchedDb)),
    duplicate: String(Boolean(data.duplicate)),
    planned_file_path: data.plannedFilePath || "",
    status: data.status || "",
    error_message: data.errorMessage || "",
  };
}

function summarize(rows) {
  return rows.reduce((acc, row) => {
    if (row.status === "DRY_RUN_MATCHED") acc.dryRunMatched += 1;
    if (row.status === "DOWNLOADED") acc.downloaded += 1;
    if (row.status === "SKIPPED_DUPLICATE") acc.duplicates += 1;
    if (row.status === "ERROR" || row.status === "PAGE_FETCH_ERROR") acc.errors += 1;
    return acc;
  }, { dryRunMatched: 0, downloaded: 0, duplicates: 0, errors: 0 });
}

function writeCsv(csvPath, rows, columns) {
  const safePath = buildCollisionSafePath(csvPath);
  const lines = [
    columns.join(","),
    ...rows.map((row) => columns.map((column) => csvEscape(row[column])).join(",")),
  ];
  fs.writeFileSync(safePath, `${lines.join("\n")}\n`, { encoding: "utf8", flag: "wx" });
  return safePath;
}

function csvEscape(value) {
  const text = String(value == null ? "" : value);
  return `"${text.replace(/"/g, '""')}"`;
}

function buildCollisionSafePath(targetPath) {
  if (!fs.existsSync(targetPath)) return targetPath;
  const parsed = path.parse(targetPath);
  let index = 1;
  let candidate = path.join(parsed.dir, `${parsed.name}(${index})${parsed.ext}`);
  while (fs.existsSync(candidate)) {
    index += 1;
    candidate = path.join(parsed.dir, `${parsed.name}(${index})${parsed.ext}`);
  }
  return candidate;
}

function sanitizeFileName(value) {
  return String(value || "")
    .replace(/[\\/:*?"<>|]/g, "_")
    .replace(/[\u0000-\u001f]/g, "")
    .trim()
    .replace(/[. ]+$/g, "") || "unknown";
}

function ensureDirectory(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function parsePositiveInt(value) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function assertSafeQualifiedName(value, label) {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*\.[a-zA-Z_][a-zA-Z0-9_]*$/.test(value)) {
    throw new Error(`Unsafe ${label}: ${value}`);
  }
}

function assertProjectTableName(value, label) {
  assertProjectDbObjectName(value, label, /^xxx_tm\d{3}_[a-zA-Z0-9_]+$/);
}

function assertProjectDbObjectName(value, label, pattern) {
  const tableName = value.split(".")[1] || "";
  if (!pattern.test(tableName)) {
    throw new Error(`${label} does not follow project DB naming: ${value}`);
  }
}

function assertSafeIdentifier(value, label) {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(value)) {
    throw new Error(`Unsafe ${label}: ${value}`);
  }
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

function formatDateStamp(date) {
  const parts = getLocalParts(date);
  return `${parts.year}${parts.month}${parts.day}_${parts.hour}${parts.minute}${parts.second}`;
}

function formatLocalDate(date) {
  const parts = getLocalParts(date);
  return `${parts.year}-${parts.month}-${parts.day}`;
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

main().catch((error) => {
  process.stderr.write(`Sukebei FC2 torrent downloader failed: ${error.message}\n`);
  process.exitCode = 1;
});
