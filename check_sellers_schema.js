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
    console.log('========== sellers テーブルの状況確認 ==========\n');

    // sellers テーブルの情報
    console.log('1. sellers テーブルの全件数:\n');
    const count = await pool.query('SELECT COUNT(*) FROM sellers');
    console.log(`   レコード数: ${count.rows[0].count}`);

    // FC2USER825648UPU の確認
    console.log('\n2. FC2USER825648UPU が存在するか確認:\n');
    const fc2user = await pool.query(
      'SELECT id, seller_id FROM sellers WHERE seller_id = $1',
      ['FC2USER825648UPU']
    );
    console.log(`   検索結果: ${fc2user.rows.length}件`);
    if (fc2user.rows.length > 0) {
      console.log(`   ID: ${fc2user.rows[0].id}, seller_id: ${fc2user.rows[0].seller_id}`);
    }

    // シーケンスの確認
    console.log('\n3. sellers_id_seq の現在値:\n');
    const seq = await pool.query('SELECT last_value FROM sellers_id_seq');
    console.log(`   last_value: ${seq.rows[0].last_value}`);

    // buyers_bijosentaku_mu の確認
    console.log('\n4. buyer_bijosentaku_mu が存在するか確認:\n');
    const bijo = await pool.query(
      'SELECT id, seller_id FROM sellers WHERE seller_id = $1',
      ['buyer_bijosentaku_mu']
    );
    console.log(`   検索結果: ${bijo.rows.length}件`);

    // 実際に INSERT してみる
    console.log('\n5. 新しい seller を INSERT してみる (テスト用: test_seller_001):\n');
    try {
      const testInsert = await pool.query(
        'INSERT INTO sellers (seller_id) VALUES ($1) RETURNING id, seller_id',
        ['test_seller_001']
      );
      console.log(`   ✅ INSERT 成功: id=${testInsert.rows[0].id}, seller_id=${testInsert.rows[0].seller_id}`);

      // テスト用 seller を削除
      await pool.query('DELETE FROM sellers WHERE seller_id = $1', ['test_seller_001']);
      console.log(`   🗑️  テスト用 seller を削除しました`);
    } catch (err) {
      console.log(`   ❌ INSERT 失敗: ${err.message}`);
    }

  } catch (error) {
    console.error('❌ エラーが発生しました');
    console.error('Error:', error.message);
  } finally {
    await pool.end();
  }
}

main();
