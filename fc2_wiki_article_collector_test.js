// ============================================================
// fc2_wiki_article_collector_test.js
// FC2 Wiki article collector.
//
// Purpose:
// - Read seller article pages from https://av-help.memo.wiki/
// - Extract product_id, title, FC2 URL, and thumbnail URL
// - Write CSV audit samples for human review
// - In db_test mode, upsert only a small sample
// - In db_execute mode, upsert articles for active wiki sellers
//
// Safety:
// - DB writes are gated by MODE and CONFIRM_DB_WRITE
// - No thumbnail downloads in this test script
// - No file moves/deletes
// - Uses additive upsert only; no DELETE, DROP, or TRUNCATE
// ============================================================

const fs = require("fs");
const path = require("path");
const { Client } = require("pg");
require("dotenv").config();
const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");

puppeteer.use(StealthPlugin());

// ============================================================
// Config
// ============================================================

const MODE = process.env.FC2_WIKI_ARTICLE_MODE || "test_csv";
const CONFIRM_TEST = "YES";
const CONFIRM_DB_WRITE = process.env.FC2_WIKI_ARTICLE_CONFIRM_DB_WRITE || "NO";

const BASE_URL = "https://av-help.memo.wiki";

const DEFAULT_SELLER_PAGES = [
  {
    sellerName: "KING POWER D",
    wikiUrl: "https://av-help.memo.wiki/d/KING%20POWER%20D",
    sourceType: "seller_page"
  }
];

const INCLUDE_DIFF_PAGE = false;
const OUTPUT_DIR = path.join(__dirname, "wiki_test_output");
const MAX_ROWS_PER_PAGE =
  MODE === "db_execute"
    ? Number(process.env.FC2_WIKI_ARTICLE_MAX_ROWS_PER_PAGE || 1000)
    : 120;
const MAX_SELLERS =
  MODE === "db_execute"
    ? Number(process.env.FC2_WIKI_ARTICLE_MAX_SELLERS || 5000)
    : DEFAULT_SELLER_PAGES.length;
const DB_TEST_ROW_LIMIT = 10;

const HEADLESS = true;
const PAGE_WAIT_MS = Number(
  process.env.FC2_WIKI_ARTICLE_PAGE_WAIT_MS ||
    (MODE === "db_execute" ? 1200 : 2500)
);
const MIN_DELAY_MS = Number(
  process.env.FC2_WIKI_ARTICLE_MIN_DELAY_MS ||
    (MODE === "db_execute" ? 500 : 1000)
);
const MAX_DELAY_MS = Number(
  process.env.FC2_WIKI_ARTICLE_MAX_DELAY_MS ||
    (MODE === "db_execute" ? 1200 : 2500)
);
const MAX_RETRY = 3;

const TS = new Date().toISOString().replace(/[-:T.]/g, "").slice(0, 14);
const ARTICLES_CSV = path.join(
  OUTPUT_DIR,
  `fc2_wiki_articles_test_${TS}.csv`
);
const PROGRESS_CSV = path.join(
  OUTPUT_DIR,
  `fc2_wiki_articles_progress_${TS}.csv`
);
const ERROR_CSV = path.join(OUTPUT_DIR, `fc2_wiki_articles_error_${TS}.csv`);
const DB_SUMMARY_CSV = path.join(
  OUTPUT_DIR,
  `fc2_wiki_articles_db_summary_${TS}.csv`
);

const DB_CONFIG = {
  host: process.env.DB_HOST || process.env.PGHOST || "localhost",
  port: Number(process.env.DB_PORT || process.env.PGPORT || 5432),
  user: process.env.DB_USER || process.env.PGUSER || "postgres",
  password: process.env.DB_PASSWORD || process.env.PGPASSWORD || "",
  database: process.env.DB_NAME || process.env.PGDATABASE || "mp4DB"
};

const TABLE_WIKI_SELLERS = "xxx_tm007_fc2_wiki_sellers";
const TABLE_WIKI_ARTICLES = "xxx_tm008_fc2_wiki_articles";

const ARTICLE_HEADERS = [
  "wiki_seller_id",
  "product_id",
  "product_id_raw",
  "title",
  "seller_name",
  "fc2_url",
  "thumbnail_url",
  "source_wiki_url",
  "source_type",
  "row_status",
  "local_thumbnail_path",
  "thumbnail_status",
  "collected_at"
];

const PROGRESS_HEADERS = [
  "source_wiki_url",
  "processed_at",
  "rows_found",
  "rows_written",
  "status",
  "note"
];

const ERROR_HEADERS = ["source_wiki_url", "tried_at", "reason"];
const DB_SUMMARY_HEADERS = [
  "mode",
  "processed_at",
  "source_wiki_url",
  "rows_input",
  "rows_written",
  "table_name",
  "note"
];

// ============================================================
// CSV helpers
// ============================================================

function esc(value) {
  return `"${String(value ?? "").replace(/"/g, '""')}"`;
}

function csvLine(values) {
  return values.map(esc).join(",") + "\n";
}

function appendCsv(filePath, values) {
  fs.appendFileSync(filePath, csvLine(values), "utf8");
}

function initCsvFiles() {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  fs.writeFileSync(ARTICLES_CSV, csvLine(ARTICLE_HEADERS), "utf8");
  fs.writeFileSync(PROGRESS_CSV, csvLine(PROGRESS_HEADERS), "utf8");
  fs.writeFileSync(ERROR_CSV, csvLine(ERROR_HEADERS), "utf8");
  fs.writeFileSync(DB_SUMMARY_CSV, csvLine(DB_SUMMARY_HEADERS), "utf8");
}

function logProgress(sourceWikiUrl, rowsFound, rowsWritten, status, note = "") {
  appendCsv(PROGRESS_CSV, [
    sourceWikiUrl,
    new Date().toISOString(),
    rowsFound,
    rowsWritten,
    status,
    note
  ]);
}

function logError(sourceWikiUrl, reason) {
  appendCsv(ERROR_CSV, [sourceWikiUrl, new Date().toISOString(), reason]);
}

function logDbSummary(sourceWikiUrl, rowsInput, rowsWritten, note = "") {
  appendCsv(DB_SUMMARY_CSV, [
    MODE,
    new Date().toISOString(),
    sourceWikiUrl,
    rowsInput,
    rowsWritten,
    TABLE_WIKI_ARTICLES,
    note
  ]);
}

// ============================================================
// Utility
// ============================================================

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function randomDelay() {
  const ms =
    Math.floor(Math.random() * (MAX_DELAY_MS - MIN_DELAY_MS + 1)) +
    MIN_DELAY_MS;
  console.log(`  wait: ${ms}ms`);
  await sleep(ms);
}

function toAbsoluteUrl(href) {
  if (!href) return "";
  if (href.startsWith("http://") || href.startsWith("https://")) return href;
  if (href.startsWith("//")) return `https:${href}`;
  if (href.startsWith("/")) return `${BASE_URL}${href}`;
  return `${BASE_URL}/${href}`;
}

function normalizeProductId(value) {
  const text = String(value || "");
  const patterns = [
    /FC2[-_\s]*PPV[-_\s]*(\d{6,8})/i,
    /fc2ppv[-_\s]*(\d{6,8})/i,
    /aid=(\d{6,8})/i,
    /\/article\/(\d{6,8})\/?/i,
    /(?:^|[^\d])(\d{6,8})(?:[^\d]|$)/
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) return match[1];
  }

  return "";
}

function shouldWriteDb() {
  return MODE === "db_test" || MODE === "db_execute";
}

function assertSafetyGate() {
  if (!["test_csv", "db_test", "db_execute"].includes(MODE)) {
    throw new Error(`Unsupported MODE: ${MODE}`);
  }
  if (MODE === "test_csv" && CONFIRM_TEST !== "YES") {
    throw new Error("Safety gate failed. Set CONFIRM_TEST=YES for test_csv.");
  }
  if (shouldWriteDb() && CONFIRM_DB_WRITE !== "YES") {
    throw new Error("DB write gate failed. Set CONFIRM_DB_WRITE=YES.");
  }
}

function limitRowsForMode(rows) {
  if (MODE === "db_test") return rows.slice(0, DB_TEST_ROW_LIMIT);
  return rows;
}

async function loadSellerPages(client) {
  if (MODE !== "db_execute" || !client) return DEFAULT_SELLER_PAGES;

  const result = await client.query(
    `
    SELECT seller_name, wiki_url
    FROM ${TABLE_WIKI_SELLERS}
    WHERE is_active = true
      AND COALESCE(is_archived, false) = false
      AND wiki_url IS NOT NULL
      AND wiki_url <> ''
    ORDER BY id
    LIMIT $1;
    `,
    [MAX_SELLERS]
  );

  return result.rows.map((row) => ({
    sellerName: row.seller_name,
    wikiUrl: row.wiki_url,
    sourceType: "seller_page"
  }));
}

function buildDiffUrl(wikiUrl) {
  try {
    const url = new URL(wikiUrl);
    if (!url.pathname.startsWith("/d/")) return "";
    url.pathname = url.pathname.replace(/^\/d\//, "/diff/");
    return url.toString();
  } catch {
    return "";
  }
}

function cleanTitle(text, productId, sellerName = "") {
  let title = String(text || "")
    .replace(/\s+/g, " ")
    .trim();

  if (productId) {
    title = title.replace(new RegExp(`FC2[-_\\s]*PPV[-_\\s]*${productId}`, "i"), "");
    title = title.replace(new RegExp(`fc2ppv[-_\\s]*${productId}`, "i"), "");
    title = title.replace(new RegExp(`\\b${productId}\\b`), "");
    title = title.replace(productId, "");
  }

  if (sellerName) {
    title = title.replace(new RegExp(`${sellerName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`), "");
  }

  return title
    .replace(/^fc2[-_\s]*ppv[-_\s]*/i, "")
    .replace(/^[-:：\s]+/, "")
    .replace(/\s+/g, " ")
    .trim();
}

// ============================================================
// Browser helpers
// ============================================================

async function openPage(browser, url) {
  for (let attempt = 1; attempt <= MAX_RETRY; attempt++) {
    let page;
    try {
      page = await browser.newPage();
      await page.setViewport({ width: 1280, height: 900 });
      await page.setRequestInterception(true);
      page.on("request", (request) => {
        const resourceType = request.resourceType();
        if (["image", "media", "font", "stylesheet"].includes(resourceType)) {
          request.abort();
          return;
        }
        request.continue();
      });
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
      await sleep(PAGE_WAIT_MS);
      return page;
    } catch (err) {
      if (page) await page.close().catch(() => {});
      logError(url, `open failed ${attempt}/${MAX_RETRY}: ${err.message}`);
      if (attempt < MAX_RETRY) await sleep(3000);
    }
  }
  return null;
}

async function fetchArticleRows(browser, source) {
  const page = await openPage(browser, source.wikiUrl);
  if (!page) return [];

  try {
    return await page.evaluate(
      ({ baseUrl, maxRows }) => {
        function abs(href) {
          if (!href) return "";
          if (href.startsWith("http://") || href.startsWith("https://")) {
            return href;
          }
          if (href.startsWith("//")) return "https:" + href;
          if (href.startsWith("/")) return baseUrl + href;
          return baseUrl + "/" + href;
        }

        function cleanText(text) {
          return String(text || "")
            .replace(/\s+/g, " ")
            .trim();
        }

        function normalizeProductId(value) {
          const text = String(value || "");
          const patterns = [
            /FC2[-_\s]*PPV[-_\s]*(\d{6,8})/i,
            /fc2ppv[-_\s]*(\d{6,8})/i,
            /aid=(\d{6,8})/i,
            /\/article\/(\d{6,8})\/?/i,
            /(?:^|[^\d])(\d{6,8})(?:[^\d]|$)/
          ];
          for (const pattern of patterns) {
            const match = text.match(pattern);
            if (match) return match[1];
          }
          return "";
        }

        function isFc2ArticleUrl(url) {
          return /adult\.contents\.fc2\.com|\/article\/|[?&]aid=\d{6,8}/i.test(
            String(url || "")
          );
        }

        function rowContainer(element) {
          return (
            element.closest("tr") ||
            element.closest("li") ||
            element.closest("p") ||
            element.closest("div") ||
            element.parentElement
          );
        }

        const candidates = [];
        const seen = new Set();

        const anchors = Array.from(document.querySelectorAll("a[href]"));
        for (const a of anchors) {
          const href = a.getAttribute("href") || "";
          const text = cleanText(a.textContent);
          const url = abs(href);
          if (!isFc2ArticleUrl(url) && !/fc2[-_\s]*ppv[-_\s]*\d{6,8}/i.test(text)) {
            continue;
          }
          const combined = `${href} ${text}`;
          const productId = normalizeProductId(combined);
          if (!productId) continue;

          const container = rowContainer(a);
          const rowText = cleanText(container ? container.textContent : text);
          const img = container ? container.querySelector("img[src]") : null;
          const thumbnailUrl = img ? abs(img.getAttribute("src") || "") : "";
          if (url.includes("seesaawiki.jp") || url.includes("wiki/member")) {
            continue;
          }

          const key = `${productId}|${url}`;
          if (seen.has(key)) continue;
          seen.add(key);

          candidates.push({
            productId,
            productIdRaw: text || href,
            rowText,
            fc2Url: isFc2ArticleUrl(url) ? url : "",
            thumbnailUrl
          });

          if (candidates.length >= maxRows) break;
        }

        if (candidates.length < maxRows) {
          const images = Array.from(document.querySelectorAll("img[src]"));
          for (const img of images) {
            const src = img.getAttribute("src") || "";
            if (!src.includes("contents-thumbnail")) continue;
            const container = rowContainer(img);
            const rowText = cleanText(container ? container.textContent : "");
            const productId = normalizeProductId(`${src} ${rowText}`);
            if (!productId) continue;
            const key = `${productId}|${src}`;
            if (seen.has(key)) continue;
            seen.add(key);

            const firstArticleLink = container
              ? Array.from(container.querySelectorAll("a[href]")).find((a) =>
                  /adult\.contents\.fc2\.com|\/article\/|aid=/.test(
                    a.getAttribute("href") || ""
                  )
                )
              : null;

            candidates.push({
              productId,
              productIdRaw: src,
              rowText,
              fc2Url: firstArticleLink
                ? abs(firstArticleLink.getAttribute("href") || "")
                : "",
              thumbnailUrl: abs(src)
            });

            if (candidates.length >= maxRows) break;
          }
        }

        return candidates;
      },
      { baseUrl: BASE_URL, maxRows: MAX_ROWS_PER_PAGE }
    );
  } finally {
    await page.close().catch(() => {});
  }
}

// ============================================================
// DB helpers
// ============================================================

async function upsertSellerForArticle(client, source) {
  const diffUrl = buildDiffUrl(source.wikiUrl);
  const wikiPath = (() => {
    try {
      return new URL(source.wikiUrl).pathname;
    } catch {
      return "";
    }
  })();

  const result = await client.query(
    `
    INSERT INTO ${TABLE_WIKI_SELLERS} (
      seller_name,
      wiki_url,
      diff_url,
      wiki_path,
      source_list_url,
      source_section,
      seller_status,
      is_popular,
      is_active,
      is_archived,
      description,
      collected_at,
      updated_at
    )
    VALUES ($1, $2, $3, $4, '', '', 'article_source', false, true, false, '', now(), now())
    ON CONFLICT (wiki_url)
    DO UPDATE SET
      seller_name = EXCLUDED.seller_name,
      diff_url = EXCLUDED.diff_url,
      wiki_path = EXCLUDED.wiki_path,
      updated_at = now()
    RETURNING id;
    `,
    [source.sellerName, source.wikiUrl, diffUrl, wikiPath]
  );

  return result.rows[0].id;
}

async function upsertArticles(client, rows) {
  let written = 0;

  for (const row of rows) {
    await client.query(
      `
      INSERT INTO ${TABLE_WIKI_ARTICLES} (
        wiki_seller_id,
        product_id,
        product_id_raw,
        title,
        seller_name,
        fc2_url,
        thumbnail_url,
        source_wiki_url,
        source_type,
        row_status,
        local_thumbnail_path,
        thumbnail_status,
        collected_at,
        updated_at
      )
      VALUES (
        $1, $2, $3, $4, $5, $6, $7,
        $8, $9, $10, $11, $12, $13, $13
      )
      ON CONFLICT (product_id, source_wiki_url)
      DO UPDATE SET
        wiki_seller_id = EXCLUDED.wiki_seller_id,
        product_id_raw = EXCLUDED.product_id_raw,
        title = EXCLUDED.title,
        seller_name = EXCLUDED.seller_name,
        fc2_url = EXCLUDED.fc2_url,
        thumbnail_url = EXCLUDED.thumbnail_url,
        source_type = EXCLUDED.source_type,
        row_status = EXCLUDED.row_status,
        thumbnail_status = EXCLUDED.thumbnail_status,
        updated_at = EXCLUDED.updated_at;
      `,
      [
        row.wikiSellerId,
        row.productId,
        row.productIdRaw,
        row.title,
        row.sellerName,
        row.fc2Url,
        row.thumbnailUrl,
        row.sourceWikiUrl,
        row.sourceType,
        row.rowStatus,
        row.localThumbnailPath,
        row.thumbnailStatus,
        row.collectedAt
      ]
    );
    written++;
  }

  return written;
}

// ============================================================
// Main
// ============================================================

(async () => {
  assertSafetyGate();

  initCsvFiles();

  console.log("=".repeat(70));
  console.log("FC2 Wiki Article Collector - TEST CSV");
  console.log(`MODE       : ${MODE}`);
  console.log(`DB_WRITE   : ${shouldWriteDb()}`);
  console.log(`OUTPUT_DIR : ${OUTPUT_DIR}`);
  console.log(`CSV        : ${ARTICLES_CSV}`);
  console.log("=".repeat(70));

  const browser = await puppeteer.launch({ headless: HEADLESS });
  const client = shouldWriteDb() ? new Client(DB_CONFIG) : null;
  let totalRows = 0;
  let totalDbRows = 0;

  try {
    if (client) await client.connect();

    const sellerPages = await loadSellerPages(client);
    const pages = [...sellerPages];
    if (INCLUDE_DIFF_PAGE) {
      for (const seller of sellerPages) {
        const diffUrl = buildDiffUrl(seller.wikiUrl);
        if (diffUrl) {
          pages.push({
            sellerName: seller.sellerName,
            wikiUrl: diffUrl,
            sourceType: "diff_page"
          });
        }
      }
    }

    for (const source of pages) {
      console.log("\n" + "-".repeat(70));
      console.log(source.wikiUrl);

      const rows = await fetchArticleRows(browser, source);
      let rowsWritten = 0;
      const normalizedRows = [];
      const wikiSellerId = client ? await upsertSellerForArticle(client, source) : "";

      for (const row of rows) {
        const productId = row.productId || normalizeProductId(row.rowText);
        if (!productId) {
          logError(source.wikiUrl, `product_id missing: ${row.rowText}`);
          continue;
        }

        const title = cleanTitle(row.rowText, productId, source.sellerName);
        const collectedAt = new Date().toISOString();
        const normalized = {
          wikiSellerId,
          productId,
          productIdRaw: row.productIdRaw,
          title,
          sellerName: source.sellerName,
          fc2Url: row.fc2Url,
          thumbnailUrl: row.thumbnailUrl,
          sourceWikiUrl: source.wikiUrl,
          sourceType: source.sourceType,
          rowStatus: "collected",
          localThumbnailPath: "",
          thumbnailStatus: row.thumbnailUrl ? "pending" : "missing_url",
          collectedAt
        };

        appendCsv(ARTICLES_CSV, [
          normalized.wikiSellerId,
          normalized.productId,
          normalized.productIdRaw,
          normalized.title,
          normalized.sellerName,
          normalized.fc2Url,
          normalized.thumbnailUrl,
          normalized.sourceWikiUrl,
          normalized.sourceType,
          normalized.rowStatus,
          normalized.localThumbnailPath,
          normalized.thumbnailStatus,
          normalized.collectedAt
        ]);

        normalizedRows.push(normalized);
        rowsWritten++;
      }

      totalRows += rowsWritten;
      if (client) {
        const dbRows = limitRowsForMode(normalizedRows);
        const written = await upsertArticles(client, dbRows);
        totalDbRows += written;
        logDbSummary(source.wikiUrl, dbRows.length, written, `seller=${source.sellerName}`);
      }

      logProgress(source.wikiUrl, rows.length, rowsWritten, "done", "");
      console.log(`  rows found  : ${rows.length}`);
      console.log(`  rows written: ${rowsWritten}`);
      console.log(`  db upsert   : ${client ? limitRowsForMode(normalizedRows).length : 0}`);

      await randomDelay();
    }

    console.log("\n" + "=".repeat(70));
    console.log("DONE");
    console.log(`article rows: ${totalRows}`);
    console.log(`db rows     : ${totalDbRows}`);
    console.log(`article CSV : ${ARTICLES_CSV}`);
    console.log(`progress    : ${PROGRESS_CSV}`);
    console.log(`error       : ${ERROR_CSV}`);
    console.log(`db summary  : ${DB_SUMMARY_CSV}`);
    console.log("=".repeat(70));
  } catch (err) {
    console.error("Fatal error:", err);
    logError("", `fatal: ${err.message || String(err)}`);
    process.exitCode = 1;
  } finally {
    await browser.close().catch(() => {});
    if (client) await client.end().catch(() => {});
  }
})();
