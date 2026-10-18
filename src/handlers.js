'use strict';
// Telegram commands, callbacks and text handling.
const R = require('./registry');
const { InlineKeyboard } = require('grammy');
const { CFG, INFO_VIEWS, SETTINGS_FIELDS, VIEW_DISTANCE, aiPanelView, bot, botIdFor, botLimitCheck, botLimitText,
  botListKeyboard, botListRich, botListText, botManageKeyboard, botManageRich, botManageText, canUseAi, chatStates,
  claimLegacyOwnership, clearFwdState, currentUserOwns, destroyBot, digestToggleView, dot, esc, fwdHomeView, getBot,
  handleEcho, handleFwdCallback, handleFwdText, handleKeyCallback, handleKeyWizardText, handleQuietCallback,
  handleWatchCallback, handleWatchText, helpRich, helpText, isPrivateChat, mainMenuKeyboard, mainMenuRich,
  mainMenuText, mcBots, normalizeSettings, ownedBots, parseProximityInput, parseScheduleInput, parseStuckInput,
  parseViewInput, quickAddGroupForward, rEdit, rSend, refreshServerStatus, relayTwoWay, restoreAutos, saveData,
  sendDigest, settingsAllKeyboard, settingsAllRich, settingsAllText, settingsKeyboard, settingsRich, settingsText,
  spawnBot, statusView, stopAutos, styleKeyboard, toggleDigest, viewDistanceFor, checkHostAllowed, normalizeHost } = R;

bot.command('start', async ctx => {
  chatStates.delete(ctx.chat.id);
  if (ctx.match === 'forward' && isPrivateChat(ctx)) {
    const view = fwdHomeView(ctx.from.id, ownedBots(ctx.from.id, ctx.chat.id, ctx.from.username));
    return rSend(ctx.chat.id, view.rich, view.legacy, view.keyboard);
  }
  await rSend(
    ctx.chat.id,
    mainMenuRich(ctx.from.id, ctx.chat.id, ctx.from.username),
    mainMenuText(ctx.from.id, ctx.chat.id, ctx.from.username),
    mainMenuKeyboard(ctx.from.id),
  );
});

bot.command('help', async ctx => {
  await rSend(
    ctx.chat.id,
    helpRich(),
    helpText(),
    new InlineKeyboard().text('📡 Forward', 'fw:home').row()
      .text('⬅️ Main Menu', 'main_menu'),
  );
});

bot.command('forward', async ctx => {
  if (!isPrivateChat(ctx)) return quickAddGroupForward(ctx);
  clearFwdState(ctx.chat.id, ctx.from.id);
  const view = fwdHomeView(ctx.from.id, ownedBots(ctx.from.id, ctx.chat.id, ctx.from.username));
  await rSend(ctx.chat.id, view.rich, view.legacy, view.keyboard);
});

bot.command('echo', async ctx => {
  const after = ctx.message.text.trim().slice(5).trim();
  await handleEcho(ctx, after);
});

bot.on('callback_query:data', async ctx => {
  const data = ctx.callbackQuery.data;
  const chatId = ctx.chat.id;
  const userId = ctx.from.id;
  const username = ctx.from.username;
  const edit = (text, keyboard, richHtml) => {
    const messageId = ctx.callbackQuery.message?.message_id;
    if (richHtml && messageId) {
      return rEdit(chatId, messageId, richHtml, text, keyboard).catch(() => {});
    }
    return ctx.editMessageText(text, {
      parse_mode: 'HTML',
      reply_markup: keyboard,
    }).catch(() => {});
  };
  const answer = (text = '') => ctx.answerCallbackQuery({
    text,
    show_alert: false,
  }).catch(() => {});

  if (data.startsWith('k:')) return handleKeyCallback(ctx, data, edit);
  if (data.startsWith('fw:')) return handleFwdCallback(ctx, data, edit, answer);
  if (data.startsWith('wl:')) return handleWatchCallback(ctx, data, edit, answer);
  if (data.startsWith('quiet:')) return handleQuietCallback(ctx, data, edit, answer);

  if (data === 'menu_digest') {
    const on = toggleDigest(userId, chatId);
    await edit(mainMenuText(userId, chatId, username), mainMenuKeyboard(userId), mainMenuRich(userId, chatId, username));
    if (on) await sendDigest(chatId, userId, { preview: true });
    return answer(on ? '🔔 Digest on' : '🔕 Digest off');
  }

  if (data === 'status_refresh') {
    await refreshServerStatus(ownedBots(userId, chatId, username));
    const view = statusView(userId, chatId, username);
    await edit(view.legacy, view.keyboard, view.rich);
    return answer('🔃 Refreshed');
  }

  if (data === 'digest_toggle') {
    const on = toggleDigest(userId, chatId);
    const view = digestToggleView(on, userId);
    await edit(view.legacy, view.keyboard, view.rich);
    if (on) await sendDigest(chatId, userId, { preview: true });
    return answer(on ? '🔔 Digest on' : '🔕 Digest off');
  }

  if (data.startsWith('bi:')) {
    const [, kind, id] = data.split(':');
    const makeView = INFO_VIEWS.get(kind);
    if (!makeView) return answer();
    const info = getBot(id);
    if (!info) return answer('Bot not found');
    if (!currentUserOwns(info, userId, chatId, username)) return answer('This bot belongs to another user');
    claimLegacyOwnership(info, userId, username);
    const view = makeView(info);
    await edit(view.legacy, view.keyboard, view.rich);
    return answer();
  }

  if (data.startsWith('ai:')) {
    const [, action, id] = data.split(':');
    const info = getBot(id);
    if (!info) return answer('Bot not found');
    if (!currentUserOwns(info, userId, chatId, username)) return answer('This bot belongs to another user');
    claimLegacyOwnership(info, userId, username);
    if (action === 'tog') {
      if (!info.settings.aiChat && !canUseAi(userId)) return answer('⚠️ Add an API key first: /keys');
      info.settings.aiChat = !info.settings.aiChat;
      saveData();
    } else if (action === 'mode') {
      info.settings.aiMode = info.settings.aiMode === 'all' ? 'mention' : 'all';
      saveData();
    } else if (action === 'clear') {
      info.settings.aiPersona = '';
      saveData();
    } else if (action === 'persona') {
      chatStates.set(chatId, { action: 'awaiting_value', botId: info.id, field: 'persona', userId });
      await edit(
        `✏️ <b>${esc(info.name)} — persona</b>\nSend the style note (max ${CFG.AI_PERSONA_MAX} chars), or <code>reset</code>.`,
        new InlineKeyboard().text('❌ Cancel', `ai:show:${info.id}`),
        `<h3>✏️ ${esc(info.name)} — persona</h3><p>Send the style note (max ${CFG.AI_PERSONA_MAX} chars), or <code>reset</code>.</p>` +
        `<blockquote>e.g. <i>friendly pirate who loves mining</i></blockquote>`,
      );
      return answer('✏️ Type it in chat');
    } else if (action !== 'show') {
      return answer();
    }
    if (action === 'show') chatStates.delete(chatId);
    const view = aiPanelView(info, ctx.chat?.type === 'private');
    await edit(view.legacy, view.keyboard, view.rich);
    return answer();
  }

  if (data === 'main_menu' || data === 'refresh_menu') {
    chatStates.delete(chatId);
    await edit(mainMenuText(userId, chatId, username), mainMenuKeyboard(userId), mainMenuRich(userId, chatId, username));
    return answer();
  }

  if (data === 'help') {
    await edit(
      helpText(),
      new InlineKeyboard().text('📡 Forward', 'fw:home').row()
        .text('⬅️ Main Menu', 'main_menu'),
      helpRich(),
    );
    return answer();
  }

  if (data === 'list_bots') {
    chatStates.delete(chatId);
    await edit(botListText(userId, chatId, username), botListKeyboard(userId, chatId, username), botListRich(userId, chatId, username));
    return answer();
  }

  if (data === 'add_bot') {
    const limit = botLimitCheck(userId, chatId, username);
    if (limit) {
      chatStates.delete(chatId);
      await edit(`🚧 <b>Bot limit reached</b>\n\n${esc(botLimitText(limit))}`,
        new InlineKeyboard().text('📋 My Bots', 'list_bots').text('⬅️ Main Menu', 'main_menu'));
      return answer('🚧 Bot limit reached');
    }
    chatStates.set(chatId, { action: 'awaiting_bot_info' });
    await edit(
      `🔌 <b>Add a Bot</b>\n\n` +
      `Send connection details in chat:\n` +
      `<code>name  ip  port  [version]</code>\n` +
      `or <code>name  ip:port  [version]</code>\n\n` +
      `<b>Example:</b>\n` +
      `<code>Steve mc.example.com 25565 1.20.4</code>\n\n` +
      `Version defaults to <code>${CFG.DEFAULT_VERSION}</code>`,
      new InlineKeyboard().text('❌ Cancel', 'main_menu'),
    );
    return answer('✏️ Type the bot details in chat!');
  }

  if (data === 'settings_all') {
    chatStates.delete(chatId);
    const owned = ownedBots(userId, chatId, username);
    if (!owned.length) return answer('No bots');
    for (const info of owned) claimLegacyOwnership(info, userId, username);
    await edit(settingsAllText(owned), settingsAllKeyboard(owned), settingsAllRich(owned));
    return answer();
  }

  if (data.startsWith('toggleall:')) {
    const key = data.slice('toggleall:'.length);
    if (!SETTINGS_FIELDS.some(([field]) => field === key)) return answer();
    const owned = ownedBots(userId, chatId, username);
    if (!owned.length) return answer('No bots');
    for (const info of owned) claimLegacyOwnership(info, userId, username);
    const enable = !owned.every(info => info.settings[key]);
    if (key === 'aiChat' && enable && !canUseAi(userId)) return answer('⚠️ Add an API key first: /keys');
    for (const info of owned) info.settings[key] = enable;
    saveData();
    await edit(settingsAllText(owned), settingsAllKeyboard(owned), settingsAllRich(owned));
    return answer(enable ? '✅ Enabled for all bots' : '⬜ Disabled for all bots');
  }

  if (data.startsWith('setvalue:')) {
    const [, id, field] = data.split(':');
    if (!['proximity', 'schedule', 'stuck', 'view'].includes(field)) return answer();
    const info = getBot(id);
    if (!info) return answer('Bot not found');
    if (!currentUserOwns(info, userId, chatId, username)) return answer('This bot belongs to another user');
    claimLegacyOwnership(info, userId, username);
    chatStates.set(chatId, { action: 'awaiting_value', botId: info.id, field, userId });
    const prompt = field === 'proximity'
      ? `👀 <b>${esc(info.name)} — Proximity alert</b>\n\n` +
        `Send the radius in blocks (1–256), or <code>off</code>.\n` +
        `Current: ${info.settings.proximityRadius ? `${info.settings.proximityRadius}m` : 'off'}`
      : field === 'view'
        ? `🌍 <b>${esc(info.name)} — View distance</b>\n\n` +
          `Chunks this bot asks the server for (2–32). Memory per bot grows with the square of it, so keep it small and raise it only for a server that needs it (long walks). ` +
          `Send a number, or <code>off</code> to follow the manager default (${VIEW_DISTANCE === null ? 'mineflayer default' : `${VIEW_DISTANCE} chunks`}). Applies from the next reconnect.\n` +
          `Current: ${info.settings.viewDistance ? `${info.settings.viewDistance} chunks` : 'default'}`
      : field === 'stuck'
        ? `🧊 <b>${esc(info.name)} — Stuck alert</b>\n\n` +
          `Alert when the bot has not moved <i>and</i> the server has been silent (no chat, joins or leaves) for this many minutes. ` +
          `Send ${CFG.STUCK_MIN}–${CFG.STUCK_MAX}, or <code>off</code>.\n` +
          `⚠️ A bot you park on purpose in a quiet world will trigger it.\n` +
          `Current: ${info.settings.stuckMinutes ? `${info.settings.stuckMinutes} min` : 'off'}`
        : `🕐 <b>${esc(info.name)} — Schedule</b>\n\n` +
          `Send the connected hours as <code>start-end</code> (0–23, server time), e.g. <code>22-6</code>, or <code>off</code>.\n` +
          `Current: ${info.settings.schedule ? `${info.settings.schedule.start}-${info.settings.schedule.end}` : 'off'}`;
    await edit(prompt, new InlineKeyboard().text('❌ Cancel', `settings:${info.id}`));
    return answer('✏️ Type the value in chat');
  }

  if (data.startsWith('togglesetting:')) {
    const [, id, key] = data.split(':');
    if (!SETTINGS_FIELDS.some(([field]) => field === key)) return answer();
    const info = getBot(id);
    if (!info) return answer('Bot not found');
    if (key === 'aiChat' && !info.settings.aiChat && !canUseAi(userId)) return answer('⚠️ Add an API key first: /keys');
    if (!currentUserOwns(info, userId, chatId, username)) return answer('This bot belongs to another user');
    claimLegacyOwnership(info, userId, username);
    info.settings[key] = !info.settings[key];
    saveData();
    await edit(settingsText(info), settingsKeyboard(info), settingsRich(info));
    return answer(`${info.settings[key] ? '✅ Enabled' : '⬜ Disabled'}`);
  }

  const [action, id] = data.split(':', 2);
  if (!['manage', 'reconnect', 'restart', 'disconnect', 'confirm_remove', 'do_remove', 'settings'].includes(action)) {
    return answer();
  }

  const info = getBot(id);
  if (!info) return answer('Bot not found');
  if (!currentUserOwns(info, userId, chatId, username)) {
    return answer('This bot belongs to another user');
  }

  claimLegacyOwnership(info, userId, username);

  if (action === 'manage') {
    chatStates.delete(chatId);
    await edit(botManageText(info), botManageKeyboard(info.id), botManageRich(info));
    return answer();
  }

  if (action === 'settings') {
    chatStates.delete(chatId);
    await edit(settingsText(info), settingsKeyboard(info), settingsRich(info));
    return answer();
  }

  if (action === 'reconnect') {
    if (info.status === 'online' || info.status === 'connecting') {
      return answer(`Already ${info.status}`);
    }
    info.autoReconnect = true;
    info.reconnectAttempts = 0;
    spawnBot(info);
    await new Promise(resolve => setTimeout(resolve, 400));
    await edit(botManageText(getBot(info.id)), botManageKeyboard(info.id), botManageRich(getBot(info.id)));
    return answer('🟡 Reconnecting…');
  }

  if (action === 'restart') {
    info.autoReconnect = true;
    info.reconnectAttempts = 0;
    spawnBot(info);
    await new Promise(resolve => setTimeout(resolve, 400));
    await edit(botManageText(getBot(info.id)), botManageKeyboard(info.id), botManageRich(getBot(info.id)));
    return answer('🔄 Restarting…');
  }

  if (action === 'disconnect') {
    info.autoReconnect = false;
    info.resumePending = false;
    info.userStopped = true; // the schedule loop leaves it alone until the next window (or a Reconnect)
    destroyBot(info);
    info.status = 'offline';
    info.connectedAt = null;
    info.error = 'Disconnected by user';
    saveData();
    await edit(botManageText(info), botManageKeyboard(info.id), botManageRich(info));
    return answer('🔴 Disconnected');
  }

  if (action === 'confirm_remove') {
    await edit(
      `⚠️ Remove <b>${esc(info.name)}</b>?\nThis will disconnect it from the server.`,
      styleKeyboard(new InlineKeyboard()
        .text('✅ Yes, remove', `do_remove:${info.id}`)
        .text('❌ Cancel', `manage:${info.id}`)),
    );
    return answer();
  }

  info.autoReconnect = false;
  destroyBot(info);
  stopAutos(info);
  mcBots.delete(info.id);
  saveData();
  await edit(botListText(userId, chatId, username), botListKeyboard(userId, chatId, username), botListRich(userId, chatId, username));
  return answer(`✅ ${info.name} removed`);
});

bot.on('message:text', async ctx => {
  const text = ctx.message.text.trim();
  const chatId = ctx.chat.id;

  const state = chatStates.get(chatId);
  if (!state) return relayTwoWay(ctx, text);

  if (state.action === 'key_wizard') {
    if (state.userId !== ctx.from?.id || !isPrivateChat(ctx)) return;
    if (state.expires < Date.now()) {
      chatStates.delete(chatId);
      return ctx.reply('⌛ That took too long. Send /keys to start again.');
    }
    return handleKeyWizardText(ctx, state, text);
  }

  if (state.action === 'fwd_pick' || state.action === 'fwd_id') return handleFwdText(ctx, state, text);
  if (state.action === 'watch_add') return handleWatchText(ctx, state, text);

  if (state.action === 'awaiting_value') {
    if (state.userId !== ctx.from?.id) return;
    chatStates.delete(chatId);
    const info = getBot(state.botId);
    if (!info || !currentUserOwns(info, ctx.from.id, chatId, ctx.from.username)) {
      return ctx.reply('❌ Bot not found.');
    }
    if (state.field === 'persona') {
      const reset = text.toLowerCase() === 'reset';
      if (!reset && text.length > CFG.AI_PERSONA_MAX) {
        return ctx.reply(`❌ Persona is limited to ${CFG.AI_PERSONA_MAX} characters.`, {
          reply_markup: new InlineKeyboard().text('✏️ Try Again', `ai:persona:${info.id}`).text('⬅️ AI chat', `ai:show:${info.id}`),
        });
      }
      info.settings.aiPersona = reset ? '' : text;
      saveData();
      const panel = aiPanelView(info, isPrivateChat(ctx));
      return rSend(chatId, panel.rich, panel.legacy, panel.keyboard);
    }
    const retry = new InlineKeyboard()
      .text('✏️ Try Again', `setvalue:${info.id}:${state.field}`)
      .text('⬅️ Settings', `settings:${info.id}`);
    if (state.field === 'proximity') {
      const parsed = parseProximityInput(text);
      if (!parsed.ok) {
        return ctx.reply('❌ Radius must be a number between 1 and 256 (or <code>off</code>).',
          { parse_mode: 'HTML', reply_markup: retry });
      }
      info.settings.proximityRadius = parsed.value;
      if (parsed.value) info.nearbyPlayers = new Set();
      const wanted = viewDistanceFor(info);
      if (info.status === 'online' && wanted && info.viewDistance != null && info.viewDistance < wanted) {
        await ctx.reply(`ℹ️ ${info.name} joined seeing ${info.viewDistance} chunks; ${parsed.value} m needs ${wanted}. The alert is fully reliable after its next reconnect.`);
      }
    } else if (state.field === 'view') {
      const parsed = parseViewInput(text);
      if (!parsed.ok) {
        return ctx.reply('❌ Send a whole number of chunks from 2 to 32 (or <code>off</code>).',
          { parse_mode: 'HTML', reply_markup: retry });
      }
      info.settings.viewDistance = parsed.value;
      const wanted = viewDistanceFor(info);
      if (info.status === 'online' && wanted !== info.viewDistance) {
        await ctx.reply(`ℹ️ ${info.name} joined with ${info.viewDistance ?? 'the default'} chunks; the new value (${wanted ?? 'default'}) applies from its next reconnect.`);
      }
    } else if (state.field === 'schedule') {
      const parsed = parseScheduleInput(text);
      if (!parsed.ok) {
        return ctx.reply('❌ Use <code>start-end</code> with hours 0–23 (e.g. <code>22-6</code>) or <code>off</code>.',
          { parse_mode: 'HTML', reply_markup: retry });
      }
      info.settings.schedule = parsed.value;
    } else if (state.field === 'stuck') {
      const parsed = parseStuckInput(text);
      if (!parsed.ok) {
        return ctx.reply(`❌ Send a number of minutes (${CFG.STUCK_MIN}–${CFG.STUCK_MAX}) or <code>off</code>.`,
          { parse_mode: 'HTML', reply_markup: retry });
      }
      info.settings.stuckMinutes = parsed.value;
      if (info.stuck) info.stuck.alerted = false;
    } else {
      return;
    }
    saveData();
    return rSend(chatId, settingsRich(info), settingsText(info), settingsKeyboard(info));
  }

  if (state.action !== 'awaiting_bot_info') return;
  chatStates.delete(chatId);

  const parts = text.split(/\s+/).filter(Boolean);
  const name = parts[0] || '';
  const rawHost = parts[1] || '';
  let host;
  let port;
  let version;

  if (rawHost.includes(':')) {
    const index = rawHost.lastIndexOf(':');
    host = normalizeHost(rawHost.slice(0, index));
    port = Number.parseInt(rawHost.slice(index + 1), 10);
    version = parts[2] || CFG.DEFAULT_VERSION;
  } else {
    host = normalizeHost(rawHost);
    port = Number.parseInt(parts[2] || '', 10);
    version = parts[3] || CFG.DEFAULT_VERSION;
  }

  const backKeyboard = new InlineKeyboard()
    .text('➕ Try Again', 'add_bot').text('⬅️ Main Menu', 'main_menu');

  if (!name || !host || !port) {
    return ctx.reply(
      `❌ Missing info.\n<code>name  ip  port  [version]</code>`,
      { parse_mode: 'HTML', reply_markup: backKeyboard },
    );
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return ctx.reply('❌ Invalid port (1–65535).', {
      parse_mode: 'HTML',
      reply_markup: backKeyboard,
    });
  }
  if (!/^[a-zA-Z0-9_]{1,16}$/.test(name)) {
    return ctx.reply('❌ Invalid username — letters, numbers, underscores, max 16.', {
      parse_mode: 'HTML',
      reply_markup: backKeyboard,
    });
  }

  const hostCheck = await checkHostAllowed(host);
  if (!hostCheck.ok) {
    return ctx.reply(hostCheck.reason === 'private'
      ? '❌ That address is private (this machine, a local network or a link-local address). The owner can allow such servers with MC_ALLOW_PRIVATE_HOSTS=1.'
      : '❌ Invalid server address — use a host name or IPv4 address (letters, numbers, dots, dashes).', {
      parse_mode: 'HTML',
      reply_markup: backKeyboard,
    });
  }

  const id = botIdFor(name, host, port);
  const existing = getBot(id);
  if (existing && !currentUserOwns(existing, ctx.from.id, chatId, ctx.from.username)) {
    return ctx.reply('⚠️ A bot with that name is already registered on that server by another user.\nPick a different Minecraft name.', {
      parse_mode: 'HTML',
      reply_markup: new InlineKeyboard().text('➕ Try Again', 'add_bot').text('⬅️ Main Menu', 'main_menu'),
    });
  }
  const limit = botLimitCheck(ctx.from.id, chatId, ctx.from.username, existing);
  if (limit) {
    return ctx.reply(`🚧 <b>Bot limit reached</b>\n${esc(botLimitText(limit))}`, {
      parse_mode: 'HTML',
      reply_markup: new InlineKeyboard().text('📋 My Bots', 'list_bots').text('⬅️ Main Menu', 'main_menu'),
    });
  }
  if (existing && (existing.status === 'online' || existing.status === 'connecting')) {
    return ctx.reply(`⚠️ <b>${esc(name)}</b> is already ${existing.status}.`, {
      parse_mode: 'HTML',
      reply_markup: new InlineKeyboard()
        .text('📋 List Bots', 'list_bots').text('⬅️ Main Menu', 'main_menu'),
    });
  }

  const info = {
    id,
    name,
    host,
    port,
    version,
    chatId,
    userId: ctx.from.id,
    ownerUsername: ctx.from.username || null,
    createdAt: existing?.createdAt || new Date().toISOString(),
    mcBot: null,
    status: 'connecting',
    connectedAt: null,
    error: null,
    autoReconnect: true,
    reconnectAttempts: 0,
    reconnectTimer: null,
    autos: new Map(),
    settings: normalizeSettings(existing?.settings),
    autoReplies: existing?.autoReplies || [],
    deathHistory: existing?.deathHistory || [],
    sessionStats: { distance: 0, respawns: 0 },
    hourStats: { deaths: 0, drops: 0 },
    lastHealth: 20,
    nearbyPlayers: new Set(),
    tickTimer: null,
  };
  const carriedAutos = [...(existing?.autos?.values() || [])];
  if (existing) stopAutos(existing);
  mcBots.set(id, info);
  restoreAutos(info, carriedAutos);

  const message = await ctx.reply(
    `🟡 Connecting <b>${esc(name)}</b> to ` +
    `<code>${esc(host)}:${port}</code> [<code>${esc(version)}</code>]…`,
    { parse_mode: 'HTML' },
  );

  spawnBot(info);
  saveData();

  setTimeout(async () => {
    const latest = getBot(id);
    if (!latest) return;
    const keyboard = new InlineKeyboard()
      .text(`${dot(latest.status)} ${latest.name}`, `manage:${latest.id}`).row()
      .text('📋 List Bots', 'list_bots').text('⬅️ Main Menu', 'main_menu');
    await rEdit(
      chatId,
      message.message_id,
      botManageRich(latest),
      botManageText(latest),
      keyboard,
    ).catch(() => {});
  }, 3000);
});

bot.catch(error => console.error('Update error:', error.error?.message ?? error));
