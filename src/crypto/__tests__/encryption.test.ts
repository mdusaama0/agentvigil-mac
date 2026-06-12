import { describe, it, expect } from 'vitest';
import {
  generateKeyPair,
  deriveSharedSecret,
  encrypt,
  decrypt,
} from '../encryption.js';

describe('encryption', () => {
  it('generates distinct base64 keypairs', () => {
    const a = generateKeyPair();
    const b = generateKeyPair();

    expect(a.publicKey).toBeTypeOf('string');
    expect(a.secretKey).toBeTypeOf('string');
    expect(a.publicKey).not.toBe(a.secretKey);
    expect(a.publicKey).not.toBe(b.publicKey);
    expect(a.secretKey).not.toBe(b.secretKey);
  });

  it('derives the same shared secret on both sides', () => {
    const mac = generateKeyPair();
    const phone = generateKeyPair();

    const macSecret = deriveSharedSecret(mac.secretKey, phone.publicKey);
    const phoneSecret = deriveSharedSecret(phone.secretKey, mac.publicKey);

    expect(macSecret).toBe(phoneSecret);
  });

  it('round-trips a message between two parties', () => {
    const mac = generateKeyPair();
    const phone = generateKeyPair();
    const macSecret = deriveSharedSecret(mac.secretKey, phone.publicKey);
    const phoneSecret = deriveSharedSecret(phone.secretKey, mac.publicKey);

    const msg = JSON.stringify({ type: 'permission_prompt', session_id: 'test' });
    const ciphertext = encrypt(msg, macSecret);
    const decrypted = decrypt(ciphertext, phoneSecret);

    expect(decrypted).toBe(msg);
  });

  it('produces different ciphertext for the same message each time (random nonce)', () => {
    const a = generateKeyPair();
    const b = generateKeyPair();
    const secret = deriveSharedSecret(a.secretKey, b.publicKey);

    const c1 = encrypt('hello world', secret);
    const c2 = encrypt('hello world', secret);

    expect(c1).not.toBe(c2);
    expect(decrypt(c1, secret)).toBe('hello world');
    expect(decrypt(c2, secret)).toBe('hello world');
  });

  it('throws when decrypting with the wrong shared secret', () => {
    const a = generateKeyPair();
    const b = generateKeyPair();
    const eve = generateKeyPair();

    const realSecret = deriveSharedSecret(a.secretKey, b.publicKey);
    const wrongSecret = deriveSharedSecret(eve.secretKey, b.publicKey);

    const ciphertext = encrypt('top secret', realSecret);

    expect(() => decrypt(ciphertext, wrongSecret)).toThrow(/Decryption failed/);
  });

  it('throws when the ciphertext has been tampered with', () => {
    const a = generateKeyPair();
    const b = generateKeyPair();
    const secret = deriveSharedSecret(a.secretKey, b.publicKey);

    const ciphertext = encrypt('do not modify me', secret);
    const tampered = ciphertext.slice(0, -4) + (ciphertext.slice(-4) === 'AAAA' ? 'BBBB' : 'AAAA');

    expect(() => decrypt(tampered, secret)).toThrow(/Decryption failed/);
  });
});
