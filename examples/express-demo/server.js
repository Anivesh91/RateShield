import 'dotenv/config';
import app from './app.js';

const PORT = Number(process.env.PORT || 3000);

const server = app.listen(PORT, () => {
  console.log(`==============================================`);
  console.log(`  SmartRate Demo Server is running!           `);
  console.log(`  Listening on: http://localhost:${PORT}      `);
  console.log(`  Endpoints:                                  `);
  console.log(`    - GET  /api/test   (Limit: 5 req / 60s)   `);
  console.log(`    - POST /api/login  (Limit: 3 req / 60s)   `);
  console.log(`    - GET  /api/public (Limit: 10 req / 60s)  `);
  console.log(`==============================================`);
});

export default server;
