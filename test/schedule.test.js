'use strict';
const { test, describe, beforeEach, afterEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const { loadApp } = require('./helpers');

// schedule 22 -> 6 (wraps midnight): hour 23 is inside, hour 12 is outside
const INSIDE = 23;
const OUTSIDE = 12;

describe('schedule loop', () => {
  let t;
  beforeEach(() => {
    t = loadApp();
    mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: Date.UTC(2026, 9, 3, 12, 0, 0) });
  });
  afterEach(() => {
    t.cleanup();
    mock.timers.reset();
  });

  const scheduled = (name, extra = {}) => {
    const info = t.addBot(name, { settings: { schedule: { start: 22, end: 6 } }, ...extra });
    info.status = 'offline';
    info.autoReconnect = false;
    return info;
  };

  test('starts a bot that is off and not waiting for anything', async () => {
    const info = scheduled('A');
    t.app.scheduleTick(INSIDE);
    await t.flush();
    assert.equal(info.status, 'connecting');
    assert.equal(t.created.length, 1);
  });

  test('leaves a bot alone while its backoff / lobby / kick / throttle timer is pending', async () => {
    const info = scheduled('A');
    info.autoReconnect = true;
    info.reconnectAttempts = 3;
    info.reconnectTimer = setTimeout(() => {}, 30_000);
    t.app.scheduleTick(INSIDE);
    await t.flush();
    assert.equal(info.status, 'offline', 'not respawned');
    assert.equal(info.reconnectAttempts, 3, 'attempt counter is not reset');
    assert.equal(t.created.length, 0);
    assert.ok(info.reconnectTimer, 'the pending retry is still there');
  });

  test('a manual Disconnect holds until the window ends, then the next window starts it again', async () => {
    const info = scheduled('A');
    info.userStopped = true;
    t.app.scheduleTick(INSIDE);
    await t.flush();
    assert.equal(t.created.length, 0, 'user said stop');

    t.app.scheduleTick(OUTSIDE); // window closes: the hold is released
    assert.equal(info.userStopped, false);
    t.app.scheduleTick(INSIDE);
    await t.flush();
    assert.equal(t.created.length, 1, 'next window resumes it');
  });

  test('a Reconnect press (spawnBot) clears the manual hold', async () => {
    const info = scheduled('A');
    info.userStopped = true;
    t.app.spawnBot(info);
    assert.equal(info.userStopped, false);
  });

  test('closing the window stops a connected bot AND one that is waiting to retry', async () => {
    const online = scheduled('A');
    online.status = 'online';
    online.autoReconnect = true;
    const waiting = scheduled('B');
    waiting.autoReconnect = true;
    waiting.reconnectTimer = setTimeout(() => {}, 30_000);

    t.app.scheduleTick(OUTSIDE);
    for (const info of [online, waiting]) {
      assert.equal(info.status, 'offline');
      assert.equal(info.autoReconnect, false);
      assert.equal(info.reconnectTimer, null, 'retry timer cancelled');
      assert.match(info.error, /Scheduled off-hours/);
    }
  });

  test('bots without a schedule are never touched', async () => {
    const info = t.addBot('A');
    info.status = 'offline';
    info.autoReconnect = false;
    t.app.scheduleTick(INSIDE);
    t.app.scheduleTick(OUTSIDE);
    await t.flush();
    assert.equal(t.created.length, 0);
    assert.equal(info.status, 'offline');
  });
});
