'use strict';
// Tests set process.env directly (see test/helpers.js ENV_KEYS/loadApp), so .env files
// never come into play here. config() is a no-op that matches dotenv's real return shape.
module.exports = {
  config: (_options = {}) => ({ parsed: {} }),
};