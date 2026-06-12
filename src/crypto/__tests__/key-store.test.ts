import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';

const { TEST_HOME } = vi.hoisted(() => ({
  TEST_HOME: `/tmp/agentvigil-key-store-test-${process.pid}-${Date.now()}`,
}));

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return {
    ...actual,
    default: { ...actual, homedir: () => TEST_HOME },
    homedir: () => TEST_HOME,
  };
});

const { loadOrCreateKeyPair } = await import('../encryption.js');

const KEYS_PATH = path.join(TEST_HOME, '.agentvigil', 'keys.json');

beforeEach(async () => {
  await fs.rm(TEST_HOME, { recursive: true, force: true });
});

afterAll(async () => {
  await fs.rm(TEST_HOME, { recursive: true, force: true });
});

describe('loadOrCreateKeyPair', () => {
  it('generates and persists a keypair to ~/.agentvigil/keys.json on first run', async () => {
    const keyPair = await loadOrCreateKeyPair();

    expect(keyPair.publicKey).toBeTypeOf('string');
    expect(keyPair.secretKey).toBeTypeOf('string');

    const stored = JSON.parse(await fs.readFile(KEYS_PATH, 'utf8'));
    expect(stored).toEqual({ public_key: keyPair.publicKey, secret_key: keyPair.secretKey });
  });

  it('restricts the keys file to owner-only permissions', async () => {
    await loadOrCreateKeyPair();

    const stats = await fs.stat(KEYS_PATH);
    expect(stats.mode & 0o777).toBe(0o600);
  });

  it('returns the same keypair on subsequent calls instead of regenerating', async () => {
    const first = await loadOrCreateKeyPair();
    const second = await loadOrCreateKeyPair();

    expect(second).toEqual(first);
  });
});
