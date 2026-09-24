import 'dotenv/config';
import express from 'express';
import { rateLimiter, MemoryStore } from '../../src/index.js';

const app = express();
const PORT = Number(process.env.SAAS_DEMO_PORT || 3003);

app.set('trust proxy', true);
app.use(express.json());

// In-memory store for demonstration
const memoryStore = new MemoryStore();

// Simulated customer database
const API_KEY_REGISTRY = {
  'ak_free_123': { name: 'Acme Starter', tier: 'free' },
  'ak_pro_456': { name: 'Beta Scale', tier: 'pro' },
  'ak_ent_789': { name: 'Global Enterprise', tier: 'enterprise' }
};

// Tier configurations
const TIER_POLICIES = {
  free: { capacity: 5, refillRate: 1 },         // 5 burst, 1 token/sec
  pro: { capacity: 20, refillRate: 5 },        // 20 burst, 5 tokens/sec
  enterprise: { capacity: 100, refillRate: 25 } // 100 burst, 25 tokens/sec
};

/**
 * Middleware: Simulates authentication & customer profile lookup
 */
app.use((req, res, next) => {
  const apiKey = req.headers['x-api-key'];
  if (apiKey && API_KEY_REGISTRY[apiKey]) {
    req.customer = API_KEY_REGISTRY[apiKey];
    req.apiKey = apiKey;
  } else {
    // Unauthenticated anonymous user -> default to free tier
    req.customer = { name: 'Anonymous Public', tier: 'free' };
    req.apiKey = req.ip || '127.0.0.1';
  }
  next();
});

/**
 * SmartRate v4 SaaS Rate Limiter Middleware
 * Uses Token Bucket with dynamic per-tenant identity, capacity, refill, and cost.
 */
const saasLimiter = rateLimiter({
  store: memoryStore,
  algorithm: 'token-bucket',

  // 1. Custom Identity: Isolates buckets per API Key or Client IP
  keyGenerator: (req) => req.apiKey,

  // 2. Dynamic Capacity: Evaluated per-request based on customer subscription tier
  capacity: (req) => {
    const tier = req.customer?.tier || 'free';
    return TIER_POLICIES[tier].capacity;
  },

  // 3. Dynamic Refill Rate: Continuous token generation rate based on tier
  refillRate: (req) => {
    const tier = req.customer?.tier || 'free';
    return TIER_POLICIES[tier].refillRate;
  },

  // 4. Dynamic Weighted Cost: Heavy endpoints consume more tokens than standard reads
  cost: (req) => {
    if (req.path.includes('/export') || req.body?.heavy === true) {
      return 5; // Heavy compute operation consumes 5 tokens
    }
    return 1; // Standard read consumes 1 token
  }
});

app.use('/api', saasLimiter);

/**
 * Standard Read Endpoint (Cost: 1 token)
 */
app.get('/api/data', (req, res) => {
  res.json({
    success: true,
    message: 'Data retrieved successfully',
    customer: req.customer,
    endpoint: '/api/data',
    cost: '1 token',
    timestamp: new Date().toISOString()
  });
});

/**
 * Heavy Compute / Export Endpoint (Cost: 5 tokens)
 */
postExportHandler:
app.post('/api/export', (req, res) => {
  res.json({
    success: true,
    message: 'Heavy data export completed',
    customer: req.customer,
    endpoint: '/api/export',
    cost: '5 tokens',
    timestamp: new Date().toISOString()
  });
});

/**
 * Root Route: Usage Guide & Sample Curl Commands
 */
app.get('/', (req, res) => {
  res.json({
    title: 'SmartRate v4 — SaaS Multi-Tier & Dynamic Policy Demo',
    tiers: {
      free: { apiKey: 'ak_free_123', ...TIER_POLICIES.free },
      pro: { apiKey: 'ak_pro_456', ...TIER_POLICIES.pro },
      enterprise: { apiKey: 'ak_ent_789', ...TIER_POLICIES.enterprise }
    },
    sampleRequests: [
      'curl -H "x-api-key: ak_free_123" http://localhost:' + PORT + '/api/data',
      'curl -H "x-api-key: ak_pro_456" http://localhost:' + PORT + '/api/data',
      'curl -X POST -H "x-api-key: ak_ent_789" http://localhost:' + PORT + '/api/export'
    ]
  });
});

let server;

export function startSaasDemoServer(port = PORT) {
  return new Promise((resolve) => {
    server = app.listen(port, () => {
      console.log(`\n================================================================`);
      console.log(`SmartRate v4 SaaS Multi-Tier Demo running at http://localhost:${port}`);
      console.log(`================================================================`);
      console.log(`[Free Tier]       x-api-key: ak_free_123  (Capacity: 5,  Refill: 1/sec)`);
      console.log(`[Pro Tier]        x-api-key: ak_pro_456   (Capacity: 20, Refill: 5/sec)`);
      console.log(`[Enterprise Tier] x-api-key: ak_ent_789   (Capacity: 100, Refill: 25/sec)`);
      console.log(`----------------------------------------------------------------`);
      console.log(`[Standard Read]   GET  /api/data   (Cost: 1 token)`);
      console.log(`[Heavy Export]    POST /api/export (Cost: 5 tokens)`);
      console.log(`================================================================\n`);
      resolve(server);
    });
  });
}

// Auto-start server if executed directly from CLI
if (process.argv[1] && process.argv[1].endsWith('saas-demo.js')) {
  startSaasDemoServer();
}

export { app };
