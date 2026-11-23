// skills.js - fast mining, fast collecting, fast house & gear progression

const { goals } = require('mineflayer-pathfinder');
const { Vec3 } = require('vec3');
const gear = require('./gear');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const BUILD_BLOCKS = [
  'cobblestone', 'cobbled_deepslate', 'blackstone',
  'andesite', 'diorite', 'granite', 'dirt', 'netherrack',
];
const TIERS = { wooden: 1, golden: 1, stone: 2, iron: 3, diamond: 4, netherite: 5 };
const ANIMALS = new Set(['cow', 'pig', 'sheep', 'chicken', 'rabbit', 'mooshroom']);
const MEAT = [
  ['beef', 'cooked_beef'],
  ['porkchop', 'cooked_porkchop'],
  ['mutton', 'cooked_mutton'],
  ['rabbit', 'cooked_rabbit'],
  ['chicken', 'cooked_chicken'],
];

const JUNK_NAMES = new Set([
  'rotten_flesh', 'spider_eye', 'poisonous_potato', 'pufferfish',
  'wheat_seeds', 'beetroot_seeds', 'melon_seeds', 'pumpkin_seeds',
  'oak_sapling', 'birch_sapling', 'spruce_sapling', 'jungle_sapling',
  'acacia_sapling', 'dark_oak_sapling', 'cherry_sapling', 'mangrove_propagule',
  'short_grass', 'tall_grass', 'fern', 'large_fern', 'poppy', 'dandelion',
]);

const COST = {
  wooden_pickaxe: { planks: 3, sticks: 2 },
  wooden_axe: { planks: 3, sticks: 2 },
  wooden_sword: { planks: 2, sticks: 1 },
  stone_pickaxe: { cobble: 3, sticks: 2 },
  stone_axe: { cobble: 3, sticks: 2 },
  stone_sword: { cobble: 2, sticks: 1 },
  iron_pickaxe: { iron: 3, sticks: 2 },
  iron_axe: { iron: 3, sticks: 2 },
  iron_sword: { iron: 2, sticks: 1 },
  iron_helmet: { iron: 5 },
  iron_chestplate: { iron: 8 },
  iron_leggings: { iron: 7 },
  iron_boots: { iron: 4 },
  diamond_pickaxe: { diamond: 3, sticks: 2 },
  diamond_axe: { diamond: 3, sticks: 2 },
  diamond_sword: { diamond: 2, sticks: 1 },
  diamond_helmet: { diamond: 5 },
  diamond_chestplate: { diamond: 8 },
  diamond_leggings: { diamond: 7 },
  diamond_boots: { diamond: 4 },
  shield: { iron: 1, planks: 6 },
  furnace: { cobble: 8 },
  enchanting_table: { diamond: 2, obsidian: 4, book: 1 },
};

function check(ctx) {
  if (ctx.state.stopped) throw new Error('STOPPED');
}

function hasBad(state, key) {
  if (!state || !state.badBlocks) return false;
  return typeof state.badBlocks.has === 'function' ? state.badBlocks.has(key) : false;
}

function markBad(state, key) {
  if (!state || !state.badBlocks) return;
  if (typeof state.badBlocks.add === 'function') state.badBlocks.add(key);
}

function itemCount(bot, name) {
  const it = bot.registry.itemsByName[name];
  return it ? bot.inventory.count(it.id, null) : 0;
}

function countWhere(bot, fn) {
  let n = 0;
  for (const i of bot.inventory.items()) if (fn(i.name)) n += i.count;
  return n;
}

const isLog = (n) => /_log$/.test(n) && !n.startsWith('stripped_');
const isPlanks = (n) => /_planks$/.test(n);
const isCobble = (n) => n === 'cobblestone' || n === 'cobbled_deepslate' || n === 'blackstone';

function buildCount(bot) {
  return countWhere(bot, (n) => BUILD_BLOCKS.includes(n));
}

function pickBuildItem(bot) {
  for (const n of BUILD_BLOCKS) if (itemCount(bot, n) > 0) return n;
  return null;
}

function toolTier(bot, kind) {
  let best = 0;
  for (const i of bot.inventory.items()) {
    const m = i.name.match(/^(wooden|golden|stone|iron|diamond|netherite)_(.+)$/);
    if (m && m[2] === kind) best = Math.max(best, TIERS[m[1]]);
  }
  return best;
}

function hasArmorPiece(bot, piece, minTier = 3) {
  const re = new RegExp('^(iron|diamond|netherite)_' + piece + '$');
  const checkName = (n) => {
    if (!re.test(n)) return false;
    return (TIERS[n.split('_')[0]] || 0) >= minTier;
  };
  if (gear.equippedNames(bot).some(checkName)) return true;
  return bot.inventory.items().some((i) => checkName(i.name));
}

async function humanLookAt(bot, vec) {
  if (!bot || !bot.entity || !vec) return;
  const jitter = vec.offset(
    (Math.random() - 0.5) * 0.1,
    (Math.random() - 0.5) * 0.08,
    (Math.random() - 0.5) * 0.1
  );
  try { await bot.lookAt(jitter, false); } catch (_) {}
}

async function cleanInventoryIfNeeded(ctx) {
  const { bot } = ctx;
  const items = bot.inventory.items();
  if (items.length < 30) return;

  for (const item of items) {
    if (JUNK_NAMES.has(item.name)) {
      try { await bot.tossStack(item); await sleep(60); } catch (_) {}
    }
  }
}

async function waitNoCombat(ctx, maxMs = 60000) {
  const t0 = Date.now();
  while ((ctx.state.combat || ctx.state.rescue || gear.isEating()) && Date.now() - t0 < maxMs) {
    check(ctx);
    await sleep(150);
  }
}

// ---------- fast walking ----------
async function gotoGoal(ctx, goal, timeout = 18000) {
  const { bot } = ctx;
  for (let attempt = 0; attempt < 2; attempt++) {
    check(ctx);
    await waitNoCombat(ctx);
    let timer;
    try {
      await Promise.race([
        bot.pathfinder.goto(goal),
        new Promise((_, rej) => {
          timer = setTimeout(() => rej(new Error('goto timeout')), timeout);
        }),
      ]);
      return true;
    } catch (e) {
      const msg = String((e && e.message) || e);
      if (e && (e.name === 'GoalChanged' || /goal was changed/i.test(msg))) continue;
      try { bot.pathfinder.setGoal(null); } catch (_) {}
      return false;
    } finally {
      clearTimeout(timer);
    }
  }
  return false;
}

async function explore(ctx, dist = 28) {
  const p = ctx.bot.entity.position;
  const a = Math.random() * Math.PI * 2;
  return gotoGoal(ctx, new goals.GoalXZ(p.x + Math.cos(a) * dist, p.z + Math.sin(a) * dist), 16000);
}

async function pickupDrops(ctx, radius = 8) {
  const { bot } = ctx;
  for (let i = 0; i < 4; i++) {
    const me = bot.entity.position;
    const items = Object.values(bot.entities)
      .filter((e) => e && e.position && (e.name === 'item' || e.displayName === 'Item'))
      .filter((e) => e.position.distanceTo(me) < radius)
      .sort((a, b) => a.position.distanceTo(me) - b.position.distanceTo(me));
    if (!items.length) return;
    const t = items[0].position;
    await gotoGoal(ctx, new goals.GoalNear(t.x, t.y, t.z, 0.9), 5000);
    await sleep(60);
  }
}

// ---------- fast mining ----------
async function equipBestToolFor(bot, block) {
  let best = null;
  let bestTime = Infinity;
  for (const item of bot.inventory.items()) {
    if (!/_(pickaxe|axe|shovel|hoe|sword|shears)$/.test(item.name)) continue;
    let t;
    try { t = block.digTime(item.type, false, false, false, [], bot.entity.effects); } catch (_) { continue; }
    if (t < bestTime) { best = item; bestTime = t; }
  }
  let handTime = Infinity;
  try { handTime = block.digTime(null, false, false, false, [], bot.entity.effects); } catch (_) {}
  if (best && bestTime < handTime && (!bot.heldItem || bot.heldItem.name !== best.name)) {
    try { await bot.equip(best, 'hand'); } catch (_) {}
  }
  return best;
}

async function mineBlock(ctx, block, opts = {}) {
  const { bot, state } = ctx;
  const p = block.position;
  const key = p.toString();

  const eye = bot.entity.position.offset(0, bot.entity.height || 1.62, 0);
  const inReach = eye.distanceTo(p.offset(0.5, 0.5, 0.5)) <= 4.6;
  let ok = true;
  if (!inReach) {
    ctx.movements.canDig = opts.canDig !== false;
    ok = await gotoGoal(ctx, new goals.GoalNear(p.x, p.y, p.z, 3), 12000);
    ctx.movements.canDig = false;
  }

  const target = bot.blockAt(p);
  if (!target || target.type !== block.type) return true;
  if (bot.entity.position.offset(0, bot.entity.height || 1.62, 0).distanceTo(p.offset(0.5, 0.5, 0.5)) > 5.5) {
    if (!ok) { markBad(state, key); return false; }
  }

  await equipBestToolFor(bot, target);
  if (!target.canHarvest(bot.heldItem ? bot.heldItem.type : null)) {
    markBad(state, key);
    return false;
  }

  try {
    state.digging = true;
    await bot.dig(target, true);
    return true;
  } catch (_) {
    markBad(state, key);
    return false;
  } finally {
    state.digging = false;
  }
}

async function collect(ctx, names, want, haveFn, opts = {}) {
  const { bot, state, log } = ctx;
  const ids = names.map((n) => bot.registry.blocksByName[n]).filter(Boolean).map((b) => b.id);
  if (!ids.length) {
    log(`unknown blocks: ${names.join(',')}`);
    return false;
  }
  let fails = 0;
  let explores = 0;
  let dugSincePickup = 0;

  while (haveFn() < want) {
    check(ctx);
    if (fails >= 6 || explores >= 4) {
      await pickupDrops(ctx, 8);
      await cleanInventoryIfNeeded(ctx);
      return haveFn() >= want;
    }
    await waitNoCombat(ctx);
    const me = bot.entity.position;
    const found = bot
      .findBlocks({ matching: ids, maxDistance: opts.maxDistance || 48, count: 60 })
      .filter((pos) => !hasBad(state, pos.toString()))
      .filter((pos) => opts.maxAbove === undefined || pos.y - me.y <= opts.maxAbove)
      .sort((a, b) => a.distanceTo(me) - b.distanceTo(me));

    if (!found.length) {
      await pickupDrops(ctx, 8);
      explores++;
      await explore(ctx, 28);
      continue;
    }

    const block = bot.blockAt(found[0]);
    if (!block) { markBad(state, found[0].toString()); continue; }
    const ok = await mineBlock(ctx, block, opts);
    if (ok) {
      fails = 0;
      dugSincePickup++;
      // drops batch mein uthao taaki har block pe rukna na pade
      if (dugSincePickup >= 6 || haveFn() >= want) {
        dugSincePickup = 0;
        await pickupDrops(ctx, 8);
        await cleanInventoryIfNeeded(ctx);
      }
    } else {
      fails++;
    }
  }

  await pickupDrops(ctx, 8);
  await cleanInventoryIfNeeded(ctx);
  return true;
}

// ---------- crafting ----------
function findTableNear(bot, dist) {
  const def = bot.registry.blocksByName.crafting_table;
  return def ? bot.findBlock({ matching: def.id, maxDistance: dist }) : null;
}

async function placeBlockNearby(ctx, itemName) {
  const { bot } = ctx;
  const item = bot.inventory.items().find((i) => i.name === itemName);
  if (!item) return null;
  try { await bot.equip(item, 'hand'); } catch (_) { return null; }
  const base = bot.entity.position.floored();
  const offs = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]];
  for (const [dx, dz] of offs) {
    const target = base.offset(dx, 0, dz);
    const below = bot.blockAt(target.offset(0, -1, 0));
    const at = bot.blockAt(target);
    if (below && below.boundingBox === 'block' && at && at.name === 'air') {
      try {
        await bot.placeBlock(below, new Vec3(0, 1, 0));
        await sleep(100);
        return bot.blockAt(target);
      } catch (_) {}
    }
  }
  return null;
}

async function craftRaw(ctx, name, table, times = 1) {
  const { bot, log } = ctx;
  const item = bot.registry.itemsByName[name];
  if (!item) return false;
  const recipes = bot.recipesFor(item.id, null, 1, table || null);
  if (!recipes.length) return false;
  try {
    await bot.craft(recipes[0], times, table || undefined);
    return true;
  } catch (e) {
    log(`craft ${name} failed: ${e.message}`);
    return false;
  }
}

async function ensurePlanks(ctx, need) {
  const { bot } = ctx;
  let guard = 0;
  while (countWhere(bot, isPlanks) < need && guard++ < 24) {
    const logItem = bot.inventory.items().find((i) => isLog(i.name));
    if (!logItem) return false;
    if (!(await craftRaw(ctx, logItem.name.replace(/_log$/, '_planks'), null, 1))) return false;
  }
  return countWhere(bot, isPlanks) >= need;
}

async function ensureSticks(ctx, need) {
  const { bot } = ctx;
  let guard = 0;
  while (itemCount(bot, 'stick') < need && guard++ < 8) {
    if (!(await ensurePlanks(ctx, 2))) return false;
    if (!(await craftRaw(ctx, 'stick', null, 1))) return false;
  }
  return itemCount(bot, 'stick') >= need;
}

async function getTable(ctx) {
  const { bot } = ctx;
  let t = findTableNear(bot, 24);
  if (!t) {
    if (itemCount(bot, 'crafting_table') === 0) {
      if (!(await ensurePlanks(ctx, 4))) return null;
      if (!(await craftRaw(ctx, 'crafting_table', null, 1))) return null;
    }
    t = await placeBlockNearby(ctx, 'crafting_table');
    if (!t) return null;
  }
  if (bot.entity.position.distanceTo(t.position) > 3.5) {
    await gotoGoal(ctx, new goals.GoalNear(t.position.x, t.position.y, t.position.z, 2), 12000);
  }
  return t;
}

async function craftTool(ctx, name) {
  const { bot } = ctx;
  const cost = COST[name];
  if (!cost) return false;
  if (cost.cobble && countWhere(bot, isCobble) < cost.cobble) return false;
  if (cost.iron && itemCount(bot, 'iron_ingot') < cost.iron) return false;
  if (cost.diamond && itemCount(bot, 'diamond') < cost.diamond) return false;
  if (cost.obsidian && itemCount(bot, 'obsidian') < cost.obsidian) return false;
  if (cost.book && itemCount(bot, 'book') < cost.book) return false;
  if (cost.sticks && !(await ensureSticks(ctx, cost.sticks))) return false;
  if (cost.planks && !(await ensurePlanks(ctx, cost.planks))) return false;
  const table = await getTable(ctx);
  if (!table) return false;
  return craftRaw(ctx, name, table, 1);
}

// ---------- smelting ----------
async function getFurnace(ctx) {
  const { bot } = ctx;
  const def = bot.registry.blocksByName.furnace;
  if (!def) return null;
  let f = bot.findBlock({ matching: def.id, maxDistance: 24 });
  if (!f) {
    if (itemCount(bot, 'furnace') === 0 && !(await craftTool(ctx, 'furnace'))) return null;
    f = await placeBlockNearby(ctx, 'furnace');
    if (!f) return null;
  }
  if (bot.entity.position.distanceTo(f.position) > 3) {
    await gotoGoal(ctx, new goals.GoalNear(f.position.x, f.position.y, f.position.z, 2), 12000);
  }
  return f;
}

async function smelt(ctx, inputName, outputName, want) {
  const { bot, log } = ctx;
  const inItem = bot.registry.itemsByName[inputName];
  const outItem = bot.registry.itemsByName[outputName];
  if (!inItem || !outItem) return false;
  const total = Math.min(itemCount(bot, inputName), want);
  if (total <= 0) return false;

  let fuel = bot.inventory.items().find((i) => i.name === 'coal' || i.name === 'charcoal');
  let fuelCount = 0;
  if (fuel && fuel.count * 8 >= total) {
    fuelCount = Math.ceil(total / 8);
  } else {
    fuel = bot.inventory.items().find((i) => isLog(i.name)) || bot.inventory.items().find((i) => isPlanks(i.name));
    if (fuel) fuelCount = Math.min(fuel.count, Math.ceil(total / 1.5));
  }
  if (!fuel || fuelCount <= 0) {
    log('no fuel for furnace');
    return false;
  }

  const furnaceBlock = await getFurnace(ctx);
  if (!furnaceBlock) return false;

  const startOut = itemCount(bot, outputName);
  let furnace = await bot.openFurnace(furnaceBlock);
  try {
    await furnace.putFuel(fuel.type, null, fuelCount);
    await furnace.putInput(inItem.id, null, total);
  } finally {
    furnace.close();
  }

  const deadline = Date.now() + total * 11000 + 25000;
  ctx.state.waiting = true;
  try {
    while (itemCount(bot, outputName) - startOut < total && Date.now() < deadline) {
      check(ctx);
      await sleep(6000);
      await waitNoCombat(ctx);
      if (bot.entity.position.distanceTo(furnaceBlock.position) > 4) {
        await gotoGoal(ctx, new goals.GoalNear(furnaceBlock.position.x, furnaceBlock.position.y, furnaceBlock.position.z, 2), 12000);
      }
      try {
        furnace = await bot.openFurnace(furnaceBlock);
        try { if (furnace.outputItem()) await furnace.takeOutput(); } finally { furnace.close(); }
      } catch (_) {}
    }
  } finally {
    ctx.state.waiting = false;
  }
  return itemCount(bot, outputName) - startOut >= total;
}

// ---------- food ----------
async function hunt(ctx, wantFood) {
  const { bot } = ctx;
  let attempts = 0;
  while (gear.foodCount(bot) < wantFood && attempts < 8) {
    check(ctx);
    await waitNoCombat(ctx);
    const me = bot.entity.position;
    const animal = Object.values(bot.entities)
      .filter((e) => e && e.position && ANIMALS.has(e.name) && e.position.distanceTo(me) < 64)
      .sort((a, b) => a.position.distanceTo(me) - b.position.distanceTo(me))[0];
    if (!animal) {
      attempts++;
      await explore(ctx, 32);
      continue;
    }
    attempts++;
    await gear.equipBestWeapon(bot);
    const t0 = Date.now();
    let lastHit = 0;
    let following = false;
    while (bot.entities[animal.id] && Date.now() - t0 < 18000) {
      check(ctx);
      await waitNoCombat(ctx);
      const dist = bot.entity.position.distanceTo(animal.position);
      if (dist > 3) {
        if (!following) { bot.pathfinder.setGoal(new goals.GoalFollow(animal, 2), true); following = true; }
      } else if (Date.now() - lastHit > gear.weaponCooldown(bot) + 30) {
        lastHit = Date.now();
        try {
          await humanLookAt(bot, animal.position.offset(0, animal.height * 0.7, 0));
          bot.attack(animal);
        } catch (_) {}
      }
      await sleep(120);
    }
    bot.pathfinder.setGoal(null);
    await sleep(200);
    await pickupDrops(ctx, 8);
    await cleanInventoryIfNeeded(ctx);
  }
  return gear.foodCount(bot) >= wantFood;
}

async function cookMeat(ctx) {
  for (const [raw, cooked] of MEAT) {
    const n = itemCount(ctx.bot, raw);
    if (n >= 2) {
      try { await smelt(ctx, raw, cooked, n); } catch (e) { ctx.log(`cooking ${raw} failed: ${e.message}`); }
    }
  }
}

// ---------- fast base building (compact 3x3 walls + roof) ----------
const AIRS = ['air', 'cave_air', 'void_air'];
const LIQUIDS = ['water', 'lava'];
const isSolid = (b) => !!b && b.boundingBox === 'block';

function housePlan(cx, cy, cz) {
  const ring = [
    [-1, -1], [0, -1], [1, -1],
    [1, 0], [1, 1], [0, 1],
    [-1, 1], [-1, 0],
  ];
  const cells = [];
  for (let layer = 1; layer <= 2; layer++) {
    for (const [dx, dz] of ring) {
      if (dx === 0 && dz === 1 && layer === 1) continue; // door gap
      cells.push(new Vec3(cx + dx, cy + layer, cz + dz));
    }
  }
  const roofY = cy + 3;
  for (let dx = -1; dx <= 1; dx++) {
    for (let dz = -1; dz <= 1; dz++) {
      cells.push(new Vec3(cx + dx, roofY, cz + dz));
    }
  }
  return cells;
}

function siteBadness(bot, cx, cy, cz) {
  let bad = 0;
  for (let dx = -1; dx <= 1; dx++) {
    for (let dz = -1; dz <= 1; dz++) {
      const g = bot.blockAt(new Vec3(cx + dx, cy, cz + dz));
      if (!g) { bad += 4; continue; }
      if (!isSolid(g) || /leaves|_log$/.test(g.name)) bad++;
      const feet = bot.blockAt(new Vec3(cx + dx, cy + 1, cz + dz));
      if (feet && LIQUIDS.includes(feet.name)) bad += 4;
    }
  }
  return bad;
}

function findBuildSite(bot) {
  const me = bot.entity.position.floored();
  const cy = me.y - 1;
  let best = null;
  for (let r = 0; r <= 18; r += 6) {
    for (let dx = -r; dx <= r; dx += 6) {
      for (let dz = -r; dz <= r; dz += 6) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
        const bad = siteBadness(bot, me.x + dx, cy, me.z + dz);
        if (!best || bad < best.bad) best = { x: me.x + dx, y: cy, z: me.z + dz, bad };
        if (bad <= 1) return best;
      }
    }
  }
  return best;
}

async function placeAt(ctx, pos, itemName) {
  const { bot } = ctx;
  const cur = bot.blockAt(pos);
  if (isSolid(cur)) return true;
  const item = bot.inventory.items().find((i) => i.name === itemName);
  if (!item) return false;
  const faces = [[0, -1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, 1, 0]];
  for (const f of faces) {
    const ref = bot.blockAt(pos.offset(f[0], f[1], f[2]));
    if (!isSolid(ref)) continue;
    try {
      await bot.equip(item, 'hand');
      await bot.placeBlock(ref, new Vec3(-f[0], -f[1], -f[2]));
      if (isSolid(bot.blockAt(pos))) return true;
    } catch (_) {}
  }
  return false;
}

async function buildHouse(ctx, site) {
  const { bot, log, state } = ctx;
  const { x: cx, y: cy, z: cz } = site;
  const center = new Vec3(cx, cy + 1, cz);

  await gotoGoal(ctx, new goals.GoalBlock(cx, cy + 1, cz), 15000);

  let cleared = 0;
  for (let dy = 1; dy <= 3; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      for (let dz = -1; dz <= 1; dz++) {
        const b = bot.blockAt(new Vec3(cx + dx, cy + dy, cz + dz));
        if (!b || AIRS.includes(b.name) || LIQUIDS.includes(b.name)) continue;
        if (cleared++ > 35) break
