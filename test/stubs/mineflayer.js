'use strict';
// Minimal mineflayer stand-in. Tests drive it with emit(): spawn(), emit('kicked', reason), emit('death'), ...
const { EventEmitter } = require('events');

const created = [];

class FakeMc extends EventEmitter {
  constructor(options) {
    super();
    this.options = options;
    this.username = options.username;
    this._client = new EventEmitter();
    this.health = 20;
    this.food = 20;
    this.entity = null;
    this.entities = {};
    this.players = {};
    this.game = { gameMode: 'survival', dimension: 'minecraft:overworld' };
    this.inventory = { items: () => [], slots: [] };
    this.ended = false;
    this.settingsCalls = [];
    created.push(this);
  }
  // test helper: the bot is "in the world"
  spawn() {
    this.entity = { position: { x: 1, y: 64, z: 1, distanceTo: () => 99 } };
    this.emit('spawn');
  }
  quit() { this.ended = true; }
  end() { this.ended = true; }
  respawn() {}
  chat() {}
  look() {}
  setControlState() {}
  setSettings(options) { this.settingsCalls.push(options); }
}

module.exports = {
  createBot: options => new FakeMc(options),
  FakeMc,
  created,
};
