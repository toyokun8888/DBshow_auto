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

// 既存 seller_id へのマッピング
const existingSellers = {
  'フェラ王24': 'krdkCCJq',
  '素人大臣': 'dSvFvcqc',
  'おっぱいが世界を救う': 'dCCvSCqS',
  '睾丸マッサージエステ準備中！！': 'dCSkkJFF',
};

// 新規登録 seller
const newSellers = [
  { seller_id: 'FC2USER825648UPU', seller_name: 'FC2USER825648UPU' },
  { seller_id: 'buyer_bijosentaku_mu', seller_name: '美女選抜（無）' },
];

// master 更新マッピング
const masterUpdates = [
  { product_id: '4716424', seller_name: 'フェラ王24', seller_id: 'krdkCCJq' },
  { product_id: '4719268', seller_name: '素人大臣', seller_id: 'dSvFvcqc' },
  { product_id: '4752881', seller_name: 'おっぱいが世界を救う', seller_id: 'dCCvSCqS' },
  { product_id: '4790694', seller_name: '睾丸マッサージエステ準備中！！', seller_id: 'dCSkkJFF' },
  { product_id: '4869941', seller_name: '素人大臣', seller_id: 'dSvFvcqc' },
  { product_id: '4898346', seller_name: '美女選抜（無）', seller_id: 'buyer_bijosentaku_mu' },
  { product_id: '4899209', seller_name: 'フェラ王24', seller_id: 'krdkCCJq' },
  { product_id: '4902562', seller_name: 'FC2USER825648UPU', seller_id: 'FC2USER825648UPU' },
  { product_id: '4902604', seller_name: '美女選抜（無）', seller_id: 'buyer_bijosentaku_mu' },
  { product_id: '4903252', seller_name: '美女選抜（無）', seller_id: 'buyer_bijosentaku_mu' },
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

  const client = await pool.connect();

  try {
    console.log('========== Phase 1-3: 新規 seller 登録と master 更新 ==========\n');

    // 既존 seller 확인
    console.log('📝 ステップ 0: 既존 seller を確認\n');

    for (const seller of newSellers) {
      const checkResult = await client.query(
        `SELECT seller_id FROM sellers WHERE seller_id = $1`,
        [seller.seller_id]
      );

      if (checkResult.rows.length > 0) {
        console.log(`  ✅ 既存: ${seller.seller_id}`);
      } else {
        console.log(`  📝 新規登録予定: ${seller.seller_id}`);
      }
    }

    // トランザクション開始
    await client.query('BEGIN');

    console.log('\n📝 ステップ 1: 新規 seller を sellers テーブルに INSERT\n');

    for (const seller of newSellers) {
      try {
        const insertSellers = await client.query(
          `INSERT INTO sellers (seller_id) VALUES ($1)
           RETURNING id, seller_id`,
          [seller.seller_id]
        );

        if (insertSellers.rows.length > 0) {
          console.log(`  ✅ 新規登録: ${seller.seller_id}`);
        }
      } catch (err) {
        if (err.code === '23505') { // UNIQUE 制約違反
          console.log(`  ℹ️  既存のため スキップ: ${seller.seller_id}`);
          // トランザクションをロールバックして再開
          await client.query('ROLLBACK');
          await client.query('BEGIN');
        } else {
          throw err;
        }
      }
    }

    console.log('\n📝 ステップ 2: seller_names に seller 名を INSERT\n');

    for (const seller of newSellers) {
      try {
        const insertNames = await client.query(
          `INSERT INTO seller_names (seller_id, seller_name) VALUES ($1, $2)
           RETURNING seller_id, seller_name`,
          [seller.seller_id, seller.seller_name]
        );

        if (insertNames.rows.length > 0) {
          console.log(`  ✅ 新規登録: ${seller.seller_id} => "${seller.seller_name}"`);
        }
      } catch (err) {
        if (err.code === '23505') { // UNIQUE 制約違反
          console.log(`  ℹ️  既存のため スキップ: ${seller.seller_id}`);
          // トランザクションをロールバックして再開
          await client.query('ROLLBACK');
          await client.query('BEGIN');
        } else {
          throw err;
        }
      }
    }

    console.log('\n📝 ステップ 3: master テーブルの seller_id を UPDATE\n');

    let updateCount = 0;
    for (const update of masterUpdates) {
      const result = await client.query(
        `UPDATE master SET seller_id = $1 WHERE product_id = $2 AND seller_id IS NULL`,
        [update.seller_id, update.product_id]
      );

      if (result.rowCount > 0) {
        console.log(`  ✅ product_id ${update.product_id}: seller_id = ${update.seller_id}`);
        updateCount++;
      } else {
        console.log(`  ⚠️  product_id ${update.product_id}: 既に seller_id が設定されているか、レコードが見つかりません`);
      }
    }

    console.log('\n📝 ステップ 4: 更新後の確認\n');

    const confirmation = await client.query(
      `SELECT product_id, seller_id, title FROM master 
       WHERE product_id = ANY($1::text[]) 
       ORDER BY product_id`,
      [masterUpdates.map(u => u.product_id)]
    );

    console.log('更新後の master テーブル状態:');
    console.log(JSON.stringify(confirmation.rows, null, 2));

    // コミット
    await client.query('COMMIT');

    console.log(`\n✅ トランザクション完了: ${updateCount}件の master レコードを更新しました`);

  } catch (error) {
    // ロールバック
    await client.query('ROLLBACK');
    console.error('❌ エラーが発生しました。トランザクションをロールバックしました。');
    console.error('Error:', error.message);
  } finally {
    client.release();
    await pool.end();
  }
}

main();
