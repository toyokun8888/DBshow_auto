/**
 * yellow 分類の249 seller_id に対して、owned_files に所持作品があるか確認
 */

const fs = require('fs');
const { Pool } = require('pg');
require('dotenv').config();

async function checkOwnedYellowSellers() {
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
    
    console.log(`\n確認対象: ${yellowSellers.length} 件の yellow seller_id\n`);

    // owned_files と master を JOIN して、yellow seller に対応する所持作品を検索
    const query = `
      SELECT 
        m.seller_id,
        COUNT(*) as owned_count,
        JSON_AGG(
          JSON_BUILD_OBJECT(
            'product_id', of.product_id,
            'title', m.title
          )
          ORDER BY of.created_at DESC
        ) FILTER (WHERE of.product_id IS NOT NULL) as samples
      FROM xxx_tm002_owned_files of
      JOIN master m ON of.product_id = m.product_id
      WHERE m.seller_id = ANY($1)
      GROUP BY m.seller_id
      ORDER BY owned_count DESC;
    `;

    const result = await pool.query(query, [yellowSellers]);

    if (result.rows.length === 0) {
      console.log('❌ yellow の249件の seller_id には、所持作品がありません。');
    } else {
      console.log(`✅ 所持作品がある seller_id: ${result.rows.length} 件\n`);
      
      let totalOwned = 0;
      result.rows.forEach((row) => {
        totalOwned += parseInt(row.owned_count);
        console.log(`  ${row.seller_id}: ${row.owned_count} 件`);
        if (row.samples && row.samples.length > 0) {
          console.log(
            `    例: "${row.samples[0].title.substring(0, 50)}..."`
          );
        }
      });
      
      console.log(`\n📊 合計所持作品数: ${totalOwned} 件`);
    }

  } catch (error) {
    console.error('❌ エラー:', error.message);
  } finally {
    await pool.end();
  }
}

checkOwnedYellowSellers();
