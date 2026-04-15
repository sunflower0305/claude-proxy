import "dotenv/config";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import net from "node:net";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";

import {
  getProviderDefinitions,
  type ProviderDefinition,
} from "./lib/providers.ts";

const DEFAULT_PROXY_STARTUP_TIMEOUT_MS = 15_000;
const DEFAULT_COMMAND_TIMEOUT_MS = 90_000;
const PROMPT = "3+9=?";

type Outcome = "PASS" | "FAIL" | "SKIP";

interface CommandResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  elapsedMs: number;
}

interface ProviderTiming {
  switchWallTimeMs?: number;
  claudeWallTimeMs?: number;
  proxyTimeToHeadersMs?: number;
  proxyTimeToFirstTokenMs?: number;
  proxyTotalTimeMs?: number;
  proxyRequestId?: string;
  proxyTerminalPhase?: string;
}

interface ProviderRunResult {
  name: string;
  provider: string;
  model: string;
  outcome: Outcome;
  details: string;
  timing?: ProviderTiming;
  logDir?: string;
}

interface ProxyProcess {
  port: number;
  stdout: () => string;
  stderr: () => string;
  stop(): Promise<void>;
}

interface ProviderArtifactPaths {
  dir: string;
  curlStdout: string;
  curlStderr: string;
  claudeStdout: string;
  claudeStderr: string;
  resultJson: string;
}

interface ProxyTimingEvent {
  request_id?: string;
  provider?: string;
  requested_model?: string;
  target_model?: string;
  phase?: string;
  elapsed_ms?: number;
  stream?: boolean;
}

function logSection(title: string) {
  console.log(`\n== ${title} ==`);
}

function getTimeoutFromEnv(
  key: string,
  fallback: number
): number {
  const value = process.env[key]?.trim();
  if (!value) return fallback;

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function normalizeOutput(output: string): string {
  return output.replace(/\s+/g, " ").trim();
}

function summarizeOutput(output: string): string {
  const normalized = normalizeOutput(output);
  return normalized ? JSON.stringify(normalized.slice(0, 200)) : "(empty)";
}

function parseProxyTimingEvents(output: string): ProxyTimingEvent[] {
  return output
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("[ProxyTiming] "))
    .flatMap((line) => {
      try {
        return [JSON.parse(line.slice("[ProxyTiming] ".length)) as ProxyTimingEvent];
      } catch {
        return [];
      }
    });
}

function extractTiming(events: ProxyTimingEvent[]): ProviderTiming | undefined {
  const latestStart = [...events]
    .reverse()
    .find((event) => event.phase === "start" && event.request_id);

  if (!latestStart?.request_id) return undefined;

  const relevant = events.filter(
    (event) => event.request_id === latestStart.request_id
  );

  const findElapsed = (phase: string) =>
    relevant.find((event) => event.phase === phase)?.elapsed_ms;
  const terminal = [...relevant]
    .reverse()
    .find((event) =>
      ["completed", "client_aborted", "error"].includes(event.phase || "")
    );

  return {
    proxyRequestId: latestStart.request_id,
    proxyTimeToHeadersMs: findElapsed("upstream_headers"),
    proxyTimeToFirstTokenMs: findElapsed("first_chunk"),
    proxyTotalTimeMs: findElapsed("completed"),
    proxyTerminalPhase: terminal?.phase,
  };
}

function formatMissingDependency(binary: string) {
  return `${binary} not found in PATH`;
}

function sanitizeFileSegment(value: string) {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "-");
}

function buildRunId() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function getArtifactRoot(cwd: string, runId: string) {
  return path.join(cwd, ".artifacts", "provider-cli-e2e", runId);
}

function getProviderArtifactPaths(
  artifactRoot: string,
  provider: ProviderDefinition
): ProviderArtifactPaths {
  const dir = path.join(
    artifactRoot,
    `${provider.key}-${sanitizeFileSegment(provider.model)}`
  );

  return {
    dir,
    curlStdout: path.join(dir, "curl.stdout.log"),
    curlStderr: path.join(dir, "curl.stderr.log"),
    claudeStdout: path.join(dir, "claude.stdout.log"),
    claudeStderr: path.join(dir, "claude.stderr.log"),
    resultJson: path.join(dir, "result.json"),
  };
}

async function ensureDirectory(dir: string) {
  await mkdir(dir, { recursive: true });
}

async function writeArtifactFile(filePath: string, content: string) {
  await writeFile(filePath, content, "utf8");
}

async function writeProviderArtifacts(
  paths: ProviderArtifactPaths,
  result: ProviderRunResult,
  commandOutputs: {
    curlStdout?: string;
    curlStderr?: string;
    claudeStdout?: string;
    claudeStderr?: string;
    proxyStdout?: string;
    proxyStderr?: string;
  }
) {
  await ensureDirectory(paths.dir);

  await Promise.all([
    writeArtifactFile(paths.curlStdout, commandOutputs.curlStdout || ""),
    writeArtifactFile(paths.curlStderr, commandOutputs.curlStderr || ""),
    writeArtifactFile(paths.claudeStdout, commandOutputs.claudeStdout || ""),
    writeArtifactFile(paths.claudeStderr, commandOutputs.claudeStderr || ""),
    writeArtifactFile(
      path.join(paths.dir, "proxy.stdout.log"),
      commandOutputs.proxyStdout || ""
    ),
    writeArtifactFile(
      path.join(paths.dir, "proxy.stderr.log"),
      commandOutputs.proxyStderr || ""
    ),
    writeArtifactFile(paths.resultJson, JSON.stringify(result, null, 2)),
  ]);
}

function printSummary(results: ProviderRunResult[]) {
  logSection("Summary");

  if (results.length === 0) {
    console.log("No test cases were collected.");
    return;
  }

  for (const result of results) {
    console.log(
      `[${result.outcome}] ${result.name} (${result.provider}, ${result.model}) - ${result.details}${
        result.logDir ? ` | logs: ${result.logDir}` : ""
      }`
    );
  }

  const counts = results.reduce(
    (acc, result) => {
      acc[result.outcome] += 1;
      return acc;
    },
    { PASS: 0, FAIL: 0, SKIP: 0 }
  );

  console.log(
    `Totals: PASS=${counts.PASS} FAIL=${counts.FAIL} SKIP=${counts.SKIP}`
  );
}

async function findFreePort() {
  return new Promise<number>((resolve, reject) => {
    const server = net.createServer();

    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }

        if (!address || typeof address === "string") {
          reject(new Error("Failed to determine free port"));
          return;
        }

        resolve(address.port);
      });
    });
  });
}

async function runCommand(
  file: string,
  args: string[],
  options: {
    cwd: string;
    env?: NodeJS.ProcessEnv;
    timeoutMs?: number;
  }
): Promise<CommandResult> {
  const timeoutMs =
    options.timeoutMs ??
    getTimeoutFromEnv(
      "PROVIDER_CLI_E2E_COMMAND_TIMEOUT_MS",
      DEFAULT_COMMAND_TIMEOUT_MS
    );

  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const child = spawn(file, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 2_000).unref();
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });

    child.once("close", (exitCode, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        exitCode,
        signal,
        stdout,
        stderr,
        timedOut,
        elapsedMs: Date.now() - startedAt,
      });
    });
  });
}

async function waitForHealth(baseUrl: string, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  let lastError = "proxy did not respond";

  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) return;
      lastError = `health returned ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }

    await delay(250);
  }

  throw new Error(
    `Timed out waiting for proxy health after ${timeoutMs}ms: ${lastError}`
  );
}

async function startProxy(cwd: string): Promise<ProxyProcess> {
  const port = await findFreePort();
  const child = spawn(
    process.execPath,
    ["--experimental-strip-types", "src/proxy.ts"],
    {
      cwd,
      env: {
        ...process.env,
        PROXY_PORT: String(port),
      },
      stdio: ["ignore", "pipe", "pipe"],
    }
  );

  let stdout = "";
  let stderr = "";

  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });

  try {
    await waitForHealth(
      `http://127.0.0.1:${port}`,
      DEFAULT_PROXY_STARTUP_TIMEOUT_MS
    );
  } catch (error) {
    child.kill("SIGTERM");
    throw new Error(
      `Failed to start proxy on port ${port}: ${
        error instanceof Error ? error.message : String(error)
      }\nstdout:\n${stdout}\nstderr:\n${stderr}`
    );
  }

  return {
    port,
    stdout: () => stdout,
    stderr: () => stderr,
    async stop() {
      if (child.killed || child.exitCode !== null) return;

      child.kill("SIGTERM");

      await new Promise<void>((resolve) => {
        const killTimer = setTimeout(() => {
          child.kill("SIGKILL");
        }, 2_000);

        child.once("close", () => {
          clearTimeout(killTimer);
          resolve();
        });
      });
    },
  };
}

async function binaryExists(binary: string, cwd: string) {
  try {
    const result = await runCommand("which", [binary], {
      cwd,
      env: process.env,
      timeoutMs: 5_000,
    });
    return result.exitCode === 0;
  } catch {
    return false;
  }
}

async function switchProvider(
  cwd: string,
  baseUrl: string,
  provider: ProviderDefinition
): Promise<CommandResult> {
  const response = await runCommand(
    "curl",
    [
      "--silent",
      "--show-error",
      "--fail-with-body",
      "-X",
      "POST",
      `${baseUrl}/api/provider`,
      "-H",
      "Content-Type: application/json",
      "-d",
      JSON.stringify({ provider: provider.key }),
    ],
    {
      cwd,
      env: process.env,
    }
  );

  if (response.timedOut) {
    throw new Error("curl provider switch timed out");
  }

  if (response.exitCode !== 0) {
    throw new Error(
      `curl exited with code ${response.exitCode}, stderr=${summarizeOutput(response.stderr)}`
    );
  }

  let payload: any;
  try {
    payload = JSON.parse(response.stdout);
  } catch {
    throw new Error(`invalid JSON from provider switch: ${response.stdout}`);
  }

  if (
    payload?.success !== true ||
    payload?.provider !== provider.key ||
    payload?.model !== provider.model
  ) {
    throw new Error(`unexpected switch payload: ${response.stdout}`);
  }

  return response;
}

async function askClaudeViaProxy(
  cwd: string,
  baseUrl: string
): Promise<CommandResult> {
  return runCommand(
    "claude",
    ["--bare", "-p", PROMPT],
    {
      cwd,
      env: {
        ...process.env,
        ANTHROPIC_BASE_URL: baseUrl,
        ANTHROPIC_API_KEY: "any-string-works",
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      },
    }
  );
}

async function runProviderCase(
  cwd: string,
  baseUrl: string,
  provider: ProviderDefinition,
  proxy: ProxyProcess,
  artifactRoot: string
): Promise<ProviderRunResult> {
  const artifactPaths = getProviderArtifactPaths(artifactRoot, provider);
  const proxyStdoutBefore = proxy.stdout().length;
  const proxyStderrBefore = proxy.stderr().length;

  if (!provider.apiKey) {
    const result = {
      name: provider.name,
      provider: provider.key,
      model: provider.model,
      outcome: "SKIP",
      details: `missing API key (${provider.apiKeyEnv.join(" or ")})`,
      logDir: artifactPaths.dir,
    } satisfies ProviderRunResult;
    await writeProviderArtifacts(artifactPaths, result, {
      proxyStdout: proxy.stdout().slice(proxyStdoutBefore),
      proxyStderr: proxy.stderr().slice(proxyStderrBefore),
    });
    return result;
  }

  let switchResult: CommandResult | undefined;
  try {
    switchResult = await switchProvider(cwd, baseUrl, provider);
  } catch (error) {
    const result = {
      name: provider.name,
      provider: provider.key,
      model: provider.model,
      outcome: "FAIL",
      details: `provider switch failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
      logDir: artifactPaths.dir,
    } satisfies ProviderRunResult;
    await writeProviderArtifacts(artifactPaths, result, {
      curlStdout: switchResult?.stdout,
      curlStderr: switchResult?.stderr,
      proxyStdout: proxy.stdout().slice(proxyStdoutBefore),
      proxyStderr: proxy.stderr().slice(proxyStderrBefore),
    });
    return result;
  }

  let commandResult: CommandResult;
  try {
    commandResult = await askClaudeViaProxy(cwd, baseUrl);
  } catch (error) {
    const result = {
      name: provider.name,
      provider: provider.key,
      model: provider.model,
      outcome: "FAIL",
      details: `claude invocation failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
      logDir: artifactPaths.dir,
    } satisfies ProviderRunResult;
    await writeProviderArtifacts(artifactPaths, result, {
      curlStdout: switchResult?.stdout,
      curlStderr: switchResult?.stderr,
      proxyStdout: proxy.stdout().slice(proxyStdoutBefore),
      proxyStderr: proxy.stderr().slice(proxyStderrBefore),
    });
    return result;
  }

  const proxyStdoutDelta = proxy.stdout().slice(proxyStdoutBefore);
  const proxyStderrDelta = proxy.stderr().slice(proxyStderrBefore);
  const timing = extractTiming(parseProxyTimingEvents(proxyStdoutDelta));
  if (timing) {
    timing.switchWallTimeMs = switchResult?.elapsedMs;
    timing.claudeWallTimeMs = commandResult.elapsedMs;
  }

  let result: ProviderRunResult;
  if (commandResult.timedOut) {
    result = {
      name: provider.name,
      provider: provider.key,
      model: provider.model,
      outcome: "FAIL",
      details: `claude timed out, stdout=${summarizeOutput(
        commandResult.stdout
      )}, stderr=${summarizeOutput(commandResult.stderr)}`,
      timing: timing || {
        switchWallTimeMs: switchResult?.elapsedMs,
        claudeWallTimeMs: commandResult.elapsedMs,
      },
      logDir: artifactPaths.dir,
    };
  } else if (commandResult.exitCode !== 0) {
    result = {
      name: provider.name,
      provider: provider.key,
      model: provider.model,
      outcome: "FAIL",
      details: `claude exited with code ${
        commandResult.exitCode
      }, stdout=${summarizeOutput(commandResult.stdout)}, stderr=${summarizeOutput(
        commandResult.stderr
      )}`,
      timing: timing || {
        switchWallTimeMs: switchResult?.elapsedMs,
        claudeWallTimeMs: commandResult.elapsedMs,
      },
      logDir: artifactPaths.dir,
    };
  } else {
    const normalizedOutput = normalizeOutput(commandResult.stdout);
    if (!normalizedOutput.includes("12")) {
      result = {
        name: provider.name,
        provider: provider.key,
        model: provider.model,
        outcome: "FAIL",
        details: `unexpected output ${summarizeOutput(commandResult.stdout)}`,
        timing: timing || {
          switchWallTimeMs: switchResult?.elapsedMs,
          claudeWallTimeMs: commandResult.elapsedMs,
        },
        logDir: artifactPaths.dir,
      };
    } else {
      result = {
        name: provider.name,
        provider: provider.key,
        model: provider.model,
        outcome: "PASS",
        details: `output ${summarizeOutput(commandResult.stdout)}`,
        timing: timing || {
          switchWallTimeMs: switchResult?.elapsedMs,
          claudeWallTimeMs: commandResult.elapsedMs,
        },
        logDir: artifactPaths.dir,
      };
    }
  }

  await writeProviderArtifacts(artifactPaths, result, {
    curlStdout: switchResult?.stdout,
    curlStderr: switchResult?.stderr,
    claudeStdout: commandResult.stdout,
    claudeStderr: commandResult.stderr,
    proxyStdout: proxyStdoutDelta,
    proxyStderr: proxyStderrDelta,
  });

  return result;
}

async function writeRunSummary(
  artifactRoot: string,
  results: ProviderRunResult[],
  proxy?: ProxyProcess
) {
  await ensureDirectory(artifactRoot);
  await Promise.all([
    writeArtifactFile(
      path.join(artifactRoot, "summary.json"),
      JSON.stringify(results, null, 2)
    ),
    writeArtifactFile(
      path.join(artifactRoot, "proxy.stdout.log"),
      proxy?.stdout() || ""
    ),
    writeArtifactFile(
      path.join(artifactRoot, "proxy.stderr.log"),
      proxy?.stderr() || ""
    ),
  ]);
}

async function main() {
  const cwd = process.cwd();
  const providers = getProviderDefinitions();
  const results: ProviderRunResult[] = [];
  const runId = buildRunId();
  const artifactRoot = getArtifactRoot(cwd, runId);

  const missingBinaries: string[] = [];
  if (!(await binaryExists("curl", cwd))) {
    missingBinaries.push(formatMissingDependency("curl"));
  }
  if (!(await binaryExists("claude", cwd))) {
    missingBinaries.push(formatMissingDependency("claude"));
  }

  if (missingBinaries.length > 0) {
    for (const provider of providers) {
      results.push({
        name: provider.name,
        provider: provider.key,
        model: provider.model,
        outcome: "SKIP",
        details: missingBinaries.join("; "),
        logDir: getProviderArtifactPaths(artifactRoot, provider).dir,
      });
    }
    await writeRunSummary(artifactRoot, results);
    printSummary(results);
    console.log(`Artifacts written to ${artifactRoot}`);
    return;
  }

  logSection("Starting proxy");
  const proxy = await startProxy(cwd);
  const proxyBaseUrl = `http://127.0.0.1:${proxy.port}`;
  console.log(`Proxy ready at ${proxyBaseUrl}`);
  console.log(`Artifacts will be written to ${artifactRoot}`);

  try {
    for (const provider of providers) {
      logSection(`Provider ${provider.name}`);
      const result = await runProviderCase(
        cwd,
        proxyBaseUrl,
        provider,
        proxy,
        artifactRoot
      );
      results.push(result);
      console.log(
        `[${result.outcome}] ${result.name} (${result.provider}) - ${result.details} | logs: ${result.logDir}`
      );
    }
  } finally {
    await writeRunSummary(artifactRoot, results, proxy);
    await proxy.stop();
  }

  printSummary(results);
  console.log(`Artifacts written to ${artifactRoot}`);

  const hasFailures = results.some((result) => result.outcome === "FAIL");
  const ranAny = results.some((result) => result.outcome !== "SKIP");

  if (!ranAny) {
    console.log("No runnable providers were configured; all cases skipped.");
    return;
  }

  if (hasFailures) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error("CLI provider E2E runner failed:", error);
  process.exit(1);
});
