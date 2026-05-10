import fs from "fs";
import path from "path";
import { spawn } from "child_process";
import { Client } from "pg";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const PROJECT_ROOT = path.resolve(__dirname, "..", "..");
const ENV_PATH = path.resolve(PROJECT_ROOT, ".env");
const EXPLORER_EXE = "C:\\Windows\\explorer.exe";

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

type OpenPathRequest = {
  ownedFileId?: number | string | null;
  productId?: string | null;
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
        sg.canonical_seller_name AS seller_name,
        o.current_path,
        o.current_file_name,
        COALESCE(t.thumbnail_path, '') AS thumbnail_path,
        COALESCE(t.collect_status, 'unknown') AS collect_status,
        o.updated_at
      FROM public.xxx_tm002_owned_files o
      LEFT JOIN public.xxx_vq001_moviemaster_unique m
        ON m.product_id = o.product_id::text
      LEFT JOIN public.xxx_tm003_seller_groups sg
        ON sg.seller_id::text = m.seller_id::text
      LEFT JOIN public.xxx_tm006_thumbnail_assets t
        ON t.product_id = o.product_id::text
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

  if (!ownedFileId && !productId) return null;

  loadEnvFile();
  const client = createPgClient();
  await client.connect();
  try {
    if (hasOwnedFileId) {
      if (!ownedFileId || !Number.isFinite(ownedFileId)) return null;
      const byId = await client.query<{ current_path: string }>(
        `
          SELECT current_path
          FROM public.xxx_tm002_owned_files
          WHERE id = $1
          LIMIT 1
        `,
        [ownedFileId]
      );
      if (!byId.rows[0]?.current_path) return null;
      return normalizeWindowsPath(byId.rows[0].current_path);
    }

    // For open operations, do not fallback by productId.
    // productId can have multiple owned files and lead to wrong location.
    if (productId) return null;

    return null;
  } finally {
    await client.end();
  }
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
  if (!fs.existsSync(normalized)) {
    throw new Error(`file_not_exists: ${normalized}`);
  }

  const launchTemplate = (process.env.MPC_BE_LAUNCH_TEMPLATE || "").trim();
  const mpcPath = (process.env.MPC_BE_PATH || "").trim();

  if (mpcPath) {
    await launchWindowsStart([mpcPath, normalized]);
    return;
  }

  if (launchTemplate) {
    const quotedPath = quoteCmdArg(normalized);
    const command = launchTemplate.replaceAll('"{file}"', quotedPath).replaceAll("{file}", quotedPath);
    await launchDetached("cmd.exe", ["/d", "/s", "/c", command]);
    return;
  }

  // Fallback: rely on Windows file association.
  await launchWindowsStart(["explorer.exe", normalized]);
}

function quoteCmdArg(value: string): string {
  return `"${String(value).replace(/"/g, '\\"')}"`;
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
            JSON.stringify({ ok: true, app: "thumbnail_library_ui", apiVersion: "open-folder-explorer-direct-v3" })
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
            res.end(JSON.stringify({ ok: true, mode: "file" }));
          } catch (error: any) {
            res.statusCode = 500;
            res.setHeader("Content-Type", "application/json; charset=utf-8");
            res.end(JSON.stringify({ ok: false, message: "open_file_failed" }));
          }
        });
}
