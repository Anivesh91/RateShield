import { Router } from 'express';
import { rateLimiter } from '../../src/index.js';
import {
  testController,
  loginController,
  publicController
} from './controllers.js';

const router = Router();

/**
 * Route 1: GET /api/test
 * Policy: 5 requests per 60 seconds
 */
router.get(
  '/test',
  rateLimiter({
    limit: 5,
    windowMs: 60_000
  }),
  testController
);

/**
 * Route 2: POST /api/login
 * Policy: 3 requests per 60 seconds (Simulates strict endpoint protection)
 */
router.post(
  '/login',
  rateLimiter({
    limit: 3,
    windowMs: 60_000
  }),
  loginController
);

/**
 * Route 3: GET /api/public
 * Policy: 10 requests per 60 seconds (Simulates higher allowance public endpoint)
 */
router.get(
  '/public',
  rateLimiter({
    limit: 10,
    windowMs: 60_000
  }),
  publicController
);

export default router;
