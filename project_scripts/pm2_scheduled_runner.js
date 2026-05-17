const path = require("path");
const { spawn } = require("child_process");

function toInt(value, fallback) {
  const n = Number.parseInt(String(value || ""), 10);
  return Number.isFinite(n) ? n : fallback;
}

function isWithinWindow(now, hour, minute, windowMinutes) {
  const current = now.getHours() * 60 + now.getMinutes();
  const target = hour * 60 + minute;
  return current >= target && current < target + windowMinutes;
}

async function main() {
  const targetScript = process.env.SCHEDULE_TARGET_SCRIPT;
  const targetCwd = process.env.SCHEDULE_TARGET_CWD || process.cwd();
  const hour = toInt(process.env.SCHEDULE_HOUR, -1);
  const minute = toInt(process.env.SCHEDULE_MINUTE, 0);
  const windowMinutes = toInt(process.env.SCHEDULE_WINDOW_MINUTES, 10);
  const allowManual = process.env.SCHEDULE_RUN_NOW === "YES";
  const now = new Date();

  if (!targetScript) {
    throw new Error("SCHEDULE_TARGET_SCRIPT is required");
  }

  if (!allowManual && !isWithinWindow(now, hour, minute, windowMinutes)) {
    console.log(
      `skip scheduled runner: now=${now.toLocaleString()} target=${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`
    );
    return;
  }

  const resolvedScript = path.resolve(targetScript);
  console.log(`run scheduled script: ${resolvedScript}`);

  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [resolvedScript], {
      cwd: targetCwd,
      stdio: "inherit",
      windowsHide: true,
    });

    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`scheduled script failed: ${code}`));
    });
  });
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
