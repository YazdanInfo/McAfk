'use strict';
const { test, describe, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { loadApp } = require('./helpers');

describe('view distance', () => {
  let t;
  const realError = console.error;
  afterEach(() => {
    console.error = realError;
    t?.cleanup();
  });

  const joinOptions = async (info) => {
    t.app.spawnBot(info);
    await t.flush();
    return t.created[t.created.length - 1].options;
  };

  test('default: every bot asks the server for a small world', async () => {
    t = loadApp();
    assert.equal(t.app.VIEW_DISTANCE, 4);
    const info = t.addBot('A');
    const options = await joinOptions(info);
    assert.equal(options.viewDistance, 4);
    assert.equal(info.viewDistance, 4);
  });

  test('MC_VIEW_DISTANCE overrides it; "default" leaves it to mineflayer', async () => {
    t = loadApp({ MC_VIEW_DISTANCE: '8' });
    assert.equal((await joinOptions(t.addBot('A'))).viewDistance, 8);
    t.cleanup();

    t = loadApp({ MC_VIEW_DISTANCE: 'default' });
    const options = await joinOptions(t.addBot('B'));
    assert.equal('viewDistance' in options, false, 'the option is not passed at all');
  });

  test('invalid values fall back to the default with a warning', () => {
    const warnings = [];
    console.error = (...args) => warnings.push(args.join(' '));
    for (const bad of ['1', '99', 'abc', '3.5', '-4']) {
      t = loadApp({ MC_VIEW_DISTANCE: bad });
      assert.equal(t.app.VIEW_DISTANCE, 4, bad);
      t.cleanup();
    }
    assert.equal(warnings.filter(line => /MC_VIEW_DISTANCE/.test(line)).length, 5);
  });

  test('a proximity alert raises it for that bot only, because the server tracks entities inside the view distance', async () => {
    t = loadApp();
    const plain = t.addBot('Plain');
    const watcher = t.addBot('Watcher', { host: 'other.example.com', settings: { proximityRadius: 100 } });
    assert.equal(t.app.viewDistanceFor(plain), 4);
    assert.equal(t.app.viewDistanceFor(watcher), 8, 'ceil(100 / 16) + 1');
    assert.equal((await joinOptions(watcher)).viewDistance, 8);
    assert.equal((await joinOptions(plain)).viewDistance, 4);

    const at = radius => t.app.viewDistanceFor({ settings: { proximityRadius: radius } });
    assert.equal(at(1), 4);
    assert.equal(at(48), 4, '48 m needs 4 chunks, already covered');
    assert.equal(at(64), 5);
    assert.equal(at(256), 17);
  });

  test('capped at 32 chunks, and "default" mode never invents a value', () => {
    t = loadApp({ MC_VIEW_DISTANCE: '32' });
    assert.equal(t.app.viewDistanceFor({ settings: { proximityRadius: 256 } }), 32);
    t.cleanup();
    t = loadApp({ MC_VIEW_DISTANCE: 'default' });
    assert.equal(t.app.viewDistanceFor({ settings: { proximityRadius: 256 } }), null);
  });

  test('/status says what is in effect', () => {
    t = loadApp();
    assert.match(t.app.statusView(7, 7, 'x').legacy, /View distance: 4 chunks/);
    t.cleanup();
    t = loadApp({ MC_VIEW_DISTANCE: 'default' });
    assert.match(t.app.statusView(7, 7, 'x').legacy, /View distance: mineflayer default/);
  });
});

describe('per-bot view distance', () => {
  let t;
  afterEach(() => t?.cleanup());

  test('a bot override wins over the manager value, including "default"', () => {
    t = loadApp({ MC_VIEW_DISTANCE: '4' });
    assert.equal(t.app.viewDistanceFor(t.addBot('Far', { settings: { viewDistance: 12 } })), 12);
    assert.equal(t.app.viewDistanceFor(t.addBot('Near', { host: 'b.example.com', settings: { viewDistance: 2 } })), 2);
    t.cleanup();

    t = loadApp({ MC_VIEW_DISTANCE: 'default' });
    assert.equal(t.app.viewDistanceFor(t.addBot('Own', { settings: { viewDistance: 6 } })), 6);
    assert.equal(t.app.viewDistanceFor(t.addBot('Plain', { host: 'b.example.com' })), null, 'no override: still mineflayer default');
  });

  test('a proximity alert still raises an override that is too small', () => {
    t = loadApp();
    assert.equal(t.app.viewDistanceFor(t.addBot('A', { settings: { viewDistance: 2, proximityRadius: 100 } })), 8);
  });

  test('it is sent when the bot joins and survives a save and restart', async () => {
    t = loadApp();
    const info = t.addBot('A', { settings: { viewDistance: 10 } });
    t.app.spawnBot(info);
    await t.flush();
    assert.equal(t.created[0].options.viewDistance, 10);
    t.app.persistNow();

    const second = loadApp({}, t.dir);
    second.app.loadData();
    assert.equal([...second.app.mcBots.values()][0].settings.viewDistance, 10);
    second.cleanup();
  });

  test('settings with nonsense values fall back to "follow the manager"', () => {
    t = loadApp();
    for (const bad of [1, 99, 'abc', 3.5, -4, 0, '']) {
      assert.equal(t.app.makePausedBot({ name: 'A', host: 'h', port: 1, settings: { viewDistance: bad } }).settings.viewDistance, null, String(bad));
    }
    assert.equal(t.app.makePausedBot({ name: 'A', host: 'h', port: 1, settings: { viewDistance: 7 } }).settings.viewDistance, 7);
  });

  test('parseViewInput', () => {
    t = loadApp();
    const parse = t.app.parseViewInput;
    assert.deepEqual(parse('8'), { ok: true, value: 8 });
    assert.deepEqual(parse(' 32 '), { ok: true, value: 32 });
    for (const off of ['off', 'default', 'auto', '0', 'OFF']) assert.deepEqual(parse(off), { ok: true, value: null }, off);
    for (const bad of ['1', '33', 'x', '4.5', '-3', '']) assert.deepEqual(parse(bad), { ok: false }, bad);
  });

  test('the settings screen shows it', () => {
    t = loadApp();
    assert.match(t.app.settingsText(t.addBot('A', { settings: { viewDistance: 9 } })), /View distance \(9 chunks\)/);
    assert.match(t.app.settingsText(t.addBot('B', { host: 'b.example.com' })), /View distance \(default\)/);
  });
});

describe('proximity change message', () => {
  let t;
  afterEach(() => t?.cleanup());
  test('a bot on the mineflayer default (no explicit chunk count) is never told it "joined seeing null chunks"', async () => {
    t = loadApp({ MC_VIEW_DISTANCE: 'default' });
    const info = t.addBot('A', { settings: { viewDistance: 6 } });
    info.status = 'online';
    info.viewDistance = null;
    t.app.bot.sent.length = 0;
    const handler = t.app.bot.handlers.find(([name]) => name === 'message:text')[1];
    const replies = [];
    t.app.chatStates.set(700, { action: 'awaiting_value', botId: info.id, field: 'proximity', userId: 7 });
    await handler({ chat: { id: 700, type: 'private' }, from: { id: 7, username: 'u' }, message: { text: '100' },
      reply: async text => { replies.push(text); return { message_id: 1 }; } });
    assert.equal(replies.filter(text => /seeing/.test(text)).length, 0);
    assert.equal(info.settings.proximityRadius, 100);
  });
});
