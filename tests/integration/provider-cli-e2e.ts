import "dotenv/config";
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
}

interface ProviderRunResult {
  name: string;
  provider: string;
  model: string;
  outcome: Outcome;
  details: string;
}

interface ProxyProcess {
  port: number;
  stop(): Promise<void>;
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

function formatMissingDependency(binary: string) {
  return `${binary} not found in PATH`;
}

function printSummary(results: ProviderRunResult[]) {
  logSection("Summary");

  if (results.length === 0) {
    console.log("No test cases were collected.");
    return;
  }

  for (const result of results) {
    console.log(
      `[${result.outcome}] ${result.name} (${result.provider}, ${result.model}) - ${result.details}`
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
) {
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
  provider: ProviderDefinition
): Promise<ProviderRunResult> {
  if (!provider.apiKey) {
    return {
      name: provider.name,
      provider: provider.key,
      model: provider.model,
      outcome: "SKIP",
      details: `missing API key (${provider.apiKeyEnv.join(" or ")})`,
    };
  }

  try {
    await switchProvider(cwd, baseUrl, provider);
  } catch (error) {
    return {
      name: provider.name,
      provider: provider.key,
      model: provider.model,
      outcome: "FAIL",
      details: `provider switch failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }

  let commandResult: CommandResult;
  try {
    commandResult = await askClaudeViaProxy(cwd, baseUrl);
  } catch (error) {
    return {
      name: provider.name,
      provider: provider.key,
      model: provider.model,
      outcome: "FAIL",
      details: `claude invocation failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }

  if (commandResult.timedOut) {
    return {
      name: provider.name,
      provider: provider.key,
      model: provider.model,
      outcome: "FAIL",
      details: `claude timed out, stderr=${summarizeOutput(commandResult.stderr)}`,
    };
  }

  if (commandResult.exitCode !== 0) {
    return {
      name: provider.name,
      provider: provider.key,
      model: provider.model,
      outcome: "FAIL",
      details: `claude exited with code ${commandResult.exitCode}, stderr=${summarizeOutput(
        commandResult.stderr
      )}`,
    };
  }

  const normalizedOutput = normalizeOutput(commandResult.stdout);
  if (!normalizedOutput.includes("12")) {
    return {
      name: provider.name,
      provider: provider.key,
      model: provider.model,
      outcome: "FAIL",
      details: `unexpected output ${summarizeOutput(commandResult.stdout)}`,
    };
  }

  return {
    name: provider.name,
    provider: provider.key,
    model: provider.model,
    outcome: "PASS",
    details: `output ${summarizeOutput(commandResult.stdout)}`,
  };
}

async function main() {
  const cwd = process.cwd();
  const providers = getProviderDefinitions();
  const results: ProviderRunResult[] = [];

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
      });
    }
    printSummary(results);
    return;
  }

  logSection("Starting proxy");
  const proxy = await startProxy(cwd);
  const proxyBaseUrl = `http://127.0.0.1:${proxy.port}`;
  console.log(`Proxy ready at ${proxyBaseUrl}`);

  try {
    for (const provider of providers) {
      logSection(`Provider ${provider.name}`);
      const result = await runProviderCase(cwd, proxyBaseUrl, provider);
      results.push(result);
      console.log(
        `[${result.outcome}] ${result.name} (${result.provider}) - ${result.details}`
      );
    }
  } finally {
    await proxy.stop();
  }

  printSummary(results);

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
