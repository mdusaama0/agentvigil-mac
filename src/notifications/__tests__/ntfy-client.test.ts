import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { fetchMock } = vi.hoisted(() => ({ fetchMock: vi.fn() }));

vi.mock('node-fetch', () => ({ default: fetchMock }));

const {
  sendPermissionNotification,
  sendTaskCompleteNotification,
  sendErrorNotification,
  sendIdleNotification,
  sendSessionEndedNotification,
} = await import('../ntfy-client.js');

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockResolvedValue({ ok: true });
});

afterEach(() => {
  vi.restoreAllMocks();
});

function lastCall() {
  const [url, init] = fetchMock.mock.calls.at(-1)!;
  return { url, init: init as { method: string; headers: Record<string, string>; body: string } };
}

describe('sendPermissionNotification', () => {
  it('posts an urgent push with approve/deny actions to the topic URL', async () => {
    await sendPermissionNotification('agentvigil-topic', 'my-app', 'rm -rf /tmp/x', 'sess1');

    const { url, init } = lastCall();
    expect(url).toBe('https://ntfy.sh/agentvigil-topic');
    expect(init.method).toBe('POST');
    expect(init.headers.Title).toContain('[my-app] Permission Required');
    expect(init.headers.Priority).toBe('urgent');
    expect(init.headers.Tags).toBe('warning,rotating_light');
    expect(init.headers.Click).toBe('agentvigil://session/sess1');
    expect(init.headers.Actions).toContain('APPROVE, https://ntfy.sh/agentvigil-topic/approve/sess1');
    expect(init.headers.Actions).toContain('DENY, https://ntfy.sh/agentvigil-topic/deny/sess1');
    expect(init.body).toBe('rm -rf /tmp/x');
  });
});

describe('sendTaskCompleteNotification', () => {
  it('posts a default-priority push with the duration in the body', async () => {
    await sendTaskCompleteNotification('agentvigil-topic', 'my-app', '4m12s');

    const { url, init } = lastCall();
    expect(url).toBe('https://ntfy.sh/agentvigil-topic');
    expect(init.headers.Title).toContain('[my-app] Task Complete');
    expect(init.headers.Priority).toBe('default');
    expect(init.headers.Tags).toBe('white_check_mark');
    expect(init.body).toBe('Completed in 4m12s');
  });
});

describe('sendErrorNotification', () => {
  it('posts a high-priority push with the error in the body', async () => {
    await sendErrorNotification('agentvigil-topic', 'my-app', 'Process crashed');

    const { url, init } = lastCall();
    expect(url).toBe('https://ntfy.sh/agentvigil-topic');
    expect(init.headers.Title).toContain('[my-app] Session Error');
    expect(init.headers.Priority).toBe('high');
    expect(init.headers.Tags).toBe('x,red_circle');
    expect(init.body).toBe('Process crashed');
  });
});

describe('sendIdleNotification', () => {
  it('posts a default-priority push that links back to the session', async () => {
    await sendIdleNotification('agentvigil-topic', 'my-app', 'sess1');

    const { url, init } = lastCall();
    expect(url).toBe('https://ntfy.sh/agentvigil-topic');
    expect(init.headers.Title).toContain('[my-app] Waiting for Input');
    expect(init.headers.Priority).toBe('default');
    expect(init.headers.Tags).toBe('information_source');
    expect(init.headers.Click).toBe('agentvigil://session/sess1');
  });
});

describe('sendSessionEndedNotification', () => {
  it('posts a low-priority push with the session closed title', async () => {
    await sendSessionEndedNotification('agentvigil-topic', 'my-app');

    const { url, init } = lastCall();
    expect(url).toBe('https://ntfy.sh/agentvigil-topic');
    expect(init.headers.Title).toContain('[my-app] Session closed');
    expect(init.headers.Priority).toBe('low');
    expect(init.headers.Tags).toBe('white_check_mark');
    expect(init.body).toBe('Claude Code session ended');
  });
});

describe('error handling', () => {
  it('never throws and just logs a warning when the network call rejects', async () => {
    fetchMock.mockRejectedValue(new Error('ENOTFOUND ntfy.sh'));

    await expect(sendTaskCompleteNotification('agentvigil-topic', 'my-app', '1s')).resolves.toBeUndefined();
    await expect(sendPermissionNotification('agentvigil-topic', 'my-app', 'ls', 'sess1')).resolves.toBeUndefined();
    await expect(sendErrorNotification('agentvigil-topic', 'my-app', 'oops')).resolves.toBeUndefined();
    await expect(sendIdleNotification('agentvigil-topic', 'my-app', 'sess1')).resolves.toBeUndefined();
    await expect(sendSessionEndedNotification('agentvigil-topic', 'my-app')).resolves.toBeUndefined();
  });
});
