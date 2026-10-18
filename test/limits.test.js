'use strict';
const { test, describe, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { loadApp } = require('./helpers');

describe('access default', () => {
  let t;
  afterEach(() => t?.cleanup());

  test('no ALLOWED_USER_IDS: closed to everyone; the allowlist lets its users in', () => {
    t = loadApp();
    assert.equal(t.app.accessMode(), 'closed');
    assert.equal(t.app.isUserAllowed(7), false);
    assert.equal(t.app.isUserAllowed(undefined), false);
    t.cleanup();

    t = loadApp({ ALLOWED_USER_IDS: '7, 8' });
    assert.equal(t.app.accessMode(), 'restricted');
    assert.equal(t.app.isUserAllowed(7), true);
    assert.equal(t.app.isUserAllowed('8'), true);
    assert.equal(t.app.isUserAllowed(9), false);
  });

  test('ALLOW_OPEN_ACCESS=1 restores open access, but never overrides an allowlist', () => {
    t = loadApp({ ALLOW_OPEN_ACCESS: '1' });
    assert.equal(t.app.accessMode(), 'open');
    assert.equal(t.app.isUserAllowed(123), true);
    t.cleanup();

    t = loadApp({ ALLOW_OPEN_ACCESS: '1', ALLOWED_USER_IDS: '7' });
    assert.equal(t.app.accessMode(), 'restricted');
    assert.equal(t.app.isUserAllowed(123), false);
  });
});

describe('bot limits', () => {
  let t;
  afterEach(() => t?.cleanup());
  const check = (userId, existing = null) => t.app.botLimitCheck(userId, 1, 'u', existing);
  const add = (name, userId, host = 'play.example.com') => t.addBot(name, { userId, host });

  test('defaults: 5 per user, 20 in total', () => {
    t = loadApp();
    assert.equal(t.app.CFG.MAX_BOTS_PER_USER, 5);
    assert.equal(t.app.CFG.MAX_BOTS_TOTAL, 20);
  });

  test('the per-user limit blocks the sixth bot of one user, not of another', () => {
    t = loadApp();
    for (let i = 0; i < 4; i += 1) add(`A${i}`, 7);
    assert.equal(check(7), null);
    add('A4', 7);
    assert.deepEqual(check(7), { kind: 'user', limit: 5, count: 5 });
    assert.equal(check(8), null);
  });

  test('the global limit applies to everyone', () => {
    t = loadApp({ MAX_BOTS_PER_USER: '0', MAX_BOTS_TOTAL: '3' });
    add('A', 7); add('B', 8); add('C', 9);
    assert.deepEqual(check(10), { kind: 'total', limit: 3, count: 3 });
  });

  test('0 means no limit', () => {
    t = loadApp({ MAX_BOTS_PER_USER: '0', MAX_BOTS_TOTAL: '0' });
    for (let i = 0; i < 30; i += 1) add(`B${i}`, 7);
    assert.equal(check(7), null);
  });

  test('replacing a bot you already own does not count; replacing someone else\'s does', () => {
    t = loadApp({ MAX_BOTS_PER_USER: '2' });
    const mine = add('Mine', 7);
    add('Other', 7, 'two.example.com');
    const foreign = add('Foreign', 8);
    assert.equal(check(7).kind, 'user', 'a new bot is blocked');
    assert.equal(check(7, mine), null, 'same name/host/port as your own bot is a replacement');
    assert.equal(check(7, foreign).kind, 'user', 'a bot that belongs to another user is not yours to replace');
  });

  test('a user already over the limit keeps the bots and just cannot add', () => {
    t = loadApp();
    for (let i = 0; i < 8; i += 1) add(`O${i}`, 7);
    assert.equal(t.app.ownedBots(7, 1, 'u').length, 8);
    assert.equal(check(7).kind, 'user');
  });

  test('/status shows how close you are', () => {
    t = loadApp({ MAX_BOTS_PER_USER: '3', MAX_BOTS_TOTAL: '10' });
    add('A', 7); add('B', 7); add('C', 8);
    const view = t.app.statusView(7, 700, 'u');
    assert.match(view.legacy, /Bot limits: 2\/3 yours · 3\/10 in total/);
    assert.match(view.rich, /2\/3 yours · 3\/10 in total/);
    add('D', 7);
    assert.match(t.app.botLimitLine(7, 700, 'u'), /3\/3 yours \(full\)/);
  });
});
