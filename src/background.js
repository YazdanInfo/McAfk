'use strict';
// Auto-eat, proximity, idle randomizer, stuck alert, watchlist events, health alerts.
const R = require('./registry');
const { InlineKeyboard } = require('grammy');
const { CFG, FOOD_ITEMS, alertOpts, esc, getBot, notifyRich, rEdit, rFooter, rSend, styleKeyboard, watchlists } = R;

// ---------------------------------------------------------------------------
// BACKGROUND FEATURES (auto-eat, alerts, proximity, idle randomizer, sleep)
// ---------------------------------------------------------------------------

const eatingNow = new Set();

const maybeAutoEat = async (info, client) => {
  if (!client || !info.settings.autoEat || eatingNow.has(info.id)) return;
  if (client.food == null || client.food > 14) return;
  const item = client.inventory?.items().find(i => FOOD_ITEMS.includes(i.name));
  if (!item) return;
  eatingNow.add(info.id);
  try {
    await client.equip(item, 'hand');
    if (typeof client.consume === 'function') {
      await client.consume();
    } else {
      client.activateItem();
      await new Promise(resolve => setTimeout(resolve, 1700));
      client.deactivateItem();
    }
  } catch (error) {
    console.error(`[EAT] ${info.name}:`, error.message);
  } finally {
    eatingNow.delete(info.id);
  }
};

const checkProximity = (info, client) => {
  const radius = info.settings.proximityRadius;
  if (!radius || !client.entity) return;
  const me = client.entity.position;
  const seen = new Set();
  for (const entity of Object.values(client.entities || {})) {
    if (entity.type !== 'player' || !entity.username || entity.username === client.username) continue;
    const distance = entity.position?.distanceTo ? entity.position.distanceTo(me) : Infinity;
    if (distance <= radius) {
      seen.add(entity.username);
      if (!info.nearbyPlayers.has(entity.username)) {
        notifyRich(info.chatId,
          `<h4>👀 Player nearby</h4><p><b>${esc(entity.username)}</b> is ${distance.toFixed(0)}m from <b>${esc(info.name)}</b>.</p>${rFooter('Spotted')}`,
          `👀 <b>${esc(entity.username)}</b> is ${distance.toFixed(0)}m from <b>${esc(info.name)}</b>.`,
          alertOpts(info, 'proximity'));
      }
    }
  }
  info.nearbyPlayers = seen;
};

const runIdleAction = client => {
  const roll = Math.random();
  try {
    if (roll < 0.5) {
      const yaw = Math.random() * Math.PI * 2 - Math.PI;
      const pitch = Math.random() * 0.6 - 0.3;
      client.look(yaw, pitch, true);
    } else if (roll < 0.8) {
      client.setControlState('jump', true);
      setTimeout(() => { try { client.setControlState('jump', false); } catch (_) {} }, 250);
    } else {
      client.setControlState('sneak', true);
      setTimeout(() => { try { client.setControlState('sneak', false); } catch (_) {} }, 800);
    }
  } catch (_) {}
};

const trySleep = async (info, client) => {
  if (!info.settings.autoSleep || client.isSleeping) return;
  if (client.time?.isDay) return;
  const bed = client.findBlock?.({ matching: block => /bed$/.test(block.name), maxDistance: 16 });
  if (!bed) return;
  try { await client.sleep(bed); } catch (_) {}
};

// ---------------------------------------------------------------------------
// STUCK ALERT — opt-in per bot (/settings → 🧊 Stuck alert). Flags a bot that has not moved horizontally
// AND has heard no chat / join / leave for N minutes (e.g. a proxy keeping it in limbo).
// ---------------------------------------------------------------------------

const trackStuck = (info, client) => {
  const now = Date.now();
  const pos = client.entity.position;
  const st = info.stuck || (info.stuck = { pos: null, movedAt: now, alerted: false });
  if (!st.pos || Math.hypot(pos.x - st.pos.x, pos.z - st.pos.z) >= 0.5) {
    st.pos = { x: pos.x, y: pos.y, z: pos.z };
    st.movedAt = now;
  }
  const minutes = info.settings.stuckMinutes;
  if (!minutes) { st.alerted = false; return; }
  const lastSign = Math.max(st.movedAt, info.lastActivityAt || 0, info.connectedAt || 0);
  if (now - lastSign < minutes * CFG.STUCK_UNIT_MS) { st.alerted = false; return; }
  if (st.alerted) return;
  st.alerted = true;
  if (!info.chatId) return;
  const keyboard = styleKeyboard(new InlineKeyboard().text('🔄 Reconnect now', `restart:${info.id}`));
  rSend(info.chatId,
    `<h4>🧊 ${esc(info.name)} looks stuck</h4>` +
    `<p>It hasn't moved and the server has been silent for <b>${minutes} min</b>. The server may be in limbo.</p>` +
    `<blockquote>Parked on purpose? Turn it off in /settings → 🧊 Stuck alert.</blockquote>${rFooter('Stuck')}`,
    `🧊 <b>${esc(info.name)}</b> looks stuck — no movement and no server activity for ${minutes} min.`,
    keyboard, alertOpts(info, 'stuck')).catch(() => {});
};

// ---------------------------------------------------------------------------
// WATCHLIST EVENTS
// ---------------------------------------------------------------------------

const recentWatch = new Map();

const watchEvent = (info, name, kind) => {
  if (!name || !info.connectedAt || Date.now() - info.connectedAt < CFG.WATCH_SETTLE_MS) return;
  info.lastActivityAt = Date.now();
  if (info.userId == null || name === info.name) return;
  const list = watchlists.get(String(info.userId));
  if (!list?.length) return;
  const lower = String(name).toLowerCase();
  if (!list.some(entry => entry.toLowerCase() === lower)) return;
  const key = `${info.host}:${info.port}|${lower}|${kind}`;
  const now = Date.now();
  if (now - (recentWatch.get(key) || 0) < CFG.WATCH_DEDUPE_MS) return; // several bots on one server see the same event
  recentWatch.set(key, now);
  if (recentWatch.size > 200) {
    for (const [k, at] of recentWatch) if (now - at > CFG.WATCH_DEDUPE_MS) recentWatch.delete(k);
  }
  if (!info.chatId) return;
  const verb = kind === 'join' ? 'joined' : 'left';
  const icon = kind === 'join' ? '🟢' : '⚫';
  notifyRich(info.chatId,
    `<h4>👀 ${icon} ${esc(name)} ${verb}</h4><p><code>${esc(info.host)}:${info.port}</code> · seen by <b>${esc(info.name)}</b></p>${rFooter('Watchlist')}`,
    `👀 ${icon} <b>${esc(name)}</b> ${verb} <code>${esc(info.host)}:${info.port}</code> (seen by ${esc(info.name)})`,
    alertOpts(info, 'watch'));
};

const runTick = info => {
  const current = getBot(info.id);
  const client = current?.mcBot;
  if (current && client && current.status === 'online'
    && Date.now() - (current.lastPacketAt || 0) > CFG.STALE_PACKET_MS) {
    const seconds = Math.round((Date.now() - current.lastPacketAt) / 1000);
    R.markConnectionLost(current, client, 'offline', `No data from the server for ${seconds}s — it may be offline`);
    R.scheduleReconnect(current);
    return;
  }
  if (!current || !client?.entity) return;
  checkProximity(current, client);
  trackStuck(current, client);
  R.idleViewTick(current, client);
  if (current.settings.idleRandomizer && !current.walking && Math.random() < CFG.IDLE_CHANCE) {
    runIdleAction(client);
  }
  if (current.settings.autoSleep) void trySleep(current, client);
};

const startTick = info => {
  clearInterval(info.tickTimer);
  info.tickTimer = setInterval(() => runTick(info), CFG.TICK_MS);
};

const stopTick = info => {
  clearInterval(info.tickTimer);
  info.tickTimer = null;
  info.nearbyPlayers = new Set();
};

// ---------------------------------------------------------------------------
// HEALTH ALERTS — one message per damage episode, edited in place
// ---------------------------------------------------------------------------

const fmtHp = value => String(Number(Number(value).toFixed(1)));

const healthAlertHtml = (info, ep) => {
  const low = ep.lowest <= CFG.LOW_HEALTH;
  const icon = low ? '🚨' : '💥';
  const title = ep.health <= CFG.LOW_HEALTH ? 'low health' : 'took damage';
  const detail = `${ep.hits} hit${ep.hits === 1 ? '' : 's'} · −${fmtHp(ep.total)} total · lowest ${fmtHp(ep.lowest)}`;
  return {
    rich: `<h4>${icon} ${esc(info.name)} ${title}</h4>` +
      `<p>❤️ ${fmtHp(ep.health)}/20</p><p><i>${detail}</i></p>${rFooter('Health')}`,
    legacy: `${icon} <b>${esc(info.name)}</b> ${title}\n❤️ ${fmtHp(ep.health)}/20\n<i>${detail}</i>`,
  };
};

const flushHealthAlert = info => {
  const ep = info.healthAlert;
  if (!ep) return Promise.resolve();
  if (ep.inflight) {
    ep.dirty = true;
    return ep.inflight;
  }
  ep.dirty = false;
  const { rich, legacy } = healthAlertHtml(info, ep);
  const task = (async () => {
    try {
      if (ep.messageId == null) {
        const res = await rSend(info.chatId, rich, legacy, undefined, alertOpts(info, 'health'));
        ep.messageId = res?.message_id ?? res?.result?.message_id ?? -1;
      } else if (ep.messageId !== -1) {
        await rEdit(info.chatId, ep.messageId, rich, legacy);
      }
    } catch (_) {
      // a failed edit is dropped; the next hit retries with fresh numbers
    } finally {
      ep.lastEditAt = Date.now();
      ep.inflight = null;
      if (ep.dirty && info.healthAlert === ep) scheduleHealthFlush(info, ep);
    }
  })();
  ep.inflight = task;
  return task;
};

const scheduleHealthFlush = (info, ep) => {
  if (ep.editTimer) return;
  const wait = Math.max(0, ep.lastEditAt + CFG.HEALTH_ALERT_EDIT_MS - Date.now());
  ep.editTimer = setTimeout(() => {
    ep.editTimer = null;
    if (info.healthAlert === ep) void flushHealthAlert(info);
  }, wait);
};

const recordDamage = (info, health, damage) => {
  const now = Date.now();
  let ep = info.healthAlert;
  if (ep && now - ep.lastDamageAt > CFG.HEALTH_ALERT_WINDOW_MS) {
    clearTimeout(ep.editTimer);
    ep = info.healthAlert = null;
  }
  const lowNow = health <= CFG.LOW_HEALTH;
  if (!ep && !(damage >= CFG.DAMAGE_ALERT_THRESHOLD || lowNow)) return;
  if (!ep) {
    ep = info.healthAlert = {
      messageId: null, hits: 0, total: 0, lowest: health, health,
      lastEditAt: 0, lastDamageAt: now, editTimer: null, inflight: null, dirty: false,
    };
  }
  ep.hits += 1;
  ep.total += damage;
  ep.lowest = Math.min(ep.lowest, health);
  ep.health = health;
  ep.lastDamageAt = now;
  scheduleHealthFlush(info, ep);
};

// Ends the current episode with a final edit so the message shows the last value.
const closeHealthAlert = async (info, finalHealth) => {
  const ep = info.healthAlert;
  if (!ep) return;
  clearTimeout(ep.editTimer);
  ep.editTimer = null;
  info.healthAlert = null;
  try { await ep.inflight; } catch (_) {}
  if (finalHealth != null) {
    ep.health = finalHealth;
    ep.lowest = Math.min(ep.lowest, finalHealth);
  }
  if (ep.messageId && ep.messageId !== -1) {
    const { rich, legacy } = healthAlertHtml(info, ep);
    try { await rEdit(info.chatId, ep.messageId, rich, legacy); } catch (_) {}
  }
};

Object.assign(R, { eatingNow, maybeAutoEat, checkProximity, runIdleAction, trySleep, trackStuck, recentWatch,
  watchEvent, runTick, startTick, stopTick, fmtHp, healthAlertHtml, flushHealthAlert, scheduleHealthFlush,
  recordDamage, closeHealthAlert });
