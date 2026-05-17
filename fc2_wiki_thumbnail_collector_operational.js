// ============================================================
// fc2_wiki_thumbnail_collector_operational.js
// FC2 Wiki thumbnail collector for the FC2 Wiki article pool.
//
// Purpose:
// - Download thumbnails from xxx_tm008_fc2_wiki_articles after owned items are mostly done
// - Save images under ./fc2_sum using {product_id}.{ext}
// - Record progress in xxx_tm009_fc2_wiki_thumbnail_assets
//
// Safety:
// - Default daily cap is 5000 downloads
// - Random delay is inserted before every network request
// - Only contents-thumbnail2.fc2.com HTTPS URLs are allowed
// - No DELETE, DROP, TRUNCATE, or file cleanup
// - Existing thumbnail files are not overwritten
// ============================================================

const fs = require("fs");
const path = require("path");
const https = require("https");
const crypto = require("crypto");
const { Client } = require("pg");
require("dotenv").config({ quiet: true });

// const CONFIRM_DOWNLOAD = process.env.FC2_THUMB_COLLECT_CONFIRM_DOWNLOAD || "NO";
// const CONFIRM_DB_WRITE = process.env.FC2_THUMB_COLLECT_CONFIRM_DB_WRITE || "NO";

const CONFIRM_DOWNLOAD = "YES";
const CONFIRM_DB_WRITE = "YES";

const OUTPUT_DIR = path.join(__dirname, "fc2_sum");

// const MAX_DOWNLOADS = Math.min(
//   Math.max(Number(process.env.FC2_THUMB_COLLECT_MAX_DOWNLOADS || 100), 1),
//   100
// );

const TARGET_SCOPE = "wiki_all_overnight";

const MAX_DOWNLOADS = Math.min(
  Math.max(Number(process.env.FC2_THUMB_COLLECT_MAX_DOWNLOADS || 5000), 1),
  5000
);

// const DAILY_CAP = Math.min(
//   Math.max(Number(process.env.FC2_THUMB_COLLECT_DAILY_CAP || 100), 1),
//   100
// );

const DAILY_CAP = Math.min(
  Math.max(Number(process.env.FC2_THUMB_COLLECT_DAILY_CAP || 5000), 1),
  5000
);

const BATCH_PAUSE_EVERY = 300;
const BATCH_PAUSE_MS = 3 * 60 * 1000;

const MIN_DELAY_MS = Math.max(Number(process.env.FC2_THUMB_COLLECT_MIN_DELAY_MS || 2500), 1000);
const MAX_DELAY_MS = Math.max(Number(process.env.FC2_THUMB_COLLECT_MAX_DELAY_MS || 5500), MIN_DELAY_MS);
const REQUEST_TIMEOUT_MS = Math.max(Number(process.env.FC2_THUMB_COLLECT_TIMEOUT_MS || 30000), 5000);
const MAX_BYTES = 10 * 1024 * 1024;
const MAX_ATTEMPTS = Math.min(
  Math.max(Number(process.env.FC2_THUMB_COLLECT_MAX_ATTEMPTS || 3), 1),
  5
);
const RUN_ID = `fc2_thumb_${new Date().toISOString().replace(/[-:T.]/g, "").slice(0, 14)}_${process.pid}`;

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
    throw new Error("Download gate failed. Set FC2_THUMB_COLLECT_CONFIRM_DOWNLOAD=YES.");
  }
  if (CONFIRM_DB_WRITE !== "YES") {
    throw new Error("DB write gate failed. Set FC2_THUMB_COLLECT_CONFIRM_DB_WRITE=YES.");
  }

  // if (MAX_DOWNLOADS > 100) {
  //   throw new Error("MAX_DOWNLOADS must be 100 or less.");
  // }

  if (MAX_DOWNLOADS > 5000) {
    throw new Error("MAX_DOWNLOADS must be 5000 or less.");
  }
  if (DAILY_CAP > 5000) {
    throw new Error("DAILY_CAP must be 5000 or less.");
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomDelayMs() {
  return MIN_DELAY_MS + Math.floor(Math.random() * (MAX_DELAY_MS - MIN_DELAY_MS + 1));
}

async function pauseAfterBatchIfNeeded(processedCount, totalTargets) {
  if (processedCount <= 0) return;
  if (processedCount >= totalTargets) return;
  if (processedCount % BATCH_PAUSE_EVERY !== 0) return;

  console.log("=".repeat(70));
  console.log(`${processedCount}件処理したため、3分休憩します...`);
  console.log("=".repeat(70));

  await sleep(BATCH_PAUSE_MS);

  console.log("休憩終了。処理を再開します...");
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

        file.on("error", (error) => {
          reject(error);
        });
      }
    );

    request.setTimeout(REQUEST_TIMEOUT_MS, () => {
      request.destroy(new Error("Request timeout"));
    });

    request.on("error", (error) => {
      reject(error);
    });
  });
}

async function collectTargets(client) {
  const effectiveLimit = Math.min(MAX_DOWNLOADS, DAILY_CAP);

  if (effectiveLimit <= 0) {
    return [];
  }

  const result = await client.query(
    `
      SELECT DISTINCT ON (a.product_id)
        a.product_id,
        a.thumbnail_url,
        '' AS source_wiki_url,
        COALESCE(t.attempt_count, 0) AS attempt_count
      FROM public.xxx_tm008_fc2_wiki_articles a
      LEFT JOIN public.xxx_tm009_fc2_wiki_thumbnail_assets t
        ON t.product_id = a.product_id
      WHERE COALESCE(a.thumbnail_url, '') <> ''
        AND COALESCE(t.thumbnail_status, '') NOT IN ('collected', 'failed', 'missing_url')
      ORDER BY
        a.product_id,
        CASE COALESCE(t.thumbnail_status, '')
          WHEN 'pending' THEN 0
          ELSE 2
        END,
        t.downloaded_at NULLS FIRST,
        t.last_checked_at NULLS FIRST,
        a.thumbnail_url
      LIMIT $1
    `,
    [effectiveLimit]
  );

  return result.rows;
}

async function countTodayCollected(client) {
  const result = await client.query(`
    SELECT COUNT(*)::integer AS count
    FROM public.xxx_tm009_fc2_wiki_thumbnail_assets
    WHERE thumbnail_status = 'collected'
      AND downloaded_at >= CURRENT_DATE
      AND downloaded_at < CURRENT_DATE + INTERVAL '1 day'
  `);
  return Number(result.rows[0]?.count || 0);
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
    [RUN_ID, MAX_DOWNLOADS, DAILY_CAP, MIN_DELAY_MS, MAX_DELAY_MS, MAX_ATTEMPTS, targetsFound, TARGET_SCOPE]
  );
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

async function countStatus(client) {
  const result = await client.query(`
    SELECT
      COUNT(*) FILTER (WHERE thumbnail_status = 'collected')::bigint AS collected,
      COUNT(*) FILTER (WHERE thumbnail_status = 'failed')::bigint AS failed,
      COUNT(*) FILTER (WHERE thumbnail_status = 'missing_url')::bigint AS missing_url,
      COUNT(*) FILTER (WHERE thumbnail_status = 'pending')::bigint AS pending,
      COUNT(*)::bigint AS total_rows
    FROM public.xxx_tm009_fc2_wiki_thumbnail_assets
  `);
  return result.rows[0];
}

async function countOwnedView(client) {
  const result = await client.query(`
    SELECT
      COUNT(*) FILTER (WHERE collect_status = 'collected')::bigint AS owned_collected,
      COUNT(*) FILTER (WHERE collect_status = 'failed')::bigint AS owned_failed,
      COUNT(*) FILTER (WHERE collect_status = 'pending')::bigint AS owned_pending,
      COUNT(*) FILTER (WHERE collect_status = 'missing_url')::bigint AS owned_missing_url,
      COUNT(*) FILTER (WHERE owned_without_thumbnail AND COALESCE(thumbnail_url, '') <> '')::bigint AS owned_remaining_with_url
    FROM public.xxx_vq029_owned_file_thumbnail_status
  `);
  return result.rows[0];
}

async function countWikiPool(client) {
  const result = await client.query(`
    SELECT
      COUNT(*)::bigint AS wiki_article_rows,
      COUNT(DISTINCT a.product_id)::bigint AS wiki_products,
      COUNT(DISTINCT a.product_id) FILTER (WHERE COALESCE(a.thumbnail_url, '') <> '')::bigint AS wiki_products_with_url,
      COUNT(DISTINCT a.product_id) FILTER (WHERE t.product_id IS NULL)::bigint AS wiki_untracked_products,
      COUNT(DISTINCT a.product_id) FILTER (
        WHERE COALESCE(a.thumbnail_url, '') <> ''
          AND COALESCE(t.thumbnail_status, '') NOT IN ('collected', 'failed', 'missing_url')
      )::bigint AS wiki_remaining_targets
    FROM public.xxx_tm008_fc2_wiki_articles a
    LEFT JOIN public.xxx_tm009_fc2_wiki_thumbnail_assets t
      ON t.product_id = a.product_id
  `);
  return result.rows[0];
}

async function main() {
  assertSafetyGate();
  ensureOutputDir();

  const client = new Client(DB_CONFIG);
  await client.connect();

  let successCount = 0;
  let failedCount = 0;
  let skippedCount = 0;
  let runLogCreated = false;
  let processedCount = 0;

  try {
    const beforeAssets = await countStatus(client);
    const beforeOwned = await countOwnedView(client);
    const beforeWiki = await countWikiPool(client);
    const todayCollected = await countTodayCollected(client);
    const targets = await collectTargets(client);
    await createRunLog(client, targets.length);
    runLogCreated = true;

    console.log("=".repeat(70));
    console.log("FC2 Wiki Thumbnail Collector");
    console.log(`target      : ${TARGET_SCOPE}`);
    console.log(`max         : ${MAX_DOWNLOADS}`);
    console.log(`dailyCap    : ${DAILY_CAP}`);
    console.log(`todayDone   : ${todayCollected}`);
    console.log(`delay       : ${MIN_DELAY_MS}-${MAX_DELAY_MS} ms`);
    console.log(`maxAttempts : ${MAX_ATTEMPTS}`);
    console.log(`retryFailed : NO`);
    console.log(`batchPause  : every ${BATCH_PAUSE_EVERY} items / ${Math.floor(BATCH_PAUSE_MS / 60000)} min`);
    console.log(`output      : ${OUTPUT_DIR}`);
    console.log(`targets     : ${targets.length}`);
    console.log(`before      : ${JSON.stringify({ beforeAssets, beforeOwned, beforeWiki })}`);
    console.log("=".repeat(70));

    for (const row of targets) {
      try {
        const productId = String(row.product_id || "").trim();
        const thumbnailUrl = String(row.thumbnail_url || "").trim();

        if (!/^\d{6,8}$/.test(productId)) {
          await markFailed(client, row, "failed", "Invalid product_id");
          failedCount += 1;
          console.log(`${productId || "(blank)"} failed invalid_product_id`);
          continue;
        }

        if (!isApprovedThumbnailUrl(thumbnailUrl)) {
          await markFailed(client, row, "missing_url", "Missing or unapproved thumbnail URL");
          failedCount += 1;
          console.log(`${productId} failed missing_or_unapproved_url`);
          continue;
        }

        const delay = randomDelayMs();
        await sleep(delay);

        const fileName = outputFileNameForProduct(productId, thumbnailUrl);
        const outputPath = path.join(OUTPUT_DIR, fileName);

        try {
          if (fs.existsSync(outputPath)) {
            const stat = fs.statSync(outputPath);
            if (!stat.isFile() || stat.size <= 0) {
              throw new Error(`Existing output is not a non-empty file: ${outputPath}`);
            }
            await markCollected(client, row, outputPath, fileName);
            await logRunItem(client, row, {
              status: "collected_existing",
              localThumbnailPath: outputPath,
              localThumbnailFileName: fileName,
              bytes: stat.size,
              sha256: "existing_file",
              delayMs: delay,
            });
            successCount += 1;
            skippedCount += 1;
            console.log(`${productId} collected existing_file bytes=${stat.size}`);
            continue;
          }

          const result = await downloadFile(thumbnailUrl, outputPath);
          await markCollected(client, row, outputPath, fileName);
          await logRunItem(client, row, {
            status: "collected",
            localThumbnailPath: outputPath,
            localThumbnailFileName: fileName,
            bytes: result.bytes,
            sha256: result.sha256,
            delayMs: delay,
          });
          successCount += 1;
          console.log(
            `${productId} collected bytes=${result.bytes} sha256=${result.sha256} delay=${delay}`
          );
        } catch (error) {
          await markFailed(client, row, "failed", error.message || error);
          await logRunItem(client, row, {
            status: "failed",
            delayMs: delay,
            errorMessage: error.message || error,
          });
          failedCount += 1;
          console.log(`${productId} failed ${error.message || error}`);
        }
      } finally {
        processedCount += 1;
        await pauseAfterBatchIfNeeded(processedCount, targets.length);
      }
    }

    const afterAssets = await countStatus(client);
    const afterOwned = await countOwnedView(client);
    const afterWiki = await countWikiPool(client);

    console.log("=".repeat(70));
    console.log("DONE");
    console.log(`run_success : ${successCount}`);
    console.log(`run_failed  : ${failedCount}`);
    console.log(`run_existing: ${skippedCount}`);
    console.log(`processed   : ${processedCount}`);
    console.log(`after       : ${JSON.stringify({ afterAssets, afterOwned, afterWiki })}`);
    console.log("=".repeat(70));
    await finishRunLog(client, "completed", successCount, failedCount, skippedCount);
  } catch (error) {
    if (runLogCreated) {
      await finishRunLog(client, "failed", successCount, failedCount, skippedCount, error.message || error);
    }
    throw error;
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error("Fatal error:", error.message || error);
  process.exitCode = 1;
});
