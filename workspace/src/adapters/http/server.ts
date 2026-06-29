import 'dotenv/config';
import http from 'node:http';
import url from 'node:url';
import { SqlitePersistenceAdapter } from '../sqlite/sqlitePersistence.js';
import { FilePersistenceAdapter } from '../fs/filePersistence.js';
import { PersistenceService } from '../../application/persistenceService.js';
import { UniverseService } from '../../application/universeService.js';
import { MockAiProvider } from '../ai/mockAiProvider.js';
import logger from '../../utils/logger.js';
import { hashPassword, verifyPassword, isArgon2Available } from '../../utils/password.js';
import { hashToken } from '../../utils/crypto.js';

const PORT = parseInt(process.env.WORLDCORE_HTTP_PORT || '3000', 10);

// Rate limiter support: default in-memory implementation with optional
// Redis-backed limiter (set WORLDCORE_RATE_LIMIT_BACKEND=redis and
// WORLDCORE_REDIS_URL). The limiter is enabled only when
// WORLDCORE_RATE_LIMIT_PER_MIN is set to a positive integer.
let _inMemoryRateMap = new Map<string, { count: number; windowStart: number }>();
let _redisLimiterFactory: any = null;
// Per-email rate limiter (in-memory). Keyed by normalized email.
let _emailRateMap = new Map<string, { count: number; windowStart: number }>();

async function checkRateLimit(ip: string) {
  const RATE_LIMIT_PER_MIN = process.env.WORLDCORE_RATE_LIMIT_PER_MIN ? parseInt(process.env.WORLDCORE_RATE_LIMIT_PER_MIN, 10) : 0;
  if (!RATE_LIMIT_PER_MIN || RATE_LIMIT_PER_MIN <= 0) return { ok: true };

  // If configured, try Redis backend first
  if (process.env.WORLDCORE_RATE_LIMIT_BACKEND === 'redis') {
    try {
      if (!_redisLimiterFactory) {
        const mod = await import('../rateLimit/redisRateLimiter.js');
        _redisLimiterFactory = await mod.createRedisRateLimiter(process.env.WORLDCORE_REDIS_URL);
      }
      if (_redisLimiterFactory) return await _redisLimiterFactory(String(ip), RATE_LIMIT_PER_MIN);
    } catch (err) {
      // Fallback to in-memory on any Redis error
      try { const msg = err instanceof Error ? err.message : String(err); console.warn('redis rate limiter init failed, falling back to memory', msg); } catch (e) {}
    }
  }

  // In-memory fixed window rate limiter
  const now = Date.now();
  const windowMs = 60_000;
  const entry = _inMemoryRateMap.get(ip);
  if (!entry || now - entry.windowStart > windowMs) {
    _inMemoryRateMap.set(ip, { count: 1, windowStart: now });
    return { ok: true };
  }
  if (entry.count >= RATE_LIMIT_PER_MIN) {
    return { ok: false, retryAfter: Math.ceil((entry.windowStart + windowMs - now) / 1000) };
  }
  entry.count += 1;
  return { ok: true };
}

async function checkEmailRateLimit(email: string) {
  const RATE_LIMIT_PER_MIN = process.env.WORLDCORE_MAGIC_LINK_RATE_LIMIT_PER_MIN ? parseInt(process.env.WORLDCORE_MAGIC_LINK_RATE_LIMIT_PER_MIN, 10) : 5;
  if (!RATE_LIMIT_PER_MIN || RATE_LIMIT_PER_MIN <= 0) return { ok: true };
  const now = Date.now();
  const windowMs = 60_000;
  const key = String((email || '').toLowerCase()).trim() || 'unknown';
  const entry = _emailRateMap.get(key);
  if (!entry || now - entry.windowStart > windowMs) {
    _emailRateMap.set(key, { count: 1, windowStart: now });
    return { ok: true };
  }
  if (entry.count >= RATE_LIMIT_PER_MIN) {
    return { ok: false, retryAfter: Math.ceil((entry.windowStart + windowMs - now) / 1000) };
  }
  entry.count += 1;
  return { ok: true };
}

// Simple JWT HS256 verification (no external dependency). Returns payload if
// valid, otherwise throws. Only used when WORLDCORE_JWT_SECRET is configured.
import crypto from 'node:crypto';

function base64urlDecode(s: string) {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  return Buffer.from(s, 'base64').toString('utf8');
}

function verifyJwtHs256(token: string, secret: string) {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('invalid token');
  const [h, p, sig] = parts;
  const header = JSON.parse(base64urlDecode(h));
  if ((header.alg || '').toUpperCase() !== 'HS256') throw new Error('unsupported alg');
  const signingInput = `${h}.${p}`;
  const expected = crypto.createHmac('sha256', secret).update(signingInput).digest('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  if (expected !== sig) throw new Error('invalid signature');
  const payload = JSON.parse(base64urlDecode(p));
  if (payload.exp && Date.now() / 1000 > payload.exp) throw new Error('token expired');
  return payload;
}

  async function jsonBody(req: http.IncomingMessage) {
  return new Promise<any>((resolve, reject) => {
    const chunks: any[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      if (!chunks.length) return resolve(undefined);
      try {
        const s = Buffer.concat(chunks).toString('utf8');
        resolve(JSON.parse(s));
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

// Password utilities (prefer Argon2 when available; fallback to PBKDF2)

export interface ServerDeps {
  adapter?: any;
  aiProvider?: any;
}

export function createServerInstance(deps?: ServerDeps): http.Server {
  // Prefer SQLite adapter, but fall back to file-backed adapter when the
  // native dependency is not available (useful for local dev without
  // installing native modules).
  let adapter: any;
  if (deps?.adapter) {
    adapter = deps.adapter;
  } else {
    try {
      adapter = new SqlitePersistenceAdapter();
    } catch (e) {
      logger.warn('sqlite.init_failed', { err: e instanceof Error ? e.message : String(e) });
      adapter = new FilePersistenceAdapter();
    }
  }
  const persistence = new PersistenceService(adapter);
  const universeService = new UniverseService(persistence);
  // AI provider: may be passed in deps (tests) or created lazily when needed.
  let aiProvider = deps?.aiProvider;
  async function getAiProvider() {
    if (aiProvider) return aiProvider;
    const mod = await import('../ai/index.js');
    aiProvider = await mod.createAiProvider();
    return aiProvider;
  }

  // Create an AiProvider for the current requester when possible. Preference:
  // 1) If a persistence-backed user has a registered apiKey, create provider for that key.
  // 2) If the server was constructed with deps.aiProvider (tests), use it.
  // 3) Fallback to global provider from env.
  async function getAiProviderForRequest(req: http.IncomingMessage, profile?: string) {
    // If tests inject a provider, use it (keeps tests deterministic)
    if (deps?.aiProvider) return deps.aiProvider;

    const actorUser = getRequesterId(req);
    if (actorUser) {
      try {
        const user = await persistence.loadUser(actorUser);
        if (user && user.apiKey) {
          const mod = await import('../ai/index.js');
          // Model override per-profile can be provided by environment or user meta
          let userModel: string | undefined = undefined;
          try {
            userModel = (user.meta && user.meta.model) || undefined;
          } catch (e) {}
          try {
            const { pseudonymize } = await import('../../utils/crypto.js');
            const pseudo = actorUser ? pseudonymize(actorUser) : 'unknown';
            logger.info('ai.provider_selected', { requesterPseudo: pseudo, provider: user.provider ?? 'user' });
          } catch (e) {
            // ignore logging errors
          }
          return await mod.createAiProviderForKey(user.apiKey, userModel);
        }
      } catch (e) {
        // ignore and fall back
      }
    }

    return getAiProvider();
  }

  // In-memory store for dev magic links: token -> { email, expiresAt }
  const magicLinkStore = new Map<string, { email: string; expiresAt: number }>();

  function signJwt(sub: string, secret: string, ttlSeconds = 3600) {
    const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const payload = Buffer.from(JSON.stringify({ sub, exp: Math.floor(Date.now() / 1000) + ttlSeconds })).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const signing = `${header}.${payload}`;
    const sig = crypto.createHmac('sha256', secret).update(signing).digest('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    return `${signing}.${sig}`;
  }

  // Refresh token helpers: generate, validate, revoke. Refresh tokens are
  // opaque to clients and stored hashed server-side (using hashToken).
  async function generateRefreshTokenForUser(userId: string, ttlSeconds?: number) {
    const ttl = typeof ttlSeconds === 'number' ? ttlSeconds : parseInt(process.env.WORLDCORE_REFRESH_TOKEN_TTL_SECONDS || String(30 * 24 * 60 * 60), 10);
    const raw = crypto.randomBytes(48).toString('hex');
    const hashed = hashToken(raw);
    const now = Date.now();
    try {
      const user = await persistence.loadUser(userId) || { meta: {} };
      const meta = user.meta || {};
      const tokens = Array.isArray(meta.refreshTokens) ? meta.refreshTokens : [];
      tokens.push({ id: hashed, createdAt: now, expiresAt: now + ttl * 1000 });
      meta.refreshTokens = tokens;
      await persistence.saveUser(userId, { provider: user.provider ?? null, apiKey: user.apiKey ?? null, meta });
      return raw;
    } catch (e) {
      // Do not expose internal errors to client
      try { logger.warn('auth.refresh_generate_failed', { user: userId, err: e instanceof Error ? e.message : String(e) }); } catch (e) {}
      return null;
    }
  }

  async function validateRefreshTokenForUser(userId: string, rawToken: string) {
    try {
      const user = await persistence.loadUser(userId);
      if (!user || !user.meta || !Array.isArray(user.meta.refreshTokens)) return { ok: false };
      const hashed = hashToken(rawToken);
      const now = Date.now();
      for (const t of user.meta.refreshTokens) {
        if (t.id === hashed) {
          if (t.expiresAt && Number(t.expiresAt) < now) return { ok: false, expired: true };
          return { ok: true, tokenEntry: t };
        }
      }
      return { ok: false };
    } catch (e) {
      return { ok: false };
    }
  }

  async function revokeRefreshTokenForUser(userId: string, rawToken?: string) {
    try {
      const user = await persistence.loadUser(userId);
      if (!user || !user.meta) return false;
      const meta = user.meta || {};
      if (!Array.isArray(meta.refreshTokens) || meta.refreshTokens.length === 0) return true;
      if (!rawToken) {
        // revoke all
        meta.refreshTokens = [];
        await persistence.saveUser(userId, { provider: user.provider ?? null, apiKey: user.apiKey ?? null, meta });
        return true;
      }
      const hashed = hashToken(rawToken);
      const newTokens = (meta.refreshTokens || []).filter((t: any) => t.id !== hashed);
      meta.refreshTokens = newTokens;
      await persistence.saveUser(userId, { provider: user.provider ?? null, apiKey: user.apiKey ?? null, meta });
      return true;
    } catch (e) {
      try { logger.warn('auth.refresh_revoke_failed', { user: userId, err: e instanceof Error ? e.message : String(e) }); } catch (e) {}
      return false;
    }
  }

  // Validate an OpenAI API key by calling a lightweight endpoint. Returns
  // { ok: true } when valid, otherwise returns { ok: false, status, code, message }
  async function validateOpenAiKey(key: string) {
    try {
      const res = await fetch('https://api.openai.com/v1/models', {
        method: 'GET',
        headers: { Authorization: `Bearer ${key}` },
      });
      if (res.ok) return { ok: true };
      const txt = await res.text();
      let code = 'K_OPENAI_ERROR';
      if (res.status === 401) code = 'K_OPENAI_INVALID';
      if (res.status === 429) code = 'K_OPENAI_RATE_LIMIT';
      return { ok: false, status: res.status, code, message: String(txt).slice(0, 200) };
    } catch (err) {
      return { ok: false, code: 'K_NETWORK', message: err instanceof Error ? err.message : String(err) };
    }
  }

  // Extract requester identity from headers. Returns a string id when
  // available (JWT sub or api-key sentinel). Returns undefined when no
  // authenticated identity is present. Note: requireAuth must be called
  // first for endpoints that require authentication - this helper simply
  // extracts the identity when present and valid.
  function getRequesterId(req: http.IncomingMessage): string | undefined {
    const apiKey = process.env.WORLDCORE_API_KEY;
    const jwtSecret = process.env.WORLDCORE_JWT_SECRET;
    try {
      const keyHdr = req.headers['x-api-key'] as string | undefined;
      if (keyHdr && apiKey && keyHdr === apiKey) return 'api-key';
      const auth = String(req.headers['authorization'] || '');
      if (auth.toLowerCase().startsWith('bearer ') && jwtSecret) {
        const tok = auth.split(' ')[1];
        try {
          const payload = verifyJwtHs256(tok, jwtSecret);
          return (payload && (payload.sub ?? payload.sub)) || undefined;
        } catch (err) {
          return undefined;
        }
      }
    } catch (e) {
      // ignore
    }
    return undefined;
  }

  function authConfigured(): boolean {
    return Boolean(process.env.WORLDCORE_API_KEY || process.env.WORLDCORE_JWT_SECRET);
  }

  function hasModifyPermission(universeObj: any, actorId?: string): boolean {
    // If no auth configured, allow (legacy/dev behavior)
    if (!authConfigured()) return true;
    if (!actorId) return false;
    if (actorId === 'api-key') return true;
    try {
      if (typeof universeObj.getOwner === 'function' && universeObj.getOwner() === actorId) return true;
      if (typeof universeObj.listMembers === 'function') {
        const mems = universeObj.listMembers();
        for (const m of mems) {
          if (m.userId === actorId && (m.role === 'editor' || m.role === 'admin' || m.role === 'owner')) return true;
        }
      }
    } catch (e) {
      // ignore and deny
    }
    return false;
  }

  function hasOwnerPermission(universeObj: any, actorId?: string): boolean {
    if (!authConfigured()) return true;
    if (!actorId) return false;
    if (actorId === 'api-key') return true;
    try {
      if (typeof universeObj.getOwner === 'function' && universeObj.getOwner() === actorId) return true;
      if (typeof universeObj.listMembers === 'function') {
        const mems = universeObj.listMembers();
        for (const m of mems) {
          if (m.userId === actorId && (m.role === 'owner' || m.role === 'admin')) return true;
        }
      }
    } catch (e) {}
    return false;
  }

  // Helper: try to detect a character id from a message or explicit actorId
  function detectActorIdFromMessage(snapU: any, message: string, explicitActorId?: string): string | undefined {
    if (explicitActorId) return explicitActorId;
    if (!message) return undefined;
    // try `Act as <token>` pattern first
    try {
      const m = /Act as\s+([\w-]+)/i.exec(message);
      if (m && m[1]) {
        const token = m[1];
        const chars = snapU.listCharacters();
        for (const c of chars) {
          if (c.id === token) return c.id;
          if ((c.name || '').toLowerCase() === token.toLowerCase()) return c.id;
        }
      }
    } catch (e) {
      // ignore
    }

    // fallback: try to match by character name as whole word
    try {
      const chars = snapU.listCharacters();
      for (const c of chars) {
        const name = (c.name || '').replace(/[.*+?^${}()|[\\]\\]/g, '\\$&');
        const re = new RegExp(`\\b${name}\\b`, 'i');
        if (re.test(message)) return c.id;
      }
    } catch (e) {
      // ignore
    }

    return undefined;
  }

  function buildUniverseContext(snapshot: any, events: any[], maxEvents = 6) {
    const chars = (snapshot.characters ?? []).map((c: any) => `- ${c.name} (${c.id})${c.description ? `: ${c.description}` : ''}`).join('\n');
    const recent = (events || []).slice(-maxEvents).map((e: any) => `- [${e.timestamp}] ${e.type}: ${JSON.stringify(e.payload)}`).join('\n');
    const attrs = snapshot.attributes ? JSON.stringify(snapshot.attributes) : 'none';
    return `Universe: ${snapshot.name} (id: ${snapshot.id})\nDescription: ${snapshot.description ?? 'none'}\nAttributes: ${attrs}\nCharacters:\n${chars || '- none'}\nRecent events:\n${recent || '- none'}\n`;
  }

  // Compact messages to avoid sending enormous contexts to the AI provider.
  // This keeps the most recent messages and inserts a system note when older
  // content is omitted. The charLimit is conservative (in characters) — you
  // can adjust it according to model limits. We operate on message.content
  // lengths as an approximation for token usage.
  function compactMessages(messages: Array<any>, charLimit = 120000): Array<any> {
    try {
      if (!messages || !messages.length) return messages;
      let total = 0;
      for (const m of messages) total += String(m.content || '').length;
      if (total <= charLimit) return messages;
      const out: Array<any> = [];
      let acc = 0;
      // keep the most recent messages until we hit the limit
      for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i];
        const len = String(m.content || '').length;
        if (acc + len > charLimit) {
          out.unshift({ role: 'system', content: '... older content truncated due to length ...' });
          break;
        }
        out.unshift(m);
        acc += len;
      }
      return out;
    } catch (e) {
      return messages;
    }
  }

  function requireAuth(req: http.IncomingMessage, res: http.ServerResponse): boolean {
    // If no auth configured, allow all requests (legacy/dev behavior).
    const apiKey = process.env.WORLDCORE_API_KEY;
    const jwtSecret = process.env.WORLDCORE_JWT_SECRET;
    const required = Boolean(apiKey || jwtSecret);
    if (!required) return true;

    const header = (req.headers['x-api-key'] || req.headers['authorization']) as string | undefined;
    // Debug: log presence of auth headers (do not log full token)
    try {
      const authHdr = String(req.headers['authorization'] || '');
      logger.info('auth.check', { method: req.method, hasAuthHeader: !!authHdr, authPreview: authHdr ? authHdr.slice(0, 20) : '' });
    } catch (e) {}
    if (!header) {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'missing_credentials', code: 'AUTH_NO_HEADER' }));
      return false;
    }

    // API key header support (x-api-key or Authorization: ApiKey <key>)
    try {
      if (req.headers['x-api-key']) {
        const key = String(req.headers['x-api-key']);
        if (apiKey && key === apiKey) return true;
      }

      const auth = String(req.headers['authorization'] || '');
      if (auth.toLowerCase().startsWith('apikey ')) {
        const k = auth.split(' ')[1];
        if (apiKey && k === apiKey) return true;
      }

      // Bearer JWT support when WORLDCORE_JWT_SECRET is set
      if (auth.toLowerCase().startsWith('bearer ') && jwtSecret) {
        const tok = auth.split(' ')[1];
        try {
          logger.info('auth.verify_attempt', { method: req.method, tokenPreview: tok ? tok.slice(0, 12) : '' });
          verifyJwtHs256(tok, jwtSecret);
          logger.info('auth.verify_ok', { method: req.method });
          return true;
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          logger.info('auth.verify_failed', { err: errMsg });
          const lower = String(errMsg).toLowerCase();
          const code = lower.includes('expire') || lower.includes('expired') ? 'AUTH_JWT_EXPIRED' : 'AUTH_INVALID_JWT';
          res.writeHead(403, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'invalid_token', code, message: errMsg }));
          return false;
        }
      }
    } catch (err) {
      // fall through to invalid
    }

    res.writeHead(403, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'invalid_credentials', code: 'AUTH_INVALID' }));
    return false;
  }

  const server = http.createServer(async (req, res) => {
    const parsed = url.parse(req.url || '', true);
    const path = parsed.pathname || '/';

    // CORS
    const corsOrigin = process.env.WORLDCORE_CORS_ORIGIN || '*';
    res.setHeader('Access-Control-Allow-Origin', corsOrigin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');

    // Preflight
    if (req.method === 'OPTIONS') {
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS,DELETE');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization,x-api-key');
      res.setHeader('Access-Control-Max-Age', '86400');
      res.writeHead(204);
      res.end();
      return;
    }

    // --- Authentication helper endpoints (dev-friendly magic-link) ---
    if (req.method === 'POST' && path === '/api/auth/magic-link/send') {
      try {
        const body = await jsonBody(req);
        const email = body && body.email ? String(body.email).toLowerCase() : null;
        if (!email) {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'invalid_body', code: 'AUTH_INVALID_BODY' }));
          return;
        }
        // Rate limit by IP and by email to mitigate abuse
        try {
          const ipAddr = (req.socket && (req.socket.remoteAddress || (req.socket as any).remoteAddress)) || 'unknown';
          const rlIp = await checkRateLimit(String(ipAddr));
          if (!rlIp.ok) { res.setHeader('Retry-After', String(rlIp.retryAfter || 60)); res.writeHead(429, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'rate_limited' })); return; }
        } catch (e) { /* fail-open */ }
        try {
          const rlEmail = await checkEmailRateLimit(String(email));
          if (!rlEmail.ok) { res.setHeader('Retry-After', String(rlEmail.retryAfter || 60)); res.writeHead(429, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'rate_limited' })); return; }
        } catch (e) { /* fail-open */ }
        const token = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
        const ttlMs = parseInt(process.env.WORLDCORE_MAGIC_LINK_TTL_MS || String(15 * 60 * 1000), 10);
        const expiresAt = Date.now() + ttlMs;
        // Persist magic link when persistence supports it; fall back to in-memory store
        try {
          await persistence.saveMagicLink(token, { email, expiresAt });
          logger.info('auth.magic_link_persisted', { tokenPreview: token.slice(0, 8), email });
        } catch (e) {
          magicLinkStore.set(token, { email, expiresAt });
          logger.info('auth.magic_link_generated', { tokenPreview: token.slice(0, 8), email, fallback: true });
        }
        if (process.env.WORLDCORE_ALLOW_DEV_MAGIC_LINK === '1') {
          // In dev mode return the token so the developer can complete the flow.
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: true, devToken: token }));
          return;
        }

        // If SMTP is configured, attempt to send the magic-link email. Use a
        // lazy import so we don't require nodemailer in environments that don't
        // have it installed (tests/dev). If SMTP not configured, return ok as
        // a passive response (previous behavior).
        const smtpHost = process.env.WORLDCORE_SMTP_HOST;
        if (smtpHost) {
          try {
            const nodemailer = await import('nodemailer');
            const smtpPort = parseInt(process.env.WORLDCORE_SMTP_PORT || '587', 10);
            const smtpSecure = String(process.env.WORLDCORE_SMTP_SECURE || 'false') === 'true' || process.env.WORLDCORE_SMTP_SECURE === '1';
            const smtpUser = process.env.WORLDCORE_SMTP_USER;
            const smtpPass = process.env.WORLDCORE_SMTP_PASS;
            const fromAddr = process.env.WORLDCORE_SMTP_FROM || `WorldCore <no-reply@localhost>`;
            const transportOpts: any = { host: smtpHost, port: smtpPort, secure: smtpSecure };
            if (smtpUser) transportOpts.auth = { user: smtpUser, pass: smtpPass };
            const transporter = nodemailer.createTransport(transportOpts as any);

            const externalBase = process.env.WORLDCORE_EXTERNAL_URL || `http://localhost:${PORT}`;
            const verifyUrl = `${externalBase.replace(/\/$/, '')}/api/auth/magic-link/verify?token=${encodeURIComponent(token)}`;
            const ttlMin = Math.round((parseInt(process.env.WORLDCORE_MAGIC_LINK_TTL_MS || String(15 * 60 * 1000), 10) / 60000));
            const subject = 'Your WorldCore magic link';
            const text = `Hello,\n\nUse this link to sign in: ${verifyUrl}\n\nThis link expires in approximately ${ttlMin} minutes.\n`;
            const html = `<p>Hello,</p><p>Use this link to sign in: <a href="${verifyUrl}">${verifyUrl}</a></p><p>This link expires in approximately ${ttlMin} minutes.</p>`;

            const info = await transporter.sendMail({ from: fromAddr, to: email, subject, text, html });
            try { logger.info('auth.magic_link_sent', { email, messageId: info && (info as any).messageId ? (info as any).messageId : undefined }); } catch (e) {}
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ ok: true }));
            return;
          } catch (err) {
            // Sending failed — attempt to remove persisted token and report error.
            try { await persistence.deleteMagicLink(token); } catch (e) {}
            res.writeHead(500, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: 'send_failed', message: err instanceof Error ? err.message : String(err) }));
            return;
          }
        }

        // Production without SMTP configured: return generic ok (legacy behavior).
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
        return;
      } catch (e) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'send_failed' }));
        return;
      }
    }

    if (req.method === 'GET' && path === '/api/auth/magic-link/verify') {
      try {
        const token = String(parsed.query?.token || '');
        if (!token) {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'missing_token', code: 'AUTH_MISSING_TOKEN' }));
          return;
        }
        // Try loading from persistence first (if available), otherwise fall
        // back to the in-memory store used in dev/test.
        let rec = undefined;
        try {
          rec = await persistence.loadMagicLink(token);
        } catch (e) {
          rec = undefined;
        }
        if (!rec) {
          rec = magicLinkStore.get(token);
        }
        if (!rec) {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'invalid_token', code: 'AUTH_INVALID_MAGIC' }));
          return;
        }
        if (Date.now() > rec.expiresAt) {
          // remove from both stores if present
          try { await persistence.deleteMagicLink(token); } catch (e) {}
          magicLinkStore.delete(token);
          res.writeHead(403, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'token_expired', code: 'AUTH_MAGIC_EXPIRED' }));
          return;
        }
        // Issue JWT for this email (dev flow). In production this should map
        // to an internal user id and perform additional checks.
        const secret = process.env.WORLDCORE_JWT_SECRET;
        if (!secret) {
          res.writeHead(500, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'server_config', code: 'AUTH_NO_SECRET' }));
          return;
        }
        const ttl = parseInt(process.env.WORLDCORE_JWT_TTL_SECONDS || String(7 * 24 * 60 * 60), 10);
        const jwt = signJwt(rec.email, secret, ttl);
        // consume token: remove from persistence and fallback store
        try { await persistence.deleteMagicLink(token); } catch (e) {}
        magicLinkStore.delete(token);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, token: jwt, expiresIn: ttl }));
        return;
      } catch (e) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'verify_failed' }));
      return;
      }
    }

    // Local register/login (simple PBKDF2 password hashing). Returns JWT on success.
    if (req.method === 'POST' && path === '/api/auth/register') {
      try {
        // Apply rate limiting to registration endpoint to reduce abuse risk.
        const ipAddr = (req.socket && (req.socket.remoteAddress || (req.socket as any).remoteAddress)) || 'unknown';
        try {
          const rl = await checkRateLimit(String(ipAddr));
          if (!rl.ok) { res.setHeader('Retry-After', String(rl.retryAfter || 60)); res.writeHead(429, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'rate_limited' })); return; }
        } catch (e) {
          // on rate limiter failure, allow request to proceed (fail-open)
        }

        const body = await jsonBody(req);
        const id = body && body.id ? String(body.id) : null;
        const password = body && body.password ? String(body.password) : null;
        if (!id || !password) { res.writeHead(400, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'invalid_body' })); return; }
        // Check server secret
        const secret = process.env.WORLDCORE_JWT_SECRET;
        if (!secret) { res.writeHead(500, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'server_config', code: 'AUTH_NO_SECRET' })); return; }
        // ensure user does not exist
        const existing = await persistence.loadUser(id);
        if (existing) { res.writeHead(409, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'user_exists' })); return; }
        // hash password (prefer Argon2 when available; fallback to PBKDF2)
        const hashInfo = await hashPassword(String(password));
        const metaToStore: any = { ...(hashInfo.algo === 'pbkdf2' ? { passwordSalt: hashInfo.salt } : {}), passwordHash: hashInfo.hash, passwordAlgo: hashInfo.algo };
        await persistence.saveUser(id, { provider: null, apiKey: null, meta: metaToStore });
        const accessToken = signJwt(id, secret, parseInt(process.env.WORLDCORE_JWT_TTL_SECONDS || String(7 * 24 * 60 * 60), 10));
        // create refresh token for the user
        const refresh = await generateRefreshTokenForUser(id);
        const resp: any = { ok: true, id, token: accessToken };
        if (refresh) resp.refreshToken = refresh;
        res.writeHead(201, { 'content-type': 'application/json' });
        res.end(JSON.stringify(resp));
        return;
      } catch (e) { res.writeHead(500, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'failed' })); return; }
    }

    if (req.method === 'POST' && path === '/api/auth/login') {
      try {
        // Apply rate limiting to login attempts as well
        const ipAddr = (req.socket && (req.socket.remoteAddress || (req.socket as any).remoteAddress)) || 'unknown';
        try {
          const rl = await checkRateLimit(String(ipAddr));
          if (!rl.ok) { res.setHeader('Retry-After', String(rl.retryAfter || 60)); res.writeHead(429, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'rate_limited' })); return; }
        } catch (e) {
          // fail-open
        }

        const body = await jsonBody(req);
        const id = body && body.id ? String(body.id) : null;
        const password = body && body.password ? String(body.password) : null;
        if (!id || !password) { res.writeHead(400, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'invalid_body' })); return; }
        const secret = process.env.WORLDCORE_JWT_SECRET;
        if (!secret) { res.writeHead(500, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'server_config', code: 'AUTH_NO_SECRET' })); return; }
        const user = await persistence.loadUser(id);
        if (!user || !user.meta || !user.meta.passwordHash) { res.writeHead(403, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'invalid_credentials' })); return; }

        // Account lockout check (per-account): if lockoutExpiresAt present and in future, reject immediately.
        try {
          const meta = user.meta || {};
          const lockoutExpires = meta.lockoutExpiresAt ? Number(meta.lockoutExpiresAt) : 0;
          if (lockoutExpires && Date.now() < lockoutExpires) {
            const retryAfter = Math.max(0, Math.ceil((lockoutExpires - Date.now()) / 1000));
            res.setHeader('Retry-After', String(retryAfter));
            res.writeHead(403, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: 'account_locked', code: 'ACCOUNT_LOCKED', retryAfter }));
            return;
          }
        } catch (e) {
          // ignore lockout check errors and proceed
        }
        // Verify password using stored algo (argon2 preferred; pbkdf2 legacy)
        const verifyRes = await verifyPassword(String(password), user.meta || {});
        if (!verifyRes.ok) {
          // Update failed attempt counters and potentially lock the account.
          try {
            const meta = user.meta || {};
            const now = Date.now();
            const maxAttempts = process.env.WORLDCORE_LOCKOUT_MAX_ATTEMPTS ? parseInt(process.env.WORLDCORE_LOCKOUT_MAX_ATTEMPTS, 10) : 5;
            const windowMs = process.env.WORLDCORE_LOCKOUT_WINDOW_MS ? parseInt(process.env.WORLDCORE_LOCKOUT_WINDOW_MS, 10) : 15 * 60 * 1000;
            const lockoutDuration = process.env.WORLDCORE_LOCKOUT_DURATION_MS ? parseInt(process.env.WORLDCORE_LOCKOUT_DURATION_MS, 10) : 15 * 60 * 1000;
            let failedCount = Number(meta.failedLoginCount || 0);
            const lastFailed = Number(meta.lastFailedAt || 0);
            if (!lastFailed || (now - lastFailed) > windowMs) {
              failedCount = 1;
            } else {
              failedCount = failedCount + 1;
            }
            meta.failedLoginCount = failedCount;
            meta.lastFailedAt = now;
            if (failedCount >= maxAttempts) {
              meta.lockoutExpiresAt = now + lockoutDuration;
            }
            await persistence.saveUser(id, { provider: user.provider ?? null, apiKey: user.apiKey ?? null, meta });
            if (meta.lockoutExpiresAt) {
              const retryAfter = Math.max(0, Math.ceil((Number(meta.lockoutExpiresAt) - Date.now()) / 1000));
              res.setHeader('Retry-After', String(retryAfter));
              res.writeHead(403, { 'content-type': 'application/json' });
              res.end(JSON.stringify({ error: 'account_locked', code: 'ACCOUNT_LOCKED', retryAfter }));
              return;
            }
          } catch (e) {
            try { logger.warn('auth.lock_update_failed', { user: id, err: e instanceof Error ? e.message : String(e) }); } catch (e) {}
          }
          res.writeHead(403, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'invalid_credentials' }));
          return;
        }

        // If we verified against PBKDF2 and Argon2 is available, re-hash the
        // password with Argon2 and update the persisted user record (migration).
        try {
          if (verifyRes.algoUsed === 'pbkdf2') {
            const argonAvail = await isArgon2Available();
            if (argonAvail) {
              const newHashInfo = await hashPassword(String(password));
              const newMeta = { ...(user.meta || {}), passwordHash: newHashInfo.hash, passwordAlgo: newHashInfo.algo };
              if (newHashInfo.salt) newMeta.passwordSalt = newHashInfo.salt; else delete newMeta.passwordSalt;
              // On successful login, clear failed counters and update hash atomically.
              try {
                newMeta.failedLoginCount = 0;
                delete newMeta.lastFailedAt;
                delete newMeta.lockoutExpiresAt;
              } catch (e) {}
              await persistence.saveUser(id, { provider: user.provider ?? null, apiKey: user.apiKey ?? null, meta: newMeta });
            }
          }
        } catch (e) {
          // Migration should not block login; log and continue
          try { logger.warn('auth.rehash_failed', { user: id, err: e instanceof Error ? e.message : String(e) }); } catch (e) {}
        }

        // On successful login, clear failed attempt counters if present
        try {
          const meta = user.meta || {};
          if (meta.failedLoginCount || meta.lastFailedAt || meta.lockoutExpiresAt) {
            const newMeta = { ...(meta || {}) };
            newMeta.failedLoginCount = 0;
            delete newMeta.lastFailedAt;
            delete newMeta.lockoutExpiresAt;
            await persistence.saveUser(id, { provider: user.provider ?? null, apiKey: user.apiKey ?? null, meta: newMeta });
          }
        } catch (e) {
          try { logger.warn('auth.clear_failed_failed', { user: id, err: e instanceof Error ? e.message : String(e) }); } catch (e) {}
        }

        const accessToken = signJwt(id, secret, parseInt(process.env.WORLDCORE_JWT_TTL_SECONDS || String(7 * 24 * 60 * 60), 10));
        // rotate refresh token: generate a new one to replace the used token
        const newRefresh = await generateRefreshTokenForUser(id);
        const resp: any = { ok: true, id, token: accessToken };
        if (newRefresh) resp.refreshToken = newRefresh;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(resp));
        return;
      } catch (e) { res.writeHead(500, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'failed' })); return; }
    }

    // Rate limiting per IP (optional)
    const ip = (req.socket && (req.socket.remoteAddress || (req.socket as any).remoteAddress)) || 'unknown';
    const rl = await checkRateLimit(String(ip));
    if (!rl.ok) {
      res.setHeader('Retry-After', String(rl.retryAfter || 60));
      res.writeHead(429, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'rate_limited' }));
      return;
    }

    try {
      // swagger/openapi JSON
      if (req.method === 'GET' && path === '/openapi.json') {
          const openapi = {
            openapi: '3.0.0',
            info: { title: 'WorldCore API', version: '0.1.0' },
            paths: {
              '/api/universes': { get: { summary: 'List universes' } },
              '/api/models': { get: { summary: 'List model aliases' }, post: { summary: 'Create model alias', security: [{ ApiKeyAuth: [] }] } },
              '/api/models/{id}': { get: { summary: 'Get model alias' }, put: { summary: 'Update model alias', security: [{ ApiKeyAuth: [] }] }, delete: { summary: 'Delete model alias', security: [{ ApiKeyAuth: [] }] } },
              '/api/universe/{id}': { get: { summary: 'Get universe snapshot' } },
              '/api/universe': { post: { summary: 'Create universe', security: [{ ApiKeyAuth: [] }, { bearerAuth: [] }] } },
              '/api/universe/{id}/character': { post: { summary: 'Add character', security: [{ ApiKeyAuth: [] }, { bearerAuth: [] }] } },
              '/api/universe/{id}/ai': { post: { summary: 'Ask AI scoped to universe' } },
              '/api/ai': { post: { summary: 'Ask AI (global, optional universeId in body)' } },
            },
            components: {
            securitySchemes: {
              ApiKeyAuth: { type: 'apiKey', in: 'header', name: 'x-api-key' },
              bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
            },
            },
          };
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(openapi));
        return;
      }

      // Model aliases CRUD (file-backed registry)
      if (req.method === 'GET' && path === '/api/models') {
        try {
          const regs = await import('../models/registry.js');
          const list = await regs.listAliases();
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify(list));
          return;
        } catch (e) { res.writeHead(500, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'failed' })); return; }
      }

      if (req.method === 'GET' && path?.startsWith('/api/models/')) {
        const id = path.replace('/api/models/', '');
        try {
          const regs = await import('../models/registry.js');
          const entry = await regs.getAlias(id);
          if (!entry) { res.writeHead(404, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'not found' })); return; }
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify(entry));
          return;
        } catch (e) { res.writeHead(500, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'failed' })); return; }
      }

      if (req.method === 'POST' && path === '/api/models') {
        if (!requireAuth(req, res)) return;
        const actor = getRequesterId(req);
        if (actor !== 'api-key') { res.writeHead(403, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'forbidden' })); return; }
        try {
          const body = await jsonBody(req);
          if (!body || !body.id || !body.model) { res.writeHead(400, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'invalid body' })); return; }
          const regs = await import('../models/registry.js');
          await regs.saveAlias(String(body.id), { model: String(body.model), description: body.description ? String(body.description) : undefined });
          res.writeHead(201, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
          return;
        } catch (e) { res.writeHead(500, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'failed' })); return; }
      }

      if ((req.method === 'PUT' || req.method === 'DELETE') && path?.startsWith('/api/models/')) {
        if (!requireAuth(req, res)) return;
        const actor = getRequesterId(req);
        if (actor !== 'api-key') { res.writeHead(403, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'forbidden' })); return; }
        const id = path.replace('/api/models/', '');
        try {
          const regs = await import('../models/registry.js');
          if (req.method === 'PUT') {
            const body = await jsonBody(req);
            if (!body || !body.model) { res.writeHead(400, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'invalid body' })); return; }
            await regs.saveAlias(id, { model: String(body.model), description: body.description ? String(body.description) : undefined });
            res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: true })); return;
          } else {
            await regs.deleteAlias(id);
            res.writeHead(204); res.end(); return;
          }
        } catch (e) { res.writeHead(500, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'failed' })); return; }
      }

    if (req.method === 'GET' && path === '/docs') {
        // simple swagger-ui from CDN
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(`<!doctype html><html><head><meta charset="utf-8"><title>API Docs</title>
<link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist/swagger-ui.css" /></head>
<body><div id="swagger"></div>
<script src="https://unpkg.com/swagger-ui-dist/swagger-ui-bundle.js"></script>
<script>window.onload=function(){SwaggerUIBundle({url:'/openapi.json',dom_id:'#swagger'});}</script>
</body></html>`);
        return;
      }
    if (req.method === 'GET' && path === '/play') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      const playHtml = String.raw`<!doctype html><html><head><meta charset="utf-8"><title>WorldCore Play</title>
<link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.2/dist/css/bootstrap.min.css" rel="stylesheet">
<style>
body{padding:1rem}
#layout{display:flex;gap:1rem}
#sidebar{flex:1;border:1px solid #ddd;padding:1rem;border-radius:6px}
#main{flex:2;border:1px solid #ddd;padding:1rem;border-radius:6px}
pre{background:#f7f7f7;padding:.5rem;overflow:auto;white-space:pre-wrap}
body.dark{background:#111;color:#eee}
body.dark pre{background:#222;color:#ddd}
.settings-panel{position:fixed;right:1rem;top:4rem;width:320px;z-index:1000}
</style></head><body>
<nav class="navbar navbar-light bg-light mb-3">
    <div class="container-fluid">
      <span id="navBrand" class="navbar-brand">WorldCore — Play</span>
      <div class="d-flex align-items-center">
      <span id="aiStatus" class="badge bg-secondary me-2">AI: Desconocido</span>
      <button id="themeToggle" class="btn btn-outline-secondary me-2" title="Toggle theme">🌓</button>
      <button id="openSettings" class="btn btn-primary">Settings</button>
    </div>
  </div>
  </nav>
  <div id="alerts" class="position-fixed top-0 end-0 p-3" style="z-index:1050"></div>
<div id="layout">
  <div id="sidebar">
    <div class="mb-2">
      <label id="labelUniverse" class="form-label">Universo</label>
      <select id="universeSelect" class="form-select"></select>
    </div>
    <div class="mb-2"><button id="loadBtn" class="btn btn-sm btn-secondary">Cargar</button></div>
    <div class="mb-2"><button id="openLogViewer" class="btn btn-sm btn-outline-info">Logs</button></div>
    <hr/>
    <h5 id="charsHeader">Personajes</h5>
    <ul id="chars" class="list-unstyled"></ul>
    <hr/>
    <div class="form-check"><input type="checkbox" id="autoRefresh" class="form-check-input"/><label id="autoRefreshLabel" class="form-check-label">Auto-refresh</label></div>
  </div>
  <div id="main">
    <h5 id="timelineTitle">Timeline (últimos eventos)</h5>
    <div id="eventsContainer" style="max-height:320px;overflow:auto;border:1px solid #eee;padding:.5rem;border-radius:4px;background:#fafafa">
      <ul id="events" class="list-unstyled mb-0"><li class="text-muted">- seleccione un universo -</li></ul>
    </div>
    <!-- Log viewer: minimal timelapse/log playback for events -->
    <div id="logViewer" style="display:none;margin-top:1rem;border:1px solid #eee;padding:.5rem;border-radius:4px;background:#fff;">
      <div class="d-flex align-items-center mb-2">
        <label class="me-2" for="logFilter">Filter</label>
        <select id="logFilter" class="form-select form-select-sm me-2" style="width:auto;">
          <option value="">All</option>
          <option value="ai_response">AI Response</option>
          <option value="character_memory">Character Memory</option>
          <option value="universe_visibility_changed">Visibility</option>
          <option value="owner_assigned">Owner Assigned</option>
        </select>
        <button id="playLog" class="btn btn-sm btn-outline-primary me-1">Play</button>
        <button id="pauseLog" class="btn btn-sm btn-outline-secondary me-1">Pause</button>
        <button id="stepLog" class="btn btn-sm btn-outline-secondary me-1">Step</button>
        <input id="logSpeed" type="number" class="form-control form-control-sm" value="1000" style="width:90px;" />ms
      </div>
      <div style="max-height:240px;overflow:auto;border-top:1px solid #eee;padding-top:.5rem;"><ul id="logList" class="list-unstyled mb-0"><li class="text-muted">- no logs -</li></ul></div>
    </div>
    <div id="visibilityContainer" class="mb-2" style="display:none">
      <div class="form-check">
        <input class="form-check-input" type="checkbox" id="publicToggle" />
        <label class="form-check-label">Make world public (visible in lists)</label>
      </div>
    </div>

    <h5 id="interactTitle" class="mt-3">Interactuar</h5>
    <div class="mb-2">
      <label id="charLabel" class="form-label">Personaje</label>
      <select id="charSelect" class="form-select"></select>
    </div>
    <div class="mb-2">
      <textarea id="prompt" class="form-control" rows="4" placeholder="Escribe un mensaje para el personaje..."></textarea>
    </div>
    <div class="mb-3"><button id="send" class="btn btn-success">Enviar</button></div>
    <h6>Respuesta AI</h6>
    <pre id="aiOut">- ninguna -</pre>
  </div>
</div>

<div id="settingsPanel" class="card settings-panel" style="display:none">
  <div class="card-body">
    <h6 id="settingsTitle" class="card-title">Settings</h6>
    <div class="mb-2">
      <label id="jwtLabel" class="form-label">JWT (Authorization)</label>
      <input id="jwtInput" class="form-control" placeholder="Paste JWT here" />
      <div class="mt-2"><button id="saveJwt" class="btn btn-sm btn-primary">Save token</button> <button id="clearJwt" class="btn btn-sm btn-outline-secondary">Clear</button></div>
    </div>
    <hr/>
    <div class="mb-2">
      <h6>Account</h6>
      <div class="mb-2">
        <div class="mb-1"><label class="form-label">Register</label>
          <input id="regId" class="form-control mb-1" placeholder="user id or email" />
          <input id="regPassword" type="password" class="form-control mb-1" placeholder="Password" />
          <div class="mt-1"><button id="registerBtn" class="btn btn-sm btn-success">Register</button></div>
        </div>
        <div class="mb-1"><label class="form-label">Login</label>
          <input id="loginId" class="form-control mb-1" placeholder="user id or email" />
          <input id="loginPassword" type="password" class="form-control mb-1" placeholder="Password" />
          <div class="mt-1"><button id="loginBtn" class="btn btn-sm btn-primary">Login</button></div>
        </div>
      </div>

      <div class="mb-2 border-top pt-2">
        <h6>Session</h6>
        <div class="mb-2">
          <div class="mb-1"><strong>User:</strong> <span id="currentUserId">-</span></div>
          <div class="mb-1"><label class="form-label">Refresh Token</label>
            <input id="refreshTokenInput" class="form-control mb-1" placeholder="No refresh token stored" readonly />
          </div>
          <div class="d-flex gap-2">
            <button id="refreshBtn" class="btn btn-sm btn-outline-primary">Refresh Access</button>
            <button id="revokeBtn" class="btn btn-sm btn-outline-danger">Revoke Tokens</button>
            <button id="logoutBtn" class="btn btn-sm btn-secondary">Logout</button>
          </div>
          <div class="mt-2"><small id="authStatus" class="text-muted"></small></div>
        </div>
      </div>

    </div>
    <hr/>
    <div class="mb-2">
      <label id="aiKeyLabel" class="form-label">Your AI Key (private)</label>
      <select id="userProvider" class="form-select mb-1"><option value="openai">OpenAI</option></select>
      <input id="userApiKey" class="form-control mb-1" placeholder="sk-..." />
      <input id="userModel" class="form-control mb-1" placeholder="Optional model override" />
      <div class="mt-2"><button id="saveUserKey" class="btn btn-sm btn-success">Save key</button></div>
      <div class="mt-2"><small id="userKeyStatus" class="text-muted"></small></div>
    </div>
    <div class="mb-2">
      <label id="langLabel" class="form-label">Idioma</label>
      <select id="langSelect" class="form-select mb-1"><option value="es">Español</option><option value="en">English</option></select>
    </div>
    <hr/>
    <div>
      <label id="themeLabel" class="form-label">Theme</label>
      <div class="mt-1"><button id="themeLight" class="btn btn-sm btn-light">Light</button> <button id="themeDark" class="btn btn-sm btn-dark">Dark</button></div>
    </div>
</div>
</div>

<!-- Character detail modal (simple overlay, no bootstrap JS) -->
<div id="charModalOverlay" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,0.4);z-index:1060;">
  <div id="charModal" class="card" style="position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);width:520px;max-width:95%;">
    <div class="card-body">
      <h5 id="charModalTitle" class="card-title">Character</h5>
      <div id="charModalBody"></div>
      <hr/>
      <div id="charEvents"></div>
      <div class="mt-2 text-end"><button id="charModalClose" class="btn btn-sm btn-secondary me-2">Close</button><button id="charModalEdit" class="btn btn-sm btn-primary">Edit</button></div>
    </div>
  </div>
</div>

<script>
async function api(path, opts){
  opts = opts || {};
  const headers = Object.assign({}, opts.headers || {});
  const token = localStorage.getItem('wc_jwt');
  if (token) headers['authorization'] = 'Bearer ' + token;
  const res = await fetch(path, Object.assign({}, opts, { headers }));
  return res;
}

// Simple client-side i18n dictionary (ES/EN) and helper. Keys are small
// and intentionally minimal for the /play UI. Use t(key, vars) to obtain
// a translated string; vars is an optional object for {placeholders}.
const I18N = {
    es: {
    nav_brand: 'WorldCore — Play',
    load: 'Cargar',
    universe_label: 'Universo',
    characters: 'Personajes',
    auto_refresh: 'Auto-refresh',
    timeline_title: 'Timeline (últimos eventos)',
    interact_title: 'Interactuar',
    prompt_placeholder: 'Escribe un mensaje para el personaje...',
    send: 'Enviar',
    ai_none: '- seleccione un universo -',
    settings: 'Ajustes',
    jwt_label: 'JWT (Authorization)',
    register: 'Registrar',
    login: 'Iniciar sesión',
    password_label: 'Contraseña',
    reg_id_placeholder: 'usuario o email',
    reg_password_placeholder: 'Contraseña',
    login_id_placeholder: 'usuario o email',
    login_password_placeholder: 'Contraseña',
    register_success: 'Registrado. Token guardado.',
    login_success: 'Sesión iniciada. Token guardado.',
    register_fail: 'Fallo en el registro',
    login_fail: 'Fallo al iniciar sesión',
    save_token: 'Guardar token',
    paste_valid_jwt: 'Pega un JWT válido',
    token_saved: 'Token guardado',
    token_cleared: 'Token borrado',
    your_ai_key: 'Tu clave AI (privada)',
    save_key: 'Guardar clave',
    key_saved: 'Clave guardada',
    key_saved_but_invalid: 'Clave guardada pero no válida (código: {code})',
    error_saving_key: 'Error al guardar la clave',
    enter_universe_id: 'Introduce id de universo',
    invalid_attributes_json: 'Atributos JSON inválidos',
    created: 'Creado',
    deleted: 'Eliminado',
    cloned: 'Clonado',
    added: 'Añadido',
    universe_character_message_required: 'Seleccione universo, personaje y escriba un mensaje',
    char_label: 'Personaje',
    not_authenticated: 'No autenticado. Guarda tu token para usar funciones personales',
    jwt_expired: 'Tu token JWT ha expirado. Genera uno nuevo o vuelve a iniciar sesión.',
    jwt_expired_action: 'Genera un nuevo token con npm run cli -- gen-token <sub> o pide uno al administrador.',
    error_fetching_user_status: 'Error al obtener estado del usuario',
    failed_update_visibility: 'Fallo al actualizar la visibilidad',
    error_update_visibility: 'Error al actualizar la visibilidad',
    error_calling_ai: 'Error al llamar a la IA',
    ai_connected: 'AI: Conectado',
    ai_global: 'AI: Global',
    ai_disconnected: 'AI: Desconectado',
    ai_provider_configured: 'Proveedor AI configurado',
    ai_using_global: 'Usando proveedor global',
    error_generic: 'Error',
    ai_not_connected: 'No conectado',
    ver_mas: 'Ver más',
    session_title: 'Sesión',
    current_user: 'Usuario',
    refresh_token_label: 'Refresh Token',
    no_refresh_token: 'Sin refresh token guardado',
    refresh_button: 'Refresh Access',
    revoke_button: 'Revoke Tokens',
    logout_button: 'Logout',
    refresh_success: 'Access token renovado',
    refresh_fail: 'Fallo al renovar token',
    revoke_success: 'Tokens revocados',
    revoke_fail: 'Fallo al revocar tokens',
    account_locked: 'Cuenta bloqueada temporalmente. Intenta más tarde.',
    close: 'Cerrar',
    edit: 'Editar',
    aliases: 'Apodos',
    age: 'Edad',
    events_title: 'Eventos',
    view_event: 'Ver evento',
    edit_character: 'Editar personaje',
    no_events: 'Sin eventos',
    logs_button: 'Logs',
    log_filter: 'Filtro',
    log_play: 'Play',
    log_pause: 'Pause',
    log_step: 'Step',
    log_speed: 'Velocidad (ms)',
    no_logs: 'Sin logs',
    settings_button: 'Ajustes',
    language_label: 'Idioma',
    theme_label: 'Tema',
    theme_light: 'Claro',
    theme_dark: 'Oscuro',
  },
  en: {
    nav_brand: 'WorldCore — Play',
    load: 'Load',
    universe_label: 'Universe',
    characters: 'Characters',
    auto_refresh: 'Auto-refresh',
    timeline_title: 'Timeline (recent events)',
    interact_title: 'Interact',
    prompt_placeholder: 'Write a message to the character...',
    send: 'Send',
    ai_none: '- none -',
    settings: 'Settings',
    jwt_label: 'JWT (Authorization)',
    register: 'Register',
    login: 'Login',
    password_label: 'Password',
    reg_id_placeholder: 'user id or email',
    reg_password_placeholder: 'Password',
    login_id_placeholder: 'user id or email',
    login_password_placeholder: 'Password',
    register_success: 'Registered. Token saved.',
    login_success: 'Logged in. Token saved.',
    register_fail: 'Registration failed',
    login_fail: 'Login failed',
    save_token: 'Save token',
    paste_valid_jwt: 'Please paste a valid JWT token',
    token_saved: 'Token saved',
    token_cleared: 'Token cleared',
    your_ai_key: 'Your AI Key (private)',
    save_key: 'Save key',
    key_saved: 'Key saved',
    key_saved_but_invalid: 'Key saved but invalid (code: {code})',
    error_saving_key: 'Error saving key',
    enter_universe_id: 'Enter universe id',
    invalid_attributes_json: 'Invalid attributes JSON',
    created: 'Created',
    deleted: 'Deleted',
    cloned: 'Cloned',
    added: 'Added',
    universe_character_message_required: 'Universe, character and message required',
    char_label: 'Character',
    not_authenticated: 'Not authenticated. Save your token to use personal features',
    jwt_expired: 'Your JWT token has expired. Generate a new one or sign in again.',
    jwt_expired_action: 'Generate a new token with npm run cli -- gen-token <sub> or contact your admin.',
    error_fetching_user_status: 'Error fetching user status',
    failed_update_visibility: 'Failed to update visibility',
    error_update_visibility: 'Error updating visibility',
    error_calling_ai: 'Error calling AI',
    ai_connected: 'AI: Connected',
    ai_global: 'AI: Global',
    ai_disconnected: 'AI: Disconnected',
    ai_provider_configured: 'AI provider configured',
    ai_using_global: 'Using global provider key',
    error_generic: 'Error',
    ai_not_connected: 'Not connected',
    ver_mas: 'View more',
    session_title: 'Session',
    current_user: 'User',
    refresh_token_label: 'Refresh Token',
    no_refresh_token: 'No refresh token stored',
    refresh_button: 'Refresh Access',
    revoke_button: 'Revoke Tokens',
    logout_button: 'Logout',
    refresh_success: 'Access token refreshed',
    refresh_fail: 'Failed to refresh token',
    revoke_success: 'Tokens revoked',
    revoke_fail: 'Failed to revoke tokens',
    account_locked: 'Account temporarily locked. Try later.',
    close: 'Close',
    edit: 'Edit',
    aliases: 'Aliases',
    age: 'Age',
    events_title: 'Events',
    view_event: 'View event',
    edit_character: 'Edit character',
    no_events: 'No events',
    logs_button: 'Logs',
    log_filter: 'Filter',
    log_play: 'Play',
    log_pause: 'Pause',
    log_step: 'Step',
    log_speed: 'Speed (ms)',
    no_logs: 'No logs',
    settings_button: 'Settings',
    language_label: 'Language',
    theme_label: 'Theme',
    theme_light: 'Light',
    theme_dark: 'Dark',
  }
};

    function t(key, vars) {
  try {
    const lang = localStorage.getItem('wc_lang') || 'es';
    const dict = I18N[lang] || I18N['es'];
    let s = dict[key] || I18N['en'][key] || key;
    if (vars) {
      for (const k in vars) {
        s = s.replace(new RegExp('\\{' + k + '\\}', 'g'), String(vars[k]));
      }
    }
    return s;
  } catch (e) {
    return key;
  }
}

// Lightweight Bootstrap-style alerts (no bootstrap JS required). Use
// showAlert(type, message) where type is one of: 'success','info','warning','danger'.
function showAlert(type, message, timeout) {
  try {
    const container = document.getElementById('alerts');
    if (!container) { window.alert(message); return; }
    const el = document.createElement('div');
    el.className = 'alert alert-' + (type || 'info') + ' alert-dismissible';
    el.setAttribute('role', 'alert');
    el.innerHTML = String(message) + ' <button type="button" class="btn-close" aria-label="Close"></button>';
    const btn = el.querySelector('.btn-close');
    if (btn) btn.addEventListener('click', () => el.remove());
    container.appendChild(el);
    const t = typeof timeout === 'number' ? timeout : 5000;
    setTimeout(() => { try { el.remove(); } catch (e) {} }, t);
  } catch (e) { try { window.alert(message); } catch (e) {} }
}

// Update the AI connection status indicator in the UI.
function updateAiStatus(state, provider, model, message, code) {
  try {
    const el = document.getElementById('aiStatus');
    if (!el) return;
    if (state === 'connected') {
      el.className = 'badge bg-success me-2';
      el.textContent = t('ai_connected') + (provider ? (' (' + provider + (model ? ' / ' + model : '') + ')') : '');
      el.title = t('ai_provider_configured');
      return;
    }
    if (state === 'global') {
      el.className = 'badge bg-warning text-dark me-2';
      el.textContent = t('ai_global') + (model ? (' (' + model + ')') : '');
      el.title = t('ai_using_global');
      return;
    }
    // disconnected / error
    el.className = 'badge bg-danger me-2';
    el.textContent = t('ai_disconnected');
    el.title = (message ? message : t('ai_not_connected')) + (code ? ' (' + code + ')' : '');
  } catch (e) {}
}

// Apply translations to visible UI elements based on selected language.
function applyTranslations() {
  try {
    const lang = localStorage.getItem('wc_lang') || 'es';
    const elNav = document.getElementById('navBrand'); if (elNav) elNav.textContent = t('nav_brand');
    const lblUni = document.getElementById('labelUniverse'); if (lblUni) lblUni.textContent = t('universe_label');
    const loadBtn = document.getElementById('loadBtn'); if (loadBtn) loadBtn.textContent = t('load');
    const charsH = document.getElementById('charsHeader'); if (charsH) charsH.textContent = t('characters');
    const arLbl = document.getElementById('autoRefreshLabel'); if (arLbl) arLbl.textContent = t('auto_refresh');
    const tl = document.getElementById('timelineTitle'); if (tl) tl.textContent = t('timeline_title');
    const it = document.getElementById('interactTitle'); if (it) it.textContent = t('interact_title');
    const cl = document.getElementById('charLabel'); if (cl) cl.textContent = t('char_label');
    const promptEl = document.getElementById('prompt'); if (promptEl) promptEl.placeholder = t('prompt_placeholder');
    const sendBtn = document.getElementById('send'); if (sendBtn) sendBtn.textContent = t('send');

    // Settings
    const settingsTitle = document.getElementById('settingsTitle'); if (settingsTitle) settingsTitle.textContent = t('settings');
    const jwtLabel = document.getElementById('jwtLabel'); if (jwtLabel) jwtLabel.textContent = t('jwt_label');
    const saveJwtBtn = document.getElementById('saveJwt'); if (saveJwtBtn) saveJwtBtn.textContent = t('save_token');
    const clearJwtBtn = document.getElementById('clearJwt'); if (clearJwtBtn) clearJwtBtn.textContent = t('token_cleared');
    const regIdEl = document.getElementById('regId'); if (regIdEl) regIdEl.placeholder = t('reg_id_placeholder');
    const regPassEl = document.getElementById('regPassword'); if (regPassEl) regPassEl.placeholder = t('reg_password_placeholder');
    const loginIdEl = document.getElementById('loginId'); if (loginIdEl) loginIdEl.placeholder = t('login_id_placeholder');
    const loginPassEl = document.getElementById('loginPassword'); if (loginPassEl) loginPassEl.placeholder = t('login_password_placeholder');
    const registerBtn = document.getElementById('registerBtn'); if (registerBtn) registerBtn.textContent = t('register');
    const loginBtn = document.getElementById('loginBtn'); if (loginBtn) loginBtn.textContent = t('login');
    const aiLabel = document.getElementById('aiKeyLabel'); if (aiLabel) aiLabel.textContent = t('your_ai_key');
    const saveKeyBtn = document.getElementById('saveUserKey'); if (saveKeyBtn) saveKeyBtn.textContent = t('save_key');
    const langLabel = document.getElementById('langLabel'); if (langLabel) langLabel.textContent = t('language_label');
    const langSel = document.getElementById('langSelect'); if (langSel) langSel.value = localStorage.getItem('wc_lang') || lang;
    const themeLbl = document.getElementById('themeLabel'); if (themeLbl) themeLbl.textContent = t('theme_label');
    const themeLight = document.getElementById('themeLight'); if (themeLight) themeLight.textContent = t('theme_light');
    const themeDark = document.getElementById('themeDark'); if (themeDark) themeDark.textContent = t('theme_dark');
  } catch (e) {
    // ignore translation failures
  }
}

async function listUniverses(){ try{ const r=await api('/api/universes'); const ids = await r.json(); const sel=document.getElementById('universeSelect'); sel.innerHTML=''; for(const id of ids){ const o=document.createElement('option'); o.value=id; o.textContent=id; sel.appendChild(o);} }catch(e){console.error(e);} }

// Utility to escape HTML content before inserting into the event list
function _escapeHtml(s){ return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

  async function loadUniverse(id) {
  if (!id) return;
  try {
    const r = await api('/api/universe/' + id);
    if (!r.ok) {
      document.getElementById('events').textContent = 'error al cargar universo';
      return;
    }
    const u = await r.json();
    const chars = u.characters || [];
    // Render characters as clickable items that open a details modal
    document.getElementById('chars').innerHTML = chars.map(function (c) { return '<li><a href="#" class="char-link" data-char-id="' + _escapeHtml(c.id) + '">' + _escapeHtml(c.name) + ' (' + _escapeHtml(c.id) + ')</a>' + (c.description ? ': ' + _escapeHtml(c.description) : '') + '</li>'; }).join('');
    const cs = document.getElementById('charSelect'); cs.innerHTML = '';
    for (const c of chars) { const o=document.createElement('option'); o.value = c.id; o.textContent = c.name + ' (' + c.id + ')'; cs.appendChild(o); }
    // Build list items newest-first and update the scrollable container while
    // preserving scroll position if the user has scrolled to view older items.
    const evs = (u.events || []).slice(-100).reverse().map(function (e) {
      try {
        const ts = e.timestamp || '';
        if (e.type === 'ai_response') {
          const actor = (u.characters || []).find(function(c){ return c.id === (e.payload && e.payload.actorId); });
          const who = actor ? (actor.name + ' (' + actor.id + ')') : ((e.payload && e.payload.actorId) || 'AI');
          const resp = (e.payload && (e.payload.response || e.payload.text)) || JSON.stringify(e.payload);
          return '<li>' + _escapeHtml('[' + ts + '] ai_response (' + who + '): ' + resp) + '</li>';
        }
        if (e.type === 'character_memory') {
          const ch = (u.characters || []).find(function(c){ return c.id === (e.payload && e.payload.characterId); });
          const who = ch ? (ch.name + ' (' + ch.id + ')') : ((e.payload && e.payload.characterId) || 'unknown');
          const txt = (e.payload && e.payload.text) || JSON.stringify(e.payload);
          return '<li>' + _escapeHtml('[' + ts + '] memory (' + who + '): ' + txt) + '</li>';
        }
        return '<li>' + _escapeHtml('[' + ts + '] ' + e.type + ': ' + JSON.stringify(e.payload)) + '</li>';
      } catch (err) { return '<li>' + _escapeHtml(JSON.stringify(e)) + '</li>'; }
    });

    const listEl = document.getElementById('events');
    const container = document.getElementById('eventsContainer');
    if (listEl && container) {
      const prevScrollTop = container.scrollTop;
      const prevScrollHeight = container.scrollHeight;
      // Use localized message when there are no events
      listEl.innerHTML = evs.length ? evs.join('') : '<li class="text-muted">' + t('no_events') + '</li>';
      const newScrollHeight = container.scrollHeight;
      // If the user is at the very top, keep showing newest items; otherwise
      // preserve their relative position so reading older items isn't interrupted.
      if (prevScrollTop <= 5) {
        container.scrollTop = 0;
      } else {
        container.scrollTop = Math.max(0, prevScrollTop + (newScrollHeight - prevScrollHeight));
      }
    }
    // Show visibility toggle for owners/admins
    (async function(){
      try {
        const rUser = await api('/api/user');
        let currentUserId = null;
        if (rUser.ok) { const j = await rUser.json(); currentUserId = j.id; }
        const visContainer = document.getElementById('visibilityContainer');
        if (!visContainer) return;
        if (!currentUserId) { visContainer.style.display='none'; return; }
        if (u.owner && (u.owner === currentUserId || (u.members||[]).some(function(m){return m.userId===currentUserId;}))) {
          visContainer.style.display='block';
          const chk = document.getElementById('publicToggle');
            if (chk) {
              try { chk.checked = !!(u.attributes && u.attributes.public); } catch(e) {}
              chk.onchange = async function(){
                try {
                  const res = await api('/api/universe/'+id+'/visibility', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ public: chk.checked }) });
                    if (!res.ok) { showAlert('danger', t('failed_update_visibility')); } else { await loadUniverse(id); }
                  } catch(e){ console.error(e); showAlert('danger', t('error_update_visibility')); }
              };
            }
        } else { visContainer.style.display='none'; }
      } catch(e){ console.error(e); }
    })();
  } catch (e) { console.error(e); document.getElementById('events').textContent = 'error'; }
}
  // Log viewer support: load events, render and play back
  let logEvents = [];
  let logIndex = -1;
  let logTimer = null;

  async function loadLogEvents() {
    try {
      const id = document.getElementById('universeSelect').value;
      if (!id) return;
      const r = await api('/api/universe/' + id);
      if (!r.ok) { document.getElementById('logList').innerHTML = '<li class="text-muted">' + t('no_logs') + '</li>'; return; }
      const u = await r.json();
      logEvents = (u.events || []).slice().reverse();
      renderLogList();
    } catch (e) { console.error(e); }
  }

  function renderLogList() {
    const fl = String(document.getElementById('logFilter').value || '');
    const listEl = document.getElementById('logList');
    if (!listEl) return;
    const filtered = logEvents.filter(function(ev){ if (!fl) return true; return String(ev.type) === fl; });
    if (!filtered.length) { listEl.innerHTML = '<li class="text-muted">' + t('no_logs') + '</li>'; return; }
    listEl.innerHTML = filtered.map(function(ev, idx){ try { return '<li data-evid="'+_escapeHtml(ev.id)+'" data-idx="'+idx+'">['+_escapeHtml(ev.timestamp||'')+'] <strong>'+_escapeHtml(ev.type)+'</strong>: '+_escapeHtml(JSON.stringify(ev.payload).slice(0,200))+'</li>'; } catch(e){ return '<li>' + _escapeHtml(JSON.stringify(ev)) + '</li>'; } }).join('');
    // click to view event details
    listEl.querySelectorAll('li[data-evid]').forEach(function(li){ li.addEventListener('click', async function(){ const evId = this.getAttribute('data-evid'); try { const id = document.getElementById('universeSelect').value; const er = await api('/api/universe/' + id + '/event/' + encodeURIComponent(evId)); if (!er.ok) { showAlert('danger', t('error_generic')); return; } const evJ = await er.json(); showAlert('info', JSON.stringify(evJ, null, 2), 10000); } catch(e){ console.error(e); showAlert('danger', t('error_generic')); } }); });
  }

  function stepLog() {
    try {
      const fl = String(document.getElementById('logFilter').value || '');
      const filtered = logEvents.filter(function(ev){ if (!fl) return true; return String(ev.type) === fl; });
      if (!filtered.length) return;
      logIndex = (logIndex + 1) % filtered.length;
      const ev = filtered[logIndex];
      // show event payload in aiOut for quick inspection
      try { document.getElementById('aiOut').textContent = JSON.stringify(ev.payload, null, 2); } catch(e) {}
      // highlight corresponding timeline entry by searching text
      try { const listEl = document.getElementById('logList'); const li = listEl.querySelector('li[data-evid]'); if (li && li.scrollIntoView) li.scrollIntoView({ behavior: 'smooth', block: 'center' }); } catch(e) {}
    } catch(e){ console.error(e); }
  }

  function playLog() {
    const speed = parseInt(String(document.getElementById('logSpeed').value || '1000'), 10) || 1000;
    if (logTimer) clearInterval(logTimer);
    logTimer = setInterval(stepLog, speed);
  }

  function pauseLog() { if (logTimer) { clearInterval(logTimer); logTimer = null; } }

  document.getElementById('openLogViewer').addEventListener('click', ()=>{ const p = document.getElementById('logViewer'); if (!p) return; p.style.display = p.style.display === 'none' ? 'block' : 'none'; if (p.style.display === 'block') loadLogEvents(); });
  document.getElementById('playLog').addEventListener('click', ()=>{ playLog(); });
  document.getElementById('pauseLog').addEventListener('click', ()=>{ pauseLog(); });
  document.getElementById('stepLog').addEventListener('click', ()=>{ stepLog(); });
  document.getElementById('logFilter').addEventListener('change', ()=>{ renderLogList(); });

  document.getElementById('loadBtn').addEventListener('click', ()=>{ const id=document.getElementById('universeSelect').value; loadUniverse(id); });
  async function openCharacterModal(universeId, charId) {
    try {
      const res = await api('/api/universe/' + universeId + '/character/' + encodeURIComponent(charId));
      if (!res.ok) { showAlert('danger', t('error_generic')); return; }
      const ch = await res.json();
      document.getElementById('charModalTitle').textContent = (ch.name || ch.id || '') + ' (' + charId + ')';
      const bodyEl = document.getElementById('charModalBody');
      bodyEl.innerHTML = '';
      try {
        const aliases = ch.meta && ch.meta.aliases ? (Array.isArray(ch.meta.aliases) ? ch.meta.aliases.join(', ') : String(ch.meta.aliases)) : '';
        bodyEl.innerHTML += '<div><strong>' + t('aliases') + ':</strong> ' + _escapeHtml(aliases || '-') + '</div>';
        bodyEl.innerHTML += '<div><strong>' + t('age') + ':</strong> ' + _escapeHtml(String(ch.meta && ch.meta.age ? ch.meta.age : '-')) + '</div>';
      } catch (e) {}
      bodyEl.innerHTML += '<p>' + _escapeHtml(ch.description || '') + '</p>';

      const eventsContainer = document.getElementById('charEvents');
      let page = 0;
      const limit = 3;
      async function loadEvents(p) {
        try {
          const r = await api('/api/universe/' + universeId + '/character/' + encodeURIComponent(charId) + '/events?page=' + encodeURIComponent(p) + '&limit=' + limit);
          if (!r.ok) { eventsContainer.innerHTML = '<div class="text-muted">' + t('no_events') + '</div>'; return; }
          const j = await r.json();
          if (!Array.isArray(j.events) || j.events.length === 0) { eventsContainer.innerHTML = '<div class="text-muted">' + t('no_events') + '</div>'; return; }
          const items = j.events.map(function(ev){
            const brief = _escapeHtml(ev.brief || (ev.payload && (ev.payload.response || ev.payload.text) ? String(ev.payload.response || ev.payload.text).slice(0,160) : JSON.stringify(ev.payload).slice(0,160)));
            return '<div class="mb-2"><small class="text-muted">' + _escapeHtml(ev.timestamp) + '</small><div>' + brief + '</div><div class="mt-1"><button class="btn btn-sm btn-link view-event" data-evid="' + _escapeHtml(ev.id) + '">' + t('view_event') + '</button></div></div><hr/>';
          }).join('');
          eventsContainer.innerHTML = items + '<div class="text-end"><button id="charEventsMore" class="btn btn-sm btn-outline-primary">' + t('ver_mas') + '</button></div>';
          document.getElementById('charEventsMore').addEventListener('click', function(){ page++; loadEvents(page); });
          // attach view buttons
          eventsContainer.querySelectorAll('.view-event').forEach(function(b){ b.addEventListener('click', async function(){ const evId = this.getAttribute('data-evid'); try { const er = await api('/api/universe/' + universeId + '/event/' + encodeURIComponent(evId)); if (!er.ok) { showAlert('danger', t('error_generic')); return; } const evJ = await er.json(); showAlert('info', JSON.stringify(evJ, null, 2), 10000); } catch (e) { console.error(e); showAlert('danger', t('error_generic')); } }); });
        } catch (e) { console.error(e); eventsContainer.innerHTML = '<div class="text-muted">' + t('no_events') + '</div>'; }
      }
      await loadEvents(0);

      // show modal
      document.getElementById('charModalOverlay').style.display = 'block';
      document.getElementById('charModalClose').onclick = function(){ document.getElementById('charModalOverlay').style.display = 'none'; };
      document.getElementById('charModalEdit').onclick = async function(){
        try {
          const newName = prompt('New name', ch.name || '');
          if (newName === null) return;
          const newDesc = prompt('New description', ch.description || '');
          const payload = { name: newName, description: newDesc };
          const r2 = await api('/api/universe/' + universeId + '/character/' + encodeURIComponent(charId), { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
          if (!r2.ok) { showAlert('danger', t('error_generic')); return; }
          showAlert('success', t('edit') + ' ' + (ch.name || ''));
          // refresh universe and modal
          await listUniverses();
          await loadUniverse(universeId);
          openCharacterModal(universeId, charId);
        } catch (e) { console.error(e); showAlert('danger', t('error_generic')); }
      };
    } catch (e) { console.error(e); showAlert('danger', t('error_generic')); }
  }
  // Character click handler: open modal with details and paginated events
  document.getElementById('chars').addEventListener('click', async function (ev) {
    try {
      const target = ev.target || ev.srcElement;
      if (!target) return;
      if (target.matches && target.matches('.char-link')) {
        ev.preventDefault();
        const charId = target.getAttribute('data-char-id');
        const uniId = document.getElementById('universeSelect').value;
        if (!uniId || !charId) return;
        openCharacterModal(uniId, charId);
      }
    } catch (e) { console.error(e); }
  });
document.getElementById('send').addEventListener('click', async ()=>{ const id=document.getElementById('universeSelect').value; const cid=document.getElementById('charSelect').value; const msg=document.getElementById('prompt').value; if(!id||!cid||!msg){ showAlert('warning', t('universe_character_message_required')); return; } try{ const payload = { message: msg, actorId: cid }; const r = await api('/api/universe/'+id+'/ai',{ method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify(payload) }); const j = await r.json(); document.getElementById('aiOut').textContent = j?.text ?? JSON.stringify(j, null, 2); try{ await loadUniverse(id); }catch(e){ /* ignore refresh errors */ } }catch(e){ console.error(e); showAlert('danger', t('error_calling_ai')); } });

  window.addEventListener('load', async ()=>{ 
    // apply translations early so UI labels render in the chosen language
    applyTranslations();
    await listUniverses();
    const sel = document.getElementById('universeSelect');
    if (sel && sel.options && sel.options.length) loadUniverse(sel.value);
    try { updateAuthUI(); } catch (e) {}

    // Auto-refresh: poll every 2s when enabled. Skip refresh while the
    // Settings panel or the Character modal are open so the UI doesn't
    // interfere with user interactions.
    setInterval(() => {
      try {
        if (document.getElementById('autoRefresh').checked) {
          const settingsPanel = document.getElementById('settingsPanel');
          if (settingsPanel && settingsPanel.style.display === 'block') return;
          const charModal = document.getElementById('charModalOverlay');
          if (charModal && charModal.style.display === 'block') return;
          const id = document.getElementById('universeSelect').value;
          if (id) loadUniverse(id);
        }
      } catch (e) {
        // ignore
      }
    }, 2000);
  // init settings
  const theme = localStorage.getItem('wc_theme') || 'light'; if (theme === 'dark') document.body.classList.add('dark');
  document.getElementById('themeToggle').addEventListener('click', ()=>{ const t = document.body.classList.toggle('dark'); localStorage.setItem('wc_theme', t ? 'dark' : 'light'); });
  document.getElementById('openSettings').addEventListener('click', ()=>{ const p = document.getElementById('settingsPanel'); p.style.display = p.style.display === 'none' ? 'block' : 'none'; refreshUserStatus(); });
  document.getElementById('saveJwt').addEventListener('click', async ()=>{
    const jwtElem = document.getElementById('jwtInput');
    let v = jwtElem ? String(jwtElem.value).trim() : '';
    // Allow pasting either raw token or "Bearer <token>" — normalize to raw token
    v = v.replace(/^Bearer\s+/i, '').trim();
    if (v) {
      localStorage.setItem('wc_jwt', v);
      if (jwtElem) jwtElem.value = v;
      showAlert('success', t('token_saved'));
      try { 
        await refreshUserStatus(); 
        // refresh universe list and currently selected universe so the UI
        // reflects permissions and content immediately without F5.
        await listUniverses();
        const sel = document.getElementById('universeSelect');
        if (sel && sel.options && sel.options.length) await loadUniverse(sel.value);
      } catch (e) { /* ignore */ }
    } else {
      showAlert('warning', t('paste_valid_jwt'));
    }
  });
  document.getElementById('clearJwt').addEventListener('click', async ()=>{ localStorage.removeItem('wc_jwt'); showAlert('info', t('token_cleared')); try { await refreshUserStatus(); await listUniverses(); const sel = document.getElementById('universeSelect'); if (sel && sel.options && sel.options.length) await loadUniverse(sel.value); } catch (e) {} });
  // Register / Login handlers in Settings
  document.getElementById('registerBtn').addEventListener('click', async ()=>{
    try {
      const id = String(document.getElementById('regId').value || '').trim();
      const pw = String(document.getElementById('regPassword').value || '');
      if (!id || !pw) { showAlert('warning', t('register_fail')); return; }
      const res = await fetch('/api/auth/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id, password: pw }) });
      if (res.status === 201) {
        const j = await res.json().catch(() => ({}));
        if (j && j.token) {
          localStorage.setItem('wc_jwt', j.token);
          if (j.refreshToken) localStorage.setItem('wc_refresh', j.refreshToken);
          showAlert('success', t('register_success'));
          try { await refreshUserStatus(); await listUniverses(); const sel = document.getElementById('universeSelect'); if (sel && sel.options && sel.options.length) await loadUniverse(sel.value); } catch (e) {}
        } else { showAlert('warning', t('register_fail')); }
      } else {
        const j = await res.json().catch(() => ({}));
        if (j && j.code === 'ACCOUNT_LOCKED') {
          const retry = res.headers.get('Retry-After');
          showAlert('danger', t('account_locked') + (retry ? (' Retry-After: ' + retry + 's') : ''));
        } else {
          showAlert('danger', t('register_fail') + ': ' + (j.error || j.code || res.status));
        }
      }
    } catch (e) { console.error(e); showAlert('danger', t('register_fail')); }
  });

  document.getElementById('loginBtn').addEventListener('click', async ()=>{
    try {
      const id = String(document.getElementById('loginId').value || '').trim();
      const pw = String(document.getElementById('loginPassword').value || '');
      if (!id || !pw) { showAlert('warning', t('login_fail')); return; }
      const res = await fetch('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id, password: pw }) });
      if (res.ok) {
        const j = await res.json().catch(() => ({}));
        if (j && j.token) {
          localStorage.setItem('wc_jwt', j.token);
          if (j.refreshToken) localStorage.setItem('wc_refresh', j.refreshToken);
          showAlert('success', t('login_success'));
          try { await refreshUserStatus(); await listUniverses(); const sel = document.getElementById('universeSelect'); if (sel && sel.options && sel.options.length) await loadUniverse(sel.value); } catch (e) {}
        } else { showAlert('warning', t('login_fail')); }
      } else {
        const j = await res.json().catch(() => ({}));
        if (j && j.code === 'ACCOUNT_LOCKED') {
          const retry = res.headers.get('Retry-After');
          showAlert('danger', t('account_locked') + (retry ? (' Retry-After: ' + retry + 's') : ''));
        } else {
          showAlert('danger', t('login_fail') + ': ' + (j.error || j.code || res.status));
        }
      }
    } catch (e) { console.error(e); showAlert('danger', t('login_fail')); }
  });
  // Refresh / Revoke / Logout handlers
  try {
    const refreshBtn = document.getElementById('refreshBtn');
    if (refreshBtn) refreshBtn.addEventListener('click', async ()=>{
      try {
        const uid = String(document.getElementById('currentUserId').textContent || '');
        const rtoken = localStorage.getItem('wc_refresh');
        if (!uid || uid === '-' || !rtoken) { showAlert('warning', t('no_refresh_token')); return; }
        const res = await fetch('/api/auth/refresh', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: uid, refreshToken: rtoken }) });
        if (!res.ok) { const j = await res.json().catch(()=>({})); showAlert('danger', t('refresh_fail') + ': ' + (j.error || j.code || res.status)); return; }
        const j = await res.json().catch(()=>({}));
        if (j.token) localStorage.setItem('wc_jwt', j.token);
        if (j.refreshToken) localStorage.setItem('wc_refresh', j.refreshToken);
        showAlert('success', t('refresh_success'));
        updateAuthUI();
        try { await refreshUserStatus(); } catch (e) {}
      } catch (e) { console.error(e); showAlert('danger', t('refresh_fail')); }
    });

    const revokeBtn = document.getElementById('revokeBtn');
    if (revokeBtn) revokeBtn.addEventListener('click', async ()=>{
      try {
        const uid = String(document.getElementById('currentUserId').textContent || '');
        if (!uid || uid === '-') { showAlert('warning', t('not_authenticated')); return; }
        const body = { id: uid, refreshToken: localStorage.getItem('wc_refresh') };
        const r = await api('/api/auth/revoke', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
        if (!r.ok) { const j = await r.json().catch(()=>({})); showAlert('danger', t('revoke_fail') + ': ' + (j.error || j.code || r.status)); return; }
        localStorage.removeItem('wc_refresh');
        localStorage.removeItem('wc_jwt');
        showAlert('success', t('revoke_success'));
        updateAuthUI();
        try { await refreshUserStatus(); } catch (e) {}
      } catch (e) { console.error(e); showAlert('danger', t('revoke_fail')); }
    });

    const logoutBtn = document.getElementById('logoutBtn');
    if (logoutBtn) logoutBtn.addEventListener('click', async ()=>{
      localStorage.removeItem('wc_jwt');
      localStorage.removeItem('wc_refresh');
      showAlert('info', t('token_cleared'));
      updateAuthUI();
      try { await refreshUserStatus(); } catch (e) {}
    });
  } catch (e) {}
  document.getElementById('saveUserKey').addEventListener('click', async ()=>{
    const provElem = document.getElementById('userProvider');
    const apiElem = document.getElementById('userApiKey');
    const modelElem = document.getElementById('userModel');
    const provider = provElem ? String(provElem.value).trim() : 'openai';
    const apiKey = apiElem ? String(apiElem.value).trim() : '';
    const model = modelElem ? String(modelElem.value).trim() : '';
    if (!apiKey) { if (!confirm('No API key entered. This will clear any existing stored key. Continue?')) return; }
    try{
      const body = { provider, apiKey: apiKey === '' ? null : apiKey, model: model === '' ? undefined : model };
      const r = await api('/api/user/key', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify(body) });
      if (r.ok) {
        const j = await r.json().catch(() => ({}));
        if (j.validated === false) {
          // Saved but validation failed
          const code = j.validationCode || j.code || 'K_OPENAI_ERROR';
          const trace = j.trace ? (' trace: ' + j.trace) : '';
          showAlert('warning', t('key_saved_but_invalid', { code }));
          try { updateAiStatus('disconnected', null, null, 'Clave inválida', code); } catch (e) {}
        } else {
          showAlert('success', t('key_saved'));
          try { updateAiStatus('connected', j.provider || provider, j.model || model || null); } catch (e) {}
        }
        await refreshUserStatus();
        // refresh universe list and currently selected universe to reflect new permissions
        await listUniverses();
        const sel2 = document.getElementById('universeSelect');
        if (sel2 && sel2.options && sel2.options.length) await loadUniverse(sel2.value);
      } else {
        const j = await r.json().catch(() => ({}));
        const code = j?.code || 'K_UNKNOWN';
        const err = j?.error || 'save_failed';
        showAlert('danger', t('error_saving_key') + ': ' + err + ' (código: ' + code + ')');
        document.getElementById('userKeyStatus').textContent = 'Error saving key: ' + err;
        try { updateAiStatus('disconnected', null, null, 'Clave inválida o no verificable', code); } catch (e) {}
      }
    } catch (e) { console.error(e); showAlert('danger', t('error_generic')); document.getElementById('userKeyStatus').textContent = 'Error saving key'; }
  });
  async function savePrefs(prefs){ try{ const r = await api('/api/user/prefs',{ method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify(prefs) }); if (!r.ok) { /* ignore */ } }catch(e){ console.error('savePrefs failed', e); } }
  document.getElementById('themeLight').addEventListener('click', async ()=>{ document.body.classList.remove('dark'); localStorage.setItem('wc_theme','light'); await savePrefs({ theme: 'light' }); });
  document.getElementById('themeDark').addEventListener('click', async ()=>{ document.body.classList.add('dark'); localStorage.setItem('wc_theme','dark'); await savePrefs({ theme: 'dark' }); });

  // language selector: update local preference and persist when possible
  try {
    const langSel = document.getElementById('langSelect');
    if (langSel) {
      langSel.value = localStorage.getItem('wc_lang') || 'es';
      langSel.addEventListener('change', async () => {
        const v = String(langSel.value || 'es');
        localStorage.setItem('wc_lang', v);
        applyTranslations();
        try { await savePrefs({ lang: v }); } catch (e) { /* ignore */ }
      });
    }
  } catch (e) {}

  async function refreshUserStatus(){
    try{
      const r = await api('/api/user');
      if (!r.ok) {
        // Try to parse error with code for tracing
        let errBody = null;
        try { errBody = await r.json(); } catch (e) { /* ignore */ }
        const code = errBody?.code || 'AUTH_UNKNOWN';
        // If the JWT has expired provide a specific friendly message and
        // suggested action for the user.
        if (code === 'AUTH_JWT_EXPIRED' || String(errBody?.message || '').toLowerCase().includes('expire')) {
          document.getElementById('userKeyStatus').textContent = t('jwt_expired');
          updateAiStatus('disconnected', null, null, t('jwt_expired'), code);
          showAlert('warning', t('jwt_expired') + ' (' + code + ')');
          return;
        }
        const friendly = t('not_authenticated');
        document.getElementById('userKeyStatus').textContent = friendly + ' (guardar JWT)';
        updateAiStatus('disconnected', null, null, friendly, code);
        // Show a non-technical message with a traceable code
        showAlert('warning', friendly + ' (' + code + ')');
        return;
      }
        const j = await r.json();
        document.getElementById('userKeyStatus').textContent = 'Provider: ' + (j.provider || 'none') + ', hasKey: ' + (j.hasKey ? 'sí' : 'no');
        // Update current user display and refresh token input
        try {
          const uidEl = document.getElementById('currentUserId'); if (uidEl) uidEl.textContent = j.id || '-';
          const rt = localStorage.getItem('wc_refresh');
          const rtEl = document.getElementById('refreshTokenInput'); if (rtEl) rtEl.value = rt ? (String(rt).slice(0,6) + '...' + String(rt).slice(-6)) : t('no_refresh_token');
          const authSt = document.getElementById('authStatus'); if (authSt) authSt.textContent = rt ? t('refresh_token_label') + ': ' + (rt ? 'stored' : '') : t('no_refresh_token');
        } catch (e) {}

      // Update AI connection indicator
      try {
        if (j.hasKey) {
          const model = (j.meta && j.meta.model) || (j.globalProviderModel || null);
          updateAiStatus('connected', j.provider || 'user', model);
        } else if (j.globalProviderConfigured) {
          updateAiStatus('global', 'global', j.globalProviderModel || null);
        } else {
          updateAiStatus('disconnected', null, null, 'No hay clave configurada', 'NO_KEY');
        }
      } catch (e) { /* ignore */ }

      try {
        if (j.meta && j.meta.theme) {
          localStorage.setItem('wc_theme', j.meta.theme);
          if (j.meta.theme === 'dark') document.body.classList.add('dark'); else document.body.classList.remove('dark');
        }
        if (j.meta && j.meta.lang) {
          localStorage.setItem('wc_lang', j.meta.lang);
          applyTranslations();
        }
      } catch(e){}
      }catch(e){
      console.error(e);
      document.getElementById('userKeyStatus').textContent = 'Error fetching user status';
      updateAiStatus('disconnected', null, null, 'Error fetching user status', 'ERR_STATUS');
      showAlert('danger', t('error_fetching_user_status'));
    }
  }

  // Small helper to update auth-related UI elements from local storage
  function updateAuthUI() {
    try {
      const uidEl = document.getElementById('currentUserId');
      const rtEl = document.getElementById('refreshTokenInput');
      const authSt = document.getElementById('authStatus');
      const token = localStorage.getItem('wc_jwt');
      const rtoken = localStorage.getItem('wc_refresh');
      // attempt to decode sub from JWT for display (best-effort)
      try {
        if (token) {
          const parts = token.split('.');
          if (parts.length === 3) {
            const payload = JSON.parse(atob(parts[1].replace(/-/g,'+').replace(/_/g,'/')));
            if (uidEl) uidEl.textContent = payload.sub || '-';
          } else {
            if (uidEl) uidEl.textContent = '-';
          }
        } else {
          if (uidEl) uidEl.textContent = '-';
        }
      } catch (e) { if (uidEl) uidEl.textContent = '-'; }
      if (rtEl) rtEl.value = rtoken ? (String(rtoken).slice(0,6) + '...' + String(rtoken).slice(-6)) : t('no_refresh_token');
      if (authSt) authSt.textContent = rtoken ? t('refresh_token_label') + ': stored' : t('no_refresh_token');
    } catch (e) {}
  }
});
</script>
</body></html>`;
      res.end(playHtml);
      return;
    }
    if (req.method === 'GET' && path === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(String.raw`<!doctype html>
<html>
<head><meta charset="utf-8"><title>WorldCore Demo</title></head>
<body>
<h1>WorldCore Demo</h1>
<p>Use the endpoints below to interact.</p>
<ul>
<li>GET /api/universes — list universes</li>
<li>GET /api/universe/:id — show snapshot</li>
<li>POST /api/universe — create universe JSON {id,name,description,attributes}</li>
<li>POST /api/universe/:id/character — add character JSON {id,name,description}</li>
<li>POST /api/universe/:id/clone — clone universe JSON {newId,newName,newDescription}</li>
<li>DELETE /api/universe/:id — delete universe</li>
<li>POST /api/ai — {"prompt":"..."}</li>
<li>CLI alternative: use <code>npm run cli -- &lt;command&gt;</code></li>
</ul>
<script>
async function api(path, opts){ const r=await fetch(path,opts); return r.json(); }
async function list(){document.getElementById('out').textContent=JSON.stringify(await api('/api/universes'),null,2)}
let refreshTimer = null;
async function show(){
  const id=document.getElementById('id').value;
  if (!id) { window.alert('enter universe id'); return; }
  const u = await api('/api/universe/'+id);
  const lines = [];
  lines.push('Universe: ' + u.name + ' (id: ' + u.id + ')');
  if (u.description) lines.push('Description: ' + u.description);
  if (u.attributes) lines.push('Attributes: ' + JSON.stringify(u.attributes));
  lines.push('\nCharacters:');
  for (const c of (u.characters||[])) {
    lines.push(' - ' + c.name + ' (' + c.id + ')' + (c.description? ': ' + c.description : ''));
    if (c.memory && c.memory.length) lines.push('   memory: ' + JSON.stringify(c.memory.slice(-3)));
  }
  lines.push('\nRecent events:');
  for (const e of (u.events||[]).slice(-10)) {
    lines.push(' - [' + e.timestamp + '] ' + e.type + ': ' + JSON.stringify(e.payload));
  }
  document.getElementById('out').textContent = lines.join('\n');

  // auto-refresh handling
  if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; }
  const ar = document.getElementById('autoRefresh');
  if (ar && ar.checked) {
    refreshTimer = setInterval(async () => { try { const u2 = await api('/api/universe/'+id); document.getElementById('out').textContent = '... refreshing ...\n' + JSON.stringify(u2, null, 2); } catch (e) { /* ignore */ } }, 3000);
  }
}
async function add(){const id=document.getElementById('id').value; const cid=document.getElementById('cid').value; const name=document.getElementById('cname').value; const desc=document.getElementById('cdesc').value; await api('/api/universe/'+id+'/character',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id:cid,name,description:desc})}); window.alert('added');}
async function createUniverse(){
  const id=document.getElementById('newId').value;
  const name=document.getElementById('newName').value;
  const desc=document.getElementById('newDesc').value;
  const policy=document.getElementById('eventPolicy').value;
  const attrsText=document.getElementById('newAttrs').value;
  let attrs;
  try{attrs=attrsText?JSON.parse(attrsText):{};}catch(e){window.alert('invalid attributes JSON');return;}
  attrs = { ...(attrs||{}), eventPolicy: policy };
  await api('/api/universe',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id,name,description:desc,attributes:attrs})});
  window.alert('created');
}
async function deleteUniverse(){const id=document.getElementById('delId').value; await fetch('/api/universe/'+id,{method:'DELETE'}); window.alert('deleted');}
async function cloneUniverse(){const src=document.getElementById('srcId').value; const nid=document.getElementById('cloneId').value; const nname=document.getElementById('cloneName').value; await api('/api/universe/'+src+'/clone',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({newId:nid,newName:nname})}); window.alert('cloned');}

async function interact(){
  const uid = document.getElementById('interactUniverse').value;
  const cid = document.getElementById('interactChar').value;
  const msg = document.getElementById('interactMessage').value;
  if (!uid || !cid || !msg) { window.alert('universe, character and message required'); return; }
  const prompt = 'Act as ' + cid + '. ' + msg;
  const res = await fetch('/api/universe/'+uid+'/ai', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt }) });
  const j = await res.json();
  document.getElementById('interactOut').textContent = JSON.stringify(j, null, 2);
}
</script>
<div>
<button onclick="list()">List universes</button>
<div>
<input id="id" placeholder="universe id" />
<button onclick="show()">Show universe</button>
<div>
<h3>Add character</h3>
<input id="cid" placeholder="character id" />
<input id="cname" placeholder="character name" />
<input id="cdesc" placeholder="character description" />
<button onclick="add()">Add character</button>
<h3>Create universe</h3>
<input id="newId" placeholder="new universe id" />
<input id="newName" placeholder="name" />
<input id="newDesc" placeholder="description" />
<label>Event policy: <select id="eventPolicy"><option value="sparse">sparse</option><option value="balanced" selected>balanced</option><option value="dense">dense</option><option value="random">random</option><option value="thematic">thematic</option></select></label>
<input id="newAttrs" placeholder='additional attributes JSON (e.g. {"theme":"dark"})' />
<button onclick="createUniverse()">Create universe</button>
<h3>Clone universe</h3>
<input id="srcId" placeholder="source id" />
<input id="cloneId" placeholder="new id" />
<input id="cloneName" placeholder="new name" />
<button onclick="cloneUniverse()">Clone</button>
<h3>Delete universe</h3>
<input id="delId" placeholder="id to delete" />
<button onclick="deleteUniverse()">Delete</button>

<h3>Interact With Character</h3>
<div>
  <input id="interactUniverse" placeholder="universe id" />
  <input id="interactChar" placeholder="character id" />
  <textarea id="interactMessage" placeholder="Write a message to the character" rows="3" cols="40"></textarea>
  <br/>
  <button onclick="interact()">Send</button>
  <pre id="interactOut" style="background:#f7f7f7;padding:0.5rem;margin-top:0.5rem"></pre>
</div>

</pre>
<label><input type="checkbox" id="autoRefresh" /> Auto-refresh every 3s</label>
<pre id="out" style="background:#eee;padding:1rem"></pre>
</body></html>`);
      return;
    }

      if (req.method === 'GET' && path === '/api/universes') {
        // Filter universes: unassigned universes are public; assigned universes
        // are visible only to owner and invited members.
        const actorId = getRequesterId(req);
        const ids = await persistence.listUniverseIds();
        const visible: string[] = [];
        for (const id of ids) {
          try {
            const u = await persistence.loadUniverse(id);
            const owner = typeof u.getOwner === 'function' ? u.getOwner() : undefined;
            if (!owner) {
              visible.push(id);
              continue;
            }
            // If universe explicitly marked public by owner, show to everyone
            try {
              if (u.attributes && u.attributes.public) {
                visible.push(id);
                continue;
              }
            } catch (e) {
              // ignore malformed attributes
            }
            // If auth not configured, expose for dev
            if (!authConfigured()) {
              visible.push(id);
              continue;
            }
            if (actorId === 'api-key') {
              visible.push(id);
              continue;
            }
            if (actorId && (u.getOwner() === actorId)) {
              visible.push(id);
              continue;
            }
            const members = u.listMembers();
            if (members && members.some((m: any) => m.userId === actorId)) {
              visible.push(id);
              continue;
            }
            // otherwise not visible
          } catch (e) {
            // ignore per-universe errors
          }
        }
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(visible));
        return;
      }

      if (req.method === 'POST' && path === '/api/universe') {
        const body = await jsonBody(req);
        if (!body || !body.id || !body.name) {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'invalid body, expected {id,name}' }));
          return;
        }
        if (!requireAuth(req, res)) return;
        // Identify requester (may be undefined when auth is not configured)
        const actorId = getRequesterId(req);
        const u = await universeService.createUniverse(body.id, body.name, body.description, body.attributes, actorId);
        res.writeHead(201, { 'content-type': 'application/json' });
        res.end(JSON.stringify(u.snapshot()));
        return;
      }

      // Anchors endpoints: list, latest and create an anchor (checkpoint)
      // Note: anchors are persisted via the PersistencePort; creating an anchor
      // will export the ledger, compute the chain checkpoint and persist an
      // Anchor record. Listing is allowed publicly; creating requires owner
      // permissions (or api-key) when auth is configured.
      if (req.method === 'GET' && path?.startsWith('/api/universe/') && path.endsWith('/anchors/latest')) {
        const id = path.replace('/api/universe/', '').replace('/anchors/latest', '');
        try {
          const anchor = await persistence.getLatestAnchor(id);
          if (!anchor) { res.writeHead(404, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'not_found' })); return; }
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify(anchor));
          return;
        } catch (e) { res.writeHead(500, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'failed' })); return; }
      }

      if (req.method === 'GET' && path?.startsWith('/api/universe/') && path.endsWith('/anchors')) {
        const id = path.replace('/api/universe/', '').replace('/anchors', '');
        try {
          const anchors = await persistence.loadAnchors(id);
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify(anchors));
          return;
        } catch (e) { res.writeHead(500, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'failed' })); return; }
      }

      if (req.method === 'POST' && path?.startsWith('/api/universe/') && path.endsWith('/anchors')) {
        const id = path.replace('/api/universe/', '').replace('/anchors', '');
        if (!requireAuth(req, res)) return;
        const actorId = getRequesterId(req);
        const snapBefore = await persistence.loadUniverse(id);
        if (!hasOwnerPermission(snapBefore, actorId)) { res.writeHead(403, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'forbidden' })); return; }
        try {
          // Delegate to the export script which computes canonical NDJSON and
          // persists an anchor when requested. Pass the current adapter so it
          // uses the same backing store instance.
          const ex = await import('../../scripts/export_ledger.js');
          // Request the export to save the anchor (opts.saveAnchor=true).
          await ex.exportLedger(id, undefined, { adapter, saveAnchor: true, signer: actorId || undefined });
          const latest = await persistence.getLatestAnchor(id);
          res.writeHead(201, { 'content-type': 'application/json' });
          res.end(JSON.stringify(latest));
          return;
        } catch (e) {
          res.writeHead(500, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'anchor_failed', message: e instanceof Error ? e.message : String(e) }));
          return;
        }
      }

      if (req.method === 'GET' && path?.startsWith('/api/universe/')) {
        const id = path.replace('/api/universe/', '');
        const u = await persistence.loadUniverse(id);
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(u.snapshot()));
        return;
      }

      if (req.method === 'POST' && path?.startsWith('/api/universe/') && path.endsWith('/character')) {
        const id = path.replace('/api/universe/', '').replace('/character', '');
        const body = await jsonBody(req);
        if (!body || !body.id || !body.name) {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'invalid body, expected {id,name}' }));
          return;
        }
        if (!requireAuth(req, res)) return;
        // Permission check: only owners or editors may modify a universe
        const actorId = getRequesterId(req);
        const snapBefore = await persistence.loadUniverse(id);
        if (!hasModifyPermission(snapBefore, actorId)) {
          res.writeHead(403, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'forbidden' }));
          return;
        }
        await universeService.addCharacter(id, { id: body.id, name: body.name, description: body.description });
        const u = await persistence.loadUniverse(id);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(u.snapshot()));
        return;
      }

      if (req.method === 'POST' && path?.startsWith('/api/universe/') && path.endsWith('/clone')) {
        const id = path.replace('/api/universe/', '').replace('/clone', '');
        const body = await jsonBody(req);
        if (!body || !body.newId) {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'invalid body, expected {newId,newName?}' }));
          return;
        }
        // perform clone: copy events and snapshot
        const source = await persistence.loadUniverse(id);
        // Only owners/admins may clone a universe
        if (!requireAuth(req, res)) return;
        const actorId = getRequesterId(req);
        if (!hasModifyPermission(source, actorId)) {
          res.writeHead(403, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'forbidden' }));
          return;
        }
        const events = await persistence.loadEvents(id);
        // append events to new universe with new ids
        for (const ev of events) {
          const newEv = { ...ev, id: `${Date.now()}-${Math.random().toString(36).slice(2,6)}` };
          await persistence.persistEvent(body.newId, newEv);
        }
        // copy snapshot
        const snap = source.snapshot();
        snap.id = body.newId;
        snap.name = body.newName ?? snap.name;
        snap.createdAt = new Date().toISOString();
        // Set new universe owner to actor if available
        const actorOwner = getRequesterId(req);
        if (actorOwner) {
          snap.owner = actorOwner;
          snap.members = [{ userId: actorOwner, role: 'owner' }];
        }
        await adapter.saveSnapshot(body.newId, snap);
        const newU = await persistence.loadUniverse(body.newId);
        res.writeHead(201, { 'content-type': 'application/json' });
        res.end(JSON.stringify(newU.snapshot()));
        return;
      }

      // Visibility toggle: owner can make an assigned universe public in lists
      if (req.method === 'POST' && path?.startsWith('/api/universe/') && path.endsWith('/visibility')) {
        const id = path.replace('/api/universe/', '').replace('/visibility', '');
        if (!requireAuth(req, res)) return;
        const actorId = getRequesterId(req);
        const snap = await persistence.loadUniverse(id);
        if (!hasOwnerPermission(snap, actorId)) {
          res.writeHead(403, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'forbidden' }));
          return;
        }
        const body = await jsonBody(req);
        if (!body || typeof body.public === 'undefined') {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'invalid body, expected {public:true|false}' }));
          return;
        }
        try {
          // persist an event for visibility change (store pseudonym for privacy)
          try {
            const { pseudonymize } = await import('../../utils/crypto.js');
            const pseudo = actorId ? pseudonymize(actorId) : undefined;
            const ev = { id: `${Date.now()}-${Math.random().toString(36).slice(2,6)}`, type: 'universe_visibility_changed', timestamp: new Date().toISOString(), payload: { public: !!body.public, changedByPseudo: pseudo } };
            await persistence.persistEvent(id, ev);
          } catch (e) {
            const ev = { id: `${Date.now()}-${Math.random().toString(36).slice(2,6)}`, type: 'universe_visibility_changed', timestamp: new Date().toISOString(), payload: { public: !!body.public } };
            await persistence.persistEvent(id, ev);
          }

          // Update snapshot attributes
          const updated = await persistence.loadUniverse(id);
          updated.attributes = { ...(updated.attributes || {}), public: !!body.public } as any;
          await persistence.saveSnapshot(updated);
          const newSnap = await persistence.loadUniverse(id);
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify(newSnap.snapshot()));
          return;
        } catch (err) {
          res.writeHead(500, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'failed' }));
          return;
        }
      }

      // Members management: invite/update member
      if (req.method === 'POST' && path?.startsWith('/api/universe/') && path.endsWith('/members')) {
        const id = path.replace('/api/universe/', '').replace('/members', '');
        if (!requireAuth(req, res)) return;
        const actorId = getRequesterId(req);
        const snapBefore = await persistence.loadUniverse(id);
        // Only owner or admin may change membership
        if (!hasOwnerPermission(snapBefore, actorId)) {
          res.writeHead(403, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'forbidden' }));
          return;
        }
        const body = await jsonBody(req);
        if (!body || !body.userId || !body.role) {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'invalid body, expected {userId,role}' }));
          return;
        }
        try {
          const updated = await universeService.addMember(id, body.userId, body.role);
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify(updated.snapshot()));
          return;
        } catch (e) {
          res.writeHead(500, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'failed' }));
          return;
        }
      }

      // Remove a member
      if (req.method === 'DELETE' && path?.startsWith('/api/universe/') && path.includes('/members/')) {
        const id = path.replace('/api/universe/', '').split('/members/')[0];
        const userToRemove = path.split('/members/')[1];
        if (!requireAuth(req, res)) return;
        const actorId = getRequesterId(req);
        const snapBefore = await persistence.loadUniverse(id);
        if (!hasOwnerPermission(snapBefore, actorId)) {
          res.writeHead(403, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'forbidden' }));
          return;
        }
        try {
          const updated = await universeService.removeMember(id, userToRemove);
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify(updated.snapshot()));
          return;
        } catch (e) {
          res.writeHead(500, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'failed' }));
          return;
        }
      }

      // List members of a universe (restricted for assigned universes)
      if (req.method === 'GET' && path?.startsWith('/api/universe/') && path.endsWith('/members')) {
        const id = path.replace('/api/universe/', '').replace('/members', '');
        const snap = await persistence.loadUniverse(id);
        const actorId = getRequesterId(req);
        // If universe is assigned, only owner or members can view members
        const owner = typeof snap.getOwner === 'function' ? snap.getOwner() : undefined;
        if (owner) {
          if (!authConfigured()) {
            // if auth not configured, expose for dev
          } else if (!hasModifyPermission(snap, actorId) && !(snap.listMembers && (snap.listMembers().some((m:any)=>m.userId===actorId)))) {
            res.writeHead(403, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: 'forbidden' }));
            return;
          }
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(snap.listMembers()));
        return;
      }

      if (req.method === 'DELETE' && path?.startsWith('/api/universe/')) {
        if (!requireAuth(req, res)) return;
        const id = path.replace('/api/universe/', '');
        const actorId = getRequesterId(req);
        const snap = await persistence.loadUniverse(id);
        if (!hasOwnerPermission(snap, actorId)) {
          res.writeHead(403, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'forbidden' }));
          return;
        }
        await persistence.deleteUniverse(id);
        res.writeHead(204);
        res.end();
        return;
      }

      // User endpoints: manage per-user API keys and profile. Require JWT (not API key) for updating.
      if (req.method === 'GET' && path === '/api/user') {
        if (!requireAuth(req, res)) return;
        const actorId = getRequesterId(req);
        if (!actorId || actorId === 'api-key') {
          res.writeHead(403, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'jwt_required' }));
          return;
        }
        const user = await persistence.loadUser(actorId);
        const globalKey = process.env.OPENAI_API_KEY || process.env.WORLDCORE_OPENAI_KEY || null;
        const globalModel = process.env.WORLDCORE_OPENAI_MODEL || null;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ id: actorId, provider: user?.provider ?? null, hasKey: Boolean(user?.apiKey), meta: user?.meta ?? {}, globalProviderConfigured: !!globalKey, globalProviderModel: globalModel }));
        return;
      }

      if (req.method === 'POST' && path === '/api/user/key') {
        if (!requireAuth(req, res)) return;
        const actorId = getRequesterId(req);
        if (!actorId || actorId === 'api-key') {
          res.writeHead(403, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'jwt_required' }));
          return;
        }
        const body = await jsonBody(req);
        if (!body || typeof body.apiKey === 'undefined') {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'invalid body, expected {apiKey} (string|null)' }));
          return;
        }
        const provider = body.provider ?? 'openai';
        const meta = { model: body.model ?? undefined };
        try {
          // Allow clearing the key by sending null or empty string
          const toStore = body.apiKey === null || body.apiKey === '' ? null : body.apiKey;

          // If clearing, just persist and return
          if (toStore === null) {
            await persistence.saveUser(actorId, { provider, apiKey: null, meta });
            logger.info('user.api_key_saved', { user: actorId, hasKey: false });
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ ok: true, cleared: true }));
            return;
          }

          // Save the key first, then attempt validation so tests that use
          // synthetic keys continue to work. Return validation result to the
          // client so the UI can inform the user (validated: true/false).
          await persistence.saveUser(actorId, { provider, apiKey: toStore, meta });
          logger.info('user.api_key_saved', { user: actorId, hasKey: !!toStore });

          if (provider === 'openai' && toStore) {
            const val = await validateOpenAiKey(String(toStore));
            if (!val.ok) {
              const trace = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
              logger.warn('user.api_key_validation_failed', { user: actorId, code: val.code, status: val.status, trace, err: val.message });
              // Return success but include validation failure info so the UI
              // can display a friendly message and a traceable code.
              res.writeHead(200, { 'content-type': 'application/json' });
              res.end(JSON.stringify({ ok: true, provider, model: meta.model ?? null, validated: false, validationCode: val.code || 'K_OPENAI_ERROR', trace }));
              return;
            }
          }

          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: true, provider, model: meta.model ?? null, validated: true }));
          return;
        } catch (err) {
          logger.error('user.api_key_save_failed', { err: err instanceof Error ? err.message : String(err) });
          res.writeHead(500, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'save_failed' }));
          return;
        }
      }

      if (req.method === 'POST' && path === '/api/user/prefs') {
        if (!requireAuth(req, res)) return;
        const actorId = getRequesterId(req);
        if (!actorId || actorId === 'api-key') {
          res.writeHead(403, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'jwt_required' }));
          return;
        }
        const body = await jsonBody(req);
        if (!body || typeof body !== 'object') {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'invalid body, expected prefs object' }));
          return;
        }
        try {
          const existing = await persistence.loadUser(actorId);
          const mergedMeta = { ...(existing?.meta || {}), ...(body || {}) };
          await persistence.saveUser(actorId, { provider: existing?.provider ?? null, apiKey: existing?.apiKey ?? null, meta: mergedMeta });
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
          return;
        } catch (err) {
          res.writeHead(500, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'save_failed' }));
          return;
        }
      }

      if (req.method === 'GET' && path === '/api/user/key') {
        if (!requireAuth(req, res)) return;
        const actorId = getRequesterId(req);
        if (!actorId || actorId === 'api-key') {
          res.writeHead(403, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'jwt_required' }));
          return;
        }
        const user = await persistence.loadUser(actorId);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ hasKey: Boolean(user?.apiKey), provider: user?.provider ?? null }));
        return;
      }

      if (req.method === 'POST' && path === '/api/ai') {
        const body = await jsonBody(req);
        if (!body || !body.prompt) {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'invalid body, expected {prompt}' }));
          return;
        }
        // If body.universeId is provided, load universe context
          if (body.universeId) {
            let snapU = await persistence.loadUniverse(body.universeId);
            const events = await persistence.loadEvents(body.universeId);
            // Auto-assign owner to first authenticated user that interacts with
            // the universe if it currently has no owner.
            try {
              const currentOwner = typeof snapU.getOwner === 'function' ? snapU.getOwner() : undefined;
              const actorUser = getRequesterId(req);
              if (!currentOwner && actorUser && actorUser !== 'api-key') {
                const assignEv = {
                  id: `${Date.now()}-${Math.random().toString(36).slice(2,6)}`,
                  type: 'owner_assigned',
                  timestamp: new Date().toISOString(),
                  payload: { ownerId: actorUser, members: [{ userId: actorUser, role: 'owner' }] },
                };
                await persistence.persistEvent(body.universeId, assignEv);
                // materialize snapshot immediately so subsequent logic sees owner
                const updatedU = await persistence.loadUniverse(body.universeId);
                await persistence.saveSnapshot(updatedU);
                snapU = updatedU;
                // reload events to include owner_assigned
                // (events variable will be recomputed below if needed)
              }
            } catch (e) {
              // Ignore owner assignment failures; continue without blocking AI call
            }
            const ctx = buildUniverseContext(snapU.snapshot(), events);
            // Build structured messages for multi-turn chat (system + user).
            let messages = [ { role: 'system', content: ctx }, { role: 'user', content: body.prompt } ];
            // compact messages to avoid context-length errors
            messages = compactMessages(messages, 120000);
            const ai = await getAiProviderForRequest(req, 'conversation');
            logger.info('ai.request', { universe: body.universeId, promptPreview: String(body.prompt).slice(0, 300) });
            const r = await ai.generate(body.prompt, { profile: 'conversation', messages });
            logger.info('ai.response', { universe: body.universeId, textPreview: String(r.text).slice(0, 300) });
            // persist AI response as an event in the universe ledger
            try {
              // attempt to detect an actor mentioned in the prompt
              let actorId: string | undefined;
              try {
                const chars = snapU.listCharacters();
                for (const c of chars) {
                  const name = (c.name || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                  const re = new RegExp(`\\b${name}\\b`, 'i');
                  if (re.test(body.prompt)) {
                    actorId = c.id;
                    break;
                  }
                }
              } catch (e) {
                // ignore
              }
                // Store a pseudonymous requester id to preserve privacy in the
                // public ledger. The real identity is never stored in cleartext.
                // Use server-side secret to compute HMAC-based pseudonym.
                try {
                  const { pseudonymize } = await import('../../utils/crypto.js');
                  const realRequester = getRequesterId(req);
                  const requesterPseudo = realRequester ? pseudonymize(realRequester) : undefined;
                    const ev = {
                    id: `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
                    type: 'ai_response',
                    timestamp: new Date().toISOString(),
                    payload: { requesterPseudo, actorId, prompt: body.prompt, response: r.text ?? null, raw: r.raw ?? r, messages },
                  };
                await persistence.persistEvent(body.universeId, ev);
              } catch (e) {
                  // fallback: persist without pseudonym (dev only)
                    const ev = {
                    id: `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
                    type: 'ai_response',
                    timestamp: new Date().toISOString(),
                    payload: { requesterId: getRequesterId(req), actorId, prompt: body.prompt, response: r.text ?? null, raw: r.raw ?? r, messages },
                  };
                  await persistence.persistEvent(body.universeId, ev);
                }
              // Also persist as character memory so snapshots materialize the reply
                if (actorId) {
                  const memEv = {
                    id: `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
                    type: 'character_memory',
                    timestamp: new Date().toISOString(),
                    payload: { characterId: actorId, text: r.text ?? null },
                  };
                await persistence.persistEvent(body.universeId, memEv);
                logger.info('ai.mem_persisted', { universe: body.universeId, characterId: actorId, eventId: memEv.id });
                }
            } catch (err) {
              // log but do not fail the AI response
              logger.error('ai.persist_error', { err: err instanceof Error ? err.message : String(err) });
            }
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify(r));
            return;
          }

        // Automatic disambiguation: if the prompt mentions a character name
        // that uniquely exists in one universe, scope the AI call to that
        // universe. If multiple universes match, return an ambiguous result
        // listing candidates so the client can choose.
        const q = String(body.prompt || '').toLowerCase();
        const universeIds = await persistence.listUniverseIds();
        const matches: Array<{ universeId: string; universeName: string; charName: string }> = [];
        for (const uid of universeIds) {
          try {
            const snap = await persistence.loadUniverse(uid);
            const chars = snap.listCharacters();
            for (const c of chars) {
              const name = (c.name || '').toLowerCase();
              // match whole word
              const re = new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
              if (re.test(body.prompt)) {
                matches.push({ universeId: uid, universeName: snap.name, charName: c.name });
                break; // one match per universe is enough
              }
            }
          } catch (err) {
            // ignore per-universe errors
          }
        }

          if (matches.length === 1) {
            const chosen = matches[0];
            let snapU = await persistence.loadUniverse(chosen.universeId);
            const events = await persistence.loadEvents(chosen.universeId);
            // Auto-assign owner if missing (first authenticated user to interact)
            try {
              const currentOwner = typeof snapU.getOwner === 'function' ? snapU.getOwner() : undefined;
              const actorUser = getRequesterId(req);
              if (!currentOwner && actorUser && actorUser !== 'api-key') {
                const assignEv = {
                  id: `${Date.now()}-${Math.random().toString(36).slice(2,6)}`,
                  type: 'owner_assigned',
                  timestamp: new Date().toISOString(),
                  payload: { ownerId: actorUser, members: [{ userId: actorUser, role: 'owner' }] },
                };
                await persistence.persistEvent(chosen.universeId, assignEv);
                const updatedU = await persistence.loadUniverse(chosen.universeId);
                await persistence.saveSnapshot(updatedU);
                snapU = updatedU;
              }
            } catch (e) {}
            const ctx = buildUniverseContext(snapU.snapshot(), events);
            let messages = [ { role: 'system', content: ctx }, { role: 'user', content: body.prompt } ];
            messages = compactMessages(messages, 120000);
            const ai = await getAiProviderForRequest(req, 'conversation');
            const r = await ai.generate(body.prompt, { profile: 'conversation', messages });
            try {
              let actorId: string | undefined;
              try {
                const chars = snapU.listCharacters();
                for (const c of chars) {
                  const name = (c.name || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                  const re = new RegExp(`\\b${name}\\b`, 'i');
                  if (re.test(body.prompt)) { actorId = c.id; break; }
                }
              } catch (e) {}
              const ev = { id: `${Date.now()}-${Math.random().toString(36).slice(2,6)}`, type: 'ai_response', timestamp: new Date().toISOString(), payload: { actorId, prompt: body.prompt, response: r.text ?? null, raw: r.raw ?? r, messages } };
              await persistence.persistEvent(chosen.universeId, ev);
              if (actorId) {
                const memEv = { id: `${Date.now()}-${Math.random().toString(36).slice(2,6)}`, type: 'character_memory', timestamp: new Date().toISOString(), payload: { characterId: actorId, text: r.text ?? null } };
                await persistence.persistEvent(chosen.universeId, memEv);
                logger.info('ai.mem_persisted', { universe: chosen.universeId, characterId: actorId, eventId: memEv.id });
              }
            } catch (err) {
              logger.error('ai.persist_error', { err: err instanceof Error ? err.message : String(err) });
            }
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify(r));
            return;
          }

        if (matches.length > 1) {
          // ambiguous: return candidates for client-side selection
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ambiguous: true, candidates: matches }));
          return;
        }

          // fallback: no disambiguation, send raw prompt
          {
            const ai = await getAiProviderForRequest(req, 'conversation');
            const messages = [{ role: 'user', content: body.prompt }];
            const r = await ai.generate(body.prompt, { profile: 'conversation', messages });
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify(r));
            return;
          }
      }

      // Refresh token rotation endpoint: accept { id, refreshToken }
      if (req.method === 'POST' && path === '/api/auth/refresh') {
        try {
          const body = await jsonBody(req);
          const id = body && body.id ? String(body.id) : null;
          const refreshToken = body && body.refreshToken ? String(body.refreshToken) : null;
          if (!id || !refreshToken) { res.writeHead(400, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'invalid body, expected {id,refreshToken}' })); return; }
          const valid = await validateRefreshTokenForUser(id!, refreshToken);
          if (!valid.ok) { res.writeHead(403, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'invalid_refresh' })); return; }
          // rotate: revoke the used token and issue a new one
          await revokeRefreshTokenForUser(id!, refreshToken!);
          const newRefresh = await generateRefreshTokenForUser(id!);
          const secret = process.env.WORLDCORE_JWT_SECRET;
          if (!secret) { res.writeHead(500, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'server_config', code: 'AUTH_NO_SECRET' })); return; }
          const newJwt = signJwt(id!, secret, parseInt(process.env.WORLDCORE_JWT_TTL_SECONDS || String(7 * 24 * 60 * 60), 10));
          const resp: any = { ok: true, token: newJwt };
          if (newRefresh) resp.refreshToken = newRefresh;
          res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(resp)); return;
        } catch (e) { res.writeHead(500, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'refresh_failed' })); return; }
      }

      // Revoke refresh token (logout). Body: { id, refreshToken }.
      if (req.method === 'POST' && path === '/api/auth/revoke') {
        try {
          const body = await jsonBody(req);
          const id = body && body.id ? String(body.id) : null;
          const refreshToken = body && body.refreshToken ? String(body.refreshToken) : null;
          if (!id) { res.writeHead(400, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'invalid body, expected {id,refreshToken?}' })); return; }
          // Authorization: allow if JWT belongs to same user OR if presented refreshToken matches
          const actor = getRequesterId(req);
          let authorized = false;
          if (actor && actor === id) authorized = true;
          if (!authorized && refreshToken) {
            const valid = await validateRefreshTokenForUser(id!, refreshToken!);
            if (valid.ok) authorized = true;
          }
          if (!authorized) { res.writeHead(403, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'forbidden' })); return; }
          const ok = await revokeRefreshTokenForUser(id!, refreshToken ?? undefined);
          if (!ok) { res.writeHead(500, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'revoke_failed' })); return; }
          res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: true })); return;
        } catch (e) { res.writeHead(500, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'revoke_failed' })); return; }
      }

      // AI endpoint scoped to a universe id (preferred for disambiguation)
      if (req.method === 'POST' && path?.startsWith('/api/universe/') && path.endsWith('/ai')) {
        const id = path.replace('/api/universe/', '').replace('/ai', '');
        const body = await jsonBody(req);
        const userMessage = body?.message ?? body?.prompt;
        if (!body || !userMessage) {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'invalid body, expected {message|prompt}' }));
          return;
        }
        let snapU = await persistence.loadUniverse(id);
        const events = await persistence.loadEvents(id);
        // Auto-assign owner to first authenticated user that interacts
        try {
          const currentOwner = typeof snapU.getOwner === 'function' ? snapU.getOwner() : undefined;
          const actorUser = getRequesterId(req);
          if (!currentOwner && actorUser && actorUser !== 'api-key') {
            const assignEv = {
              id: `${Date.now()}-${Math.random().toString(36).slice(2,6)}`,
              type: 'owner_assigned',
              timestamp: new Date().toISOString(),
              payload: { ownerId: actorUser, members: [{ userId: actorUser, role: 'owner' }] },
            };
            await persistence.persistEvent(id, assignEv);
            const updatedU = await persistence.loadUniverse(id);
            await persistence.saveSnapshot(updatedU);
            snapU = updatedU;
          }
        } catch (e) {
          // ignore
        }
        const ctx = buildUniverseContext(snapU.snapshot(), events);
        // Build final prompt: prefer explicit actorId when provided; otherwise try to detect by name
        let finalPrompt = `${ctx}\nUser: ${userMessage}`;
        let actorId: string | undefined = body?.actorId;
        if (actorId) {
          try {
            const ch = snapU.getCharacter(actorId);
            if (ch && ch.name) finalPrompt = `${ctx}\nAct as ${ch.name}. ${userMessage}`;
          } catch (e) {
            // ignore
          }
        } else {
          try {
            const chars = snapU.listCharacters();
            for (const c of chars) {
              const name = (c.name || '').replace(/[.*+?^${}()|[\\]\\]/g, '\\$&');
              const re = new RegExp(`\\b${name}\\b`, 'i');
              if (re.test(userMessage)) { actorId = c.id; break; }
            }
          } catch (e) {}
        }
            let messages = [{ role: 'system', content: ctx }, { role: 'user', content: finalPrompt }];
            messages = compactMessages(messages, 120000);
            const ai = await getAiProviderForRequest(req, 'conversation');
            logger.info('ai.request', { universe: id, promptPreview: String(finalPrompt).slice(0, 300) });
        const r = await ai.generate(finalPrompt, { profile: 'conversation', messages });
        logger.info('ai.response', { universe: id, textPreview: String(r.text).slice(0, 300) });
            try {
              try {
                if (!actorId) actorId = detectActorIdFromMessage(snapU, userMessage, body?.actorId);
              } catch (e) {}
               try {
                 const { pseudonymize } = await import('../../utils/crypto.js');
                 const realRequester = getRequesterId(req);
                 const requesterPseudo = realRequester ? pseudonymize(realRequester) : undefined;
                  const ev = { id: `${Date.now()}-${Math.random().toString(36).slice(2,6)}`, type: 'ai_response', timestamp: new Date().toISOString(), payload: { requesterPseudo, actorId, prompt: finalPrompt, response: r.text ?? null, raw: r.raw ?? r, messages } };
                 await persistence.persistEvent(id, ev);
               } catch (e) {
                  const ev = { id: `${Date.now()}-${Math.random().toString(36).slice(2,6)}`, type: 'ai_response', timestamp: new Date().toISOString(), payload: { requesterId: getRequesterId(req), actorId, prompt: finalPrompt, response: r.text ?? null, raw: r.raw ?? r, messages } };
                 await persistence.persistEvent(id, ev);
               }
              if (actorId) {
                const memEv = { id: `${Date.now()}-${Math.random().toString(36).slice(2,6)}`, type: 'character_memory', timestamp: new Date().toISOString(), payload: { characterId: actorId, text: r.text ?? null } };
                await persistence.persistEvent(id, memEv);
                logger.info('ai.mem_persisted', { universe: id, characterId: actorId, eventId: memEv.id });
              }
            } catch (err) {
              logger.error('ai.persist_error', { err: err instanceof Error ? err.message : String(err) });
            }
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify(r));
            return;
          }

      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
    } catch (err) {
      logger.error('http.error', { err: err instanceof Error ? err.message : String(err), stack: err instanceof Error ? err.stack : undefined });
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'internal error' }));
    }
  });

  return server;
}

async function main() {
  const server = createServerInstance();
  await new Promise<void>((resolve) => {
    server.listen(PORT, () => {
      logger.info('http.server_listening', { port: PORT });
      console.log(`HTTP server listening on http://localhost:${PORT}`);
      resolve();
    });
  });
}

// Only auto-start the HTTP server when not running tests and when the
// autostart flag is not explicitly disabled. This prevents tests from
// accidentally binding to the default port when the module is imported.
if (process.env.NODE_ENV !== 'test' && process.env.WORLDCORE_DISABLE_HTTP_AUTOSTART !== '1') {
  // In production require WORLDCORE_USER_KEYS_SECRET to be set for
  // encrypted user key storage. Fail fast to avoid secrets accidentally
  // being stored in plaintext.
  if (process.env.NODE_ENV === 'production' && !process.env.WORLDCORE_USER_KEYS_SECRET) {
    // eslint-disable-next-line no-console
    console.error('WORLDCORE_USER_KEYS_SECRET must be set in production; aborting startup');
    process.exit(1);
  }
  main().catch((err: any) => {
    console.error('server error', err);
    process.exit(1);
  });
}
