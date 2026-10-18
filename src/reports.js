'use strict';
// Hourly digest and /status.
const R = require('./registry');
const { S } = R;
const { InlineKeyboard } = require('grammy');
const fs = require('fs');
const os = require('os');
const perfHooks = require('perf_hooks');
const { ALLOWED_USER_IDS, CFG, DATA, accessMode, alertOpts, backupInfo, bot, botLimitLine, digestSubs, dot, esc,
  fmtHp, locCell, locLine, mcBots, notifyRich, ownedBots, rFooter, rSend, rTable, rTime, refreshServerStatus, saveData, serverStatusList,
  snapshotLocation, statusLabel, styledText, tgTime, uptime, utcText } = R;

// ---------------------------------------------------------------------------
// HOURLY DIGEST (per-user opt-in) — /digest toggles it on and off
// ---------------------------------------------------------------------------

S.nextDigestAt = Date.now() + CFG.DIGEST_INTERVAL_MS;

const toggleDigest = (userId, chatId) => {
  const key = String(userId);
  if (digestSubs.has(key)) {
    digestSubs.delete(key);
    saveData();
    return false;
  }
  digestSubs.set(key, chatId);
  saveData();
  return true;
};

const digestKeyboard = userId => {
  const on = digestSubs.has(String(userId));
  return styledText(new InlineKeyboard(), on ? '🔕 Turn off digest' : '🔔 Turn on digest', 'digest_toggle', on ? 'danger' : 'success');
};

const digestToggleView = (on, userId) => ({
  rich: on
    ? `<h3>🔔 Hourly digest on</h3><p>A status summary of all your bots will be sent to this chat every hour.</p>` +
      `<blockquote>Send /digest again (or tap the button) to turn it off.</blockquote>`
    : `<h3>🔕 Hourly digest off</h3><p>Send /digest again (or tap the button) to turn it back on.</p>`,
  legacy: on
    ? `🔔 <b>Hourly digest on</b>\nA status summary of all your bots will be sent to this chat every hour.\nSend /digest again to turn it off.`
    : `🔕 <b>Hourly digest off</b>\nSend /digest again to turn it back on.`,
  keyboard: digestKeyboard(userId),
});

const digestView = (bots, { preview = false } = {}) => {
  const online = bots.filter(info => info.status === 'online').length;
  const totals = { deaths: 0, drops: 0 };
  const entries = bots.map(info => {
    const client = info.mcBot;
    const live = info.status === 'online' && client?.entity;
    const stats = info.hourStats || { deaths: 0, drops: 0 };
    totals.deaths += stats.deaths;
    totals.drops += stats.drops;
    return {
      info,
      snap: live ? snapshotLocation(client) : null,
      players: live && client.players ? Object.keys(client.players).length : null,
      vitals: live && client.health != null ? `❤️ ${fmtHp(client.health)} · 🍗 ${client.food ?? '?'}` : null,
      events: [stats.deaths ? `💀 ${stats.deaths}` : '', stats.drops ? `🔌 ${stats.drops}` : ''].filter(Boolean).join(' '),
    };
  });
  const period = preview ? 'so far this hour' : 'in the last hour';
  const summary = `${online}/${bots.length} online · 💀 ${totals.deaths} death(s) · 🔌 ${totals.drops} disconnect(s) ${period}`;
  const attention = bots.filter(info => info.status !== 'online' && info.error);

  const rows = entries.map(({ info, snap, players, vitals, events }) => [
    `${dot(info.status)} <b>${esc(info.name)}</b>`,
    `<b>${statusLabel(info.status)}</b>${info.connectedAt ? `<br>⏱ ${uptime(Date.now() - info.connectedAt)}` : ''}`,
    snap ? locCell(snap.pos, snap.dim) + (players != null ? `<br>👥 ${players}` : '') : '—',
    vitals || '—',
    events || '—',
  ]);
  const servers = serverStatusList(bots);
  const serverRows = servers.map(([key, st]) => st.ok
    ? [`<code>${esc(key)}</code>`, `${st.online ?? '?'}/${st.max ?? '?'}`, esc(st.motd || '—'), st.latency != null ? `${st.latency} ms` : '—']
    : [`<code>${esc(key)}</code>`, '—', '—', '⚫ no reply']);
  const serversRich = servers.length
    ? `<h4>🌐 Servers</h4>` + rTable(['Server', 'Players', 'MOTD', 'Ping'], serverRows)
    : '';
  const serversLegacy = servers.length
    ? `\n\n🌐 <b>Servers</b>\n` + servers.map(([key, st]) => st.ok
      ? `<code>${esc(key)}</code> — 👥 ${st.online ?? '?'}/${st.max ?? '?'}${st.latency != null ? ` · ${st.latency} ms` : ''}${st.motd ? `\n    ${esc(st.motd)}` : ''}`
      : `<code>${esc(key)}</code> — ⚫ no reply`).join('\n')
    : '';
  const rich = `<h3>🕐 ${preview ? 'Digest preview' : 'Hourly digest'}</h3><p>${esc(summary)}</p>` +
    rTable(['Bot', 'Status', 'Where', 'Vitals', 'Events'], rows) +
    (attention.length
      ? `<details><summary>⚠️ Needs attention (${attention.length})</summary>` +
        attention.map(info => `<p><b>${esc(info.name)}</b> — <code>${esc(String(info.error).slice(0, 160))}</code></p>`).join('') +
        `</details>`
      : '') +
    serversRich +
    `<footer>${preview ? 'Preview' : 'Digest'} ${rTime()} · next ${tgTime(S.nextDigestAt, 't')}</footer>`;
  const lines = entries.map(({ info, snap, players, vitals, events }) =>
    `${dot(info.status)} <b>${esc(info.name)}</b> — ${statusLabel(info.status)}` +
    (info.connectedAt ? ` · ⏱ ${uptime(Date.now() - info.connectedAt)}` : '') +
    (snap ? `\n    📍 ${locLine(snap.pos, snap.dim)}${players != null ? ` · 👥 ${players}` : ''}` : '') +
    (vitals ? `\n    ${vitals}` : '') + (events ? `\n    ${events}` : ''));
  const legacy = `🕐 <b>${preview ? 'Digest preview' : 'Hourly digest'}</b>\n${esc(summary)}\n\n${lines.join('\n')}` +
    (attention.length ? `\n\n⚠️ <b>Needs attention</b>\n${attention.map(info => `${esc(info.name)}: <code>${esc(String(info.error).slice(0, 160))}</code>`).join('\n')}` : '');
  return { rich, legacy: legacy + serversLegacy };
};

const sendDigest = async (chatId, userId, options) => {
  const bots = ownedBots(userId, null, null);
  if (!bots.length) return null;
  await refreshServerStatus(bots);
  const view = digestView(bots, options);
  const silent = options?.preview ? undefined : alertOpts({ userId }, 'digest');
  return rSend(chatId, view.rich, view.legacy, digestKeyboard(userId), silent).catch(() => null);
};

bot.command('digest', async ctx => {
  const on = toggleDigest(ctx.from.id, ctx.chat.id);
  const view = digestToggleView(on, ctx.from.id);
  await rSend(ctx.chat.id, view.rich, view.legacy, view.keyboard);
  if (on) await sendDigest(ctx.chat.id, ctx.from.id, { preview: true });
});

setInterval(() => {
  if (S.shuttingDown) return;
  S.nextDigestAt = Date.now() + CFG.DIGEST_INTERVAL_MS;
  for (const [key, chatId] of digestSubs) void sendDigest(chatId, key);
  for (const info of mcBots.values()) info.hourStats = { deaths: 0, drops: 0 };
}, CFG.DIGEST_INTERVAL_MS).unref?.();

// ---------------------------------------------------------------------------
// TELEGRAM HANDLERS
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// STATUS — /status: health of the manager, your bots, servers and backups
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// LOAD — all bots live in ONE Node process, and JavaScript runs on ONE core, so on a multi-core VPS the first wall is usually
// that core, not RAM. Once a minute the manager records its CPU share (process.cpuUsage / wall time, 100 = one full core) and
// the event-loop lag (perf_hooks.monitorEventLoopDelay). /status shows both, and the console says so once when they stay high.
// ---------------------------------------------------------------------------

const LOAD_RESOLUTION_MS = 20; // the histogram's timer period; an idle loop reads ~this much, so it is subtracted
S.load = { at: 0, cpuPct: null, lagP99: null, lagMax: null, hot: 0, saturated: false, noticeAt: 0 };
let loadHistogram = null;
try {
  loadHistogram = perfHooks.monitorEventLoopDelay({ resolution: LOAD_RESOLUTION_MS });
  loadHistogram.enable();
} catch (_) { loadHistogram = null; } // runtimes without it (some Bun builds): CPU is still reported, lag shows "n/a"
let loadPrev = { cpu: process.cpuUsage(), at: Date.now() };

// Tells each user who has bots, once per saturated spell (and at most once per CFG.LOAD_NOTICE_MIN_GAP_MS), that the manager is at
// its CPU limit. Same recipients as the unclean-restart notice: the chat of each user's first bot. Silent in the user's quiet hours.
const announceLoad = (now = Date.now()) => {
  const load = S.load;
  if (S.shuttingDown || now - (load.noticeAt || 0) < CFG.LOAD_NOTICE_MIN_GAP_MS) return 0;
  const chats = new Map(); // userId -> chat of their first bot
  for (const info of mcBots.values()) {
    if (info.userId != null && info.chatId && !chats.has(String(info.userId))) chats.set(String(info.userId), info.chatId);
  }
  if (!chats.size) return 0;
  load.noticeAt = now;
  const online = [...mcBots.values()].filter(info => info.status === 'online').length;
  const lag = load.lagP99 === null ? 'n/a' : `${load.lagP99} ms`;
  for (const [userId, chatId] of chats) {
    notifyRich(chatId,
      `<h4>⚠️ Manager is at its CPU limit</h4>` +
      `<p>CPU <b>${load.cpuPct}%</b> of one core and event-loop lag p99 <b>${esc(lag)}</b> for ${CFG.LOAD_WARN_SAMPLES} minutes in a row, with <b>${online}</b> bot(s) online manager-wide. ` +
      `Bots may react late. Do not add more bots here; the other options are in the README (<i>Sizing</i>).</p>${rFooter('Load')}`,
      `⚠️ <b>Manager is at its CPU limit</b>\nCPU ${load.cpuPct}% of one core, loop lag p99 ${esc(lag)}, ${online} bot(s) online manager-wide. ` +
      `Bots may react late; do not add more bots here (README → Sizing).`,
      alertOpts({ userId }, 'load'));
  }
  return chats.size;
};

const loadSample = (now = Date.now()) => {
  const cpu = process.cpuUsage();
  const wallMs = now - loadPrev.at;
  const load = S.load;
  if (wallMs > 0) {
    const busyMs = (cpu.user - loadPrev.cpu.user + cpu.system - loadPrev.cpu.system) / 1000;
    load.cpuPct = Math.max(0, Math.round((busyMs / wallMs) * 100));
  }
  loadPrev = { cpu, at: now };
  if (loadHistogram && loadHistogram.count > 0) {
    load.lagP99 = Math.max(0, Math.round(loadHistogram.percentile(99) / 1e6 - LOAD_RESOLUTION_MS));
    load.lagMax = Math.max(0, Math.round(loadHistogram.max / 1e6 - LOAD_RESOLUTION_MS));
    loadHistogram.reset();
  }
  load.at = now;
  const high = (load.cpuPct ?? 0) >= CFG.LOAD_WARN_CPU_PCT || (load.lagP99 ?? 0) >= CFG.LOAD_WARN_LAG_MS;
  load.hot = high ? load.hot + 1 : 0;
  const saturated = load.hot >= CFG.LOAD_WARN_SAMPLES;
  if (saturated && !load.saturated) {
    console.error(`⚠️ Load: CPU ${load.cpuPct}% of one core, event-loop lag p99 ${load.lagP99 ?? 'n/a'} ms for ${CFG.LOAD_WARN_SAMPLES} samples in a row. One core is the limit now: stop adding bots here (README → Sizing).`);
    announceLoad(now);
  } else if (!saturated && load.saturated) {
    console.log(`✅ Load back to normal: CPU ${load.cpuPct}% of one core, lag p99 ${load.lagP99 ?? 'n/a'} ms.`);
  }
  load.saturated = saturated;
  return load;
};

const loadLine = () => {
  const load = S.load;
  if (!load.at) return `measuring… (first sample after ${Math.round(CFG.LOAD_SAMPLE_MS / 1000)} s)`;
  const cores = typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length;
  const lag = load.lagP99 === null ? 'n/a' : `p99 ${load.lagP99} ms, max ${load.lagMax} ms`;
  return `CPU ${load.cpuPct}% of one core (host has ${cores}) · loop lag ${lag}` +
    (load.saturated ? ' · ⚠️ one core is the limit: more bots here will lag' : '');
};

setInterval(() => { if (!S.shuttingDown) loadSample(); }, CFG.LOAD_SAMPLE_MS).unref?.();

const fmtMb = bytes => `${Math.round(bytes / 1048576)} MB`;

// RSS and heap, plus RSS divided by the bots online in the whole manager (the process total is shared by all users' bots).
// The division includes the manager's own base cost, so it overstates the price of ONE more bot, most at low counts; for the
// marginal cost compare two readings: (RSS at N2 - RSS at N1) / (N2 - N1).
const memLine = mem => {
  const online = [...mcBots.values()].filter(info => info.status === 'online').length;
  return `${fmtMb(mem.rss)} RSS · ${fmtMb(mem.heapUsed)} heap` +
    (online ? ` · ≈${fmtMb(mem.rss / online)} per online bot (${online} online)` : '');
};

const statusView = (userId, chatId, username) => {
  const owned = ownedBots(userId, chatId, username);
  const count = status => owned.filter(info => info.status === status).length;
  const pairs = R.fwdPairs(userId);
  const active = pairs.filter(([, entry]) => entry.active).length;
  const queued = pairs.reduce((sum, [, entry]) => sum + (R.fwdBuffers.get(entry)?.lines.length || 0), 0);
  const mem = process.memoryUsage();
  const runtime = process.versions.bun ? `Bun ${process.versions.bun}` : `Node ${process.versions.node}`;
  const backups = backupInfo();
  let saved = null;
  let size = 0;
  try {
    const st = fs.statSync(DATA);
    saved = st.mtimeMs;
    size = st.size;
  } catch (_) {}
  const servers = serverStatusList(owned);
  const serverCell = servers.length
    ? servers.map(([key, st]) => st.ok
      ? `<code>${esc(key)}</code> 👥 ${st.online ?? '?'}/${st.max ?? '?'}${st.latency != null ? ` · ${st.latency} ms` : ''}`
      : `<code>${esc(key)}</code> ⚫ no reply`).join('<br>')
    : '—';
  const access = accessMode() === 'restricted' ? `🔒 restricted (${ALLOWED_USER_IDS.size} user(s))`
    : accessMode() === 'open' ? '🌐 open to anyone (ALLOW_OPEN_ACCESS=1)' : '⛔ closed — set ALLOWED_USER_IDS';
  const limits = botLimitLine(userId, chatId, username);
  const botsCell = `🟢 ${count('online')} online · 🟡 ${count('connecting')} connecting · 🔴 ${count('offline') + count('error')} down (of ${owned.length})`;
  const rich = `<h3>🩺 Status</h3>` +
    rTable(['Property', 'Value'], [
      ['⏱ Manager uptime', uptime(process.uptime() * 1000)],
      ['🧠 Memory', `${memLine(mem)}`],
      ['⚙️ Runtime', esc(runtime)],
      ['📈 Load', esc(loadLine())],
      ['🤖 Your bots', botsCell],
      ['🚧 Bot limits', esc(limits)],
      ['📡 Forwards', `${active} on · ${pairs.length - active} paused · ${queued} line(s) queued`],
      ['🌐 Servers', serverCell],
      ['💾 Data', saved ? `${(size / 1024).toFixed(1)} KB · saved ${tgTime(saved, 't')}` : '—'],
      ['🗄 Backups', `${backups.count}/${CFG.BACKUP_KEEP}${backups.newestAt ? ` · newest ${tgTime(backups.newestAt)}` : ''}`],
      ['🔒 Access', access],
      ['🌙 Quiet hours', esc(R.quietLine(userId))],
      ['🚪 Join queue', R.joinQueueLine(owned)],
      ['👁 View distance', esc(R.viewDistanceLine())],
      ['💓 Heartbeat', R.heartbeatLine()],
    ]) +
    `<footer>Status ${rTime()}</footer>`;
  const legacy = `🩺 <b>Status</b>\n\n⏱ Uptime: <b>${uptime(process.uptime() * 1000)}</b>\n` +
    `🧠 Memory: ${memLine(mem)}\n⚙️ ${esc(runtime)}\n📈 ${esc(loadLine())}\n` +
    `🤖 ${botsCell}\n🚧 Bot limits: ${limits}\n📡 Forwards: ${active} on · ${pairs.length - active} paused · ${queued} queued\n` +
    (servers.length ? servers.map(([key, st]) => st.ok
      ? `🌐 <code>${esc(key)}</code> 👥 ${st.online ?? '?'}/${st.max ?? '?'}`
      : `🌐 <code>${esc(key)}</code> ⚫ no reply`).join('\n') + '\n' : '') +
    `💾 Data: ${saved ? `${(size / 1024).toFixed(1)} KB · saved ${utcText(saved)}` : '—'}\n` +
    `🗄 Backups: ${backups.count}/${CFG.BACKUP_KEEP}${backups.newestAt ? ` · newest ${utcText(backups.newestAt)}` : ''}\n🔒 ${access}\n` +
    `🌙 Quiet hours: ${R.quietLine(userId)}\n🚪 Join queue: ${R.joinQueueLine(owned)}\n👁 View distance: ${R.viewDistanceLine()}\n💓 Heartbeat: ${R.heartbeatLine()}`;
  const keyboard = new InlineKeyboard().text('🔃 Refresh', 'status_refresh').text('⬅️ Main Menu', 'main_menu');
  return { rich, legacy, keyboard };
};

bot.command('status', async ctx => {
  const view = statusView(ctx.from.id, ctx.chat.id, ctx.from.username);
  await rSend(ctx.chat.id, view.rich, view.legacy, view.keyboard);
});

Object.assign(R, { toggleDigest, digestKeyboard, digestToggleView, digestView, sendDigest, fmtMb, statusView, loadSample, loadLine, announceLoad, memLine });
