'use strict';
const { test, describe, beforeEach, afterEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const { loadApp } = require('./helpers');

const at = (h, m = 0) => Date.UTC(2026, 9, 3, h, m, 0); // 2026-10-03 hh:mm UTC
const silent = message => message.opts.disable_notification === true;

describe('timezone and window maths', () => {
  const { app, cleanup } = loadApp();
  test('parseTz', () => {
    assert.deepEqual(app.parseTz('Asia/Baku'), { tz: 'Asia/Baku' });
    assert.deepEqual(app.parseTz('UTC+4'), { tz: 'UTC+04:00' });
    assert.deepEqual(app.parseTz('+5:30'), { tz: 'UTC+05:30' });
    assert.deepEqual(app.parseTz('gmt-3'), { tz: 'UTC-03:00' });
    assert.deepEqual(app.parseTz('server'), { tz: null });
    assert.equal(app.parseTz('UTC+15'), null);
    assert.equal(app.parseTz('UTC-13'), null);
    assert.equal(app.parseTz('Mars/Phobos'), null);
    assert.equal(app.parseTz('Baku'), null);
  });
  test('localParts follows the zone, DST included', () => {
    assert.deepEqual(app.localParts('UTC+04:00', at(22, 30)), { hour: 2, minute: 30 });
    assert.deepEqual(app.localParts('Asia/Baku', at(22, 30)), { hour: 2, minute: 30 });
    assert.deepEqual(app.localParts('UTC-05:30', at(3, 15)), { hour: 21, minute: 45 });
    // New York is UTC-4 in July and UTC-5 in January
    assert.equal(app.localParts('America/New_York', Date.UTC(2026, 6, 1, 12)).hour, 8);
    assert.equal(app.localParts('America/New_York', Date.UTC(2026, 0, 1, 12)).hour, 7);
    assert.equal(app.localParts('America/New_York', Date.UTC(2026, 0, 1, 5)).hour, 0); // midnight is 0, never 24
  });
  test('isQuietNow handles a window that wraps midnight and its edges', () => {
    app.quietPrefs.set('7', { on: true, start: 23, end: 7, tz: 'UTC+00:00' });
    assert.equal(app.isQuietNow(7, at(22, 59)), false);
    assert.equal(app.isQuietNow(7, at(23, 0)), true);
    assert.equal(app.isQuietNow(7, at(3, 0)), true);
    assert.equal(app.isQuietNow(7, at(6, 59)), true);
    assert.equal(app.isQuietNow(7, at(7, 0)), false);
    assert.equal(app.isQuietNow(7, at(12, 0)), false);
    app.quietPrefs.set('7', { on: true, start: 13, end: 15, tz: 'UTC+00:00' }); // same-day window
    assert.equal(app.isQuietNow(7, at(14, 0)), true);
    assert.equal(app.isQuietNow(7, at(15, 0)), false);
    app.quietPrefs.set('7', { on: false, start: 23, end: 7, tz: 'UTC+00:00' });
    assert.equal(app.isQuietNow(7, at(3, 0)), false, 'switched off');
    assert.equal(app.isQuietNow(8, at(3, 0)), false, 'a user with no settings');
    assert.equal(app.isQuietNow(null, at(3, 0)), false, 'legacy bot without an owner id');
    cleanup();
  });
});

describe('which alerts go silent', () => {
  const { app, cleanup } = loadApp();
  test('only the listed kinds, only inside the window; unknown kinds stay audible', () => {
    app.quietPrefs.set('7', { on: true, start: 23, end: 7, tz: 'UTC+00:00' });
    const info = { userId: 7 };
    mock.timers.enable({ apis: ['Date'], now: at(2) });
    try {
      for (const kind of ['connected', 'reconnecting', 'kicked', 'error', 'waiting', 'lobby', 'watch', 'digest', 'hint']) {
        assert.deepEqual(app.alertOpts(info, kind), { disable_notification: true }, kind);
      }
      for (const kind of ['ban', 'death', 'stuck', 'gaveup', 'health', 'proximity', 'something-new']) {
        assert.equal(app.alertOpts(info, kind), undefined, kind);
      }
      mock.timers.setTime(at(12));
      assert.equal(app.alertOpts(info, 'watch'), undefined, 'daytime');
    } finally {
      mock.timers.reset();
      cleanup();
    }
  });
});

describe('real alert paths', () => {
  let t;
  beforeEach(() => {
    t = loadApp();
    t.app.quietPrefs.set('7', { on: true, start: 23, end: 7, tz: 'UTC+00:00' });
    mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: at(2) }); // 02:00 = quiet
  });
  afterEach(() => {
    t.cleanup();
    mock.timers.reset();
  });

  const online = async info => {
    t.app.spawnBot(info);
    await t.flush();
    const mc = t.created[t.created.length - 1];
    mc.spawn();
    return mc;
  };

  test('connected is silent, death is audible, ban is audible', async () => {
    const info = t.addBot('A');
    const mc = await online(info);
    mock.timers.tick(t.app.CFG.LOBBY_CHECK_MS);
    await t.flush();
    const connected = t.sent.find(m => /connected to/.test(m.text));
    assert.ok(connected, 'connected alert was sent');
    assert.ok(silent(connected), 'silent at 02:00');
    assert.equal(connected.via, 'rich', 'the rich path carries the flag too');

    t.sent.length = 0;
    mc.emit('death');
    mock.timers.tick(t.app.CFG.DEATH_ALERT_DELAY_MS + 10);
    await t.flush();
    const death = t.sent.find(m => /died/.test(m.text));
    assert.ok(death && !silent(death), 'a death always makes a sound');

    t.sent.length = 0;
    mc.emit('kicked', 'You are banned from this server');
    await t.flush();
    const ban = t.sent.find(m => /banned/.test(m.text));
    assert.ok(ban && !silent(ban), 'a ban always makes a sound');
  });

  test('reconnecting and watchlist are silent, gave-up is audible', async () => {
    const info = t.addBot('A');
    const mc = await online(info);
    mock.timers.tick(t.app.CFG.LOBBY_CHECK_MS);
    t.sent.length = 0;

    mc.emit('kicked', 'Flying is not enabled on this server');
    const kicked = t.sent.find(m => /was kicked/.test(m.text));
    const reconnecting = t.sent.find(m => /reconnecting in/.test(m.text));
    assert.ok(kicked && silent(kicked));
    assert.ok(reconnecting && silent(reconnecting));

    t.sent.length = 0;
    info.reconnectAttempts = t.app.CFG.MAX_RECONNECTS;
    t.app.scheduleReconnect(info);
    const gaveUp = t.sent.find(m => /gave up/.test(m.text));
    assert.ok(gaveUp && !silent(gaveUp));

    // watchlist
    t.sent.length = 0;
    t.app.watchlists.set('7', ['Notch']);
    info.connectedAt = Date.now() - 60_000;
    t.app.watchEvent(info, 'Notch', 'join');
    const watch = t.sent.find(m => /Notch/.test(m.text));
    assert.ok(watch && silent(watch));
  });

  test('outside the window nothing is silenced', async () => {
    mock.timers.setTime(at(12));
    const info = t.addBot('A');
    await online(info);
    mock.timers.tick(t.app.CFG.LOBBY_CHECK_MS);
    const connected = t.sent.find(m => /connected to/.test(m.text));
    assert.ok(connected && !silent(connected));
  });

  test('the hourly digest is silent, the preview you ask for is not', async () => {
    const info = t.addBot('A');
    info.status = 'offline';
    await t.app.sendDigest(700, 7);
    await t.app.sendDigest(700, 7, { preview: true });
    const [hourly, preview] = t.sent.filter(m => /digest/i.test(m.text));
    assert.ok(hourly && silent(hourly));
    assert.ok(preview && !silent(preview));
  });
});

describe('/quiet command and persistence', () => {
  test('parsing, validation and a restart round trip', async () => {
    const first = loadApp();
    const { app } = first;
    const run = async text => {
      first.sent.length = 0;
      await app.bot.commands.get('quiet')({ from: { id: 7 }, chat: { id: 7 }, message: { text } });
      return first.sent.map(m => m.text).join('\n');
    };

    await run('/quiet 23-7');
    assert.deepEqual(app.quietPrefs.get('7'), { on: true, start: 23, end: 7, tz: null });
    await run('/quiet 22:00-06:00');
    assert.equal(app.quietPrefs.get('7').start, 22);
    assert.equal(app.quietPrefs.get('7').end, 6);
    await run('/quiet 1 5');
    assert.equal(app.quietPrefs.get('7').start, 1);
    await run('/quiet 23-7');

    assert.match(await run('/quiet 5-5'), /must differ/);
    assert.match(await run('/quiet 25-7'), /0 to 23/);
    assert.match(await run('/quiet 22:30-6'), /whole hours/);
    assert.match(await run('/quiet banana'), /did not understand/);
    assert.match(await run('/quiet tz Mars/Phobos'), /Unknown timezone/);
    assert.equal(app.quietPrefs.get('7').start, 23, 'bad input changes nothing');

    await run('/quiet tz Asia/Baku');
    assert.equal(app.quietPrefs.get('7').tz, 'Asia/Baku');
    assert.match(await run('/quiet'), /Asia\/Baku/);

    app.persistNow();

    const second = loadApp({}, first.dir);
    second.app.loadData();
    assert.deepEqual(second.app.quietPrefs.get('7'), { on: true, start: 23, end: 7, tz: 'Asia/Baku' });

    await second.app.bot.commands.get('quiet')({ from: { id: 7 }, chat: { id: 7 }, message: { text: '/quiet off' } });
    assert.equal(second.app.quietPrefs.get('7').on, false);
    second.cleanup();
    first.cleanup(); // owns (and removes) the shared data directory
  });

  test('a corrupt saved entry cannot mute everything', () => {
    const t = loadApp();
    require('fs').writeFileSync(t.app.DATA, JSON.stringify({ meta: { version: 5 }, bots: [], quiet: {
      7: { on: true, start: 5, end: 5, tz: 'UTC+00:00' },
      8: { on: true, start: 99, end: -1, tz: 'nope' },
      abc: { on: true, start: 1, end: 2 },
    } }));
    t.app.loadData();
    assert.equal(t.app.isQuietNow(7, at(5)), false);
    assert.equal(t.app.quietPrefs.get('7').on, false);
    assert.equal(t.app.quietPrefs.get('8').on, false);
    assert.equal(t.app.quietPrefs.get('8').tz, null);
    assert.equal(t.app.quietPrefs.has('abc'), false);
    t.cleanup();
  });
});
