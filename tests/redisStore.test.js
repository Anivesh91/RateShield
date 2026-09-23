import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { RedisStore } from '../src/stores/redisStore.js';

describe('SmartRate — RedisStore Foundation Unit Tests', () => {

  it('throws TypeError when options is missing or not an object', () => {
    assert.throws(() => new RedisStore(), {
      name: 'TypeError',
      message: /RedisStore options must be an object/
    });

    assert.throws(() => new RedisStore(null), {
      name: 'TypeError',
      message: /RedisStore options must be an object/
    });
  });

  it('throws TypeError when client is not provided', () => {
    assert.throws(() => new RedisStore({}), {
      name: 'TypeError',
      message: /requires a pre-connected Redis client instance/
    });

    assert.throws(() => new RedisStore({ client: null }), {
      name: 'TypeError',
      message: /requires a pre-connected Redis client instance/
    });
  });

  it('throws TypeError when client does not implement expected Redis methods', () => {
    assert.throws(() => new RedisStore({ client: { foo: 'bar' } }), {
      name: 'TypeError',
      message: /valid Redis client instance/
    });
  });

  it('successfully initializes when a valid client instance is injected', () => {
    const mockClient = {
      incr: async () => 1,
      pExpire: async () => true,
      pTTL: async () => 60000,
      sendCommand: async () => 'OK'
    };

    const store = new RedisStore({ client: mockClient });
    assert.equal(store.client, mockClient);
  });

  describe('Fixed Window State Management', () => {
    it('sets expiration only on first request (count === 1)', async () => {
      let expireCalledWith = null;

      const mockClient = {
        incr: async () => 1,
        pExpire: async (key, ms) => {
          expireCalledWith = { key, ms };
          return true;
        },
        pTTL: async () => 59000,
        sendCommand: async () => 'OK'
      };

      const store = new RedisStore({ client: mockClient });
      const result = await store.consume({ key: 'test:redis:1', limit: 5, windowMs: 60_000 });

      assert.equal(result.allowed, true);
      assert.equal(result.count, 1);
      assert.equal(result.remaining, 4);
      assert.equal(result.reset, 59);
      assert.deepEqual(expireCalledWith, { key: 'test:redis:1', ms: 60000 });
    });

    it('does not re-apply pExpire when count > 1', async () => {
      let expireCalled = false;

      const mockClient = {
        incr: async () => 2,
        pExpire: async () => {
          expireCalled = true;
          return true;
        },
        pTTL: async () => 50000,
        sendCommand: async () => 'OK'
      };

      const store = new RedisStore({ client: mockClient });
      const result = await store.consume({ key: 'test:redis:2', limit: 5, windowMs: 60_000 });

      assert.equal(result.allowed, true);
      assert.equal(result.count, 2);
      assert.equal(result.remaining, 3);
      assert.equal(result.reset, 50);
      assert.equal(expireCalled, false);
    });

    it('blocks request when limit is exceeded', async () => {
      const mockClient = {
        incr: async () => 6,
        pExpire: async () => true,
        pTTL: async () => 40000,
        sendCommand: async () => 'OK'
      };

      const store = new RedisStore({ client: mockClient });
      const result = await store.consume({ key: 'test:redis:3', limit: 5, windowMs: 60_000 });

      assert.equal(result.allowed, false);
      assert.equal(result.count, 6);
      assert.equal(result.remaining, 0);
      assert.equal(result.reset, 40);
      assert.equal(result.retryAfter, 40);
    });
  });
});
