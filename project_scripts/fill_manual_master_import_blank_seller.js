const fs = require("fs");
const path = require("path");

const targetPath = path.resolve(process.argv[2] || "manual_master_import.csv");
const mode = process.argv.includes("--execute") ? "execute" : "dry-run";
const pendingName = "保留";

function main() {
  const original = fs.readFileSync(targetPath, "utf8");
  const newline = original.includes("\r\n") ? "\r\n" : "\n";
  const lines = original.split(/\r?\n/);
  let changed = 0;

  const updatedLines = lines.map((line, index) => {
    if (index === 0 || line === "") return line;
    if (line.endsWith(',""')) {
      changed += 1;
      return `${line.slice(0, -3)},"${pendingName}"`;
    }
    return line;
  });

  const updated = updatedLines.join(newline);
  const result = {
    file: targetPath,
    mode,
    rows: Math.max(0, lines.filter((line) => line !== "").length - 1),
    changed,
  };

  if (mode === "execute") {
    const timestamp = new Date().toISOString().replace(/[-:T.]/g, "").slice(0, 14);
    const backupPath = `${targetPath}.bak_blank_seller_line_${timestamp}`;
    fs.copyFileSync(targetPath, backupPath);
    fs.writeFileSync(targetPath, updated, "utf8");
    result.backup = backupPath;
  }

  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

main();
