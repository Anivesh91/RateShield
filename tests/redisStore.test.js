import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { RedisStore } from '../src/stores/redisStore.js';

describe('SmartRate — RedisStore Unit Tests', () => {

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

  it('throws TypeError when client does not implement eval or sendCommand', () => {
    assert.throws(() => new RedisStore({ client: { foo: 'bar' } }), {
      name: 'TypeError',
      message: /valid Redis client instance/
    });
  });

  it('successfully initializes when a valid client instance is injected', () => {
    const mockClient = {
      eval: async () => [1, 60000],
      sendCommand: async () => [1, 60000]
    };

    const store = new RedisStore({ client: mockClient });
    assert.equal(store.client, mockClient);
    assert.ok(typeof store.script === 'string' && store.script.includes('INCR'));
  });

  describe('Atomic Lua State Execution', () => {
    it('executes Lua script via client.eval with keys and arguments', async () => {
      let evalParams = null;

      const mockClient = {
        eval: async (script, options) => {
          evalParams = { script, options };
          return [1, 59500];
        }
      };

      const store = new RedisStore({ client: mockClient });
      const result = await store.consume({ key: 'test:lua:1', limit: 5, windowMs: 60_000 });

      assert.equal(result.allowed, true);
      assert.equal(result.count, 1);
      assert.equal(result.remaining, 4);
      assert.equal(result.reset, 60);
      assert.deepEqual(evalParams.options, {
        keys: ['test:lua:1'],
        arguments: ['60000']
      });
    });

    it('falls back to sendCommand when client.eval is absent', async () => {
      let commandSent = null;

      const mockClient = {
        sendCommand: async (commandArgs) => {
          commandSent = commandArgs;
          return [2, 45000];
        }
      };

      const store = new RedisStore({ client: mockClient });
      const result = await store.consume({ key: 'test:lua:2', limit: 5, windowMs: 60_000 });

      assert.equal(result.allowed, true);
      assert.equal(result.count, 2);
      assert.equal(result.remaining, 3);
      assert.equal(result.reset, 45);
      assert.equal(commandSent[0], 'EVAL');
      assert.equal(commandSent[2], '1');
      assert.equal(commandSent[3], 'test:lua:2');
      assert.equal(commandSent[4], '60000');
    });

    it('blocks requests when Lua returns count > limit', async () => {
      const mockClient = {
        eval: async () => [6, 35000]
      };

      const store = new RedisStore({ client: mockClient });
      const result = await store.consume({ key: 'test:lua:3', limit: 5, windowMs: 60_000 });

      assert.equal(result.allowed, false);
      assert.equal(result.count, 6);
      assert.equal(result.remaining, 0);
      assert.equal(result.reset, 35);
      assert.equal(result.retryAfter, 35);
    });

    it('validates consume input arguments fail-fast', async () => {
      const store = new RedisStore({ client: { eval: async () => [1, 60000] } });

      await assert.rejects(() => store.consume({ key: '', limit: 5, windowMs: 60000 }), {
        name: 'TypeError',
        message: /'key' must be a non-empty string/
      });

      await assert.rejects(() => store.consume({ key: 'k', limit: 0, windowMs: 60000 }), {
        name: 'RangeError',
        message: /'limit' must be a positive integer/
      });

      await assert.rejects(() => store.consume({ key: 'k', limit: 5, windowMs: -1 }), {
        name: 'RangeError',
        message: /'windowMs' must be a positive number/
      });
    });

    it('throws descriptive Error when Redis returns TTL = -1 (key without expiry)', async () => {
      const mockClient = {
        eval: async () => [5, -1]
      };

      const store = new RedisStore({ client: mockClient });
      await assert.rejects(
        () => store.consume({ key: 'test:orphan', limit: 5, windowMs: 60_000 }),
        {
          name: 'Error',
          message: /Key 'test:orphan' exists in Redis without an expiration TTL/
        }
      );
    });
  });
});
