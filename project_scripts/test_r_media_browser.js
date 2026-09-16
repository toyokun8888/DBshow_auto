"use strict";

const filePath = process.argv[2];
if (!filePath) throw new Error("usage: node test_r_media_browser.js <absolute-mp4-path>");

async function main() {
  const response = await fetch("http://127.0.0.1:3001/api/library/open-file", {
    method: "POST",
    headers: { origin: "http://localhost", "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify({ fullPath: filePath }),
  });
  const body = await response.text();
  process.stdout.write(`${JSON.stringify({
    status: response.status,
    allowOrigin: response.headers.get("access-control-allow-origin"),
    body,
  }, null, 2)}\n`);
  if (!response.ok) process.exitCode = 1;
}

main().catch((error) => { process.stderr.write(`${error.stack || error.message}\n`); process.exitCode = 1; });
