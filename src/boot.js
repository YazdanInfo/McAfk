'use strict';
// Heartbeat, shutdown, schedule loops, resume and the command list.
const R = require('./registry');
const { S } = R;
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const { CFG, DATA_DIR, IS_TEST, bot, destroyBot, flushForwardsNow, getBot, mcBots, notifyRich, ownedBots, persistNow,
  rFooter, safeJsonParse, saveData, spawnBot, tgTime, uptime, utcText, wantsOnline } = R;

// ---------------------------------------------------------------------------
// HEARTBEAT — optional dead man's switch. With HEARTBEAT_URL set (e.g. a healthchecks.io check URL) the manager
// pings it every minute WHILE HEALTHY. If the pings stop — kill -9, power cut, OOM kill, a hung event loop,
// Telegram unreachable — the monitoring service notices the silence and alerts you (it is the one that sends the
// message: a process that is dead cannot). Healthy = not shutting down AND Telegram answered an API call recently
// (long polling counts). Minecraft bots being down does NOT stop the heartbeat: that is what the bot alerts are for.
// ---------------------------------------------------------------------------

const HEARTBEAT_URL = (() => {
  const raw = String(process.env.HEARTBEAT_URL || '').trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('not http(s)');
    return url;
  } catch (_) {
    console.error('⚠️ HEARTBEAT_URL is not a valid http(s) URL — heartbeat disabled.');
    return null;
  }
})();

const heartbeat = { state: 'idle', okAt: 0, attemptAt: 0, error: null }; // state: idle | ok | paused | failing

// Health file: DATA_DIR/.health is touched every minute while healthy, with or without HEARTBEAT_URL.
// The Docker HEALTHCHECK reads its age; a restart reads its age to say when the last sign of life was.
const HEALTH_FILE = path.join(DATA_DIR, '.health');
const writeHealthFile = () => {
  try { fs.writeFileSync(HEALTH_FILE, String(Date.now())); } catch (_) {}
};

// Run marker: DATA_DIR/.running exists while the manager runs and is removed on a clean stop (exit code 0).
// Finding it at startup means the last run ended without that: crash, kill -9, OOM kill or power loss.
const RUN_MARKER = path.join(DATA_DIR, '.running');
const writeRunMarker = extra => {
  try { fs.writeFileSync(RUN_MARKER, JSON.stringify({ pid: process.pid, startedAt: Date.now(), ...extra })); } catch (_) {}
};
const clearRunMarker = () => {
  for (const file of [RUN_MARKER, HEALTH_FILE]) {
    try { fs.unlinkSync(file); } catch (_) {}
  }
};

// Call once at startup, before anything else touches the marker.
const bootRunState = () => {
  let previous = null;
  let unclean = false;
  let lastAlive = null;
  try {
    previous = safeJsonParse(fs.readFileSync(RUN_MARKER, 'utf8'), {}) || {};
    unclean = true;
    lastAlive = Number(previous.startedAt) || null;
  } catch (_) { /* no marker: the last run stopped cleanly (or this is the first run) */ }
  try { lastAlive = Math.max(lastAlive || 0, fs.statSync(HEALTH_FILE).mtimeMs) || lastAlive; } catch (_) {}
  try { fs.unlinkSync(HEALTH_FILE); } catch (_) {} // a leftover file must not make the new run look healthy
  const noticeAt = Number(previous?.noticeAt) || 0;
  // Unclean starts in a row, inside the window: a clean stop deletes the marker and so resets the count. At CRASH_LOOP_STARTS the
  // bots are not auto-resumed (resumeBots), because a manager that dies at boot would otherwise log every bot in again on each restart.
  const now = Date.now();
  const uncleanStarts = unclean
    ? [...(Array.isArray(previous?.uncleanStarts) ? previous.uncleanStarts : []).map(Number)
      .filter(at => Number.isFinite(at) && now - at < CFG.CRASH_LOOP_WINDOW_MS), now].slice(-20)
    : [];
  const crashLoop = CFG.CRASH_LOOP_STARTS > 0 && uncleanStarts.length >= CFG.CRASH_LOOP_STARTS;
  writeRunMarker({ noticeAt, uncleanStarts });
  return { unclean, lastAlive, noticeAt, uncleanStarts, crashLoop };
};

// Tells each user who has bots that the manager came back after an unclean stop. Audible on purpose (see QUIET_KINDS).
const announceRestart = state => {
  if (!state?.unclean) return 0;
  // crash loop: one notice, not one per restart; the one exception is the start where auto-resume gets held
  const holdStart = state.crashLoop && state.uncleanStarts.length === CFG.CRASH_LOOP_STARTS;
  if (!holdStart && Date.now() - (state.noticeAt || 0) < CFG.RESTART_NOTICE_MIN_GAP_MS) return 0;
  const chats = new Map(); // userId -> chat of their first bot
  for (const info of mcBots.values()) {
    if (info.userId != null && info.chatId && !chats.has(String(info.userId))) chats.set(String(info.userId), info.chatId);
  }
  if (!chats.size) return 0;
  for (const [userId, chatId] of chats) {
    const owned = ownedBots(userId, null, null);
    const scheduled = owned.filter(info => info.settings?.schedule).length;
    const coming = owned.filter(info => info.resumePending || bootResumed.has(info.id)).length;
    const held = state.crashLoop
      ? `Auto-resume is <b>held</b>: the manager did not stop cleanly ${state.uncleanStarts.length} times in ${Math.round(CFG.CRASH_LOOP_WINDOW_MS / 60000)} min, ` +
        `so your bots stay offline instead of logging in again on every restart. Check the logs, then press <b>Reconnect</b> (📋 My Bots) or restart the manager cleanly.`
      : '';
    const resume = held || (coming ? `<b>${coming}</b> of them are reconnecting by themselves, one after another. ` : '') +
      (owned.length - coming ? `${coming ? 'The rest' : 'They'} stay paused until you press <b>Reconnect</b> (📋 My Bots)` : '') +
      (scheduled ? `${owned.length - coming ? '; ' : ''}the ${scheduled} bot(s) with a 🕐 schedule also start by themselves inside their window` : '') + '.';
    const seen = state.lastAlive ? ` Last sign of life: ${tgTime(state.lastAlive)}.` : '';
    notifyRich(chatId,
      `<h4>⚠️ Manager restarted after an unclean stop</h4>` +
      `<p>It did not shut down cleanly: a crash, <code>kill -9</code>, an out-of-memory kill or a power loss.${seen}</p>` +
      `<p>Your <b>${owned.length}</b> bot(s) were not connected while it was down. ${resume}</p>${rFooter('Restarted')}`,
      `⚠️ <b>Manager restarted after an unclean stop</b> (crash, kill, out-of-memory or power loss)` +
      `${state.lastAlive ? `\nLast sign of life: ${utcText(state.lastAlive)}` : ''}\n` +
      `Your ${owned.length} bot(s) were not connected while it was down. ${resume}`);
  }
  writeRunMarker({ noticeAt: Date.now(), uncleanStarts: state.uncleanStarts });
  return chats.size;
};

const telegramHealthy = () => S.lastTelegramOkAt > 0 && Date.now() - S.lastTelegramOkAt < CFG.HEARTBEAT_TG_STALE_MS;

const requestHeartbeat = url => new Promise(resolve => {
  const lib = url.protocol === 'https:' ? https : http;
  let settled = false;
  const done = result => {
    if (settled) return;
    settled = true;
    resolve(result);
  };
  const req = lib.request(url, { method: 'GET', headers: { 'User-Agent': 'mcafk-heartbeat' } }, res => {
    res.resume();
    res.on('end', () => done({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode }));
    res.on('error', error => done({ ok: false, error: String(error.code || error.message).slice(0, 60) }));
  });
  req.setTimeout(CFG.HEARTBEAT_TIMEOUT_MS, () => req.destroy(new Error('timeout')));
  req.on('error', error => done({ ok: false, error: String(error.code || error.message).slice(0, 60) }));
  req.end();
});

// The URL carries the check's secret, so it is never logged: only the host name is.
const setHeartbeatState = (state, detail) => {
  if (heartbeat.state === state) return;
  heartbeat.state = state;
  if (state === 'ok') console.log(`💓 Heartbeat OK (${HEARTBEAT_URL.hostname})`);
  else if (state === 'paused') console.error(`💔 Heartbeat paused: ${detail}`);
  else if (state === 'failing') console.error(`💔 Heartbeat ping to ${HEARTBEAT_URL.hostname} failed: ${detail}`);
};

const heartbeatTick = async () => {
  if (S.shuttingDown) return;
  if (!telegramHealthy()) {
    const seconds = S.lastTelegramOkAt ? Math.round((Date.now() - S.lastTelegramOkAt) / 1000) : null;
    heartbeat.error = seconds === null ? 'Telegram has not answered yet' : `Telegram has not answered for ${seconds}s`;
    if (HEARTBEAT_URL) setHeartbeatState('paused', heartbeat.error);
    return;
  }
  writeHealthFile(); // healthy: the Docker HEALTHCHECK sees a fresh file even without HEARTBEAT_URL
  if (!HEARTBEAT_URL) return;
  heartbeat.attemptAt = Date.now();
  const result = await requestHeartbeat(HEARTBEAT_URL);
  if (result.ok) {
    heartbeat.okAt = Date.now();
    heartbeat.error = null;
    setHeartbeatState('ok');
  } else {
    heartbeat.error = result.error || `HTTP ${result.status}`;
    setHeartbeatState('failing', heartbeat.error);
  }
};

const startHeartbeat = () => {
  if (HEARTBEAT_URL) console.log(`💓 Heartbeat enabled → ${HEARTBEAT_URL.hostname}, every ${Math.round(CFG.HEARTBEAT_INTERVAL_MS / 1000)}s while healthy`);
  setInterval(() => { void heartbeatTick(); }, CFG.HEARTBEAT_INTERVAL_MS).unref?.();
  void heartbeatTick();
};

const heartbeatLine = () => {
  if (!HEARTBEAT_URL) return 'off (set HEARTBEAT_URL)';
  if (heartbeat.state === 'ok') return `on · last ping ${uptime(Date.now() - heartbeat.okAt)} ago`;
  if (heartbeat.state === 'idle') return 'on · starting';
  return `⚠️ ${heartbeat.state}: ${heartbeat.error || 'unknown'}`;
};

// ---------------------------------------------------------------------------
// SHUTDOWN / BOOT
// ---------------------------------------------------------------------------

// Boot-time auto-resume: every bot that was meant to be running comes back, one start every CFG.RESUME_SPREAD_MS. The actual
// logins then go through the join queue (JOIN_GAP_MS apart per server), so a restart never hits a server with all bots at once.
const bootResumed = new Set(); // ids resumed by this run (the restart notice reports them)

const resumeBots = state => {
  if (state?.crashLoop) {
    // Held, not forgotten: wantedOnline keeps them saved as "running", so the next clean start brings them back by itself.
    const minutes = Math.round(CFG.CRASH_LOOP_WINDOW_MS / 60000);
    for (const info of mcBots.values()) {
      if (!info.resumePending) continue;
      info.resumePending = false;
      info.wantedOnline = true;
      info.userStopped = true; // the schedule loop must not start it either
      info.error = `Auto-resume held: ${state.uncleanStarts.length} unclean starts in ${minutes} min — press Reconnect once the manager is stable`;
    }
    return 0;
  }
  const pending = [...mcBots.values()].filter(info => info.resumePending);
  pending.forEach((info, index) => {
    const timer = setTimeout(() => {
      const latest = getBot(info.id);
      if (S.shuttingDown || latest !== info || !latest.resumePending) return; // removed, disconnected by hand or reconnected meanwhile
      latest.resumePending = false;
      const schedule = latest.settings?.schedule;
      if (schedule && !inScheduleWindow(new Date().getHours(), schedule.start, schedule.end)) {
        latest.error = `Scheduled off-hours (active ${schedule.start}:00–${schedule.end}:00)`; // the schedule loop starts it in its window
        saveData();
        return;
      }
      bootResumed.add(latest.id);
      latest.reconnectAttempts = 0;
      spawnBot(latest);
    }, index * CFG.RESUME_SPREAD_MS);
    timer.unref?.();
  });
  return pending.length;
};

// Disconnects every bot for the stop, first remembering which ones were meant to be running (saved as `paused: false`).
const stopAllBots = () => {
  for (const info of mcBots.values()) {
    info.wantedOnline = wantsOnline(info);
    info.resumePending = false;
    info.autoReconnect = false;
    destroyBot(info);
    info.status = 'offline';
    info.connectedAt = null;
  }
};

const shutdown = async (signal, exitCode = 0) => {
  if (S.shuttingDown) return;
  S.shuttingDown = true;
  console.log(`🛑 ${signal} received — shutting down cleanly…`);

  stopAllBots();
  if (S.saveTimer) clearTimeout(S.saveTimer);
  S.saveTimer = null;
  persistNow();

  try {
    await flushForwardsNow();
  } catch (_) {}

  try {
    await bot.stop();
  } catch (_) {}
  if (exitCode === 0) clearRunMarker(); // a crash (exit 1) leaves the marker so the next start reports it
  process.exit(exitCode);
};

const installProcessHandlers = () => {
  process.once('SIGINT', () => { void shutdown('SIGINT'); });
  process.once('SIGTERM', () => { void shutdown('SIGTERM'); });

  process.on('uncaughtException', error => {
    console.error('[UNCAUGHT]', error?.message || error);
    const msg = String(error?.message || '');
    if (
      msg.includes('destroy is not a function') ||
      msg.includes('dest.destroy') ||
      error?.code === 'ERR_STREAM_DESTROYED'
    ) {
      console.error('[UNCAUGHT] Non-fatal stream error — continuing…');
      return;
    }
    void shutdown('uncaughtException', 1); // non-zero so Restart=on-failure / Docker restart policies kick in
  });

  process.on('unhandledRejection', reason => {
    console.error('[UNHANDLED]', reason);
  });
};
if (!IS_TEST) installProcessHandlers();

// A bot that exhausted CFG.MAX_RECONNECTS doesn't stay down forever — retry
// at a slower, indefinite cadence so a long server outage still self-heals.
setInterval(() => {
  if (S.shuttingDown) return;
  for (const info of mcBots.values()) {
    if (info.autoReconnect && info.status === 'error' && /Max reconnect attempts reached/.test(info.error || '')) {
      const schedule = info.settings?.schedule;
      if (schedule && !inScheduleWindow(new Date().getHours(), schedule.start, schedule.end)) continue;
      info.reconnectAttempts = 0;
      spawnBot(info, false);
    }
  }
}, CFG.GIVEUP_RETRY_MS).unref?.();

const inScheduleWindow = (hour, start, end) => start === end
  ? true
  : (start < end ? (hour >= start && hour < end) : (hour >= start || hour < end));

// One pass of the schedule loop. A bot that is merely waiting out a backoff / lobby / kick / throttle timer is left alone
// (restarting it here used to skip its backoff and reset its attempt counter every minute), and so is a bot the user
// disconnected by hand. When the window closes, a bot that is waiting to retry is stopped too, not only a connected one.
const scheduleTick = (hour = new Date().getHours()) => {
  if (S.shuttingDown) return;
  for (const info of mcBots.values()) {
    const schedule = info.settings?.schedule;
    if (!schedule) continue;
    const shouldBeOn = inScheduleWindow(hour, schedule.start, schedule.end);
    if (shouldBeOn) {
      if (info.status === 'offline' && !info.reconnectTimer && !info.userStopped) {
        info.autoReconnect = true;
        info.reconnectAttempts = 0;
        spawnBot(info);
      }
      continue;
    }
    info.userStopped = false; // a manual Disconnect only holds until this window ends
    const waitingToRetry = info.status === 'offline' && Boolean(info.reconnectTimer);
    if (info.status === 'online' || info.status === 'connecting' || waitingToRetry) {
      info.autoReconnect = false;
      destroyBot(info);
      info.status = 'offline';
      info.connectedAt = null;
      info.error = `Scheduled off-hours (active ${schedule.start}:00–${schedule.end}:00)`;
      saveData();
    }
  }
};

setInterval(() => scheduleTick(), CFG.SCHEDULE_CHECK_MS).unref?.();

const BOT_COMMANDS = [
  { command: 'start', description: 'Open the main menu' },
  { command: 'help', description: 'Usage guide' },
  { command: 'forward', description: 'Forward chat to a group or channel' },
  { command: 'digest', description: 'Hourly status summary on/off' },
  { command: 'watch', description: 'Player join/leave watchlist' },
  { command: 'quiet', description: 'Silent alerts at night' },
  { command: 'status', description: 'Manager health, servers, backups' },
  { command: 'settings', description: 'Toggles, proximity, schedule' },
  { command: 'where', description: 'Location + session stats' },
  { command: 'deaths', description: 'Death history with coordinates' },
  { command: 'inventory', description: 'Items and equipment' },
  { command: 'walk', description: 'Move your bots' },
  { command: 'auto', description: 'Repeat an action on a timer' },
  { command: 'echo', description: 'Send a chat message' },
  { command: 'autoreply', description: 'Auto-reply to chat keywords' },
  { command: 'ai', description: 'AI chat panel' },
  { command: 'keys', description: 'Manage your AI API keys' },
];

Object.assign(R, { HEARTBEAT_URL, heartbeat, HEALTH_FILE, writeHealthFile, RUN_MARKER, writeRunMarker,
  clearRunMarker, bootRunState, announceRestart, telegramHealthy, requestHeartbeat, setHeartbeatState, heartbeatTick,
  startHeartbeat, heartbeatLine, bootResumed, resumeBots, stopAllBots, shutdown, installProcessHandlers,
  inScheduleWindow, scheduleTick, BOT_COMMANDS });
