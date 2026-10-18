'use strict';
const { test, describe, beforeEach, afterEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const { loadApp } = require('./helpers');

describe('server address rules', () => {
  let t;
  afterEach(() => t?.cleanup());

  test('privateAddress: loopback, LAN, link-local, metadata, CGNAT and IPv6 equivalents are private; public ones are not', () => {
    t = loadApp();
    const priv = ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '0.0.0.0', '100.64.0.1',
      '198.18.0.1', '224.0.0.1', '::1', '::', 'fd00::1', 'fe80::1', '::ffff:10.0.0.1', '::ffff:127.0.0.1'];
    const pub = ['8.8.8.8', '172.15.0.1', '172.32.0.1', '192.169.0.1', '100.63.0.1', '1.1.1.1', '2606:4700:4700::1111', '::ffff:8.8.8.8'];
    for (const a of priv) assert.equal(t.app.privateAddress(a), true, a);
    for (const a of pub) assert.equal(t.app.privateAddress(a), false, a);
  });

  test('normalizeHost lower-cases, trims and drops a trailing dot', () => {
    t = loadApp();
    assert.equal(t.app.normalizeHost('  Play.Example.COM. '), 'play.example.com');
  });

  test('invalid shapes are refused before anything else', async () => {
    t = loadApp();
    for (const bad of ['', 'a b', 'ex ample.com', 'http://x.com', 'x.com/path', '-bad.com', 'bad-.com', 'a..b.com', '.lead.com', 'x.-y.com', '[::1]', 'mc_server.com!', 'é.com', 'a'.repeat(254)]) {
      assert.deepEqual(await t.app.checkHostAllowed(bad), { ok: false, reason: 'invalid' }, bad);
    }
  });

  test('literal private addresses and private names are refused; public literals pass without any lookup', async () => {
    t = loadApp();
    let lookups = 0;
    t.app.hostResolver.lookupAll = async () => { lookups += 1; return ['8.8.8.8']; };
    for (const bad of ['127.0.0.1', '10.0.0.5', '169.254.169.254', 'localhost', 'a.localhost', 'nas.local', 'db.internal', 'x.home.arpa']) {
      assert.deepEqual(await t.app.checkHostAllowed(bad), { ok: false, reason: 'private' }, bad);
    }
    assert.deepEqual(await t.app.checkHostAllowed('8.8.8.8'), { ok: true });
    assert.equal(lookups, 0);
  });

  test('a public name that resolves to a private address is refused (any one address is enough)', async () => {
    t = loadApp();
    t.app.hostResolver.lookupAll = async () => ['93.184.216.34', '10.0.0.7'];
    assert.deepEqual(await t.app.checkHostAllowed('sneaky.example.com'), { ok: false, reason: 'private' });
    t.app.hostResolver.lookupAll = async () => ['93.184.216.34'];
    assert.deepEqual(await t.app.checkHostAllowed('mc.example.com'), { ok: true });
  });

  test('a failed lookup is let through', async () => {
    t = loadApp();
    t.app.hostResolver.lookupAll = async () => { throw Object.assign(new Error('nx'), { code: 'ENOTFOUND' }); };
    assert.deepEqual(await t.app.checkHostAllowed('down.example.com'), { ok: true });
  });

  test('a slow lookup times out and is let through', async () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    try {
      t = loadApp();
      t.app.hostResolver.lookupAll = () => new Promise(() => {});
      const pending = t.app.checkHostAllowed('slow.example.com');
      mock.timers.tick(t.app.CFG.JOIN_DNS_TIMEOUT_MS);
      assert.deepEqual(await pending, { ok: true });
    } finally { mock.timers.reset(); }
  });

  test('MC_ALLOW_PRIVATE_HOSTS=1 allows private hosts but never an invalid shape', async () => {
    t = loadApp({ MC_ALLOW_PRIVATE_HOSTS: '1' });
    assert.deepEqual(await t.app.checkHostAllowed('127.0.0.1'), { ok: true });
    assert.deepEqual(await t.app.checkHostAllowed('localhost'), { ok: true });
    assert.deepEqual(await t.app.checkHostAllowed('a b'), { ok: false, reason: 'invalid' });
  });
});

describe('adding a bot: host handling', () => {
  let t;
  const replies = [];
  beforeEach(() => { replies.length = 0; });
  afterEach(() => t?.cleanup());

  const add = async text => {
    const handler = t.app.bot.handlers.find(([name]) => name === 'message:text')[1];
    t.app.chatStates.set(700, { action: 'awaiting_bot_info' });
    await handler({ chat: { id: 700, type: 'private' }, from: { id: 7, username: 'u' }, message: { text },
      reply: async message => { replies.push(message); return { message_id: 1 }; } });
  };
  const hosts = () => [...t.app.mcBots.values()].map(info => info.host);

  test('the host is stored lower-case, so the same server cannot be added twice by changing the case', async () => {
    t = loadApp({ MAX_BOTS_PER_USER: '0' });
    t.app.hostResolver.lookupAll = async () => ['93.184.216.34'];
    await add('Steve Mc.Example.COM 25565');
    await add('Steve mc.example.com:25565');
    assert.deepEqual(hosts(), ['mc.example.com'], 'one bot, lower-case');
  });

  test('private and invalid hosts are refused with an explanation, and nothing is added', async () => {
    t = loadApp();
    await add('Steve 127.0.0.1 25565');
    assert.match(replies.pop(), /private/);
    assert.match(replies.length ? '' : 'x', /x/);
    await add('Steve 169.254.169.254:80');
    assert.match(replies.pop(), /MC_ALLOW_PRIVATE_HOSTS/);
    await add('Steve ex_ample!.com 25565');
    assert.match(replies.pop(), /Invalid server address/);
    assert.equal(t.app.mcBots.size, 0);
  });

  test('with MC_ALLOW_PRIVATE_HOSTS=1 a LAN server can be added', async () => {
    t = loadApp({ MC_ALLOW_PRIVATE_HOSTS: '1' });
    await add('Steve 192.168.1.20 25565');
    assert.deepEqual(hosts(), ['192.168.1.20']);
  });

  test('bots saved earlier on a private address still load and are not re-checked', () => {
    t = loadApp();
    const info = t.addBot('Old', { host: '127.0.0.1' });
    assert.equal(t.app.mcBots.get(info.id).host, '127.0.0.1');
  });
});
