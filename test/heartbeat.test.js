'use strict';
const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { loadApp } = require('./helpers');

const SECRET = 'a1b2c3d4-secret-check-uuid';

describe('heartbeat', () => {
  let server;
  let hits;
  let status;
  let t;
  let logs;
  const realLog = console.log;
  const realError = console.error;

  const boot = (env = {}) => {
    t = loadApp({ HEARTBEAT_URL: `http://127.0.0.1:${server.address().port}/ping/${SECRET}`, ...env });
    return t.app;
  };

  beforeEach(async () => {
    hits = [];
    status = 200;
    logs = [];
    console.log = (...args) => logs.push(args.join(' '));
    console.error = (...args) => logs.push(args.join(' '));
    server = http.createServer((req, res) => {
      hits.push({ method: req.method, url: req.url, agent: req.headers['user-agent'] });
      res.statusCode = status;
      res.end('OK');
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  });

  afterEach(async () => {
    console.log = realLog;
    console.error = realError;
    t?.cleanup();
    await new Promise(resolve => server.close(resolve));
  });

  test('pings the URL while Telegram is healthy', async () => {
    const app = boot();
    app.setLastTelegramOkAt(Date.now());
    await app.heartbeatTick();
    assert.equal(hits.length, 1);
    assert.equal(hits[0].method, 'GET');
    assert.equal(hits[0].url, `/ping/${SECRET}`);
    assert.equal(hits[0].agent, 'mcafk-heartbeat');
    assert.equal(app.heartbeat.state, 'ok');
    assert.match(app.heartbeatLine(), /^on · last ping/);
  });

  test('stops pinging when Telegram has gone quiet, resumes when it is back', async () => {
    const app = boot();
    await app.heartbeatTick(); // Telegram never answered yet
    assert.equal(hits.length, 0);
    assert.equal(app.heartbeat.state, 'paused');

    app.setLastTelegramOkAt(Date.now());
    await app.heartbeatTick();
    assert.equal(hits.length, 1);

    app.setLastTelegramOkAt(Date.now() - app.CFG.HEARTBEAT_TG_STALE_MS - 1000);
    await app.heartbeatTick();
    assert.equal(hits.length, 1, 'no ping while Telegram is stale');
    assert.equal(app.heartbeat.state, 'paused');
    assert.match(app.heartbeatLine(), /paused/);

    app.setLastTelegramOkAt(Date.now());
    await app.heartbeatTick();
    assert.equal(hits.length, 2);
    assert.equal(app.heartbeat.state, 'ok');
  });

  test('a failing endpoint is reported and recovers', async () => {
    const app = boot();
    app.setLastTelegramOkAt(Date.now());
    status = 500;
    await app.heartbeatTick();
    assert.equal(app.heartbeat.state, 'failing');
    assert.match(app.heartbeatLine(), /failing: HTTP 500/);
    status = 200;
    await app.heartbeatTick();
    assert.equal(app.heartbeat.state, 'ok');
  });

  test('a dead endpoint does not throw or hang', async () => {
    const app = boot();
    app.setLastTelegramOkAt(Date.now());
    await new Promise(resolve => server.close(resolve));
    server = http.createServer(); // keeps afterEach's close() happy
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    await app.heartbeatTick();
    assert.equal(app.heartbeat.state, 'failing');
  });

  test('no ping while shutting down', async () => {
    const app = boot();
    app.setLastTelegramOkAt(Date.now());
    app.setShuttingDown(true);
    await app.heartbeatTick();
    assert.equal(hits.length, 0);
    app.setShuttingDown(false);
  });

  test('the secret URL is never logged', async () => {
    const app = boot();
    app.setLastTelegramOkAt(Date.now());
    status = 500;
    await app.heartbeatTick();
    status = 200;
    await app.heartbeatTick();
    app.setLastTelegramOkAt(0);
    await app.heartbeatTick();
    assert.ok(logs.length >= 2, 'state changes were logged');
    assert.ok(!logs.some(line => line.includes(SECRET)), 'but never with the check URL');
  });

  test('off by default, and an invalid URL disables it with a warning', async () => {
    t = loadApp();
    assert.match(t.app.heartbeatLine(), /^off/);
    await t.app.heartbeatTick();
    assert.equal(hits.length, 0);
    t.cleanup();

    t = loadApp({ HEARTBEAT_URL: 'ftp://example.com/x' });
    assert.match(t.app.heartbeatLine(), /^off/);
    assert.ok(logs.some(line => /HEARTBEAT_URL is not a valid/.test(line)));
  });

  test('/status shows quiet hours, join queue and heartbeat', async () => {
    const app = boot();
    const view = app.statusView(7, 7, 'someone');
    assert.match(view.legacy, /Quiet hours: off/);
    assert.match(view.legacy, /Join queue: 0 waiting · 5s between joins/);
    assert.match(view.legacy, /Heartbeat: on · starting/);
    assert.match(view.rich, /Quiet hours/);
    assert.match(view.rich, /Heartbeat/);
  });
});
