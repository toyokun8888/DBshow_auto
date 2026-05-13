const fs = require("fs");
const path = require("path");
const express = require("express");
const cors = require("cors");
const { Client } = require("pg");

const PORT = Number(process.env.PORT || 3001);

// simple_server から見て ../../../ が filedatachange
const ENV_PATH = path.resolve(__dirname, "..", "..", "..", ".env");

const app = express();

app.use(cors());
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

async function main() {
  loadEnvFile(ENV_PATH);

  const db = createDbClient();
  await db.connect();

  app.get("/api/health", async (_req, res) => {
    res.json({
      ok: true,
      app: "seller-completion-simple-server",
      envPath: ENV_PATH,
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
          FROM xxx_VQ013_owned_seller_summary_display
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

        const result = await db.query(
        `
            SELECT
            m.seller_id,
            m.product_id,
            m.title
            FROM xxx_VQ001_moviemaster_unique m
            WHERE m.seller_id = $1
            AND NOT EXISTS (
                SELECT 1
                FROM xxx_VQ002_owned_product_ids o
                WHERE o.product_id::text = m.product_id
            )
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
        })),
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

  app.listen(PORT, () => {
    console.log(`simple server started: http://localhost:${PORT}`);
    console.log(`env: ${ENV_PATH}`);
  });
}

main().catch((error) => {
  console.error("simple server failed");
  console.error(error.message);
  process.exitCode = 1;
});