/**
 * 所持作品がある31個の seller_id を、ユーザーが追記できる形式で CSV/JSON 出力
 */

const fs = require('fs');
const { Pool } = require('pg');
require('dotenv').config();

async function createOwnedYellowList() {
  const pool = new Pool({
    user: process.env.DB_USER,
    host: process.env.DB_HOST,
    database: process.env.DB_NAME,
    password: process.env.DB_PASSWORD,
    port: process.env.DB_PORT,
  });

  try {
    // phase2_analysis_result.json から yellow seller_id を読み込み
    const analysisResult = JSON.parse(
      fs.readFileSync('phase2_analysis_result.json', 'utf8')
    );
    const yellowSellers = analysisResult.data.yellow.map((entry) => entry.seller_id);

    // owned_files と master を JOIN して詳細を取得
    const query = `
      SELECT 
        m.seller_id,
        COUNT(*) as owned_count,
        MAX(m.title) as sample_title
      FROM xxx_tm002_owned_files of
      JOIN master m ON of.product_id = m.product_id
      WHERE m.seller_id = ANY($1)
      GROUP BY m.seller_id
      ORDER BY owned_count DESC;
    `;

    const result = await pool.query(query, [yellowSellers]);

    // CSV 形式で出力
    const csvHeader = 'seller_id,owned_count,sample_title,seller_name,notes\n';
    const csvRows = result.rows.map((row) => {
      const titlePreview = (row.sample_title || '').substring(0, 50);
      
      return `"${row.seller_id}",${row.owned_count},"${titlePreview}...","",""`; // seller_name と notes は空
    });

    const csvContent = csvHeader + csvRows.join('\n');
    fs.writeFileSync('owned_yellow_sellers_input.csv', csvContent, 'utf8');
    console.log('✅ CSV 出力: owned_yellow_sellers_input.csv');

    // JSON 形式でも出力（見やすい用）
    const jsonData = {
      timestamp: new Date().toISOString(),
      count: result.rows.length,
      data: result.rows.map((row, index) => ({
        no: index + 1,
        seller_id: row.seller_id,
        owned_count: parseInt(row.owned_count),
        sample_title: row.sample_title || '',
        seller_name: '', // ユーザーが追記
        notes: '', // 備考欄
      })),
    };

    fs.writeFileSync(
      'owned_yellow_sellers_input.json',
      JSON.stringify(jsonData, null, 2),
      'utf8'
    );
    console.log('✅ JSON 出力: owned_yellow_sellers_input.json');

    // コンソール表示（確認用）
    console.log(`\n📋 31件の一覧（所持数が多い順）\n`);
    console.log('No. | seller_id | 所持数 | サンプルタイトル');
    console.log('----|-----------| --------|' + '-'.repeat(50));
    result.rows.forEach((row, index) => {
      const titlePreview = (row.sample_title || '')
        .substring(0, 40);
      console.log(
        `${String(index + 1).padStart(3)} | ${row.seller_id.padEnd(9)} | ${String(row.owned_count).padStart(6)} | ${titlePreview}...`
      );
    });

    console.log(`\n\n📝 入力方法：\n`);
    console.log('1️⃣  owned_yellow_sellers_input.csv または owned_yellow_sellers_input.json を開く');
    console.log('2️⃣  "seller_name" 列に、この seller_id の日本語名を入力');
    console.log('3️⃣  "notes" 列に、備考があれば記入（例：別名がある、など）');
    console.log('4️⃣  完成したら、ファイルを保存して報告');

  } catch (error) {
    console.error('❌ エラー:', error.message);
  } finally {
    await pool.end();
  }
}

createOwnedYellowList();
