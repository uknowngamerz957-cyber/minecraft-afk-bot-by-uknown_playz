// brain.js - fast progression brain: wood -> stone -> food -> house -> iron -> diamond -> enchant

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
const SCAFFOLD_NAMES = ['dirt', 'cobblestone', 'cobbled_deepslate', 'netherrack', 'andesite', 'diorite', 'granite'];
const HOSTILE_NAMES = [
  'zombie', 'skeleton', 'creeper', 'spider', 'cave_spider', 'witch', 'enderman', 'husk', 'stray', 'drowned',
  'phantom', 'pillager', 'vindicator', 'slime', 'blaze', 'ghast', 'zombie_villager', 'silverfish', 'bogged', 'breeze',
];

function createExpiringBadBlocks(ttlMs = 25000) {
  const map = new Map();
  return {
    has(k) {
      const exp = map.get(k);
      if (!exp) return false;
      if (Date.now() > exp) {
        map.delete(k);
        return false;
      }
      return true;
    },
    add(k) {
      map.set(k, Date.now() + ttlMs);
    },
    prune() {
      const now = Date.now();
      for (const [k, exp] of map) {
        if (now > exp) map.delete(k);
      }
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
  bot.pathfinder.thinkTimeout = 3000;

  const state = {
    combat: false,
    digging: false,
    stopped: false,
    badBlocks: createExpiringBadBlocks(25000),
    home: null,
    houseBuilt: false,
    enchantedDone: false,
    rescue: false,
    waiting: false,
    loot: null,
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
            if (!enemy || enemy.name !== attacker.username) {
              log(`${attacker.username} hit me ${list.length}x, they are an enemy now`);
            }
            enemy = { name: attacker.username, until: now + 60000 };
          }
        }
      }
    } catch (_) {}
    lastHealth = bot.health;
  });

  function aimSmooth(targetVec) {
    if (!bot || !bot.entity || !targetVec) return;
    const jittered = targetVec.offset(
      (Math.random() - 0.5) * 0.1,
      (Math.random() - 0.5) * 0.08,
      (Math.random() - 0.5) * 0.1
    );
    bot.lookAt(jittered, false).catch(() => {});
  }

  function hasShield() {
    try {
      const o = bot.inventory.slots[bot.getEquipmentDestSlot('off-hand')];
      return !!o && o.name === 'shield';
    } catch (_) { return false; }
  }
  function shieldUp() {
    if (gear.isEating() || !hasShield() || bot.usingHeldItem) return;
    try { bot.activateItem(true); } catch (_) {}
  }
  function shieldDown() {
    if (!bot.usingHeldItem) return;
    try { bot.deactivateItem(); } catch (_) {}
  }
  async function equipShield() {
    if (hasShield()) return;
    const s = bot.inventory.items().find((i) => i.name === 'shield');
    if (s) { try { await bot.equip(s, 'off-hand'); } catch (_) {} }
  }

  let strafeDir = 1;
  let strafeUntil = 0;
  let lastFleeSet = 0;
  function stopMelee() {
    for (const c of ['forward', 'back', 'left', 'right', 'jump']) bot.setControlState(c, false);
  }

  function flee(from) {
    state.combat = true;
    shieldDown();
    const now = Date.now();
    const moving = typeof bot.pathfinder.isMoving === 'function' ? bot.pathfinder.isMoving() : true;
    if (followId !== 'flee:' + from.id || (!moving && now - lastFleeSet > 1200)) {
      if (followId !== 'flee:' + from.id) stopMelee();
      followId = 'flee:' + from.id;
      lastFleeSet = now;
      bot.setControlState('sprint', true);
      const p = bot.entity.position;
      const dx = p.x - from.position.x;
      const dz = p.z - from.position.z;
      const len = Math.hypot(dx, dz) || 1;
      bot.pathfinder.setGoal(new goals.GoalXZ(p.x + (dx / len) * 22, p.z + (dz / len) * 22));
    }
  }

  function fight(target) {
    state.combat = true;
    if (gear.isEating()) {
      shieldDown();
      return;
    }
    gear.equipBestWeapon(bot).catch(() => {});
    const dist = bot.entity.position.distanceTo(target.position);
    const now = Date.now();

    if (dist > 4.5) {
      if (followId !== 'chase:' + target.id) {
        stopMelee();
        followId = 'chase:' + target.id;
        bot.pathfinder.setGoal(new goals.GoalFollow(target, 2), true);
      }
      bot.setControlState('sprint', true);
      shieldDown();
      return;
    }

    if (followId !== 'melee:' + target.id) {
      bot.pathfinder.setGoal(null);
      followId = 'melee:' + target.id;
    }
    aimSmooth(target.position.offset(0, (target.height || 1.6) * 0.85, 0));
    bot.setControlState('forward', dist > 2.3);
    bot.setControlState('sprint', dist > 2.3);
    bot.setControlState('back', dist < 1.3);
    if (now > strafeUntil) {
      strafeDir = Math.random() < 0.5 ? -1 : 1;
      strafeUntil = now + 450 + Math.random() * 600;
    }
    bot.setControlState('left', strafeDir < 0 && dist < 3.5);
    bot.setControlState('right', strafeDir > 0 && dist < 3.5);
    if (bot.entity.onGround && Math.random() < 0.1) {
      bot.setControlState('jump', true);
      setTimeout(() => { try { bot.setControlState('jump', false); } catch (_) {} }, 120);
    }
    if (dist < 3.3 && now - lastAttack > gear.weaponCooldown(bot) + 25) {
      lastAttack = now;
      try { bot.attack(target); } catch (_) {}
    }
    shieldUp();
  }

  function combatTick() {
    if (state.stopped || !bot.entity) return;
    if (gear.isEating()) {
      shieldDown();
      return;
    }
    const now = Date.now();
    const lowHealth = bot.health !== undefined && bot.health <= FLEE_HEALTH;

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

    const close = nearestHostile(CREEPER_FLEE_DIST);
    if (close && close.name === 'creeper') return flee(close);

    const mob = nearestHostile(ATTACK_RANGE);
    if (mob) {
      if (lowHealth) return flee(mob);
      if (!fightStart.has(mob.id)) fightStart.set(mob.id, now);
      if (now - fightStart.get(mob.id) > 18000) {
        ignore.set(mob.id, now + 30000);
        fightStart.delete(mob.id);
        return;
      }
      return fight(mob);
    }

    if (state.combat) {
      state.combat = false;
      followId = null;
      stopMelee();
      shieldDown();
      bot.setControlState('sprint', false);
      bot.pathfinder.setGoal(null);
    }
  }

  async function climbOutOfHole() {
    if (!bot.entity || state.digging) return false;
    const base = bot.entity.position.floored();

    const above = bot.blockAt(base.offset(0, 2, 0));
    if (above && above.boundingBox === 'block' && !/bedrock|chest|furnace|crafting_table|water|lava/.test(above.name)) {
      try {
        state.digging = true;
        await bot.dig(above, true);
      } catch (_) {
      } finally {
        state.digging = false;
      }
    }

    const scaffoldName = SCAFFOLD_NAMES.find((n) => S.itemCount(bot, n) > 0);
    const below = bot.blockAt(base.offset(0, -1, 0));
    if (scaffoldName && below && below.boundingBox === 'block') {
      const item = bot.inventory.items().find((i) => i.name === scaffoldName);
      if (item) {
        try {
          await bot.equip(item, 'hand');
          bot.setControlState('jump', true);
          await S.sleep(150);
          await bot.placeBlock(below, new Vec3(0, 1, 0));
          bot.setControlState('jump', false);
          await S.sleep(150);
          return true;
        } catch (_) {
          bot.setControlState('jump', false);
        }
      }
    }

    const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];
    for (const [dx, dz] of dirs) {
      for (const dy of [1, 2]) {
        const wall = bot.blockAt(base.offset(dx, dy, dz));
        if (wall && wall.boundingBox === 'block' && !/bedrock|chest|furnace|crafting_table|water|lava/.test(wall.name)) {
          try {
            state.digging = true;
            await bot.dig(wall, true);
          } catch (_) {
          } finally {
            state.digging = false;
          }
        }
      }
      try { await bot.lookAt(base.offset(dx + 0.5, 1.5, dz + 0.5), false); } catch (_) {}
      bot.setControlState('forward', true);
      bot.setControlState('sprint', true);
      bot.setControlState('jump', true);
      await S.sleep(550);
      stopMelee();
      bot.setControlState('sprint', false);
      if (bot.entity.position.y > base.y + 0.4 || bot.entity.position.distanceTo(base.offset(0.5, 0, 0.5)) > 1.2) {
        return true;
      }
    }
    return false;
  }

  timers.push(setInterval(combatTick, 350));
  timers.push(setInterval(() => { gear.eatIfNeeded(bot).catch(() => {}); }, 1000));
  timers.push(setInterval(() => {
    gear.equipBestArmor(bot).then(() => equipShield()).catch(() => {});
  }, 5000));

  let lastPos = null;
  let lastMoveAt = Date.now();
  let stuckCount = 0;
  timers.push(setInterval(async () => {
    try {
      if (!bot.entity || state.stopped || bot.health <= 0 || state.rescue) return;
      const now = Date.now();
      const p = bot.entity.position;
      const moved = !lastPos || p.distanceTo(lastPos) > 0.7;
      if (moved) { lastPos = p.clone(); lastMoveAt = now; stuckCount = 0; return; }
      if (state.waiting || gear.isEating()) { lastMoveAt = now; return; }

      const inWater = S.isInWater(bot);
      const onLeaves = S.isOnLeaves(bot);
      const limit = inWater || onLeaves ? 4500 : 7500;
      if (now - lastMoveAt < limit) return;

      stuckCount++;
      lastMoveAt = Date.now();
      state.rescue = true;
      state.digging = false;
      bot.pathfinder.setGoal(null);
      stopMelee();

      if (inWater) {
        log(`Stuck in water (${stuckCount}), swimming to land`);
        await S.escapeWater(ctx);
      } else if (onLeaves) {
        log(`Stuck on tree leaves (${stuckCount}), climbing down`);
        await S.descendFromLeaves(ctx);
      } else {
        log(`Stuck (${stuckCount}), climbing/moving out`);
        await climbOutOfHole();
        await S.wiggle(ctx);
        if (stuckCount >= 2 && !state.combat) await S.explore(ctx, 18);
      }
    } catch (e) {
      if (!(e && e.message === 'STOPPED')) log(`unstuck error: ${e && e.message}`);
    } finally {
      state.rescue = false;
    }
  }, 2000));

  timers.push(setInterval(() => {
    const now = Date.now();
    for (const [id, t] of ignore) if (t < now) ignore.delete(id);
    if (state.badBlocks && typeof state.badBlocks.prune === 'function') state.badBlocks.prune();
  }, 25000));

  if (cfg.jumpWhileMoving !== false) {
    timers.push(setInterval(() => {
      try {
        const moving = typeof bot.pathfinder.isMoving === 'function' ? bot.pathfinder.isMoving() : false;
        if (!moving || state.digging || gear.isEating() || !bot.entity || !bot.entity.onGround) return;
        if (Math.random() > 0.55) return;
        const ceiling = bot.blockAt(bot.entity.position.floored().offset(0, 2, 0));
        if (ceiling && ceiling.boundingBox === 'block') return;
        bot.setControlState('jump', true);
        setTimeout(() => { try { bot.setControlState('jump', false); } catch (_) {} }, 130);
      } catch (_) {}
    }, 1200));
  }

  bot.on('death', () => {
    const p = bot.entity && bot.entity.position;
    const hadItems = bot.inventory.items().length > 0;
    if (p && hadItems) {
      state.loot = { pos: p.clone(), tries: 0, expires: Date.now() + 4.5 * 60 * 1000 };
      log(`I died at ${p.x.toFixed(0)}, ${p.y.toFixed(0)}, ${p.z.toFixed(0)}. Trying to recover loot`);
    } else {
      log('I died, continuing');
    }
    state.combat = false;
    state.rescue = false;
    followId = null;
    enemy = null;
    stopMelee();
  });

  const have = (n) => S.itemCount(bot, n);
  const logsWorth = () => S.countWhere(bot, S.isLog) + Math.floor(S.countWhere(bot, S.isPlanks) / 4);

  function missingIron() {
    const m = [];
    if (S.toolTier(bot, 'pickaxe') < 3) m.push('iron_pickaxe');
    if (S.toolTier(bot, 'sword') < 3) m.push('iron_sword');
    for (const piece of ['helmet', 'chestplate', 'leggings', 'boots']) {
      if (!S.hasArmorPiece(bot, piece, 3)) m.push('iron_' + piece);
    }
    return m;
  }

  function missingDiamond() {
    const m = [];
    if (S.toolTier(bot, 'pickaxe') < 4) m.push('diamond_pickaxe');
    if (S.toolTier(bot, 'sword') < 4) m.push('diamond_sword');
    for (const piece of ['helmet', 'chestplate', 'leggings', 'boots']) {
      if (!S.hasArmorPiece(bot, piece, 4)) m.push('diamond_' + piece);
    }
    return m;
  }

  let currentStage = 'starting';
  const invCount = () => bot.inventory.items().reduce((a, i) => a + i.count, 0);

  const STAGES = [
    {
      name: 'recover loot',
      done: () => !state.loot || state.loot.tries >= 3 || Date.now() > state.loot.expires,
      run: async () => {
        const loot = state.loot;
        loot.tries++;
        const before = invCount();
        await S.gotoGoal(ctx, new goals.GoalNear(loot.pos.x, loot.pos.y, loot.pos.z, 3), 25000);
        await S.pickupDrops(ctx, 16);
        await gear.equipBestArmor(bot);
        await gear.equipBestWeapon(bot);
        await equipShield();
        if (invCount() - before > 0 || loot.tries >= 3) {
          state.loot = null;
          return true;
        }
        return false;
      },
    },
    {
      name: 'emergency food',
      done: () => gear.foodCount(bot) > 0 || ((bot.food === undefined || bot.food >= 14) && bot.health > 8),
      run: async () => {
        await S.hunt(ctx, 2);
        await S.cookMeat(ctx);
        return gear.foodCount(bot) > 0;
      },
    },
    {
      name: 'wood + wooden pickaxe',
      done: () => S.toolTier(bot, 'pickaxe') >= 1,
      run: async () => {
        if (logsWorth() < 8) {
          await S.collect(ctx, LOG_NAMES, 10, logsWorth, { canDig: true, maxAbove: 6, maxDistance: 40 });
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
        await S.collect(ctx, ['stone'], 16, () => S.countWhere(bot, S.isCobble), { maxDistance: 36 });
        await S.craftTool(ctx, 'stone_pickaxe');
        await S.craftTool(ctx, 'stone_sword');
        if (S.toolTier(bot, 'axe') < 2) await S.craftTool(ctx, 'stone_axe');
        if (have('furnace') === 0) await S.craftTool(ctx, 'furnace');
        return S.toolTier(bot, 'pickaxe') >= 2 && S.toolTier(bot, 'sword') >= 2;
      },
    },
    {
      name: 'food',
      done: () => gear.foodCount(bot) >= 3,
      run: async () => {
        await S.hunt(ctx, 4);
        await S.cookMeat(ctx);
        return gear.foodCount(bot) >= 3;
      },
    },
    {
      name: 'base house',
      done: () => state.houseBuilt,
      run: async () => {
        const door = S.findExistingDoor(bot);
        if (door) {
          state.home = door.position;
          state.houseBuilt = true;
          log('Found existing base door');
          return true;
        }
        await S.collect(ctx, ['stone'], 36, () => S.buildCount(bot), { maxDistance: 36 });
        if (S.buildCount(bot) < 30) {
          await S.collect(ctx, ['dirt', 'grass_block'], 36, () => S.buildCount(bot), { canDig: true, maxDistance: 28 });
        }
        if (S.buildCount(bot) < 30) return false;
        await S.ensurePlanks(ctx, 4).catch(() => {});
        const site = S.findBuildSite(bot);
        if (!site) return false;
        log(`Building fast base at ${site.x}, ${site.y + 1}, ${site.z}`);
        const ok = await S.buildHouse(ctx, site);
        if (ok) {
          state.home = bot.entity.position.clone();
          state.houseBuilt = true;
          log('Base finished');
        }
        return ok;
      },
    },
    {
      name: 'iron gear',
      done: () => missingIron().length === 0,
      run: async () => {
        const missing = missingIron();
        const ingotsNeeded = missing.reduce((sum, n) => sum + (S.COST[n] ? S.COST[n].iron || 0 : 0), 0) + (have('shield') ? 0 : 1);
        const stock = () => have('raw_iron') + have('iron_ingot');
        if (stock() < ingotsNeeded) {
          if (have('coal') + have('charcoal') < 3 && S.countWhere(bot, S.isLog) < 8) {
            await S.collect(ctx, COAL_ORES, 3, () => have('coal'), { maxDistance: 48 });
            if (have('coal') < 2) await S.collect(ctx, LOG_NAMES, 8, () => S.countWhere(bot, S.isLog), { canDig: true, maxAbove: 6, maxDistance: 40 });
          }
          await S.collect(ctx, IRON_ORES, ingotsNeeded, stock, { maxDistance: 72 });
        }
        if (have('raw_iron') > 0) await S.smelt(ctx, 'raw_iron', 'iron_ingot', have('raw_iron'));
        for (const name of missing) {
          if (have('iron_ingot') >= (S.COST[name].iron || 0)) await S.craftTool(ctx, name);
        }
        if (have('shield') === 0 && have('iron_ingot') >= 1) await S.craftTool(ctx, 'shield');
        await gear.equipBestArmor(bot);
        await gear.equipBestWeapon(bot);
        await equipShield();
        return missingIron().length === 0;
      },
    },
    {
      name: 'diamond gear',
      done: () => missingDiamond().length === 0,
      run: async () => {
        if (S.toolTier(bot, 'pickaxe') < 3) return false;
        const missing = missingDiamond();
        const diamondsNeeded = missing.reduce((sum, n) => sum + (S.COST[n] ? S.COST[n].diamond || 0 : 0), 0);
        if (have('diamond') < diamondsNeeded) {
          await S.collect(ctx, DIAMOND_ORES, diamondsNeeded, () => have('diamond'), { maxDistance: 80 });
        }
        for (const name of missing) {
          if (have('diamond') >= (S.COST[name].diamond || 0)) {
            await S.craftTool(ctx, name);
          }
        }
        await gear.equipBestArmor(bot);
        await gear.equipBestWeapon(bot);
        return missingDiamond().length === 0;
      },
    },
    {
      name: 'enchant gear',
      done: () => state.enchantedDone,
      run: async () => {
        const ok = await S.enchantGear(ctx);
        if (ok) {
          state.enchantedDone = true;
          await gear.equipBestArmor(bot);
          await gear.equipBestWeapon(bot);
        }
        return ok;
      },
    },
  ];

  const fails = {};
  const skipUntil = {};

  async function idleStep() {
    const base = state.home || bot.entity.position;
    const x = base.x + (Math.random() * 10 - 5);
    const z = base.z + (Math.random() * 10 - 5);
    await S.gotoGoal(ctx, new goals.GoalNear(x, base.y, z, 1), 10000);
    await S.sleep(3500);
  }

  async function mainLoop() {
    try { if (bot.waitForChunksToLoad) await Promise.race([bot.waitForChunksToLoad(), S.sleep(8000)]); } catch (_) {}
    await S.sleep(300);
    log('Fast brain started');
    while (!state.stopped) {
      try {
        if (!bot.entity || bot.health <= 0) { await S.sleep(1500); continue; }
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
          log(`Stage retry: ${stage.name} (try ${fails[stage.name]})`);
          if (fails[stage.name] >= 3) {
            skipUntil[stage.name] = Date.now() + 2 * 60 * 1000;
            fails[stage.name] = 0;
          }
          await climbOutOfHole();
          if (fails[stage.name] >= 2) await S.explore(ctx, 24);
          else await S.sleep(700);
        }
      } catch (e) {
        if (e && e.message === 'STOPPED') return;
        log(`Error: ${e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : e}`);
        await S.sleep(2000);
      }
    }
  }

  timers.push(setInterval(() => {
    try {
      log(`status | stage=${currentStage} | hp=${bot.health} food=${bot.food} | logs=${S.countWhere(bot, S.isLog)} cobble=${S.countWhere(bot, S.isCobble)} iron=${have('iron_ingot') + have('raw_iron')} dia=${have('diamond')} | pick=${S.toolTier(bot, 'pickaxe')} sword=${S.toolTier(bot, 'sword')} diaArmor=${gear.hasDiamondArmor(bot) ? 'yes' : 'no'}`);
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
