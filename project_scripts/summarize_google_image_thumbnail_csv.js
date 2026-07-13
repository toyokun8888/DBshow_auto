const fs = require("fs");

const csvPath = process.argv[2];
if (!csvPath) {
  process.stderr.write("Usage: node project_scripts/summarize_google_image_thumbnail_csv.js <csv>\n");
  process.exit(1);
}

const rows = readCsv(csvPath);
const statusCounts = countBy(rows, "status");
const dbWriteCounts = countBy(rows, "db_write_status");

process.stdout.write(
  `${JSON.stringify(
    {
      rows: rows.length,
      status: statusCounts,
      db_write_status: dbWriteCounts,
    },
    null,
    2
  )}\n`
);

function countBy(rows, column) {
  const counts = {};
  for (const row of rows) {
    const key = row[column] || "";
    counts[key] = (counts[key] || 0) + 1;
  }
  return counts;
}

function readCsv(path) {
  const text = fs.readFileSync(path, "utf8");
  const lines = text.split(/\r?\n/).filter(Boolean);
  if (lines.length <= 1) return [];
  const headers = parseCsvLine(lines[0]);
  return lines.slice(1).map((line) => {
    const values = parseCsvLine(line);
    const row = {};
    headers.forEach((header, index) => {
      row[header] = values[index] || "";
    });
    return row;
  });
}

function parseCsvLine(line) {
  const out = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '"' && inQuotes && line[i + 1] === '"') {
      current += '"';
      i += 1;
    } else if (ch === '"') {
      inQuotes = !inQuotes;
    } else if (ch === "," && !inQuotes) {
      out.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  out.push(current);
  return out;
}
