'use strict';
const { test, describe, beforeEach, afterEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { loadApp } = require('./helpers');

const saved = t => JSON.parse(fs.readFileSync(path.join(t.dir, 'userdata.json'), 'utf8')).bots;

describe('auto-resume after a restart', () => {
  let first;
  let second;
  beforeEach(() => {
    first = loadApp();
    mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: Date.UTC(2026, 9, 3, 12, 0, 0) });
  });
  afterEach(() => {
    second?.cleanup();
    first.cleanup();
    mock.timers.reset();
    second = null;
  });

  // a second "process" on the same data directory
  const restart = (env = {}) => {
    second = loadApp(env, first.dir);
    second.app.loadData();
    return second;
  };

  test('a clean stop remembers who was running; only those come back', async () => {
    const running = first.addBot('Running');
    const stopped = first.addBot('Stopped');
    stopped.autoReconnect = false; // the user pressed Disconnect
    first.app.stopAllBots(); // what SIGTERM does
    first.app.persistNow();
    assert.deepEqual(saved(first).map(b => [b.name, b.paused]), [['Running', false], ['Stopped', true]]);
    void running;

    const t = restart();
    assert.equal(t.app.resumeBots(), 1);
    mock.timers.tick(0);
    await t.flush();
    assert.deepEqual(t.created.map(mc => mc.username), ['Running']);
    assert.equal(t.app.mcBots.get(running.id).autoReconnect, true);
    assert.equal([...t.app.mcBots.values()].find(b => b.name === 'Stopped').status, 'offline');
  });

  test('a crash (no clean stop) resumes from the last save', async () => {
    first.addBot('A');
    first.app.persistNow(); // the debounced save that happened while it was running; no stopAllBots(), like kill -9
    const t = restart();
    assert.equal(t.app.resumeBots(), 1);
    mock.timers.tick(0);
    await t.flush();
    assert.equal(t.created.length, 1);
  });

  test('files from before v15 (every bot saved as paused) stay paused once', () => {
    first.addBot('A');
    first.app.persistNow();
    const file = path.join(first.dir, 'userdata.json');
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    for (const record of data.bots) { record.paused = true; }
    fs.writeFileSync(file, JSON.stringify(data));
    const t = restart();
    assert.equal(t.app.resumeBots(), 0);
  });

  test('AUTO_RESUME=0 keeps the old behaviour', () => {
    first.addBot('A');
    first.app.persistNow();
    const t = restart({ AUTO_RESUME: '0' });
    assert.equal(t.app.resumeBots(), 0);
  });

  test('starts are spread out, and the join queue spaces the logins on top', async () => {
    for (const name of ['A', 'B', 'C']) first.addBot(name);
    first.app.persistNow();
    const t = restart({ RESUME_SPREAD_MS: '300' });
    assert.equal(t.app.resumeBots(), 3);
    const spread = t.app.CFG.RESUME_SPREAD_MS;
    const gap = t.app.CFG.JOIN_GAP_MS;
    assert.equal(spread, 300);

    mock.timers.tick(0);
    await t.flush();
    assert.equal(t.created.length, 1, 'only the first has started');
    mock.timers.tick(spread);
    await t.flush();
    assert.equal(t.created.length, 1, 'second is started but queued behind the first (same server)');
    mock.timers.tick(gap);
    await t.flush();
    assert.equal(t.created.length, 2);
    mock.timers.tick(gap);
    await t.flush();
    assert.deepEqual(t.created.map(mc => mc.username), ['A', 'B', 'C']);
  });

  test('a save while bots wait for their turn does not record them as paused', () => {
    first.addBot('A');
    first.addBot('B');
    first.app.persistNow();
    const t = restart();
    t.app.resumeBots();
    t.app.persistNow(); // before any resume timer has fired
    assert.deepEqual(saved(t).map(b => b.paused), [false, false]);
  });

  test('Disconnect before its turn cancels the resume', async () => {
    first.addBot('A');
    first.app.persistNow();
    const t = restart();
    t.app.resumeBots();
    const info = [...t.app.mcBots.values()][0];
    info.resumePending = false; // what the Disconnect button does
    mock.timers.tick(1000);
    await t.flush();
    assert.equal(t.created.length, 0);
  });

  test('a scheduled bot outside its window is not started', async () => {
    const hour = new Date().getHours();
    first.addBot('Night', { settings: { schedule: { start: (hour + 2) % 24, end: (hour + 3) % 24 } } });
    first.addBot('Day', { host: 'other.example.com', settings: { schedule: { start: hour, end: (hour + 1) % 24 } } });
    first.app.persistNow();
    const t = restart();
    t.app.resumeBots();
    mock.timers.tick(1000);
    await t.flush();
    assert.deepEqual(t.created.map(mc => mc.username), ['Day']);
  });

  test('the unclean-restart notice says which bots are reconnecting', () => {
    first.addBot('A');
    first.addBot('B');
    first.addBot('C');
    first.app.persistNow();
    const data = JSON.parse(fs.readFileSync(path.join(first.dir, 'userdata.json'), 'utf8'));
    data.bots[2].paused = true;
    fs.writeFileSync(path.join(first.dir, 'userdata.json'), JSON.stringify(data));
    const t = restart();
    fs.writeFileSync(t.app.RUN_MARKER, '{}');
    t.app.resumeBots();
    t.app.announceRestart(t.app.bootRunState());
    const text = t.sent[0].text;
    assert.match(text, /<b>3<\/b> bot\(s\)/);
    assert.match(text, /<b>2<\/b> of them are reconnecting by themselves/);
    assert.match(text, /The rest stay paused/);
  });
});
