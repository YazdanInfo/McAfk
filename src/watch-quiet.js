'use strict';
// /watch, /quiet and the quick-add forward helper.
const R = require('./registry');
const { InlineKeyboard } = require('grammy');
const { CFG, IDLE_VIEW_DISTANCE, QUIET_DEFAULT_WINDOW, VIEW_DISTANCE, bot, botUsername, chatStates, esc, forwardMap,
  fwdEntry, fwdPairs, isQuietNow, joinWaiting, localParts, ownedBots, parseTz, quietPrefs, rFooter, rSend, rTable,
  saveData, styledText, watchlists } = R;

// ---------------------------------------------------------------------------
// WATCHLIST — /watch: join/leave alerts for specific players
// ---------------------------------------------------------------------------

const WATCH_NAME = /^[A-Za-z0-9_.]{1,17}$/;
const getWatch = userId => watchlists.get(String(userId)) || [];

const addWatchNames = (userId, names) => {
  const list = [...getWatch(userId)];
  const result = { added: [], dup: [], invalid: [], full: false };
  for (const name of names) {
    if (!WATCH_NAME.test(name)) { result.invalid.push(name); continue; }
    if (list.some(entry => entry.toLowerCase() === name.toLowerCase())) { result.dup.push(name); continue; }
    if (list.length >= CFG.WATCH_MAX) { result.full = true; break; }
    list.push(name);
    result.added.push(name);
  }
  if (result.added.length) {
    watchlists.set(String(userId), list);
    saveData();
  }
  return result;
};

const removeWatchName = (userId, name) => {
  const list = getWatch(userId);
  const next = list.filter(entry => entry.toLowerCase() !== String(name).toLowerCase());
  if (next.length === list.length) return false;
  if (next.length) watchlists.set(String(userId), next);
  else watchlists.delete(String(userId));
  saveData();
  return true;
};

const watchNote = result => [
  result.added.length ? `✅ Added: ${result.added.map(esc).join(', ')}` : '',
  result.dup.length ? `ℹ️ Already watching: ${result.dup.map(esc).join(', ')}` : '',
  result.invalid.length ? `❌ Invalid name: ${result.invalid.map(esc).join(', ')} (1–17 letters, digits, _ or .)` : '',
  result.full ? `⚠️ Limit of ${CFG.WATCH_MAX} names reached.` : '',
].filter(Boolean).join('<br>');

const watchView = (userId, owned, note = '') => {
  const names = getWatch(userId);
  const online = new Map();
  for (const info of owned) {
    if (info.status !== 'online' || !info.mcBot?.players) continue;
    for (const player of Object.keys(info.mcBot.players)) {
      if (!online.has(player.toLowerCase())) online.set(player.toLowerCase(), `${info.host}:${info.port}`);
    }
  }
  const keyboard = new InlineKeyboard();
  names.forEach((name, index) => {
    keyboard.text(`🗑 ${name}`, `wl:rm:${name}`);
    if (index % 2 === 1) keyboard.row();
  });
  if (names.length % 2 === 1) keyboard.row();
  styledText(keyboard, '➕ Add players', 'wl:add', 'primary').row();
  keyboard.text('⬅️ Main Menu', 'main_menu');
  if (!names.length) {
    return {
      rich: `<h3>👀 Watchlist</h3>` + (note ? `<p>${note}</p>` : '') +
        `<p>Get an alert when specific players join or leave a server where one of your bots is online.</p>` +
        `<blockquote>Press <b>➕ Add players</b>, or send <code>/watch add Notch Herobrine</code></blockquote>` + rFooter('Watchlist'),
      legacy: `👀 <b>Watchlist</b>\n${note ? `${note}\n` : ''}\nGet an alert when specific players join or leave. Press ➕ Add players or send /watch add Notch Herobrine`,
      keyboard,
    };
  }
  const rows = names.map(name => {
    const where = online.get(name.toLowerCase());
    return [`<b>${esc(name)}</b>`, where ? `🟢 online · <code>${esc(where)}</code>` : '⚫ not seen'];
  });
  const rich = `<h3>👀 Watchlist (${names.length})</h3>` + (note ? `<p>${note}</p>` : '') +
    rTable(['Player', 'Now'], rows) +
    `<p><i>Alerts go to the chat where each bot was added. "Now" only covers servers where your bots are online.</i></p>` + rFooter('Watchlist');
  const legacy = `👀 <b>Watchlist (${names.length})</b>\n${note ? `${note}\n` : ''}\n` +
    names.map(name => {
      const where = online.get(name.toLowerCase());
      return `${where ? '🟢' : '⚫'} <b>${esc(name)}</b>${where ? ` — ${esc(where)}` : ''}`;
    }).join('\n');
  return { rich, legacy, keyboard };
};

async function handleWatchCallback(ctx, data, edit, answer) {
  const userId = ctx.from.id;
  const chatId = ctx.chat.id;
  const owned = ownedBots(userId, chatId, ctx.from.username);
  const [, action, ...rest] = data.split(':');
  const show = view => edit(view.legacy, view.keyboard, view.rich);
  if (action === 'home') {
    chatStates.delete(chatId);
    await show(watchView(userId, owned));
    return answer();
  }
  if (action === 'add') {
    chatStates.set(chatId, { action: 'watch_add', userId, expires: Date.now() + CFG.WIZARD_TTL_MS });
    await edit(
      `➕ <b>Add players</b>\nSend one or more names, e.g. <code>Notch Herobrine</code>.`,
      new InlineKeyboard().text('❌ Cancel', 'wl:home'),
      `<h3>➕ Add players</h3><p>Send one or more names, e.g. <code>Notch Herobrine</code>.</p>`,
    );
    return answer('✏️ Type the names in chat');
  }
  if (action === 'rm') {
    const removed = removeWatchName(userId, rest.join(':'));
    await show(watchView(userId, owned));
    return answer(removed ? '🗑 Removed' : 'Not in the list');
  }
  return answer();
}

async function handleWatchText(ctx, state, text) {
  if (state.userId !== ctx.from?.id) return;
  const chatId = ctx.chat.id;
  chatStates.delete(chatId);
  const owned = ownedBots(ctx.from.id, chatId, ctx.from.username);
  if (state.expires < Date.now()) return ctx.reply('⌛ That took too long. Send /watch to start again.');
  let note = '';
  if (!/^cancel$/i.test(text)) {
    note = watchNote(addWatchNames(ctx.from.id, text.split(/[\s,]+/).filter(Boolean)));
  }
  const view = watchView(ctx.from.id, owned, note);
  return rSend(chatId, view.rich, view.legacy, view.keyboard);
}

bot.command('watch', async ctx => {
  const owned = ownedBots(ctx.from.id, ctx.chat.id, ctx.from.username);
  const args = ctx.message.text.trim().split(/\s+/).slice(1);
  const sub = (args[0] || '').toLowerCase();
  let note = '';
  if (sub === 'remove' || sub === 'rm' || sub === 'del') {
    const removed = args.slice(1).filter(name => removeWatchName(ctx.from.id, name));
    note = removed.length ? `🗑 Removed: ${removed.map(esc).join(', ')}` : 'ℹ️ Nothing to remove.';
  } else if (args.length) {
    const names = sub === 'add' ? args.slice(1) : args;
    note = watchNote(addWatchNames(ctx.from.id, names));
  }
  const view = watchView(ctx.from.id, owned, note);
  await rSend(ctx.chat.id, view.rich, view.legacy, view.keyboard);
});

// ---------------------------------------------------------------------------
// QUIET HOURS UI — /quiet
// ---------------------------------------------------------------------------

const pad2 = n => String(n).padStart(2, '0');
const QUIET_WINDOW_RE = /^(\d{1,2})(?::(\d{2}))?\s*(?:-|–|—|to|\s)\s*(\d{1,2})(?::(\d{2}))?$/i;

const setQuiet = (userId, patch) => {
  const key = String(userId);
  const next = { on: false, ...QUIET_DEFAULT_WINDOW, tz: null, ...(quietPrefs.get(key) || {}), ...patch };
  quietPrefs.set(key, next);
  saveData();
  return next;
};

const quietLine = userId => {
  const prefs = quietPrefs.get(String(userId));
  if (!prefs?.on) return 'off (/quiet)';
  return `${pad2(prefs.start)}:00–${pad2(prefs.end)}:00 · ${prefs.tz || 'server clock'}${isQuietNow(userId) ? ' · silent now' : ''}`;
};

const viewDistanceLine = () => (VIEW_DISTANCE === null
  ? 'mineflayer default (largest world, most memory)'
  : `${VIEW_DISTANCE} chunks (raised per bot when a proximity alert needs more)`) +
  ' · per-bot override in /settings' +
  (IDLE_VIEW_DISTANCE === null ? '' : ` · idle bots drop to ${IDLE_VIEW_DISTANCE} after ${Math.round(CFG.IDLE_VIEW_AFTER_MS / 60000)} min`);

const joinQueueLine = owned => CFG.JOIN_GAP_MS
  ? `${joinWaiting(owned)} waiting · ${Math.round(CFG.JOIN_GAP_MS / 100) / 10}s between joins per server`
  : 'off';

// Applies `/quiet <args>`; returns a short HTML note for the panel.
const applyQuietArgs = (userId, rawArgs) => {
  const text = String(rawArgs || '').trim().replace(/\s+/g, ' ');
  if (!text) return '';
  const lower = text.toLowerCase();
  if (lower === 'off') {
    if (quietPrefs.has(String(userId))) setQuiet(userId, { on: false });
    return '🔔 Quiet hours are <b>off</b>: every alert makes a sound again.';
  }
  if (lower === 'on') {
    const next = setQuiet(userId, { on: true });
    return `🌙 Quiet hours are <b>on</b>: ${pad2(next.start)}:00–${pad2(next.end)}:00.`;
  }
  const tzMatch = text.match(/^(?:tz|timezone|zone)\s*(.*)$/i);
  if (tzMatch) {
    const parsed = parseTz(tzMatch[1]);
    if (!parsed) return `❌ Unknown timezone <code>${esc(tzMatch[1])}</code>. Try <code>Asia/Baku</code>, <code>Europe/London</code>, <code>UTC+4</code> or <code>UTC-5:30</code>.`;
    setQuiet(userId, { tz: parsed.tz });
    return parsed.tz ? `🕐 Timezone set to <code>${esc(parsed.tz)}</code>.` : '🕐 Using the server clock.';
  }
  const match = text.match(QUIET_WINDOW_RE);
  if (!match) return '❌ I did not understand that. Examples: <code>/quiet 23-7</code> · <code>/quiet tz Asia/Baku</code> · <code>/quiet off</code>';
  const [start, end] = [Number(match[1]), Number(match[3])];
  if ((match[2] && match[2] !== '00') || (match[4] && match[4] !== '00')) return '❌ Quiet hours use whole hours, for example <code>/quiet 23-7</code>.';
  if (start > 23 || end > 23) return '❌ Hours go from 0 to 23.';
  if (start === end) return '❌ Start and end must differ (equal hours would mute all day).';
  setQuiet(userId, { start, end, on: true });
  return `🌙 Quiet hours <b>${pad2(start)}:00–${pad2(end)}:00</b> are on.`;
};

const quietKeyboard = userId => {
  const on = Boolean(quietPrefs.get(String(userId))?.on);
  const keyboard = styledText(new InlineKeyboard(), on ? '🔔 Turn off quiet hours' : '🌙 Turn on quiet hours', 'quiet:toggle', on ? 'danger' : 'success').row();
  return keyboard.text('⬅️ Main Menu', 'main_menu');
};

const quietView = (userId, note = '') => {
  const prefs = quietPrefs.get(String(userId)) || null;
  const on = Boolean(prefs?.on);
  const span = prefs || QUIET_DEFAULT_WINDOW;
  const windowText = `${pad2(span.start)}:00–${pad2(span.end)}:00`;
  const clock = prefs ? localParts(prefs.tz, Date.now()) : null;
  const zone = prefs?.tz || 'server clock';
  const state = on ? (isQuietNow(userId) ? 'On · silent right now' : 'On · audible right now') : 'Off';
  const tzWarning = !prefs?.tz;
  const rich = `<h3>🌙 Quiet hours</h3>` + (note ? `<p>${note}</p>` : '') +
    rTable(['Property', 'Value'], [
      ['State', `<b>${esc(state)}</b>`],
      ['Window', `<code>${windowText}</code>`],
      ['Timezone', `<code>${esc(zone)}</code>${clock ? ` · now ${pad2(clock.hour)}:${pad2(clock.minute)}` : ''}`],
    ]) +
    (tzWarning ? `<blockquote>⚠️ No timezone set, so the window follows the server's clock. Send <code>/quiet tz Asia/Baku</code> (or <code>UTC+4</code>).</blockquote>` : '') +
    `<details><summary>What goes silent, what never does</summary>` +
    `<p>🔕 <b>Silent</b> (delivered without sound): connected · reconnecting · kicked / errors · name in use / server full · server offline notices · watchlist · hourly digest</p>` +
    `<p>🔔 <b>Always audible</b>: bans and whitelist · deaths · stuck alerts · gave up reconnecting · damage / low health · player nearby · restart notice</p>` +
    `<p><i>Forwarded game chat is not an alert and is not changed.</i></p></details>` +
    `<blockquote><code>/quiet 23-7</code> · <code>/quiet tz Asia/Baku</code> · <code>/quiet off</code></blockquote>${rFooter('Quiet')}`;
  const legacy = `🌙 <b>Quiet hours</b>\n${note ? `${note}\n` : ''}\n` +
    `State: <b>${esc(state)}</b>\nWindow: <code>${windowText}</code>\nTimezone: <code>${esc(zone)}</code>${clock ? ` (now ${pad2(clock.hour)}:${pad2(clock.minute)})` : ''}\n` +
    (tzWarning ? `⚠️ No timezone set — using the server clock. Send /quiet tz Asia/Baku (or UTC+4).\n` : '') +
    `\n🔕 Silent: connected, reconnecting, kicked/errors, name in use / server full, server offline, watchlist, digest.\n` +
    `🔔 Always audible: bans, whitelist, deaths, stuck, gave up reconnecting, damage, player nearby, restart notice.\n\n` +
    `/quiet 23-7 · /quiet tz Asia/Baku · /quiet off`;
  return { rich, legacy, keyboard: quietKeyboard(userId) };
};

async function handleQuietCallback(ctx, data, edit, answer) {
  const userId = ctx.from.id;
  const [, action] = data.split(':');
  let note = '';
  if (action === 'toggle') {
    const on = Boolean(quietPrefs.get(String(userId))?.on);
    note = applyQuietArgs(userId, on ? 'off' : 'on');
  }
  const view = quietView(userId, note);
  await edit(view.legacy, view.keyboard, view.rich);
  return answer(action === 'toggle' ? (quietPrefs.get(String(userId))?.on ? '🌙 Quiet hours on' : '🔔 Quiet hours off') : '');
}

bot.command('quiet', async ctx => {
  const note = applyQuietArgs(ctx.from.id, ctx.message.text.trim().replace(/^\/quiet(?:@\w+)?/i, ''));
  const view = quietView(ctx.from.id, note);
  await rSend(ctx.chat.id, view.rich, view.legacy, view.keyboard);
});

// In a group, /forward adds that group right away (pause/remove later from the private manager).
const quickAddGroupForward = async ctx => {
  if (ctx.chat.type === 'channel' || !ctx.from) return;
  const userId = ctx.from.id;
  const key = String(userId);
  const chatId = String(ctx.chat.id);
  const owned = ownedBots(userId, ctx.chat.id, ctx.from.username);
  let entry = fwdEntry(userId, chatId);
  let headline;
  if (!entry) {
    if (fwdPairs(userId).length >= CFG.FORWARD_MAX) {
      return ctx.reply(`❌ You already have ${CFG.FORWARD_MAX} forwards — remove one in a private chat with me (/forward).`);
    }
    if (!forwardMap.has(key)) forwardMap.set(key, new Map());
    entry = {
      active: true,
      title: ctx.chat.title || '',
      type: ctx.chat.type === 'supergroup' ? 'supergroup' : 'group',
      addedAt: Date.now(),
      bots: null,
      lastError: null,
      filter: 'all',
      twoWay: false,
    };
    forwardMap.get(key).set(chatId, entry);
    saveData();
    headline = '✅ Forwarding enabled';
  } else if (!entry.active) {
    entry.active = true;
    entry.lastError = null;
    saveData();
    headline = '🟢 Forwarding resumed';
  } else {
    headline = '📡 Already forwarding';
  }
  const online = owned.filter(info => info.status === 'online').length;
  const username = botUsername() || ctx.me?.username;
  const keyboard = username ? new InlineKeyboard().url('⚙️ Manage forwards', `https://t.me/${username}?start=forward`) : undefined;
  await rSend(ctx.chat.id,
    `<h3>${headline}</h3><p>This chat receives Minecraft chat from your bots.</p>` +
    rTable(['🤖 Bots', '🟢 Online'], [[`<b>${owned.length}</b>`, `<b>${online}</b>`]]) + rFooter('Forward'),
    `${headline}\nThis chat receives Minecraft chat from your bots.\n🤖 <b>${owned.length}</b> bot(s) — <b>${online}</b> online`,
    keyboard);
};

Object.assign(R, { WATCH_NAME, getWatch, addWatchNames, removeWatchName, watchNote, watchView, handleWatchCallback,
  handleWatchText, pad2, QUIET_WINDOW_RE, setQuiet, quietLine, viewDistanceLine, joinQueueLine, applyQuietArgs,
  quietKeyboard, quietView, handleQuietCallback, quickAddGroupForward });
