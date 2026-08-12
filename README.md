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
# McAfk — AFK Minecraft Player Bot for Telegram

A Node.js Telegram bot that connects offline (cracked-auth) player bots to Minecraft servers and forwards in-game chat to Telegram groups. Manage multiple bots from your phone through a fully inline-keyboard UI — no slash commands required.

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
- **Bot movement** — move bots in all four directions with `/walk`

---

## Requirements

| Requirement | Version |
|---|---|
| Node.js | ≥ 18 |
| or Bun | ≥ 1.0 |
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

**Usage:** `/walk [botname] [direction] [distance]`

**Example:**
```
/walk yazdanbot forward 2
```

**Response:**
```
✅ Walk complete!
🤖 Yazdanbot — walked 2.0 blocks
```

> Directions: `forward`, `back`, `left`, `right`
> If no bot is specified, the command moves all bots.

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
| 📡 Forwarding | Explains the chat-forwarding feature |
| ℹ️ Help | Full usage guide |

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
   /forward @yourusername
   ```
3. Every bot you own will now forward server chat to that group.

> On public servers, server spam can flood the group quickly. If you're using a supergroup, create a dedicated topic for server chat, or use a separate group.

**Forwarding commands** (used in the group):

| Command | Description |
|---|---|
| `/forward @username` | Subscribe this group to that user's bots' chat |
| `/unforward @username` | Unsubscribe |
| `/forwards` | List active subscriptions in this chat |

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

```
index.js
├── State
│   ├── mcBots      Map<name, BotInfo>          — all registered bots
│   ├── chatStates  Map<chatId, State>           — conversation flow per chat
│   └── forwardMap  Map<username, Set<chatId>>   — forwarding subscriptions
├── spawnBot()      — creates mineflayer bot, wires events, handles reconnect
├── Telegram UI     — /start, /forward, /unforward, /forwards + inline callbacks
└── Chat forwarding — strips § color codes, sends plain text to subscribed groups
```

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
