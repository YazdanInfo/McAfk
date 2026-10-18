'use strict';
// Minimal grammY stand-in: records every outgoing message in `bot.sent` and keeps command handlers in `bot.commands`.

class InlineKeyboard {
  constructor() { this.inline_keyboard = [[]]; }
  _push(button) { this.inline_keyboard[this.inline_keyboard.length - 1].push(button); return this; }
  text(text, callback_data) { return this._push({ text, callback_data }); }
  url(text, url) { return this._push({ text, url }); }
  add(button) { return this._push(button); }
  row() { this.inline_keyboard.push([]); return this; }
}

class Keyboard {
  constructor() { this.keyboard = [[]]; }
  requestChat() { return this; }
  row() { return this; }
}

class Bot {
  constructor(token) {
    this.token = token;
    this.sent = [];         // { chatId, via: 'rich' | 'legacy', text, opts }
    this.commands = new Map();
    this.handlers = [];
    this.middlewares = []; // bot.use(fn), in registration order
    const record = (chatId, via, text, opts) => {
      this.sent.push({ chatId, via, text, opts: opts || {} });
      return Promise.resolve({ message_id: this.sent.length, ok: true });
    };
    this.api = {
      config: { use() {} },
      sendMessage: (chatId, text, opts) => record(chatId, 'legacy', text, opts),
      editMessageText: () => Promise.resolve({}),
      setMyCommands: () => Promise.resolve(true),
      raw: {
        sendRichMessage: payload => {
          const { chat_id, rich_message, ...opts } = payload;
          return record(chat_id, 'rich', rich_message?.html || '', opts);
        },
        editMessageText: () => Promise.resolve({}),
      },
    };
  }
  use(fn) { this.middlewares.push(fn); }
  command(name, fn) { this.commands.set(name, fn); }
  on(filter, fn) { this.handlers.push([filter, fn]); }
  catch() {}
  start() { return Promise.resolve(); }
  stop() { return Promise.resolve(); }
}

module.exports = { Bot, InlineKeyboard, Keyboard };
