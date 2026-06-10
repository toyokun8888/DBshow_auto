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
    console.log('========== seller_names テーブルのシーケンス修復 ==========\n');

    console.log('📝 ステップ 1: seller_names のスキーマと最大値を確認\n');
    
    // seller_names のスキーマ確認
    const schema = await pool.query(`
      SELECT column_name, data_type, column_default
      FROM information_schema.columns
      WHERE table_name = 'seller_names'
      ORDER BY ordinal_position
    `);
    console.log('   seller_names のカラム:');
    schema.rows.forEach(row => {
      console.log(`     - ${row.column_name}: ${row.data_type} (default: ${row.column_default || 'なし'})`);
    });

    console.log('\n📝 ステップ 2: seller_names の最大 id を取得\n');
    const maxId = await pool.query('SELECT MAX(id) as max_id FROM seller_names');
    const maxValue = maxId.rows[0].max_id || 0;
    console.log(`   現在の最大 id: ${maxValue}`);

    // シーケンスがあるか確認
    const seqCheck = await pool.query(`
      SELECT sequence_name
      FROM information_schema.sequences
      WHERE sequence_name LIKE 'seller_names%'
    `);
    console.log(`\n   シーケンス一覧: ${seqCheck.rows.map(r => r.sequence_name).join(', ')}`);

    if (seqCheck.rows.length > 0) {
      console.log('\n📝 ステップ 3: シーケンスをリセット\n');
      for (const seq of seqCheck.rows) {
        const resetResult = await pool.query(
          `SELECT setval('${seq.sequence_name}', $1, true)`,
          [maxValue]
        );
        console.log(`   ${seq.sequence_name} をリセット: ${resetResult.rows[0].setval}`);
      }
    }

    console.log('\n✅ 確認完了\n');

  } catch (error) {
    console.error('❌ エラーが発生しました');
    console.error('Error:', error.message);
  } finally {
    await pool.end();
  }
}

main();
