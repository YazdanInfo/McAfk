'use strict';
// McAfk — Telegram manager for fake offline Minecraft players.
// The code lives in src/, split by feature in load order (see src/registry.js for how the modules share names):
//   config → state → util → messaging → ai → persistence → menus → background → lifecycle → actions → settings
//   → ai-keys → reports → forward → watch-quiet → handlers → boot
// This file only loads them in that order and, under MCAFK_TEST=1, exports the internals for test/ (otherwise it starts the bot).

require('./src/config');
require('./src/state');
require('./src/util');
require('./src/messaging');
require('./src/ai');
require('./src/persistence');
require('./src/menus');
require('./src/background');
require('./src/lifecycle');
require('./src/actions');
require('./src/settings');
require('./src/ai-keys');
require('./src/reports');
require('./src/forward');
require('./src/watch-quiet');
require('./src/handlers');
require('./src/boot');
const R = require('./src/registry');
const { S } = R;
const { ALLOWED_USER_IDS, BOT_COMMANDS, CFG, DATA, HEALTH_FILE, IDLE_VIEW_DISTANCE, IS_TEST, RUN_MARKER,
  VIEW_DISTANCE, accessMode, alertOpts, announceRestart, applyQuietArgs, bootResumed, bootRunState, bot,
  botLimitCheck, botLimitLine, chatStates, classifyKick, clearRunMarker, digestSubs, handleThrottle, heartbeat, heartbeatLine,
  heartbeatTick, idleViewTick, inScheduleWindow, isQuietNow, isUserAllowed, joinKeyCache, joinQueues, joinResolver,
  loadData, announceLoad, loadLine, loadSample, localParts, makePausedBot, mcBots, notify, notifyRich, ownedBots, parseIdleViewDistance, parseTz,
  parseViewDistance, parseViewInput, persistNow, quietLine, quietPrefs, quietView, rSend, resumeBots,
  scheduleReconnect, scheduleTick, sendDigest, serverAiConfig, settingsText, spawnBot, startHeartbeat, statusView,
  stopAllBots, viewDistanceFor, wantsOnline, watchEvent, watchlists, checkHostAllowed, hostResolver, normalizeHost, privateAddress } = R;

if (IS_TEST) {
  // test/ drives these directly with stubbed grammy / mineflayer (see test/helpers.js); nothing is started or polled.
  module.exports = {
    CFG, bot, mcBots, watchlists, digestSubs, quietPrefs, joinQueues, heartbeat, DATA,
    makePausedBot, spawnBot, scheduleReconnect, classifyKick, handleThrottle, watchEvent, sendDigest,
    isQuietNow, alertOpts, parseTz, localParts, inScheduleWindow, applyQuietArgs, quietView, quietLine,
    statusView, persistNow, loadData, heartbeatTick, heartbeatLine, notify, notifyRich, rSend,
    viewDistanceFor, parseViewDistance, VIEW_DISTANCE, scheduleTick, joinResolver, joinKeyCache, bootRunState, announceRestart, clearRunMarker, RUN_MARKER, HEALTH_FILE,
    loadSample, loadLine, announceLoad, memLine: R.memLine, resumeBots, bootResumed, wantsOnline, isUserAllowed, botLimitCheck, botLimitLine, parseViewInput,
    idleViewTick, parseIdleViewDistance, IDLE_VIEW_DISTANCE, settingsText, ownedBots, stopAllBots, accessMode, chatStates, checkHostAllowed, hostResolver, normalizeHost, privateAddress,
    setLastTelegramOkAt: ms => { S.lastTelegramOkAt = ms; },
    setShuttingDown: value => { S.shuttingDown = Boolean(value); },
  };
} else {
  console.log('🚀 Minecraft Bot Manager starting…');
  console.log(accessMode() === 'restricted' ? `🔒 Access restricted to ${ALLOWED_USER_IDS.size} Telegram user(s)`
    : accessMode() === 'open' ? '⚠️ Open access (ALLOW_OPEN_ACCESS=1): anyone who finds this bot can add Minecraft bots. Set ALLOWED_USER_IDS to restrict it.'
      : '⛔ ALLOWED_USER_IDS is empty: the manager is CLOSED to everyone. Message the bot once (it shows your Telegram ID), put the ID in ALLOWED_USER_IDS and restart. ALLOW_OPEN_ACCESS=1 restores the old open behaviour.');
  console.log(`🚧 Limits: ${CFG.MAX_BOTS_PER_USER || 'no'} bot(s) per user, ${CFG.MAX_BOTS_TOTAL || 'no'} in total`);
  console.log(`🤖 AI chat: per-user encrypted keys enabled${serverAiConfig ? `; shared fallback key (${serverAiConfig.kind}, ${serverAiConfig.model})` : ''}`);
  const runState = bootRunState();
  if (runState.unclean) console.error('⚠️ The previous run did not stop cleanly (crash, kill or power loss).');
  loadData();
  const resuming = resumeBots(runState);
  if (runState.crashLoop) console.error(`⚠️ ${runState.uncleanStarts.length} unclean starts in ${Math.round(CFG.CRASH_LOOP_WINDOW_MS / 60000)} min: auto-resume is held, bots stay offline until you press Reconnect or the next clean start.`);
  if (resuming) console.log(`🔁 Resuming ${resuming} bot(s), one every ${CFG.RESUME_SPREAD_MS} ms; the join queue spaces the logins.`);
  bot.start({
    onStart: info => {
      console.log(`✅ Running as @${info.username}`);
      bot.api.setMyCommands(BOT_COMMANDS).catch(error => {
        console.error('[COMMANDS] setMyCommands failed:', error.description || error.message);
      });
      startHeartbeat();
      announceRestart(runState);
    },
  });
}
