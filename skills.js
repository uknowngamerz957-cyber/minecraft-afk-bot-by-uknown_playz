// skills.js - fast mining, chest looting, haybale->bread, full crafting, smelting, hunting & unstuck
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
const JUNK = new Set([
  'rotten_flesh', 'spider_eye', 'poisonous_potato', 'pufferfish',
  'wheat_seeds', 'beetroot_seeds', 'melon_seeds', 'pumpkin_seeds',
  'oak_sapling', 'birch_sapling', 'spruce_sapling', 'jungle_sapling',
  'acacia_sapling', 'dark_oak_sapling', 'cherry_sapling', 'mangrove_propagule',
  'short_grass', 'tall_grass', 'fern', 'large_fern', 'poppy', 'dandelion',
]);
const COST = {
  planks: {},
  stick: { planks: 1 },
  crafting_table: { planks: 4 },
  chest: { planks: 8 },
  torch: { sticks: 1 },
  bread: {},
  shield: { iron: 1, planks: 6 },
  wooden_pickaxe: { planks: 3, sticks: 2 },
  wooden_axe: { planks: 3, sticks: 2 },
  wooden_sword: { planks: 2, sticks: 1 },
  wooden_shovel: { planks: 1, sticks: 2 },
  stone_pickaxe: { cobble: 3, sticks: 2 },
  stone_axe: { cobble: 3, sticks: 2 },
  stone_sword: { cobble: 2, sticks: 1 },
  stone_shovel: { cobble: 1, sticks: 2 },
  iron_pickaxe: { iron: 3, sticks: 2 },
  iron_axe: { iron: 3, sticks: 2 },
  iron_sword: { iron: 2, sticks: 1 },
  iron_shovel: { iron: 1, sticks: 2 },
  iron_helmet: { iron: 5 },
  iron_chestplate: { iron: 8 },
  iron_leggings: { iron: 7 },
  iron_boots: { iron: 4 },
  diamond_pickaxe: { diamond: 3, sticks: 2 },
  diamond_axe: { diamond: 3, sticks: 2 },
  diamond_sword: { diamond: 2, sticks: 1 },
  diamond_shovel: { diamond: 1, sticks: 2 },
  diamond_helmet: { diamond: 5 },
  diamond_chestplate: { diamond: 8 },
  diamond_leggings: { diamond: 7 },
  diamond_boots: { diamond: 4 },
  furnace: { cobble: 8 },
};
const LIQUIDS = ['water', 'lava'];
const checkedChests = new Set();

const check = (ctx) => { if (ctx.state.stopped) throw new Error('STOPPED'); };
const hasBad = (st, k) => !!(st && st.badBlocks && st.badBlocks.has(k));
const markBad = (st, k) => { if (st && st.badBlocks) st.badBlocks.add(k); };
const itemCount = (bot, n) => {
  const it = bot.registry.itemsByName[n];
  return it ? bot.inventory.count(it.id, null) : 0;
};
const countWhere = (bot, fn) => bot.inventory.items().reduce((s, i) => (fn(i.name) ? s + i.count : s), 0);
const isLog = (n) => /_log$/.test(n) && !n.startsWith('stripped_');
const isPlanks = (n) => /_planks$/.test(n);
const isCobble = (n) => n === 'cobblestone' || n === 'cobbled_deepslate' || n === 'blackstone';

function toolTier(bot, kind) {
  let b = 0;
  for (const i of bot.inventory.items()) {
    const m = i.name.match(/^(wooden|golden|stone|iron|diamond|netherite)_(.+)$/);
    if (m && m[2] === kind) b = Math.max(b, TIERS[m[1]]);
  }
  return b;
}

function hasArmorPiece(bot, piece, minTier = 3) {
  const re = new RegExp('^(iron|diamond|netherite)_' + piece + '$');
  const ok = (n) => re.test(n) && (TIERS[n.split('_')[0]] || 0) >= minTier;
  return gear.equippedNames(bot).some(ok) || bot.inventory.items().some((i) => ok(i.name));
}

async function humanLookAt(bot, v) {
  if (!bot || !bot.entity || !v) return;
  try { await bot.lookAt(v, false); } catch (_) {}
}

async function cleanInventoryIfNeeded(ctx) {
  const items = ctx.bot.inventory.items();
  if (items.length < 32) return;
  for (const it of items) {
    if (JUNK.has(it.name)) {
      try { await ctx.bot.tossStack(it); await sleep(15); } catch (_) {}
    }
  }
}

async function waitNoCombat(ctx, maxMs = 15000) {
  const t0 = Date.now();
  while ((ctx.state.combat || ctx.state.rescue || gear.isEating()) && Date.now() - t0 < maxMs) {
    check(ctx);
    await sleep(50);
  }
}

async function gotoGoal(ctx, goal, timeout = 6000) {
  const { bot } = ctx;
  for (let a = 0; a < 2; a++) {
    check(ctx);
    await waitNoCombat(ctx);
    let timer;
    try {
      await Promise.race([
        bot.pathfinder.goto(goal),
        new Promise((_, rej) => {
          timer = setTimeout(() => rej(new Error('timeout')), timeout);
        }),
      ]);
      return true;
    } catch (e) {
      if (e && (e.name === 'GoalChanged' || /goal was changed/i.test(String(e.message || e)))) continue;
      try { bot.pathfinder.setGoal(null); } catch (_) {}
      return false;
    } finally {
      clearTimeout(timer);
    }
  }
  return false;
}

async function explore(ctx, dist = 24) {
  const p = ctx.bot.entity.position;
  const a = Math.random() * Math.PI * 2;
  const gx = p.x + Math.cos(a) * dist;
  const gz = p.z + Math.sin(a) * dist;
  return gotoGoal(ctx, new goals.GoalXZ(gx, gz), 6000);
}

async function pickupDrops(ctx, radius = 10) {
  const { bot } = ctx;
  try { bot.pathfinder.setGoal(null); } catch (_) {}
  for (let pass = 0; pass < 5; pass++) {
    check(ctx);
    if (!bot.entity) return;
    const me = bot.entity.position;
    const items = Object.values(bot.entities)
      .filter((e) => e && e.isValid !== false && e.position && (e.name === 'item' || e.displayName === 'Item'))
      .filter((e) => e.position.distanceTo(me) <= radius)
      .sort((a, b) => a.position.distanceTo(me) - b.position.distanceTo(me));
    if (!items.length) return;

    const target = items[0];
    const t0 = Date.now();
    while (bot.entities[target.id] && Date.now() - t0 < 1400) {
      check(ctx);
      const curPos = bot.entity.position;
      const d = target.position.distanceTo(curPos);
      if (d < 1.1) break;
      await humanLookAt(bot, target.position.offset(0, 0.3, 0));
      bot.setControlState('forward', true);
      bot.setControlState('sprint', true);
      bot.setControlState('jump', target.position.y > curPos.y + 0.35 || d > 2.2);
      await sleep(70);
    }
    for (const c of ['forward', 'sprint', 'jump']) bot.setControlState(c, false);
    await sleep(80);
  }
}

async function equipBestToolFor(bot, block) {
  let best = null;
  let bestT = Infinity;
  for (const item of bot.inventory.items()) {
    if (!/_(pickaxe|axe|shovel|hoe|sword|shears)$/.test(item.name)) continue;
    try {
      const t = block.digTime(item.type, false, false, false, [], bot.entity.effects);
      if (t < bestT) { best = item; bestT = t; }
    } catch (_) {}
  }
  let handT = Infinity;
  try { handT = block.digTime(null, false, false, false, [], bot.entity.effects); } catch (_) {}
  if (best && bestT < handT && (!bot.heldItem || bot.heldItem.name !== best.name)) {
    try { await bot.equip(best, 'hand'); } catch (_) {}
  }
}

async function mineBlock(ctx, block, opts = {}) {
  const { bot, state } = ctx;
  const p = block.position;
  const key = p.toString();
  const eye = bot.entity.position.offset(0, bot.entity.height || 1.62, 0);
  let ok = true;
  if (eye.distanceTo(p.offset(0.5, 0.5, 0.5)) > 4.6) {
    ctx.movements.canDig = opts.canDig !== false;
    ok = await gotoGoal(ctx, new goals.GoalNear(p.x, p.y, p.z, 2.8), 5500);
    ctx.movements.canDig = false;
  }
  const target = bot.blockAt(p);
  if (!target || target.type !== block.type) return true;
  if (!ok && bot.entity.position.offset(0, bot.entity.height || 1.62, 0).distanceTo(p.offset(0.5, 0.5, 0.5)) > 5.5) {
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
    await bot.dig(target, true);
    await sleep(140);
    await pickupDrops(ctx, 10);
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
  if (!ids.length) { log(`unknown blocks: ${names.join(',')}`); return false; }
  let fails = 0;
  let explores = 0;
  let dug = 0;
  while (haveFn() < want) {
    check(ctx);
    if (fails >= 6 || explores >= 4) {
      await pickupDrops(ctx, 10);
      await cleanInventoryIfNeeded(ctx);
      return haveFn() >= want;
    }
    await waitNoCombat(ctx);
    const me = bot.entity.position;
    const found = bot
      .findBlocks({ matching: ids, maxDistance: opts.maxDistance || 48, count: 80 })
      .filter((pos) => !hasBad(state, pos.toString()))
      .filter((pos) => opts.maxAbove === undefined || pos.y - me.y <= opts.maxAbove)
      .sort((a, b) => a.distanceTo(me) - b.distanceTo(me));
    if (!found.length) {
      await pickupDrops(ctx, 10);
      explores++;
      await explore(ctx, 24);
      continue;
    }
    const block = bot.blockAt(found[0]);
    if (!block) { markBad(state, found[0].toString()); continue; }
    if (await mineBlock(ctx, block, opts)) {
      fails = 0;
      dug++;
      if (dug >= 6 || haveFn() >= want) {
        dug = 0;
        await pickupDrops(ctx, 10);
        await cleanInventoryIfNeeded(ctx);
      }
    } else {
      fails++;
    }
  }
  await pickupDrops(ctx, 10);
  await cleanInventoryIfNeeded(ctx);
  return true;
}

// ---------- chest looting (village & nearby chests) ----------
async function lootChests(ctx, maxDist = 48, maxChests = 6) {
  const { bot, log } = ctx;
  const chestIds = ['chest', 'trapped_chest', 'barrel']
    .map((n) => bot.registry.blocksByName[n])
    .filter(Boolean)
    .map((b) => b.id);
  if (!chestIds.length) return false;

  let looted = 0;
  for (let i = 0; i < maxChests; i++) {
    check(ctx);
    await waitNoCombat(ctx);
    const me = bot.entity.position;
    const positions = bot
      .findBlocks({ matching: chestIds, maxDistance: maxDist, count: 32 })
      .filter((p) => !checkedChests.has(p.toString()))
      .sort((a, b) => a.distanceTo(me) - b.distanceTo(me));
    if (!positions.length) break;

    const pos = positions[0];
    checkedChests.add(pos.toString());
    if (bot.entity.position.distanceTo(pos) > 3.5) {
      await gotoGoal(ctx, new goals.GoalNear(pos.x, pos.y, pos.z, 2.2), 6000);
    }
    const block = bot.blockAt(pos);
    if (!block) continue;

    let container;
    try {
      container = await bot.openContainer(block);
      const slots = container.containerItems();
      for (const item of slots) {
        if (!item || JUNK.has(item.name)) continue;
        try {
          await container.withdraw(item.type, null, item.count);
          looted++;
          await sleep(40);
        } catch (_) {}
      }
    } catch (_) {
    } finally {
      if (container) {
        try { container.close(); } catch (_) {}
      }
    }
    await cleanInventoryIfNeeded(ctx);
  }
  if (looted > 0) log(`Loot
