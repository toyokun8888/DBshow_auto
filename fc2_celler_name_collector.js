// ============================================================
//  fc2_seller_name_collector.js
//  FC2CM.com から販売者ID・販売者名の対応表を収集して CSV に出力する
//
//  【このスクリプトの目的】
//  既存の master.csv に含まれる seller_id（理論値）を
//  販売者名（物理名）に変換するための参照テーブルを作成する。
//  同一seller_idに複数の販売者名が紐づく場合もすべて収集する。
//
//  【出力ファイル】
//    sellers_YYYYMMDDHHMMSS.csv      … seller_idの一覧（重複なし）
//    seller_names_YYYYMMDDHHMMSS.csv … seller_id × 販売者名（1対多）
//    error_YYYYMMDDHHMMSS.csv        … 取得失敗ログ
//    progress_YYYYMMDDHHMMSS.csv     … 進捗ログ（途中再開用）
//
//  【実行方法】
//    node fc2_seller_name_collector.js
//
//  【途中再開の手順】
//    1. progress_*.csv の最終行を確認する
//    2. "index_path" 列の値（例: ?cl=漢字は）を確認する
//    3. 設定エリア② RESUME_FROM にその値を貼り付けて再実行する
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
//       1 … ALL モード  : ?cl=all から全販売者を自動収集する（通常はこちら）
//       0 … 個別モード  : 下の TARGET_INDEX_PATHS に指定した行のみ収集する
// ----------------------------------------------------------
const MODE = 1;

// ----------------------------------------------------------
//  ② 途中再開ポイント【ALLモード(MODE=1)専用】
//
//  ※ 通常は空欄のままでOK（最初から実行される）
//
//  途中で止まった場合の再開手順:
//    1. OUTPUT_DIR 内の progress_*.csv を開く
//    2. 最終行の "index_path" 列の値を確認する（例: ?cl=漢字は）
//    3. その値をそのまま下に貼り付けて再実行する
//       例: const RESUME_FROM = "?cl=漢字は";
//
//  ※ 指定した行（その行を含む）から処理を再開する
//  ※ 再開後は新しいタイムスタンプのCSVが作られる（後でマージが必要）
// ----------------------------------------------------------
const RESUME_FROM = ""; // 空欄 = 最初から  例: "?cl=漢字は"

// ----------------------------------------------------------
//  ③ 個別モード(MODE=0)専用：収集したい行インデックスを指定する
//
//  行インデックスの値は ?cl=all ページのリンクから確認できる
//  例) ?cl=かなは / ?cl=英字Ａ / ?cl=漢字あ
// ----------------------------------------------------------
const TARGET_INDEX_PATHS = [
  "?cl=かなは",   // ← 収集したい行インデックスをここに追加
  // "?cl=英字Ａ",
  // "?cl=漢字あ",
];

// ----------------------------------------------------------
//  ④ CSV 出力先ディレクトリ（存在しない場合は自動作成）
// ----------------------------------------------------------
const OUTPUT_DIR = "C:\\fc2_output";

// ----------------------------------------------------------
//  ⑤ アクセス間隔（ミリ秒）― ランダム幅を指定
//  ※ 短くしすぎると攻撃とみなされる可能性があるため注意
//  ※ 今回は商品詳細ページへのアクセスがないため前回より短めでも安全
// ----------------------------------------------------------
const MIN_DELAY_MS = 1500; // 最小待機時間（1.5秒）
const MAX_DELAY_MS = 4000; // 最大待機時間（4秒）

// ----------------------------------------------------------
//  ⑥ 自動停止の設定
//  ※ 行インデックス単位で連続してこの件数だけ失敗が続いたら自動停止する
// ----------------------------------------------------------
const AUTO_STOP_COUNT = 5;

// ----------------------------------------------------------
//  ⑦ リトライ設定
// ----------------------------------------------------------
const MAX_RETRY        = 2;    // ページ取得失敗時のリトライ回数
const INDEX_RETRY_MAX  = 3;    // 行が0件だった時のリトライ回数
const INDEX_RETRY_WAIT = 4000; // リトライ前の待機時間（ミリ秒）

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

const SELLERS_CSV      = path.join(OUTPUT_DIR, `sellers_${TS}.csv`);
const SELLER_NAMES_CSV = path.join(OUTPUT_DIR, `seller_names_${TS}.csv`);
const ERROR_CSV        = path.join(OUTPUT_DIR, `error_${TS}.csv`);
const PROGRESS_CSV     = path.join(OUTPUT_DIR, `progress_${TS}.csv`);

// オートナンバー用カウンター
let sellersAutoId     = 1;
let sellerNamesAutoId = 1;


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

function logProgress(indexPath, count, status, note = "") {
  const line = [
    indexPath,
    new Date().toISOString(),
    count,
    status,
    note
  ].map(esc).join(",") + "\n";
  fs.appendFileSync(PROGRESS_CSV, line, "utf8");
}

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
//  Step B: 各行ページから 販売者ID・販売者名 を収集
//
//  取得するデータ:
//    href="./?cll=seller_id"  → seller_id（理論値）
//    テキスト "販売者名（seller_id）" → seller_name（物理名）を抽出
//
//  1つの seller_id に複数の seller_name が紐づく場合もすべて収集する
//  （同じ販売者が名前を変えている場合に対応）
// ============================================================

async function fetchSellerDataFromIndex(browser, indexPath) {
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

    // 販売者ID・販売者名を同時に取得
    // テキスト例: "は〜るん（sirouto-mutimuti-kyonyu）"
    //   → seller_name: "は〜るん"
    //   → seller_id  : "sirouto-mutimuti-kyonyu"（hrefからも取れる）
    const sellerData = await page.evaluate(() => {
      return Array.from(document.querySelectorAll(".kanren_word_link a"))
        .map(a => {
          const href  = a.getAttribute("href") || "";
          const text  = a.textContent.trim();
          const idMatch = href.match(/\?cll=(.+)/);
          if (!idMatch) return null;

          // デコードできない文字（%記号など）が含まれる場合は
          // デコードせずそのままの文字列を使う
          let sellerId;
          try {
            sellerId = decodeURIComponent(idMatch[1]);
          } catch (e) {
            sellerId = idMatch[1]; // デコード失敗時はそのまま使用
          }

          // テキストから販売者名を抽出
          // "販売者名（seller_id）" の形式から名前部分だけ取り出す
          // ※ 末尾の（seller_id）を除去する
          const nameMatch = text.match(/^(.+?)（[^（）]+）$/);
          const sellerName = nameMatch ? nameMatch[1].trim() : text.trim();

          return { sellerId, sellerName };
        })
        .filter(Boolean);
    });

    await page.close();

    if (sellerData.length === 0) {
      console.log(`  ⚠️  データが0件 (${attempt}/${INDEX_RETRY_MAX}回目)`);
      if (attempt < INDEX_RETRY_MAX) {
        console.log(`  ↩️  ${INDEX_RETRY_WAIT}ms 後にリトライ...`);
        await sleep(INDEX_RETRY_WAIT);
      } else {
        console.log(`  ❌ ${INDEX_RETRY_MAX}回試行しても0件のためスキップ`);
        logError(url, `${INDEX_RETRY_MAX}回リトライ後も0件`);
      }
      continue;
    }

    console.log(`  ✅ ${sellerData.length} 件取得 (${attempt}回目で成功)`);
    return sellerData;
  }

  return [];
}


// ============================================================
//  メイン処理
// ============================================================

(async () => {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  const now = new Date().toISOString();

  // --------------------------------------------------------
  //  sellers.csv のヘッダー
  //    id          : オートナンバー（DB投入時に上書きされる想定だが列として持つ）
  //    seller_id   : 理論値（例: hamenakadashimu）← master.csv とリレーションできる
  //    index_path  : どの検索インデックスから取得したか（例: ?cl=かなは）
  //    registered_at: このCSVに登録された日時
  // --------------------------------------------------------
  fs.writeFileSync(
    SELLERS_CSV,
    ["id", "seller_id", "index_path", "registered_at"].map(esc).join(",") + "\n",
    "utf8"
  );

  // --------------------------------------------------------
  //  seller_names.csv のヘッダー
  //    id          : オートナンバー
  //    seller_id   : 理論値（sellers.seller_id と外部キーでリレーション）
  //    seller_name : 物理名（表示名）
  //    index_path  : どの検索インデックスから取得したか
  //    registered_at: このCSVに登録された日時
  // --------------------------------------------------------
  fs.writeFileSync(
    SELLER_NAMES_CSV,
    ["id", "seller_id", "seller_name", "index_path", "registered_at"].map(esc).join(",") + "\n",
    "utf8"
  );

  fs.writeFileSync(
    ERROR_CSV,
    ["url", "tried_at", "reason"].map(esc).join(",") + "\n",
    "utf8"
  );
  fs.writeFileSync(
    PROGRESS_CSV,
    // index_path  : RESUME_FROM に使う値
    // processed_at: 処理日時
    // count       : 取得件数
    // status      : done / skipped / stopped
    // note        : 補足
    ["index_path", "processed_at", "count", "status", "note"].map(esc).join(",") + "\n",
    "utf8"
  );

  console.log("=".repeat(60));
  console.log("  FC2 Seller Name Collector");
  console.log(`  モード      : ${MODE === 1 ? "ALL（全行インデックス）" : "個別指定"}`);
  if (MODE === 1 && RESUME_FROM) {
    console.log(`  再開ポイント: ${RESUME_FROM} から`);
  }
  console.log(`  出力先      : ${OUTPUT_DIR}`);
  console.log(`  自動停止    : ${AUTO_STOP_COUNT}件連続失敗で停止`);
  console.log("=".repeat(60));

  const browser = await puppeteer.launch({ headless: HEADLESS });

  // 処理済み seller_id を追跡（sellers.csv への重複書き込みを防ぐ）
  const processedSellerIds = new Set();

  let consecutiveFailCount = 0;
  let autoStopped          = false;
  let totalSellerIds       = 0;
  let totalSellerNames     = 0;

  try {

    // 行インデックスリストを準備
    let indexLinks = [];

    if (MODE === 1) {
      indexLinks = await fetchAllIndexLinks(browser);
      if (indexLinks.length === 0) {
        console.error("❌ 行インデックスが取得できませんでした。終了します。");
        return;
      }

      // RESUME_FROM が指定されている場合、その行から開始
      if (RESUME_FROM) {
        const found = indexLinks.findIndex(link => link === RESUME_FROM);
        if (found === -1) {
          console.warn(`⚠️  RESUME_FROM "${RESUME_FROM}" が見つかりませんでした。最初から実行します。`);
        } else {
          indexLinks = indexLinks.slice(found);
          console.log(`\n▶️  再開: ${RESUME_FROM} (残り ${indexLinks.length} 行) から開始`);
        }
      }
    } else {
      // 個別モード
      indexLinks = TARGET_INDEX_PATHS;
      console.log(`\n個別指定: ${indexLinks.length} 行を処理します`);
    }

    // --------------------------------------------------------
    //  各行インデックスをループ
    // --------------------------------------------------------
    for (let i = 0; i < indexLinks.length; i++) {
      const indexPath = indexLinks[i];
      console.log(`\n${"─".repeat(50)}`);
      console.log(`📂 [${i + 1}/${indexLinks.length}] ${indexPath}`);

      const sellerData = await fetchSellerDataFromIndex(browser, indexPath);

      if (sellerData.length === 0) {
        consecutiveFailCount++;
        console.log(`  ⚠️  連続失敗: ${consecutiveFailCount}/${AUTO_STOP_COUNT}`);
        logProgress(indexPath, 0, "skipped", "0件");

        if (consecutiveFailCount >= AUTO_STOP_COUNT) {
          console.log(`\n🛑 連続失敗が ${AUTO_STOP_COUNT} 件に達したため自動停止します。`);
          console.log(`\n  ▼ 途中再開する場合は設定エリア② に以下を貼り付けて再実行:`);
          console.log(`    const RESUME_FROM = "${indexPath}";`);
          logProgress(indexPath, 0, "stopped", `連続失敗${AUTO_STOP_COUNT}件で自動停止`);
          autoStopped = true;
          break;
        }

        await randomDelay();
        continue;
      }

      // 成功 → 連続失敗カウントリセット
      consecutiveFailCount = 0;

      // --------------------------------------------------------
      //  sellers.csv に書き込む（seller_id の重複を除去）
      //  seller_names.csv には全行（同一IDの複数名も含む）書き込む
      // --------------------------------------------------------
      let newSellerIds   = 0;
      let newSellerNames = 0;

      for (const { sellerId, sellerName } of sellerData) {

        // sellers.csv: seller_id が未登録の場合のみ追記
        if (!processedSellerIds.has(sellerId)) {
          processedSellerIds.add(sellerId);
          const line = [
            sellersAutoId++,  // id（オートナンバー）
            sellerId,         // seller_id（理論値）
            indexPath,        // どの行インデックスから取得したか
            now               // 登録日時
          ].map(esc).join(",") + "\n";
          fs.appendFileSync(SELLERS_CSV, line, "utf8");
          newSellerIds++;
        }

        // seller_names.csv: 全行追記（同一IDの複数名も全て記録）
        const nameLine = [
          sellerNamesAutoId++, // id（オートナンバー）
          sellerId,            // seller_id（理論値）← sellers と外部キーでリレーション
          sellerName,          // seller_name（物理名・表示名）
          indexPath,           // どの行インデックスから取得したか
          now                  // 登録日時
        ].map(esc).join(",") + "\n";
        fs.appendFileSync(SELLER_NAMES_CSV, nameLine, "utf8");
        newSellerNames++;
      }

      totalSellerIds   += newSellerIds;
      totalSellerNames += newSellerNames;

      logProgress(indexPath, sellerData.length, "done",
        `新規sellerID:${newSellerIds}件 名前:${newSellerNames}件`);

      console.log(`  📊 新規seller_id: ${newSellerIds}件 / 販売者名: ${newSellerNames}件`);
      console.log(`  📊 累計 seller_id: ${totalSellerIds}件 / 販売者名: ${totalSellerNames}件`);

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
    console.log(`  収集 seller_id   : ${totalSellerIds} 件（重複なし）`);
    console.log(`  収集 seller_name : ${totalSellerNames} 件（同一IDの複数名含む）`);
    console.log(`  sellers      → ${SELLERS_CSV}`);
    console.log(`  seller_names → ${SELLER_NAMES_CSV}`);
    console.log(`  error        → ${ERROR_CSV}`);
    console.log(`  progress     → ${PROGRESS_CSV}`);
    console.log("=".repeat(60));

  } catch (fatalErr) {
    console.error("\n❌ 致命的エラー:", fatalErr);
  } finally {
    await browser.close().catch(() => {});
  }
})();