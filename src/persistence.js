'use strict';
// userdata.json: save, load, backups, bot records.
const R = require('./registry');
const { S } = R;
const fs = require('fs');
const path = require('path');
const { CFG, DATA, DATA_TMP, MAX_KEYS_PER_USER, QUIET_DEFAULT_WINDOW, botIdFor, cleanDim, cleanItems, cleanPos,
  digestSubs, forwardMap, mcBots, normUsername, normalizeSettings, parseTz, quietPrefs, safeJsonParse,
  sanitizeKeyStoreRecord, userKeys, watchlists } = R;

// ---------------------------------------------------------------------------
// PERSISTENCE
// ---------------------------------------------------------------------------

// Should this bot come back by itself after a restart? `wantedOnline` is captured at shutdown, before autoReconnect is
// cleared for the clean stop (otherwise every bot would be saved as paused); `resumePending` covers the boot-time window in
// which a bot is waiting for its resume turn and a save must not record it as paused.
const wantsOnline = info => Boolean(info.resumePending) || (info.wantedOnline ?? info.autoReconnect !== false);

const serialiseBot = info => ({
  id: String(info.id),
  name: info.name,
  host: info.host,
  port: info.port,
  version: info.version,
  chatId: info.chatId,
  userId: info.userId ?? null,
  ownerUsername: info.ownerUsername || null,
  paused: !wantsOnline(info),
  createdAt: info.createdAt || new Date().toISOString(),
  autos: [...(info.autos?.values() || [])].map(auto => ({
    action: auto.action,
    direction: auto.direction,
    blocks: auto.blocks,
    minSec: auto.minSec,
    maxSec: auto.maxSec,
  })),
  settings: normalizeSettings(info.settings),
  autoReplies: (info.autoReplies || []).map(r => ({
    trigger: r.trigger,
    response: r.response,
    cooldownSec: r.cooldownSec ?? CFG.AUTOREPLY_DEFAULT_COOLDOWN_SEC,
  })),
  deathHistory: (info.deathHistory || []).slice(0, CFG.DEATH_HISTORY_MAX),
});

const backupPath = n => `${DATA}.bak${n}`;
S.lastBackupAt = null;

const backupInfo = () => {
  let count = 0;
  let newestAt = 0;
  for (let n = 1; n <= CFG.BACKUP_KEEP; n += 1) {
    try {
      const st = fs.statSync(backupPath(n));
      count += 1;
      newestAt = Math.max(newestAt, st.mtimeMs);
    } catch (_) {}
  }
  return { count, newestAt };
};

const isValidDataFile = file => {
  try {
    const parsed = safeJsonParse(fs.readFileSync(file, 'utf8'), null);
    return Boolean(parsed) && typeof parsed === 'object' && !Array.isArray(parsed);
  } catch (_) {
    return false;
  }
};

// Keeps the last CFG.BACKUP_KEEP copies, at most one per CFG.BACKUP_INTERVAL_MS. The copy is taken from the file
// that is about to be replaced, so a bad edit is still recoverable from the copy made just before it.
const rotateBackups = () => {
  if (S.lastBackupAt === null) S.lastBackupAt = backupInfo().newestAt;
  if (Date.now() - S.lastBackupAt < CFG.BACKUP_INTERVAL_MS) return;
  if (!fs.existsSync(DATA) || !isValidDataFile(DATA)) return; // never rotate a broken file into the backups
  try {
    for (let n = CFG.BACKUP_KEEP; n >= 2; n -= 1) {
      if (fs.existsSync(backupPath(n - 1))) fs.renameSync(backupPath(n - 1), backupPath(n));
    }
    fs.copyFileSync(DATA, backupPath(1));
    try { fs.chmodSync(backupPath(1), 0o600); } catch (_) {}
    S.lastBackupAt = Date.now();
  } catch (error) {
    console.error('backup:', error.message);
  }
};

// A truncated/unreadable userdata.json must never be silently replaced by an empty one.
const restoreFromBackupIfCorrupt = () => {
  if (!fs.existsSync(DATA) || isValidDataFile(DATA)) return;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const kept = `${DATA}.corrupt-${stamp}`;
  try { fs.copyFileSync(DATA, kept); } catch (_) {}
  for (let n = 1; n <= CFG.BACKUP_KEEP; n += 1) {
    if (fs.existsSync(backupPath(n)) && isValidDataFile(backupPath(n))) {
      fs.copyFileSync(backupPath(n), DATA);
      console.error(`⚠️ userdata.json was unreadable — restored from backup ${n}. The broken file was kept as ${path.basename(kept)}`);
      return;
    }
  }
  console.error(`⚠️ userdata.json is unreadable and no valid backup exists. The broken file was kept as ${path.basename(kept)}`);
};

const persistNow = () => {
  const data = {
    meta: {
      version: CFG.DATA_VERSION,
      updatedAt: new Date().toISOString(),
      app: 'mcafk',
    },
    bots: [...mcBots.values()].map(serialiseBot),
    forwards: Object.fromEntries([...forwardMap].map(([key, dests]) => [key, [...dests].map(([chatId, entry]) => ({
      chatId,
      active: entry.active !== false,
      title: entry.title || '',
      type: entry.type || 'group',
      addedAt: entry.addedAt || null,
      bots: Array.isArray(entry.bots) ? entry.bots : null,
      lastError: entry.lastError || null,
      filter: entry.filter || 'all',
      twoWay: Boolean(entry.twoWay),
    }))])),
    digests: Object.fromEntries([...digestSubs]),
    watch: Object.fromEntries([...watchlists]),
    quiet: Object.fromEntries([...quietPrefs]),
    keySalt: S.keySalt,
    apiKeys: Object.fromEntries([...userKeys]),
  };

  rotateBackups();
  try {
    fs.writeFileSync(DATA_TMP, JSON.stringify(data, null, 2), { encoding: 'utf8', mode: 0o600 });
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
  if (S.loading || S.shuttingDown) return;
  if (S.saveTimer) clearTimeout(S.saveTimer);
  S.saveTimer = setTimeout(() => {
    S.saveTimer = null;
    persistNow();
  }, CFG.SAVE_DEBOUNCE_MS);
};

const normalizeFwdEntry = (raw, chatId) => ({
  active: raw?.active !== false,
  title: String(raw?.title || '').slice(0, 100),
  type: ['private', 'group', 'supergroup', 'channel'].includes(raw?.type)
    ? raw.type
    : (Number(chatId) > 0 ? 'private' : 'group'),
  addedAt: Number.isFinite(Number(raw?.addedAt)) && raw?.addedAt != null ? Number(raw.addedAt) : Date.now(),
  bots: Array.isArray(raw?.bots) ? raw.bots.map(String).filter(id => /^\d+$/.test(id)) : null,
  lastError: raw?.lastError ? String(raw.lastError).slice(0, 120) : null,
  filter: ['all', 'chat_deaths', 'chat'].includes(raw?.filter) ? raw.filter : 'all',
  twoWay: raw?.type !== 'channel' && Boolean(raw?.twoWay),
});

const migrateForwardKey = (key, bots) => {
  const stringKey = String(key);
  if (/^-?\d+$/.test(stringKey)) return stringKey;
  if (stringKey.startsWith('username:')) return stringKey;
  const owner = bots.find(info => normUsername(info.ownerUsername) === normUsername(stringKey));
  return owner?.userId != null ? String(owner.userId) : `username:${normUsername(stringKey)}`;
};

const makePausedBot = (record, { resume = false } = {}) => {
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
    error: resume ? 'Resuming after restart…' : 'Paused after restart — press Reconnect to resume',
    resumePending: resume,
    autoReconnect: false,
    reconnectAttempts: 0,
    reconnectTimer: null,
    autos: new Map(),
    settings: normalizeSettings(record.settings),
    autoReplies: Array.isArray(record.autoReplies)
      ? record.autoReplies
        .filter(r => r && typeof r.trigger === 'string' && typeof r.response === 'string')
        .slice(0, 20)
        .map(r => ({
          trigger: r.trigger,
          response: r.response,
          cooldownSec: Number.isFinite(Number(r.cooldownSec))
            ? Math.min(Math.max(Number(r.cooldownSec), 0), CFG.AUTOREPLY_MAX_COOLDOWN_SEC)
            : CFG.AUTOREPLY_DEFAULT_COOLDOWN_SEC,
          lastFiredAt: 0,
        }))
      : [],
    deathHistory: Array.isArray(record.deathHistory)
      ? record.deathHistory
        .filter(d => d && Number.isFinite(Number(d.at)))
        .slice(0, CFG.DEATH_HISTORY_MAX)
        .map(d => ({
          cause: String(d.cause || 'Unknown').slice(0, 200),
          at: Number(d.at),
          pos: cleanPos(d.pos),
          dim: cleanDim(d.dim),
          respawn: cleanPos(d.respawn),
          items: cleanItems(d.items),
          itemTotal: Number.isFinite(Number(d.itemTotal)) ? Math.max(0, Math.round(Number(d.itemTotal))) : 0,
        }))
      : [],
    sessionStats: { distance: 0, respawns: 0 },
    hourStats: { deaths: 0, drops: 0 },
    lastHealth: 20,
    nearbyPlayers: new Set(),
    tickTimer: null,
  };
};

const loadData = () => {
  try {
    recoverTempData();
  } catch (error) {
    console.error('userdata recovery:', error.message);
  }
  try {
    restoreFromBackupIfCorrupt();
  } catch (error) {
    console.error('userdata backup restore:', error.message);
  }
  if (!fs.existsSync(DATA)) {
    persistNow();
    return;
  }

  S.loading = true;
  try {
    const parsed = safeJsonParse(fs.readFileSync(DATA, 'utf8'), null);
    if (!parsed || typeof parsed !== 'object') throw new Error('invalid JSON root');

    const loadedBots = [];
    let migrated = parsed.meta?.version !== CFG.DATA_VERSION;
    for (const record of Array.isArray(parsed.bots) ? parsed.bots : []) {
      if (!record?.name || !record?.host || !record?.port) continue;
      // `paused: false` = it was meant to be running when the process stopped. Files from before v15 recorded every bot as
      // paused at a clean stop, so the first restart after upgrading still pauses everything.
      const info = makePausedBot(record, { resume: CFG.AUTO_RESUME && record.paused === false });
      if (mcBots.has(info.id)) {
        console.error(`loadData: duplicate bot id ${info.id}; keeping the first record`);
        migrated = true;
        continue;
      }
      mcBots.set(info.id, info);
      R.restoreAutos(info, record.autos);
      loadedBots.push(info);
    }

    for (const [key, items] of Object.entries(parsed.forwards || {})) {
      const migratedKey = migrateForwardKey(key, loadedBots);
      if (migratedKey !== String(key)) migrated = true;
      const list = Array.isArray(items) ? items : [];
      if (!forwardMap.has(migratedKey)) forwardMap.set(migratedKey, new Map());
      const dests = forwardMap.get(migratedKey);
      for (const item of list) {
        const isObject = item && typeof item === 'object';
        const rawId = isObject ? item.chatId : item;
        if (!/^-?\d+$/.test(String(rawId))) { migrated = true; continue; }
        if (!isObject) migrated = true; // v3 format: plain chat id => active forward
        if (!dests.has(String(rawId))) dests.set(String(rawId), normalizeFwdEntry(isObject ? item : {}, String(rawId)));
      }
      if (!dests.size) forwardMap.delete(migratedKey);
    }

    for (const [key, chatId] of Object.entries(parsed.digests || {})) {
      if (/^\d+$/.test(String(key)) && /^-?\d+$/.test(String(chatId))) digestSubs.set(String(key), chatId);
    }

    for (const [key, names] of Object.entries(parsed.watch || {})) {
      if (!/^\d+$/.test(String(key)) || !Array.isArray(names)) continue;
      const clean = [];
      for (const name of names) {
        const value = String(name);
        if (/^[A-Za-z0-9_.]{1,17}$/.test(value) && !clean.some(n => n.toLowerCase() === value.toLowerCase())) clean.push(value);
      }
      if (clean.length) watchlists.set(String(key), clean.slice(0, CFG.WATCH_MAX));
    }

    for (const [key, raw] of Object.entries(parsed.quiet || {})) {
      if (!/^\d+$/.test(String(key)) || !raw || typeof raw !== 'object') continue;
      const hour = value => Number.isInteger(value) && value >= 0 && value <= 23;
      const valid = hour(raw.start) && hour(raw.end) && raw.start !== raw.end;
      quietPrefs.set(String(key), {
        on: Boolean(raw.on) && valid,
        start: valid ? raw.start : QUIET_DEFAULT_WINDOW.start,
        end: valid ? raw.end : QUIET_DEFAULT_WINDOW.end,
        tz: parseTz(raw.tz)?.tz ?? null,
      });
    }

    if (typeof parsed.keySalt === 'string' && /^[A-Za-z0-9+/=]{16,64}$/.test(parsed.keySalt)) S.keySalt = parsed.keySalt;
    for (const [uid, store] of Object.entries(parsed.apiKeys || {})) {
      if (!/^\d+$/.test(uid) || !Array.isArray(store?.keys)) continue;
      const keys = store.keys.map(sanitizeKeyStoreRecord).filter(Boolean).slice(0, MAX_KEYS_PER_USER);
      if (!keys.length) continue;
      userKeys.set(uid, { active: keys.some(k => k.id === store.active) ? store.active : keys[0].id, keys });
    }

    const resuming = loadedBots.filter(info => info.resumePending).length;
    console.log(`📦 ${loadedBots.length} bot(s) loaded: ${resuming} will reconnect by themselves, ${loadedBots.length - resuming} stay paused until you press Reconnect.`);
    if (migrated) persistNow();
  } catch (error) {
    console.error('loadData:', error.message);
  } finally {
    S.loading = false;
  }
};

Object.assign(R, { wantsOnline, serialiseBot, backupPath, backupInfo, isValidDataFile, rotateBackups,
  restoreFromBackupIfCorrupt, persistNow, recoverTempData, saveData, normalizeFwdEntry, migrateForwardKey,
  makePausedBot, loadData });
