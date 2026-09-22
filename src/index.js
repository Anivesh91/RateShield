/**
 * SmartRate — Public Package Entry Point
 *
 * This file serves as the public facade for the SmartRate library.
 * Consumers import from this entry point rather than accessing internal files.
 */
export { default } from './limiter/rateLimiter.js';
export { rateLimiter } from './limiter/rateLimiter.js';
