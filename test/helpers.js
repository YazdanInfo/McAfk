'use strict';
// Loads index.js with grammy / mineflayer / minecraft-protocol replaced by the stubs in test/stubs,
// a throw-away DATA_DIR and MCAFK_TEST=1 (which exports internals instead of starting the bot).
const Module = require('module');
const path = require('path');
const fs = require('fs');
const os = require('os');

const STUBS = {
  grammy: path.join(__dirname, 'stubs', 'grammy.js'),
  mineflayer: path.join(__dirname, 'stubs', 'mineflayer.js'),
  'minecraft-protocol': path.join(__dirname, 'stubs', 'minecraft-protocol.js'),
};

const originalResolve = Module._resolveFilename;
Module._resolveFilename = function resolveWithStubs(request, ...rest) {
  if (Object.prototype.hasOwnProperty.call(STUBS, request)) return STUBS[request];
  return originalResolve.call(this, request, ...rest);
};

const INDEX = path.join(__dirname, '..', 'index.js');
const ENV_KEYS = ['MC_VIEW_DISTANCE', 'HEARTBEAT_URL', 'JOIN_GAP_MS', 'THROTTLE_RETRY_MS', 'HEARTBEAT_INTERVAL_MS', 'HEARTBEAT_TG_STALE_MS', 'ALLOWED_USER_IDS', 'DATA_DIR',
  'ALLOW_OPEN_ACCESS', 'MAX_BOTS_PER_USER', 'MAX_BOTS_TOTAL', 'AUTO_RESUME', 'RESUME_SPREAD_MS', 'MC_IDLE_VIEW_DISTANCE', 'MC_IDLE_AFTER_MIN',
  'MC_ALLOW_PRIVATE_HOSTS', 'RESUME_CRASH_LOOP_STARTS'];

// Fresh copy of index.js. `env` overrides environment variables, `dataDir` reuses a data directory (persistence tests).
const loadApp = (env = {}, dataDir = null) => {
  for (const key of ENV_KEYS) delete process.env[key];
  const dir = dataDir || fs.mkdtempSync(path.join(os.tmpdir(), 'mcafk-test-'));
  Object.assign(process.env, { MCAFK_TEST: '1', TELEGRAM_BOT_TOKEN: '123456:test', DATA_DIR: dir }, env);
  for (const key of Object.keys(require.cache)) {
    if (key === INDEX || key.startsWith(path.join(__dirname, 'stubs')) || key.startsWith(path.join(__dirname, '..', 'src'))) delete require.cache[key];
  }
  const app = require(INDEX);
  app.joinResolver.lookup = async host => host; // no real DNS in tests: the host name stands in for its address
  const mineflayer = require('mineflayer');
  const protocol = require('minecraft-protocol');

  const flush = async (rounds = 5) => { for (let i = 0; i < rounds; i += 1) await new Promise(resolve => setImmediate(resolve)); };

  // A registered, owned bot ready for spawnBot().
  const addBot = (name, extra = {}) => {
    const info = app.makePausedBot({ name, host: 'play.example.com', port: 25565, version: '1.20.4', userId: 7, chatId: 700, ...extra });
    info.autoReconnect = true;
    info.status = 'connecting';
    app.mcBots.set(info.id, info);
    return info;
  };

  const cleanup = () => {
    for (const info of app.mcBots.values()) {
      info.autoReconnect = false;
      clearInterval(info.tickTimer);
      clearTimeout(info.reconnectTimer);
      if (info.healthAlert) clearTimeout(info.healthAlert.editTimer);
    }
    for (const queue of app.joinQueues.values()) clearTimeout(queue.timer);
    if (!dataDir) fs.rmSync(dir, { recursive: true, force: true });
  };

  return { app, mineflayer, protocol, flush, addBot, cleanup, dir, created: mineflayer.created, sent: app.bot.sent };
};

module.exports = { loadApp };
