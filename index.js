// RANDOM_GAMEER - Minecraft AFK bot (no Discord needed)
// Reads the server IP from config.json (or SERVER_IP env var) and joins automatically.

const fs = require('fs');
const path = require('path');
const mineflayer = require('mineflayer');
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder');

// ---------- settings ----------
const config = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));

const BOT_NAME = config.botName || 'RANDOM_GAMEER';
const PASSWORD = config.password || 'uknown_playz';
const CHAT_MESSAGE = config.chatMessage || '67';
const CHAT_INTERVAL_MS = (config.chatEveryMinutes || 5) * 60 * 1000;
const ATTACK_RANGE = 10; // kill mobs within this many blocks
const FLEE_HEALTH = 8; // run away when health <= this (20 = full)
const CREEPER_FLEE_DIST = 7; // always run from creepers this close
const REJOIN_DELAY_MS = 2000; // rejoin 2 sec after kick/disconnect

function parseAddress(input) {
  const trimmed = String(input).trim();
  const parts = trimmed.split(':');
  if (parts.length === 2 && /^\d+$/.test(parts[1])) {
    return { host: parts[0], port: parseInt(parts[1], 10) };
  }
  return { host: trimmed, port: 25565 };
}

const rawIp = process.env.SERVER_IP || config.serverIp;
if (!rawIp || rawIp === 'YOUR_SERVER_IP_HERE') {
  console.error('Set "serverIp" in config.json (example: "play.example.com" or "1.2.3.4:25565").');
  process.exit(1);
}
const { host, port } = parseAddress(rawIp);
// mineflayer only supports Minecraft up to 1.21.11. Newer servers (26.x) still accept it through
// ViaVersion, so the bot joins as 1.21.11 by default. Auto-detect ("") can fail on 26.x servers.
const firstVersion = process.env.MC_VERSION || config.version || '1.21.11';
// If the bot keeps failing to join, it tries these versions one by one
const FALLBACK_VERSIONS = ['1.21.11', '1.21.9', '1.21.4', '1.21.1', '1.20.4', '1.19.4', '1.18.2'];
const versionList = [firstVersion, ...FALLBACK_VERSIONS.filter((v) => v !== firstVersion)];
let versionIdx = 0;
let quickFails = 0;

// ---------- helpers ----------
function isHostile(entity) {
  if (!entity || !entity.position) return false;
  if (entity.type === 'hostile') return true;
  const hostileNames = [
    'zombie', 'skeleton', 'creeper', 'spider', 'cave_spider', 'witch',
    'enderman', 'husk', 'stray', 'drowned', 'phantom', 'pillager',
    'vindicator', 'slime', 'blaze', 'ghast', 'zombie_villager', 'silverfish',
  ];
  return hostileNames.includes(entity.name);
}

// ---------- bot ----------
function startBot() {
  const version = versionList[versionIdx];
  console.log(`[bot] Connecting ${BOT_NAME} to ${host}:${port} (version: ${version || 'auto'}) ...`);

  let bot;
  try {
    bot = mineflayer.createBot({
      host,
      port,
      username: BOT_NAME,
      version,
      hideErrors: false,
    });
  } catch (err) {
    // e.g. unsupported version in config.json: don't die silently, try the next version
    console.log(`[bot] Could not start with version ${version || 'auto'}: ${err.message}`);
    quickFails = 0;
    versionIdx = (versionIdx + 1) % versionList.length;
    setTimeout(startBot, REJOIN_DELAY_MS);
    return;
  }

  bot.loadPlugin(pathfinder);
  bot.once('login', () => console.log('[bot] Logged in using protocol version:', bot.version));
  bot.on('connect', () => console.log('[bot] TCP connected to server'));
  bot._client.on('error', (err) => console.log('[bot] Protocol error:', err.message));

  let spawnedAt = 0;
  let chatTimer = null;
  let tickTimer = null;
  let wanderTimer = null;
  let lastAttack = 0;
  let lastAuthAt = 0;
  let state = 'idle'; // idle | fighting | fleeing

  // Auto /register and /login for auth plugins (AuthMe, nLogin, ...)
  bot.on('messagestr', (msg) => {
    const text = msg.toLowerCase();
    if (Date.now() - lastAuthAt < 2000) return;
    if (text.includes('/register') || text.includes('/reg ')) {
      lastAuthAt = Date.now();
      setTimeout(() => {
        try { bot.chat(`/register ${PASSWORD} ${PASSWORD}`); } catch (_) {}
      }, 1000);
    } else if (text.includes('/login') || text.includes('/l ')) {
      lastAuthAt = Date.now();
      setTimeout(() => {
        try { bot.chat(`/login ${PASSWORD}`); } catch (_) {}
      }, 1000);
    }
  });

  bot.once('spawn', () => {
    spawnedAt = Date.now();
    console.log(`[bot] Joined ${host}:${port}`);

    // heartbeat so the log shows the bot is alive and what it is doing
    const heartbeat = setInterval(() => {
      const p = bot.entity && bot.entity.position;
      console.log(`[bot] alive | health=${bot.health} | state=${state} | pos=${p ? p.x.toFixed(1) + ',' + p.y.toFixed(1) + ',' + p.z.toFixed(1) : '?'}`);
    }, 15000);
    bot.once('end', () => clearInterval(heartbeat));

    const movements = new Movements(bot);
    movements.canDig = false; // don't break blocks
    bot.pathfinder.setMovements(movements);

    // say "67" every 5 minutes
    setTimeout(() => { try { bot.chat(CHAT_MESSAGE); } catch (_) {} }, 5000);
    chatTimer = setInterval(() => {
      try { bot.chat(CHAT_MESSAGE); } catch (_) {}
    }, CHAT_INTERVAL_MS);

    tickTimer = setInterval(tick, 400);
    wanderTimer = setInterval(wander, 6000);
  });

  function nearestHostile(maxDist) {
    let best = null;
    let bestDist = maxDist;
    for (const id in bot.entities) {
      const e = bot.entities[id];
      if (e === bot.entity || !isHostile(e)) continue;
      const d = bot.entity.position.distanceTo(e.position);
      if (d <= bestDist) {
        best = e;
        bestDist = d;
      }
    }
    return best;
  }

  function equipBestSword() {
    const order = ['netherite_sword', 'diamond_sword', 'iron_sword', 'stone_sword', 'golden_sword', 'wooden_sword'];
    for (const name of order) {
      const item = bot.inventory.items().find((i) => i.name === name);
      if (item) {
        bot.equip(item, 'hand').catch(() => {});
        return;
      }
    }
  }

  function flee(from) {
    state = 'fleeing';
    bot.setControlState('sprint', true);
    const p = bot.entity.position;
    const dx = p.x - from.position.x;
    const dz = p.z - from.position.z;
    const len = Math.hypot(dx, dz) || 1;
    bot.pathfinder.setGoal(new goals.GoalXZ(p.x + (dx / len) * 20, p.z + (dz / len) * 20));
  }

  function fight(mob) {
    state = 'fighting';
    bot.setControlState('sprint', false);
    equipBestSword();
    bot.pathfinder.setGoal(new goals.GoalFollow(mob, 2), true);
    const dist = bot.entity.position.distanceTo(mob.position);
    if (dist < 3.5 && Date.now() - lastAttack > 650) {
      lastAttack = Date.now();
      bot.lookAt(mob.position.offset(0, (mob.height || 1) * 0.8, 0), true)
        .then(() => { try { bot.attack(mob); } catch (_) {} })
        .catch(() => {});
    }
  }

  function tick() {
    if (!bot.entity) return;
    const lowHealth = bot.health !== undefined && bot.health <= FLEE_HEALTH;

    const close = nearestHostile(CREEPER_FLEE_DIST);
    if (close && close.name === 'creeper') return flee(close); // never melee creepers

    const mob = nearestHostile(ATTACK_RANGE);
    if (mob && lowHealth) return flee(mob);
    if (mob) return fight(mob);

    if (state !== 'idle') {
      state = 'idle';
      bot.setControlState('sprint', false);
      bot.pathfinder.setGoal(null);
    }
  }

  function wander() {
    if (!bot.entity || state !== 'idle') return;
    const p = bot.entity.position;
    bot.pathfinder.setGoal(
      new goals.GoalNear(p.x + (Math.random() * 20 - 10), p.y, p.z + (Math.random() * 20 - 10), 1)
    );
    bot.setControlState('jump', true);
    setTimeout(() => bot.setControlState('jump', false), 300);
    bot.look(Math.random() * Math.PI * 2, (Math.random() - 0.5) * 0.6, false);
  }

  bot.on('death', () => console.log('[bot] Died, respawning...'));
  bot.on('kicked', (reason) => console.log('[bot] Kicked:', String(reason).slice(0, 300)));
  bot.on('error', (err) => console.log('[bot] Error:', err.message));
  bot.on('end', () => {
    clearInterval(chatTimer);
    clearInterval(tickTimer);
    clearInterval(wanderTimer);
    // Never joined, or kicked within 10 seconds of joining = probably wrong version.
    // After 3 fails in a row, switch to the next version in the list.
    if (!spawnedAt || Date.now() - spawnedAt < 10000) {
      quickFails++;
    } else {
      quickFails = 0;
    }
    if (quickFails >= 3) {
      quickFails = 0;
      versionIdx = (versionIdx + 1) % versionList.length;
      console.log(`[bot] Kicked too fast 3 times, switching to version ${versionList[versionIdx] || 'auto'}`);
    }
    console.log(`[bot] Disconnected. Rejoining in ${REJOIN_DELAY_MS / 1000} seconds...`);
    setTimeout(startBot, REJOIN_DELAY_MS);
  });
}

process.on('uncaughtException', (err) => console.log('[bot] Uncaught:', err && err.stack));
process.on('unhandledRejection', (err) => console.log('[bot] Unhandled:', err && err.message));

// keeps the program alive no matter what, so the run never ends by itself
setInterval(() => {}, 60 * 1000);

startBot();
