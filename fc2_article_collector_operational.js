// ============================================================
// fc2_article_collector_operational.js
// FC2 Article Collector 本番差分バックフィル版
//
// 目的:
// - FC2検索ページを page=START_PAGE から順に巡回
// - CSVログを残す
// - stageへバッチ投入
// - master / full へ新規だけINSERT
// - 一定ページごとにCOMMIT
// - 停止した場合、START_PAGEを書き換えて再開可能
//
// 今回の重要仕様:
// - 既に page=1〜5 の一部最新IDは master に入っている
// - そのため DBのMAX(product_id) は停止基準に使わない
// - 旧差分境界として BACKFILL_BASELINE_PRODUCT_ID を使う
// - product_id > BACKFILL_BASELINE_PRODUCT_ID が無いページが連続したら停止
// ============================================================

const fs = require("fs");
const path = require("path");
const { Client } = require("pg");
require("dotenv").config();

const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
puppeteer.use(StealthPlugin());

// ============================================================
// ★★★ 設定エリア ★★★
// ============================================================

const BASE_URL = "https://adult.contents.fc2.com";

// 再開したい場合はここを変更
const START_PAGE = 1;

// 最大安全ページ数
const MAX_PAGE = 10;

// 今回の古いmaster最大ID
// これ以下まで到達したら、現在差分を埋めたと判断する
const BACKFILL_BASELINE_PRODUCT_ID = 1000000;

// この回数連続で「基準IDより新しい作品がない」なら停止
const STOP_CONSECUTIVE_NO_NEWER_PAGE_COUNT = 20;


// 500ページごとに休憩
const REST_EVERY_PAGES = 500;

// 5分休憩
const REST_MS = 5 * 60 * 1000;

// 何ページごとにDBへ投入するか
const BATCH_PAGES = 100;

// true = ROLLBACK
// false = COMMIT
const DRY_RUN = false;

// 本番実行の安全確認
const CONFIRM_EXECUTE = "YES";

// 出力先
const OUTPUT_DIR = "C:\\fc2_article_output\\backfill_run";

// Puppeteer
const HEADLESS = true;
const PAGE_WAIT_MS = 3000;
const MIN_DELAY_MS = 2000;
const MAX_DELAY_MS = 6000;
const MAX_RETRY = 3;

// DB接続
const DB_CONFIG = {
  host: process.env.DB_HOST || "localhost",
  port: Number(process.env.DB_PORT || 5432),
  user: process.env.DB_USER || "postgres",
  password: process.env.DB_PASSWORD || "",
  database: process.env.DB_NAME || "mp4DB"
};

// ============================================================
// テーブル名
// ============================================================

const TABLE_MASTER = "master";
const TABLE_FULL = "xxx_tm006_fc2_article_master_full";
const TABLE_FULL_STAGE = "xxx_tm006_fc2_article_master_full_stage";
const TABLE_IMPORT_STAGE = "xxx_tm006_fc2_article_master_import_stage";

// ============================================================
// CSV
// ============================================================

const TS = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 15);

const MASTER_CSV = path.join(OUTPUT_DIR, `fc2_article_master_import_${TS}.csv`);
const FULL_CSV = path.join(OUTPUT_DIR, `fc2_article_master_full_${TS}.csv`);
const PROGRESS_CSV = path.join(OUTPUT_DIR, `fc2_article_progress_${TS}.csv`);
const ERROR_CSV = path.join(OUTPUT_DIR, `fc2_article_error_${TS}.csv`);
const SUMMARY_CSV = path.join(OUTPUT_DIR, `fc2_article_batch_summary_${TS}.csv`);

const MASTER_HEADERS = ["product_id", "title", "seller_id"];

const FULL_HEADERS = [
  "product_id",
  "title",
  "seller_id",
  "seller_name",
  "price_text",
  "price_pt",
  "article_url",
  "search_page_url",
  "page_number",
  "row_index_in_page",
  "collected_at"
];

const PROGRESS_HEADERS = [
  "page_number",
  "search_page_url",
  "processed_at",
  "rows_found",
  "rows_written",
  "max_product_id_in_page",
  "newer_than_baseline_count",
  "consecutive_no_newer_pages",
  "status",
  "note"
];

const ERROR_HEADERS = [
  "page_number",
  "search_page_url",
  "tried_at",
  "reason"
];

const SUMMARY_HEADERS = [
  "batch_no",
  "start_page",
  "end_page",
  "processed_at",
  "rows_collected",
  "unique_stage_count",
  "new_master_before",
  "master_count_before",
  "full_count_before",
  "master_count_after",
  "full_count_after",
  "mode"
];

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
  console.log(`  待機: ${ms}ms`);
  await sleep(ms);
}

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

  fs.writeFileSync(MASTER_CSV, csvLine(MASTER_HEADERS), "utf8");
  fs.writeFileSync(FULL_CSV, csvLine(FULL_HEADERS), "utf8");
  fs.writeFileSync(PROGRESS_CSV, csvLine(PROGRESS_HEADERS), "utf8");
  fs.writeFileSync(ERROR_CSV, csvLine(ERROR_HEADERS), "utf8");
  fs.writeFileSync(SUMMARY_CSV, csvLine(SUMMARY_HEADERS), "utf8");
}

function logError(pageNumber, searchPageUrl, reason) {
  appendCsv(ERROR_CSV, [
    pageNumber,
    searchPageUrl,
    new Date().toISOString(),
    reason
  ]);
}

function logProgress(
  pageNumber,
  searchPageUrl,
  rowsFound,
  rowsWritten,
  maxProductIdInPage,
  newerThanBaselineCount,
  consecutiveNoNewerPages,
  status,
  note = ""
) {
  appendCsv(PROGRESS_CSV, [
    pageNumber,
    searchPageUrl,
    new Date().toISOString(),
    rowsFound,
    rowsWritten,
    maxProductIdInPage,
    newerThanBaselineCount,
    consecutiveNoNewerPages,
    status,
    note
  ]);
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
  const match = String(href || "").match(/\/article\/(\d+)\/?/);
  return match ? match[1] : "";
}

function extractSellerIdFromSellerHref(href) {
  const match = String(href || "").match(/\/users\/([^/]+)\/?/);
  return match ? match[1] : "";
}

function parsePricePt(priceText) {
  const clean = String(priceText || "").replace(/[^\d]/g, "");
  return clean ? Number(clean) : null;
}

function toBigIntSafe(value) {
  const text = String(value ?? "");
  return /^\d+$/.test(text) ? BigInt(text) : 0n;
}

// ============================================================
// Puppeteer
// ============================================================

async function openPage(browser, url, pageNumber) {
  for (let attempt = 1; attempt <= MAX_RETRY; attempt++) {
    let page;

    try {
      page = await browser.newPage();

      await page.setViewport({
        width: 1280,
        height: 900
      });

      await page.goto(url, {
        waitUntil: "domcontentloaded",
        timeout: 30000
      });

      await sleep(PAGE_WAIT_MS);

      return page;
    } catch (err) {
      if (page) await page.close().catch(() => {});

      console.log(
        `  page=${pageNumber} 取得失敗 ${attempt}/${MAX_RETRY}: ${err.message}`
      );

      logError(pageNumber, url, `ページ取得失敗 ${attempt}/${MAX_RETRY}: ${err.message}`);

      if (attempt < MAX_RETRY) {
        await sleep(3000);
      }
    }
  }

  return null;
}

async function fetchItemsFromPage(browser, pageNumber) {
  const searchPageUrl = buildSearchPageUrl(pageNumber);
  const page = await openPage(browser, searchPageUrl, pageNumber);

  if (!page) {
    return [];
  }

  try {
    return await page.evaluate(() => {
      const cards = Array.from(
        document.querySelectorAll("div.c-cntCard-110-f")
      );

      return cards
        .map((card, index) => {
          const titleA = card.querySelector("a.c-cntCard-110-f_itemName");
          const sellerA = card.querySelector("span.c-cntCard-110-f_seller a");
          const priceSpan = card.querySelector("span.c-cntCard-110-f_price");

          if (!titleA) return null;

          return {
            rowIndexInPage: index + 1,
            href: titleA.getAttribute("href") || "",
            title:
              titleA.getAttribute("title") ||
              (titleA.textContent || "").trim(),
            sellerHref: sellerA ? sellerA.getAttribute("href") || "" : "",
            sellerName: sellerA ? (sellerA.textContent || "").trim() : "",
            priceText: priceSpan ? (priceSpan.textContent || "").trim() : ""
          };
        })
        .filter(Boolean);
    });
  } finally {
    await page.close().catch(() => {});
  }
}

// ============================================================
// DB helper
// ============================================================

async function truncateStage(client) {
  await client.query(`TRUNCATE TABLE ${TABLE_FULL_STAGE};`);
  await client.query(`TRUNCATE TABLE ${TABLE_IMPORT_STAGE};`);
}

function chunkArray(arr, size) {
  const chunks = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}

async function bulkInsertImportStage(client, rows) {
  const chunks = chunkArray(rows, 500);

  for (const chunk of chunks) {
    const values = [];
    const placeholders = chunk.map((row, i) => {
      const base = i * 3;
      values.push(row.product_id, row.title, row.seller_id);
      return `($${base + 1}, $${base + 2}, $${base + 3})`;
    });

    await client.query(
      `
      INSERT INTO ${TABLE_IMPORT_STAGE} (
        product_id,
        title,
        seller_id
      )
      VALUES ${placeholders.join(",")};
      `,
      values
    );
  }
}

async function bulkInsertFullStage(client, rows) {
  const chunks = chunkArray(rows, 300);

  for (const chunk of chunks) {
    const values = [];
    const placeholders = chunk.map((row, i) => {
      const base = i * 11;
      values.push(
        row.product_id,
        row.title,
        row.seller_id,
        row.seller_name,
        row.price_text,
        row.price_pt,
        row.article_url,
        row.search_page_url,
        row.page_number,
        row.row_index_in_page,
        row.collected_at
      );
      return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7}, $${base + 8}, $${base + 9}, $${base + 10}, $${base + 11})`;
    });

    await client.query(
      `
      INSERT INTO ${TABLE_FULL_STAGE} (
        product_id,
        title,
        seller_id,
        seller_name,
        price_text,
        price_pt,
        article_url,
        search_page_url,
        page_number,
        row_index_in_page,
        collected_at
      )
      VALUES ${placeholders.join(",")};
      `,
      values
    );
  }
}

async function getCounts(client) {
  const uniqueStage = await client.query(
    `SELECT COUNT(DISTINCT product_id)::int AS count FROM ${TABLE_IMPORT_STAGE};`
  );

  const newMaster = await client.query(
    `
    SELECT COUNT(DISTINCT s.product_id)::int AS count
    FROM ${TABLE_IMPORT_STAGE} s
    LEFT JOIN ${TABLE_MASTER} m
      ON m.product_id = s.product_id
    WHERE m.product_id IS NULL;
    `
  );

  const masterCount = await client.query(
    `SELECT COUNT(*)::int AS count FROM ${TABLE_MASTER};`
  );

  const fullCount = await client.query(
    `SELECT COUNT(*)::int AS count FROM ${TABLE_FULL};`
  );

  return {
    uniqueStage: uniqueStage.rows[0].count,
    newMaster: newMaster.rows[0].count,
    masterCount: masterCount.rows[0].count,
    fullCount: fullCount.rows[0].count
  };
}

async function commitStageToMain(client) {
  await client.query("BEGIN;");

  try {
    await client.query(
      `
      INSERT INTO ${TABLE_MASTER} (
        product_id,
        title,
        seller_id
      )
      SELECT DISTINCT ON (s.product_id)
        s.product_id,
        s.title,
        s.seller_id
      FROM ${TABLE_IMPORT_STAGE} s
      LEFT JOIN ${TABLE_MASTER} m
        ON m.product_id = s.product_id
      WHERE m.product_id IS NULL
      ORDER BY s.product_id, s.product_id::bigint DESC;
      `
    );

    await client.query(
      `
      INSERT INTO ${TABLE_FULL} (
        product_id,
        title,
        seller_id,
        seller_name,
        price_text,
        price_pt,
        article_url,
        search_page_url,
        page_number,
        row_index_in_page,
        collected_at
      )
      SELECT DISTINCT ON (s.product_id)
        s.product_id,
        s.title,
        s.seller_id,
        s.seller_name,
        s.price_text,
        s.price_pt,
        s.article_url,
        s.search_page_url,
        s.page_number,
        s.row_index_in_page,
        s.collected_at
      FROM ${TABLE_FULL_STAGE} s
      LEFT JOIN ${TABLE_FULL} f
        ON f.product_id = s.product_id
      WHERE f.product_id IS NULL
      ORDER BY s.product_id, s.collected_at DESC;
      `
    );

    if (DRY_RUN) {
      await client.query("ROLLBACK;");
      console.log("  DRY_RUN=true のため ROLLBACK");
      return "ROLLBACK";
    }

    await client.query("COMMIT;");
    console.log("  COMMIT 完了");
    return "COMMIT";
  } catch (err) {
    await client.query("ROLLBACK;");
    throw err;
  }
}

// ============================================================
// Batch処理
// ============================================================

async function flushBatch(client, batchNo, startPage, endPage, fullRows, importRows) {
  if (fullRows.length === 0) {
    console.log(`\nBatch ${batchNo}: 対象0件のためスキップ`);
    return;
  }

  console.log("\n" + "=".repeat(70));
  console.log(`Batch ${batchNo}: page ${startPage} ～ ${endPage}`);
  console.log(`rows: ${fullRows.length}`);
  console.log("stage初期化中...");

  await truncateStage(client);

  console.log("stage投入中...");
  await bulkInsertImportStage(client, importRows);
  await bulkInsertFullStage(client, fullRows);

  const before = await getCounts(client);

  console.log("投入前確認:", before);

  const mode = await commitStageToMain(client);

  const after = await getCounts(client);

  console.log("投入後確認:", after);

  appendCsv(SUMMARY_CSV, [
    batchNo,
    startPage,
    endPage,
    new Date().toISOString(),
    fullRows.length,
    before.uniqueStage,
    before.newMaster,
    before.masterCount,
    before.fullCount,
    after.masterCount,
    after.fullCount,
    mode
  ]);

  console.log("=".repeat(70));
}

// ============================================================
// Main
// ============================================================

(async () => {
  if (!DRY_RUN && CONFIRM_EXECUTE !== "YES") {
    throw new Error("本番実行するには CONFIRM_EXECUTE = \"YES\" が必要です。");
  }

  initCsvFiles();

  console.log("=".repeat(70));
  console.log("FC2 Article Collector Backfill");
  console.log(`START_PAGE                 : ${START_PAGE}`);
  console.log(`MAX_PAGE                   : ${MAX_PAGE}`);
  console.log(`BACKFILL_BASELINE_PRODUCT_ID: ${BACKFILL_BASELINE_PRODUCT_ID}`);
  console.log(`BATCH_PAGES                : ${BATCH_PAGES}`);
  console.log(`DRY_RUN                    : ${DRY_RUN}`);
  console.log(`OUTPUT_DIR                 : ${OUTPUT_DIR}`);
  console.log("=".repeat(70));

  const client = new Client(DB_CONFIG);
  await client.connect();

  const browser = await puppeteer.launch({
    headless: HEADLESS
  });

  let batchNo = 1;
  let batchStartPage = START_PAGE;
  let batchFullRows = [];
  let batchImportRows = [];

  let totalFound = 0;
  let totalWritten = 0;
  let consecutiveNoNewerPages = 0;

  try {
    for (let pageNumber = START_PAGE; pageNumber <= MAX_PAGE; pageNumber++) {
      const searchPageUrl = buildSearchPageUrl(pageNumber);

      console.log("\n" + "-".repeat(70));
      console.log(`page=${pageNumber}`);
      console.log(searchPageUrl);

      const items = await fetchItemsFromPage(browser, pageNumber);

      let rowsWritten = 0;
      let maxProductIdInPage = 0n;
      let newerThanBaselineCount = 0;

      for (const item of items) {
        const productId = extractProductIdFromArticleHref(item.href);

        if (!productId) {
          logError(
            pageNumber,
            searchPageUrl,
            `product_id取得不可 row=${item.rowIndexInPage}`
          );
          continue;
        }

        const productIdBig = toBigIntSafe(productId);
        if (productIdBig > maxProductIdInPage) {
          maxProductIdInPage = productIdBig;
        }

        if (productIdBig > BigInt(BACKFILL_BASELINE_PRODUCT_ID)) {
          newerThanBaselineCount++;
        }

        const sellerId = extractSellerIdFromSellerHref(item.sellerHref);
        const articleUrl = toAbsoluteUrl(item.href);
        const pricePt = parsePricePt(item.priceText);
        const collectedAt = new Date().toISOString();

        const importRow = {
          product_id: productId,
          title: item.title,
          seller_id: sellerId || null
        };

        const fullRow = {
          product_id: productId,
          title: item.title,
          seller_id: sellerId || null,
          seller_name: item.sellerName || null,
          price_text: item.priceText || null,
          price_pt: pricePt,
          article_url: articleUrl,
          search_page_url: searchPageUrl,
          page_number: pageNumber,
          row_index_in_page: item.rowIndexInPage,
          collected_at: collectedAt
        };

        batchImportRows.push(importRow);
        batchFullRows.push(fullRow);

        appendCsv(MASTER_CSV, [
          importRow.product_id,
          importRow.title,
          importRow.seller_id
        ]);

        appendCsv(FULL_CSV, [
          fullRow.product_id,
          fullRow.title,
          fullRow.seller_id,
          fullRow.seller_name,
          fullRow.price_text,
          fullRow.price_pt ?? "",
          fullRow.article_url,
          fullRow.search_page_url,
          fullRow.page_number,
          fullRow.row_index_in_page,
          fullRow.collected_at
        ]);

        rowsWritten++;
      }

      totalFound += items.length;
      totalWritten += rowsWritten;

      if (newerThanBaselineCount === 0) {
        consecutiveNoNewerPages++;
      } else {
        consecutiveNoNewerPages = 0;
      }

      console.log(`  取得 ${items.length} 件 / 書込 ${rowsWritten} 件`);
      console.log(`  page最大ID: ${maxProductIdInPage.toString()}`);
      console.log(`  baseline超え: ${newerThanBaselineCount}`);
      console.log(`  baseline超え0の連続: ${consecutiveNoNewerPages}/${STOP_CONSECUTIVE_NO_NEWER_PAGE_COUNT}`);
      console.log(`  累計 取得=${totalFound} / 書込=${totalWritten}`);

      logProgress(
        pageNumber,
        searchPageUrl,
        items.length,
        rowsWritten,
        maxProductIdInPage.toString(),
        newerThanBaselineCount,
        consecutiveNoNewerPages,
        "done",
        ""
      );

      const shouldFlushByBatch =
        (pageNumber - batchStartPage + 1) >= BATCH_PAGES;

      const shouldStop =
        consecutiveNoNewerPages >= STOP_CONSECUTIVE_NO_NEWER_PAGE_COUNT;

      if (shouldFlushByBatch || shouldStop) {
        await flushBatch(
          client,
          batchNo,
          batchStartPage,
          pageNumber,
          batchFullRows,
          batchImportRows
        );

        batchNo++;
        batchStartPage = pageNumber + 1;
        batchFullRows = [];
        batchImportRows = [];
      }

      if (shouldStop) {
        console.log("\n停止条件に到達しました。");
        console.log(`最後に処理したページ: ${pageNumber}`);
        break;
      }
      // ============================================================
      // 500ページごとに長休憩
      // ============================================================

        if (
        pageNumber > START_PAGE &&
        pageNumber % REST_EVERY_PAGES === 0
        ) {
        console.log("\n" + "=".repeat(70));
        console.log(
            `${REST_EVERY_PAGES}ページ到達。`
        );
        console.log(
            `${Math.floor(REST_MS / 60000)}分休憩します。`
        );
        console.log("=".repeat(70));

        await sleep(REST_MS);
        }

      if (pageNumber < MAX_PAGE) {
        await randomDelay();
      }
    }

    if (batchFullRows.length > 0) {
      await flushBatch(
        client,
        batchNo,
        batchStartPage,
        MAX_PAGE,
        batchFullRows,
        batchImportRows
      );
    }

    console.log("\n" + "=".repeat(70));
    console.log("完了");
    console.log(`取得合計: ${totalFound}`);
    console.log(`書込合計: ${totalWritten}`);
    console.log(`master CSV : ${MASTER_CSV}`);
    console.log(`full CSV   : ${FULL_CSV}`);
    console.log(`progress   : ${PROGRESS_CSV}`);
    console.log(`error      : ${ERROR_CSV}`);
    console.log(`summary    : ${SUMMARY_CSV}`);
    console.log("=".repeat(70));
  } catch (err) {
    console.error("\n致命的エラー:", err);
    logError(0, "", `致命的エラー: ${err.message || String(err)}`);
  } finally {
    await browser.close().catch(() => {});
    await client.end().catch(() => {});
  }
})();