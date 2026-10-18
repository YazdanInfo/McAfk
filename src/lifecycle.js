'use strict';
// Mineflayer lifecycle, server ping, kick handling, join queue, connect and reconnect.
const R = require('./registry');
const { S } = R;
const { InlineKeyboard } = require('grammy');
const mineflayer = require('mineflayer');
const dns = require('dns');
const net = require('net');
const { CFG, DEATH_PATTERN, IDLE_VIEW_DISTANCE, VIEW_DISTANCE, alertOpts, closeHealthAlert, esc,
  formatMinecraftReason, getBot, locLine, maybeAiReply, maybeAutoEat, notify, notifyRich, rFooter, rSend,
  reconnectDelay, recordDamage, rememberChat, saveData, snapshotItems, snapshotLocation, startTick, stopTick,
  stripColors, styleKeyboard, triggerMatches, watchEvent } = R;

// ---------------------------------------------------------------------------
// MINEFLAYER LIFECYCLE
// ---------------------------------------------------------------------------

// Single place that tears a connection down: status, timers, listeners and socket.
const markConnectionLost = (info, client, status, error) => {
  if (info.status === 'online') {
    if (!info.hourStats) info.hourStats = { deaths: 0, drops: 0 };
    info.hourStats.drops += 1;
  }
  info.status = status;
  info.error = error;
  info.connectedAt = null;
  info.stuck = null;
  info.mcBot = null;
  stopTick(info);
  if (info.healthAlert) {
    clearTimeout(info.healthAlert.editTimer);
    info.healthAlert = null;
  }
  if (!client) return;
  try { client.removeAllListeners(); } catch (_) {}
  try { client.on('error', () => {}); } catch (_) {}
  try { client.end(); } catch (_) {}
};

const destroyBot = info => {
  if (!info) return;
  info.spawnSeq = (info.spawnSeq || 0) + 1; // invalidates a preflight ping that is still in flight
  stopTick(info);
  if (info.healthAlert) {
    clearTimeout(info.healthAlert.editTimer);
    info.healthAlert = null;
  }
  if (info.reconnectTimer) {
    clearTimeout(info.reconnectTimer);
    info.reconnectTimer = null;
  }
  if (info.mcBot) {
    const client = info.mcBot;
    info.mcBot = null;
    try {
      client.quit();
    } catch (_) {}
    client.removeAllListeners();
  }
};

const friendlyError = (error, info) => {
  const code = error?.code;
  if (code === 'ECONNREFUSED') return 'Connection refused — server offline or wrong port';
  if (code === 'ECONNRESET') return 'Connection reset — check version or server is in online mode';
  if (code === 'ENOTFOUND') return `Host not found: ${error.hostname || info.host}`;
  if (code === 'EAI_AGAIN') return 'DNS lookup failed temporarily — try again';
  if (code === 'ETIMEDOUT') return 'Timed out — server may be offline';
  if (/unsupported protocol version/i.test(error?.message || '')) {
    return 'Unsupported protocol version — choose a compatible client version';
  }
  return error?.message || 'Unknown connection error';
};

// ---------------------------------------------------------------------------
// SERVER STATUS PING (minecraft-protocol, already a dependency of mineflayer)
// ---------------------------------------------------------------------------

S.mcProtocol = null;
try {
  S.mcProtocol = require('minecraft-protocol');
} catch (_) {
  try {
    S.mcProtocol = require(require.resolve('minecraft-protocol', { paths: [require.resolve('mineflayer')] }));
  } catch (__) { /* no ping support: the preflight and server rows are simply skipped */ }
}

const pingServer = async (host, port) => {
  if (!S.mcProtocol || typeof S.mcProtocol.ping !== 'function') return null;
  let timer;
  try {
    const res = await Promise.race([
      S.mcProtocol.ping({ host, port }),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('ping timeout')), CFG.PING_TIMEOUT_MS); }),
    ]);
    const players = res?.players || {};
    const online = Number(players.online ?? res?.playerCount);
    const max = Number(players.max ?? res?.maxPlayers);
    const versionName = typeof res?.version === 'object' ? res.version?.name : res?.version;
    const latency = Number(res?.latency);
    return {
      ok: true,
      at: Date.now(),
      online: Number.isFinite(online) ? online : null,
      max: Number.isFinite(max) ? max : null,
      motd: formatMinecraftReason(res?.description ?? res?.motd ?? '').replace(/\s+/g, ' ').trim().slice(0, 120),
      version: stripColors(String(versionName || '')).slice(0, 40),
      latency: Number.isFinite(latency) ? Math.round(latency) : null,
    };
  } catch (error) {
    return { ok: false, at: Date.now(), error: String(error?.code || error?.message || 'ping failed').slice(0, 60) };
  } finally {
    clearTimeout(timer);
  }
};

// Hosts such as Aternos answer the status ping with an "Offline" MOTD while the real server is stopped.
const looksOffline = status => Boolean(status?.ok) && /\boffline\b/i.test(`${status.motd} ${status.version}`);

const refreshServerStatus = async bots => {
  const byServer = new Map();
  for (const info of bots) {
    const key = `${info.host}:${info.port}`;
    if (!byServer.has(key)) byServer.set(key, []);
    byServer.get(key).push(info);
  }
  await Promise.all([...byServer.values()].map(async infos => {
    const status = await pingServer(infos[0].host, infos[0].port);
    if (status) for (const info of infos) info.serverStatus = status;
  }));
};

const serverStatusList = bots => {
  const seen = new Map();
  for (const info of bots) {
    const key = `${info.host}:${info.port}`;
    if (info.serverStatus && !seen.has(key)) seen.set(key, info.serverStatus);
  }
  return [...seen];
};

const handleServerOffline = (info, status) => {
  info.status = 'offline';
  info.error = `Server reports offline (“${status.motd || status.version}”). Checking again in ${Math.round(CFG.LOBBY_RETRY_MS / 60000)} min`;
  info.reconnectAttempts = 0;
  clearTimeout(info.reconnectTimer);
  info.reconnectTimer = setTimeout(() => {
    info.reconnectTimer = null;
    const latest = getBot(info.id);
    if (latest?.autoReconnect && !S.shuttingDown) spawnBot(latest, false);
  }, CFG.LOBBY_RETRY_MS);
  if (!info.lobbyNotified && info.chatId) {
    info.lobbyNotified = true;
    notifyRich(info.chatId,
      `<h4>🚪 ${esc(info.name)}: server is offline</h4>` +
      `<blockquote><code>${esc(status.motd || status.version)}</code></blockquote>` +
      `<p>I'm not joining while it says offline. Checking again every ${Math.round(CFG.LOBBY_RETRY_MS / 60000)} min.</p>` +
      `<blockquote>Wrong? Turn off 🚪 Lobby guard in /settings.</blockquote>${rFooter('Offline')}`,
      `🚪 <b>${esc(info.name)}</b>: server says offline (<code>${esc(status.motd || status.version)}</code>). ` +
      `Checking again every ${Math.round(CFG.LOBBY_RETRY_MS / 60000)} min. Wrong? Turn off 🚪 Lobby guard in /settings.`,
      alertOpts(info, 'lobby'));
  }
  saveData();
};

// ---------------------------------------------------------------------------
// KICK HANDLING — a ban or whitelist is not fixed by retrying
// ---------------------------------------------------------------------------

const classifyKick = message => {
  const text = String(message || '').toLowerCase();
  if (/\bbanned\b|ip.?ban|disconnect\.banned/.test(text)) return 'ban';
  if (/white-?list|not_whitelisted/.test(text)) return 'whitelist';
  if (/logged in from another location|duplicate_login|already (?:connected|online|logged)/.test(text)) return 'duplicate';
  if (/server is full|server_full|\bis full\b|full server/.test(text)) return 'full';
  if (/connection throttled|\bthrottled\b/.test(text)) return 'throttle';
  return 'other';
};

const stopAfterKick = (info, client, kind, message) => {
  info.autoReconnect = false; // also keeps the schedule loop away: its status is 'error', not 'offline'
  clearTimeout(info.reconnectTimer);
  info.reconnectTimer = null;
  markConnectionLost(info, client, 'error', `${kind === 'ban' ? 'Banned' : 'Not whitelisted'}: ${message}`);
  if (info.chatId) {
    const title = kind === 'ban' ? `🚫 ${info.name} is banned` : `📋 ${info.name} is not whitelisted`;
    const fix = kind === 'ban'
      ? 'Unban it on the server (for example <code>/pardon ' + esc(info.name) + '</code>)'
      : 'Add it on the server (for example <code>/whitelist add ' + esc(info.name) + '</code>)';
    rSend(info.chatId,
      `<h4>${esc(title)}</h4><blockquote expandable><code>${esc(message)}</code></blockquote>` +
      `<p>I stopped retrying: repeated join attempts can make this worse. ${fix}, then press <b>Reconnect</b>.</p>${rFooter('Stopped')}`,
      `${esc(title)}\n<code>${esc(message)}</code>\nI stopped retrying. ${fix}, then press Reconnect.`,
      styleKeyboard(new InlineKeyboard().text('🟡 Reconnect', `reconnect:${info.id}`)), alertOpts(info, 'ban')).catch(() => {});
  }
  saveData();
};

const retryAfterKick = (info, kind) => {
  const ms = kind === 'duplicate' ? CFG.KICK_DUP_RETRY_MS : CFG.KICK_FULL_RETRY_MS;
  clearTimeout(info.reconnectTimer);
  info.reconnectTimer = setTimeout(() => {
    info.reconnectTimer = null;
    const latest = getBot(info.id);
    if (latest?.autoReconnect && !S.shuttingDown) spawnBot(latest, false);
  }, ms);
  if (info.lastKickKind !== kind && info.chatId) {
    const reason = kind === 'duplicate'
      ? 'The same name is already logged in (another session or a stuck ghost connection).'
      : 'The server is full.';
    notifyRich(info.chatId,
      `<h4>⏳ ${esc(info.name)}: ${kind === 'duplicate' ? 'name already in use' : 'server full'}</h4>` +
      `<p>${reason} Retrying every ${Math.round(ms / 60000) || 1} min, quietly.</p>${rFooter('Waiting')}`,
      `⏳ <b>${esc(info.name)}</b>: ${esc(reason)} Retrying every ${Math.round(ms / 60000) || 1} min.`,
      alertOpts(info, 'waiting'));
  }
  info.lastKickKind = kind;
  saveData();
};

// "Connection throttled! Please wait before reconnecting." — Paper/Spigot/Bungee refuse a second join from the same IP
// within a few seconds. Not a failure: wait quietly and retry, without using up a reconnect attempt.
// After CFG.THROTTLE_MAX_STREAK throttle kicks in a row the normal backoff takes over (so it can never loop silently forever).
const handleThrottle = (info, client, message) => {
  markConnectionLost(info, client, 'offline', 'Join throttled by the server — retrying shortly');
  info.throttleStreak = (info.throttleStreak || 0) + 1;
  if (info.throttleStreak > CFG.THROTTLE_MAX_STREAK) {
    info.throttleStreak = 0;
    info.error = `Join throttled ${CFG.THROTTLE_MAX_STREAK} times in a row: ${message}`;
    scheduleReconnect(info);
    return;
  }
  clearTimeout(info.reconnectTimer);
  info.reconnectTimer = setTimeout(() => {
    info.reconnectTimer = null;
    const latest = getBot(info.id);
    if (latest?.autoReconnect && !S.shuttingDown) spawnBot(latest, false);
  }, CFG.THROTTLE_RETRY_MS);
  saveData();
};

// View distance for one bot. The server only tracks entities inside the client's view distance, so a bot with a
// proximity alert of R blocks needs at least ceil(R / 16) + 1 chunks or the alert would silently never fire.
// A per-bot override (/settings → 🌍 View distance) wins over MC_VIEW_DISTANCE, even over "default".
const viewDistanceFor = info => {
  const base = info.settings?.viewDistance ?? VIEW_DISTANCE;
  if (base === null) return null;
  const radius = Number(info.settings?.proximityRadius) || 0;
  const needed = radius > 0 ? Math.ceil(radius / 16) + 1 : 0;
  return Math.min(32, Math.max(base, needed));
};

// OPTIONAL idle world reduction (MC_IDLE_VIEW_DISTANCE, off by default). A bot that has not moved for CFG.IDLE_VIEW_AFTER_MS asks
// the server for a smaller view distance and asks for its normal one again as soon as it moves. Bots with a proximity alert are
// skipped (they need the view). NOT measured against a real server: how much memory this frees depends on the server unloading
// the chunks it no longer needs to send.
const idleViewTick = (info, client) => {
  if (IDLE_VIEW_DISTANCE === null || info.idleViewFailed || typeof client?.setSettings !== 'function') return;
  const st = info.stuck;
  if (!st) return;
  const normal = info.viewDistance ?? null; // what this connection asked for (null = mineflayer's large default)
  const apply = value => {
    try { client.setSettings({ viewDistance: value }); return true; } catch (_) { info.idleViewFailed = true; return false; }
  };
  if (info.idleView) {
    if (st.movedAt > info.idleView.since || info.walking || info.settings.proximityRadius) {
      info.idleView = null;
      apply(normal ?? 'far');
    }
    return;
  }
  if (info.walking || info.settings.proximityRadius) return;
  if (normal !== null && IDLE_VIEW_DISTANCE >= normal) return; // already that small: nothing to save
  if (Date.now() - st.movedAt < CFG.IDLE_VIEW_AFTER_MS) return;
  if (apply(IDLE_VIEW_DISTANCE)) info.idleView = { since: Date.now(), value: IDLE_VIEW_DISTANCE };
};

// ---------------------------------------------------------------------------
// JOIN QUEUE — every join attempt to one host:port goes through a queue that keeps CFG.JOIN_GAP_MS between
// attempts, so the schedule loop (or a mass Reconnect) never trips the server's connection throttle.
// Different hosts do not wait for each other. Entries of bots that were destroyed or re-spawned are skipped.
// ---------------------------------------------------------------------------

const joinQueues = new Map(); // "ip:port" (or "host:port" when the name cannot be resolved) -> { items: [{ info, seq, run }], lastAt, timer }

// The server throttles per source address, and two names can point at one server, so the queue is keyed by the
// resolved IP. `joinResolver.lookup` is replaceable (tests). A failed or slow lookup falls back to the host name.
// ---- what a user may point a bot at --------------------------------------------------------------------------------------
// A bot connects from THIS machine, so an unrestricted host would let any allowed user probe the VPS itself, its network and the
// cloud metadata address (the error text — refused vs timed out — tells what is open). Checked when a bot is ADDED; bots saved
// earlier keep working. MC_ALLOW_PRIVATE_HOSTS=1 allows them (a Minecraft server on this VPS or your LAN).
const LABEL_RE = /^[a-z0-9]([a-z0-9_-]{0,61}[a-z0-9])?$/;
const validHostname = host => host.length > 0 && host.length <= 253 && host.split('.').every(label => LABEL_RE.test(label));
const normalizeHost = raw => String(raw || '').trim().toLowerCase().replace(/\.$/, '');

const privateIPv4 = address => {
  const [a, b, c] = address.split('.').map(Number);
  return a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) || (a === 192 && b === 0 && c === 0) || (a === 198 && (b === 18 || b === 19));
};
const privateAddress = address => {
  const text = String(address || '').toLowerCase();
  if (net.isIPv4(text)) return privateIPv4(text);
  if (!net.isIPv6(text)) return false;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (mapped) return privateIPv4(mapped[1]);
  return text === '::' || text === '::1' || /^f[cd]/.test(text) || /^fe[89ab]/.test(text) || /^ff/.test(text);
};
const privateName = host => host === 'localhost' || /\.(localhost|local|internal|localdomain|home\.arpa)$/.test(host);

const hostResolver = { lookupAll: host => dns.promises.lookup(host, { all: true }).then(list => list.map(entry => entry.address)) };

// -> { ok: true } or { ok: false, reason: 'invalid' | 'private' }. A failed or slow lookup is let through (the server may simply be down).
const checkHostAllowed = async rawHost => {
  const host = normalizeHost(rawHost);
  if (!validHostname(host)) return { ok: false, reason: 'invalid' };
  if (CFG.ALLOW_PRIVATE_HOSTS) return { ok: true };
  if (net.isIP(host)) return privateAddress(host) ? { ok: false, reason: 'private' } : { ok: true };
  if (privateName(host)) return { ok: false, reason: 'private' };
  let timer;
  try {
    const addresses = await Promise.race([
      Promise.resolve().then(() => hostResolver.lookupAll(host)),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), CFG.JOIN_DNS_TIMEOUT_MS); timer.unref?.(); }),
    ]);
    if (addresses.some(privateAddress)) return { ok: false, reason: 'private' };
  } catch (_) { /* unresolved: allow */ } finally { clearTimeout(timer); }
  return { ok: true };
};

const joinResolver = { lookup: host => dns.promises.lookup(host).then(result => result.address) };
const joinKeyCache = new Map(); // lower-case host -> { at, promise<address | null> }

const resolveJoinKey = info => {
  const host = String(info.host).trim().toLowerCase();
  const fallback = `${host}:${info.port}`;
  if (net.isIP(host)) return Promise.resolve(fallback);
  const toKey = address => (address ? `${address}:${info.port}` : fallback);
  const hit = joinKeyCache.get(host);
  if (hit && Date.now() - hit.at < CFG.JOIN_KEY_TTL_MS) return hit.promise.then(toKey);
  let timer;
  const promise = Promise.race([
    Promise.resolve().then(() => joinResolver.lookup(host)),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('dns timeout')), CFG.JOIN_DNS_TIMEOUT_MS);
      timer.unref?.();
    }),
  ]).then(address => String(address || '').toLowerCase() || null, () => null)
    .finally(() => clearTimeout(timer));
  joinKeyCache.set(host, { at: Date.now(), promise });
  void promise.then(address => { if (!address && joinKeyCache.get(host)?.promise === promise) joinKeyCache.delete(host); });
  return promise.then(toKey);
};
const joinEntryLive = item => !S.shuttingDown
  && getBot(item.info.id) === item.info
  && item.info.spawnSeq === item.seq
  && item.info.status === 'connecting';

const pumpJoinQueue = key => {
  const queue = joinQueues.get(key);
  if (!queue || queue.timer) return;
  while (queue.items.length) {
    const item = queue.items[0];
    if (!joinEntryLive(item)) {
      queue.items.shift();
      continue;
    }
    const wait = queue.lastAt + CFG.JOIN_GAP_MS - Date.now();
    if (wait > 0) {
      queue.timer = setTimeout(() => {
        queue.timer = null;
        pumpJoinQueue(key);
      }, wait);
      queue.timer.unref?.();
      return;
    }
    queue.items.shift();
    queue.lastAt = Date.now();
    try {
      item.run();
    } catch (error) {
      console.error('[JOIN]', error?.message || error);
    }
  }
  if (!queue.timer && Date.now() - queue.lastAt >= CFG.JOIN_GAP_MS) joinQueues.delete(key);
};

const queueJoin = (info, seq, run) => {
  if (!CFG.JOIN_GAP_MS) {
    run();
    return;
  }
  void resolveJoinKey(info).then(key => {
    const item = { info, seq, run };
    if (!joinEntryLive(item)) return; // removed, disconnected or re-spawned while the name was being resolved
    let queue = joinQueues.get(key);
    if (!queue) {
      queue = { items: [], lastAt: 0, timer: null };
      joinQueues.set(key, queue);
    }
    queue.items.push(item);
    pumpJoinQueue(key);
  });
};

// Bots of `bots` that are waiting for their join slot (for /status).
const joinWaiting = bots => {
  const mine = new Set(bots);
  let count = 0;
  for (const queue of joinQueues.values()) {
    for (const item of queue.items) if (mine.has(item.info) && joinEntryLive(item)) count += 1;
  }
  return count;
};

const LOBBY_MODES = ['adventure'];

// Aternos (and similar hosts) keep a lobby alive while the real server is off. A bot that lands in an
// adventure world is not on the real server: drop it and retry later instead of reporting "online".
const handleLobby = (info, client) => {
  const mode = String(client.game?.gameMode || 'unknown');
  info.status = 'connecting'; // so this is not counted as a normal disconnect in the digest
  markConnectionLost(info, client, 'offline',
    `Server looks off — joined a ${mode} lobby. Retrying in ${Math.round(CFG.LOBBY_RETRY_MS / 60000)} min`);
  info.reconnectAttempts = 0;
  clearTimeout(info.reconnectTimer);
  info.reconnectTimer = setTimeout(() => {
    info.reconnectTimer = null;
    const latest = getBot(info.id);
    if (latest?.autoReconnect && !S.shuttingDown) spawnBot(latest, false);
  }, CFG.LOBBY_RETRY_MS);
  if (!info.lobbyNotified && info.chatId) {
    info.lobbyNotified = true;
    notifyRich(info.chatId,
      `<h4>🚪 ${esc(info.name)}: server seems off</h4>` +
      `<p>It joined a <b>${esc(mode)}</b> lobby instead of the real world, so I disconnected it.</p>` +
      `<p>I'll keep retrying every ${Math.round(CFG.LOBBY_RETRY_MS / 60000)} min and tell you when it's really in.</p>` +
      `<blockquote>Not what you expect? Turn off 🚪 Lobby guard in /settings.</blockquote>${rFooter('Lobby')}`,
      `🚪 <b>${esc(info.name)}</b>: server seems off — joined a ${esc(mode)} lobby, disconnected.\n` +
      `Retrying every ${Math.round(CFG.LOBBY_RETRY_MS / 60000)} min. Not what you expect? Turn off 🚪 Lobby guard in /settings.`,
      alertOpts(info, 'lobby'));
  }
  saveData();
};

const scheduleReconnect = info => {
  const current = getBot(info.id);
  if (!current || !current.autoReconnect || S.shuttingDown) return;

  if (current.reconnectAttempts >= CFG.MAX_RECONNECTS) {
    current.status = 'error';
    current.error = `Max reconnect attempts reached (${CFG.MAX_RECONNECTS})`;
    saveData();
    if (current.chatId) {
      notifyRich(current.chatId,
        `<h4>❌ ${esc(current.name)} gave up</h4><p>${CFG.MAX_RECONNECTS} failed reconnect attempts.</p>${rFooter('Stopped')}`,
        `❌ <b>${esc(current.name)}</b> gave up after ${CFG.MAX_RECONNECTS} failed attempts.`,
        alertOpts(current, 'gaveup'));
    }
    return;
  }

  current.reconnectAttempts += 1;
  const delay = reconnectDelay(current.reconnectAttempts);
  current.reconnectTimer = setTimeout(() => {
    current.reconnectTimer = null;
    const latest = getBot(current.id);
    if (latest?.autoReconnect && !S.shuttingDown) spawnBot(latest, false);
  }, delay);

  if (current.chatId) {
    notify(current.chatId,
      `🔄 <b>${esc(current.name)}</b> reconnecting in ${Math.round(delay / 1000)}s ` +
      `(attempt ${current.reconnectAttempts})…`,
      alertOpts(current, 'reconnecting'));
  }
  saveData();
};

const spawnBot = (info, resetAttempts = true) => {
  const current = getBot(info.id);
  if (!current) return;
  destroyBot(current);

  current.status = 'connecting';
  current.error = null;
  current.autoReconnect = true;
  current.userStopped = false;
  current.resumePending = false;
  current.wantedOnline = undefined;
  if (resetAttempts) current.reconnectAttempts = 0;
  const seq = current.spawnSeq;

  // Ask the server for its status first. A ping that fails never blocks joining; only a clear "offline" does.
  void pingServer(current.host, current.port).then(status => {
    if (S.shuttingDown || getBot(current.id) !== current || current.spawnSeq !== seq) return;
    if (status) current.serverStatus = status;
    if (current.settings.lobbyGuard && looksOffline(status) && (current.preflightSkips || 0) < CFG.PREFLIGHT_MAX_SKIPS) {
      current.preflightSkips = (current.preflightSkips || 0) + 1;
      handleServerOffline(current, status);
      return;
    }
    current.preflightSkips = 0;
    queueJoin(current, seq, () => connectBot(current));
  });
};

const connectBot = current => {
  let mcBot;
  const viewDistance = viewDistanceFor(current);
  current.viewDistance = viewDistance; // what this connection asked for (a later proximity change needs a reconnect)
  current.idleView = null;
  current.idleViewFailed = false;
  try {
    mcBot = mineflayer.createBot({
      host: current.host,
      port: current.port,
      username: current.name,
      version: current.version,
      auth: 'offline',
      hideErrors: false,
      checkTimeoutInterval: CFG.MC_TIMEOUT_MS,
      ...(viewDistance ? { viewDistance } : {}),
    });
  } catch (error) {
    current.status = 'error';
    current.error = friendlyError(error, current);
    scheduleReconnect(current);
    return;
  }

  current.mcBot = mcBot;
  current.lastPacketAt = Date.now();
  try {
    mcBot._client?.on('packet', () => { current.lastPacketAt = Date.now(); });
  } catch (_) {}

  mcBot.once('spawn', () => {
    current.status = 'online';
    current.throttleStreak = 0;
    current.connectedAt = Date.now();
    current.sessionStats = { distance: 0, respawns: 0 };
    current.reconnectAttempts = 0;
    current.error = null;
    current.lastHealth = mcBot.health ?? 20;
    current.lowHealthWarned = false;
    current.stuck = null;
    current.lastActivityAt = Date.now();
    startTick(current);
    saveData();
    // Give the server a moment to send the real gamemode, then tell a lobby apart from the real world.
    setTimeout(() => {
      if (current.mcBot !== mcBot || current.status !== 'online') return;
      if (current.settings.lobbyGuard && LOBBY_MODES.includes(String(mcBot.game?.gameMode))) {
        handleLobby(current, mcBot);
        return;
      }
      const wasLobby = current.lobbyNotified;
      current.lobbyNotified = false;
      current.lastKickKind = null;
      current.preflightSkips = 0;
      if (!current.chatId) return;
      notifyRich(current.chatId,
        `<p>🟢 <b>${esc(current.name)}</b> ${wasLobby ? 'is really in now' : 'connected to'} ` +
        `<code>${esc(current.host)}:${current.port}</code>!</p>${rFooter('Connected')}`,
        `🟢 <b>${esc(current.name)}</b> ${wasLobby ? 'is really in now' : 'connected to'} ` +
        `<code>${esc(current.host)}:${current.port}</code>!`,
        alertOpts(current, 'connected'));
    }, CFG.LOBBY_CHECK_MS);
  });

  mcBot.on('kicked', reason => {
    const message = formatMinecraftReason(reason) || 'Unknown reason';
    const kind = classifyKick(message);
    if (kind === 'ban' || kind === 'whitelist') {
      stopAfterKick(current, mcBot, kind, message);
      return;
    }
    if (kind === 'throttle') {
      handleThrottle(current, mcBot, message);
      return;
    }
    markConnectionLost(current, mcBot, 'offline', `Kicked: ${message}`);
    if (kind === 'duplicate' || kind === 'full') {
      retryAfterKick(current, kind);
      return;
    }
    if (current.chatId) {
      notifyRich(current.chatId,
        `<h4>🔴 ${esc(current.name)} was kicked</h4>` +
        `<blockquote expandable><code>${esc(message)}</code></blockquote>${rFooter('Kicked')}`,
        `🔴 <b>${esc(current.name)}</b> was kicked: <code>${esc(message)}</code>`,
        alertOpts(current, 'kicked'));
    }
    scheduleReconnect(current);
  });

  mcBot.on('error', error => {
    markConnectionLost(current, mcBot, 'error', friendlyError(error, current));
    if (current.chatId) {
      notifyRich(current.chatId,
        `<h4>🔴 ${esc(current.name)} error</h4>` +
        `<blockquote expandable><code>${esc(current.error)}</code></blockquote>${rFooter('Error')}`,
        `🔴 <b>${esc(current.name)}</b> error: <code>${esc(current.error)}</code>`,
        alertOpts(current, 'error'));
    }
    scheduleReconnect(current);
  });

  mcBot.on('end', reason => {
    if (current.status !== 'online' && current.status !== 'connecting') return;
    markConnectionLost(current, mcBot, 'offline', formatMinecraftReason(reason) || 'Connection closed');
    scheduleReconnect(current);
  });

  mcBot.on('message', jsonMessage => {
    const clean = stripColors(
      typeof jsonMessage?.toAnsi === 'function'
        ? jsonMessage.toAnsi()
        : jsonMessage?.toString(),
    );
    if (clean && clean.startsWith(`${current.name} `) && DEATH_PATTERN.test(clean)) {
      current.lastDeathMessage = clean;
      current.lastDeathAt = Date.now();
      const latest = current.deathHistory?.[0];
      if (latest && latest.cause === 'Unknown' && Date.now() - latest.at < 3000) {
        latest.cause = clean.slice(0, 200);
        saveData();
      }
    }
    current.lastActivityAt = Date.now();
    if (!clean) return;
    const targets = R.fwdTargetsFor(current, R.classifyMcMessage(clean));
    if (!targets.length) return;
    const label = `[${current.name} @ ${current.host}:${current.port}]`;
    for (const [groupId, entry] of targets) R.sendForward(groupId, entry, label, clean);
  });

  mcBot.on('playerJoined', player => watchEvent(current, player?.username, 'join'));
  mcBot.on('playerLeft', player => watchEvent(current, player?.username, 'left'));

  // After a respawn, remember where the bot came back (attached to the last death entry).
  mcBot.on('spawn', () => {
    const pending = current.pendingRespawn;
    if (!pending) return;
    current.pendingRespawn = null;
    const snap = snapshotLocation(mcBot);
    if (snap) {
      pending.respawn = snap.pos;
      saveData();
    }
  });

  mcBot.on('health', () => {
    if (!current.mcBot) return;
    const health = mcBot.health ?? 20;
    const previous = current.lastHealth ?? 20;
    if (health < previous - 0.01) {
      const lowNow = health <= CFG.LOW_HEALTH;
      if (current.settings.healthAlerts && current.chatId) {
        recordDamage(current, health, previous - health);
      }
      current.lowHealthWarned = lowNow;
    }
    current.lastHealth = health;
    if (current.settings.autoEat) void maybeAutoEat(current, mcBot);
  });

  mcBot.on('death', () => {
    const cause = current.lastDeathAt && Date.now() - current.lastDeathAt < 3000
      ? current.lastDeathMessage
      : null;
    if (!current.deathHistory) current.deathHistory = [];
    const where = snapshotLocation(mcBot);
    const record = {
      cause: (cause || 'Unknown').slice(0, 200),
      at: Date.now(),
      pos: where?.pos || null,
      dim: where?.dim || null,
      respawn: null,
      items: [],
      itemTotal: 0,
    };
    const carried = snapshotItems(mcBot);
    record.items = carried.items;
    record.itemTotal = carried.total;
    current.deathHistory.unshift(record);
    current.pendingRespawn = record;
    if (!current.hourStats) current.hourStats = { deaths: 0, drops: 0 };
    current.hourStats.deaths += 1;
    if (current.deathHistory.length > CFG.DEATH_HISTORY_MAX) current.deathHistory.length = CFG.DEATH_HISTORY_MAX;
    if (!current.sessionStats) current.sessionStats = { distance: 0, respawns: 0 };
    current.sessionStats.respawns += 1;
    saveData();
    const closing = closeHealthAlert(current, 0);
    if (current.settings.healthAlerts && current.chatId) {
      // Short delay so the death message (cause) has time to arrive first.
      setTimeout(async () => {
        await closing;
        const knownCause = current.lastDeathAt && Date.now() - current.lastDeathAt < 5000
          ? current.lastDeathMessage
          : cause;
        notifyRich(current.chatId,
          `<h4>💀 ${esc(current.name)} died</h4>` +
          (knownCause ? `<blockquote>${esc(knownCause)}</blockquote>` : '') +
          (record.pos ? `<p>📍 ${locLine(record.pos, record.dim)}</p>` : '') +
          (record.itemTotal ? `<p>🎒 ${record.itemTotal} item(s) in inventory</p>` : '') +
          `${current.settings.autoRespawn ? '<p>Respawning…</p>' : ''}${rFooter('Died')}`,
          `💀 <b>${esc(current.name)}</b> died` + (knownCause ? `: <code>${esc(knownCause)}</code>` : '') +
          (record.pos ? `\n📍 ${locLine(record.pos, record.dim)}` : '') +
          (record.itemTotal ? `\n🎒 ${record.itemTotal} item(s) in inventory` : '') +
          (current.settings.autoRespawn ? '\nRespawning…' : ''),
          alertOpts(current, 'death'));
      }, CFG.DEATH_ALERT_DELAY_MS);
    }
    if (current.settings.autoRespawn) {
      try { mcBot.respawn(); } catch (_) {}
    }
  });

  mcBot.on('chat', (username, message) => {
    if (username === mcBot.username) return;
    rememberChat(current, username, message);
    const rule = (current.autoReplies || []).find(r => triggerMatches(r.trigger, message));
    if (!rule) {
      void maybeAiReply(current, mcBot, username, message);
      return;
    }
    const now = Date.now();
    const cooldownMs = (rule.cooldownSec ?? CFG.AUTOREPLY_DEFAULT_COOLDOWN_SEC) * 1000;
    if (now - (rule.lastFiredAt || 0) < cooldownMs) return;
    rule.lastFiredAt = now;
    try { mcBot.chat(rule.response); } catch (_) {}
  });

  saveData();
};

Object.assign(R, { normalizeHost, privateAddress, checkHostAllowed, hostResolver, markConnectionLost, destroyBot, friendlyError, pingServer, looksOffline, refreshServerStatus,
  serverStatusList, handleServerOffline, classifyKick, stopAfterKick, retryAfterKick, handleThrottle,
  viewDistanceFor, idleViewTick, joinQueues, joinResolver, joinKeyCache, resolveJoinKey, joinEntryLive,
  pumpJoinQueue, queueJoin, joinWaiting, LOBBY_MODES, handleLobby, scheduleReconnect, spawnBot, connectBot });
