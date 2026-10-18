'use strict';
// Rich messages, quiet hours, ownership helpers, button and location helpers, auto-reply triggers.
const R = require('./registry');
const { S } = R;
const { CFG, bot, esc, forwardMap, mcBots, normUsername, quietPrefs, safeJsonParse, stripColors } = R;

// ---------------------------------------------------------------------------
// RICH MESSAGES (Bot API 10.3: sendRichMessage / editMessageText + rich_message)
// Every rich call has a plain-HTML fallback, so older API behaviour keeps working.
// ---------------------------------------------------------------------------

S.richEnabled = true;

const richErrorText = error => String(error?.description || error?.message || error || '');

const noteRichError = error => {
  const text = richErrorText(error);
  if (/method not found|unknown method|not found: method/i.test(text)) {
    S.richEnabled = false;
    console.error('[RICH] Bot API has no rich message support — using plain HTML from now on.');
  } else {
    console.error('[RICH] falling back to plain HTML:', text);
  }
};

const cleanMarkup = markup => markup?.inline_keyboard
  ? { inline_keyboard: markup.inline_keyboard.filter(row => row.length > 0) }
  : markup;

// `extra` carries send options such as { disable_notification: true } (quiet hours); both paths honour it.
const rSend = async (chatId, richHtml, legacyHtml, markup, extra = {}) => {
  const reply_markup = cleanMarkup(markup);
  if (S.richEnabled && richHtml) {
    try {
      return await bot.api.raw.sendRichMessage({
        chat_id: chatId,
        rich_message: { html: richHtml },
        ...(reply_markup ? { reply_markup } : {}),
        ...extra,
      });
    } catch (error) {
      noteRichError(error);
    }
  }
  return bot.api.sendMessage(chatId, legacyHtml, {
    parse_mode: 'HTML',
    ...(reply_markup ? { reply_markup } : {}),
    ...extra,
  });
};

const rEdit = async (chatId, messageId, richHtml, legacyHtml, markup) => {
  const reply_markup = cleanMarkup(markup);
  if (S.richEnabled && richHtml) {
    try {
      return await bot.api.raw.editMessageText({
        chat_id: chatId,
        message_id: messageId,
        rich_message: { html: richHtml },
        ...(reply_markup ? { reply_markup } : {}),
      });
    } catch (error) {
      if (/message is not modified/i.test(richErrorText(error))) return null;
      noteRichError(error);
    }
  }
  return bot.api.editMessageText(chatId, messageId, legacyHtml, {
    parse_mode: 'HTML',
    ...(reply_markup ? { reply_markup } : {}),
  });
};

const notifyRich = (chatId, richHtml, legacyHtml, extra) => rSend(chatId, richHtml, legacyHtml, undefined, extra)
  .catch(() => {});

// ---------------------------------------------------------------------------
// QUIET HOURS — per user. Chatty alerts are still delivered, but silently (disable_notification),
// during the user's nightly window. Everything that needs a human stays audible.
// An alert kind that is not listed in QUIET_KINDS is ALWAYS audible: a new alert is never silenced by accident.
//   silent in quiet hours: connected / reconnecting / kicked / error / waiting (name in use, server full, throttle)
//                          / lobby (server offline) / watch (watchlist) / digest / hint / load (manager at its CPU limit)
//   always audible:        ban, whitelist, death, stuck, gaveup, health, proximity, restart (unclean-restart notice)
// ---------------------------------------------------------------------------

const QUIET_DEFAULT_WINDOW = Object.freeze({ start: 23, end: 7 });
const QUIET_KINDS = new Set(['connected', 'reconnecting', 'kicked', 'error', 'waiting', 'lobby', 'watch', 'digest', 'hint', 'load']);

const tzFormatters = new Map();

// Returns { tz } (tz null = the server's own clock) or null when the text is not a usable timezone.
const parseTz = raw => {
  const text = String(raw ?? '').trim();
  if (!text || /^(server|local|default)$/i.test(text)) return { tz: null };
  const offset = text.match(/^(?:utc|gmt)?\s*([+-])\s*(\d{1,2})(?::?(\d{2}))?$/i);
  if (offset) {
    const hours = Number(offset[2]);
    const minutes = Number(offset[3] || 0);
    const total = hours * 60 + minutes;
    const max = offset[1] === '-' ? 12 * 60 : 14 * 60;
    if (minutes > 59 || total > max) return null;
    return { tz: `UTC${offset[1]}${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}` };
  }
  try {
    return { tz: new Intl.DateTimeFormat('en-US', { timeZone: text }).resolvedOptions().timeZone };
  } catch (_) {
    return null;
  }
};

const localParts = (tz, ms) => {
  try {
    if (!tz) {
      const date = new Date(ms);
      return { hour: date.getHours(), minute: date.getMinutes() };
    }
    const offset = /^UTC([+-])(\d{2}):(\d{2})$/.exec(tz);
    if (offset) {
      const minutes = (offset[1] === '-' ? -1 : 1) * (Number(offset[2]) * 60 + Number(offset[3]));
      const date = new Date(ms + minutes * 60000);
      return { hour: date.getUTCHours(), minute: date.getUTCMinutes() };
    }
    let formatter = tzFormatters.get(tz);
    if (!formatter) {
      formatter = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', minute: 'numeric', hourCycle: 'h23' });
      tzFormatters.set(tz, formatter);
    }
    const parts = formatter.formatToParts(new Date(ms));
    return {
      hour: Number(parts.find(part => part.type === 'hour')?.value) % 24,
      minute: Number(parts.find(part => part.type === 'minute')?.value),
    };
  } catch (_) {
    const date = new Date(ms);
    return { hour: date.getHours(), minute: date.getMinutes() };
  }
};

const isQuietNow = (userId, now = Date.now()) => {
  const prefs = userId == null ? null : quietPrefs.get(String(userId));
  if (!prefs || !prefs.on || prefs.start === prefs.end) return false;
  return R.inScheduleWindow(localParts(prefs.tz, now).hour, prefs.start, prefs.end);
};

// Send options for an alert owned by `info`: silent only when this kind is quiet-able AND the owner is in quiet hours.
const alertOpts = (info, kind) => QUIET_KINDS.has(kind) && isQuietNow(info?.userId)
  ? { disable_notification: true }
  : undefined;

// Rich HTML building blocks (all inputs must already be escaped with esc()).
const rTable = (headers, rows) =>
  `<table bordered striped compact><tr>${headers.map(h => `<th>${h}</th>`).join('')}</tr>` +
  `${rows.map(row => `<tr>${row.map(cell => `<td>${cell}</td>`).join('')}</tr>`).join('')}</table>`;

const rTime = () =>
  `<tg-time unix="${Math.floor(Date.now() / 1000)}" format="wDT">now</tg-time>`;

const rFooter = label => `<footer>${label} ${rTime()}</footer>`;

// Inline keyboard button colors (Bot API 9.4+ `style`): primary / success / danger.
const BUTTON_STYLES = [
  [/^reconnect:/, 'success'],
  [/^restart:/, 'success'],
  [/^do_remove:/, 'danger'],
  [/^confirm_remove:/, 'danger'],
  [/^disconnect:/, 'danger'],
  [/^add_bot$/, 'primary'],
];

const styleKeyboard = keyboard => {
  for (const row of keyboard.inline_keyboard || []) {
    for (const button of row) {
      const match = BUTTON_STYLES.find(([pattern]) => pattern.test(button.callback_data || ''));
      if (match) button.style = match[1];
    }
  }
  return keyboard;
};

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

// Can this user add one more bot? Returns null (yes) or { kind: 'user' | 'total', limit, count }. Replacing a bot the user already
// owns (same name, host and port) adds nothing; users who already have more than the limit keep their bots and just cannot add.
const botLimitCheck = (userId, chatId, username, existing = null) => {
  if (existing && currentUserOwns(existing, userId, chatId, username)) return null;
  const mine = ownedBots(userId, chatId, username).length;
  if (CFG.MAX_BOTS_PER_USER && mine >= CFG.MAX_BOTS_PER_USER) return { kind: 'user', limit: CFG.MAX_BOTS_PER_USER, count: mine };
  if (CFG.MAX_BOTS_TOTAL && mcBots.size >= CFG.MAX_BOTS_TOTAL) return { kind: 'total', limit: CFG.MAX_BOTS_TOTAL, count: mcBots.size };
  return null;
};

const botLimitText = limit => limit.kind === 'user'
  ? `You already have ${limit.count} of ${limit.limit} bots. Remove one first (📋 My Bots) to add another.`
  : `This manager is full (${limit.count} of ${limit.limit} bots in total). Ask the owner to raise MAX_BOTS_TOTAL or remove a bot.`;

const botLimitLine = (userId, chatId, username) => {
  const mine = ownedBots(userId, chatId, username).length;
  const parts = [
    CFG.MAX_BOTS_PER_USER ? `${mine}/${CFG.MAX_BOTS_PER_USER} yours${mine >= CFG.MAX_BOTS_PER_USER ? ' (full)' : ''}` : `${mine} yours (no per-user limit)`,
    CFG.MAX_BOTS_TOTAL ? `${mcBots.size}/${CFG.MAX_BOTS_TOTAL} in total${mcBots.size >= CFG.MAX_BOTS_TOTAL ? ' (full)' : ''}` : `${mcBots.size} in total (no global limit)`,
  ];
  return parts.join(' · ');
};

const claimLegacyOwnership = (info, userId, username) => {
  if (!info || info.userId != null || !userId) return;
  if (!username || normUsername(info.ownerUsername) !== normUsername(username)) return;
  info.userId = userId;
  const legacyKey = `username:${normUsername(info.ownerUsername)}`;
  const userKeyValue = String(userId);
  const legacyGroups = forwardMap.get(legacyKey);
  if (legacyGroups?.size) {
    if (!forwardMap.has(userKeyValue)) forwardMap.set(userKeyValue, new Map());
    const target = forwardMap.get(userKeyValue);
    for (const [groupId, entry] of legacyGroups) if (!target.has(groupId)) target.set(groupId, entry);
    forwardMap.delete(legacyKey);
  }
  R.saveData();
};

// ---------------------------------------------------------------------------
// BUTTON / LOCATION HELPERS
// ---------------------------------------------------------------------------

// Adds a callback button and optionally colors it (Bot API 9.4+ `style`).
const styledText = (keyboard, label, data, style) => {
  keyboard.text(label, data);
  if (style) {
    const row = keyboard.inline_keyboard[keyboard.inline_keyboard.length - 1];
    row[row.length - 1].style = style;
  }
  return keyboard;
};

// Adds a "tap to copy" button (Bot API 7.11 `copy_text`).
const copyButton = (keyboard, label, text) => keyboard.add({ text: label, copy_text: { text: String(text).slice(0, 256) } });

const cleanPos = raw => raw && [raw.x, raw.y, raw.z].every(v => v != null && Number.isFinite(Number(v)))
  ? { x: Math.round(Number(raw.x)), y: Math.round(Number(raw.y)), z: Math.round(Number(raw.z)) }
  : null;

const cleanDim = raw => String(raw ?? '').replace(/^minecraft:/, '').slice(0, 40) || null;

const dimLabel = dim => {
  const value = String(dim || '').toLowerCase();
  if (!value) return null;
  if (value.includes('nether')) return '🔥 Nether';
  if (value.includes('end')) return '🌌 End';
  if (value.includes('overworld')) return '🌲 Overworld';
  return `🌐 ${value}`;
};

// Items (inventory + armor/offhand) at the moment of death, as [[name, count], ...] biggest stacks first.
const snapshotItems = client => {
  const totals = new Map();
  const add = (item, count) => {
    const key = String(item?.displayName || item?.name || '').slice(0, 40);
    if (key && count > 0) totals.set(key, (totals.get(key) || 0) + count);
  };
  try {
    for (const item of client?.inventory?.items?.() || []) add(item, Number(item.count) || 0);
    const slots = client?.inventory?.slots || [];
    for (const slot of [5, 6, 7, 8, 45]) if (slots[slot]) add(slots[slot], 1);
  } catch (_) {}
  const all = [...totals].sort((a, b) => b[1] - a[1]);
  return { items: all.slice(0, CFG.DEATH_ITEMS_MAX), total: all.reduce((sum, [, count]) => sum + count, 0) };
};

const cleanItems = raw => Array.isArray(raw)
  ? raw.filter(row => Array.isArray(row) && row[0] && Number.isFinite(Number(row[1])) && Number(row[1]) > 0)
    .slice(0, CFG.DEATH_ITEMS_MAX)
    .map(row => [String(row[0]).slice(0, 40), Math.round(Number(row[1]))])
  : [];

const snapshotLocation = client => {
  const pos = cleanPos(client?.entity?.position);
  return pos ? { pos, dim: cleanDim(client.game?.dimension) } : null;
};

const posText = pos => pos ? `${pos.x} ${pos.y} ${pos.z}` : '—';

// Rich table cell / legacy line for a position (+ optional dimension).
const locCell = (pos, dim) => pos
  ? `<code>${posText(pos)}</code>${dimLabel(dim) ? `<br>${esc(dimLabel(dim))}` : ''}`
  : '—';
const locLine = (pos, dim) => pos
  ? `<code>${posText(pos)}</code>${dimLabel(dim) ? ` · ${esc(dimLabel(dim))}` : ''}`
  : '—';

const tgTime = (ms, format = 'dt') =>
  `<tg-time unix="${Math.floor(ms / 1000)}" format="${format}">${new Date(ms).toISOString().replace('T', ' ').slice(0, 16)} UTC</tg-time>`;
const utcText = ms => `${new Date(ms).toISOString().replace('T', ' ').slice(0, 16)} UTC`;

const forwardKeyFor = info => userKey(info.userId) || `username:${normUsername(info.ownerUsername)}`;

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
// AUTO-REPLY TRIGGERS
// `*` is a wildcard for any run of characters. Matching is done with plain
// indexOf over the literal segments (no regex), so it is linear-time and a
// trigger can never cause catastrophic backtracking. A trigger without `*`
// keeps the original case-insensitive substring match.
// ---------------------------------------------------------------------------

const triggerMatches = (trigger, message) => {
  if (!trigger || typeof message !== 'string') return false;
  const text = message.toLowerCase();
  const needle = trigger.toLowerCase();
  if (!needle.includes('*')) return text.includes(needle);
  let position = 0;
  for (const segment of needle.split('*')) {
    if (!segment) continue;
    const found = text.indexOf(segment, position);
    if (found < 0) return false;
    position = found + segment.length;
  }
  return true;
};

Object.assign(R, { richErrorText, noteRichError, cleanMarkup, rSend, rEdit, notifyRich, QUIET_DEFAULT_WINDOW,
  QUIET_KINDS, tzFormatters, parseTz, localParts, isQuietNow, alertOpts, rTable, rTime, rFooter, BUTTON_STYLES,
  styleKeyboard, userKey, currentUserOwns, getBot, ownedBots, botLimitCheck, botLimitText, botLimitLine,
  claimLegacyOwnership, styledText, copyButton, cleanPos, cleanDim, dimLabel, snapshotItems, cleanItems,
  snapshotLocation, posText, locCell, locLine, tgTime, utcText, forwardKeyFor, formatMinecraftReason, triggerMatches });
