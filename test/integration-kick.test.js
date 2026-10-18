'use strict';
// Integration test with the REAL mineflayer, minecraft-protocol and grammY (no stubs): a local offline-mode Minecraft
// server kicks every login the way Paper does when it throttles a second join from one IP. It proves the assumption
// the throttle handling rests on: mineflayer reports a login-phase kick through its `kicked` event, and
// index.js then waits quietly instead of burning a reconnect attempt.
// It skips itself when the dependencies are not installed (run `npm install` first). CI installs them.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');

const VERSION = '1.20.4';
const THROTTLE_TEXT = 'Connection throttled! Please wait before reconnecting.';

let mineflayer = null;
let mcProtocol = null;
let skip = false;
try {
  require('grammy');
  mineflayer = require('mineflayer');
  mcProtocol = require(require.resolve('minecraft-protocol', { paths: [require.resolve('mineflayer')] }));
} catch (_) {
  skip = 'grammy / mineflayer are not installed (run `npm install`)';
}

const freePort = () => new Promise((resolve, reject) => {
  const probe = net.createServer();
  probe.once('error', reject);
  probe.listen(0, '127.0.0.1', () => {
    const { port } = probe.address();
    probe.close(() => resolve(port));
  });
});

const waitFor = async (check, ms, what) => {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (check()) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`timed out waiting for ${what}`);
};

const waitForPort = async port => {
  const until = Date.now() + 5000;
  while (Date.now() < until) {
    const open = await new Promise(resolve => {
      const socket = net.connect(port, '127.0.0.1', () => { socket.destroy(); resolve(true); });
      socket.once('error', () => resolve(false));
    });
    if (open) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error('test server did not start');
};

const servers = [];

// Paper answers a throttled join with a LOGIN-phase disconnect, so `beforeLogin` (called before the login completes)
// is the faithful place to kick. If this minecraft-protocol version ignores that option, the `login` event kicks
// instead (a play-phase kick, which mineflayer also reports as `kicked`). `phase.used` records which one fired and is
// printed with t.diagnostic, so a green run says what it actually proved.
const startThrottlingServer = async () => {
  const port = await freePort();
  const phase = { used: null };
  const kick = (client, name) => {
    if (phase.used) return;
    phase.used = name;
    try { client.end(THROTTLE_TEXT); } catch (_) {}
  };
  const server = mcProtocol.createServer({
    host: '127.0.0.1', port, 'online-mode': false, version: VERSION, motd: 'mcafk integration', maxPlayers: 5,
    beforeLogin: client => kick(client, 'login phase (beforeLogin)'),
  });
  server.on('connection', client => client.on('error', () => {}));
  server.on('error', () => {});
  server.on('login', client => {
    client.on('error', () => {});
    kick(client, 'play phase (login event)');
  });
  servers.push(server);
  await waitForPort(port);
  return { server, port, phase };
};

after(() => {
  for (const server of servers) {
    try { server.close(); } catch (_) {}
  }
});

test('mineflayer reports a throttle kick through `kicked`', { skip, timeout: 30000 }, async t => {
  const { port, phase } = await startThrottlingServer();
  const client = mineflayer.createBot({ host: '127.0.0.1', port, username: 'Probe', version: VERSION, auth: 'offline', hideErrors: true });
  let reason = null;
  client.on('error', () => {});
  client.once('kicked', value => { reason = value; });
  try {
    await waitFor(() => reason !== null, 15000, 'the kicked event');
  } finally {
    try { client.end(); } catch (_) {}
  }
  t.diagnostic(`kick phase exercised: ${phase.used}`);
  assert.ok(JSON.stringify(reason).toLowerCase().includes('throttled'), `unexpected kick reason: ${JSON.stringify(reason)}`);
});

test('index.js treats it as a throttle: quiet, no reconnect attempt used, retry scheduled', { skip, timeout: 40000 }, async t => {
  const { port, phase } = await startThrottlingServer();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcafk-int-'));
  Object.assign(process.env, {
    MCAFK_TEST: '1', TELEGRAM_BOT_TOKEN: '123456:test', DATA_DIR: dir, JOIN_GAP_MS: '0', THROTTLE_RETRY_MS: '600000',
  });
  const app = require('../index.js');

  // Real grammY, but nothing may reach the network: record every outgoing call and answer it locally.
  const calls = [];
  app.bot.api.config.use(async (prev, method, payload) => {
    calls.push(method);
    return { ok: true, result: { message_id: 1 } };
  });

  const info = app.makePausedBot({ name: 'Throttled', host: '127.0.0.1', port, version: VERSION, userId: 7, chatId: 700 });
  info.autoReconnect = true;
  info.status = 'connecting';
  app.mcBots.set(info.id, info);
  try {
    app.spawnBot(info);
    await waitFor(() => (info.throttleStreak || 0) >= 1 || info.reconnectAttempts > 0, 20000, 'the kick to be handled');
    t.diagnostic(`kick phase exercised: ${phase.used}`);
    assert.equal(info.throttleStreak, 1, 'classified as a throttle (an unclassified kick would have used a reconnect attempt)');
    assert.equal(info.reconnectAttempts, 0);
    assert.equal(info.status, 'offline');
    assert.ok(info.reconnectTimer, 'a retry is scheduled');
    assert.deepEqual(calls.filter(method => /^send/.test(method)), [], 'the owner is not messaged');
  } finally {
    info.autoReconnect = false;
    clearTimeout(info.reconnectTimer);
    try { info.mcBot?.end?.(); } catch (_) {}
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
