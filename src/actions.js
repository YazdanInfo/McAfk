'use strict';
// /echo, /walk and /auto.
const R = require('./registry');
const { S } = R;
const { AUTO_MAX_SECONDS, AUTO_MIN_SECONDS, bot, dot, esc, normUsername, ownedBots, rFooter, rSend, rTable, saveData,
  statusLabel } = R;

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
    await rSend(
      ctx.chat.id,
      `<h4>✅ Echo sent${target}</h4>` +
      `<blockquote>${esc(message)}</blockquote>` +
      `<p>🤖 Delivered to <b>${sent}</b> bot(s)` +
      (offline > 0 ? `<br>⚫ ${offline} offline — skipped` : '') + `</p>`,
      `✅ <b>Echo sent!</b>${target}\n\n` +
      `💬 <code>${esc(message)}</code>\n` +
      `🤖 Delivered to <b>${sent}</b> bot(s)` +
      (offline > 0 ? `\n⚫ ${offline} offline — skipped` : ''),
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

const WALK_DIRECTIONS = ['forward', 'back', 'backward', 'left', 'right'];

// Walks one bot `blocks` blocks in `direction`. Always resolves (never rejects).
const walkBot = (info, direction, blocks) => new Promise(resolve => {
  const client = info.mcBot;
  if (!client?.entity) {
    resolve({ name: info.name, distance: '0.0', failed: true });
    return;
  }

  const control = direction === 'backward' ? 'back' : direction;
  const startPos = client.entity.position.clone();
  let done = false;
  let timeoutId = null;
  info.walking = (info.walking || 0) + 1;

  const travelled = () => {
    const pos = client.entity?.position;
    if (!pos) return 0;
    const dx = pos.x - startPos.x;
    const dy = pos.y - startPos.y;
    const dz = pos.z - startPos.z;
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
  };

  const finish = timedOut => {
    if (done) return;
    done = true;
    clearTimeout(timeoutId);
    try { client.setControlState(control, false); } catch (_) {}
    try { client.removeListener('move', onMove); } catch (_) {}
    info.walking = Math.max(0, (info.walking || 1) - 1);
    const dist = travelled();
    if (!info.sessionStats) info.sessionStats = { distance: 0, respawns: 0 };
    info.sessionStats.distance += dist;
    resolve({
      name: info.name,
      distance: dist.toFixed(1),
      ...(timedOut ? { timeout: true } : {}),
    });
  };

  function onMove() {
    if (travelled() >= blocks) finish(false);
  }

  try {
    client.setControlState(control, true);
    client.on('move', onMove);
  } catch (_) {
    finish(true);
    return;
  }
  timeoutId = setTimeout(() => finish(true), Math.min(blocks * 5000, 30000));
});

bot.command('walk', async ctx => {
  const sender = normUsername(ctx.from?.username);
  const userId = ctx.from?.id;
  const chatId = ctx.chat.id;
  const args = ctx.message.text.trim().split(/\s+/).slice(1);

  const direction = args[0]?.toLowerCase();
  const blocks = Number.parseFloat(args[1]);

  if (!direction || !WALK_DIRECTIONS.includes(direction)) {
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

  const results = await Promise.all(online.map(info => walkBot(info, direction, blocks)));
  const lines = results.map(r =>
    `🤖 <b>${esc(r.name)}</b> — walked <code>${r.distance}</code> blocks` +
    (r.timeout ? ' (timeout)' : ''),
  );
  await rSend(
    ctx.chat.id,
    `<h4>✅ Walk complete</h4>` +
    rTable(['Bot', 'Walked', 'Result'], results.map(r => [
      `🤖 <b>${esc(r.name)}</b>`,
      `<code>${r.distance}</code> blocks`,
      r.failed ? '⚠️ not ready' : r.timeout ? '⏱ timeout' : '✅ done',
    ])),
    `✅ <b>Walk complete!</b>\n\n${lines.join('\n')}`,
  );
});

// ---------------------------------------------------------------------------
// AUTO (repeating automated actions)
// ---------------------------------------------------------------------------

const autoKey = auto => `${auto.action}:${auto.direction}`;

const autoDelayMs = auto => (auto.minSec === auto.maxSec
  ? auto.minSec
  : auto.minSec + Math.random() * (auto.maxSec - auto.minSec)) * 1000;

const autoIntervalLabel = auto => auto.minSec === auto.maxSec
  ? `${auto.minSec}s`
  : `${auto.minSec}–${auto.maxSec}s (random)`;

const autoLabel = auto =>
  `${auto.action} ${auto.direction} ${auto.blocks} every ${autoIntervalLabel(auto)}`;

const scheduleAuto = (info, auto) => {
  clearTimeout(auto.timer);
  auto.timer = setTimeout(() => { void runAuto(info, auto); }, autoDelayMs(auto));
};

const runAuto = async (info, auto) => {
  if (S.shuttingDown || info.autos?.get(auto.key) !== auto) return;
  scheduleAuto(info, auto);
  if (info.status !== 'online' || !info.mcBot || info.walking) return;
  try {
    await walkBot(info, auto.direction, auto.blocks);
  } catch (error) {
    console.error(`[AUTO] ${info.name}:`, error.message);
  }
};

const startAuto = (info, spec) => {
  const auto = {
    action: 'walk',
    direction: spec.direction === 'backward' ? 'back' : spec.direction,
    blocks: spec.blocks,
    minSec: spec.minSec,
    maxSec: spec.maxSec,
    timer: null,
  };
  auto.key = autoKey(auto);
  if (!info.autos) info.autos = new Map();
  const previous = info.autos.get(auto.key);
  if (previous) clearTimeout(previous.timer);
  info.autos.set(auto.key, auto);
  scheduleAuto(info, auto);
  return auto;
};

const validAutoSpec = spec => spec
  && WALK_DIRECTIONS.includes(spec.direction)
  && Number.isFinite(spec.blocks) && spec.blocks > 0 && spec.blocks <= 100
  && Number.isFinite(spec.minSec) && Number.isFinite(spec.maxSec)
  && spec.minSec >= AUTO_MIN_SECONDS && spec.maxSec <= AUTO_MAX_SECONDS
  && spec.minSec <= spec.maxSec;

const restoreAutos = (info, list) => {
  if (!info.autos) info.autos = new Map();
  if (!Array.isArray(list)) return;
  for (const spec of list) {
    if (spec?.action === 'walk' && validAutoSpec(spec)) startAuto(info, spec);
  }
};

const stopAutos = (info, key = null) => {
  if (!info.autos?.size) return 0;
  let removed = 0;
  for (const [autoKeyValue, auto] of [...info.autos]) {
    if (key && autoKeyValue !== key) continue;
    clearTimeout(auto.timer);
    info.autos.delete(autoKeyValue);
    removed++;
  }
  return removed;
};

const parseInterval = raw => {
  const match = /^(\d+(?:\.\d+)?)(?:-(\d+(?:\.\d+)?))?$/.exec(raw || '');
  if (!match) return null;
  const minSec = Number.parseFloat(match[1]);
  const maxSec = match[2] === undefined ? minSec : Number.parseFloat(match[2]);
  return { minSec, maxSec };
};

const autoUsage = () =>
  `⚠️ <b>Auto Usage</b>\n\n` +
  `<code>/auto walk forward 2 60</code> → all your bots\n` +
  `<code>/auto Steve walk forward 2 60</code> → one bot\n` +
  `<code>/auto Steve walk forward 2 30-90</code> → random 30–90s\n\n` +
  `Format: <code>/auto [bot] walk &lt;direction&gt; &lt;blocks&gt; &lt;seconds&gt;</code>\n` +
  `Blocks: 0.1–100 · Seconds: ${AUTO_MIN_SECONDS}–${AUTO_MAX_SECONDS}\n\n` +
  `<code>/auto list</code> — show active automations\n` +
  `<code>/auto stop [bot] [walk direction]</code> — cancel`;

bot.command('auto', async ctx => {
  const sender = normUsername(ctx.from?.username);
  const userId = ctx.from?.id;
  const chatId = ctx.chat.id;
  const args = ctx.message.text.trim().split(/\s+/).slice(1);
  const owned = ownedBots(userId, chatId, sender);
  const findOwned = name => owned.find(info => info.name.toLowerCase() === String(name || '').toLowerCase());
  const reply = text => ctx.reply(text, { parse_mode: 'HTML' });

  if (!args.length) return reply(autoUsage());
  const sub = args[0].toLowerCase();

  if (sub === 'list') {
    const lines = [];
    const rows = [];
    for (const info of owned) {
      for (const auto of info.autos?.values() || []) {
        lines.push(`${dot(info.status)} <b>${esc(info.name)}</b> — <code>${esc(autoLabel(auto))}</code>`);
        rows.push([
          `${dot(info.status)} <b>${esc(info.name)}</b>`,
          `${esc(auto.action)} ${esc(auto.direction)}`,
          `${auto.blocks}`,
          esc(autoIntervalLabel(auto)),
        ]);
      }
    }
    return rSend(
      chatId,
      rows.length
        ? `<h3>🔁 Active automations</h3>${rTable(['Bot', 'Action', 'Steps', 'Every'], rows)}${rFooter('Updated')}`
        : `<h3>🔁 No active automations</h3><pre><code>/auto walk forward 2 60</code></pre>`,
      lines.length
        ? `🔁 <b>Active automations</b>\n\n${lines.join('\n')}`
        : `🔁 No active automations.\n\n<code>/auto walk forward 2 60</code>`,
    );
  }

  if (sub === 'stop') {
    let rest = args.slice(1);
    let targets = owned;
    if (rest[0] && rest[0].toLowerCase() !== 'walk' && rest[0].toLowerCase() !== 'all') {
      const match = findOwned(rest[0]);
      if (!match) return reply(`❌ Bot "${esc(rest[0])}" not found or you don't own it.`);
      targets = [match];
      rest = rest.slice(1);
    } else if (rest[0]?.toLowerCase() === 'all') {
      rest = rest.slice(1);
    }
    let key = null;
    if (rest[0]?.toLowerCase() === 'walk') {
      const direction = rest[1]?.toLowerCase();
      if (!WALK_DIRECTIONS.includes(direction)) return reply(autoUsage());
      key = `walk:${direction === 'backward' ? 'back' : direction}`;
    }
    let removed = 0;
    for (const info of targets) removed += stopAutos(info, key);
    if (removed) saveData();
    return reply(removed
      ? `🛑 Stopped <b>${removed}</b> automation(s).`
      : '⚠️ No matching automations found.');
  }

  let rest = args;
  let targets = owned;
  if (rest[0].toLowerCase() !== 'walk') {
    const match = findOwned(rest[0]);
    if (!match) return reply(`❌ Bot "${esc(rest[0])}" not found or you don't own it.\n\n${autoUsage()}`);
    targets = [match];
    rest = rest.slice(1);
  }

  const [action, rawDirection, rawBlocks, rawSeconds] = rest;
  if (action?.toLowerCase() !== 'walk') return reply(autoUsage());

  const direction = rawDirection?.toLowerCase();
  const blocks = Number.parseFloat(rawBlocks);
  const interval = parseInterval(rawSeconds);
  if (!WALK_DIRECTIONS.includes(direction)) return reply(autoUsage());
  if (!Number.isFinite(blocks) || blocks <= 0 || blocks > 100) {
    return reply('❌ Steps must be a number between 0.1 and 100.');
  }
  if (!interval || !validAutoSpec({ direction, blocks, ...interval })) {
    return reply(
      `❌ Seconds must be a number (or range like <code>30-90</code>) ` +
      `between ${AUTO_MIN_SECONDS} and ${AUTO_MAX_SECONDS}.`,
    );
  }
  if (!targets.length) return reply('❌ You have no registered bots. Use <b>➕ Add Bot</b>.');

  const started = targets.map(info => ({
    info,
    auto: startAuto(info, { direction, blocks, ...interval }),
  }));
  saveData();

  const lines = started.map(({ info }) => `🤖 <b>${esc(info.name)}</b> ${dot(info.status)}`);
  await rSend(
    chatId,
    `<h3>🔁 Auto enabled</h3>` +
    `<blockquote><code>${esc(autoLabel(started[0].auto))}</code></blockquote>` +
    rTable(['Bot', 'State'], started.map(({ info }) => [`🤖 <b>${esc(info.name)}</b>`, `${dot(info.status)} ${statusLabel(info.status)}`])) +
    `<p>First run in ${esc(autoIntervalLabel(started[0].auto))}. Offline bots skip runs until reconnected.</p>` +
    `<footer>Cancel: <code>/auto stop</code></footer>`,
    `🔁 <b>Auto enabled</b>\n\n` +
    `<code>${esc(autoLabel(started[0].auto))}</code>\n\n${lines.join('\n')}\n\n` +
    `First run in ${autoIntervalLabel(started[0].auto)}. Offline bots skip runs until reconnected.\n` +
    `Cancel: <code>/auto stop</code>`,
  );
});

Object.assign(R, { handleEcho, WALK_DIRECTIONS, walkBot, autoKey, autoDelayMs, autoIntervalLabel, autoLabel,
  scheduleAuto, runAuto, startAuto, validAutoSpec, restoreAutos, stopAutos, parseInterval, autoUsage });
