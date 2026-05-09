const fs = require("fs");
const path = require("path");
const axios = require("axios");
const cheerio = require("cheerio");

// 対象フォルダを指定
const targetDir = "D:/all"; // ←任意のフォルダに変更してください

// 7桁の数字を抽出する関数
function extractNumber(filename) {
  const fc2Pattern = /^(?:FC2-PPV-|FC2PPV-|fc2ppv-)(\d{7})/;
  const normalPattern = /(\d{7})$/;

  let match = filename.match(fc2Pattern);
  if (match) return match[1];

  match = filename.match(normalPattern);
  if (match) return match[1];

  return null;
}

// fc2cm.com から h1 と h2 を取得
async function fetchFc2cmData(number) {
  const url = `https://fc2cm.com/?p=${number}&nc=0`;

  try {
    const response = await axios.get(url, { timeout: 10000 });
    const $ = cheerio.load(response.data);

    const h1 = $("h1.entry-title").text().trim() || "なし";
    const h2 = $("h2").first().text().trim() || "なし";

    return { url, h1, h2 };
  } catch (err) {
    console.error(`❌ Fetch error for ${url}:`, err.message);
    return { url, h1: "取得失敗", h2: "取得失敗" };
  }
}

// フォルダを再帰的に探索
function getAllMp4Files(dir) {
  let results = [];
  const list = fs.readdirSync(dir, { withFileTypes: true });
  list.forEach((file) => {
    const fullPath = path.join(dir, file.name);
    if (file.isDirectory()) {
      results = results.concat(getAllMp4Files(fullPath));
    } else if (path.extname(file.name).toLowerCase() === ".mp4") {
      results.push(fullPath);
    }
  });
  return results;
}

// ファイルを移動 & CSV 出力
async function processFiles() {
  const files = getAllMp4Files(targetDir);
  const validFiles = [];

  for (const file of files) {
    const filename = path.basename(file);
    const number = extractNumber(filename);
    if (number) {
      validFiles.push({ file, filename, number });
    }
  }

  // 数値の昇順にソート
  validFiles.sort((a, b) => a.number - b.number);

  // 100件ずつ分割
  const chunkSize = 100;
  for (let i = 0; i < validFiles.length; i += chunkSize) {
    const chunk = validFiles.slice(i, i + chunkSize);

    const folderName = `delfc2${Math.floor(i / chunkSize) + 1}`;
    const newDir = path.join(targetDir, folderName);
    if (!fs.existsSync(newDir)) {
      fs.mkdirSync(newDir);
    }

    let csvData = "FileName,Number,URL,H1,H2\n";

    for (const item of chunk) {
      const newPath = path.join(newDir, item.filename);

      // ファイル移動
      fs.renameSync(item.file, newPath);

      // fc2cmからデータ取得
      const { url, h1, h2 } = await fetchFc2cmData(item.number);

      csvData += `"${item.filename}",${item.number},${url},"${h1}","${h2}"\n`;
    }

    // CSVファイル書き込み
    const csvPath = path.join(
      targetDir,
      `delfc2_result_${Math.floor(i / chunkSize) + 1}.csv`
    );
    fs.writeFileSync(csvPath, csvData, "utf8");
  }

  console.log("✅ すべての処理が完了しました。");
  process.exit(0); // 自動終了
}

processFiles();
