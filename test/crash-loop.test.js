'use strict';
const { test, describe, beforeEach, afterEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { loadApp } = require('./helpers');

const NOW = Date.UTC(2026, 9, 3, 12, 0, 0);
const MIN = 60 * 1000;

describe('crash-loop guard for auto-resume', () => {
  let first;
  let second;
  beforeEach(() => mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: NOW }));
  afterEach(() => { second?.cleanup(); first?.cleanup(); mock.timers.reset(); second = null; first = null; });

  // a data dir with `n` bots that were running, and a left-over run marker listing earlier unclean starts
  const setup = (starts, env = {}) => {
    first = loadApp();
    for (const name of ['A', 'B']) first.addBot(name, { host: `${name.toLowerCase()}.example.com` });
    first.app.persistNow();
    fs.writeFileSync(path.join(first.dir, '.running'), JSON.stringify({ pid: 1, startedAt: NOW - MIN, noticeAt: 0, uncleanStarts: starts }));
    second = loadApp(env, first.dir);
    second.app.loadData();
    return second;
  };
  const boot = t => { const state = t.app.bootRunState(); const n = t.app.resumeBots(state); return { state, n }; };
  const markerStarts = t => JSON.parse(fs.readFileSync(path.join(t.dir, '.running'), 'utf8')).uncleanStarts;

  test('one unclean start is normal: bots resume', async () => {
    const t = setup([]);
    const { state, n } = boot(t);
    assert.equal(state.unclean, true);
    assert.equal(state.crashLoop, false);
    assert.equal(n, 2);
  });

  test('the third unclean start inside 10 minutes holds the resume; bots stay offline and say why', async () => {
    const t = setup([NOW - 8 * MIN, NOW - 4 * MIN]);
    const { state, n } = boot(t);
    assert.equal(state.crashLoop, true);
    assert.equal(state.uncleanStarts.length, 3);
    assert.equal(n, 0);
    mock.timers.tick(5000);
    await t.flush();
    assert.equal(t.created.length, 0);
    for (const info of t.app.mcBots.values()) {
      assert.match(info.error, /Auto-resume held: 3 unclean starts in 10 min/);
      assert.equal(info.resumePending, false);
      assert.equal(info.userStopped, true, 'the schedule loop must not start it either');
    }
  });

  test('held bots stay saved as running, so the next clean start brings them back', async () => {
    const t = setup([NOW - 8 * MIN, NOW - 4 * MIN]);
    boot(t);
    t.app.persistNow();
    const saved = JSON.parse(fs.readFileSync(path.join(t.dir, 'userdata.json'), 'utf8')).bots;
    assert.deepEqual(saved.map(b => b.paused), [false, false]);

    // fixed: stopped cleanly (marker deleted), started again
    t.app.stopAllBots();
    t.app.clearRunMarker();
    const third = loadApp({}, first.dir);
    third.app.loadData();
    const { state, n } = (() => { const s = third.app.bootRunState(); return { state: s, n: third.app.resumeBots(s) }; })();
    assert.equal(state.unclean, false);
    assert.equal(n, 2);
    third.cleanup();
  });

  test('starts older than the window do not count', () => {
    const t = setup([NOW - 40 * MIN, NOW - 25 * MIN, NOW - 11 * MIN]);
    const { state, n } = boot(t);
    assert.equal(state.uncleanStarts.length, 1);
    assert.equal(state.crashLoop, false);
    assert.equal(n, 2);
  });

  test('a clean stop resets the count (no marker -> no unclean starts)', () => {
    first = loadApp();
    first.addBot('A');
    first.app.persistNow();
    second = loadApp({}, first.dir);
    second.app.loadData();
    const state = second.app.bootRunState();
    assert.deepEqual(state.uncleanStarts, []);
    assert.equal(state.crashLoop, false);
  });

  test('the count is kept in the marker for the next start, also after the restart notice', () => {
    const t = setup([NOW - 4 * MIN]);
    const { state } = boot(t);
    assert.equal(markerStarts(t).length, 2);
    t.app.announceRestart(state);
    assert.equal(markerStarts(t).length, 2, 'announceRestart must not drop it');
  });

  test('RESUME_CRASH_LOOP_STARTS=0 never holds; a higher number needs more starts', () => {
    let t = setup([NOW - 8 * MIN, NOW - 4 * MIN, NOW - 2 * MIN], { RESUME_CRASH_LOOP_STARTS: '0' });
    assert.equal(boot(t).state.crashLoop, false);
    second.cleanup(); first.cleanup();
    t = setup([NOW - 8 * MIN, NOW - 4 * MIN], { RESUME_CRASH_LOOP_STARTS: '5' });
    assert.equal(boot(t).state.crashLoop, false);
  });

  test('the hold is announced once, at the start where it begins, even inside the notice gap; later starts stay quiet', () => {
    let t = setup([NOW - 8 * MIN, NOW - 4 * MIN]);
    fs.writeFileSync(path.join(t.dir, '.running'), JSON.stringify({ pid: 1, startedAt: NOW - MIN, noticeAt: NOW - 3 * MIN, uncleanStarts: [NOW - 8 * MIN, NOW - 4 * MIN] }));
    let state = t.app.bootRunState();
    t.app.resumeBots(state);
    assert.equal(t.app.announceRestart(state), 1);
    assert.match(t.sent.map(s => s.text).join('\n'), /Auto-resume is <b>held<\/b>|Auto-resume is held/);

    // the next crash (4th start, still inside the gap): no second message
    t.sent.length = 0;
    fs.writeFileSync(path.join(t.dir, '.running'), JSON.stringify({ pid: 2, startedAt: NOW, noticeAt: NOW - MIN, uncleanStarts: [NOW - 8 * MIN, NOW - 4 * MIN, NOW - 1 * MIN] }));
    state = t.app.bootRunState();
    assert.equal(state.uncleanStarts.length, 4);
    assert.equal(t.app.announceRestart(state), 0);
    assert.equal(t.sent.length, 0);
  });

  test('a corrupt marker still counts as one unclean start and does not throw', () => {
    first = loadApp();
    first.addBot('A');
    first.app.persistNow();
    fs.writeFileSync(path.join(first.dir, '.running'), '{not json');
    second = loadApp({}, first.dir);
    second.app.loadData();
    const state = second.app.bootRunState();
    assert.equal(state.unclean, true);
    assert.equal(state.uncleanStarts.length, 1);
  });
});
