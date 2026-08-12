'use strict';

const { Bot, InlineKeyboard } = require('grammy');
const mineflayer = require('mineflayer');
const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// CONFIG 
// ---------------------------------------------------------------------------

const CFG = Object.freeze({
  DEFAULT_VERSION: '1.20.4',
  MAX_RECONNECTS: 10,
  BASE_RECONNECT_MS: 5000,
  MAX_RECONNECT_MS: 60000,
  MC_TIMEOUT_MS: 30000,
  SAVE_DEBOUNCE_MS: 500,
  DATA_VERSION: 2,
});

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!TOKEN) {
  console.error('TELEGRAM_BOT_TOKEN not set');
  process.exit(1);
}

const DATA = path.join(__dirname, 'userdata.json');
const DATA_TMP = `${DATA}.tmp`;

// ---------------------------------------------------------------------------
// STATE
// ---------------------------------------------------------------------------

const mcBots = new Map();
const chatStates = new Map();
const forwardMap = new Map();
const bot = new Bot(TOKEN);

let loading = false;
let saveTimer = null;
let shuttingDown = false;

// ---------------------------------------------------------------------------
// UTILITIES
// ---------------------------------------------------------------------------

const esc = value => String(value ?? '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

const stripColors = value => String(value ?? '')
  .replace(/§[0-9a-fk-or]/gi, '')
  .replace(/\x1b\[[0-9;]*m/g, '')
  .trim();

const normUsername = value => String(value || '').replace(/^@/, '').toLowerCase();

const uptime = milliseconds => {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  if (days > 0) return `${days}d ${hours % 24}h`;
  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
  return `${seconds}s`;
};

const dot = status => status === 'online'
  ? '🟢'
  : status === 'connecting'
    ? '🟡'
    : status === 'error'
      ? '🔴'
      : '⚫';

const ownerTag = info => info.ownerUsername
  ? `@${info.ownerUsername}`
  : info.userId
    ? `ID ${info.userId}`
    : `#${info.chatId}`;

const hashId = input => {
  let hash = 2166136261;
  for (const character of String(input)) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
};

const botIdFor = (name, host, port) => String(hashId(`${name}:${host}:${port}`));

const statusLabel = status => status === 'online'
  ? 'ONLINE'
  : status === 'connecting'
    ? 'CONNECTING'
    : status === 'error'
      ? 'ERROR'
      : 'OFFLINE';

const shortBotName = name => {
  const value = String(name || '');
  return value.length > 18 ? `${value.slice(0, 17)}…` : value;
};

const reconnectDelay = attempt => Math.min(
  CFG.BASE_RECONNECT_MS * Math.pow(2, Math.max(0, attempt - 1)),
  CFG.MAX_RECONNECT_MS,
);

const safeJsonParse = (value, fallback) => {
  try {
    return JSON.parse(value);
  } catch (_) {
    return fallback;
  }
};

const notify = (chatId, text) => bot.api
  .sendMessage(chatId, text, { parse_mode: 'HTML' })
  .catch(() => {});

const notifyPlain = (chatId, text) => bot.api.sendMessage(chatId, text).catch(() => {});

const userKey = userId => userId == null ? null : String(userId);

const currentUserOwns = (info, userId, chatId, username) => {
  if (info.userId != null && userId != null) return String(info.userId) === String(userId);
  return Boolean(
    userId
      && username
      && info.ownerUsername
      && normUsername(info.ownerUsername) === normUsername(username),
  );
};

const getBot = id => mcBots.get(String(id));

const ownedBots = (userId, chatId, username) => [...mcBots.values()]
  .filter(info => currentUserOwns(info, userId, chatId, username));

const claimLegacyOwnership = (info, userId, username) => {
  if (!info || info.userId != null || !userId) return;
  if (!username || normUsername(info.ownerUsername) !== normUsername(username)) return;
  info.userId = userId;
  const legacyKey = `username:${normUsername(info.ownerUsername)}`;
  const userKeyValue = String(userId);
  const legacyGroups = forwardMap.get(legacyKey);
  if (legacyGroups?.size) {
    if (!forwardMap.has(userKeyValue)) forwardMap.set(userKeyValue, new Set());
    for (const groupId of legacyGroups) forwardMap.get(userKeyValue).add(groupId);
    forwardMap.delete(legacyKey);
  }
  saveData();
};

const formatMinecraftReason = reason => {
  const flatten = value => {
    if (value == null) return '';
    if (typeof value === 'string') {
      const parsed = safeJsonParse(value, null);
      return parsed && typeof parsed === 'object' ? flatten(parsed) : value;
    }
    if (Array.isArray(value)) return value.map(flatten).join('');
    if (typeof value === 'object') {
      if (value.text) return `${value.text}${flatten(value.extra || '')}`;
      if (value.translate) return value.translate;
      if (value.extra) return flatten(value.extra);
      return JSON.stringify(value);
    }
    return String(value);
  };
  return stripColors(flatten(reason));
};

// ---------------------------------------------------------------------------
// PERSISTENCE
// ---------------------------------------------------------------------------

const serialiseBot = info => ({
  id: String(info.id),
  name: info.name,
  host: info.host,
  port: info.port,
  version: info.version,
  chatId: info.chatId,
  userId: info.userId ?? null,
  ownerUsername: info.ownerUsername || null,
  paused: info.autoReconnect === false,
  createdAt: info.createdAt || new Date().toISOString(),
});

const persistNow = () => {
  const data = {
    meta: {
      version: CFG.DATA_VERSION,
      updatedAt: new Date().toISOString(),
      app: 'mcafk',
    },
    bots: [...mcBots.values()].map(serialiseBot),
    forwards: Object.fromEntries([...forwardMap]
      .map(([key, chatIds]) => [key, [...chatIds]])),
  };

  try {
    fs.writeFileSync(DATA_TMP, JSON.stringify(data, null, 2), 'utf8');
    fs.renameSync(DATA_TMP, DATA);
  } catch (error) {
    console.error('saveData:', error.message);
  }
};

const recoverTempData = () => {
  if (fs.existsSync(DATA) || !fs.existsSync(DATA_TMP)) return;
  const recovered = safeJsonParse(fs.readFileSync(DATA_TMP, 'utf8'), null);
  if (!recovered || typeof recovered !== 'object') return;
  fs.renameSync(DATA_TMP, DATA);
  console.log('♻️ Recovered the last complete userdata.json save.');
};

const saveData = () => {
  if (loading || shuttingDown) return;
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    persistNow();
  }, CFG.SAVE_DEBOUNCE_MS);
};

const migrateForwardKey = (key, bots) => {
  const stringKey = String(key);
  if (/^-?\d+$/.test(stringKey)) return stringKey;
  if (stringKey.startsWith('username:')) return stringKey;
  const owner = bots.find(info => normUsername(info.ownerUsername) === normUsername(stringKey));
  return owner?.userId != null ? String(owner.userId) : `username:${normUsername(stringKey)}`;
};

const makePausedBot = record => {
  const name = String(record.name || '');
  const host = String(record.host || '');
  const port = Number(record.port);
  const version = String(record.version || CFG.DEFAULT_VERSION);
  const persistedId = String(record.id || '');
  const id = /^\d+$/.test(persistedId)
    ? persistedId
    : botIdFor(name, host, port);

  return {
    id,
    name,
    host,
    port,
    version,
    chatId: record.chatId ?? null,
    userId: record.userId ?? null,
    ownerUsername: record.ownerUsername || null,
    createdAt: record.createdAt || new Date().toISOString(),
    mcBot: null,
    status: 'offline',
    connectedAt: null,
    error: 'Paused after restart — press Reconnect to resume',
    autoReconnect: false,
    reconnectAttempts: 0,
    reconnectTimer: null,
  };
};

const loadData = () => {
  try {
    recoverTempData();
  } catch (error) {
    console.error('userdata recovery:', error.message);
  }
  if (!fs.existsSync(DATA)) {
    persistNow();
    return;
  }

  loading = true;
  try {
    const parsed = safeJsonParse(fs.readFileSync(DATA, 'utf8'), null);
    if (!parsed || typeof parsed !== 'object') throw new Error('invalid JSON root');

    const loadedBots = [];
    let migrated = parsed.meta?.version !== CFG.DATA_VERSION;
    for (const record of Array.isArray(parsed.bots) ? parsed.bots : []) {
      if (!record?.name || !record?.host || !record?.port) continue;
      const info = makePausedBot(record);
      if (mcBots.has(info.id)) {
        console.error(`loadData: duplicate bot id ${info.id}; keeping the first record`);
        migrated = true;
        continue;
      }
      mcBots.set(info.id, info);
      loadedBots.push(info);
    }

    for (const [key, chatIds] of Object.entries(parsed.forwards || {})) {
      const migratedKey = migrateForwardKey(key, loadedBots);
      const ids = Array.isArray(chatIds)
        ? chatIds.filter(value => /^-?\d+$/.test(String(value)))
        : [];
      if (migratedKey !== String(key) || ids.length !== (Array.isArray(chatIds) ? chatIds.length : 0)) {
        migrated = true;
      }
      if (!forwardMap.has(migratedKey)) forwardMap.set(migratedKey, new Set());
      for (const chatId of ids) forwardMap.get(migratedKey).add(chatId);
    }

    console.log(`📦 ${loadedBots.length} bot(s) loaded (paused). Press Reconnect to resume.`);
    if (migrated) persistNow();
  } catch (error) {
    console.error('loadData:', error.message);
  } finally {
    loading = false;
  }
};

// ---------------------------------------------------------------------------
// UI BUILDERS
// ---------------------------------------------------------------------------

const mainMenuText = (userId, chatId, username) => {
  const bots = ownedBots(userId, chatId, username);
  const online = bots.filter(info => info.status === 'online').length;
  return `🤖 <b>Minecraft Bot Manager</b>\n\n` +
    `Connect fake offline players to any Minecraft server.\n` +
    `Supports ViaVersion · ViaBackwards · ViaRewind\n\n` +
    `💎 <b>Your bots:</b> ${bots.length} registered  🟢 ${online} online`;
};

const mainMenuKeyboard = () => new InlineKeyboard()
  .text('➕ Add Bot', 'add_bot').text('📋 My Bots', 'list_bots').row()
  .text('ℹ️ Help & Guide', 'help');

const botListText = (userId, chatId, username) => {
  const bots = ownedBots(userId, chatId, username);
  if (!bots.length) return `🤖 <b>No bots registered</b>\n\nPress <b>➕ Add Bot</b> to connect one.`;

  const lines = [`🤖 <b>Your bots (${bots.length})</b>\n`];
  for (const info of bots) {
    const runningFor = info.connectedAt
      ? `  ⏱ ${uptime(Date.now() - info.connectedAt)}`
      : '';
    lines.push(
      `${dot(info.status)} <b>${esc(info.name)}</b>  <i>(${esc(ownerTag(info))})</i>\n` +
      `    🌐 <code>${esc(info.host)}:${info.port}</code>  ` +
      `🔧 <code>${esc(info.version)}</code>  <b>${statusLabel(info.status)}</b>${runningFor}`,
    );
  }
  return lines.join('\n');
};

const botListKeyboard = (userId, chatId, username) => {
  const keyboard = new InlineKeyboard();
  const bots = ownedBots(userId, chatId, username);
  for (const info of bots) {
    keyboard.text(
      `${dot(info.status)}  ${shortBotName(info.name)}  ·  ${statusLabel(info.status)}`,
      `manage:${info.id}`,
    ).row();
  }
  return keyboard
    .text('➕ Add Another Bot', 'add_bot').row()
    .text('🔃  Refresh List', 'list_bots').row()
    .text('⬅️  Main Menu', 'main_menu');
};

const botManageText = info => {
  const runningFor = info.connectedAt
    ? `\n⏱ <b>Uptime:</b> ${uptime(Date.now() - info.connectedAt)}`
    : '';
  const reconnects = info.reconnectAttempts
    ? `\n🔄 <b>Reconnect attempts:</b> ${info.reconnectAttempts}/${CFG.MAX_RECONNECTS}`
    : '';
  const error = info.error
    ? `\n⚠️ <b>Last event:</b> <code>${esc(info.error)}</code>`
    : '';
  return `${dot(info.status)} <b>${esc(info.name)}</b>  <i>(${esc(ownerTag(info))})</i>\n\n` +
    `🌐 <b>Server:</b> <code>${esc(info.host)}:${info.port}</code>\n` +
    `🔧 <b>Version:</b> <code>${esc(info.version)}</code>\n` +
    `📡 <b>Status:</b> <b>${info.status}</b>${runningFor}${reconnects}${error}`;
};

const botManageKeyboard = id => {
  const info = getBot(id);
  const keyboard = new InlineKeyboard();
  if (info?.status === 'online' || info?.status === 'connecting') {
    keyboard.text('🔴 Disconnect', `disconnect:${id}`);
  } else {
    keyboard.text('🟢 Reconnect', `reconnect:${id}`);
  }
  return keyboard
    .row()
    .text('🔃  Refresh Status', `manage:${id}`)
    .text('⬅️  Back to Bots', 'list_bots').row()
    .text('🗑️  Remove Bot', `confirm_remove:${id}`);
};

// ---------------------------------------------------------------------------
// MINEFLAYER LIFECYCLE
// ---------------------------------------------------------------------------

const destroyBot = info => {
  if (!info) return;
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

const scheduleReconnect = info => {
  const current = getBot(info.id);
  if (!current || !current.autoReconnect || shuttingDown) return;

  if (current.reconnectAttempts >= CFG.MAX_RECONNECTS) {
    current.status = 'error';
    current.error = `Max reconnect attempts reached (${CFG.MAX_RECONNECTS})`;
    saveData();
    if (current.chatId) {
      notify(current.chatId,
        `❌ <b>${esc(current.name)}</b> gave up after ${CFG.MAX_RECONNECTS} failed attempts.`);
    }
    return;
  }

  current.reconnectAttempts += 1;
  const delay = reconnectDelay(current.reconnectAttempts);
  current.reconnectTimer = setTimeout(() => {
    current.reconnectTimer = null;
    const latest = getBot(current.id);
    if (latest?.autoReconnect && !shuttingDown) spawnBot(latest, false);
  }, delay);

  if (current.chatId) {
    notify(current.chatId,
      `🔄 <b>${esc(current.name)}</b> reconnecting in ${Math.round(delay / 1000)}s ` +
      `(attempt ${current.reconnectAttempts})…`);
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
  if (resetAttempts) current.reconnectAttempts = 0;

  let mcBot;
  try {
    mcBot = mineflayer.createBot({
      host: current.host,
      port: current.port,
      username: current.name,
      version: current.version,
      auth: 'offline',
      hideErrors: false,
      checkTimeoutInterval: CFG.MC_TIMEOUT_MS,
    });
  } catch (error) {
    current.status = 'error';
    current.error = friendlyError(error, current);
    scheduleReconnect(current);
    return;
  }

  current.mcBot = mcBot;

  const forwardKey = userKey(current.userId) || `username:${normUsername(current.ownerUsername)}`;

  mcBot.once('spawn', () => {
    current.status = 'online';
    current.connectedAt = Date.now();
    current.reconnectAttempts = 0;
    current.error = null;
    saveData();
    if (current.chatId) {
      notify(current.chatId,
        `🟢 <b>${esc(current.name)}</b> connected to ` +
        `<code>${esc(current.host)}:${current.port}</code>!`);
    }
  });

  mcBot.on('kicked', reason => {
    const message = formatMinecraftReason(reason) || 'Unknown reason';
    current.status = 'offline';
    current.error = `Kicked: ${message}`;
    current.mcBot = null;
    mcBot.removeAllListeners();
    if (current.chatId) {
      notify(current.chatId,
        `🔴 <b>${esc(current.name)}</b> was kicked: <code>${esc(message)}</code>`);
    }
    scheduleReconnect(current);
  });

  mcBot.on('error', error => {
    current.status = 'error';
    current.error = friendlyError(error, current);
    current.mcBot = null;
    mcBot.removeAllListeners();
    if (current.chatId) {
      notify(current.chatId,
        `🔴 <b>${esc(current.name)}</b> error: <code>${esc(current.error)}</code>`);
    }
    scheduleReconnect(current);
  });

  mcBot.on('end', reason => {
    if (current.status !== 'online' && current.status !== 'connecting') return;
    current.status = 'offline';
    current.error = formatMinecraftReason(reason) || 'Connection closed';
    current.mcBot = null;
    mcBot.removeAllListeners();
    scheduleReconnect(current);
  });

  mcBot.on('message', jsonMessage => {
    const groups = forwardMap.get(forwardKey);
    if (!groups?.size) return;
    const clean = stripColors(
      typeof jsonMessage?.toAnsi === 'function'
        ? jsonMessage.toAnsi()
        : jsonMessage?.toString(),
    );
    if (!clean) return;
    const text = `[${current.name} @ ${current.host}:${current.port}] ${clean}`;
    for (const groupId of groups) notifyPlain(groupId, text);
  });

  saveData();
};

// ---------------------------------------------------------------------------
// ECHO
// ---------------------------------------------------------------------------

async function handleEcho(ctx, afterCmd) {
  const sender = normUsername(ctx.from?.username);
  const userId = ctx.from?.id;
  const chatId = ctx.chat.id;

  if (!afterCmd) {
    return ctx.reply(
      `⚠️ <b>Echo Usage</b>\n\n` +
      `<code>/echo your message</code> → all your online bots\n` +
      `<code>/echo Steve your message</code> → specific bot only`,
      { parse_mode: 'HTML' },
    );
  }

  let botName = null;
  let message = afterCmd;

  const owned = ownedBots(userId, chatId, sender);
  owned.sort((a, b) => b.name.length - a.name.length);

  const afterCmdNorm = afterCmd.trim();
  for (const info of owned) {
    const name = info.name;
    const nameLower = name.toLowerCase();
    const afterLower = afterCmdNorm.toLowerCase();
    if (
      afterLower.startsWith(nameLower) &&
      (afterCmdNorm.length === name.length || afterCmdNorm[name.length] === ' ')
    ) {
      botName = name;
      message = afterCmdNorm.slice(name.length).trim();
      break;
    }
  }

  if (!message) {
    return ctx.reply(
      `⚠️ Message is empty.\n` +
      (botName
        ? `<code>/echo ${esc(botName)} your message</code>`
        : `<code>/echo your message</code>`),
      { parse_mode: 'HTML' },
    );
  }

  let sent = 0;
  let offline = 0;

  for (const info of owned) {
    if (botName && info.name !== botName) continue;

    if (info.status === 'online' && info.mcBot) {
      try {
        info.mcBot.chat(message);
        sent++;
      } catch (error) {
        console.error(`[ECHO] ${info.name}:`, error.message);
      }
    } else {
      offline++;
    }
  }

  if (sent > 0) {
    const target = botName ? ` → <b>${esc(botName)}</b>` : ' → <b>all your bots</b>';
    await ctx.reply(
      `✅ <b>Echo sent!</b>${target}\n\n` +
      `💬 <code>${esc(message)}</code>\n` +
      `🤖 Delivered to <b>${sent}</b> bot(s)` +
      (offline > 0 ? `\n⚫ ${offline} offline — skipped` : ''),
      { parse_mode: 'HTML' },
    );
  } else if (offline > 0) {
    await ctx.reply(
      `⚠️ Target bot${botName ? ` "${esc(botName)}"` : 's'} offline.\n` +
      `Press <b>🟢 Reconnect</b> first.`,
      { parse_mode: 'HTML' },
    );
  } else if (botName) {
    await ctx.reply(
      `❌ Bot "${esc(botName)}" not found or you don't own it.`,
      { parse_mode: 'HTML' },
    );
  } else {
    await ctx.reply(
      `❌ You have no registered bots. Use <b>➕ Add Bot</b>.`,
      { parse_mode: 'HTML' },
    );
  }
}

// ---------------------------------------------------------------------------
// WALK
// ---------------------------------------------------------------------------

bot.command('walk', async ctx => {
  const sender = normUsername(ctx.from?.username);
  const userId = ctx.from?.id;
  const chatId = ctx.chat.id;
  const args = ctx.message.text.trim().split(/\s+/).slice(1);

  const validDirections = ['forward', 'back', 'backward', 'left', 'right'];
  const direction = args[0]?.toLowerCase();
  const blocks = Number.parseFloat(args[1]);

  if (!direction || !validDirections.includes(direction)) {
    return ctx.reply(
      `⚠️ <b>Walk Usage</b>\n\n` +
      `<code>/walk forward 10</code>\n` +
      `<code>/walk back 5</code>\n` +
      `<code>/walk left 3</code>\n` +
      `<code>/walk right 7</code>\n\n` +
      `Directions: <code>forward, back, left, right</code>`,
      { parse_mode: 'HTML' },
    );
  }
  if (!Number.isFinite(blocks) || blocks <= 0 || blocks > 100) {
    return ctx.reply('❌ Length must be a number between 0.1 and 100 blocks.', { parse_mode: 'HTML' });
  }

  const owned = ownedBots(userId, chatId, sender);
  const online = owned.filter(info => info.status === 'online' && info.mcBot);
  if (!online.length) {
    return ctx.reply('⚠️ No online bots. Press 🟢 Reconnect first.', { parse_mode: 'HTML' });
  }

  const mcDirection = direction === 'backward' ? 'back' : direction;
  const walkPromises = online.map(info => new Promise((resolve) => {
    const botInstance = info.mcBot;
    const startPos = botInstance.entity.position.clone();
    const targetDistance = blocks;
    let resolved = false;

    botInstance.setControlState(mcDirection, true);

    const checkDistance = () => {
      if (resolved) return;
      const currentPos = botInstance.entity.position;
      const dx = currentPos.x - startPos.x;
      const dz = currentPos.z - startPos.z;
      const dy = currentPos.y - startPos.y;
      const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);

      if (distance >= targetDistance) {
        resolved = true;
        botInstance.setControlState(mcDirection, false);
        botInstance.removeListener('move', checkDistance);
        resolve({ name: info.name, distance: distance.toFixed(1) });
      }
    };

    botInstance.on('move', checkDistance);

    setTimeout(() => {
      if (resolved) return;
      resolved = true;
      botInstance.setControlState(mcDirection, false);
      botInstance.removeListener('move', checkDistance);
      const currentPos = botInstance.entity.position;
      const dx = currentPos.x - startPos.x;
      const dz = currentPos.z - startPos.z;
      const dy = currentPos.y - startPos.y;
      const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
      resolve({ name: info.name, distance: distance.toFixed(1), timeout: true });
    }, Math.min(blocks * 5000, 30000));
  }));

  const results = await Promise.all(walkPromises);
  const lines = results.map(r =>
    `🤖 <b>${esc(r.name)}</b> — walked <code>${r.distance}</code> blocks` +
    (r.timeout ? ' (timeout)' : ''),
  );
  await ctx.reply(`✅ <b>Walk complete!</b>\n\n${lines.join('\n')}`, { parse_mode: 'HTML' });
});

// ---------------------------------------------------------------------------
// TELEGRAM HANDLERS
// ---------------------------------------------------------------------------

bot.command('start', async ctx => {
  chatStates.delete(ctx.chat.id);
  await ctx.reply(mainMenuText(ctx.from.id, ctx.chat.id, ctx.from.username), {
    parse_mode: 'HTML',
    reply_markup: mainMenuKeyboard(),
  });
});

bot.command('forward', async ctx => {
  const rawTarget = ctx.message.text.trim().split(/\s+/)[1] || '';
  const senderUsername = normUsername(ctx.from.username);
  const target = normUsername(rawTarget);

  if (!senderUsername) {
    return ctx.reply('❌ Set a Telegram username before enabling forwarding.');
  }
  if (target && target !== senderUsername) {
    return ctx.reply(
      `❌ You can only forward your own bots.\nUse <code>/forward @${esc(senderUsername)}</code>`,
      { parse_mode: 'HTML' },
    );
  }

  const key = String(ctx.from.id);
  if (!forwardMap.has(key)) forwardMap.set(key, new Set());
  forwardMap.get(key).add(ctx.chat.id);
  saveData();

  const bots = ownedBots(ctx.from.id, ctx.chat.id, ctx.from.username);
  const online = bots.filter(info => info.status === 'online').length;
  await ctx.reply(
    `✅ <b>Forwarding enabled!</b>\n\n` +
    `This chat will receive Minecraft chat from your bots.\n` +
    `🤖 <b>${bots.length}</b> bot(s) — <b>${online}</b> online\n\n` +
    `To stop: <code>/unforward @${esc(senderUsername)}</code>`,
    { parse_mode: 'HTML' },
  );
});

bot.command('unforward', async ctx => {
  const key = String(ctx.from.id);
  const groups = forwardMap.get(key);
  if (!groups?.has(ctx.chat.id)) {
    return ctx.reply('⚠️ This chat is not subscribed to your bots.');
  }

  groups.delete(ctx.chat.id);
  if (!groups.size) forwardMap.delete(key);
  saveData();
  await ctx.reply('✅ Stopped forwarding your bot messages to this chat.');
});

bot.command('forwards', async ctx => {
  const key = String(ctx.from.id);
  const groups = forwardMap.get(key);
  if (!groups?.has(ctx.chat.id)) {
    return ctx.reply(
      '📡 <b>No active forwards.</b>\n\nUse <code>/forward @yourusername</code> in this chat.',
      { parse_mode: 'HTML' },
    );
  }

  const bots = ownedBots(ctx.from.id, ctx.chat.id, ctx.from.username);
  const online = bots.filter(info => info.status === 'online').length;
  await ctx.reply(
    `📡 <b>Active forwards:</b>\n\n` +
    `Your bots — ${bots.length} total, ${online} online\n` +
    `This chat is subscribed to their Minecraft messages.`,
    { parse_mode: 'HTML' },
  );
});

bot.command('echo', async ctx => {
  const after = ctx.message.text.trim().slice(5).trim();
  await handleEcho(ctx, after);
});

bot.on('callback_query:data', async ctx => {
  const data = ctx.callbackQuery.data;
  const chatId = ctx.chat.id;
  const userId = ctx.from.id;
  const username = ctx.from.username;
  const edit = (text, keyboard) => ctx.editMessageText(text, {
    parse_mode: 'HTML',
    reply_markup: keyboard,
  }).catch(() => {});
  const answer = (text = '') => ctx.answerCallbackQuery({
    text,
    show_alert: false,
  }).catch(() => {});

  if (data === 'main_menu' || data === 'refresh_menu') {
    chatStates.delete(chatId);
    await edit(mainMenuText(userId, chatId, username), mainMenuKeyboard());
    return answer();
  }

  if (data === 'help') {
    await edit(
      `⭐ <b>Help &amp; Usage</b>\n\n` +
      `<b>➕ Adding a bot</b>\nPress <i>Add Bot</i> then send:\n` +
      `<code>name  ip  port  [version]</code>\n` +
      `or <code>name  ip:port  [version]</code>\n\n` +
      `<b>Examples:</b>\n` +
      `<code>Steve play.example.com 25565</code>\n` +
      `<code>Alex mc.example.com 25565 1.8.9</code>\n\n` +
      `<b>Versions:</b> 1.21.4 · 1.20.4 · 1.19.4 · 1.16.5 · 1.12.2 · 1.8.9 · 1.7.10\n\n` +
      `🔥 <b>Via:</b> ViaVersion / ViaBackwards / ViaRewind — set the right client version.\n\n` +
      `📡 <b>Forwarding:</b> In a group, run <code>/forward @yourusername</code>.\n` +
      `📢 <b>Echo:</b> <code>/echo [botname] message</code>\n` +
      `🚶 <b>Walk:</b> <code>/walk forward 10</code> — move your bots\n` +
      `Bots connect and stay idle — no movement.`,
      new InlineKeyboard().text('📡 Forwarding Guide', 'fwd_help').row()
        .text('⬅️ Main Menu', 'main_menu'),
    );
    return answer();
  }

  if (data === 'fwd_help') {
    await edit(
      `📡 <b>Chat Forwarding</b>\n\n` +
      `Forward Minecraft chat from your bots to a Telegram group.\n\n` +
      `<b>Setup:</b>\n` +
      `1. Add this bot to your group\n` +
      `2. In the group send: <code>/forward @yourusername</code>\n` +
      `3. You must be the user named in the command\n\n` +
      `<b>Commands (in the group):</b>\n` +
      `<code>/forward @you</code> — start forwarding\n` +
      `<code>/unforward @you</code> — stop\n` +
      `<code>/forwards</code> — list active subscriptions\n\n` +
      `<b>Format:</b>\n` +
      `<code>[BotName @ host:port] message text</code>\n\n` +
      `⚠️ Only you can subscribe to your own bots.`,
      new InlineKeyboard().text('ℹ️ General Help', 'help').row()
        .text('⬅️ Main Menu', 'main_menu'),
    );
    return answer();
  }

  if (data === 'list_bots') {
    chatStates.delete(chatId);
    await edit(botListText(userId, chatId, username), botListKeyboard(userId, chatId, username));
    return answer();
  }

  if (data === 'add_bot') {
    chatStates.set(chatId, { action: 'awaiting_bot_info' });
    await edit(
      `🔌 <b>Add a Bot</b>\n\n` +
      `Send connection details in chat:\n` +
      `<code>name  ip  port  [version]</code>\n` +
      `or <code>name  ip:port  [version]</code>\n\n` +
      `<b>Example:</b>\n` +
      `<code>Steve mc.example.com 25565 1.20.4</code>\n\n` +
      `Version defaults to <code>${CFG.DEFAULT_VERSION}</code>`,
      new InlineKeyboard().text('❌ Cancel', 'main_menu'),
    );
    return answer('✏️ Type the bot details in chat!');
  }

  const [action, id] = data.split(':', 2);
  if (!['manage', 'reconnect', 'disconnect', 'confirm_remove', 'do_remove'].includes(action)) {
    return answer();
  }

  const info = getBot(id);
  if (!info) return answer('Bot not found');
  if (!currentUserOwns(info, userId, chatId, username)) {
    return answer('This bot belongs to another user');
  }

  claimLegacyOwnership(info, userId, username);

  if (action === 'manage') {
    await edit(botManageText(info), botManageKeyboard(info.id));
    return answer();
  }

  if (action === 'reconnect') {
    if (info.status === 'online' || info.status === 'connecting') {
      return answer(`Already ${info.status}`);
    }
    info.autoReconnect = true;
    info.reconnectAttempts = 0;
    spawnBot(info);
    await new Promise(resolve => setTimeout(resolve, 400));
    await edit(botManageText(getBot(info.id)), botManageKeyboard(info.id));
    return answer('🟡 Reconnecting…');
  }

  if (action === 'disconnect') {
    info.autoReconnect = false;
    destroyBot(info);
    info.status = 'offline';
    info.connectedAt = null;
    info.error = 'Disconnected by user';
    saveData();
    await edit(botManageText(info), botManageKeyboard(info.id));
    return answer('🔴 Disconnected');
  }

  if (action === 'confirm_remove') {
    await edit(
      `⚠️ Remove <b>${esc(info.name)}</b>?\nThis will disconnect it from the server.`,
      new InlineKeyboard()
        .text('✅ Yes, remove', `do_remove:${info.id}`)
        .text('❌ Cancel', `manage:${info.id}`),
    );
    return answer();
  }

  info.autoReconnect = false;
  destroyBot(info);
  mcBots.delete(info.id);
  saveData();
  await edit(botListText(userId, chatId, username), botListKeyboard(userId, chatId, username));
  return answer(`✅ ${info.name} removed`);
});

bot.on('message:text', async ctx => {
  const text = ctx.message.text.trim();
  const chatId = ctx.chat.id;

  const state = chatStates.get(chatId);
  if (!state || state.action !== 'awaiting_bot_info') return;
  chatStates.delete(chatId);

  const parts = text.split(/\s+/).filter(Boolean);
  const name = parts[0] || '';
  const rawHost = parts[1] || '';
  let host;
  let port;
  let version;

  if (rawHost.includes(':')) {
    const index = rawHost.lastIndexOf(':');
    host = rawHost.slice(0, index);
    port = Number.parseInt(rawHost.slice(index + 1), 10);
    version = parts[2] || CFG.DEFAULT_VERSION;
  } else {
    host = rawHost;
    port = Number.parseInt(parts[2] || '', 10);
    version = parts[3] || CFG.DEFAULT_VERSION;
  }

  const backKeyboard = new InlineKeyboard()
    .text('➕ Try Again', 'add_bot').text('⬅️ Main Menu', 'main_menu');

  if (!name || !host || !port) {
    return ctx.reply(
      `❌ Missing info.\n<code>name  ip  port  [version]</code>`,
      { parse_mode: 'HTML', reply_markup: backKeyboard },
    );
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return ctx.reply('❌ Invalid port (1–65535).', {
      parse_mode: 'HTML',
      reply_markup: backKeyboard,
    });
  }
  if (!/^[a-zA-Z0-9_]{1,16}$/.test(name)) {
    return ctx.reply('❌ Invalid username — letters, numbers, underscores, max 16.', {
      parse_mode: 'HTML',
      reply_markup: backKeyboard,
    });
  }

  const id = botIdFor(name, host, port);
  const existing = getBot(id);
  if (existing && (existing.status === 'online' || existing.status === 'connecting')) {
    return ctx.reply(`⚠️ <b>${esc(name)}</b> is already ${existing.status}.`, {
      parse_mode: 'HTML',
      reply_markup: new InlineKeyboard()
        .text('📋 List Bots', 'list_bots').text('⬅️ Main Menu', 'main_menu'),
    });
  }

  const info = {
    id,
    name,
    host,
    port,
    version,
    chatId,
    userId: ctx.from.id,
    ownerUsername: ctx.from.username || null,
    createdAt: existing?.createdAt || new Date().toISOString(),
    mcBot: null,
    status: 'connecting',
    connectedAt: null,
    error: null,
    autoReconnect: true,
    reconnectAttempts: 0,
    reconnectTimer: null,
  };
  mcBots.set(id, info);

  const message = await ctx.reply(
    `🟡 Connecting <b>${esc(name)}</b> to ` +
    `<code>${esc(host)}:${port}</code> [<code>${esc(version)}</code>]…`,
    { parse_mode: 'HTML' },
  );

  spawnBot(info);
  saveData();

  setTimeout(async () => {
    const latest = getBot(id);
    if (!latest) return;
    const keyboard = new InlineKeyboard()
      .text(`${dot(latest.status)} ${latest.name}`, `manage:${latest.id}`).row()
      .text('📋 List Bots', 'list_bots').text('⬅️ Main Menu', 'main_menu');
    await bot.api.editMessageText(
      chatId,
      message.message_id,
      botManageText(latest),
      { parse_mode: 'HTML', reply_markup: keyboard },
    ).catch(() => {});
  }, 3000);
});

bot.catch(error => console.error('Update error:', error.error?.message ?? error));

// ---------------------------------------------------------------------------
// SHUTDOWN / BOOT
// ---------------------------------------------------------------------------

const shutdown = async signal => {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`🛑 ${signal} received — shutting down cleanly…`);

  for (const info of mcBots.values()) {
    info.autoReconnect = false;
    destroyBot(info);
    info.status = 'offline';
    info.connectedAt = null;
  }
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = null;
  persistNow();

  try {
    await bot.stop();
  } catch (_) {}
  process.exit(0);
};

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
  void shutdown('uncaughtException');
});

process.on('unhandledRejection', reason => {
  console.error('[UNHANDLED]', reason);
});

console.log('🚀 Minecraft Bot Manager starting…');
loadData();
bot.start({
  onStart: info => console.log(`✅ Running as @${info.username}`),
});
