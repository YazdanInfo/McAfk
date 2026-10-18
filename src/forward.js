'use strict';
// Forwarding hub and two-way relay.
const R = require('./registry');
const { InlineKeyboard, Keyboard } = require('grammy');
const { CFG, DEATH_PATTERN, bot, chatStates, esc, forwardKeyFor, forwardMap, ownedBots, rFooter, rSend, rTable,
  richErrorText, saveData, shortBotName, styleKeyboard, styledText, tgTime, utcText } = R;

// ---------------------------------------------------------------------------
// FORWARDING — /forward hub: Forwards list (🟢/🔴) + New Forward wizard
// ---------------------------------------------------------------------------

const FWD_FILTERS = ['all', 'chat_deaths', 'chat'];
const FWD_FILTER_LABEL = { all: '📜 Everything', chat_deaths: '💬 Chat + deaths', chat: '💬 Chat only' };
const FWD_FILTER_ALLOWS = {
  all: () => true,
  chat_deaths: kind => kind === 'chat' || kind === 'death',
  chat: kind => kind === 'chat',
};

const FWD_REQ_GROUP = 11;
const FWD_REQ_CHANNEL = 12;
const FWD_PAUSE_PATTERN = /forbidden|kicked|chat not found|not enough rights|have no rights|deactivated|blocked|peer_id_invalid/i;

const botUsername = () => {
  try { return bot.botInfo?.username || null; } catch (_) { return null; }
};

const fwdPairs = userId => [...(forwardMap.get(String(userId))?.entries() || [])];
const fwdEntry = (userId, chatId) => forwardMap.get(String(userId))?.get(String(chatId)) || null;

// Classifies a clean Minecraft line: 'chat' | 'death' | 'join' | 'other' (heuristic, vanilla + common plugin formats).
const classifyMcMessage = clean => {
  if (/^\S{1,32} (?:joined|left) the game$/i.test(clean)) return 'join';
  if (/^(?:<[^>\n]{1,40}>|(?:\[[^\]\n]{1,30}\]\s*)*[^\s:<>\[\]]{1,32}\s*[:»])\s/.test(clean)) return 'chat';
  if (DEATH_PATTERN.test(clean)) return 'death';
  return 'other';
};

const fwdTargetsFor = (info, kind = 'other') => {
  const dests = forwardMap.get(forwardKeyFor(info));
  if (!dests?.size) return [];
  return [...dests].filter(([, entry]) =>
    entry.active
    && (!entry.bots || entry.bots.includes(String(info.id)))
    && (FWD_FILTER_ALLOWS[entry.filter] || FWD_FILTER_ALLOWS.all)(kind));
};

// Batched relay: lines for one destination are collected and sent as ONE message (leading edge, then at most
// one message per FWD_BATCH_MS). Keeps us under Telegram's per-group rate limit and honours retry_after.
const fwdBuffers = new Map(); // entry -> { chatId, lines: [{label,text}], timer, lastSentAt, dropped, sending }

const isLiveFwdEntry = (chatId, entry) => {
  for (const dests of forwardMap.values()) if (dests.get(String(chatId)) === entry) return true;
  return false;
};

const renderFwdLines = lines => {
  if (lines.length === 1) return `${lines[0].label} ${lines[0].text}`;
  const out = [];
  let last = null;
  for (const line of lines) {
    if (line.label !== last) {
      out.push(`${last ? '\n' : ''}${line.label}`);
      last = line.label;
    }
    out.push(line.text);
  }
  return out.join('\n');
};

const chunkFwdLines = lines => {
  const chunks = [];
  let current = [];
  for (const line of lines) {
    if (current.length && renderFwdLines([...current, line]).length > CFG.FWD_CHUNK_CHARS) {
      chunks.push(current);
      current = [];
    }
    current.push(line);
  }
  if (current.length) chunks.push(current);
  return chunks;
};

const queueFwdFlush = (entry, buf) => {
  if (buf.timer) return;
  const wait = Math.max(0, buf.lastSentAt + CFG.FWD_BATCH_MS - Date.now());
  buf.timer = setTimeout(() => { void flushForward(entry, buf); }, wait);
};

const flushForward = async (entry, buf) => {
  buf.timer = null;
  if (buf.sending) {
    buf.timer = setTimeout(() => { void flushForward(entry, buf); }, 300);
    return;
  }
  const lines = buf.lines;
  buf.lines = [];
  if (!lines.length) return;
  if (!entry.active || !isLiveFwdEntry(buf.chatId, entry)) { buf.dropped = 0; return; }
  const skipped = buf.dropped;
  buf.dropped = 0;
  const chunks = chunkFwdLines(lines);
  buf.sending = true;
  buf.lastSentAt = Date.now();
  try {
    for (let i = 0; i < chunks.length; i += 1) {
      const body = `${i === 0 && skipped ? `…${skipped} older line(s) skipped\n` : ''}${renderFwdLines(chunks[i])}`;
      try {
        await bot.api.sendMessage(buf.chatId, body);
      } catch (error) {
        const reason = richErrorText(error);
        const retry = Number(error?.parameters?.retry_after);
        if (retry > 0) {
          const rest = chunks.slice(i).flat();
          buf.lines = rest.concat(buf.lines).slice(-CFG.FWD_BUFFER_MAX);
          buf.lastSentAt = Date.now() + retry * 1000 - CFG.FWD_BATCH_MS;
          return;
        }
        if (entry.active && FWD_PAUSE_PATTERN.test(reason)) {
          entry.active = false;
          entry.lastError = reason.slice(0, 120);
          saveData();
          return;
        }
      }
    }
  } finally {
    buf.sending = false;
    if (buf.lines.length) queueFwdFlush(entry, buf);
  }
};

// Shutdown: send everything still waiting in the batch buffers right away (ignoring the batch window),
// destinations in parallel, giving up after FWD_FLUSH_TIMEOUT_MS so shutdown never hangs.
const flushForwardsNow = async () => {
  const jobs = [];
  for (const [entry, buf] of fwdBuffers) {
    clearTimeout(buf.timer);
    buf.timer = null;
    const lines = buf.lines;
    buf.lines = [];
    if (!lines.length || !entry.active || !isLiveFwdEntry(buf.chatId, entry)) continue;
    const skipped = buf.dropped;
    buf.dropped = 0;
    const chunks = chunkFwdLines(lines);
    jobs.push((async () => {
      for (let i = 0; i < chunks.length; i += 1) {
        const body = `${i === 0 && skipped ? `…${skipped} older line(s) skipped\n` : ''}${renderFwdLines(chunks[i])}`;
        try {
          await bot.api.sendMessage(buf.chatId, body);
        } catch (_) {
          return; // best effort: no retries while shutting down
        }
      }
    })());
  }
  if (!jobs.length) return;
  await Promise.race([
    Promise.allSettled(jobs),
    new Promise(resolve => setTimeout(resolve, CFG.FWD_FLUSH_TIMEOUT_MS)),
  ]);
};

const sendForward = (chatId, entry, label, text) => {
  let buf = fwdBuffers.get(entry);
  if (!buf) {
    buf = { chatId, lines: [], timer: null, lastSentAt: 0, dropped: 0, sending: false };
    fwdBuffers.set(entry, buf);
  }
  buf.lines.push({ label, text: String(text).slice(0, 1000) });
  if (buf.lines.length > CFG.FWD_BUFFER_MAX) {
    buf.lines.shift();
    buf.dropped += 1;
  }
  queueFwdFlush(entry, buf);
};

const fwdTypeLabel = type => type === 'channel' ? '📢 Channel' : type === 'private' ? '👤 Private chat' : '👥 Group';
const fwdTitle = (chatId, entry) => entry.title || (entry.type === 'private' ? 'Private chat' : `Chat ${chatId}`);
const fwdDot = entry => entry.active ? '🟢' : '🔴';
const shortTitle = (text, max = 26) => text.length > max ? `${text.slice(0, max - 1)}…` : text;
const fwdBotsLabel = (entry, owned) => {
  if (!entry.bots) return 'All bots';
  const names = owned.filter(info => entry.bots.includes(String(info.id))).map(info => info.name);
  return names.length ? names.join(', ') : '—';
};

const fwdHomeView = (userId, owned) => {
  const pairs = fwdPairs(userId);
  const active = pairs.filter(([, entry]) => entry.active).length;
  const rich = `<h2>📡 Chat Forwarding</h2>` +
    `<p>Send your bots' Minecraft chat to a group, a channel or this chat.</p>` +
    rTable(['🟢 Active', '🔴 Paused', '🤖 Bots'], [[`<b>${active}</b>`, `<b>${pairs.length - active}</b>`, `<b>${owned.length}</b>`]]) +
    `<blockquote>📡 <b>Forwards</b> — every destination, switch each on or off.<br>➕ <b>New Forward</b> — add one with a short wizard.</blockquote>` +
    rFooter('Forward');
  const legacy = `📡 <b>Chat Forwarding</b>\n\nSend your bots' Minecraft chat to a group, a channel or this chat.\n\n` +
    `🟢 Active: <b>${active}</b>   🔴 Paused: <b>${pairs.length - active}</b>   🤖 Bots: <b>${owned.length}</b>\n\n` +
    `<b>Forwards</b> — every destination, switch each on or off.\n<b>New Forward</b> — add one with a short wizard.`;
  const keyboard = new InlineKeyboard().text('📡 Forwards ›', 'fw:list');
  styledText(keyboard, '➕ New Forward', 'fw:new', 'primary').row();
  keyboard.text('⬅️ Main Menu', 'main_menu');
  return { rich, legacy, keyboard };
};

const fwdListView = (userId, owned) => {
  const pairs = fwdPairs(userId);
  const keyboard = new InlineKeyboard();
  for (const [chatId, entry] of pairs) {
    styledText(keyboard, `${fwdDot(entry)} ${shortTitle(fwdTitle(chatId, entry))}`, `fw:d:${chatId}`, entry.active ? 'success' : 'danger').row();
  }
  keyboard.text('⬅️ Back', 'fw:home');
  styledText(keyboard, '➕ New Forward', 'fw:new', 'primary');
  if (!pairs.length) {
    return {
      rich: `<h3>📡 No forwards yet</h3><p>Press <b>➕ New Forward</b> to add your first destination.</p>`,
      legacy: `📡 <b>No forwards yet</b>\nPress <b>➕ New Forward</b> to add your first destination.`,
      keyboard,
    };
  }
  const rich = `<h3>📡 Forwards (${pairs.length})</h3>` +
    rTable(['State', 'Destination', 'Type', 'Bots'], pairs.map(([chatId, entry]) => [
      `${fwdDot(entry)}${entry.lastError ? ' ⚠️' : ''}`,
      `<b>${esc(fwdTitle(chatId, entry))}</b>`,
      esc(fwdTypeLabel(entry.type)),
      esc(fwdBotsLabel(entry, owned)),
    ])) +
    `<p><i>🟢 forwarding · 🔴 paused — tap a destination to manage it.</i></p>` + rFooter('Forwards');
  const legacy = `📡 <b>Forwards (${pairs.length})</b>\n\n` +
    pairs.map(([chatId, entry]) => `${fwdDot(entry)} <b>${esc(fwdTitle(chatId, entry))}</b> — ${esc(fwdTypeLabel(entry.type))} · ${esc(fwdBotsLabel(entry, owned))}`).join('\n') +
    `\n\n🟢 forwarding · 🔴 paused — tap a destination to manage it.`;
  return { rich, legacy, keyboard };
};

const fwdDetailView = (userId, chatId, owned, note = '') => {
  const entry = fwdEntry(userId, chatId);
  if (!entry) return null;
  const title = fwdTitle(chatId, entry);
  const rich = `<h3>${fwdDot(entry)} ${esc(title)}</h3>` + (note ? `<p>${note}</p>` : '') +
    rTable(['Property', 'Value'], [
      ['📍 Destination', `<b>${esc(title)}</b>`],
      ['🏷 Type', esc(fwdTypeLabel(entry.type))],
      ['📡 Status', entry.active ? '🟢 <b>Forwarding</b>' : '🔴 <b>Paused</b>'],
      ['🤖 Bots', esc(fwdBotsLabel(entry, owned))],
      ['🎚 Filter', esc(FWD_FILTER_LABEL[entry.filter] || FWD_FILTER_LABEL.all)],
      ...(entry.type === 'channel' ? [] : [['🎮 Two-way', entry.twoWay ? '🟢 <b>On</b> — your messages go into the game' : '⬜ Off']]),
      ['🗓 Added', tgTime(entry.addedAt)],
    ]) +
    (entry.lastError ? `<blockquote expandable>⚠️ Paused automatically: <code>${esc(entry.lastError)}</code></blockquote>` : '') +
    rFooter('Forward');
  const legacy = `${fwdDot(entry)} <b>${esc(title)}</b>\n${note ? `${note}\n` : ''}\n` +
    `Type: ${esc(fwdTypeLabel(entry.type))}\nStatus: ${entry.active ? '🟢 Forwarding' : '🔴 Paused'}\nBots: ${esc(fwdBotsLabel(entry, owned))}\nFilter: ${esc(FWD_FILTER_LABEL[entry.filter] || FWD_FILTER_LABEL.all)}\n` +
    (entry.type === 'channel' ? '' : `Two-way: ${entry.twoWay ? '🟢 On' : '⬜ Off'}\n`) + `Added: ${utcText(entry.addedAt)}` +
    (entry.lastError ? `\n⚠️ Paused automatically: <code>${esc(entry.lastError)}</code>` : '');
  const keyboard = new InlineKeyboard();
  styledText(keyboard, entry.active ? '🔴 Turn off' : '🟢 Turn on', `fw:t:${chatId}`, entry.active ? 'danger' : 'success').row();
  keyboard.text(`🎚 ${FWD_FILTER_LABEL[entry.filter] || FWD_FILTER_LABEL.all}`, `fw:f:${chatId}`).row();
  if (entry.type !== 'channel') {
    styledText(keyboard, entry.twoWay ? '🎮 Two-way: ON' : '🎮 Two-way: OFF', `fw:w:${chatId}`, entry.twoWay ? 'success' : undefined).row();
  }
  keyboard.text('🤖 Bots', `fw:b:${chatId}`).text('🧪 Test', `fw:x:${chatId}`).row();
  styledText(keyboard, '🗑 Remove', `fw:r:${chatId}`, 'danger').row();
  keyboard.text('⬅️ Back', 'fw:list');
  return { rich, legacy, keyboard };
};

const fwdBotsView = (userId, chatId, owned, note = '', wizard = false) => {
  const entry = fwdEntry(userId, chatId);
  if (!entry) return null;
  const title = fwdTitle(chatId, entry);
  const selected = info => !entry.bots || entry.bots.includes(String(info.id));
  const rich = `<h3>🤖 Bots → ${esc(title)}</h3>` + (note ? `<p>${note}</p>` : '') +
    `<p>Tap a bot to include or exclude it. <i>Default: all bots, including ones you add later.</i></p>` + rFooter('Forward');
  const legacy = `🤖 <b>Bots → ${esc(title)}</b>\n${note ? `${note}\n` : ''}\nTap a bot to include or exclude it. Default: all bots.`;
  const keyboard = new InlineKeyboard();
  for (const info of owned) {
    styledText(keyboard, `${selected(info) ? '✅' : '⬜'} ${shortBotName(info.name)}`, `fw:bt:${chatId}:${info.id}`, selected(info) ? 'success' : undefined).row();
  }
  keyboard.text('🌐 All bots', `fw:ba:${chatId}`);
  styledText(keyboard, wizard ? '✔️ Done' : '⬅️ Back', `fw:d:${chatId}`, wizard ? 'primary' : undefined);
  return { rich, legacy, keyboard };
};

const fwdNewView = () => {
  const keyboard = new InlineKeyboard();
  styledText(keyboard, '👥 Pick a chat', 'fw:pick', 'primary').row();
  keyboard.text('👤 This chat', 'fw:self').text('✏️ Enter ID', 'fw:id').row();
  keyboard.text('❌ Cancel', 'fw:home');
  return {
    rich: `<h3>➕ New Forward — step 1</h3><p>Where should Minecraft chat go?</p>` +
      `<blockquote>👥 <b>Pick a chat</b> — choose a group or channel from your list.<br>` +
      `👤 <b>This chat</b> — send it here, to our private chat.<br>` +
      `✏️ <b>Enter ID</b> — type <code>@username</code> or a numeric chat ID.</blockquote>` +
      `<p><i>I must be a member of the destination (channels: admin with Post Messages).</i></p>` + rFooter('Wizard'),
    legacy: `➕ <b>New Forward — step 1</b>\nWhere should Minecraft chat go?\n\n` +
      `👥 <b>Pick a chat</b> — a group or channel from your list\n👤 <b>This chat</b> — our private chat\n✏️ <b>Enter ID</b> — <code>@username</code> or numeric ID\n\n` +
      `I must be a member of the destination (channels: admin with Post Messages).`,
    keyboard,
  };
};

const FWD_FAIL_TEXT = {
  notfound: "I can't find that chat. Add me to the group or channel first, then try again.",
  notmember: 'You need to be a member of that group (or an admin of that channel) to forward into it.',
  private: 'A private chat can only be your own.',
  limit: `You already have ${CFG.FORWARD_MAX} forwards — remove one first.`,
  send: "I can't post there. Make me a member (channels: admin with Post Messages) and try again.",
};

const fwdFailView = result => {
  const text = FWD_FAIL_TEXT[result.reason] || 'Something went wrong.';
  const detail = result.detail ? ` <code>${esc(String(result.detail).slice(0, 120))}</code>` : '';
  const username = botUsername();
  const keyboard = new InlineKeyboard();
  if (username) {
    keyboard.url('➕ Add me to a group', `https://t.me/${username}?startgroup=true`).row();
    keyboard.url('📢 Add me to a channel', `https://t.me/${username}?startchannel=true&admin=post_messages`).row();
  }
  keyboard.text('🔁 Try again', 'fw:new').text('⬅️ Back', 'fw:home');
  return {
    rich: `<h3>❌ Couldn't add it</h3><p>${esc(text)}${detail}</p>`,
    legacy: `❌ <b>Couldn't add it</b>\n${esc(text)}${detail}`,
    keyboard,
  };
};

const parseChatRef = raw => {
  const text = String(raw || '').trim();
  if (/^-?\d{5,}$/.test(text)) return Number(text);
  const link = /^(?:https?:\/\/)?t\.me\/([A-Za-z][A-Za-z0-9_]{3,})\/?$/i.exec(text);
  if (link) return `@${link[1]}`;
  if (/^@?[A-Za-z][A-Za-z0-9_]{3,}$/.test(text)) return text.startsWith('@') ? text : `@${text}`;
  return null;
};

const fwdTestMessage = () => ({
  rich: `<h4>🧪 Forwarding test</h4><p>Minecraft chat from your bots will appear here.</p>${rFooter('Test')}`,
  legacy: `🧪 <b>Forwarding test</b>\nMinecraft chat from your bots will appear here.`,
});

// Validates the destination (exists, user belongs to it, bot can post), then stores it as an active forward.
const addFwdDestination = async (userId, target) => {
  const key = String(userId);
  let chat;
  try {
    chat = await bot.api.getChat(target);
  } catch (error) {
    return { ok: false, reason: 'notfound', detail: richErrorText(error) };
  }
  const chatId = String(chat.id);
  if (chat.type === 'private') {
    if (chatId !== key) return { ok: false, reason: 'private' };
  } else {
    try {
      const member = await bot.api.getChatMember(chat.id, userId);
      const allowed = chat.type === 'channel'
        ? ['creator', 'administrator']
        : ['creator', 'administrator', 'member', 'restricted'];
      if (!allowed.includes(member.status)) return { ok: false, reason: 'notmember' };
    } catch (_) {
      return { ok: false, reason: 'notmember' };
    }
  }
  if (fwdEntry(userId, chatId)) return { ok: true, chatId, existed: true };
  if (fwdPairs(userId).length >= CFG.FORWARD_MAX) return { ok: false, reason: 'limit' };
  const test = fwdTestMessage();
  try {
    await rSend(chat.id, test.rich, test.legacy);
  } catch (error) {
    return { ok: false, reason: 'send', detail: richErrorText(error) };
  }
  if (!forwardMap.has(key)) forwardMap.set(key, new Map());
  forwardMap.get(key).set(chatId, {
    active: true,
    title: chat.type === 'private' ? 'My private chat' : (chat.title || chat.username || ''),
    type: ['private', 'group', 'supergroup', 'channel'].includes(chat.type) ? chat.type : 'group',
    addedAt: Date.now(),
    bots: null,
    lastError: null,
    filter: 'all',
    twoWay: false,
  });
  saveData();
  return { ok: true, chatId };
};

const fwdAddResultView = (userId, owned, result) => {
  if (!result.ok) return fwdFailView(result);
  if (result.existed) return fwdDetailView(userId, result.chatId, owned, 'ℹ️ Already in your list.');
  if (owned.length > 1) {
    return fwdBotsView(userId, result.chatId, owned, '✅ Added and switched on. <b>Step 2</b> — pick the bots to forward.', true);
  }
  return fwdDetailView(userId, result.chatId, owned, '✅ Added and switched on.');
};

const clearFwdState = (chatId, userId) => {
  const state = chatStates.get(chatId);
  if ((state?.action === 'fwd_pick' || state?.action === 'fwd_id') && state.userId === userId) chatStates.delete(chatId);
};

const toggleFwdBot = (entry, owned, botId) => {
  const ids = owned.map(info => String(info.id));
  const current = entry.bots ? new Set(entry.bots.filter(id => ids.includes(id))) : new Set(ids);
  if (current.has(botId)) {
    if (current.size === 1) return false; // at least one bot must stay selected
    current.delete(botId);
  } else {
    current.add(botId);
  }
  entry.bots = ids.every(id => current.has(id)) ? null : [...current];
  return true;
};

async function handleFwdCallback(ctx, data, edit, answer) {
  const userId = ctx.from.id;
  const chatId = ctx.chat.id;
  const isPrivate = ctx.chat?.type === 'private';
  const owned = ownedBots(userId, chatId, ctx.from.username);
  const [, action, a, b] = data.split(':');
  const show = view => edit(view.legacy, view.keyboard, view.rich);
  const target = /^-?\d+$/.test(a || '') ? a : null;
  const needPrivate = () => answer('Open a private chat with me for this');

  if (action === 'home') {
    clearFwdState(chatId, userId);
    await show(fwdHomeView(userId, owned));
    return answer();
  }
  if (action === 'list') {
    await show(fwdListView(userId, owned));
    return answer();
  }
  if (action === 'new') {
    if (!isPrivate) return needPrivate();
    clearFwdState(chatId, userId);
    await show(fwdNewView());
    return answer();
  }
  if (action === 'pick') {
    if (!isPrivate) return needPrivate();
    chatStates.set(chatId, { action: 'fwd_pick', userId, expires: Date.now() + CFG.WIZARD_TTL_MS });
    await ctx.reply('👇 Choose the chat to forward into.', {
      reply_markup: new Keyboard()
        .requestChat('👥 Group', FWD_REQ_GROUP, { chat_is_channel: false })
        .requestChat('📢 Channel', FWD_REQ_CHANNEL, { chat_is_channel: true }).row()
        .text('❌ Cancel').oneTime().resized(),
    }).catch(() => {});
    return answer();
  }
  if (action === 'self') {
    if (!isPrivate) return needPrivate();
    const result = await addFwdDestination(userId, userId);
    await show(fwdAddResultView(userId, owned, result));
    return answer(result.ok ? '✅ Added' : '❌ Failed');
  }
  if (action === 'id') {
    if (!isPrivate) return needPrivate();
    chatStates.set(chatId, { action: 'fwd_id', userId, expires: Date.now() + CFG.WIZARD_TTL_MS });
    await edit(
      `✏️ <b>Enter the destination</b>\nSend <code>@username</code>, a t.me link or a numeric chat ID.`,
      new InlineKeyboard().text('❌ Cancel', 'fw:home'),
      `<h3>✏️ Enter the destination</h3><p>Send <code>@username</code>, a t.me link or a numeric chat ID.</p>`,
    );
    return answer('✏️ Type it in chat');
  }

  // everything below targets an existing forward
  if (!target || !fwdEntry(userId, target)) return answer('Forward not found');
  const entry = fwdEntry(userId, target);

  if (action === 'd') {
    await show(fwdDetailView(userId, target, owned));
    return answer();
  }
  if (action === 't') {
    entry.active = !entry.active;
    if (entry.active) entry.lastError = null;
    saveData();
    await show(fwdDetailView(userId, target, owned));
    return answer(entry.active ? '🟢 Forwarding on' : '🔴 Paused');
  }
  if (action === 'x') {
    const test = fwdTestMessage();
    try {
      await rSend(Number(target), test.rich, test.legacy);
      return answer('🧪 Test sent');
    } catch (error) {
      return answer(`❌ ${richErrorText(error)}`.slice(0, 180));
    }
  }
  if (action === 'r') {
    const title = fwdTitle(target, entry);
    await edit(
      `⚠️ Remove the forward to <b>${esc(title)}</b>?`,
      styleKeyboard(new InlineKeyboard().text('✅ Yes, remove', `fw:rd:${target}`).text('❌ Cancel', `fw:d:${target}`)),
      `<h3>⚠️ Remove forward?</h3><p><b>${esc(title)}</b> will stop receiving Minecraft chat.</p>`,
    );
    return answer();
  }
  if (action === 'rd') {
    const dests = forwardMap.get(String(userId));
    dests?.delete(target);
    if (dests && !dests.size) forwardMap.delete(String(userId));
    saveData();
    await show(fwdListView(userId, owned));
    return answer('🗑 Removed');
  }
  if (action === 'f') {
    entry.filter = FWD_FILTERS[(FWD_FILTERS.indexOf(entry.filter) + 1) % FWD_FILTERS.length];
    saveData();
    await show(fwdDetailView(userId, target, owned));
    return answer(FWD_FILTER_LABEL[entry.filter]);
  }
  if (action === 'w') {
    if (entry.type === 'channel') return answer('Not available for channels');
    entry.twoWay = !entry.twoWay;
    saveData();
    const note = entry.twoWay
      ? '🎮 <b>Two-way on.</b> Your messages here are said in the game (never starting with <code>/</code>). ' +
        'Prefix <code>@BotName</code> to pick a bot. If nothing happens, turn off <b>Group Privacy</b> for me in @BotFather or make me admin.'
      : '';
    await show(fwdDetailView(userId, target, owned, note));
    return answer(entry.twoWay ? '🎮 Two-way on' : '🎮 Two-way off');
  }
  if (action === 'b') {
    await show(fwdBotsView(userId, target, owned));
    return answer();
  }
  if (action === 'bt') {
    if (!owned.some(info => String(info.id) === String(b))) return answer('Bot not found');
    if (!toggleFwdBot(entry, owned, String(b))) return answer('Keep at least one bot selected');
    saveData();
    await show(fwdBotsView(userId, target, owned, '', true));
    return answer();
  }
  if (action === 'ba') {
    entry.bots = null;
    saveData();
    await show(fwdBotsView(userId, target, owned, '', true));
    return answer('🌐 All bots');
  }
  return answer();
}

async function handleFwdText(ctx, state, text) {
  if (state.userId !== ctx.from?.id) return;
  const chatId = ctx.chat.id;
  const owned = ownedBots(ctx.from.id, chatId, ctx.from.username);
  const hideKeyboard = { reply_markup: { remove_keyboard: true } };
  if (state.expires < Date.now()) {
    chatStates.delete(chatId);
    return ctx.reply('⌛ That took too long. Send /forward to start again.', hideKeyboard);
  }
  if (/^[^\w]*cancel$/i.test(text)) {
    chatStates.delete(chatId);
    await ctx.reply('Cancelled.', hideKeyboard);
    const home = fwdHomeView(ctx.from.id, owned);
    return rSend(chatId, home.rich, home.legacy, home.keyboard);
  }
  if (state.action === 'fwd_pick') {
    return ctx.reply('👆 Use the buttons under the keyboard to pick a chat, or press ❌ Cancel.');
  }
  const ref = parseChatRef(text);
  if (ref == null) {
    return ctx.reply('❌ Send an <code>@username</code>, a t.me link or a numeric chat ID.', { parse_mode: 'HTML' });
  }
  chatStates.delete(chatId);
  const result = await addFwdDestination(ctx.from.id, ref);
  const view = fwdAddResultView(ctx.from.id, owned, result);
  return rSend(chatId, view.rich, view.legacy, view.keyboard);
}

// The chat picked with the "Pick a chat" button (request_chat reply keyboard).
bot.on('message:chat_shared', async ctx => {
  const state = chatStates.get(ctx.chat.id);
  if (state?.action !== 'fwd_pick' || state.userId !== ctx.from?.id || state.expires < Date.now()) return;
  chatStates.delete(ctx.chat.id);
  const waiting = await ctx.reply('⏳ Checking that chat…', { reply_markup: { remove_keyboard: true } }).catch(() => null);
  const result = await addFwdDestination(ctx.from.id, Number(ctx.message.chat_shared.chat_id));
  if (waiting) bot.api.deleteMessage(ctx.chat.id, waiting.message_id).catch(() => {});
  const view = fwdAddResultView(ctx.from.id, ownedBots(ctx.from.id, ctx.chat.id, ctx.from.username), result);
  await rSend(ctx.chat.id, view.rich, view.legacy, view.keyboard);
});

// ---------------------------------------------------------------------------
// TWO-WAY RELAY — messages from the forward's owner in a two-way destination are said in the game
// ---------------------------------------------------------------------------

async function relayTwoWay(ctx, text) {
  if (!ctx.from || !text || text.startsWith('/')) return; // never turn Telegram text into game commands
  const entry = fwdEntry(ctx.from.id, ctx.chat.id);
  if (!entry || !entry.active || !entry.twoWay || entry.type === 'channel') return;
  const pool = ownedBots(ctx.from.id, ctx.chat.id, ctx.from.username)
    .filter(info => !entry.bots || entry.bots.includes(String(info.id)));
  if (!pool.length) return;
  let message = text;
  let candidates = pool;
  const named = /^@(\S+)\s+([\s\S]+)$/.exec(text);
  if (named) {
    const target = pool.find(info => info.name.toLowerCase() === named[1].toLowerCase());
    if (target) {
      candidates = [target];
      message = named[2];
    }
  }
  message = message.replace(/\s*\n\s*/g, ' ').trim();
  if (!message) return;
  if (message.length > CFG.MC_CHAT_MAX) {
    return ctx.reply(`❌ Too long for Minecraft chat (${message.length}/${CFG.MC_CHAT_MAX}).`);
  }
  const sender = candidates.find(info => info.status === 'online' && info.mcBot);
  if (!sender) return ctx.reply('⚠️ No selected bot is online.');
  try {
    sender.mcBot.chat(message);
  } catch (_) {
    return ctx.reply('❌ Could not send that message.');
  }
  bot.api.setMessageReaction(ctx.chat.id, ctx.message.message_id, [{ type: 'emoji', emoji: '👍' }]).catch(() => {});
}

Object.assign(R, { FWD_FILTERS, FWD_FILTER_LABEL, FWD_FILTER_ALLOWS, FWD_REQ_GROUP, FWD_REQ_CHANNEL,
  FWD_PAUSE_PATTERN, botUsername, fwdPairs, fwdEntry, classifyMcMessage, fwdTargetsFor, fwdBuffers, isLiveFwdEntry,
  renderFwdLines, chunkFwdLines, queueFwdFlush, flushForward, flushForwardsNow, sendForward, fwdTypeLabel, fwdTitle,
  fwdDot, shortTitle, fwdBotsLabel, fwdHomeView, fwdListView, fwdDetailView, fwdBotsView, fwdNewView, FWD_FAIL_TEXT,
  fwdFailView, parseChatRef, fwdTestMessage, addFwdDestination, fwdAddResultView, clearFwdState, toggleFwdBot,
  handleFwdCallback, handleFwdText, relayTwoWay });
