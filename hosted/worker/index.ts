import {
  clearSessionCookie,
  createSessionCookie,
  hasValidSession,
  passwordMatches,
  requiresLogin,
  secretMatches,
} from "./auth.ts";
import { ValidationError } from "./normalize.ts";
import { D1VocabularyStore, type D1DatabaseLike } from "./store.ts";

interface AssetFetcher { fetch(request: Request): Promise<Response>; }
export interface Env {
  ASSETS: AssetFetcher;
  DB: D1DatabaseLike;
  PAPERLEX_CAPTURE_TOKEN?: string;
  PAPERLEX_IMPORT_TOKEN?: string;
  // PAPERLEX_PASSWORD を設定すると、ChatGPT のログインではなく PaperLex 自身の
  // パスワードで認証する。Cloudflare へ直接置く場合はこちらを使う。
  PAPERLEX_PASSWORD?: string;
  PAPERLEX_SESSION_SECRET?: string;
}
interface ExecutionContext { waitUntil(promise: Promise<unknown>): void; passThroughOnException(): void; }

const JSON_HEADERS = { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" };

const worker = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    void ctx;
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) return withSecurityHeaders(await handleApi(request, env, url));
    return withSecurityHeaders(await env.ASSETS.fetch(request));
  },
};

export async function handleApi(request: Request, env: Env, url = new URL(request.url)): Promise<Response> {
  const store = new D1VocabularyStore(env.DB);
  try {
    if (url.pathname === "/api/health" && request.method === "GET") return json(200, { ok: true, service: "PaperLex", version: 1 });

    if (url.pathname === "/api/capture" && request.method === "POST") {
      assertJsonRequest(request);
      assertSameOrigin(request);
      if (!secretMatches(request.headers.get("X-PaperLex-Token"), env.PAPERLEX_CAPTURE_TOKEN)) {
        return json(401, { error: "キャプチャ用トークンが正しくありません。" });
      }
      const body = await readJson(request, 96 * 1024);
      const result = await store.capture({ ...body, sourceApp: body.sourceApp || "Preview" });
      return json(result.created ? 201 : 200, result);
    }
    if (url.pathname === "/api/import" && request.method === "POST") {
      assertJsonRequest(request);
      assertSameOrigin(request);
      if (!secretMatches(request.headers.get("X-PaperLex-Import-Token"), env.PAPERLEX_IMPORT_TOKEN)) {
        return json(401, { error: "インポート用トークンが正しくありません。" });
      }
      return json(200, await store.importBackup(await readJson(request, 8 * 1024 * 1024)));
    }
    if (url.pathname === "/api/session" && request.method === "POST") {
      assertJsonRequest(request);
      assertSameOrigin(request);
      if (!requiresLogin(env)) return json(404, { error: "このサイトはパスワードログインを使いません。" });
      const body = await readJson(request, 4 * 1024);
      if (!passwordMatches(body.password, env)) return json(401, { error: "パスワードが正しくありません。" });
      const response = json(200, { ok: true });
      response.headers.set("Set-Cookie", await createSessionCookie(env));
      return response;
    }
    if (url.pathname === "/api/session" && request.method === "DELETE") {
      assertSameOrigin(request);
      const response = json(200, { ok: true });
      response.headers.set("Set-Cookie", clearSessionCookie());
      return response;
    }

    if (!await isAuthorized(request, env)) {
      return json(401, {
        error: requiresLogin(env) ? "PaperLex のパスワードでログインしてください。" : "ChatGPTでのログインが必要です。",
      });
    }
    if (url.pathname === "/api/config" && request.method === "GET") {
      return json(200, {
        requiresLogin: requiresLogin(env),
        authentication: requiresLogin(env) ? "password" : "private-site",
      });
    }
    if (url.pathname === "/api/words" && request.method === "GET") return json(200, { words: await store.listWords() });
    if (url.pathname === "/api/words" && request.method === "POST") {
      assertJsonRequest(request);
      assertSameOrigin(request);
      const body = await readJson(request, 96 * 1024);
      const result = await store.capture({ ...body, sourceApp: body.sourceApp || "PaperLex web" });
      return json(result.created ? 201 : 200, result);
    }

    const exampleRefreshMatch = /^\/api\/words\/([0-9a-z-]+)\/examples\/refresh$/i.exec(url.pathname);
    if (exampleRefreshMatch && request.method === "POST") {
      assertSameOrigin(request);
      const word = await store.refreshExamples(exampleRefreshMatch[1]);
      return word ? json(200, { word }) : json(404, { error: "単語が見つかりません。" });
    }
    const dictionaryRefreshMatch = /^\/api\/words\/([0-9a-z-]+)\/dictionary\/refresh$/i.exec(url.pathname);
    if (dictionaryRefreshMatch && request.method === "POST") {
      assertSameOrigin(request);
      const word = await store.refreshDictionary(dictionaryRefreshMatch[1]);
      return word ? json(200, { word }) : json(404, { error: "単語が見つかりません。" });
    }
    const wordMatch = /^\/api\/words\/([0-9a-z-]+)$/i.exec(url.pathname);
    if (wordMatch && request.method === "GET") {
      const word = await store.getWord(wordMatch[1]);
      return word ? json(200, { word }) : json(404, { error: "単語が見つかりません。" });
    }
    if (wordMatch && request.method === "PATCH") {
      assertJsonRequest(request);
      assertSameOrigin(request);
      const word = await store.updateWord(wordMatch[1], await readJson(request, 96 * 1024));
      return word ? json(200, { word }) : json(404, { error: "単語が見つかりません。" });
    }
    if (wordMatch && request.method === "DELETE") {
      assertSameOrigin(request);
      return await store.deleteWord(wordMatch[1]) ? json(200, { ok: true }) : json(404, { error: "単語が見つかりません。" });
    }
    if (url.pathname === "/api/export" && request.method === "GET") {
      const response = json(200, await store.exportBackup());
      response.headers.set("Content-Disposition", `attachment; filename="paperlex-${new Date().toISOString().slice(0, 10)}.json"`);
      return response;
    }
    return json(404, { error: "Not found" });
  } catch (error) {
    if (error instanceof ValidationError) return json(error.statusCode, { error: error.message, details: error.details });
    if (error instanceof SyntaxError) return json(400, { error: "JSONを読み取れません。" });
    console.error("[PaperLex hosted]", error);
    return json(500, { error: "内部エラーが発生しました。" });
  }
}

function json(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), { status, headers: JSON_HEADERS });
}

async function readJson(request: Request, limit: number): Promise<Record<string, unknown>> {
  const declared = Number(request.headers.get("Content-Length"));
  if (Number.isFinite(declared) && declared > limit) throw payloadTooLarge();
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > limit) throw payloadTooLarge();
  const value = text ? JSON.parse(text) : {};
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ValidationError("JSONはオブジェクト形式で送信してください。");
  return value as Record<string, unknown>;
}

function payloadTooLarge(): ValidationError {
  const error = new ValidationError("データが大きすぎます。");
  error.statusCode = 413;
  return error;
}

function assertJsonRequest(request: Request): void {
  const contentType = String(request.headers.get("Content-Type") || "").split(";", 1)[0].trim().toLowerCase();
  if (contentType !== "application/json") {
    const error = new ValidationError("Content-Type は application/json を指定してください。");
    error.statusCode = 415;
    throw error;
  }
}

function assertSameOrigin(request: Request): void {
  const origin = request.headers.get("Origin");
  if (!origin || origin === new URL(request.url).origin) return;
  const error = new ValidationError("別のサイトからの更新は許可されていません。");
  error.statusCode = 403;
  throw error;
}

export { secretMatches };

// パスワードを設定していれば PaperLex のセッション、していなければ Sites の
// プライベート配信が入れる oai-authenticated-user-id を認証の根拠にする。
async function isAuthorized(request: Request, env: Env): Promise<boolean> {
  if (requiresLogin(env)) return hasValidSession(request, env);
  return hasAuthenticatedUser(request);
}

export function hasAuthenticatedUser(request: Request): boolean {
  return Boolean(request.headers.get("oai-authenticated-user-id")?.trim());
}

function withSecurityHeaders(response: Response): Response {
  const secured = new Response(response.body, response);
  secured.headers.set("X-Content-Type-Options", "nosniff");
  secured.headers.set("Referrer-Policy", "no-referrer");
  secured.headers.set("X-Frame-Options", "DENY");
  secured.headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  secured.headers.set("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; media-src 'self' https:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'");
  return secured;
}

export default worker;
