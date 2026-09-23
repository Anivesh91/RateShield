import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import { rateLimiter } from '../src/index.js';
import { RedisStore } from '../src/stores/redisStore.js';

/**
 * Simulates Redis's atomic Lua script execution guarantee:
 * Redis executes a Lua script atomically with respect to other Redis commands.
 * Commands from other clients cannot interleave with the script while it is executing.
 * (Note: Node.js handles incoming HTTP requests concurrently; Redis guarantees atomic
 * execution of each Lua script without command interleaving).
 */
function createAtomicRedisClient() {
  const store = new Map();
  let queue = Promise.resolve();

  return {
    async eval(script, options) {
      return new Promise((resolve) => {
        queue = queue.then(async () => {
          const key = options.keys[0];
          const windowMs = Number(options.arguments[0]);
          const now = Date.now();

          let entry = store.get(key);
          if (!entry || (entry.expiresAt && now >= entry.expiresAt)) {
            entry = { count: 1, expiresAt: now + windowMs };
            store.set(key, entry);
            resolve([1, windowMs]);
            return;
          }

          entry.count += 1;
          const remainingTtl = Math.max(0, entry.expiresAt - now);
          resolve([entry.count, remainingTtl]);
        });
      });
    },

    getCounter(key) {
      return store.get(key)?.count || 0;
    },

    async sendCommand() {
      return 'OK';
    }
  };
}

function createTestApp() {
  const app = express();
  app.set('trust proxy', true);
  app.use(express.json());
  return app;
}

describe('SmartRate v2 — Concurrency & Atomicity Verification', () => {

  it('verifies that allowed requests do not exceed configured quota under 50 concurrent requests', async () => {
    const redisClient = createAtomicRedisClient();
    const redisStore = new RedisStore({ client: redisClient });

    const LIMIT = 10;
    const TOTAL_REQUESTS = 50;

    const app = createTestApp();
    app.get(
      '/api/burst-test',
      rateLimiter({ limit: LIMIT, windowMs: 60_000, store: redisStore }),
      (req, res) => res.status(200).json({ success: true })
    );

    const testIp = '10.200.0.1';

    // Dispatch 50 concurrent requests in parallel
    const requestPromises = Array.from({ length: TOTAL_REQUESTS }, () =>
      request(app)
        .get('/api/burst-test')
        .set('X-Forwarded-For', testIp)
    );

    const responses = await Promise.all(requestPromises);

    const allowedResponses = responses.filter((r) => r.status === 200);
    const blockedResponses = responses.filter((r) => r.status === 429);

    // Automated assertions verifying quota enforcement under concurrency
    assert.equal(allowedResponses.length, LIMIT, `Expected exactly ${LIMIT} allowed requests, got ${allowedResponses.length}`);
    assert.equal(blockedResponses.length, TOTAL_REQUESTS - LIMIT, `Expected exactly ${TOTAL_REQUESTS - LIMIT} blocked requests, got ${blockedResponses.length}`);

    // Verify headers on blocked requests
    for (const res of blockedResponses) {
      assert.equal(res.body.success, false);
      assert.equal(res.headers['ratelimit-limit'], String(LIMIT));
      assert.equal(res.headers['ratelimit-remaining'], '0');
      assert.ok(Number(res.headers['retry-after']) > 0);
    }

    assert.equal(
      redisClient.getCounter('smartrate:GET:/api/burst-test:10.200.0.1'),
      TOTAL_REQUESTS,
      `Expected final Redis counter to be ${TOTAL_REQUESTS}`
    );
  });

  it('enforces independent concurrent quotas for distinct client IPs in parallel', async () => {
    const redisClient = createAtomicRedisClient();
    const redisStore = new RedisStore({ client: redisClient });

    const LIMIT = 5;
    const app = createTestApp();
    app.get(
      '/api/parallel-clients',
      rateLimiter({ limit: LIMIT, windowMs: 60_000, store: redisStore }),
      (req, res) => res.json({ success: true })
    );

    const clientA = '10.200.1.1';
    const clientB = '10.200.1.2';

    // Client A sends 10 requests, Client B sends 10 requests concurrently
    const promisesA = Array.from({ length: 10 }, () =>
      request(app).get('/api/parallel-clients').set('X-Forwarded-For', clientA)
    );
    const promisesB = Array.from({ length: 10 }, () =>
      request(app).get('/api/parallel-clients').set('X-Forwarded-For', clientB)
    );

    const [resultsA, resultsB] = await Promise.all([
      Promise.all(promisesA),
      Promise.all(promisesB)
    ]);

    const allowedA = resultsA.filter((r) => r.status === 200).length;
    const blockedA = resultsA.filter((r) => r.status === 429).length;

    const allowedB = resultsB.filter((r) => r.status === 200).length;
    const blockedB = resultsB.filter((r) => r.status === 429).length;

    assert.equal(allowedA, LIMIT);
    assert.equal(blockedA, 5);
    assert.equal(allowedB, LIMIT);
    assert.equal(blockedB, 5);
  });
});
