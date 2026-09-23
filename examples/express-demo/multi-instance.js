import 'dotenv/config';
import express from 'express';
import { createClient } from 'redis';
import { rateLimiter, RedisStore } from '../../src/index.js';

const PORT_A = Number(process.env.PORT_A || 3000);
const PORT_B = Number(process.env.PORT_B || 3001);
const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';

const redisClient = createClient({ url: REDIS_URL });

redisClient.on('error', (err) => {
  console.error('[Redis Error]', err.message);
});

await redisClient.connect();
console.log(`Connected to Redis at ${REDIS_URL}`);

const sharedStore = new RedisStore({ client: redisClient });

const sharedLimiter = rateLimiter({
  limit: 5,
  windowMs: 60_000,
  store: sharedStore
});

function createApp(instanceName) {
  const app = express();
  app.set('trust proxy', true);
  app.use(express.json());

  app.get('/api/resource', sharedLimiter, (req, res) => {
    res.json({
      success: true,
      message: `Response from ${instanceName}`,
      ip: req.ip
    });
  });

  return app;
}

const appA = createApp('Instance A');
const appB = createApp('Instance B');

const serverA = appA.listen(PORT_A, () => {
  console.log(`Instance A listening on http://localhost:${PORT_A}`);
});

const serverB = appB.listen(PORT_B, () => {
  console.log(`Instance B listening on http://localhost:${PORT_B}`);
});

async function handleShutdown(signal) {
  console.log(`\nReceived ${signal}. Shutting down gracefully...`);

  await new Promise((resolve) => serverA.close(resolve));
  await new Promise((resolve) => serverB.close(resolve));
  await redisClient.quit();

  process.exit(0);
}

process.on('SIGINT', () => handleShutdown('SIGINT'));
process.on('SIGTERM', () => handleShutdown('SIGTERM'));

export { appA, appB, serverA, serverB, redisClient };
