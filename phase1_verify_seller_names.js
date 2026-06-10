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

// 更新対象データ
const updates = [
  { product_id: '4716424', seller_name: 'フェラ王24' },
  { product_id: '4719268', seller_name: '素人大臣' },
  { product_id: '4752881', seller_name: 'おっぱいが世界を救う' },
  { product_id: '4790694', seller_name: '睾丸マッサージエステ準備中！！' },
  { product_id: '4869941', seller_name: '素人大臣' },
  { product_id: '4898346', seller_name: '美女選抜（無）' },
  { product_id: '4899209', seller_name: 'フェラ王24' },
  { product_id: '4902562', seller_name: 'FC2USER825648UPU' },
  { product_id: '4902604', seller_name: '美女選抜（無）' },
  { product_id: '4903252', seller_name: '美女選抜（無）' },
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
    console.log('========== Phase 1-2: seller_name の確認と存在チェック ==========\n');

    // ユニークな seller_name を取得
    const uniqueSellerNames = [...new Set(updates.map(u => u.seller_name))];
    console.log(`対象の seller_name（重複除外）: ${uniqueSellerNames.length}個\n`);
    console.log(uniqueSellerNames);
    console.log('\n');

    // 各 seller_name が seller_names テーブルに存在するか確認
    console.log('========== seller_names テーブルでの存在確認 ==========\n');

    for (const sellerName of uniqueSellerNames) {
      const result = await pool.query(
        `SELECT DISTINCT seller_id FROM seller_names WHERE seller_name = $1 LIMIT 5`,
        [sellerName]
      );

      if (result.rows.length === 0) {
        console.log(`❌ "${sellerName}": seller_names に存在しない`);
      } else {
        console.log(`✅ "${sellerName}": seller_id = ${result.rows.map(r => r.seller_id).join(', ')}`);
      }
    }

    console.log('\n');

    // 各 seller_name が sellers テーブルに存在するか確認
    console.log('========== sellers テーブルでの存在確認 ==========\n');

    for (const sellerName of uniqueSellerNames) {
      const result = await pool.query(
        `SELECT seller_id FROM sellers WHERE seller_id = $1`,
        [sellerName]
      );

      if (result.rows.length === 0) {
        console.log(`❌ "${sellerName}": sellers に存在しない（seller_id として）`);
      } else {
        console.log(`✅ "${sellerName}": sellers に存在する（seller_id として）`);
      }
    }

    console.log('\n');

    // master テーブルの現在の状態確認
    console.log('========== master テーブルの現在状態（更新前） ==========\n');

    const updateProductIds = updates.map(u => u.product_id);
    const beforeResult = await pool.query(
      `SELECT product_id, seller_id, title FROM master WHERE product_id = ANY($1::text[]) ORDER BY product_id`,
      [updateProductIds]
    );

    console.log(beforeResult.rows);

  } catch (error) {
    console.error('Error:', error.message);
  } finally {
    await pool.end();
  }
}

main();
