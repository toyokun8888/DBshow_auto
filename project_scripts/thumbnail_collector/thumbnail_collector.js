const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const https = require("https");
const http = require("http");
const { Client } = require("pg");

const PROJECT_ROOT = path.resolve(__dirname, "..", "..");

const CONFIG = {
  mode: "dry-run", // dry-run | execute
  confirmExecute: "",
  dailyLimit: 100,

  // TODO(CONFIG_PATH): change to your thumbnail root directory.
  thumbnailRootDir: path.join(__dirname, "sample_workspace", "thumbnails"),
  // TODO(CONFIG_PATH): change to your CSV log directory.
  csvLogDir: path.join(__dirname, "sample_workspace", "logs"),

  // TODO(CONFIG_PATH): if you have known priority product_id list file, set this path.
  knownPriorityListPath: path.join(__dirname, "sample_workspace", "known_priority_ids.txt"),
  // TODO(CONFIG_PATH): if you have wish list product_id file, set this path.
  wishListPath: path.join(__dirname, "sample_workspace", "wishlist_ids.txt"),

  // TODO(DB): adjust table/view names to your schema.
  dbMasterView: "public.xxx_vq001_moviemaster_unique",
  dbOwnedTable: "public.xxx_tm002_owned_files",
  dbThumbnailTable: "public.xxx_tm006_thumbnail_assets",
  dbThumbnailJobLogTable: "public.xxx_tl002_thumbnail_jobs",

  // TODO(DB_QUERY): tweak priority queries to match your actual DB structure.
  sqlPriorityOwned: `
    SELECT o.product_id
    FROM public.xxx_tm002_owned_files o
    LEFT JOIN public.xxx_tm006_thumbnail_assets t
      ON t.product_id = o.product_id
    WHERE t.product_id IS NULL
    ORDER BY o.updated_at DESC NULLS LAST, o.id DESC
    LIMIT $1
  `,
  sqlPriorityRest: `
    SELECT m.product_id
    FROM public.xxx_vq001_moviemaster_unique m
    LEFT JOIN public.xxx_tm006_thumbnail_assets t
      ON t.product_id = m.product_id
    WHERE t.product_id IS NULL
    ORDER BY m.product_id
    LIMIT $1
  `,

  sourcePolicy: ["google_cse", "scrape_api"], // ordered fallback
  timeoutMs: 15000,
  envPath: path.join(PROJECT_ROOT, ".env"),
};

const CSV_COLUMNS = [
  "run_id",
  "mode",
  "priority_bucket",
  "product_id",
  "attempt_source",
  "status",
  "thumbnail_path",
  "thumbnail_file_name",
  "error_message",
  "created_at",
];

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) return writeUsage();
  if (args.initSample) await initSampleWorkspace(path.join(__dirname, "sample_workspace"));

  const config = buildConfig(args);
  ensureDirectory(config.thumbnailRootDir);
  ensureDirectory(config.csvLogDir);

  const runId = args.runId || buildRunId("thumbnail_collect");
  const csvPath = path.join(config.csvLogDir, `thumbnail_collect_${runId}.csv`);
  const rows = [];

  const client = await connectDb(config);
  try {
    const queue = await buildPriorityQueue(client, config, config.dailyLimit);
    for (const item of queue) {
      const row = await processOne({
        client,
        config,
        runId,
        item,
      });
      rows.push(row);
    }
  } finally {
    await client.end();
  }

  writeCsv(csvPath, rows, CSV_COLUMNS);
  const summary = summarize(rows);
  process.stdout.write(
    [
      `Thumbnail collector completed (${config.mode}).`,
      `Queued: ${rows.length}`,
      `Success: ${summary.success}`,
      `Skipped: ${summary.skipped}`,
      `Error: ${summary.error}`,
      `CSV: ${csvPath}`,
      "",
    ].join("\n")
  );
}

async function processOne(ctx) {
  const { client, config, runId, item } = ctx;
  const createdAt = new Date().toISOString();
  const base = {
    run_id: runId,
    mode: config.mode,
    priority_bucket: item.bucket,
    product_id: item.productId,
    attempt_source: "",
    status: "",
    thumbnail_path: "",
    thumbnail_file_name: "",
    error_message: "",
    created_at: createdAt,
  };

  if (config.mode === "dry-run") {
    base.status = "dry_run";
    return base;
  }

  for (const sourceName of config.sourcePolicy) {
    base.attempt_source = sourceName;
    try {
      const candidate = await resolveThumbnailCandidate({
        sourceName,
        productId: item.productId,
        timeoutMs: config.timeoutMs,
      });
      if (!candidate || !candidate.url) continue;

      const saved = await downloadThumbnail({
        url: candidate.url,
        productId: item.productId,
        sourceName,
        rootDir: config.thumbnailRootDir,
        timeoutMs: config.timeoutMs,
      });

      await withTransaction(client, async () => {
        await upsertThumbnailAsset(client, config, {
          productId: item.productId,
          bucket: item.bucket,
          sourceName,
          thumbnailPath: saved.fullPath,
          thumbnailFileName: saved.fileName,
          status: "collected",
          errorMessage: "",
        });
        await insertThumbnailJobLog(client, config, {
          runId,
          productId: item.productId,
          bucket: item.bucket,
          sourceName,
          status: "success",
          thumbnailPath: saved.fullPath,
          errorMessage: "",
        });
      });

      base.status = "success";
      base.thumbnail_path = saved.fullPath;
      base.thumbnail_file_name = saved.fileName;
      return base;
    } catch (error) {
      base.error_message = error.message;
    }
  }

  await withTransaction(client, async () => {
    await upsertThumbnailAsset(client, config, {
      productId: item.productId,
      bucket: item.bucket,
      sourceName: base.attempt_source || "",
      thumbnailPath: "",
      thumbnailFileName: "",
      status: "failed",
      errorMessage: base.error_message || "thumbnail_not_found",
    });
    await insertThumbnailJobLog(client, config, {
      runId,
      productId: item.productId,
      bucket: item.bucket,
      sourceName: base.attempt_source || "",
      status: "error",
      thumbnailPath: "",
      errorMessage: base.error_message || "thumbnail_not_found",
    });
  });

  base.status = "error";
  return base;
}

async function buildPriorityQueue(client, config, limit) {
  const out = [];
  const used = new Set();
  const collected = await loadCollectedProductIdSet(client, config);

  const knownIds = await loadIdList(config.knownPriorityListPath);
  for (const productId of knownIds) {
    if (collected.has(productId)) continue;
    if (used.has(productId)) continue;
    used.add(productId);
    out.push({ bucket: "known", productId });
    if (out.length >= limit) return out;
  }

  const wishIds = await loadIdList(config.wishListPath);
  for (const productId of wishIds) {
    if (collected.has(productId)) continue;
    if (used.has(productId)) continue;
    used.add(productId);
    out.push({ bucket: "wish", productId });
    if (out.length >= limit) return out;
  }

  const remain = limit - out.length;
  if (remain <= 0) return out;

  const owned = await queryWithFallback(client, config.sqlPriorityOwned, [remain], {
    fallbackSql: `
      SELECT o.product_id
      FROM public.xxx_tm002_owned_files o
      ORDER BY o.updated_at DESC NULLS LAST, o.id DESC
      LIMIT $1
    `,
  });
  for (const row of owned.rows) {
    const productId = String(row.product_id || "").trim();
    if (!productId || used.has(productId)) continue;
    used.add(productId);
    out.push({ bucket: "owned", productId });
    if (out.length >= limit) return out;
  }

  const remain2 = limit - out.length;
  if (remain2 <= 0) return out;
  const rest = await queryWithFallback(client, config.sqlPriorityRest, [remain2], {
    fallbackSql: `
      SELECT m.product_id
      FROM public.xxx_vq001_moviemaster_unique m
      ORDER BY m.product_id
      LIMIT $1
    `,
  });
  for (const row of rest.rows) {
    const productId = String(row.product_id || "").trim();
    if (!productId || used.has(productId)) continue;
    used.add(productId);
    out.push({ bucket: "rest", productId });
    if (out.length >= limit) return out;
  }

  return out;
}

async function loadCollectedProductIdSet(client, config) {
  try {
    assertSafeQualifiedName(config.dbThumbnailTable, "thumbnail table");
    const rs = await client.query(
      `SELECT product_id
       FROM ${config.dbThumbnailTable}
       WHERE collect_status = 'collected'
         AND COALESCE(thumbnail_path, '') <> ''`
    );
    return new Set(rs.rows.map((v) => String(v.product_id || "").trim()).filter(Boolean));
  } catch (error) {
    if (error && error.code === "42P01") return new Set();
    throw error;
  }
}

async function queryWithFallback(client, primarySql, params, opts) {
  try {
    return await client.query(primarySql, params);
  } catch (error) {
    if (error && error.code === "42P01" && opts && opts.fallbackSql) {
      return client.query(opts.fallbackSql, params);
    }
    throw error;
  }
}

async function resolveThumbnailCandidate(ctx) {
  const { sourceName, productId, timeoutMs } = ctx;
  if (sourceName === "google_cse") return resolveViaGoogleCse(productId, timeoutMs);
  if (sourceName === "scrape_api") return resolveViaScrapeApi(productId, timeoutMs);
  return null;
}

async function resolveViaGoogleCse(productId, timeoutMs) {
  // TODO(API_CONFIG): set GOOGLE_CSE_API_KEY / GOOGLE_CSE_CX in .env.
  const key = process.env.GOOGLE_CSE_API_KEY || "";
  const cx = process.env.GOOGLE_CSE_CX || "";
  if (!key || !cx || key.startsWith("CHANGE_ME_") || cx.startsWith("CHANGE_ME_")) {
    throw new Error("google_cse_not_configured");
  }
  const query = encodeURIComponent(`FC2 PPV ${productId} thumbnail`);
  const url = `https://www.googleapis.com/customsearch/v1?key=${encodeURIComponent(key)}&cx=${encodeURIComponent(cx)}&searchType=image&num=1&q=${query}`;
  const response = await requestJson(url, timeoutMs);
  const first = response && response.items && response.items[0];
  if (!first || !first.link) throw new Error("google_cse_no_result");
  return { url: first.link };
}

async function resolveViaScrapeApi(productId, timeoutMs) {
  // TODO(API_CONFIG): set SCRAPE_API_ENDPOINT template in .env if used.
  // Example: https://example.com/api/thumbnail?product_id={PRODUCT_ID}
  const endpointTemplate = process.env.SCRAPE_API_ENDPOINT || "";
  if (!endpointTemplate || endpointTemplate.startsWith("CHANGE_ME_")) {
    throw new Error("scrape_api_not_configured");
  }
  const endpoint = endpointTemplate.replace("{PRODUCT_ID}", encodeURIComponent(productId));
  const response = await requestJson(endpoint, timeoutMs);
  if (!response || !response.thumbnail_url) throw new Error("scrape_api_no_result");
  return { url: response.thumbnail_url };
}

async function downloadThumbnail(ctx) {
  const { url, productId, sourceName, rootDir, timeoutMs } = ctx;
  const raw = await requestBinary(url, timeoutMs);
  const ext = detectExt(url, raw.contentType);
  const fileName = sanitizeFileName(`FC2_PPV_${productId}_${sourceName}${ext}`);
  const dir = path.join(rootDir, productId.slice(0, 3));
  ensureDirectory(dir);
  const fullPath = path.join(dir, fileName);
  if (fs.existsSync(fullPath)) {
    return { fullPath, fileName };
  }
  await fsp.writeFile(fullPath, raw.buffer);
  return { fullPath, fileName };
}

function detectExt(url, contentType) {
  const lowerType = String(contentType || "").toLowerCase();
  if (lowerType.includes("png")) return ".png";
  if (lowerType.includes("webp")) return ".webp";
  if (lowerType.includes("jpeg") || lowerType.includes("jpg")) return ".jpg";
  const ext = path.extname(new URL(url).pathname).toLowerCase();
  if ([".jpg", ".jpeg", ".png", ".webp"].includes(ext)) return ext === ".jpeg" ? ".jpg" : ext;
  return ".jpg";
}

async function upsertThumbnailAsset(client, config, row) {
  assertSafeQualifiedName(config.dbThumbnailTable, "thumbnail table");
  await client.query(
    `INSERT INTO ${config.dbThumbnailTable}
      (product_id, priority_bucket, source_name, thumbnail_path, thumbnail_file_name, collect_status, error_message, updated_at, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,NOW(),NOW())
     ON CONFLICT (product_id) DO UPDATE SET
       priority_bucket = EXCLUDED.priority_bucket,
       source_name = EXCLUDED.source_name,
       thumbnail_path = CASE
         WHEN ${config.dbThumbnailTable}.collect_status = 'collected' AND EXCLUDED.collect_status = 'failed'
           THEN ${config.dbThumbnailTable}.thumbnail_path
         ELSE EXCLUDED.thumbnail_path
       END,
       thumbnail_file_name = CASE
         WHEN ${config.dbThumbnailTable}.collect_status = 'collected' AND EXCLUDED.collect_status = 'failed'
           THEN ${config.dbThumbnailTable}.thumbnail_file_name
         ELSE EXCLUDED.thumbnail_file_name
       END,
       collect_status = CASE
         WHEN ${config.dbThumbnailTable}.collect_status = 'collected' AND EXCLUDED.collect_status = 'failed'
           THEN ${config.dbThumbnailTable}.collect_status
         ELSE EXCLUDED.collect_status
       END,
       error_message = EXCLUDED.error_message,
       updated_at = NOW()`,
    [
      row.productId,
      row.bucket,
      row.sourceName,
      row.thumbnailPath,
      row.thumbnailFileName,
      row.status,
      row.errorMessage,
    ]
  );
}

async function insertThumbnailJobLog(client, config, row) {
  assertSafeQualifiedName(config.dbThumbnailJobLogTable, "thumbnail job log table");
  await client.query(
    `INSERT INTO ${config.dbThumbnailJobLogTable}
      (run_id, product_id, priority_bucket, source_name, status, thumbnail_path, error_message, processed_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,NOW())`,
    [
      row.runId,
      row.productId,
      row.bucket,
      row.sourceName,
      row.status,
      row.thumbnailPath,
      row.errorMessage,
    ]
  );
}

async function requestJson(url, timeoutMs) {
  const text = await requestText(url, timeoutMs);
  return JSON.parse(text);
}

async function requestText(url, timeoutMs) {
  const data = await requestBinary(url, timeoutMs);
  return data.buffer.toString("utf8");
}

async function requestBinary(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const mod = parsed.protocol === "http:" ? http : https;
    const req = mod.get(
      parsed,
      { timeout: timeoutMs, headers: { "User-Agent": "filedatachange-thumbnail-collector/1.0" } },
      (res) => {
        const status = res.statusCode || 0;
        if (status < 200 || status >= 300) {
          res.resume();
          reject(new Error(`http_status_${status}`));
          return;
        }
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          resolve({
            buffer: Buffer.concat(chunks),
            contentType: res.headers["content-type"] || "",
          });
        });
      }
    );
    req.on("timeout", () => {
      req.destroy(new Error("request_timeout"));
    });
    req.on("error", (err) => reject(err));
  });
}

async function connectDb(config) {
  loadEnvFile(config.envPath);
  assertSafeQualifiedName(config.dbMasterView, "master view");
  const client = createPgClient();
  await client.connect();
  return client;
}

function buildConfig(args) {
  const mode = (args.mode || CONFIG.mode).toLowerCase();
  if (!["dry-run", "execute"].includes(mode)) throw new Error(`Invalid mode: ${mode}`);
  const confirmExecute = args.confirmExecute || CONFIG.confirmExecute;
  if (mode === "execute" && confirmExecute !== "YES") {
    throw new Error("execute mode requires --confirm-execute YES");
  }
  return {
    ...CONFIG,
    mode,
    confirmExecute,
    dailyLimit: Number.isInteger(args.dailyLimit) ? args.dailyLimit : CONFIG.dailyLimit,
    thumbnailRootDir: args.thumbnailRootDir || CONFIG.thumbnailRootDir,
    csvLogDir: args.logDir || CONFIG.csvLogDir,
    knownPriorityListPath: args.knownList || CONFIG.knownPriorityListPath,
    wishListPath: args.wishList || CONFIG.wishListPath,
    dbMasterView: args.dbView || CONFIG.dbMasterView,
    dbThumbnailTable: args.dbThumbnailTable || CONFIG.dbThumbnailTable,
    dbThumbnailJobLogTable: args.dbThumbnailJobLogTable || CONFIG.dbThumbnailJobLogTable,
  };
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    const next = argv[i + 1];
    if (key === "--help" || key === "-h") args.help = true;
    else if (key === "--init-sample") args.initSample = true;
    else if (key === "--mode") args.mode = consumeValue(key, next, argv, ++i);
    else if (key === "--daily-limit") args.dailyLimit = Number.parseInt(consumeValue(key, next, argv, ++i), 10);
    else if (key === "--thumbnail-root-dir") args.thumbnailRootDir = consumeValue(key, next, argv, ++i);
    else if (key === "--log-dir") args.logDir = consumeValue(key, next, argv, ++i);
    else if (key === "--known-list") args.knownList = consumeValue(key, next, argv, ++i);
    else if (key === "--wish-list") args.wishList = consumeValue(key, next, argv, ++i);
    else if (key === "--db-view") args.dbView = consumeValue(key, next, argv, ++i);
    else if (key === "--db-thumbnail-table") args.dbThumbnailTable = consumeValue(key, next, argv, ++i);
    else if (key === "--db-thumbnail-job-log-table") args.dbThumbnailJobLogTable = consumeValue(key, next, argv, ++i);
    else if (key === "--run-id") args.runId = consumeValue(key, next, argv, ++i);
    else if (key === "--confirm-execute") args.confirmExecute = consumeValue(key, next, argv, ++i);
    else throw new Error(`Unknown argument: ${key}`);
  }
  return args;
}

async function loadIdList(filePath) {
  if (!fs.existsSync(filePath)) return [];
  const text = await fsp.readFile(filePath, "utf8");
  return text
    .split(/\r?\n/)
    .map((v) => v.trim())
    .filter((v) => /^[0-9]{6,7}$/.test(v));
}

function summarize(rows) {
  return rows.reduce(
    (acc, row) => {
      if (row.status === "success") acc.success += 1;
      else if (row.status === "error") acc.error += 1;
      else acc.skipped += 1;
      return acc;
    },
    { success: 0, skipped: 0, error: 0 }
  );
}

function writeCsv(csvPath, rows, columns) {
  const lines = [columns.join(",")];
  for (const row of rows) {
    lines.push(columns.map((c) => csvEscape(row[c])).join(","));
  }
  fs.writeFileSync(csvPath, `${lines.join("\n")}\n`, "utf8");
}

function csvEscape(value) {
  const text = String(value == null ? "" : value);
  return `"${text.replace(/"/g, '""')}"`;
}

function writeUsage() {
  process.stdout.write(
    [
      "Usage:",
      "  node thumbnail_collector.js --mode dry-run --daily-limit 100",
      "  node thumbnail_collector.js --mode execute --confirm-execute YES --daily-limit 100",
      "",
      "TODO markers:",
      "  - CONFIG_PATH: local folders",
      "  - DB: table/view names",
      "  - DB_QUERY: queue priority SQL",
      "  - API_CONFIG: provider endpoint and keys",
      "",
    ].join("\n")
  );
}

async function withTransaction(client, fn) {
  await client.query("BEGIN");
  try {
    const ret = await fn();
    await client.query("COMMIT");
    return ret;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

async function initSampleWorkspace(root) {
  ensureDirectory(path.join(root, "logs"));
  ensureDirectory(path.join(root, "thumbnails"));
  const known = path.join(root, "known_priority_ids.txt");
  const wish = path.join(root, "wishlist_ids.txt");
  if (!fs.existsSync(known)) await fsp.writeFile(known, "1234567\n2345678\n", "utf8");
  if (!fs.existsSync(wish)) await fsp.writeFile(wish, "3456789\n", "utf8");
}

function sanitizeFileName(name) {
  return String(name).replace(/[\\/:*?"<>|]/g, "_");
}

function ensureDirectory(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function consumeValue(name, value) {
  if (!value || value.startsWith("--")) throw new Error(`Missing value for ${name}`);
  return value;
}

function buildRunId(label) {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "").replace("T", "_");
  return `${stamp}_${label}`;
}

function assertSafeQualifiedName(value, label) {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*\.[a-zA-Z_][a-zA-Z0-9_]*$/.test(value)) {
    throw new Error(`Unsafe ${label}: ${value}`);
  }
}

function loadEnvFile(envPath) {
  if (!fs.existsSync(envPath)) throw new Error(`.env not found: ${envPath}`);
  const text = fs.readFileSync(envPath, "utf8");
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const idx = line.indexOf("=");
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    const value = unquoteEnvValue(line.slice(idx + 1).trim());
    if (key && process.env[key] === undefined) process.env[key] = value;
  }
}

function unquoteEnvValue(value) {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}

function requireEnv(name) {
  const value = process.env[name];
  if (!value || value.startsWith("CHANGE_ME_")) throw new Error(`${name} is not configured in .env`);
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

main().catch((error) => {
  process.stderr.write(`Thumbnail collector failed: ${error.message}\n`);
  process.exitCode = 1;
});
