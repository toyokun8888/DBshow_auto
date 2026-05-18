// ============================================================
// fc2_article_delta_thumbnail_collector_operational.js
// Collect thumbnails only for the latest FC2 article daily delta.
//
// Purpose:
// - Read product IDs staged by fc2_article_collector_operational.js
// - Resolve thumbnail URLs from the FC2 Wiki article pool by product_id
// - Download thumbnails for those staged product IDs only
// - Save files and DB status using the same tables as fc2_wiki_thumbnail_collector_operational.js
//
// Safety:
// - Differential target queue only, not whole master
// - Random delay before network requests
// - Only contents-thumbnail2.fc2.com HTTPS URLs are accepted
// - Existing thumbnail files are not overwritten
// - No DROP, TRUNCATE, or file cleanup
// ============================================================

const fs = require("fs");
const path = require("path");
const https = require("https");
const crypto = require("crypto");
const { Client } = require("pg");
require("dotenv").config({ quiet: true });

const BASE_URL = "https://adult.contents.fc2.com";
const OUTPUT_DIR = path.join(__dirname, "fc2_sum");

const CONFIRM_DOWNLOAD = process.env.FC2_ARTICLE_DELTA_THUMB_CONFIRM_DOWNLOAD || "YES";
const CONFIRM_DB_WRITE = process.env.FC2_ARTICLE_DELTA_THUMB_CONFIRM_DB_WRITE || "YES";

const LOOKBACK_HOURS = Math.min(
  Math.max(Number(process.env.FC2_ARTICLE_DELTA_THUMB_LOOKBACK_HOURS || 24), 1),
  72
);
const MAX_DOWNLOADS = Math.min(
  Math.max(Number(process.env.FC2_ARTICLE_DELTA_THUMB_MAX_DOWNLOADS || 300), 1),
  1000
);
const MAX_PAGES = Math.min(
  Math.max(Number(process.env.FC2_ARTICLE_DELTA_THUMB_MAX_PAGES || 10), 1),
  50
);

const MIN_DELAY_MS = Math.max(Number(process.env.FC2_ARTICLE_DELTA_THUMB_MIN_DELAY_MS || 2000), 1000);
const MAX_DELAY_MS = Math.max(Number(process.env.FC2_ARTICLE_DELTA_THUMB_MAX_DELAY_MS || 5000), MIN_DELAY_MS);
const REQUEST_TIMEOUT_MS = Math.max(Number(process.env.FC2_ARTICLE_DELTA_THUMB_TIMEOUT_MS || 30000), 5000);
const MAX_ATTEMPTS = Math.min(
  Math.max(Number(process.env.FC2_ARTICLE_DELTA_THUMB_MAX_ATTEMPTS || 3), 1),
  5
);
const MAX_BYTES = 10 * 1024 * 1024;
const TARGET_SCOPE = "article_delta";
const RUN_ID = `fc2_article_delta_thumb_${new Date().toISOString().replace(/[-:T.]/g, "").slice(0, 14)}_${process.pid}`;
const TABLE_DELTA_THUMBNAIL_TARGETS = "xxx_tm010_fc2_delta_thumbnail_targets";
const TABLE_DELTA_THUMBNAIL_TARGET_LOGS = "xxx_tl005_fc2_delta_thumbnail_target_logs";

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

function assertSafetyGate() {
  if (CONFIRM_DOWNLOAD !== "YES") {
    throw new Error("Download gate failed. Set FC2_ARTICLE_DELTA_THUMB_CONFIRM_DOWNLOAD=YES.");
  }
  if (CONFIRM_DB_WRITE !== "YES") {
    throw new Error("DB write gate failed. Set FC2_ARTICLE_DELTA_THUMB_CONFIRM_DB_WRITE=YES.");
  }
}

function ensureOutputDir() {
  if (fs.existsSync(OUTPUT_DIR)) {
    const stat = fs.statSync(OUTPUT_DIR);
    if (!stat.isDirectory()) {
      throw new Error(`Output path exists but is not a directory: ${OUTPUT_DIR}`);
    }
  }
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomDelayMs() {
  return MIN_DELAY_MS + Math.floor(Math.random() * (MAX_DELAY_MS - MIN_DELAY_MS + 1));
}

function buildSearchPageUrl(pageNumber) {
  return `${BASE_URL}/search/?&page=${pageNumber}`;
}

function toAbsoluteUrl(href) {
  if (!href) return "";
  if (href.startsWith("http://") || href.startsWith("https://")) return href;
  return `${BASE_URL}${href}`;
}

function extractProductIdFromArticleHref(href) {
  const match = String(href || "").match(/(?:\/article\/|[?&]aid=|fc2-?ppv-)(\d{6,8})/i);
  return match ? match[1] : "";
}

function isApprovedThumbnailUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && parsed.hostname === "contents-thumbnail2.fc2.com";
  } catch {
    return false;
  }
}

function extensionFromUrl(url) {
  const cleanPath = new URL(url).pathname.toLowerCase();
  const ext = path.extname(cleanPath);
  if ([".jpg", ".jpeg", ".png", ".webp"].includes(ext)) return ext;
  return ".jpg";
}

function outputFileNameForProduct(productId, url) {
  return `${productId}${extensionFromUrl(url)}`;
}

function firstNonEmpty(...values) {
  for (const value of values) {
    const text = String(value || "").trim();
    if (text) return text;
  }
  return "";
}

function decodeHtml(value) {
  return String(value || "")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function normalizeUrl(value) {
  const text = decodeHtml(String(value || "").trim()).replace(/\\\//g, "/");
  if (text.startsWith("//")) return `https:${text}`;
  return toAbsoluteUrl(text);
}

function formatError(error) {
  const parts = [
    error?.name,
    error?.code,
    error?.message,
    error?.cause?.code,
    error?.cause?.message,
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(":") : String(error || "unknown_error");
}

function fetchText(url) {
  return new Promise((resolve, reject) => {
    const request = https.get(
      url,
      {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) thumbnail-check/1.0",
          Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        },
      },
      (response) => {
        if (response.statusCode !== 200) {
          response.resume();
          reject(new Error(`HTTP ${response.statusCode}`));
          return;
        }

        const chunks = [];
        response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        response.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      }
    );

    request.setTimeout(REQUEST_TIMEOUT_MS, () => {
      request.destroy(new Error("Request timeout"));
    });
    request.on("error", reject);
  });
}

function downloadFile(url, outputPath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    let bytes = 0;
    const tempPath = `${outputPath}.download-${process.pid}-${Date.now()}.tmp`;

    const request = https.get(
      url,
      {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) thumbnail-check/1.0",
          Accept: "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
        },
      },
      (response) => {
        if (response.statusCode !== 200) {
          response.resume();
          reject(new Error(`HTTP ${response.statusCode}`));
          return;
        }

        const contentType = response.headers["content-type"] || "";
        if (!String(contentType).startsWith("image/")) {
          response.resume();
          reject(new Error(`Unexpected content-type: ${contentType}`));
          return;
        }

        const file = fs.createWriteStream(tempPath, { flags: "wx" });

        response.on("data", (chunk) => {
          bytes += chunk.length;
          if (bytes > MAX_BYTES) {
            request.destroy(new Error(`File too large: ${bytes}`));
            return;
          }
          hash.update(chunk);
        });

        response.pipe(file);

        file.on("finish", () => {
          file.close(() => {
            if (fs.existsSync(outputPath)) {
              reject(new Error(`Output file already exists: ${outputPath}`));
              return;
            }
            fs.renameSync(tempPath, outputPath);
            resolve({
              bytes,
              sha256: hash.digest("hex"),
              contentType,
            });
          });
        });

        file.on("error", reject);
      }
    );

    request.setTimeout(REQUEST_TIMEOUT_MS, () => {
      request.destroy(new Error("Request timeout"));
    });

    request.on("error", (error) => {
      try {
        if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
      } catch {
        // noop
      }
      reject(error);
    });
  });
}

async function fetchSearchPageHtml(url, label) {
  let lastError = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      return await fetchText(url);
    } catch (error) {
      lastError = error;
      console.log(`${label} page failed ${attempt}/${MAX_ATTEMPTS}: ${formatError(error)}`);
      if (attempt < MAX_ATTEMPTS) await sleep(3000 * attempt);
    }
  }
  throw new Error(`Page fetch failed after ${MAX_ATTEMPTS} attempts: ${formatError(lastError)}`);
}

function extractFirstThumbnailUrlFromHtml(html) {
  const matches = String(html || "").match(
    /(?:https:\\?\/\\?\/|\/\/)contents-thumbnail2\.fc2\.com[^"'<>\\\s]+/gi
  ) || [];

  for (const value of matches) {
    const normalized = normalizeUrl(value);
    if (isApprovedThumbnailUrl(normalized)) return normalized;
  }

  return "";
}

async function scrapeThumbnailsFromSearchPage(searchPageUrl, wantedProductIds) {
  const html = await fetchSearchPageHtml(searchPageUrl, searchPageUrl);
  if (!html) return [];

  const rows = [];
  for (const productId of wantedProductIds) {
    const articlePattern = new RegExp(`(?:/article/${productId}(?:/|\\\\?)|[?&]aid=${productId}(?:&|["'<>\\\\s])|fc2-?ppv-${productId}(?:[^0-9]|$))`, "gi");
    let match = null;
    let foundMatch = false;
    let thumbnailUrl = "";

    while ((match = articlePattern.exec(html)) !== null) {
      foundMatch = true;
      const start = Math.max(0, match.index - 5000);
      const end = Math.min(html.length, match.index + 5000);
      const windowHtml = html.slice(start, end);
      thumbnailUrl = extractFirstThumbnailUrlFromHtml(windowHtml);
      if (thumbnailUrl) break;
    }

    if (!foundMatch) continue;

    if (!thumbnailUrl) {
      rows.push({
        href: `/article/${productId}/`,
        thumbnailUrl: "",
      });
      continue;
    }

    rows.push({
      href: `/article/${productId}/`,
      thumbnailUrl,
    });
  }

  return rows;
}

async function collectDeltaCandidates(client) {
  const result = await client.query(
    `
      SELECT
        q.product_id,
        q.source_run_id,
        q.source_collected_at,
        q.article_url,
        q.search_page_url,
        q.page_number,
        q.row_index_in_page,
        q.article_seller_id,
        q.article_seller_name,
        q.wiki_seller_id,
        q.wiki_seller_name,
        COALESCE(w.thumbnail_url, '') AS thumbnail_url,
        COALESCE(w.source_wiki_url, ws.wiki_url, '') AS source_wiki_url,
        COALESCE(ws.wiki_url, '') AS wiki_seller_url,
        CASE
          WHEN COALESCE(w.thumbnail_url, '') = '' THEN 'not_found_yet'
          ELSE 'found'
        END AS thumbnail_lookup_status,
        COALESCE(t.thumbnail_status, '') AS thumbnail_status,
        COALESCE(t.attempt_count, 0) AS attempt_count
      FROM public.${TABLE_DELTA_THUMBNAIL_TARGETS} q
      LEFT JOIN public.xxx_tm007_fc2_wiki_sellers ws
        ON ws.id = q.wiki_seller_id
      LEFT JOIN public.xxx_tm009_fc2_wiki_thumbnail_assets t
        ON t.product_id = q.product_id
      LEFT JOIN LATERAL (
        SELECT
          a.thumbnail_url,
          a.source_wiki_url
        FROM public.xxx_tm008_fc2_wiki_articles a
        WHERE a.product_id = q.product_id
          AND COALESCE(a.thumbnail_url, '') <> ''
        ORDER BY
          a.updated_at DESC NULLS LAST,
          a.collected_at DESC NULLS LAST,
          a.id DESC
        LIMIT 1
      ) w ON true
      WHERE q.target_status = 'pending'
        AND COALESCE(t.thumbnail_status, '') <> 'collected'
        AND COALESCE(t.attempt_count, 0) < $2
      ORDER BY
        q.page_number ASC NULLS LAST,
        q.row_index_in_page ASC NULLS LAST,
        CASE WHEN q.product_id ~ '^\\d+$' THEN q.product_id::numeric END DESC NULLS LAST,
        q.product_id DESC
      LIMIT $1
    `,
    [MAX_DOWNLOADS, MAX_ATTEMPTS]
  );

  return result.rows;
}

function buildPageUrls(candidates) {
  const urls = [];
  const seen = new Set();

  for (const row of candidates) {
    const url = firstNonEmpty(row.search_page_url, row.page_number ? buildSearchPageUrl(row.page_number) : "");
    if (!url || seen.has(url)) continue;
    seen.add(url);
    urls.push(url);
    if (urls.length >= MAX_PAGES) break;
  }

  return urls;
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
      VALUES ($1, 'running', $8, $2, $3, $4, $5, $6, $7, now())
    `,
    [RUN_ID, MAX_DOWNLOADS, MAX_DOWNLOADS, MIN_DELAY_MS, MAX_DELAY_MS, MAX_ATTEMPTS, targetsFound, TARGET_SCOPE]
  );
}

async function ensureDeltaThumbnailTargetTables(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS public.${TABLE_DELTA_THUMBNAIL_TARGETS} (
      product_id text PRIMARY KEY,
      source_run_id text NOT NULL,
      source_collected_at timestamptz,
      article_url text,
      search_page_url text,
      page_number integer,
      row_index_in_page integer,
      article_seller_id text,
      article_seller_name text,
      wiki_seller_id bigint,
      wiki_seller_name text,
      target_status text NOT NULL DEFAULT 'pending',
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
  `);

  await client.query(`
    CREATE TABLE IF NOT EXISTS public.${TABLE_DELTA_THUMBNAIL_TARGET_LOGS} (
      id bigserial PRIMARY KEY,
      run_id text NOT NULL,
      product_id text NOT NULL,
      article_seller_id text,
      article_seller_name text,
      wiki_seller_id bigint,
      wiki_seller_name text,
      action text NOT NULL,
      result_status text NOT NULL,
      detail text,
      recorded_at timestamptz NOT NULL DEFAULT now()
    );
  `);
}

async function updateDeltaTargetStatus(client, row, status, detail = "") {
  await client.query(
    `
      UPDATE public.${TABLE_DELTA_THUMBNAIL_TARGETS}
      SET
        target_status = $2,
        updated_at = now()
      WHERE product_id = $1
    `,
    [row.product_id, status]
  );

  await client.query(
    `
      INSERT INTO public.${TABLE_DELTA_THUMBNAIL_TARGET_LOGS} (
        run_id,
        product_id,
        article_seller_id,
        article_seller_name,
        wiki_seller_id,
        wiki_seller_name,
        action,
        result_status,
        detail
      )
      VALUES ($1, $2, $3, $4, $5, $6, 'thumbnail_collect', $7, NULLIF($8, ''))
    `,
    [
      RUN_ID,
      row.product_id || "",
      row.article_seller_id || "",
      row.article_seller_name || "",
      row.wiki_seller_id || null,
      row.wiki_seller_name || "",
      status,
      String(detail || "").slice(0, 1000),
    ]
  );
}

async function cleanupDeltaTargets(client) {
  const result = await client.query(`DELETE FROM public.${TABLE_DELTA_THUMBNAIL_TARGETS};`);
  return result.rowCount;
}

async function finishRunLog(client, status, successCount, failedCount, existingFileCount, lastError = "") {
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
    [RUN_ID, status, successCount, failedCount, existingFileCount, String(lastError || "").slice(0, 1000)]
  );
}

async function markCollected(client, row, outputPath, fileName) {
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
      VALUES ($1, $2, $3, $4, 'collected', $5, now(), now(), 1, NULL, now())
      ON CONFLICT (product_id) DO UPDATE SET
        thumbnail_url = EXCLUDED.thumbnail_url,
        local_thumbnail_path = EXCLUDED.local_thumbnail_path,
        local_thumbnail_file_name = EXCLUDED.local_thumbnail_file_name,
        thumbnail_status = 'collected',
        source_wiki_url = EXCLUDED.source_wiki_url,
        last_checked_at = now(),
        downloaded_at = now(),
        attempt_count = public.xxx_tm009_fc2_wiki_thumbnail_assets.attempt_count + 1,
        last_error = NULL,
        updated_at = now()
    `,
    [row.product_id, row.thumbnail_url, outputPath, fileName, row.source_wiki_url || ""]
  );
}

async function markFailed(client, row, status, errorMessage) {
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
        attempt_count,
        last_error,
        updated_at
      )
      VALUES ($1, $2, '', '', $3, $4, now(), 1, $5, now())
      ON CONFLICT (product_id) DO UPDATE SET
        thumbnail_url = EXCLUDED.thumbnail_url,
        thumbnail_status = EXCLUDED.thumbnail_status,
        source_wiki_url = EXCLUDED.source_wiki_url,
        last_checked_at = now(),
        attempt_count = public.xxx_tm009_fc2_wiki_thumbnail_assets.attempt_count + 1,
        last_error = EXCLUDED.last_error,
        updated_at = now()
    `,
    [
      row.product_id,
      row.thumbnail_url || "",
      status,
      row.source_wiki_url || "",
      String(errorMessage || "").slice(0, 1000),
    ]
  );
}

async function logRunItem(client, row, item) {
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
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NULLIF($10, ''), $11)
    `,
    [
      RUN_ID,
      row.product_id || "",
      row.thumbnail_url || "",
      item.localThumbnailPath || "",
      item.localThumbnailFileName || "",
      item.status,
      item.bytes || null,
      item.sha256 || "",
      item.delayMs || null,
      String(item.errorMessage || "").slice(0, 1000),
      Number(row.attempt_count || 0) + 1,
    ]
  );
}

async function processThumbnail(client, row) {
  const productId = String(row.product_id || "").trim();
  const thumbnailUrl = String(row.thumbnail_url || "").trim();

  if (!/^\d{6,8}$/.test(productId)) {
    await markFailed(client, row, "failed", "Invalid product_id");
    await logRunItem(client, row, { status: "failed", errorMessage: "invalid_product_id" });
    return "failed";
  }

  if (!isApprovedThumbnailUrl(thumbnailUrl)) {
    if (row.thumbnail_lookup_status === "fetch_failed") {
      await markFailed(client, row, "fetch_failed", "FC2 Wiki seller page fetch failed");
      await logRunItem(client, row, { status: "fetch_failed", errorMessage: "wiki_seller_page_fetch_failed" });
      return "fetch_failed";
    }

    if (row.thumbnail_lookup_status === "not_found_yet") {
      await markFailed(client, row, "not_found_yet", "Thumbnail URL not found in FC2 Wiki article pool");
      await logRunItem(client, row, { status: "not_found_yet", errorMessage: "thumbnail_url_not_found_yet" });
      return "not_found_yet";
    }

    if (row.thumbnail_fetch_error) {
      await markFailed(client, row, "fetch_failed", row.thumbnail_fetch_error);
      await logRunItem(client, row, { status: "fetch_failed", errorMessage: row.thumbnail_fetch_error });
      return "failed";
    }

    await markFailed(client, row, "missing_url", "Missing or unapproved thumbnail URL");
    await logRunItem(client, row, { status: "missing_url", errorMessage: "missing_or_unapproved_url" });
    return "failed";
  }

  const fileName = outputFileNameForProduct(productId, thumbnailUrl);
  const outputPath = path.join(OUTPUT_DIR, fileName);

  if (fs.existsSync(outputPath)) {
    const stat = fs.statSync(outputPath);
    await markCollected(client, row, outputPath, fileName);
    await logRunItem(client, row, {
      status: "existing_file",
      localThumbnailPath: outputPath,
      localThumbnailFileName: fileName,
      bytes: stat.size,
    });
    console.log(`${productId} collected existing_file bytes=${stat.size}`);
    return "existing";
  }

  const delayMs = randomDelayMs();
  await sleep(delayMs);

  try {
    const result = await downloadFile(thumbnailUrl, outputPath);
    await markCollected(client, row, outputPath, fileName);
    await logRunItem(client, row, {
      status: "collected",
      localThumbnailPath: outputPath,
      localThumbnailFileName: fileName,
      bytes: result.bytes,
      sha256: result.sha256,
      delayMs,
    });
    console.log(`${productId} collected bytes=${result.bytes}`);
    return "collected";
  } catch (error) {
    await markFailed(client, row, "failed", error.message || String(error));
    await logRunItem(client, row, {
      status: "failed",
      delayMs,
      errorMessage: error.message || String(error),
    });
    console.log(`${productId} failed ${error.message || error}`);
    return "failed";
  }
}

async function main() {
  assertSafetyGate();
  ensureOutputDir();

  const client = new Client(DB_CONFIG);
  await client.connect();

  let successCount = 0;
  let failedCount = 0;
  let existingCount = 0;
  let cleanupCount = 0;

  try {
    await ensureDeltaThumbnailTargetTables(client);
    const candidates = await collectDeltaCandidates(client);
    await createRunLog(client, candidates.length);

    console.log("=".repeat(70));
    console.log("FC2 Article Delta Thumbnail Collector");
    console.log(`maxDownloads  : ${MAX_DOWNLOADS}`);
    console.log(`source        : ${TABLE_DELTA_THUMBNAIL_TARGETS}`);
    console.log(`delay         : ${MIN_DELAY_MS}-${MAX_DELAY_MS} ms`);
    console.log(`output        : ${OUTPUT_DIR}`);
    console.log(`targets       : ${candidates.length}`);
    console.log("=".repeat(70));

    if (candidates.length === 0) {
      await finishRunLog(client, "success", 0, 0, 0);
      return;
    }

    const targetByProductId = new Map(candidates.map((row) => [String(row.product_id), row]));
    const wikiUrls = [];
    const seenWikiUrls = new Set();

    for (const row of candidates) {
      if (row.thumbnail_url) continue;
      if (!row.wiki_seller_url || seenWikiUrls.has(row.wiki_seller_url)) continue;
      seenWikiUrls.add(row.wiki_seller_url);
      wikiUrls.push(row.wiki_seller_url);
    }

    for (const wikiUrl of wikiUrls) {
      const wantedProductIds = candidates
        .filter((row) => !row.thumbnail_url && row.wiki_seller_url === wikiUrl)
        .map((row) => String(row.product_id));
      let cards = [];
      try {
        cards = await scrapeThumbnailsFromSearchPage(wikiUrl, wantedProductIds);
      } catch (error) {
        console.log(`${wikiUrl} scrape failed: ${error.message || error}`);
        for (const productId of wantedProductIds) {
          const row = targetByProductId.get(productId);
          if (row) row.thumbnail_lookup_status = "fetch_failed";
        }
        continue;
      }

      for (const card of cards) {
        const productId = extractProductIdFromArticleHref(card.href);
        const row = targetByProductId.get(productId);
        if (!row || !card.thumbnailUrl) continue;
        row.thumbnail_url = toAbsoluteUrl(card.thumbnailUrl);
        row.source_wiki_url = wikiUrl;
        row.thumbnail_lookup_status = "found";
      }
    }

    for (const row of candidates) {
      const status = await processThumbnail(client, row);
      if (status === "collected") successCount++;
      else if (status === "existing") existingCount++;
      else failedCount++;

      await updateDeltaTargetStatus(client, row, status, row.thumbnail_lookup_status || "");
    }

    await finishRunLog(client, "success", successCount, failedCount, existingCount);
    cleanupCount = await cleanupDeltaTargets(client);
  } catch (error) {
    console.error(error);
    try {
      await finishRunLog(client, "failed", successCount, failedCount, existingCount, error.message || String(error));
    } catch {
      // noop
    }
    process.exitCode = 1;
  } finally {
    await client.end();
  }

  console.log("=".repeat(70));
  console.log("DONE");
  console.log(`run_success : ${successCount}`);
  console.log(`run_failed  : ${failedCount}`);
  console.log(`run_existing: ${existingCount}`);
  console.log(`queue_deleted: ${cleanupCount}`);
  console.log("=".repeat(70));
}

main();
