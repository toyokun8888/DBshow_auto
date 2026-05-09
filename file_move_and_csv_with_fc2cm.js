// file_move_and_csv_with_fc2cm.js
// - MP4 を再帰走査
// - ファイル名から 7 桁番号（まず末尾7桁 → FC2-PPV/FC2PPV パターン）＋枝番(_1/-2等)を抽出
// - Puppeteer で fc2cm（?p=番号）から タイトル: h1.entry-title、販売者: h2 a[rel='category'] を取得
// - タイトル未取得 or 販売者未取得（= 未分類）の場合は「リネームしない」→ 元名のまま移動
// - 取得成功時のみ「<タイトル><枝番>.mp4」にリネーム（禁止文字は _ に置換）
// - 販売者フォルダは DEST_BASE_DIR 直下、未取得は "_未分類"
// - アクセス間は 1〜5 秒ランダム待機（待機時間を表示）
// - タイトル取得失敗時は debug_html_番号.html を保存
// - CSV ログに OldPath/NewPath などを出力

const fs = require("fs");
const path = require("path");

// Bot 回避の安定性向上
const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
puppeteer.use(StealthPlugin());

// ===== 設定 =====
const TARGET_DIR = "L:\\all";           // 元ファイル探索場所
const DEST_BASE_DIR = "L:\\all_fc2"     // 移動先ベースディレクトリ
const UNCLASSIFIED = "_未分類";
const MIN_DELAY_MS = 1000;
const MAX_DELAY_MS = 5000;
const HEADLESS = true;

// ===== ユーティリティ =====
function sleep(ms) {
  return new Promise(res => setTimeout(res, ms));
}
async function randomDelayWithLog() {
  const ms = Math.floor(Math.random() * (MAX_DELAY_MS - MIN_DELAY_MS + 1)) + MIN_DELAY_MS;
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
    } else if (entry.isFile() && path.extname(entry.name).toLowerCase() === ".mp4") {
      results.push(full);
    }
  }
  return results;
}
//-----------------------------------------------------------末尾優先含む---------------------------------------------------
// ファイル名から 7 桁番号と枝番(_1 / -2 など)を抽出（末尾7桁を最優先）
// function extractNumberAndSuffix(filename) {
//   const baseNoExt = path.basename(filename, path.extname(filename));

//   // 枝番（末尾の _1 / -2 など）を保持
//   const mSuffix = baseNoExt.match(/([_-]\d{1,2})$/);
//   const suffix = mSuffix ? mSuffix[0] : "";

//   // 枝番は検索対象から除外
//   const mainPart = mSuffix ? baseNoExt.slice(0, -mSuffix[0].length) : baseNoExt;

//   // 1) 末尾7桁を最優先
//   const digits = mainPart.replace(/\D/g, "");
//   if (digits.length >= 7) {
//     return { number: digits.slice(-7), suffix };
//   }

//   // 2) FC2-PPV / FC2PPV / fc2ppv パターン
//   const mHead = mainPart.match(/(?:FC2-PPV-|FC2PPV-|supjav\.com@fc2ppv-|hhd800\.com@FC2-|fc2-ppv-|fc2ppv_|ARCHIVE-FC2PPV-|FC2 PPV |hhd800.com@FC2-PPV-|fc2ppv-)(\d{7})/i);
//   if (mHead) return { number: mHead[1], suffix };

//   return { number: null, suffix };
// }
//-----------------------------------------------------------末尾優先含む---------------------------------------------------
// ===== ファイル名から番号と枝番を抽出 =====
// （A）末尾7桁優先バージョン
// （B）FC2系パターンのみ抽出バージョン
// 使用したい方のブロックだけコメントアウト解除して使う


/* ============================================
(A) 末尾7桁優先バージョン
============================================ */

function extractNumberAndSuffix(filename) {
  const baseNoExt = path.basename(filename, path.extname(filename));

  // 枝番（末尾の _1 / -2 など）を保持
  const mSuffix = baseNoExt.match(/([_-]\d{1,2})$/);
  const suffix = mSuffix ? mSuffix[0] : "";

  // 枝番は検索対象から除外
  const mainPart = mSuffix ? baseNoExt.slice(0, -mSuffix[0].length) : baseNoExt;

  // 1) 末尾7桁を最優先
  const digits = mainPart.replace(/\D/g, "");
  if (digits.length >= 7) {
    return { number: digits.slice(-7), suffix };
  }

  // 2) FC2-PPV / FC2PPV / fc2ppv パターン
  const mHead = mainPart.match(
    /(?:FC2-PPV-|FC2PPV-|supjav\.com@fc2ppv-|hhd800\.com@FC2-|fc2-ppv-|fc2ppv_|hhd800.com@FC2-PPV-|ARCHIVE-FC2PPV-|FC2 PPV |hhd800.com@FC2-PPV-|fc2ppv-)(\d{7})/i
  );
  if (mHead) return { number: mHead[1], suffix };

  return { number: null, suffix };
}


/* ============================================
(B) FC2系パターンのみ抽出バージョン
============================================ */
// function extractNumberAndSuffix(filename) {
//   const baseNoExt = path.basename(filename, path.extname(filename));

//   // 枝番（末尾の _1 / -2 など）を保持
//   const mSuffix = baseNoExt.match(/([_-]\d{1,2})$/);
//   const suffix = mSuffix ? mSuffix[0] : "";

//   // 枝番は検索対象から除外
//   const mainPart = mSuffix ? baseNoExt.slice(0, -mSuffix[0].length) : baseNoExt;

//   // FC2-PPV / FC2PPV / fc2ppv など既知パターン
//   const mHead = mainPart.match(
//     /(?:FC2-PPV-|FC2PPV-|supjav\.com@fc2ppv-|hhd800\.com@FC2-|fc2-ppv-|fc2ppv_|ARCHIVE-FC2PPV-|FC2 PPV |hhd800.com@FC2-PPV-|fc2ppv-)(\d{7})/i
//   );
//   if (mHead) return { number: mHead[1], suffix };

//   // 一致しなければ null
//   return { number: null, suffix };
// }
// /* ============================================
// (C) 先頭が7桁の数値で始まるパターン
// ============================================ */
// function extractNumberAndSuffix(filename) {
//   const baseNoExt = path.basename(filename, path.extname(filename));

//   // 枝番（末尾の _1 / -2 など）を保持
//   const mSuffix = baseNoExt.match(/([_-]\d{1,2})$/);
//   const suffix = mSuffix ? mSuffix[0] : "";

//   // 枝番は検索対象から除外
//   const mainPart = mSuffix ? baseNoExt.slice(0, -mSuffix[0].length) : baseNoExt;

//   // 先頭が7桁の数値で始まる場合にマッチ
//   const mHeadNum = mainPart.match(/^(\d{7})/);
//   if (mHeadNum) {
//     return { number: mHeadNum[1], suffix };
//   }

//   // 一致しなければ null
//   return { number: null, suffix };
// }

// ===== fc2cm から タイトル(h1) と 販売者(h2>a[rel='category']) を取得 =====
async function fetchFc2cmData(browser, number) {
  const url = `https://fc2cm.com/?p=${number}`;
  let title = "なし";
  let seller = "なし";
  let page;

  try {
    page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });
    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125 Safari/537.36"
    );
    await page.setExtraHTTPHeaders({ "Accept-Language": "ja,en-US;q=0.9,en;q=0.8" });

    await page.goto(url, { waitUntil: "networkidle2", timeout: 30000 });

    // --- タイトル (h1.entry-title) ---
    const titleEl = await page.$("h1.entry-title");
    if (titleEl) {
      title = await page.evaluate(el => el.textContent.trim(), titleEl);
    } else {
      console.warn(`⚠️ タイトル取得失敗: ${url}`);
      const html = await page.content();
      const debugPath = path.join(TARGET_DIR, `debug_html_${number}.html`);
      fs.writeFileSync(debugPath, html, "utf8");
    }

    // --- 販売者 (h2 のカテゴリー) ---
    let sellerEl =
      (await page.$("h2 a[rel='category']")) ||
      (await page.$("span.blog_info a[rel='category tag']")) ||
      (await page.$(".blog_info p a[rel='category']"));

    if (sellerEl) {
      seller = await page.evaluate(el => el.textContent.trim(), sellerEl);
    } else {
      seller = "なし";
    }
  } catch (err) {
    console.error(`❌ Puppeteer fetch error for ${url}:`, err.message);
  } finally {
    if (page) await page.close().catch(() => {});
  }

  // 最低限のノイズ除去
  if (!title || /404|not\s*found|エラー|error/i.test(title)) {
    title = "なし";
  }
  if (!seller) seller = "なし";

  return { url, title, seller };
}

// ===== メイン処理 =====
(async () => {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "").replace("T", "_");
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

      // 分類フォルダ：販売者が未取得なら "_未分類"
      const sellerValid = seller && seller !== "なし";
      const destDir = path.join(DEST_BASE_DIR, sanitizeForPath(sellerValid ? seller : UNCLASSIFIED));
      if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });

      // リネーム条件
      const titleValid = title && title !== "なし";
      const canRename = titleValid && sellerValid;

      let newName = oldName;
      if (canRename) {
        const safeTitle = sanitizeForPath(title);
        if (safeTitle) newName = `${safeTitle}${suffix}${ext}`;
      } else {
        if (!sellerValid) {
          console.warn(`⚠️ 販売者なし → 未分類 / 元名保持: ${oldName}`);
        }
        if (!titleValid) {
          console.warn(`⚠️ タイトルなし → 元名保持: ${oldName}`);
        }
      }

      // 宛先パス作成（同名回避）
      let destPath = path.join(destDir, newName);
      if (fs.existsSync(destPath)) {
        destPath = uniquePath(destPath);
        newName = path.basename(destPath);
      }

      // 移動
      fs.renameSync(oldPath, destPath);

      const action =
        destPath !== oldPath
          ? newName !== path.basename(oldPath)
            ? "Moved+Renamed"
            : "Moved"
          : "NoChange";

      // CSV ログ
      const line = [
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
        .map(v => `"${String(v)}"`)
        .join(",") + "\n";
      fs.appendFileSync(logPath, line, "utf8");

      console.log(`✅ ${oldName} → ${newName} / ${sellerValid ? seller : UNCLASSIFIED} (${action})`);
    }

    console.log("\n🎉 完了：ログ => " + logPath);
  } catch (e) {
    console.error("❌ 処理中エラー:", e);
  } finally {
    await browser.close().catch(() => {});
  }
})();
