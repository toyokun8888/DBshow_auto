const fs = require("fs");
const path = require("path");
const express = require("express");
const cors = require("cors");
const { Pool } = require("pg");

const PORT = Number(process.env.PORT || 3001);

// simple_server から見て ../../../ が filedatachange
const PROJECT_ROOT = path.resolve(__dirname, "..", "..", "..");
const ENV_PATH = path.resolve(PROJECT_ROOT, ".env");

const app = express();

app.use(
  cors({
    origin: [
      "http://localhost",
      "http://127.0.0.1",
      "http://localhost:5173",
      "http://127.0.0.1:5173",
    ],
  })
);
app.use(express.json());

function loadEnvFile(envPath) {
  if (!fs.existsSync(envPath)) {
    throw new Error(`.env not found: ${envPath}`);
  }

  const text = fs.readFileSync(envPath, "utf8");

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();

    if (!line || line.startsWith("#")) continue;

    const separatorIndex = line.indexOf("=");
    if (separatorIndex === -1) continue;

    const key = line.slice(0, separatorIndex).trim();
    const value = unquoteEnvValue(line.slice(separatorIndex + 1).trim());

    if (key && process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

function unquoteEnvValue(value) {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }

  return value;
}

function requireEnv(name) {
  const value = process.env[name];

  if (!value || value.startsWith("CHANGE_ME_")) {
    throw new Error(`${name} is not configured in .env`);
  }

  return value;
}

function createDbPool() {
  const sslValue = (process.env.PGSSL || "false").toLowerCase();

  return new Pool({
    host: requireEnv("PGHOST"),
    port: Number(process.env.PGPORT || 5432),
    database: requireEnv("PGDATABASE"),
    user: requireEnv("PGUSER"),
    password: requireEnv("PGPASSWORD"),
    ssl: sslValue === "true" ? { rejectUnauthorized: false } : false,
  });
}

function toNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function toBool(value) {
  return value === true || value === "true" || value === 1 || value === "1";
}

function normalizeWindowsPath(targetPath) {
  const raw = String(targetPath || "").trim().replace(/\//g, "\\");
  const fixedDrive = raw.replace(/^([A-Za-z]):(?![\\])/, "$1:\\");
  return path.normalize(fixedDrive).replace(/\//g, "\\");
}

function resolveThumbnailRoots() {
  const raw = (process.env.THUMBNAIL_ALLOWED_ROOTS || "").trim();
  const configuredRoots = raw
    ? raw
        .split(";")
        .map((value) => normalizeWindowsPath(value.trim()))
        .filter(Boolean)
    : [];
  return configuredRoots.length > 0
    ? configuredRoots
    : [normalizeWindowsPath(path.join(PROJECT_ROOT, "fc2_sum"))];
}

function isPathUnderRoots(targetPath, roots) {
  const normalized = normalizeWindowsPath(targetPath).toLowerCase();
  return roots.some((root) => {
    const rootLower = normalizeWindowsPath(root).toLowerCase().replace(/[\\]+$/, "");
    return normalized === rootLower || normalized.startsWith(`${rootLower}\\`);
  });
}

function contentTypeForImage(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".png") return "image/png";
  if (ext === ".webp") return "image/webp";
  return "image/jpeg";
}

async function resolveThumbnailPath(db, productId) {
  const result = await db.query(
    `
      SELECT local_thumbnail_path
      FROM public.xxx_tm009_fc2_wiki_thumbnail_assets
      WHERE product_id = $1
        AND COALESCE(local_thumbnail_path, '') <> ''
        AND thumbnail_status = 'collected'
      LIMIT 1
    `,
    [productId]
  );
  return result.rows[0]?.local_thumbnail_path || "";
}

function mapSellerProductRow(row) {
  return {
    sellerId: String(row.seller_id || ""),
    sellerName: String(row.seller_name || row.seller_id || ""),
    productId: String(row.product_id || ""),
    title: String(row.title || ""),
    thumbnailPath:
      toBool(row.has_local_thumbnail) && row.product_id
        ? `/api/library/thumbnail/${row.product_id}`
        : "",
    thumbnailStatus: String(row.thumbnail_status || "unknown"),
    isOwned: toBool(row.is_owned),
    isLibraryOwned: toBool(row.is_library_owned),

    hasRapidgator: toBool(row.has_rapidgator),
    hasMp4: toBool(row.has_mp4),
    hasRar: toBool(row.has_rar),

    rapidgatorMp4Url: String(row.rapidgator_mp4_url || ""),
    rapidgatorPageUrl: String(row.rapidgator_page_url || ""),
    rapidgatorAllUrls: row.rapidgator_all_urls
      ? String(row.rapidgator_all_urls)
          .split(" | ")
          .map((v) => v.trim())
          .filter(Boolean)
      : [],

    rapidgatorMp4Title: String(row.rapidgator_mp4_title || ""),
    rapidgatorMp4Size: String(row.rapidgator_mp4_size || ""),

    rapidgatorTotalRecords: toNumber(row.rapidgator_total_records),
    rapidgatorMp4Count: toNumber(row.rapidgator_mp4_count),
    rapidgatorRarCount: toNumber(row.rapidgator_rar_count),

    localFileExists: toBool(row.local_file_exists),
    localFileCount: toNumber(row.local_file_count),
    localFileName: String(row.local_file_name || ""),
    localFullPath: String(row.local_full_path || ""),
    localFileSize: String(row.local_file_size || ""),
    localLastWriteTime: String(row.local_last_write_time || ""),
  };
}

async function main() {
  loadEnvFile(ENV_PATH);

  const db = createDbPool();
  await db.query("SELECT 1");

  app.get("/api/health", async (_req, res) => {
    res.json({
      ok: true,
      app: "seller-completion-simple-server",
      version: "seller-cache-v1",
      port: PORT,
    });
  });

  app.get("/api/seller-summary", async (req, res) => {
    try {
      const limit = Math.min(Math.max(Number(req.query.limit || 1000), 1), 5000);
      const sort = String(req.query.sort || "missing_asc");

      const orderBy =
        sort === "missing_desc"
          ? "missing_products DESC, seller_id ASC"
          : sort === "owned_desc"
            ? "owned_products DESC, seller_id ASC"
            : sort === "total_desc"
              ? "total_products DESC, seller_id ASC"
              : "missing_products ASC, seller_id ASC";

      const result = await db.query(
        `
          SELECT
            seller_id,
            COALESCE(seller_name, seller_id) AS seller_name,
            COUNT(*)::integer AS total_products,
            COUNT(*) FILTER (WHERE is_owned)::integer AS owned_products,
            COUNT(*) FILTER (WHERE NOT is_owned)::integer AS missing_products,
            ROUND(
              COUNT(*) FILTER (WHERE is_owned)::numeric / NULLIF(COUNT(*), 0) * 100,
              1
            ) AS completion_rate
          FROM xxx_tm010_seller_completion_product_cache
          GROUP BY seller_id, seller_name
          ORDER BY ${orderBy}
          LIMIT $1
        `,
        [limit]
      );

      res.json({
        ok: true,
        sellers: result.rows.map((row) => ({
          sellerId: String(row.seller_id || ""),
          sellerName: String(row.seller_name || row.seller_id || ""),
          totalProducts: toNumber(row.total_products),
          ownedProducts: toNumber(row.owned_products),
          missingProducts: toNumber(row.missing_products),
          completionRate: toNumber(row.completion_rate),
        })),
      });
    } catch (error) {
      res.status(500).json({
        ok: false,
        message: error.message,
      });
    }
  });

  app.get("/api/seller-missing/:sellerId", async (req, res) => {
    try {
      const sellerId = req.params.sellerId;
      const limit = Math.min(Math.max(Number(req.query.limit || 500), 1), 5000);
      const includeRapidgator = String(req.query.includeRapidgator || "0") === "1";

      if (!includeRapidgator) {
        const result = await db.query(
          `
            WITH target_products AS (
              SELECT
                seller_id,
                COALESCE(seller_name, seller_id) AS seller_name,
                product_id,
                title,
                is_owned
              FROM xxx_tm010_seller_completion_product_cache
              WHERE seller_id = $1
              ORDER BY product_id ASC
              LIMIT $2
            )

            SELECT
              m.seller_id,
              m.seller_name,
              m.product_id,
              m.title,
              COALESCE(t.thumbnail_status, 'unknown') AS thumbnail_status,
              CASE
                WHEN t.thumbnail_status = 'collected'
                  AND COALESCE(t.local_thumbnail_path, '') <> ''
                THEN true
              ELSE false
              END AS has_local_thumbnail,
              m.is_owned,
              EXISTS (
                SELECT 1
                FROM xxx_tm002_owned_files ofi
                WHERE ofi.product_id = m.product_id
                  AND ofi.status = 'owned'
              ) AS is_library_owned,

              false AS has_rapidgator,
              false AS has_mp4,
              false AS has_rar,
              '' AS rapidgator_mp4_url,
              '' AS rapidgator_page_url,
              '' AS rapidgator_all_urls,
              '' AS rapidgator_mp4_title,
              '' AS rapidgator_mp4_size,
              0 AS rapidgator_total_records,
              0 AS rapidgator_mp4_count,
              0 AS rapidgator_rar_count,

              false AS local_file_exists,
              0 AS local_file_count,
              '' AS local_file_name,
              '' AS local_full_path,
              '' AS local_file_size,
              '' AS local_last_write_time

            FROM target_products m

            LEFT JOIN xxx_tm009_fc2_wiki_thumbnail_assets t
              ON t.product_id = m.product_id

            ORDER BY m.product_id ASC
          `,
          [sellerId, limit]
        );

        res.json({
          ok: true,
          sellerId,
          items: result.rows.map(mapSellerProductRow),
        });
        return;
      }

      /*
        旧SQLバックアップ：
        既存の未所持判定ロジックは下記。
        今回はこの判定そのものは変えず、
        local_mp4 情報だけ LEFT JOIN で注釈追加する。

        SELECT
          m.seller_id,
          m.product_id,
          m.title,

          CASE
            WHEN rg.fc2_product_id IS NOT NULL THEN true
            ELSE false
          END AS has_rapidgator,

          COALESCE(rg.has_mp4, false) AS has_mp4,
          COALESCE(rg.has_rar, false) AS has_rar,

          COALESCE(rg.best_mp4_url, '') AS rapidgator_mp4_url,
          COALESCE(rg.best_page_url, '') AS rapidgator_page_url,
          COALESCE(rg.all_urls, '') AS rapidgator_all_urls,

          COALESCE(rg.best_mp4_title, '') AS rapidgator_mp4_title,
          COALESCE(rg.best_mp4_size, '') AS rapidgator_mp4_size,

          COALESCE(rg.total_records, 0) AS rapidgator_total_records,
          COALESCE(rg.mp4_count, 0) AS rapidgator_mp4_count,
          COALESCE(rg.rar_count, 0) AS rapidgator_rar_count

        FROM xxx_VQ001_moviemaster_unique m

        LEFT JOIN xxx_vq025_rapidgator_best_links rg
          ON rg.fc2_product_id = m.product_id

        WHERE m.seller_id = $1
          AND NOT EXISTS (
            SELECT 1
            FROM xxx_VQ002_owned_product_ids o
            WHERE o.product_id::text = m.product_id
          )

        ORDER BY m.product_id ASC
        LIMIT $2
      */

      const result = await db.query(
        `
          WITH target_products AS (
            SELECT
              seller_id,
              COALESCE(seller_name, seller_id) AS seller_name,
              product_id,
              title,
              is_owned
            FROM xxx_tm010_seller_completion_product_cache
            WHERE seller_id = $1
            ORDER BY product_id ASC
            LIMIT $2
          ),
          local_mp4 AS (
            SELECT
              lm.product_id,
              COUNT(*) AS local_file_count,
              MIN(lm.file_name) AS local_file_name,
              MIN(lm.full_path) AS local_full_path,
              MIN(lm.file_size) AS local_file_size,
              MIN(lm.last_write_time) AS local_last_write_time
            FROM xxx_v_local_mp4_exists_master lm
            JOIN target_products m
              ON m.product_id = lm.product_id
            WHERE lm.product_id ~ '^[0-9]{7}$'
            GROUP BY lm.product_id
          ),
          rg_rows AS (
            SELECT r.*
            FROM xxx_vq020_rapidgator_group_normalized r
            JOIN target_products m
              ON m.product_id = r.fc2_product_id
            WHERE NULLIF(r.fc2_product_id, '') IS NOT NULL
          ),
          rg_summary AS (
            SELECT
              r.fc2_product_id,
              true AS has_rapidgator,
              COUNT(*) AS total_records,
              COUNT(*) FILTER (WHERE lower(r.file_ext) = 'mp4') AS mp4_count,
              COUNT(*) FILTER (WHERE lower(r.file_ext) = 'rar') AS rar_count,
              string_agg(r.file_url, ' | ' ORDER BY r.file_title) AS all_urls
            FROM rg_rows r
            GROUP BY r.fc2_product_id
          ),
          rg_mp4 AS (
            SELECT DISTINCT ON (r.fc2_product_id)
              r.fc2_product_id,
              r.file_title AS best_mp4_title,
              r.file_url AS best_mp4_url,
              r.file_size AS best_mp4_size
            FROM rg_rows r
            WHERE lower(r.file_ext) = 'mp4'
            ORDER BY
              r.fc2_product_id,
              CASE
                WHEN NULLIF(r.part_no, '') IS NULL THEN 0
                WHEN NULLIF(r.part_no, '') = '1' THEN 1
                ELSE 2
              END,
              r.page_number::integer,
              r.row_index_in_page::integer,
              r.file_title
          ),
          rg_page AS (
            SELECT DISTINCT ON (r.fc2_product_id)
              r.fc2_product_id,
              r.source_page_url AS best_page_url
            FROM rg_rows r
            ORDER BY
              r.fc2_product_id,
              CASE
                WHEN lower(r.file_ext) = 'mp4' THEN 0
                WHEN lower(r.file_ext) = 'rar' THEN 1
                ELSE 2
              END,
              r.page_number::integer,
              r.row_index_in_page::integer,
              r.file_title
          ),
          rg AS (
            SELECT
              s.fc2_product_id,
              s.has_rapidgator,
              s.mp4_count > 0 AS has_mp4,
              s.rar_count > 0 AS has_rar,
              COALESCE(m.best_mp4_url, '') AS best_mp4_url,
              COALESCE(p.best_page_url, '') AS best_page_url,
              COALESCE(s.all_urls, '') AS all_urls,
              COALESCE(m.best_mp4_title, '') AS best_mp4_title,
              COALESCE(m.best_mp4_size, '') AS best_mp4_size,
              s.total_records,
              s.mp4_count,
              s.rar_count
            FROM rg_summary s
            LEFT JOIN rg_mp4 m
              ON m.fc2_product_id = s.fc2_product_id
            LEFT JOIN rg_page p
              ON p.fc2_product_id = s.fc2_product_id
          )

          SELECT
            m.seller_id,
            m.seller_name,
            m.product_id,
            m.title,
            COALESCE(t.thumbnail_status, 'unknown') AS thumbnail_status,
            CASE
              WHEN t.thumbnail_status = 'collected'
                AND COALESCE(t.local_thumbnail_path, '') <> ''
              THEN true
            ELSE false
            END AS has_local_thumbnail,
            m.is_owned,
            EXISTS (
              SELECT 1
              FROM xxx_tm002_owned_files ofi
              WHERE ofi.product_id = m.product_id
                AND ofi.status = 'owned'
            ) AS is_library_owned,

            CASE
              WHEN rg.fc2_product_id IS NOT NULL THEN true
              ELSE false
            END AS has_rapidgator,

            COALESCE(rg.has_mp4, false) AS has_mp4,
            COALESCE(rg.has_rar, false) AS has_rar,

            COALESCE(rg.best_mp4_url, '') AS rapidgator_mp4_url,
            COALESCE(rg.best_page_url, '') AS rapidgator_page_url,
            COALESCE(rg.all_urls, '') AS rapidgator_all_urls,

            COALESCE(rg.best_mp4_title, '') AS rapidgator_mp4_title,
            COALESCE(rg.best_mp4_size, '') AS rapidgator_mp4_size,

            COALESCE(rg.total_records, 0) AS rapidgator_total_records,
            COALESCE(rg.mp4_count, 0) AS rapidgator_mp4_count,
            COALESCE(rg.rar_count, 0) AS rapidgator_rar_count,

            CASE
              WHEN lm.product_id IS NOT NULL THEN true
              ELSE false
            END AS local_file_exists,

            COALESCE(lm.local_file_count, 0) AS local_file_count,
            COALESCE(lm.local_file_name, '') AS local_file_name,
            COALESCE(lm.local_full_path, '') AS local_full_path,
            COALESCE(lm.local_file_size::text, '') AS local_file_size,
            COALESCE(lm.local_last_write_time::text, '') AS local_last_write_time

          FROM target_products m

          LEFT JOIN rg
            ON rg.fc2_product_id = m.product_id

          LEFT JOIN local_mp4 lm
            ON lm.product_id = m.product_id

          LEFT JOIN xxx_tm009_fc2_wiki_thumbnail_assets t
            ON t.product_id = m.product_id

          ORDER BY m.product_id ASC
        `,
        [sellerId, limit]
      );

      res.json({
        ok: true,
        sellerId,
        items: result.rows.map(mapSellerProductRow),
      });
    } catch (error) {
      res.status(500).json({
        ok: false,
        message: error.message,
      });
    }
  });

  app.get("/api/seller-products/search", async (req, res) => {
    try {
      const query = String(req.query.q || "").trim();
      const limit = Math.min(Math.max(Number(req.query.limit || 500), 1), 5000);

      if (query.length < 2) {
        res.json({
          ok: true,
          sellerId: "global",
          items: [],
        });
        return;
      }

      const likeQuery = `%${query}%`;
      const prefixQuery = `${query}%`;
      const isProductIdQuery = /^[0-9]{5,9}$/.test(query);
      const targetWhere = isProductIdQuery
        ? "w.product_id = $1"
        : `
              w.product_id ILIKE $1
               OR w.product_id ILIKE $2
               OR w.title ILIKE $2
               OR w.seller_name ILIKE $2
               OR w.seller_id ILIKE $2
          `;
      const limitPlaceholder = isProductIdQuery ? "$2" : "$3";
      const searchParams = isProductIdQuery
        ? [query, limit]
        : [prefixQuery, likeQuery, limit];

      const result = await db.query(
        `
          WITH target_products AS (
            SELECT DISTINCT ON (w.product_id)
              w.seller_id,
              w.seller_name,
              w.product_id,
              w.title,
              w.is_owned
            FROM xxx_tm010_seller_completion_product_cache w
            WHERE ${targetWhere}
            ORDER BY
              w.product_id,
              w.title ASC
            LIMIT ${limitPlaceholder}
          ),
          local_mp4 AS (
            SELECT
              lm.product_id,
              COUNT(*) AS local_file_count,
              MIN(lm.file_name) AS local_file_name,
              MIN(lm.full_path) AS local_full_path,
              MIN(lm.file_size) AS local_file_size,
              MIN(lm.last_write_time) AS local_last_write_time
            FROM xxx_v_local_mp4_exists_master lm
            JOIN target_products w
              ON w.product_id = lm.product_id
            WHERE lm.product_id ~ '^[0-9]{7}$'
            GROUP BY lm.product_id
          ),
          rg_rows AS (
            SELECT r.*
            FROM xxx_vq020_rapidgator_group_normalized r
            JOIN target_products w
              ON w.product_id = r.fc2_product_id
            WHERE NULLIF(r.fc2_product_id, '') IS NOT NULL
          ),
          rg_summary AS (
            SELECT
              r.fc2_product_id,
              true AS has_rapidgator,
              COUNT(*) AS total_records,
              COUNT(*) FILTER (WHERE lower(r.file_ext) = 'mp4') AS mp4_count,
              COUNT(*) FILTER (WHERE lower(r.file_ext) = 'rar') AS rar_count,
              string_agg(r.file_url, ' | ' ORDER BY r.file_title) AS all_urls
            FROM rg_rows r
            GROUP BY r.fc2_product_id
          ),
          rg_mp4 AS (
            SELECT DISTINCT ON (r.fc2_product_id)
              r.fc2_product_id,
              r.file_title AS best_mp4_title,
              r.file_url AS best_mp4_url,
              r.file_size AS best_mp4_size
            FROM rg_rows r
            WHERE lower(r.file_ext) = 'mp4'
            ORDER BY
              r.fc2_product_id,
              CASE
                WHEN NULLIF(r.part_no, '') IS NULL THEN 0
                WHEN NULLIF(r.part_no, '') = '1' THEN 1
                ELSE 2
              END,
              r.page_number::integer,
              r.row_index_in_page::integer,
              r.file_title
          ),
          rg_page AS (
            SELECT DISTINCT ON (r.fc2_product_id)
              r.fc2_product_id,
              r.source_page_url AS best_page_url
            FROM rg_rows r
            ORDER BY
              r.fc2_product_id,
              CASE
                WHEN lower(r.file_ext) = 'mp4' THEN 0
                WHEN lower(r.file_ext) = 'rar' THEN 1
                ELSE 2
              END,
              r.page_number::integer,
              r.row_index_in_page::integer,
              r.file_title
          ),
          rg AS (
            SELECT
              s.fc2_product_id,
              s.has_rapidgator,
              s.mp4_count > 0 AS has_mp4,
              s.rar_count > 0 AS has_rar,
              COALESCE(m.best_mp4_url, '') AS best_mp4_url,
              COALESCE(p.best_page_url, '') AS best_page_url,
              COALESCE(s.all_urls, '') AS all_urls,
              COALESCE(m.best_mp4_title, '') AS best_mp4_title,
              COALESCE(m.best_mp4_size, '') AS best_mp4_size,
              s.total_records,
              s.mp4_count,
              s.rar_count
            FROM rg_summary s
            LEFT JOIN rg_mp4 m
              ON m.fc2_product_id = s.fc2_product_id
            LEFT JOIN rg_page p
              ON p.fc2_product_id = s.fc2_product_id
          )

          SELECT
            w.seller_id,
            w.seller_name,
            w.product_id,
            w.title,
            COALESCE(t.thumbnail_status, 'unknown') AS thumbnail_status,
            CASE
              WHEN t.thumbnail_status = 'collected'
                AND COALESCE(t.local_thumbnail_path, '') <> ''
              THEN true
              ELSE false
            END AS has_local_thumbnail,
            w.is_owned,
            EXISTS (
              SELECT 1
              FROM xxx_tm002_owned_files ofi
              WHERE ofi.product_id = w.product_id
                AND ofi.status = 'owned'
            ) AS is_library_owned,

            CASE
              WHEN rg.fc2_product_id IS NOT NULL THEN true
              ELSE false
            END AS has_rapidgator,

            COALESCE(rg.has_mp4, false) AS has_mp4,
            COALESCE(rg.has_rar, false) AS has_rar,

            COALESCE(rg.best_mp4_url, '') AS rapidgator_mp4_url,
            COALESCE(rg.best_page_url, '') AS rapidgator_page_url,
            COALESCE(rg.all_urls, '') AS rapidgator_all_urls,

            COALESCE(rg.best_mp4_title, '') AS rapidgator_mp4_title,
            COALESCE(rg.best_mp4_size, '') AS rapidgator_mp4_size,

            COALESCE(rg.total_records, 0) AS rapidgator_total_records,
            COALESCE(rg.mp4_count, 0) AS rapidgator_mp4_count,
            COALESCE(rg.rar_count, 0) AS rapidgator_rar_count,

            CASE
              WHEN lm.product_id IS NOT NULL THEN true
              ELSE false
            END AS local_file_exists,

            COALESCE(lm.local_file_count, 0) AS local_file_count,
            COALESCE(lm.local_file_name, '') AS local_file_name,
            COALESCE(lm.local_full_path, '') AS local_full_path,
            COALESCE(lm.local_file_size::text, '') AS local_file_size,
            COALESCE(lm.local_last_write_time::text, '') AS local_last_write_time

          FROM target_products w

          LEFT JOIN xxx_tm009_fc2_wiki_thumbnail_assets t
            ON t.product_id = w.product_id

          LEFT JOIN rg
            ON rg.fc2_product_id = w.product_id

          LEFT JOIN local_mp4 lm
            ON lm.product_id = w.product_id

          ORDER BY
            w.product_id,
            CASE
              WHEN t.thumbnail_status = 'collected'
                AND COALESCE(t.local_thumbnail_path, '') <> ''
              THEN 0
              ELSE 1
            END,
            w.title ASC
        `,
        searchParams
      );

      res.json({
        ok: true,
        sellerId: "global",
        items: result.rows.map(mapSellerProductRow),
      });
    } catch (error) {
      res.status(500).json({
        ok: false,
        message: error.message,
      });
    }
  });

  app.get("/api/library/thumbnail/:productId", async (req, res) => {
    try {
      const productId = String(req.params.productId || "").trim();

      if (!/^[0-9]{6,8}$/.test(productId)) {
        res.status(400).json({
          ok: false,
          message: "invalid_product_id",
        });
        return;
      }

      const thumbnailPath = await resolveThumbnailPath(db, productId);
      if (!thumbnailPath) {
        res.status(404).json({
          ok: false,
          message: "thumbnail_not_found",
        });
        return;
      }

      const normalized = normalizeWindowsPath(thumbnailPath);
      if (!isPathUnderRoots(normalized, resolveThumbnailRoots())) {
        res.status(403).json({
          ok: false,
          message: "thumbnail_path_not_allowed",
        });
        return;
      }

      if (!fs.existsSync(normalized)) {
        res.status(404).json({
          ok: false,
          message: "thumbnail_file_not_exists",
        });
        return;
      }

      res.statusCode = 200;
      res.setHeader("Content-Type", contentTypeForImage(normalized));
      fs.createReadStream(normalized).pipe(res);
    } catch (error) {
      res.status(500).json({
        ok: false,
        message: error.message,
      });
    }
  });

  app.get("/api/rapidgator/groups", async (_req, res) => {
    try {
      const result = await db.query(`
        SELECT
          normalized_group_key,
          sample_group_rule,
          total_records,
          distinct_base_title_count,
          mp4_count,
          rar_count,
          file_ext_list
        FROM xxx_vq023_rapidgator_group_summary
        ORDER BY total_records DESC
        LIMIT 5000
      `);

      res.json({
        ok: true,
        groups: result.rows.map((row) => ({
          groupKey: String(row.normalized_group_key || "unknown"),
          groupRule: String(row.sample_group_rule || "unknown"),
          totalRecords: toNumber(row.total_records),
          uniqueTitles: toNumber(row.distinct_base_title_count),
          mp4Count: toNumber(row.mp4_count),
          rarCount: toNumber(row.rar_count),
          totalSizeText: "",
          fileExtList: String(row.file_ext_list || "")
            .split(",")
            .map((v) => v.trim())
            .filter(Boolean),
        })),
      });
    } catch (error) {
      res.status(500).json({
        ok: false,
        message: error.message,
      });
    }
  });

  app.get("/api/rapidgator/group/:groupKey/items", async (req, res) => {
    try {
      const groupKey = req.params.groupKey;
      const limit = Math.min(Math.max(Number(req.query.limit || 1000), 1), 5000);

      const result = await db.query(
        `
          SELECT
            base_title_without_part,
            fc2_product_id,
            wiki_seller_name,
            wiki_display_title,
            has_local_thumbnail,
            thumbnail_status,
            sample_file_title,
            sample_folder_name,
            sample_file_url,
            file_ext_list,
            mp4_count,
            rar_count,
            total_records,
            sample_file_url,
            sample_file_title,
            sample_file_url,
            sample_file_url,
            min_page_number,
            max_page_number,
            file_title_list,
            file_url_list
          FROM xxx_vq030_rapidgator_wiki_display
          WHERE COALESCE(NULLIF(normalized_group_key, ''), 'unknown') = $1
          ORDER BY total_records DESC, base_title_without_part ASC
          LIMIT $2
        `,
        [groupKey, limit]
      );

      res.json({
        ok: true,
        groupKey,
        items: result.rows.map((row) => {
          const urls = String(row.file_url_list || "")
            .split(" | ")
            .map((v) => v.trim())
            .filter(Boolean);

          return {
            productId: String(row.fc2_product_id || ""),
            baseTitle: String(row.base_title_without_part || ""),
            fileTitle: String(row.sample_file_title || ""),
            sellerName: String(row.wiki_seller_name || ""),
            fileExt: String(row.file_ext_list || ""),
            fileSize: "",
            thumbnailPath:
              toBool(row.has_local_thumbnail) && row.fc2_product_id
                ? `/api/library/thumbnail/${row.fc2_product_id}`
                : "",
            thumbnailStatus: String(row.thumbnail_status || "unknown"),
            hasMp4: toNumber(row.mp4_count) > 0,
            hasRar: toNumber(row.rar_count) > 0,
            mp4Count: toNumber(row.mp4_count),
            rarCount: toNumber(row.rar_count),
            rapidgatorMp4Url: "",
            rapidgatorPageUrl: String(row.sample_file_url || ""),
            rapidgatorAllUrls: urls,
            totalRecords: toNumber(row.total_records),
          };
        }),
      });
    } catch (error) {
      res.status(500).json({
        ok: false,
        message: error.message,
      });
    }
  });

  app.use((_req, res) => {
    res.status(404).json({
      ok: false,
      message: "not_found",
    });
  });

  app.listen(PORT, "127.0.0.1", () => {
    console.log(`simple server started: http://localhost:${PORT}`);
    console.log(`env: ${ENV_PATH}`);
  });
}

main().catch((error) => {
  console.error("simple server failed");
  console.error(error.message);
  process.exitCode = 1;
});
