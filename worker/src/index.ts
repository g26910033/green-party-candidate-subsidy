const MAX_BODY_BYTES = 64 * 1024;
const MAX_LEDGER_ITEMS = 80;
const MAX_AMOUNT = 100_000_000;

type LedgerItem = {
  id: string;
  name: string;
  amount: number;
  note: string;
};

type Candidate = {
  id: string;
  name: string;
  role: string;
  depositCap: number;
  depositAid: number;
  ratio: number;
  donation: number;
  limit: number;
};

type AppState = {
  income: LedgerItem[];
  expenses: LedgerItem[];
  candidates: Candidate[];
  updatedAt: string | null;
};

type StateRow = {
  data: string;
  revision: number;
  updated_at: string;
};

const CANDIDATE_SPECS = [
  { id: "gan", name: "甘崇緯", role: "市議員", depositCap: 160_000, limit: 500_000 },
  { id: "wang", name: "王振庭", role: "市議員", depositCap: 160_000, limit: 500_000 },
  { id: "chang", name: "張佑輔", role: "市議員", depositCap: 160_000, limit: 500_000 },
  { id: "you", name: "游子昂", role: "市民代表", depositCap: 30_000, limit: 100_000 },
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cleanString(value: unknown, maxLength: number): string {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

function cleanNumber(value: unknown, maximum = MAX_AMOUNT, decimals = 0): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  const bounded = Math.min(maximum, Math.max(0, value));
  const factor = 10 ** decimals;
  return Math.round(bounded * factor) / factor;
}

function sanitizeLedger(value: unknown): LedgerItem[] | null {
  if (!Array.isArray(value) || value.length > MAX_LEDGER_ITEMS) return null;
  const seen = new Set<string>();
  const items: LedgerItem[] = [];

  for (const rawItem of value) {
    if (!isRecord(rawItem)) return null;
    const id = cleanString(rawItem.id, 100);
    const name = cleanString(rawItem.name, 160);
    if (!id || !name || seen.has(id)) return null;
    seen.add(id);
    items.push({
      id,
      name,
      amount: cleanNumber(rawItem.amount),
      note: cleanString(rawItem.note, 500),
    });
  }
  return items;
}

function sanitizeCandidates(value: unknown): Candidate[] | null {
  if (!Array.isArray(value)) return null;

  const incoming = new Map<string, Record<string, unknown>>();
  for (const rawCandidate of value) {
    if (!isRecord(rawCandidate)) return null;
    const id = cleanString(rawCandidate.id, 30);
    if (!id || incoming.has(id)) return null;
    incoming.set(id, rawCandidate);
  }

  const candidates: Candidate[] = [];
  for (const spec of CANDIDATE_SPECS) {
    const rawCandidate = incoming.get(spec.id);
    if (!rawCandidate) return null;
    candidates.push({
      ...spec,
      depositAid: cleanNumber(rawCandidate.depositAid, spec.depositCap),
      ratio: cleanNumber(rawCandidate.ratio, 100, 2),
      donation: cleanNumber(rawCandidate.donation),
    });
  }
  return candidates;
}

function sanitizeState(value: unknown): AppState | null {
  if (!isRecord(value)) return null;
  const income = sanitizeLedger(value.income);
  const expenses = sanitizeLedger(value.expenses);
  const candidates = sanitizeCandidates(value.candidates);
  if (!income || !expenses || !candidates) return null;
  return { income, expenses, candidates, updatedAt: null };
}

function allowedOrigin(request: Request, env: Env): string | null {
  const origin = request.headers.get("Origin");
  if (!origin) return null;
  const allowed = env.ALLOWED_ORIGINS.split(",").map((item) => item.trim());
  return allowed.includes(origin) ? origin : null;
}

function responseHeaders(request: Request, env: Env): Headers {
  const headers = new Headers({
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
    "X-Content-Type-Options": "nosniff",
  });
  const origin = allowedOrigin(request, env);
  if (origin) {
    headers.set("Access-Control-Allow-Origin", origin);
    headers.set("Vary", "Origin");
  }
  return headers;
}

function json(request: Request, env: Env, body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: responseHeaders(request, env),
  });
}

async function secureEqual(left: string, right: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const [leftHash, rightHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(left)),
    crypto.subtle.digest("SHA-256", encoder.encode(right)),
  ]);
  return crypto.subtle.timingSafeEqual(leftHash, rightHash);
}

async function readLimitedBody(request: Request): Promise<string> {
  if (!request.body) return "";
  const declaredLength = Number(request.headers.get("Content-Length") || 0);
  if (declaredLength > MAX_BODY_BYTES) throw new Error("BODY_TOO_LARGE");

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalLength = 0;

  while (true) {
    const result = await reader.read();
    if (result.done) break;
    totalLength += result.value.byteLength;
    if (totalLength > MAX_BODY_BYTES) {
      await reader.cancel();
      throw new Error("BODY_TOO_LARGE");
    }
    chunks.push(result.value);
  }

  const combined = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(combined);
}

async function getState(request: Request, env: Env): Promise<Response> {
  const row = await env.DB
    .prepare("SELECT data, revision, updated_at FROM app_state WHERE id = 1")
    .first<StateRow>();

  if (!row) {
    return json(request, env, { data: null, revision: 0, updatedAt: null });
  }

  try {
    const parsed: unknown = JSON.parse(row.data);
    const data = sanitizeState(parsed);
    if (!data) throw new Error("INVALID_STORED_STATE");
    data.updatedAt = row.updated_at;
    return json(request, env, { data, revision: row.revision, updatedAt: row.updated_at });
  } catch (error) {
    console.error(JSON.stringify({ event: "state_parse_failed", message: error instanceof Error ? error.message : "unknown" }));
    return json(request, env, { error: "共享資料格式錯誤" }, 500);
  }
}

async function putState(request: Request, env: Env): Promise<Response> {
  const origin = request.headers.get("Origin");
  if (origin && !allowedOrigin(request, env)) {
    return json(request, env, { error: "不允許的來源" }, 403);
  }

  const authorization = request.headers.get("Authorization") || "";
  const providedToken = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
  if (!providedToken || !env.EDITOR_TOKEN || !(await secureEqual(providedToken, env.EDITOR_TOKEN))) {
    return json(request, env, { error: "編輯連結無效" }, 401);
  }

  let payload: unknown;
  try {
    payload = JSON.parse(await readLimitedBody(request));
  } catch (error) {
    const tooLarge = error instanceof Error && error.message === "BODY_TOO_LARGE";
    return json(request, env, { error: tooLarge ? "資料超過大小限制" : "資料格式錯誤" }, tooLarge ? 413 : 400);
  }

  if (!isRecord(payload) || !Number.isInteger(payload.revision) || Number(payload.revision) < 0) {
    return json(request, env, { error: "缺少正確的資料版本" }, 400);
  }
  const state = sanitizeState(payload.data);
  if (!state) {
    return json(request, env, { error: "資料欄位不完整" }, 400);
  }

  const expectedRevision = Number(payload.revision);
  const nextRevision = expectedRevision + 1;
  const updatedAt = new Date().toISOString();
  state.updatedAt = updatedAt;
  const serialized = JSON.stringify(state);

  const result = expectedRevision === 0
    ? await env.DB
      .prepare("INSERT INTO app_state (id, data, revision, updated_at) VALUES (1, ?, 1, ?) ON CONFLICT(id) DO NOTHING")
      .bind(serialized, updatedAt)
      .run()
    : await env.DB
      .prepare("UPDATE app_state SET data = ?, revision = revision + 1, updated_at = ? WHERE id = 1 AND revision = ?")
      .bind(serialized, updatedAt, expectedRevision)
      .run();

  if (result.meta.changes !== 1) {
    return json(request, env, { error: "資料已被其他人更新，請重新載入", conflict: true }, 409);
  }

  console.log(JSON.stringify({ event: "state_saved", revision: nextRevision, updatedAt }));
  return json(request, env, { data: state, revision: nextRevision, updatedAt });
}

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      const origin = allowedOrigin(request, env);
      if (!origin) return json(request, env, { error: "不允許的來源" }, 403);
      const headers = responseHeaders(request, env);
      headers.set("Access-Control-Allow-Headers", "Authorization, Content-Type");
      headers.set("Access-Control-Allow-Methods", "GET, PUT, OPTIONS");
      headers.set("Access-Control-Max-Age", "86400");
      return new Response(null, { status: 204, headers });
    }

    if (url.pathname === "/health" && request.method === "GET") {
      return json(request, env, { ok: true });
    }
    if (url.pathname !== "/state") {
      return json(request, env, { error: "找不到此端點" }, 404);
    }
    if (request.method === "GET") return getState(request, env);
    if (request.method === "PUT") return putState(request, env);
    return json(request, env, { error: "不支援的請求方式" }, 405);
  },
} satisfies ExportedHandler<Env>;
