import 'dotenv/config';
import express from 'express';
import { rateLimiter, MemoryStore } from '../../src/index.js';

const app = express();
const PORT = Number(process.env.DEMO_PORT || 3002);

app.set('trust proxy', true);
app.use(express.json());

// In-memory store instance for demonstration
const memoryStore = new MemoryStore();

/**
 * Route 1: Fixed Window Demonstration
 * Limit: 5 requests per 10 seconds
 */
app.get(
  '/api/fixed',
  rateLimiter({
    algorithm: 'fixed-window',
    limit: 5,
    windowMs: 10_000,
    store: memoryStore
  }),
  (req, res) => {
    res.json({
      success: true,
      algorithm: 'fixed-window',
      message: 'Request allowed under Fixed Window policy (5 req / 10s)',
      timestamp: new Date().toISOString()
    });
  }
);

/**
 * Route 2: Sliding Window Demonstration
 * Limit: 5 requests per 10 seconds (Rolling)
 */
app.get(
  '/api/sliding',
  rateLimiter({
    algorithm: 'sliding-window',
    limit: 5,
    windowMs: 10_000,
    store: memoryStore
  }),
  (req, res) => {
    res.json({
      success: true,
      algorithm: 'sliding-window',
      message: 'Request allowed under Rolling Sliding Window policy (5 req / 10s)',
      timestamp: new Date().toISOString()
    });
  }
);

/**
 * Root Route: Usage Guide
 */
app.get('/', (req, res) => {
  res.json({
    title: 'SmartRate v3 — Algorithm Comparison Demo',
    endpoints: [
      {
        path: '/api/fixed',
        algorithm: 'fixed-window',
        limit: 5,
        windowMs: 10000,
        note: 'Prone to boundary bursts (e.g. 5 reqs at t=9s, 5 reqs at t=10.1s -> 10 reqs in ~1s)'
      },
      {
        path: '/api/sliding',
        algorithm: 'sliding-window',
        limit: 5,
        windowMs: 10000,
        note: 'Strictly rolling: guarantees no more than 5 reqs in ANY 10-second rolling window'
      }
    ]
  });
});

let server;

export function startDemoServer(port = PORT) {
  return new Promise((resolve) => {
    server = app.listen(port, () => {
      console.log(`\n======================================================`);
      console.log(`SmartRate v3 Comparison Demo running at http://localhost:${port}`);
      console.log(`======================================================`);
      console.log(`[Fixed Window]   GET http://localhost:${port}/api/fixed   (5 req / 10s)`);
      console.log(`[Sliding Window] GET http://localhost:${port}/api/sliding (5 req / 10s)`);
      console.log(`======================================================\n`);
      resolve(server);
    });
  });
}

// Auto-start server if executed directly from CLI
if (process.argv[1] && process.argv[1].endsWith('sliding-demo.js')) {
  startDemoServer();
}

export default app;
