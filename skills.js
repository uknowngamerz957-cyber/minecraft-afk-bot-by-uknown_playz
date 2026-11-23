// skills.js - movement, mining, crafting, smelting, hunting, base building, and enchanting

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

// ---------- small helpers ----------
function check(ctx) {
  if (ctx.state.stopped) throw new Error('STOPPED');
}

function hasBad(state, key) {
  if (!state || !state.badBlocks) return false;
  if (typeof state.badBlocks.has === 'function') return state.badBlocks.has(key);
  return false;
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
    const prefix = n.split('_')[0];
    return (TIERS[prefix] || 0) >= minTier;
  };
  if (gear.equippedNames(bot).some(checkName)) return true;
  return bot.inventory.items().some((i) => checkName(i.name));
}

async function humanLookAt(bot, vec) {
  if (!bot || !bot.entity || !vec) return;
  const jitter = vec.offset(
    (Math.random() - 0.5) * 0.14,
    (Math.random() - 0.5) * 0.12,
    (Math.random() - 0.5) * 0.14
  );
  try { await bot.lookAt(jitter, false); } catch (_) {}
}

async function cleanInventoryIfNeeded(ctx) {
  const { bot, log } = ctx;
  const items = bot.inventory.items();
  if (items.length < 28) return;

  for (const item of items) {
    if (JUNK_NAMES.has(item.name)) {
      try { await bot.tossStack(item); await sleep(120); } catch (_) {}
    }
  }

  // if still crowded, trim excess dirt/gravel above 32
  for (const item of bot.inventory.items()) {
    if ((item.name === 'dirt' || item.name === 'gravel' || item.name === 'cobblestone') && item.count > 48) {
      try {
        await bot.toss(item.type, null, item.count - 32);
        log(`Trimmed excess ${item.name}`);
        await sleep(120);
        if (bot.inventory.items().length < 26) break;
      } catch (_) {}
    }
  }
}

async function waitNoCombat(ctx, maxMs = 90000) {
  const t0 = Date.now();
  while ((ctx.state.combat || ctx.state.rescue || gear.isEating()) && Date.now() - t0 < maxMs) {
    check(ctx);
    await sleep(250);
  }
}

// ---------- walking ----------
async function gotoGoal(ctx, goal, timeout = 40000) {
  const { bot } = ctx;
  for (let attempt = 0; attempt < 4; attempt++) {
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
      if (/timeout/.test(msg)) bot.pathfinder.setGoal(null);
      return false;
    } finally {
      clearTimeout(timer);
    }
  }
  return false;
}

async function explore(ctx, dist = 40) {
  const p = ctx.bot.entity.position;
  const a = Math.random() * Math.PI * 2;
  return gotoGoal(ctx, new goals.GoalXZ(p.x + Math.cos(a) * dist, p.z + Math.sin(a) * dist), 30000);
}

async function pickupDrops(ctx, radius = 7) {
  const { bot } = ctx;
  for (let i = 0; i < 6; i++) {
    const me = bot.entity.position;
    const items = Object.values(bot.entities)
      .filter((e) => e && e.position && (e.name === 'item' || e.displayName === 'Item'))
      .filter((e) => e.position.distanceTo(me) < radius)
      .sort((a, b) => a.position.distanceTo(me) - b.position.distanceTo(me));
    if (!items.length) return;
    const t = items[0].position;
    await gotoGoal(ctx, new goals.GoalNear(t.x, t.y, t.z, 0.8), 8000);
    await sleep(150);
  }
}

// ---------- mining ----------
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
  if (best && bestTime < handTime) {
    try { await bot.equip(best, 'hand'); } catch (_) {}
  }
  return best;
}

async function mineBlock(ctx, block, opts = {}) {
  const { bot, state } = ctx;
  const p = block.position;
  const key = p.toString();

  const eye = bot.entity.position.offset(0, bot.entity.height || 1.62, 0);
  const inReach = eye.distanceTo(p.offset(0.5, 0.5, 0.5)) <= 4.3;
  let ok = true;
  if (!inReach) {
    ctx.movements.canDig = opts.canDig !== false;
    ok = await gotoGoal(ctx, new goals.GoalGetToBlock(p.x, p.y, p.z), 25000);
    ctx.movements.canDig = false;
  }

  const target = bot.blockAt(p);
  if (!target || target.type !== block.type) return true;
  if (!ok || bot.entity.position.offset(0, bot.entity.height || 1.62, 0).distanceTo(p.offset(0.5, 0.5, 0.5)) > 5.2) {
    markBad(state, key);
    return false;
  }
  await equipBestToolFor(bot, target);
  if (!target.canHarvest(bot.heldItem ? bot.heldItem.type : null)) {
    markBad(state, key);
    return false;
  }
  try {
    state.digging = true;
    await bot.dig(target);
  } catch (_) {
    markBad(state, key);
    return false;
  } finally {
    state.digging = false;
  }
  await sleep(100);
  await pickupDrops(ctx, 6);
  await cleanInventoryIfNeeded(ctx);
  return true;
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
  while (haveFn() < want) {
    check(ctx);
    if (fails >= 8 || explores >= 6) return false;
    await waitNoCombat(ctx);
    const me = bot.entity.position;
    const found = bot
      .findBlocks({ matching: ids, maxDistance: opts.maxDistance || 64, count: 60 })
      .filter((pos) => !hasBad(state, pos.toString()))
      .filter((pos) => opts.maxAbove === undefined || pos.y - me.y <= opts.maxAbove)
      .sort((a, b) => a.distanceTo(me) - b.distanceTo(me));
    if (!found.length) {
      explores++;
      await explore(ctx, 40);
      continue;
    }
    const block = bot.blockAt(found[0]);
    if (!block) { markBad(state, found[0].toString()); continue; }
    const ok = await mineBlock(ctx, block, opts);
    if (ok) fails = 0; else fails++;
  }
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
        await sleep(200);
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
    await gotoGoal(ctx, new goals.GoalNear(t.position.x, t.position.y, t.position.z, 2), 20000);
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
    await gotoGoal(ctx, new goals.GoalNear(f.position.x, f.position.y, f.position.z, 2), 20000);
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

  const deadline = Date.now() + total * 11000 + 30000;
  ctx.state.waiting = true;
  try {
    while (itemCount(bot, outputName) - startOut < total && Date.now() < deadline) {
      check(ctx);
      await sleep(8000);
      await waitNoCombat(ctx);
      if (bot.entity.position.distanceTo(furnaceBlock.position) > 4) {
        await gotoGoal(ctx, new goals.GoalNear(furnaceBlock.position.x, furnaceBlock.position.y, furnaceBlock.position.z, 2), 20000);
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
  while (gear.foodCount(bot) < wantFood && attempts < 10) {
    check(ctx);
    await waitNoCombat(ctx);
    const me = bot.entity.position;
    const animal = Object.values(bot.entities)
      .filter((e) => e && e.position && ANIMALS.has(e.name) && e.position.distanceTo(me) < 80)
      .sort((a, b) => a.position.distanceTo(me) - b.position.distanceTo(me))[0];
    if (!animal) {
      attempts++;
      await explore(ctx, 50);
      continue;
    }
    attempts++;
    await gear.equipBestWeapon(bot);
    const t0 = Date.now();
    let lastHit = 0;
    let following = false;
    while (bot.entities[animal.id] && Date.now() - t0 < 25000) {
      check(ctx);
      await waitNoCombat(ctx);
      const dist = bot.entity.position.distanceTo(animal.position);
      if (dist > 3) {
        if (!following) { bot.pathfinder.setGoal(new goals.GoalFollow(animal, 2), true); following = true; }
      } else if (Date.now() - lastHit > gear.weaponCooldown(bot) + 50) {
        lastHit = Date.now();
        try {
          await humanLookAt(bot, animal.position.offset(0, animal.height * 0.7, 0));
          bot.attack(animal);
        } catch (_) {}
      }
      await sleep(150);
    }
    bot.pathfinder.setGoal(null);
    await sleep(300);
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

// ---------- building ----------
const AIRS = ['air', 'cave_air', 'void_air'];
const LIQUIDS = ['water', 'lava'];
const isSolid = (b) => !!b && b.boundingBox === 'block';

function housePlan(cx, cy, cz) {
  const ring = [];
  for (let dx = -2; dx <= 2; dx++) {
    for (let dz = -2; dz <= 2; dz++) {
      if (Math.abs(dx) === 2 || Math.abs(dz) === 2) ring.push([dx, dz]);
    }
  }
  ring.sort((a, b) => Math.atan2(a[1], a[0]) - Math.atan2(b[1], b[0]));
  const cells = [];
  for (let layer = 1; layer <= 3; layer++) {
    for (const [dx, dz] of ring) {
      if (dx === 0 && dz === 2 && layer <= 2) continue;
      cells.push(new Vec3(cx + dx, cy + layer, cz + dz));
    }
  }
  const roofY = cy + 4;
  for (const [dx, dz] of ring) cells.push(new Vec3(cx + dx, roofY, cz + dz));
  const inner = [[0, 1], [1, 0], [0, -1], [-1, 0], [1, 1], [1, -1], [-1, 1], [-1, -1], [0, 0]];
  for (const [dx, dz] of inner) cells.push(new Vec3(cx + dx, roofY, cz + dz));
  return cells;
}

function siteBadness(bot, cx, cy, cz) {
  let bad = 0;
  for (let dx = -2; dx <= 2; dx++) {
    for (let dz = -2; dz <= 2; dz++) {
      const g = bot.blockAt(new Vec3(cx + dx, cy, cz + dz));
      if (!g) { bad += 5; continue; }
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
  for (let r = 0; r <= 24; r += 6) {
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

  if (!(await gotoGoal(ctx, new goals.GoalBlock(cx, cy + 1, cz), 40000))) return false;

  let cleared = 0;
  for (let dy = 1; dy <= 4; dy++) {
    for (let dx = -2; dx <= 2; dx++) {
      for (let dz = -2; dz <= 2; dz++) {
        const b = bot.blockAt(new Vec3(cx + dx, cy + dy, cz + dz));
        if (!b || AIRS.includes(b.name) || LIQUIDS.includes(b.name)) continue;
        if (cleared++ > 80) return false;
        await equipBestToolFor(bot, b);
        try { state.digging = true; await bot.dig(b); } catch (_) {} finally { state.digging = false; }
      }
    }
  }

  for (let dx = -2; dx <= 2; dx++) {
    for (let dz = -2; dz <= 2; dz++) {
      const item = pickBuildItem(bot);
      if (!item) return false;
      await placeAt(ctx, new Vec3(cx + dx, cy, cz + dz), item);
    }
  }

  let failures = 0;
  for (const pos of housePlan(cx, cy, cz)) {
    check(ctx);
    await waitNoCombat(ctx);
    const item = pickBuildItem(bot);
    if (!item) { log('house: ran out of blocks'); return false; }
    if (bot.entity.position.distanceTo(center.offset(0.5, 0, 0.5)) > 2.2) {
      await gotoGoal(ctx, new goals.GoalBlock(cx, cy + 1, cz), 20000);
    }
    const ok = await placeAt(ctx, pos, item);
    if (!ok && ++failures > 12) { log('house: too many failed placements'); return false; }
    await sleep(120);
  }

  try {
    const planks = bot.inventory.items().find((i) => isPlanks(i.name));
    if (planks || (await ensurePlanks(ctx, 6))) {
      const p = bot.inventory.items().find((i) => isPlanks(i.name));
      const doorName = p.name.replace('_planks', '_door');
      if (itemCount(bot, doorName) === 0 && (await ensurePlanks(ctx, 6))) {
        const table = await getTable(ctx);
        if (table) await craftRaw(ctx, doorName, table, 1);
        await gotoGoal(ctx, new goals.GoalBlock(cx, cy + 1, cz), 20000);
      }
      const door = bot.inventory.items().find((i) => i.name === doorName);
      if (door) {
        await bot.equip(door, 'hand');
        await bot.placeBlock(bot.blockAt(new Vec3(cx, cy, cz + 2)), new Vec3(0, 1, 0));
      }
    }
    if (itemCount(bot, 'torch') === 0 && itemCount(bot, 'coal') + itemCount(bot, 'charcoal') > 0 && itemCount(bot, 'stick') > 0) {
      await craftRaw(ctx, 'torch', null, 1);
    }
    const torch = bot.inventory.items().find((i) => i.name === 'torch');
    if (torch) {
      await bot.equip(torch, 'hand');
      await bot.placeBlock(bot.blockAt(new Vec3(cx - 1, cy, cz - 1)), new Vec3(0, 1, 0));
    }
  } catch (e) {
    log(`door/torch skipped: ${e.message}`);
  }
  return true;
}

function findExistingDoor(bot) {
  const ids = Object.values(bot.registry.blocksByName)
    .filter((b) => /_door$/.test(b.name))
    .map((b) => b.id);
  if (!ids.length) return null;
  return bot.findBlock({ matching: ids, maxDistance: 48 });
}

// ---------- enchanting ----------
async function enchantGear(ctx) {
  const { bot, log } = ctx;
  const xp = bot.experience && typeof bot.experience.level === 'number' ? bot.experience.level : 0;
  const lapis = itemCount(bot, 'lapis_lazuli');

  const targets = bot.inventory.items().filter((i) =>
    /^(iron|diamond)_(sword|pickaxe|axe|helmet|chestplate|leggings|boots)$/.test(i.name) &&
    (!i.nbt || !i.nbt.value || !i.nbt.value.Enchantments)
  );
  if (!targets.length) return true;

  if (xp < 3 || lapis < 1) {
    log(`Enchanting skipped for now (level=${xp}, lapis=${lapis})`);
    return true;
  }

  const enchDef = bot.registry.blocksByName.enchanting_table;
  let tableBlock = enchDef ? bot.findBlock({ matching: enchDef.id, maxDistance: 24 }) : null;
  if (!tableBlock && itemCount(bot, 'enchanting_table') > 0) {
    tableBlock = await placeBlockNearby(ctx, 'enchanting_table');
  }
  if (!tableBlock || typeof bot.openEnchantmentTable !== 'function') {
    log('No enchanting table available yet, keeping gear as-is');
    return true;
  }

  if (bot.entity.position.distanceTo(tableBlock.position) > 3.5) {
    await gotoGoal(ctx, new goals.GoalNear(tableBlock.position.x, tableBlock.position.y, tableBlock.position.z, 2), 20000);
  }

  let enchantedAny = false;
  for (const item of targets.slice(0, 4)) {
    let table;
    try {
      table = await bot.openEnchantmentTable(tableBlock);
      await table.putTargetItem(item);
      const lapisItem = bot.inventory.items().find((i) => i.name === 'lapis_lazuli');
      if (!lapisItem) break;
      await table.putLapis(lapisItem);
      await sleep(250);
      const slot = xp >= 15 ? 2 : xp >= 8 ? 1 : 0;
      await table.enchant(slot);
      enchantedAny = true;
      log(`Enchanted ${item.name} at slot ${slot}`);
    } catch (_) {
      break;
    } finally {
      if (table) {
        try {
          if (table.targetItem()) await table.takeTargetItem();
          if (table.lapisItem()) await table.takeLapis();
          table.close();
        } catch (_) {}
      }
    }
  }
  return enchantedAny || targets.length > 0;
}

// ---------- getting unstuck ----------
function isInWater(bot) {
  const feet = bot.blockAt(bot.entity.position.floored());
  return !!bot.entity.isInWater || !!(feet && (feet.name === 'water' || feet.name === 'bubble_column'));
}

function isOnLeaves(bot) {
  const below = bot.blockAt(bot.entity.position.offset(0, -0.5, 0).floored());
  return !!below && /leaves/.test(below.name);
}

async function escapeWater(ctx) {
  const { bot } = ctx;
  for (let i = 0; i < 8; i++) {
    check(ctx);
    if (!isInWater(bot)) return true;
    const me = bot.entity.position.floored();
    let best = null;
    let bestD = Infinity;
    for (let dx = -14; dx <= 14; dx++) {
      for (let dz = -14; dz <= 14; dz++) {
        for (let dy = -3; dy <= 3; dy++) {
          const b = bot.blockAt(me.offset(dx, dy, dz));
          if (!b || b.boundingBox !== 'block' || LIQUIDS.includes(b.name) || /leaves/.test(b.name)) continue;
          const a1 = bot.blockAt(b.position.offset(0, 1, 0));
          const a2 = bot.blockAt(b.position.offset(0, 2, 0));
          if (a1 && a2 && a1.name === 'air' && a2.name === 'air') {
            const d = dx * dx + dz * dz + dy * dy;
            if (d < bestD) { bestD = d; best = b.position; }
          }
        }
      }
    }
    if (best) {
      await humanLookAt(bot, best.offset(0.5, 1.5, 0.5));
    } else {
      try { await bot.look(Math.random() * Math.PI * 2, 0, false); } catch (_) {}
    }
    bot.setControlState('forward', true);
    bot.setControlState('sprint', true);
    bot.setControlState('jump', true);
    await sleep(1500);
    for (const c of ['forward', 'sprint', 'jump']) bot.setControlState(c, false);
  }
  return !isInWater(bot);
}

async function descendFromLeaves(ctx) {
  const { bot, state } = ctx;
  for (let i = 0; i < 30; i++) {
    check(ctx);
    const below = bot.blockAt(bot.entity.position.offset(0, -0.5, 0).floored());
    if (!below) return false;
    if (/leaves/.test(below.name)) {
      await equipBestToolFor(bot, below);
      try { state.digging = true; await bot.dig(below); } catch (_) {} finally { state.digging = false; }
      await sleep(350);
      continue;
    }
    if (below.boundingBox === 'block') return true;
    await sleep(250);
  }
  return false;
}

async function wiggle(ctx) {
  const { bot } = ctx;
  try { await bot.look(Math.random() * Math.PI * 2, 0, false); } catch (_) {}
  bot.setControlState('forward', true);
  bot.setControlState('jump', true);
  bot.setControlState('sprint', true);
  await sleep(1500);
  for (const c of ['forward', 'jump', 'sprint']) bot.setControlState(c, false);
}

module.exports = {
  isInWater, isOnLeaves, escapeWater, descendFromLeaves, wiggle,
  sleep, check, itemCount, countWhere, isLog, isPlanks, isCobble, buildCount, toolTier, hasArmorPiece,
  cleanInventoryIfNeeded, waitNoCombat, gotoGoal, explore, pickupDrops, collect, mineBlock,
  craftTool, getTable, craftRaw, ensurePlanks, smelt, hunt, cookMeat,
  housePlan, findBuildSite, buildHouse, findExistingDoor, enchantGear, COST,
};
