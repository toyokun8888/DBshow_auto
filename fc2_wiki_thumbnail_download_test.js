// ============================================================
// fc2_wiki_thumbnail_download_test.js
// FC2 thumbnail download test - one URL only.
//
// Purpose:
// - Download one verified thumbnail URL
// - Save it under ./fc2_sum
// - Keep this test independent from DB
// - In db_test_3 mode, download three owned-product thumbnails and upsert
//   their local paths into xxx_tm009_fc2_wiki_thumbnail_assets
//
// Naming:
// - FC2_Wiki.md recommends {product_id}.jpg.
// - This standalone URL does not include a reliable product_id, so the test
//   uses FC2_THUMB_TEST_PRODUCT_ID when provided.
// - Without FC2_THUMB_TEST_PRODUCT_ID, it uses a deterministic test name
//   derived from the URL leaf.
// ============================================================

const fs = require("fs");
const path = require("path");
const https = require("https");
const crypto = require("crypto");
const { Client } = require("pg");

const MODE = process.env.FC2_THUMB_MODE || "test_one";
const CONFIRM_DOWNLOAD = process.env.FC2_THUMB_CONFIRM_DOWNLOAD || "YES";
const CONFIRM_DB_WRITE = process.env.FC2_THUMB_CONFIRM_DB_WRITE || "NO";

const TEST_URL =
  process.env.FC2_THUMB_TEST_URL ||
  "https://contents-thumbnail2.fc2.com/w360/storage200000.contents.fc2.com/file/385/38437260/1763645304.74.jpg";

const TEST_PRODUCT_ID = process.env.FC2_THUMB_TEST_PRODUCT_ID || "";
const OUTPUT_DIR = path.join(__dirname, "fc2_sum");
const MAX_BYTES = 10 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 30000;
const DB_TEST_LIMIT = Math.min(Math.max(Number(process.env.FC2_THUMB_DB_TEST_LIMIT || 3), 1), 3);

function assertSafetyGate() {
  if (!["test_one", "db_test_3"].includes(MODE)) {
    throw new Error(`Unsupported MODE: ${MODE}`);
  }
  if (CONFIRM_DOWNLOAD !== "YES") {
    throw new Error("Download gate failed. Set CONFIRM_DOWNLOAD=YES.");
  }
  if (MODE === "db_test_3" && CONFIRM_DB_WRITE !== "YES") {
    throw new Error("DB write gate failed. Set FC2_THUMB_CONFIRM_DB_WRITE=YES.");
  }
  if (MODE === "test_one" && !isApprovedThumbnailUrl(TEST_URL)) {
    throw new Error("Refusing non-approved thumbnail host.");
  }
}

function loadEnvFile() {
  const envPath = path.join(__dirname, ".env");
  if (!fs.existsSync(envPath)) return;
  const text = fs.readFileSync(envPath, "utf8");
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const idx = line.indexOf("=");
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim().replace(/^['"]|['"]$/g, "");
    if (key && process.env[key] === undefined) process.env[key] = value;
  }
}

function requireEnv(name) {
  const value = process.env[name];
  if (!value || value.startsWith("CHANGE_ME_")) {
    throw new Error(`${name} is not configured`);
  }
  return value;
}

function createPgClient() {
  const sslValue = (process.env.PGSSL || "false").toLowerCase();
  return new Client({
    host: requireEnv("PGHOST"),
    port: Number(process.env.PGPORT || 5432),
    database: requireEnv("PGDATABASE"),
    user: requireEnv("PGUSER"),
    password: requireEnv("PGPASSWORD"),
    ssl: sslValue === "true" ? { rejectUnauthorized: false } : false,
  });
}

function isApprovedThumbnailUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && parsed.hostname === "contents-thumbnail2.fc2.com";
  } catch {
    return false;
  }
}

function ensureOutputDir() {
  if (fs.existsSync(OUTPUT_DIR)) {
    const stat = fs.statSync(OUTPUT_DIR);
    if (!stat.isDirectory()) {
      throw new Error(`Output path exists but is not a directory: ${OUTPUT_DIR}`);
    }
  }
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
}

function extensionFromUrl(url) {
  const cleanPath = new URL(url).pathname.toLowerCase();
  const ext = path.extname(cleanPath);
  if ([".jpg", ".jpeg", ".png", ".webp"].includes(ext)) return ext;
  return ".jpg";
}

function outputFileName(url) {
  const ext = extensionFromUrl(url);
  if (/^\d{6,8}$/.test(TEST_PRODUCT_ID)) {
    return `${TEST_PRODUCT_ID}${ext}`;
  }

  const leaf = path.basename(new URL(url).pathname).replace(/[^\w.-]/g, "_");
  const base = leaf.slice(0, -path.extname(leaf).length) || "thumbnail";
  const safeLeaf = base.replace(/\./g, "_");
  return `thumb_test_${safeLeaf}${ext}`;
}

function outputFileNameForProduct(productId, url) {
  return `${productId}${extensionFromUrl(url)}`;
}

function downloadFile(url, outputPath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    let bytes = 0;
    const tempPath = `${outputPath}.download-${process.pid}-${Date.now()}.tmp`;

    const request = https.get(url, (response) => {
      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error(`HTTP ${response.statusCode}`));
        return;
      }

      const contentType = response.headers["content-type"] || "";
      if (!String(contentType).startsWith("image/")) {
        response.resume();
        reject(new Error(`Unexpected content-type: ${contentType}`));
        return;
      }

      const file = fs.createWriteStream(tempPath, { flags: "wx" });

      response.on("data", (chunk) => {
        bytes += chunk.length;
        if (bytes > MAX_BYTES) {
          request.destroy(new Error(`File too large: ${bytes}`));
          return;
        }
        hash.update(chunk);
      });

      response.pipe(file);

      file.on("finish", () => {
        file.close(() => {
          if (fs.existsSync(outputPath)) {
            reject(new Error(`Output file already exists: ${outputPath}`));
            return;
          }
          fs.renameSync(tempPath, outputPath);
          resolve({
            bytes,
            sha256: hash.digest("hex"),
            contentType
          });
        });
      });

      file.on("error", (err) => {
        reject(err);
      });
    });

    request.setTimeout(REQUEST_TIMEOUT_MS, () => {
      request.destroy(new Error("Request timeout"));
    });

    request.on("error", (err) => {
      reject(err);
    });
  });
}

async function collectDbTestTargets(client) {
  const result = await client.query(
    `
      SELECT DISTINCT ON (o.product_id)
        o.product_id::text AS product_id,
        w.thumbnail_url,
        w.source_wiki_url
      FROM public.xxx_tm002_owned_files o
      JOIN public.xxx_vq026_wiki_article_master_enriched w
        ON w.product_id = o.product_id::text
      LEFT JOIN public.xxx_tm009_fc2_wiki_thumbnail_assets t
        ON t.product_id = o.product_id::text
      WHERE o.status = 'owned'
        AND COALESCE(w.thumbnail_url, '') <> ''
        AND COALESCE(t.thumbnail_status, '') <> 'collected'
      ORDER BY o.product_id, w.updated_at DESC NULLS LAST
      LIMIT $1
    `,
    [DB_TEST_LIMIT * 10]
  );
  return result.rows.filter((row) => isApprovedThumbnailUrl(row.thumbnail_url));
}

async function upsertThumbnailResult(client, row, outputPath, fileName) {
  await client.query(
    `
      INSERT INTO public.xxx_tm009_fc2_wiki_thumbnail_assets (
        product_id,
        thumbnail_url,
        local_thumbnail_path,
        local_thumbnail_file_name,
        thumbnail_status,
        source_wiki_url,
        last_checked_at,
        downloaded_at,
        attempt_count,
        last_error,
        updated_at
      )
      VALUES ($1, $2, $3, $4, 'collected', $5, now(), now(), 1, NULL, now())
      ON CONFLICT (product_id) DO UPDATE SET
        thumbnail_url = EXCLUDED.thumbnail_url,
        local_thumbnail_path = EXCLUDED.local_thumbnail_path,
        local_thumbnail_file_name = EXCLUDED.local_thumbnail_file_name,
        thumbnail_status = 'collected',
        source_wiki_url = EXCLUDED.source_wiki_url,
        last_checked_at = now(),
        downloaded_at = now(),
        attempt_count = public.xxx_tm009_fc2_wiki_thumbnail_assets.attempt_count + 1,
        last_error = NULL,
        updated_at = now()
    `,
    [row.product_id, row.thumbnail_url, outputPath, fileName, row.source_wiki_url || ""]
  );
}

async function runDbTest3() {
  loadEnvFile();
  ensureOutputDir();

  const client = createPgClient();
  await client.connect();
  try {
    const targets = await collectDbTestTargets(client);
    if (targets.length === 0) {
      throw new Error("No eligible owned thumbnail targets found.");
    }

    console.log("=".repeat(70));
    console.log("FC2 Wiki Thumbnail DB Test");
    console.log(`MODE       : ${MODE}`);
    console.log(`LIMIT      : ${DB_TEST_LIMIT}`);
    console.log(`OUTPUT_DIR : ${OUTPUT_DIR}`);
    console.log("=".repeat(70));

    let savedCount = 0;
    const failed = [];

    const successes = [];

    for (const row of targets) {
      if (savedCount >= DB_TEST_LIMIT) break;

      const fileName = outputFileNameForProduct(row.product_id, row.thumbnail_url);
      const outputPath = path.join(OUTPUT_DIR, fileName);
      let result = null;

      try {
        if (fs.existsSync(outputPath)) {
          const bytes = fs.statSync(outputPath).size;
          result = { bytes, sha256: "existing_file", contentType: "existing_file" };
        } else {
          result = await downloadFile(row.thumbnail_url, outputPath);
        }

        savedCount += 1;
        successes.push({ row, outputPath, fileName });
        console.log(
          `${row.product_id}: saved=${outputPath} bytes=${result.bytes} sha256=${result.sha256}`
        );
      } catch (error) {
        failed.push(`${row.product_id}:${error.message || error}`);
        console.warn(`${row.product_id}: skipped=${error.message || error}`);
      }
    }

    if (savedCount < DB_TEST_LIMIT) {
      throw new Error(`Only ${savedCount}/${DB_TEST_LIMIT} thumbnails saved. Failed: ${failed.join(", ")}`);
    }

    await client.query("BEGIN");
    try {
      for (const success of successes) {
        await upsertThumbnailResult(
          client,
          success.row,
          success.outputPath,
          success.fileName
        );
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  } finally {
    await client.end();
  }
}

(async () => {
  assertSafetyGate();
  if (MODE === "db_test_3") {
    await runDbTest3();
    return;
  }

  ensureOutputDir();

  const fileName = outputFileName(TEST_URL);
  const outputPath = path.join(OUTPUT_DIR, fileName);
  if (fs.existsSync(outputPath)) {
    throw new Error(`Output file already exists: ${outputPath}`);
  }

  console.log("=".repeat(70));
  console.log("FC2 Wiki Thumbnail Download Test");
  console.log(`MODE       : ${MODE}`);
  console.log(`URL        : ${TEST_URL}`);
  console.log(`OUTPUT     : ${outputPath}`);
  console.log("=".repeat(70));

  const result = await downloadFile(TEST_URL, outputPath);

  console.log("DONE");
  console.log(`bytes      : ${result.bytes}`);
  console.log(`contentType: ${result.contentType}`);
  console.log(`sha256     : ${result.sha256}`);
  console.log(`saved      : ${outputPath}`);
})().catch((err) => {
  console.error("Fatal error:", err.message || err);
  process.exitCode = 1;
});
