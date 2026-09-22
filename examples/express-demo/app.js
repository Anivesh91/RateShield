import express from 'express';
import demoRoutes from './routes.js';

const app = express();

app.use(express.json());

// In production behind reverse proxies (Nginx, ALB, Cloudflare),
// configure app.set('trust proxy', 1) to accurately parse client IPs.
app.use('/api', demoRoutes);

app.use((req, res) => {
  res.status(404).json({
    success: false,
    message: `Cannot ${req.method} ${req.originalUrl}`
  });
});

export default app;
