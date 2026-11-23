// brain.js - the "player" brain.
//  * fights mobs within 10 blocks, runs from creepers
//  * fights a player only if they hit it 2+ times AND it wears full iron armor (else it runs away)
//  * eats food, equips the best armor and weapon
//  * jumps while moving
//  * works through stages: wood -> stone tools -> food -> house -> iron gear

const { Movements, goals } = require('mineflayer-pathfinder');
const gear = require('./gear');
const S = require('./skills');

const ATTACK_RANGE = 10; // mobs closer than this get attacked
const CREEPER_FLEE_DIST = 7;
const FLEE_HEALTH = 8;
const LOG_NAMES = ['oak_log', 'birch_log', 'spruce_log', 'jungle_log', 'acacia_log', 'dark_oak_log', 'mangrove_log', 'cherry_log', 'pale_oak_log'];
const IRON_ORES = ['iron_ore', 'deepslate_iron_ore'];
const COAL_ORES = ['coal_ore', 'deepslate_coal_ore'];
const HOSTILE_NAMES = [
  'zombie', 'skeleton', 'creeper', 'spider', 'cave_spider', 'witch', 'enderman', 'husk', 'stray', 'drowned',
  'phantom', 'pillager', 'vindicator', 'slime', 'blaze', 'ghast', 'zombie_villager', 'silverfish', 'bogged', 'breeze',
];

function startBrain(bot, cfg, log) {
  const movements = new Movements(bot);
  movements.canDig = false;
  bot.pathfinder.setMovements(movements);

  const state = {
    combat: false,
    digging: false,
    stopped: false,
    badBlocks: new Set(),
    home: null,
    houseBuilt: false,
  };
  const ctx = { bot, log, movements, state };

  const HITS_TO_FIGHT = cfg.hitsToFight || 2;
  const timers = [];
  const ignore = new Map(); // mob id -> ignore until (ms)
  const fightStart = new Map(); // mob id -> when we started chasing it
  const hits = new Map(); // player name -> [timestamps]
  let enemy = null; // { name, until }
  let followId = null;
  let lastAttack = 0;
  let lastHealth = bot.health;

  // ---------------- finding things ----------------
  function isHostile(e) {
    if (!e || !e.position || e === bot.entity) return false;
    if (e.type === 'player') return false;
    return e.type === 'hostile' || HOSTILE_NAMES.includes(e.name);
  }

  function nearestHostile(maxDist) {
    const me = bot.entity.position;
    const now = Date.now();
    let best = null;
    let bestD = maxDist;
    for (const e of Object.values(bot.entities)) {
      if (!isHostile(e)) continue;
      if ((ignore.get(e.id) || 0) > now) continue;
      if (Math.abs(e.position.y - me.y) > 6) continue;
      const d = me.distanceTo(e.position);
      if (d <= bestD) { best = e; bestD = d; }
    }
    return best;
  }

  function nearestPlayer(maxDist) {
    const me = bot.entity.position;
    let best = null;
    let bestD = maxDist;
    for (const e of Object.values(bot.entities)) {
      if (!e || e.type !== 'player' || e === bot.entity || e.username === bot.username) continue;
      const d = me.distanceTo(e.position);
      if (d <= bestD) { best = e; bestD = d; }
    }
    return best;
  }

  // ---------------- being hit by a player ----------------
  bot.on('health', () => {
    try {
      if (bot.health < lastHealth) {
        const attacker = nearestPlayer(6);
        if (attacker && !nearestHostile(4)) {
          const now = Date.now();
          const list = (hits.get(attacker.username) || []).filter((t) => now - t < 10000);
          list.push(now);
          hits.set(attacker.username, list);
          if (list.length >= HITS_TO_FIGHT || (enemy && enemy.name === attacker.username)) {
            if (!enemy || enemy.name !== attacker.username) log(`${attacker.username} hit me ${list.length}x, they are an enemy now`);
            enemy = { name: attacker.username, until: now + 60000 };
          }
        }
      }
    } catch (_) { /* never crash on health events */ }
    lastHealth = bot.health;
  });

  // ---------------- combat actions ----------------
  function flee(from) {
    state.combat = true;
    if (followId !== 'flee:' + from.id) {
      followId = 'flee:' + from.id;
      bot.setControlState('sprint', true);
      const p = bot.entity.position;
      const dx = p.x - from.position.x;
      const dz = p.z - from.position.z;
      const len = Math.hypot(dx, dz) || 1;
      bot.pathfinder.setGoal(new goals.GoalXZ(p.x + (dx / len) * 25, p.z + (dz / len) * 25));
    }
  }

  function fight(target) {
    state.combat = true;
    gear.equipBestWeapon(bot).catch(() => {});
    if (followId !== 'fight:' + target.id) {
      followId = 'fight:' + target.id;
      bot.setControlState('sprint', true);
      bot.pathfinder.setGoal(new goals.GoalFollow(target, 2), true);
    }
    const dist = bot.entity.position.distanceTo(target.position);
    if (dist < 3.4 && Date.now() - lastAttack > gear.weaponCooldown(bot) + 30) {
      lastAttack = Date.now();
      bot.lookAt(target.position.offset(0, (target.height || 1.5) * 0.85, 0), true)
        .then(() => { try { bot.attack(target); } catch (_) {} })
        .catch(() => {});
    }
  }

  function combatTick() {
    if (state.stopped || !bot.entity) return;
    const now = Date.now();
    const lowHealth = bot.health !== undefined && bot.health <= FLEE_HEALTH;

    // 1) an enemy player
    if (enemy && now > enemy.until) enemy = null;
    if (enemy) {
      const rec = bot.players[enemy.name];
      const target = rec && rec.entity;
      if (target && bot.entity.position.distanceTo(target.position) < 40) {
        const ready = gear.hasIronArmor(bot) && gear.bestWeapon(bot) && bot.health > 6;
        return ready ? fight(target) : flee(target);
      }
      enemy = null;
    }

    // 2) creepers explode, never melee them
    const close = nearestHostile(CREEPER_FLEE_DIST);
    if (close && close.name === 'creeper') return flee(close);

    // 3) mobs within 10 blocks
    const mob = nearestHostile(ATTACK_RANGE);
    if (mob) {
      if (lowHealth) return flee(mob);
      if (!fightStart.has(mob.id)) fightStart.set(mob.id, now);
      if (now - fightStart.get(mob.id) > 20000) {
        // can't reach it (behind a wall?) so ignore it for a while
        ignore.set(mob.id, now + 40000);
        fightStart.delete(mob.id);
        return;
      }
      return fight(mob);
    }

    // 4) all clear
    if (state.combat) {
      state.combat = false;
      followId = null;
      bot.setControlState('sprint', false);
      bot.pathfinder.setGoal(null);
    }
  }

  // ---------------- background upkeep ----------------
  timers.push(setInterval(combatTick, 400));
  timers.push(setInterval(() => { gear.eatIfNeeded(bot).catch(() => {}); }, 1500));
  timers.push(setInterval(() => { gear.equipBestArmor(bot).catch(() => {}); }, 6000));
  timers.push(setInterval(() => {
    for (const [id, t] of ignore) if (t < Date.now()) ignore.delete(id);
  }, 30000));

  // jump while moving
  if (cfg.jumpWhileMoving !== false) {
    timers.push(setInterval(() => {
      try {
        const moving = typeof bot.pathfinder.isMoving === 'function' ? bot.pathfinder.isMoving() : false;
        if (moving && !state.digging && bot.entity && bot.entity.onGround) {
          bot.setControlState('jump', true);
          setTimeout(() => bot.setControlState('jump', false), 150);
        }
      } catch (_) {}
    }, 650));
  }

  bot.on('death', () => {
    state.combat = false;
    followId = null;
    enemy = null;
    log('I died, respawning and starting over from my inventory');
  });

  // ---------------- stages ----------------
  const have = (n) => S.itemCount(bot, n);
  const logsWorth = () => S.countWhere(bot, S.isLog) + Math.floor(S.countWhere(bot, S.isPlanks) / 4);

  const IRON_PIECES = ['iron_pickaxe', 'iron_sword', 'iron_helmet', 'iron_chestplate', 'iron_leggings', 'iron_boots'];
  function missingIron() {
    const m = [];
    if (S.toolTier(bot, 'pickaxe') < 3) m.push('iron_pickaxe');
    if (S.toolTier(bot, 'sword') < 3) m.push('iron_sword');
    for (const piece of ['helmet', 'chestplate', 'leggings', 'boots']) {
      if (!S.hasArmorPiece(bot, piece)) m.push('iron_' + piece);
    }
    return m;
  }

  let currentStage = 'starting';

  const STAGES = [
    {
      // emergency: low health/hunger and nothing to eat -> get food before anything else
      name: 'emergency food',
      done: () => gear.foodCount(bot) > 0 || (bot.food === undefined || bot.food >= 14) && bot.health > 8,
      run: async () => {
        await S.hunt(ctx, 3);
        await S.cookMeat(ctx);
        return gear.foodCount(bot) > 0;
      },
    },
    {
      name: 'wood + wooden pickaxe',
      done: () => S.toolTier(bot, 'pickaxe') >= 1,
      run: async () => {
        if (logsWorth() < 10) {
          await S.collect(ctx, LOG_NAMES, 12, logsWorth, { canDig: false, maxAbove: 3 });
        }
        if (logsWorth() < 3) return false;
        if (!(await S.craftTool(ctx, 'wooden_pickaxe'))) return false;
        if (S.toolTier(bot, 'sword') < 1) await S.craftTool(ctx, 'wooden_sword');
        if (S.toolTier(bot, 'axe') < 1) await S.craftTool(ctx, 'wooden_axe');
        return S.toolTier(bot, 'pickaxe') >= 1;
      },
    },
    {
      name: 'stone tools + furnace',
      done: () => S.toolTier(bot, 'pickaxe') >= 2 && S.toolTier(bot, 'sword') >= 2,
      run: async () => {
        const need = 22;
        await S.collect(ctx, ['stone'], need, () => S.countWhere(bot, S.isCobble), { maxDistance: 48 });
        await S.craftTool(ctx, 'stone_pickaxe');
        await S.craftTool(ctx, 'stone_sword');
        if (S.toolTier(bot, 'axe') < 2) await S.craftTool(ctx, 'stone_axe');
        if (have('furnace') === 0) await S.craftTool(ctx, 'furnace');
        return S.toolTier(bot, 'pickaxe') >= 2 && S.toolTier(bot, 'sword') >= 2;
      },
    },
    {
      name: 'food',
      done: () => gear.foodCount(bot) >= 4,
      run: async () => {
        await S.hunt(ctx, 6);
        await S.cookMeat(ctx);
        return gear.foodCount(bot) >= 4;
      },
    },
    {
      name: 'house',
      done: () => state.houseBuilt,
      run: async () => {
        const door = S.findExistingDoor(bot);
        if (door) {
          state.home = door.position;
          state.houseBuilt = true;
          log('Found my house (a door nearby), skipping building');
          return true;
        }
        await S.collect(ctx, ['stone'], 80, () => S.buildCount(bot), { maxDistance: 48 });
        if (S.buildCount(bot) < 72) {
          await S.collect(ctx, ['dirt', 'grass_block'], 80, () => S.buildCount(bot), { canDig: false, maxDistance: 32 });
        }
        if (S.buildCount(bot) < 72) return false;
        await S.ensurePlanks(ctx, 6).catch(() => {});
        const site = S.findBuildSite(bot);
        if (!site) return false;
        log(`Building a house at ${site.x}, ${site.y + 1}, ${site.z}`);
        const ok = await S.buildHouse(ctx, site);
        if (ok) {
          state.home = bot.entity.position.clone();
          state.houseBuilt = true;
          log('House finished');
        }
        return ok;
      },
    },
    {
      name: 'iron gear',
      done: () => missingIron().length === 0,
      run: async () => {
        const missing = missingIron();
        const ingotsNeeded = missing.reduce((sum, n) => sum + S.COST[n].iron, 0) + (have('shield') ? 0 : 1);
        const stock = () => have('raw_iron') + have('iron_ingot');
        if (stock() < ingotsNeeded) {
          // fuel first: coal if there is some, wood otherwise
          if (have('coal') + have('charcoal') < 4 && S.countWhere(bot, S.isLog) < 12) {
            await S.collect(ctx, COAL_ORES, 4, () => have('coal'), { maxDistance: 64 });
            if (have('coal') < 2) await S.collect(ctx, LOG_NAMES, 12, () => S.countWhere(bot, S.isLog), { canDig: false, maxAbove: 3 });
          }
          await S.collect(ctx, IRON_ORES, ingotsNeeded, stock, { maxDistance: 100 });
        }
        if (have('raw_iron') > 0) await S.smelt(ctx, 'raw_iron', 'iron_ingot', have('raw_iron'));
        for (const name of missing) {
          if (have('iron_ingot') >= S.COST[name].iron) await S.craftTool(ctx, name);
        }
        if (have('shield') === 0 && have('iron_ingot') >= 1) await S.craftTool(ctx, 'shield');
        await gear.equipBestArmor(bot);
        const shield = bot.inventory.items().find((i) => i.name === 'shield');
        if (shield) { try { await bot.equip(shield, 'off-hand'); } catch (_) {} }
        return missingIron().length === 0;
      },
    },
  ];

  // ---------------- main loop ----------------
  const fails = {};
  const skipUntil = {};

  async function idleStep() {
    // nothing left to do: hang around home, jumping about
    const base = state.home || bot.entity.position;
    const x = base.x + (Math.random() * 12 - 6);
    const z = base.z + (Math.random() * 12 - 6);
    await S.gotoGoal(ctx, new goals.GoalNear(x, base.y, z, 1), 15000);
    await S.sleep(5000);
  }

  async function mainLoop() {
    try { if (bot.waitForChunksToLoad) await bot.waitForChunksToLoad(); } catch (_) {}
    await S.sleep(3000);
    log('Brain started. Working through: wood -> stone -> food -> house -> iron gear');
    while (!state.stopped) {
      try {
        if (!bot.entity || bot.health <= 0) { await S.sleep(2000); continue; }
        const now = Date.now();
        const stage = STAGES.find((s) => !s.done() && !((skipUntil[s.name] || 0) > now));
        if (!stage) { await idleStep(); continue; }
        log(`Stage: ${stage.name}`);
        currentStage = stage.name;
        const ok = await stage.run();
        if (ok) {
          fails[stage.name] = 0;
          log(`Stage done: ${stage.name}`);
        } else {
          fails[stage.name] = (fails[stage.name] || 0) + 1;
          log(`Stage not finished: ${stage.name} (try ${fails[stage.name]})`);
          if (fails[stage.name] >= 3) {
            skipUntil[stage.name] = Date.now() + 10 * 60 * 1000;
            fails[stage.name] = 0;
            log(`Skipping "${stage.name}" for 10 minutes`);
          }
          await S.sleep(3000);
        }
      } catch (e) {
        if (e && e.message === 'STOPPED') return;
        log(`Error: ${e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : e}`);
        await S.sleep(3000);
      }
    }
  }

  // one short status line every 30s so the log is easy to read
  timers.push(setInterval(() => {
    try {
      log(`status | stage=${currentStage} | hp=${bot.health} food=${bot.food} | logs=${S.countWhere(bot, S.isLog)} planks=${S.countWhere(bot, S.isPlanks)} cobble=${S.countWhere(bot, S.isCobble)} meat=${gear.foodCount(bot)} | pick=${S.toolTier(bot, 'pickaxe')} sword=${S.toolTier(bot, 'sword')} ironArmor=${gear.hasIronArmor(bot) ? 'yes' : 'no'}`);
    } catch (_) {}
  }, 30000));

  mainLoop();

  return {
    stop() {
      state.stopped = true;
      for (const t of timers) clearInterval(t);
    },
  };
}

module.exports = { startBrain };
