const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const http = require("http");
const https = require("https");
const crypto = require("crypto");
const { Client } = require("pg");
const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
require("dotenv").config({ quiet: true });

puppeteer.use(StealthPlugin());

const PROJECT_ROOT = path.resolve(__dirname, "..");
const OUTPUT_DIR = path.join(PROJECT_ROOT, "fc2_sum", "google_image_thumbnails");
const LOG_DIR = path.join(PROJECT_ROOT, "project_scripts", "google_image_thumbnail_logs");
const STATUS_DIR = path.join(LOG_DIR, "status");
const RUN_PREFIX = "google_image_thumb";
const RUN_ID = `${RUN_PREFIX}_${new Date().toISOString().replace(/[-:T.]/g, "").slice(0, 14)}_${process.pid}`;

const CSV_COLUMNS = [
  "run_id",
  "mode",
  "resolver",
  "product_id",
  "search_query",
  "search_url",
  "result_rank",
  "result_page_url",
  "candidate_image_url",
  "candidate_thumbnail_url",
  "candidate_image_source",
  "candidate_imgrefurl",
  "candidate_alt",
  "saved_local_thumbnail_path",
  "saved_local_thumbnail_file_name",
  "db_write_status",
  "status",
  "error_message",
  "delay_ms",
  "bytes",
  "sha256",
  "processed_at",
];

const CONFIG = {
  mode: "dry-run",
  confirmExecute: "",
  allowGoogleOverwrite: "",
  sourceCsv: "",
  targetKind: "owned-without-thumbnail",
  limit: 5,
  resolver: "browser",
  headless: true,
  minDelayMs: 2000,
  maxDelayMs: 5000,
  batchPauseEvery: 300,
  batchPauseMs: 3 * 60 * 1000,
  navigationTimeoutMs: 45000,
  requestTimeoutMs: 30000,
  maxImageBytes: 20 * 1024 * 1024,
  maxAttempts: 2,
  stopAfterConsecutiveFailures: 10,
  outputDir: OUTPUT_DIR,
  logDir: LOG_DIR,
  statusDir: STATUS_DIR,
  runId: RUN_ID,
};

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
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    const next = argv[i + 1];
    if (key === "--help" || key === "-h") args.help = true;
    else if (key === "--mode") args.mode = consumeValue(key, next, argv, ++i);
    else if (key === "--limit") args.limit = parseIntArg(consumeValue(key, next, argv, ++i), key);
    else if (key === "--resolver") args.resolver = consumeValue(key, next, argv, ++i);
    else if (key === "--confirm-execute") args.confirmExecute = consumeValue(key, next, argv, ++i);
    else if (key === "--allow-google-overwrite") args.allowGoogleOverwrite = consumeValue(key, next, argv, ++i);
    else if (key === "--source-csv") args.sourceCsv = consumeValue(key, next, argv, ++i);
    else if (key === "--target-kind") args.targetKind = consumeValue(key, next, argv, ++i);
    else if (key === "--run-id") args.runId = consumeValue(key, next, argv, ++i);
    else if (key === "--headful") args.headless = false;
    else if (key === "--headless") args.headless = true;
    else if (key === "--min-delay-ms") args.minDelayMs = parseIntArg(consumeValue(key, next, argv, ++i), key);
    else if (key === "--max-delay-ms") args.maxDelayMs = parseIntArg(consumeValue(key, next, argv, ++i), key);
    else if (key === "--batch-pause-every") args.batchPauseEvery = parseIntArg(consumeValue(key, next, argv, ++i), key);
    else if (key === "--batch-pause-ms") args.batchPauseMs = parseIntArg(consumeValue(key, next, argv, ++i), key);
    else throw new Error(`Unknown argument: ${key}`);
  }
  return args;
}

function buildConfig(args) {
  const mode = String(args.mode || CONFIG.mode).toLowerCase();
  if (!["dry-run", "execute", "promote-dry-run", "export-targets"].includes(mode)) {
    throw new Error(`Invalid mode: ${mode}`);
  }

  const limit = Number.isInteger(args.limit) ? args.limit : CONFIG.limit;
  if (limit < 1 || limit > 5000) throw new Error("limit must be between 1 and 5000");

  const config = {
    ...CONFIG,
    ...args,
    mode,
    limit,
    maxDelayMs: Math.max(args.maxDelayMs || CONFIG.maxDelayMs, args.minDelayMs || CONFIG.minDelayMs),
  };

  if (!["browser", "html", "csv", "fc2-article"].includes(config.resolver)) {
    throw new Error("resolver must be browser, html, csv, or fc2-article");
  }
  if (!["owned-without-thumbnail", "rapidgator-unowned"].includes(config.targetKind)) {
    throw new Error("target-kind must be owned-without-thumbnail or rapidgator-unowned");
  }

  if ((mode === "execute" || mode === "promote-dry-run") && config.confirmExecute !== "YES") {
    throw new Error(`${mode} mode requires --confirm-execute YES`);
  }
  if (mode === "promote-dry-run" && !config.sourceCsv) {
    throw new Error("promote-dry-run mode requires --source-csv");
  }
  if (config.resolver === "csv" && !config.sourceCsv) {
    throw new Error("csv resolver requires --source-csv");
  }

  return config;
}

function writeUsage() {
  process.stdout.write(
    [
      "Usage:",
      "  node project_scripts/google_image_thumbnail_collector.js --mode dry-run --limit 5",
      "  node project_scripts/google_image_thumbnail_collector.js --mode dry-run --resolver fc2-article --limit 5",
      "  node project_scripts/google_image_thumbnail_collector.js --mode execute --resolver fc2-article --limit 100 --confirm-execute YES",
      "  node project_scripts/google_image_thumbnail_collector.js --mode dry-run --limit 5 --resolver html",
      "  node project_scripts/google_image_thumbnail_collector.js --mode dry-run --resolver csv --source-csv <manual-candidates.csv> --limit 5",
      "  node project_scripts/google_image_thumbnail_collector.js --mode promote-dry-run --source-csv <csv> --confirm-execute YES",
      "  node project_scripts/google_image_thumbnail_collector.js --mode execute --limit 100 --confirm-execute YES",
      "  node project_scripts/google_image_thumbnail_collector.js --mode execute --resolver csv --source-csv <manual-candidates.csv> --limit 100 --confirm-execute YES",
      "  add --allow-google-overwrite YES only when intentionally replacing previous Google-derived rows",
      "  node project_scripts/google_image_thumbnail_collector.js --mode export-targets --limit 100",
      "",
    ].join("\n")
  );
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) return writeUsage();

  const config = buildConfig(args);
  ensureDirectory(config.outputDir);
  ensureDirectory(config.logDir);
  ensureDirectory(config.statusDir);

  if (config.mode === "promote-dry-run") {
    await promoteDryRun(config);
    return;
  }
  if (config.mode === "export-targets") {
    await exportTargets(config);
    return;
  }

  await collectGoogleThumbnails(config);
}

async function collectGoogleThumbnails(config) {
  const csvPath = path.join(config.logDir, `${config.runId}_${config.mode}.csv`);
  initCsv(csvPath);

  const summary = createSummary(config, csvPath);
  await writeStatus(config, summary);

  const client = new Client(DB_CONFIG);
  await client.connect();

  let browser = null;
  try {
    const targets = config.sourceCsv
      ? collectTargetsFromCandidateCsv(config.sourceCsv, config.limit)
      : await collectTargets(client, config.limit);
    summary.targets = targets.length;
    await writeStatus(config, summary);

    if (targets.length === 0) {
      summary.run_status = "completed";
      summary.last_message = "no targets";
      await writeStatus(config, summary);
      return;
    }

    if (config.mode === "execute") {
      await preflightDbWrite(client, targets.map((row) => row.product_id), config);
    }

    if (config.resolver === "browser") {
      browser = await puppeteer.launch({
        headless: config.headless,
        args: ["--no-sandbox", "--disable-setuid-sandbox"],
      });
    }

    for (const row of targets) {
      const delayMs = randomDelayMs(config);
      await sleep(delayMs);

      let csvRow = buildBaseCsvRow(config, row.product_id, delayMs);
      try {
        const candidate = await resolveCandidateWithRetry(browser, row.product_id, config, row);
        csvRow = { ...csvRow, ...candidateToCsv(candidate) };

        const download = await downloadBestCandidate(candidate, row.product_id, config);
        csvRow.saved_local_thumbnail_path = download.outputPath;
        csvRow.saved_local_thumbnail_file_name = download.fileName;
        csvRow.bytes = String(download.bytes);
        csvRow.sha256 = download.sha256;

        if (config.mode === "execute") {
          assertValidProductId(row.product_id);
          await assertWritableProduct(client, row.product_id, config);
          await markCollected(client, {
            productId: row.product_id,
            thumbnailUrl: download.sourceUrl,
            outputPath: download.outputPath,
            fileName: download.fileName,
            sourceWikiUrl: candidate.imgrefurl || candidate.resultPageUrl || candidate.searchUrl,
          });
          csvRow.db_write_status = await verifyCollectedPath(client, row.product_id, download.outputPath);
        } else {
          csvRow.db_write_status = "not_written_dry_run";
        }

        csvRow.status = download.existing ? "collected_existing" : "collected";
        summary.success += 1;
        summary.consecutive_failures = 0;
        if (candidate.imageSource === "imgres_imgurl") summary.imgres_imgurl += 1;
        if (candidate.imageSource === "google_thumbnail_url") summary.google_thumbnail_url += 1;
      } catch (error) {
        const errorMessage = formatError(error);
        const expectedMiss = isExpectedFc2ArticleMiss(config, errorMessage);
        csvRow.status = expectedMiss ? "not_found" : "failed";
        csvRow.error_message = errorMessage;
        csvRow.db_write_status = config.mode === "execute" ? "not_written_failed" : "not_written_dry_run";
        summary.failed += 1;
        summary.consecutive_failures = expectedMiss ? 0 : summary.consecutive_failures + 1;
        summary.latest_error = csvRow.error_message;
      }

      csvRow.processed_at = new Date().toISOString();
      appendCsv(csvPath, csvRow);
      summary.processed += 1;
      summary.last_product_id = row.product_id;
      summary.updated_at = new Date().toISOString();
      await writeStatus(config, summary);

      if (summary.consecutive_failures >= config.stopAfterConsecutiveFailures) {
        throw new Error(`stop_after_consecutive_failures_${summary.consecutive_failures}`);
      }

      await pauseAfterBatchIfNeeded(summary.processed, targets.length, config);
    }

    summary.run_status = "completed";
    summary.updated_at = new Date().toISOString();
    await writeStatus(config, summary);
  } catch (error) {
    summary.run_status = "failed";
    summary.latest_error = formatError(error);
    summary.updated_at = new Date().toISOString();
    await writeStatus(config, summary);
    throw error;
  } finally {
    if (browser) await browser.close().catch(() => {});
    await client.end().catch(() => {});
  }
}

async function collectTargets(client, limit) {
  const result = await client.query(
    `
      SELECT DISTINCT product_id
      FROM public.xxx_vq029_owned_file_thumbnail_status
      WHERE owned_without_thumbnail = true
        AND product_id ~ '^[0-9]{6,8}$'
      ORDER BY product_id DESC
      LIMIT $1
    `,
    [limit]
  );
  return result.rows.map((row) => ({ product_id: String(row.product_id || "").trim() })).filter((row) => row.product_id);
}

function collectTargetsFromCandidateCsv(sourceCsv, limit) {
  const rows = readCsv(path.resolve(sourceCsv));
  return rows
    .map((row) => ({
      ...row,
      product_id: String(row.product_id || row.productId || "").trim(),
    }))
    .filter((row) => /^[0-9]{6,8}$/.test(row.product_id))
    .slice(0, limit);
}

async function exportTargets(config) {
  const csvPath = path.join(config.logDir, `${config.runId}_targets.csv`);
  const client = new Client(DB_CONFIG);
  await client.connect();
  try {
    const targets = await collectTargets(client, config.limit);
    const columns = [
      "product_id",
      "search_query",
      "search_url",
      "imgres_url",
      "candidate_image_url",
      "candidate_thumbnail_url",
      "saved_html_path",
      "memo",
    ];
    fs.writeFileSync(csvPath, `${columns.join(",")}\n`, "utf8");
    for (const target of targets) {
      const searchQuery = `fc2 ${target.product_id}`;
      const searchUrl =
        config.resolver === "fc2-article"
          ? `https://adult.contents.fc2.com/article/${target.product_id}/`
          : `https://www.google.com/search?udm=2&q=${encodeURIComponent(searchQuery)}`;
      const row = {
        product_id: target.product_id,
        search_query: searchQuery,
        search_url: searchUrl,
        imgres_url: "",
        candidate_image_url: "",
        candidate_thumbnail_url: "",
        saved_html_path: "",
        memo: "",
      };
      fs.appendFileSync(csvPath, `${columns.map((column) => csvEscape(row[column] || "")).join(",")}\n`, "utf8");
    }
    const summary = createSummary(config, csvPath);
    summary.targets = targets.length;
    summary.processed = targets.length;
    summary.run_status = "completed";
    summary.last_message = "target csv exported";
    await writeStatus(config, summary);
    process.stdout.write(`exported targets: ${targets.length}\n${csvPath}\n`);
  } finally {
    await client.end().catch(() => {});
  }
}

async function resolveCandidateWithRetry(browser, productId, config, sourceRow = {}) {
  let lastError = null;
  for (let attempt = 1; attempt <= config.maxAttempts; attempt += 1) {
    try {
      return await resolveCandidate(browser, productId, config, sourceRow);
    } catch (error) {
      lastError = error;
      if (attempt < config.maxAttempts) await sleep(1500 * attempt);
    }
  }
  throw lastError || new Error("candidate_not_found");
}

async function resolveCandidate(browser, productId, config, sourceRow = {}) {
  if (config.resolver === "csv") {
    return resolveCandidateFromCsvRow(productId, sourceRow);
  }

  if (config.resolver === "fc2-article") {
    return resolveCandidateFromFc2Article(productId, config);
  }

  if (config.resolver === "html") {
    return resolveCandidateFromHtml(productId, config);
  }

  const query = `fc2 ${productId}`;
  const searchUrl = `https://www.google.com/search?udm=2&q=${encodeURIComponent(query)}`;
  const page = await browser.newPage();
  try {
    await page.setViewport({ width: 1366, height: 900, deviceScaleFactor: 1 });
    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
    );
    await page.goto(searchUrl, {
      waitUntil: "domcontentloaded",
      timeout: config.navigationTimeoutMs,
    });
    await sleep(1200);

    const title = await page.title().catch(() => "");
    const bodyText = await page.evaluate(() => document.body ? document.body.innerText.slice(0, 2000) : "");
    if (isBlockedGooglePage(title, bodyText)) {
      throw new Error("google_block_or_captcha_detected");
    }

    const candidate = await page.evaluate((targetProductId) => {
      function decodeMaybe(value) {
        try {
          return decodeURIComponent(value || "");
        } catch {
          return value || "";
        }
      }

      function absoluteHref(href) {
        try {
          return new URL(href, location.origin).href;
        } catch {
          return href || "";
        }
      }

      function readImgres(anchor) {
        const rawHref = anchor.getAttribute("href") || "";
        const absolute = absoluteHref(rawHref);
        let parsed = null;
        try {
          parsed = new URL(absolute);
        } catch {
          return null;
        }
        const imgurl = decodeMaybe(parsed.searchParams.get("imgurl") || "");
        const imgrefurl = decodeMaybe(parsed.searchParams.get("imgrefurl") || "");
        const container = anchor.closest("[data-docid], [jscontroller], div") || anchor;
        const img = anchor.querySelector("img") || container.querySelector("img");
        const alt = img ? (img.getAttribute("alt") || "") : "";
        const thumb = img ? (img.currentSrc || img.src || img.getAttribute("src") || "") : "";
        const lpage = container.getAttribute("data-lpage") || "";
        return {
          imgurl,
          imgrefurl,
          resultPageUrl: imgrefurl || lpage || "",
          googleThumbnailUrl: thumb,
          alt,
          href: absolute,
        };
      }

      const anchors = Array.from(document.querySelectorAll('a[href*="/imgres"], a[href*="imgurl="]'));
      const first = anchors.map(readImgres).find(Boolean);
      if (first && (first.imgurl || first.googleThumbnailUrl)) return first;

      const images = Array.from(document.querySelectorAll("img"));
      const fallback = images.find((img) => {
        const src = img.currentSrc || img.src || img.getAttribute("src") || "";
        return src.includes("encrypted-tbn") || src.startsWith("http");
      });
      if (!fallback) return null;
      return {
        imgurl: "",
        imgrefurl: "",
        resultPageUrl: "",
        googleThumbnailUrl: fallback.currentSrc || fallback.src || fallback.getAttribute("src") || "",
        alt: fallback.getAttribute("alt") || "",
        href: "",
      };
    }, productId);

    if (!candidate) throw new Error("candidate_not_found");
    const imageSource = candidate.imgurl ? "imgres_imgurl" : "google_thumbnail_url";
    const imageUrl = candidate.imgurl || candidate.googleThumbnailUrl || "";
    if (!imageUrl) throw new Error("candidate_image_url_missing");

    return {
      productId,
      searchQuery: query,
      searchUrl,
      rank: 1,
      resultPageUrl: candidate.resultPageUrl || "",
      imageUrl,
      thumbnailUrl: candidate.googleThumbnailUrl || "",
      imageSource,
      imgrefurl: candidate.imgrefurl || "",
      alt: candidate.alt || "",
    };
  } finally {
    await page.close().catch(() => {});
  }
}

async function resolveCandidateFromHtml(productId, config) {
  const query = `fc2 ${productId}`;
  const searchUrl = `https://www.google.com/search?udm=2&q=${encodeURIComponent(query)}`;
  const html = await requestText(searchUrl, config.navigationTimeoutMs);
  if (isBlockedGooglePage("", html.slice(0, 4000))) {
    throw new Error("google_block_or_captcha_detected");
  }

  const imgres = extractFirstImgresCandidate(html);
  const fallbackThumbnailUrl = extractFirstGoogleThumbnailUrl(html);
  if (!imgres && !fallbackThumbnailUrl) {
    throw new Error("candidate_not_found");
  }

  const imageUrl = imgres?.imgurl || fallbackThumbnailUrl || "";
  if (!imageUrl) throw new Error("candidate_image_url_missing");

  return {
    productId,
    searchQuery: query,
    searchUrl,
    rank: 1,
    resultPageUrl: imgres?.imgrefurl || "",
    imageUrl,
    thumbnailUrl: fallbackThumbnailUrl || "",
    imageSource: imgres?.imgurl ? "imgres_imgurl" : "google_thumbnail_url",
    imgrefurl: imgres?.imgrefurl || "",
    alt: imgres?.alt || "",
  };
}

async function resolveCandidateFromFc2Article(productId, config) {
  assertValidProductId(productId);
  const articleUrl = `https://adult.contents.fc2.com/article/${productId}/`;
  const html = await requestText(articleUrl, config.navigationTimeoutMs);
  if (isFc2ArticleNotFound(productId, html)) {
    throw new Error("fc2_article_not_found");
  }

  const candidate = extractFc2ArticleImageCandidate(productId, html);
  if (!candidate?.imageUrl) {
    throw new Error("fc2_article_candidate_not_found");
  }

  return {
    productId,
    searchQuery: `fc2 ${productId}`,
    searchUrl: articleUrl,
    rank: 1,
    resultPageUrl: articleUrl,
    imageUrl: candidate.imageUrl,
    thumbnailUrl: candidate.thumbnailUrl || candidate.imageUrl,
    imageSource: candidate.imageSource,
    imgrefurl: articleUrl,
    alt: candidate.alt || "",
  };
}

function isFc2ArticleNotFound(productId, html) {
  const text = String(html || "");
  if (text.includes("items_notfound")) return true;
  if (text.includes("/contents_source/js/u/notfound/")) return true;
  const productMarkers = [
    `article:${productId}`,
    `"productID":"${productId}"`,
    `"sku":"${productId}"`,
    `data-id="${productId}"`,
    `/embed/${productId}/`,
    `/embed/${productId}?`,
    `FC2-PPV-${productId}`,
  ];
  return !productMarkers.some((marker) => text.includes(marker));
}

function extractFc2ArticleImageCandidate(productId, html) {
  const candidates = [
    {
      imageUrl: extractMetaContent(html, "name", "twitter:image"),
      imageSource: "fc2_article_twitter_image",
    },
    {
      imageUrl: extractMainItemThumb(html),
      imageSource: "fc2_article_main_thumb",
    },
    {
      imageUrl: extractMetaContent(html, "property", "og:image"),
      imageSource: "fc2_article_og_image",
    },
    {
      imageUrl: extractJsonLdImageUrl(html),
      imageSource: "fc2_article_jsonld_image",
    },
  ];

  const normalized = candidates
    .map((candidate) => ({
      ...candidate,
      imageUrl: normalizeCandidateUrl(candidate.imageUrl),
    }))
    .filter((candidate) => candidate.imageUrl);

  const chosen =
    normalized.find((candidate) => candidate.imageUrl.includes("contents-thumbnail2.fc2.com")) ||
    normalized[0];
  if (!chosen) return null;

  return {
    ...chosen,
    thumbnailUrl:
      normalizeCandidateUrl(extractMetaContent(html, "name", "twitter:image")) ||
      chosen.imageUrl,
    alt:
      extractMetaContent(html, "name", "twitter:title") ||
      extractMetaContent(html, "property", "og:title") ||
      `FC2-PPV-${productId}`,
  };
}

function extractMetaContent(html, attrName, attrValue) {
  const tags = String(html || "").match(/<meta\b[^>]*>/gi) || [];
  const attrPattern = new RegExp(`\\s${attrName}=(["'])${escapeRegExp(attrValue)}\\1`, "i");
  for (const tag of tags) {
    if (!attrPattern.test(tag)) continue;
    const contentMatch = tag.match(/\scontent=(["'])(.*?)\1/i);
    if (contentMatch) return decodeHtml(contentMatch[2]);
  }
  return "";
}

function extractMainItemThumb(html) {
  const match = String(html || "").match(/items_article_MainitemThumb[\s\S]{0,1000}?<img\b[^>]*\ssrc=(["'])(.*?)\1/i);
  return match ? decodeHtml(match[2]) : "";
}

function extractJsonLdImageUrl(html) {
  const decoded = decodeHtml(String(html || ""));
  const objectMatch = decoded.match(/"image"\s*:\s*\{\s*"url"\s*:\s*"([^"]+)"/i);
  if (objectMatch) return objectMatch[1].replace(/\\\//g, "/");
  const stringMatch = decoded.match(/"image"\s*:\s*"([^"]+)"/i);
  return stringMatch ? stringMatch[1].replace(/\\\//g, "/") : "";
}

function normalizeCandidateUrl(value) {
  const raw = decodeHtml(String(value || "").trim()).replace(/\\\//g, "/");
  if (!raw) return "";
  if (raw.startsWith("//")) return `https:${raw}`;
  return raw;
}

function resolveCandidateFromCsvRow(productId, row) {
  const searchQuery = String(row.search_query || `fc2 ${productId}`).trim();
  const searchUrl = String(row.search_url || `https://www.google.com/search?udm=2&q=${encodeURIComponent(searchQuery)}`).trim();
  const htmlPath = String(row.saved_html_path || row.html_path || "").trim();
  const imgresUrl = String(row.imgres_url || row.result_imgres_url || "").trim();
  const directImageUrl = String(row.candidate_image_url || row.image_url || row.imgurl || "").trim();
  const thumbnailUrl = String(row.candidate_thumbnail_url || row.thumbnail_url || "").trim();
  const imgrefurl = String(row.candidate_imgrefurl || row.imgrefurl || row.result_page_url || "").trim();
  const alt = String(row.candidate_alt || row.alt || "").trim();

  if (directImageUrl) {
    if (directImageUrl.includes("imgurl=")) {
      const parsed = parseImgresUrl(directImageUrl);
      const imageUrl = parsed.imgurl || thumbnailUrl;
      if (!imageUrl) throw new Error("manual_candidate_imgres_without_imgurl_or_thumbnail");
      return {
        productId,
        searchQuery,
        searchUrl,
        rank: 1,
        resultPageUrl: parsed.imgrefurl || imgrefurl,
        imageUrl,
        thumbnailUrl,
        imageSource: parsed.imgurl ? "imgres_imgurl" : "google_thumbnail_url",
        imgrefurl: parsed.imgrefurl || imgrefurl,
        alt,
      };
    }

    return {
      productId,
      searchQuery,
      searchUrl,
      rank: 1,
      resultPageUrl: imgrefurl,
      imageUrl: directImageUrl,
      thumbnailUrl,
      imageSource: classifyCandidateSource(directImageUrl, "manual_candidate_image_url"),
      imgrefurl,
      alt,
    };
  }

  if (imgresUrl) {
    const parsed = parseImgresUrl(imgresUrl);
    const imageUrl = parsed.imgurl || thumbnailUrl;
    if (!imageUrl) throw new Error("manual_imgres_without_imgurl_or_thumbnail");
    return {
      productId,
      searchQuery,
      searchUrl,
      rank: 1,
      resultPageUrl: parsed.imgrefurl || imgrefurl,
      imageUrl,
      thumbnailUrl,
      imageSource: parsed.imgurl ? "imgres_imgurl" : "google_thumbnail_url",
      imgrefurl: parsed.imgrefurl || imgrefurl,
      alt,
    };
  }

  if (htmlPath) {
    const absoluteHtmlPath = path.resolve(htmlPath);
    if (!fs.existsSync(absoluteHtmlPath)) throw new Error(`manual_html_missing:${absoluteHtmlPath}`);
    const html = fs.readFileSync(absoluteHtmlPath, "utf8");
    const imgres = extractFirstImgresCandidate(html);
    const fallbackThumbnailUrl = thumbnailUrl || extractFirstGoogleThumbnailUrl(html);
    const imageUrl = imgres?.imgurl || fallbackThumbnailUrl || "";
    if (!imageUrl) throw new Error("manual_html_candidate_not_found");
    return {
      productId,
      searchQuery,
      searchUrl,
      rank: 1,
      resultPageUrl: imgres?.imgrefurl || imgrefurl,
      imageUrl,
      thumbnailUrl: fallbackThumbnailUrl || "",
      imageSource: imgres?.imgurl ? "imgres_imgurl" : "google_thumbnail_url",
      imgrefurl: imgres?.imgrefurl || imgrefurl,
      alt: imgres?.alt || alt,
    };
  }

  throw new Error("manual_candidate_url_missing");
}

function parseImgresUrl(imgresUrl) {
  const absolute = imgresUrl.startsWith("http") ? imgresUrl : `https://www.google.com${imgresUrl}`;
  try {
    const parsed = new URL(decodeHtml(absolute));
    return {
      imgurl: parsed.searchParams.get("imgurl") || "",
      imgrefurl: parsed.searchParams.get("imgrefurl") || "",
    };
  } catch {
    return {
      imgurl: extractQueryParam(decodeHtml(imgresUrl), "imgurl"),
      imgrefurl: extractQueryParam(decodeHtml(imgresUrl), "imgrefurl"),
    };
  }
}

function classifyCandidateSource(url, fallback) {
  if (String(url || "").includes("encrypted-tbn")) return "google_thumbnail_url";
  if (String(url || "").includes("imgurl=")) return "imgres_imgurl";
  return fallback;
}

function extractFirstImgresCandidate(html) {
  const text = String(html || "");
  const hrefMatches = text.match(/href=(["'])(.*?)\1/gi) || [];
  for (const raw of hrefMatches) {
    const valueMatch = raw.match(/href=(["'])(.*?)\1/i);
    if (!valueMatch) continue;
    const href = decodeHtml(valueMatch[2]);
    if (!href.includes("imgurl=")) continue;
    const absolute = href.startsWith("http") ? href : `https://www.google.com${href}`;
    try {
      const parsed = new URL(absolute);
      const imgurl = parsed.searchParams.get("imgurl") || "";
      const imgrefurl = parsed.searchParams.get("imgrefurl") || "";
      if (imgurl) {
        return {
          imgurl,
          imgrefurl,
          alt: extractNearbyAlt(text, valueMatch.index || 0),
        };
      }
    } catch {
      const imgurl = extractQueryParam(href, "imgurl");
      if (imgurl) {
        return {
          imgurl,
          imgrefurl: extractQueryParam(href, "imgrefurl"),
          alt: extractNearbyAlt(text, valueMatch.index || 0),
        };
      }
    }
  }
  return null;
}

function extractFirstGoogleThumbnailUrl(html) {
  const decoded = decodeHtml(String(html || ""));
  const match = decoded.match(/https:\/\/encrypted-tbn[0-9]\.gstatic\.com\/images\?[^"'<>\\\s]+/i);
  return match ? match[0] : "";
}

function extractQueryParam(value, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = String(value || "").match(new RegExp(`[?&]${escaped}=([^&]+)`, "i"));
  if (!match) return "";
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return match[1] || "";
  }
}

function extractNearbyAlt(html, index) {
  const start = Math.max(0, index - 1000);
  const end = Math.min(html.length, index + 2000);
  const windowHtml = decodeHtml(html.slice(start, end));
  const match = windowHtml.match(/\salt=(["'])(.*?)\1/i);
  return match ? match[2] : "";
}

function escapeRegExp(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function decodeHtml(value) {
  return String(value || "")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#039;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function isBlockedGooglePage(title, bodyText) {
  const text = `${title}\n${bodyText}`.toLowerCase();
  return (
    text.includes("unusual traffic") ||
    text.includes("not a robot") ||
    text.includes("captcha") ||
    text.includes("our systems have detected")
  );
}

async function downloadBestCandidate(candidate, productId, config) {
  const candidates = [];
  if (candidate.imageUrl) candidates.push({ url: candidate.imageUrl, source: candidate.imageSource });
  if (
    candidate.thumbnailUrl &&
    candidate.thumbnailUrl !== candidate.imageUrl
  ) {
    candidates.push({ url: candidate.thumbnailUrl, source: "google_thumbnail_url" });
  }

  let lastError = null;
  for (const item of candidates) {
    try {
      return await downloadCandidateUrl(item.url, productId, item.source, config);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error("download_candidate_failed");
}

async function downloadCandidateUrl(url, productId, sourceName, config) {
  const ext = extensionFromUrl(url);
  const fileName = sanitizeFileName(`${productId}_google_${sourceName}${ext}`);
  const outputPath = path.join(config.outputDir, fileName);

  if (fs.existsSync(outputPath)) {
    const stat = fs.statSync(outputPath);
    if (!stat.isFile() || stat.size <= 0) throw new Error(`existing_output_invalid:${outputPath}`);
    return {
      outputPath,
      fileName,
      bytes: stat.size,
      sha256: "existing_file",
      sourceUrl: url,
      existing: true,
    };
  }

  const result = await requestBinary(url, config.requestTimeoutMs, 0, config.maxImageBytes);
  if (!String(result.contentType || "").startsWith("image/")) {
    throw new Error(`unexpected_content_type:${result.contentType}`);
  }
  if (!result.buffer || result.buffer.length <= 0) {
    throw new Error("empty_image_buffer");
  }

  const tempPath = `${outputPath}.download-${process.pid}-${Date.now()}.tmp`;
  try {
    await fsp.writeFile(tempPath, result.buffer, { flag: "wx" });
    if (fs.existsSync(outputPath)) {
      const stat = fs.statSync(outputPath);
      if (!stat.isFile() || stat.size <= 0) throw new Error(`existing_output_invalid:${outputPath}`);
      await fsp.unlink(tempPath).catch(() => {});
      return {
        outputPath,
        fileName,
        bytes: stat.size,
        sha256: "existing_file",
        sourceUrl: url,
        existing: true,
      };
    }
    fs.renameSync(tempPath, outputPath);
    return {
      outputPath,
      fileName,
      bytes: result.buffer.length,
      sha256: crypto.createHash("sha256").update(result.buffer).digest("hex"),
      sourceUrl: url,
      existing: false,
    };
  } catch (error) {
    await fsp.unlink(tempPath).catch(() => {});
    throw error;
  }
}

function requestBinary(url, timeoutMs, redirectCount = 0, maxBytes = CONFIG.maxImageBytes) {
  if (redirectCount > 5) return Promise.reject(new Error("too_many_redirects"));
  return new Promise((resolve, reject) => {
    let parsed;
    try {
      parsed = new URL(url);
      assertSafeOutboundUrl(parsed);
    } catch {
      reject(new Error(`invalid_url:${url}`));
      return;
    }
    const mod = parsed.protocol === "http:" ? http : https;
    const req = mod.get(
      parsed,
      {
        timeout: timeoutMs,
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) thumbnail-check/1.0",
          Accept: "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
        },
      },
      (res) => {
        const status = res.statusCode || 0;
        if ([301, 302, 303, 307, 308].includes(status) && res.headers.location) {
          res.resume();
          const nextUrl = new URL(res.headers.location, parsed).href;
          requestBinary(nextUrl, timeoutMs, redirectCount + 1, maxBytes).then(resolve, reject);
          return;
        }
        if (status < 200 || status >= 300) {
          res.resume();
          reject(new Error(`http_status_${status}`));
          return;
        }
        const contentLength = Number(res.headers["content-length"] || 0);
        if (contentLength > maxBytes) {
          res.resume();
          reject(new Error(`image_too_large:${contentLength}`));
          return;
        }
        const chunks = [];
        let received = 0;
        res.on("data", (chunk) => {
          received += chunk.length;
          if (received > maxBytes) {
            req.destroy(new Error(`image_too_large:${received}`));
            return;
          }
          chunks.push(Buffer.from(chunk));
        });
        res.on("end", () => {
          resolve({
            buffer: Buffer.concat(chunks),
            contentType: res.headers["content-type"] || "",
          });
        });
      }
    );
    req.on("timeout", () => req.destroy(new Error("request_timeout")));
    req.on("error", reject);
  });
}

function requestText(url, timeoutMs, redirectCount = 0) {
  if (redirectCount > 5) return Promise.reject(new Error("too_many_redirects"));
  return new Promise((resolve, reject) => {
    let parsed;
    try {
      parsed = new URL(url);
      assertSafeOutboundUrl(parsed);
    } catch {
      reject(new Error(`invalid_url:${url}`));
      return;
    }
    const mod = parsed.protocol === "http:" ? http : https;
    const req = mod.get(
      parsed,
      {
        timeout: timeoutMs,
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
          Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Accept-Language": "ja,en-US;q=0.9,en;q=0.8",
        },
      },
      (res) => {
        const status = res.statusCode || 0;
        if ([301, 302, 303, 307, 308].includes(status) && res.headers.location) {
          res.resume();
          const nextUrl = new URL(res.headers.location, parsed).href;
          requestText(nextUrl, timeoutMs, redirectCount + 1).then(resolve, reject);
          return;
        }
        if (status < 200 || status >= 300) {
          res.resume();
          reject(new Error(`http_status_${status}`));
          return;
        }
        const chunks = [];
        let received = 0;
        res.on("data", (chunk) => {
          received += chunk.length;
          if (received > 5 * 1024 * 1024) {
            req.destroy(new Error(`html_too_large:${received}`));
            return;
          }
          chunks.push(Buffer.from(chunk));
        });
        res.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      }
    );
    req.on("timeout", () => req.destroy(new Error("request_timeout")));
    req.on("error", reject);
  });
}

function assertSafeOutboundUrl(parsedUrl) {
  if (!["http:", "https:"].includes(parsedUrl.protocol)) {
    throw new Error(`unsafe_url_protocol:${parsedUrl.protocol}`);
  }
  const hostname = parsedUrl.hostname.toLowerCase();
  if (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname === "0.0.0.0" ||
    hostname === "::1" ||
    hostname.startsWith("127.") ||
    hostname.startsWith("10.") ||
    hostname.startsWith("192.168.") ||
    isPrivate172Host(hostname) ||
    hostname.startsWith("169.254.") ||
    hostname === "metadata.google.internal"
  ) {
    throw new Error(`unsafe_url_host:${hostname}`);
  }
}

function isPrivate172Host(hostname) {
  const match = hostname.match(/^172\.(\d{1,3})\./);
  if (!match) return false;
  const second = Number(match[1]);
  return second >= 16 && second <= 31;
}

async function promoteDryRun(config) {
  const csvPath = path.resolve(config.sourceCsv);
  const rows = readCsv(csvPath).filter((row) => row.status === "collected" || row.status === "collected_existing");
  if (rows.length === 0) throw new Error("no collected dry-run rows found");

  const summary = createSummary(config, csvPath);
  summary.targets = rows.length;
  await writeStatus(config, summary);

  const client = new Client(DB_CONFIG);
  await client.connect();
  try {
    await preflightDbWrite(client, rows.map((row) => String(row.product_id || "").trim()), config);

    for (const row of rows) {
      const productId = String(row.product_id || "").trim();
      const outputPath = String(row.saved_local_thumbnail_path || "").trim();
      const fileName = String(row.saved_local_thumbnail_file_name || "").trim();
      const thumbnailUrl = String(row.candidate_image_url || "").trim();
      assertValidProductId(productId);
      if (!outputPath || !fs.existsSync(outputPath)) throw new Error(`missing_saved_file:${productId}`);
      if (!isWithinDirectory(config.outputDir, outputPath)) {
        throw new Error(`saved_file_outside_output_dir:${productId}`);
      }
      await assertWritableProduct(client, productId, config);
      await markCollected(client, {
        productId,
        thumbnailUrl,
        outputPath,
        fileName,
        sourceWikiUrl: row.candidate_imgrefurl || row.result_page_url || row.search_url || "",
      });
      const dbWriteStatus = await verifyCollectedPath(client, productId, outputPath);
      if (dbWriteStatus !== "collected") {
        throw new Error(`promote_verify_failed:${productId}:${dbWriteStatus}`);
      }
      summary.processed += 1;
      summary.success += 1;
      summary.updated_at = new Date().toISOString();
      await writeStatus(config, summary);
    }
    summary.run_status = "completed";
    await writeStatus(config, summary);
  } finally {
    await client.end().catch(() => {});
  }
}

async function markCollected(client, row) {
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
        attempt_count = COALESCE(public.xxx_tm009_fc2_wiki_thumbnail_assets.attempt_count, 0) + 1,
        last_error = NULL,
        updated_at = now()
      WHERE NOT (
        public.xxx_tm009_fc2_wiki_thumbnail_assets.thumbnail_status = 'collected'
        AND COALESCE(public.xxx_tm009_fc2_wiki_thumbnail_assets.local_thumbnail_path, '') <> ''
        AND COALESCE(public.xxx_tm009_fc2_wiki_thumbnail_assets.local_thumbnail_path, '') NOT LIKE '%google_image_thumbnails%'
      )
    `,
    [row.productId, row.thumbnailUrl, row.outputPath, row.fileName, row.sourceWikiUrl || ""]
  );
}

async function preflightDbWrite(client, productIds, config) {
  const normalizedProductIds = productIds.map((value) => String(value || "").trim());
  const invalidProductIds = normalizedProductIds.filter((value) => !isValidProductId(value));
  if (invalidProductIds.length > 0) {
    throw new Error(`preflight_invalid_product_ids:${invalidProductIds.join("|")}`);
  }
  const uniqueProductIds = Array.from(new Set(normalizedProductIds));
  if (uniqueProductIds.length === 0) throw new Error("preflight_no_valid_product_ids");

  const result = await client.query(
    `
      WITH targets AS (
        SELECT DISTINCT product_id
        FROM unnest($1::text[]) AS p(product_id)
      ),
      owned_status AS (
        SELECT
          product_id,
          bool_or(owned_without_thumbnail = true) AS owned_without_thumbnail
        FROM public.xxx_vq029_owned_file_thumbnail_status
        WHERE product_id = ANY($1::text[])
        GROUP BY product_id
      ),
      rapidgator_status AS (
        SELECT
          b.fc2_product_id AS product_id,
          bool_or(o.product_id IS NOT NULL) AS is_owned,
          bool_or(
            b.has_rapidgator = true
            OR COALESCE(b.best_mp4_url::text, '') <> ''
            OR COALESCE(b.best_page_url::text, '') <> ''
          ) AS rapidgator_unowned_downloadable
        FROM public.xxx_vq025_rapidgator_best_links b
        LEFT JOIN public.xxx_vq002_owned_product_ids o
          ON o.product_id::text = b.fc2_product_id::text
        WHERE b.fc2_product_id = ANY($1::text[])
        GROUP BY b.fc2_product_id
      )
      SELECT
        t.product_id,
        COALESCE(os.owned_without_thumbnail, false) AS owned_without_thumbnail,
        COALESCE(rs.is_owned, false) AS is_owned,
        COALESCE(rs.rapidgator_unowned_downloadable, false) AS rapidgator_unowned_downloadable,
        CASE
          WHEN a.thumbnail_status = 'collected' OR COALESCE(a.local_thumbnail_path, '') <> '' THEN true
          ELSE false
        END AS has_existing_thumbnail,
        a.thumbnail_status AS current_thumbnail_status,
        a.local_thumbnail_path AS current_local_thumbnail_path,
        CASE
          WHEN COALESCE(a.local_thumbnail_path, '') LIKE '%google_image_thumbnails%' THEN true
          ELSE false
        END AS current_is_google_thumbnail,
        CASE
          WHEN a.product_id IS NULL THEN 'insert'
          WHEN COALESCE(a.local_thumbnail_path, '') LIKE '%google_image_thumbnails%' THEN 'update_existing_google'
          WHEN a.thumbnail_status = 'collected' AND COALESCE(a.local_thumbnail_path, '') <> '' THEN 'preserve_existing_non_google'
          ELSE 'update_uncollected'
        END AS planned_action
      FROM targets t
      LEFT JOIN owned_status os
        ON os.product_id = t.product_id
      LEFT JOIN rapidgator_status rs
        ON rs.product_id = t.product_id
      LEFT JOIN public.xxx_tm009_fc2_wiki_thumbnail_assets a
        ON a.product_id = t.product_id
      ORDER BY t.product_id
    `,
    [uniqueProductIds]
  );

  const columns = [
    "product_id",
    "owned_without_thumbnail",
    "is_owned",
    "rapidgator_unowned_downloadable",
    "has_existing_thumbnail",
    "current_thumbnail_status",
    "current_local_thumbnail_path",
    "current_is_google_thumbnail",
    "planned_action",
  ];
  const preflightPath = path.join(config.logDir, `${config.runId}_${config.mode}_db_preflight.csv`);
  fs.writeFileSync(preflightPath, `${columns.join(",")}\n`, "utf8");
  for (const row of result.rows) {
    fs.appendFileSync(preflightPath, `${columns.map((column) => csvEscape(row[column] || "")).join(",")}\n`, "utf8");
  }

  const notWritable = result.rows.filter((row) => !isWritableTargetRow(row, config));
  if (notWritable.length > 0) {
    throw new Error(`preflight_not_writable_for_${config.targetKind}:${notWritable.map((row) => row.product_id).join("|")}`);
  }

  const googleOverwrites = result.rows.filter((row) => row.planned_action === "update_existing_google");
  if (googleOverwrites.length > 0 && config.allowGoogleOverwrite !== "YES") {
    throw new Error(
      `preflight_existing_google_thumbnail_requires_allow:${googleOverwrites
        .map((row) => row.product_id)
        .join("|")}`
    );
  }

  process.stdout.write(`db preflight ok: ${result.rowCount} rows\n${preflightPath}\n`);
}

async function assertWritableProduct(client, productId, config) {
  const result = await client.query(
    `
      WITH target AS (
        SELECT $1::text AS product_id
      ),
      owned_status AS (
        SELECT
          product_id,
          bool_or(owned_without_thumbnail = true) AS owned_without_thumbnail
        FROM public.xxx_vq029_owned_file_thumbnail_status
        WHERE product_id = $1
        GROUP BY product_id
      ),
      rapidgator_status AS (
        SELECT
          b.fc2_product_id AS product_id,
          bool_or(o.product_id IS NOT NULL) AS is_owned,
          bool_or(
            b.has_rapidgator = true
            OR COALESCE(b.best_mp4_url::text, '') <> ''
            OR COALESCE(b.best_page_url::text, '') <> ''
          ) AS rapidgator_unowned_downloadable
        FROM public.xxx_vq025_rapidgator_best_links b
        LEFT JOIN public.xxx_vq002_owned_product_ids o
          ON o.product_id::text = b.fc2_product_id::text
        WHERE b.fc2_product_id = $1
        GROUP BY b.fc2_product_id
      )
      SELECT
        COALESCE(os.owned_without_thumbnail, false) AS owned_without_thumbnail,
        COALESCE(rs.is_owned, false) AS is_owned,
        COALESCE(rs.rapidgator_unowned_downloadable, false) AS rapidgator_unowned_downloadable,
        CASE
          WHEN a.thumbnail_status = 'collected' OR COALESCE(a.local_thumbnail_path, '') <> '' THEN true
          ELSE false
        END AS has_existing_thumbnail
      FROM target t
      LEFT JOIN owned_status os
        ON os.product_id = t.product_id
      LEFT JOIN rapidgator_status rs
        ON rs.product_id = t.product_id
      LEFT JOIN public.xxx_tm009_fc2_wiki_thumbnail_assets a
        ON a.product_id = t.product_id
      LIMIT 1
    `,
    [productId]
  );
  if (result.rowCount !== 1 || !isWritableTargetRow(result.rows[0], config)) {
    throw new Error(`product_not_writable_for_${config.targetKind}:${productId}`);
  }
}

function isWritableTargetRow(row, config) {
  if (config.targetKind === "rapidgator-unowned") {
    return row.is_owned !== true && row.rapidgator_unowned_downloadable === true && row.has_existing_thumbnail !== true;
  }
  return row.owned_without_thumbnail === true;
}

function assertValidProductId(productId) {
  if (!isValidProductId(productId)) {
    throw new Error(`invalid_product_id:${productId}`);
  }
}

function isValidProductId(productId) {
  return /^[0-9]{6,8}$/.test(String(productId || "").trim());
}

async function verifyCollectedPath(client, productId, expectedPath) {
  const result = await client.query(
    `
      SELECT thumbnail_status, local_thumbnail_path
      FROM public.xxx_tm009_fc2_wiki_thumbnail_assets
      WHERE product_id = $1
      LIMIT 1
    `,
    [productId]
  );
  const row = result.rows[0];
  if (!row) return "not_inserted";
  if (row.thumbnail_status !== "collected") return `unexpected_status:${row.thumbnail_status || ""}`;
  if (String(row.local_thumbnail_path || "") !== String(expectedPath || "")) {
    return "preserved_existing_or_path_mismatch";
  }
  return "collected";
}

function buildBaseCsvRow(config, productId, delayMs) {
  const searchQuery = `fc2 ${productId}`;
  const searchUrl =
    config.resolver === "fc2-article"
      ? `https://adult.contents.fc2.com/article/${productId}/`
      : `https://www.google.com/search?udm=2&q=${encodeURIComponent(searchQuery)}`;
  return {
    run_id: config.runId,
    mode: config.mode,
    resolver: config.resolver,
    product_id: productId,
    search_query: searchQuery,
    search_url: searchUrl,
    result_rank: "1",
    result_page_url: "",
    candidate_image_url: "",
    candidate_thumbnail_url: "",
    candidate_image_source: "",
    candidate_imgrefurl: "",
    candidate_alt: "",
    saved_local_thumbnail_path: "",
    saved_local_thumbnail_file_name: "",
    db_write_status: "",
    status: "",
    error_message: "",
    delay_ms: String(delayMs),
    bytes: "",
    sha256: "",
    processed_at: "",
  };
}

function candidateToCsv(candidate) {
  return {
    search_query: candidate.searchQuery,
    search_url: candidate.searchUrl,
    result_rank: String(candidate.rank),
    result_page_url: candidate.resultPageUrl,
    candidate_image_url: candidate.imageUrl,
    candidate_thumbnail_url: candidate.thumbnailUrl,
    candidate_image_source: candidate.imageSource,
    candidate_imgrefurl: candidate.imgrefurl,
    candidate_alt: candidate.alt,
  };
}

function createSummary(config, csvPath) {
  return {
    run_id: config.runId,
    mode: config.mode,
    resolver: config.resolver,
    run_status: "running",
    csv_path: csvPath,
    targets: 0,
    processed: 0,
    success: 0,
    failed: 0,
    consecutive_failures: 0,
    imgres_imgurl: 0,
    google_thumbnail_url: 0,
    last_product_id: "",
    latest_error: "",
    last_message: "",
    started_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
}

async function writeStatus(config, summary) {
  const statusPath = path.join(config.statusDir, `${config.runId}.json`);
  await fsp.writeFile(statusPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  await fsp.writeFile(path.join(config.statusDir, "latest.json"), `${JSON.stringify(summary, null, 2)}\n`, "utf8");
}

function initCsv(csvPath) {
  if (!fs.existsSync(csvPath)) {
    fs.writeFileSync(csvPath, `${CSV_COLUMNS.join(",")}\n`, "utf8");
  }
}

function appendCsv(csvPath, row) {
  const line = CSV_COLUMNS.map((column) => csvEscape(row[column] || "")).join(",");
  fs.appendFileSync(csvPath, `${line}\n`, "utf8");
}

function readCsv(csvPath) {
  const text = fs.readFileSync(csvPath, "utf8");
  const lines = text.split(/\r?\n/).filter(Boolean);
  if (lines.length <= 1) return [];
  const headers = parseCsvLine(lines[0]);
  return lines.slice(1).map((line) => {
    const values = parseCsvLine(line);
    const row = {};
    headers.forEach((header, index) => {
      row[header] = values[index] || "";
    });
    return row;
  });
}

function parseCsvLine(line) {
  const out = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '"' && inQuotes && line[i + 1] === '"') {
      current += '"';
      i += 1;
    } else if (ch === '"') {
      inQuotes = !inQuotes;
    } else if (ch === "," && !inQuotes) {
      out.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  out.push(current);
  return out;
}

function csvEscape(value) {
  const text = String(value == null ? "" : value);
  return `"${text.replace(/"/g, '""')}"`;
}

async function pauseAfterBatchIfNeeded(processedCount, totalTargets, config) {
  if (processedCount <= 0) return;
  if (processedCount >= totalTargets) return;
  if (config.batchPauseEvery <= 0) return;
  if (processedCount % config.batchPauseEvery !== 0) return;
  await sleep(config.batchPauseMs);
}

function randomDelayMs(config) {
  return config.minDelayMs + Math.floor(Math.random() * (config.maxDelayMs - config.minDelayMs + 1));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function extensionFromUrl(url) {
  try {
    const ext = path.extname(new URL(url).pathname).toLowerCase();
    if ([".jpg", ".jpeg", ".png", ".webp", ".gif"].includes(ext)) {
      return ext === ".jpeg" ? ".jpg" : ext;
    }
  } catch {
    // fall through
  }
  return ".jpg";
}

function sanitizeFileName(name) {
  return String(name).replace(/[\\/:*?"<>|]/g, "_");
}

function ensureDirectory(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function isWithinDirectory(baseDir, candidatePath) {
  const resolvedBase = path.resolve(baseDir);
  const resolvedCandidate = path.resolve(candidatePath);
  const relative = path.relative(resolvedBase, resolvedCandidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function consumeValue(name, value) {
  if (!value || value.startsWith("--")) throw new Error(`Missing value for ${name}`);
  return value;
}

function parseIntArg(value, name) {
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed)) throw new Error(`Invalid integer for ${name}: ${value}`);
  return parsed;
}

function formatError(error) {
  const parts = [error?.name, error?.code, error?.message].filter(Boolean);
  return parts.length > 0 ? parts.join(":") : String(error || "unknown_error");
}

function isExpectedFc2ArticleMiss(config, errorMessage) {
  return config.resolver === "fc2-article" && String(errorMessage || "").includes("fc2_article_not_found");
}

main().catch((error) => {
  process.stderr.write(`google image thumbnail collector failed: ${formatError(error)}\n`);
  process.exitCode = 1;
});
