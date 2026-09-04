// PaperLex 自身のパスワードでログインするための署名つきセッション。
// OpenAI Sites では ChatGPT のログインが認証を担うが、Cloudflare へ直接置く場合は
// PAPERLEX_PASSWORD を設定してこちらを使う。lib/auth.mjs と同じ方式を Web Crypto で実装している。
const COOKIE_NAME = "paperlex_session";
// スマホから毎回入力しなくて済むよう長めに取る。サーバーが Set-Cookie で発行する
// HttpOnly cookie なので、document.cookie 由来の cookie に掛かる Safari の 7 日制限は受けない。
const SESSION_LIFETIME_MS = 365 * 24 * 60 * 60 * 1000;
const SIGNATURE_CONTEXT = "paperlex:user-session:v1:";

export interface AuthEnv {
  PAPERLEX_PASSWORD?: string;
  PAPERLEX_SESSION_SECRET?: string;
}

export function requiresLogin(env: AuthEnv): boolean {
  return Boolean(env.PAPERLEX_PASSWORD);
}

export function passwordMatches(candidate: unknown, env: AuthEnv): boolean {
  return requiresLogin(env) && secretMatches(String(candidate ?? ""), env.PAPERLEX_PASSWORD);
}

export async function createSessionCookie(
  env: AuthEnv,
  { secure = true, now = Date.now() }: { secure?: boolean; now?: number } = {},
): Promise<string> {
  const payload = encodeBase64Url(new TextEncoder().encode(JSON.stringify({
    issuedAt: now,
    expiresAt: now + SESSION_LIFETIME_MS,
  })));
  const attributes = [
    `${COOKIE_NAME}=${payload}.${await sign(payload, signingSecret(env))}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    `Max-Age=${Math.floor(SESSION_LIFETIME_MS / 1000)}`,
  ];
  if (secure) attributes.push("Secure");
  return attributes.join("; ");
}

export function clearSessionCookie(): string {
  return `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`;
}

export async function hasValidSession(request: Request, env: AuthEnv, now = Date.now()): Promise<boolean> {
  if (!requiresLogin(env)) return false;
  const value = parseCookies(request.headers.get("Cookie") || "")[COOKIE_NAME] || "";
  const separator = value.lastIndexOf(".");
  if (separator < 1) return false;

  const payload = value.slice(0, separator);
  if (!secretMatches(value.slice(separator + 1), await sign(payload, signingSecret(env)))) return false;
  try {
    const parsed = JSON.parse(new TextDecoder().decode(decodeBase64Url(payload)));
    return Number.isFinite(parsed.issuedAt)
      && Number.isFinite(parsed.expiresAt)
      && parsed.issuedAt <= now + 60_000
      && parsed.expiresAt > now
      && parsed.expiresAt - parsed.issuedAt <= SESSION_LIFETIME_MS;
  } catch {
    return false;
  }
}

export function secretMatches(provided: string | null, expected: string | undefined): boolean {
  if (!provided || !expected || provided.length !== expected.length) return false;
  let difference = 0;
  for (let index = 0; index < expected.length; index += 1) difference |= provided.charCodeAt(index) ^ expected.charCodeAt(index);
  return difference === 0;
}

function signingSecret(env: AuthEnv): string {
  return env.PAPERLEX_SESSION_SECRET || env.PAPERLEX_PASSWORD || "paperlex-hosted-session";
}

async function sign(payload: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${SIGNATURE_CONTEXT}${payload}`));
  return encodeBase64Url(new Uint8Array(signature));
}

function parseCookies(header: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const segment of header.split(";")) {
    const index = segment.indexOf("=");
    if (index < 0) continue;
    const key = segment.slice(0, index).trim();
    if (key) result[key] = segment.slice(index + 1).trim();
  }
  return result;
}

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function decodeBase64Url(value: string): Uint8Array {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}
