'use strict';
// Guards the module split: every name a module reads from the shared registry must be registered by some module, and the
// load order must make every destructured name available at the time it is read. Catches a forgotten export before runtime.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { loadApp } = require('./helpers');

const SRC = path.join(__dirname, '..', 'src');
const files = fs.readdirSync(SRC).filter(f => f.endsWith('.js') && f !== 'registry.js');
const loadOrder = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8')
  .match(/^require\('\.\/src\/([\w-]+)'\);$/gm).map(m => m.match(/src\/([\w-]+)/)[1]); // the loader lines only

test('index.js requires every src module exactly once', () => {
  assert.deepEqual([...loadOrder].sort(), files.map(f => f.replace(/\.js$/, '')).sort());
});

test('every name read from the registry is registered; early names come from earlier modules', () => {
  const t = loadApp();
  try {
    const R = require('../src/registry');
    const owner = new Map(); // name -> index in load order of the module that registers it
    loadOrder.forEach((mod, i) => {
      const text = fs.readFileSync(path.join(SRC, `${mod}.js`), 'utf8');
      const assign = /Object\.assign\(R, \{([\s\S]*?)\}\);/.exec(text);
      if (!assign) return;
      for (const name of assign[1].split(',').map(x => x.trim()).filter(Boolean)) owner.set(name, i);
    });
    const problems = [];
    loadOrder.forEach((mod, i) => {
      const text = fs.readFileSync(path.join(SRC, `${mod}.js`), 'utf8');
      const header = /const \{ ([^}]*) \} = R;\n/g;
      let m;
      while ((m = header.exec(text))) {
        if (m[1].trim() === 'S') continue;
        for (const name of m[1].split(',').map(x => x.trim()).filter(Boolean)) {
          if (!owner.has(name)) problems.push(`${mod}: ${name} is never registered`);
          else if (owner.get(name) >= i) problems.push(`${mod}: ${name} comes from a later module (use R.${name} at call time)`);
        }
      }
      for (const [, name] of text.matchAll(/\bR\.([A-Za-z_]\w*)/g)) {
        if (name === 'S') continue;
        if (!owner.has(name)) problems.push(`${mod}: R.${name} is never registered`);
      }
    });
    assert.deepEqual(problems, []);
    for (const name of owner.keys()) assert.notEqual(R[name], undefined, `${name} is registered but undefined at runtime`);
  } finally { t.cleanup(); }
});
