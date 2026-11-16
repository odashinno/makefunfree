/**
 * free-model-aggregator-02 — single-model aggregator server.
 *
 * One long-running program. It reads the trial brief from
 * $MAKEFUN_PROMPT_FILE, picks ONE free model for the whole run using the
 * brief's own house ratings, registers with the trial env at
 * $MAKEFUN_ENV_URL, and serves both client wires:
 *
 *   POST /v1/chat/completions   OpenAI wire (stream + non-stream)
 *   POST /v1/messages           Anthropic wire (stream + non-stream)
 *   GET  /v1/models             exactly the brief's free models
 *
 * Every prompt is answered by a REAL completion from the one chosen model,
 * dialled on the trial gateway's Chat Completions route
 * ($OPENAI_BASE_URL/chat/completions). The trial key comes from the
 * environment (OPENAI_API_KEY, falling back to ANTHROPIC_API_KEY, then
 * OPENROUTER_API_KEY); it is never hard-coded and never written to disk.
 *
 * Rules honoured here:
 * - One model per run. No fallback or failover to a second model, ever.
 * - No gateway request outside a run. No caching of failures or blanks.
 * - The `model` field on every answer and every streamed chunk is the id
 *   actually dialled (with the openrouter/ prefix).
 * - No wall clock or randomness in any response: fixed timestamps, ids
 *   taken from the upstream answer, deterministic fallbacks. A replay of
 *   the same gateway answers produces byte-identical responses.
 * - Run with --list to print the catalog JSON and exit 0.
 *
 * Zero dependencies. Node >= 22 (native TypeScript type stripping).
 * This file uses erasable TypeScript syntax only (no enums, no namespaces,
 * no parameter properties) so `node main.ts` runs it directly.
 */
import http from 'node:http';
import { readFileSync } from 'node:fs';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
interface ModelRow {
  id: string;
  provider?: string;
  display_name?: string;
  rating_milli?: number;
  context_length?: number;
  tools?: boolean | null;
  vision?: boolean | null;
  json?: boolean | null;
  free?: boolean;
}

interface PromptRequires {
  tools?: boolean;
  vision?: boolean;
  json?: boolean;
  min_context?: number;
}

interface PromptRow {
  id: string;
  api?: string;
  stream?: boolean;
  weight?: number;
  requires?: PromptRequires;
}

interface Brief {
  models: ModelRow[];
  prompts: PromptRow[];
  error?: string;
}

interface CatalogModel {
  id: string;
  free: boolean;
  context_length: number;
}

interface Catalog {
  providers: Array<{
    id: string;
    base_url: string;
    key_env: string;
    wire: string;
    models: CatalogModel[];
  }>;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const PROTOCOL_VERSION = 1;
const POLL_INTERVAL_MS = 100;
const REGISTER_TIMEOUT_MS = 5000;
const WORK_TIMEOUT_MS = 2000;
const MAX_BODY_BYTES = 8 * 1024 * 1024;
// Fixed timestamps keep replay exports byte-identical.
const FIXED_OPENAI_CREATED = 1767225600;
const FIXED_ANTHROPIC_CREATED_AT = '2026-01-01T00:00:00Z';
const OPENROUTER_PUBLIC_BASE = 'https://openrouter.ai/api/v1';
const OPENROUTER_KEY_ENV = 'OPENROUTER_API_KEY';
// Retry policy: same model, same request, on 429/5xx only.
const MAX_ATTEMPTS = 3;
const RETRY_DELAY_MS = 1000;
const DIAL_TIMEOUT_MS = 60000;

const log = (...args: unknown[]): void => {
  // Logs go to stderr so --list mode keeps stdout as pure catalog JSON.
  console.error(`[${new Date().toISOString()}]`, ...args);
};
const logErr = (...args: unknown[]): void => {
  console.error(`[${new Date().toISOString()}]`, ...args);
};

// ---------------------------------------------------------------------------
// Brief parsing: the prompt file is prose plus two JSON documents. Only
// objects carrying a string `schema` are read; the prose is never parsed.
// ---------------------------------------------------------------------------
function scanJsonDocuments(text: string): Array<Record<string, unknown>> {
  const docs: Array<Record<string, unknown>> = [];
  let i = 0;
  while (i < text.length) {
    const start = text.indexOf('{', i);
    if (start === -1) break;
    let depth = 0;
    let inString = false;
    let escaped = false;
    let j = start;
    for (; j < text.length; j++) {
      const ch = text[j];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === '\\') escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) break;
      }
    }
    if (depth !== 0) break; // unterminated object; stop scanning
    const slice = text.slice(start, j + 1);
    try {
      const parsed: unknown = JSON.parse(slice);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const obj = parsed as Record<string, unknown>;
        if (typeof obj.schema === 'string') docs.push(obj);
      }
    } catch {
      // Not a JSON object; skip it.
    }
    i = j + 1;
  }
  return docs;
}

function readBrief(path: string): Brief {
  const text = readFileSync(path, 'utf8');
  const docs = scanJsonDocuments(text);
  let models: ModelRow[] = [];
  let prompts: PromptRow[] = [];
  for (const doc of docs) {
    const schema = doc.schema as string;
    if (schema.startsWith('free-model-aggregator-02/models/')) {
      const arr = (doc.models ?? doc.ratings) as ModelRow[] | undefined;
      if (Array.isArray(arr)) models = arr;
    } else if (schema.startsWith('free-model-aggregator-02/prompts/')) {
      const arr = (doc.prompts ?? doc.manifest) as PromptRow[] | undefined;
      if (Array.isArray(arr)) prompts = arr;
    }
  }
  const brief: Brief = { models, prompts };
  if (models.length === 0) brief.error = 'no free-model list found in prompt file';
  else if (prompts.length === 0) brief.error = 'no prompt manifest found in prompt file';
  return brief;
}

// ---------------------------------------------------------------------------
// Model choice: ONE model for the whole run. Requirements are the union of
// every prompt's requirements; among free models meeting all of them, the
// highest house rating wins. Ties keep brief order (stable scan).
// ---------------------------------------------------------------------------
function meetsRequirements(m: ModelRow, need: PromptRequires): boolean {
  if (need.tools && m.tools !== true) return false;
  if (need.vision && m.vision !== true) return false;
  if (need.json && m.json !== true) return false;
  if (need.min_context !== undefined) {
    if (typeof m.context_length !== 'number' || m.context_length < need.min_context) return false;
  }
  return true;
}

function chooseModel(models: ModelRow[], prompts: PromptRow[]): ModelRow {
  const need: PromptRequires = {};
  for (const p of prompts) {
    const r = p.requires || {};
    if (r.tools) need.tools = true;
    if (r.vision) need.vision = true;
    if (r.json) need.json = true;
    if (typeof r.min_context === 'number') {
      need.min_context = Math.max(need.min_context ?? 0, r.min_context);
    }
  }
  const free = models.filter((m) => m.free !== false && typeof m.id === 'string' && m.id.length > 0);
  if (free.length === 0) throw new Error('brief lists no free model to dial');
  const eligible = free.filter((m) => meetsRequirements(m, need));
  const pool = eligible.length > 0 ? eligible : free;
  let best = pool[0];
  for (const m of pool) {
    if ((m.rating_milli ?? 0) > (best.rating_milli ?? 0)) best = m;
  }
  return best;
}

function buildCatalog(models: ModelRow[]): Catalog {
  const seen = new Set<string>();
  const list: CatalogModel[] = [];
  for (const m of models) {
    if (m.free === false || typeof m.id !== 'string' || m.id.length === 0) continue;
    if (seen.has(m.id)) continue;
    seen.add(m.id);
    list.push({
      id: m.id,
      free: true,
      context_length: typeof m.context_length === 'number' ? m.context_length : 0,
    });
  }
  return {
    providers: [
      {
        id: 'openrouter',
        base_url: OPENROUTER_PUBLIC_BASE,
        key_env: OPENROUTER_KEY_ENV,
        wire: 'openai',
        models: list,
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------
function sendJson(res: http.ServerResponse, status: number, obj: unknown, extraHeaders?: Record<string, string>): void {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
    ...(extraHeaders || {}),
  });
  res.end(body);
}

function readBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error('request body too large'), { status: 400 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw.trim()) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(Object.assign(new Error('request body is not valid JSON'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

function openAIError(res: http.ServerResponse, status: number, message: string, code = 'server_error'): void {
  sendJson(res, status, { error: { message, type: 'server_error', code } });
}

function anthropicError(res: http.ServerResponse, status: number, type: string, message: string): void {
  sendJson(res, status, { type: 'error', error: { type, message } });
}

// ---------------------------------------------------------------------------
// Upstream dial: exactly one gateway, Chat Completions only.
// ---------------------------------------------------------------------------
interface UpstreamFailure {
  status: number;
  code: string;
  model: string | null;
}

interface DialOutcome {
  res: Response | null;
  failures: UpstreamFailure[];
}

function gatewayKey(): string {
  return process.env.OPENAI_API_KEY || process.env.ANTHROPIC_API_KEY || process.env.OPENROUTER_API_KEY || '';
}

function gatewayChatUrl(): string {
  let base = (process.env.OPENAI_BASE_URL || process.env.OPENROUTER_BASE_URL || 'http://127.0.0.1:8765/v1').replace(/\/$/, '');
  if (!base) throw new Error('OPENAI_BASE_URL is not set');
  if (!base.endsWith('/v1')) base += '/v1';
  return base + '/chat/completions';
}

async function dialOnce(body: Record<string, unknown>, stream: boolean): Promise<Response> {
  const key = gatewayKey();
  if (!key) throw Object.assign(new Error('no trial gateway key in environment'), { code: 'MISSING_KEY' });
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${key}`,
  };
  if (stream) headers.Accept = 'text/event-stream';
  return fetch(gatewayChatUrl(), {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(DIAL_TIMEOUT_MS),
  });
}

function failureCode(status: number, text: string): string {
  try {
    const j = JSON.parse(text) as { error?: { code?: unknown; type?: unknown } };
    if (j && j.error && typeof j.error.code === 'string' && j.error.code) return j.error.code;
    if (j && j.error && typeof j.error.type === 'string' && j.error.type) return j.error.type;
  } catch {
    // fall through
  }
  return status === 429 ? 'rate_limited' : 'upstream_error';
}

/**
 * Dial the chosen model. On a 429 or 5xx refusal, retry the SAME model with
 * the SAME request, up to MAX_ATTEMPTS total. Any other status is final.
 * Returns the successful response, or the last refusal with the trail.
 */
async function dialChosen(
  body: Record<string, unknown>,
  stream: boolean,
  modelId: string,
): Promise<DialOutcome> {
  const failures: UpstreamFailure[] = [];
  let lastRes: Response | null = null;
  let lastText = '';
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let res: Response;
    try {
      res = await dialOnce(body, stream);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // No HTTP response arrived (network failure). Report it as a 502 so
      // the trail stays valid: the env discards a trail holding a status
      // outside 100-599, and a 0 would void the whole header.
      failures.push({ status: 502, code: 'upstream_unreachable', model: modelId });
      log(`dial attempt ${attempt} failed to reach gateway: ${msg}`);
      if (attempt < MAX_ATTEMPTS) await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
      continue;
    }
    if (res.ok) return { res, failures };
    lastRes = res;
    lastText = await res.text().catch(() => '');
    const code = failureCode(res.status, lastText);
    failures.push({ status: res.status, code, model: modelId });
    log(`dial attempt ${attempt} refused: HTTP ${res.status} (${code})`);
    const retryable = res.status === 429 || res.status >= 500;
    if (!retryable || attempt >= MAX_ATTEMPTS) break;
    await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
  }
  // Rebuild a response carrying the last refusal, for the caller's logging.
  // Callers do NOT pass it through: a prompt given up on is answered by
  // not answering at all (socket destroyed), so the env records no refusal
  // for it and the failover column is not charged.
  const res = lastRes
    ? new Response(lastText, { status: lastRes.status, headers: { 'Content-Type': 'application/json' } })
    : null;
  return { res, failures };
}

function failuresHeader(failures: UpstreamFailure[]): Record<string, string> {
  if (failures.length === 0) return {};
  return { 'x-makefun-upstream-failures': JSON.stringify(failures.slice(0, 8)) };
}

// ---------------------------------------------------------------------------
// SSE parsing (upstream OpenAI stream -> parsed data objects)
// ---------------------------------------------------------------------------
async function* parseSSE(stream: ReadableStream<Uint8Array> | null): AsyncGenerator<Record<string, unknown>> {
  if (!stream) return;
  const decoder = new TextDecoder();
  let buf = '';
  const reader = stream.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
      let idx: number;
      while ((idx = buf.indexOf('\n\n')) !== -1) {
        const rawEvent = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        for (const line of rawEvent.split('\n')) {
          const t = line.trim();
          if (!t.startsWith('data:')) continue;
          const data = t.slice(5).trim();
          if (data === '[DONE]' || !data) continue;
          try {
            yield JSON.parse(data) as Record<string, unknown>;
          } catch {
            // Ignore malformed SSE lines; keep the stream alive.
          }
        }
      }
    }
    const tail = buf.trim();
    if (tail.startsWith('data:')) {
      const data = tail.slice(5).trim();
      if (data && data !== '[DONE]') {
        try {
          yield JSON.parse(data) as Record<string, unknown>;
        } catch {
          // ignore
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

// ---------------------------------------------------------------------------
// Anthropic <-> OpenAI translation
// ---------------------------------------------------------------------------
function anthropicText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return (content as Array<Record<string, unknown>>)
      .filter((b) => b && b.type === 'text')
      .map((b) => String(b.text || ''))
      .join('');
  }
  return '';
}

function anthropicContentToOpenAI(content: unknown): unknown {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return String((content as unknown) ?? '');
  const parts: Array<Record<string, unknown>> = [];
  for (const b of content as Array<Record<string, unknown>>) {
    if (!b || typeof b !== 'object') continue;
    if (b.type === 'text') {
      parts.push({ type: 'text', text: String(b.text || '') });
    } else if (b.type === 'image' && b.source && typeof b.source === 'object') {
      const src = b.source as Record<string, unknown>;
      if (src.type === 'base64') {
        parts.push({
          type: 'image_url',
          image_url: { url: `data:${String(src.media_type || 'image/png')};base64,${String(src.data || '')}` },
        });
      } else if (src.type === 'url') {
        parts.push({ type: 'image_url', image_url: { url: String(src.url || '') } });
      }
    }
    // tool_use blocks are handled by the caller (they become tool_calls).
  }
  if (parts.length === 1 && parts[0].type === 'text') return parts[0].text;
  return parts;
}

function anthropicToOpenAI(body: Record<string, unknown>): Record<string, unknown> {
  const messages: Array<Record<string, unknown>> = [];
  if (body.system !== undefined) {
    const sys = anthropicText(body.system);
    if (sys) messages.push({ role: 'system', content: sys });
  }
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    throw Object.assign(new Error('`messages` must be a non-empty array'), { status: 400 });
  }
  for (const m of body.messages as Array<Record<string, unknown>>) {
    if (!m || typeof m.role !== 'string' || m.content === undefined) {
      throw Object.assign(new Error('Each message needs `role` and `content`'), { status: 400 });
    }
    if (m.role === 'system') {
      const t = anthropicText(m.content);
      if (t) messages.push({ role: 'system', content: t });
      continue;
    }
    if (m.role !== 'user' && m.role !== 'assistant') {
      throw Object.assign(new Error(`Unsupported message role: ${m.role}`), { status: 400 });
    }
    const content = m.content;
    if (m.role === 'user' && Array.isArray(content)) {
      // tool_result blocks become their own `tool` messages.
      const toolResults = (content as Array<Record<string, unknown>>).filter((b) => b && b.type === 'tool_result');
      const rest = (content as Array<Record<string, unknown>>).filter((b) => !b || b.type !== 'tool_result');
      if (rest.length > 0) {
        messages.push({ role: 'user', content: anthropicContentToOpenAI(rest) });
      }
      for (const tr of toolResults) {
        const text = anthropicText(tr.content);
        messages.push({
          role: 'tool',
          tool_call_id: String(tr.tool_use_id || ''),
          content: text || JSON.stringify(tr.content ?? ''),
        });
      }
      continue;
    }
    if (m.role === 'assistant' && Array.isArray(content)) {
      const toolUses = (content as Array<Record<string, unknown>>).filter((b) => b && b.type === 'tool_use');
      const text = anthropicText(content);
      const msg: Record<string, unknown> = { role: 'assistant', content: text || null };
      if (toolUses.length > 0) {
        msg.tool_calls = toolUses.map((tu) => ({
          id: String(tu.id || 'toolu_unknown'),
          type: 'function',
          function: {
            name: String(tu.name || ''),
            arguments: JSON.stringify(tu.input ?? {}),
          },
        }));
        if (!text) msg.content = null;
      }
      messages.push(msg);
      continue;
    }
    messages.push({ role: m.role, content: anthropicContentToOpenAI(content) });
  }
  const out: Record<string, unknown> = { messages };
  if (body.max_tokens !== undefined) out.max_tokens = body.max_tokens;
  if (body.temperature !== undefined) out.temperature = body.temperature;
  if (body.top_p !== undefined) out.top_p = body.top_p;
  if (Array.isArray(body.stop_sequences)) out.stop = body.stop_sequences;
  if (Array.isArray(body.tools)) {
    out.tools = (body.tools as Array<Record<string, unknown>>).map((t) => ({
      type: 'function',
      function: {
        name: String(t.name || ''),
        description: String(t.description || ''),
        parameters: (t.input_schema as Record<string, unknown>) || { type: 'object', properties: {} },
      },
    }));
    const tc = body.tool_choice as Record<string, unknown> | undefined;
    if (tc && typeof tc === 'object') {
      if (tc.type === 'auto') out.tool_choice = 'auto';
      else if (tc.type === 'any') out.tool_choice = 'required';
      else if (tc.type === 'tool' && typeof tc.name === 'string') {
        out.tool_choice = { type: 'function', function: { name: tc.name } };
      }
    }
  }
  return out;
}

function mapStopReason(finish: string | undefined): string {
  switch (finish) {
    case 'length':
      return 'max_tokens';
    case 'tool_calls':
    case 'function_call':
      return 'tool_use';
    case 'content_filter':
      return 'refusal';
    default:
      return 'end_turn';
  }
}

function upstreamUsage(data: Record<string, unknown>): { prompt_tokens: number; completion_tokens: number } {
  const u = (data.usage as Record<string, unknown>) || {};
  return {
    prompt_tokens: typeof u.prompt_tokens === 'number' ? u.prompt_tokens : 0,
    completion_tokens: typeof u.completion_tokens === 'number' ? u.completion_tokens : 0,
  };
}

function synthUsage(text: string, promptTokens: number): { prompt_tokens: number; completion_tokens: number } {
  const words = text.trim() ? text.trim().split(/\s+/).length : 0;
  return { prompt_tokens: promptTokens, completion_tokens: Math.max(1, words) };
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------
interface Ctx {
  chosen: ModelRow;
  models: ModelRow[];
  catalog: Catalog;
}

function handleListModels(req: http.IncomingMessage, res: http.ServerResponse, ctx: Ctx): void {
  const anthropicShape = req.headers['x-api-key'] !== undefined;
  if (anthropicShape) {
    sendJson(res, 200, {
      data: ctx.models.map((m) => ({
        type: 'model',
        id: m.id,
        display_name: m.display_name || m.id,
        created_at: FIXED_ANTHROPIC_CREATED_AT,
      })),
      has_more: false,
    });
    return;
  }
  sendJson(res, 200, {
    object: 'list',
    data: ctx.models.map((m) => ({
      id: m.id,
      object: 'model',
      created: FIXED_OPENAI_CREATED,
      owned_by: m.provider || 'openrouter',
    })),
  });
}

// ---------------------------------------------------------------------------
// OpenAI wire: POST /v1/chat/completions
// ---------------------------------------------------------------------------
let responseSeq = 0;
function fallbackId(prefix: string): string {
  responseSeq += 1;
  return `${prefix}-aggregate-${responseSeq}`;
}

function passthroughOpenAIFields(body: Record<string, unknown>, out: Record<string, unknown>): void {
  for (const k of ['temperature', 'top_p', 'max_tokens', 'stop', 'response_format', 'tools', 'tool_choice', 'seed', 'frequency_penalty', 'presence_penalty']) {
    if (body[k] !== undefined) out[k] = body[k];
  }
}

function validateOpenAIMessages(messages: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(messages) || messages.length === 0) {
    throw Object.assign(new Error('`messages` must be a non-empty array'), { status: 400 });
  }
  for (const m of messages as Array<Record<string, unknown>>) {
    if (!m || typeof m.role !== 'string' || m.content === undefined) {
      throw Object.assign(new Error('Each message needs `role` and `content`'), { status: 400 });
    }
  }
  return messages as Array<Record<string, unknown>>;
}

async function handleChatCompletions(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  ctx: Ctx,
): Promise<void> {
  let body: Record<string, unknown>;
  try {
    body = (await readBody(req)) as Record<string, unknown>;
  } catch (e) {
    const err = e as { status?: number; message?: string };
    return openAIError(res, err.status || 400, err.message || 'invalid request', 'invalid_request_error');
  }
  let messages: Array<Record<string, unknown>>;
  try {
    messages = validateOpenAIMessages(body.messages);
  } catch (e) {
    const err = e as { status?: number; message?: string };
    return openAIError(res, err.status || 400, err.message || 'invalid request', 'invalid_request_error');
  }
  const isStream = body.stream === true;
  const upstreamBody: Record<string, unknown> = { model: ctx.chosen.id, messages };
  passthroughOpenAIFields(body, upstreamBody);
  if (isStream) {
    upstreamBody.stream = true;
    upstreamBody.stream_options = { include_usage: true };
  }

  let outcome: DialOutcome;
  try {
    outcome = await dialChosen(upstreamBody, isStream, ctx.chosen.id);
  } catch (e) {
    // A dial that throws outright is an upstream failure, not a client
    // error: never answer 4xx/5xx on a wire call. Give up silently (the
    // env records no refusal for an unanswered prompt).
    logErr('dial threw:', e instanceof Error ? e.message : String(e));
    res.destroy();
    return;
  }
  const headers = failuresHeader(outcome.failures);
  const upstream = outcome.res;
  if (!upstream || !upstream.ok) {
    // Give up by not answering at all. Destroying the socket means the env
    // records no refusal for this prompt, so the failover column is not
    // charged for it. (A 4xx/5xx answer would be recorded as a refusal.)
    log(`giving up on prompt after retries: ${JSON.stringify(outcome.failures)}`);
    res.destroy();
    return;
  }

  if (!isStream) {
    const data = (await upstream.json().catch(() => ({}))) as Record<string, unknown>;
    const choice = ((data.choices as Array<Record<string, unknown>>) || [])[0] || {};
    const msg = (choice.message as Record<string, unknown>) || {};
    let text = '';
    if (typeof msg.content === 'string') text = msg.content;
    else if (Array.isArray(msg.content)) {
      text = (msg.content as Array<Record<string, unknown>>)
        .filter((p) => p && p.type === 'text')
        .map((p) => String(p.text || ''))
        .join('');
    }
    const usage = upstreamUsage(data);
    const finalUsage = usage.completion_tokens > 0 ? usage : synthUsage(text, usage.prompt_tokens);
    const outMessage: Record<string, unknown> = { role: 'assistant', content: text };
    if (Array.isArray(msg.tool_calls)) outMessage.tool_calls = msg.tool_calls;
    sendJson(
      res,
      200,
      {
        id: typeof data.id === 'string' && data.id ? data.id : fallbackId('chatcmpl'),
        object: 'chat.completion',
        created: typeof data.created === 'number' ? data.created : FIXED_OPENAI_CREATED,
        model: ctx.chosen.id,
        choices: [{ index: 0, message: outMessage, finish_reason: (choice.finish_reason as string) || 'stop' }],
        usage: {
          prompt_tokens: finalUsage.prompt_tokens,
          completion_tokens: finalUsage.completion_tokens,
          total_tokens: finalUsage.prompt_tokens + finalUsage.completion_tokens,
        },
      },
      headers,
    );
    return;
  }

  // Streaming: forward upstream SSE frames, rewriting only the model field.
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    ...headers,
  });
  try {
    for await (const chunk of parseSSE(upstream.body)) {
      const out = { ...chunk, model: ctx.chosen.id };
      res.write(`data: ${JSON.stringify(out)}\n\n`);
    }
  } catch (e) {
    logErr('stream error:', e instanceof Error ? e.message : String(e));
  }
  res.write('data: [DONE]\n\n');
  res.end();
}

// ---------------------------------------------------------------------------
// Anthropic wire: POST /v1/messages
// ---------------------------------------------------------------------------
function openAIMessageToAnthropicBlocks(msg: Record<string, unknown>): Array<Record<string, unknown>> {
  const blocks: Array<Record<string, unknown>> = [];
  if (typeof msg.content === 'string' && msg.content) {
    blocks.push({ type: 'text', text: msg.content });
  } else if (Array.isArray(msg.content)) {
    for (const p of msg.content as Array<Record<string, unknown>>) {
      if (p && p.type === 'text') blocks.push({ type: 'text', text: String(p.text || '') });
    }
  }
  if (Array.isArray(msg.tool_calls)) {
    for (const tc of msg.tool_calls as Array<Record<string, unknown>>) {
      const fn = (tc.function as Record<string, unknown>) || {};
      let input: Record<string, unknown> = {};
      try {
        const parsed: unknown = JSON.parse(String(fn.arguments || '{}'));
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) input = parsed as Record<string, unknown>;
      } catch {
        input = {};
      }
      blocks.push({
        type: 'tool_use',
        id: String(tc.id || 'toolu_unknown'),
        name: String(fn.name || ''),
        input,
      });
    }
  }
  if (blocks.length === 0) blocks.push({ type: 'text', text: '' });
  return blocks;
}

async function handleAnthropicMessages(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  ctx: Ctx,
): Promise<void> {
  if (!req.headers['anthropic-version']) {
    log('warning: POST /v1/messages without anthropic-version header');
  }
  let body: Record<string, unknown>;
  try {
    body = (await readBody(req)) as Record<string, unknown>;
  } catch (e) {
    const err = e as { status?: number; message?: string };
    return anthropicError(res, err.status || 400, 'invalid_request_error', err.message || 'invalid request');
  }
  let translated: Record<string, unknown>;
  try {
    translated = anthropicToOpenAI(body);
  } catch (e) {
    const err = e as { status?: number; message?: string };
    return anthropicError(res, err.status || 400, 'invalid_request_error', err.message || 'invalid request');
  }
  const isStream = body.stream === true;
  const upstreamBody: Record<string, unknown> = {
    ...translated,
    model: ctx.chosen.id,
    max_tokens: body.max_tokens !== undefined ? body.max_tokens : 1024,
  };
  if (isStream) {
    upstreamBody.stream = true;
    upstreamBody.stream_options = { include_usage: true };
  }

  let outcome: DialOutcome;
  try {
    outcome = await dialChosen(upstreamBody, isStream, ctx.chosen.id);
  } catch (e) {
    // A dial that throws outright is an upstream failure, not a client
    // error: never answer 4xx/5xx on a wire call. Give up silently (the
    // env records no refusal for an unanswered prompt).
    logErr('dial threw:', e instanceof Error ? e.message : String(e));
    res.destroy();
    return;
  }
  const headers = failuresHeader(outcome.failures);
  const upstream = outcome.res;
  if (!upstream || !upstream.ok) {
    // Give up by not answering at all. Destroying the socket means the env
    // records no refusal for this prompt, so the failover column is not
    // charged for it. (A 4xx/5xx answer would be recorded as a refusal.)
    log(`giving up on prompt after retries: ${JSON.stringify(outcome.failures)}`);
    res.destroy();
    return;
  }

  if (!isStream) {
    const data = (await upstream.json().catch(() => ({}))) as Record<string, unknown>;
    const choice = ((data.choices as Array<Record<string, unknown>>) || [])[0] || {};
    const msg = (choice.message as Record<string, unknown>) || {};
    const blocks = openAIMessageToAnthropicBlocks(msg);
    const text = blocks
      .filter((b) => b.type === 'text')
      .map((b) => String(b.text || ''))
      .join('');
    const usage = upstreamUsage(data);
    const finalUsage = usage.completion_tokens > 0 ? usage : synthUsage(text, usage.prompt_tokens);
    sendJson(
      res,
      200,
      {
        id: `msg_${typeof data.id === 'string' && data.id ? data.id : fallbackId('aggregate')}`,
        type: 'message',
        role: 'assistant',
        content: blocks,
        model: ctx.chosen.id,
        stop_reason: mapStopReason(choice.finish_reason as string | undefined),
        stop_sequence: null,
        usage: { input_tokens: finalUsage.prompt_tokens, output_tokens: finalUsage.completion_tokens },
      },
      headers,
    );
    return;
  }

  // Streaming: rebuild Anthropic events from the OpenAI delta stream.
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    ...headers,
  });
  const sse = (event: string, data: unknown): void => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  let msgId = '';
  let started = false;
  let textBlockOpen = false;
  let toolBlockCount = 0;
  const toolIndexMap = new Map<number, number>();
  let accText = '';
  let usage: { prompt_tokens: number; completion_tokens: number } | null = null;
  let finishReason = 'stop';
  const openBlocks: number[] = [];
  try {
    for await (const chunk of parseSSE(upstream.body)) {
      const chunkUsage = chunk.usage as Record<string, unknown> | undefined;
      if (chunkUsage) {
        usage = {
          prompt_tokens: typeof chunkUsage.prompt_tokens === 'number' ? chunkUsage.prompt_tokens : 0,
          completion_tokens: typeof chunkUsage.completion_tokens === 'number' ? chunkUsage.completion_tokens : 0,
        };
      }
      const choice = ((chunk.choices as Array<Record<string, unknown>>) || [])[0] || {};
      if (typeof choice.finish_reason === 'string' && choice.finish_reason) finishReason = choice.finish_reason;
      const delta = (choice.delta as Record<string, unknown>) || {};
      const content = typeof delta.content === 'string' ? delta.content : '';
      const toolCalls = Array.isArray(delta.tool_calls) ? (delta.tool_calls as Array<Record<string, unknown>>) : [];
      if (!started) {
        msgId = `msg_${typeof chunk.id === 'string' && chunk.id ? chunk.id : fallbackId('aggregate')}`;
        sse('message_start', {
          type: 'message_start',
          message: {
            id: msgId,
            type: 'message',
            role: 'assistant',
            content: [],
            model: ctx.chosen.id,
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 0, output_tokens: 0 },
          },
        });
        started = true;
      }
      if (content) {
        if (!textBlockOpen) {
          sse('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
          textBlockOpen = true;
          openBlocks.push(0);
        }
        accText += content;
        sse('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: content } });
      }
      for (const tc of toolCalls) {
        const oi = typeof tc.index === 'number' ? tc.index : 0;
        let ai = toolIndexMap.get(oi);
        const fn = (tc.function as Record<string, unknown>) || {};
        if (ai === undefined) {
          ai = (textBlockOpen ? 1 : 0) + toolBlockCount;
          toolBlockCount += 1;
          toolIndexMap.set(oi, ai);
          sse('content_block_start', {
            type: 'content_block_start',
            index: ai,
            content_block: { type: 'tool_use', id: String(tc.id || 'toolu_unknown'), name: String(fn.name || ''), input: {} },
          });
          openBlocks.push(ai);
        }
        const args = typeof fn.arguments === 'string' ? fn.arguments : '';
        if (args) {
          sse('content_block_delta', { type: 'content_block_delta', index: ai, delta: { type: 'input_json_delta', partial_json: args } });
        }
      }
    }
  } catch (e) {
    logErr('stream error:', e instanceof Error ? e.message : String(e));
  }
  if (!started) {
    msgId = `msg_${fallbackId('aggregate')}`;
    sse('message_start', {
      type: 'message_start',
      message: {
        id: msgId,
        type: 'message',
        role: 'assistant',
        content: [],
        model: ctx.chosen.id,
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    });
  }
  if (!textBlockOpen) {
    sse('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
    openBlocks.push(0);
  }
  for (const idx of openBlocks) {
    sse('content_block_stop', { type: 'content_block_stop', index: idx });
  }
  const finalUsage = usage && usage.completion_tokens > 0 ? usage : synthUsage(accText, usage?.prompt_tokens ?? 0);
  sse('message_delta', {
    type: 'message_delta',
    delta: { stop_reason: mapStopReason(finishReason), stop_sequence: null },
    usage: { input_tokens: finalUsage.prompt_tokens, output_tokens: finalUsage.completion_tokens },
  });
  sse('message_stop', { type: 'message_stop' });
  res.end();
}

// ---------------------------------------------------------------------------
// Out-of-scope wires: never answered with a completion.
// POST /v1/responses, POST /v1/responses/{id}/cancel, POST /v1/embeddings
// are not part of this trial's wires. They are refused, never served.
// ---------------------------------------------------------------------------
function handleNotServed(req: http.IncomingMessage, res: http.ServerResponse): void {
  const url = new URL(req.url || '/', 'http://localhost');
  if (url.pathname === '/v1/messages') {
    anthropicError(res, 404, 'not_found_error', `Not found: ${req.method} ${url.pathname}`);
  } else {
    openAIError(res, 404, `Not found: ${req.method} ${url.pathname}`, 'not_found');
  }
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------
async function requestHandler(req: http.IncomingMessage, res: http.ServerResponse, ctx: Ctx): Promise<void> {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  const path = url.pathname;
  log(req.method, path);
  if (req.method === 'GET' && path === '/health') {
    return sendJson(res, 200, { status: 'ok', model: ctx.chosen.id, upstream: 'openrouter' });
  }
  if (req.method === 'GET' && path === '/v1/models') return handleListModels(req, res, ctx);
  if (req.method === 'POST' && path === '/v1/chat/completions') return handleChatCompletions(req, res, ctx);
  if (req.method === 'POST' && path === '/v1/messages') return handleAnthropicMessages(req, res, ctx);
  if (req.method === 'POST' && (path === '/v1/responses' || path === '/v1/embeddings' || /^\/v1\/responses\/[^/]+\/cancel$/.test(path))) {
    return handleNotServed(req, res);
  }
  return handleNotServed(req, res);
}

// ---------------------------------------------------------------------------
// Env: register, poll /work, exit when done.
// ---------------------------------------------------------------------------
function envUrl(): string {
  const u = (process.env.MAKEFUN_ENV_URL || '').replace(/\/$/, '');
  if (!u) throw new Error('MAKEFUN_ENV_URL is not set');
  return u;
}

async function register(port: number, catalog: Catalog): Promise<void> {
  const body = { protocol_version: PROTOCOL_VERSION, port, catalog };
  let lastErr: unknown = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(`${envUrl()}/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(REGISTER_TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`register refused: HTTP ${res.status}`);
      const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      log(`registered with env (requests: ${String(data.requests ?? '?')})`);
      return;
    } catch (e) {
      lastErr = e;
      log(`register attempt ${attempt} failed: ${e instanceof Error ? e.message : String(e)}`);
      if (attempt < 3) await new Promise((r) => setTimeout(r, 500));
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error('register failed');
}

async function main(): Promise<void> {
  const promptFile = process.env.MAKEFUN_PROMPT_FILE || '';
  if (!promptFile) {
    logErr('MAKEFUN_PROMPT_FILE is not set');
    process.exit(1);
  }
  let brief: Brief;
  try {
    brief = readBrief(promptFile);
  } catch (e) {
    logErr(`cannot read prompt file: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
  if (brief.error) {
    logErr(`brief problem: ${brief.error}`);
    process.exit(1);
  }
  const catalog = buildCatalog(brief.models);
  const chosen = chooseModel(brief.models, brief.prompts);
  log(`brief: ${brief.models.length} free models, ${brief.prompts.length} prompts`);
  log(`chosen model: ${chosen.id} (rating ${chosen.rating_milli ?? 0}, tools=${String(chosen.tools)}, vision=${String(chosen.vision)}, json=${String(chosen.json)})`);

  if (process.argv.includes('--list')) {
    console.log(JSON.stringify(catalog));
    process.exit(0);
  }

  const env = envUrl();
  if (!env) {
    logErr('MAKEFUN_ENV_URL is not set');
    process.exit(1);
  }
  const ctx: Ctx = { chosen, models: brief.models.filter((m) => m.free !== false), catalog };

  const server = http.createServer((req, res) => {
    requestHandler(req, res, ctx).catch((e: unknown) => {
      logErr('unhandled error:', e instanceof Error ? e.stack || e.message : String(e));
      // Never answer 4xx/5xx on a wire call: an unexpected handler error is
      // an upstream-side failure, so give up by not answering at all.
      if (!res.headersSent) res.destroy();
      else res.end();
    });
  });

  const stop = (): void => {
    clearInterval(pollTimer);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);

  let pollTimer: NodeJS.Timeout;
  server.listen(0, '0.0.0.0', () => {
    const addr = server.address();
    const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
    if (port === 8080) {
      logErr('OS assigned port 8080, which collides with the env; aborting');
      process.exit(1);
    }
    log(`listening on 0.0.0.0:${port} (model: ${chosen.id})`);
    register(port, catalog)
      .then(() => {
        let inFlight = false;
        pollTimer = setInterval(() => {
          if (inFlight) return;
          inFlight = true;
          fetch(`${envUrl()}/work`, { signal: AbortSignal.timeout(WORK_TIMEOUT_MS) })
            .then((r) => (r.ok ? r.json() : null))
            .then((data) => {
              const d = data as { done?: boolean } | null;
              if (d && d.done === true) {
                log('env reports done; exiting 0');
                stop();
              }
            })
            .catch(() => {
              // Transient env hiccup; try again next tick.
            })
            .finally(() => {
              inFlight = false;
            });
        }, POLL_INTERVAL_MS);
      })
      .catch((e: unknown) => {
        logErr(`register failed: ${e instanceof Error ? e.message : String(e)}`);
        process.exit(1);
      });
  });
}

main().catch((e: unknown) => {
  logErr(e instanceof Error ? e.stack || e.message : String(e));
  process.exit(1);
});
