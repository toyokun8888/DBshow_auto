const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

// .env ファイルの読み込み
const ENV_PATH = path.resolve(__dirname, '.env');
function loadEnvFile(envPath) {
  if (!fs.existsSync(envPath)) {
    throw new Error(`.env not found: ${envPath}`);
  }

  const text = fs.readFileSync(envPath, 'utf8');

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();

    if (!line || line.startsWith('#')) continue;

    const separatorIndex = line.indexOf('=');
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

  if (!value || value.startsWith('CHANGE_ME_')) {
    throw new Error(`${name} is not configured in .env`);
  }

  return value;
}

async function main() {
  loadEnvFile(ENV_PATH);

  const pool = new Pool({
    host: requireEnv('PGHOST'),
    port: Number(process.env.PGPORT || 5432),
    database: requireEnv('PGDATABASE'),
    user: requireEnv('PGUSER'),
    password: requireEnv('PGPASSWORD'),
    ssl: (process.env.PGSSL || 'false').toLowerCase() === 'true'
      ? { rejectUnauthorized: false }
      : false,
  });

  try {
    console.log('========== 🔴 Phase 1-1: seller_id が NULL で owned な10件の詳細 ==========\n');

    const query1 = `
      SELECT
        m.product_id,
        m.title,
        ofi.current_path,
        ofi.current_file_name,
        ofi.status,
        ofi.created_at
      FROM master m
      INNER JOIN xxx_tm002_owned_files ofi
        ON ofi.product_id = m.product_id
        AND ofi.status = 'owned'
      WHERE m.seller_id IS NULL
      ORDER BY m.product_id ASC;
    `;

    const result1 = await pool.query(query1);
    console.log('seller_id が NULL で owned なレコード:');
    console.log(JSON.stringify(result1.rows, null, 2));
    console.log(`\n合計: ${result1.rows.length}件\n`);



  } catch (error) {
    console.error('Error:', error.message);
  } finally {
    await pool.end();
  }
}

main();
