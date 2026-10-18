'use strict';
const { test, describe, beforeEach, afterEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const { loadApp } = require('./helpers');

const THROTTLE_REASON = '{"text":"Connection throttled! Please wait before reconnecting."}';

describe('classifyKick', () => {
  const { app, cleanup } = loadApp();
  test('recognises the throttle kick and leaves the others alone', () => {
    assert.equal(app.classifyKick('Connection throttled! Please wait before reconnecting.'), 'throttle');
    assert.equal(app.classifyKick('connection throttled'), 'throttle');
    assert.equal(app.classifyKick('You are banned from this server'), 'ban');
    assert.equal(app.classifyKick('You are not white-listed on this server!'), 'whitelist');
    assert.equal(app.classifyKick('You logged in from another location'), 'duplicate');
    assert.equal(app.classifyKick('The server is full!'), 'full');
    assert.equal(app.classifyKick('Flying is not enabled on this server'), 'other');
    cleanup();
  });
});

describe('join queue', () => {
  let t;
  beforeEach(() => {
    t = loadApp();
    mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: Date.UTC(2026, 9, 3, 12, 0, 0) });
  });
  afterEach(() => {
    t.cleanup();
    mock.timers.reset();
  });

  test('bots started together on one host join JOIN_GAP_MS apart', async () => {
    const gap = t.app.CFG.JOIN_GAP_MS;
    assert.equal(gap, 5000);
    for (const name of ['A', 'B', 'C']) t.app.spawnBot(t.addBot(name));
    await t.flush();
    assert.equal(t.created.length, 1, 'first bot joins at once');

    mock.timers.tick(gap - 1);
    await t.flush();
    assert.equal(t.created.length, 1, 'second bot still waits');

    mock.timers.tick(1);
    await t.flush();
    assert.equal(t.created.length, 2);

    mock.timers.tick(gap);
    await t.flush();
    assert.equal(t.created.length, 3);
    assert.deepEqual(t.created.map(mc => mc.username), ['A', 'B', 'C']);
  });

  test('different hosts do not wait for each other', async () => {
    t.app.spawnBot(t.addBot('A', { host: 'one.example.com' }));
    t.app.spawnBot(t.addBot('B', { host: 'two.example.com' }));
    t.app.spawnBot(t.addBot('C', { host: 'ONE.example.com' })); // same host, different case
    await t.flush();
    assert.deepEqual(t.created.map(mc => mc.username), ['A', 'B']);
    mock.timers.tick(5000);
    await t.flush();
    assert.deepEqual(t.created.map(mc => mc.username), ['A', 'B', 'C']);
  });

  test('a bot that is destroyed or re-spawned while queued does not take a slot', async () => {
    const a = t.addBot('A');
    const b = t.addBot('B');
    t.app.spawnBot(a);
    await t.flush();
    t.app.spawnBot(b); // queued behind A
    await t.flush();
    b.autoReconnect = false;
    t.app.mcBots.delete(b.id); // removed by the user
    const c = t.addBot('C');
    t.app.spawnBot(c);
    await t.flush();
    mock.timers.tick(5000);
    await t.flush();
    assert.deepEqual(t.created.map(mc => mc.username), ['A', 'C'], 'B was skipped without costing C a second gap');
  });
});

describe('throttle kick', () => {
  let t;
  beforeEach(() => {
    t = loadApp();
    mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: Date.UTC(2026, 9, 3, 12, 0, 0) });
  });
  afterEach(() => {
    t.cleanup();
    mock.timers.reset();
  });

  const join = async (info) => {
    t.app.spawnBot(info, false);
    await t.flush();
    return t.created[t.created.length - 1];
  };

  test('waits quietly: no message, no reconnect attempt used, retried after THROTTLE_RETRY_MS', async () => {
    const info = t.addBot('A');
    const mc = await join(info);
    mc.emit('kicked', THROTTLE_REASON);

    assert.equal(info.reconnectAttempts, 0);
    assert.equal(info.status, 'offline');
    assert.equal(t.sent.length, 0, 'nothing is sent to the owner');

    mock.timers.tick(t.app.CFG.THROTTLE_RETRY_MS);
    await t.flush();
    assert.equal(t.created.length, 2, 'it joins again');
    assert.equal(info.reconnectAttempts, 0);
    assert.equal(t.sent.length, 0);
  });

  test('a real spawn resets the throttle streak', async () => {
    const info = t.addBot('A');
    const mc = await join(info);
    mc.emit('kicked', THROTTLE_REASON);
    assert.equal(info.throttleStreak, 1);
    mock.timers.tick(t.app.CFG.THROTTLE_RETRY_MS);
    await t.flush();
    t.created[1].spawn();
    assert.equal(info.throttleStreak, 0);
    assert.equal(info.status, 'online');
  });

  test('after THROTTLE_MAX_STREAK kicks in a row the normal backoff takes over', async () => {
    const info = t.addBot('A');
    const max = t.app.CFG.THROTTLE_MAX_STREAK;
    let kicks = 0;
    let mc = await join(info);
    while (info.reconnectAttempts === 0 && kicks < max + 5) {
      mc.emit('kicked', THROTTLE_REASON);
      kicks += 1;
      if (info.reconnectAttempts > 0) break;
      mock.timers.tick(t.app.CFG.THROTTLE_RETRY_MS);
      await t.flush();
      mc = t.created[t.created.length - 1];
    }
    assert.equal(kicks, max + 1);
    assert.equal(info.reconnectAttempts, 1, 'now it counts as a normal reconnect');
    assert.ok(t.sent.some(m => /reconnecting/.test(m.text)), 'and the owner hears about it');
  });

  test('other kicks still use the normal reconnect path', async () => {
    const info = t.addBot('A');
    const mc = await join(info);
    mc.emit('kicked', 'Flying is not enabled on this server');
    assert.equal(info.reconnectAttempts, 1);
  });
});

describe('join queue is keyed by resolved address', () => {
  let t;
  beforeEach(() => {
    t = loadApp();
    mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: Date.UTC(2026, 9, 3, 12, 0, 0) });
  });
  afterEach(() => {
    t.cleanup();
    mock.timers.reset();
  });

  test('two names for one server share a queue; a different server does not', async () => {
    const ips = { 'a.example.com': '10.0.0.1', 'b.example.com': '10.0.0.1', 'c.example.com': '10.0.0.2' };
    t.app.joinResolver.lookup = async host => ips[host];
    t.app.spawnBot(t.addBot('A', { host: 'a.example.com' }));
    t.app.spawnBot(t.addBot('B', { host: 'b.example.com' }));
    t.app.spawnBot(t.addBot('C', { host: 'c.example.com' }));
    await t.flush();
    assert.deepEqual(t.created.map(mc => mc.username).sort(), ['A', 'C'], 'B waits behind A: same IP');
    mock.timers.tick(5000);
    await t.flush();
    assert.deepEqual(t.created.map(mc => mc.username).sort(), ['A', 'B', 'C']);
  });

  test('the port is part of the key', async () => {
    t.app.joinResolver.lookup = async () => '10.0.0.1';
    t.app.spawnBot(t.addBot('A', { host: 'a.example.com', port: 25565 }));
    t.app.spawnBot(t.addBot('B', { host: 'a.example.com', port: 25566 }));
    await t.flush();
    assert.equal(t.created.length, 2);
  });

  test('a failing lookup falls back to the host name (and is not cached)', async () => {
    let calls = 0;
    t.app.joinResolver.lookup = async () => { calls += 1; throw new Error('ENOTFOUND'); };
    t.app.spawnBot(t.addBot('A', { host: 'dead.example.com' }));
    t.app.spawnBot(t.addBot('B', { host: 'dead.example.com' }));
    await t.flush();
    assert.equal(t.created.length, 1, 'same host name still shares a queue');
    assert.equal(t.app.joinKeyCache.has('dead.example.com'), false);
    assert.ok(calls >= 1);
  });

  test('a slow lookup times out instead of blocking the join', async () => {
    t.app.joinResolver.lookup = () => new Promise(() => {}); // never answers
    t.app.spawnBot(t.addBot('A', { host: 'slow.example.com' }));
    await t.flush();
    assert.equal(t.created.length, 0);
    mock.timers.tick(t.app.CFG.JOIN_DNS_TIMEOUT_MS);
    await t.flush();
    assert.equal(t.created.length, 1);
  });

  test('answers are cached, IP literals skip DNS, and one lookup serves a burst', async () => {
    let calls = 0;
    t.app.joinResolver.lookup = async () => { calls += 1; return '10.0.0.1'; };
    for (const name of ['A', 'B', 'C']) t.app.spawnBot(t.addBot(name, { host: 'play.example.com' }));
    await t.flush();
    assert.equal(calls, 1, 'one lookup for three bots');
    t.app.spawnBot(t.addBot('D', { host: '192.168.1.5' }));
    await t.flush();
    assert.equal(calls, 1, 'IP literal does not resolve');
  });

  test('a bot removed while its name is resolving never joins', async () => {
    let release;
    t.app.joinResolver.lookup = () => new Promise(resolve => { release = () => resolve('10.0.0.1'); });
    const info = t.addBot('A', { host: 'a.example.com' });
    t.app.spawnBot(info);
    await t.flush();
    t.app.mcBots.delete(info.id);
    release();
    await t.flush();
    assert.equal(t.created.length, 0);
  });
});
