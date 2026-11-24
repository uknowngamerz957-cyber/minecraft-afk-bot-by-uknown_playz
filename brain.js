// brain.js - 3x fast 6-stage pipeline with chest looting, haybale bread & wider tree search
const { Movements, goals } = require('mineflayer-pathfinder');
const { Vec3 } = require('vec3');
const gear = require('./gear');
const S = require('./skills');

const ATTACK_RANGE = 10;
const CREEPER_FLEE_DIST = 7;
const FLEE_HEALTH = 8;

const LOG_NAMES = [
  'oak_log', 'birch_log', 'spruce_log', 'jungle_log',
  'acacia_log', 'dark_oak_log', 'mangrove_log', 'cherry_log', 'pale_oak_log',
];
const IRON_ORES = ['iron_ore', 'deepslate_iron_ore'];
const DIAMOND_ORES = ['diamond_ore', 'deepslate_diamond_ore'];
const COAL_ORES = ['coal_ore', 'deepslate_coal_ore'];
const HOUSE_MAT_NAMES = ['cobblestone', 'cobbled_deepslate', 'stone', 'oak_log', 'birch_log', 'spruce_log', 'dirt'];
const SCAFFOLD_NAMES = ['dirt', 'cobblestone', 'cobbled_deepslate', 'andesite', 'diorite', 'granite'];
const HOSTILE_NAMES = [
  'zombie', 'skeleton', 'creeper', 'spider', 'cave_spider', 'witch', 'enderman',
  'husk', 'stray', 'drowned', 'phantom', 'pillager', 'vindicator', 'slime',
  'blaze', 'ghast', 'zombie_villager', 'silverfish', 'bogged', 'breeze',
];

function createExpiringBadBlocks(ttlMs = 20000) {
  const map = new Map();
  return {
    has(k) {
      const exp = map.get(k);
      if (!exp) return false;
      if (Date.now() > exp) { map.delete(k); return false; }
      return true;
    },
    add(k) { map.set(k, Date.now() + ttlMs); },
    prune() {
      const now = Date.now();
      for (const [k, exp] of map) if (now > exp) map.delete(k);
    },
  };
}

function startBrain(bot, cfg, log) {
  const movements = new Movements(bot);
  movements.canDig = true;
  movements.allow1by1towers = true;
  movements.scafoldingBlocks = SCAFFOLD_NAMES
    .map((n) => bot.registry.itemsByName[n])
    .filter(Boolean)
    .map((i) => i.id);
  bot.pathfinder.setMovements(movements);
  bot.pathfinder.thinkTimeout = 1200;

  const state = {
    combat: false,
    digging: false,
    stopped: false,
    badBlocks: createExpiringBadBlocks(20000),
    rescue: false,
    waiting: false,
    houseMatsDone: false,
  };
  const ctx = { bot, log, movements, state };

  const HITS_TO_FIGHT = cfg.hitsToFight || 2;
  const timers = [];
  const ignore = new Map();
  const fightStart = new Map();
  const hits = new Map();
  let enemy = null;
  let followId = null;
  let lastAttack = 0;
  let lastHealth = bot.health;

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
      if (Math.abs(e.position.y - me.y) > 8) continue;
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
            enemy = { name: attacker.username, until: now + 60000 };
          }
        }
      }
    } catch (_) {}
    lastHealth = bot.health;
  });

  function aimSmooth(targetVec) {
    if (!bot || !bot.entity || !targetVec) return;
    bot.lookAt(targetVec, false).catch(() => {});
  }

  function stopMelee() {
    for (const c of ['forward', 'back', 'left', 'right', 'jump']) bot.setControlState(c, false);
  }

  function flee(from) {
    state.combat = true;
    if (followId !== 'flee:' + from.id) {
      stopMelee();
      followId = 'flee:' + from.id;
      bot.setControlState('sprint', true);
      const p = bot.entity.position;
      const dx = p.x - from.position.x;
      const dz = p.z - from.position.z;
      const len = Math.hypot(dx, dz) || 1;
      bot.pathfinder.setGoal(new goals.GoalXZ(p.x + (dx / len) * 24, p.z + (dz / len) * 24));
    }
  }

  function fight(target) {
    state.combat = true;
    if (gear.isEating()) return;
    gear.equipBestWeapon(bot).catch(() => {});
    const dist = bot.entity.position.distanceTo(target.position);
    const now = Date.now();

    if (dist > 4.2) {
      if (followId !== 'chase:' + target.id) {
        stopMelee();
        followId = 'chase:' + target.id;
        bot.pathfinder.setGoal(new goals.GoalFollow(target, 2), true);
      }
      bot.setControlState('sprint', true);
      return;
    }

    if (followId !== 'melee:' + target.id) {
      bot.pathfinder.setGoal(null);
      followId = 'melee:' + target.id;
    }
    aimSmooth(target.position.offset(0, (target.height || 1.6) * 0.85, 0));
    bot.setControlState('forward', dist > 2.2);
    bot.setControlState('sprint', dist > 2.2);
    bot.setControlState('back', dist < 1.3);
    if (dist < 3.4 && now - lastAttack > gear.weaponCooldown(bot) + 10) {
      lastAttack = now;
      try { bot.attack(target); } catch (_) {}
    }
  }

  function combatTick() {
    if (state.stopped || !bot.entity) return;
    if (gear.isEating()) return;
    const now = Date.now();
    const lowHealth = bot.health !== undefined && bot.health <= FLEE_HEALTH;

    if (enemy && now > enemy.until) enemy = null;
    if (enemy) {
      const rec = bot.players[enemy.name];
      const target = rec && rec.entity;
      if (target && bot.entity.position.distanceTo(target.position) < 35) {
        const ready = gear.hasIronArmor(bot) && gear.bestWeapon(bot) && bot.health > 6;
        return ready ? fight(target) : flee(target);
      }
      enemy = null;
    }

    const close = nearestHostile(CREEPER_FLEE_DIST);
    if (close && close.name === 'creeper') return flee(close);

    const mob = nearestHostile(ATTACK_RANGE);
    if (mob) {
      if (lowHealth) return flee(mob);
      if (!fightStart.has(mob.id)) fightStart.set(mob.id, now);
      if (now - fightStart.get(mob.id) > 14000) {
        ignore.set(mob.id, now + 20000);
        fightStart.delete(mob.id);
        return;
      }
      return fight(mob);
    }

    if (state.combat) {
      state.combat = false;
      followId = null;
      stopMelee();
      bot.setControlState('sprint', false);
      bot.pathfinder.setGoal(null);
    }
  }

  async function climbOutOfHole() {
    if (!bot.entity || state.digging) return false;
    const base = bot.entity.position.floored();
    const above = bot.blockAt(base.offset(0, 2, 0));
    if (above && above.boundingBox === 'block' && !/bedrock|chest|furnace|crafting_table|water|lava/.test(above.name)) {
      try { state.digging = true; await bot.dig(above, true); } catch (_) {} finally { state.digging = false; }
    }
    const scaffoldName = SCAFFOLD_NAMES.find((n) => S.itemCount(bot, n) > 0);
    const below = bot.blockAt(base.offset(0, -1, 0));
    if (scaffoldName && below && below.boundingBox === 'block') {
      const item = bot.inventory.items().find((i) => i.name === scaffoldName);
      if (item) {
        try {
          await bot.equip(item, 'hand');
          bot.setControlState('jump', true);
          await S.sleep(70);
          await bot.placeBlock(below, new Vec3(0, 1, 0));
          bot.setControlState('jump', false);
          await S.sleep(70);
          return true;
        } catch (_) {
          bot.setControlState('jump', false);
        }
      }
    }
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      for (const dy of [1, 2]) {
        const wall = bot.blockAt(base.offset(dx, dy, dz));
        if (wall && wall.boundingBox === 'block' && !/bedrock|chest|furnace|crafting_table|water|lava/.test(wall.name)) {
          try { state.digging = true; await bot.dig(wall, true); } catch (_) {} finally { state.digging = false; }
        }
      }
      try { await bot.lookAt(base.offset(dx + 0.5, 1.5, dz + 0.5), false); } catch (_) {}
      bot.setControlState('forward', true);
      bot.setControlState('sprint', true);
      bot.setControlState('jump', true);
      await S.sleep(300);
      stopMelee();
      bot.setControlState('sprint', false);
      if (bot.entity.position.y > base.y + 0.4 || bot.entity.position.distanceTo(base.offset(0.5, 0, 0.5)) > 1.2) return true;
    }
    return false;
  }

  timers.push(setInterval(combatTick, 200));
  timers.push(setInterval(() => { gear.eatIfNeeded(bot).catch(() => {}); }, 600));
  timers.push(setInterval(() => { gear.equipBestArmor(bot).catch(() => {}); }, 2500));

  let lastPos = null;
  let lastMoveAt = Date.now();
  let stuckCount = 0;
  timers.push(setInterval(async () => {
    try {
      if (!bot.entity || state.stopped || bot.health <= 0 || state.rescue) return;
      const now = Date.now();
      const p = bot.entity.position;
      if (!lastPos || p.distanceTo(lastPos) > 0.6) { lastPos = p.clone(); lastMoveAt = now; stuckCount = 0; return; }
      if (state.waiting || gear.isEating()) { lastMoveAt = now; return; }
      const inWater = S.isInWater(bot);
      const onLeaves = S.isOnLeaves(bot);
      const limit = inWater || onLeaves ? 2000 : 3000;
      if (now - lastMoveAt < limit) return;
      stuckCount++;
      lastMoveAt = Date.now();
      state.rescue = true;
      state.digging = false;
      bot.pathfinder.setGoal(null);
      stopMelee();
      if (inWater) await S.escapeWater(ctx);
      else if (onLeaves) await S.descendFromLeaves(ctx);
      else {
        await climbOutOfHole();
        await S.wiggle(ctx);
        if (stuckCount >= 2 && !state.combat) await S.explore(ctx, 36);
      }
    } catch (e) {
      if (!(e && e.message === 'STOPPED')) log(`unstuck error: ${e && e.message}`);
    } finally {
      state.rescue = false;
    }
  }, 1200));

  timers.push(setInterval(() => {
    const now = Date.now();
    for (const [id, t] of ignore) if (t < now) ignore.delete(id);
    if (state.badBlocks && typeof state.badBlocks.prune === 'function') state.badBlocks.prune();
  }, 20000));

  const have = (n) => S.itemCount(bot, n);
  const logsWorth = () => S.countWhere(bot, S.isLog) + Math.floor(S.countWhere(bot, S.isPlanks) / 4);
  const stonePool = () => S.countWhere(bot, S.isCobble) + have('stone');
  const rawOrCookedFood = () => gear.foodCount(bot) + have('beef') + have('porkchop') + have('mutton') + have('chicken') + have('rabbit');

  function missingIron() {
    const m = [];
    if (S.toolTier(bot, 'pickaxe') < 3) m.push('iron_pickaxe');
    if (S.toolTier(bot, 'axe') < 3) m.push('iron_axe');
    if (S.toolTier(bot, 'sword') < 3) m.push('iron_sword');
    for (const piece of ['helmet', 'chestplate', 'leggings', 'boots']) {
      if (!S.hasArmorPiece(bot, piece, 3)) m.push('iron_' + piece);
    }
    return m;
  }

  function missingDiamond() {
    const m = [];
    if (S.toolTier(bot, 'pickaxe') < 4) m.push('diamond_pickaxe');
    if (S.toolTier(bot, 'axe') < 4) m.push('diamond_axe');
    if (S.toolTier(bot, 'sword') < 4) m.push('diamond_sword');
    for (const piece of ['helmet', 'chestplate', 'leggings', 'boots']) {
      if (!S.hasArmorPiece(bot, piece, 4)) m.push('diamond_' + piece);
    }
    return m;
  }

  const STAGES = [
    {
      name: '1. wood + wooden pickaxe',
      done: () => S.toolTier(bot, 'pickaxe') >= 1,
      run: async () => {
        await S.lootChests(ctx, 48, 4).catch(() => {});
        await S.craftBreadFromHay(ctx, 4).catch(() => {});
        if (logsWorth() < 6) {
          await S.collect(ctx, LOG_NAMES, 8, logsWorth, { canDig: true, maxAbove: 8, maxDistance: 64 });
        }
        if (logsWorth() < 3) {
          await S.explore(ctx, 45);
          return false;
        }
        const ok = await S.craftTool(ctx, 'wooden_pickaxe');
        await S.craftAllAvailable(ctx).catch(() => {});
        await gear.equipBestWeapon(bot);
        return ok || S.toolTier(bot, 'pickaxe') >= 1;
      },
    },
    {
      name: '2. 32 stone + stone axe, sword, pickaxe',
      done: () => S.toolTier(bot, 'axe') >= 2 && S.toolTier(bot, 'sword') >= 2 && S.toolTier(bot, 'pickaxe') >= 2,
      run: async () => {
        await S.lootChests(ctx, 48, 4).catch(() => {});
        if (stonePool() < 32) {
          await S.collect(ctx, ['stone', 'cobblestone', 'cobbled_deepslate'], 32, stonePool, { maxDistance: 56 });
        }
        if (S.toolTier(bot, 'pickaxe') < 2) await S.craftTool(ctx, 'stone_pickaxe');
        if (S.toolTier(bot, 'axe') < 2) await S.craftTool(ctx, 'stone_axe');
        if (S.toolTier(bot, 'sword') < 2) await S.craftTool(ctx, 'stone_sword');
        await S.craftAllAvailable(ctx).catch(() => {});
        await gear.equipBestWeapon(bot);
        return S.toolTier(bot, 'axe') >= 2 && S.toolTier(bot, 'sword') >= 2 && S.toolTier(bot, 'pickaxe') >= 2;
      },
    },
    {
      name: '3. food + furnace + cook food',
      done: () => gear.foodCount(bot) >= 4 && (have('furnace') > 0 || !!bot.findBlock({ matching: bot.registry.blocksByName.furnace.id, maxDistance: 24 })),
      run: async () => {
        await S.lootChests(ctx, 48, 5).catch(() => {});
        await S.craftBreadFromHay(ctx, 6).catch(() => {});
        if (rawOrCookedFood() < 4) {
          await S.hunt(ctx, 4);
        }
        if (have('furnace') === 0) {
          if (stonePool() < 8) {
            await S.collect(ctx, ['stone', 'cobblestone', 'cobbled_deepslate'], 8, stonePool, { maxDistance: 48 });
          }
          await S.craftTool(ctx, 'furnace');
        }
        await S.cookMeat(ctx);
        return gear.foodCount(bot) >= 4;
      },
    },
    {
      name: '4. find iron + iron gear',
      done: () => missingIron().length === 0,
      run: async () => {
        await S.lootChests(ctx, 48, 5).catch(() => {});
        const missing = missingIron();
        const ingotsNeeded = missing.reduce((sum, n) => sum + (S.COST[n] ? S.COST[n].iron || 0 : 0), 0);
        const stock = () => have('raw_iron') + have('iron_ingot');
        if (stock() < ingotsNeeded) {
          if (have('coal') + have('charcoal') < 4 && S.countWhere(bot, S.isLog) < 8) {
            await S.collect(ctx, COAL_ORES, 4, () => have('coal'), { maxDistance: 56 });
          }
          await S.collect(ctx, IRON_ORES, ingotsNeeded, stock, { maxDistance: 84 });
        }
        if (have('raw_iron') > 0) await S.smelt(ctx, 'raw_iron', 'iron_ingot', have('raw_iron'));
        for (const name of missing) {
          if (have('iron_ingot') >= (S.COST[name].iron || 0)) await S.craftTool(ctx, name);
        }
        await S.craftAllAvailable(ctx).catch(() => {});
        await gear.equipBestArmor(bot);
        await gear.equipBestWeapon(bot);
        return missingIron().length === 0;
      },
    },
    {
      name: '5. collect house materials',
      done: () => state.houseMatsDone || S.countWhere(bot, (n) => HOUSE_MAT_NAMES.includes(n)) >= 48,
      run: async () => {
        await S.lootChests(ctx, 48, 4).catch(() => {});
        const haveMats = () => S.countWhere(bot, (n) => HOUSE_MAT_NAMES.includes(n));
        if (haveMats() < 48) {
          await S.collect(ctx, ['stone', 'cobblestone', 'cobbled_deepslate', 'dirt'], 48, haveMats, { canDig: true, maxDistance: 56 });
        }
