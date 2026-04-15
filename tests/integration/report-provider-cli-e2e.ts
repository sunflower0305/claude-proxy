import { readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

type Outcome = "PASS" | "FAIL" | "SKIP";

interface ProviderRunResult {
  name: string;
  provider: string;
  model: string;
  outcome: Outcome;
  details: string;
  timing?: {
    switchWallTimeMs?: number;
    claudeWallTimeMs?: number;
    proxyTimeToHeadersMs?: number;
    proxyTimeToFirstTokenMs?: number;
    proxyTotalTimeMs?: number;
    proxyRequestId?: string;
    proxyTerminalPhase?: string;
  };
  logDir?: string;
}

interface ProviderReportRow {
  result: ProviderRunResult;
  logDir: string;
  logs: Record<string, string>;
  metrics: {
    claudeStdoutBytes: number;
    claudeStderrBytes: number;
    proxyStdoutBytes: number;
    proxyStderrBytes: number;
    curlPayload?: string;
    proxyLastRequest?: string;
    firstTokenMs?: number;
    totalMs?: number;
    claudeWallTimeMs?: number;
  };
}

const ARTIFACTS_ROOT = ".artifacts/provider-cli-e2e";
const REPORT_FILENAME = "report.html";
const LOG_FILES = [
  "claude.stdout.log",
  "claude.stderr.log",
  "curl.stdout.log",
  "curl.stderr.log",
  "proxy.stdout.log",
  "proxy.stderr.log",
  "result.json",
] as const;

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

function formatMs(value?: number): string {
  if (value === undefined) return "n/a";
  if (value < 1000) return `${value} ms`;
  return `${(value / 1000).toFixed(2)} s`;
}

function summarizeText(value: string, maxLength = 160): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) return "(empty)";
  return normalized.length > maxLength
    ? `${normalized.slice(0, maxLength)}...`
    : normalized;
}

function relativeToCwd(target: string): string {
  return path.relative(process.cwd(), target) || ".";
}

async function exists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

async function readTextIfExists(target: string): Promise<string> {
  try {
    return await readFile(target, "utf8");
  } catch {
    return "";
  }
}

async function getLatestRunDir(root: string): Promise<string> {
  const entries = await readdir(root, { withFileTypes: true });
  const dirs = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

  const latest = dirs.at(-1);
  if (!latest) {
    throw new Error(`No run directories found under ${root}`);
  }

  return path.join(root, latest);
}

async function resolveRunDir(arg?: string): Promise<string> {
  if (arg) {
    const runDir = path.resolve(process.cwd(), arg);
    if (!(await exists(runDir))) {
      throw new Error(`Run directory does not exist: ${runDir}`);
    }
    return runDir;
  }

  const root = path.resolve(process.cwd(), ARTIFACTS_ROOT);
  if (!(await exists(root))) {
    throw new Error(`Artifacts root does not exist: ${root}`);
  }

  return getLatestRunDir(root);
}

function getOutcomeCounts(results: ProviderRunResult[]) {
  return results.reduce(
    (acc, result) => {
      acc[result.outcome] += 1;
      return acc;
    },
    { PASS: 0, FAIL: 0, SKIP: 0 }
  );
}

function extractProxyLastRequest(proxyStdout: string): string | undefined {
  const lines = proxyStdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  const lastRequest = [...lines]
    .reverse()
    .find((line) => /^\[\d{4}-\d{2}-\d{2}T/.test(line));

  return lastRequest;
}

function outcomeClass(outcome: Outcome): string {
  return outcome.toLowerCase();
}

async function loadProviderRows(results: ProviderRunResult[]): Promise<ProviderReportRow[]> {
  const rows: ProviderReportRow[] = [];

  for (const result of results) {
    const logDir = result.logDir || "";
    const logs = Object.fromEntries(
      await Promise.all(
        LOG_FILES.map(async (fileName) => [
          fileName,
          logDir ? await readTextIfExists(path.join(logDir, fileName)) : "",
        ])
      )
    ) as Record<string, string>;

    rows.push({
      result,
      logDir,
      logs,
      metrics: {
        claudeStdoutBytes: Buffer.byteLength(logs["claude.stdout.log"] || "", "utf8"),
        claudeStderrBytes: Buffer.byteLength(logs["claude.stderr.log"] || "", "utf8"),
        proxyStdoutBytes: Buffer.byteLength(logs["proxy.stdout.log"] || "", "utf8"),
        proxyStderrBytes: Buffer.byteLength(logs["proxy.stderr.log"] || "", "utf8"),
        curlPayload: summarizeText(logs["curl.stdout.log"] || ""),
        proxyLastRequest: extractProxyLastRequest(logs["proxy.stdout.log"] || ""),
        firstTokenMs: result.timing?.proxyTimeToFirstTokenMs,
        totalMs: result.timing?.proxyTotalTimeMs,
        claudeWallTimeMs: result.timing?.claudeWallTimeMs,
      },
    });
  }

  return rows;
}

function renderComparison(rows: ProviderReportRow[]): string {
  const comparable = rows.filter(
    (row) =>
      row.metrics.firstTokenMs !== undefined || row.metrics.totalMs !== undefined
  );

  const maxFirstToken = Math.max(
    ...comparable.map((row) => row.metrics.firstTokenMs || 0),
    0
  );
  const maxTotal = Math.max(
    ...comparable.map((row) => row.metrics.totalMs || 0),
    0
  );

  if (comparable.length === 0) {
    return `
      <section class="comparison-panel">
        <h2>Timing Comparison</h2>
        <p class="subtitle">No timing data found in this run. Re-run the latest e2e to populate first-token and total duration metrics.</p>
      </section>
    `;
  }

  return `
    <section class="comparison-panel">
      <h2>Timing Comparison</h2>
      <p class="subtitle">First token comes from proxy stream timing. Total time is proxy stream completion; Claude wall time is included for cross-checking.</p>
      <div class="comparison-table">
        ${comparable
          .map((row) => {
            const firstToken = row.metrics.firstTokenMs;
            const total = row.metrics.totalMs;
            const firstWidth =
              firstToken !== undefined && maxFirstToken > 0
                ? (firstToken / maxFirstToken) * 100
                : 0;
            const totalWidth =
              total !== undefined && maxTotal > 0 ? (total / maxTotal) * 100 : 0;

            return `
              <div class="comparison-row">
                <div class="comparison-label">
                  <strong>${escapeHtml(row.result.name)}</strong>
                  <span>${escapeHtml(row.result.provider)} / ${escapeHtml(row.result.model)}</span>
                </div>
                <div class="comparison-metric">
                  <span class="metric-name">First token</span>
                  <span class="metric-value">${escapeHtml(formatMs(firstToken))}</span>
                  <div class="bar-track"><div class="bar first-token" style="width:${firstWidth}%"></div></div>
                </div>
                <div class="comparison-metric">
                  <span class="metric-name">Total</span>
                  <span class="metric-value">${escapeHtml(formatMs(total))}</span>
                  <div class="bar-track"><div class="bar total" style="width:${totalWidth}%"></div></div>
                </div>
                <div class="comparison-metric compact">
                  <span class="metric-name">Claude wall</span>
                  <span class="metric-value">${escapeHtml(
                    formatMs(row.metrics.claudeWallTimeMs)
                  )}</span>
                </div>
              </div>
            `;
          })
          .join("\n")}
      </div>
    </section>
  `;
}

function renderLogBlock(title: string, content: string): string {
  return `
    <details class="log-block">
      <summary>${escapeHtml(title)} <span class="muted">(${escapeHtml(formatBytes(Buffer.byteLength(content, "utf8")))})</span></summary>
      <pre>${escapeHtml(content || "")}</pre>
    </details>
  `;
}

function renderRow(row: ProviderReportRow): string {
  const { result, logs, metrics } = row;
  const claudeStdoutSummary = summarizeText(logs["claude.stdout.log"] || "");
  const claudeStderrSummary = summarizeText(logs["claude.stderr.log"] || "");

  return `
    <section class="provider-card ${outcomeClass(result.outcome)}">
      <div class="provider-header">
        <div>
          <h2>${escapeHtml(result.name)}</h2>
          <p class="meta">${escapeHtml(result.provider)} / ${escapeHtml(result.model)}</p>
        </div>
        <span class="badge ${outcomeClass(result.outcome)}">${escapeHtml(result.outcome)}</span>
      </div>

      <p class="details">${escapeHtml(result.details)}</p>

      <div class="metrics">
        <div><strong>First token</strong><span>${escapeHtml(formatMs(metrics.firstTokenMs))}</span></div>
        <div><strong>Total complete</strong><span>${escapeHtml(formatMs(metrics.totalMs))}</span></div>
        <div><strong>Claude wall</strong><span>${escapeHtml(formatMs(metrics.claudeWallTimeMs))}</span></div>
        <div><strong>Claude stdout</strong><span>${escapeHtml(claudeStdoutSummary)}</span></div>
        <div><strong>Claude stderr</strong><span>${escapeHtml(claudeStderrSummary)}</span></div>
        <div><strong>curl payload</strong><span>${escapeHtml(metrics.curlPayload || "(empty)")}</span></div>
        <div><strong>Last proxy request</strong><span>${escapeHtml(metrics.proxyLastRequest || "(none)")}</span></div>
        <div><strong>Log dir</strong><span>${escapeHtml(relativeToCwd(row.logDir || ""))}</span></div>
      </div>

      <div class="log-grid">
        ${renderLogBlock("claude.stdout.log", logs["claude.stdout.log"] || "")}
        ${renderLogBlock("claude.stderr.log", logs["claude.stderr.log"] || "")}
        ${renderLogBlock("curl.stdout.log", logs["curl.stdout.log"] || "")}
        ${renderLogBlock("curl.stderr.log", logs["curl.stderr.log"] || "")}
        ${renderLogBlock("proxy.stdout.log", logs["proxy.stdout.log"] || "")}
        ${renderLogBlock("proxy.stderr.log", logs["proxy.stderr.log"] || "")}
        ${renderLogBlock("result.json", logs["result.json"] || "")}
      </div>
    </section>
  `;
}

function renderHtml(runDir: string, rows: ProviderReportRow[], summaryJson: string): string {
  const counts = getOutcomeCounts(rows.map((row) => row.result));
  const reportTitle = `Provider CLI E2E Report - ${path.basename(runDir)}`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(reportTitle)}</title>
  <style>
    :root {
      --bg: #f5f1e8;
      --panel: #fffdf8;
      --ink: #1f1d1a;
      --muted: #6d655a;
      --border: #d8cfc0;
      --pass: #245c3a;
      --pass-bg: #dff3e6;
      --fail: #8a2330;
      --fail-bg: #fde3e6;
      --skip: #8a6400;
      --skip-bg: #fff1c7;
      --first-token: #136f63;
      --total: #b25c16;
      --shadow: 0 14px 40px rgba(48, 35, 16, 0.08);
      --mono: "SFMono-Regular", "Menlo", "Consolas", monospace;
      --sans: "Iowan Old Style", "Palatino Linotype", "Book Antiqua", serif;
    }

    * { box-sizing: border-box; }
    body {
      margin: 0;
      background:
        radial-gradient(circle at top left, rgba(192, 135, 61, 0.18), transparent 28%),
        linear-gradient(180deg, #faf6ef 0%, var(--bg) 100%);
      color: var(--ink);
      font-family: var(--sans);
      line-height: 1.5;
    }

    main {
      max-width: 1180px;
      margin: 0 auto;
      padding: 40px 20px 80px;
    }

    .hero {
      background: rgba(255, 253, 248, 0.85);
      backdrop-filter: blur(8px);
      border: 1px solid var(--border);
      border-radius: 24px;
      padding: 28px;
      box-shadow: var(--shadow);
      margin-bottom: 24px;
    }

    h1, h2, h3, p { margin: 0; }
    h1 { font-size: clamp(32px, 4vw, 52px); line-height: 1.02; margin-bottom: 10px; }
    .subtitle { color: var(--muted); font-size: 16px; }
    .run-path { margin-top: 12px; font-family: var(--mono); font-size: 13px; color: var(--muted); word-break: break-all; }

    .summary-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
      gap: 14px;
      margin-top: 22px;
    }

    .summary-card {
      border-radius: 18px;
      padding: 16px;
      border: 1px solid var(--border);
      background: var(--panel);
    }

    .summary-card .label { display: block; color: var(--muted); font-size: 13px; margin-bottom: 6px; }
    .summary-card .value { display: block; font-size: 30px; font-weight: 700; }
    .summary-card.pass .value { color: var(--pass); }
    .summary-card.fail .value { color: var(--fail); }
    .summary-card.skip .value { color: var(--skip); }

    .provider-card {
      border-radius: 22px;
      border: 1px solid var(--border);
      background: rgba(255, 253, 248, 0.92);
      box-shadow: var(--shadow);
      padding: 22px;
      margin-top: 18px;
    }

    .provider-card.pass { border-left: 10px solid var(--pass); }
    .provider-card.fail { border-left: 10px solid var(--fail); }
    .provider-card.skip { border-left: 10px solid var(--skip); }

    .provider-header {
      display: flex;
      gap: 16px;
      justify-content: space-between;
      align-items: start;
      margin-bottom: 10px;
    }

    .meta, .muted { color: var(--muted); }
    .details { margin: 12px 0 16px; font-size: 17px; }

    .badge {
      border-radius: 999px;
      padding: 7px 12px;
      font-size: 12px;
      font-weight: 700;
      letter-spacing: 0.06em;
      text-transform: uppercase;
    }

    .badge.pass { background: var(--pass-bg); color: var(--pass); }
    .badge.fail { background: var(--fail-bg); color: var(--fail); }
    .badge.skip { background: var(--skip-bg); color: var(--skip); }

    .metrics {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(230px, 1fr));
      gap: 12px;
      margin-bottom: 18px;
    }

    .metrics div {
      border: 1px solid var(--border);
      border-radius: 14px;
      padding: 12px;
      background: #fff;
    }

    .metrics strong {
      display: block;
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      color: var(--muted);
      margin-bottom: 4px;
    }

    .comparison-panel {
      border-radius: 22px;
      border: 1px solid var(--border);
      background: rgba(255, 253, 248, 0.92);
      box-shadow: var(--shadow);
      padding: 22px;
      margin: 18px 0;
    }

    .comparison-table {
      display: grid;
      gap: 14px;
      margin-top: 16px;
    }

    .comparison-row {
      display: grid;
      grid-template-columns: minmax(180px, 1.2fr) minmax(220px, 1fr) minmax(220px, 1fr) minmax(130px, 0.6fr);
      gap: 14px;
      align-items: center;
      border: 1px solid var(--border);
      border-radius: 16px;
      padding: 14px;
      background: #fff;
    }

    .comparison-label strong, .comparison-label span, .comparison-metric span {
      display: block;
    }

    .comparison-label span, .metric-name { color: var(--muted); font-size: 12px; text-transform: uppercase; letter-spacing: 0.06em; }
    .metric-value { margin: 3px 0 8px; font-family: var(--mono); font-size: 15px; }
    .bar-track {
      height: 10px;
      border-radius: 999px;
      background: #ece4d7;
      overflow: hidden;
    }

    .bar {
      height: 100%;
      border-radius: 999px;
    }

    .bar.first-token { background: linear-gradient(90deg, #1d9a8b, var(--first-token)); }
    .bar.total { background: linear-gradient(90deg, #e79c53, var(--total)); }

    .log-grid {
      display: grid;
      grid-template-columns: 1fr;
      gap: 12px;
    }

    .log-block {
      border: 1px solid var(--border);
      border-radius: 14px;
      overflow: hidden;
      background: #fff;
    }

    .log-block summary {
      cursor: pointer;
      padding: 12px 14px;
      font-weight: 700;
      list-style: none;
      user-select: none;
      font-family: var(--mono);
      font-size: 13px;
      background: #f8f3ea;
    }

    .log-block summary::-webkit-details-marker { display: none; }
    .log-block pre {
      margin: 0;
      padding: 14px;
      overflow: auto;
      max-height: 420px;
      background: #fffdfa;
      font-family: var(--mono);
      font-size: 12px;
      line-height: 1.55;
      white-space: pre-wrap;
      word-break: break-word;
    }

    .raw-summary {
      margin-top: 24px;
      border-radius: 22px;
      border: 1px solid var(--border);
      background: rgba(255, 253, 248, 0.92);
      box-shadow: var(--shadow);
      padding: 22px;
    }

    @media (max-width: 700px) {
      main { padding: 24px 14px 50px; }
      .provider-header { flex-direction: column; }
    }
  </style>
</head>
<body>
  <main>
    <section class="hero">
      <h1>Provider CLI E2E Report</h1>
      <p class="subtitle">Offline HTML analysis for persisted test artifacts.</p>
      <p class="run-path">Run directory: ${escapeHtml(runDir)}</p>

      <div class="summary-grid">
        <div class="summary-card">
          <span class="label">Providers</span>
          <span class="value">${rows.length}</span>
        </div>
        <div class="summary-card pass">
          <span class="label">Pass</span>
          <span class="value">${counts.PASS}</span>
        </div>
        <div class="summary-card fail">
          <span class="label">Fail</span>
          <span class="value">${counts.FAIL}</span>
        </div>
        <div class="summary-card skip">
          <span class="label">Skip</span>
          <span class="value">${counts.SKIP}</span>
        </div>
      </div>
    </section>

    ${renderComparison(rows)}

    ${rows.map(renderRow).join("\n")}

    <section class="raw-summary">
      <h2>summary.json</h2>
      <p class="subtitle">Raw machine-readable result set captured for this run.</p>
      <pre>${escapeHtml(summaryJson)}</pre>
    </section>
  </main>
</body>
</html>`;
}

async function main() {
  const runDir = await resolveRunDir(process.argv[2]);
  const summaryPath = path.join(runDir, "summary.json");
  const summaryJson = await readFile(summaryPath, "utf8");
  const results = JSON.parse(summaryJson) as ProviderRunResult[];
  const rows = await loadProviderRows(results);
  const outputPath = path.join(runDir, REPORT_FILENAME);
  const html = renderHtml(runDir, rows, summaryJson);

  await writeFile(outputPath, html, "utf8");

  console.log(`HTML report written to ${outputPath}`);
}

main().catch((error) => {
  console.error("Failed to generate HTML report:", error);
  process.exit(1);
});
