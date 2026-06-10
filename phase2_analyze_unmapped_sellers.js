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
    console.log('========== Phase 2-1: seller_names 未対応の502個の seller_id を分析 ==========\n');

    console.log('📝 ステップ 1: 分析クエリを実行\n');

    const analysisQuery = `
      WITH unmapped_sellers AS (
        -- master.seller_id が seller_names に存在しない seller_id
        SELECT DISTINCT m.seller_id
        FROM master m
        WHERE m.seller_id IS NOT NULL
          AND m.seller_id <> ''
          AND NOT EXISTS (
            SELECT 1 FROM seller_names sn
            WHERE sn.seller_id = m.seller_id
          )
      )
      SELECT
        u.seller_id,
        COUNT(DISTINCT m.product_id) AS product_count,
        MAX(m.title) AS sample_title,
        MAX(m.title) AS longest_title,
        CASE 
          WHEN EXISTS (SELECT 1 FROM sellers s WHERE s.seller_id = u.seller_id)
          THEN '✅ sellers に存在'
          ELSE '❌ sellers に未存在'
        END AS sellers_status,
        CASE 
          WHEN COUNT(DISTINCT m.product_id) >= 5
          THEN '🟡 半有効'
          ELSE '🔴 疑わしい'
        END AS classification
      FROM unmapped_sellers u
      LEFT JOIN master m ON m.seller_id = u.seller_id
      GROUP BY u.seller_id
      ORDER BY 
        COUNT(DISTINCT m.product_id) DESC,
        u.seller_id ASC;
    `;

    const result = await pool.query(analysisQuery);
    const allResults = result.rows;

    // 分類別に集計
    const green = allResults.filter(r => r.classification === '🟢 有効');
    const yellow = allResults.filter(r => r.classification === '🟡 半有効');
    const red = allResults.filter(r => r.classification === '🔴 疑わしい');

    console.log(`📊 分類結果サマリー:\n`);
    console.log(`  � 半有効（作品数 ≥ 5、未登録）: ${yellow.length}件`);
    console.log(`  🔴 疑わしい（作品数 < 5、未登録）: ${red.length}件`);
    console.log(`  合計: ${allResults.length}件\n`);

    //  半有効を詳細表示
    if (yellow.length > 0) {
      console.log(`\n========== 🟡 半有効（ユーザー手動判定）: ${yellow.length}件 ==========\n`);
      yellow.forEach((row, idx) => {
        console.log(`${idx + 1}. seller_id: ${row.seller_id}`);
        console.log(`   作品数: ${row.product_count}`);
        console.log(`   wiki_seller_name: ${row.wiki_seller_name || '（なし）'}`);
        console.log(`   サンプルタイトル: ${row.sample_title.substring(0, 80)}...`);
        console.log('');
      });
    }

    // 🔴 疑わしいを詳細表示
    if (red.length > 0) {
      console.log(`\n========== 🔴 疑わしい（確認推奨）: ${red.length}件 ==========\n`);
      console.log(`（最初の20件のみ表示）\n`);
      red.slice(0, 20).forEach((row, idx) => {
        console.log(`${idx + 1}. seller_id: ${row.seller_id}`);
        console.log(`   作品数: ${row.product_count}`);
        console.log(`   サンプルタイトル: ${row.sample_title.substring(0, 60)}...`);
        console.log('');
      });
      if (red.length > 20) {
        console.log(`   ... 他 ${red.length - 20}件\n`);
      }
    }

    // JSON ファイルに出力（全データ）
    const outputPath = path.resolve(__dirname, 'phase2_analysis_result.json');
    fs.writeFileSync(outputPath, JSON.stringify({
      timestamp: new Date().toISOString(),
      summary: {
        yellow_count: yellow.length,
        red_count: red.length,
        total: allResults.length,
      },
      data: {
        yellow: yellow.map(r => ({
          seller_id: r.seller_id,
          product_count: r.product_count,
          sample_title: r.sample_title,
        })),
        red: red.map(r => ({
          seller_id: r.seller_id,
          product_count: r.product_count,
          sample_title: r.sample_title,
        })),
      },
    }, null, 2));

    console.log(`\n✅ 分析完了。詳細は phase2_analysis_result.json を確認してください\n`);

  } catch (error) {
    console.error('❌ エラーが発生しました');
    console.error('Error:', error.message);
  } finally {
    await pool.end();
  }
}

main();
