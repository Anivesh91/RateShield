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
});
