const { Client } = require("pg");
require("dotenv").config({ quiet: true });

const DB_CONFIG = {
  host: requireEnv("PGHOST"),
  port: Number(process.env.PGPORT || 5432),
  database: requireEnv("PGDATABASE"),
  user: requireEnv("PGUSER"),
  password: requireEnv("PGPASSWORD"),
  ssl:
    (process.env.PGSSL || "false").toLowerCase() === "true"
      ? { rejectUnauthorized: false }
      : false,
};

const RELATIONS = [
  "xxx_vq030_rapidgator_wiki_display",
  "xxx_vq025_rapidgator_best_links",
  "xxx_vq002_owned_product_ids",
  "xxx_vq021_rapidgator_fc2_unowned",
  "xxx_vq028_wiki_seller_missing_products",
  "xxx_tm009_fc2_wiki_thumbnail_assets",
];

function requireEnv(name) {
  const value = process.env[name];
  if (!value || value.startsWith("CHANGE_ME_")) {
    throw new Error(`${name} is not configured`);
  }
  return value;
}

async function main() {
  const client = new Client(DB_CONFIG);
  await client.connect();
  try {
    const schemas = {};
    for (const relationName of RELATIONS) {
      schemas[relationName] = await getRelationInfo(client, relationName);
    }

    const counts = {};
    if (schemas.xxx_vq030_rapidgator_wiki_display.exists) {
      counts.vq030 = await countVq030Targets(client, schemas.xxx_vq030_rapidgator_wiki_display.columns);
    }
    if (schemas.xxx_vq025_rapidgator_best_links.exists) {
      counts.vq025_join_tm009 = await countVq025Targets(client);
    }

    process.stdout.write(
      `${JSON.stringify(
        {
          inspected_at: new Date().toISOString(),
          schemas,
          counts,
        },
        null,
        2
      )}\n`
    );
  } finally {
    await client.end().catch(() => {});
  }
}

async function getRelationInfo(client, relationName) {
  const existsResult = await client.query(
    "SELECT to_regclass($1) IS NOT NULL AS exists",
    [`public.${relationName}`]
  );
  if (!existsResult.rows[0].exists) {
    return { exists: false, columns: [] };
  }

  const columnsResult = await client.query(
    `
      SELECT column_name, data_type
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = $1
      ORDER BY ordinal_position
    `,
    [relationName]
  );

  return {
    exists: true,
    columns: columnsResult.rows,
  };
}

async function countVq030Targets(client, columns) {
  const columnNames = new Set(columns.map((column) => column.column_name));
  const idColumn = columnNames.has("fc2_product_id") ? "fc2_product_id" : "product_id";
  const dlPredicates = [];
  const thumbnailPredicates = [];

  if (columnNames.has("has_rapidgator")) {
    dlPredicates.push("has_rapidgator = true");
  }
  for (const columnName of ["best_mp4_url", "rapidgator_mp4_url", "sample_file_url", "best_page_url"]) {
    if (columnNames.has(columnName)) {
      dlPredicates.push(`COALESCE(${quoteIdent(columnName)}::text, '') <> ''`);
    }
  }

  if (columnNames.has("has_local_thumbnail")) {
    thumbnailPredicates.push("has_local_thumbnail = false");
  }
  if (columnNames.has("local_thumbnail_path")) {
    thumbnailPredicates.push("COALESCE(local_thumbnail_path, '') = ''");
  }
  if (columnNames.has("thumbnail_status")) {
    thumbnailPredicates.push("COALESCE(thumbnail_status, '') <> 'collected'");
  }

  if (!columnNames.has(idColumn) || dlPredicates.length === 0 || thumbnailPredicates.length === 0) {
    return {
      usable: false,
      reason: "required id, downloadable, or thumbnail columns were not found",
      id_column: idColumn,
      dl_predicates: dlPredicates,
      thumbnail_predicates: thumbnailPredicates,
    };
  }

  const sql = `
    SELECT
      COUNT(*)::integer AS rows,
      COUNT(DISTINCT ${quoteIdent(idColumn)})::integer AS distinct_products
    FROM public.xxx_vq030_rapidgator_wiki_display
    WHERE ${quoteIdent(idColumn)}::text ~ '^[0-9]{6,8}$'
      AND (${dlPredicates.join(" OR ")})
      AND (${thumbnailPredicates.join(" OR ")})
  `;
  const sampleSql = `
    SELECT ${quoteIdent(idColumn)}::text AS product_id
    FROM public.xxx_vq030_rapidgator_wiki_display
    WHERE ${quoteIdent(idColumn)}::text ~ '^[0-9]{6,8}$'
      AND (${dlPredicates.join(" OR ")})
      AND (${thumbnailPredicates.join(" OR ")})
    GROUP BY ${quoteIdent(idColumn)}
    ORDER BY ${quoteIdent(idColumn)}::bigint DESC
    LIMIT 20
  `;

  const [countResult, sampleResult] = await Promise.all([
    client.query(sql),
    client.query(sampleSql),
  ]);

  return {
    usable: true,
    id_column: idColumn,
    dl_predicates: dlPredicates,
    thumbnail_predicates: thumbnailPredicates,
    rows: countResult.rows[0].rows,
    distinct_products: countResult.rows[0].distinct_products,
    sample_desc: sampleResult.rows.map((row) => row.product_id),
  };
}

async function countVq025Targets(client) {
  const sql = `
    SELECT
      COUNT(*)::integer AS rows,
      COUNT(DISTINCT b.fc2_product_id)::integer AS distinct_products
    FROM public.xxx_vq025_rapidgator_best_links b
    LEFT JOIN public.xxx_tm009_fc2_wiki_thumbnail_assets t
      ON t.product_id = b.fc2_product_id::text
     AND t.thumbnail_status = 'collected'
    WHERE b.fc2_product_id::text ~ '^[0-9]{6,8}$'
      AND (
        b.has_rapidgator = true
        OR COALESCE(b.best_mp4_url::text, '') <> ''
        OR COALESCE(b.best_page_url::text, '') <> ''
      )
      AND t.product_id IS NULL
  `;
  const sampleSql = `
    SELECT b.fc2_product_id::text AS product_id
    FROM public.xxx_vq025_rapidgator_best_links b
    LEFT JOIN public.xxx_tm009_fc2_wiki_thumbnail_assets t
      ON t.product_id = b.fc2_product_id::text
     AND t.thumbnail_status = 'collected'
    WHERE b.fc2_product_id::text ~ '^[0-9]{6,8}$'
      AND (
        b.has_rapidgator = true
        OR COALESCE(b.best_mp4_url::text, '') <> ''
        OR COALESCE(b.best_page_url::text, '') <> ''
      )
      AND t.product_id IS NULL
    GROUP BY b.fc2_product_id
    ORDER BY b.fc2_product_id::bigint DESC
    LIMIT 20
  `;

  const [countResult, sampleResult] = await Promise.all([
    client.query(sql),
    client.query(sampleSql),
  ]);

  return {
    usable: true,
    rows: countResult.rows[0].rows,
    distinct_products: countResult.rows[0].distinct_products,
    sample_desc: sampleResult.rows.map((row) => row.product_id),
  };
}

function quoteIdent(value) {
  if (!/^[a-z_][a-z0-9_]*$/i.test(value)) {
    throw new Error(`Unsafe identifier: ${value}`);
  }
  return `"${value.replace(/"/g, '""')}"`;
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message || error}\n`);
  process.exitCode = 1;
});
