// ============================================================
// fc2_wiki_seller_collector_test.js
// FC2 Wiki seller list collector.
//
// Purpose:
// - Read seller list pages from https://av-help.memo.wiki/
// - Extract wiki seller display names and URLs
// - Write CSV audit samples for human review
// - In db_test mode, upsert only a small sample
// - In db_execute mode, upsert all extracted sellers
//
// Safety:
// - DB writes are gated by MODE and CONFIRM_DB_WRITE
// - No file moves/deletes
// - Small page scope by default
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

const MODE = process.env.FC2_WIKI_SELLER_MODE || "test_csv";
const CONFIRM_TEST = "YES";
const CONFIRM_DB_WRITE = process.env.FC2_WIKI_SELLER_CONFIRM_DB_WRITE || "NO";

const BASE_URL = "https://av-help.memo.wiki";

const LIST_PAGES = [
  {
    sourceListUrl:
      "https://av-help.memo.wiki/d/FC2PPV%a5%ea%a5%b9%a5%c8%b0%ec%cd%f7",
    sourceLabel: "fc2ppv_list"
  }
];

const OUTPUT_DIR = path.join(__dirname, "wiki_test_output");
const MAX_LINKS_PER_PAGE =
  MODE === "db_execute"
    ? Number(process.env.FC2_WIKI_SELLER_MAX_LINKS || 5000)
    : 80;
const DB_TEST_ROW_LIMIT = 5;

const HEADLESS = true;
const PAGE_WAIT_MS = 2500;
const MIN_DELAY_MS = 1000;
const MAX_DELAY_MS = 2500;
const MAX_RETRY = 3;

const TS = new Date().toISOString().replace(/[-:T.]/g, "").slice(0, 14);
const SELLERS_CSV = path.join(OUTPUT_DIR, `fc2_wiki_sellers_test_${TS}.csv`);
const PROGRESS_CSV = path.join(
  OUTPUT_DIR,
  `fc2_wiki_sellers_progress_${TS}.csv`
);
const ERROR_CSV = path.join(OUTPUT_DIR, `fc2_wiki_sellers_error_${TS}.csv`);
const DB_SUMMARY_CSV = path.join(
  OUTPUT_DIR,
  `fc2_wiki_sellers_db_summary_${TS}.csv`
);

const DB_CONFIG = {
  host: process.env.DB_HOST || process.env.PGHOST || "localhost",
  port: Number(process.env.DB_PORT || process.env.PGPORT || 5432),
  user: process.env.DB_USER || process.env.PGUSER || "postgres",
  password: process.env.DB_PASSWORD || process.env.PGPASSWORD || "",
  database: process.env.DB_NAME || process.env.PGDATABASE || "mp4DB"
};

const TABLE_WIKI_SELLERS = "xxx_tm007_fc2_wiki_sellers";

const SELLER_HEADERS = [
  "seller_name",
  "wiki_url",
  "diff_url",
  "wiki_path",
  "source_list_url",
  "source_section",
  "seller_status",
  "is_popular",
  "is_active",
  "is_archived",
  "description",
  "collected_at"
];

const PROGRESS_HEADERS = [
  "source_list_url",
  "processed_at",
  "links_found",
  "rows_written",
  "status",
  "note"
];

const ERROR_HEADERS = ["source_list_url", "tried_at", "reason"];
const DB_SUMMARY_HEADERS = [
  "mode",
  "processed_at",
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
  fs.writeFileSync(SELLERS_CSV, csvLine(SELLER_HEADERS), "utf8");
  fs.writeFileSync(PROGRESS_CSV, csvLine(PROGRESS_HEADERS), "utf8");
  fs.writeFileSync(ERROR_CSV, csvLine(ERROR_HEADERS), "utf8");
  fs.writeFileSync(DB_SUMMARY_CSV, csvLine(DB_SUMMARY_HEADERS), "utf8");
}

function logProgress(sourceListUrl, linksFound, rowsWritten, status, note = "") {
  appendCsv(PROGRESS_CSV, [
    sourceListUrl,
    new Date().toISOString(),
    linksFound,
    rowsWritten,
    status,
    note
  ]);
}

function logError(sourceListUrl, reason) {
  appendCsv(ERROR_CSV, [sourceListUrl, new Date().toISOString(), reason]);
}

function logDbSummary(rowsInput, rowsWritten, note = "") {
  appendCsv(DB_SUMMARY_CSV, [
    MODE,
    new Date().toISOString(),
    rowsInput,
    rowsWritten,
    TABLE_WIKI_SELLERS,
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
  if (href.startsWith("/")) return `${BASE_URL}${href}`;
  return `${BASE_URL}/${href}`;
}

function getWikiPath(url) {
  try {
    return new URL(url).pathname;
  } catch {
    return "";
  }
}

function buildDiffUrl(wikiUrl) {
  const wikiPath = getWikiPath(wikiUrl);
  if (!wikiPath.startsWith("/d/")) return "";
  return `${BASE_URL}${wikiPath.replace(/^\/d\//, "/diff/")}`;
}

function inferSellerStatus(sectionText) {
  const text = String(sectionText || "");
  if (text.includes("人気")) return "popular";
  if (text.includes("過去")) return "past";
  return "listed";
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

function isLikelySellerName(text) {
  const value = String(text || "").trim();
  if (!value) return false;
  if (value === "もっと見る") return false;
  if (value.includes("ランキング")) return false;
  if (value.includes("BEST100")) return false;
  if (value.includes("100選")) return false;
  if (value.includes("FC2PPV") && value.includes("月間")) return false;
  if (value.includes("FC2PPV") && value.includes("年間")) return false;
  return true;
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

async function fetchSellerLinks(browser, source) {
  const page = await openPage(browser, source.sourceListUrl);
  if (!page) return [];

  try {
    return await page.evaluate(
      ({ baseUrl, maxLinks }) => {
        function abs(href) {
          if (!href) return "";
          if (href.startsWith("http://") || href.startsWith("https://")) {
            return href;
          }
          if (href.startsWith("/")) return baseUrl + href;
          return baseUrl + "/" + href;
        }

        function cleanText(text) {
          return String(text || "")
            .replace(/\s+/g, " ")
            .trim();
        }

        function nearestSectionText(element) {
          let current = element;
          for (let depth = 0; current && depth < 6; depth++) {
            let prev = current.previousElementSibling;
            while (prev) {
              if (/^H[1-6]$/.test(prev.tagName)) return cleanText(prev.textContent);
              prev = prev.previousElementSibling;
            }
            current = current.parentElement;
          }
          return "";
        }

        function isLikelySellerName(text) {
          const value = String(text || "").trim();
          if (!value) return false;
          if (value === "もっと見る") return false;
          if (value.includes("ランキング")) return false;
          if (value.includes("BEST100")) return false;
          if (value.includes("100選")) return false;
          if (value.includes("FC2PPV") && value.includes("月間")) return false;
          if (value.includes("FC2PPV") && value.includes("年間")) return false;
          return true;
        }

        const anchors = Array.from(document.querySelectorAll("a[href]"));
        const rows = [];
        const seen = new Set();

        for (const a of anchors) {
          const href = a.getAttribute("href") || "";
          const text = cleanText(a.textContent);
          if (!text) continue;
          if (!href.includes("/d/")) continue;
          if (href.includes("/diff/")) continue;
          if (href.includes("FC2PPV%a5%ea%a5%b9%a5%c8")) continue;
          if (href.includes("cmd=") || href.includes("edit")) continue;
          if (!isLikelySellerName(text)) continue;

          const wikiUrl = abs(href).split("#")[0];
          if (seen.has(wikiUrl)) continue;
          seen.add(wikiUrl);

          rows.push({
            sellerName: text,
            wikiUrl,
            sourceSection: nearestSectionText(a),
            description: ""
          });

          if (rows.length >= maxLinks) break;
        }

        return rows;
      },
      { baseUrl: BASE_URL, maxLinks: MAX_LINKS_PER_PAGE }
    );
  } finally {
    await page.close().catch(() => {});
  }
}

// ============================================================
// DB helpers
// ============================================================

async function upsertSellers(client, rows) {
  let written = 0;

  for (const row of rows) {
    await client.query(
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
      VALUES (
        $1, $2, $3, $4, $5, $6, $7,
        $8, $9, $10, $11, $12, $12
      )
      ON CONFLICT (wiki_url)
      DO UPDATE SET
        seller_name = EXCLUDED.seller_name,
        diff_url = EXCLUDED.diff_url,
        wiki_path = EXCLUDED.wiki_path,
        source_list_url = EXCLUDED.source_list_url,
        source_section = EXCLUDED.source_section,
        seller_status = EXCLUDED.seller_status,
        is_popular = EXCLUDED.is_popular,
        is_active = EXCLUDED.is_active,
        is_archived = EXCLUDED.is_archived,
        description = EXCLUDED.description,
        updated_at = EXCLUDED.updated_at;
      `,
      [
        row.sellerName,
        row.wikiUrl,
        row.diffUrl,
        row.wikiPath,
        row.sourceListUrl,
        row.sourceSection,
        row.sellerStatus,
        row.isPopular,
        row.isActive,
        row.isArchived,
        row.description,
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
  console.log("FC2 Wiki Seller Collector - TEST CSV");
  console.log(`MODE       : ${MODE}`);
  console.log(`DB_WRITE   : ${shouldWriteDb()}`);
  console.log(`OUTPUT_DIR : ${OUTPUT_DIR}`);
  console.log(`CSV        : ${SELLERS_CSV}`);
  console.log("=".repeat(70));

  const browser = await puppeteer.launch({ headless: HEADLESS });
  const client = shouldWriteDb() ? new Client(DB_CONFIG) : null;
  let totalRows = 0;
  let totalDbRows = 0;

  try {
    if (client) await client.connect();

    for (const source of LIST_PAGES) {
      console.log("\n" + "-".repeat(70));
      console.log(source.sourceListUrl);

      const rows = await fetchSellerLinks(browser, source);
      let rowsWritten = 0;

      const normalizedRows = [];

      for (const row of rows) {
        const diffUrl = buildDiffUrl(row.wikiUrl);
        const wikiPath = getWikiPath(row.wikiUrl);
        const sellerStatus = inferSellerStatus(row.sourceSection);
        const collectedAt = new Date().toISOString();

        const normalized = {
          sellerName: row.sellerName,
          wikiUrl: row.wikiUrl,
          diffUrl,
          wikiPath,
          sourceListUrl: source.sourceListUrl,
          sourceSection: row.sourceSection,
          sellerStatus,
          isPopular: sellerStatus === "popular",
          isActive: true,
          isArchived: sellerStatus === "past",
          description: row.description,
          collectedAt
        };

        appendCsv(SELLERS_CSV, [
          normalized.sellerName,
          normalized.wikiUrl,
          normalized.diffUrl,
          normalized.wikiPath,
          normalized.sourceListUrl,
          normalized.sourceSection,
          normalized.sellerStatus,
          normalized.isPopular,
          normalized.isActive,
          normalized.isArchived,
          normalized.description,
          normalized.collectedAt
        ]);

        normalizedRows.push(normalized);
        rowsWritten++;
      }

      totalRows += rowsWritten;
      if (client) {
        const dbRows = limitRowsForMode(normalizedRows);
        const written = await upsertSellers(client, dbRows);
        totalDbRows += written;
        logDbSummary(dbRows.length, written, `source=${source.sourceLabel}`);
      }

      logProgress(source.sourceListUrl, rows.length, rowsWritten, "done", "");
      console.log(`  links found : ${rows.length}`);
      console.log(`  rows written: ${rowsWritten}`);
      console.log(`  db upsert   : ${client ? limitRowsForMode(normalizedRows).length : 0}`);

      await randomDelay();
    }

    console.log("\n" + "=".repeat(70));
    console.log("DONE");
    console.log(`seller rows: ${totalRows}`);
    console.log(`db rows    : ${totalDbRows}`);
    console.log(`seller CSV : ${SELLERS_CSV}`);
    console.log(`progress   : ${PROGRESS_CSV}`);
    console.log(`error      : ${ERROR_CSV}`);
    console.log(`db summary : ${DB_SUMMARY_CSV}`);
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
