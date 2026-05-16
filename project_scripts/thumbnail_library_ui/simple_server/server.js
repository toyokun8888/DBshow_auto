const fs = require("fs");
const path = require("path");
const express = require("express");
const cors = require("cors");
const { Client } = require("pg");

const PORT = Number(process.env.PORT || 3001);

// simple_server から見て ../../../ が filedatachange
const ENV_PATH = path.resolve(__dirname, "..", "..", "..", ".env");

const app = express();

app.use(
  cors({
    origin: ["http://localhost:5173", "http://127.0.0.1:5173"],
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

function createDbClient() {
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

function toNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function toBool(value) {
  return value === true || value === "true" || value === 1 || value === "1";
}

async function main() {
  loadEnvFile(ENV_PATH);

  const db = createDbClient();
  await db.connect();

  app.get("/api/health", async (_req, res) => {
    res.json({
      ok: true,
      app: "seller-completion-simple-server",
       version: "local-mp4-check-001",
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
            total_products,
            owned_products,
            missing_products,
            ROUND(
              owned_products::numeric / NULLIF(total_products, 0) * 100,
              1
            ) AS completion_rate
          FROM xxx_vq027_wiki_seller_summary_display
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
          WITH local_mp4 AS (
            SELECT
              product_id,
              COUNT(*) AS local_file_count,
              MIN(file_name) AS local_file_name,
              MIN(full_path) AS local_full_path,
              MIN(file_size) AS local_file_size,
              MIN(last_write_time) AS local_last_write_time
            FROM xxx_v_local_mp4_exists_master
            WHERE product_id ~ '^[0-9]{7}$'
            GROUP BY product_id
          )

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

          FROM xxx_vq028_wiki_seller_missing_products m

          LEFT JOIN xxx_vq025_rapidgator_best_links rg
            ON rg.fc2_product_id = m.product_id

          LEFT JOIN local_mp4 lm
            ON lm.product_id = m.product_id

          WHERE m.seller_id = $1

          ORDER BY m.product_id ASC
          LIMIT $2
        `,
        [sellerId, limit]
      );

      res.json({
        ok: true,
        sellerId,
        items: result.rows.map((row) => ({
          sellerId: String(row.seller_id || ""),
          productId: String(row.product_id || ""),
          title: String(row.title || ""),

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
        })),
      });
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
