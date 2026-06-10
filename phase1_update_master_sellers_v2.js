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

// 新規登録 seller
const newSellers = [
  { seller_id: 'FC2USER825648UPU', seller_name: 'FC2USER825648UPU' },
  { seller_id: 'buyer_bijosentaku_mu', seller_name: '美女選抜（無）' },
];

// master 更新マッピング
const masterUpdates = [
  { product_id: '4716424', seller_id: 'krdkCCJq' },
  { product_id: '4719268', seller_id: 'dSvFvcqc' },
  { product_id: '4752881', seller_id: 'dCCvSCqS' },
  { product_id: '4790694', seller_id: 'dCSkkJFF' },
  { product_id: '4869941', seller_id: 'dSvFvcqc' },
  { product_id: '4898346', seller_id: 'buyer_bijosentaku_mu' },
  { product_id: '4899209', seller_id: 'krdkCCJq' },
  { product_id: '4902562', seller_id: 'FC2USER825648UPU' },
  { product_id: '4902604', seller_id: 'buyer_bijosentaku_mu' },
  { product_id: '4903252', seller_id: 'buyer_bijosentaku_mu' },
];

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
    console.log('========== Phase 1-3: 新規 seller 登録と master 更新 ==========\n');

    console.log('📝 ステップ 1: 新規 seller を sellers テーブルに登録\n');

    for (const seller of newSellers) {
      const result = await pool.query(
        `INSERT INTO sellers (seller_id) 
         VALUES ($1) 
         ON CONFLICT (seller_id) DO NOTHING
         RETURNING id, seller_id`,
        [seller.seller_id]
      );

      if (result.rows.length > 0) {
        console.log(`  ✅ 新規登録: ${seller.seller_id}`);
      } else {
        console.log(`  ℹ️  既存のため スキップ: ${seller.seller_id}`);
      }
    }

    console.log('\n📝 ステップ 2: seller_names に seller 名を登録\n');

    for (const seller of newSellers) {
      const result = await pool.query(
        `INSERT INTO seller_names (seller_id, seller_name) 
         VALUES ($1, $2) 
         ON CONFLICT DO NOTHING
         RETURNING seller_id, seller_name`,
        [seller.seller_id, seller.seller_name]
      );

      if (result.rows.length > 0) {
        console.log(`  ✅ 新規登録: ${seller.seller_id} => "${seller.seller_name}"`);
      } else {
        console.log(`  ℹ️  既存のため スキップ: ${seller.seller_id}`);
      }
    }

    console.log('\n📝 ステップ 3: master テーブルの seller_id を UPDATE\n');

    let updateCount = 0;
    for (const update of masterUpdates) {
      const result = await pool.query(
        `UPDATE master SET seller_id = $1 WHERE product_id = $2 AND seller_id IS NULL`,
        [update.seller_id, update.product_id]
      );

      if (result.rowCount > 0) {
        console.log(`  ✅ product_id ${update.product_id}: seller_id = ${update.seller_id}`);
        updateCount++;
      } else {
        console.log(`  ⚠️  product_id ${update.product_id}: 既に seller_id が設定済み`);
      }
    }

    console.log('\n📝 ステップ 4: 更新後の確認\n');

    const confirmation = await pool.query(
      `SELECT product_id, seller_id, title FROM master 
       WHERE product_id = ANY($1::text[]) 
       ORDER BY product_id`,
      [masterUpdates.map(u => u.product_id)]
    );

    console.log('更新後の master テーブル状態:');
    confirmation.rows.forEach(row => {
      console.log(`  ${row.product_id}: seller_id = ${row.seller_id}`);
    });

    console.log(`\n✅ 完了: ${updateCount}件の master レコードを更新しました`);

  } catch (error) {
    console.error('❌ エラーが発生しました');
    console.error('Error:', error.message);
  } finally {
    await pool.end();
  }
}

main();
