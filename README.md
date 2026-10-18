---

<img src="/Images/mcafk.png" alt="Project Logo" width="400" />

---

![GitHub stars](https://img.shields.io/github/stars/yazdaninfo/mcafk?style=social)
![GitHub forks](https://img.shields.io/github/forks/yazdaninfo/mcafk?style=social)
![GitHub issues](https://img.shields.io/github/issues/yazdaninfo/mcafk?style=social)
![GitHub release](https://img.shields.io/github/v/release/yazdaninfo/mcafk?style=for-the-badge)
![Node JS](https://img.shields.io/badge/Node.js-43853D?style=for-the-badge&logo=node.js&logoColor=white)
![Bun](https://img.shields.io/badge/Bun-000000?style=for-the-badge&logo=bun&logoColor=white)
![Telegram](https://img.shields.io/badge/Telegram-2CA5E0?style=for-the-badge&logo=telegram&logoColor=white)
![MIT License](https://img.shields.io/badge/License-MIT-yellow.svg?style=for-the-badge)
---
# McAfk - AFK Minecraft Player Bot for Telegram

A Node.js Telegram bot that connects offline (cracked-auth) player bots to Minecraft servers and forwards in-game chat to Telegram groups. Manage multiple bots from your phone through a fully inline-keyboard UI - no slash commands required.

---

## Jump to ...

- [Telegram Interface](#telegram-interface)
- [Features](#features)
- [Requirements](#requirements)
- [Setup](#setup)
- [Controlling Commands](#controlling-commands)
- [Usage](#usage)
- [Via Plugin Support](#via-plugin-support)
- [Auto-Reconnect](#auto-reconnect)
- [Architecture](#architecture)
- [Warning](#warning)
- [License](#license)

---

## Telegram Interface

**Main Menu** — send `/start` to see the menu:

![Main Menu](/Images/telegram-menu.png)

**Adding a Bot** — press **Add Bot** and enter the connection details:

![Add Bot Flow](/Images/add-bot-demo.png)

**Chat Forwarding** — Minecraft chat appears in your Telegram group:

![Chat Forwarding](/Images/chat-forward.png)

**`/walk` command** — make the bot move:

![Walking](/Images/walk.gif)

---

## Features

- **Fake player connections** to any cracked (offline-auth) Minecraft server
- **Multi-bot management** — add, disconnect, reconnect, and remove bots at any time
- **ViaVersion / ViaBackwards / ViaRewind support** — connect with any client version to any server version
- **Auto-reconnect** with exponential backoff (5s → 10s → 20s → 40s → 60s)
- **Chat forwarding** — pipe Minecraft server chat to Telegram groups in real time
- **Inline keyboard UI** — everything is controlled through Telegram buttons, no slash commands needed in private chat
- **Detailed status** — uptime, server address, version, and last error per bot
- **In-game messaging** — send messages to Minecraft chat with `/echo`
- **Bot movement** — move bots in all four directions with `/walk`, repeat it on a timer with `/auto`
- **Per-bot settings** — auto-eat, auto-respawn, health and death alerts, idle randomizer, auto-sleep, proximity alert, schedule window, view distance, lobby guard, stuck alert
- **Alerts and history** — damage/death alerts with cause and coordinates, `/where`, `/deaths`, `/inventory`, hourly digest, player watchlist, `/quiet` hours
- **Forward manager** — per-destination filters, chosen bots, batching, optional two-way relay (see `/forward`)
- **Optional AI chat** — a bot can answer in-game chat with the owner's own, encrypted API key
- **Unattended operation** — auto-resume after a restart, crash-loop guard, join queue per server, bot limits, closed-by-default access, backups of `userdata.json`, heartbeat, `/status` with CPU/memory/load
- **Deployment files** — systemd units, Dockerfile, docker-compose, GitHub Actions, and a test suite (`npm test`)

---

## Requirements

| Requirement | Version |
|---|---|
| Node.js | ≥ 22 |
| Bun | ≥ 1.0 |
| npm | ≥ 9 |

---

## Setup

### 1. Download the files

Clone the repo, or go to the [releases page](https://github.com/yazdaninfo/mcafk/releases) and download the source as a zip.

```shell
git clone https://github.com/yazdaninfo/mcafk
```

### 2. Install dependencies

```bash
npm install
```

Or install manually:

```shell
npm install grammy && npm install mineflayer
```

### 3. Create a Telegram bot

1. Open [@BotFather](https://t.me/BotFather) on Telegram
2. Send `/newbot` and follow the prompts
3. Copy the **bot token** you receive

### 4. Set the environment variable

```bash
export TELEGRAM_BOT_TOKEN=your_token_here
```

Or create a `.env` file and load it with your preferred tool — the bot reads `process.env.TELEGRAM_BOT_TOKEN` at startup.

Also set `ALLOWED_USER_IDS` (your numeric Telegram ID). **With it empty the manager is closed to everyone** (see [Access control](#access-control)). Not sure of your ID? Start the bot, message it once: it replies with your ID.

### 5. Run

```bash
npm start
# or
node index.js
```

You should see:

```
🚀 Minecraft Bot Manager starting…
✅  Running as @YourBotName
```

---

## Controlling Commands

### `/walk`

Moves your bot in a given direction.

**Usage:** `/walk [direction] [distance]`

**Example:**
```
/walk forward 2
```

**Response:**
```
✅ Walk complete!
🤖 Yazdanbot — walked 2.0 blocks
```

> Directions: `forward`, `back`, `left`, `right`

### `/auto`

Repeat an action automatically on a timer. Currently supports `walk`.

**Usage:** `/auto [botname] walk <direction> <steps> <seconds>`

```
/auto walk forward 2 60           # every bot you own, every 60s
/auto Steve walk forward 2 60     # only Steve
/auto Steve walk forward 2 30-90  # random delay between 30 and 90s
/auto list                        # show active automations
/auto stop [botname] [walk forward]
```

Steps = blocks (0.1–100), seconds = 5–86400. Offline bots skip runs until reconnected. Automations are saved and resume after a restart.

### `/settings`

`/settings [bot]` opens a toggle menu (inline buttons) for a bot:

- 🍗 **Auto-eat** — eats food from inventory when hungry.
- 💀 **Auto-respawn** — respawns automatically on death.
- ❤️ **Health alerts** — one Telegram message per damage episode, edited in place as you take more hits, plus a separate death message with the cause when detectable.
- 🎲 **Idle randomizer** — small random look/jump/sneak every so often, so the bot looks less like a script.
- 🛏 **Auto-sleep** — finds and uses a nearby bed at night.

All default to on except auto-sleep.

The same menu also has **👀 Proximity**, **🌍 View distance** and **🕐 Schedule** buttons: tap one, then send the value (`20` / `off`, `8` / `off`, or `22-6` / `off`) as a normal message. (These replace the old `/proximity` and `/schedule` commands.)

`/settings all` (or **⚙️ Settings (All Bots)** in the bot list) applies a toggle to every bot you own at once. 🟡 means the bots currently differ; tapping turns it on for all, and tapping again turns it off for all.

### `/watch` — player watchlist

`/watch` opens the list (🟢 online now / ⚫ not seen). `/watch add Notch Herobrine`, `/watch remove Notch`, or use the ➕ / 🗑 buttons. When a watched player joins or leaves a server where one of your bots is online, you get an alert in the chat where that bot was added. Several bots on the same server alert only once. Max 30 names.

### `/autoreply`

Reply automatically to in-game chat keywords:

```
/autoreply [bot] add hi | hello!
/autoreply [bot] add ip * | play.example.com | 60
/autoreply [bot] list
/autoreply [bot] remove hi
```

- A trigger without `*` is a case-insensitive substring match (as before).
- `*` matches any text, so `what * ip` matches "what is the ip". Matching is done with plain string search, not regex, so no trigger can slow the bot down.
- The optional last field is a per-trigger cooldown in seconds (default 10, max 3600), so a busy chat can't make the bot repeat itself.

Up to 20 rules per bot; the first matching trigger wins.

### `/where` and `/inventory`

`/where` — coordinates, dimension, gamemode, difficulty, health and food, plus stats since the last connect (copy-coords button).
`/deaths` — the last 10 deaths with time, cause and **where the bot died** (coordinates + dimension, and where it respawned), with copy buttons, plus an expandable **inventory at death** (stacks merged, armor included).
`/inventory` — stacked items and equipment.
Without a bot name these show a bot picker; the same views are buttons in each bot's menu.

### `/ai` — AI answers to server chat

Lets a bot answer in-game chat through an LLM, using the **owner's own API key**.

```
/ai [bot]                  status (which key is used, mode, persona, counters)
/ai [bot] on|off           (also a toggle in /settings)
/ai [bot] mode mention|all mention = only when its name is said (default), all = every message
/ai [bot] persona text     style note, up to 300 chars; "persona reset" clears it
```

- Auto-reply rules are checked first; AI only answers messages no rule matched.
- Limits per bot: one request at a time, 8s per player, 2.5s between replies, 60 requests per hour (`AI_MAX_PER_HOUR`).
- Replies are forced to one plain-text line and can never start with `/`, `!` or `.`, so a player cannot trick the bot into running commands. Messages from your own bots are ignored to avoid bot-to-bot loops.
- The model is told to admit being a bot if someone sincerely asks. Check that the server you join allows bots.
- `mode all` sends every chat line to your provider and costs more; start with `mention`.

### `/keys` — your own API keys (private chat only)

`/keys` opens a wizard: **Add key** → pick the provider → paste the key → pick the model. The bot deletes your message, encrypts the key, sends one tiny test request, and saves it as your active key. You can store up to 5 keys and switch with **🔀 Use**, re-check with **🧪 Test**, or remove with **🗑**. The active key is used by the AI chat of all your bots.

Providers: Anthropic (Claude), OpenAI, OpenRouter, Groq, or **any OpenAI-compatible URL** (you send the base URL, e.g. `https://example.com/v1`). Newer OpenAI models that require `max_completion_tokens` are handled automatically.

**How keys are protected**

- A hash is one-way and could not be used to call the API, so keys are stored with authenticated encryption instead: **AES-256-GCM**, a fresh random IV per key, the owner and key id bound as AAD (a ciphertext cannot be moved to another user), and a master key derived with scrypt.
- The master secret comes from `KEY_ENCRYPTION_SECRET`. If it is not set, a random one is created once in `.keysecret` (mode 0600) next to `index.js`. **Back up `.keysecret` together with `userdata.json`**; without it saved keys cannot be decrypted and must be re-added.
- Keys are decrypted only for the moment of a request, never logged, never echoed, and only the last 4 characters are ever shown.
- Custom URLs must be `https://` and may not point at private, loopback or link-local addresses (checked again when connecting, redirects are not followed). Set `AI_ALLOW_PRIVATE_URLS=1` to allow e.g. a local Ollama.
- Limits of this design: Telegram messages are not end-to-end encrypted, so the key is visible to Telegram when you send it (the bot deletes it immediately). Encryption at rest protects a leaked `userdata.json` or backup, not someone with root access to the running server. Use a dedicated key with a spend limit.

Optional server-wide fallback key for users without their own: `ANTHROPIC_API_KEY`, or `AI_API_KEY` (+ `AI_BASE_URL`); `AI_MODEL` overrides the model.

### `/digest`

`/digest` is a toggle: send it once to turn the hourly summary on (you get an instant preview), send it again to turn it off. The digest is a table with each bot's status, uptime, coordinates + dimension, health/food, players online, and deaths/disconnects in the last hour, plus a list of bots that need attention. The main menu has the same toggle button. The subscription survives restarts.

### Reconnecting

Each bot retries with backoff up to 10 attempts, then goes into a slower persistent retry (every 5 minutes) so a long server outage still self-heals without manual intervention — unless a `/schedule` window says it should be off right now.

### `/echo`

Sends a message to Minecraft chat.

**Usage:** `/echo [botname] [message]`

**Example:**
```
/echo yazdanbot hi guys
```

**Response:**
```
✅ Echo sent! → yazdanbot
💬 hi guys
🤖 Delivered to 1 bot(s)
⚫ 2 offline — skipped
```

> If no bot is specified, the message is sent from all online bots.

---

## Usage

### Private chat — managing bots

Send `/start` to your bot to open the main menu.

| Button | Action |
|---|---|
| ➕ Add Bot | Prompts you for connection details, then connects |
| 📋 Bots | Lists all registered bots with status |
| ℹ️ Help & Guide | Full usage guide |

**Adding a bot** — after pressing **Add Bot**, send one of:

```
name  ip  port  [version]
name  ip:port   [version]
```

Examples:

```
Steve play.example.com 25565 1.20.4
Alex  mc.example.com 25565 1.8.9
```

**Supported versions** (anything mineflayer supports):
`1.21.4` `1.20.4` `1.19.4` `1.16.5` `1.12.2` `1.8.9` `1.7.10`

### Group chat — forwarding Minecraft chat

1. Add your bot to a Telegram group.
2. In the group, send:
   ```
   /forward
   ```
3. Every bot you own will now forward server chat to that group. (Or use `/forward` in a private chat for the wizard.)

> On public servers, server spam can flood the group quickly. If you're using a supergroup, create a dedicated topic for server chat, or use a separate group.

**`/forward`** (private chat) opens the manager with two buttons:

- **📡 Forwards** — every destination with 🟢 (forwarding) / 🔴 (paused). Tap one to turn it on/off, choose which bots it receives, send a test message, or remove it. Destinations that kick the bot are paused automatically.
- **➕ New Forward** — wizard: pick a group/channel from your own chat list (or *This chat* / enter an `@username` / ID), then choose the bots.

Each destination also has:

- **🎚 Filter** — *Everything*, *Chat + deaths* or *Chat only* (tap to cycle).
- **🎮 Two-way** (groups/private only) — messages **you** write there are said in the game by one of the selected bots. `@BotName text` picks the bot; text starting with `/` is never relayed (use `/echo` for commands). Needs *Group Privacy* turned off for the bot in @BotFather (or admin rights) to see group messages. Over 256 characters is rejected.
- **Batching** — lines are collected and sent as one message (at most one message per ~3.5 s per destination) so busy servers don't hit Telegram's rate limit; `retry_after` is honoured.

In a group, `/forward` adds that group instantly (and links to the manager).

Forwarded messages look like:

```
[Steve @ mc.example.com:25565] Player123: hello everyone
[Steve @ mc.example.com:25565] Player123 joined the game
```

---

## Via Plugin Support

Server-side Via plugins handle protocol translation automatically. You only need to specify the correct **client** version when adding a bot:

| Plugin | Use case | Example |
|---|---|---|
| **ViaVersion** | Connect a newer client to an older server | `version 1.20.4` on a 1.8 server |
| **ViaBackwards** | Connect an older client to a newer server | `version 1.8.9` on a 1.20 server |
| **ViaRewind** | Connect a 1.7.x client to modern servers | `version 1.7.10` |

No special configuration is needed on the bot side.

---

## Auto-Reconnect

When a bot loses connection for any reason (kick, timeout, server restart), it automatically retries with exponential backoff:

| Attempt | Wait |
|---|---|
| 1 | 5s |
| 2 | 10s |
| 3 | 20s |
| 4 | 40s |
| 5+ | 60s |

The counter resets on a successful connection. Pressing **Disconnect** or **Remove** in the bot manager cancels any pending reconnect immediately.

---

## Architecture

<img src="/Images/diagram.png" alt="Project Logo" width="400" />

```
index.js            loads src/ in order; under MCAFK_TEST=1 exports the internals for test/
src/
├── registry.js     the shared namespace the modules register their names in (see below)
├── config.js       environment parsing, CFG constants, default settings
├── state.js        mcBots / chatStates / forwardMap …, the Telegram client, access control
├── util.js         small formatting and id helpers
├── messaging.js    rich messages, quiet hours, ownership and button helpers
├── ai.js           AI chat: provider requests, encrypted key store
├── persistence.js  userdata.json, backups, bot records
├── menus.js        main menu, bot list, manage screens, help
├── background.js   auto-eat, proximity, idle randomizer, stuck and health alerts
├── lifecycle.js    mineflayer lifecycle, server ping, kicks, join queue, reconnect
├── actions.js      /echo, /walk, /auto
├── settings.js     /settings screens, where / deaths / inventory views
├── ai-keys.js      /ai panel and the /keys wizard
├── reports.js      hourly digest and /status
├── forward.js      /forward hub and the two-way relay
├── watch-quiet.js  /watch and /quiet
├── handlers.js     Telegram commands, callbacks, text
└── boot.js         heartbeat, shutdown, schedule loop, resume, command list
```

The files are split by feature, in the order they load. They share one namespace (`src/registry.js`): each module registers its top-level names there, and a module reads another module's names from it (a name from an earlier module is destructured at the top of the file, one from a later module is read as `R.name` when used, so call order never matters). The few mutable variables several modules assign (`S.shuttingDown`, `S.loading` …) live on `S`. Nothing about behaviour changed in the split; it is a first step, not a layered design (many modules still call into each other).

**Dependencies:**

| Package | Purpose |
|---|---|
| [`grammy`](https://grammy.dev) v1 | Telegram Bot API client |
| [`mineflayer`](https://mineflayer.com) v4 | Minecraft bot client |

---

## Warning

**For educational purposes only.**

- Do not use this on servers you don't own or have permission to test on.
- Using this may violate a server's Terms of Service and risk a ban. Check the relevant TOS before using.

---

## License

MIT — see [LICENSE](LICENSE).


## Upgrading from the original single-file version

The original `index.js` (data format version 2) keeps working as a data source: bot ids are computed the same way, `userdata.json` is read and rewritten in the current format (version 5), and old forwards become active forwards (covered by `test/upstream-migration.test.js`). Things that behave differently, and that you should know about before upgrading:

- **Node 22 or newer** is required (the original accepted 18).
- **Access is closed by default.** With `ALLOWED_USER_IDS` empty nobody can use the manager; message the bot once to see your numeric ID, put it in `ALLOWED_USER_IDS` and restart. `ALLOW_OPEN_ACCESS=1` restores the old open behaviour.
- **Bots may not point at this machine or a private network** when they are added (loopback, LAN, link-local, cloud metadata). Set `MC_ALLOW_PRIVATE_HOSTS=1` if the Minecraft server runs on the same VPS or LAN. Bots that are already saved are not re-checked.
- **Bot limits:** 5 per user and 20 in total by default (`MAX_BOTS_PER_USER`, `MAX_BOTS_TOTAL`, `0` = no limit). Users who already have more keep their bots.
- **Adding a bot with the same name, host and port as someone else's bot is refused** (it used to replace that bot and take it over). Host names are stored in lower case.
- **Bots that were running come back by themselves after a restart** (`AUTO_RESUME=0` keeps the old "paused until Reconnect"). A file written by the original version records every bot as paused after a clean stop, so the first restart after upgrading still pauses all of them.
- **`/forward` is now a manager** in a private chat; in a group it adds that group right away. `/unforward` and `/forwards` were merged into it and only answer with a pointer. `/proximity`, `/schedule` and `/gamemode` were merged into `/settings` and `/where` the same way.
- **New defaults:** bots ask the server for a 4-chunk view distance (`MC_VIEW_DISTANCE`), "server shows offline" (Aternos-style lobby) is detected before and after joining, and `userdata.json` is written with mode 0600 next to its backups.

See `CHANGELOG.md` for the full list.

## Optional: stuck alert

`/settings` → **🧊 Stuck alert** (off by default). Set a number of minutes (5–720): if the bot has not moved horizontally **and** heard no chat, join or leave for that long, you get one alert with a **Reconnect now** button. Useful when a host keeps a bot in limbo. A bot you park on purpose in a quiet world will trigger it, so leave it off for those.


## Access control

Set `ALLOWED_USER_IDS` (comma-separated Telegram user IDs, see `.env.example`). Everyone else gets one polite "private" reply and cannot press buttons; strangers in groups are ignored.

**Left empty, the manager is closed to everyone** (earlier versions were open to anyone who found the bot, which let a stranger add bots until the VPS ran out of memory). While it is closed, anyone who messages the bot is shown their own Telegram ID, so you can paste yours into `ALLOWED_USER_IDS` and restart; `/status` and the startup log say `closed`. Blocked attempts are also logged as `⛔ blocked user <id>`. `ALLOW_OPEN_ACCESS=1` brings back the old open behaviour on purpose (it never overrides an allowlist). Bots that were already saved keep running while the manager is closed: only new use is refused.

## Bot limits

`MAX_BOTS_PER_USER` (default 5) and `MAX_BOTS_TOTAL` (default 20) cap how many bots one user, and the whole manager, can have; `0` means no limit. **Add Bot** says so when you are at a limit, and the check runs again when you send the details. Replacing a bot you already own (same name, host and port) does not count. A user who already has more bots than the limit keeps them and simply cannot add. Adding a bot whose name, host and port match **another user's** bot is refused (it used to overwrite that record and take over its settings and auto-replies). `/status` shows `3/5 yours · 12/20 in total`. The defaults are guesses for a small VPS: measure the RSS in `/status` with your real bots and adjust.

## Server addresses

When you add a bot, the host is lower-cased and must be a plain host name or IPv4 address. **Private addresses are refused** (loopback, `10.x`, `172.16–31.x`, `192.168.x`, link-local such as the cloud metadata address, `localhost`, `*.local`, `*.internal`, and host names that resolve to one of those): a bot connects from *this* machine, so otherwise any allowed user could probe your VPS and network through the error messages. If your Minecraft server runs on this VPS or your LAN, set `MC_ALLOW_PRIVATE_HOSTS=1`. Bots saved before v15.2 are not re-checked and keep working. A host that cannot be resolved at that moment is let through (the server may just be down).

## Auto-resume after a restart

Bots that were meant to be running when the process stopped (a clean stop, a crash, `kill -9`, an OOM kill or a reboot) reconnect by themselves, one start every `RESUME_SPREAD_MS` (300 ms), and the join queue then keeps `JOIN_GAP_MS` between the logins to one server. Bots you **Disconnect**ed, bots that were banned or not whitelisted, and bots outside their 🕐 schedule window stay as they were (scheduled bots start inside their window as before). `AUTO_RESUME=0` brings back the old "everything stays paused until Reconnect" behaviour. **Crash-loop guard:** if the manager itself did not stop cleanly `RESUME_CRASH_LOOP_STARTS` times (default 3) within 10 minutes, bots are *held*: not logged in again on every restart. Their saved state stays "running", so the next clean start brings them back, or press **Reconnect**; one notice says so. `0` disables the guard. After an unclean stop the restart notice says how many bots are reconnecting.

Upgrade note: a `userdata.json` written by v14 or older recorded every bot as paused at a clean stop, so the **first** restart after upgrading still pauses everything; from the first v15 run on, resume works.

## Server checks and kicks

- **Status ping before joining.** The server's list status (players, MOTD, ping) is read first. If it says *Offline* (Aternos does this while the server is stopped), the bot doesn't join and checks again every 3 min (guarded by 🚪 Lobby guard; after 5 skips it joins anyway as a safety valve). A failed ping never blocks joining. The digest and `/status` show players, MOTD and ping per server.
- **Kick reasons.** *Banned* and *not whitelisted* stop reconnecting and tell you the fix (`/pardon` / `/whitelist add`) with a Reconnect button. *Logged in from another location* and *server full* retry quietly every 2 / 1 min with one notice. Anything else keeps the normal backoff.
- **Join throttling.** Paper and Spigot refuse a second connection from the same IP within about 4 seconds (*Connection throttled*). Every join to one `host:port` therefore goes through a queue that keeps **5 s** between attempts (`JOIN_GAP_MS`, `0` turns it off), so starting several bots at once, or the schedule loop waking them together, is safe; different servers do not wait for each other. The queue is keyed by the server's **resolved IP** (plus port), because the throttle is per source address and two host names can point at one server; if the name cannot be resolved within 2 s the host name itself is the key. If a throttle kick still happens (for example another client joined from your IP), the bot waits `THROTTLE_RETRY_MS` (5 s) and tries again **without a message and without using up a reconnect attempt**. After 12 throttle kicks in a row the normal backoff takes over, so it cannot loop silently forever. `/status` shows how many bots are waiting for a join slot.

## `/status`

Manager uptime, memory, runtime, your bots, forwards (and queued lines), server status, data file, backups and whether access is restricted, plus your quiet hours, the join queue and the heartbeat. Refresh button included.

## `/quiet` — quiet hours

Alerts at 3 a.m. are noise. `/quiet 23-7` (whole hours, wraps midnight) makes the chatty ones arrive **silently** (Telegram's `disable_notification`: delivered, no sound) during that window, per user. Set your timezone once with `/quiet tz Asia/Baku` (or `UTC+4`, `UTC-5:30`); without it the window follows the server's clock, and the panel warns you. `/quiet off` / `/quiet on` or the panel button switch it, and the panel is also on the main menu.

| Silent in quiet hours | Always audible |
|---|---|
| connected / really in · reconnecting · kicked and errors · name in use / server full · server-offline notices · watchlist · hourly digest | bans and whitelist · deaths · stuck alerts · gave up reconnecting · damage and low health · player nearby · the unclean-restart notice |

Anything not on the silent list is audible by design, so a new kind of alert can never be muted by accident. Forwarded game chat is not an alert and is unchanged. The classification is one set (`QUIET_KINDS` in `index.js`) if you want to move something.

## Resource use

A bot's main cost is the **world it loads**: the server sends every chunk within the client's view distance, and the number of chunks grows with the *square* of that radius. Mineflayer asks for a large radius by default, which an AFK bot never needs. McAfk therefore asks for **4 chunks** (`MC_VIEW_DISTANCE`, accepts 2–32, or `default` to leave it to mineflayer). The server may still send less than you ask for (it caps at its own setting), never more.

A bot with a 👀 proximity alert of *R* blocks automatically gets at least `ceil(R / 16) + 1` chunks, because the server only tracks players inside the client's view distance and the alert would otherwise never fire. That is per bot, so one wide alert does not enlarge the others. A change to the proximity radius reaches the server at that bot's next reconnect, and the bot tells you so.

One server may need more than 4 chunks (for example for long `/auto walk`s): **/settings → 🌍 View distance** sets 2–32 chunks for that one bot (`off` follows `MC_VIEW_DISTANCE`), so a generous server does not raise the default for all of them. It takes effect at the bot's next reconnect, and a proximity alert still raises it if it needs more.

**Optional idle reduction (off by default):** `MC_IDLE_VIEW_DISTANCE=2` (2–32) makes a bot that has not moved horizontally for `MC_IDLE_AFTER_MIN` minutes (default 30) ask the server for that smaller view distance, and ask for its normal one again as soon as it moves or gets a proximity alert. Bots with a proximity alert are skipped. **This one is not measured:** whether it frees memory depends on the server unloading the chunks it no longer needs to send, and it has only been tested against stubs, not a real server. Turn it on for one deployment, watch the RSS in `/status` before and after, and leave it off if it does not help. `/status` shows when it is on.

What it does *not* change: physics still ticks 20 times a second per bot and packets are still parsed, so CPU per bot stays roughly constant. All bots share one process, so the Minecraft data tables for a version are loaded once, not once per bot.

**Measure it on your own server** (per-bot memory and CPU have not been measured against real servers): start your bots, wait ten minutes, and note the RSS in `/status`; then restart with `MC_VIEW_DISTANCE=default` and compare. Each bot also costs the manager very little compared with a separate process per bot, so add bots to one manager rather than running several managers.

Optional hard cap on Node's heap, useful on a small VPS: `NODE_OPTIONS=--max-old-space-size=256` (make it larger if you run many bots; if the heap legitimately needs more, the process is killed and restarted, which the restart notice then reports). In Docker, `mem_limit` in `docker-compose.yml` does the same job from outside.

## Sizing for a bigger VPS (e.g. 16 GB RAM / 4 vCPU)

All bots run inside **one Node process, and JavaScript executes on one core**. A 4 vCPU machine therefore does not run four times as many bots in one manager: the first wall is usually that single core, not RAM. `/status` has a **📈 Load** row for exactly this: the manager's CPU share (100% = one full core) and event-loop lag, sampled once a minute. When CPU stays at 85% or more, or lag p99 at 250 ms or more, for three samples in a row, `/status` says *one core is the limit*, the console logs it once (and again when it recovers), and **every user who has bots gets one Telegram message** (sent to the chat of their first bot, like the unclean-restart notice). That message is sent once per saturated spell and at most once every 30 minutes, so a load that flaps around the threshold cannot spam; it is silent during the user's `/quiet` hours. Those thresholds are judgement calls, not measured values.

How to use a bigger machine:

0. **Read RAM per bot in `/status`.** The 🧠 Memory row ends with `≈N MB per online bot (M online)`: the process RSS divided by the bots online in the whole manager (all users). It includes the manager's own base cost, so it overstates what one more bot costs, most when few bots are online. For the marginal cost compare two readings: `(RSS at N2 − RSS at N1) / (N2 − N1)`, taken after the bots have been up for ten minutes.

1. **Raise the caps in steps.** `MAX_BOTS_TOTAL` and `MAX_BOTS_PER_USER` default to 20 and 5, chosen for a small box. Raise the total by about 10, let the bots run for a while, read the Load row, repeat. CPU per bot has not been measured, so there is no recommended number; the Load row is the measurement.
2. **Keep `MC_VIEW_DISTANCE` at 4.** More RAM does not make a larger radius useful for an AFK bot, and it costs RAM and CPU. Use **/settings → 🌍 View distance** for the one server that needs more.
3. **Past one core: more managers, not more threads.** A second manager needs its own Telegram bot token (a second bot from @BotFather; one token can be polled by one process only) and its own `DATA_DIR`. `deploy/mcafk@.service` is a systemd template for that. Instances share nothing, including the join queue, so two managers joining the same Minecraft server can trip its connection throttle; the throttle retry handles that quietly. Splitting one manager's bots over worker threads is possible in principle but would be a large rewrite and is not done.
4. **Memory guard.** `deploy/mcafk.service` sets `MemoryHigh=10G` / `MemoryMax=12G` for a 16 GB host (lower them if a Minecraft server shares the machine). Leave `NODE_OPTIONS=--max-old-space-size` unset on a big machine.

Ubuntu 24.04's own `nodejs` package is Node 18, which is below the required 22; install Node 22 from NodeSource (the commands are at the top of `deploy/mcafk.service`). `UV_THREADPOOL_SIZE=8` in the unit enlarges libuv's thread pool (DNS, zlib, file I/O); that is a precaution, not a measured gain.

## Schedule loop

With a 🕐 schedule set in `/settings`, the manager checks once a minute. Inside the window it starts a bot that is off; it **leaves alone** a bot that is waiting out a reconnect backoff, a lobby / kick / throttle timer (it used to restart those every minute, which skipped the backoff and reset the attempt counter), and a bot you **disconnected by hand** (that holds until the window ends or you press Reconnect). When the window closes it stops a connected bot **and** one that is waiting to retry, so nothing keeps reconnecting all night.

## Restart notice

`kill -9`, an out-of-memory kill or a power cut leave no chance to say anything, but the next start can. While running, the manager keeps `.running` in the data directory and deletes it on a clean stop (exit code 0). If it is found at startup, each user with bots gets one message: *restarted after an unclean stop*, when it was last seen alive, and how many of their bots are reconnecting by themselves (see Auto-resume above; the rest stay paused until **Reconnect**). It is audible even in quiet hours, and a crash loop sends one notice per 10 minutes, not one per restart. This complements the heartbeat: the heartbeat tells you it died, this tells you it came back.

## Heartbeat (`HEARTBEAT_URL`)

`kill -9`, an OOM kill or a power cut cannot be reported by the process that just died, but they can be noticed from outside. Set `HEARTBEAT_URL` to a check URL from a service such as [healthchecks.io](https://healthchecks.io) (or Uptime Kuma's push monitor). The manager pings it every minute while it is healthy; if the pings stop, **the monitoring service** sends you the alert (healthchecks.io has a Telegram integration; create the check with a 1 minute period and a 3–5 minute grace).

Healthy means: not shutting down, and Telegram answered an API call within the last 3 minutes (long polling counts), so a hung event loop or lost network also stops the pings. Minecraft bots being down does **not** stop the heartbeat; that is what the bot alerts are for. The URL contains the check's secret, so it is never logged (only the host name is). A planned restart is a short gap well inside the grace time. `/status` shows the heartbeat state.

The same health check also touches `DATA_DIR/.health` every minute, with or without `HEARTBEAT_URL`. The Docker image's `HEALTHCHECK` reads it and reports the container **unhealthy** when it is older than 3 minutes (`docker ps`). Docker only flags that state; to restart an unhealthy container automatically, add an autoheal helper.

## Tests

**Reproducible installs:** run `npm install` once and commit the generated `package-lock.json`; the Dockerfile and CI then use `npm ci` (until a lockfile exists they fall back to `npm install`, so versions float). The Docker image and CI use Node 22 and 24 (Node 20 reached end of life on 30 Apr 2026).

`npm test` (Node 22+; built-in test runner with fake timers). Most tests load `index.js` against small stubs of grammY, mineflayer and the status ping in `test/stubs/`, so they need no network, no Telegram token and no Minecraft server. They cover the join queue (including DNS-keyed queues), throttle handling, the schedule loop, quiet hours (including every alert that must stay audible), the heartbeat and health file (against a real local HTTP server), the restart notice, persistence, auto-resume, the bot limits (also through the real Add Bot handlers), per-bot and idle view distance, and the access default.

`test/integration-kick.test.js` is different: it uses the **real** mineflayer, minecraft-protocol and grammY against a local offline-mode Minecraft server that kicks every login with Paper's throttle message, to prove mineflayer delivers that kick through its `kicked` event and that the manager then waits quietly. It needs `npm install` first and skips itself otherwise. The kick phase it exercised (login or play) is printed as a test diagnostic. GitHub Actions (`.github/workflows/test.yml`) runs everything on Node 22 and 24 for every push.

## Running 24/7

- **systemd:** `deploy/mcafk.service` (install steps are in the file). The process exits `0` on a clean stop and `1` on a crash, so `Restart=on-failure` restarts only crashes.
- **Several managers on one machine:** `deploy/mcafk@.service` (see *Sizing for a bigger VPS*).
- **Docker:** `docker compose up -d --build` (see `docker-compose.yml`; data lives in the `/data` volume via `DATA_DIR`).
- Plain Node: `node --env-file=.env index.js` (Node 22+), or export the variables yourself.

## Backups

`userdata.json` is saved atomically and a copy of the previous file is kept as `userdata.json.bak1`…`bak3` (at most one per hour). If `userdata.json` ever becomes unreadable at startup, the newest valid backup is restored automatically and the broken file is kept as `userdata.json.corrupt-<time>`. To roll back by hand: stop the bot and `cp userdata.json.bak1 userdata.json`. Back up `.keysecret` together with them (it never changes).
