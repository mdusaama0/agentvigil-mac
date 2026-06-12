# SKILL: Testing
# Read before writing any tests

## Framework: Vitest
```bash
npm test          # run all tests
npm test -- --watch  # watch mode
```

## Test Structure
```
src/
  hooks/__tests__/hook-handler.test.ts
  sessions/__tests__/session-manager.test.ts
  crypto/__tests__/encryption.test.ts
  notifications/__tests__/ntfy-client.test.ts
  tunnel/__tests__/websocket-server.test.ts
```

## Key Tests to Write

### Encryption round-trip
```typescript
import { describe, it, expect } from 'vitest';
import { generateKeyPair, deriveSharedSecret, encrypt, decrypt } from '../crypto/encryption';

describe('encryption', () => {
  it('round-trips a message', () => {
    const mac = generateKeyPair();
    const phone = generateKeyPair();
    const macSecret = deriveSharedSecret(mac.secretKey, phone.publicKey);
    const phoneSecret = deriveSharedSecret(phone.secretKey, mac.publicKey);

    const msg = JSON.stringify({ type: 'permission_prompt', session_id: 'test' });
    const ciphertext = encrypt(msg, macSecret);
    const decrypted = decrypt(ciphertext, phoneSecret);

    expect(decrypted).toBe(msg);
  });
});
```

### Hook handler parses stdin correctly
```typescript
it('parses permission_prompt hook payload', async () => {
  const payload = {
    session_id: 'test123',
    cwd: '/Users/dev/my-project',
    hook_event_name: 'Notification',
    notification_type: 'permission_prompt',
    message: 'rm -rf node_modules',
  };
  // Pipe to hook handler and verify AgentEvent output
});
```

### Settings merge doesn't destroy existing hooks
```typescript
it('merges hooks without overwriting existing entries', async () => {
  const existing = { hooks: { PreToolUse: [{ type: 'command', command: 'echo hello' }] } };
  const merged = mergeHooks(existing.hooks, buildHookConfig());
  expect(merged.PreToolUse).toBeDefined(); // preserved
  expect(merged.Notification).toBeDefined(); // added
});
```

## Manual Testing Commands
```bash
# Test hook handler directly
echo '{"session_id":"test","cwd":"/tmp","hook_event_name":"Notification","notification_type":"permission_prompt","message":"rm -rf test"}' | npx tsx src/index.ts hook permission_prompt

# Test ntfy push
npx tsx src/index.ts test-push

# Test full setup flow
npx tsx src/index.ts setup --dry-run
```
