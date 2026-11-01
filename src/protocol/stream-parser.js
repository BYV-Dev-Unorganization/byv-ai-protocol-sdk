'use strict';

const { BYVStreamParser } = require('./parser');

function createBYVStreamParser(options) {
  return new BYVStreamParser(options);
}

module.exports = { BYVStreamParser, createBYVStreamParser };