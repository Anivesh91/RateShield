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

    const blocked = await store.consume({ key, limit: 3, windowMs: 60_000 });
    assert.equal(blocked.allowed, false);
    assert.equal(blocked.remaining, 0);
    assert.ok(blocked.retryAfter > 0);

    store.destroy();
  });

  it('resets counter after window duration has elapsed', async () => {
    const store = new MemoryStore();
    const key = 'test:key:3';

    const res1 = await store.consume({ key, limit: 1, windowMs: 50 });
    assert.equal(res1.allowed, true);

    const res2 = await store.consume({ key, limit: 1, windowMs: 50 });
    assert.equal(res2.allowed, false);

    await new Promise((resolve) => setTimeout(resolve, 60));

    const res3 = await store.consume({ key, limit: 1, windowMs: 50 });
    assert.equal(res3.allowed, true);
    assert.equal(res3.count, 1);
    assert.equal(res3.remaining, 0);

    store.destroy();
  });

  it('cleans up expired records and returns count of evicted entries', async () => {
    const store = new MemoryStore();

    await store.consume({ key: 'stale:1', limit: 5, windowMs: 30 });
    await store.consume({ key: 'stale:2', limit: 5, windowMs: 30 });
    await store.consume({ key: 'active:1', limit: 5, windowMs: 60_000 });

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

    const allowedB = await store.consume({ key: 'client:B', limit: 1, windowMs: 60_000 });
    assert.equal(allowedB.allowed, true);
    assert.equal(allowedB.count, 1);

    store.destroy();
  });
});
