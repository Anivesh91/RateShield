import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStore } from '../src/stores/memoryStore.js';

describe('SmartRate — MemoryStore Unit Tests', () => {

  it('initializes a fresh record on first consume call', async () => {
    const store = new MemoryStore();
    const result = await store.consume({ key: 'test:key:1', limit: 5, windowMs: 60_000 });

    assert.equal(result.allowed, true);
    assert.equal(result.count, 1);
    assert.equal(result.remaining, 4);
    assert.ok(result.reset > 0);
    assert.equal(result.retryAfter, undefined);

    store.destroy();
  });

  it('increments counter sequentially up to configured limit', async () => {
    const store = new MemoryStore();
    const key = 'test:key:2';

    for (let i = 1; i <= 3; i++) {
      const result = await store.consume({ key, limit: 3, windowMs: 60_000 });
      assert.equal(result.allowed, true);
      assert.equal(result.count, i);
      assert.equal(result.remaining, 3 - i);
    }

    // 4th request must be blocked
    const blocked = await store.consume({ key, limit: 3, windowMs: 60_000 });
    assert.equal(blocked.allowed, false);
    assert.equal(blocked.remaining, 0);
    assert.ok(blocked.retryAfter > 0);

    store.destroy();
  });

  it('resets counter after window duration has elapsed', async () => {
    const store = new MemoryStore();
    const key = 'test:key:3';

    // 1st request (windowMs: 50ms)
    const res1 = await store.consume({ key, limit: 1, windowMs: 50 });
    assert.equal(res1.allowed, true);

    // 2nd request immediately blocked
    const res2 = await store.consume({ key, limit: 1, windowMs: 50 });
    assert.equal(res2.allowed, false);

    // Wait for window to elapse
    await new Promise((resolve) => setTimeout(resolve, 60));

    // 3rd request after expiry must succeed with fresh window
    const res3 = await store.consume({ key, limit: 1, windowMs: 50 });
    assert.equal(res3.allowed, true);
    assert.equal(res3.count, 1);
    assert.equal(res3.remaining, 0);

    store.destroy();
  });

  it('cleans up expired records and returns count of evicted entries', async () => {
    const store = new MemoryStore();

    // Populate active and short-lived entries
    await store.consume({ key: 'stale:1', limit: 5, windowMs: 30 });
    await store.consume({ key: 'stale:2', limit: 5, windowMs: 30 });
    await store.consume({ key: 'active:1', limit: 5, windowMs: 60_000 });

    // Wait 40ms for short-lived entries to expire
    await new Promise((resolve) => setTimeout(resolve, 40));

    const removed = store.cleanupExpiredRecords();
    assert.equal(removed, 2, `Expected 2 records removed, got: ${removed}`);
    assert.equal(store.store.has('stale:1'), false);
    assert.equal(store.store.has('stale:2'), false);
    assert.equal(store.store.has('active:1'), true);

    store.destroy();
  });

  it('isolates state between different keys', async () => {
    const store = new MemoryStore();

    await store.consume({ key: 'client:A', limit: 1, windowMs: 60_000 });
    const blockedA = await store.consume({ key: 'client:A', limit: 1, windowMs: 60_000 });
    assert.equal(blockedA.allowed, false);

    // client:B should be unaffected
    const allowedB = await store.consume({ key: 'client:B', limit: 1, windowMs: 60_000 });
    assert.equal(allowedB.allowed, true);
    assert.equal(allowedB.count, 1);

    store.destroy();
  });
});
