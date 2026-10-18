'use strict';
const { test, describe, beforeEach, afterEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const { loadApp } = require('./helpers');

const MIN = 60 * 1000;

describe('idle view reduction (optional)', () => {
  let t;
  const realError = console.error;
  beforeEach(() => mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: Date.UTC(2026, 9, 3, 12, 0, 0) }));
  afterEach(() => {
    console.error = realError;
    t?.cleanup();
    mock.timers.reset();
  });

  // a connected bot that last moved `idleMin` minutes ago
  const connected = async (env, idleMin, extra = {}) => {
    t = loadApp(env);
    const info = t.addBot('A', extra);
    t.app.spawnBot(info);
    await t.flush();
    const mc = t.created[t.created.length - 1];
    mc.spawn();
    info.stuck = { pos: { x: 1, y: 64, z: 1 }, movedAt: Date.now() - idleMin * MIN, alerted: false };
    return { info, mc };
  };

  test('off by default: nothing is ever sent', async () => {
    const { info, mc } = await connected({}, 600);
    t.app.idleViewTick(info, mc);
    assert.equal(mc.settingsCalls.length, 0);
    assert.equal(t.app.IDLE_VIEW_DISTANCE, null);
  });

  test('a bot that stood still long enough shrinks once, and gets its normal view back when it moves', async () => {
    const { info, mc } = await connected({ MC_IDLE_VIEW_DISTANCE: '2' }, 31);
    t.app.idleViewTick(info, mc);
    assert.deepEqual(mc.settingsCalls, [{ viewDistance: 2 }]);
    t.app.idleViewTick(info, mc);
    assert.equal(mc.settingsCalls.length, 1, 'not repeated every tick');

    info.stuck.movedAt = Date.now() + 1000; // moved after it went idle
    t.app.idleViewTick(info, mc);
    assert.deepEqual(mc.settingsCalls[1], { viewDistance: 4 }, 'back to what this connection asked for');
    t.app.idleViewTick(info, mc);
    assert.equal(mc.settingsCalls.length, 2);
  });

  test('not before MC_IDLE_AFTER_MIN (default 30)', async () => {
    const { info, mc } = await connected({ MC_IDLE_VIEW_DISTANCE: '2' }, 29);
    t.app.idleViewTick(info, mc);
    assert.equal(mc.settingsCalls.length, 0);
    assert.equal(t.app.CFG.IDLE_VIEW_AFTER_MS, 30 * MIN);
  });

  test('MC_IDLE_AFTER_MIN changes the wait', async () => {
    const { info, mc } = await connected({ MC_IDLE_VIEW_DISTANCE: '2', MC_IDLE_AFTER_MIN: '5' }, 6);
    t.app.idleViewTick(info, mc);
    assert.equal(mc.settingsCalls.length, 1);
  });

  test('bots with a proximity alert, walking bots and already-small bots are left alone', async () => {
    let { info, mc } = await connected({ MC_IDLE_VIEW_DISTANCE: '2' }, 120, { settings: { proximityRadius: 32 } });
    t.app.idleViewTick(info, mc);
    assert.equal(mc.settingsCalls.length, 0, 'proximity');
    t.cleanup();

    ({ info, mc } = await connected({ MC_IDLE_VIEW_DISTANCE: '2' }, 120));
    info.walking = true;
    t.app.idleViewTick(info, mc);
    assert.equal(mc.settingsCalls.length, 0, 'walking');
    t.cleanup();

    ({ info, mc } = await connected({ MC_IDLE_VIEW_DISTANCE: '6' }, 120, { settings: { viewDistance: 3 } }));
    t.app.idleViewTick(info, mc);
    assert.equal(mc.settingsCalls.length, 0, 'normal view (3) is already below the idle value (6)');
  });

  test('a proximity alert switched on while idle restores the view', async () => {
    const { info, mc } = await connected({ MC_IDLE_VIEW_DISTANCE: '2' }, 40);
    t.app.idleViewTick(info, mc);
    info.settings.proximityRadius = 50;
    t.app.idleViewTick(info, mc);
    assert.deepEqual(mc.settingsCalls.map(c => c.viewDistance), [2, 4]);
  });

  test('a failing setSettings turns it off for that connection instead of retrying every tick', async () => {
    const { info, mc } = await connected({ MC_IDLE_VIEW_DISTANCE: '2' }, 40);
    let calls = 0;
    mc.setSettings = () => { calls += 1; throw new Error('not supported'); };
    t.app.idleViewTick(info, mc);
    t.app.idleViewTick(info, mc);
    assert.equal(calls, 1);
    assert.equal(info.idleView, null);
  });

  test('a client without setSettings is ignored', async () => {
    const { info, mc } = await connected({ MC_IDLE_VIEW_DISTANCE: '2' }, 40);
    delete mc.setSettings;
    mc.setSettings = undefined;
    assert.doesNotThrow(() => t.app.idleViewTick(info, mc));
  });

  test('invalid values keep it off with a warning', () => {
    const warnings = [];
    console.error = (...args) => warnings.push(args.join(' '));
    for (const bad of ['1', '99', 'abc', '2.5']) {
      t = loadApp({ MC_IDLE_VIEW_DISTANCE: bad });
      assert.equal(t.app.IDLE_VIEW_DISTANCE, null, bad);
      t.cleanup();
    }
    assert.equal(warnings.filter(line => /MC_IDLE_VIEW_DISTANCE/.test(line)).length, 4);
  });

  test('/status says when it is on', () => {
    t = loadApp({ MC_IDLE_VIEW_DISTANCE: '3' });
    t.addBot('A');
    assert.match(t.app.statusView(7, 700, 'u').legacy, /idle bots drop to 3 after 30 min/);
  });
});
