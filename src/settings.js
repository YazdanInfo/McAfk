'use strict';
// Settings screens, value parsers, where / deaths / inventory views.
const R = require('./registry');
const { InlineKeyboard } = require('grammy');
const { CFG, bot, copyButton, dimLabel, dot, esc, fmtHp, locCell, locLine, normUsername, ownedBots, posText, rFooter,
  rSend, rTable, saveData, shortBotName, snapshotLocation, styledText, tgTime, uptime, utcText } = R;

// ---------------------------------------------------------------------------
// SETTINGS / PROXIMITY / AUTOREPLY / SCHEDULE / WHERE / INVENTORY
// ---------------------------------------------------------------------------

// Splits "[botname] rest..." into { target, rest }. With one bot owned and no
// name given, defaults to it. `rest` is everything after the resolved name.
const resolveBotArg = (owned, args) => {
  if (args[0]) {
    const match = owned.find(info => info.name.toLowerCase() === args[0].toLowerCase());
    if (match) return { target: match, rest: args.slice(1) };
  }
  if (owned.length === 1) return { target: owned[0], rest: args };
  return { target: null, rest: args };
};

const SETTINGS_FIELDS = [
  ['autoEat', '🍗 Auto-eat'],
  ['autoRespawn', '💀 Auto-respawn'],
  ['healthAlerts', '❤️ Health alerts'],
  ['idleRandomizer', '🎲 Idle randomizer'],
  ['autoSleep', '🛏 Auto-sleep'],
  ['lobbyGuard', '🚪 Lobby guard'],
  ['aiChat', '🤖 AI chat'],
];

const settingsText = info => {
  const lines = SETTINGS_FIELDS.map(([key, label]) => `${info.settings[key] ? '✅' : '⬜'} ${label}`);
  lines.push(`${info.settings.proximityRadius ? '✅' : '⬜'} 👀 Proximity alert` +
    (info.settings.proximityRadius ? ` (${info.settings.proximityRadius}m)` : ''));
  lines.push(`${info.settings.viewDistance ? '✅' : '⬜'} 🌍 View distance` +
    (info.settings.viewDistance ? ` (${info.settings.viewDistance} chunks)` : ' (default)'));
  lines.push(`${info.settings.schedule ? '✅' : '⬜'} 🕐 Schedule` +
    (info.settings.schedule ? ` (${info.settings.schedule.start}:00–${info.settings.schedule.end}:00)` : ''));
  lines.push(`${info.settings.stuckMinutes ? '✅' : '⬜'} 🧊 Stuck alert` +
    (info.settings.stuckMinutes ? ` (${info.settings.stuckMinutes} min)` : ''));
  return `⚙️ <b>${esc(info.name)} settings</b>\n\n${lines.join('\n')}\n\n` +
    `Tap a toggle to flip it. Tap Proximity, View distance, Schedule or Stuck alert to set a value.`;
};

const settingsRich = info => {
  const rows = SETTINGS_FIELDS.map(([key, label]) => [esc(label), info.settings[key] ? '✅ <b>On</b>' : '⬜ Off']);
  const prox = info.settings.proximityRadius;
  const sched = info.settings.schedule;
  rows.push(['👀 Proximity alert', prox ? `✅ <b>${prox}m</b>` : '⬜ Off']);
  rows.push(['🌍 View distance', info.settings.viewDistance ? `✅ <b>${info.settings.viewDistance} chunks</b>` : '⬜ Default']);
  rows.push(['🕐 Schedule', sched ? `✅ <b>${sched.start}:00–${sched.end}:00</b>` : '⬜ Off']);
  rows.push(['🧊 Stuck alert', info.settings.stuckMinutes ? `✅ <b>${info.settings.stuckMinutes} min</b>` : '⬜ Off']);
  return `<h3>⚙️ ${esc(info.name)} settings</h3>` +
    rTable(['Setting', 'State'], rows) +
    `<p><i>Tap a toggle to flip it. Proximity and Schedule ask for a value.</i></p>` +
    rFooter('Settings');
};

const settingsKeyboard = info => {
  const keyboard = new InlineKeyboard();
  for (const [key, label] of SETTINGS_FIELDS) {
    styledText(keyboard, `${info.settings[key] ? '✅' : '⬜'} ${label}`, `togglesetting:${info.id}:${key}`,
      info.settings[key] ? 'success' : undefined).row();
  }
  const prox = info.settings.proximityRadius;
  const sched = info.settings.schedule;
  styledText(keyboard, `${prox ? '✅' : '⬜'} 👀 Proximity${prox ? ` (${prox}m)` : ''}`, `setvalue:${info.id}:proximity`, prox ? 'success' : undefined).row();
  styledText(keyboard, `${sched ? '✅' : '⬜'} 🕐 Schedule${sched ? ` (${sched.start}-${sched.end})` : ''}`, `setvalue:${info.id}:schedule`, sched ? 'success' : undefined).row();
  const view = info.settings.viewDistance;
  styledText(keyboard, `${view ? '✅' : '⬜'} 🌍 View distance${view ? ` (${view})` : ''}`, `setvalue:${info.id}:view`, view ? 'success' : undefined).row();
  const stuckMin = info.settings.stuckMinutes;
  styledText(keyboard, `${stuckMin ? '✅' : '⬜'} 🧊 Stuck alert${stuckMin ? ` (${stuckMin}m)` : ''}`, `setvalue:${info.id}:stuck`, stuckMin ? 'success' : undefined).row();
  return keyboard.text('⬅️ Back', `manage:${info.id}`);
};

// Value parsers shared by the /proximity, /schedule commands and the settings menu.
// Return { ok: true, value } or { ok: false }.
const parseProximityInput = raw => {
  const text = String(raw || '').trim().toLowerCase();
  if (text === 'off' || text === '0') return { ok: true, value: null };
  const radius = Number.parseFloat(text);
  if (!Number.isFinite(radius) || radius <= 0 || radius > 256) return { ok: false };
  return { ok: true, value: radius };
};

const parseViewInput = raw => {
  const text = String(raw || '').trim().toLowerCase();
  if (text === 'off' || text === 'default' || text === '0' || text === 'auto') return { ok: true, value: null };
  const chunks = Number.parseInt(text, 10);
  if (!/^\d+$/.test(text) || chunks < 2 || chunks > 32) return { ok: false };
  return { ok: true, value: chunks };
};

const parseStuckInput = raw => {
  const text = String(raw || '').trim().toLowerCase();
  if (text === 'off' || text === '0') return { ok: true, value: null };
  const minutes = Number.parseInt(text, 10);
  if (!/^\d+$/.test(text) || minutes < CFG.STUCK_MIN || minutes > CFG.STUCK_MAX) return { ok: false };
  return { ok: true, value: minutes };
};

const parseScheduleInput = raw => {
  const text = String(raw || '').trim().toLowerCase();
  if (text === 'off') return { ok: true, value: null };
  const match = /^(\d{1,2})-(\d{1,2})$/.exec(text);
  if (!match) return { ok: false };
  const start = Number.parseInt(match[1], 10);
  const end = Number.parseInt(match[2], 10);
  if (start < 0 || start > 23 || end < 0 || end > 23) return { ok: false };
  return { ok: true, value: { start, end } };
};

const settingsAllStats = bots => SETTINGS_FIELDS.map(([key, label]) => {
  const onCount = bots.filter(info => info.settings[key]).length;
  const icon = onCount === bots.length ? '✅' : onCount === 0 ? '⬜' : '🟡';
  return { key, label, onCount, icon };
});

const settingsAllText = bots => {
  const lines = settingsAllStats(bots).map(f => `${f.icon} ${f.label} (${f.onCount}/${bots.length})`);
  return `⚙️ <b>All bots settings</b> (${bots.length})\n\n${lines.join('\n')}\n\n` +
    `Tap a toggle to apply it to every bot: if all are on it turns them off, otherwise it turns them all on.`;
};

const settingsAllRich = bots =>
  `<h3>⚙️ All bots settings (${bots.length})</h3>` +
  rTable(['Setting', 'On'], settingsAllStats(bots).map(f => [esc(f.label), `${f.icon} ${f.onCount}/${bots.length}`])) +
  `<p><i>Tap a toggle to apply it to every bot: if all are on it turns them off, otherwise it turns them all on. 🟡 = bots differ.</i></p>` +
  rFooter('Settings');

const settingsAllKeyboard = bots => {
  const keyboard = new InlineKeyboard();
  for (const f of settingsAllStats(bots)) {
    styledText(keyboard, `${f.icon} ${f.label}`, `toggleall:${f.key}`, f.icon === '✅' ? 'success' : undefined).row();
  }
  return keyboard.text('⬅️ Back', 'list_bots');
};

// "Which bot?" picker used by commands that need a target (callbackPrefix:<botId>).
const pickBotReply = (ctx, owned, callbackPrefix, title, extra) => {
  if (!owned.length) {
    return ctx.reply('❌ You have no registered bots. Use <b>➕ Add Bot</b>.', { parse_mode: 'HTML' });
  }
  const keyboard = new InlineKeyboard();
  for (const info of owned) {
    keyboard.text(`${dot(info.status)} ${shortBotName(info.name)}`, `${callbackPrefix}:${info.id}`).row();
  }
  if (extra) keyboard.text(extra.label, extra.data);
  return rSend(ctx.chat.id, `<h4>${title}</h4><p>Which bot?</p>`, `<b>${title}</b>\nWhich bot?`, keyboard);
};

bot.command('settings', async ctx => {
  const sender = normUsername(ctx.from?.username);
  const owned = ownedBots(ctx.from?.id, ctx.chat.id, sender);
  const args = ctx.message.text.trim().split(/\s+/).slice(1);
  if (args[0]?.toLowerCase() === 'all' && !owned.some(info => info.name.toLowerCase() === 'all')) {
    if (!owned.length) return ctx.reply('❌ You have no registered bots. Use <b>➕ Add Bot</b>.', { parse_mode: 'HTML' });
    return rSend(ctx.chat.id, settingsAllRich(owned), settingsAllText(owned), settingsAllKeyboard(owned));
  }
  const { target } = resolveBotArg(owned, args);
  if (!target) {
    return pickBotReply(ctx, owned, 'settings', '⚙️ Settings',
      owned.length > 1 ? { label: '⚙️ All bots', data: 'settings_all' } : null);
  }
  await rSend(ctx.chat.id, settingsRich(target), settingsText(target), settingsKeyboard(target));
});

bot.command('autoreply', async ctx => {
  const sender = normUsername(ctx.from?.username);
  const owned = ownedBots(ctx.from?.id, ctx.chat.id, sender);
  const args = ctx.message.text.trim().split(/\s+/).slice(1);
  const { target, rest } = resolveBotArg(owned, args);
  const usage = '⚠️ Usage:\n<code>/autoreply [bot] add trigger | response | cooldownSec</code>\n' +
    '<code>/autoreply [bot] remove trigger</code>\n<code>/autoreply [bot] list</code>\n\n' +
    '<code>*</code> in a trigger matches any text (e.g. <code>hello * there</code>). ' +
    `Cooldown is optional (default ${CFG.AUTOREPLY_DEFAULT_COOLDOWN_SEC}s, max ${CFG.AUTOREPLY_MAX_COOLDOWN_SEC}s).`;
  if (!target) return ctx.reply(usage, { parse_mode: 'HTML' });

  const sub = (rest[0] || '').toLowerCase();
  if (sub === 'list' || !sub) {
    const rules = target.autoReplies || [];
    const example = `/autoreply ${target.name} add hi * | hello! | 30`;
    const rich = rules.length
      ? `<h3>💬 ${esc(target.name)} — auto-replies</h3>` +
        rTable(['#', 'Trigger', 'Reply', 'Cooldown'], rules.map((r, i) => [
          String(i + 1), `<code>${esc(r.trigger)}</code>`, esc(r.response),
          `${r.cooldownSec ?? CFG.AUTOREPLY_DEFAULT_COOLDOWN_SEC}s`,
        ])) +
        `<details><summary>Add / remove</summary><pre><code>${esc(example)}\n/autoreply ${esc(target.name)} remove hi *</code></pre></details>` +
        rFooter('Auto-reply')
      : `<h3>💬 ${esc(target.name)} — no auto-replies</h3><p>Add one:</p><pre><code>${esc(example)}</code></pre>`;
    const lines = rules.map((r, i) =>
      `${i + 1}. <code>${esc(r.trigger)}</code> → ${esc(r.response)} <i>(cd ${r.cooldownSec ?? CFG.AUTOREPLY_DEFAULT_COOLDOWN_SEC}s)</i>`);
    return rSend(ctx.chat.id, rich,
      lines.length
        ? `💬 <b>${esc(target.name)} auto-replies</b>\n\n${lines.join('\n')}\n\nAdd: <code>${esc(example)}</code>`
        : `💬 No auto-replies set for <b>${esc(target.name)}</b>.\nAdd: <code>${esc(example)}</code>`);
  }
  if (sub === 'remove') {
    const key = rest.slice(1).join(' ').trim().toLowerCase();
    const before = (target.autoReplies || []).length;
    target.autoReplies = (target.autoReplies || []).filter(r => r.trigger.toLowerCase() !== key);
    saveData();
    return ctx.reply(target.autoReplies.length < before
      ? `🗑️ Removed auto-reply for <code>${esc(key)}</code>.`
      : `⚠️ No auto-reply found for <code>${esc(key)}</code>.`, { parse_mode: 'HTML' });
  }
  if (sub === 'add') {
    const combined = rest.slice(1).join(' ');
    const pipeIndex = combined.indexOf('|');
    if (pipeIndex < 0) return ctx.reply(usage, { parse_mode: 'HTML' });
    const trigger = combined.slice(0, pipeIndex).trim();
    let response = combined.slice(pipeIndex + 1).trim();
    let cooldownSec = CFG.AUTOREPLY_DEFAULT_COOLDOWN_SEC;
    const lastPipe = response.lastIndexOf('|');
    if (lastPipe >= 0 && /^\d+(\.\d+)?$/.test(response.slice(lastPipe + 1).trim())) {
      cooldownSec = Number.parseFloat(response.slice(lastPipe + 1).trim());
      response = response.slice(0, lastPipe).trim();
      if (cooldownSec > CFG.AUTOREPLY_MAX_COOLDOWN_SEC) {
        return ctx.reply(`❌ Cooldown must be between 0 and ${CFG.AUTOREPLY_MAX_COOLDOWN_SEC} seconds.`, { parse_mode: 'HTML' });
      }
    }
    if (!trigger || !response) return ctx.reply(usage, { parse_mode: 'HTML' });
    if (!target.autoReplies) target.autoReplies = [];
    if (target.autoReplies.length >= 20) {
      return ctx.reply('❌ Limit of 20 auto-replies per bot reached.', { parse_mode: 'HTML' });
    }
    target.autoReplies = target.autoReplies.filter(r => r.trigger.toLowerCase() !== trigger.toLowerCase());
    target.autoReplies.push({ trigger, response, cooldownSec, lastFiredAt: 0 });
    saveData();
    return ctx.reply(
      `✅ <b>${esc(target.name)}</b> will reply to <code>${esc(trigger)}</code> with:\n<code>${esc(response)}</code>\n` +
      `⏳ Cooldown: ${cooldownSec}s${trigger.includes('*') ? ' · wildcard match' : ' · substring match'}`,
      { parse_mode: 'HTML' });
  }
  return ctx.reply(usage, { parse_mode: 'HTML' });
});

// ---------------------------------------------------------------------------
// INFO VIEWS — /where, /deaths, /inventory (commands, manage-menu buttons and bot picker share these)
// ---------------------------------------------------------------------------

const infoBackKeyboard = (kind, info) => new InlineKeyboard()
  .text('🔃 Refresh', `bi:${kind}:${info.id}`).text('⬅️ Back', `manage:${info.id}`);

const offlineInfoView = (kind, info) => ({
  rich: `<h3>⚠️ ${esc(info.name)} is not online</h3><p>Reconnect it from the bot menu first.</p>${rFooter('Status')}`,
  legacy: `⚠️ <b>${esc(info.name)}</b> is not online.`,
  keyboard: infoBackKeyboard(kind, info),
});

const whereView = info => {
  const client = info.mcBot;
  if (info.status !== 'online' || !client?.entity) return offlineInfoView('where', info);
  const pos = client.entity.position;
  const snap = snapshotLocation(client);
  const game = client.game || {};
  const stats = info.sessionStats || { distance: 0, respawns: 0 };
  const coords = `x=${pos.x.toFixed(1)} y=${pos.y.toFixed(1)} z=${pos.z.toFixed(1)}`;
  const mode = `${game.gameMode || 'unknown'}${game.hardcore ? ' 💀 hardcore' : ''}`;
  const hp = client.health == null ? '?' : fmtHp(client.health);
  const playtime = info.connectedAt ? uptime(Date.now() - info.connectedAt) : '—';
  const rich = `<h3>📍 ${esc(info.name)}</h3>` +
    rTable(['Property', 'Value'], [
      ['📍 Position', `<code>${coords}</code>`],
      ['🌐 Dimension', esc(dimLabel(snap?.dim) || 'unknown')],
      ['🎮 Gamemode', esc(mode)],
      ['⚔️ Difficulty', esc(game.difficulty || 'unknown')],
      ['❤️ Health', `${hp}/20`],
      ['🍗 Food', `${client.food ?? '?'}/20`],
    ]) +
    `<h4>Since last connect</h4>` +
    rTable(['Stat', 'Value'], [
      ['⏱ Playtime', playtime],
      ['🚶 Walked', `${stats.distance.toFixed(1)} blocks`],
      ['💀 Respawns', String(stats.respawns)],
    ]) +
    rFooter('Location');
  const legacy = `📍 <b>${esc(info.name)}</b>\n<code>${coords}</code>\n` +
    `🌐 Dimension: ${esc(dimLabel(snap?.dim) || 'unknown')}\n` +
    `🎮 Gamemode: <code>${esc(mode)}</code>\n⚔️ Difficulty: <code>${esc(game.difficulty || 'unknown')}</code>\n` +
    `❤️ Health: ${hp}/20  🍗 Food: ${client.food ?? '?'}/20\n\n<b>Since last connect</b>\n` +
    `⏱ Playtime: ${playtime}\n🚶 Walked: ${stats.distance.toFixed(1)} blocks\n💀 Respawns: ${stats.respawns}`;
  const keyboard = new InlineKeyboard();
  if (snap) copyButton(keyboard, '📋 Copy coords', posText(snap.pos)).row();
  keyboard.text('🔃 Refresh', `bi:where:${info.id}`).text('⬅️ Back', `manage:${info.id}`);
  return { rich, legacy, keyboard };
};

const deathsView = info => {
  const history = info.deathHistory || [];
  const keyboard = new InlineKeyboard();
  if (!history.length) {
    keyboard.text('⬅️ Back', `manage:${info.id}`);
    return {
      rich: `<h3>💀 ${esc(info.name)}</h3><p>No deaths recorded.</p>${rFooter('Deaths')}`,
      legacy: `💀 No deaths recorded for <b>${esc(info.name)}</b>.`,
      keyboard,
    };
  }
  const rows = history.map((d, i) => [
    String(i + 1),
    tgTime(d.at),
    esc(d.cause),
    d.pos ? locCell(d.pos, d.dim) + (d.respawn ? `<br>↪ <code>${posText(d.respawn)}</code>` : '') : '—',
  ]);
  const hasRespawn = history.some(d => d.respawn);
  const rich = `<h3>💀 ${esc(info.name)} — last ${history.length} death(s)</h3>` +
    rTable(['#', 'When', 'Cause', 'Where'], rows) +
    (hasRespawn ? `<p><i>↪ = where it respawned.</i></p>` : '') +
    history.map((d, i) => ({ d, i })).filter(({ d }) => d.items?.length).slice(0, 5).map(({ d, i }) =>
      `<details><summary>🎒 #${i + 1} inventory at death (${d.itemTotal} item(s))</summary>` +
      `<p>${d.items.map(([name, count]) => `${count}× ${esc(name)}`).join(', ')}</p></details>`).join('') +
    rFooter('Deaths');
  const lines = history.map((d, i) =>
    `${i + 1}. <code>${utcText(d.at)}</code>\n    ${esc(d.cause)}\n    📍 ${locLine(d.pos, d.dim)}` +
    (d.respawn ? ` ↪ <code>${posText(d.respawn)}</code>` : '') +
    (d.items?.length ? `\n    🎒 ${esc(d.items.slice(0, 6).map(([name, count]) => `${count}× ${name}`).join(', '))}${d.items.length > 6 ? '…' : ''}` : ''));
  const legacy = `💀 <b>${esc(info.name)}</b> — last ${history.length} death(s)\n\n${lines.join('\n')}`;
  const withPos = history.map((d, i) => ({ d, i })).filter(({ d }) => d.pos).slice(0, 6);
  withPos.forEach(({ d, i }, index) => {
    copyButton(keyboard, `📋 #${i + 1} ${posText(d.pos)}`, posText(d.pos));
    if (index % 2 === 1 && index < withPos.length - 1) keyboard.row();
  });
  if (withPos.length) keyboard.row();
  keyboard.text('🔃 Refresh', `bi:deaths:${info.id}`).text('⬅️ Back', `manage:${info.id}`);
  return { rich, legacy, keyboard };
};

const inventoryView = info => {
  const client = info.mcBot;
  if (info.status !== 'online' || !client) return offlineInfoView('inventory', info);
  const items = client.inventory?.items() || [];
  const totals = new Map();
  for (const item of items) {
    const key = item.displayName || item.name;
    totals.set(key, (totals.get(key) || 0) + item.count);
  }
  const sorted = [...totals].sort((a, b) => b[1] - a[1]);
  const MAX_ROWS = 30;
  const shown = sorted.slice(0, MAX_ROWS);
  const more = sorted.length - shown.length;
  const slots = client.inventory?.slots || [];
  const gear = [['⛑ Head', 5], ['🛡 Chest', 6], ['👖 Legs', 7], ['👢 Feet', 8], ['🤚 Offhand', 45]]
    .map(([label, slot]) => [label, slots[slot]])
    .filter(([, item]) => item)
    .map(([label, item]) => [label, item.displayName || item.name]);
  if (client.heldItem) gear.unshift(['✋ Holding', `${client.heldItem.displayName || client.heldItem.name}`]);
  const total = items.reduce((sum, item) => sum + item.count, 0);

  let rich = `<h3>🎒 ${esc(info.name)} — ${total} item(s)</h3>`;
  let legacy = `🎒 <b>${esc(info.name)}</b> inventory`;
  if (!shown.length && !gear.length) {
    rich += `<p>The inventory is empty.</p>`;
    legacy += `\n\nThe inventory is empty.`;
  }
  if (shown.length) {
    rich += rTable(['Item', 'Qty'], shown.map(([name, count]) => [esc(name), `<b>${count}</b>`])) +
      (more > 0 ? `<p><i>…and ${more} more kind(s).</i></p>` : '');
    legacy += `\n\n${shown.map(([name, count]) => `• ${count}x ${esc(name)}`).join('\n')}` + (more > 0 ? `\n…and ${more} more kind(s).` : '');
  }
  if (gear.length) {
    rich += `<h4>Equipment</h4>` + rTable(['Slot', 'Item'], gear.map(([label, name]) => [label, esc(name)]));
    legacy += `\n\n<b>Equipment</b>\n${gear.map(([label, name]) => `${label}: ${esc(name)}`).join('\n')}`;
  }
  rich += rFooter('Inventory');
  return { rich, legacy, keyboard: infoBackKeyboard('inventory', info) };
};

const INFO_VIEWS = new Map([['where', whereView], ['deaths', deathsView], ['inventory', inventoryView]]);

const showInfoCommand = async (ctx, kind, title) => {
  const owned = ownedBots(ctx.from?.id, ctx.chat.id, normUsername(ctx.from?.username));
  const args = ctx.message.text.trim().split(/\s+/).slice(1);
  const { target } = resolveBotArg(owned, args);
  if (!target) return pickBotReply(ctx, owned, `bi:${kind}`, title);
  const view = INFO_VIEWS.get(kind)(target);
  await rSend(ctx.chat.id, view.rich, view.legacy, view.keyboard);
};

bot.command('where', ctx => showInfoCommand(ctx, 'where', '📍 Where'));
bot.command('deaths', ctx => showInfoCommand(ctx, 'deaths', '💀 Deaths'));
bot.command('inventory', ctx => showInfoCommand(ctx, 'inventory', '🎒 Inventory'));

// Commands that were merged into other menus (kept only as a friendly pointer).
const MERGED_COMMANDS = {
  unforward: '/forward → Forwards → tap the destination',
  forwards: '/forward → Forwards',
  proximity: '/settings → 👀 Proximity',
  schedule: '/settings → 🕐 Schedule',
  gamemode: '/where',
};
for (const [command, hint] of Object.entries(MERGED_COMMANDS)) {
  bot.command(command, ctx => ctx.reply(`ℹ️ /${command} was merged — use ${hint}.`));
}

Object.assign(R, { resolveBotArg, SETTINGS_FIELDS, settingsText, settingsRich, settingsKeyboard, parseProximityInput,
  parseViewInput, parseStuckInput, parseScheduleInput, settingsAllStats, settingsAllText, settingsAllRich,
  settingsAllKeyboard, pickBotReply, infoBackKeyboard, offlineInfoView, whereView, deathsView, inventoryView,
  INFO_VIEWS, showInfoCommand, MERGED_COMMANDS });
