import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import nacl from 'tweetnacl';
import { logger } from '../utils/logger.js';

// Use Node's built-in Buffer for base64 — avoids tweetnacl-util ESM compat issues on Node 26.
const encodeBase64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64');
const decodeBase64 = (str: string): Uint8Array => new Uint8Array(Buffer.from(str, 'base64'));

const KEYS_PATH = path.join(os.homedir(), '.agentvigil', 'keys.json');

export interface KeyPair {
  publicKey: string;
  secretKey: string;
}

interface KeyStore {
  public_key: string;
  secret_key: string;
}

export function generateKeyPair(): KeyPair {
  const keyPair = nacl.box.keyPair();
  return {
    publicKey: encodeBase64(keyPair.publicKey),
    secretKey: encodeBase64(keyPair.secretKey),
  };
}

/** Loads the persisted X25519 keypair from ~/.agentvigil/keys.json, generating and saving one on first run. */
export async function loadOrCreateKeyPair(): Promise<KeyPair> {
  try {
    const raw = await fs.readFile(KEYS_PATH, 'utf8');
    const stored = JSON.parse(raw) as KeyStore;
    logger.info('Loaded existing keypair from keys.json');
    return { publicKey: stored.public_key, secretKey: stored.secret_key };
  } catch {
    const keyPair = generateKeyPair();
    const store: KeyStore = { public_key: keyPair.publicKey, secret_key: keyPair.secretKey };
    await fs.mkdir(path.dirname(KEYS_PATH), { recursive: true });
    await fs.writeFile(KEYS_PATH, JSON.stringify(store, null, 2), { mode: 0o600 });
    await fs.chmod(KEYS_PATH, 0o600);
    logger.info('Generated new keypair (first run)');
    return keyPair;
  }
}

export function deriveSharedSecret(ourSecretKey: string, theirPublicKey: string): string {
  const sharedSecret = nacl.box.before(
    decodeBase64(theirPublicKey),
    decodeBase64(ourSecretKey)
  );
  return encodeBase64(sharedSecret);
}

export function encrypt(plaintext: string, sharedSecret: string): string {
  const nonce = nacl.randomBytes(nacl.box.nonceLength);
  const messageUint8 = new TextEncoder().encode(plaintext);
  const encrypted = nacl.box.after(
    messageUint8,
    nonce,
    decodeBase64(sharedSecret)
  );

  const combined = new Uint8Array(nonce.length + encrypted.length);
  combined.set(nonce);
  combined.set(encrypted, nonce.length);
  return encodeBase64(combined);
}

export function decrypt(ciphertext: string, sharedSecret: string): string {
  const combined = decodeBase64(ciphertext);
  const nonce = combined.slice(0, nacl.box.nonceLength);
  const encrypted = combined.slice(nacl.box.nonceLength);
  const decrypted = nacl.box.open.after(
    encrypted,
    nonce,
    decodeBase64(sharedSecret)
  );
  if (!decrypted) throw new Error('Decryption failed — wrong key or tampered message');
  return new TextDecoder().decode(decrypted);
}
