'use strict';
// Small formatting and id helpers.
const R = require('./registry');
const { CFG, bot } = R;

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

const notify = (chatId, text, extra = {}) => bot.api
  .sendMessage(chatId, text, { parse_mode: 'HTML', ...extra })
  .catch(() => {});

Object.assign(R, { esc, stripColors, normUsername, uptime, dot, ownerTag, hashId, botIdFor, statusLabel,
  shortBotName, reconnectDelay, safeJsonParse, notify });
