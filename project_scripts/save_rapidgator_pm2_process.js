const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const TARGET_NAME = "daily-0430-rapidgator-delta";
const ACTIVE_ONCE_NAME = "once-fc2-javarchive-backfill";
const EXPECTED_CRON = "30 4 * * *";
const EXPECTED_SCRIPT = path.resolve(__dirname, "pm2_scheduled_runner.js");
const EXPECTED_TARGET = path.resolve(__dirname, "rapidgator_daily_delta.js");

function timestamp(date = new Date()) {
  return date.toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
}

function pm2CliScriptPath() {
  const script = process.env.APPDATA
    ? path.join(process.env.APPDATA, "npm", "node_modules", "pm2", "bin", "pm2")
    : "";
  if (!script || !fs.existsSync(script)) throw new Error("PM2 CLI script was not found");
  return script;
}

function validateTarget(processEntry) {
  const environment = processEntry?.pm2_env;
  if (!environment || environment.name !== TARGET_NAME || environment.cron_restart !== EXPECTED_CRON) {
    throw new Error("Live Rapidgator PM2 process does not match the expected name or cron");
  }
  if (path.resolve(environment.pm_exec_path || "") !== EXPECTED_SCRIPT ||
      path.resolve(environment.SCHEDULE_TARGET_SCRIPT || "") !== EXPECTED_TARGET) {
    throw new Error("Live Rapidgator PM2 process points to an unexpected script");
  }
  if (environment.RAPIDGATOR_DAILY_EXECUTE !== "YES" ||
      environment.RAPIDGATOR_DAILY_CONFIRM_DB_WRITE !== "YES" ||
      environment.RAPIDGATOR_DAILY_EXPECTED_FOLDERS !== "7") {
    throw new Error("Live Rapidgator PM2 process is missing a required execution gate");
  }
  return environment;
}

function writeJsonAtomic(filePath, value) {
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporaryPath, JSON.stringify(value, null, 2) + "\n", {
    encoding: "utf8",
    flag: "wx",
  });
  fs.renameSync(temporaryPath, filePath);
}

function main() {
  const execute = process.argv.includes("--execute");
  const pm2HomeDir = process.env.PM2_HOME || path.join(os.homedir(), ".pm2");
  const dumpPath = path.join(pm2HomeDir, "dump.pm2");
  const saved = JSON.parse(fs.readFileSync(dumpPath, "utf8"));
  if (!Array.isArray(saved) || saved.some((entry) => entry.name === ACTIVE_ONCE_NAME)) {
    throw new Error(`Saved PM2 dump is invalid or already contains ${ACTIVE_ONCE_NAME}`);
  }

  const live = JSON.parse(execFileSync(process.execPath, [pm2CliScriptPath(), "jlist"], {
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 20 * 1024 * 1024,
  }));
  const matches = live.filter((entry) => entry.name === TARGET_NAME);
  if (matches.length !== 1) {
    throw new Error(`Expected one live ${TARGET_NAME} process, found ${matches.length}`);
  }
  const targetEnvironment = validateTarget(matches[0]);
  const result = [...saved.filter((entry) => entry.name !== TARGET_NAME), targetEnvironment];
  if (result.filter((entry) => entry.name === TARGET_NAME).length !== 1 ||
      result.some((entry) => entry.name === ACTIVE_ONCE_NAME)) {
    throw new Error("PM2 dump candidate failed the final process-name check");
  }

  const report = {
    mode: execute ? "execute" : "dry_run",
    dump_path: dumpPath,
    saved_processes_before: saved.length,
    target_already_saved: saved.some((entry) => entry.name === TARGET_NAME),
    saved_processes_after: result.length,
    target_name: TARGET_NAME,
    target_cron: targetEnvironment.cron_restart,
    active_once_saved: false,
  };

  if (execute) {
    const backupPath = `${dumpPath}.before-rapidgator-${timestamp()}`;
    fs.copyFileSync(dumpPath, backupPath, fs.constants.COPYFILE_EXCL);
    writeJsonAtomic(dumpPath, result);
    const verified = JSON.parse(fs.readFileSync(dumpPath, "utf8"));
    if (verified.filter((entry) => entry.name === TARGET_NAME).length !== 1 ||
        verified.some((entry) => entry.name === ACTIVE_ONCE_NAME)) {
      throw new Error("Saved PM2 dump verification failed");
    }
    report.backup_path = backupPath;
    report.verified = true;
  }

  process.stdout.write(JSON.stringify(report, null, 2) + "\n");
}

try {
  main();
} catch (error) {
  process.stderr.write(`Rapidgator PM2 save failed: ${error.message}\n`);
  process.exitCode = 1;
}
