import fs from "fs";
import os from "os";
import path from "path";
import { spawn } from "child_process";
import { Client } from "pg";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const PROJECT_ROOT = path.resolve(__dirname, "..", "..");
const ENV_PATH = path.resolve(PROJECT_ROOT, ".env");
const EXPLORER_EXE = "C:\\Windows\\explorer.exe";
const MPC_BE_ALIAS_NAME = "mpc-be.exe";

type LibraryRow = {
  owned_file_id: number | null;
  product_id: string;
  title: string;
  seller_name: string | null;
  current_path: string;
  current_file_name: string | null;
  thumbnail_path: string;
  collect_status: string;
  updated_at: string | null;
};

type ThumbnailPathRow = {
  local_thumbnail_path: string | null;
};

type OpenPathRequest = {
  ownedFileId?: number | string | null;
  productId?: string | null;

  // SellerCompletion 用 local path
  fullPath?: string | null;
};

type OpenPathResolution = {
  current_path: string;
  product_id: string;
  current_file_name: string | null;
};

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

function requireEnv(name: string): string {
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

function inferSellerNameFromPath(currentPath: string): string {
  const normalized = String(currentPath || "").replace(/\//g, "\\");
  const parts = normalized.split("\\").filter(Boolean);
  if (parts.length < 2) return "unknown_seller";
  return parts[parts.length - 2] || "unknown_seller";
}

function buildPathHint(currentPath: string, currentFileName?: string | null): string {
  const normalized = String(currentPath || "").replace(/\//g, "\\");
  const fileName = currentFileName || path.basename(normalized);
  const sellerName = inferSellerNameFromPath(normalized);
  return `${sellerName}\\${fileName}`;
}

function normalizeWindowsPath(targetPath: string): string {
  const raw = String(targetPath || "").trim().replace(/\//g, "\\");
  // Convert drive-relative paths like "K:all_fc2\..." to absolute "K:\all_fc2\..."
  const fixedDrive = raw.replace(/^([A-Za-z]):(?![\\])/, "$1:\\");
  return path.normalize(fixedDrive).replace(/\//g, "\\");
}

function resolveAllowedRoots(): string[] {
  const raw = (process.env.MEDIA_ALLOWED_ROOTS || "").trim();
  if (!raw) return [];
  return raw
    .split(";")
    .map((v) => normalizeWindowsPath(v.trim()))
    .filter(Boolean);
}

function isPathAllowed(currentPath: string): boolean {
  const normalized = normalizeWindowsPath(currentPath);
  const allowedRoots = resolveAllowedRoots();
  if (allowedRoots.length === 0) return false;

  const lower = normalized.toLowerCase();
  return allowedRoots.some((root) => {
    const rootLower = normalizeWindowsPath(root).toLowerCase().replace(/[\\]+$/, "");
    return lower === rootLower || lower.startsWith(`${rootLower}\\`);
  });
}

function resolveThumbnailRoots(): string[] {
  const raw = (process.env.THUMBNAIL_ALLOWED_ROOTS || "").trim();
  const configuredRoots = raw
    ? raw
        .split(";")
        .map((v) => normalizeWindowsPath(v.trim()))
        .filter(Boolean)
    : [];
  return configuredRoots.length > 0
    ? configuredRoots
    : [normalizeWindowsPath(path.join(PROJECT_ROOT, "fc2_sum"))];
}

function isPathUnderRoots(targetPath: string, roots: string[]): boolean {
  const normalized = normalizeWindowsPath(targetPath).toLowerCase();
  return roots.some((root) => {
    const rootLower = normalizeWindowsPath(root).toLowerCase().replace(/[\\]+$/, "");
    return normalized === rootLower || normalized.startsWith(`${rootLower}\\`);
  });
}

function contentTypeForImage(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".png") return "image/png";
  if (ext === ".webp") return "image/webp";
  return "image/jpeg";
}

async function queryLibraryRows(): Promise<LibraryRow[]> {
  loadEnvFile();
  const client = createPgClient();
  await client.connect();
  try {
    const sql = `
      SELECT
        o.id AS owned_file_id,
        o.product_id::text AS product_id,
        COALESCE(m.title, o.current_file_name) AS title,
        COALESCE(wt.wiki_seller_name, sg.canonical_seller_name) AS seller_name,
        o.current_path,
        o.current_file_name,
        CASE
          WHEN COALESCE(wt.local_thumbnail_path, '') <> ''
          THEN '/api/library/thumbnail/' || o.product_id::text
          ELSE ''
        END AS thumbnail_path,
        COALESCE(wt.collect_status, 'unknown') AS collect_status,
        o.updated_at
      FROM public.xxx_tm002_owned_files o
      LEFT JOIN public.xxx_vq001_moviemaster_unique m
        ON m.product_id = o.product_id::text
      LEFT JOIN public.xxx_tm003_seller_groups sg
        ON sg.seller_id::text = m.seller_id::text
      LEFT JOIN public.xxx_vq029_owned_file_thumbnail_status wt
        ON wt.owned_file_id = o.id
      WHERE o.status = 'owned'
      ORDER BY o.updated_at DESC NULLS LAST, o.id DESC
    `;

    const fallbackSql = `
      SELECT
        o.id AS owned_file_id,
        o.product_id::text AS product_id,
        COALESCE(m.title, o.current_file_name) AS title,
        sg.canonical_seller_name AS seller_name,
        o.current_path,
        o.current_file_name,
        '' AS thumbnail_path,
        'unknown' AS collect_status,
        o.updated_at
      FROM public.xxx_tm002_owned_files o
      LEFT JOIN public.xxx_vq001_moviemaster_unique m
        ON m.product_id = o.product_id::text
      LEFT JOIN public.xxx_tm003_seller_groups sg
        ON sg.seller_id::text = m.seller_id::text
      WHERE o.status = 'owned'
      ORDER BY o.updated_at DESC NULLS LAST, o.id DESC
    `;

    try {
      const rs = await client.query<LibraryRow>(sql);
      return rs.rows;
    } catch (error: any) {
      if (error?.code === "42P01") {
        const rs = await client.query<LibraryRow>(fallbackSql);
        return rs.rows;
      }
      throw error;
    }
  } finally {
    await client.end();
  }
}

async function resolveThumbnailPath(productId: string): Promise<string | null> {
  loadEnvFile();
  const client = createPgClient();
  await client.connect();
  try {
    const result = await client.query<ThumbnailPathRow>(
      `
        SELECT local_thumbnail_path
        FROM public.xxx_tm009_fc2_wiki_thumbnail_assets
        WHERE product_id = $1
          AND COALESCE(local_thumbnail_path, '') <> ''
          AND thumbnail_status = 'collected'
        LIMIT 1
      `,
      [productId]
    );
    return result.rows[0]?.local_thumbnail_path || null;
  } finally {
    await client.end();
  }
}

async function readJsonBody(req: any): Promise<OpenPathRequest> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return {};
  try {
    return JSON.parse(raw) as OpenPathRequest;
  } catch {
    return {};
  }
}

async function resolveCurrentPath(payload: OpenPathRequest): Promise<string | null> {
  const hasOwnedFileId =
    !(payload.ownedFileId === null || payload.ownedFileId === undefined || payload.ownedFileId === "");
  const ownedFileId = hasOwnedFileId ? Number(payload.ownedFileId) : null;
  const productId = (payload.productId || "").trim();
  // ============================================================
  // SellerCompletion 用:
  // localFullPath を直接受け取った場合はそれを優先使用
  // ============================================================
  const fullPath = (payload.fullPath || "").trim();

  if (fullPath) {
    return normalizeWindowsPath(fullPath);
  }
  // ============================================================
  if (!ownedFileId && !productId) return null;

  loadEnvFile();
  const client = createPgClient();
  await client.connect();
  try {
    if (hasOwnedFileId) {
      if (!ownedFileId || !Number.isFinite(ownedFileId)) return null;
      const byId = await client.query<OpenPathResolution>(
        `
          SELECT current_path, product_id::text, current_file_name
          FROM public.xxx_tm002_owned_files
          WHERE id = $1
          LIMIT 1
        `,
        [ownedFileId]
      );
      if (!byId.rows[0]?.current_path) return null;
      return resolveExistingMediaPath(byId.rows[0]);
    }

    // For open operations, do not fallback by productId.
    // productId can have multiple owned files and lead to wrong location.
    if (productId) return null;

    return null;
  } finally {
    await client.end();
  }
}

function resolveExistingMediaPath(row: OpenPathResolution): string {
  const normalized = normalizeWindowsPath(row.current_path);
  if (!isPathAllowed(normalized)) return normalized;
  if (fs.existsSync(normalized)) return normalized;

  const folderPath = path.dirname(normalized);
  if (!fs.existsSync(folderPath)) return normalized;

  const productId = String(row.product_id || "").trim();
  const expectedFileName = row.current_file_name || path.basename(normalized);
  const expectedLoose = normalizeFileNameForLookup(expectedFileName);
  const candidates = fs
    .readdirSync(folderPath, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .filter((name) => path.extname(name).toLowerCase() === ".mp4");

  const exactCurrentFileName = row.current_file_name ? path.join(folderPath, row.current_file_name) : "";
  if (exactCurrentFileName && fs.existsSync(exactCurrentFileName)) return exactCurrentFileName;

  const looseMatches = candidates.filter((name) => normalizeFileNameForLookup(name) === expectedLoose);
  if (looseMatches.length === 1) return path.join(folderPath, looseMatches[0]);

  if (productId) {
    const productMatches = candidates.filter((name) => name.includes(productId));
    if (productMatches.length === 1) return path.join(folderPath, productMatches[0]);

    const expectedSuffix = extractFilePartSuffix(expectedFileName);
    if (expectedSuffix) {
      const suffixMatches = productMatches.filter((name) => extractFilePartSuffix(name) === expectedSuffix);
      if (suffixMatches.length === 1) return path.join(folderPath, suffixMatches[0]);
    }

    const expectedDuplicateSuffix = extractDuplicateSuffix(expectedFileName);
    const duplicateMatches = productMatches.filter((name) => extractDuplicateSuffix(name) === expectedDuplicateSuffix);
    if (duplicateMatches.length === 1) return path.join(folderPath, duplicateMatches[0]);

    const looseProductMatches = productMatches.filter((name) =>
      normalizeFileNameForLookup(name).includes(normalizeFileNameForLookup(productId))
    );
    if (looseProductMatches.length === 1) return path.join(folderPath, looseProductMatches[0]);
  }

  return normalized;
}

function extractDuplicateSuffix(fileName: string): string {
  const baseName = path.basename(String(fileName || ""), path.extname(fileName || ""));
  const match = baseName.match(/\(([0-9]{1,3})\)$/);
  return match ? String(Number(match[1])) : "none";
}

function extractFilePartSuffix(fileName: string): string {
  const baseName = path.basename(String(fileName || ""), path.extname(fileName || ""));
  const match = baseName.match(/(?:^|[-_\s])([0-9]{1,3})$/);
  if (!match) return "";
  return String(Number(match[1]));
}

function normalizeFileNameForLookup(fileName: string): string {
  return String(fileName || "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}.]+/gu, "");
}

async function openExplorerFolder(targetPath: string) {
  const normalized = normalizeWindowsPath(targetPath);
  const folderPath = path.dirname(normalized);
  if (!isPathAllowed(folderPath)) {
    throw new Error("folder_not_allowed");
  }
  if (!fs.existsSync(folderPath)) {
    throw new Error("folder_not_exists");
  }
  await launchDetached(EXPLORER_EXE, [folderPath], { visible: true });
}

async function openMediaFile(targetPath: string) {
  const normalized = normalizeWindowsPath(targetPath);
  if (!isPathAllowed(normalized)) {
    throw new Error("file_not_allowed");
  }
  if (!fs.existsSync(normalized)) {
    throw new Error("file_not_exists");
  }

  const launchTemplate = (process.env.MPC_BE_LAUNCH_TEMPLATE || "").trim();
  const useLaunchTemplate = (process.env.MPC_BE_USE_LAUNCH_TEMPLATE || "false").toLowerCase() === "true";
  const mpcPath = (process.env.MPC_BE_PATH || "").trim();
  const mpcExecutable = resolveMpcBeExecutable(mpcPath);

  if (useLaunchTemplate && launchTemplate) {
    const quotedPath = quoteCmdArg(normalized);
    const command = launchTemplate.replaceAll('"{file}"', quotedPath).replaceAll("{file}", quotedPath);
    await launchDetached("cmd.exe", ["/d", "/s", "/c", command]);
    return;
  }

  if (mpcPath || mpcExecutable) {
    if (!mpcExecutable) {
      throw new Error("mpc_be_not_exists");
    }
    await launchMpcViaExplorerLauncher(mpcExecutable, normalized);
    return;
  }

  // Fallback: rely on Windows file association.
  await launchWindowsStart(["explorer.exe", normalized]);
}

function resolveMpcBeExecutable(configuredPath: string): string | null {
  const normalizedConfiguredPath = configuredPath ? normalizeWindowsPath(configuredPath) : "";
  const aliasPath = resolveWindowsAppAlias(MPC_BE_ALIAS_NAME);

  if (aliasPath && launcherPathExists(aliasPath)) {
    return aliasPath;
  }
  if (normalizedConfiguredPath && fs.existsSync(normalizedConfiguredPath) && !isWindowsAppsPackagePath(normalizedConfiguredPath)) {
    return normalizedConfiguredPath;
  }
  return null;
}

function resolveWindowsAppAlias(exeName: string): string | null {
  const localAppData =
    process.env.LOCALAPPDATA ||
    (process.env.USERPROFILE ? path.join(process.env.USERPROFILE, "AppData", "Local") : "") ||
    inferLocalAppDataFromProjectRoot();
  if (!localAppData) return null;
  return path.join(localAppData, "Microsoft", "WindowsApps", exeName);
}

function launcherPathExists(targetPath: string): boolean {
  try {
    fs.lstatSync(targetPath);
    return true;
  } catch {
    return false;
  }
}

function inferLocalAppDataFromProjectRoot(): string {
  const parts = normalizeWindowsPath(PROJECT_ROOT).split("\\").filter(Boolean);
  if (parts.length < 3 || parts[1].toLowerCase() !== "users") return "";
  return path.join(`${parts[0]}\\`, parts[1], parts[2], "AppData", "Local");
}

function isWindowsAppsPackagePath(targetPath: string): boolean {
  return normalizeWindowsPath(targetPath).toLowerCase().includes("\\program files\\windowsapps\\");
}

function getLauncherStatus() {
  const configuredPath = (process.env.MPC_BE_PATH || "").trim();
  const aliasPath = resolveWindowsAppAlias(MPC_BE_ALIAS_NAME);
  return {
    mpcAliasLaunchable: Boolean(aliasPath && launcherPathExists(aliasPath)),
    mpcConfiguredReady: Boolean(
      configuredPath && fs.existsSync(normalizeWindowsPath(configuredPath)) && !isWindowsAppsPackagePath(configuredPath)
    ),
    mpcConfiguredIsWindowsApps: Boolean(configuredPath && isWindowsAppsPackagePath(configuredPath)),
    mpcTemplateConfigured: Boolean((process.env.MPC_BE_LAUNCH_TEMPLATE || "").trim()),
    mpcTemplateEnabled: (process.env.MPC_BE_USE_LAUNCH_TEMPLATE || "false").toLowerCase() === "true",
  };
}

function quoteCmdArg(value: string): string {
  return `"${String(value).replace(/"/g, '\\"')}"`;
}

async function launchMpcViaExplorerLauncher(executablePath: string, mediaPath: string): Promise<void> {
  const baseName = `thumbnail-library-open-${process.pid}-${Date.now()}`;
  const scriptPath = path.join(os.tmpdir(), `${baseName}.ps1`);
  const commandPath = path.join(os.tmpdir(), `${baseName}.cmd`);
  const script = [
    "$ErrorActionPreference = 'Stop'",
    `$FilePath = ${quotePowerShellSingleString(executablePath)}`,
    `$MediaPath = ${quotePowerShellSingleString(mediaPath)}`,
    'Start-Process -FilePath $FilePath -ArgumentList (\'"\' + $MediaPath + \'"\')',
    "",
  ].join("\r\n");
  const command = [
    "@echo off",
    `powershell.exe -NoProfile -ExecutionPolicy Bypass -File "${commandPathForBatch(scriptPath)}"`,
    "",
  ].join("\r\n");

  fs.writeFileSync(scriptPath, `\ufeff${script}`, "utf8");
  fs.writeFileSync(commandPath, command, "utf8");
  try {
    await launchDetached(EXPLORER_EXE, [commandPath], { visible: true });
  } finally {
    setTimeout(() => cleanupLauncherFiles([scriptPath, commandPath]), 30000);
  }
}

function quotePowerShellSingleString(value: string): string {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function commandPathForBatch(value: string): string {
  return String(value).replace(/%/g, "%%");
}

function cleanupLauncherFiles(filePaths: string[]) {
  for (const filePath of filePaths) {
    try {
      fs.unlinkSync(filePath);
    } catch {
      // Ignore cleanup errors for one-shot launcher files.
    }
  }
}

function launchWindowsStart(commandAndArgs: string[]): Promise<void> {
  const [command, ...args] = commandAndArgs;
  const line = ["start", '""', quoteCmdArg(command), ...args.map(quoteCmdArg)].join(" ");
  return launchAndWait("cmd.exe", ["/d", "/s", "/c", line], 2500);
}

function launchAndWait(command: string, args: string[], timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      detached: false,
      stdio: "ignore",
      windowsHide: true,
    });
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      if (error) reject(error);
      else resolve();
    };
    const timer = setTimeout(() => finish(), timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timer);
      finish(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (code && code !== 0) {
        finish(new Error(`launch_failed:${code}`));
        return;
      }
      finish();
    });
  });
}

function launchDetached(command: string, args: string[], options: { visible?: boolean } = {}): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      detached: true,
      stdio: "ignore",
      windowsHide: options.visible ? false : true,
      shell: false,
    });
    let settled = false;
    const settleResolve = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    const settleReject = (error: unknown) => {
      if (settled) return;
      settled = true;
      reject(error instanceof Error ? error : new Error(String(error)));
    };

    // Only hard spawn errors are treated as failures.
    // GUI launchers (like explorer.exe) may return non-zero even on success.
    child.once("error", (error) => {
      settleReject(error);
    });

    child.unref();

    // Launch accepted if no immediate spawn error.
    setTimeout(() => {
      settleResolve();
    }, 350);
  });
}

export default defineConfig({
  plugins: [
    react(),
    {
      name: "local-library-api",
      enforce: "pre",
      configureServer(server) {
        attachLibraryApi(server);
      },
      configurePreviewServer(server) {
        attachLibraryApi(server);
      },
    },
  ],
  server: {
    host: "localhost",
    port: 5173,
    strictPort: true,
  },
  preview: {
    host: "localhost",
    port: 5173,
    strictPort: true,
  },
});

function attachLibraryApi(server: any) {
        server.middlewares.use(async (req: any, res: any, next: any) => {
          const url = (req.url || "").split("?")[0];
          if (!url.startsWith("/api/library/health")) {
            next();
            return;
          }
          res.setHeader("Content-Type", "application/json; charset=utf-8");
          res.end(
            JSON.stringify({
              ok: true,
              app: "thumbnail_library_ui",
              apiVersion: "open-file-template-gated-v15",
              launcher: getLauncherStatus(),
            })
          );
        });

        server.middlewares.use(async (req: any, res: any, next: any) => {
          const url = (req.url || "").split("?")[0];
          if (!url.startsWith("/api/library/items")) {
            next();
            return;
          }
          try {
            const rows = await queryLibraryRows();
            const items = rows.map((r) => ({
              ownedFileId: r.owned_file_id,
              productId: r.product_id,
              title: r.title,
              sellerName: r.seller_name || inferSellerNameFromPath(r.current_path),
              pathHint: buildPathHint(r.current_path, r.current_file_name),
              thumbnailPath: r.thumbnail_path,
              collectStatus: r.collect_status,
              updatedAt: r.updated_at,
            }));
            res.setHeader("Content-Type", "application/json; charset=utf-8");
            res.end(JSON.stringify({ items }));
          } catch (error: any) {
            res.statusCode = 500;
            res.setHeader("Content-Type", "application/json; charset=utf-8");
            res.end(JSON.stringify({ error: error?.message || "unknown_error", items: [] }));
          }
        });

        server.middlewares.use(async (req: any, res: any, next: any) => {
          const url = decodeURIComponent((req.url || "").split("?")[0]);
          const match = url.match(/^\/api\/library\/thumbnail\/([0-9]{6,8})$/);
          if (!match) {
            next();
            return;
          }
          try {
            const thumbnailPath = await resolveThumbnailPath(match[1]);
            if (!thumbnailPath) {
              res.statusCode = 404;
              res.setHeader("Content-Type", "application/json; charset=utf-8");
              res.end(JSON.stringify({ ok: false, message: "thumbnail_not_found" }));
              return;
            }

            const normalized = normalizeWindowsPath(thumbnailPath);
            if (!isPathUnderRoots(normalized, resolveThumbnailRoots())) {
              res.statusCode = 403;
              res.setHeader("Content-Type", "application/json; charset=utf-8");
              res.end(JSON.stringify({ ok: false, message: "thumbnail_path_not_allowed" }));
              return;
            }

            if (!fs.existsSync(normalized)) {
              res.statusCode = 404;
              res.setHeader("Content-Type", "application/json; charset=utf-8");
              res.end(JSON.stringify({ ok: false, message: "thumbnail_file_not_exists" }));
              return;
            }

            res.statusCode = 200;
            res.setHeader("Content-Type", contentTypeForImage(normalized));
            fs.createReadStream(normalized).pipe(res);
          } catch (error: any) {
            res.statusCode = 500;
            res.setHeader("Content-Type", "application/json; charset=utf-8");
            res.end(JSON.stringify({ ok: false, message: error?.message || "thumbnail_failed" }));
          }
        });

        server.middlewares.use(async (req: any, res: any, next: any) => {
          const url = (req.url || "").split("?")[0];
          if (!url.startsWith("/api/library/open-folder")) {
            next();
            return;
          }
          if ((req.method || "").toUpperCase() !== "POST") {
            res.statusCode = 405;
            res.setHeader("Content-Type", "application/json; charset=utf-8");
            res.end(JSON.stringify({ ok: false, message: "method_not_allowed" }));
            return;
          }
          try {
            const payload = await readJsonBody(req);
            const currentPath = await resolveCurrentPath(payload);
            if (!currentPath) {
              res.statusCode = 404;
              res.setHeader("Content-Type", "application/json; charset=utf-8");
              res.end(JSON.stringify({ ok: false, message: "path_not_found" }));
              return;
            }
            if (!isPathAllowed(currentPath)) {
              res.statusCode = 403;
              res.setHeader("Content-Type", "application/json; charset=utf-8");
              res.end(JSON.stringify({ ok: false, message: "path_not_allowed" }));
              return;
            }
            await openExplorerFolder(currentPath);
            res.statusCode = 200;
            res.setHeader("Content-Type", "application/json; charset=utf-8");
            res.end(JSON.stringify({ ok: true, mode: "folder", launcher: "explorer-direct" }));
          } catch (error: any) {
            res.statusCode = 500;
            res.setHeader("Content-Type", "application/json; charset=utf-8");
            res.end(JSON.stringify({ ok: false, message: error?.message || "open_folder_failed" }));
          }
        });

        server.middlewares.use(async (req: any, res: any, next: any) => {
          const url = (req.url || "").split("?")[0];
          if (!url.startsWith("/api/library/open-file")) {
            next();
            return;
          }
          if ((req.method || "").toUpperCase() !== "POST") {
            res.statusCode = 405;
            res.setHeader("Content-Type", "application/json; charset=utf-8");
            res.end(JSON.stringify({ ok: false, message: "method_not_allowed" }));
            return;
          }
          try {
            const payload = await readJsonBody(req);
            const currentPath = await resolveCurrentPath(payload);
            if (!currentPath) {
              res.statusCode = 404;
              res.setHeader("Content-Type", "application/json; charset=utf-8");
              res.end(JSON.stringify({ ok: false, message: "path_not_found" }));
              return;
            }
            if (!isPathAllowed(currentPath)) {
              res.statusCode = 403;
              res.setHeader("Content-Type", "application/json; charset=utf-8");
              res.end(JSON.stringify({ ok: false, message: "path_not_allowed" }));
              return;
            }
            if (!fs.existsSync(currentPath)) {
              res.statusCode = 404;
              res.setHeader("Content-Type", "application/json; charset=utf-8");
              res.end(JSON.stringify({ ok: false, message: "file_not_exists" }));
              return;
            }
            await openMediaFile(currentPath);
            res.statusCode = 200;
            res.setHeader("Content-Type", "application/json; charset=utf-8");
            res.end(JSON.stringify({ ok: true, mode: "file", launcher: "mpc-be-explorer-launcher" }));
          } catch (error: any) {
            res.statusCode = 500;
            res.setHeader("Content-Type", "application/json; charset=utf-8");
            res.end(JSON.stringify({ ok: false, message: error?.message || "open_file_failed" }));
          }
        });
}
