# SKILL: Encryption & Pairing
# Read before touching crypto/encryption.ts or pairing logic

## Library: TweetNaCl (tweetnacl npm package)
Same algorithm as the Flutter app — X25519 key exchange + XSalsa20-Poly1305.
The Mac and phone derive the SAME shared secret independently.

## Key Generation (once, on setup)
```typescript
import nacl from 'tweetnacl';
import { encodeBase64, decodeBase64 } from 'tweetnacl-util';

export function generateKeyPair(): { publicKey: string; secretKey: string } {
  const keyPair = nacl.box.keyPair();
  return {
    publicKey: encodeBase64(keyPair.publicKey),
    secretKey: encodeBase64(keyPair.secretKey),
  };
}
```

## Deriving Shared Secret (after phone sends its public key)
```typescript
export function deriveSharedSecret(
  ourSecretKey: string,
  theirPublicKey: string
): string {
  const sharedSecret = nacl.box.before(
    decodeBase64(theirPublicKey),
    decodeBase64(ourSecretKey)
  );
  return encodeBase64(sharedSecret);
}
```

## Encrypt (Mac → Phone)
```typescript
export function encrypt(plaintext: string, sharedSecret: string): string {
  const nonce = nacl.randomBytes(nacl.box.nonceLength);
  const messageUint8 = new TextEncoder().encode(plaintext);
  const encrypted = nacl.box.after(
    messageUint8,
    nonce,
    decodeBase64(sharedSecret)
  );
  // Combine nonce + ciphertext → base64
  const combined = new Uint8Array(nonce.length + encrypted.length);
  combined.set(nonce);
  combined.set(encrypted, nonce.length);
  return encodeBase64(combined);
}
```

## Decrypt (Phone → Mac)
```typescript
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
```

## Key Storage (~/.agentvigil/keys.json)
```typescript
interface KeyStore {
  public_key: string;   // base64
  secret_key: string;   // base64 — NEVER send this anywhere
}
```
File permissions: chmod 600 ~/.agentvigil/keys.json

## Pairing Flow
1. Mac generates keypair, stores in ~/.agentvigil/keys.json
2. Mac shows QR with its public key + WSS URL
3. Phone scans QR, sends its public key as FIRST WebSocket message (unencrypted):
   `{ "type": "pair", "pub_key": "base64...", "device_name": "Pixel 8 Pro" }`
4. Mac derives sharedSecret from phone's public key + mac's secret key
5. Mac saves sharedSecret to config for this device
6. Mac sends encrypted confirmation: `{ "type": "paired", "device_id": "uuid" }`
7. All subsequent messages are encrypted

## QR Payload
```typescript
const qrPayload = JSON.stringify({
  v: 1,
  wss: tunnelUrl,           // e.g. "wss://abc123.trycloudflare.com"
  ntfy: config.ntfy_topic,  // e.g. "agentvigil-x7k2m9p1q3r5t7u9"
  device_id: config.device_id,
  pub_key: keyStore.public_key,
  expires: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
});

// Display in terminal:
import qrcode from 'qrcode-terminal';
qrcode.generate(qrPayload, { small: true });
```
