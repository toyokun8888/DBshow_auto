const fs = require("fs");
const path = require("path");
const { Client } = require("pg");

const PROJECT_ROOT = path.resolve(__dirname, "..");
const ENV_PATH = path.resolve(PROJECT_ROOT, ".env");

function loadEnvFile(envPath) {
  if (!fs.existsSync(envPath)) {
    return;
  }

  const text = fs.readFileSync(envPath, "utf8");
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }

    const separatorIndex = line.indexOf("=");
    if (separatorIndex === -1) {
      continue;
    }

    const key = line.slice(0, separatorIndex).trim();
    const value = line.slice(separatorIndex + 1).trim();
    if (key && process.env[key] === undefined) {
      process.env[key] = unquoteEnvValue(value);
    }
  }
}

function unquoteEnvValue(value) {
  if (
    (value.startsWith("\"") && value.endsWith("\"")) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function requireEnv(name) {
  const value = process.env[name];
  if (!value || value.startsWith("CHANGE_ME_")) {
    throw new Error(`${name} is not configured in .env`);
  }
  return value;
}

function createClient() {
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

async function main() {
  loadEnvFile(ENV_PATH);

  const client = createClient();
  await client.connect();

  try {
    const result = await client.query(`
      SELECT
        current_database() AS database_name,
        current_user AS user_name,
        inet_server_addr() AS server_addr,
        inet_server_port() AS server_port
    `);

    process.stdout.write("PostgreSQL connection check succeeded.\n");
    process.stdout.write(JSON.stringify(result.rows[0], null, 2));
    process.stdout.write("\n");
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  process.stderr.write("PostgreSQL connection check failed.\n");
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
