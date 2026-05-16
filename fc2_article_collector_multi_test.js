// ============================================================
// fc2_article_collector_multi_test.js
// FC2 search page 複数ページ取得テスト版
//
// 目的:
// - page=START_PAGE ～ END_PAGE を連続取得
// - DBには書き込まない
// - CSVを2種類出力
//   1) master投入用: product_id,title,seller_id
//   2) 完全版: xxx_tm006_fc2_article_master_full と同じ列
// ============================================================

const fs = require("fs");
const path = require("path");

const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
puppeteer.use(StealthPlugin());

// ============================================================
// 設定エリア
// ============================================================

const BASE_URL = "https://adult.contents.fc2.com";

// まずは 1 ～ 5 でテスト
const START_PAGE = 1;
const END_PAGE = 5;

// CSV出力先
const OUTPUT_DIR = "C:\\fc2_article_output\\multi_test";

// true = ブラウザ非表示
// false = ブラウザ表示
const HEADLESS = true;

// ページ表示後の固定待機
const PAGE_WAIT_MS = 3000;

// ページ間ランダム待機
const MIN_DELAY_MS = 2000;
const MAX_DELAY_MS = 6000;

// ページ取得リトライ回数
const MAX_RETRY = 3;

// 0件ページが連続したら停止
const AUTO_STOP_EMPTY_COUNT = 3;

// ============================================================
// 内部設定
// ============================================================

const TS = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 15);

const MASTER_CSV = path.join(
  OUTPUT_DIR,
  `fc2_article_master_import_${TS}.csv`
);

const FULL_CSV = path.join(
  OUTPUT_DIR,
  `fc2_article_master_full_${TS}.csv`
);

const PROGRESS_CSV = path.join(
  OUTPUT_DIR,
  `fc2_article_progress_${TS}.csv`
);

const ERROR_CSV = path.join(
  OUTPUT_DIR,
  `fc2_article_error_${TS}.csv`
);

const MASTER_HEADERS = [
  "product_id",
  "title",
  "seller_id"
];

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
  "status",
  "note"
];

const ERROR_HEADERS = [
  "page_number",
  "search_page_url",
  "tried_at",
  "reason"
];

// ============================================================
// CSV utility
// ============================================================

function esc(value) {
  return `"${String(value ?? "").replace(/"/g, '""')}"`;
}

function csvLine(values) {
  return values.map(esc).join(",") + "\n";
}

function initCsvFiles() {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  fs.writeFileSync(MASTER_CSV, csvLine(MASTER_HEADERS), "utf8");
  fs.writeFileSync(FULL_CSV, csvLine(FULL_HEADERS), "utf8");
  fs.writeFileSync(PROGRESS_CSV, csvLine(PROGRESS_HEADERS), "utf8");
  fs.writeFileSync(ERROR_CSV, csvLine(ERROR_HEADERS), "utf8");
}

function appendCsv(filePath, values) {
  fs.appendFileSync(filePath, csvLine(values), "utf8");
}

function logProgress(pageNumber, searchPageUrl, rowsFound, rowsWritten, status, note = "") {
  appendCsv(PROGRESS_CSV, [
    pageNumber,
    searchPageUrl,
    new Date().toISOString(),
    rowsFound,
    rowsWritten,
    status,
    note
  ]);
}

function logError(pageNumber, searchPageUrl, reason) {
  appendCsv(ERROR_CSV, [
    pageNumber,
    searchPageUrl,
    new Date().toISOString(),
    reason
  ]);
}

// ============================================================
// utility
// ============================================================

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function randomDelay() {
  const ms =
    Math.floor(Math.random() * (MAX_DELAY_MS - MIN_DELAY_MS + 1)) +
    MIN_DELAY_MS;

  console.log(`  ⏳ ${ms}ms 待機...`);
  await sleep(ms);
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
  const text = String(href || "");
  const match = text.match(/\/article\/(\d+)\/?/);
  return match ? match[1] : "";
}

function extractSellerIdFromSellerHref(href) {
  const text = String(href || "");
  const match = text.match(/\/users\/([^/]+)\/?/);
  return match ? match[1] : "";
}

function parsePricePt(priceText) {
  const clean = String(priceText || "").replace(/[^\d]/g, "");
  return clean ? Number(clean) : null;
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
        `  ⚠️ page=${pageNumber} 取得失敗 ${attempt}/${MAX_RETRY}: ${err.message}`
      );

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
    logError(pageNumber, searchPageUrl, "ページ取得失敗");
    return [];
  }

  try {
    const items = await page.evaluate(() => {
      const cards = Array.from(
        document.querySelectorAll("div.c-cntCard-110-f")
      );

      return cards
        .map((card, index) => {
          const titleA = card.querySelector("a.c-cntCard-110-f_itemName");
          const sellerA = card.querySelector("span.c-cntCard-110-f_seller a");
          const priceSpan = card.querySelector("span.c-cntCard-110-f_price");

          if (!titleA) return null;

          const href = titleA.getAttribute("href") || "";

          const title =
            titleA.getAttribute("title") ||
            (titleA.textContent || "").trim();

          const sellerHref = sellerA
            ? sellerA.getAttribute("href") || ""
            : "";

          const sellerName = sellerA
            ? (sellerA.textContent || "").trim()
            : "";

          const priceText = priceSpan
            ? (priceSpan.textContent || "").trim()
            : "";

          return {
            rowIndexInPage: index + 1,
            href,
            title,
            sellerHref,
            sellerName,
            priceText
          };
        })
        .filter(Boolean);
    });

    return items;
  } finally {
    await page.close().catch(() => {});
  }
}

// ============================================================
// CSV write
// ============================================================

function writeItem(pageNumber, item) {
  const searchPageUrl = buildSearchPageUrl(pageNumber);
  const collectedAt = new Date().toISOString();

  const productId = extractProductIdFromArticleHref(item.href);
  const sellerId = extractSellerIdFromSellerHref(item.sellerHref);
  const articleUrl = toAbsoluteUrl(item.href);
  const pricePt = parsePricePt(item.priceText);

  if (!productId) {
    return false;
  }

  appendCsv(MASTER_CSV, [
    productId,
    item.title,
    sellerId
  ]);

  appendCsv(FULL_CSV, [
    productId,
    item.title,
    sellerId,
    item.sellerName,
    item.priceText,
    pricePt ?? "",
    articleUrl,
    searchPageUrl,
    pageNumber,
    item.rowIndexInPage,
    collectedAt
  ]);

  return true;
}

// ============================================================
// main
// ============================================================

(async () => {
  initCsvFiles();

  console.log("=".repeat(70));
  console.log("FC2 Article Collector MULTI TEST");
  console.log(`取得ページ : ${START_PAGE} ～ ${END_PAGE}`);
  console.log(`出力先     : ${OUTPUT_DIR}`);
  console.log(`master CSV : ${MASTER_CSV}`);
  console.log(`full CSV   : ${FULL_CSV}`);
  console.log("=".repeat(70));

  const browser = await puppeteer.launch({
    headless: HEADLESS
  });

  let totalFound = 0;
  let totalWritten = 0;
  let emptyCount = 0;

  try {
    for (let pageNumber = START_PAGE; pageNumber <= END_PAGE; pageNumber++) {
      const searchPageUrl = buildSearchPageUrl(pageNumber);

      console.log("\n" + "─".repeat(70));
      console.log(`📄 page=${pageNumber}`);
      console.log(`URL: ${searchPageUrl}`);

      const items = await fetchItemsFromPage(browser, pageNumber);

      const rowsFound = items.length;
      let rowsWritten = 0;

      if (rowsFound === 0) {
        emptyCount++;

        console.log(
          `  ⚠️ 0件 / 連続0件 ${emptyCount}/${AUTO_STOP_EMPTY_COUNT}`
        );

        logProgress(
          pageNumber,
          searchPageUrl,
          0,
          0,
          "empty",
          "取得0件"
        );

        if (emptyCount >= AUTO_STOP_EMPTY_COUNT) {
          console.log("  🛑 連続0件のため停止");
          break;
        }

        await randomDelay();
        continue;
      }

      emptyCount = 0;

      for (const item of items) {
        const ok = writeItem(pageNumber, item);

        if (ok) {
          rowsWritten++;
        } else {
          logError(
            pageNumber,
            searchPageUrl,
            `product_id取得不可 row=${item.rowIndexInPage}`
          );
        }
      }

      totalFound += rowsFound;
      totalWritten += rowsWritten;

      console.log(`  ✅ 取得 ${rowsFound} 件 / CSV書込 ${rowsWritten} 件`);
      console.log(`  📊 累計 取得=${totalFound} / 書込=${totalWritten}`);

      logProgress(
        pageNumber,
        searchPageUrl,
        rowsFound,
        rowsWritten,
        "done",
        ""
      );

      if (pageNumber < END_PAGE) {
        await randomDelay();
      }
    }

    console.log("\n" + "=".repeat(70));
    console.log("完了");
    console.log(`取得合計 : ${totalFound}`);
    console.log(`書込合計 : ${totalWritten}`);
    console.log(`master CSV : ${MASTER_CSV}`);
    console.log(`full CSV   : ${FULL_CSV}`);
    console.log(`progress   : ${PROGRESS_CSV}`);
    console.log(`error      : ${ERROR_CSV}`);
    console.log("=".repeat(70));
  } catch (fatalErr) {
    console.error("致命的エラー:", fatalErr);
  } finally {
    await browser.close().catch(() => {});
  }
})();