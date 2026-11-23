// brain.js - full progression brain with climb/unstick & mining fixes

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
const HOSTILE_NAMES = [
  'zombie', 'skeleton', 'creeper', 'spider', 'cave_spider', 'witch', 'enderman', 'husk', 'stray', 'drowned',
  'phantom', 'pillager', 'vindicator', 'slime', 'blaze', 'ghast', 'zombie_villager', 'silverfish', 'bogged', 'breeze',
];

function createExpiringBadBlocks(ttlMs = 45000) {
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
  bot.pathfinder.setMovements(movements);
  bot.pathfinder.thinkTimeout = 4500;

  const state = {
    combat: false,
    digging: false,
    stopped: false,
    badBlocks: createExpiringBadBlocks(45000),
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

  async function humanLookAt(targetVec) {
    if (!bot || !bot.entity || !targetVec) return;
    const jittered = targetVec.offset(
      (Math.random() - 0.5) * 0.14,
      (Math.random() - 0.5) * 0.12,
      (Math.random() - 0.5) * 0.14
    );
    try { await bot.lookAt(jittered, false); } catch (_) {}
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
    if (followId !== 'flee:' + from.id || (!moving && now - lastFleeSet > 1500)) {
      if (followId !== 'flee:' + from.id) stopMelee();
      followId = 'flee:' + from.id;
      lastFleeSet = now;
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
    humanLookAt(target.position.offset(0, (target.height || 1.6) * 0.85, 0));
    bot.setControlState('forward', dist > 2.3);
    bot.setControlState('sprint', dist > 2.3);
    bot.setControlState('back', dist < 1.3);
    if (now > strafeUntil) {
      strafeDir = Math.random() < 0.5 ? -1 : 1;
      strafeUntil = now + 500 + Math.random() * 700;
    }
    bot.setControlState('left', strafeDir < 0 && dist < 3.5);
    bot.setControlState('right', strafeDir > 0 && dist < 3.5);
    if (bot.entity.onGround && Math.random() < 0.1) {
      bot.setControlState('jump', true);
      setTimeout(() => { try { bot.setControlState('jump', false); } catch (_) {} }, 130);
    }
    if (dist < 3.3 && now - lastAttack > gear.weaponCooldown(bot) + 30) {
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
      if (now - fightStart.get(mob.id) > 20000) {
        ignore.set(mob.id, now + 40000);
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

  // Dig a safe block above or in front so the bot can climb out of pits/overhangs
  async function digClimbBlock() {
    if (!bot.entity || state.digging) return false;
    const base = bot.entity.position.floored();
    const candidates = [
      base.offset(0, 2, 0),
      base.offset(0, 1, 0),
      base.offset(1, 1, 0),
      base.offset(-1, 1, 0),
      base.offset(0, 1, 1),
      base.offset(0, 1, -1),
      base.offset(1, 0, 0),
      base.offset(-1, 0, 0),
      base.offset(0, 0, 1),
      base.offset(0, 0, -1),
    ];
    for (const pos of candidates) {
      const b = bot.blockAt(pos);
      if (!b || b.boundingBox !== 'block') continue;
      if (/bedrock|chest|furnace|crafting_table|water|lava|air/.test(b.name)) continue;
      try {
        state.digging = true;
        await bot.dig(b);
        return true;
      } catch (_) {
      } finally {
        state.digging = false;
      }
    }
    return false;
  }

  timers.push(setInterval(combatTick, 400));
  timers.push(setInterval(() => { gear.eatIfNeeded(bot).catch(() => {}); }, 1200));
  timers.push(setInterval(() => {
    gear.equipBestArmor(bot).then(() => equipShield()).catch(() => {});
  }, 6000));

  // Stuck detector: runs even during combat if stuck > 12s so holes/overhangs don't lock the bot
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
      if (state.waiting || state.digging || gear.isEating()) { lastMoveAt = now; return; }

      const inWater = S.isInWater(bot);
      const onLeaves = S.isOnLeaves(bot);
      const limit = state.combat ? 12000 : (inWater || onLeaves ? 6000 : 12000);
      if (now - lastMoveAt < limit) return;

      stuckCount++;
      lastMoveAt = Date.now();
      state.rescue = true;
      bot.pathfinder.setGoal(null);
      stopMelee();

      if (inWater) {
        log(`Stuck in water (${stuckCount}), swimming to land`);
        await S.escapeWater(ctx);
      } else if (onLeaves) {
        log(`Stuck on tree leaves (${stuckCount}), climbing down`);
        await S.descendFromLeaves(ctx);
      } else {
        log(`Stuck/trapped (${stuckCount}), digging/climbing free`);
        await digClimbBlock();
        await S.wiggle(ctx);
        if (stuckCount >= 2 && !state.combat) await S.explore(ctx, 20);
      }
    } catch (e) {
      if (!(e && e.message === 'STOPPED')) log(`unstuck error: ${e && e.message}`);
    } finally {
      state.rescue = false;
    }
  }, 2500));

  timers.push(setInterval(() => {
    const now = Date.now();
    for (const [id, t] of ignore) if (t < now) ignore.delete(id);
    if (state.badBlocks && typeof state.badBlocks.prune === 'function') state.badBlocks.prune();
  }, 30000));

  if (cfg.jumpWhileMoving !== false) {
    timers.push(setInterval(() => {
      try {
        const moving = typeof bot.pathfinder.isMoving === 'function' ? bot.pathfinder.isMoving() : false;
        if (!moving || state.digging || gear.isEating() || !bot.entity || !bot.entity.onGround) return;
        if (Math.random() > 0.5) return;
        const ceiling = bot.blockAt(bot.entity.position.floored().offset(0, 2, 0));
        if (ceiling && ceiling.boundingBox === 'block') return;
        bot.setControlState('jump', true);
        setTimeout(() => { try { bot.setControlState('jump', false); } catch (_) {} }, 140 + Math.floor(Math.random() * 60));
      } catch (_) {}
    }, 1400));
  }

  bot.on('death', () => {
    const p = bot.entity && bot.entity.position;
    const hadItems = bot.inventory.items().length > 0;
    if (p && hadItems) {
      state.loot = { pos: p.clone(), tries: 0, expires: Date.now() + 4.5 * 60 * 1000 };
      log(`I died at ${p.x.toFixed(0)}, ${p.y.toFixed(0)}, ${p.z.toFixed(0)}. I will try to get my stuff back (3 tries)`);
    } else {
      log('I died (nothing to recover), starting over');
    }
    state.combat = false;
    state.rescue = false;
    followId = null;
    enemy = null;
    stopMelee();
  });

  // ---------------- stages ----------------
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
        log(`Going back to where I died (try ${loot.tries}/3)`);
        await S.gotoGoal(ctx, new goals.GoalNear(loot.pos.x, loot.pos.y, loot.pos.z, 3), 60000);
        await S.pickupDrops(ctx, 16);
        await S.sleep(600);
        await S.pickupDrops(ctx, 16);
        await gear.equipBestArmor(bot);
        await gear.equipBestWeapon(bot);
        await equipShield();
        const gained = invCount() - before;
        if (gained > 0) {
          log(`Got ${gained} items back`);
          state.loot = null;
          return true;
        }
        if (loot.tries >= 3) {
          log('Could not get my loot back after 3 tries, going back to grinding');
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
          await S.collect(ctx, LOG_NAMES, 12, logsWorth, { canDig: true, maxAbove: 6 });
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
      name: 'base house',
      done: () => state.houseBuilt,
      run: async () => {
        const door = S.findExistingDoor(bot);
        if (door) {
          state.home = door.position;
          state.houseBuilt = true;
          log('Found my base (a door nearby), skipping building');
          return true;
        }
        await S.collect(ctx, ['stone'], 80, () => S.buildCount(bot), { maxDistance: 48 });
        if (S.buildCount(bot) < 72) {
          await S.collect(ctx, ['dirt', 'grass_block'], 80, () => S.buildCount(bot), { canDig: true, maxDistance: 32 });
        }
        if (S.buildCount(bot) < 72) return false;
        await S.ensurePlanks(ctx, 6).catch(() => {});
        const site = S.findBuildSite(bot);
        if (!site) return false;
        log(`Building base house at ${site.x}, ${site.y + 1}, ${site.z}`);
        const ok = await S.buildHouse(ctx, site);
        if (ok) {
          state.home = bot.entity.position.clone();
          state.houseBuilt = true;
          log('Base house finished');
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
          if (have('coal') + have('charcoal') < 4 && S.countWhere(bot, S.isLog) < 12) {
            await S.collect(ctx, COAL_ORES, 4, () => have('coal'), { maxDistance: 64 });
            if (have('coal') < 2) await S.collect(ctx, LOG_NAMES, 12, () => S.countWhere(bot, S.isLog), { canDig: true, maxAbove: 6 });
          }
          await S.collect(ctx, IRON_ORES, ingotsNeeded, stock, { maxDistance: 100 });
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
          await S.collect(ctx, DIAMOND_ORES, diamondsNeeded, () => have('diamond'), { maxDistance: 110 });
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
    const x = base.x + (Math.random() * 12 - 6);
    const z = base.z + (Math.random() * 12 - 6);
    await S.gotoGoal(ctx, new goals.GoalNear(x, base.y, z, 1), 15000);
    await S.sleep(5000);
  }

  async function mainLoop() {
    try { if (bot.waitForChunksToLoad) await Promise.race([bot.waitForChunksToLoad(), S.sleep(10000)]); } catch (_) {}
    await S.sleep(500);
    log('Brain started: wood -> stone -> food -> base -> iron -> diamond -> enchant');
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
            skipUntil[stage.name] = Date.now() + 3 * 60 * 1000;
            fails[stage.name] = 0;
            log(`Skipping "${stage.name}" for 3 minutes`);
          }
          if (fails[stage.name] >= 2) {
            await S.explore(ctx, 40);
          } else {
            await digClimbBlock();
            await S.sleep(1500);
          }
        }
      } catch (e) {
        if (e && e.message === 'STOPPED') return;
        log(`Error: ${e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : e}`);
        await S.sleep(3000);
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
