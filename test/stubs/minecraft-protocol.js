'use strict';
// Status ping stand-in: replies instantly with a healthy server. Set `module.exports.reply` to change it.
const api = {
  reply: () => ({ players: { online: 1, max: 20 }, version: { name: '1.20.4' }, description: 'A Minecraft Server', latency: 12 }),
  ping: options => Promise.resolve(api.reply(options)),
};
module.exports = api;
