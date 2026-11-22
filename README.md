# RANDOM_GAMEER – Minecraft bot (auto-join)

No Discord needed. Put your server IP in `config.json`, push to GitHub, and the bot joins automatically using GitHub Actions.

## Setup (GitHub)
1. Create a new GitHub repo and upload ALL files from this folder (keep the `.github/workflows/bot.yml` path exactly).
2. Open `config.json` and change `"serverIp"` to your server, e.g. `"play.example.com"` or `"1.2.3.4:25565"`.
3. Commit. The bot starts by itself (Actions tab → "Run RANDOM_GAMEER").

To join a different server without editing files: Actions tab → Run RANDOM_GAMEER → **Run workflow** → type the IP.

## What the bot does
- Joins the server IP you set
- Says `67` in chat every 5 minutes
- Keeps moving (wanders, jumps, looks around)
- Attacks hostile mobs within 10 blocks
- Runs away from creepers, and from mobs when health is low
- Rejoins 2 seconds after any kick/disconnect
- Auto `/register` and `/login` with password `uknown_playz` (change in `config.json`)

## Run on your own PC instead
```
npm install
npm start
```
(Node.js 18+ needed.)

## Notes
- The name `RANDOM_GAMEER` only works on cracked / offline-mode servers.
- If auto version detection fails, set `"version"` in `config.json` (e.g. `"1.20.4"`).
- GitHub Actions restarts the bot every 5 hours, so there is a few seconds of downtime then. Free private repos have limited Actions minutes; public repos don't.
- Only use it on servers that allow bots.
