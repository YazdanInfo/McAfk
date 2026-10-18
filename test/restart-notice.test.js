'use strict';
const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const { loadApp } = require('./helpers');

describe('unclean restart notice', () => {
  let t;
  beforeEach(() => { t = loadApp(); });
  afterEach(() => t.cleanup());

  test('first run and clean stops are silent; the marker is (re)created', () => {
    const state = t.app.bootRunState();
    assert.equal(state.unclean, false);
    assert.ok(fs.existsSync(t.app.RUN_MARKER));
    t.addBot('A');
    assert.equal(t.app.announceRestart(state), 0);
    assert.equal(t.sent.length, 0);

    t.app.clearRunMarker(); // what a clean shutdown does
    assert.equal(fs.existsSync(t.app.RUN_MARKER), false);
    assert.equal(t.app.bootRunState().unclean, false, 'next start sees a clean stop');
  });

  test('a left-over marker means unclean: each owner is told once, audibly, with the last sign of life', () => {
    fs.writeFileSync(t.app.RUN_MARKER, JSON.stringify({ pid: 1, startedAt: Date.UTC(2026, 9, 3, 1, 0, 0) }));
    fs.writeFileSync(t.app.HEALTH_FILE, '1');
    const seen = Date.UTC(2026, 9, 3, 3, 30, 0);
    fs.utimesSync(t.app.HEALTH_FILE, seen / 1000, seen / 1000);

    const state = t.app.bootRunState();
    assert.equal(state.unclean, true);
    assert.equal(state.lastAlive, seen, 'the health file is newer than the marker');
    assert.equal(fs.existsSync(t.app.HEALTH_FILE), false, 'a stale health file is removed');

    t.addBot('A');
    t.addBot('B'); // same owner, second bot: still one message
    t.addBot('C', { userId: 8, chatId: 800 });
    t.addBot('D', { userId: null, chatId: 900 }); // legacy bot without an owner id: nobody to tell
    assert.equal(t.app.announceRestart(state), 2);
    assert.equal(t.sent.length, 2);
    assert.deepEqual(t.sent.map(m => m.chatId).sort(), [700, 800]);
    for (const message of t.sent) {
      assert.match(message.text, /unclean stop/);
      assert.equal(message.opts.disable_notification, undefined, 'never silenced');
    }
    assert.match(t.sent.find(m => m.chatId === 700).text, /<b>2<\/b> bot\(s\)/);
  });

  test('quiet hours do not silence it', () => {
    t.app.quietPrefs.set('7', { on: true, start: 0, end: 23, tz: 'UTC+00:00' });
    fs.writeFileSync(t.app.RUN_MARKER, '{}');
    t.addBot('A');
    t.app.announceRestart(t.app.bootRunState());
    assert.equal(t.sent[0].opts.disable_notification, undefined);
  });

  test('a crash loop sends one notice, not one per restart', () => {
    fs.writeFileSync(t.app.RUN_MARKER, '{}');
    t.addBot('A');
    assert.equal(t.app.announceRestart(t.app.bootRunState()), 1);
    // crash again right away: the marker (now carrying noticeAt) is left behind
    const second = t.app.bootRunState();
    assert.equal(second.unclean, true);
    assert.equal(t.app.announceRestart(second), 0, 'inside the minimum gap');
    assert.equal(t.sent.length, 1);

    // much later
    fs.writeFileSync(t.app.RUN_MARKER, JSON.stringify({ noticeAt: Date.now() - t.app.CFG.RESTART_NOTICE_MIN_GAP_MS - 1 }));
    assert.equal(t.app.announceRestart(t.app.bootRunState()), 1);
  });

  test('a corrupt marker still counts as unclean', () => {
    fs.writeFileSync(t.app.RUN_MARKER, '{not json');
    assert.equal(t.app.bootRunState().unclean, true);
  });
});

describe('health file', () => {
  let t;
  afterEach(() => t?.cleanup());

  test('touched while Telegram answers, even without HEARTBEAT_URL; untouched when it does not', async () => {
    t = loadApp();
    assert.equal(fs.existsSync(t.app.HEALTH_FILE), false);
    await t.app.heartbeatTick();
    assert.equal(fs.existsSync(t.app.HEALTH_FILE), false, 'Telegram never answered');

    t.app.setLastTelegramOkAt(Date.now());
    await t.app.heartbeatTick();
    assert.equal(fs.existsSync(t.app.HEALTH_FILE), true);
    fs.unlinkSync(t.app.HEALTH_FILE);

    t.app.setLastTelegramOkAt(Date.now() - t.app.CFG.HEARTBEAT_TG_STALE_MS - 1000);
    await t.app.heartbeatTick();
    assert.equal(fs.existsSync(t.app.HEALTH_FILE), false, 'Telegram went quiet');
  });
});
