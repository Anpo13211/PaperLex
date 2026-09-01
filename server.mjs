import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createAuth, verifyCaptureToken } from './lib/auth.mjs';
import { assertSafeNetworkConfig, loadConfig } from './lib/config.mjs';
import { ValidationError } from './lib/normalize.mjs';
import { VocabularyStore } from './lib/store.mjs';

const APP_DIR = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(APP_DIR, 'public');
const LIBRARY_ENTRY_PATHS = new Set(['/', '/index.html', '/vocabulary.html']);
const REVALIDATED_STATIC_FILES = new Set(['index.html', 'app.js', 'definition-format.js', 'service-worker.js']);
const STATIC_FILES = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['index.html', 'text/html; charset=utf-8']],
  ['/vocabulary.html', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/definition-format.js', ['definition-format.js', 'text/javascript; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
  ['/manifest.webmanifest', ['manifest.webmanifest', 'application/manifest+json; charset=utf-8']],
  ['/service-worker.js', ['service-worker.js', 'text/javascript; charset=utf-8']],
  ['/icons/icon.svg', ['icons/icon.svg', 'image/svg+xml']],
  ['/icons/icon-192.png', ['icons/icon-192.png', 'image/png']],
  ['/icons/icon-512.png', ['icons/icon-512.png', 'image/png']],
]);

export function createPaperLexApp({
  store,
  password = '',
  captureToken = '',
  sessionSecret = '',
  secureCookie = false,
  libraryUrl = '',
}) {
  const auth = createAuth({ password, sessionSecret });
  const loginLimiter = createLoginLimiter();

  return async function handle(request, response) {
    setSecurityHeaders(response);
    const url = new URL(request.url || '/', 'http://paperlex.local');

    try {
      if (request.method === 'GET' || request.method === 'HEAD') {
        if (libraryUrl && LIBRARY_ENTRY_PATHS.has(url.pathname) && url.searchParams.get('local') !== '1') {
          return redirect(response, libraryUrl);
        }
        if (STATIC_FILES.has(url.pathname)) {
          return serveStatic(url.pathname, request, response);
        }
      }

      if (url.pathname === '/api/health' && request.method === 'GET') {
        return sendJson(response, 200, { ok: true, service: 'PaperLex', version: 1 });
      }

      if (url.pathname === '/api/config' && request.method === 'GET') {
        return sendJson(response, 200, { requiresLogin: auth.requiresLogin, libraryUrl });
      }

      if (url.pathname === '/api/session' && request.method === 'POST') {
        assertJsonRequest(request);
        assertSameOrigin(request);
        const loginKey = request.socket.remoteAddress || 'unknown';
        const retryAfter = loginLimiter.retryAfter(loginKey);
        if (retryAfter > 0) {
          response.setHeader('Retry-After', String(retryAfter));
          return sendJson(response, 429, { error: 'ログイン失敗が続いたため、しばらく待ってからお試しください。' });
        }
        const body = await readJson(request);
        if (!auth.login(body.password)) {
          loginLimiter.recordFailure(loginKey);
          return sendJson(response, 401, { error: 'パスワードが違います。' });
        }
        loginLimiter.clear(loginKey);
        response.setHeader('Set-Cookie', auth.sessionCookie({ secure: secureCookie || request.socket.encrypted === true }));
        return sendJson(response, 200, { ok: true });
      }

      if (url.pathname === '/api/session' && request.method === 'DELETE') {
        response.setHeader('Set-Cookie', auth.clearCookie());
        return sendJson(response, 200, { ok: true });
      }

      if (url.pathname === '/api/capture' && request.method === 'POST') {
        assertJsonRequest(request);
        assertSameOrigin(request);
        if (!verifyCaptureToken(request, captureToken)) {
          return sendJson(response, 401, { error: 'キャプチャ用トークンが正しくありません。' });
        }
        const body = await readJson(request);
        const result = await store.capture({ ...body, sourceApp: body.sourceApp || 'Preview' });
        return sendJson(response, result.created ? 201 : 200, result);
      }

      if (!url.pathname.startsWith('/api/')) return sendJson(response, 404, { error: 'Not found' });
      if (!auth.isAuthorized(request)) return sendJson(response, 401, { error: 'ログインが必要です。' });

      if (url.pathname === '/api/words' && request.method === 'GET') {
        return sendJson(response, 200, { words: store.listWords() });
      }

      if (url.pathname === '/api/words' && request.method === 'POST') {
        assertJsonRequest(request);
        assertSameOrigin(request);
        const body = await readJson(request);
        const result = await store.capture({ ...body, sourceApp: body.sourceApp || 'PaperLex web' });
        return sendJson(response, result.created ? 201 : 200, result);
      }

      const exampleRefreshMatch = /^\/api\/words\/([0-9a-f-]+)\/examples\/refresh$/i.exec(url.pathname);
      if (exampleRefreshMatch && request.method === 'POST') {
        assertSameOrigin(request);
        const word = await store.refreshExamples(exampleRefreshMatch[1]);
        return word ? sendJson(response, 200, { word }) : sendJson(response, 404, { error: '単語が見つかりません。' });
      }

      const dictionaryRefreshMatch = /^\/api\/words\/([0-9a-f-]+)\/dictionary\/refresh$/i.exec(url.pathname);
      if (dictionaryRefreshMatch && request.method === 'POST') {
        assertSameOrigin(request);
        const word = await store.refreshDictionary(dictionaryRefreshMatch[1]);
        return word ? sendJson(response, 200, { word }) : sendJson(response, 404, { error: '単語が見つかりません。' });
      }

      const wordMatch = /^\/api\/words\/([0-9a-f-]+)$/i.exec(url.pathname);
      if (wordMatch && request.method === 'GET') {
        const word = store.getWord(wordMatch[1]);
        return word ? sendJson(response, 200, { word }) : sendJson(response, 404, { error: '単語が見つかりません。' });
      }

      if (wordMatch && request.method === 'PATCH') {
        assertJsonRequest(request);
        assertSameOrigin(request);
        const body = await readJson(request);
        const word = store.updateWord(wordMatch[1], body);
        return word ? sendJson(response, 200, { word }) : sendJson(response, 404, { error: '単語が見つかりません。' });
      }

      if (wordMatch && request.method === 'DELETE') {
        const deleted = store.deleteWord(wordMatch[1]);
        return deleted ? sendJson(response, 200, { ok: true }) : sendJson(response, 404, { error: '単語が見つかりません。' });
      }

      if (url.pathname === '/api/export' && request.method === 'GET') {
        response.setHeader('Content-Disposition', `attachment; filename="paperlex-${new Date().toISOString().slice(0, 10)}.json"`);
        return sendJson(response, 200, store.exportBackup());
      }

      return sendJson(response, 404, { error: 'Not found' });
    } catch (error) {
      if (error instanceof ValidationError) {
        return sendJson(response, error.statusCode, { error: error.message, details: error.details });
      }
      if (error?.code === 'BODY_TOO_LARGE') {
        return sendJson(response, 413, { error: 'データが大きすぎます。' });
      }
      if (error instanceof SyntaxError) {
        return sendJson(response, 400, { error: 'JSONを読み取れません。' });
      }
      console.error('[PaperLex]', error);
      return sendJson(response, 500, { error: '内部エラーが発生しました。' });
    }
  };
}

export function startServer(config = loadConfig()) {
  assertSafeNetworkConfig(config);
  const store = new VocabularyStore({ filename: config.databasePath, logger: console });
  const app = createPaperLexApp({
    store,
    password: config.password,
    captureToken: config.captureToken,
    sessionSecret: config.sessionSecret,
    secureCookie: config.secureCookie,
    libraryUrl: config.libraryUrl,
  });
  const server = http.createServer(app);
  const backfillController = new AbortController();
  const backgroundLookups = Promise.all([
    store.backfillDictionaries({ signal: backfillController.signal }),
    store.backfillExamples({ signal: backfillController.signal }),
  ])
    .then(([dictionaries, examples]) => {
      if (dictionaries.processed) console.log(`PaperLex dictionary lookups completed: ${dictionaries.processed}`);
      if (examples.processed) console.log(`PaperLex example lookups completed: ${examples.processed}`);
    })
    .catch((error) => console.error('[PaperLex enrichment]', error));
  server.listen(config.port, config.host, () => {
    const localUrl = `http://${config.host === '0.0.0.0' ? '127.0.0.1' : config.host}:${config.port}`;
    console.log(`PaperLex is ready: ${localUrl}`);
  });
  let stopping = false;
  const shutdown = () => {
    if (stopping) return;
    stopping = true;
    backfillController.abort();
    server.close(async () => {
      await settleWithin(backgroundLookups, 2_000);
      store.close();
      process.exit(0);
    });
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  return { server, store };
}

async function settleWithin(promise, timeoutMs) {
  let timer;
  try {
    await Promise.race([
      promise,
      new Promise((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function readJson(request, limit = 96 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) {
      const error = new Error('Request body too large');
      error.code = 'BODY_TOO_LARGE';
      throw error;
    }
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (!value || Array.isArray(value) || typeof value !== 'object') {
    throw new ValidationError('JSONはオブジェクト形式で送信してください。');
  }
  return value;
}

function sendJson(response, statusCode, payload) {
  const body = JSON.stringify(payload);
  response.statusCode = statusCode;
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.setHeader('Content-Length', Buffer.byteLength(body));
  response.setHeader('Cache-Control', 'no-store');
  response.end(body);
}

function redirect(response, location) {
  response.statusCode = 302;
  response.setHeader('Location', location);
  response.setHeader('Content-Length', '0');
  response.setHeader('Cache-Control', 'no-store');
  response.end();
}

function serveStatic(pathname, request, response) {
  const [relativePath, contentType] = STATIC_FILES.get(pathname);
  const absolutePath = path.join(PUBLIC_DIR, relativePath);
  if (!fs.existsSync(absolutePath)) return sendJson(response, 404, { error: 'Not found' });
  const stat = fs.statSync(absolutePath);
  response.statusCode = 200;
  response.setHeader('Content-Type', contentType);
  response.setHeader('Content-Length', stat.size);
  response.setHeader(
    'Cache-Control',
    REVALIDATED_STATIC_FILES.has(relativePath) ? 'no-cache' : 'public, max-age=300',
  );
  if (request.method === 'HEAD') return response.end();
  fs.createReadStream(absolutePath).pipe(response);
}

function setSecurityHeaders(response) {
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('X-Frame-Options', 'DENY');
  response.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  response.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; media-src 'self' https:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  );
}

function assertJsonRequest(request) {
  const contentType = String(request.headers['content-type'] || '').split(';', 1)[0].trim().toLowerCase();
  if (contentType !== 'application/json') {
    const error = new ValidationError('Content-Type は application/json を指定してください。');
    error.statusCode = 415;
    throw error;
  }
}

function assertSameOrigin(request) {
  const origin = request.headers.origin;
  if (!origin) return;
  try {
    const originUrl = new URL(origin);
    if (originUrl.host === request.headers.host) return;
  } catch {
    // Rejected below.
  }
  const error = new ValidationError('別のサイトからの更新は許可されていません。');
  error.statusCode = 403;
  throw error;
}

function createLoginLimiter({ maxFailures = 8, windowMs = 5 * 60 * 1000 } = {}) {
  const attempts = new Map();
  return {
    retryAfter(key, now = Date.now()) {
      const entry = attempts.get(key);
      if (!entry) return 0;
      if (now - entry.startedAt >= windowMs) {
        attempts.delete(key);
        return 0;
      }
      if (entry.count < maxFailures) return 0;
      return Math.max(1, Math.ceil((windowMs - (now - entry.startedAt)) / 1000));
    },
    recordFailure(key, now = Date.now()) {
      const entry = attempts.get(key);
      if (!entry || now - entry.startedAt >= windowMs) {
        attempts.set(key, { count: 1, startedAt: now });
      } else {
        entry.count += 1;
      }
      if (attempts.size > 1_000) {
        for (const [candidate, value] of attempts) {
          if (now - value.startedAt >= windowMs) attempts.delete(candidate);
        }
      }
    },
    clear(key) {
      attempts.delete(key);
    },
  };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) startServer();
