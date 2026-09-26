const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const axios = require("axios");
const cheerio = require("cheerio");
const { Client } = require("pg");
require("dotenv").config({ path: path.resolve(__dirname, "../.env"), quiet: true });

const PROJECT_ROOT = path.resolve(__dirname, "..");
const COLLECTOR_SCRIPT = path.join(PROJECT_ROOT, "rapidgator_folder_collector2.js");
const IMPORT_SCRIPT = path.join(__dirname, "import_rapidgator_delta.js");
const DEFAULT_OUTPUT_ROOT = path.join(PROJECT_ROOT, "tmp", "rapidgator_daily");
const LOCK_NAMESPACE = 20260923;
const LOCK_KEY = 23043001;

function cliValue(name) {
  const index = process.argv.indexOf(name);
  if (index < 0) return "";
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`Missing value for ${name}`);
  return value;
}

function toBoundedInt(value, fallback, minimum, maximum, label) {
  const parsed = Number.parseInt(String(value ?? fallback), 10);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${label} must be an integer between ${minimum} and ${maximum}`);
  }
  return parsed;
}

function localTimestamp(date = new Date()) {
  const parts = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}${values.month}${values.day}${values.hour}${values.minute}${values.second}`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomBetween(minimum, maximum) {
  return minimum + Math.floor(Math.random() * (maximum - minimum + 1));
}

function validateFolder(folder) {
  const folderId = String(folder.folder_id || "");
  const folderName = String(folder.folder_name || "");
  const dbMaxPage = Number(folder.db_max_page || 0);
  if (!/^\d+$/.test(folderId) || !/^[A-Za-z0-9_-]+$/.test(folderName)) {
    throw new Error(`Unsafe Rapidgator folder entry: ${folderId}/${folderName}`);
  }
  if (!Number.isSafeInteger(dbMaxPage) || dbMaxPage < 1 || dbMaxPage > 100000) {
    throw new Error(`Unsafe DB page range for Rapidgator folder: ${folderId}/${folderName}`);
  }
  return { folderId, folderName, dbMaxPage };
}

function folderPageUrl(folder, pageNumber) {
  return `https://rapidgator.net/folder/${folder.folderId}/${folder.folderName}.html?page=${pageNumber}`;
}

function parseFolderHtml(html, folder, pageNumber) {
  const text = String(html || "");
  if (/captcha|cf-chl-|cloudflare challenge|attention required/i.test(text.slice(0, 100000))) {
    throw new Error(`Rapidgator returned a block or CAPTCHA page for ${folder.folderId}/${folder.folderName}`);
  }
  const $ = cheerio.load(text);
  const rows = $("table.items tbody tr");
  if (rows.length < 1 || rows.length > 100) {
    throw new Error(`Unexpected row count ${rows.length} at ${folderPageUrl(folder, pageNumber)}`);
  }
  const itemUrls = rows.toArray().map((row, index) => {
    const href = $(row).find("td a").first().attr("href");
    if (!href) throw new Error(`Missing item link at row ${index + 1} of ${folderPageUrl(folder, pageNumber)}`);
    const url = new URL(href, "https://rapidgator.net");
    const fileLink = url.protocol === "https:" && url.hostname === "rapidgator.net" &&
      /^\/file\/[0-9a-f]+\//i.test(url.pathname);
    const folderLink = url.protocol === "https:" && url.hostname === "rapidgator.net" &&
      /^\/folder\/\d+\/[^/]+\.html$/i.test(url.pathname);
    if (!fileLink && !folderLink) {
      throw new Error(`Unexpected item link at row ${index + 1} of ${folderPageUrl(folder, pageNumber)}`);
    }
    return url.href;
  });
  const fileUrls = itemUrls.filter((url) => {
    const parsed = new URL(url);
    return /^\/file\/[0-9a-f]+\//i.test(parsed.pathname);
  });
  const summaryText = $("div.summary").first().text().trim();
  const totalMatch = summaryText.match(/^Total objects in folder\s+(\d+)$/i);
  const totalItems = Number(totalMatch?.[1]);
  if (!Number.isSafeInteger(totalItems) || totalItems < 1 || totalItems > 100000000) {
    throw new Error(`Missing or unsafe folder total at ${folderPageUrl(folder, pageNumber)}`);
  }
  const lastPage = Math.ceil(totalItems / 100);
  if (lastPage < 1 || lastPage > 100000 || pageNumber > lastPage) {
    throw new Error(`Unsafe last page detected for ${folder.folderId}/${folder.folderName}`);
  }
  const expectedRows = pageNumber < lastPage ? 100 : ((totalItems - 1) % 100) + 1;
  if (rows.length !== expectedRows) {
    throw new Error(
      `Folder row count mismatch at ${folderPageUrl(folder, pageNumber)}: expected ${expectedRows}, found ${rows.length}`
    );
  }
  const lastLinks = $("div.rapidPager ul.yiiPager li.last a").toArray();
  if (lastPage > 1 && lastLinks.length !== 1) {
    throw new Error(`Missing explicit last-page link at ${folderPageUrl(folder, pageNumber)}`);
  }
  if (lastLinks.length) {
    const lastUrl = new URL($(lastLinks[0]).attr("href") || "", "https://rapidgator.net");
    const expectedPath = `/folder/${folder.folderId}/${folder.folderName}.html`;
    const linkedPage = Number(lastUrl.searchParams.get("page"));
    if (lastUrl.protocol !== "https:" || lastUrl.hostname !== "rapidgator.net" ||
        lastUrl.pathname !== expectedPath || !Number.isSafeInteger(linkedPage) || linkedPage !== lastPage) {
      throw new Error(`Invalid last-page link at ${folderPageUrl(folder, pageNumber)}`);
    }
  }
  return {
    itemRows: rows.length,
    fileUrls: [...new Set(fileUrls)],
    lastPage,
    totalItems,
    paginationDetected: lastLinks.length === 1,
  };
}

async function fetchFolderPage(folder, pageNumber, config) {
  const url = folderPageUrl(folder, pageNumber);
  let lastError;
  for (let attempt = 1; attempt <= config.maxAttempts; attempt += 1) {
    try {
      const response = await axios.get(url, {
        timeout: config.requestTimeoutMs,
        signal: AbortSignal.timeout(config.requestTimeoutMs),
        maxRedirects: 3,
        maxContentLength: 2 * 1024 * 1024,
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) rapidgator-daily-delta/1.0",
        },
      });
      return parseFolderHtml(response.data, folder, pageNumber);
    } catch (error) {
      lastError = error;
      const status = Number(error.response?.status || 0);
      if (status === 403 || status === 429 || attempt >= config.maxAttempts) break;
      await sleep(3000 * attempt);
    }
  }
  throw new Error(`Probe failed for ${url}: ${lastError?.message || lastError}`);
}

function createDbClient() {
  return new Client({
    host: process.env.PGHOST,
    port: Number(process.env.PGPORT || 5432),
    database: process.env.PGDATABASE,
    user: process.env.PGUSER,
    password: process.env.PGPASSWORD,
    keepAlive: true,
    ssl: String(process.env.PGSSL || "false").toLowerCase() === "true"
      ? { rejectUnauthorized: false }
      : false,
  });
}

async function loadRegisteredFolders(client, expectedFolderCount) {
  const result = await client.query(`
    SELECT folder_id, folder_name, MAX(page_number::integer)::integer AS db_max_page
    FROM public.xxx_tl002_rapidgator_raw
    WHERE folder_id ~ '^\\d+$'
      AND folder_name ~ '^[A-Za-z0-9_-]+$'
    GROUP BY folder_id, folder_name
    ORDER BY folder_id, folder_name
  `);
  const folders = result.rows.map(validateFolder);
  if (folders.length !== expectedFolderCount) {
    throw new Error(`Expected ${expectedFolderCount} registered Rapidgator folders, found ${folders.length}`);
  }
  return folders;
}

async function knownUrls(client, urls) {
  if (!urls.length) return new Set();
  const result = await client.query(`
    SELECT DISTINCT file_url
    FROM public.xxx_tl002_rapidgator_raw
    WHERE file_url = ANY($1::text[])
  `, [urls]);
  return new Set(result.rows.map((row) => row.file_url));
}

async function discoverDeltaRange(client, folder, config) {
  const firstPage = await fetchFolderPage(folder, 1, config);
  if (!firstPage.paginationDetected && (folder.dbMaxPage > 1 || firstPage.itemRows === 100)) {
    throw new Error(`Pagination was not detected for ${folder.folderId}/${folder.folderName}`);
  }
  const lastPage = firstPage.lastPage;
  const probed = [];
  let consecutiveKnownPages = 0;
  let totalUnknownUrls = 0;
  for (let pageNumber = lastPage; pageNumber >= 1; pageNumber -= 1) {
    if (probed.length >= config.maxProbePages) {
      throw new Error(
        `Delta boundary was not found within ${config.maxProbePages} pages for ${folder.folderId}/${folder.folderName}`
      );
    }
    if (probed.length) await sleep(randomBetween(config.probeMinDelayMs, config.probeMaxDelayMs));
    const page = pageNumber === 1 ? firstPage : await fetchFolderPage(folder, pageNumber, config);
    const known = await knownUrls(client, page.fileUrls);
    const unknownUrls = page.fileUrls.filter((url) => !known.has(url));
    totalUnknownUrls += unknownUrls.length;
    probed.push({
      page: pageNumber,
      rows: page.itemRows,
      file_urls: page.fileUrls.length,
      known_urls: known.size,
      unknown_urls: unknownUrls.length,
    });
    if (page.fileUrls.length === 0) {
      consecutiveKnownPages = 0;
    } else {
      consecutiveKnownPages = unknownUrls.length === 0 ? consecutiveKnownPages + 1 : 0;
    }
    if (consecutiveKnownPages >= config.knownBoundaryPages) break;
  }
  if (totalUnknownUrls > 0 && consecutiveKnownPages < config.knownBoundaryPages && probed.at(-1)?.page !== 1) {
    throw new Error(`Known URL boundary was not reached for ${folder.folderId}/${folder.folderName}`);
  }
  return {
    current_last_page: lastPage,
    start_page: Math.min(...probed.map((entry) => entry.page)),
    end_page: lastPage,
    probed_pages: probed,
    unknown_urls_in_probe: totalUnknownUrls,
  };
}

function runCommand(label, script, args, captureStdout = false) {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const child = spawn(process.execPath, [script, ...args], {
      cwd: PROJECT_ROOT,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    child.stdout.on("data", (chunk) => {
      const value = chunk.toString();
      if (captureStdout) stdout += value;
      process.stdout.write(`[${label}] ${value}`);
    });
    child.stderr.on("data", (chunk) => {
      const value = chunk.toString();
      stderr += value;
      process.stderr.write(`[${label}] ${value}`);
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${label} exited with code ${code}: ${stderr.trim()}`));
    });
  });
}

function parseJsonOutput(output, label) {
  try {
    return JSON.parse(String(output || "").trim());
  } catch {
    throw new Error(`${label} did not return valid JSON`);
  }
}

function writeJsonAtomic(filePath, value) {
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(value, null, 2) + "\n", { encoding: "utf8", flag: "wx" });
  fs.renameSync(tempPath, filePath);
}

function configFromEnvironment() {
  const outputRoot = path.resolve(cliValue("--output-root") || process.env.RAPIDGATOR_DAILY_OUTPUT_ROOT || DEFAULT_OUTPUT_ROOT);
  const relativeOutput = path.relative(PROJECT_ROOT, outputRoot);
  if (relativeOutput.startsWith("..") || path.isAbsolute(relativeOutput)) {
    throw new Error("Rapidgator daily output root must stay inside the project workspace");
  }
  const execute = process.argv.includes("--execute") ||
    String(process.env.RAPIDGATOR_DAILY_EXECUTE || "NO").toUpperCase() === "YES";
  if (execute && String(process.env.RAPIDGATOR_DAILY_CONFIRM_DB_WRITE || "NO").toUpperCase() !== "YES") {
    throw new Error("DB write gate failed: set RAPIDGATOR_DAILY_CONFIRM_DB_WRITE=YES");
  }
  const probeMinDelayMs = toBoundedInt(
    process.env.RAPIDGATOR_DAILY_PROBE_MIN_DELAY_MS, 1000, 500, 60000, "probe minimum delay"
  );
  const collectorWaitMinMs = toBoundedInt(
    process.env.RAPIDGATOR_DAILY_COLLECTOR_MIN_DELAY_MS, 2000, 1000, 60000,
    "collector minimum delay"
  );
  return {
    execute,
    outputRoot,
    expectedFolderCount: toBoundedInt(
      process.env.RAPIDGATOR_DAILY_EXPECTED_FOLDERS, 7, 1, 20, "expected folder count"
    ),
    knownBoundaryPages: toBoundedInt(
      process.env.RAPIDGATOR_DAILY_KNOWN_BOUNDARY_PAGES, 2, 1, 10, "known boundary pages"
    ),
    maxProbePages: toBoundedInt(
      process.env.RAPIDGATOR_DAILY_MAX_PROBE_PAGES, 50, 3, 100, "maximum probe pages"
    ),
    probeMinDelayMs,
    probeMaxDelayMs: toBoundedInt(
      process.env.RAPIDGATOR_DAILY_PROBE_MAX_DELAY_MS, 2500, probeMinDelayMs, 120000,
      "probe maximum delay"
    ),
    requestTimeoutMs: toBoundedInt(
      process.env.RAPIDGATOR_DAILY_TIMEOUT_MS, 30000, 5000, 120000, "request timeout"
    ),
    maxAttempts: toBoundedInt(
      process.env.RAPIDGATOR_DAILY_MAX_ATTEMPTS, 3, 1, 3, "maximum attempts"
    ),
    collectorWaitMinMs,
    collectorWaitMaxMs: toBoundedInt(
      process.env.RAPIDGATOR_DAILY_COLLECTOR_MAX_DELAY_MS, 6000, collectorWaitMinMs, 120000,
      "collector maximum delay"
    ),
  };
}

async function collectAndImport(folder, plan, runDirectory, config) {
  const folderDirectory = path.join(runDirectory, `${folder.folderId}_${folder.folderName}`);
  fs.mkdirSync(folderDirectory, { recursive: true });
  const sharedArgs = [
    "--folder-id", folder.folderId,
    "--folder-name", folder.folderName,
    "--start-page", String(plan.start_page),
    "--end-page", String(plan.end_page),
  ];
  await runCommand(
    `${folder.folderName}:collect`,
    COLLECTOR_SCRIPT,
    [...sharedArgs, "--output-dir", folderDirectory,
      "--wait-min-ms", String(config.collectorWaitMinMs),
      "--wait-max-ms", String(config.collectorWaitMaxMs)]
  );
  const importArgs = [folderDirectory, ...sharedArgs];
  const dryRun = parseJsonOutput(
    (await runCommand(`${folder.folderName}:dry-run`, IMPORT_SCRIPT, importArgs, true)).stdout,
    `${folder.folderName} dry-run`
  );
  if (!config.execute) return { dry_run: dryRun };
  const applied = parseJsonOutput(
    (await runCommand(`${folder.folderName}:execute`, IMPORT_SCRIPT, [...importArgs, "--execute"], true)).stdout,
    `${folder.folderName} execute`
  );
  const postCheck = parseJsonOutput(
    (await runCommand(`${folder.folderName}:post-check`, IMPORT_SCRIPT, importArgs, true)).stdout,
    `${folder.folderName} post-check`
  );
  if (postCheck.new_urls !== 0) {
    throw new Error(`${folder.folderName} post-check still has ${postCheck.new_urls} new URLs`);
  }
  return { dry_run: dryRun, applied, post_check: postCheck };
}

async function main() {
  const config = configFromEnvironment();
  const runId = `rapidgator_daily_${localTimestamp()}`;
  const runDirectory = path.join(config.outputRoot, runId);
  fs.mkdirSync(config.outputRoot, { recursive: true });
  fs.mkdirSync(runDirectory);
  const statusPath = path.join(runDirectory, "status.json");
  const status = {
    run_id: runId,
    mode: config.execute ? "execute" : "dry_run",
    run_status: "starting",
    started_at: new Date().toISOString(),
    folders: [],
  };
  writeJsonAtomic(statusPath, status);

  const client = createDbClient();
  let lockAcquired = false;
  await client.connect();
  try {
    const lock = await client.query("SELECT pg_try_advisory_lock($1, $2) AS acquired", [LOCK_NAMESPACE, LOCK_KEY]);
    lockAcquired = lock.rows[0]?.acquired === true;
    if (!lockAcquired) {
      status.run_status = "skipped_locked";
      status.finished_at = new Date().toISOString();
      writeJsonAtomic(statusPath, status);
      process.stdout.write(JSON.stringify(status, null, 2) + "\n");
      return;
    }
    const folders = await loadRegisteredFolders(client, config.expectedFolderCount);
    status.run_status = "running";
    status.registered_folders = folders.length;
    writeJsonAtomic(statusPath, status);

    for (const folder of folders) {
      const result = { ...folder, status: "probing", started_at: new Date().toISOString() };
      status.folders.push(result);
      writeJsonAtomic(statusPath, status);
      try {
        const plan = await discoverDeltaRange(client, folder, config);
        Object.assign(result, plan);
        if (plan.unknown_urls_in_probe === 0) {
          result.status = "no_change";
        } else {
          result.status = "collecting";
          writeJsonAtomic(statusPath, status);
          result.import = await collectAndImport(folder, plan, runDirectory, config);
          result.status = config.execute ? "applied" : "dry_run_ready";
        }
      } catch (error) {
        result.status = "failed";
        result.error = error.message || String(error);
      }
      result.finished_at = new Date().toISOString();
      writeJsonAtomic(statusPath, status);
    }

    const failed = status.folders.filter((folder) => folder.status === "failed");
    status.run_status = failed.length ? "failed" : "completed";
    status.changed_folders = status.folders.filter((folder) => folder.unknown_urls_in_probe > 0).length;
    status.new_urls = status.folders.reduce((sum, folder) => {
      const count = config.execute ? folder.import?.applied?.inserted : folder.import?.dry_run?.new_urls;
      return sum + Number(count || 0);
    }, 0);
    status.failed_folders = failed.length;
    status.finished_at = new Date().toISOString();
    writeJsonAtomic(statusPath, status);
    process.stdout.write(JSON.stringify(status, null, 2) + "\n");
    if (failed.length) process.exitCode = 1;
  } catch (error) {
    status.run_status = "failed";
    status.error = error.message || String(error);
    status.finished_at = new Date().toISOString();
    writeJsonAtomic(statusPath, status);
    throw error;
  } finally {
    if (lockAcquired) {
      await client.query("SELECT pg_advisory_unlock($1, $2)", [LOCK_NAMESPACE, LOCK_KEY]).catch(() => {});
    }
    await client.end().catch(() => {});
  }
}

module.exports = { localTimestamp, parseFolderHtml, validateFolder };

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`Rapidgator daily delta failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}
