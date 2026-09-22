import 'dotenv/config';
import app from './app.js';

const PORT = Number(process.env.PORT || 3000);

const server = app.listen(PORT, () => {
  console.log(`SmartRate demo running on http://localhost:${PORT}`);
  console.log('Routes:');
  console.log('  GET  /api/test   -> 5 req / 60s');
  console.log('  POST /api/login  -> 3 req / 60s');
  console.log('  GET  /api/public -> 10 req / 60s');
});

export default server;
