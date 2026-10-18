'use strict';
// /status "Load" row: CPU share of the single Node thread and event-loop lag, and the one-time "saturated" log lines.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadApp } = require('./helpers');

const withStubbedCpu = fn => {
  const real = process.cpuUsage;
  const state = { user: real.call(process).user };
  process.cpuUsage = () => ({ user: state.user, system: 0 });
  return Promise.resolve(fn(state)).finally(() => { process.cpuUsage = real; });
};

const captureConsole = () => {
  const logs = [];
  const real = { log: console.log, error: console.error };
  console.log = (...a) => logs.push(['log', a.join(' ')]);
  console.error = (...a) => logs.push(['error', a.join(' ')]);
  return { logs, restore: () => { console.log = real.log; console.error = real.error; } };
};

test('/status has a Load row, "measuring" until the first sample', () => {
  const t = loadApp();
  try {
    assert.match(t.app.loadLine(), /^measuring/);
    const view = t.app.statusView(7, 700, 'u');
    assert.match(view.legacy, /📈 measuring/);
    assert.match(view.rich, /Load/);
  } finally { t.cleanup(); }
});

test('CPU share is busy time over wall time, in % of one core', async () => {
  const t = loadApp();
  try {
    await withStubbedCpu(state => {
      const T = Date.now();
      t.app.loadSample(T);                 // sync the baseline with the stub
      state.user += 400 * 1000;            // 400 ms of CPU ...
      const load = t.app.loadSample(T + 1000); // ... in 1000 ms of wall time
      assert.equal(load.cpuPct, 40);
      assert.match(t.app.loadLine(), /CPU 40% of one core/);
      assert.doesNotMatch(t.app.loadLine(), /one core is the limit/);
    });
  } finally { t.cleanup(); }
});

test('saturation needs LOAD_WARN_SAMPLES in a row, logs once, and recovery logs once', async () => {
  const t = loadApp();
  const cap = captureConsole();
  try {
    await withStubbedCpu(state => {
      let now = Date.now();
      t.app.loadSample(now);
      const step = busyMs => { state.user += busyMs * 1000; now += 1000; return t.app.loadSample(now); };
      assert.equal(step(950).saturated, false);   // 1st high sample
      assert.equal(step(950).saturated, false);   // 2nd
      assert.equal(step(100).hot, 0);             // a calm sample resets the streak
      step(950); step(950);
      assert.equal(step(950).saturated, true);    // 3rd in a row
      step(990); step(990);                       // stays saturated: no second warning
      assert.equal(cap.logs.filter(([k, m]) => k === 'error' && /one core is the limit/i.test(m)).length, 1);
      assert.match(t.app.loadLine(), /one core is the limit/);
      assert.equal(step(100).saturated, false);
      assert.equal(cap.logs.filter(([k, m]) => k === 'log' && /Load back to normal/.test(m)).length, 1);
    });
  } finally { cap.restore(); t.cleanup(); }
});

test('a blocked event loop shows up as lag', async () => {
  const t = loadApp();
  try {
    t.app.loadSample();                          // clear whatever start-up recorded
    await new Promise(resolve => setTimeout(resolve, 60));
    const end = Date.now() + 400; while (Date.now() < end) { /* block the loop */ }
    await new Promise(resolve => setTimeout(resolve, 100));
    const load = t.app.loadSample();
    assert.ok(load.lagMax >= 300, `lagMax was ${load.lagMax}`);
  } finally { t.cleanup(); }
});

test('an idle loop reads ~0 ms of lag, not the histogram timer period', async () => {
  const t = loadApp();
  try {
    t.app.loadSample();
    await new Promise(resolve => setTimeout(resolve, 200)); // a few histogram ticks, nothing blocking
    const load = t.app.loadSample();
    assert.ok(load.lagP99 !== null && load.lagP99 < 20, `idle lagP99 was ${load.lagP99}`);
  } finally { t.cleanup(); }
});

// ---- Telegram notice when saturated ----------------------------------------------------------------------------------------
const saturate = (t, state, clock) => {
  const step = busyMs => { state.user += busyMs * 1000; clock.now += 1000; return t.app.loadSample(clock.now); };
  step(950); step(950); step(950);
};
const calm = (t, state, clock, jumpMs = 1000) => { clock.now += jumpMs; return t.app.loadSample(clock.now); };

test('saturation messages each owner once, in the chat of their first bot', async () => {
  const t = loadApp();
  const cap = captureConsole();
  try {
    await withStubbedCpu(state => {
      const clock = { now: Date.now() };
      t.addBot('A'); t.addBot('B'); // same owner: one message
      t.addBot('C', { userId: 8, chatId: 800 });
      t.addBot('D', { userId: null, chatId: 900 }); // no owner id: nobody to tell
      t.app.mcBots.get([...t.app.mcBots.keys()][0]).status = 'online';
      t.app.loadSample(clock.now);
      saturate(t, state, clock);
      assert.deepEqual(t.sent.map(m => m.chatId).sort(), [700, 800]);
      for (const m of t.sent) {
        assert.match(m.text, /CPU limit/);
        assert.match(m.text, /95%/);
        assert.equal(m.opts.disable_notification, undefined, 'audible outside quiet hours');
      }
      assert.match(t.sent[0].text, /1<\/b> bot\(s\) online|1 bot\(s\) online/);
    });
  } finally { cap.restore(); t.cleanup(); }
});

test('one notice per spell, and at most one per LOAD_NOTICE_MIN_GAP_MS even if the load flaps', async () => {
  const t = loadApp();
  const cap = captureConsole();
  try {
    await withStubbedCpu(state => {
      const clock = { now: Date.now() };
      t.addBot('A');
      t.app.loadSample(clock.now);
      saturate(t, state, clock);
      assert.equal(t.sent.length, 1);
      state.user += 990 * 1000; clock.now += 1000; t.app.loadSample(clock.now); // still saturated: nothing more
      assert.equal(t.sent.length, 1);
      calm(t, state, clock, 10 * 60 * 1000);                                      // recovers, 10 min later ...
      saturate(t, state, clock);                                                  // ... saturated again: inside the gap
      assert.equal(t.sent.length, 1, 'no second notice inside the gap');
      calm(t, state, clock, 45 * 60 * 1000);
      saturate(t, state, clock);
      assert.equal(t.sent.length, 2, 'a new spell after the gap is announced');
    });
  } finally { cap.restore(); t.cleanup(); }
});

test('with nobody to tell, no notice is sent and the gap is not consumed', async () => {
  const t = loadApp();
  const cap = captureConsole();
  try {
    await withStubbedCpu(state => {
      const clock = { now: Date.now() };
      t.app.loadSample(clock.now);
      saturate(t, state, clock);
      assert.equal(t.sent.length, 0);
      assert.equal(t.app.announceLoad(clock.now), 0);
      t.addBot('A');
      assert.equal(t.app.announceLoad(clock.now), 1, 'the first owner to appear is told right away');
    });
  } finally { cap.restore(); t.cleanup(); }
});

test('the notice is silent in the owner\'s quiet hours', async () => {
  const t = loadApp();
  const cap = captureConsole();
  try {
    await withStubbedCpu(state => {
      const hour = new Date().getUTCHours();
      t.app.quietPrefs.set('7', { on: true, start: hour, end: (hour + 1) % 24, tz: 'UTC+00:00' });
      const clock = { now: Date.now() };
      t.addBot('A');
      t.app.loadSample(clock.now);
      saturate(t, state, clock);
      assert.equal(t.sent.length, 1);
      assert.equal(t.sent[0].opts.disable_notification, true);
    });
  } finally { cap.restore(); t.cleanup(); }
});

// ---- RAM per online bot ----------------------------------------------------------------------------------------------------
test('/status shows RSS per online bot, manager-wide, and nothing when no bot is online', () => {
  const t = loadApp();
  try {
    t.addBot('A'); t.addBot('B'); t.addBot('C', { userId: 8, chatId: 800 });
    assert.doesNotMatch(t.app.statusView(7, 700, 'u').legacy, /per online bot/);
    const bots = [...t.app.mcBots.values()];
    bots[0].status = 'online'; bots[2].status = 'online'; // one of mine, one of someone else's
    const mem = { rss: 400 * 1048576, heapUsed: 100 * 1048576 };
    assert.equal(t.app.memLine(mem), '400 MB RSS · 100 MB heap · ≈200 MB per online bot (2 online)');
    assert.match(t.app.statusView(7, 700, 'u').legacy, /per online bot \(2 online\)/);
    assert.match(t.app.statusView(7, 700, 'u').rich, /per online bot \(2 online\)/);
  } finally { t.cleanup(); }
});
