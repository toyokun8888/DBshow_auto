// ============================================================
//  rapidgator_folder_collector.js
//  Rapidgator の folder ページからファイル一覧を収集して CSV に出力する
//
//  【目的】
//    - Rapidgator のフォルダ一覧ページを複数ページ巡回
//    - file_title / file_url / file_size / group_key などをCSV化
//    - DBへ直接INSERTしない
//    - CSVは5万件ごとに分割
//    - DB投入後にSQLでクレンジング・照合する前提
//
//  【今回追加した重要仕様】
//    - 枝番判定カラムを追加
//      part_no
//      part_label
//      part_type
//      base_title_without_part
//
//    - .part数字.拡張子 型を枝番判定
//      例:
//        FC2-PPV-1298389.part6.rar
//        heydouga4017-150-1.part02.rar
//
//    - FC2PPV系のみ、末尾 -数字.拡張子 型も枝番判定
//      例:
//        FC2-PPV-1298933-1.mp4
//        FC2PPV-4843693-2.mp4
//
//    - ただし以下は枝番扱いしない
//      例:
//        heyzo-3798.mp4
//        WANZ-227.mp4
//        MOSAIC-ARCHIVE-aarm-262.mp4
//
//  【出力ファイル】
//    rapidgator_master_YYYYMMDDHHMMSS_part001.csv
//    rapidgator_master_YYYYMMDDHHMMSS_part002.csv
//    ...
//    rapidgator_error_YYYYMMDDHHMMSS.csv
//    rapidgator_progress_YYYYMMDDHHMMSS.csv
//
//  【実行方法】
//    node rapidgator_folder_collector.js
//
//  【初回テスト推奨】
//    TEST_MODE = true
//    TEST_MAX_RECORDS = 100
// ============================================================

const fs = require("fs");
const path = require("path");

const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
puppeteer.use(StealthPlugin());

// ============================================================
//  ★★★ 設定エリア ― まずはここだけ確認 ★★★
// ============================================================

// Rapidgator のベースURL
const BASE_URL = "https://rapidgator.net";

// 対象フォルダID
const FOLDER_ID = "3330879";

// 対象フォルダ名
const FOLDER_NAME = "movie";

// 取得開始ページ
const START_PAGE = 1;

// 取得終了ページ
const END_PAGE = 1000;

// 途中再開ページ
// 通常は null
// 例: 350 から再開したい場合 → const RESUME_PAGE = 350;
const RESUME_PAGE = null;

// テストモード
// true  = TEST_MAX_RECORDS 件に達したら停止
// false = START_PAGE 〜 END_PAGE まで取得
const TEST_MODE = false;

// テスト時の最大取得件数
const TEST_MAX_RECORDS = 300;

// CSV出力先ディレクトリ
const OUTPUT_DIR = "C:\\rapidgator_output\\run_0001_1000";

// master CSV の1ファイルあたり最大行数
const MAX_ROWS_PER_CSV = 50000;

// アクセス待機時間
const MIN_DELAY_MS = 2000;
const MAX_DELAY_MS = 6000;

// ページ取得リトライ回数
const MAX_RETRY = 3;

// 一覧0件時のリトライ回数
const EMPTY_RETRY_MAX = 3;

// 一覧0件時のリトライ待機時間
const EMPTY_RETRY_WAIT_MS = 4000;

// 連続失敗で自動停止する回数
const AUTO_STOP_COUNT = 5;

// ブラウザを表示しない
// true  = 通常運用
// false = デバッグ用
const HEADLESS = true;

// ============================================================
//  内部設定
// ============================================================

const TS = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 15);

const ERROR_CSV = path.join(OUTPUT_DIR, `rapidgator_error_${TS}.csv`);
const PROGRESS_CSV = path.join(OUTPUT_DIR, `rapidgator_progress_${TS}.csv`);

const MASTER_HEADERS = [
  "global_seq",
  "csv_part_no",
  "file_seq",
  "source_page_url",
  "folder_id",
  "folder_name",
  "page_number",
  "row_index_in_page",
  "file_title",
  "file_url",
  "file_size",
  "file_ext",
  "group_key",
  "group_rule",
  "fc2_product_id",
  "part_no",
  "part_label",
  "part_type",
  "base_title_without_part",
  "collected_at"
];

const ERROR_HEADERS = [
  "page_number",
  "source_page_url",
  "global_seq",
  "csv_part_no",
  "file_seq",
  "tried_at",
  "reason"
];

const PROGRESS_HEADERS = [
  "page_number",
  "source_page_url",
  "processed_at",
  "rows_found",
  "total_global_seq",
  "csv_part_no",
  "file_seq",
  "status",
  "note"
];

// ============================================================
//  実行中カウンタ
// ============================================================

let globalSeq = 0;
let csvPartNo = 1;
let fileSeq = 0;
let currentMasterCsv = "";

// ============================================================
//  ユーティリティ
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

function esc(value) {
  return `"${String(value ?? "").replace(/"/g, '""')}"`;
}

function csvLine(values) {
  return values.map(esc).join(",") + "\n";
}

function padPartNo(num) {
  return String(num).padStart(3, "0");
}

function getMasterCsvPath(partNo) {
  return path.join(
    OUTPUT_DIR,
    `rapidgator_master_${TS}_part${padPartNo(partNo)}.csv`
  );
}

function initCsvFiles() {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  fs.writeFileSync(ERROR_CSV, csvLine(ERROR_HEADERS), "utf8");
  fs.writeFileSync(PROGRESS_CSV, csvLine(PROGRESS_HEADERS), "utf8");

  currentMasterCsv = getMasterCsvPath(csvPartNo);
  fs.writeFileSync(currentMasterCsv, csvLine(MASTER_HEADERS), "utf8");
}

function rotateMasterCsvIfNeeded() {
  if (fileSeq < MAX_ROWS_PER_CSV) return;

  csvPartNo++;
  fileSeq = 0;
  currentMasterCsv = getMasterCsvPath(csvPartNo);
  fs.writeFileSync(currentMasterCsv, csvLine(MASTER_HEADERS), "utf8");

  console.log(`  📄 CSV分割: part${padPartNo(csvPartNo)} を作成`);
}

function logError(pageNumber, sourcePageUrl, reason) {
  fs.appendFileSync(
    ERROR_CSV,
    csvLine([
      pageNumber,
      sourcePageUrl,
      globalSeq,
      csvPartNo,
      fileSeq,
      new Date().toISOString(),
      reason
    ]),
    "utf8"
  );
}

function logProgress(pageNumber, sourcePageUrl, rowsFound, status, note = "") {
  fs.appendFileSync(
    PROGRESS_CSV,
    csvLine([
      pageNumber,
      sourcePageUrl,
      new Date().toISOString(),
      rowsFound,
      globalSeq,
      csvPartNo,
      fileSeq,
      status,
      note
    ]),
    "utf8"
  );
}

function buildFolderPageUrl(pageNumber) {
  return `${BASE_URL}/folder/${FOLDER_ID}/${FOLDER_NAME}.html?page=${pageNumber}`;
}

function toAbsoluteUrl(href) {
  if (!href) return "";
  if (href.startsWith("http://") || href.startsWith("https://")) return href;
  return `${BASE_URL}${href}`;
}

function getFileExt(fileTitle) {
  const clean = String(fileTitle || "").trim();
  const match = clean.match(/\.([^.]+)$/);
  return match ? match[1].toLowerCase() : "";
}

function removeLastExtension(fileTitle) {
  return String(fileTitle || "").trim().replace(/\.[^.]+$/, "");
}

function replaceLastExtension(fileTitle, newBaseName) {
  const title = String(fileTitle || "").trim();
  const extMatch = title.match(/(\.[^.]+)$/);
  return extMatch ? `${newBaseName}${extMatch[1]}` : newBaseName;
}

// ============================================================
//  FC2PPV 判定
// ============================================================

function extractFc2ProductId(fileTitle) {
  const title = String(fileTitle || "").trim();

  // 対応例:
  //   FC2PPV-4858872.mp4
  //   fc2ppv-4858867.mp4
  //   FC2-PPV-3168228.mp4
  //   FC2_PPV_3168228.mp4
  //   FC2-PPV-1298389.part1.rar
  //   FC2-PPV-1298933-1.mp4
  const match = title.match(/^fc2[-_]?ppv[-_]?(\d+)/i);

  return match ? match[1] : "";
}

function isFc2PpvTitle(fileTitle) {
  return Boolean(extractFc2ProductId(fileTitle));
}

// ============================================================
//  枝番判定
// ============================================================

function analyzePartInfo(fileTitle, fc2ProductId) {
  const title = String(fileTitle || "").trim();
  const nameNoExt = removeLastExtension(title);

  let partNo = "";
  let partLabel = "";
  let partType = "";
  let baseTitleWithoutPart = title;

  // ----------------------------------------------------------
  // ルール1: .part数字.拡張子 型
  //
  // 対応例:
  //   FC2-PPV-1298389.part6.rar
  //   FC2-PPV-1298389.part01.rar
  //   heydouga4017-150-1.part02.rar
  //
  // 結果:
  //   part_no    = 6 / 1 / 2
  //   part_label = part6 / part01 / part02
  //   part_type  = dot_part_number
  //   base_title_without_part = FC2-PPV-1298389.rar
  // ----------------------------------------------------------
  const dotPartMatch = nameNoExt.match(/\.part(\d+)$/i);

  if (dotPartMatch) {
    const rawNo = dotPartMatch[1];

    partNo = String(parseInt(rawNo, 10));
    partLabel = `part${rawNo}`;
    partType = "dot_part_number";

    const baseName = nameNoExt.replace(/\.part\d+$/i, "");
    baseTitleWithoutPart = replaceLastExtension(title, baseName);

    return {
      partNo,
      partLabel,
      partType,
      baseTitleWithoutPart
    };
  }

  // ----------------------------------------------------------
  // ルール2: FC2PPV系のみ -数字.拡張子 型
  //
  // 対応例:
  //   FC2-PPV-1298933-1.mp4
  //   FC2PPV-4843693-2.mp4
  //
  // 非対象:
  //   heyzo-3798.mp4
  //   WANZ-227.mp4
  //   MOSAIC-ARCHIVE-aarm-262.mp4
  //
  // 条件:
  //   FC2PPV系であること
  //   fc2_product_id の直後に -数字 があること
  // ----------------------------------------------------------
  if (fc2ProductId) {
    const fc2DashPartRegex = new RegExp(
      `^(fc2[-_]?ppv[-_]?${fc2ProductId})-(\\d+)$`,
      "i"
    );

    const fc2DashPartMatch = nameNoExt.match(fc2DashPartRegex);

    if (fc2DashPartMatch) {
      const rawNo = fc2DashPartMatch[2];

      partNo = String(parseInt(rawNo, 10));
      partLabel = `-${rawNo}`;
      partType = "suffix_dash_number";

      const baseName = fc2DashPartMatch[1];
      baseTitleWithoutPart = replaceLastExtension(title, baseName);

      return {
        partNo,
        partLabel,
        partType,
        baseTitleWithoutPart
      };
    }
  }

  return {
    partNo,
    partLabel,
    partType,
    baseTitleWithoutPart
  };
}

// ============================================================
//  グルーピング推測
// ============================================================

function analyzeFileTitle(fileTitle) {
  const title = String(fileTitle || "").trim();
  const titleLower = title.toLowerCase();
  const nameNoExt = removeLastExtension(title);

  let groupKey = "";
  let groupRule = "unknown";

  const fc2ProductId = extractFc2ProductId(title);

  // ----------------------------------------------------------
  // FC2PPV / FC2-PPV 表記ゆれ対応
  // ----------------------------------------------------------
  if (fc2ProductId) {
    groupKey = "FC2PPV-";
    groupRule = "fc2ppv_special";
    return { groupKey, groupRule, fc2ProductId };
  }

  // ----------------------------------------------------------
  // MOSAIC-ARCHIVE 特殊扱い
  // ----------------------------------------------------------
  if (titleLower.startsWith("mosaic-archive-")) {
    groupKey = "MOSAIC-ARCHIVE-";
    groupRule = "prefix_known_multi_hyphen";
    return { groupKey, groupRule, fc2ProductId };
  }

  // ----------------------------------------------------------
  // 後方判定型
  // 例:
  //   030626-001-carib.mp4 → -carib
  //   030526_100-paco.mp4 → -paco
  // ----------------------------------------------------------
  if (/^\d/.test(nameNoExt)) {
    const suffixMatch = nameNoExt.match(/-([A-Za-z]+)$/);
    if (suffixMatch) {
      groupKey = `-${suffixMatch[1]}`;
      groupRule = "suffix_alpha_after_hyphen";
      return { groupKey, groupRule, fc2ProductId };
    }
  }

  // ----------------------------------------------------------
  // 前方一致型
  // 例:
  //   heyzo-3798.mp4                 → heyzo-
  //   heydouga4017-150-1.part01.rar  → heydouga4017-
  //   WANZ-227.part1.rar             → WANZ-
  // ----------------------------------------------------------
  const prefixMatch = nameNoExt.match(/^([A-Za-z][A-Za-z0-9]*-)/);
  if (prefixMatch) {
    groupKey = prefixMatch[1];
    groupRule = "prefix_alpha_hyphen";
    return { groupKey, groupRule, fc2ProductId };
  }

  return { groupKey, groupRule, fc2ProductId };
}

// ============================================================
//  Puppeteer ページ取得
// ============================================================

async function openPage(browser, url) {
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

      return page;
    } catch (err) {
      if (page) await page.close().catch(() => {});
      console.log(`  ⚠️ ページ取得失敗 ${attempt}/${MAX_RETRY}: ${err.message}`);

      if (attempt < MAX_RETRY) {
        await sleep(3000);
      }
    }
  }

  return null;
}

// ============================================================
//  1ページ分のファイル一覧取得
// ============================================================

async function fetchItemsFromPage(browser, pageNumber) {
  const sourcePageUrl = buildFolderPageUrl(pageNumber);

  for (let attempt = 1; attempt <= EMPTY_RETRY_MAX; attempt++) {
    const page = await openPage(browser, sourcePageUrl);

    if (!page) {
      logError(pageNumber, sourcePageUrl, "ページ取得失敗");

      if (attempt < EMPTY_RETRY_MAX) {
        await sleep(EMPTY_RETRY_WAIT_MS);
      }

      continue;
    }

    const items = await page.evaluate(() => {
      const rows = Array.from(document.querySelectorAll("table.items tbody tr"));

      return rows
        .map((tr, index) => {
          const a = tr.querySelector("td a");
          const sizeTd = tr.querySelector("td.td-for-select");

          if (!a) return null;

          const href = a.getAttribute("href") || "";
          const fileTitle = (a.textContent || "").trim();
          const fileSize = sizeTd ? (sizeTd.textContent || "").trim() : "";

          return {
            rowIndexInPage: index + 1,
            href,
            fileTitle,
            fileSize
          };
        })
        .filter(Boolean);
    });

    await page.close();

    if (items.length > 0) {
      return items;
    }

    console.log(`  ⚠️ 一覧0件 ${attempt}/${EMPTY_RETRY_MAX}`);

    if (attempt < EMPTY_RETRY_MAX) {
      await sleep(EMPTY_RETRY_WAIT_MS);
    } else {
      logError(pageNumber, sourcePageUrl, "一覧0件");
    }
  }

  return [];
}

// ============================================================
//  master CSV 書き込み
// ============================================================

function writeMasterRecord(pageNumber, item) {
  rotateMasterCsvIfNeeded();

  globalSeq++;
  fileSeq++;

  const sourcePageUrl = buildFolderPageUrl(pageNumber);
  const fileTitle = item.fileTitle;
  const fileUrl = toAbsoluteUrl(item.href);
  const fileSize = item.fileSize;
  const fileExt = getFileExt(fileTitle);
  const collectedAt = new Date().toISOString();

  const analyzed = analyzeFileTitle(fileTitle);
  const partInfo = analyzePartInfo(fileTitle, analyzed.fc2ProductId);

  const line = csvLine([
    globalSeq,
    csvPartNo,
    fileSeq,
    sourcePageUrl,
    FOLDER_ID,
    FOLDER_NAME,
    pageNumber,
    item.rowIndexInPage,
    fileTitle,
    fileUrl,
    fileSize,
    fileExt,
    analyzed.groupKey,
    analyzed.groupRule,
    analyzed.fc2ProductId,
    partInfo.partNo,
    partInfo.partLabel,
    partInfo.partType,
    partInfo.baseTitleWithoutPart,
    collectedAt
  ]);

  fs.appendFileSync(currentMasterCsv, line, "utf8");
}

// ============================================================
//  メイン処理
// ============================================================

(async () => {
  initCsvFiles();

  const actualStartPage = RESUME_PAGE || START_PAGE;

  console.log("=".repeat(70));
  console.log("  Rapidgator Folder Collector");
  console.log(`  対象URL      : ${BASE_URL}/folder/${FOLDER_ID}/${FOLDER_NAME}.html`);
  console.log(`  取得ページ    : ${actualStartPage} ～ ${END_PAGE}`);
  console.log(`  TEST_MODE   : ${TEST_MODE}`);
  console.log(`  TEST_MAX    : ${TEST_MAX_RECORDS}`);
  console.log(`  CSV分割      : ${MAX_ROWS_PER_CSV} 件ごと`);
  console.log(`  出力先       : ${OUTPUT_DIR}`);
  console.log("=".repeat(70));

  const browser = await puppeteer.launch({
    headless: HEADLESS
  });

  let consecutiveFailCount = 0;
  let autoStopped = false;
  let testStopped = false;

  try {
    for (let pageNumber = actualStartPage; pageNumber <= END_PAGE; pageNumber++) {
      const sourcePageUrl = buildFolderPageUrl(pageNumber);

      console.log("\n" + "─".repeat(70));
      console.log(`📄 page=${pageNumber}`);
      console.log(`URL: ${sourcePageUrl}`);

      const items = await fetchItemsFromPage(browser, pageNumber);

      if (items.length === 0) {
        consecutiveFailCount++;

        console.log(
          `  ⚠️ 取得0件 / 連続失敗 ${consecutiveFailCount}/${AUTO_STOP_COUNT}`
        );

        logProgress(
          pageNumber,
          sourcePageUrl,
          0,
          "skipped",
          "一覧0件 または取得失敗"
        );

        if (consecutiveFailCount >= AUTO_STOP_COUNT) {
          console.log(`\n🛑 連続失敗が ${AUTO_STOP_COUNT} 件に達したため停止`);

          logProgress(
            pageNumber,
            sourcePageUrl,
            0,
            "stopped",
            `連続失敗${AUTO_STOP_COUNT}件で自動停止`
          );

          autoStopped = true;
          break;
        }

        await randomDelay();
        continue;
      }

      consecutiveFailCount = 0;

      let writtenThisPage = 0;

      for (const item of items) {
        writeMasterRecord(pageNumber, item);
        writtenThisPage++;

        if (TEST_MODE && globalSeq >= TEST_MAX_RECORDS) {
          testStopped = true;
          break;
        }
      }

      logProgress(
        pageNumber,
        sourcePageUrl,
        items.length,
        "done",
        `書き込み${writtenThisPage}件`
      );

      console.log(`  ✅ 取得 ${items.length} 件 / 書き込み ${writtenThisPage} 件`);
      console.log(`  📊 累計 global_seq=${globalSeq}`);
      console.log(`  📄 現在CSV part${padPartNo(csvPartNo)} file_seq=${fileSeq}`);

      if (testStopped) {
        console.log(`\n🧪 TEST_MODE: ${TEST_MAX_RECORDS} 件に達したため停止`);
        break;
      }

      if (pageNumber < END_PAGE) {
        await randomDelay();
      }
    }

    console.log("\n" + "=".repeat(70));

    if (autoStopped) {
      console.log("  🛑 自動停止");
    } else if (testStopped) {
      console.log("  🧪 テスト停止");
    } else {
      console.log("  🎉 完了");
    }

    console.log(`  取得総数      : ${globalSeq}`);
    console.log(`  最終CSV part  : ${padPartNo(csvPartNo)}`);
    console.log(`  master出力先  : ${OUTPUT_DIR}`);
    console.log(`  error         : ${ERROR_CSV}`);
    console.log(`  progress      : ${PROGRESS_CSV}`);
    console.log("=".repeat(70));
  } catch (fatalErr) {
    console.error("\n❌ 致命的エラー:", fatalErr);

    logError(
      0,
      "",
      `致命的エラー: ${fatalErr.message || String(fatalErr)}`
    );
  } finally {
    await browser.close().catch(() => {});
  }
})();