import 'dotenv/config';
import http from 'node:http';
import url from 'node:url';
import { SqlitePersistenceAdapter } from '../sqlite/sqlitePersistence.js';
import { FilePersistenceAdapter } from '../fs/filePersistence.js';
import { PersistenceService } from '../../application/persistenceService.js';
import { WorldService } from '../../application/worldService.js';
import { MockAiProvider } from '../ai/mockAiProvider.js';
import logger from '../../utils/logger.js';
import { hashPassword, verifyPassword, isArgon2Available } from '../../utils/password.js';
import { hashToken } from '../../utils/crypto.js';
import { buildWorldContext, compactMessages } from '../../application/contextBuilder.js';

// Default development HTTP port. For local development and testing we use 3001
// to avoid colliding with user-running instances on 3000. This can be
// overridden by setting WORLDCORE_HTTP_PORT in your environment or .env.
const PORT = parseInt(process.env.WORLDCORE_HTTP_PORT || '3001', 10);

// Rate limiter support: default in-memory implementation with optional
// Redis-backed limiter (set WORLDCORE_RATE_LIMIT_BACKEND=redis and
// WORLDCORE_REDIS_URL). The limiter is enabled only when
// WORLDCORE_RATE_LIMIT_PER_MIN is set to a positive integer.
let _inMemoryRateMap = new Map<string, { count: number; windowStart: number }>();
let _redisLimiterFactory: any = null;
// Per-email rate limiter (in-memory). Keyed by normalized email.
let _emailRateMap = new Map<string, { count: number; windowStart: number }>();
// In-memory presence store (per-universe/world). Map<universeId, Map<userId, { lastSeen, accumulatedMs, joinedAt }>>
const _presenceStore: Map<string, Map<string, { lastSeen: number; accumulatedMs: number; joinedAt?: number }>> = new Map();

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

  function ensurePresenceMap(worldId: string) {
  let m = _presenceStore.get(worldId);
  if (!m) { m = new Map(); _presenceStore.set(worldId, m); }
  return m;
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
  const worldService = new WorldService(persistence);
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

    // Helper: wrap a provider's generate method so it injects a language
    // instruction based on the incoming request header 'x-wc-lang' or opts.lang.
    function wrapProviderWithLang(provider: any) {
      try {
        if (!provider || (provider as any).__wc_lang_wrapped) return provider;
        const orig = provider.generate && provider.generate.bind(provider);
        if (typeof orig !== 'function') return provider;
        provider.generate = async function(prompt: any, opts: any) {
          try {
            const headerLang = String(req.headers['x-wc-lang'] || '').trim();
            const optLang = opts && opts.lang ? String(opts.lang).trim() : '';
            const lang = optLang || headerLang || null;
            if (lang) {
              if (opts && Array.isArray(opts.messages)) {
                const insertIdx = (opts.messages.length && opts.messages[0] && opts.messages[0].role === 'system') ? 1 : 0;
                opts.messages.splice(insertIdx, 0, { role: 'system', content: `Respond in the user's language: ${lang}.` });
              } else if (typeof prompt === 'string') {
                prompt = `Respond in the user's language: ${lang}.\n\n` + prompt;
              }
            }
          } catch (e) {
            // ignore injection errors
          }
          return orig(prompt, opts);
        };
        (provider as any).__wc_lang_wrapped = true;
      } catch (e) {}
      return provider;
    }

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
          const prov = await mod.createAiProviderForKey(user.apiKey, userModel);
          return wrapProviderWithLang(prov);
        }
      } catch (e) {
        // ignore and fall back
      }
    }

    const globalProv = await getAiProvider();
    return wrapProviderWithLang(globalProv);
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

  // Context generation and message compaction are provided by the centralized
  // Context Builder (application responsibility). See
  // src/application/contextBuilder.ts for implementation.

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

        // Determine how to send email: support 'smtp' and 'sendmail' via
        // WORLDCORE_EMAIL_TYPE or legacy WORLDCORE_SMTP_HOST env. Default is
        // passive-ok (return {ok:true}) when no transport is configured.
        const emailTypeRaw = (process.env.WORLDCORE_EMAIL_TYPE || (process.env.WORLDCORE_SMTP_HOST ? 'smtp' : '')).toLowerCase();
        const emailType = emailTypeRaw || '';

        if (emailType === 'smtp' || emailType === 'sendmail') {
          try {
            // Use the email helper which wraps nodemailer and is lazy.
            const mod = await import('../../utils/emailSender.js');
            const sendMagicLinkEmail = mod.sendMagicLinkEmail as (email: string, token: string, opts?: any) => Promise<any>;
            const info = await sendMagicLinkEmail(email, token, { externalBase: process.env.WORLDCORE_EXTERNAL_URL, ttlMs });
            try { logger.info('auth.magic_link_sent', { email, messageId: info && (info as any).messageId ? (info as any).messageId : undefined }); } catch (e) {}
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ ok: true }));
            return;
          } catch (err) {
            try { await persistence.deleteMagicLink(token); } catch (e) {}
            res.writeHead(500, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: 'send_failed', message: err instanceof Error ? err.message : String(err) }));
            return;
          }
        }

        // No email transport configured: legacy behavior — return generic ok.
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
              '/api/worlds': { get: { summary: 'List worlds' } },
              '/api/models': { get: { summary: 'List model aliases' }, post: { summary: 'Create model alias', security: [{ ApiKeyAuth: [] }] } },
              '/api/models/{id}': { get: { summary: 'Get model alias' }, put: { summary: 'Update model alias', security: [{ ApiKeyAuth: [] }] }, delete: { summary: 'Delete model alias', security: [{ ApiKeyAuth: [] }] } },
              '/api/world/{id}': { get: { summary: 'Get world snapshot' } },
              '/api/world': { post: { summary: 'Create world', security: [{ ApiKeyAuth: [] }, { bearerAuth: [] }] } },
              '/api/world/{id}/character': { post: { summary: 'Add character', security: [{ ApiKeyAuth: [] }, { bearerAuth: [] }] } },
              '/api/world/{id}/ai': { post: { summary: 'Ask AI scoped to world' } },
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
#sidebar{flex:1;border:1px solid #ddd;padding:1rem;border-radius:6px;background:#fff}
#main{flex:2;border:1px solid #ddd;padding:1rem;border-radius:6px;background:#fff}
pre{background:#f7f7f7;padding:.5rem;overflow:auto;white-space:pre-wrap}

/* Dark theme overrides: use !important where needed to override inline
   or bootstrap defaults so all form controls and containers become dark */
body.dark{background:#0b0b0b;color:#e6e6e6}

/* Keep AI response pre as green-on-black for diagnostics */
body.dark pre{background:#000;color:#0f0}

/* Timeline / log / debug containers: force dark backgrounds and readable text */
body.dark #eventsContainer,
body.dark #logViewer,
body.dark #debugPane { background:#0b0b0b !important; color:#d0d0d0 !important; border-color:#222 !important }
body.dark #eventsContainer ul, body.dark #eventsContainer li { background:transparent !important; color:#d0d0d0 !important }
body.dark #logList li, body.dark #debugList li { color:#d0d0d0 !important }
body.dark .text-muted { color:#9a9a9a !important }

/* Darken cards, sidebars and main area */
body.dark #sidebar,
body.dark #main,
body.dark .card,
body.dark .settings-panel,
body.dark #charModal .card { background:#0b0b0b !important; color:#e6e6e6 !important; border:1px solid #222 !important }

/* Form controls and selects in dark mode: force background/color/border */
body.dark input.form-control,
body.dark textarea.form-control,
body.dark select.form-select,
body.dark .form-select,
body.dark .form-control { background:#111 !important; color:#e6e6e6 !important; border-color:#333 !important }
body.dark input.form-control::placeholder,
body.dark textarea.form-control::placeholder { color:#777 !important }

/* Navbar (overrides bootstrap bg-light) */
body.dark .navbar, body.dark .bg-light { background:#0b0b0b !important; color:#e6e6e6 !important; border-color:#222 !important }
body.dark .navbar-brand { color:#e6e6e6 !important }

/* Buttons and labels */
body.dark .btn, body.dark .btn-outline-secondary, body.dark .btn-sm { color:#e6e6e6 !important }
body.dark .form-check-label { color:#e6e6e6 !important }

/* Character list links */
body.dark #chars li a { color:#9fe3a6 !important }

/* Settings panel: keep scrollable */
.settings-panel{position:fixed;right:1rem;top:4rem;width:320px;max-height:calc(100vh - 6rem);overflow:auto;-webkit-overflow-scrolling:touch;z-index:1000}
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
    <div class="mb-2 d-flex align-items-start">
        <div style="flex:1">
        <label id="labelWorld" class="form-label">Mundo</label>
        <select id="worldSelect" class="form-select"></select>
      </div>
      <div class="ms-2" style="margin-top:1.5rem">
        <button id="openUniverseSettings" class="btn btn-sm btn-outline-secondary" title="World settings">⚙️</button>
      </div>
    </div>
    <div class="mb-2"><button id="loadBtn" class="btn btn-sm btn-secondary">Cargar</button></div>
    <div class="mb-2 d-flex gap-2">
      <button id="openLogViewer" class="btn btn-sm btn-outline-info">Logs</button>
      <button id="openGlobalChars" class="btn btn-sm btn-outline-secondary">Global</button>
    </div>
    <hr/>
    <h5 id="charsHeader">Personajes</h5>
    <ul id="chars" class="list-unstyled"></ul>
    <div id="createCharBlock" class="mt-2">
      <h6 class="mb-1">Crear personaje</h6>
      <input id="newCharId" class="form-control mb-1" placeholder="id (p.ej. bob)" />
      <input id="newCharName" class="form-control mb-1" placeholder="Nombre de personaje" />
      <input id="newCharDesc" class="form-control mb-1" placeholder="Descripción (opcional)" />
      <div class="d-flex gap-2"><button id="createCharBtn" class="btn btn-sm btn-success">Crear personaje</button></div>
    </div>
    <hr/>
    <div class="form-check"><input type="checkbox" id="autoRefresh" class="form-check-input"/><label id="autoRefreshLabel" class="form-check-label">Auto-refresh</label></div>
  </div>
  <div id="main">
    <h5 id="timelineTitle">Timeline (últimos eventos)</h5>
    <div id="eventsContainer" style="max-height:320px;overflow:auto;border:1px solid #eee;padding:.5rem;border-radius:4px;background:#fafafa">
      <ul id="events" class="list-unstyled mb-0"><li class="text-muted">- seleccione un mundo -</li></ul>
    </div>

    <!-- World-level AI defaults modal: opened via gear button next to world selector -->
    <div id="worldSettingsModalOverlay" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,0.4);z-index:1060;">
      <div id="worldAiDefaultsBlock" class="card" style="position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);width:520px;max-width:95%;">
        <div class="card-body">
          <h6 id="worldAiDefaultsTitle" class="card-title">Ajustes AI del mundo</h6>
          <div class="mb-1">
            <label class="form-label" id="defaultAiProfileLabel">Perfil AI por defecto</label>
            <input id="defaultAiProfileInput" class="form-control mb-1" placeholder="e.g. storyteller" />
            <label class="form-label" id="defaultModelOverrideLabel">Model override por defecto</label>
            <input id="defaultModelOverrideInput" class="form-control mb-1" placeholder="optional model alias or name" />
            <div class="mt-1"><button id="saveWorldDefaults" class="btn btn-sm btn-primary">Guardar</button> <button id="worldSettingsCancel" class="btn btn-sm btn-outline-secondary">Cancelar</button></div>
            <div class="mt-2"><small id="worldDefaultsStatus" class="text-muted"></small></div>

            <!-- World profiles management -->
            <div id="worldProfilesContainer" class="mt-3" style="border-top:1px solid #eee;padding-top:.75rem;">
              <h6 class="card-subtitle mb-2">World Profiles</h6>
              <div id="worldProfilesList" class="mb-2"><small class="text-muted">-</small></div>
              <div id="worldCreateProfileForm" class="mb-2">
                <label class="form-label">Create Profile (id)</label>
                <input id="newProfileId" class="form-control mb-1" placeholder="e.g. storyteller" />
                <input id="newProfileName" class="form-control mb-1" placeholder="Display name" />
                <input id="newProfileModel" class="form-control mb-1" placeholder="Model alias or name (optional)" />
                <input id="newProfileDescription" class="form-control mb-1" placeholder="Description (optional)" />
                <div class="d-flex gap-2"><button id="createProfileBtn" class="btn btn-sm btn-success">Create profile</button></div>
              </div>
              <div id="worldProfilesStatus" class="text-muted small"></div>
            </div>

          </div>
        </div>
      </div>
    </div>

    <!-- Global characters modal (managed centrally) -->
    <div id="globalCharsOverlay" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,0.4);z-index:1060;">
      <div class="card" style="position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);width:720px;max-width:95%;">
        <div class="card-body">
          <h5 class="card-title">Global Characters</h5>
          <div id="globalCharsList" style="max-height:300px;overflow:auto;margin-bottom:.5rem;"></div>
          <hr/>
          <h6>Create Global Character</h6>
          <input id="globalCharId" class="form-control mb-1" placeholder="id (unique)" />
          <input id="globalCharName" class="form-control mb-1" placeholder="display name" />
          <input id="globalCharDesc" class="form-control mb-1" placeholder="description (optional)" />
          <textarea id="globalCharMeta" class="form-control mb-1" placeholder='meta JSON (optional, e.g. {"accent":"British"})' rows="3"></textarea>
          <div class="text-end"><button id="createGlobalCharBtn" class="btn btn-sm btn-success">Create</button> <button id="closeGlobalCharsBtn" class="btn btn-sm btn-secondary">Close</button></div>
        </div>
      </div>
    </div>

    <!-- Log viewer: minimal timelapse/log playback for events -->
      <div id="logViewer" style="display:none;margin-top:1rem;border:1px solid #eee;padding:.5rem;border-radius:4px;background:#fff;">
      <div class="d-flex align-items-center mb-2">
        <div class="btn-group me-2" role="group" aria-label="Log Tabs">
          <button id="logTabTimeline" class="btn btn-sm btn-outline-secondary active">Timeline</button>
          <button id="logTabDebug" class="btn btn-sm btn-outline-secondary">Debug</button>
        </div>
        <label class="me-2" for="logFilter">Filter</label>
        <select id="logFilter" class="form-select form-select-sm me-2" style="width:auto;">
          <option value="">All</option>
          <option value="ai_response">AI Response</option>
          <option value="character_memory">Character Memory</option>
          <option value="world_visibility_changed">Visibility</option>
          <option value="owner_assigned">Owner Assigned</option>
        </select>
        <button id="playLog" class="btn btn-sm btn-outline-primary me-1">Play</button>
        <button id="pauseLog" class="btn btn-sm btn-outline-secondary me-1">Pause</button>
        <button id="stepLog" class="btn btn-sm btn-outline-secondary me-1">Step</button>
        <input id="logSpeed" type="number" class="form-control form-control-sm" value="1000" style="width:90px;" />ms
      </div>
      <div id="logTimelinePane" style="max-height:240px;overflow:auto;border-top:1px solid #eee;padding-top:.5rem;"><ul id="logList" class="list-unstyled mb-0"><li class="text-muted">- no logs -</li></ul></div>
      <div id="debugPane" style="display:none;max-height:240px;overflow:auto;border-top:1px solid #eee;padding-top:.5rem;background:#f8f8f8;"><ul id="debugList" class="list-unstyled mb-0"><li class="text-muted">- no debug -</li></ul></div>
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
      <div class="mt-2 text-end"><button id="charModalClose" class="btn btn-sm btn-secondary me-2">Close</button><button id="charModalEdit" class="btn btn-sm btn-primary">Edit</button> <button id="charModalDelete" class="btn btn-sm btn-danger ms-2">Delete</button></div>
    </div>
  </div>
</div>

<script>
async function api(path, opts){
  opts = opts || {};
  const headers = Object.assign({}, opts.headers || {});
  const token = localStorage.getItem('wc_jwt');
  if (token) headers['authorization'] = 'Bearer ' + token;
  // Propagate client language preference to the server so it can instruct
  // the AI provider to respond in the user's language by default.
  try { const lang = localStorage.getItem('wc_lang'); if (lang) headers['x-wc-lang'] = String(lang); } catch(e) {}
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
    universe_label: 'Mundo (World)',
    characters: 'Personajes',
    auto_refresh: 'Auto-refresh',
    timeline_title: 'Timeline (últimos eventos)',
    interact_title: 'Interactuar',
    prompt_placeholder: 'Escribe un mensaje para el personaje...',
    send: 'Enviar',
    ai_none: '- seleccione un mundo -',
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
    enter_universe_id: 'Introduce id del mundo (server/world)',
    invalid_attributes_json: 'Atributos JSON inválidos',
    created: 'Creado',
    deleted: 'Eliminado',
    cloned: 'Clonado',
    added: 'Añadido',
    universe_character_message_required: 'Seleccione mundo, personaje y escriba un mensaje',
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
    save: 'Guardar',
    universe_ai_defaults: 'Ajustes AI del mundo',
    no_universe_selected: 'Ningún mundo seleccionado',
    default_ai_profile: 'Perfil AI por defecto',
    default_model_override: 'Model override por defecto',
    accent_label: 'Acento',
    ai_profile_saved: 'Perfil AI guardado',
    no_permission: 'No tienes permiso para modificar los ajustes del mundo',
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
    universe_label: 'World',
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
    enter_universe_id: 'Enter world id',
    invalid_attributes_json: 'Invalid attributes JSON',
    created: 'Created',
    deleted: 'Deleted',
    cloned: 'Cloned',
    added: 'Added',
    universe_character_message_required: 'World, character and message required',
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
    save: 'Save',
    universe_ai_defaults: 'World AI Defaults',
    no_universe_selected: 'No world selected',
    default_ai_profile: 'Default AI Profile',
    default_model_override: 'Default Model Override',
    accent_label: 'Accent',
    ai_profile_saved: 'AI profile saved',
    no_permission: 'You do not have permission to modify world defaults',
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
    const lblUni = document.getElementById('labelWorld'); if (lblUni) lblUni.textContent = t('world_label');
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
    const uniAiTitle = document.getElementById('worldAiDefaultsTitle'); if (uniAiTitle) uniAiTitle.textContent = t('world_ai_defaults');
    const defaultAiProfileLabel = document.getElementById('defaultAiProfileLabel'); if (defaultAiProfileLabel) defaultAiProfileLabel.textContent = t('default_ai_profile');
    const defaultModelOverrideLabel = document.getElementById('defaultModelOverrideLabel'); if (defaultModelOverrideLabel) defaultModelOverrideLabel.textContent = t('default_model_override');
    // hide until permission check runs
    const uniBlock = document.getElementById('worldAiDefaultsBlock'); if (uniBlock) uniBlock.style.display = 'none';
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

    async function listWorlds(){
      try{
        const r = await api('/api/worlds');
        const ids = await r.json();
        const sel = document.getElementById('worldSelect');
        if (!sel) return;
        sel.innerHTML = '';
        for (const id of ids) { const o = document.createElement('option'); o.value = id; o.textContent = id; sel.appendChild(o); }
      } catch (e) { console.error(e); }
    }

  // Utility to escape HTML content before inserting into the event list
  function _escapeHtml(s){ return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

  // Keep last loaded world snapshot accessible for permission checks
  let lastWorldSnapshot = null;
  // Cache last known owner id per loaded world to avoid transient UI hiding
  let lastOwnerIdCache = null;

  async function loadWorld(id) {
  if (!id) return;
  try {
    const r = await api('/api/world/' + id);
    if (!r.ok) {
      document.getElementById('events').textContent = 'error al cargar mundo';
      return;
    }
    const u = await r.json();
    // store snapshot for later permission checks
    try { lastWorldSnapshot = u; lastOwnerIdCache = (u && (u.owner || (u.attributes && u.attributes.owner))) || null; } catch (e) {}
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
        // Determine owner id from snapshot; fall back to cached owner to avoid transient hide
        const ownerIdFromSnap = (u && ((u.owner) || (u.attributes && u.attributes.owner))) || null;
        const effectiveOwner = ownerIdFromSnap || lastOwnerIdCache || null;
        if (effectiveOwner && (effectiveOwner === currentUserId || (u.members||[]).some(function(m){return m.userId===currentUserId;}))) {
          visContainer.style.display='block';
          const chk = document.getElementById('publicToggle');
              if (chk) {
                try { chk.checked = !!(u.attributes && u.attributes.public); } catch(e) {}
                chk.onchange = async function(){
                  try {
               const res = await api('/api/world/'+id+'/visibility', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ public: chk.checked }) });
                    if (!res.ok) { showAlert('danger', t('failed_update_visibility')); } else { await loadWorld(id); }
                  } catch(e){ console.error(e); showAlert('danger', t('error_update_visibility')); }
                };
              }
        } else { visContainer.style.display='none'; }
        } catch(e){ console.error(e); }
    })();

    // After rendering the world snapshot and visibility, refresh world AI defaults UI
    try { await refreshWorldAiProfileFields(); } catch (e) { /* ignore */ }
  } catch (e) { console.error(e); document.getElementById('events').textContent = 'error'; }
}
  // Log viewer support: load events, render and play back
  let logEvents = [];
  let logIndex = -1;
  let logTimer = null;
  // Limit number of log entries rendered to avoid client-side jank
  let logDisplayLimit = 200;

  async function loadLogEvents() {
    try {
      const id = document.getElementById('worldSelect').value;
      if (!id) return;
    const r = await api('/api/world/' + id);
      if (!r.ok) { document.getElementById('logList').innerHTML = '<li class="text-muted">' + t('no_logs') + '</li>'; return; }
      const u = await r.json();
      // keep the full array in memory but render only a window (most recent entries)
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
    const toShow = filtered.slice(0, logDisplayLimit);
    listEl.innerHTML = toShow.map(function(ev, idx){ try { return '<li data-evid="'+_escapeHtml(ev.id)+'" data-idx="'+idx+'">['+_escapeHtml(ev.timestamp||'')+'] <strong>'+_escapeHtml(ev.type)+'</strong>: '+_escapeHtml(JSON.stringify(ev.payload).slice(0,200))+'</li>'; } catch(e){ return '<li>' + _escapeHtml(JSON.stringify(ev)) + '</li>'; } }).join('');
    // If there are more entries available, show a Load more button
    const moreBtnId = 'logLoadMoreBtn';
    try {
      let moreBtn = document.getElementById(moreBtnId);
      if (filtered.length > toShow.length) {
        if (!moreBtn) {
          moreBtn = document.createElement('button');
          moreBtn.id = moreBtnId;
          moreBtn.className = 'btn btn-sm btn-outline-secondary mt-2';
          moreBtn.textContent = 'Load more...';
          listEl.parentNode.appendChild(moreBtn);
        }
        moreBtn.style.display = 'inline-block';
        moreBtn.onclick = function(){ logDisplayLimit = Math.min(logDisplayLimit + 200, filtered.length); renderLogList(); };
      } else {
        if (moreBtn) moreBtn.style.display = 'none';
      }
    } catch (e) { /* ignore DOM append errors */ }
    // click to view event details
    listEl.querySelectorAll('li[data-evid]').forEach(function(li){ li.addEventListener('click', async function(){ const evId = this.getAttribute('data-evid'); try { const id = document.getElementById('worldSelect').value; const er = await api('/api/world/' + id + '/event/' + encodeURIComponent(evId)); if (!er.ok) { showAlert('danger', t('error_generic')); return; } const evJ = await er.json(); showAlert('info', JSON.stringify(evJ, null, 2), 10000); } catch(e){ console.error(e); showAlert('danger', t('error_generic')); } }); });
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
  // Tabs for log viewer: Timeline vs Debug
  document.getElementById('logTabTimeline')?.addEventListener('click', async ()=>{ try { document.getElementById('logTabTimeline').classList.add('active'); document.getElementById('logTabDebug').classList.remove('active'); document.getElementById('logTimelinePane').style.display='block'; document.getElementById('debugPane').style.display='none'; await loadLogEvents(); } catch(e){} });
  document.getElementById('logTabDebug')?.addEventListener('click', async ()=>{ try { document.getElementById('logTabDebug').classList.add('active'); document.getElementById('logTabTimeline').classList.remove('active'); document.getElementById('logTimelinePane').style.display='none'; document.getElementById('debugPane').style.display='block'; await loadDebugPrompts(); } catch(e){} });

  async function loadDebugPrompts(){
    try{
      const id = document.getElementById('worldSelect').value;
      if (!id) return;
      const r = await api('/api/world/' + id);
      if (!r.ok) { document.getElementById('debugList').innerHTML = '<li class="text-muted">' + t('no_logs') + '</li>'; return; }
      const u = await r.json();
      const events = (u.events || []).slice().reverse();
      const aiEv = events.filter(function(ev){ return String(ev.type) === 'ai_response'; });
      if (!aiEv.length) { document.getElementById('debugList').innerHTML = '<li class="text-muted">' + t('no_logs') + '</li>'; return; }
      const items = aiEv.map(function(ev){
        try{
          const ts = _escapeHtml(String(ev.timestamp || ''));
          const actor = _escapeHtml(String((ev.payload && ev.payload.actorId) || 'AI'));
          // try to get resolved model metadata from provider raw
          const raw = (ev.payload && (ev.payload.raw || ev.payload.raw)) || {};
          const meta = raw && raw.__wc_meta ? raw.__wc_meta : { resolvedModel: raw.model || (raw?.model || null), resolvedProfile: (ev.payload && ev.payload.profile) || null };
          const model = _escapeHtml(String(meta && meta.resolvedModel ? meta.resolvedModel : '-'));
          const profile = _escapeHtml(String(meta && meta.resolvedProfile ? meta.resolvedProfile : '-'));
          const promptPreview = _escapeHtml(String((ev.payload && (ev.payload.prompt || (ev.payload.raw && ev.payload.raw.prompt))) || '').slice(0, 1000));
          return '<li><div><small class="text-muted">[' + ts + '] model: ' + model + ' profile: ' + profile + ' actor: ' + actor + '</small></div><pre style="background:#000;color:#0f0;padding:.5rem;white-space:pre-wrap;">' + promptPreview + '</pre></li>';
        }catch(e){ return '<li>' + _escapeHtml(JSON.stringify(ev).slice(0,200)) + '</li>'; }
      }).join('');
      document.getElementById('debugList').innerHTML = items;
    }catch(e){ console.error(e); document.getElementById('debugList').innerHTML = '<li class="text-muted">' + t('no_logs') + '</li>'; }
  }
  document.getElementById('playLog').addEventListener('click', ()=>{ playLog(); });
  document.getElementById('pauseLog').addEventListener('click', ()=>{ pauseLog(); });
  document.getElementById('stepLog').addEventListener('click', ()=>{ stepLog(); });
  document.getElementById('logFilter').addEventListener('change', ()=>{ renderLogList(); });

  document.getElementById('loadBtn').addEventListener('click', ()=>{ const id=document.getElementById('worldSelect').value; loadWorld(id); });
  // Create character button in sidebar
  try {
    const createCharBtn = document.getElementById('createCharBtn');
    if (createCharBtn) createCharBtn.addEventListener('click', async function(){
      try {
        const id = document.getElementById('worldSelect').value;
        if (!id) { showAlert('warning', t('enter_world_id')); return; }
        const cid = String((document.getElementById('newCharId') || {}).value || '').trim();
        const cname = String((document.getElementById('newCharName') || {}).value || '').trim();
        const cdesc = String((document.getElementById('newCharDesc') || {}).value || '').trim();
        if (!cid || !cname) { showAlert('warning', 'id and name required'); return; }
        const body = { id: cid, name: cname, description: cdesc || null };
        const r = await api('/api/world/' + id + '/character', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
        if (!r.ok) { const j = await r.json().catch(()=>({})); showAlert('danger', t('error_generic') + ': ' + (j.error || j.code || r.status)); return; }
        showAlert('success', t('created'));
        (document.getElementById('newCharId') || {}).value = '';
        (document.getElementById('newCharName') || {}).value = '';
        (document.getElementById('newCharDesc') || {}).value = '';
        await listWorlds();
        await loadWorld(id);
      } catch (e) { console.error(e); showAlert('danger', t('error_generic')); }
    });
  } catch (e) {}
  async function openCharacterModal(worldId, charId) {
    try {
      const res = await api('/api/world/' + worldId + '/character/' + encodeURIComponent(charId));
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

      // AI profile assignment: show a select populated with world profiles
      try {
        const currentProfile = (ch.meta && ch.meta.aiProfile) ? ch.meta.aiProfile : '';
        const currentModelOverride = (ch.meta && ch.meta.modelOverride) ? ch.meta.modelOverride : '';
        bodyEl.innerHTML += '<hr/>';
        bodyEl.innerHTML += '<div class="mb-2"><label class="form-label">' + t('default_ai_profile') + '</label><select id="charAiProfileSelect" class="form-select mb-1"><option value="">- none -</option></select></div>';
        bodyEl.innerHTML += '<div class="mb-2"><label class="form-label">' + t('default_model_override') + '</label><input id="charModelOverride" class="form-control mb-1" value="' + _escapeHtml(currentModelOverride) + '" placeholder="optional model alias or name" /></div>';
        // character language and accent (meta)
        try {
          const currentLang = (ch.meta && ch.meta.language) ? ch.meta.language : '';
          const currentAccent = (ch.meta && ch.meta.accent) ? ch.meta.accent : '';
          bodyEl.innerHTML += '<div class="mb-2"><label class="form-label">' + t('language_label') + '</label><select id="charLanguageSelect" class="form-select mb-1"><option value="">(default)</option><option value="es"' + (currentLang==='es' ? ' selected' : '') + '>Español</option><option value="en"' + (currentLang==='en' ? ' selected' : '') + '>English</option></select></div>';
          bodyEl.innerHTML += '<div class="mb-2"><label class="form-label">' + t('accent_label') + '</label><input id="charAccentInput" class="form-control mb-1" value="' + _escapeHtml(currentAccent) + '" placeholder="e.g. British, Mexican" /></div>';
        } catch (e) {}
        bodyEl.innerHTML += '<div class="text-end"><button id="saveCharAi" class="btn btn-sm btn-primary">' + t('save') + ' ' + t('edit_character') + '</button> <button id="saveCharMeta" class="btn btn-sm btn-outline-primary ms-2">Save meta</button></div>';
        // populate profile select from world profiles
        (async function(){
          try{
            const r = await api('/api/world/' + worldId + '/profiles');
            if (!r.ok) return;
            const j = await r.json();
            const sel = document.getElementById('charAiProfileSelect');
            if (!sel) return;
            sel.innerHTML = '<option value="">- none -</option>' + (Array.isArray(j.profiles) ? j.profiles.map(function(p){ return '<option value="'+_escapeHtml(String(p.id))+'">'+_escapeHtml(String(p.name || p.id))+' '+(_escapeHtml(String(p.model || '')))+'</option>'; }).join('') : '');
            try { if (currentProfile) sel.value = currentProfile; } catch(e){}
          }catch(e){ console.error(e); }
        })();
      } catch (e) { console.error(e); }

      const eventsContainer = document.getElementById('charEvents');
      let page = 0;
      const limit = 3;
      async function loadEvents(p) {
        try {
            const r = await api('/api/world/' + worldId + '/character/' + encodeURIComponent(charId) + '/events?page=' + encodeURIComponent(p) + '&limit=' + limit);
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
            eventsContainer.querySelectorAll('.view-event').forEach(function(b){ b.addEventListener('click', async function(){ const evId = this.getAttribute('data-evid'); try { const er = await api('/api/world/' + worldId + '/event/' + encodeURIComponent(evId)); if (!er.ok) { showAlert('danger', t('error_generic')); return; } const evJ = await er.json(); showAlert('info', JSON.stringify(evJ, null, 2), 10000); } catch (e) { console.error(e); showAlert('danger', t('error_generic')); } }); });
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
            const r2 = await api('/api/world/' + worldId + '/character/' + encodeURIComponent(charId), { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
          if (!r2.ok) { showAlert('danger', t('error_generic')); return; }
          showAlert('success', t('edit') + ' ' + (ch.name || ''));
          // refresh world and modal
          await listWorlds();
          await loadWorld(worldId);
          openCharacterModal(worldId, charId);
        } catch (e) { console.error(e); showAlert('danger', t('error_generic')); }
      };
      // Delete character handler
      try {
        const delBtn = document.getElementById('charModalDelete');
        if (delBtn) delBtn.addEventListener('click', async function(){
          try {
            if (!confirm('Delete character ' + (ch.name || charId) + '?')) return;
            const r = await api('/api/world/' + worldId + '/character/' + encodeURIComponent(charId), { method: 'DELETE' });
            if (!r.ok) { const j = await r.json().catch(()=>({})); showAlert('danger', t('error_generic') + ': ' + (j.error || j.code || r.status)); return; }
            showAlert('success', t('deleted'));
            document.getElementById('charModalOverlay').style.display = 'none';
            await listWorlds();
            await loadWorld(worldId);
          } catch (e) { console.error(e); showAlert('danger', t('error_generic')); }
        });
      } catch (e) {}
      // Save AI profile for character
      try {
        const saveBtn = document.getElementById('saveCharAi');
        if (saveBtn) saveBtn.addEventListener('click', async function(){
          try {
            const profileSelect = document.getElementById('charAiProfileSelect');
            const profile = profileSelect ? String(profileSelect.value || '').trim() : '';
            const modelOverride = String(document.getElementById('charModelOverride').value || '').trim();
            const body = { profile: profile === '' ? null : profile, modelOverride: modelOverride === '' ? null : modelOverride };
            const r = await api('/api/world/' + worldId + '/character/' + encodeURIComponent(charId) + '/ai-profile', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
            if (!r.ok) { const j = await r.json().catch(()=>({})); showAlert('danger', t('error_generic') + ': ' + (j.error || j.code || r.status)); return; }
            showAlert('success', t('ai_profile_saved'));
            await listWorlds();
            await loadWorld(worldId);
            openCharacterModal(worldId, charId);
          } catch (e) { console.error(e); showAlert('danger', t('error_generic')); }
        });
        const saveMetaBtn = document.getElementById('saveCharMeta');
        if (saveMetaBtn) saveMetaBtn.addEventListener('click', async function(){
          try {
            const langSel = document.getElementById('charLanguageSelect');
            const accentEl = document.getElementById('charAccentInput');
            const lang = langSel ? String(langSel.value || '').trim() : '';
            const accent = accentEl ? String((accentEl.value || '')).trim() : '';
            const meta = {};
            if (lang) meta.language = lang; else meta.language = null;
            if (accent) meta.accent = accent; else meta.accent = null;
            const body = { meta };
            const r = await api('/api/world/' + worldId + '/character/' + encodeURIComponent(charId), { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
            if (!r.ok) { const j = await r.json().catch(()=>({})); showAlert('danger', t('error_generic') + ': ' + (j.error || j.code || r.status)); return; }
            showAlert('success', t('save'));
            await listWorlds();
            await loadWorld(worldId);
            openCharacterModal(worldId, charId);
          } catch (e) { console.error(e); showAlert('danger', t('error_generic')); }
        });
      } catch (e) {}
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
        const worldId = document.getElementById('worldSelect').value;
        if (!worldId || !charId) return;
        openCharacterModal(worldId, charId);
      }
    } catch (e) { console.error(e); }
  });
  
  // Global characters UI: load list, create and assign
  async function loadGlobalChars() {
    try {
      const r = await api('/api/characters/global');
      if (!r.ok) { showAlert('danger', 'Failed to load global characters'); return; }
      const j = await r.json();
      const listEl = document.getElementById('globalCharsList');
      if (!listEl) return;
      const chars = Array.isArray(j.characters) ? j.characters : [];
      if (!chars.length) { listEl.innerHTML = '<div class="text-muted">- none -</div>'; return; }
      listEl.innerHTML = chars.map(function(c){ return '<div class="d-flex align-items-start justify-content-between mb-2"><div style="flex:1"><strong>' + _escapeHtml(c.id) + '</strong> — ' + _escapeHtml(c.name || '') + '<br/><small class="text-muted">' + _escapeHtml(c.description || '') + '</small></div><div style="margin-left:8px"><div class="btn-group" role="group"><button class="btn btn-sm btn-outline-primary assignGlobalBtn" data-id="' + _escapeHtml(c.id) + '">Assign</button><button class="btn btn-sm btn-outline-secondary cloneGlobalBtn" data-id="' + _escapeHtml(c.id) + '">Clone as...</button><button class="btn btn-sm btn-outline-danger delGlobalBtn" data-id="' + _escapeHtml(c.id) + '">Delete</button></div></div></div>'; }).join('');
      // attach handlers
      (listEl.querySelectorAll('.assignGlobalBtn') || []).forEach(function(btn){ btn.addEventListener('click', async function(){ try{ const id = this.getAttribute('data-id'); const target = document.getElementById('worldSelect').value; if (!target) { showAlert('warning', 'Select a world first'); return; } const res = await api('/api/characters/global/' + encodeURIComponent(id) + '/assign', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ targetWorld: target }) }); if (!res.ok) { const jj = await res.json().catch(()=>({})); showAlert('danger', 'Assign failed: ' + (jj.error || jj.code || res.status)); return; } showAlert('success', 'Assigned to ' + target); await loadWorld(target); }catch(e){ console.error(e); showAlert('danger', 'Assign failed'); } }); });
      (listEl.querySelectorAll('.cloneGlobalBtn') || []).forEach(function(btn){ btn.addEventListener('click', async function(){ try{ const id = this.getAttribute('data-id'); const newId = prompt('New local id (leave empty to reuse):', id); if (newId === null) return; const target = document.getElementById('worldSelect').value; if (!target) { showAlert('warning', 'Select a world first'); return; } const body = { targetWorld: target, newId: newId || id }; const res = await api('/api/characters/global/' + encodeURIComponent(id) + '/assign', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); if (!res.ok) { const jj = await res.json().catch(()=>({})); showAlert('danger', 'Clone failed: ' + (jj.error || jj.code || res.status)); return; } showAlert('success', 'Cloned as ' + (newId || id)); await loadWorld(target); }catch(e){ console.error(e); showAlert('danger', 'Clone failed'); } }); });
      (listEl.querySelectorAll('.delGlobalBtn') || []).forEach(function(btn){ btn.addEventListener('click', async function(){ try{ const id = this.getAttribute('data-id'); if (!confirm('Delete global character ' + id + '?')) return; const res = await api('/api/characters/global/' + encodeURIComponent(id), { method: 'DELETE' }); if (!res.ok) { const jj = await res.json().catch(()=>({})); showAlert('danger', 'Delete failed: ' + (jj.error || jj.code || res.status)); return; } showAlert('success', 'Deleted'); await loadGlobalChars(); }catch(e){ console.error(e); showAlert('danger', 'Delete failed'); } }); });
    } catch (e) { console.error(e); showAlert('danger', 'Failed to load global characters'); }
  }

  // Create new global character from modal
  try {
    const createBtn = document.getElementById('createGlobalCharBtn');
    if (createBtn) createBtn.addEventListener('click', async function(){ try{ const idEl = document.getElementById('globalCharId'); const nameEl = document.getElementById('globalCharName'); const descEl = document.getElementById('globalCharDesc'); const metaEl = document.getElementById('globalCharMeta'); const id = idEl ? String(idEl.value || '').trim() : ''; const name = nameEl ? String(nameEl.value || '').trim() : ''; const description = descEl ? String(descEl.value || '').trim() : ''; const metaText = metaEl ? String(metaEl.value || '').trim() : ''; if (!id || !name) { showAlert('warning', 'id and name required'); return; } let meta = undefined; if (metaText) { try { meta = JSON.parse(metaText); } catch (e) { showAlert('warning', 'Invalid meta JSON'); return; } } const body = { id, name, description: description || null, meta: meta || {} }; const res = await api('/api/characters/global', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); if (!res.ok) { const jj = await res.json().catch(()=>({})); showAlert('danger', 'Create failed: ' + (jj.error || jj.code || res.status)); return; } showAlert('success', 'Created'); if (idEl) idEl.value=''; if (nameEl) nameEl.value=''; if (descEl) descEl.value=''; if (metaEl) metaEl.value=''; await loadGlobalChars(); }catch(e){ console.error(e); showAlert('danger', 'Create failed'); } });
  } catch (e) {}

  // Open/close handlers for global modal
  try { const openBtn = document.getElementById('openGlobalChars'); if (openBtn) openBtn.addEventListener('click', function(){ try{ const overlay = document.getElementById('globalCharsOverlay'); if (!overlay) return; const isShown = overlay.style.display === 'block'; overlay.style.display = isShown ? 'none' : 'block'; if (!isShown) loadGlobalChars(); }catch(e){} }); const closeBtn = document.getElementById('closeGlobalCharsBtn'); if (closeBtn) closeBtn.addEventListener('click', function(){ try{ const overlay = document.getElementById('globalCharsOverlay'); if (overlay) overlay.style.display = 'none'; }catch(e){} }); } catch (e) {}
document.getElementById('send').addEventListener('click', async ()=>{ const id=document.getElementById('worldSelect').value; const cid=document.getElementById('charSelect').value; const msg=document.getElementById('prompt').value; if(!id||!cid||!msg){ showAlert('warning', t('world_character_message_required')); return; } try{ const payload = { message: msg, actorId: cid }; const r = await api('/api/world/'+id+'/ai',{ method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify(payload) }); const j = await r.json(); document.getElementById('aiOut').textContent = j?.text ?? JSON.stringify(j, null, 2); try{ await loadWorld(id); }catch(e){ /* ignore refresh errors */ } }catch(e){ console.error(e); showAlert('danger', t('error_calling_ai')); } });

  window.addEventListener('load', async ()=>{ 
    // apply translations early so UI labels render in the chosen language
    applyTranslations();
    // Ensure the AI connection indicator is populated immediately on load
    // (so the status badge left of the theme toggle is accurate on F5 / fresh open)
    try { await refreshUserStatus(); } catch (e) { console.error('refreshUserStatus failed on load', e); }
            await listWorlds();
    const sel = document.getElementById('worldSelect');
    if (sel && sel.options && sel.options.length) await loadWorld(sel.value);
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
          const id = document.getElementById('worldSelect').value;
          if (id) loadWorld(id);
        }
      } catch (e) {
        // ignore
      }
    }, 2000);
  // init settings
  const theme = localStorage.getItem('wc_theme') || 'light'; if (theme === 'dark') document.body.classList.add('dark');
  document.getElementById('themeToggle').addEventListener('click', ()=>{ const t = document.body.classList.toggle('dark'); localStorage.setItem('wc_theme', t ? 'dark' : 'light'); });
  document.getElementById('openSettings').addEventListener('click', ()=>{ const p = document.getElementById('settingsPanel'); p.style.display = p.style.display === 'none' ? 'block' : 'none'; refreshUserStatus(); });
  // Universe settings gear: open the per-world modal (do not show on global Settings)
  try {
    const worldBtn = document.getElementById('openWorldSettings');
    if (worldBtn) worldBtn.addEventListener('click', ()=>{ try{ const overlay = document.getElementById('worldSettingsModalOverlay'); if(!overlay) return; const isShown = overlay.style.display === 'block'; overlay.style.display = isShown ? 'none' : 'block'; if (!isShown) refreshWorldAiProfileFields(); }catch(e){} });
    const worldCancel = document.getElementById('worldSettingsCancel');
    if (worldCancel) worldCancel.addEventListener('click', ()=>{ try{ const overlay = document.getElementById('worldSettingsModalOverlay'); if (overlay) overlay.style.display = 'none'; }catch(e){} });
  } catch (e) {}
  // When opening settings or changing selected world, refresh world AI defaults fields
  async function refreshWorldAiProfileFields(){
    try{
      const id = document.getElementById('worldSelect').value;
      const defaultAiEl = document.getElementById('defaultAiProfileInput');
      const defaultModelEl = document.getElementById('defaultModelOverrideInput');
      const statusEl = document.getElementById('worldDefaultsStatus');
      const profilesListEl = document.getElementById('worldProfilesList');
      const profilesStatusEl = document.getElementById('worldProfilesStatus');

      if (!id) {
        if (defaultAiEl) defaultAiEl.value = '';
        if (defaultModelEl) defaultModelEl.value = '';
        if (statusEl) statusEl.textContent = t('no_world_selected');
        if (profilesListEl) profilesListEl.innerHTML = '';
        if (profilesStatusEl) profilesStatusEl.textContent = '';
        return;
      }

      // First fetch the world snapshot to check whether the current user
      // has permission to modify world-level defaults.
      const snapRes = await api('/api/world/' + id);
      if (!snapRes.ok) {
        if (statusEl) statusEl.textContent = t('error_generic');
        const block = document.getElementById('worldAiDefaultsBlock'); if (block) block.style.display = 'none';
        return;
      }
      const snap = await snapRes.json();
      // determine current user id from UI (refreshUserStatus should have populated this)
      const currentUser = String((document.getElementById('currentUserId') && document.getElementById('currentUserId').textContent) || '');
      let allowed = false;
      try {
        if (currentUser && currentUser !== '-' && snap) {
          if (snap.owner && snap.owner === currentUser) allowed = true;
          if (!allowed && Array.isArray(snap.members)) {
            for (const m of snap.members) {
              if (m.userId === currentUser && (m.role === 'editor' || m.role === 'admin' || m.role === 'owner')) { allowed = true; break; }
            }
          }
        }
      } catch (e) { allowed = false; }

      if (!allowed) {
        // hide the block when the current user lacks permission
        const block = document.getElementById('worldAiDefaultsBlock'); if (block) block.style.display = 'none';
        if (statusEl) statusEl.textContent = t('no_permission');
        return;
      }

      // user is allowed: show block and fetch the current defaults
      const block = document.getElementById('worldAiDefaultsBlock'); if (block) block.style.display = 'block';
      const r = await api('/api/world/' + id + '/ai-profile');
      if (!r.ok) { if (statusEl) statusEl.textContent = t('error_generic'); return; }
      const j = await r.json();
      if (defaultAiEl) defaultAiEl.value = j.defaultAiProfile || '';
      if (defaultModelEl) defaultModelEl.value = j.defaultModelOverride || '';
      if (statusEl) statusEl.textContent = '';

      // Attach saveWorldDefaults handler (clone to avoid duplicate listeners)
      try {
        const saveBtn = document.getElementById('saveWorldDefaults');
        if (saveBtn) {
          const newSave = saveBtn.cloneNode(true);
          saveBtn.parentNode.replaceChild(newSave, saveBtn);
              newSave.addEventListener('click', async ()=>{
            try{
              const profile = String((document.getElementById('defaultAiProfileInput') || {}).value || '').trim();
              const modelOverride = String((document.getElementById('defaultModelOverrideInput') || {}).value || '').trim();
              const body = { defaultAiProfile: profile === '' ? null : profile, defaultModelOverride: modelOverride === '' ? null : modelOverride };
              const rr = await api('/api/world/' + id + '/ai-profile', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
              if (!rr.ok) { const jj = await rr.json().catch(()=>({})); showAlert('danger', t('error_generic') + ': ' + (jj.error || jj.code || rr.status)); return; }
              showAlert('success', t('ai_profile_saved'));
              try { const overlay = document.getElementById('worldSettingsModalOverlay'); if (overlay) overlay.style.display = 'none'; } catch(e) {}
              await listWorlds();
              await loadWorld(id);
              await refreshWorldAiProfileFields();
            }catch(e){ console.error(e); showAlert('danger', t('error_generic')); }
          });
        }
      } catch (e) {}

      // Load and render world profiles
      try {
        if (profilesListEl) profilesListEl.innerHTML = '<small class="text-muted">Loading...</small>';
        if (profilesStatusEl) profilesStatusEl.textContent = '';
        const rp = await api('/api/world/' + id + '/profiles');
        if (!rp.ok) { if (profilesStatusEl) profilesStatusEl.textContent = t('error_generic'); if (profilesListEl) profilesListEl.innerHTML = ''; return; }
        const pj = await rp.json();
        const profiles = Array.isArray(pj.profiles) ? pj.profiles : [];
        if (!profiles.length) {
          if (profilesListEl) profilesListEl.innerHTML = '<div class="text-muted">- no profiles -</div>';
        } else {
          const items = profiles.map(function(p){
            const pid = p.profileId || p.id || '';
            const name = p.name || pid;
            const model = p.model || '-';
            const desc = p.description ? (' - ' + p.description) : '';
            return '<div class="d-flex align-items-center justify-content-between mb-1"><div><strong>' + _escapeHtml(name) + '</strong> <small>(' + _escapeHtml(pid) + ')</small> <small class="text-muted">model: ' + _escapeHtml(model) + '</small>' + _escapeHtml(desc) + '</div><div><button class="btn btn-sm btn-outline-danger deleteProfileBtn" data-profile-id="' + _escapeHtml(pid) + '">Delete</button></div></div>';
          }).join('');
          if (profilesListEl) profilesListEl.innerHTML = items;
          // attach delete handlers
          try {
            const delBtns = profilesListEl.querySelectorAll('.deleteProfileBtn');
            delBtns.forEach(function(btn){
              btn.addEventListener('click', async function(ev){
                try {
                  ev.preventDefault();
                  const pid = this.getAttribute('data-profile-id');
                  if (!pid) return;
                  if (!confirm('Delete profile ' + pid + '?')) return;
                  const dr = await api('/api/world/' + id + '/profiles/' + encodeURIComponent(pid), { method: 'DELETE' });
                  if (!dr.ok) { const jj = await dr.json().catch(()=>({})); showAlert('danger', t('error_generic') + ': ' + (jj.error || jj.code || dr.status)); return; }
                  showAlert('success', t('deleted'));
                  await refreshUniverseAiProfileFields();
                } catch (e) { console.error(e); showAlert('danger', t('error_generic')); }
              });
            });
          } catch (e) {}
        }
        // Create profile handler (ensure not attached multiple times)
        try {
          const createBtn = document.getElementById('createProfileBtn');
          if (createBtn && !createBtn.dataset.wcInit) {
            createBtn.addEventListener('click', async function(){
              try {
                const pidEl = document.getElementById('newProfileId');
                const pnameEl = document.getElementById('newProfileName');
                const pmodelEl = document.getElementById('newProfileModel');
                const pdescEl = document.getElementById('newProfileDescription');
                const pid = pidEl ? String(pidEl.value || '').trim() : '';
                const pname = pnameEl ? String(pnameEl.value || '').trim() : '';
                const pmodel = pmodelEl ? String(pmodelEl.value || '').trim() : '';
                const pdesc = pdescEl ? String(pdescEl.value || '').trim() : '';
                if (!pid || !pname) { showAlert('warning', 'Profile id and name required'); return; }
                const body = { id: pid, name: pname };
                if (pmodel) body.model = pmodel;
                if (pdesc) body.description = pdesc;
                const cr = await api('/api/world/' + id + '/profiles', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
                if (!cr.ok) { const jj = await cr.json().catch(()=>({})); showAlert('danger', t('error_generic') + ': ' + (jj.error || jj.code || cr.status)); return; }
                showAlert('success', t('created'));
                if (pidEl) pidEl.value = ''; if (pnameEl) pnameEl.value = ''; if (pmodelEl) pmodelEl.value = ''; if (pdescEl) pdescEl.value = '';
                await refreshUniverseAiProfileFields();
              } catch (e) { console.error(e); showAlert('danger', t('error_generic')); }
            });
            createBtn.dataset.wcInit = '1';
          }
        } catch (e) {}
      } catch (e) { console.error(e); if (profilesStatusEl) profilesStatusEl.textContent = t('error_generic'); }
    }catch(e){ console.error(e); try{ document.getElementById('worldDefaultsStatus').textContent = t('error_generic'); }catch(e){} }
  }
  document.getElementById('worldSelect').addEventListener('change', ()=>{ try{ refreshWorldAiProfileFields(); }catch(e){} });
  // Profiles creation/deletion handlers are attached dynamically by refreshUniverseAiProfileFields
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
    await listWorlds();
    const sel = document.getElementById('worldSelect');
    if (sel && sel.options && sel.options.length) await loadWorld(sel.value);
      } catch (e) { /* ignore */ }
    } else {
      showAlert('warning', t('paste_valid_jwt'));
    }
  });
  document.getElementById('clearJwt').addEventListener('click', async ()=>{ localStorage.removeItem('wc_jwt'); showAlert('info', t('token_cleared')); try { await refreshUserStatus(); await listWorlds(); const sel = document.getElementById('worldSelect'); if (sel && sel.options && sel.options.length) await loadWorld(sel.value); } catch (e) {} });
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
          try { await refreshUserStatus(); await listWorlds(); const sel = document.getElementById('worldSelect'); if (sel && sel.options && sel.options.length) await loadWorld(sel.value); } catch (e) {}
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
          try { await refreshUserStatus(); await listWorlds(); const sel = document.getElementById('worldSelect'); if (sel && sel.options && sel.options.length) await loadWorld(sel.value); } catch (e) {}
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
              await listWorlds();
        const sel2 = document.getElementById('worldSelect');
        if (sel2 && sel2.options && sel2.options.length) await loadWorld(sel2.value);
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
  <li>GET /api/worlds — list worlds</li>
  <li>GET /api/world/:id — show world snapshot</li>
  <li>POST /api/world — create world JSON {id,name,description,attributes}</li>
  <li>POST /api/world/:id/character — add character JSON {id,name,description}</li>
  <li>POST /api/world/:id/clone — clone world JSON {newId,newName,newDescription}</li>
  <li>DELETE /api/world/:id — delete world</li>
<li>POST /api/ai — {"prompt":"..."}</li>
<li>CLI alternative: use <code>npm run cli -- &lt;command&gt;</code></li>
</ul>
<script>
async function api(path, opts){ const r=await fetch(path,opts); return r.json(); }
async function list(){document.getElementById('out').textContent=JSON.stringify(await api('/api/worlds'),null,2)}
let refreshTimer = null;
async function show(){
  const id=document.getElementById('id').value;
  if (!id) { window.alert('enter universe id'); return; }
  const u = await api('/api/world/'+id);
  const lines = [];
  lines.push('World: ' + u.name + ' (id: ' + u.id + ')');
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
    refreshTimer = setInterval(async () => { try { const u2 = await api('/api/world/'+id); document.getElementById('out').textContent = '... refreshing ...\n' + JSON.stringify(u2, null, 2); } catch (e) { /* ignore */ } }, 3000);
  }
}
async function add(){const id=document.getElementById('id').value; const cid=document.getElementById('cid').value; const name=document.getElementById('cname').value; const desc=document.getElementById('cdesc').value; await api('/api/world/'+id+'/character',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id:cid,name,description:desc})}); window.alert('added');}
async function createUniverse(){
  const id=document.getElementById('newId').value;
  const name=document.getElementById('newName').value;
  const desc=document.getElementById('newDesc').value;
  const policy=document.getElementById('eventPolicy').value;
  const attrsText=document.getElementById('newAttrs').value;
  let attrs;
  try{attrs=attrsText?JSON.parse(attrsText):{};}catch(e){window.alert('invalid attributes JSON');return;}
  attrs = { ...(attrs||{}), eventPolicy: policy };
  await api('/api/world',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id,name,description:desc,attributes:attrs})});
  window.alert('created');
}
async function deleteUniverse(){const id=document.getElementById('delId').value; await fetch('/api/world/'+id,{method:'DELETE'}); window.alert('deleted');}
async function cloneUniverse(){const src=document.getElementById('srcId').value; const nid=document.getElementById('cloneId').value; const nname=document.getElementById('cloneName').value; await api('/api/world/'+src+'/clone',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({newId:nid,newName:nname})}); window.alert('cloned');}

async function interact(){
  const uid = document.getElementById('interactUniverse').value;
  const cid = document.getElementById('interactChar').value;
  const msg = document.getElementById('interactMessage').value;
  if (!uid || !cid || !msg) { window.alert('universe, character and message required'); return; }
  const prompt = 'Act as ' + cid + '. ' + msg;
  const res = await api('/api/world/'+uid+'/ai', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt }) });
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

      if (req.method === 'GET' && path === '/api/worlds') {
        // Filter universes: unassigned universes are public; assigned universes
        // are visible only to owner and invited members.
        const actorId = getRequesterId(req);
        const ids = await persistence.listWorldIds();
        const visible: string[] = [];
        for (const id of ids) {
          try {
            const u = await persistence.loadWorld(id);
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

    if (req.method === 'POST' && path === '/api/world') {
        const body = await jsonBody(req);
        if (!body || !body.id || !body.name) {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'invalid body, expected {id,name}' }));
          return;
        }
        if (!requireAuth(req, res)) return;
        // Identify requester (may be undefined when auth is not configured)
        const actorId = getRequesterId(req);
        const u = await worldService.createWorld(body.id, body.name, body.description, body.attributes, actorId);
        res.writeHead(201, { 'content-type': 'application/json' });
        res.end(JSON.stringify(u.snapshot()));
        return;
      }

      // Global characters CRUD: create/list/get/update/delete
      const GLOBAL_CHARS_ID = '__global_chars';

      if (req.method === 'GET' && path === '/api/characters/global') {
        try {
          const g = await persistence.loadWorld(GLOBAL_CHARS_ID);
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ characters: (g && g.listCharacters && g.listCharacters()) || [] }));
          return;
        } catch (e) { res.writeHead(500, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'failed' })); return; }
      }

      if (req.method === 'GET' && path?.startsWith('/api/characters/global/')) {
        const charId = decodeURIComponent(path.replace('/api/characters/global/', ''));
        try {
          const g = await persistence.loadWorld(GLOBAL_CHARS_ID);
          const ch = g && g.getCharacter ? g.getCharacter(charId) : undefined;
          if (!ch) { res.writeHead(404, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'not_found' })); return; }
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify(ch));
          return;
        } catch (e) { res.writeHead(500, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'failed' })); return; }
      }

      if (req.method === 'POST' && path === '/api/characters/global') {
        if (!requireAuth(req, res)) return;
        const actorId = getRequesterId(req);
        if (!actorId || actorId === 'api-key') { res.writeHead(403, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'jwt_required' })); return; }
        try {
          const body = await jsonBody(req);
          if (!body || !body.id || !body.name) { res.writeHead(400, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'invalid body, expected {id,name,description?,meta?}' })); return; }
          const ev = { id: `${Date.now()}-${Math.random().toString(36).slice(2,6)}`, type: 'global_character_created', timestamp: new Date().toISOString(), payload: { characterId: String(body.id), name: body.name, description: body.description || null, owner: actorId, meta: body.meta || {} } };
          await persistence.persistEvent(GLOBAL_CHARS_ID, ev);
          const events = await persistence.loadEvents(GLOBAL_CHARS_ID);
          const { World } = await import('../../domain/world.js');
          const updated = World.reconstructFromEvents(GLOBAL_CHARS_ID, undefined, events);
          await persistence.saveSnapshot(updated);
          res.writeHead(201, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: true, character: ev.payload }));
          return;
        } catch (e) { res.writeHead(500, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'failed', message: e instanceof Error ? e.message : String(e) })); return; }
      }

      if (req.method === 'PUT' && path?.startsWith('/api/characters/global/')) {
        if (!requireAuth(req, res)) return;
        const actorId = getRequesterId(req);
        if (!actorId || actorId === 'api-key') { res.writeHead(403, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'jwt_required' })); return; }
        const charId = decodeURIComponent(path.replace('/api/characters/global/', ''));
        try {
          const body = await jsonBody(req) || {};
          const ev = { id: `${Date.now()}-${Math.random().toString(36).slice(2,6)}`, type: 'global_character_updated', timestamp: new Date().toISOString(), payload: { characterId: charId, name: typeof body.name === 'undefined' ? undefined : body.name, description: typeof body.description === 'undefined' ? undefined : body.description, meta: typeof body.meta === 'undefined' ? undefined : body.meta, actor: actorId } };
          await persistence.persistEvent(GLOBAL_CHARS_ID, ev);
          const events = await persistence.loadEvents(GLOBAL_CHARS_ID);
          const { World } = await import('../../domain/world.js');
           const updated = World.reconstructFromEvents(GLOBAL_CHARS_ID, undefined, events);
          await persistence.saveSnapshot(updated);
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
          return;
        } catch (e) { res.writeHead(500, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'failed' })); return; }
      }

      if (req.method === 'DELETE' && path?.startsWith('/api/characters/global/')) {
        if (!requireAuth(req, res)) return;
        const actorId = getRequesterId(req);
        if (!actorId || actorId === 'api-key') { res.writeHead(403, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'jwt_required' })); return; }
        const charId = decodeURIComponent(path.replace('/api/characters/global/', ''));
        try {
          const ev = { id: `${Date.now()}-${Math.random().toString(36).slice(2,6)}`, type: 'global_character_deleted', timestamp: new Date().toISOString(), payload: { characterId: charId, actor: actorId } };
          await persistence.persistEvent(GLOBAL_CHARS_ID, ev);
          const events = await persistence.loadEvents(GLOBAL_CHARS_ID);
          const { World } = await import('../../domain/world.js');
           const updated = World.reconstructFromEvents(GLOBAL_CHARS_ID, undefined, events);
          await persistence.saveSnapshot(updated);
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
          return;
        } catch (e) { res.writeHead(500, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'failed' })); return; }
      }

      // Assign/clone a global character into a world
      if (req.method === 'POST' && path?.startsWith('/api/characters/global/') && path.endsWith('/assign')) {
        if (!requireAuth(req, res)) return;
        const actorId = getRequesterId(req);
        if (!actorId || actorId === 'api-key') { res.writeHead(403, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'jwt_required' })); return; }
        const charId = decodeURIComponent(path.replace('/api/characters/global/', '').replace('/assign', ''));
        try {
          const body = await jsonBody(req) || {};
          // Require explicit targetWorld in the request body. Legacy targetUniverse is no longer supported.
          const target = typeof body.targetWorld === 'string' ? String(body.targetWorld) : null;
          const newId = body.newId ? String(body.newId) : charId;
          if (!target) { res.writeHead(400, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'invalid body, expected { targetWorld, newId? }' })); return; }
          const targetSnap = await persistence.loadWorld(target);
          if (!hasModifyPermission(targetSnap, actorId)) { res.writeHead(403, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'forbidden' })); return; }
          // Load global character
          const globalU = await persistence.loadWorld(GLOBAL_CHARS_ID);
          const ch = globalU && globalU.getCharacter ? globalU.getCharacter(charId) : undefined;
          if (!ch) { res.writeHead(404, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'not_found' })); return; }
          // Persist character_added event into target universe
          const ev = { id: `${Date.now()}-${Math.random().toString(36).slice(2,6)}`, type: 'character_added', timestamp: new Date().toISOString(), payload: { characterId: newId, name: ch.name, description: ch.description } };
          await persistence.persistEvent(target, ev);
          const events = await persistence.loadEvents(target);
          const { World } = await import('../../domain/world.js');
           const updated = World.reconstructFromEvents(target, undefined, events);
          await persistence.saveSnapshot(updated);
          res.writeHead(201, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: true, target: target }));
          return;
        } catch (e) { res.writeHead(500, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'failed', message: e instanceof Error ? e.message : String(e) })); return; }
      }

      // Anchors endpoints: list, latest and create an anchor (checkpoint)
      // Note: anchors are persisted via the PersistencePort; creating an anchor
      // will export the ledger, compute the chain checkpoint and persist an
      // Anchor record. Listing is allowed publicly; creating requires owner
      // permissions (or api-key) when auth is configured.
      if (req.method === 'GET' && path?.startsWith('/api/world/') && path.endsWith('/anchors/latest')) {
        const id = path.replace('/api/world/', '').replace('/anchors/latest', '');
        try {
          const anchor = await persistence.getLatestAnchor(id);
          if (!anchor) { res.writeHead(404, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'not_found' })); return; }
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify(anchor));
          return;
        } catch (e) { res.writeHead(500, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'failed' })); return; }
      }

      if (req.method === 'GET' && path?.startsWith('/api/world/') && path.endsWith('/anchors')) {
        const id = path.replace('/api/world/', '').replace('/anchors', '');
        try {
          const anchors = await persistence.loadAnchors(id);
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify(anchors));
          return;
        } catch (e) { res.writeHead(500, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'failed' })); return; }
      }

      // Owner claim / owner-status endpoints (minimal implementation)
      if (req.method === 'POST' && path?.startsWith('/api/world/') && path.endsWith('/owner/claim')) {
        const id = path.replace('/api/world/', '').replace('/owner/claim', '');
        try {
          if (!requireAuth(req, res)) return; // require auth for claiming
          const actorId = getRequesterId(req);
          if (!actorId || actorId === 'api-key') { res.writeHead(403, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'jwt_required' })); return; }
          const snapBefore = await persistence.loadWorld(id);
          const currentOwner = typeof snapBefore.getOwner === 'function' ? snapBefore.getOwner() : undefined;
          if (currentOwner) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: false, status: 'denied', reason: 'already_owned', owner: currentOwner })); return; }
          // Minimal behavior: assign owner immediately (promote)
          const ev = { id: `${Date.now()}-${Math.random().toString(36).slice(2,6)}`, type: 'owner_assigned', timestamp: new Date().toISOString(), payload: { ownerId: actorId, members: [{ userId: actorId, role: 'owner' }] } };
          await persistence.persistEvent(id, ev);
          const events = await persistence.loadEvents(id);
          const { World } = await import('../../domain/world.js');
           const updatedU = World.reconstructFromEvents(id, undefined, events);
          await persistence.saveSnapshot(updatedU);
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: true, status: 'promoted', owner: actorId }));
          return;
        } catch (e) { res.writeHead(500, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'failed' })); return; }
      }

      if (req.method === 'GET' && path?.startsWith('/api/world/') && path.endsWith('/owner-status')) {
        const id = path.replace('/api/world/', '').replace('/owner-status', '');
        try {
          const snap = await persistence.loadWorld(id);
          const owner = typeof snap.getOwner === 'function' ? snap.getOwner() : undefined;
          // reservedOwner not implemented in this minimal pass
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ owner: owner || null, reservedOwner: null, candidates: [] }));
          return;
        } catch (e) { res.writeHead(500, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'failed' })); return; }
      }

      // Presence endpoints: support join/leave/heartbeat and querying presence
      if (req.method === 'POST' && path?.startsWith('/api/world/') && path.endsWith('/presence')) {
        const id = path.replace('/api/world/', '').replace('/presence', '');
        try {
          const body = await jsonBody(req) || {};
          const action = String(body.action || '').toLowerCase();
          const providedUserId = body.userId ? String(body.userId) : undefined;
          // Prefer authenticated identity when available
          const actor = getRequesterId(req) || providedUserId || 'anonymous';
          const now = Date.now();
          const map = ensurePresenceMap(id);
          // Helper to persist presence events (pseudonymize user for ledger)
          async function persistPresenceEvent(type: string, payload: any) {
            try {
              try {
                const { pseudonymize } = await import('../../utils/crypto.js');
                const pseudo = actor ? pseudonymize(actor) : undefined;
                const ev = { id: `${Date.now()}-${Math.random().toString(36).slice(2,6)}`, type, timestamp: new Date().toISOString(), payload: Object.assign({}, payload, { requesterPseudo: pseudo }) };
                await persistence.persistEvent(id, ev);
              } catch (e) {
                const ev = { id: `${Date.now()}-${Math.random().toString(36).slice(2,6)}`, type, timestamp: new Date().toISOString(), payload };
                await persistence.persistEvent(id, ev);
              }
            } catch (e) { /* log but do not fail presence update */ }
          }

          if (action === 'join') {
            const prev = map.get(actor) || { lastSeen: now, accumulatedMs: 0 };
            prev.joinedAt = prev.joinedAt || now;
            prev.lastSeen = now;
            map.set(actor, prev);
            await persistPresenceEvent('presence_join', { userId: actor });
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ ok: true }));
            return;
          }

          if (action === 'heartbeat') {
            const entry = map.get(actor) || { lastSeen: now, accumulatedMs: 0 };
            const delta = entry.lastSeen ? Math.max(0, now - entry.lastSeen) : 0;
            entry.accumulatedMs = Number(entry.accumulatedMs || 0) + delta;
            entry.lastSeen = now;
            map.set(actor, entry);
            // No ledger event for every heartbeat to avoid noise; optional sampling could persist summary
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ ok: true }));
            return;
          }

          if (action === 'leave') {
            const entry = map.get(actor);
            if (entry) {
              const delta = entry.lastSeen ? Math.max(0, now - entry.lastSeen) : 0;
              entry.accumulatedMs = Number(entry.accumulatedMs || 0) + delta;
              entry.lastSeen = now;
              map.delete(actor);
              await persistPresenceEvent('presence_leave', { userId: actor, accumulatedMs: entry.accumulatedMs });
            }
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ ok: true }));
            return;
          }

          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'invalid action', allowed: ['join','leave','heartbeat'] }));
          return;
        } catch (e) {
          res.writeHead(500, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'failed' }));
          return;
        }
      }

      if (req.method === 'GET' && path?.startsWith('/api/world/') && path.endsWith('/presence')) {
        const id = path.replace('/api/world/', '').replace('/presence', '');
        try {
          const map = _presenceStore.get(id) || new Map();
          const users = [];
          for (const [uid, entry] of map.entries()) {
            users.push({ userId: uid, lastSeen: entry.lastSeen, accumulatedMs: entry.accumulatedMs || 0, joinedAt: entry.joinedAt || null });
          }
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ count: users.length, users }));
          return;
        } catch (e) { res.writeHead(500, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'failed' })); return; }
      }

      // Character update: update name/description or meta (language/accent etc.)
      if (req.method === 'PUT' && path?.startsWith('/api/world/') && path.includes('/character/')) {
        const tail = path.replace('/api/world/', '');
        const parts = tail.split('/character/');
        const id = parts[0];
        const charPart = parts[1] || '';
        const charId = decodeURIComponent(String(charPart));

        try {
          if (!requireAuth(req, res)) return;
          const actorId = getRequesterId(req);
          const snapBefore = await persistence.loadWorld(id);
          if (!hasModifyPermission(snapBefore, actorId)) { res.writeHead(403, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'forbidden' })); return; }
          const body = await jsonBody(req) || {};
          // Accept { name?, description?, meta? } or shorthand { language, accent }
          const payload: any = { characterId: charId };
          if (typeof body.name !== 'undefined') payload.name = body.name;
          if (typeof body.description !== 'undefined') payload.description = body.description;
          if (body.meta && typeof body.meta === 'object') payload.meta = body.meta;
          if (typeof body.language !== 'undefined' || typeof body.accent !== 'undefined') {
            payload.meta = payload.meta || {};
            if (typeof body.language !== 'undefined') payload.meta.language = body.language;
            if (typeof body.accent !== 'undefined') payload.meta.accent = body.accent;
          }
          payload.actor = actorId;
          const ev = { id: `${Date.now()}-${Math.random().toString(36).slice(2,6)}`, type: 'character_meta_updated', timestamp: new Date().toISOString(), payload };
          await persistence.persistEvent(id, ev);
          const events = await persistence.loadEvents(id);
          const { World } = await import('../../domain/world.js');
           const updatedU = World.reconstructFromEvents(id, undefined, events);
          await persistence.saveSnapshot(updatedU);
          const ch = updatedU.getCharacter(charId);
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: true, character: ch }));
          return;
        } catch (e) { res.writeHead(500, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'failed' })); return; }
      }

      // Character AI profile endpoints: get/set per-character preferred profile or model overrides
      if (path?.startsWith('/api/world/') && path.includes('/character/') && path.endsWith('/ai-profile')) {
        // parse universe id and character id
        const tail = path.replace('/api/world/', '');
        const parts = tail.split('/character/');
        const id = parts[0];
        const charPart = parts[1] || '';
        const charId = decodeURIComponent(String(charPart).replace('/ai-profile', ''));

        if (req.method === 'GET') {
          try {
            const u = await persistence.loadWorld(id);
            const ch = u.getCharacter(charId);
            if (!ch) { res.writeHead(404, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'not_found' })); return; }
            const meta = (ch as any).meta || {};
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ profile: meta.aiProfile ?? null, modelOverride: meta.modelOverride ?? null }));
            return;
          } catch (e) { res.writeHead(500, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'failed' })); return; }
        }

        if (req.method === 'POST') {
          try {
            if (!requireAuth(req, res)) return;
            const actorId = getRequesterId(req);
            const snapBefore = await persistence.loadWorld(id);
            if (!hasModifyPermission(snapBefore, actorId)) { res.writeHead(403, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'forbidden' })); return; }
            const body = await jsonBody(req);
            if (!body || (typeof body.profile === 'undefined' && typeof body.modelOverride === 'undefined')) { res.writeHead(400, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'invalid body, expected {profile?,modelOverride?}' })); return; }
            // Create event and persist it, then reconstruct universe from
            // events and persist an updated snapshot so the snapshot and
            // ledger remain consistent.
            const ev = { id: `${Date.now()}-${Math.random().toString(36).slice(2,6)}`, type: 'character_ai_profile_updated', timestamp: new Date().toISOString(), payload: { characterId: charId, profile: typeof body.profile === 'undefined' ? null : body.profile, modelOverride: typeof body.modelOverride === 'undefined' ? null : body.modelOverride, actor: actorId } };
            await persistence.persistEvent(id, ev);
            // Reconstruct universe from events so reconstruction logic applies
            const events = await persistence.loadEvents(id);
            const { World } = await import('../../domain/world.js');
            const updatedU = World.reconstructFromEvents(id, undefined, events);
            // Save snapshot based on reconstructed state
            await persistence.saveSnapshot(updatedU);
            const ch = updatedU.getCharacter(charId);
            const meta = (ch as any)?.meta || {};
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ ok: true, profile: meta.aiProfile ?? null, modelOverride: meta.modelOverride ?? null }));
            return;
          } catch (e) { res.writeHead(500, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'failed' })); return; }
        }
      }

      // Universe-level AI profile defaults: get/set defaults via API so users
      // can configure per-world preferred profile or model override. These are
      // stored in snapshot.attributes and emitted as events for auditability.
      if (req.method === 'GET' && path?.startsWith('/api/world/') && path.endsWith('/ai-profile')) {
        const id = path.replace('/api/world/', '').replace('/ai-profile', '');
        try {
          const u = await persistence.loadWorld(id);
          const attrs = u.attributes || {};
          const defaultAiProfile = Object.prototype.hasOwnProperty.call(attrs, 'defaultAiProfile') ? attrs.defaultAiProfile : null;
          const defaultModelOverride = Object.prototype.hasOwnProperty.call(attrs, 'defaultModelOverride') ? attrs.defaultModelOverride : null;
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ defaultAiProfile, defaultModelOverride }));
          return;
        } catch (e) { res.writeHead(500, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'failed' })); return; }
      }

      // World-level profiles: list
      if (req.method === 'GET' && path?.startsWith('/api/world/') && path.endsWith('/profiles')) {
        const id = path.replace('/api/world/', '').replace('/profiles', '');
        try {
          const u = await persistence.loadWorld(id);
          const attrs = u.attributes || {};
          const profiles = attrs.profiles && typeof attrs.profiles === 'object' ? Object.values(attrs.profiles) : [];
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ profiles }));
          return;
        } catch (e) { res.writeHead(500, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'failed' })); return; }
      }

      // World-level profiles: create
      if (req.method === 'POST' && path?.startsWith('/api/world/') && path.endsWith('/profiles')) {
        const id = path.replace('/api/world/', '').replace('/profiles', '');
        if (!requireAuth(req, res)) return;
        const actorId = getRequesterId(req);
        const snapBefore = await persistence.loadWorld(id);
        if (!hasModifyPermission(snapBefore, actorId)) { res.writeHead(403, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'forbidden' })); return; }
        try {
          const body = await jsonBody(req);
          if (!body || !body.id || !body.name) { res.writeHead(400, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'invalid body, expected {id,name,model?}' })); return; }
          const ev = { id: `${Date.now()}-${Math.random().toString(36).slice(2,6)}`, type: 'world_profile_created', timestamp: new Date().toISOString(), payload: { profileId: String(body.id), name: body.name, description: body.description || null, model: body.model || null, defaultTemperature: typeof body.defaultTemperature === 'undefined' ? null : body.defaultTemperature, defaultMaxTokens: typeof body.defaultMaxTokens === 'undefined' ? null : body.defaultMaxTokens, actor: actorId } };
          await persistence.persistEvent(id, ev);
          const events = await persistence.loadEvents(id);
          const { World } = await import('../../domain/world.js');
          const updatedU = World.reconstructFromEvents(id, undefined, events);
          await persistence.saveSnapshot(updatedU);
          res.writeHead(201, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: true, profile: ev.payload }));
          return;
        } catch (e) { res.writeHead(500, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'failed' })); return; }
      }

      // World-level profiles: delete
      if (req.method === 'DELETE' && path?.startsWith('/api/world/') && path.includes('/profiles/')) {
        const id = path.replace('/api/world/', '').split('/profiles/')[0];
        const profileId = decodeURIComponent(path.split('/profiles/')[1] || '');
        if (!requireAuth(req, res)) return;
        const actorId = getRequesterId(req);
        const snapBefore = await persistence.loadWorld(id);
        if (!hasModifyPermission(snapBefore, actorId)) { res.writeHead(403, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'forbidden' })); return; }
        try {
          const ev = { id: `${Date.now()}-${Math.random().toString(36).slice(2,6)}`, type: 'world_profile_deleted', timestamp: new Date().toISOString(), payload: { profileId, actor: actorId } };
          await persistence.persistEvent(id, ev);
          const events = await persistence.loadEvents(id);
          const { World } = await import('../../domain/world.js');
          const updatedU = World.reconstructFromEvents(id, undefined, events);
          await persistence.saveSnapshot(updatedU);
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
          return;
        } catch (e) { res.writeHead(500, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'failed' })); return; }
      }

      if (req.method === 'POST' && path?.startsWith('/api/world/') && path.endsWith('/ai-profile')) {
        const id = path.replace('/api/world/', '').replace('/ai-profile', '');
        if (!requireAuth(req, res)) return;
        const actorId = getRequesterId(req);
        const snapBefore = await persistence.loadWorld(id);
        if (!hasModifyPermission(snapBefore, actorId)) { res.writeHead(403, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'forbidden' })); return; }
        try {
          const body = await jsonBody(req);
          if (!body || (typeof body.defaultAiProfile === 'undefined' && typeof body.defaultModelOverride === 'undefined')) { res.writeHead(400, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'invalid body, expected {defaultAiProfile?, defaultModelOverride?}' })); return; }
          const ev = { id: `${Date.now()}-${Math.random().toString(36).slice(2,6)}`, type: 'world_ai_profile_updated', timestamp: new Date().toISOString(), payload: { defaultAiProfile: typeof body.defaultAiProfile === 'undefined' ? null : body.defaultAiProfile, defaultModelOverride: typeof body.defaultModelOverride === 'undefined' ? null : body.defaultModelOverride, actor: actorId } };
          await persistence.persistEvent(id, ev);
          const events = await persistence.loadEvents(id);
          const { World } = await import('../../domain/world.js');
          const updatedU = World.reconstructFromEvents(id, undefined, events);
          await persistence.saveSnapshot(updatedU);
          const attrs = updatedU.attributes || {};
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: true, defaultAiProfile: attrs.defaultAiProfile ?? null, defaultModelOverride: attrs.defaultModelOverride ?? null }));
          return;
        } catch (e) { res.writeHead(500, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'failed' })); return; }
      }

      if (req.method === 'POST' && path?.startsWith('/api/world/') && path.endsWith('/anchors')) {
        const id = path.replace('/api/world/', '').replace('/anchors', '');
        if (!requireAuth(req, res)) return;
        const actorId = getRequesterId(req);
        const snapBefore = await persistence.loadWorld(id);
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

      if (req.method === 'GET' && path?.startsWith('/api/world/')) {
        const id = path.replace('/api/world/', '');
        const u = await persistence.loadWorld(id);
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(u.snapshot()));
        return;
      }

      

      if (req.method === 'POST' && path?.startsWith('/api/world/') && path.endsWith('/character')) {
        const id = path.replace('/api/world/', '').replace('/character', '');
        const body = await jsonBody(req);
        if (!body || !body.id || !body.name) {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'invalid body, expected {id,name}' }));
          return;
        }
        if (!requireAuth(req, res)) return;
        // Permission check: only owners or editors may modify a universe
        const actorId = getRequesterId(req);
        const snapBefore = await persistence.loadWorld(id);
        if (!hasModifyPermission(snapBefore, actorId)) {
          res.writeHead(403, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'forbidden' }));
          return;
        }
        await worldService.addCharacter(id, { id: body.id, name: body.name, description: body.description });
        const u = await persistence.loadWorld(id);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(u.snapshot()));
        return;
      }

      // Delete a character from a universe
      if (req.method === 'DELETE' && path?.startsWith('/api/world/') && path.includes('/character/')) {
        const tail = path.replace('/api/world/', '');
        const parts = tail.split('/character/');
        const id = parts[0];
        const charPart = parts[1] || '';
        const charId = decodeURIComponent(String(charPart));
        if (!requireAuth(req, res)) return;
        const actorId = getRequesterId(req);
        const snapBefore = await persistence.loadWorld(id);
        if (!hasModifyPermission(snapBefore, actorId)) { res.writeHead(403, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'forbidden' })); return; }
        try {
          const ev = { id: `${Date.now()}-${Math.random().toString(36).slice(2,6)}`, type: 'character_deleted', timestamp: new Date().toISOString(), payload: { characterId: charId, actor: actorId } };
          await persistence.persistEvent(id, ev);
          const events = await persistence.loadEvents(id);
          const { World } = await import('../../domain/world.js');
           const updatedU = World.reconstructFromEvents(id, undefined, events);
          await persistence.saveSnapshot(updatedU);
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
          return;
        } catch (e) { res.writeHead(500, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'failed' })); return; }
      }

      if (req.method === 'POST' && path?.startsWith('/api/world/') && path.endsWith('/clone')) {
        const id = path.replace('/api/world/', '').replace('/clone', '');
        const body = await jsonBody(req);
        if (!body || !body.newId) {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'invalid body, expected {newId,newName?}' }));
          return;
        }
        // perform clone: copy events and snapshot
        const source = await persistence.loadWorld(id);
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
        const newU = await persistence.loadWorld(body.newId);
        res.writeHead(201, { 'content-type': 'application/json' });
        res.end(JSON.stringify(newU.snapshot()));
        return;
      }

      // Clone a character from this universe into another universe
      if (req.method === 'POST' && path?.startsWith('/api/world/') && path.includes('/character/') && path.endsWith('/clone')) {
        // path: /api/world/:src/character/:charId/clone
        const tail = path.replace('/api/world/', '');
        const parts = tail.split('/character/');
        const srcId = parts[0];
        const charPart = parts[1] || '';
        const charId = decodeURIComponent(String(charPart).replace('/clone', ''));
        if (!requireAuth(req, res)) return;
        const actorId = getRequesterId(req);
        const srcSnap = await persistence.loadWorld(srcId);
        // Require modify permission on target later; body must include targetWorld
        try {
          const body = await jsonBody(req) || {};
          const target = typeof body.targetWorld === 'string' ? String(body.targetWorld) : null;
          const newId = typeof body.newId === 'string' ? String(body.newId) : charId;
          if (!target) { res.writeHead(400, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'invalid body, expected {targetWorld, newId?}' })); return; }
          // Read character from source
          const ch = srcSnap.getCharacter(charId);
          if (!ch) { res.writeHead(404, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'not_found' })); return; }
          // Check permission on target
            const targetSnapBefore = await persistence.loadWorld(target);
          if (!hasModifyPermission(targetSnapBefore, actorId)) { res.writeHead(403, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'forbidden' })); return; }
          // Use UniverseService to add character to target universe
          await worldService.addCharacter(target, { id: newId, name: ch.name, description: ch.description });
            const u = await persistence.loadWorld(target);
          res.writeHead(201, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: true, target: u.snapshot() }));
          return;
        } catch (e) { res.writeHead(500, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'failed', message: e instanceof Error ? e.message : String(e) })); return; }
      }

      // Visibility toggle: owner can make an assigned universe public in lists
      if (req.method === 'POST' && path?.startsWith('/api/world/') && path.endsWith('/visibility')) {
        const id = path.replace('/api/world/', '').replace('/visibility', '');
        if (!requireAuth(req, res)) return;
        const actorId = getRequesterId(req);
        const snap = await persistence.loadWorld(id);
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
            const ev = { id: `${Date.now()}-${Math.random().toString(36).slice(2,6)}`, type: 'world_visibility_changed', timestamp: new Date().toISOString(), payload: { public: !!body.public, changedByPseudo: pseudo } };
            await persistence.persistEvent(id, ev);
          } catch (e) {
            const ev = { id: `${Date.now()}-${Math.random().toString(36).slice(2,6)}`, type: 'world_visibility_changed', timestamp: new Date().toISOString(), payload: { public: !!body.public } };
            await persistence.persistEvent(id, ev);
          }

          // Update snapshot attributes
          const updated = await persistence.loadWorld(id);
          updated.attributes = { ...(updated.attributes || {}), public: !!body.public } as any;
          await persistence.saveSnapshot(updated);
          const newSnap = await persistence.loadWorld(id);
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
      if (req.method === 'POST' && path?.startsWith('/api/world/') && path.endsWith('/members')) {
        const id = path.replace('/api/world/', '').replace('/members', '');
        if (!requireAuth(req, res)) return;
        const actorId = getRequesterId(req);
        const snapBefore = await persistence.loadWorld(id);
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
          const updated = await worldService.addMember(id, body.userId, body.role);
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
      if (req.method === 'DELETE' && path?.startsWith('/api/world/') && path.includes('/members/')) {
        const id = path.replace('/api/world/', '').split('/members/')[0];
        const userToRemove = path.split('/members/')[1];
        if (!requireAuth(req, res)) return;
        const actorId = getRequesterId(req);
        const snapBefore = await persistence.loadWorld(id);
        if (!hasOwnerPermission(snapBefore, actorId)) {
          res.writeHead(403, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'forbidden' }));
          return;
        }
        try {
          const updated = await worldService.removeMember(id, userToRemove);
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
      if (req.method === 'GET' && path?.startsWith('/api/world/') && path.endsWith('/members')) {
        const id = path.replace('/api/world/', '').replace('/members', '');
        const snap = await persistence.loadWorld(id);
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

      if (req.method === 'DELETE' && path?.startsWith('/api/world/')) {
        if (!requireAuth(req, res)) return;
        const id = path.replace('/api/world/', '');
        const actorId = getRequesterId(req);
        const snap = await persistence.loadWorld(id);
        if (!hasOwnerPermission(snap, actorId)) {
          res.writeHead(403, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'forbidden' }));
          return;
        }
        await persistence.deleteWorld(id);
        res.writeHead(204);
        res.end();
        return;
      }

      // User endpoints: manage per-user API keys and profile. GET /api/user is
      // intentionally forgiving: when no auth header is present we return a
      // minimal public view so the /play UI can render without spamming the
      // console with 401/403 errors. If an Authorization/x-api-key header is
      // supplied, validate it and return the authenticated user's info.
      if (req.method === 'GET' && path === '/api/user') {
        const hasAuthHdr = Boolean(req.headers['authorization'] || req.headers['x-api-key']);
        const globalKey = process.env.OPENAI_API_KEY || process.env.WORLDCORE_OPENAI_KEY || null;
        const globalModel = process.env.WORLDCORE_OPENAI_MODEL || null;

        if (!hasAuthHdr) {
          // No auth provided: return minimal public-facing info (non-sensitive)
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ id: null, provider: null, hasKey: false, meta: {}, globalProviderConfigured: !!globalKey, globalProviderModel: globalModel }));
          return;
        }

        // Auth header present: validate and return authenticated user or an
        // error if the token/key is invalid (preserves previous behaviour).
        if (!requireAuth(req, res)) return;
        const actorId = getRequesterId(req);
        if (!actorId || actorId === 'api-key') {
          res.writeHead(403, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'jwt_required' }));
          return;
        }
        const user = await persistence.loadUser(actorId);
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
        // If body.worldId is provided, load world context
          if (body.worldId) {
            let snapU = await persistence.loadWorld(body.worldId);
            const events = await persistence.loadEvents(body.worldId);
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
                   await persistence.persistEvent(body.worldId, assignEv);
                // materialize snapshot immediately so subsequent logic sees owner
                 const updatedU = await persistence.loadWorld(body.worldId);
                await persistence.saveSnapshot(updatedU);
                snapU = updatedU;
                // reload events to include owner_assigned
                // (events variable will be recomputed below if needed)
              }
            } catch (e) {
              // Ignore owner assignment failures; continue without blocking AI call
            }
            const ctx = buildWorldContext(snapU.snapshot(), events);
            // Build structured messages for multi-turn chat (system + user).
            let messages = [ { role: 'system', content: ctx }, { role: 'user', content: body.prompt } ];
            // compact messages to avoid context-length errors
            messages = compactMessages(messages, 120000);
            
            const ai = await getAiProviderForRequest(req, 'conversation');
            // Determine profile/modelOverride preference: per-character meta > universe attributes > default
            let chosenProfile: any = 'conversation';
            let modelOverride: any = undefined;
            let actorIdFromPrompt: string | undefined = undefined;
            try {
              const actorUser = getRequesterId(req);
              // If the request includes an explicit actor (detected earlier), prefer its profile
              // Note: actor identification above used detect-by-name heuristics; here we attempt
              // to read character meta if actorId was resolved earlier in this scope.
              // We don't want to re-run heavy logic; use the snapU loaded above.
              // Attempt to detect actorId from messages if available
              try {
                const chars = snapU.listCharacters();
                for (const c of chars) {
                  const name = (c.name || '').replace(/[.*+?^${}()|[\\]\\]/g, '\\$&');
                  const re = new RegExp(`\\b${name}\\b`, 'i');
                  if (re.test(body.prompt)) { actorIdFromPrompt = c.id; break; }
                }
              } catch (e) {}
              const actorIdToUse = actorIdFromPrompt || undefined;
              if (actorIdToUse) {
                const ch = snapU.getCharacter(actorIdToUse as any);
                if (ch && (ch as any).meta) {
                  if ((ch as any).meta.aiProfile) chosenProfile = (ch as any).meta.aiProfile;
                  if ((ch as any).meta.modelOverride) modelOverride = (ch as any).meta.modelOverride;
                }
              }
              // Universe-level defaults
              try {
                if (!chosenProfile && snapU && snapU.attributes && snapU.attributes.defaultAiProfile) chosenProfile = snapU.attributes.defaultAiProfile;
                if (!modelOverride && snapU && snapU.attributes && snapU.attributes.defaultModelOverride) modelOverride = snapU.attributes.defaultModelOverride;
              } catch (e) {}
            } catch (e) {}

            // If a character was resolved from the prompt and has an accent meta,
            // instruct the provider to simulate that accent in the response.
            try {
              const actorIdToUse = actorIdFromPrompt || undefined;
              let actorCh = null;
              if (actorIdToUse) {
                try { actorCh = snapU.getCharacter(actorIdToUse as any); } catch (e) { actorCh = null; }
              }
              if (actorCh && (actorCh as any).meta && (actorCh as any).meta.accent) {
                try { messages.splice(1, 0, { role: 'system', content: `Simulate accent/voice: ${(actorCh as any).meta.accent}` }); } catch (e) {}
              }
            } catch (e) {}

            logger.info('ai.request', { world: body.worldId, promptPreview: String(body.prompt).slice(0, 300), profile: chosenProfile, modelOverride });
            let r;
            try {
              const opts: any = { profile: chosenProfile, messages };
              if (modelOverride) opts.modelOverride = modelOverride;
              r = await ai.generate(body.prompt, opts);
              } catch (err) {
                logger.error('ai.generate_failed', { world: body.worldId, err: err instanceof Error ? err.message : String(err) });
                res.writeHead(502, { 'content-type': 'application/json' });
                res.end(JSON.stringify({ error: 'ai_failed', message: err instanceof Error ? err.message : String(err) }));
                return;
              }
            logger.info('ai.response', { world: body.worldId, textPreview: String(r.text).slice(0, 300) });
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
                await persistence.persistEvent(body.worldId, ev);
              } catch (e) {
                  // fallback: persist without pseudonym (dev only)
                    const ev = {
                    id: `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
                    type: 'ai_response',
                    timestamp: new Date().toISOString(),
                    payload: { requesterId: getRequesterId(req), actorId, prompt: body.prompt, response: r.text ?? null, raw: r.raw ?? r, messages },
                  };
                  await persistence.persistEvent(body.worldId, ev);
                }
              // Also persist as character memory so snapshots materialize the reply
                if (actorId) {
                  const memEv = {
                    id: `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
                    type: 'character_memory',
                    timestamp: new Date().toISOString(),
                    payload: { characterId: actorId, text: r.text ?? null },
                  };
                await persistence.persistEvent(body.worldId, memEv);
                logger.info('ai.mem_persisted', { world: body.worldId, characterId: actorId, eventId: memEv.id });
                }
            } catch (err) {
              // log but do not fail the AI response
              logger.error('ai.persist_error', { err: err instanceof Error ? err.message : String(err) });
            }
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify(r));
            return;
          }

      // Ordenador command interpreter: allow privileged users to run simple
      // NL commands that mutate the universe (create/delete/rename characters).
      if (req.method === 'POST' && path?.startsWith('/api/world/') && path.endsWith('/ordenador/command')) {
        const id = path.replace('/api/world/', '').replace('/ordenador/command', '');
        if (!requireAuth(req, res)) return;
        const actorId = getRequesterId(req);
        if (!actorId || actorId === 'api-key') { res.writeHead(403, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'jwt_required' })); return; }
        const snapBefore = await persistence.loadWorld(id);
        if (!hasModifyPermission(snapBefore, actorId)) { res.writeHead(403, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'forbidden' })); return; }
        try {
          const body = await jsonBody(req) || {};
          const message = String(body.message || '').trim();
          if (!message) { res.writeHead(400, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'invalid body, expected {message}' })); return; }

          const emitted: any[] = [];

          // helpers to find character by name or id
          function findCharByNameOrId(u: any, token: string) {
            if (!token) return null;
            const byId = u.getCharacter(token);
            if (byId) return byId;
            const lower = token.toLowerCase();
            const chars = u.listCharacters();
            for (const c of chars) {
              if ((c.name || '').toLowerCase() === lower) return c;
            }
            return null;
          }

          // create command: create Tom / crea personaje "Tom"
          const mCreate = message.match(/\b(?:crea(?:r)?|create)\b(?:\s+(?:personaje|person|char(?:acter)?))?\s+(?:"([^"]+)"|'([^']+)'|(\S+))/i);
          if (mCreate) {
            const name = mCreate[1] || mCreate[2] || mCreate[3];
            const idForChar = (body.newId && String(body.newId).trim()) || String((name || '').replace(/\s+/g, '_')).trim();
            if (snapBefore.getCharacter(idForChar)) { res.writeHead(409, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'character_exists' })); return; }
            const ev = { id: `${Date.now()}-${Math.random().toString(36).slice(2,6)}`, type: 'character_added', timestamp: new Date().toISOString(), payload: { characterId: idForChar, name: name, description: null } };
            await persistence.persistEvent(id, ev);
            emitted.push(ev);
          }

          // delete command: elimina personaje Tom / delete Tom
          const mDelete = message.match(/\b(?:elimina(?:r)?|borra|delete|remove)\b(?:\s+(?:personaje|person|char(?:acter)?))?\s+(?:"([^"]+)"|'([^']+)'|(\S+))/i);
          if (mDelete) {
            const token = mDelete[1] || mDelete[2] || mDelete[3];
            const found = findCharByNameOrId(snapBefore, token);
            if (!found) { res.writeHead(404, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'character_not_found' })); return; }
            const ev = { id: `${Date.now()}-${Math.random().toString(36).slice(2,6)}`, type: 'character_deleted', timestamp: new Date().toISOString(), payload: { characterId: found.id, actor: actorId } };
            await persistence.persistEvent(id, ev);
            emitted.push(ev);
          }

          // rename command: renombra <old> a <new> / rename <old> to <new>
          const mRename = message.match(/\b(?:renombra|rename|cambia nombre a|change name to)\b\s+(?:"([^"]+)"|'([^']+)'|(\S+))\s+(?:a|to)\s+(?:"([^']+)"|'([^']+)'|(.+))/i);
          if (mRename) {
            const oldToken = mRename[1] || mRename[2] || mRename[3];
            const newName = (mRename[4] || mRename[5] || mRename[6] || '').trim();
            const found = findCharByNameOrId(snapBefore, oldToken);
            if (!found) { res.writeHead(404, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'character_not_found' })); return; }
            const ev = { id: `${Date.now()}-${Math.random().toString(36).slice(2,6)}`, type: 'character_meta_updated', timestamp: new Date().toISOString(), payload: { characterId: found.id, name: newName, actor: actorId } };
            await persistence.persistEvent(id, ev);
            emitted.push(ev);
          }

          // move command: move <char> from <worldA> to <worldB> (EN) or
          // mueve <char> del <Mundo A> al <Mundo B> (ES)
          const mMoveEn = message.match(/\b(?:move)\b\s+(?:"([^"]+)"|'([^']+)'|(\S+))\s+from\s+(?:"([^"]+)"|'([^']+)'|(\S+))\s+to\s+(?:"([^"]+)"|'([^']+)'|(\S+))/i);
          const mMoveEs = message.match(/\b(?:mueve|traslada|mover)\b\s+(?:a\s*)?(?:"([^"]+)"|'([^']+)'|(\S+))\s+(?:del|de)\s+(?:Mundo\s+)?(?:"([^"]+)"|'([^']+)'|(\S+))\s+(?:al|a)\s+(?:Mundo\s+)?(?:"([^"]+)"|'([^']+)'|(\S+))/i);
          if (mMoveEn || mMoveEs) {
            // extract tokens
            let charToken: string | undefined;
            let fromToken: string | undefined;
            let toToken: string | undefined;
            if (mMoveEn) {
              charToken = mMoveEn[1] || mMoveEn[2] || mMoveEn[3];
              fromToken = mMoveEn[4] || mMoveEn[5] || mMoveEn[6];
              toToken = mMoveEn[7] || mMoveEn[8] || mMoveEn[9];
            } else if (mMoveEs) {
              charToken = mMoveEs[1] || mMoveEs[2] || mMoveEs[3];
              fromToken = mMoveEs[4] || mMoveEs[5] || mMoveEs[6];
              toToken = mMoveEs[7] || mMoveEs[8] || mMoveEs[9];
            }

            // helper to find a universe id by name or id
            async function findUniverseByNameOrId(token: string | undefined) {
              if (!token) return null;
              const lookup = String(token).toLowerCase().trim();
              const uids = await persistence.listWorldIds();
              for (const uid of uids) {
                try {
                   const snap = await persistence.loadWorld(uid);
                  if (String(uid).toLowerCase() === lookup) return uid;
                  if ((snap && String(snap.name || '').toLowerCase()) === lookup) return uid;
                } catch (e) { /* ignore */ }
              }
              return null;
            }

            const srcId = (fromToken ? await findUniverseByNameOrId(fromToken) : id) || null;
            const dstId = toToken ? await findUniverseByNameOrId(toToken) : null;
            if (!srcId || !dstId) { res.writeHead(404, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'world_not_found', from: srcId, to: dstId })); return; }

            // load universes
             const srcSnap = await persistence.loadWorld(srcId);
             const dstSnap = await persistence.loadWorld(dstId);
            if (!hasModifyPermission(srcSnap, actorId) || !hasModifyPermission(dstSnap, actorId)) { res.writeHead(403, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'forbidden' })); return; }

            const found = findCharByNameOrId(srcSnap, charToken || '');
            if (!found) { res.writeHead(404, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'character_not_found_in_source' })); return; }
            // conflict check
            const existsInDst = dstSnap.getCharacter(found.id);
            if (existsInDst) { res.writeHead(409, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'character_conflict_in_target', id: found.id })); return; }

            // perform delete in source and add in target; also copy meta and memory entries
            const evDel = { id: `${Date.now()}-${Math.random().toString(36).slice(2,6)}`, type: 'character_deleted', timestamp: new Date().toISOString(), payload: { characterId: found.id, actor: actorId } };
            await persistence.persistEvent(srcId, evDel);
            emitted.push(evDel);

            const evAdd = { id: `${Date.now()}-${Math.random().toString(36).slice(2,6)}`, type: 'character_added', timestamp: new Date().toISOString(), payload: { characterId: found.id, name: found.name, description: found.description } };
            await persistence.persistEvent(dstId, evAdd);
            emitted.push(evAdd);

            // copy meta if present
            try {
              if ((found as any).meta && Object.keys((found as any).meta || {}).length) {
                const metaEv = { id: `${Date.now()}-${Math.random().toString(36).slice(2,6)}`, type: 'character_meta_updated', timestamp: new Date().toISOString(), payload: { characterId: found.id, meta: (found as any).meta, actor: actorId } };
                await persistence.persistEvent(dstId, metaEv);
                emitted.push(metaEv);
              }
            } catch (e) {}

            // copy memory entries if any
            try {
              const mems = (found.memory || []);
              for (const mtext of mems) {
                const memEv = { id: `${Date.now()}-${Math.random().toString(36).slice(2,6)}`, type: 'character_memory', timestamp: new Date().toISOString(), payload: { characterId: found.id, text: mtext } };
                await persistence.persistEvent(dstId, memEv);
                emitted.push(memEv);
              }
            } catch (e) {}

            // rebuild snapshots for both universes
            try {
              const { World } = await import('../../domain/world.js');
              const srcEvents = await persistence.loadEvents(srcId);
              const srcUpdated = World.reconstructFromEvents(srcId, undefined, srcEvents);
              await persistence.saveSnapshot(srcUpdated);
              const dstEvents = await persistence.loadEvents(dstId);
              const dstUpdated = World.reconstructFromEvents(dstId, undefined, dstEvents);
              await persistence.saveSnapshot(dstUpdated);
            } catch (e) {}
          }

          if (!emitted.length) {
            res.writeHead(400, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: 'unknown_command', message: 'No supported command detected' }));
            return;
          }

          // Rebuild snapshot and return result
          const events = await persistence.loadEvents(id);
          const { World } = await import('../../domain/world.js');
          const updatedU = World.reconstructFromEvents(id, undefined, events);
          await persistence.saveSnapshot(updatedU);
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: true, emitted: emitted.map(e => ({ id: e.id, type: e.type, payload: e.payload })), snapshot: updatedU.snapshot() }));
          return;
        } catch (e) { res.writeHead(500, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'failed', message: e instanceof Error ? e.message : String(e) })); return; }
      }

        // Automatic disambiguation: if the prompt mentions a character name
        // that uniquely exists in one universe, scope the AI call to that
        // universe. If multiple universes match, return an ambiguous result
        // listing candidates so the client can choose.
        const q = String(body.prompt || '').toLowerCase();
        const universeIds = await persistence.listWorldIds();
        const matches: Array<{ worldId: string; worldName: string; charName: string }> = [];
        for (const uid of universeIds) {
          try {
            const snap = await persistence.loadWorld(uid);
            const chars = snap.listCharacters();
            for (const c of chars) {
              const name = (c.name || '').toLowerCase();
              // match whole word
              const re = new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
              if (re.test(body.prompt)) {
                matches.push({ worldId: uid, worldName: snap.name, charName: c.name });
                break; // one match per universe is enough
              }
            }
          } catch (err) {
            // ignore per-universe errors
          }
        }

          if (matches.length === 1) {
            const chosen = matches[0];
            let snapU = await persistence.loadWorld(chosen.worldId);
            const events = await persistence.loadEvents(chosen.worldId);
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
                await persistence.persistEvent(chosen.worldId, assignEv);
                const updatedU = await persistence.loadWorld(chosen.worldId);
                await persistence.saveSnapshot(updatedU);
                snapU = updatedU;
              }
            } catch (e) {}
            const ctx = buildWorldContext(snapU.snapshot(), events);
            let messages = [ { role: 'system', content: ctx }, { role: 'user', content: body.prompt } ];
            messages = compactMessages(messages, 120000);
            
            const ai = await getAiProviderForRequest(req, 'conversation');
            // choose profile/modelOverride: prefer character meta then universe defaults
            let chosenProfileLocal: any = 'conversation';
            let modelOverrideLocal: any = undefined;
            try {
              // If a character can be resolved from the prompt, prefer its settings
              let actorIdLocal: string | undefined;
              try {
                const chars = snapU.listCharacters();
                for (const c of chars) {
                  const name = (c.name || '').replace(/[.*+?^${}()|[\\]\\]/g, '\\$&');
                  const re = new RegExp(`\\b${name}\\b`, 'i');
                  if (re.test(body.prompt)) { actorIdLocal = c.id; break; }
                }
              } catch (e) {}
              if (actorIdLocal) {
                const ch = snapU.getCharacter(actorIdLocal as any);
                if (ch && (ch as any).meta) {
                  if ((ch as any).meta.aiProfile) chosenProfileLocal = (ch as any).meta.aiProfile;
                  if ((ch as any).meta.modelOverride) modelOverrideLocal = (ch as any).meta.modelOverride;
                }
              }
              if (snapU && snapU.attributes) {
                if (!chosenProfileLocal && snapU.attributes.defaultAiProfile) chosenProfileLocal = snapU.attributes.defaultAiProfile;
                if (!modelOverrideLocal && snapU.attributes.defaultModelOverride) modelOverrideLocal = snapU.attributes.defaultModelOverride;
              }
            } catch (e) {}
            let r;
            try {
              const opts: any = { profile: chosenProfileLocal, messages };
              if (modelOverrideLocal) opts.modelOverride = modelOverrideLocal;
              r = await ai.generate(body.prompt, opts);
              } catch (err) {
                logger.error('ai.generate_failed', { world: chosen.worldId, err: err instanceof Error ? err.message : String(err) });
                res.writeHead(502, { 'content-type': 'application/json' });
                res.end(JSON.stringify({ error: 'ai_failed', message: err instanceof Error ? err.message : String(err) }));
                return;
              }
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
               await persistence.persistEvent(chosen.worldId, ev);
              if (actorId) {
                const memEv = { id: `${Date.now()}-${Math.random().toString(36).slice(2,6)}`, type: 'character_memory', timestamp: new Date().toISOString(), payload: { characterId: actorId, text: r.text ?? null } };
                await persistence.persistEvent(chosen.worldId, memEv);
                logger.info('ai.mem_persisted', { world: chosen.worldId, characterId: actorId, eventId: memEv.id });
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
            let r;
            try {
              const opts: any = { profile: 'conversation', messages };
              r = await ai.generate(body.prompt, opts);
            } catch (err) {
              logger.error('ai.generate_failed', { err: err instanceof Error ? err.message : String(err) });
              res.writeHead(502, { 'content-type': 'application/json' });
              res.end(JSON.stringify({ error: 'ai_failed', message: err instanceof Error ? err.message : String(err) }));
              return;
            }
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

      // List characters across all worlds (search universes for characters)
      if (req.method === 'GET' && path === '/api/characters') {
        try {
          const ids = await persistence.listWorldIds();
          const out: Array<any> = [];
          for (const id of ids) {
            try {
               const u = await persistence.loadWorld(id);
              const chars = u.listCharacters();
               for (const c of chars) {
                 out.push({ worldId: id, character: c });
               }
            } catch (e) { /* ignore per-universe errors */ }
          }
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ characters: out }));
          return;
        } catch (e) { res.writeHead(500, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'failed' })); return; }
      }

      // Get info about a character across worlds (find occurrences)
      if (req.method === 'GET' && path?.startsWith('/api/character/')) {
        const charId = path.replace('/api/character/', '');
        try {
          const ids = await persistence.listWorldIds();
          const found: Array<any> = [];
          for (const id of ids) {
            try {
               const u = await persistence.loadWorld(id);
               const ch = u.getCharacter(charId);
               if (ch) found.push({ worldId: id, character: ch });
            } catch (e) {}
          }
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ occurrences: found }));
          return;
        } catch (e) { res.writeHead(500, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'failed' })); return; }
      }

      // AI endpoint scoped to a universe id (preferred for disambiguation)
      if (req.method === 'POST' && path?.startsWith('/api/world/') && path.endsWith('/ai')) {
        const id = path.replace('/api/world/', '').replace('/ai', '');
        const body = await jsonBody(req);
        const userMessage = body?.message ?? body?.prompt;
        if (!body || !userMessage) {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'invalid body, expected {message|prompt}' }));
        return;
      }

      
        let snapU = await persistence.loadWorld(id);
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
            const updatedU = await persistence.loadWorld(id);
            await persistence.saveSnapshot(updatedU);
            snapU = updatedU;
          }
        } catch (e) {
          // ignore
        }
        const ctx = buildWorldContext(snapU.snapshot(), events);
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
        // choose profile/modelOverride: prefer explicit actor meta, then universe defaults
        let chosenProfileFinal: any = 'conversation';
        let modelOverrideFinal: any = undefined;
        try {
          if (actorId) {
            const ch = snapU.getCharacter(actorId);
            if (ch && (ch as any).meta) {
              if ((ch as any).meta.aiProfile) chosenProfileFinal = (ch as any).meta.aiProfile;
              if ((ch as any).meta.modelOverride) modelOverrideFinal = (ch as any).meta.modelOverride;
            }
          }
          if (snapU && snapU.attributes) {
            if (!chosenProfileFinal && snapU.attributes.defaultAiProfile) chosenProfileFinal = snapU.attributes.defaultAiProfile;
            if (!modelOverrideFinal && snapU.attributes.defaultModelOverride) modelOverrideFinal = snapU.attributes.defaultModelOverride;
          }
        } catch (e) {}
        let r;
        try {
          const opts: any = { profile: chosenProfileFinal, messages };
          if (modelOverrideFinal) opts.modelOverride = modelOverrideFinal;
          r = await ai.generate(finalPrompt, opts);
        } catch (err) {
          logger.error('ai.generate_failed', { universe: id, err: err instanceof Error ? err.message : String(err) });
          res.writeHead(502, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'ai_failed', message: err instanceof Error ? err.message : String(err) }));
          return;
        }
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
