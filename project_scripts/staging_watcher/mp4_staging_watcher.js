const fs = require("fs");
const fsp = fs.promises;
const path = require("path");

const CONFIG = {
  // TODO: Replace with your manual download folder path.
  manualDownloadDir: path.join(__dirname, "sample_workspace", "download"),

  // TODO: Replace with your temporary staging folder path.
  stagingDir: path.join(__dirname, "sample_workspace", "staging"),

  // TODO: Replace with your CSV log folder path.
  csvLogDir: path.join(__dirname, "sample_workspace", "logs"),

  // Safety defaults.
  mode: "once", // once | watch
  dryRun: true,
  pollIntervalMs: 3000,
  stableCheckIntervalMs: 1000,
  stableCheckRounds: 2,
};

const CSV_COLUMNS = [
  "run_id",
  "timestamp",
  "action",
  "status",
  "source_path",
  "dest_path",
  "file_size",
  "file_modified_at",
  "note",
];

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    writeUsage();
    return;
  }

  if (args.initSample) {
    initSampleWorkspace(path.join(__dirname, "sample_workspace"));
  }

  const config = buildConfig(args);
  ensureDirectory(config.csvLogDir);
  ensureDirectory(config.stagingDir);

  const runId = args.runId || buildRunId("mp4_staging");
  const csvPath = path.join(config.csvLogDir, `file_process_${runId}.csv`);
  const state = {
    runId,
    csvPath,
    seenLowerPaths: new Set(),
    inProgressLowerPaths: new Set(),
  };

  writeCsvHeaderIfMissing(csvPath);

  if (config.mode === "once") {
    const count = await processOnce(config, state);
    process.stdout.write(
      [
        "mp4 staging watcher completed (once mode).",
        `Processed: ${count}`,
        `Dry-run: ${String(config.dryRun)}`,
        `CSV: ${csvPath}`,
        "",
      ].join("\n")
    );
    return;
  }

  process.stdout.write(
    [
      "mp4 staging watcher started (watch mode).",
      `Manual download dir: ${config.manualDownloadDir}`,
      `Staging dir: ${config.stagingDir}`,
      `Dry-run: ${String(config.dryRun)}`,
      `CSV: ${csvPath}`,
      "Press Ctrl+C to stop.",
      "",
    ].join("\n")
  );

  // Polling-based watcher is simple and stable on Windows.
  await runWatchLoop(config, state);
}

function buildConfig(args) {
  const mode = (args.mode || CONFIG.mode).toLowerCase();
  if (mode !== "once" && mode !== "watch") {
    throw new Error(`Invalid mode: ${mode}`);
  }

  return {
    ...CONFIG,
    mode,
    dryRun: parseBooleanArg(args.dryRun, CONFIG.dryRun),
    manualDownloadDir: args.manualDir || CONFIG.manualDownloadDir,
    stagingDir: args.stagingDir || CONFIG.stagingDir,
    csvLogDir: args.logDir || CONFIG.csvLogDir,
    pollIntervalMs: parseIntArg(args.pollMs, CONFIG.pollIntervalMs, "pollMs"),
    stableCheckIntervalMs: parseIntArg(
      args.stableCheckMs,
      CONFIG.stableCheckIntervalMs,
      "stableCheckMs"
    ),
    stableCheckRounds: parseIntArg(
      args.stableRounds,
      CONFIG.stableCheckRounds,
      "stableRounds"
    ),
  };
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    const next = argv[i + 1];

    if (key === "--help" || key === "-h") args.help = true;
    else if (key === "--init-sample") args.initSample = true;
    else if (key === "--mode") args.mode = consumeValue(key, next, argv, ++i);
    else if (key === "--manual-dir") args.manualDir = consumeValue(key, next, argv, ++i);
    else if (key === "--staging-dir") args.stagingDir = consumeValue(key, next, argv, ++i);
    else if (key === "--log-dir") args.logDir = consumeValue(key, next, argv, ++i);
    else if (key === "--dry-run") args.dryRun = consumeValue(key, next, argv, ++i);
    else if (key === "--poll-ms") args.pollMs = consumeValue(key, next, argv, ++i);
    else if (key === "--stable-check-ms") args.stableCheckMs = consumeValue(key, next, argv, ++i);
    else if (key === "--stable-rounds") args.stableRounds = consumeValue(key, next, argv, ++i);
    else if (key === "--run-id") args.runId = consumeValue(key, next, argv, ++i);
    else throw new Error(`Unknown argument: ${key}`);
  }
  return args;
}

function consumeValue(name, value) {
  if (!value || value.startsWith("--")) {
    throw new Error(`Missing value for ${name}`);
  }
  return value;
}

function writeUsage() {
  process.stdout.write(
    [
      "Usage:",
      "  node mp4_staging_watcher.js --init-sample",
      "  node mp4_staging_watcher.js --mode once --manual-dir <path> --staging-dir <path> --log-dir <path>",
      "  node mp4_staging_watcher.js --mode watch --dry-run true --poll-ms 3000",
      "",
      "Rules:",
      "  - Handles only .mp4 files.",
      "  - Waits until download appears stable before processing.",
      "  - Uses (1), (2), ... when staging name conflicts.",
      "  - On move failure, source file remains untouched.",
      "",
    ].join("\n")
  );
}

async function processOnce(config, state) {
  const targets = await listDirectMp4Files(config.manualDownloadDir);
  let processed = 0;

  for (const sourcePath of targets) {
    const done = await processOneFile(config, state, sourcePath);
    if (done) processed += 1;
  }

  return processed;
}

async function runWatchLoop(config, state) {
  while (true) {
    try {
      await processOnce(config, state);
    } catch (error) {
      await appendCsvRow(state.csvPath, buildLogRow(state.runId, {
        action: "scan",
        status: "error",
        sourcePath: "",
        destPath: "",
        fileSize: "",
        fileModifiedAt: "",
        note: `scan_error:${error.message}`,
      }));
    }

    await sleep(config.pollIntervalMs);
  }
}

async function processOneFile(config, state, sourcePath) {
  const lower = sourcePath.toLowerCase();
  if (state.inProgressLowerPaths.has(lower)) return false;
  if (state.seenLowerPaths.has(lower)) return false;

  state.inProgressLowerPaths.add(lower);
  try {
    const stable = await waitUntilStable(sourcePath, config.stableCheckRounds, config.stableCheckIntervalMs);
    if (!stable.ok) {
      await appendCsvRow(state.csvPath, buildLogRow(state.runId, {
        action: "detect",
        status: "skipped",
        sourcePath,
        destPath: "",
        fileSize: "",
        fileModifiedAt: "",
        note: stable.note,
      }));
      return false;
    }

    const sourceName = path.basename(sourcePath);
    const plannedDest = await nextAvailablePath(path.join(config.stagingDir, sourceName));

    if (config.dryRun) {
      await appendCsvRow(state.csvPath, buildLogRow(state.runId, {
        action: "move_to_staging",
        status: "dry_run",
        sourcePath,
        destPath: plannedDest,
        fileSize: String(stable.stat.size),
        fileModifiedAt: stable.stat.mtime.toISOString(),
        note: "planned_only",
      }));
      state.seenLowerPaths.add(lower);
      return true;
    }

    await moveFile(sourcePath, plannedDest);
    const movedStat = await fsp.stat(plannedDest);

    await appendCsvRow(state.csvPath, buildLogRow(state.runId, {
      action: "move_to_staging",
      status: "success",
      sourcePath,
      destPath: plannedDest,
      fileSize: String(movedStat.size),
      fileModifiedAt: movedStat.mtime.toISOString(),
      note: "moved",
    }));

    state.seenLowerPaths.add(lower);
    return true;
  } catch (error) {
    await appendCsvRow(state.csvPath, buildLogRow(state.runId, {
      action: "move_to_staging",
      status: "error",
      sourcePath,
      destPath: "",
      fileSize: "",
      fileModifiedAt: "",
      note: `move_error:${error.message}`,
    }));
    return false;
  } finally {
    state.inProgressLowerPaths.delete(lower);
  }
}

async function listDirectMp4Files(dir) {
  if (!fs.existsSync(dir)) return [];

  const entries = await fsp.readdir(dir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .filter((entry) => path.extname(entry.name).toLowerCase() === ".mp4")
    .map((entry) => path.join(dir, entry.name))
    .sort((a, b) => a.localeCompare(b, "ja"));
}

async function waitUntilStable(filePath, rounds, waitMs) {
  let previous = null;

  for (let i = 0; i < rounds + 1; i += 1) {
    if (!fs.existsSync(filePath)) {
      return { ok: false, note: "source_missing" };
    }

    let stat;
    try {
      stat = await fsp.stat(filePath);
    } catch {
      return { ok: false, note: "stat_failed" };
    }

    const current = `${stat.size}:${stat.mtimeMs}`;
    if (previous && previous === current) {
      return { ok: true, stat };
    }

    previous = current;
    await sleep(waitMs);
  }

  return { ok: false, note: "still_changing_or_busy" };
}

async function nextAvailablePath(targetPath) {
  const parsed = path.parse(targetPath);
  let index = 0;
  let candidate = targetPath;

  while (true) {
    try {
      await fsp.access(candidate, fs.constants.F_OK);
      index += 1;
      candidate = path.join(parsed.dir, `${parsed.name}(${index})${parsed.ext}`);
    } catch {
      return candidate;
    }
  }
}

async function moveFile(sourcePath, destPath) {
  try {
    await fsp.rename(sourcePath, destPath);
  } catch (error) {
    if (error && error.code === "EXDEV") {
      throw new Error(
        "cross_device_move_blocked: source file is kept untouched (manual handling required)"
      );
    }
    throw error;
  }
}

function buildRunId(label) {
  const stamp = new Date()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\..+$/, "")
    .replace("T", "_");
  return `${stamp}_${label}`;
}

function writeCsvHeaderIfMissing(csvPath) {
  if (fs.existsSync(csvPath)) return;
  fs.writeFileSync(csvPath, `${CSV_COLUMNS.join(",")}\n`, "utf8");
}

async function appendCsvRow(csvPath, row) {
  const line = CSV_COLUMNS.map((column) => csvEscape(row[column] || "")).join(",");
  await fsp.appendFile(csvPath, `${line}\n`, "utf8");
}

function buildLogRow(runId, data) {
  return {
    run_id: runId,
    timestamp: new Date().toISOString(),
    action: data.action || "",
    status: data.status || "",
    source_path: data.sourcePath || "",
    dest_path: data.destPath || "",
    file_size: data.fileSize || "",
    file_modified_at: data.fileModifiedAt || "",
    note: data.note || "",
  };
}

function csvEscape(value) {
  const text = String(value == null ? "" : value);
  return `"${text.replace(/"/g, "\"\"")}"`;
}

function parseBooleanArg(value, fallback) {
  if (value == null) return fallback;
  const normalized = String(value).toLowerCase();
  if (normalized === "true" || normalized === "1" || normalized === "yes") return true;
  if (normalized === "false" || normalized === "0" || normalized === "no") return false;
  throw new Error(`Invalid boolean: ${value}`);
}

function parseIntArg(value, fallback, name) {
  if (value == null) return fallback;
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Invalid ${name}: ${value}`);
  }
  return parsed;
}

function ensureDirectory(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function initSampleWorkspace(root) {
  const downloadDir = path.join(root, "download");
  const stagingDir = path.join(root, "staging");
  const logsDir = path.join(root, "logs");

  ensureDirectory(downloadDir);
  ensureDirectory(stagingDir);
  ensureDirectory(logsDir);

  const samples = [
    "FC2-PPV-1111111.mp4",
    "FC2PPV-2222222_1.mp4",
    "not_target.txt",
  ];

  for (const fileName of samples) {
    const fullPath = path.join(downloadDir, fileName);
    if (!fs.existsSync(fullPath)) {
      fs.writeFileSync(fullPath, fileName.endsWith(".mp4") ? "sample" : "skip", "utf8");
    }
  }
}

main().catch((error) => {
  process.stderr.write(`mp4 staging watcher failed: ${error.message}\n`);
  process.exitCode = 1;
});
