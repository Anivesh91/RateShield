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
 * Supports both Fixed Window string counters and Sliding Window Sorted Sets (ZSET).
 */
function createAtomicRedisClient() {
  const strings = new Map();
  const zsets = new Map(); // key -> Array<{ score: number, member: string }>
  let queue = Promise.resolve();

  return {
    async eval(script, options) {
      return new Promise((resolve) => {
        queue = queue.then(async () => {
          const key = options.keys[0];

          // 1. Sliding Window Lua Execution (4 arguments: now, windowMs, limit, member)
          if (options.arguments.length >= 4) {
            const now = Number(options.arguments[0]);
            const windowMs = Number(options.arguments[1]);
            const limit = Number(options.arguments[2]);
            const member = options.arguments[3];

            const cutoff = now - windowMs;
            let entries = zsets.get(key) || [];

            // Prune expired entries (score <= cutoff)
            entries = entries.filter((e) => e.score > cutoff);

            const currentCount = entries.length;
            let allowed = 0;

            if (currentCount < limit) {
              entries.push({ score: now, member });
              allowed = 1;
            }

            zsets.set(key, entries);

            const oldestScore = entries.length > 0 ? entries[0].score : now;
            resolve([allowed, entries.length, oldestScore]);
            return;
          }

          // 2. Fixed Window Lua Execution (1 argument: windowMs)
          const windowMs = Number(options.arguments[0]);
          const now = Date.now();

          let entry = strings.get(key);
          if (!entry || (entry.expiresAt && now >= entry.expiresAt)) {
            entry = { count: 1, expiresAt: now + windowMs };
            strings.set(key, entry);
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
      return strings.get(key)?.count || 0;
    },

    getZsetCount(key) {
      return zsets.get(key)?.length || 0;
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

describe('SmartRate — Concurrency & Atomicity Verification', () => {

  describe('Fixed Window Concurrency', () => {
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

  describe('Sliding Window Concurrency (Redis ZSET)', () => {
    it('verifies that allowed requests do not exceed configured quota under 50 concurrent requests on Redis Sliding Window', async () => {
      const redisClient = createAtomicRedisClient();
      const redisStore = new RedisStore({ client: redisClient });

      const LIMIT = 10;
      const TOTAL_REQUESTS = 50;

      const app = createTestApp();
      app.get(
        '/api/sliding-burst',
        rateLimiter({
          algorithm: 'sliding-window',
          limit: LIMIT,
          windowMs: 60_000,
          store: redisStore
        }),
        (req, res) => res.status(200).json({ success: true })
      );

      const testIp = '10.200.0.99';

      // Dispatch 50 concurrent requests in parallel against sliding window endpoint
      const requestPromises = Array.from({ length: TOTAL_REQUESTS }, () =>
        request(app)
          .get('/api/sliding-burst')
          .set('X-Forwarded-For', testIp)
      );

      const responses = await Promise.all(requestPromises);

      const allowedResponses = responses.filter((r) => r.status === 200);
      const blockedResponses = responses.filter((r) => r.status === 429);

      // Automated assertions verifying quota enforcement under concurrency
      assert.equal(allowedResponses.length, LIMIT, `Expected exactly ${LIMIT} allowed requests, got ${allowedResponses.length}`);
      assert.equal(blockedResponses.length, TOTAL_REQUESTS - LIMIT, `Expected exactly ${TOTAL_REQUESTS - LIMIT} blocked requests, got ${blockedResponses.length}`);

      for (const res of blockedResponses) {
        assert.equal(res.body.success, false);
        assert.equal(res.headers['ratelimit-limit'], String(LIMIT));
        assert.equal(res.headers['ratelimit-remaining'], '0');
        assert.ok(Number(res.headers['retry-after']) > 0);
      }

      // In Redis Sliding Window, rejected requests are NOT added to the ZSET,
      // so the ZSET must contain exactly the 10 admitted requests
      assert.equal(
        redisClient.getZsetCount('smartrate:sliding-window:GET:/api/sliding-burst:10.200.0.99'),
        LIMIT,
        `Expected final Redis ZSET cardinality to be ${LIMIT}`
      );
    });

    it('enforces independent concurrent sliding quotas for distinct client IPs in parallel', async () => {
      const redisClient = createAtomicRedisClient();
      const redisStore = new RedisStore({ client: redisClient });

      const LIMIT = 5;
      const app = createTestApp();
      app.get(
        '/api/sliding-clients',
        rateLimiter({
          algorithm: 'sliding-window',
          limit: LIMIT,
          windowMs: 60_000,
          store: redisStore
        }),
        (req, res) => res.json({ success: true })
      );

      const clientA = '10.200.2.1';
      const clientB = '10.200.2.2';

      const promisesA = Array.from({ length: 15 }, () =>
        request(app).get('/api/sliding-clients').set('X-Forwarded-For', clientA)
      );
      const promisesB = Array.from({ length: 15 }, () =>
        request(app).get('/api/sliding-clients').set('X-Forwarded-For', clientB)
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
      assert.equal(blockedA, 10);
      assert.equal(allowedB, LIMIT);
      assert.equal(blockedB, 10);
    });
  });
});
