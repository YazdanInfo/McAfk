'use strict';
// /ai panel and the /keys wizard.
const R = require('./registry');
const { InlineKeyboard } = require('grammy');
const crypto = require('crypto');
const { AI_MAX_PER_HOUR, AI_PROVIDERS, CFG, MAX_KEYS_PER_USER, bot, canUseAi, cfgFromRecord, chatStates,
  claimLegacyOwnership, cleanApiKeyInput, decryptKeyRecord, decryptSecret, encryptSecret, esc, keyAad,
  keyFingerprint, normUsername, ownedBots, parseBaseUrl, pickBotReply, rFooter, rSend, rTable, resolveAiConfig,
  resolveBotArg, saveData, serverAiConfig, styledText, userKeys, validModelName, verifyKeyConfig } = R;

// ---------------------------------------------------------------------------
// /ai — AI chat controls
// ---------------------------------------------------------------------------

const aiStatusText = info => {
  const state = info.aiState;
  const hourCount = state && Date.now() - state.hourStart <= 60 * 60 * 1000 ? state.hourCount : 0;
  const cfg = resolveAiConfig(info);
  let keyLine;
  if (!cfg) keyLine = '⚠️ No API key yet — add yours with /keys (in a private chat).';
  else if (cfg.error) keyLine = '⚠️ Your saved key can no longer be decrypted — re-add it with /keys.';
  else if (cfg.source === 'user') keyLine = `Key: your <b>${esc(cfg.label)}</b> · <code>${esc(cfg.model)}</code>`;
  else keyLine = `Key: shared server key · <code>${esc(cfg.model)}</code>`;
  return `🤖 <b>${esc(info.name)} — AI chat</b>\n\n` +
    `Status: ${info.settings.aiChat ? '✅ on' : '⬜ off'}\n` +
    `Mode: ${info.settings.aiMode === 'all' ? 'every message' : 'only when its name is mentioned'}\n` +
    `Persona: ${info.settings.aiPersona ? `<i>${esc(info.settings.aiPersona)}</i>` : '—'}\n` +
    `${keyLine}\n` +
    `Replies: ${state?.replies || 0} this session · ${hourCount}/${AI_MAX_PER_HOUR} requests this hour\n` +
    `\n<code>/ai [bot] on|off</code>\n<code>/ai [bot] mode mention|all</code>\n` +
    `<code>/ai [bot] persona text</code> · <code>/ai [bot] persona reset</code>`;
};

const aiPanelView = (info, isPrivate) => {
  const state = info.aiState;
  const hourCount = state && Date.now() - state.hourStart <= 60 * 60 * 1000 ? state.hourCount : 0;
  const cfg = resolveAiConfig(info);
  let key;
  if (!cfg) key = '⚠️ No API key yet — add one with /keys';
  else if (cfg.error) key = '⚠️ Saved key can no longer be decrypted — re-add it with /keys';
  else if (cfg.source === 'user') key = `${esc(cfg.label)} · <code>${esc(cfg.model)}</code>`;
  else key = `Shared server key · <code>${esc(cfg.model)}</code>`;
  const on = Boolean(info.settings.aiChat);
  const rich = `<h3>🤖 ${esc(info.name)} — AI chat</h3>` +
    rTable(['Setting', 'Value'], [
      ['Status', on ? '✅ <b>On</b>' : '⬜ Off'],
      ['Mode', info.settings.aiMode === 'all' ? 'Every message' : 'Only when its name is said'],
      ['Persona', info.settings.aiPersona ? `<i>${esc(info.settings.aiPersona)}</i>` : '—'],
      ['Key', key],
      ['Usage', `${state?.replies || 0} replies this session · ${hourCount}/${AI_MAX_PER_HOUR} requests this hour`],
    ]) + rFooter('AI');
  const keyboard = new InlineKeyboard();
  styledText(keyboard, on ? '✅ AI chat: on' : '⬜ AI chat: off', `ai:tog:${info.id}`, on ? 'success' : undefined).row();
  keyboard.text(`🎯 Mode: ${info.settings.aiMode === 'all' ? 'every message' : 'mention'}`, `ai:mode:${info.id}`).row();
  keyboard.text('✏️ Persona', `ai:persona:${info.id}`);
  if (info.settings.aiPersona) keyboard.text('🧹 Clear', `ai:clear:${info.id}`);
  keyboard.row();
  if (isPrivate) keyboard.text('🔑 My API keys', 'k:menu').row();
  keyboard.text('⬅️ Back', `manage:${info.id}`);
  return { rich, legacy: aiStatusText(info), keyboard };
};

const sendAiPanel = (ctx, info) => {
  const view = aiPanelView(info, isPrivateChat(ctx));
  return rSend(ctx.chat.id, view.rich, view.legacy, view.keyboard);
};

bot.command('ai', async ctx => {
  const sender = normUsername(ctx.from?.username);
  const owned = ownedBots(ctx.from?.id, ctx.chat.id, sender);
  const args = ctx.message.text.trim().split(/\s+/).slice(1);
  const { target, rest } = resolveBotArg(owned, args);
  if (!target) return pickBotReply(ctx, owned, 'ai:show', '🤖 AI chat');
  const sub = (rest[0] || '').toLowerCase();
  claimLegacyOwnership(target, ctx.from.id, ctx.from.username);

  if (!sub) return sendAiPanel(ctx, target);

  if (sub === 'on' || sub === 'off') {
    if (sub === 'on' && !canUseAi(ctx.from.id)) {
      return ctx.reply('⚠️ You have no API key yet. Open a private chat with me and send /keys to add one.');
    }
    target.settings.aiChat = sub === 'on';
    saveData();
    return sendAiPanel(ctx, target);
  }

  if (sub === 'mode') {
    const mode = (rest[1] || '').toLowerCase();
    if (mode !== 'mention' && mode !== 'all') {
      return ctx.reply('⚠️ Usage: <code>/ai [bot] mode mention</code> or <code>/ai [bot] mode all</code>', { parse_mode: 'HTML' });
    }
    target.settings.aiMode = mode;
    saveData();
    return sendAiPanel(ctx, target);
  }

  if (sub === 'persona') {
    const text = rest.slice(1).join(' ').trim();
    if (!text) {
      return ctx.reply('⚠️ Usage: <code>/ai [bot] persona friendly pirate who loves mining</code> or <code>/ai [bot] persona reset</code>',
        { parse_mode: 'HTML' });
    }
    if (text.length > CFG.AI_PERSONA_MAX && text.toLowerCase() !== 'reset') {
      return ctx.reply(`❌ Persona is limited to ${CFG.AI_PERSONA_MAX} characters.`, { parse_mode: 'HTML' });
    }
    target.settings.aiPersona = text.toLowerCase() === 'reset' ? '' : text;
    saveData();
    return sendAiPanel(ctx, target);
  }

  return sendAiPanel(ctx, target);
});

// ---------------------------------------------------------------------------
// /keys — personal API key wizard (private chat only)
// ---------------------------------------------------------------------------

const KEY_WIZARD_TTL_MS = 10 * 60 * 1000;
const isPrivateChat = ctx => ctx.chat?.type === 'private';
const newKeyId = () => crypto.randomBytes(4).toString('hex');
const cancelKeyboard = () => new InlineKeyboard().text('❌ Cancel', 'k:menu');

const setWizard = (chatId, userId, patch) => {
  const previous = chatStates.get(chatId);
  const base = previous?.action === 'key_wizard' && previous.userId === userId ? previous : {};
  const next = { ...base, action: 'key_wizard', userId, expires: Date.now() + KEY_WIZARD_TTL_MS, ...patch };
  chatStates.set(chatId, next);
  return next;
};

const getWizard = (chatId, userId) => {
  const state = chatStates.get(chatId);
  if (!state || state.action !== 'key_wizard' || state.userId !== userId) return null;
  if (state.expires < Date.now()) {
    chatStates.delete(chatId);
    return null;
  }
  return state;
};

const keyCount = userId => userKeys.get(String(userId))?.keys.length || 0;

const keysMenuView = userId => {
  const store = userKeys.get(String(userId));
  const keys = store?.keys || [];
  const lines = keys.map((key, index) =>
    `${store.active === key.id ? '✅' : '⬜'} <b>${index + 1}.</b> ${esc(key.label)} — <code>…${esc(key.last4)}</code> · <code>${esc(key.model)}</code>`);
  let text = `🔑 <b>Your AI API keys</b>\n\n${lines.length ? lines.join('\n') : 'You have no keys yet.'}\n\n` +
    `The active key (✅) is used by the AI chat of all your bots. Keys are stored encrypted on the server.`;
  if (!keys.length && serverAiConfig) text += `\n\nUntil you add one, the server's shared key is used.`;
  const keyboard = new InlineKeyboard();
  keys.forEach((key, index) => {
    if (store.active !== key.id) keyboard.text(`🔀 Use ${index + 1}`, `k:use:${key.id}`);
    keyboard.text(`🧪 Test ${index + 1}`, `k:test:${key.id}`).text(`🗑 ${index + 1}`, `k:del:${key.id}`).row();
  });
  if (keys.length < MAX_KEYS_PER_USER) keyboard.text('➕ Add key', 'k:add').row();
  keyboard.text('⬅️ Main Menu', 'main_menu');
  return { text, keyboard };
};

const providerKeyboard = () => {
  const keyboard = new InlineKeyboard();
  Object.keys(AI_PROVIDERS).forEach((id, index) => {
    keyboard.text(AI_PROVIDERS[id].name, `k:p:${id}`);
    if (index % 2) keyboard.row();
  });
  return keyboard.row().text('❌ Cancel', 'k:menu');
};

const keyPromptText = providerId =>
  `🔑 <b>${esc(AI_PROVIDERS[providerId].name)}</b>\n\nSend your API key as your <b>next message</b>.\n\n` +
  `🔒 I delete your message right away and keep the key encrypted. Never paste it in a group.`;

const modelPromptText = providerId =>
  `✏️ Send the model name` +
  (AI_PROVIDERS[providerId].modelHint ? `, for example <code>${esc(AI_PROVIDERS[providerId].modelHint)}</code>` : '') + '.';

const saveKeyRecord = (userId, pending) => {
  const uid = String(userId);
  let store = userKeys.get(uid);
  if (!store) {
    store = { active: null, keys: [] };
    userKeys.set(uid, store);
  }
  store.keys.push({
    id: pending.id,
    provider: pending.provider,
    label: pending.label,
    baseUrl: pending.baseUrl || null,
    model: pending.model,
    last4: pending.last4,
    fp: pending.fp,
    addedAt: Date.now(),
    enc: pending.enc,
  });
  store.active = pending.id;
  saveData();
};

// Verifies the (still encrypted) pending key with a tiny request, then saves it.
const finishKeyWizard = async (ctx, userId, chatId, state) => {
  const pending = state.pending;
  await ctx.reply('🧪 Checking the key with a tiny test request…').catch(() => {});
  let result;
  try {
    const plain = decryptSecret(pending.enc, keyAad(userId, pending.id, pending.provider));
    result = await verifyKeyConfig(cfgFromRecord(userId, pending, plain));
  } catch (_) {
    result = { ok: false, reason: 'internal error while decrypting the pending key' };
  }
  if (result.ok) {
    saveKeyRecord(userId, pending);
    chatStates.delete(chatId);
    const view = keysMenuView(userId);
    return ctx.reply(`✅ Key verified and saved — it is now your active key.\n\n${view.text}`, { parse_mode: 'HTML', reply_markup: view.keyboard });
  }
  setWizard(chatId, userId, { step: 'confirm' });
  return ctx.reply(`❌ The check failed: ${esc(result.reason)}.\n\nYou can save the key anyway or start over.`, {
    parse_mode: 'HTML',
    reply_markup: new InlineKeyboard()
      .text('💾 Save anyway', 'k:save').text('🔁 Start over', 'k:add').row()
      .text('❌ Cancel', 'k:menu'),
  });
};

const handleKeyWizardText = async (ctx, state, text) => {
  const userId = ctx.from.id;
  const chatId = ctx.chat.id;

  if (state.step === 'url') {
    const parsed = parseBaseUrl(text);
    if (parsed.error) {
      return ctx.reply(`❌ ${esc(parsed.error)} Send the base URL again.`, { parse_mode: 'HTML', reply_markup: cancelKeyboard() });
    }
    setWizard(chatId, userId, { step: 'key', baseUrl: parsed.url });
    return ctx.reply(keyPromptText(state.provider), { parse_mode: 'HTML', reply_markup: cancelKeyboard() });
  }

  if (state.step === 'key') {
    // Remove the message holding the secret first, whatever it contains.
    const deleted = await bot.api.deleteMessage(chatId, ctx.message.message_id).then(() => true, () => false);
    const cleaned = cleanApiKeyInput(text);
    if (!cleaned) {
      return ctx.reply('❌ That does not look like an API key (16–400 visible characters, no spaces). Send it again, or cancel.',
        { reply_markup: cancelKeyboard() });
    }
    let pending;
    try {
      const fp = keyFingerprint(cleaned);
      const existing = userKeys.get(String(userId))?.keys.find(key => key.fp === fp);
      if (existing) {
        userKeys.get(String(userId)).active = existing.id;
        saveData();
        chatStates.delete(chatId);
        const view = keysMenuView(userId);
        return ctx.reply(`ℹ️ That key is already saved — I made it your active key.\n\n${view.text}`, { parse_mode: 'HTML', reply_markup: view.keyboard });
      }
      const id = newKeyId();
      const last4 = cleaned.slice(-4);
      pending = {
        id, fp, last4,
        provider: state.provider,
        baseUrl: state.baseUrl,
        label: `${AI_PROVIDERS[state.provider].name} …${last4}`,
        enc: encryptSecret(cleaned, keyAad(userId, id, state.provider)),
        model: null,
      };
    } catch (error) {
      console.error('key store:', error.message);
      chatStates.delete(chatId);
      return ctx.reply('❌ The server could not initialise key encryption. Tell the bot admin to check the logs.');
    }
    const note = deleted ? '🔒 I deleted your message.' : '⚠️ I could not delete your message — please delete it yourself now.';
    const provider = AI_PROVIDERS[state.provider];
    if (provider.defaultModel) {
      setWizard(chatId, userId, { step: 'model', pending });
      return ctx.reply(`✅ Key …${esc(last4Of(pending))} received and encrypted. ${note}\n\nWhich model should answer?`, {
        parse_mode: 'HTML',
        reply_markup: new InlineKeyboard()
          .text(`✅ ${provider.defaultModel}`, 'k:m:default').row()
          .text('✏️ Another model', 'k:m:custom').row()
          .text('❌ Cancel', 'k:menu'),
      });
    }
    setWizard(chatId, userId, { step: 'model_text', pending });
    return ctx.reply(`✅ Key …${esc(last4Of(pending))} received and encrypted. ${note}\n\n${modelPromptText(state.provider)}`,
      { parse_mode: 'HTML', reply_markup: cancelKeyboard() });
  }

  if (state.step === 'model_text') {
    if (!validModelName(text)) {
      return ctx.reply('❌ Model names may only contain letters, digits and . _ : / @ + - (max 100). Send it again.',
        { reply_markup: cancelKeyboard() });
    }
    state.pending.model = text.trim();
    const next = setWizard(chatId, userId, { step: 'checking' });
    return finishKeyWizard(ctx, userId, chatId, next);
  }

  return ctx.reply('Please use the buttons above, or /keys to start over.');
};

const last4Of = pending => pending.last4;

const handleKeyCallback = async (ctx, data, edit) => {
  const userId = ctx.from.id;
  const chatId = ctx.chat.id;
  const toast = (text = '', alert = false) => ctx.answerCallbackQuery({ text, show_alert: alert }).catch(() => {});
  if (!isPrivateChat(ctx)) return toast('🔒 Manage API keys in a private chat with me.', true);

  const [, action, arg] = data.split(':');
  const showMenu = async (prefix = '') => {
    chatStates.delete(chatId);
    const view = keysMenuView(userId);
    await edit(`${prefix}${view.text}`, view.keyboard);
  };

  if (action === 'menu') {
    await showMenu();
    return toast();
  }

  if (action === 'add') {
    if (keyCount(userId) >= MAX_KEYS_PER_USER) return toast(`You can store up to ${MAX_KEYS_PER_USER} keys. Delete one first.`, true);
    chatStates.delete(chatId);
    await edit('🔑 <b>Add an API key</b>\n\nWhich provider is the key for?', providerKeyboard());
    return toast();
  }

  if (action === 'p') {
    const provider = AI_PROVIDERS[arg];
    if (!provider) return toast();
    if (keyCount(userId) >= MAX_KEYS_PER_USER) return toast(`You can store up to ${MAX_KEYS_PER_USER} keys. Delete one first.`, true);
    if (!provider.base) {
      setWizard(chatId, userId, { step: 'url', provider: arg, pending: null, baseUrl: null });
      await edit('🔗 <b>Custom provider</b>\n\nSend the base URL of the OpenAI-compatible API, for example <code>https://example.com/v1</code>.', cancelKeyboard());
    } else {
      setWizard(chatId, userId, { step: 'key', provider: arg, pending: null, baseUrl: provider.base });
      await edit(keyPromptText(arg), cancelKeyboard());
    }
    return toast();
  }

  if (action === 'm' || action === 'save') {
    const state = getWizard(chatId, userId);
    if (action === 'm') {
      if (!state || state.step !== 'model' || !state.pending) return toast('This step expired — send /keys to start again.', true);
      if (arg === 'custom') {
        setWizard(chatId, userId, { step: 'model_text' });
        await edit(modelPromptText(state.provider), cancelKeyboard());
        return toast();
      }
      state.pending.model = AI_PROVIDERS[state.provider].defaultModel;
      await toast('Checking…');
      const next = setWizard(chatId, userId, { step: 'checking' });
      return finishKeyWizard(ctx, userId, chatId, next);
    }
    if (!state || state.step !== 'confirm' || !state.pending?.model) return toast('This step expired — send /keys to start again.', true);
    saveKeyRecord(userId, state.pending);
    await showMenu('💾 Saved (not verified) and set as active.\n\n');
    return toast('Saved');
  }

  const store = userKeys.get(String(userId));
  const record = store?.keys.find(key => key.id === arg);
  if (!record) {
    await showMenu();
    return toast('That key no longer exists.');
  }

  if (action === 'use') {
    store.active = record.id;
    saveData();
    await showMenu();
    return toast(`✅ Now using ${record.label}`);
  }

  if (action === 'test') {
    let result;
    try {
      result = await verifyKeyConfig(cfgFromRecord(userId, record, decryptKeyRecord(userId, record)));
    } catch (_) {
      result = { ok: false, reason: 'the stored key could not be decrypted (server secret changed) — delete and re-add it' };
    }
    return toast(result.ok ? `✅ ${record.label} works.` : `❌ ${result.reason}`, true);
  }

  if (action === 'del') {
    await edit(`🗑 Delete <b>${esc(record.label)}</b> (<code>…${esc(record.last4)}</code>)?`,
      new InlineKeyboard().text('🗑 Yes, delete', `k:delok:${record.id}`).text('⬅️ Keep it', 'k:menu'));
    return toast();
  }

  if (action === 'delok') {
    store.keys = store.keys.filter(key => key.id !== record.id);
    if (store.active === record.id) store.active = store.keys[0]?.id || null;
    if (!store.keys.length) userKeys.delete(String(userId));
    saveData();
    await showMenu();
    return toast('Deleted');
  }

  return toast();
};

bot.command('keys', async ctx => {
  if (!isPrivateChat(ctx)) {
    return ctx.reply('🔒 API keys are private. Open a chat with me directly and send /keys there.');
  }
  chatStates.delete(ctx.chat.id);
  const view = keysMenuView(ctx.from.id);
  await ctx.reply(view.text, { parse_mode: 'HTML', reply_markup: view.keyboard });
});

Object.assign(R, { aiStatusText, aiPanelView, sendAiPanel, KEY_WIZARD_TTL_MS, isPrivateChat, newKeyId,
  cancelKeyboard, setWizard, getWizard, keyCount, keysMenuView, providerKeyboard, keyPromptText, modelPromptText,
  saveKeyRecord, finishKeyWizard, handleKeyWizardText, last4Of, handleKeyCallback });
