import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

type HeaderValue = string | string[] | number | undefined;

export interface CaptureRequest {
  method: string;
  url: string;
  headers: Record<string, HeaderValue>;
  body: unknown;
}

export interface CaptureResponse {
  status?: number;
  headers?: Record<string, HeaderValue>;
  raw?: string;
  bytes?: number;
  firstByteAt?: number;
  finishedAt: number;
  error?: string;
  aborted?: boolean;
}

export interface CaptureEntry {
  id: string;
  session: string;
  seq: number;
  ts: number;
  provider: string;
  requestedModel: string;
  targetModel: string;
  stream: boolean;
  startedAt: number;
  request: CaptureRequest;
  response: CaptureResponse | null;
}

export interface CaptureStart {
  provider: string;
  requestedModel: string;
  targetModel: string;
  stream: boolean;
  request: CaptureRequest;
  startedAt?: number;
}

interface CaptureStoreOptions {
  root: string;
  redact: boolean;
}

export interface CaptureStore {
  readonly enabled: boolean;
  readonly root?: string;
  readonly sessionId?: string;
  begin(input: CaptureStart): CaptureEntry | null;
  complete(entry: CaptureEntry | null, response: CaptureResponse): void;
  fail(entry: CaptureEntry | null, error: unknown, extra?: Partial<CaptureResponse>): void;
}

const SENSITIVE_HEADERS = new Set(["authorization", "x-api-key"]);

function isEnabled(value: string | undefined): boolean {
  if (!value) return false;
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

function isRedactionDisabled(value: string | undefined): boolean {
  if (!value) return false;
  return ["0", "false", "no", "off"].includes(value.trim().toLowerCase());
}

function localTimestamp(ms = Date.now()): string {
  const date = new Date(ms);
  const pad = (value: number, width = 2) => String(value).padStart(width, "0");
  return [
    date.getFullYear(),
    "-",
    pad(date.getMonth() + 1),
    "-",
    pad(date.getDate()),
    "T",
    pad(date.getHours()),
    "-",
    pad(date.getMinutes()),
    "-",
    pad(date.getSeconds()),
    "-",
    pad(date.getMilliseconds(), 3),
  ].join("");
}

function padSeq(seq: number): string {
  return String(seq).padStart(4, "0");
}

function normalizeHeaders(headers: Record<string, HeaderValue> | undefined) {
  return { ...(headers ?? {}) };
}

function redactHeaders(headers: Record<string, HeaderValue>, redact: boolean) {
  const normalized = normalizeHeaders(headers);
  if (!redact) return normalized;

  for (const key of Object.keys(normalized)) {
    if (SENSITIVE_HEADERS.has(key.toLowerCase())) {
      normalized[key] = "[REDACTED]";
    }
  }

  return normalized;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

class FileCaptureStore implements CaptureStore {
  readonly enabled = true;
  readonly root: string;
  readonly sessionId: string;
  private readonly sessionDir: string;
  private readonly redact: boolean;
  private seq = 0;

  constructor(options: CaptureStoreOptions) {
    this.root = options.root;
    this.redact = options.redact;
    this.sessionId = localTimestamp();
    this.sessionDir = path.join(this.root, this.sessionId);
  }

  begin(input: CaptureStart): CaptureEntry | null {
    const seq = ++this.seq;
    const startedAt = input.startedAt ?? Date.now();
    const entry: CaptureEntry = {
      id: `${this.sessionId}/${padSeq(seq)}`,
      session: this.sessionId,
      seq,
      ts: startedAt,
      provider: input.provider,
      requestedModel: input.requestedModel,
      targetModel: input.targetModel,
      stream: input.stream,
      startedAt,
      request: {
        ...input.request,
        headers: redactHeaders(input.request.headers, this.redact),
      },
      response: null,
    };

    this.persist(entry);
    return entry;
  }

  complete(entry: CaptureEntry | null, response: CaptureResponse): void {
    if (!entry) return;
    entry.response = {
      ...response,
      headers: redactHeaders(response.headers ?? {}, this.redact),
    };
    this.persist(entry);
  }

  fail(entry: CaptureEntry | null, error: unknown, extra: Partial<CaptureResponse> = {}): void {
    if (!entry) return;
    this.complete(entry, {
      ...extra,
      error: errorMessage(error),
      finishedAt: extra.finishedAt ?? Date.now(),
    });
  }

  private persist(entry: CaptureEntry): void {
    try {
      mkdirSync(this.sessionDir, { recursive: true });
      writeFileSync(
        path.join(this.sessionDir, `${padSeq(entry.seq)}.json`),
        `${JSON.stringify(entry, null, 2)}\n`,
      );
    } catch (error) {
      console.warn("[CaptureStore] Failed to persist capture:", errorMessage(error));
    }
  }
}

const disabledCaptureStore: CaptureStore = {
  enabled: false,
  begin: () => null,
  complete: () => {},
  fail: () => {},
};

export function createCaptureStoreFromEnv(env: NodeJS.ProcessEnv = process.env): CaptureStore {
  if (!isEnabled(env.CLAUDE_PROXY_LOG)) return disabledCaptureStore;

  const root = path.resolve(env.CLAUDE_PROXY_LOG_DIR || ".claude-proxy/sessions");
  const redact = !isRedactionDisabled(env.CLAUDE_PROXY_REDACT);

  try {
    return new FileCaptureStore({ root, redact });
  } catch (error) {
    console.warn("[CaptureStore] Failed to initialize capture store:", errorMessage(error));
    return disabledCaptureStore;
  }
}
