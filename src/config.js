'use strict';
// Environment parsing, CFG constants, default settings.
const R = require('./registry');
const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// CONFIG 
// ---------------------------------------------------------------------------

// Non-negative number from the environment (0 is allowed, unlike `Number(x) || default`).
const envMs = (name, fallback) => {
  const raw = process.env[name];
  const value = Number(raw);
  return raw !== undefined && raw !== '' && Number.isFinite(value) && value >= 0 ? value : fallback;
};

// Whole number >= 0 from the environment (0 = "no limit" for the caps below).
const envCount = (name, fallback) => {
  const raw = process.env[name];
  const value = Number(raw);
  return raw !== undefined && raw !== '' && Number.isInteger(value) && value >= 0 ? value : fallback;
};

// How many chunks around the bot the server sends. The loaded world is the biggest memory cost of a bot and grows with the
// SQUARE of this radius. MC_VIEW_DISTANCE=4 (default) | 2..32 | default (= leave it to mineflayer, which asks for the most).
const VIEW_DISTANCE_DEFAULT = 4;
const parseViewDistance = raw => {
  const text = String(raw ?? '').trim().toLowerCase();
  if (!text) return VIEW_DISTANCE_DEFAULT;
  if (text === 'default') return null;
  const value = Number(text);
  if (Number.isInteger(value) && value >= 2 && value <= 32) return value;
  console.error(`⚠️ MC_VIEW_DISTANCE="${raw}" is not a whole number from 2 to 32 (or "default") — using ${VIEW_DISTANCE_DEFAULT}.`);
  return VIEW_DISTANCE_DEFAULT;
};
const VIEW_DISTANCE = parseViewDistance(process.env.MC_VIEW_DISTANCE);

// Optional (default OFF): a bot that has stood still for a while asks the server for a smaller world, and asks for its normal one
// again when it moves. MC_IDLE_VIEW_DISTANCE=2..32 turns it on, MC_IDLE_AFTER_MIN is how long it must stand still (default 30).
const parseIdleViewDistance = raw => {
  const text = String(raw ?? '').trim().toLowerCase();
  if (!text || text === 'off') return null;
  const value = Number(text);
  if (Number.isInteger(value) && value >= 2 && value <= 32) return value;
  console.error(`⚠️ MC_IDLE_VIEW_DISTANCE="${raw}" is not a whole number from 2 to 32 (or "off") — idle view reduction stays off.`);
  return null;
};
const IDLE_VIEW_DISTANCE = parseIdleViewDistance(process.env.MC_IDLE_VIEW_DISTANCE);

const CFG = Object.freeze({
  DEFAULT_VERSION: '1.20.4',
  MAX_RECONNECTS: 10,
  BASE_RECONNECT_MS: 5000,
  MAX_RECONNECT_MS: 60000,
  MC_TIMEOUT_MS: 30000,
  SAVE_DEBOUNCE_MS: 500,
  DATA_VERSION: 5,
  PING_TIMEOUT_MS: Number(process.env.PING_TIMEOUT_MS) || 4000,
  PREFLIGHT_MAX_SKIPS: 5,      // after this many "server shows offline" skips, join anyway once
  KICK_DUP_RETRY_MS: Number(process.env.KICK_DUP_RETRY_MS) || 2 * 60 * 1000,  // "logged in from another location"
  KICK_FULL_RETRY_MS: Number(process.env.KICK_FULL_RETRY_MS) || 60 * 1000,    // "server is full"
  BACKUP_INTERVAL_MS: Number(process.env.BACKUP_INTERVAL_MS) || 60 * 60 * 1000,
  BACKUP_KEEP: 3,
  DEATH_ITEMS_MAX: 15,
  FWD_BATCH_MS: Number(process.env.FWD_BATCH_MS) || 3500, // min gap between messages to one destination (Telegram: ~20/min per group)
  FWD_BUFFER_MAX: 200,         // lines buffered per destination before the oldest are dropped
  FWD_FLUSH_TIMEOUT_MS: 4000,  // max time to wait for buffered forwards on shutdown
  FWD_CHUNK_CHARS: 3800,       // Telegram limit is 4096
  MC_CHAT_MAX: 256,
  WATCH_MAX: 30,
  WATCH_SETTLE_MS: Number(process.env.WATCH_SETTLE_MS) || 5000, // ignore the tab-list burst right after joining
  WATCH_DEDUPE_MS: 15 * 1000,
  STUCK_MIN: 5,
  STUCK_MAX: 720,
  STUCK_UNIT_MS: Number(process.env.STUCK_UNIT_MS) || 60 * 1000,
  LOBBY_CHECK_MS: 2000,        // after spawn, wait this long for the real gamemode before judging
  LOBBY_RETRY_MS: Number(process.env.LOBBY_RETRY_MS) || 3 * 60 * 1000, // server looks off (lobby) -> try again after this
  FORWARD_MAX: 10,             // forward destinations per user
  WIZARD_TTL_MS: 10 * 60 * 1000,
  LOW_HEALTH: 6,               // 3 hearts
  DAMAGE_ALERT_THRESHOLD: 2,   // 1 heart drop
  GIVEUP_RETRY_MS: 5 * 60 * 1000,  // after giving up, keep retrying forever at this slower cadence
  TICK_MS: Number(process.env.TICK_MS) || 5000,               // per-bot background tick: proximity / idle / sleep
  IDLE_CHANCE: 0.15,           // chance per tick to do a small idle action
  SCHEDULE_CHECK_MS: 60 * 1000,
  JOIN_GAP_MS: envMs('JOIN_GAP_MS', 5000),                 // min gap between two join attempts to the same host:port (Paper/Spigot throttle ~4 s); 0 = off
  THROTTLE_RETRY_MS: envMs('THROTTLE_RETRY_MS', 5000),     // "Connection throttled" kick: try again after this, without using up a reconnect attempt
  MAX_BOTS_PER_USER: envCount('MAX_BOTS_PER_USER', 5),     // bots one user may have; 0 = no limit (users who already have more keep them, they just cannot add)
  MAX_BOTS_TOTAL: envCount('MAX_BOTS_TOTAL', 20),          // bots in the whole manager; 0 = no limit
  AUTO_RESUME: process.env.AUTO_RESUME !== '0',            // bots that were running when the process stopped reconnect by themselves
  RESUME_SPREAD_MS: envMs('RESUME_SPREAD_MS', 300),        // gap between the resume starts at boot (the join queue then spaces the actual logins)
  IDLE_VIEW_AFTER_MS: envCount('MC_IDLE_AFTER_MIN', 30) * 60 * 1000 || 30 * 60 * 1000,
  CRASH_LOOP_STARTS: envCount('RESUME_CRASH_LOOP_STARTS', 3), // unclean starts in a row (within the window below) after which bots are NOT auto-resumed; 0 = never hold
  CRASH_LOOP_WINDOW_MS: 10 * 60 * 1000,
  ALLOW_PRIVATE_HOSTS: process.env.MC_ALLOW_PRIVATE_HOSTS === '1', // allow bots on loopback / LAN / link-local addresses (a server on this VPS or your network)
  JOIN_DNS_TIMEOUT_MS: 2000,                               // resolving the host for the join queue key; on failure the host name itself is the key
  JOIN_KEY_TTL_MS: 5 * 60 * 1000,                          // how long a host -> IP answer is reused
  RESTART_NOTICE_MIN_GAP_MS: 10 * 60 * 1000,               // a crash loop sends at most one "restarted" notice per this long
  THROTTLE_MAX_STREAK: 12,                                 // this many throttle kicks in a row => fall back to the normal backoff
  HEARTBEAT_INTERVAL_MS: envMs('HEARTBEAT_INTERVAL_MS', 60 * 1000) || 60 * 1000,
  HEARTBEAT_TG_STALE_MS: envMs('HEARTBEAT_TG_STALE_MS', 3 * 60 * 1000), // Telegram must have answered within this long to count as healthy
  HEARTBEAT_TIMEOUT_MS: 10 * 1000,
  LOAD_SAMPLE_MS: 60 * 1000,           // /status "Load" row: CPU and event-loop lag are sampled this often
  LOAD_WARN_CPU_PCT: 85,               // % of ONE core (all bots share one Node thread) ...
  LOAD_WARN_LAG_MS: 250,               // ... or event-loop lag p99 above this, for LOAD_WARN_SAMPLES samples in a row => "saturated"
  LOAD_WARN_SAMPLES: 3,
  LOAD_NOTICE_MIN_GAP_MS: 30 * 60 * 1000, // at most one Telegram "saturated" notice per this long (a load that flaps around the threshold must not spam)
  AUTOREPLY_DEFAULT_COOLDOWN_SEC: 10,
  AUTOREPLY_MAX_COOLDOWN_SEC: 3600,
  DEATH_HISTORY_MAX: 10,
  DIGEST_INTERVAL_MS: 60 * 60 * 1000,
  STALE_PACKET_MS: 45 * 1000,          // online but silent this long => connection is dead
  HEALTH_ALERT_WINDOW_MS: 60 * 1000,   // damage within this long of the last hit edits the same message
  HEALTH_ALERT_EDIT_MS: 1500,          // min gap between edits of the damage message
  DEATH_ALERT_DELAY_MS: 400,           // wait for the death message so the cause is known
  AI_TIMEOUT_MS: 15 * 1000,
  AI_MAX_TOKENS: 120,
  AI_MAX_REPLY_CHARS: 200,             // Minecraft chat limit is 256
  AI_MAX_INPUT_CHARS: 300,
  AI_PLAYER_COOLDOWN_MS: 8 * 1000,     // per player, per bot
  AI_GLOBAL_GAP_MS: 2500,              // min gap between two AI replies of one bot
  AI_CONTEXT_LINES: 8,
  AI_PERSONA_MAX: 300,
});

const FOOD_ITEMS = [
  'bread', 'baked_potato', 'cooked_beef', 'cooked_porkchop', 'cooked_chicken',
  'cooked_mutton', 'cooked_rabbit', 'cooked_cod', 'cooked_salmon', 'apple',
  'golden_apple', 'golden_carrot', 'carrot', 'melon_slice', 'sweet_berries',
  'pumpkin_pie', 'mushroom_stew', 'beetroot_soup', 'rabbit_stew', 'cookie',
];

const DEATH_PATTERN = /\b(was slain by|was shot by|was killed by|drowned|fell|hit the ground too hard|burned to death|went up in flames|blew up|was blown up|starved to death|suffocated|was pricked to death|tried to swim in lava|fell out of the world|withered away|was struck by lightning|froze to death|was squashed|was fireballed by|discovered the floor was lava)\b/i;

const defaultSettings = () => ({
  autoEat: true,
  autoRespawn: true,
  healthAlerts: true,
  idleRandomizer: true,
  autoSleep: false,
  lobbyGuard: true,
  proximityRadius: null,
  viewDistance: null, // null = follow MC_VIEW_DISTANCE; 2-32 = chunks this bot asks the server for
  stuckMinutes: null, // null = off; flag a bot that has not moved and heard nothing for this many minutes
  schedule: null, // { start, end } hours 0-23, server-local time
  aiChat: false,
  aiMode: 'mention', // 'mention' = only when the bot's name is said, 'all' = every message
  aiPersona: '',
});

const normalizeSettings = raw => {
  const merged = { ...defaultSettings(), ...(raw || {}) };
  merged.aiChat = Boolean(merged.aiChat);
  if (merged.aiMode !== 'all') merged.aiMode = 'mention';
  merged.aiPersona = typeof merged.aiPersona === 'string' ? merged.aiPersona.slice(0, CFG.AI_PERSONA_MAX) : '';
  const stuck = Number(merged.stuckMinutes);
  const view = Number(merged.viewDistance);
  merged.viewDistance = Number.isInteger(view) && view >= 2 && view <= 32 ? view : null;
  merged.stuckMinutes = Number.isFinite(stuck) && stuck > 0 ? Math.min(Math.max(Math.round(stuck), CFG.STUCK_MIN), CFG.STUCK_MAX) : null;
  return merged;
};

const AUTO_MIN_SECONDS = 5;
const AUTO_MAX_SECONDS = 86400;

const IS_TEST = process.env.MCAFK_TEST === '1'; // test/ loads index.js with stubs and drives it directly
const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!TOKEN) {
  console.error('TELEGRAM_BOT_TOKEN not set');
  process.exit(1);
}

const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.resolve(__dirname, '..'); // default: next to index.js
try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (_) {}
const DATA = path.join(DATA_DIR, 'userdata.json');
const DATA_TMP = `${DATA}.tmp`;

Object.assign(R, { envMs, envCount, VIEW_DISTANCE_DEFAULT, parseViewDistance, VIEW_DISTANCE, parseIdleViewDistance,
  IDLE_VIEW_DISTANCE, CFG, FOOD_ITEMS, DEATH_PATTERN, defaultSettings, normalizeSettings, AUTO_MIN_SECONDS,
  AUTO_MAX_SECONDS, IS_TEST, TOKEN, DATA_DIR, DATA, DATA_TMP });
