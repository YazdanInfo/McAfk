'use strict';
// Runs the real access middleware (not just isUserAllowed) the way grammY would.
const { test, describe, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { loadApp } = require('./helpers');

describe('access middleware', () => {
  let t;
  const realLog = console.log;
  afterEach(() => { console.log = realLog; t?.cleanup(); });

  const run = async (ctx) => {
    const calls = { next: 0, replies: [], answers: [] };
    const full = {
      ...ctx,
      reply: async text => { calls.replies.push(text); },
      answerCallbackQuery: async arg => { calls.answers.push(arg); },
    };
    await t.app.bot.middlewares[0](full, async () => { calls.next += 1; });
    return calls;
  };
  const priv = (id, extra = {}) => ({ from: { id, username: 'x' }, chat: { id, type: 'private' }, message: { text: 'hi' }, ...extra });

  test('closed: a stranger gets one reply with their own ID and never reaches the handlers', async () => {
    console.log = () => {};
    t = loadApp();
    const first = await run(priv(555));
    assert.equal(first.next, 0);
    assert.equal(first.replies.length, 1);
    assert.match(first.replies[0], /Your Telegram ID: 555/);
    assert.match(first.replies[0], /ALLOWED_USER_IDS/);
    const again = await run(priv(555));
    assert.equal(again.replies.length, 0, 'answered at most once an hour');
  });

  test('closed: buttons are refused, groups are ignored silently', async () => {
    console.log = () => {};
    t = loadApp();
    const button = await run({ from: { id: 9 }, chat: { id: 9, type: 'private' }, callbackQuery: { data: 'add_bot' } });
    assert.equal(button.next, 0);
    assert.match(button.answers[0].text, /private/);
    const group = await run({ from: { id: 10 }, chat: { id: -100, type: 'supergroup' }, message: { text: 'x' } });
    assert.equal(group.next, 0);
    assert.equal(group.replies.length, 0);
  });

  test('restricted: the ID in the allowlist passes, others get the plain private notice (no ID shown)', async () => {
    console.log = () => {};
    t = loadApp({ ALLOWED_USER_IDS: '7' });
    assert.equal((await run(priv(7))).next, 1);
    const other = await run(priv(8));
    assert.equal(other.next, 0);
    assert.equal(other.replies[0], '⛔ This bot is private.');
  });

  test('open (ALLOW_OPEN_ACCESS=1): everyone passes', async () => {
    t = loadApp({ ALLOW_OPEN_ACCESS: '1' });
    assert.equal((await run(priv(123))).next, 1);
  });
});
