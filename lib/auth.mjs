import { createHmac, timingSafeEqual } from 'node:crypto';

const COOKIE_NAME = 'paperlex_session';

export function createAuth({ password = '', sessionSecret = '' } = {}) {
  const requiresLogin = Boolean(password);
  const signingSecret = sessionSecret || password || 'paperlex-local-session';

  return {
    requiresLogin,
    login(candidate) {
      return requiresLogin && safeStringEqual(String(candidate ?? ''), password);
    },
    isAuthorized(request) {
      if (!requiresLogin) return true;
      const cookies = parseCookies(request.headers.cookie || '');
      return verifySession(cookies[COOKIE_NAME] || '', signingSecret);
    },
    sessionCookie({ secure = false } = {}) {
      const value = createSession(signingSecret);
      const attributes = [
        `${COOKIE_NAME}=${value}`,
        'Path=/',
        'HttpOnly',
        'SameSite=Strict',
        'Max-Age=2592000',
      ];
      if (secure) attributes.push('Secure');
      return attributes.join('; ');
    },
    clearCookie() {
      return `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`;
    },
  };
}

export function verifyCaptureToken(request, configuredToken) {
  if (!configuredToken) return false;
  const supplied = request.headers['x-paperlex-token'] || bearerToken(request.headers.authorization);
  return safeStringEqual(String(supplied || ''), configuredToken);
}

function createSession(secret, now = Date.now()) {
  const payload = Buffer.from(JSON.stringify({
    issuedAt: now,
    expiresAt: now + 30 * 24 * 60 * 60 * 1000,
  })).toString('base64url');
  return `${payload}.${sign(payload, secret)}`;
}

function verifySession(value, secret, now = Date.now()) {
  const separator = value.lastIndexOf('.');
  if (separator < 1) return false;
  const payload = value.slice(0, separator);
  const signature = value.slice(separator + 1);
  if (!safeStringEqual(signature, sign(payload, secret))) return false;
  try {
    const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return Number.isFinite(parsed.issuedAt)
      && Number.isFinite(parsed.expiresAt)
      && parsed.issuedAt <= now + 60_000
      && parsed.expiresAt > now
      && parsed.expiresAt - parsed.issuedAt <= 30 * 24 * 60 * 60 * 1000;
  } catch {
    return false;
  }
}

function sign(payload, secret) {
  return createHmac('sha256', secret).update(`paperlex:user-session:v1:${payload}`).digest('base64url');
}

function parseCookies(header) {
  const result = {};
  for (const segment of header.split(';')) {
    const index = segment.indexOf('=');
    if (index < 0) continue;
    const key = segment.slice(0, index).trim();
    const value = segment.slice(index + 1).trim();
    if (key) result[key] = value;
  }
  return result;
}

function bearerToken(header = '') {
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match?.[1] || '';
}

function safeStringEqual(left, right) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  if (leftBuffer.length !== rightBuffer.length) return false;
  return timingSafeEqual(leftBuffer, rightBuffer);
}
