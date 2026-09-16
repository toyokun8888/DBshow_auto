"use strict";

const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const axios = require("axios");
const { Client } = require("pg");
require("dotenv").config({ path: path.resolve(__dirname, "..", ".env"), quiet: true });

const OUTPUT_DIR = path.win32.resolve(process.env.SUKEBEI_TORRENT_DOWNLOAD_DIR || "N:\\hogehoge");
const RETRY_COUNT = 3;
const TIMEOUT_MS = 30000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function outputName(row) {
  const torrentId = new URL(row.torrent_url).pathname.match(/(\d+)\.torrent$/i)?.[1];
  if (!/^\d{6,8}$/.test(String(row.product_id)) || !torrentId) {
    throw new Error(`Invalid recovery row: ${row.product_id} ${row.torrent_url}`);
  }
  return `${row.product_id}_${torrentId}.torrent`;
}

async function download(row) {
  const destination = path.win32.join(OUTPUT_DIR, outputName(row));
  const tempPath = `${destination}.part`;
  if (fs.existsSync(destination)) {
    const stat = await fsp.stat(destination);
    if (stat.size > 0) return { status: "existing", destination, bytes: stat.size };
    throw new Error(`Existing zero-byte destination: ${destination}`);
  }

  let lastError;
  for (let attempt = 1; attempt <= RETRY_COUNT; attempt += 1) {
    try {
      const response = await axios.get(row.torrent_url, {
        responseType: "arraybuffer",
        timeout: TIMEOUT_MS,
        headers: {
          "User-Agent": process.env.SUKEBEI_USER_AGENT || "Mozilla/5.0",
          Accept: "application/x-bittorrent,*/*;q=0.8",
        },
        validateStatus: (status) => status >= 200 && status < 300,
      });
      const bytes = Buffer.from(response.data);
      if (bytes.length === 0) throw new Error("Downloaded zero bytes");
      await fsp.writeFile(tempPath, bytes, { flag: "wx" });
      await fsp.rename(tempPath, destination);
      return { status: "downloaded", destination, bytes: bytes.length };
    } catch (error) {
      lastError = error;
      try { await fsp.unlink(tempPath); } catch (cleanupError) {
        if (cleanupError.code !== "ENOENT") throw cleanupError;
      }
      if (attempt < RETRY_COUNT) await sleep(2000 * attempt);
    }
  }
  throw lastError;
}

async function main() {
  await fsp.mkdir(OUTPUT_DIR, { recursive: true });
  const client = new Client({
    host: process.env.PGHOST,
    port: Number(process.env.PGPORT || 5432),
    database: process.env.PGDATABASE,
    user: process.env.PGUSER,
    password: process.env.PGPASSWORD,
    ssl: String(process.env.PGSSL || "false").toLowerCase() === "true"
      ? { rejectUnauthorized: false }
      : false,
  });

  await client.connect();
  let rows;
  try {
    const result = await client.query(`
      SELECT product_id, torrent_url, downloaded_at
      FROM public.xxx_tm012_sukebei_torrent_downloads
      WHERE (downloaded_at AT TIME ZONE 'Asia/Tokyo')::date
        BETWEEN DATE '2026-08-12' AND DATE '2026-08-13'
        AND status = 'downloaded'
      ORDER BY downloaded_at, product_id
    `);
    rows = result.rows;
  } finally {
    await client.end();
  }

  let downloaded = 0;
  let existing = 0;
  const failures = [];
  for (const row of rows) {
    try {
      const result = await download(row);
      if (result.status === "downloaded") downloaded += 1;
      else existing += 1;
      process.stdout.write(`${result.status} ${row.product_id} bytes=${result.bytes}\n`);
    } catch (error) {
      failures.push({ product_id: row.product_id, torrent_url: row.torrent_url, error: error.message });
      process.stderr.write(`failed ${row.product_id}: ${error.message}\n`);
    }
  }

  process.stdout.write(`${JSON.stringify({ target: rows.length, downloaded, existing, failed: failures.length, failures }, null, 2)}\n`);
  if (failures.length > 0) process.exitCode = 1;
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message || error}\n`);
  process.exitCode = 1;
});
