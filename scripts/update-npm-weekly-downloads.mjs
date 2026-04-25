import { mkdir, readFile, writeFile } from "node:fs/promises";

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const packageJsonUrl = new URL("../package.json", import.meta.url);
const outputUrl = new URL("../.github/badges/npm-weekly-downloads.json", import.meta.url);

function formatDate(date) {
  return date.toISOString().slice(0, 10);
}

function utcDateOnly(date) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

async function readPackageName() {
  const packageJson = JSON.parse(await readFile(packageJsonUrl, "utf8"));

  if (typeof packageJson.name !== "string" || packageJson.name.length === 0) {
    throw new Error("package.json is missing a package name");
  }

  return packageJson.name;
}

async function main() {
  const packageName = await readPackageName();
  const todayUtc = utcDateOnly(new Date());
  const endDate = new Date(todayUtc.getTime() - MS_PER_DAY);
  const startDate = new Date(endDate.getTime() - 6 * MS_PER_DAY);
  const start = formatDate(startDate);
  const end = formatDate(endDate);
  const encodedPackageName = encodeURIComponent(packageName);
  const downloadsUrl = `https://api.npmjs.org/downloads/point/${start}:${end}/${encodedPackageName}`;

  const response = await fetch(downloadsUrl, {
    headers: {
      Accept: "application/json",
      "User-Agent": "claude-proxy-badge-updater",
    },
  });

  if (!response.ok) {
    throw new Error(`npm downloads request failed: ${response.status} ${response.statusText}`);
  }

  const data = await response.json();

  if (typeof data.downloads !== "number") {
    throw new Error("npm downloads response is missing a numeric downloads value");
  }

  const badge = {
    schemaVersion: 1,
    label: "downloads",
    message: `${data.downloads}/week`,
    color: "brightgreen",
  };

  await mkdir(new URL(".", outputUrl), { recursive: true });
  await writeFile(outputUrl, `${JSON.stringify(badge, null, 2)}\n`);
  console.log(`Updated npm weekly downloads badge: ${badge.message} (${data.start ?? start}:${data.end ?? end})`);
}

await main();
