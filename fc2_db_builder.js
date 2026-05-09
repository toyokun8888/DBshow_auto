// ============================================================
//  fc2_db_builder.js
//  FC2CM からデータを収集して CSV に出力するスクリプト
// ============================================================

const fs = require("fs");
const path = require("path");
const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
puppeteer.use(StealthPlugin());

// ============================================================
//  ★★★ 設定エリア ― ここだけ変更すれば動く ★★★
// ============================================================

// 取得する品番の範囲（少量ずつ分割して実行することを推奨）
const START_NUMBER = 690512; // 開始品番
const END_NUMBER   = 695000; // 終了品番（この番号を含む）

// CSV 出力先ディレクトリ（存在しない場合は自動作成）
const OUTPUT_DIR = "C:\\fc2_output";

// アクセス間隔（ミリ秒）― ランダム幅を指定
const MIN_DELAY_MS = 3000; // 最小待機時間
const MAX_DELAY_MS = 7000; // 最大待機時間

// リトライ設定
const MAX_RETRY = 3; // 失敗時の最大試行回数（初回 + リトライ）

// ブラウザをウィンドウ表示するか（true=表示しない / false=表示する）
const HEADLESS = true;

// ============================================================
//  内部設定（変更不要）
// ============================================================

// タイムスタンプ（ファイル名用）
const TS = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 15);

const MASTER_CSV = path.join(OUTPUT_DIR, `master_${TS}.csv`);
const TAGS_CSV   = path.join(OUTPUT_DIR, `tags_${TS}.csv`);
const ERROR_CSV  = path.join(OUTPUT_DIR, `error_${TS}.csv`);

// ============================================================
//  ユーティリティ
// ============================================================

function sleep(ms) {
  return new Promise(res => setTimeout(res, ms));
}

async function randomDelay() {
  const ms = Math.floor(Math.random() * (MAX_DELAY_MS - MIN_DELAY_MS + 1)) + MIN_DELAY_MS;
  console.log(`  ⏳ ${ms}ms 待機...`);
  await sleep(ms);
}

// CSV 用のエスケープ（ダブルクォートで囲み、内部の " を "" にする）
function esc(value) {
  return `"${String(value ?? "").replace(/"/g, '""')}"`;
}

// ============================================================
//  fc2cm.com からデータを取得
// ============================================================

async function fetchData(browser, number) {
  const url = `https://fc2cm.com/?p=${number}`;
  let page;

  try {
    page = await browser.newPage();

    // タイムアウトを30秒に設定
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });

    // --- タイトル ---
    // <h1 class="entry-title"> のテキスト
    const title = await page.$eval(
      "h1.entry-title",
      el => el.textContent.trim()
    ).catch(() => null);

    // タイトルが取れない = ページ自体が存在しない or エラー
    if (!title) return null;

    // --- 商品ID ---
    // <table> 内の「商品ID」行の <h2> テキスト
    const productId = await page.evaluate(() => {
      const rows = document.querySelectorAll("table tr");
      for (const row of rows) {
        const label = row.querySelector("td p");
        if (label && label.textContent.trim() === "商品ID") {
          const h2 = row.querySelector("h2");
          return h2 ? h2.textContent.trim() : null;
        }
      }
      return null;
    });

    // --- 販売者 ---
    // 「販売者」行の <h2><a rel="category"> テキスト
    const seller = await page.evaluate(() => {
      const rows = document.querySelectorAll("table tr");
      for (const row of rows) {
        const label = row.querySelector("td p");
        if (label && label.textContent.trim() === "販売者") {
          const a = row.querySelector("a[rel='category']");
          return a ? a.textContent.trim() : null;
        }
      }
      return null;
    });

    // --- 販売日 ---
    // 「販売日」行の <p> テキスト（例: 2025-06-02）
    const saleDate = await page.evaluate(() => {
      const rows = document.querySelectorAll("table tr");
      for (const row of rows) {
        const label = row.querySelector("td p");
        if (label && label.textContent.trim() === "販売日") {
          // 同じ行の 3列目 <p>
          const tds = row.querySelectorAll("td");
          if (tds[2]) {
            const p = tds[2].querySelector("p");
            return p ? p.textContent.trim() : null;
          }
        }
      }
      return null;
    });

    // --- タグ ---
    // 「タグ」行の <h5><a rel="tag"> を複数取得
    const tags = await page.evaluate(() => {
      const rows = document.querySelectorAll("table tr");
      for (const row of rows) {
        const label = row.querySelector("td p");
        if (label && label.textContent.trim() === "タグ") {
          const anchors = row.querySelectorAll("a[rel='tag']");
          return Array.from(anchors).map(a => a.textContent.trim());
        }
      }
      return [];
    });

    return { title, productId, seller, saleDate, tags };

  } catch (err) {
    return { error: err.message };
  } finally {
    if (page) await page.close().catch(() => {});
  }
}

// ============================================================
//  メイン処理
// ============================================================

(async () => {
  // 出力ディレクトリ作成
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  // CSV ヘッダーを書き込む（新規作成）
  fs.writeFileSync(
    MASTER_CSV,
    ["product_id", "seller", "sale_date", "title"].map(esc).join(",") + "\n",
    "utf8"
  );
  fs.writeFileSync(
    TAGS_CSV,
    ["product_id", "tag"].map(esc).join(",") + "\n",
    "utf8"
  );
  fs.writeFileSync(
    ERROR_CSV,
    ["number", "tried_at", "reason"].map(esc).join(",") + "\n",
    "utf8"
  );

  console.log("=".repeat(60));
  console.log(`  FC2 DB Builder`);
  console.log(`  範囲: ${START_NUMBER} 〜 ${END_NUMBER}`);
  console.log(`  出力: ${OUTPUT_DIR}`);
  console.log("=".repeat(60));

  const browser = await puppeteer.launch({ headless: HEADLESS });
  let successCount = 0;
  let errorCount = 0;

  try {
    for (let num = START_NUMBER; num <= END_NUMBER; num++) {
      console.log(`\n[${num}] アクセス中...`);

      let result = null;
      let lastError = "";

      // リトライループ（最大 MAX_RETRY 回）
      for (let attempt = 1; attempt <= MAX_RETRY; attempt++) {
        if (attempt > 1) {
          console.log(`  ↩️  リトライ ${attempt}回目...`);
          await sleep(3000); // リトライ前に少し待つ
        }

        result = await fetchData(browser, num);

        // null = ページなし、error プロパティあり = 通信エラー
        if (result && !result.error) break;

        lastError = result?.error ?? "ページにデータなし";
        console.log(`  ⚠️  取得失敗 (${attempt}回目): ${lastError}`);
        result = null;
      }

      if (!result) {
        // 全試行失敗 → エラーログに記録してスキップ
        const errLine = [
          num,
          new Date().toISOString(),
          lastError
        ].map(esc).join(",") + "\n";
        fs.appendFileSync(ERROR_CSV, errLine, "utf8");
        errorCount++;
        console.log(`  ❌ スキップ: ${num}`);
      } else {
        // マスター CSV に追記
        const masterLine = [
          result.productId ?? num,
          result.seller    ?? "",
          result.saleDate  ?? "",
          result.title     ?? ""
        ].map(esc).join(",") + "\n";
        fs.appendFileSync(MASTER_CSV, masterLine, "utf8");

        // タグ CSV に追記（タグの数だけ行が増える）
        for (const tag of result.tags) {
          const tagLine = [
            result.productId ?? num,
            tag
          ].map(esc).join(",") + "\n";
          fs.appendFileSync(TAGS_CSV, tagLine, "utf8");
        }

        successCount++;
        console.log(`  ✅ 取得成功: ${result.title} / タグ${result.tags.length}件`);
      }

      // 最終番号以外はランダム待機
      if (num < END_NUMBER) await randomDelay();
    }

  } catch (fatalErr) {
    console.error("\n❌ 致命的エラー:", fatalErr);
  } finally {
    await browser.close().catch(() => {});
  }

  // 完了サマリー
  console.log("\n" + "=".repeat(60));
  console.log(`  完了`);
  console.log(`  成功: ${successCount} 件 / 失敗: ${errorCount} 件`);
  console.log(`  master → ${MASTER_CSV}`);
  console.log(`  tags   → ${TAGS_CSV}`);
  console.log(`  error  → ${ERROR_CSV}`);
  console.log("=".repeat(60));
})();
