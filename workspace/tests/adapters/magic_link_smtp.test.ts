import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// Top-level mock for nodemailer so the helper (emailSender) receives the
// mocked transport regardless of dynamic imports. This ensures the server's
// lazy import of nodemailer is intercepted by Vitest.
const sendMailMock = vi.fn(async (opts: any) => ({ messageId: 'msg-1' }));
vi.mock('nodemailer', () => ({ createTransport: () => ({ sendMail: sendMailMock }) }));

describe('Magic link SMTP (integration)', () => {
  let tmp: string;
  const prevEnv: Record<string, string | undefined> = {};

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'wc-smtp-'));
    // snapshot/events dir for FilePersistenceAdapter
    const dataDir = path.join(tmp, 'universes');
    await fs.mkdir(dataDir, { recursive: true });
    // Save env and set SMTP env vars
    ['WORLDCORE_SMTP_HOST', 'WORLDCORE_SMTP_PORT', 'WORLDCORE_SMTP_USER', 'WORLDCORE_SMTP_PASS', 'WORLDCORE_SMTP_FROM', 'WORLDCORE_ALLOW_DEV_MAGIC_LINK', 'WORLDCORE_EXTERNAL_URL'].forEach((k) => { prevEnv[k] = process.env[k]; });
    process.env.WORLDCORE_SMTP_HOST = 'smtp.example.local';
    process.env.WORLDCORE_SMTP_PORT = '587';
    process.env.WORLDCORE_SMTP_USER = 'user';
    process.env.WORLDCORE_SMTP_PASS = 'pass';
    process.env.WORLDCORE_SMTP_FROM = 'no-reply@example.com';
    process.env.WORLDCORE_ALLOW_DEV_MAGIC_LINK = '0';
    process.env.WORLDCORE_EXTERNAL_URL = `http://127.0.0.1:3000`;
    // Prepare mocked nodemailer
  });

  afterEach(async () => {
    // restore env
    for (const k of Object.keys(prevEnv)) {
      if (typeof prevEnv[k] === 'undefined') delete process.env[k]; else process.env[k] = prevEnv[k];
    }
    await fs.rm(tmp, { recursive: true, force: true });
    vi.resetModules();
    vi.clearAllMocks();
  });

  it('sends email via nodemailer when SMTP configured', async () => {
    // nodemailer is mocked at the top-level for this file so no local mock is
    // required here. The top-level `sendMailMock` will receive the call.

    const exportMod = await import('../../src/adapters/fs/filePersistence');
    const FilePersistenceAdapter = exportMod.FilePersistenceAdapter;
    const adapter = new FilePersistenceAdapter(path.join(tmp, 'universes'));

    const mod = await import('../../src/adapters/http/server');
    const createServerInstance = mod.createServerInstance;

    const server = createServerInstance({ adapter, aiProvider: undefined });
    await new Promise((r) => server.listen(0, r));
    const port = (server.address() as any).port;

    const res = await globalThis.fetch(`http://127.0.0.1:${port}/api/auth/magic-link/send`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'test@example.com' }),
    });

    if (res.status !== 200) {
      const txt = await res.text().catch(() => '');
      console.error('magic-link SMTP response:', res.status, txt);
    }
    expect(res.status).toBe(200);
    // ensure nodemailer sendMail was called
    expect(sendMailMock).toHaveBeenCalled();

    server.close();
  });
});
