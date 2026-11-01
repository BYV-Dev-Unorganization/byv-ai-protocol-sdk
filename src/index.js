'use strict';

const { start, createServer } = require('./server');

if (require.main === module) start();

module.exports = { start, createServer };