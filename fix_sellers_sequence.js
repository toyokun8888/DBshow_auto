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
    console.log('========== シーケンスの修復 ==========\n');

    console.log('📝 ステップ 1: sellers テーブルの最大 id を取得\n');
    const maxId = await pool.query('SELECT MAX(id) as max_id FROM sellers');
    const maxValue = maxId.rows[0].max_id || 0;
    console.log(`   現在の最大 id: ${maxValue}`);

    console.log('\n📝 ステップ 2: シーケンスをリセット\n');
    const resetResult = await pool.query(
      `SELECT setval('sellers_id_seq', $1, true)`,
      [maxValue]
    );
    console.log(`   setval 実行: ${resetResult.rows[0].setval}`);

    console.log('\n📝 ステップ 3: シーケンスの現在値を確認\n');
    const seq = await pool.query('SELECT last_value FROM sellers_id_seq');
    console.log(`   last_value: ${seq.rows[0].last_value}`);

    console.log('\n📝 ステップ 4: 修復後のテスト INSERT\n');
    const testInsert = await pool.query(
      'INSERT INTO sellers (seller_id) VALUES ($1) RETURNING id, seller_id',
      ['test_seller_verify']
    );
    console.log(`   ✅ テスト INSERT 成功: id=${testInsert.rows[0].id}, seller_id=${testInsert.rows[0].seller_id}`);

    // テスト用 seller を削除
    await pool.query('DELETE FROM sellers WHERE seller_id = $1', ['test_seller_verify']);
    console.log(`   🗑️  テスト用 seller を削除\n`);

    console.log('✅ シーケンス修復完了\n');

  } catch (error) {
    console.error('❌ エラーが発生しました');
    console.error('Error:', error.message);
  } finally {
    await pool.end();
  }
}

main();
