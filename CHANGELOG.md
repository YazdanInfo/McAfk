# Changelog

This file describes everything that differs from the original single-file McAfk (`index.js`, data format version 2, commands `/start /forward /unforward /forwards /echo /walk`). The step-by-step history of the work, in Persian, is in [`CHANGELOG-fa.md`](CHANGELOG-fa.md) (internal iterations v1 – v15.4).

## Things that behave differently (read before upgrading)

| Area | Original | Now |
|---|---|---|
| Node | ≥ 18 | **≥ 22** (`package.json` engines, Dockerfile, CI on 22 and 24) |
| Access | anyone who finds the bot can use it | **closed unless `ALLOWED_USER_IDS` is set**; a stranger only sees their own ID. `ALLOW_OPEN_ACCESS=1` restores open access (never overrides an allowlist) |
| Server address when adding a bot | anything | lower-cased, must be a valid host name or IPv4; **loopback, LAN, link-local, cloud-metadata, CGNAT, multicast and their IPv6 forms are refused** unless `MC_ALLOW_PRIVATE_HOSTS=1`. Checked when adding only; saved bots are not re-checked |
| Same name + host + port as another user's bot | replaced their record and **took the bot over** (id is derived from those three values) | refused; the other record is untouched |
| Bot limits | none | `MAX_BOTS_PER_USER` (5) and `MAX_BOTS_TOTAL` (20); `0` = unlimited; users already above keep their bots |
| After a restart | every bot stays paused until **Reconnect** | bots that were meant to be running reconnect by themselves (`AUTO_RESUME=0` = old behaviour). A file written by the original version records every bot as paused after a clean stop, so the first restart after upgrading still pauses them all |
| `/forward` | `/forward @you` in a group; `/unforward`, `/forwards` | `/forward` is a manager (private chat) / instant add (group). `/unforward` and `/forwards` only reply with a pointer. `/proximity`, `/schedule`, `/gamemode` were merged into `/settings` and `/where` the same way |
| View distance | mineflayer default (large) | **4 chunks** per bot (`MC_VIEW_DISTANCE`, per-bot override in `/settings`); raised automatically for a bot with a proximity alert |
| `userdata.json` | mode default, one copy | mode 0600, atomic write, up to 3 rotating backups, automatic restore of the newest valid backup if the file is corrupt |

## Data format

`userdata.json` moved from version 2 to **5**. Files from the original version load unchanged (bot ids are computed by the same function, forwards given as plain chat ids become active forwards) and are rewritten in the new format; this is covered by `test/upstream-migration.test.js`. New optional keys (`digests`, `watch`, `quiet`, `keySalt`, `apiKeys`, per-bot `settings`, `autoReplies`, `deathHistory`, `autos`, `paused`) default sensibly when absent. Back up `.keysecret` together with `userdata.json` once AI keys are used.

## New commands and features

- **`/settings [bot]`** (and `/settings all`): toggles for auto-eat, auto-respawn, health alerts, idle randomizer, auto-sleep, **lobby guard**, **AI chat**; buttons for **proximity alert** (radius), **view distance**, **schedule window** (e.g. `22-6`), **stuck alert** (minutes without movement and server activity).
- **`/auto`** — repeat a walk on a timer, fixed or random (`30-90`) delay; saved and resumed after a restart.
- **`/autoreply`** — keyword rules for in-game chat, `*` wildcards (plain string matching, never regex), per-rule cooldown, up to 20 rules per bot.
- **`/where`, `/deaths`, `/inventory`** — position/dimension/gamemode/health/food and session stats; last 10 deaths with cause, coordinates, dimension, respawn point and inventory at death; items and equipment.
- **`/digest`** — hourly summary (toggle), including a servers section with player counts and ping.
- **`/watch`** — player join/leave watchlist (up to 30 names), de-duplicated across bots on one server.
- **`/quiet`** — per-user quiet hours (`/quiet 23-7`, `/quiet tz Asia/Baku`): chatty alerts arrive silently; bans, deaths, stuck/gave-up, low health and nearby players always stay audible.
- **`/forward` manager** — destinations with on/off, chosen bots, test message, removal; wizard picks a group/channel from your own chat list; per-destination **filter** (everything / chat + deaths / chat only); **two-way** relay (your messages in the group are said in-game; text starting with `/` is never relayed); line batching (≤ 1 message per ~3.5 s per destination, `retry_after` honoured); destinations that kick the bot are paused automatically.
- **`/ai`, `/keys`** — optional LLM answers to in-game chat using the owner's own API key (Anthropic, OpenAI, OpenRouter, Groq, or any OpenAI-compatible URL). Keys are stored with AES-256-GCM (per-key IV, owner and key id as AAD, scrypt-derived master key from `KEY_ENCRYPTION_SECRET` or a generated `.keysecret`), only the last 4 characters are shown, the message containing the key is deleted. Replies are forced to one plain line that never starts with `/`, `!` or `.`; per-bot and per-player rate limits and an hourly cap.
- **`/status`** — uptime, memory (RSS, heap, RSS per online bot), CPU load and event-loop lag, bots, bot limits, forwards, servers, data file and backups, access mode, quiet hours, join queue, view distance, heartbeat.
- **`/help`**, a full Telegram command menu, and rich (table) messages using Bot API 10.3 with an automatic, permanent fallback to plain HTML when the API does not support them.

## Reliability

- **Dead-connection watchdog:** no packet for 45 s marks the bot offline and reconnects (the original could show "online" forever behind a silent socket). A single teardown path clears status, timers, listeners and socket.
- **Kick classification:** ban and "not whitelisted" are not retried (a notice with the fix is sent); "logged in from another location" retries every 2 min, "server is full" every minute, "Connection throttled" quietly after 5 s without using a reconnect attempt (normal backoff after 12 in a row). After the normal 10 attempts a bot keeps retrying every 5 min.
- **Join queue:** attempts to the same resolved IP:port are spaced `JOIN_GAP_MS` (5 s) apart, for the schedule loop, manual Reconnect, auto-reconnect and boot resume alike.
- **Server checks:** a status ping before joining skips a server whose MOTD says "Offline" (Aternos-style); after joining, an empty adventure-mode lobby is detected and treated as "server off".
- **Schedule loop fixes:** it no longer restarts a bot that is waiting out a backoff/lobby/kick/throttle timer, a manual Disconnect holds until the window ends, and closing the window also stops a bot that is waiting to retry.
- **Alerts:** one damage message per damage episode, edited in place; the death message follows ~0.4 s later so the cause is known.
- **Crash/restart handling:** a `.running` marker detects an unclean stop and sends each user one notice (at most one per 10 min); a crash-loop guard holds auto-resume after 3 unclean starts in 10 min (`RESUME_CRASH_LOOP_STARTS`); queued forwards are flushed (≤ 4 s) on SIGINT/SIGTERM; exit code 0 on a clean stop and 1 on a crash, so `Restart=on-failure` only restarts crashes.
- **Monitoring:** optional `HEARTBEAT_URL` ping while Telegram answers; `DATA_DIR/.health` for the Docker `HEALTHCHECK`; the manager measures its own CPU share and event-loop lag once a minute and, when one core stays saturated, logs it and sends each owner one Telegram message (silent in quiet hours, at most one per 30 min).

## Security

- Allowlist by default (above); host restrictions on new bots so an allowed user cannot probe the VPS or its network through error messages.
- Ownership-takeover bug fixed; setting keys in callback data are accepted only from a fixed list.
- AI custom URLs must be `https://` and may not point at private/loopback/link-local addresses (checked again at connect time, redirects not followed, response size capped); `AI_ALLOW_PRIVATE_URLS=1` allows e.g. a local Ollama.
- AI output can never make a bot run a command (leading `/`, `!` and `.` are stripped, one plain line only), and text from a Telegram group is never relayed in-game if it starts with `/`. Auto-reply rules are written by the bot's owner and are sent as written.

## Operations and tooling

- `index.js` is now a loader for 17 modules in `src/` that share one namespace (`src/registry.js`); behaviour is unchanged by the split. It is a first step, not a layered design.
- `deploy/mcafk.service` (systemd; memory limits and `LimitNOFILE` sized for a 16 GB host), `deploy/mcafk@.service` (template for several independent managers, each with its own bot token), `Dockerfile`, `docker-compose.yml`, `.env.example`, GitHub Actions (Node 22 and 24).
- Optional tuning: `MC_IDLE_VIEW_DISTANCE` / `MC_IDLE_AFTER_MIN` (idle bots ask for a smaller world; **off by default and not measured against a real server**), `DATA_DIR`, `JOIN_GAP_MS`, `THROTTLE_RETRY_MS`, `RESUME_SPREAD_MS`, `AUTO_RESUME`.
- README: new sections for access control, bot limits, server addresses, auto-resume, kicks and server checks, `/status`, `/quiet`, resource use, sizing for a bigger VPS, restart notice, heartbeat, tests, 24/7 running, backups, and upgrading.

## Tests

`npm test` runs 130 tests (2 of them are the real-library integration tests and skip themselves when the dependencies are not installed) with the built-in Node runner against stubs of grammY, mineflayer and the status ping (no network, token or Minecraft server needed). `test/integration-kick.test.js` uses the real mineflayer, minecraft-protocol and grammY against a local offline-mode server that throttle-kicks every login; it skips itself when the dependencies are not installed.

## Known limitations

- Almost everything is tested against stubs, plus that one real-library integration test; behaviour against real servers over long periods has not been measured. In particular, memory and CPU per bot and the effect of the idle view-distance reduction are unmeasured.
- All bots share one Node process, so one CPU core is the practical ceiling; `/status` shows when it is reached. More cores need more managers (each with its own Telegram bot token), see `deploy/mcafk@.service`.
- The host check runs when a bot is added, so DNS rebinding afterwards is not caught, and IPv6 literals cannot be added (`:` separates the port).
- Bot ids are still a 32-bit FNV-1a hash of `name:host:port` (kept for compatibility with saved data and callback buttons).
- A proxy (BungeeCord/Velocity) that stays alive while the backend is dead keeps the bot in limbo, which the watchdog cannot detect; the optional stuck alert covers part of that.
- The lobby guard only checks at join time.
