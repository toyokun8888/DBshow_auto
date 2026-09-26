const axios = require("axios");
const cheerio = require("cheerio");
const path = require("path");
const { Client } = require("pg");
require("dotenv").config({ path: path.resolve(__dirname, "../.env"), quiet: true });

const [folderId = "3330879", folderName = "movie", pageArg = "1"] = process.argv.slice(2);
const page = Number(pageArg);
if (!/^\d+$/.test(folderId) || !/^[A-Za-z0-9_-]+$/.test(folderName) ||
    !Number.isInteger(page) || page < 1 || page > 100000) {
  throw new Error("Usage: node probe_rapidgator_folder.js <folder_id> <folder_name> <page>");
}
const url = `https://rapidgator.net/folder/${folderId}/${folderName}.html?page=${page}`;

async function main() {
  const response = await axios.get(url, {
    timeout: 20000,
    maxRedirects: 3,
    headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/125.0 Safari/537.36" },
  });
  const $ = cheerio.load(response.data);
  const rows = $("table.items tbody tr");
  const itemUrls = rows.toArray().map((row) => $(row).find("td a").first().attr("href"))
    .filter(Boolean).map((href) => new URL(href, "https://rapidgator.net").href);
  const links = new Set();
  $("a[href*='page=']").each((_, el) => {
    const href = $(el).attr("href") || "";
    const match = href.match(/[?&]page=(\d+)/);
    if (match) links.add(Number(match[1]));
  });
  const client = new Client({
    host: process.env.PGHOST, port: Number(process.env.PGPORT || 5432),
    database: process.env.PGDATABASE, user: process.env.PGUSER,
    password: process.env.PGPASSWORD,
    ssl: String(process.env.PGSSL || "false").toLowerCase() === "true"
      ? { rejectUnauthorized: false } : false,
  });
  await client.connect();
  let known;
  try {
    const result = await client.query(`
      SELECT file_url FROM public.xxx_tl002_rapidgator_raw
      WHERE file_url = ANY($1::text[])
    `, [itemUrls]);
    known = new Set(result.rows.map((row) => row.file_url));
  } finally {
    await client.end();
  }
  process.stdout.write(JSON.stringify({
    url,
    status: response.status,
    title: $("title").text().trim().slice(0, 120),
    item_rows: rows.length,
    known_urls: itemUrls.filter((item) => known.has(item)).length,
    new_urls: itemUrls.filter((item) => !known.has(item)).length,
    new_file_urls: itemUrls.filter((item) => !known.has(item) && new URL(item).pathname.startsWith("/file/")).length,
    new_folder_urls: itemUrls.filter((item) => !known.has(item) && new URL(item).pathname.startsWith("/folder/")).length,
    sample_title: rows.first().find("td a").first().text().trim().slice(0, 120),
    sample_url: itemUrls[0] || "",
    page_links_max: Math.max(0, ...links),
    page_links_count: links.size,
    sort_links: $("table.items thead a").toArray().map((element) => ({
      text: $(element).text().trim().slice(0, 60),
      href: $(element).attr("href") || "",
    })),
    table_headers: $("table.items thead th").toArray().map((element) => ({
      text: $(element).text().trim().slice(0, 60),
      id: $(element).attr("id") || "",
      title: $(element).attr("title") || "",
      class: $(element).attr("class") || "",
    })),
    html_length: String(response.data).length,
  }, null, 2) + "\n");
}

main().catch((error) => {
  process.stderr.write(`Rapidgator folder probe failed: ${JSON.stringify({
    name: error.name,
    code: error.code,
    status: error.response?.status,
    message: error.message,
    causes: error.errors?.map((item) => ({ code: item.code, message: item.message })),
  })}\n`);
  process.exitCode = 1;
});
