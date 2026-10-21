'use strict';
// Drives the real Telegram handlers (callback "add_bot", then the text with the bot details) to prove the limits hold there,
// not just in the helper.
const { test, describe, beforeEach, afterEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const { loadApp } = require('./helpers');

// Fixture hosts (mc.example.com, two.example.com, ...) don't exist, so a real DNS lookup
// is at the mercy of whatever network this runs on: some resolvers (notably several mobile
// carriers) answer an unknown name with a private/CGNAT address instead of NXDOMAIN, which
// checkHostAllowed then correctly refuses — failing these tests for a reason that has nothing
// to do with limits or ownership. Stub it to a known public address so they're deterministic
// regardless of network. (Same pattern as test/hosts.test.js.)
const stubPublicDns = app => { app.hostResolver.lookupAll = async () => ['93.184.216.34']; };

describe('adding a bot respects the limits', () => {
  let t;
  let answers;
  let replies;
  beforeEach(() => {
    mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: Date.UTC(2026, 9, 3, 12, 0, 0) });
    answers = [];
    replies = [];
  });
  afterEach(() => {
    t?.cleanup();
    mock.timers.reset();
  });

  const handler = filter => t.app.bot.handlers.find(([name]) => name === filter)[1];
  const base = { chat: { id: 700, type: 'private' }, from: { id: 7, username: 'u' } };
  const press = data => handler('callback_query:data')({
    ...base,
    callbackQuery: { data, message: { message_id: 5 } },
    answerCallbackQuery: async arg => { answers.push(arg.text); },
    editMessageText: async () => ({}),
  });
  const type = text => handler('message:text')({
    ...base,
    message: { text },
    reply: async (message, opts) => { replies.push(message); return { message_id: 9, opts }; },
  });
  const owned = () => t.app.ownedBots(7, 700, 'u');

  test('under the limit the bot is added', async () => {
    t = loadApp({ MAX_BOTS_PER_USER: '2' });
    stubPublicDns(t.app);
    await press('add_bot');
    await type('Steve mc.example.com 25565');
    assert.equal(owned().length, 1);
  });

  test('at the limit the Add button says so and does not ask for details', async () => {
    t = loadApp({ MAX_BOTS_PER_USER: '1' });
    stubPublicDns(t.app);
    t.addBot('One');
    await press('add_bot');
    assert.match(answers[0], /limit/i);
    await type('Steve mc.example.com 25565'); // no pending state: this is just chat, nothing is added
    assert.equal(owned().length, 1);
  });

  test('the text step checks again (limits can fill up between the button and the message)', async () => {
    t = loadApp({ MAX_BOTS_PER_USER: '2' });
    stubPublicDns(t.app);
    await press('add_bot');
    t.addBot('One');
    t.addBot('Two', { host: 'two.example.com' });
    await type('Steve mc.example.com 25565');
    assert.match(replies.join('\n'), /Bot limit reached/);
    assert.equal(owned().length, 2);
  });

  test('the global limit stops everyone, at the button and at the text step', async () => {
    t = loadApp({ MAX_BOTS_PER_USER: '0', MAX_BOTS_TOTAL: '1' });
    stubPublicDns(t.app);
    await press('add_bot'); // nobody has a bot yet: allowed
    t.addBot('Other', { userId: 99, chatId: 990 });
    await type('Steve mc.example.com 25565');
    assert.match(replies.join('\n'), /manager is full/);
    assert.equal(t.app.mcBots.size, 1);

    await press('add_bot'); // now the button itself says no
    assert.match(answers[answers.length - 1], /limit/i);
  });
});

describe('adding over someone else\'s bot', () => {
  let t;
  const replies = [];
  beforeEach(() => { replies.length = 0; });
  afterEach(() => t?.cleanup());

  test('the same name, host and port owned by another user is refused and left untouched', async () => {
    t = loadApp();
    stubPublicDns(t.app);
    const theirs = t.addBot('Steve', { host: 'mc.example.com', userId: 99, chatId: 990,
      settings: { aiPersona: 'secret persona', viewDistance: 9 } });
    theirs.autoReplies.push({ trigger: 'hi', response: 'hello', cooldownSec: 5, lastFiredAt: 0 });
    const handler = t.app.bot.handlers.find(([name]) => name === 'message:text')[1];
    t.app.chatStates.set(700, { action: 'awaiting_bot_info' });
    await handler({
      chat: { id: 700, type: 'private' }, from: { id: 7, username: 'u' }, message: { text: 'Steve mc.example.com 25565' },
      reply: async text => { replies.push(text); return { message_id: 1 }; },
    });
    assert.match(replies.join('\n'), /another user/);
    const kept = t.app.mcBots.get(theirs.id);
    assert.equal(kept, theirs, 'same record object');
    assert.equal(kept.userId, 99);
    assert.equal(kept.settings.aiPersona, 'secret persona');
    assert.equal(kept.autoReplies.length, 1);
    assert.equal(t.created.length, 0, 'nothing was started');
  });
});