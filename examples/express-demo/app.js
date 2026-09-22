import express from 'express';
import demoRoutes from './routes.js';

const app = express();

// Parse JSON request bodies
app.use(express.json());

/**
 * ARCHITECTURAL NOTE ON EXPRESS TRUST PROXY:
 *
 * In local development, req.ip resolves directly from the socket connection.
 *
 * In production environments operating behind reverse proxies, load balancers,
 * or CDNs (such as Nginx, AWS ALB, or Cloudflare), Express needs to know
 * which proxies to trust to parse the `X-Forwarded-For` header accurately:
 *
 *   app.set('trust proxy', 1); // Trust first hop (e.g. Nginx or ALB)
 *
 * Blindly trusting all forwarded headers without verified proxy hops is insecure
 * and can allow clients to spoof IP addresses. Configure this based on your
 * specific infrastructure topology.
 */

// Mount demo routes under the /api namespace
app.use('/api', demoRoutes);

// Catch-all 404 handler for undefined routes
app.use((req, res) => {
  res.status(404).json({
    success: false,
    message: `Cannot ${req.method} ${req.originalUrl}`
  });
});

export default app;
