'use strict';
// Main menu, bot list, manage screens, help.
const R = require('./registry');
const { InlineKeyboard } = require('grammy');
const { CFG, digestSubs, dot, esc, getBot, ownedBots, ownerTag, rFooter, rTable, shortBotName, statusLabel,
  styleKeyboard, styledText, uptime } = R;

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

const mainMenuKeyboard = userId => {
  const digestOn = digestSubs.has(String(userId));
  const keyboard = new InlineKeyboard()
    .text('➕ Add Bot', 'add_bot').text('📋 My Bots', 'list_bots').row()
    .text('📡 Forward', 'fw:home').text('👀 Watchlist', 'wl:home').row();
  styledText(keyboard, digestOn ? '🔔 Digest: ON' : '🔕 Digest: OFF', 'menu_digest', digestOn ? 'success' : undefined).row();
  keyboard.text('🌙 Quiet hours', 'quiet:home').text('ℹ️ Help & Guide', 'help');
  return styleKeyboard(keyboard);
};

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
  if (bots.length > 1) keyboard.text('⚙️ Settings (All Bots)', 'settings_all').row();
  return styleKeyboard(keyboard
    .text('➕ Add Another Bot', 'add_bot').row()
    .text('🔃  Refresh List', 'list_bots').row()
    .text('⬅️  Main Menu', 'main_menu'));
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
  return styleKeyboard(keyboard
    .row()
    .text('🔃  Refresh Status', `manage:${id}`)
    .text('⚙️  Settings', `settings:${id}`).row()
    .text('📍 Where', `bi:where:${id}`).text('💀 Deaths', `bi:deaths:${id}`).text('🎒 Inventory', `bi:inventory:${id}`).row()
    .text('⬅️  Back to Bots', 'list_bots').row()
    .text('🗑️  Remove Bot', `confirm_remove:${id}`));
};

const mainMenuRich = (userId, chatId, username) => {
  const bots = ownedBots(userId, chatId, username);
  const online = bots.filter(info => info.status === 'online').length;
  return `<h2>🤖 Minecraft Bot Manager</h2>` +
    `<p>Connect fake offline players to any Minecraft server.</p>` +
    `<blockquote>Supports ViaVersion · ViaBackwards · ViaRewind</blockquote>` +
    rTable(['💎 Registered', '🟢 Online'], [[`<b>${bots.length}</b>`, `<b>${online}</b>`]]) +
    rFooter('Updated');
};

const botListRich = (userId, chatId, username) => {
  const bots = ownedBots(userId, chatId, username);
  if (!bots.length) {
    return `<h3>🤖 No bots registered</h3><p>Press <b>➕ Add Bot</b> to connect one.</p>`;
  }
  const rows = bots.map(info => [
    `${dot(info.status)} <b>${esc(info.name)}</b>`,
    `<code>${esc(info.host)}:${info.port}</code>`,
    `<code>${esc(info.version)}</code>`,
    `<b>${statusLabel(info.status)}</b>${info.connectedAt ? `<br>⏱ ${uptime(Date.now() - info.connectedAt)}` : ''}`,
  ]);
  return `<h3>🤖 Your bots (${bots.length})</h3>` +
    rTable(['Bot', 'Server', 'Version', 'Status'], rows) +
    rFooter('Updated');
};

const botManageRich = info => {
  const rows = [
    ['🌐 Server', `<code>${esc(info.host)}:${info.port}</code>`],
    ['🔧 Version', `<code>${esc(info.version)}</code>`],
    ['📡 Status', `<b>${statusLabel(info.status)}</b>`],
  ];
  if (info.connectedAt) rows.push(['⏱ Uptime', uptime(Date.now() - info.connectedAt)]);
  if (info.reconnectAttempts) rows.push(['🔄 Reconnects', `${info.reconnectAttempts}/${CFG.MAX_RECONNECTS}`]);
  const autos = [...(info.autos?.values() || [])];
  if (autos.length) rows.push(['🔁 Auto', autos.map(auto => `<code>${esc(R.autoLabel(auto))}</code>`).join('<br>')]);
  const onFlags = R.SETTINGS_FIELDS.filter(([key]) => info.settings[key]).map(([, label]) => label);
  if (onFlags.length) rows.push(['⚙️ Settings', onFlags.join(', ')]);
  return `<h3>${dot(info.status)} ${esc(info.name)}</h3>` +
    `<p><i>${esc(ownerTag(info))}</i></p>` +
    rTable(['Property', 'Value'], rows) +
    (info.error ? `<blockquote expandable>⚠️ Last event: <code>${esc(info.error)}</code></blockquote>` : '') +
    rFooter('Updated');
};

const helpRich = () =>
  `<h2>⭐ Help &amp; Usage</h2>` +
  `<details open><summary>➕ Adding a bot</summary>` +
  `<p>Press <b>Add Bot</b> then send:</p>` +
  `<pre><code>name  ip  port  [version]\nname  ip:port  [version]</code></pre>` +
  `<pre><code>Steve play.example.com 25565\nAlex mc.example.com 25565 1.8.9</code></pre>` +
  `<p><b>Versions:</b> 1.21.4 · 1.20.4 · 1.19.4 · 1.16.5 · 1.12.2 · 1.8.9 · 1.7.10</p>` +
  `<p>🔥 <b>Via:</b> ViaVersion / ViaBackwards / ViaRewind — set the right client version.</p>` +
  `</details>` +
  `<details><summary>📡 Forwarding</summary><code>/forward</code> opens the manager: <b>Forwards</b> (🟢 on / 🔴 off) and <b>New Forward</b> (wizard). Each destination has a 🎚 filter (everything / chat + deaths / chat only), 🎮 two-way (your messages go into the game) and a bot picker. In a group, <code>/forward</code> adds that group instantly.</details>` +
  `<details><summary>📢 Echo</summary><code>/echo [botname] message</code></details>` +
  `<details><summary>🚶 Walk</summary><code>/walk forward 10</code> — move your bots</details>` +
  `<details><summary>🔁 Auto</summary>` +
  `<pre><code>/auto [bot] walk forward 2 60\n/auto [bot] walk forward 2 30-90\n/auto list\n/auto stop [bot]</code></pre>` +
  `Repeats an action on a timer.</details>` +
  `<details><summary>⚙️ Settings &amp; safety</summary>` +
  `<code>/settings [bot]</code> — toggles, 👀 proximity and 🕐 schedule in one menu · <code>/settings all</code> — every bot<br>` +
  `<code>/autoreply [bot] add hi * | hello! | 30</code> — wildcard trigger, 30s cooldown<br>` +
  `<code>/where</code> · <code>/deaths</code> · <code>/inventory</code> — pick a bot with the buttons (deaths include coordinates)<br>` +
  `<code>/ai [bot]</code> — AI chat panel · <code>/keys</code> — your own AI API keys (private chat)<br>` +
  `<code>/digest</code> — turn the hourly status summary on or off<br>` +
  `<code>/watch</code> — alerts when chosen players join or leave · <code>/settings</code> has an opt-in 🧊 stuck alert<br><code>/status</code> — manager health, servers and backups<br><code>/quiet 23-7</code> — alerts arrive silently at night (bans, deaths and stuck alerts stay audible) · <code>/quiet tz Asia/Baku</code> sets your timezone</details>` +
  `<footer>Bots stay idle unless you use /walk, /auto or the idle randomizer.</footer>`;

const helpText = () =>
  `⭐ <b>Help &amp; Usage</b>\n\n` +
  `<b>➕ Adding a bot</b>\nPress <i>Add Bot</i> then send:\n` +
  `<code>name  ip  port  [version]</code>\n` +
  `or <code>name  ip:port  [version]</code>\n\n` +
  `<b>Examples:</b>\n` +
  `<code>Steve play.example.com 25565</code>\n` +
  `<code>Alex mc.example.com 25565 1.8.9</code>\n\n` +
  `<b>Versions:</b> 1.21.4 · 1.20.4 · 1.19.4 · 1.16.5 · 1.12.2 · 1.8.9 · 1.7.10\n\n` +
  `🔥 <b>Via:</b> ViaVersion / ViaBackwards / ViaRewind — set the right client version.\n\n` +
  `📡 <b>Forwarding:</b> <code>/forward</code> — manager with <i>Forwards</i> (🟢/🔴) and <i>New Forward</i> wizard\n` +
  `📢 <b>Echo:</b> <code>/echo [botname] message</code> · 🚶 <b>Walk:</b> <code>/walk forward 10</code> · 🔁 <b>Auto:</b> <code>/auto [bot] walk forward 2 60</code>\n` +
  `⚙️ <b>Settings:</b> <code>/settings [bot]</code> — toggles, proximity, schedule · <code>/settings all</code>\n` +
  `💬 <b>Auto-reply:</b> <code>/autoreply [bot] add hi * | hello! | 30</code> (<code>*</code> = wildcard, last field = cooldown s)\n` +
  `📍 <code>/where</code> · 💀 <code>/deaths</code> · 🎒 <code>/inventory</code>\n` +
  `🤖 <b>AI chat:</b> <code>/ai [bot]</code> · 🔑 <b>API keys:</b> <code>/keys</code> in a private chat\n` +
  `🔔 <b>Digest:</b> <code>/digest</code> — toggles the hourly status summary\n` +
  `👀 <b>Watchlist:</b> <code>/watch add Notch</code> — alert when a player joins or leaves\n` +
  `🩺 <b>Status:</b> <code>/status</code> — manager health, servers and backups\n` +
  `🌙 <b>Quiet hours:</b> <code>/quiet 23-7</code> · <code>/quiet tz Asia/Baku</code> — silent alerts at night\n` +
  `Bots stay idle unless you use /walk, /auto or the idle randomizer.`;

Object.assign(R, { mainMenuText, mainMenuKeyboard, botListText, botListKeyboard, botManageText, botManageKeyboard,
  mainMenuRich, botListRich, botManageRich, helpRich, helpText });
