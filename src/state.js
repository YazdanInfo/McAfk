'use strict';
// Shared state (bots, forwards, watchlists), the Telegram client, access control.
const R = require('./registry');
const { S } = R;
const { Bot } = require('grammy');
const { TOKEN } = R;

// ---------------------------------------------------------------------------
// STATE
// ---------------------------------------------------------------------------

const mcBots = new Map();
const chatStates = new Map();
const forwardMap = new Map(); // userKey -> Map<chatId(string), { active, title, type, addedAt, bots, lastError }>
const digestSubs = new Map(); // userId(string) -> chatId that receives the hourly digest
const watchlists = new Map(); // userId(string) -> string[] player names to watch
const quietPrefs = new Map(); // userId(string) -> { on, start, end, tz } quiet hours (tz null = server clock)
const bot = new Bot(TOKEN);

// Heartbeat input: the last time Telegram answered one of our API calls (long polling counts).
S.lastTelegramOkAt = 0;
bot.api.config.use(async (prev, method, payload, signal) => {
  const res = await prev(method, payload, signal);
  if (res?.ok) S.lastTelegramOkAt = Date.now();
  return res;
});

// Allowlist: ALLOWED_USER_IDS="123456789,987654321". With it empty the manager is CLOSED to everyone, unless the owner opts in
// to the old open behaviour with ALLOW_OPEN_ACCESS=1 (anyone who finds the bot could then add bots until the VPS runs out of memory).
const ALLOWED_USER_IDS = new Set(String(process.env.ALLOWED_USER_IDS || '').split(/[\s,]+/).filter(id => /^\d+$/.test(id)));
const OPEN_ACCESS = ALLOWED_USER_IDS.size === 0 && process.env.ALLOW_OPEN_ACCESS === '1';
const accessMode = () => ALLOWED_USER_IDS.size ? 'restricted' : OPEN_ACCESS ? 'open' : 'closed';
const isUserAllowed = id => accessMode() === 'open' || Boolean(id && ALLOWED_USER_IDS.has(String(id)));
const deniedSeen = new Map(); // userId -> last time we logged / answered

bot.use(async (ctx, next) => {
  const id = ctx.from?.id;
  if (isUserAllowed(id)) return next();
  const now = Date.now();
  const fresh = !id || now - (deniedSeen.get(id) || 0) > 60 * 60 * 1000;
  if (id && fresh) {
    deniedSeen.set(id, now);
    console.log(`⛔ blocked user ${id}${ctx.from?.username ? ` (@${ctx.from.username})` : ''}`);
  }
  try {
    if (ctx.callbackQuery) await ctx.answerCallbackQuery({ text: '⛔ This bot is private.', show_alert: true });
    else if (fresh && ctx.chat?.type === 'private' && ctx.message) {
      // Not configured yet: show the person their own ID, so the owner can paste it into ALLOWED_USER_IDS without reading logs.
      await ctx.reply(accessMode() === 'closed' && id
        ? `⛔ This bot is private.\nYour Telegram ID: ${id}\n(The owner can put it in ALLOWED_USER_IDS and restart.)`
        : '⛔ This bot is private.');
    }
  } catch (_) {}
});

S.loading = false;
S.saveTimer = null;
S.shuttingDown = false;

Object.assign(R, { mcBots, chatStates, forwardMap, digestSubs, watchlists, quietPrefs, bot, ALLOWED_USER_IDS,
  OPEN_ACCESS, accessMode, isUserAllowed, deniedSeen });
