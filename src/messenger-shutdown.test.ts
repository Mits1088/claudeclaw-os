import { describe, expect, it, vi } from 'vitest';

import { stopMessengerForShutdown } from './messenger.js';

describe('stopMessengerForShutdown', () => {
  it('waits for a successful messenger stop', async () => {
    const stop = vi.fn().mockResolvedValue(undefined);

    await expect(stopMessengerForShutdown({ kind: 'test', stop })).resolves.toBeUndefined();
    expect(stop).toHaveBeenCalledOnce();
  });

  it('absorbs transport failures so signal shutdown can still exit cleanly', async () => {
    const stop = vi.fn().mockRejectedValue(new Error('network unavailable'));

    await expect(stopMessengerForShutdown({ kind: 'telegram', stop })).resolves.toBeUndefined();
    expect(stop).toHaveBeenCalledOnce();
  });
});
