// file_move_and_csv_with_fc2cm.js
// - MP4 を再帰走査
// - ファイル名から7桁番号＋枝番(_1/-2等)を抽出
// - Puppeteerでjavpop.movからタイトル(h2.post-title)、販売者(販売者：～)を取得
// - タイトルが取得できなければリネームしない
// - タイトル取得済みだが販売者が取得できない場合は「タイトル_販売者なし」として "_未分類" フォルダへ
// - 両方取得できた場合は「販売者フォルダ」へリネーム移動
// - CSVログ出力対応
// - 取得失敗時は debug_html_番号.html を保存

const fs = require("fs");
const path = require("path");
const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
puppeteer.use(StealthPlugin());

// ===== 設定 =====
const TARGET_DIR = "L:\\all";
const DEST_BASE_DIR = "L:\\all_fc2";
const UNCLASSIFIED = "_未分類";
const MIN_DELAY_MS = 1000;
const MAX_DELAY_MS = 5000;
const HEADLESS = true;

// ===== ユーティリティ =====
function sleep(ms) {
  return new Promise((res) => setTimeout(res, ms));
}
async function randomDelayWithLog() {
  const ms =
    Math.floor(Math.random() * (MAX_DELAY_MS - MIN_DELAY_MS + 1)) +
    MIN_DELAY_MS;
  console.log(`⏳ 次回リクエストまで ${ms}ms 待機...`);
  await sleep(ms);
}
function sanitizeForPath(str) {
  return String(str).replace(/[\\/:*?"<>|]/g, "_").trim();
}
function uniquePath(p) {
  const ext = path.extname(p);
  const base = p.slice(0, -ext.length);
  let i = 1;
  let newPath = p;
  while (fs.existsSync(newPath)) {
    newPath = `${base}(${i})${ext}`;
    i++;
  }
  return newPath;
}
function getAllMp4Files(dir) {
  let results = [];
  const list = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of list) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results = results.concat(getAllMp4Files(full));
    } else if (
      entry.isFile() &&
      path.extname(entry.name).toLowerCase() === ".mp4"
    ) {
      results.push(full);
    }
  }
  return results;
}

// ===== ファイル名から番号と枝番を抽出 =====
function extractNumberAndSuffix(filename) {
  const baseNoExt = path.basename(filename, path.extname(filename));

  // 枝番（末尾の _1 / -2 など）
  const mSuffix = baseNoExt.match(/([_-]\d{1,2})$/);
  const suffix = mSuffix ? mSuffix[0] : "";

  const mainPart = mSuffix
    ? baseNoExt.slice(0, -mSuffix[0].length)
    : baseNoExt;

  // 末尾7桁優先
  const digits = mainPart.replace(/\D/g, "");
  if (digits.length >= 7) {
    return { number: digits.slice(-7), suffix };
  }

  // FC2-PPV 系
  const mHead = mainPart.match(
    /(?:FC2-PPV-|FC2PPV-|fc2ppv_|fc2ppv-)(\d{7})/i
  );
  if (mHead) return { number: mHead[1], suffix };

  return { number: null, suffix };
}

// ===== javpop.mov から タイトル と 販売者 を取得 =====
async function fetchFc2cmData(browser, number) {
  const url = `https://javpop.mov/ja/fc2-ppvppv-${number}/`;
  let title = "なし";
  let seller = "なし";
  let page;

  try {
    page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });
    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125 Safari/537.36"
    );
    await page.setExtraHTTPHeaders({
      "Accept-Language": "ja,en-US;q=0.9,en;q=0.8",
    });

    await page.goto(url, { waitUntil: "networkidle2", timeout: 30000 });

    // --- タイトル (h2.post-title) ---
    const titleEl = await page.$("h2.post-title");
    if (titleEl) {
      title = await page.evaluate((el) => el.textContent.trim(), titleEl);
    } else {
      console.warn(`⚠️ タイトル取得失敗: ${url}`);
    }

    // --- 販売者を含む段落を全て探索 ---
    const paragraphs = await page.$$("p");
    let infoText = "";

    for (const p of paragraphs) {
      const text = await page.evaluate((el) => el.innerText.trim(), p);
      // 「販売者」または「卖家」を含む段落を探す
      if (/販売者：|卖家：/.test(text)) {
        infoText = text;
        break;
      }
    }

    // --- 販売者抽出（日本語 or 中国語対応） ---
    if (infoText) {
      const sellerMatch = infoText.match(/(?:販売者|卖家)：([^\n<]+)/);
      if (sellerMatch) {
        seller = sellerMatch[1].trim();
      }
    } else {
      console.warn(`⚠️ 販売者情報が見つかりません: ${url}`);
      const html = await page.content();
      const debugPath = path.join(TARGET_DIR, `debug_html_${number}.html`);
      fs.writeFileSync(debugPath, html, "utf8");
    }
  } catch (err) {
    console.error(`❌ Puppeteer fetch error for ${url}:`, err.message);
  } finally {
    if (page) await page.close().catch(() => {});
  }
  
  // --- ノイズ除去 ---
  if (!title || /404|not\s*found|エラー|error/i.test(title)) {
    title = "なし";
  }
  if (!seller) seller = "なし";

  return { url, title, seller };
}

// ===== メイン処理 =====
(async () => {
  const stamp = new Date()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\..+/, "")
    .replace("T", "_");
  const logPath = path.join(DEST_BASE_DIR, `rename_log_${stamp}.csv`);
  fs.writeFileSync(
    logPath,
    "OldPath,NewPath,OldFileName,NewFileName,Number,URL,Title,Seller,Action\n",
    "utf8"
  );

  const files = getAllMp4Files(TARGET_DIR);
  const jobs = [];
  for (const f of files) {
    const { number, suffix } = extractNumberAndSuffix(path.basename(f));
    if (number) jobs.push({ fullPath: f, number, suffix });
  }
  jobs.sort((a, b) => Number(a.number) - Number(b.number));

  const browser = await puppeteer.launch({
    headless: HEADLESS,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  try {
    for (const { fullPath, number, suffix } of jobs) {
      await randomDelayWithLog();

      const { url, title, seller } = await fetchFc2cmData(browser, number);

      const oldPath = fullPath;
      const oldName = path.basename(oldPath);
      const ext = path.extname(oldName);

      // --- 条件判定 ---
      const titleValid = title && title !== "なし";
      const sellerValid = seller && seller !== "なし";

      let destDir, newName;

      if (titleValid && sellerValid) {
        // ✅ 通常処理：タイトル＋販売者あり
        destDir = path.join(DEST_BASE_DIR, sanitizeForPath(seller));
        newName = `${sanitizeForPath(title)}${suffix}${ext}`;
      } else if (titleValid && !sellerValid) {
        // ✅ タイトルのみ取得：未分類フォルダへ
        destDir = path.join(DEST_BASE_DIR, UNCLASSIFIED);
        newName = `${sanitizeForPath(title)}_販売者なし${suffix}${ext}`;
      } else {
        // ❌ タイトルも販売者もなし：元名で未分類
        destDir = path.join(DEST_BASE_DIR, UNCLASSIFIED);
        newName = oldName;
      }

      if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });

      // --- 同名回避 ---
      let destPath = path.join(destDir, newName);
      if (fs.existsSync(destPath)) {
        destPath = uniquePath(destPath);
        newName = path.basename(destPath);
      }

      // --- 移動 ---
      fs.renameSync(oldPath, destPath);

      const action =
        destPath !== oldPath
          ? newName !== path.basename(oldPath)
            ? "Moved+Renamed"
            : "Moved"
          : "NoChange";

      // --- CSVログ ---
      const line =
        [
          oldPath,
          destPath,
          path.basename(oldPath),
          newName,
          number,
          url,
          (title || "").replace(/"/g, '""'),
          (seller || "").replace(/"/g, '""'),
          action,
        ]
          .map((v) => `"${String(v)}"`)
          .join(",") + "\n";
      fs.appendFileSync(logPath, line, "utf8");

      console.log(
        `✅ ${oldName} → ${newName} / ${
          sellerValid ? seller : UNCLASSIFIED
        } (${action})`
      );
    }

    console.log("\n🎉 完了：ログ => " + logPath);
  } catch (e) {
    console.error("❌ 処理中エラー:", e);
  } finally {
    await browser.close().catch(() => {});
  }
})();
