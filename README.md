---
<img src="/Images/mcafk.png" alt="Project Logo" width="400" />

---

![GitHub stars](https://img.shields.io/github/stars/yazdaninfo/mcafk?style=social)
![GitHub forks](https://img.shields.io/github/forks/yazdaninfo/mcafk?style=social)
![GitHub issues](https://img.shields.io/github/issues/yazdaninfo/mcafk?style=social)
![Node JS](https://img.shields.io/badge/Node.js-43853D?style=for-the-badge&logo=node.js&logoColor=white)
![Bun](https://img.shields.io/badge/Bun-000000?style=for-the-badge&logo=bun&logoColor=white)
![Telegram](https://img.shields.io/badge/Telegram-2CA5E0?style=for-the-badge&logo=telegram&logoColor=white)
![MIT License](https://img.shields.io/badge/License-MIT-yellow.svg?style=for-the-badge)

---

## 🤖 McAfk, Afk minecraft player — Telegram Bot

A Node.js Telegram bot that connects fake offline (cracked) players to Minecraft servers and forwards in-game chat to Telegram group chats. Manage multiple bots from your phone with a fully inline-keyboard UI — no complicated commands needed.

---
## 📱 **Telegram Interface**

### Main Menu
Send `/start` to see this:

![Main Menu](/Images/telegram-menu.png)

### Adding a Bot
Press **Add Bot** and enter details:

![Add Bot Flow](/Images/add-bot-demo.png)

### Chat Forwarding
Minecraft chat appears in your Telegram group:

![Chat Forwarding](/Images/chat-forward.png)

---


## Features

- **Connect fake players** to any Minecraft server that is cracked and have via backwards (offline/cracked auth)
- **Multi-bot management** — add, disconnect, reconnect, and remove bots at any time
- **ViaVersion / ViaBackwards / ViaRewind support** — connect with any client version to any server version
- **Auto-reconnect** with exponential backoff (5 s → 10 s → 20 s → 40 s → 60 s)
- **Chat forwarding** — pipe Minecraft server chat to Telegram group chats in real time
- **Inline keyboard UI** — everything controlled through Telegram buttons; no slash commands needed in private chat
- **Detailed status** — uptime, server address, version, last error per bot

---

## Requirements

| Requirement | Version |
|---|---|
| Node.js | ≥ 22 |
| or bun  | ≥ 1.0 |
| npm | ≥ 9 |

---

## Setup

### 1. download the files 
you can go to the releases page and download the source code and unzip it or clone the repo
```shell
git clone https://github.com/yazdaninfo/mcafk
```
and change the name of ".env.example" to ".env" and add your token 

### 2. Install dependencies

```bash
npm install
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

## Usage

### Private chat — managing bots

Send `/start` to your bot to open the main menu.

| Button | Action |
|---|---|
| ➕ Add Bot | Prompts you for connection details, then connects |
| 📋 Bots | Lists all registered bots with status |
| 📡 Forwarding | Explains the chat-forwarding feature |
| ℹ️ Help | Full usage guide |

**Adding a bot** — after pressing Add Bot, send one of:

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

1. Add your bot to a Telegram group
2. In the group, send:
   ```
   /forward @yourusername
   ```
3. Every bot you own will now forward server chat to that group

4. sometimes especially if you are using the bot on public servers the spam messages from the server could flood the group so if you are using a supergroup add a new topic for the server chat or create a new group 

**Forwarding commands** (use in the group):

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

Server-side Via plugins handle all protocol translation automatically. You just need to specify the correct **client** version when adding a bot:

| Plugin | Use case | Example |
|---|---|---|
| **ViaVersion** | Connect a newer client to an older server | `version 1.20.4` on a 1.8 server |
| **ViaBackwards** | Connect an older client to a newer server | `version 1.8.9` on a 1.20 server |
| **ViaRewind** | Connect a 1.7.x client to modern servers | `version 1.7.10` |

No special configuration is needed on the bot side.

---

## Auto-Reconnect

When a bot loses connection for any reason (kick, timeout, server restart), it automatically retries:

| Attempt | Wait |
|---|---|
| 1 | 5 s |
| 2 | 10 s |
| 3 | 20 s |
| 4 | 40 s |
| 5+ | 60 s |

The counter resets on a successful connection. Pressing **Disconnect** or **Remove** in the bot manager cancels any pending reconnect immediately.

---

## Architecture

```
index.js
├── State
│   ├── mcBots      Map<name, BotInfo>     — all registered bots
│   ├── chatStates  Map<chatId, State>     — conversation flow per chat
│   └── forwardMap  Map<username, Set<chatId>>  — forwarding subscriptions
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
**for educational purposes only**

**don't use this on servers you don't own**

**risk of ban in services if break the TOS check before using**

---

## License

MIT — see [LICENSE](LICENSE).
