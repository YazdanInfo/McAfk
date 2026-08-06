'use strict';

const { Bot, InlineKeyboard } = require('grammy');
const mineflayer = require('mineflayer');
const fs = require('fs');
const path = require('path');

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!TOKEN) { console.error('TELEGRAM_BOT_TOKEN not set'); process.exit(1); }

const DATA = path.join(__dirname, 'userdata.json');
const DATA_TMP = DATA + '.tmp';

const mcBots = new Map();
const chatStates = new Map();
const forwardMap = new Map();

const bot = new Bot(TOKEN);

let loading = false;

function saveData() {
  if (loading) return;
  const out = {
    bots: [...mcBots.values()].filter(b => b.autoReconnect !== false || b.status !== 'offline').map(b => ({
      name: b.name, host: b.host, port: b.port,
      version: b.version, chatId: b.chatId, ownerUsername: b.ownerUsername,
      paused: !b.autoReconnect,
    })),
    forwards: Object.fromEntries([...forwardMap].map(([u, s]) => [u, [...s]])),
  };
  try {
    fs.writeFileSync(DATA_TMP, JSON.stringify(out), 'utf8');
    fs.renameSync(DATA_TMP, DATA);
  } catch (e) { console.error('saveData:', e.message); }
}

function loadData() {
  if (!fs.existsSync(DATA)) { fs.writeFileSync(DATA, JSON.stringify({ bots: [], forwards: {} }), 'utf8'); return; }
  loading = true;
  try {
    const raw = JSON.parse(fs.readFileSync(DATA, 'utf8'));
    for (const [u, ids] of Object.entries(raw.forwards || {})) forwardMap.set(u, new Set(ids));
    for (const b of (raw.bots || [])) {
      spawnBot(b.name, b.host, b.port, b.version, b.chatId, b.ownerUsername);
      if (b.paused) {
        const info = mcBots.get(b.name);
        if (info) { info.autoReconnect = false; destroyBot(info); info.status = 'offline'; info.error = 'Was disconnected before last shutdown'; }
      }
    }
  } catch (e) { console.error('loadData:', e.message); }
  loading = false;
}

const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const uptime = ms => {
  const s = Math.floor(ms / 1000), m = Math.floor(s / 60), h = Math.floor(m / 60), d = Math.floor(h / 24);
  if (d > 0) return `${d}d ${h % 24}h`;
  if (h > 0) return `${h}h ${m % 60}m`;
  if (m > 0) return `${m}m ${s % 60}s`;
  return `${s}s`;
};

const dot = s => s === 'online' ? '🟢' : s === 'connecting' ? '🟡' : s === 'error' ? '🔴' : '⚫';
const norm = u => String(u || '').replace(/^@/, '').toLowerCase();
const ownerTag = b => b.ownerUsername ? `@${b.ownerUsername}` : `#${b.chatId}`;

const notify = (chatId, text) => bot.api.sendMessage(chatId, text, { parse_mode: 'HTML' }).catch(() => {});
const notifyPlain = (chatId, text) => bot.api.sendMessage(chatId, text).catch(() => {});

function mainMenuText() {
  let online = 0;
  for (const b of mcBots.values()) if (b.status === 'online') online++;
  return `🤖 <b>Minecraft Bot Manager</b>\n\nConnect fake offline players to any Minecraft server.\nSupports ViaVersion · ViaBackwards · ViaRewind\n\n💎 <b>Bots:</b> ${mcBots.size} registered  🟢 ${online} online`;
}

function botListText() {
  if (!mcBots.size) return `🤖 <b>No bots running</b>\n\nPress <b>➕ Add Bot</b> to connect one.`;
  const lines = [`🤖 <b>Bots (${mcBots.size})</b>\n`];
  for (const b of mcBots.values()) {
    const ut = b.connectedAt ? `  ⏱ ${uptime(Date.now() - b.connectedAt)}` : '';
    lines.push(`${dot(b.status)} <b>${esc(b.name)}</b>  <i>(${esc(ownerTag(b))})</i>\n    🌐 <code>${esc(b.host)}:${b.port}</code>  🔧 <code>${esc(b.version)}</code>${ut}`);
  }
  return lines.join('\n');
}

function botListKeyboard() {
  const kb = new InlineKeyboard();
  let col = 0;
  for (const b of mcBots.values()) {
    kb.text(`${dot(b.status)} ${b.name}`, `manage:${b.name}`);
    if (++col % 2 === 0) kb.row();
  }
  if (col % 2) kb.row();
  return kb.text('➕ Add Bot', 'add_bot').text('🔃 Refresh', 'list_bots').row().text('⬅️ Main Menu', 'main_menu');
}

function botManageText(b) {
  const ut = b.connectedAt ? `\n⏱ <b>Uptime:</b> ${uptime(Date.now() - b.connectedAt)}` : '';
  const err = b.error ? `\n⚠️ <b>Last event:</b> <code>${esc(b.error)}</code>` : '';
  return `${dot(b.status)} <b>${esc(b.name)}</b>  <i>(${esc(ownerTag(b))})</i>\n\n🌐 <b>Server:</b> <code>${esc(b.host)}:${b.port}</code>\n🔧 <b>Version:</b> <code>${esc(b.version)}</code>\n📡 <b>Status:</b> <b>${b.status}</b>${ut}${err}`;
}

function botManageKeyboard(name) {
  const b = mcBots.get(name);
  const kb = new InlineKeyboard();
  if (b?.status === 'online' || b?.status === 'connecting') kb.text('🔴 Disconnect', `disconnect:${name}`);
  else kb.text('🟢 Reconnect', `reconnect:${name}`);
  return kb.text('🗑️ Remove', `confirm_remove:${name}`).row().text('🔃 Refresh', `manage:${name}`).text('⬅️ Back', 'list_bots');
}

function destroyBot(info) {
  if (info.reconnectTimer) { clearTimeout(info.reconnectTimer); info.reconnectTimer = null; }
  if (info.mcBot) { info.mcBot.removeAllListeners(); try { info.mcBot.quit(); } catch (_) {} info.mcBot = null; }
}

const MAX_RECONNECTS = 10;
const reconnectDelay = n => Math.min(5000 * Math.pow(2, n - 1), 60000);

function spawnBot(name, host, port, version, chatId, ownerUsername) {
  const ex = mcBots.get(name);
  if (ex) destroyBot(ex);

  const info = {
    name, host, port, version, chatId,
    ownerUsername: ownerUsername || null,
    mcBot: null, status: 'connecting',
    connectedAt: null, error: null,
    autoReconnect: true,
    reconnectAttempts: ex?.reconnectAttempts ?? 0,
    reconnectTimer: null,
  };
  mcBots.set(name, info);

  let mcBot;
  try {
    mcBot = mineflayer.createBot({ host, port, username: name, version, auth: 'offline', hideErrors: false, checkTimeoutInterval: 30000 });
  } catch (e) { info.status = 'error'; info.error = e.message; return; }
  info.mcBot = mcBot;

  const ownerNorm = norm(ownerUsername);

  function scheduleReconnect() {
    const current = mcBots.get(name);
    if (!current || !current.autoReconnect) return;
    if (current.reconnectAttempts >= MAX_RECONNECTS) {
      current.status = 'error';
      current.error = 'Max reconnect attempts reached';
      notify(chatId, `❌ <b>${esc(name)}</b> gave up after ${MAX_RECONNECTS} failed attempts.`);
      return;
    }
    current.reconnectAttempts++;
    const delay = reconnectDelay(current.reconnectAttempts);
    notify(chatId, `🔄 <b>${esc(name)}</b> reconnecting in ${Math.round(delay / 1000)}s (attempt ${current.reconnectAttempts})…`);
    current.reconnectTimer = setTimeout(() => {
      const latest = mcBots.get(name);
      if (!latest || !latest.autoReconnect) return;
      spawnBot(name, host, port, version, chatId, ownerUsername);
    }, delay);
  }

  mcBot.once('spawn', () => {
    info.status = 'online';
    info.connectedAt = Date.now();
    info.reconnectAttempts = 0;
    info.error = null;
    saveData();
    notify(chatId, `🟢 <b>${esc(name)}</b> connected to <code>${esc(host)}:${port}</code>!`);
  });

  mcBot.on('kicked', reason => {
    let r = reason;
    try { const p = JSON.parse(reason); r = p.text || p.translate || reason; } catch (_) {}
    info.status = 'offline'; info.error = `Kicked: ${r}`; info.mcBot = null;
    mcBot.removeAllListeners();
    notify(chatId, `🔴 <b>${esc(name)}</b> was kicked: <code>${esc(r)}</code>`);
    scheduleReconnect();
  });

  mcBot.on('error', err => {
    let msg = err.message;
    if (err.code === 'ECONNREFUSED') msg = 'Connection refused — server offline or wrong port';
    else if (err.code === 'ECONNRESET') msg = 'Connection reset — check version or server is in online-mode';
    else if (err.code === 'ENOTFOUND') msg = `Host not found: ${err.hostname || host}`;
    else if (err.code === 'ETIMEDOUT') msg = 'Timed out — server may be offline';
    info.status = 'error'; info.error = msg; info.mcBot = null;
    mcBot.removeAllListeners();
    notify(chatId, `🔴 <b>${esc(name)}</b> error: <code>${esc(msg)}</code>`);
    scheduleReconnect();
  });

  mcBot.on('end', reason => {
    if (info.status !== 'online' && info.status !== 'connecting') return;
    info.status = 'offline'; info.error = reason || 'Connection closed'; info.mcBot = null;
    mcBot.removeAllListeners();
    scheduleReconnect();
  });

  mcBot.on('message', jsonMsg => {
    const groups = forwardMap.get(ownerNorm);
    if (!groups?.size) return;
    const raw = jsonMsg.toAnsi ? jsonMsg.toAnsi().replace(/\x1b\[[0-9;]*m/g, '') : jsonMsg.toString();
    const clean = raw.replace(/§[0-9a-fk-or]/gi, '').trim();
    if (!clean) return;
    const text = `[${name} @ ${host}:${port}] ${clean}`;
    for (const gid of groups) notifyPlain(gid, text);
  });
}

bot.command('start', async ctx => {
  chatStates.delete(ctx.chat.id);
  await ctx.reply(mainMenuText(), {
    parse_mode: 'HTML',
    reply_markup: new InlineKeyboard()
      .text('➕ Add Bot', 'add_bot').text('📋 Bots', 'list_bots').row()
      .text('📡 Forwarding', 'fwd_help').text('ℹ️ Help', 'help').row()
      .text('🔃 Refresh', 'refresh_menu'),
  });
});

bot.command('forward', async ctx => {
  const raw = (ctx.message.text.trim().split(/\s+/)[1] || '');
  const target = norm(raw);
  const sender = norm(ctx.from.username);

  if (!target) return ctx.reply(`⚠️ Usage: <code>/forward @yourusername</code>`, { parse_mode: 'HTML' });
  if (!sender || sender !== target) return ctx.reply(`❌ You can only forward your own bots.\nUse <code>/forward @${esc(sender || 'yourusername')}</code>`, { parse_mode: 'HTML' });

  if (!forwardMap.has(target)) forwardMap.set(target, new Set());
  forwardMap.get(target).add(ctx.chat.id);
  saveData();

  let total = 0, online = 0;
  for (const b of mcBots.values()) {
    if (norm(b.ownerUsername) === target) { total++; if (b.status === 'online') online++; }
  }
  await ctx.reply(`✅ <b>Forwarding enabled!</b>\n\nThis chat will receive Minecraft chat from your bots.\n🤖 <b>${total}</b> bot(s) — <b>${online}</b> online\n\nTo stop: <code>/unforward @${esc(target)}</code>`, { parse_mode: 'HTML' });
});

bot.command('unforward', async ctx => {
  const raw = (ctx.message.text.trim().split(/\s+/)[1] || '');
  const target = norm(raw);
  const sender = norm(ctx.from.username);

  if (!target) return ctx.reply(`⚠️ Usage: <code>/unforward @yourusername</code>`, { parse_mode: 'HTML' });
  if (!sender || sender !== target) return ctx.reply(`❌ You can only manage your own subscriptions.`, { parse_mode: 'HTML' });

  const groups = forwardMap.get(target);
  if (!groups?.has(ctx.chat.id)) return ctx.reply(`⚠️ This chat is not subscribed to your bots.`, { parse_mode: 'HTML' });

  groups.delete(ctx.chat.id);
  if (!groups.size) forwardMap.delete(target);
  saveData();
  await ctx.reply(`✅ Stopped forwarding your bot messages to this chat.`, { parse_mode: 'HTML' });
});

bot.command('forwards', async ctx => {
  const chatId = ctx.chat.id;
  const active = [];
  for (const [username, groups] of forwardMap) {
    if (!groups.has(chatId)) continue;
    let total = 0, online = 0;
    for (const b of mcBots.values()) {
      if (norm(b.ownerUsername) === username) { total++; if (b.status === 'online') online++; }
    }
    active.push(`📡 <b>@${esc(username)}</b> — ${total} bot(s), ${online} online`);
  }
  if (!active.length) return ctx.reply(`📡 <b>No active forwards.</b>\n\nUse <code>/forward @yourusername</code> in this chat.`, { parse_mode: 'HTML' });
  await ctx.reply(`📡 <b>Active forwards:</b>\n\n` + active.join('\n'), { parse_mode: 'HTML' });
});

bot.on('callback_query:data', async ctx => {
  const data = ctx.callbackQuery.data;
  const chatId = ctx.chat.id;
  const edit = (text, kb) => ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: kb }).catch(() => {});
  const answer = (text = '') => ctx.answerCallbackQuery({ text, show_alert: false }).catch(() => {});

  if (data === 'main_menu' || data === 'refresh_menu') {
    chatStates.delete(chatId);
    await edit(mainMenuText(), new InlineKeyboard()
      .text('➕ Add Bot', 'add_bot').text('📋 Bots', 'list_bots').row()
      .text('📡 Forwarding', 'fwd_help').text('ℹ️ Help', 'help').row()
      .text('🔃 Refresh', 'refresh_menu'));
    return answer();
  }

  if (data === 'help') {
    await edit(
      `⭐ <b>Help &amp; Usage</b>\n\n<b>➕ Adding a bot</b>\nPress <i>Add Bot</i> then send:\n<code>name  ip  port  [version]</code>\nor <code>name  ip:port  [version]</code>\n\n<b>Examples:</b>\n<code>Steve play.example.com 25565</code>\n<code>Alex mc.example.com 25565 1.8.9</code>\n\n<b>Versions:</b> 1.21.4 · 1.20.4 · 1.19.4 · 1.16.5 · 1.12.2 · 1.8.9 · 1.7.10\n\n🔥 <b>Via:</b> ViaVersion / ViaBackwards / ViaRewind — just set the right client version.\n\n📡 <b>Forwarding:</b> In a group, run <code>/forward @yourusername</code>.\nYou must be the user named. Bots just connect and stay idle — no movement.`,
      new InlineKeyboard().text('📡 Forwarding Guide', 'fwd_help').row().text('⬅️ Main Menu', 'main_menu')
    );
    return answer();
  }

  if (data === 'fwd_help') {
    await edit(
      `📡 <b>Chat Forwarding</b>\n\nForward Minecraft chat from your bots to a Telegram group.\n\n<b>Setup:</b>\n1. Add this bot to your group\n2. In the group send: <code>/forward @yourusername</code>\n3. You must be the user named in the command\n\n<b>Commands (in the group):</b>\n<code>/forward @you</code> — start forwarding\n<code>/unforward @you</code> — stop\n<code>/forwards</code> — list active subscriptions\n\n<b>Format:</b>\n<code>[BotName @ host:port] message text</code>\n\n⚠️ Only you can subscribe to your own bots.`,
      new InlineKeyboard().text('ℹ️ General Help', 'help').row().text('⬅️ Main Menu', 'main_menu')
    );
    return answer();
  }

  if (data === 'list_bots') {
    chatStates.delete(chatId);
    await edit(botListText(), botListKeyboard());
    return answer();
  }

  if (data === 'add_bot') {
    chatStates.set(chatId, { action: 'awaiting_bot_info' });
    await edit(
      `🔌 <b>Add a Bot</b>\n\nSend connection details in chat:\n<code>name  ip  port  [version]</code>\nor <code>name  ip:port  [version]</code>\n\n<b>Example:</b>\n<code>Steve mc.example.com 25565 1.20.4</code>\n\nVersion defaults to <code>1.20.4</code>`,
      new InlineKeyboard().text('❌ Cancel', 'main_menu')
    );
    return answer('✏️ Type the bot details in chat!');
  }

  if (data.startsWith('manage:')) {
    const name = data.slice(7);
    const info = mcBots.get(name);
    if (!info) { await edit(botListText(), botListKeyboard()); return answer('Bot no longer exists'); }
    await edit(botManageText(info), botManageKeyboard(name));
    return answer();
  }

  if (data.startsWith('reconnect:')) {
    const name = data.slice(10);
    const info = mcBots.get(name);
    if (!info) return answer('Bot not found');
    if (info.status === 'online' || info.status === 'connecting') return answer('Already ' + info.status);
    info.autoReconnect = true;
    info.reconnectAttempts = 0;
    spawnBot(name, info.host, info.port, info.version, info.chatId, info.ownerUsername);
    await new Promise(r => setTimeout(r, 400));
    await edit(botManageText(mcBots.get(name)), botManageKeyboard(name));
    return answer('🟡 Reconnecting…');
  }

  if (data.startsWith('disconnect:')) {
    const name = data.slice(11);
    const info = mcBots.get(name);
    if (!info) return answer('Bot not found');
    info.autoReconnect = false;
    destroyBot(info);
    info.status = 'offline';
    info.error = 'Disconnected by user';
    saveData();
    await edit(botManageText(info), botManageKeyboard(name));
    return answer('🔴 Disconnected');
  }

  if (data.startsWith('confirm_remove:')) {
    const name = data.slice(15);
    await edit(
      `⚠️ Remove <b>${esc(name)}</b>?\nThis will disconnect it from the server.`,
      new InlineKeyboard().text('✅ Yes, remove', `do_remove:${name}`).text('❌ Cancel', `manage:${name}`)
    );
    return answer();
  }

  if (data.startsWith('do_remove:')) {
    const name = data.slice(10);
    const info = mcBots.get(name);
    if (info) { info.autoReconnect = false; destroyBot(info); }
    mcBots.delete(name);
    saveData();
    await edit(botListText(), botListKeyboard());
    return answer(`✅ ${name} removed`);
  }
});

bot.on('message:text', async ctx => {
  const chatId = ctx.chat.id;
  const state = chatStates.get(chatId);
  if (!state || state.action !== 'awaiting_bot_info') return;
  chatStates.delete(chatId);

  const parts = ctx.message.text.trim().split(/\s+/);
  const name = parts[0];
  const rawHost = parts[1] || '';
  let host, port, version;

  if (rawHost.includes(':')) {
    const idx = rawHost.lastIndexOf(':');
    host = rawHost.slice(0, idx);
    port = parseInt(rawHost.slice(idx + 1), 10);
    version = parts[2] || '1.20.4';
  } else {
    host = rawHost;
    port = parseInt(parts[2] || '', 10);
    version = parts[3] || '1.20.4';
  }

  const backKb = new InlineKeyboard().text('➕ Try Again', 'add_bot').text('⬅️ Main Menu', 'main_menu');
  if (!name || !host || !port) return ctx.reply(`❌ Missing info.\n<code>name  ip  port  [version]</code>`, { parse_mode: 'HTML', reply_markup: backKb });
  if (isNaN(port) || port < 1 || port > 65535) return ctx.reply(`❌ Invalid port (1–65535).`, { parse_mode: 'HTML', reply_markup: backKb });
  if (!/^[a-zA-Z0-9_]{1,16}$/.test(name)) return ctx.reply(`❌ Invalid username — letters, numbers, underscores, max 16.`, { parse_mode: 'HTML', reply_markup: backKb });

  const existing = mcBots.get(name);
  if (existing && (existing.status === 'online' || existing.status === 'connecting')) {
    return ctx.reply(`⚠️ <b>${esc(name)}</b> is already ${existing.status}.`, {
      parse_mode: 'HTML',
      reply_markup: new InlineKeyboard().text('📋 List Bots', 'list_bots').text('⬅️ Main Menu', 'main_menu'),
    });
  }

  const ownerUsername = ctx.from.username || null;
  const msg = await ctx.reply(`🟡 Connecting <b>${esc(name)}</b> to <code>${esc(host)}:${port}</code> [<code>${esc(version)}</code>]…`, { parse_mode: 'HTML' });

  spawnBot(name, host, port, version, chatId, ownerUsername);
  saveData();

  setTimeout(async () => {
    const info = mcBots.get(name);
    if (!info) return;
    const kb = new InlineKeyboard().text(`${dot(info.status)} ${info.name}`, `manage:${info.name}`).row().text('📋 List Bots', 'list_bots').text('⬅️ Main Menu', 'main_menu');
    await bot.api.editMessageText(chatId, msg.message_id, botManageText(info), { parse_mode: 'HTML', reply_markup: kb }).catch(() => {});
  }, 3000);
});

bot.catch(err => console.error('Update error:', err.error?.message ?? err));

console.log('🚀 Minecraft Bot Manager starting…');
loadData();
bot.start({ onStart: info => console.log(`✅ Running as @${info.username}`) });