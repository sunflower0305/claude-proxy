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

export interface CaptureSession {
  setResponse(status: number, headers: Headers): void;
  append(chunk: Uint8Array | string): void;
  complete(): void;
  fail(error: unknown, extra?: Pick<CaptureResponse, "aborted">): void;
}

export interface CaptureStore {
  begin(input: CaptureStart): CaptureSession;
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
  return { ...headers };
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

class FileCaptureSession implements CaptureSession {
  private readonly chunks: Buffer[] = [];
  private readonly response: Partial<CaptureResponse> = {};
  private firstByteAt: number | undefined;
  private settled = false;

  constructor(
    private readonly entry: CaptureEntry,
    private readonly filePath: string,
    private readonly redact: boolean,
  ) {}

  setResponse(status: number, headers: Headers): void {
    if (this.settled) return;
    this.response.status = status;
    this.response.headers = redactHeaders(Object.fromEntries(headers.entries()), this.redact);
  }

  append(chunk: Uint8Array | string): void {
    if (this.settled) return;
    if (this.firstByteAt === undefined) this.firstByteAt = Date.now();
    this.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  complete(): void {
    this.finish();
  }

  fail(error: unknown, extra: Pick<CaptureResponse, "aborted"> = {}): void {
    this.finish({
      ...extra,
      error: errorMessage(error),
    });
  }

  private finish(extra: Partial<CaptureResponse> = {}): void {
    if (this.settled) return;
    this.settled = true;

    const includeBody =
      this.response.status !== undefined || this.chunks.length > 0 || extra.aborted === true;
    const raw = includeBody ? Buffer.concat(this.chunks) : undefined;

    this.entry.response = {
      ...this.response,
      ...(raw && { raw: raw.toString("utf8"), bytes: raw.byteLength }),
      ...(this.firstByteAt !== undefined && { firstByteAt: this.firstByteAt }),
      ...extra,
      finishedAt: Date.now(),
    };

    try {
      mkdirSync(path.dirname(this.filePath), { recursive: true });
      writeFileSync(this.filePath, `${JSON.stringify(this.entry, null, 2)}\n`);
    } catch (error) {
      console.warn("[CaptureStore] Failed to persist capture:", errorMessage(error));
    }
  }
}

class FileCaptureStore implements CaptureStore {
  private readonly sessionId = localTimestamp();
  private readonly sessionDir: string;
  private seq = 0;

  constructor(private readonly options: CaptureStoreOptions) {
    this.sessionDir = path.join(options.root, this.sessionId);
  }

  begin(input: CaptureStart): CaptureSession {
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
        headers: redactHeaders(input.request.headers, this.options.redact),
      },
      response: null,
    };

    return new FileCaptureSession(
      entry,
      path.join(this.sessionDir, `${padSeq(seq)}.json`),
      this.options.redact,
    );
  }
}

const disabledCaptureSession: CaptureSession = {
  setResponse: () => {},
  append: () => {},
  complete: () => {},
  fail: () => {},
};

const disabledCaptureStore: CaptureStore = {
  begin: () => disabledCaptureSession,
};

export function createCaptureStoreFromEnv(env: NodeJS.ProcessEnv = process.env): CaptureStore {
  if (!isEnabled(env.CLAUDE_PROXY_LOG)) return disabledCaptureStore;

  try {
    return new FileCaptureStore({
      root: path.resolve(env.CLAUDE_PROXY_LOG_DIR || ".claude-proxy/sessions"),
      redact: !isRedactionDisabled(env.CLAUDE_PROXY_REDACT),
    });
  } catch (error) {
    console.warn("[CaptureStore] Failed to initialize capture store:", errorMessage(error));
    return disabledCaptureStore;
  }
}
