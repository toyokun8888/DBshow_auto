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
    console.log('========== xxx_tm007_fc2_wiki_sellers のスキーマ確認 ==========\n');

    const schema = await pool.query(`
      SELECT column_name, data_type
      FROM information_schema.columns
      WHERE table_name = 'xxx_tm007_fc2_wiki_sellers'
      ORDER BY ordinal_position
    `);

    console.log('カラム一覧:');
    schema.rows.forEach(row => {
      console.log(`  - ${row.column_name}: ${row.data_type}`);
    });

    console.log('\n\nサンプルレコード（最初の3件）:\n');
    const sample = await pool.query('SELECT * FROM xxx_tm007_fc2_wiki_sellers LIMIT 3');
    console.log(JSON.stringify(sample.rows, null, 2));

  } catch (error) {
    console.error('❌ エラーが発生しました');
    console.error('Error:', error.message);
  } finally {
    await pool.end();
  }
}

main();
