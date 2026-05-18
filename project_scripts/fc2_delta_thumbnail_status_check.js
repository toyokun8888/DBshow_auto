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
    const targetStatus = await client.query(`
      SELECT target_status, count(*) AS rows
      FROM public.xxx_tm010_fc2_delta_thumbnail_targets
      GROUP BY target_status
      ORDER BY target_status
    `);
    console.log("targets");
    console.table(targetStatus.rows);

    const recentAssetStatus = await client.query(`
      SELECT thumbnail_status, count(*) AS rows
      FROM public.xxx_tm009_fc2_wiki_thumbnail_assets
      WHERE updated_at >= now() - interval '30 minutes'
      GROUP BY thumbnail_status
      ORDER BY thumbnail_status
    `);
    console.log("recent thumbnail assets");
    console.table(recentAssetStatus.rows);

    const recentRunItems = await client.query(`
      SELECT item_status, count(*) AS rows
      FROM public.xxx_tl004_fc2_wiki_thumbnail_run_items
      WHERE run_id LIKE 'fc2_article_delta_thumb_%'
      GROUP BY item_status
      ORDER BY item_status
    `);
    console.log("delta run items");
    console.table(recentRunItems.rows);

    const recentTargetLogs = await client.query(`
      SELECT action, result_status, count(*) AS rows
      FROM public.xxx_tl005_fc2_delta_thumbnail_target_logs
      WHERE recorded_at >= now() - interval '30 minutes'
      GROUP BY action, result_status
      ORDER BY action, result_status
    `);
    console.log("recent target logs");
    console.table(recentTargetLogs.rows);
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
