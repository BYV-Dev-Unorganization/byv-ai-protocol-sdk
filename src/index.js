'use strict';

const { start, createServer } = require('./server');

if (require.main === module) {
  start().catch((error) => {
    console.error('[startup] BYV gateway failed to initialize:', error.message || error);
    process.exitCode = 1;
  });
}

module.exports = { start, createServer };