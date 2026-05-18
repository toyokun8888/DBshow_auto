import fs from "fs";
import path from "path";
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import ffprobe from "ffprobe-static";
import { Client } from "pg";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "..", "..", "..");
const ENV_PATH = path.resolve(PROJECT_ROOT, ".env");
const TABLE_NAME = "public.xxx_tm011_owned_file_video_metadata";

const args = parseArgs(process.argv.slice(2));

main().catch((error) => {
  console.error(`[video-resolution] failed: ${error?.message || error}`);
  process.exitCode = 1;
});

async function main() {
  loadEnvFile();

  const client = createPgClient();
  await client.connect();

  try {
    await ensureMetadataTable(client);

    if (args.summary) {
      await printSummary(client);
      return;
    }

    if (args.createTableOnly) {
      console.info("[video-resolution] table ready");
      return;
    }

    const rows = await loadTargets(client);
    console.info(`[video-resolution] targets=${rows.length} dryRun=${args.dryRun}`);

    let ok = 0;
    let skipped = 0;
    let failed = 0;
    let processed = 0;

    for (let index = 0; index < rows.length; index += args.concurrency) {
      const chunk = rows.slice(index, index + args.concurrency);
      const results = await Promise.all(chunk.map((row) => inspectRow(row)));

      for (let i = 0; i < chunk.length; i += 1) {
        const row = chunk[i];
        const result = results[i];

        if (args.dryRun) {
          console.info(
            `[video-resolution] dry owned_file_id=${row.owned_file_id} status=${result.probe_status} ` +
              `class=${result.resolution_class || ""} size=${result.video_width || ""}x${result.video_height || ""}`
          );
        } else {
          await upsertMetadata(client, row, result);
        }

        if (result.probe_status === "ok") ok += 1;
        else if (result.probe_status === "path_not_allowed" || result.probe_status === "file_missing") skipped += 1;
        else failed += 1;

        processed += 1;
      }

      if (!args.dryRun && (processed % 100 === 0 || processed === rows.length)) {
        console.info(
          `[video-resolution] progress ${processed}/${rows.length} ok=${ok} skipped=${skipped} failed=${failed}`
        );
      }
    }

    console.info(`[video-resolution] done ok=${ok} skipped=${skipped} failed=${failed}`);
  } finally {
    await client.end();
  }
}

function parseArgs(values) {
  const parsed = {
    all: false,
    concurrency: 4,
    createTableOnly: false,
    dryRun: false,
    limit: 0,
    summary: false,
    timeoutMs: 30000,
  };

  for (let i = 0; i < values.length; i += 1) {
    const value = values[i];
    if (value === "--all") parsed.all = true;
    else if (value === "--create-table-only") parsed.createTableOnly = true;
    else if (value === "--dry-run") parsed.dryRun = true;
    else if (value === "--summary") parsed.summary = true;
    else if (value === "--concurrency") {
      parsed.concurrency = Math.max(1, Math.min(Number(values[i + 1] || 4), 8));
      i += 1;
    }
    else if (value === "--limit") {
      parsed.limit = Number(values[i + 1] || 0);
      i += 1;
    }
    else if (value === "--timeout-ms") {
      parsed.timeoutMs = Math.max(1000, Number(values[i + 1] || 30000));
      i += 1;
    }
  }

  return parsed;
}

async function printSummary(client) {
  const result = await client.query(`
    SELECT
      probe_status,
      COALESCE(resolution_class, 'none') AS resolution_class,
      COUNT(*)::integer AS count
    FROM ${TABLE_NAME}
    GROUP BY probe_status, COALESCE(resolution_class, 'none')
    ORDER BY probe_status, resolution_class
  `);

  console.info(JSON.stringify(result.rows));
}

function loadEnvFile() {
  if (!fs.existsSync(ENV_PATH)) return;
  const text = fs.readFileSync(ENV_PATH, "utf8");
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const idx = line.indexOf("=");
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim().replace(/^['"]|['"]$/g, "");
    if (key && process.env[key] === undefined) process.env[key] = value;
  }
}

function requireEnv(name) {
  const value = process.env[name];
  if (!value || value.startsWith("CHANGE_ME_")) {
    throw new Error(`${name} is not configured`);
  }
  return value;
}

function createPgClient() {
  const sslValue = (process.env.PGSSL || "false").toLowerCase();
  return new Client({
    host: requireEnv("PGHOST"),
    port: Number(process.env.PGPORT || 5432),
    database: requireEnv("PGDATABASE"),
    user: requireEnv("PGUSER"),
    password: requireEnv("PGPASSWORD"),
    ssl: sslValue === "true" ? { rejectUnauthorized: false } : false,
  });
}

async function ensureMetadataTable(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS ${TABLE_NAME} (
      owned_file_id bigint PRIMARY KEY,
      product_id text NOT NULL,
      current_path text NOT NULL,
      current_file_name text,
      file_size bigint,
      file_modified_at timestamptz,
      video_width integer,
      video_height integer,
      resolution_class text,
      probe_status text NOT NULL,
      probe_error text,
      probed_at timestamptz NOT NULL DEFAULT now(),
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT xxx_chk_tm011_resolution_class
        CHECK (resolution_class IS NULL OR resolution_class IN ('4K', 'HD', 'LOW')),
      CONSTRAINT xxx_chk_tm011_probe_status
        CHECK (probe_status IN ('ok', 'failed', 'file_missing', 'path_not_allowed'))
    )
  `);

  await client.query(`
    CREATE INDEX IF NOT EXISTS xxx_idx_tm011_video_metadata_product_id
      ON ${TABLE_NAME} (product_id)
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS xxx_idx_tm011_video_metadata_resolution_class
      ON ${TABLE_NAME} (resolution_class)
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS xxx_idx_tm011_video_metadata_probe_status
      ON ${TABLE_NAME} (probe_status)
  `);
}

async function loadTargets(client) {
  const limitSql = args.limit > 0 ? "LIMIT $1" : "";
  const params = args.limit > 0 ? [args.limit] : [];
  const missingOnlySql = args.all
    ? ""
    : `AND NOT EXISTS (
        SELECT 1
        FROM ${TABLE_NAME} vm
        WHERE vm.owned_file_id = o.id
      )`;

  const result = await client.query(
    `
      SELECT
        o.id AS owned_file_id,
        o.product_id::text AS product_id,
        o.current_path,
        o.current_file_name,
        o.file_size,
        o.file_modified_at
      FROM public.xxx_tm002_owned_files o
      WHERE o.status = 'owned'
        AND lower(COALESCE(o.file_ext, '.mp4')) = '.mp4'
        ${missingOnlySql}
      ORDER BY o.updated_at DESC NULLS LAST, o.id DESC
      ${limitSql}
    `,
    params
  );

  return result.rows;
}

async function inspectRow(row) {
  const currentPath = normalizeWindowsPath(row.current_path);

  if (!isPathAllowed(currentPath)) {
    return {
      probe_status: "path_not_allowed",
      probe_error: "path_not_allowed",
    };
  }

  if (!fs.existsSync(currentPath)) {
    return {
      probe_status: "file_missing",
      probe_error: "file_missing",
    };
  }

  try {
    const metadata = await runFfprobe(currentPath);
    const videoStream = (metadata.streams || []).find((stream) => stream.codec_type === "video");
    const width = Number(videoStream?.width || 0);
    const height = Number(videoStream?.height || 0);

    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
      return {
        probe_status: "failed",
        probe_error: "video_dimensions_not_found",
      };
    }

    return {
      probe_status: "ok",
      video_width: width,
      video_height: height,
      resolution_class: classifyResolution(width, height),
    };
  } catch (error) {
    return {
      probe_status: "failed",
      probe_error: String(error?.message || error).slice(0, 1000),
    };
  }
}

function runFfprobe(filePath) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      ffprobe.path,
      [
        "-v",
        "error",
        "-select_streams",
        "v:0",
        "-show_entries",
        "stream=codec_type,width,height",
        "-of",
        "json",
        filePath,
      ],
      { windowsHide: true }
    );

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    let settled = false;
    let timer;
    const finishReject = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    };
    const finishResolve = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };

    child.once("error", finishReject);
    timer = setTimeout(() => {
      child.kill("SIGKILL");
      finishReject(new Error(`ffprobe_timeout_${args.timeoutMs}ms`));
    }, args.timeoutMs);

    child.once("close", (code) => {
      if (code !== 0) {
        finishReject(new Error(stderr.trim() || `ffprobe_exit_${code}`));
        return;
      }

      try {
        finishResolve(JSON.parse(stdout || "{}"));
      } catch (error) {
        finishReject(error);
      }
    });
  });
}

function classifyResolution(width, height) {
  const maxSide = Math.max(width, height);
  const minSide = Math.min(width, height);

  if (maxSide >= 3840 || minSide >= 2160) return "4K";
  if (maxSide >= 1280 || minSide >= 720) return "HD";
  return "LOW";
}

async function upsertMetadata(client, row, result) {
  await client.query(
    `
      INSERT INTO ${TABLE_NAME} (
        owned_file_id,
        product_id,
        current_path,
        current_file_name,
        file_size,
        file_modified_at,
        video_width,
        video_height,
        resolution_class,
        probe_status,
        probe_error,
        probed_at,
        created_at,
        updated_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, now(), now(), now())
      ON CONFLICT (owned_file_id) DO UPDATE SET
        product_id = EXCLUDED.product_id,
        current_path = EXCLUDED.current_path,
        current_file_name = EXCLUDED.current_file_name,
        file_size = EXCLUDED.file_size,
        file_modified_at = EXCLUDED.file_modified_at,
        video_width = EXCLUDED.video_width,
        video_height = EXCLUDED.video_height,
        resolution_class = EXCLUDED.resolution_class,
        probe_status = EXCLUDED.probe_status,
        probe_error = EXCLUDED.probe_error,
        probed_at = now(),
        updated_at = now()
    `,
    [
      row.owned_file_id,
      row.product_id,
      normalizeWindowsPath(row.current_path),
      row.current_file_name || null,
      row.file_size || null,
      row.file_modified_at || null,
      result.video_width || null,
      result.video_height || null,
      result.resolution_class || null,
      result.probe_status,
      result.probe_error || null,
    ]
  );
}

function normalizeWindowsPath(targetPath) {
  const raw = String(targetPath || "").trim().replace(/\//g, "\\");
  const withoutLeadingSlash = raw.replace(/^[\\]+([A-Za-z]:)/, "$1");
  const fixedDrive = withoutLeadingSlash.replace(/^([A-Za-z]):(?![\\])/, "$1:\\");
  return path.normalize(fixedDrive).replace(/\//g, "\\");
}

function resolveAllowedRoots() {
  const raw = (process.env.MEDIA_ALLOWED_ROOTS || "").trim();
  if (!raw) return [];
  return raw
    .split(";")
    .map((value) => normalizeWindowsPath(value.trim()))
    .filter(Boolean);
}

function isPathAllowed(currentPath) {
  const normalized = normalizeWindowsPath(currentPath);
  const allowedRoots = resolveAllowedRoots();
  if (allowedRoots.length === 0) return false;

  const lower = normalized.toLowerCase();
  return allowedRoots.some((root) => {
    const rootLower = normalizeWindowsPath(root).toLowerCase().replace(/[\\]+$/, "");
    return lower === rootLower || lower.startsWith(`${rootLower}\\`);
  });
}
