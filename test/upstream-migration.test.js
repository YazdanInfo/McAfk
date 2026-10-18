'use strict';
// A userdata.json written by the original single-file McAfk (DATA_VERSION 2) must load, keep its bot ids and forwards,
// and be rewritten in the current format.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadApp } = require('./helpers');

// The id function of the original index.js (FNV-1a over "name:host:port"), copied here as the reference.
const upstreamHashId = input => {
  let hash = 2166136261;
  for (const character of String(input)) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
};
const upstreamId = (name, host, port) => String(upstreamHashId(`${name}:${host}:${port}`));

const writeUpstreamFile = dir => {
  const bot = (name, extra = {}) => ({
    id: upstreamId(name, 'play.example.com', 25565), name, host: 'play.example.com', port: 25565, version: '1.20.4',
    chatId: 700, userId: 7, ownerUsername: 'alice', paused: true, createdAt: '2026-01-01T00:00:00.000Z', ...extra,
  });
  fs.writeFileSync(path.join(dir, 'userdata.json'), JSON.stringify({
    meta: { version: 2, updatedAt: '2026-01-01T00:00:00.000Z', app: 'mcafk' },
    bots: [bot('Steve'), bot('Alex', { paused: false })],
    forwards: { 7: [-1001234567890, 700] },
  }, null, 2));
};

test('a data file from the original single-file version loads, keeps ids and forwards, and is migrated', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcafk-upstream-'));
  writeUpstreamFile(dir);
  const t = loadApp({}, dir);
  try {
    t.app.loadData();
    const ids = [...t.app.mcBots.keys()].sort();
    assert.deepEqual(ids, [upstreamId('Steve', 'play.example.com', 25565), upstreamId('Alex', 'play.example.com', 25565)].sort(),
      'the id of every bot is unchanged, so saved callback buttons and forwards still point at it');
    const steve = t.app.mcBots.get(upstreamId('Steve', 'play.example.com', 25565));
    assert.equal(steve.status, 'offline');
    assert.equal(steve.resumePending, false, 'saved as paused: stays paused until Reconnect');
    const alex = t.app.mcBots.get(upstreamId('Alex', 'play.example.com', 25565));
    assert.equal(alex.resumePending, true, 'saved as "was running" (crash): comes back by itself (AUTO_RESUME=0 turns that off)');

    const dests = require('../src/registry').forwardMap.get('7');
    assert.ok(dests, 'the forwards of user 7 are loaded');
    assert.deepEqual([...dests.keys()].sort(), ['-1001234567890', '700']);
    for (const entry of dests.values()) assert.equal(entry.active, true, 'plain chat ids become active forwards');

    const rewritten = JSON.parse(fs.readFileSync(path.join(dir, 'userdata.json'), 'utf8'));
    assert.equal(rewritten.meta.version, 5, 'rewritten in the current format');
    assert.equal(rewritten.bots.length, 2);
  } finally { t.cleanup(); fs.rmSync(dir, { recursive: true, force: true }); }
});
