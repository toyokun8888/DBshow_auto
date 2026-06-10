const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

require('dotenv').config();

const CSV_PATH = path.resolve(__dirname, 'owned_yellow_sellers_input.csv');
const applyChanges = process.argv.includes('--apply');

function env(primary, fallback) {
  return process.env[primary] || process.env[fallback];
}

function parseCsvLine(line) {
  const values = [];
  let current = '';
  let quoted = false;

  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    const next = line[i + 1];

    if (char === '"' && quoted && next === '"') {
      current += '"';
      i += 1;
      continue;
    }

    if (char === '"') {
      quoted = !quoted;
      continue;
    }

    if (char === ',' && !quoted) {
      values.push(current);
      current = '';
      continue;
    }

    current += char;
  }

  values.push(current);
  return values;
}

function readSellerRows() {
  const text = fs.readFileSync(CSV_PATH, 'utf8').replace(/^\uFEFF/, '');
  const lines = text.split(/\r?\n/).filter((line) => line.trim() !== '');
  const header = parseCsvLine(lines.shift());
  const sellerIdIndex = header.indexOf('seller_id');
  const sellerNameIndex = header.indexOf('seller_name');
  const ownedCountIndex = header.indexOf('owned_count');

  if (sellerIdIndex === -1 || sellerNameIndex === -1) {
    throw new Error('CSV must include seller_id and seller_name columns');
  }

  return lines.map((line, index) => {
    const columns = parseCsvLine(line);
    return {
      rowNumber: index + 2,
      seller_id: (columns[sellerIdIndex] || '').trim(),
      seller_name: (columns[sellerNameIndex] || '').trim(),
      owned_count: Number(columns[ownedCountIndex] || 0),
    };
  }).filter((row) => row.seller_id && row.seller_name);
}

async function main() {
  const rows = readSellerRows();
  const pool = new Pool({
    host: env('PGHOST', 'DB_HOST'),
    port: Number(env('PGPORT', 'DB_PORT') || 5432),
    database: env('PGDATABASE', 'DB_NAME'),
    user: env('PGUSER', 'DB_USER'),
    password: env('PGPASSWORD', 'DB_PASSWORD'),
    ssl: (process.env.PGSSL || 'false').toLowerCase() === 'true'
      ? { rejectUnauthorized: false }
      : false,
  });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    let sellersInserted = 0;
    let sellersExisting = 0;
    let namesInserted = 0;
    let namesExisting = 0;

    for (const row of rows) {
      const sellerResult = await client.query(
        'SELECT id FROM sellers WHERE seller_id = $1',
        [row.seller_id]
      );

      if (sellerResult.rows.length > 0) {
        sellersExisting += 1;
      } else {
        sellersInserted += 1;
        if (applyChanges) {
          await client.query(
            'INSERT INTO sellers (seller_id) VALUES ($1)',
            [row.seller_id]
          );
        }
      }

      const nameResult = await client.query(
        'SELECT id FROM seller_names WHERE seller_id = $1 AND seller_name = $2',
        [row.seller_id, row.seller_name]
      );

      if (nameResult.rows.length > 0) {
        namesExisting += 1;
      } else {
        namesInserted += 1;
        if (applyChanges) {
          await client.query(
            'INSERT INTO seller_names (seller_id, seller_name) VALUES ($1, $2)',
            [row.seller_id, row.seller_name]
          );
        }
      }
    }

    if (applyChanges) {
      await client.query('COMMIT');
    } else {
      await client.query('ROLLBACK');
    }

    console.log(JSON.stringify({
      mode: applyChanges ? 'apply' : 'dry-run',
      csv_rows: rows.length,
      owned_total: rows.reduce((sum, row) => sum + row.owned_count, 0),
      sellers_existing: sellersExisting,
      sellers_to_insert: sellersInserted,
      seller_names_existing: namesExisting,
      seller_names_to_insert: namesInserted,
    }, null, 2));
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
