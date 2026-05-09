// file_move_and_csv_with_fc2cm_fullcsv_unclassified_header.js
const fs = require("fs");
const path = require("path");
const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
puppeteer.use(StealthPlugin());

// ===== 設定 =====
const TARGET_DIR = "G:\\all";
const DEST_BASE_DIR = "G:\\all_fc2";
const UNCLASSIFIED = "_未分類";
const MIN_DELAY_MS = 1000;
const MAX_DELAY_MS = 5000;
const HEADLESS = true;

// ===== CSV ファイル名にタイムスタンプ追加 =====
const timestamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 15);
const LOG_FILE = path.join(DEST_BASE_DIR, `fc2_log_${timestamp}.csv`);

// ===== ユーティリティ =====
function sleep(ms) { return new Promise(res => setTimeout(res, ms)); }
async function randomDelayWithLog() {
  const ms = Math.floor(Math.random() * (MAX_DELAY_MS - MIN_DELAY_MS + 1)) + MIN_DELAY_MS;
  console.log(`⏳ 次回リクエストまで ${ms}ms 待機...`);
  await sleep(ms);
}
function sanitizeForPath(str) { return String(str).replace(/[\\/:*?"<>|]/g, "_").trim(); }
function uniquePath(p) {
  const ext = path.extname(p);
  const base = p.slice(0, -ext.length);
  let i = 1, newPath = p;
  while (fs.existsSync(newPath)) { newPath = `${base}(${i})${ext}`; i++; }
  return newPath;
}
function getAllMp4Files(dir) {
  let results = [];
  const list = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of list) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) results = results.concat(getAllMp4Files(full));
    else if (entry.isFile() && path.extname(entry.name).toLowerCase() === ".mp4") results.push(full);
  }
  return results;
}

// ===== タイトル文字列から番号と枝番を抽出 =====
function extractNumberAndBranch(title) {
  const numMatch = title.match(/^FC2[\s\-]?PPV\s*(\d{7})/i);
  const number = numMatch ? numMatch[1] : null;
  const branchMatch = title.match(/([_-]\d{1,2})$/);
  const branch = branchMatch ? branchMatch[1] : "";
  return { number, branch };
}

// ===== fc2cm からタイトルと販売者を取得 =====
async function fetchFc2cmData(browser, number) {
  const url = `https://fc2cm.com/?p=${number}`;
  let title = null;
  let seller = null;
  let page;
  try {
    page = await browser.newPage();
    await page.goto(url, { waitUntil: "domcontentloaded" });
    const t = await page.$eval("h1.entry-title", el => el.textContent.trim()).catch(() => null);
    if (t) title = t;
    const s = await page.$eval("h2 a[rel='category']", el => el.textContent.trim()).catch(() => null);
    if (s) seller = s;
  } catch (err) {
    console.error(`⚠️ fc2cm取得エラー(${number}):`, err.message);
  } finally {
    if (page) await page.close();
  }
  return { title, seller };
}

// ===== CSV エスケープ =====
function csvEscape(value) { return `"${String(value || "").replace(/"/g, '""')}"`; }

// ===== メイン処理 =====
(async () => {
  fs.mkdirSync(DEST_BASE_DIR, { recursive: true });
  const files = getAllMp4Files(TARGET_DIR);
  console.log(`🔎 MP4 ファイル ${files.length} 件を検出`);

  // CSVヘッダー出力
  const header = [
    "OldPath",
    "NewPath",
    "OldFileName",
    "NewFileName",
    "Number",
    "URL",
    "Title",
    "Seller",
    "Action"
  ].join(",") + "\n";
  fs.writeFileSync(LOG_FILE, header, "utf8");

  const browser = await puppeteer.launch({ headless: HEADLESS });

  try {
    for (const oldPath of files) {
      const oldName = path.basename(oldPath);
      const { number, branch } = extractNumberAndBranch(oldName);

      await randomDelayWithLog();

      let title = null;
      let sellerValid = false;
      let seller = UNCLASSIFIED;
      let action = "Skipped";
      let newName = oldName;
      let destPath = oldPath;
      let url = number ? `https://fc2cm.com/?p=${number}` : "";

      if (number) {
        const data = await fetchFc2cmData(browser, number);
        title = data.title;
        if (data.seller) {
          seller = sanitizeForPath(data.seller);
          sellerValid = true;
        }
      }

      // タイトルがある場合のみリネーム
      if (title) {
        const destFolder = sellerValid ? seller : UNCLASSIFIED;
        newName = sanitizeForPath(title) + branch + path.extname(oldPath);
        destPath = uniquePath(path.join(DEST_BASE_DIR, destFolder, newName));

        fs.mkdirSync(path.dirname(destPath), { recursive: true });
        try { fs.renameSync(oldPath, destPath); action = "Moved+Renamed"; }
        catch (err) { console.error(`⚠️ 移動失敗: ${oldPath}`, err.message); action = "Error"; }
      } else {
        // タイトルが取得できない場合は元ファイル名で未分類フォルダに移動
        destPath = uniquePath(path.join(DEST_BASE_DIR, UNCLASSIFIED, oldName));
        fs.mkdirSync(path.dirname(destPath), { recursive: true });
        try { fs.renameSync(oldPath, destPath); action = "Moved"; }
        catch (err) { console.error(`⚠️ 移動失敗: ${oldPath}`, err.message); action = "Error"; }
      }

      // CSV ログ
      const line = [
        oldPath,
        destPath,
        oldName,
        newName,
        number || "",
        url,
        title || "",
        seller,
        action
      ].map(csvEscape).join(",") + "\n";

      fs.appendFileSync(LOG_FILE, line, "utf8");
      console.log(`✅ ${oldName} → ${newName} / ${sellerValid ? seller : UNCLASSIFIED} (${action})`);
    }

    console.log("\n🎉 完了：ログ => " + LOG_FILE);
  } catch (e) {
    console.error("❌ 処理中エラー:", e);
  } finally {
    await browser.close().catch(() => {});
  }
})();

