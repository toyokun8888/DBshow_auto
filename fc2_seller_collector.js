// ============================================================
//  fc2_seller_collector.js
//  FC2CM.com から販売者ごとの商品一覧を収集して CSV に出力する
//
//  【出力ファイル】
//    master_YYYYMMDDHHMMSS.csv    … 商品ID・タイトル・販売者ID
//    error_YYYYMMDDHHMMSS.csv     … 取得失敗したURL・理由
//    progress_YYYYMMDDHHMMSS.csv  … 処理済み行インデックスの進捗ログ
//
//  【実行方法】
//    node fc2_seller_collector.js
//
//  【途中再開の手順】
//    1. progress_*.csv の最終行を確認する
//    2. その行の "index_path" 列の値（例: ?cl=漢字は）を確認する
//    3. 下の設定エリア② RESUME_FROM にその値を貼り付けて再実行する
// ============================================================

const fs    = require("fs");
const path  = require("path");
const puppeteer     = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
puppeteer.use(StealthPlugin());


// ============================================================
//  ★★★ 設定エリア ― ここだけ変更すれば動く ★★★
// ============================================================

// ----------------------------------------------------------
//  ① 動作モード
//       1 … ALL モード  : ?cl=all から全販売者を自動収集する
//       0 … 個別モード  : 下の TARGET_SELLERS に指定した販売者のみ収集する
// ----------------------------------------------------------
const MODE = 1;

// ----------------------------------------------------------
//  ② 途中再開ポイント【ALLモード(MODE=1)専用】
//
//  ※ 通常は空欄のままでOK（最初から実行される）
//
//  途中で止まった場合の再開手順:
//    1. OUTPUT_DIR 内の progress_*.csv を開く
//    2. 最終行の "index_path" 列の値を確認する
//       例: "?cl=漢字は"
//    3. その値をそのまま下の RESUME_FROM に貼り付けて再実行する
//       例: const RESUME_FROM = "?cl=漢字は";
//
//  ※ 指定した行（その行を含む）から処理を再開する
//  ※ 再開後は新しいタイムスタンプのCSVファイルが作られる
//     （再開前のファイルとは別ファイルになるため、後でマージが必要）
// ----------------------------------------------------------
const RESUME_FROM = "?cl=漢字び"; // 空欄 = 最初から  例: "?cl=漢字は"

// ----------------------------------------------------------
//  ③ 個別モード(MODE=0)専用：取得したい販売者IDをここに入力する
//
//  販売者IDの確認方法:
//    fc2cm.com/?cl=all → 任意の行 → 販売者名をクリック
//    → URLの ?cll=○○○ の ○○○ 部分がID
//
//  例) https://fc2cm.com/?cll=hamenakadashimu
//      → ID は "hamenakadashimu"
// ----------------------------------------------------------
const TARGET_SELLERS = [
  "hamenakadashimu",        // ← 販売者IDをここに追加していく
  // "onnckenkyukai",       // ← 複数指定する場合はコメントを外す
  // "sirouto-mutimuti-kyonyu",
];

// ----------------------------------------------------------
//  ④ CSV 出力先ディレクトリ（存在しない場合は自動作成）
// ----------------------------------------------------------
const OUTPUT_DIR = "G:\\fc2_output";

// ----------------------------------------------------------
//  ⑤ アクセス間隔（ミリ秒）― ランダム幅を指定
//  ※ 短くしすぎると攻撃とみなされる可能性があるため注意
// ----------------------------------------------------------
const MIN_DELAY_MS = 2000; // 最小待機時間（2秒）
const MAX_DELAY_MS = 6000; // 最大待機時間（6秒）

// ----------------------------------------------------------
//  ⑥ 自動停止の設定
//  ※ 行インデックス単位で連続してこの件数だけ失敗が続いたら自動停止する
//  ※ 実データに基づくループのため、連続失敗は異常とみなす
// ----------------------------------------------------------
const AUTO_STOP_COUNT = 5; // 連続失敗がこの件数に達したら停止

// ----------------------------------------------------------
//  ⑦ リトライ設定
// ----------------------------------------------------------
const MAX_RETRY        = 2;    // ページ取得失敗時のリトライ回数
const INDEX_RETRY_MAX  = 3;    // 行インデックスが0件だった時のリトライ回数
const INDEX_RETRY_WAIT = 4000; // 行インデックスリトライ前の待機時間（ミリ秒）

// ----------------------------------------------------------
//  ⑧ ブラウザ表示設定
//    true  … ブラウザを表示しない（通常はこちら）
//    false … ブラウザを表示する（動作確認・デバッグ時）
// ----------------------------------------------------------
const HEADLESS = true;

// ----------------------------------------------------------
//  ベースURL（変更不要）
// ----------------------------------------------------------
const BASE_URL = "https://fc2cm.com";


// ============================================================
//  内部設定（変更不要）
// ============================================================

const TS = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 15);

const MASTER_CSV   = path.join(OUTPUT_DIR, `master_${TS}.csv`);
const ERROR_CSV    = path.join(OUTPUT_DIR, `error_${TS}.csv`);
const PROGRESS_CSV = path.join(OUTPUT_DIR, `progress_${TS}.csv`);


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

function esc(value) {
  return `"${String(value ?? "").replace(/"/g, '""')}"`;
}

function logError(url, reason) {
  const line = [url, new Date().toISOString(), reason].map(esc).join(",") + "\n";
  fs.appendFileSync(ERROR_CSV, line, "utf8");
}

// 進捗をCSVに記録する
// status: "done"=成功 / "skipped"=スキップ / "stopped"=自動停止で中断
function logProgress(indexPath, sellerCount, status, note = "") {
  const line = [
    indexPath,
    new Date().toISOString(),
    sellerCount,
    status,
    note
  ].map(esc).join(",") + "\n";
  fs.appendFileSync(PROGRESS_CSV, line, "utf8");
}

// リトライ付きでページを開く
async function openPage(browser, url) {
  for (let attempt = 1; attempt <= MAX_RETRY; attempt++) {
    let page;
    try {
      page = await browser.newPage();
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
      return page;
    } catch (err) {
      if (page) await page.close().catch(() => {});
      console.log(`  ⚠️  openPage失敗 (${attempt}回目): ${err.message}`);
      if (attempt < MAX_RETRY) await sleep(3000);
      else return null;
    }
  }
}


// ============================================================
//  Step A: ?cl=all から全行インデックスURLを収集
// ============================================================

async function fetchAllIndexLinks(browser) {
  console.log("\n📋 全行インデックスを収集中...");
  const url  = `${BASE_URL}/?cl=all`;
  const page = await openPage(browser, url);

  if (!page) {
    console.error("❌ ?cl=all の取得に失敗しました");
    return [];
  }

  const links = await page.evaluate(() => {
    return Array.from(document.querySelectorAll("span.cat1 a"))
      .map(a => a.getAttribute("href"))
      .filter(href => href && href.includes("?cl="))
      .map(href => href.replace("./", ""));
  });

  await page.close();
  console.log(`  → ${links.length} 件の行インデックスを検出`);
  return links;
}


// ============================================================
//  Step B: 各行ページ(?cl=かなは 等)から販売者IDを収集
//
//  【リトライについて】
//  ページ自体は開けても中身が0件の場合がある（ロード遅延・一時エラー）
//  そのため「0件だった場合」も最大 INDEX_RETRY_MAX 回リトライする
// ============================================================

async function fetchSellerIdsFromIndex(browser, indexPath) {
  const url = `${BASE_URL}/${indexPath}`;

  for (let attempt = 1; attempt <= INDEX_RETRY_MAX; attempt++) {

    const page = await openPage(browser, url);

    if (!page) {
      console.log(`  ⚠️  ページ取得失敗 (${attempt}/${INDEX_RETRY_MAX}回目)`);
      if (attempt < INDEX_RETRY_MAX) {
        console.log(`  ↩️  ${INDEX_RETRY_WAIT}ms 後にリトライ...`);
        await sleep(INDEX_RETRY_WAIT);
      }
      continue;
    }

    const sellerIds = await page.evaluate(() => {
      return Array.from(document.querySelectorAll(".kanren_word_link a"))
        .map(a => {
          const href  = a.getAttribute("href") || "";
          const match = href.match(/\?cll=(.+)/);
          if (!match) return null;
          // デコードできない文字（%記号など）が含まれる場合は
          // デコードせずそのままの文字列を使う
          try {
            return decodeURIComponent(match[1]);
          } catch (e) {
            return match[1]; // デコード失敗時はそのまま使用
          }
        })
        .filter(Boolean);
    });

    await page.close();

    if (sellerIds.length === 0) {
      console.log(`  ⚠️  販売者IDが0件 (${attempt}/${INDEX_RETRY_MAX}回目)`);
      if (attempt < INDEX_RETRY_MAX) {
        console.log(`  ↩️  ${INDEX_RETRY_WAIT}ms 後にリトライ...`);
        await sleep(INDEX_RETRY_WAIT);
      } else {
        console.log(`  ❌ ${INDEX_RETRY_MAX}回試行しても0件のためスキップ`);
        logError(url, `${INDEX_RETRY_MAX}回リトライ後も販売者ID0件`);
      }
      continue;
    }

    const unique = [...new Set(sellerIds)];
    console.log(`  ✅ ${unique.length} 件の販売者IDを取得 (${attempt}回目で成功)`);
    return unique;
  }

  return [];
}


// ============================================================
//  Step C: ?cll=販売者ID から商品一覧（品番・タイトル）を収集
// ============================================================

async function fetchProductsFromSeller(browser, sellerId) {
  const url  = `${BASE_URL}/?cll=${encodeURIComponent(sellerId)}`;
  const page = await openPage(browser, url);

  if (!page) {
    logError(url, "販売者ページの取得失敗");
    return [];
  }

  const products = await page.evaluate((sid) => {
    return Array.from(document.querySelectorAll(".kanren_word_link a"))
      .map(a => {
        const href   = a.getAttribute("href") || "";
        const text   = a.textContent.trim();
        const pMatch = href.match(/\?p=(\d+)/);
        if (!pMatch) return null;

        const productId = pMatch[1];
        const title     = text.replace(/^\d+[\s　]+/, "").trim();
        return { productId, title, sellerId: sid };
      })
      .filter(Boolean);
  }, sellerId);

  await page.close();
  return products;
}


// ============================================================
//  メイン処理
// ============================================================

(async () => {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  // CSVヘッダー書き込み（新規作成）
  fs.writeFileSync(
    MASTER_CSV,
    ["product_id", "title", "seller_id"].map(esc).join(",") + "\n",
    "utf8"
  );
  fs.writeFileSync(
    ERROR_CSV,
    ["url", "tried_at", "reason"].map(esc).join(",") + "\n",
    "utf8"
  );
  fs.writeFileSync(
    PROGRESS_CSV,
    // index_path   : 処理した行インデックス（例: ?cl=漢字は）← RESUME_FROM に使う値
    // processed_at : 処理日時
    // seller_count : その行で取得できた販売者ID数
    // status       : done=完了 / skipped=スキップ / stopped=自動停止
    // note         : 補足メモ（商品数・エラー数など）
    ["index_path", "processed_at", "seller_count", "status", "note"].map(esc).join(",") + "\n",
    "utf8"
  );

  console.log("=".repeat(60));
  console.log("  FC2 Seller Collector");
  console.log(`  モード      : ${MODE === 1 ? "ALL（全販売者）" : "個別指定"}`);
  if (MODE === 1 && RESUME_FROM) {
    console.log(`  再開ポイント: ${RESUME_FROM} から`);
  }
  if (MODE === 0) {
    console.log(`  対象販売者  : ${TARGET_SELLERS.join(", ")}`);
  }
  console.log(`  出力先      : ${OUTPUT_DIR}`);
  console.log(`  自動停止    : ${AUTO_STOP_COUNT}件連続失敗で停止`);
  console.log("=".repeat(60));

  const browser = await puppeteer.launch({ headless: HEADLESS });

  // 連続失敗カウンター（行インデックス単位でカウント）
  let consecutiveFailCount = 0;
  let autoStopped          = false;

  try {

    // --------------------------------------------------------
    //  個別モード
    // --------------------------------------------------------
    if (MODE === 0) {
      let totalProducts = 0;
      let errorCount    = 0;

      for (let i = 0; i < TARGET_SELLERS.length; i++) {
        const sellerId = TARGET_SELLERS[i];
        console.log(`\n[${i + 1}/${TARGET_SELLERS.length}] 販売者: ${sellerId}`);

        const products = await fetchProductsFromSeller(browser, sellerId);

        if (products.length === 0) {
          console.log(`  ⚠️  商品が取得できませんでした`);
          logError(`${BASE_URL}/?cll=${sellerId}`, "商品0件 または取得失敗");
          errorCount++;
          consecutiveFailCount++;
          console.log(`  ⚠️  連続失敗: ${consecutiveFailCount}/${AUTO_STOP_COUNT}`);

          // 個別モードでも自動停止チェック
          if (consecutiveFailCount >= AUTO_STOP_COUNT) {
            console.log(`\n🛑 連続失敗が ${AUTO_STOP_COUNT} 件に達したため自動停止します。`);
            autoStopped = true;
            break;
          }
        } else {
          for (const p of products) {
            const line = [p.productId, p.title, p.sellerId].map(esc).join(",") + "\n";
            fs.appendFileSync(MASTER_CSV, line, "utf8");
          }
          totalProducts        += products.length;
          consecutiveFailCount  = 0; // 成功したらリセット
          console.log(`  ✅ ${products.length} 件取得`);
        }

        if (i < TARGET_SELLERS.length - 1) await randomDelay();
      }

      console.log("\n" + "=".repeat(60));
      console.log(`  ${autoStopped ? "🛑 自動停止" : "🎉 完了"}（個別モード）`);
      console.log(`  取得商品数: ${totalProducts} 件 / エラー: ${errorCount} 件`);
      console.log(`  master → ${MASTER_CSV}`);
      console.log(`  error  → ${ERROR_CSV}`);
      console.log("=".repeat(60));
      return;
    }

    // --------------------------------------------------------
    //  ALL モード
    // --------------------------------------------------------

    // Step A: 全行インデックスを取得
    const indexLinks = await fetchAllIndexLinks(browser);
    if (indexLinks.length === 0) {
      console.error("❌ 行インデックスが取得できませんでした。終了します。");
      return;
    }

    // RESUME_FROM が指定されている場合、その行から開始するようスキップ
    let startIndex = 0;
    if (RESUME_FROM) {
      const found = indexLinks.findIndex(link => link === RESUME_FROM);
      if (found === -1) {
        console.warn(`⚠️  RESUME_FROM "${RESUME_FROM}" が行インデックスに見つかりませんでした。最初から実行します。`);
      } else {
        startIndex = found;
        console.log(`\n▶️  再開: [${startIndex + 1}/${indexLinks.length}] ${RESUME_FROM} から開始`);
      }
    }

    let totalProducts = 0;
    let totalSellers  = 0;
    let totalErrors   = 0;

    // Step B + C: 各行インデックスをループ
    for (let i = startIndex; i < indexLinks.length; i++) {
      const indexPath = indexLinks[i];
      console.log(`\n${"─".repeat(50)}`);
      console.log(`📂 [${i + 1}/${indexLinks.length}] ${indexPath}`);

      // Step B: 販売者IDを収集
      const sellerIds = await fetchSellerIdsFromIndex(browser, indexPath);

      if (sellerIds.length === 0) {
        // リトライしても0件 → この行はスキップ・連続失敗カウントを増やす
        consecutiveFailCount++;
        console.log(`  ⚠️  連続失敗: ${consecutiveFailCount}/${AUTO_STOP_COUNT}`);
        logProgress(indexPath, 0, "skipped", "販売者ID0件");

        // 自動停止チェック
        if (consecutiveFailCount >= AUTO_STOP_COUNT) {
          console.log(`\n🛑 連続失敗が ${AUTO_STOP_COUNT} 件に達したため自動停止します。`);
          console.log(`\n  ▼ 途中再開する場合は以下を設定エリア②に貼り付けて再実行:`);
          console.log(`    const RESUME_FROM = "${indexPath}";`);
          logProgress(indexPath, 0, "stopped", `連続失敗${AUTO_STOP_COUNT}件で自動停止`);
          autoStopped = true;
          break;
        }

        await randomDelay();
        continue;
      }

      // 成功 → 連続失敗カウントをリセット
      consecutiveFailCount = 0;

      // Step C: 各販売者の商品一覧を収集
      let lineProducts = 0;
      let lineErrors   = 0;

      for (let j = 0; j < sellerIds.length; j++) {
        const sellerId = sellerIds[j];
        console.log(`  [販売者 ${j + 1}/${sellerIds.length}] ${sellerId}`);

        const products = await fetchProductsFromSeller(browser, sellerId);

        if (products.length === 0) {
          logError(`${BASE_URL}/?cll=${sellerId}`, "商品0件 または取得失敗");
          lineErrors++;
          console.log(`    ⚠️  0件`);
        } else {
          for (const p of products) {
            const line = [p.productId, p.title, p.sellerId].map(esc).join(",") + "\n";
            fs.appendFileSync(MASTER_CSV, line, "utf8");
          }
          lineProducts += products.length;
          console.log(`    ✅ ${products.length} 件`);
        }

        if (j < sellerIds.length - 1) await randomDelay();
      }

      // この行の処理完了を進捗ファイルに記録
      logProgress(indexPath, sellerIds.length, "done", `商品${lineProducts}件 エラー${lineErrors}件`);

      totalProducts += lineProducts;
      totalSellers  += sellerIds.length;
      totalErrors   += lineErrors;

      console.log(`  📊 小計: 販売者${sellerIds.length} / 商品${lineProducts} / エラー${lineErrors}`);
      console.log(`  📊 累計: 販売者${totalSellers} / 商品${totalProducts}`);

      if (i < indexLinks.length - 1) await randomDelay();
    }

    // --------------------------------------------------------
    //  完了サマリー
    // --------------------------------------------------------
    console.log("\n" + "=".repeat(60));
    if (autoStopped) {
      console.log("  🛑 自動停止（連続失敗検知）");
      console.log("  途中再開: 設定エリア② RESUME_FROM に止まった行の値を設定して再実行");
    } else {
      console.log("  🎉 全件完了");
    }
    console.log(`  処理販売者数: ${totalSellers} 件`);
    console.log(`  取得商品数  : ${totalProducts} 件`);
    console.log(`  エラー      : ${totalErrors} 件`);
    console.log(`  master   → ${MASTER_CSV}`);
    console.log(`  error    → ${ERROR_CSV}`);
    console.log(`  progress → ${PROGRESS_CSV}`);
    console.log("=".repeat(60));

  } catch (fatalErr) {
    console.error("\n❌ 致命的エラー:", fatalErr);
  } finally {
    await browser.close().catch(() => {});
  }
})();