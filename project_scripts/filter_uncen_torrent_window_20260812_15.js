"use strict";

const fs = require("fs");
const path = require("path");
const { Client } = require("pg");

const envFile = process.env.ENV_FILE || path.resolve(__dirname, "..", ".env");
for (const line of fs.readFileSync(envFile, "utf8").split(/\r?\n/)) {
  const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
  if (!match || process.env[match[1]] !== undefined) continue;
  let value = match[2];
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
  process.env[match[1]] = value;
}

const cutoff = "2026-08-12";
const views = {
  "10mu": "tenmusume_v_completion_items",
  "1pon": "onepondo_v_completion_items",
  carib: "carib_v_completion_items",
  paco: "paco_v_completion_items",
  heyzo: "heyzo_v_completion_items",
  h0930: "h0930_v_completion_items",
  tokyo_hot: "tokyo_hot_v_completion_items",
};

async function main() {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  const keep = [];
  const quarantine = [];
  try {
    for (const [site, view] of Object.entries(views)) {
      const result = await client.query(`
        select q.id, q.site_key, q.movie_code, q.torrent_file_path,
               v.release_date::text as release_date
        from cl.uncen_torrent_acquisition q
        left join cl.${view} v on lower(replace(v.movie_code, '-', '')) = lower(replace(q.movie_code, '-', ''))
        where q.site_key = $1 and q.status = 'torrent_downloaded'
          and q.updated_at >= date '2026-08-15'
      `, [site]);
      for (const row of result.rows) {
        if (row.release_date && row.release_date >= cutoff) keep.push(row);
        else quarantine.push(row);
      }
    }
    console.log(JSON.stringify({ cutoff, keep: keep.length, quarantine: quarantine.length,
      keepBySite: Object.fromEntries(Object.keys(views).map((site) => [site, keep.filter((row) => row.site_key === site).length])),
      quarantineBySite: Object.fromEntries(Object.keys(views).map((site) => [site, quarantine.filter((row) => row.site_key === site).length])) }, null, 2));
    console.log("KEEP_FILES");
    for (const row of keep) console.log(row.torrent_file_path);
  } finally { await client.end(); }
}

main().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; });
