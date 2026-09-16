"use strict";

const fs = require("fs");
const path = require("path");

const ENV_FILE = path.resolve(__dirname, "..", ".env");
for (const line of fs.readFileSync(ENV_FILE, "utf8").split(/\r?\n/)) {
  const match = line.match(/(?:^|\s)([A-Za-z_][A-Za-z0-9_]*)\s*=\s*([^\r\n]*)$/);
  if (!match || process.env[match[1]] !== undefined) continue;
  process.env[match[1]] = match[2].trim().replace(/^(["'])(.*)\1$/, "$2");
}

const EXECUTE = process.argv.includes("--execute") && process.env.CONFIRM_EXECUTE === "YES";
const RESUME_R = process.argv.includes("--resume-r") && process.env.CONFIRM_EXECUTE === "YES";
const MAPPINGS = new Map([
  ["n:\\hogehoge\\downloads", "R:\\hogehoge\\downloads"],
  ["n:\\uncen\\torrent_automation\\downloads", "R:\\uncen\\torrent_automation\\downloads"],
]);

function normalized(value) {
  return path.win32.resolve(String(value || "")).replace(/[\\/]+$/, "").toLowerCase();
}

async function request(base, cookie, endpoint, options = {}) {
  const response = await fetch(`${base}${endpoint}`, {
    ...options,
    headers: { ...(options.headers || {}), cookie },
  });
  if (!response.ok) throw new Error(`${endpoint} failed: HTTP ${response.status}`);
  return response;
}

async function main() {
  const base = String(process.env.QB_URL || "http://localhost:8080").replace(/\/+$/, "");
  const parsed = new URL(base);
  if (!["localhost", "127.0.0.1"].includes(parsed.hostname)) throw new Error("QB_URL must be local");
  const login = await fetch(`${base}/api/v2/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ username: process.env.QB_USERNAME || "", password: process.env.QB_PASSWORD || "" }),
  });
  if (!login.ok) throw new Error(`qB login failed: HTTP ${login.status}`);
  const cookie = login.headers.get("set-cookie")?.split(";")[0];
  if (!cookie) throw new Error("qB login cookie missing");

  const torrents = await (await request(base, cookie, "/api/v2/torrents/info")).json();
  const rPaths = new Set([...MAPPINGS.values()].map(normalized));
  const onR = torrents.filter((torrent) => rPaths.has(normalized(torrent.save_path)));
  const targets = torrents
    .map((torrent) => ({ ...torrent, target: MAPPINGS.get(normalized(torrent.save_path)) }))
    .filter((torrent) => torrent.target);
  const summary = targets.map((torrent) => ({
    hash: torrent.hash,
    name: torrent.name,
    state: torrent.state,
    progress: torrent.progress,
    downloaded: torrent.downloaded,
    total_size: torrent.total_size,
    save_path: torrent.save_path,
    target: torrent.target,
  }));
  const rStateCounts = Object.fromEntries(Object.entries(onR.reduce((counts, torrent) => {
    counts[torrent.state] = (counts[torrent.state] || 0) + 1;
    return counts;
  }, {})).sort());
  const rErrors = onR.filter((torrent) => torrent.state === "error").map((torrent) => ({
    hash: torrent.hash, name: torrent.name, progress: torrent.progress, save_path: torrent.save_path,
  }));
  process.stdout.write(`${JSON.stringify({ execute: EXECUTE, resume_r: RESUME_R, target_count: targets.length, r_count: onR.length, r_state_counts: rStateCounts, r_errors: rErrors, torrents: summary }, null, 2)}\n`);
  if (RESUME_R && onR.length) {
    const body = new URLSearchParams({ hashes: onR.map((torrent) => torrent.hash).join("|") });
    try {
      await request(base, cookie, "/api/v2/torrents/start", {
        method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body,
      });
    } catch (error) {
      await request(base, cookie, "/api/v2/torrents/resume", {
        method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body,
      });
    }
  }
  if (!EXECUTE) return;

  for (const targetDir of new Set(targets.map((torrent) => torrent.target))) fs.mkdirSync(targetDir, { recursive: true });
  for (const [source, targetDir] of MAPPINGS) {
    const hashes = targets.filter((torrent) => normalized(torrent.save_path) === source).map((torrent) => torrent.hash);
    if (!hashes.length) continue;
    const body = new URLSearchParams({ hashes: hashes.join("|"), location: targetDir });
    await request(base, cookie, "/api/v2/torrents/setLocation", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
    });
    const startBody = new URLSearchParams({ hashes: hashes.join("|") });
    try {
      await request(base, cookie, "/api/v2/torrents/start", {
        method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: startBody,
      });
    } catch (error) {
      await request(base, cookie, "/api/v2/torrents/resume", {
        method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: startBody,
      });
    }
  }

  await new Promise((resolve) => setTimeout(resolve, 3000));
  const after = await (await request(base, cookie, "/api/v2/torrents/info")).json();
  const verified = after.filter((torrent) => targets.some((target) => target.hash === torrent.hash)).map((torrent) => ({
    hash: torrent.hash, name: torrent.name, state: torrent.state, progress: torrent.progress, save_path: torrent.save_path,
  }));
  process.stdout.write(`${JSON.stringify({ verified_count: verified.length, torrents: verified }, null, 2)}\n`);
}

main().catch((error) => { process.stderr.write(`${error.stack || error.message}\n`); process.exitCode = 1; });
