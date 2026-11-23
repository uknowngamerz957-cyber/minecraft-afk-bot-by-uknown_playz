const { goals } = require('mineflayer-pathfinder');
const { Vec3 } = require('vec3');
const gear = require('./gear');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const BUILD_BLOCKS = ['cobblestone', 'cobbled_deepslate', 'blackstone', 'andesite', 'diorite', 'granite', 'dirt', 'netherrack'];
const TIERS = { wooden: 1, golden: 1, stone: 2, iron: 3, diamond: 4, netherite: 5 };
const ANIMALS = new Set(['cow', 'pig', 'sheep', 'chicken', 'rabbit', 'mooshroom']);
const MEAT = [['beef', 'cooked_beef'], ['porkchop', 'cooked_porkchop'], ['mutton', 'cooked_mutton'], ['rabbit', 'cooked_rabbit'], ['chicken', 'cooked_chicken']];
const JUNK = new Set(['rotten_flesh', 'spider_eye', 'poisonous_potato', 'pufferfish', 'wheat_seeds', 'beetroot_seeds', 'melon_seeds', 'pumpkin_seeds', 'oak_sapling', 'birch_sapling', 'spruce_sapling', 'jungle_sapling', 'acacia_sapling', 'dark_oak_sapling', 'cherry_sapling', 'mangrove_propagule', 'short_grass', 'tall_grass', 'fern', 'large_fern', 'poppy', 'dandelion']);
const COST = {
  wooden_pickaxe: { planks: 3, sticks: 2 }, wooden_axe: { planks: 3, sticks: 2 }, wooden_sword: { planks: 2, sticks: 1 },
  stone_pickaxe: { cobble: 3, sticks: 2 }, stone_axe: { cobble: 3, sticks: 2 }, stone_sword: { cobble: 2, sticks: 1 },
  iron_pickaxe: { iron: 3, sticks: 2 }, iron_axe: { iron: 3, sticks: 2 }, iron_sword: { iron: 2, sticks: 1 },
  iron_helmet: { iron: 5 }, iron_chestplate: { iron: 8 }, iron_leggings: { iron: 7 }, iron_boots: { iron: 4 },
  diamond_pickaxe: { diamond: 3, sticks: 2 }, diamond_axe: { diamond: 3, sticks: 2 }, diamond_sword: { diamond: 2, sticks: 1 },
  diamond_helmet: { diamond: 5 }, diamond_chestplate: { diamond: 8 }, diamond_leggings: { diamond: 7 }, diamond_boots: { diamond: 4 },
  furnace: { cobble: 8 },
};
const LIQUIDS = ['water', 'lava'];
const check = (ctx) => { if (ctx.state.stopped) throw new Error('STOPPED'); };
const hasBad = (st, k) => !!(st && st.badBlocks && st.badBlocks.has(k));
const markBad = (st, k) => { if (st && st.badBlocks) st.badBlocks.add(k); };
const itemCount = (bot, n) => { const it = bot.registry.itemsByName[n]; return it ? bot.inventory.count(it.id, null) : 0; };
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

async function humanLookAt(bot, v) { if (bot && bot.entity && v) { try { await bot.lookAt(v, false); } catch (_) {} } }

async function cleanInventoryIfNeeded(ctx) {
  const items = ctx.bot.inventory.items();
  if (items.length < 32) return;
  for (const it of items) { if (JUNK.has(it.name)) { try { await ctx.bot.tossStack(it); await sleep(15); } catch (_) {} } }
}

async function waitNoCombat(ctx, maxMs = 15000) {
  const t0 = Date.now();
  while ((ctx.state.combat || ctx.state.rescue || gear.isEating()) && Date.now() - t0 < maxMs) { check(ctx); await sleep(50); }
}

async function gotoGoal(ctx, goal, timeout = 6000) {
  const { bot } = ctx;
  for (let a = 0; a < 2; a++) {
    check(ctx); await waitNoCombat(ctx);
    let timer;
    try {
      await Promise.race([bot.pathfinder.goto(goal), new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('timeout')), timeout); })]);
      return true;
    } catch (e) {
      if (e && (e.name === 'GoalChanged' || /goal was changed/i.test(String(e.message || e)))) continue;
      try { bot.pathfinder.setGoal(null); } catch (_) {}
      return false;
    } finally { clearTimeout(timer); }
  }
  return false;
}

async function explore(ctx, dist = 24) {
  const p = ctx.bot.entity.position, a = Math.random() * Math.PI * 2;
  return gotoGoal(ctx, new goals.GoalXZ(p.x + Math.cos(a) * dist, p.z + Math.sin(a) * dist), 6000);
}

async function pickupDrops(ctx, radius = 9) {
  const { bot } = ctx;
  for (let i = 0; i < 3; i++) {
    const me = bot.entity.position;
    const items = Object.values(bot.entities).filter((e) => e && e.position && (e.name === 'item' || e.displayName === 'Item') && e.position.distanceTo(me) < radius).sort((a, b) => a.position.distanceTo(me) - b.position.distanceTo(me));
    if (!items.length) return;
    await gotoGoal(ctx, new goals.GoalNear(items[0].position.x, items[0].position.y, items[0].position.z, 1.0), 2500);
    await sleep(20);
  }
}

async function equipBestToolFor(bot, block) {
  let best = null, bestT = Infinity;
  for (const item of bot.inventory.items()) {
    if (!/_(pickaxe|axe|shovel|hoe|sword|shears)$/.test(item.name)) continue;
    try { const t = block.digTime(item.type, false, false, false, [], bot.entity.effects); if (t < bestT) { best = item; bestT = t; } } catch (_) {}
  }
  let handT = Infinity;
  try { handT = block.digTime(null, false, false, false, [], bot.entity.effects); } catch (_) {}
  if (best && bestT < handT && (!bot.heldItem || bot.heldItem.name !== best.name)) { try { await bot.equip(best, 'hand'); } catch (_) {} }
}

async function mineBlock(ctx, block, opts = {}) {
  const { bot, state } = ctx;
  const p = block.position, key = p.toString(), eye = bot.entity.position.offset(0, bot.entity.height || 1.62, 0);
  let ok = true;
  if (eye.distanceTo(p.offset(0.5, 0.5, 0.5)) > 4.8) { ctx.movements.canDig = opts.canDig !== false; ok = await gotoGoal(ctx, new goals.GoalNear(p.x, p.y, p.z, 3.2), 5500); ctx.movements.canDig = false; }
  const target = bot.blockAt(p);
  if (!target || target.type !== block.type) return true;
  if (!ok && bot.entity.position.offset(0, bot.entity.height || 1.62, 0).distanceTo(p.offset(0.5, 0.5, 0.5)) > 5.6) { markBad(state, key); return false; }
  await equipBestToolFor(bot, target);
  if (!target.canHarvest(bot.heldItem ? bot.heldItem.type : null)) { markBad(state, key); return false; }
  try { state.digging = true; await bot.dig(target, true); return true; } catch (_) { markBad(state, key); return false; } finally { state.digging = false; }
}

async function collect(ctx, names, want, haveFn, opts = {}) {
  const { bot, state, log } = ctx;
  const ids = names.map((n) => bot.registry.blocksByName[n]).filter(Boolean).map((b) => b.id);
  if (!ids.length) { log(`unknown blocks: ${names.join(',')}`); return false; }
  let fails = 0, explores = 0, dug = 0;
  while (haveFn() < want) {
    check(ctx);
    if (fails >= 6 || explores >= 4) { await pickupDrops(ctx, 9); await cleanInventoryIfNeeded(ctx); return haveFn() >= want; }
    await waitNoCombat(ctx);
    const me = bot.entity.position;
    const found = bot.findBlocks({ matching: ids, maxDistance: opts.maxDistance || 48, count: 80 }).filter((pos) => !hasBad(state, pos.toString())).filter((pos) => opts.maxAbove === undefined || pos.y - me.y <= opts.maxAbove).sort((a, b) => a.distanceTo(me) - b.distanceTo(me));
    if (!found.length) { await pickupDrops(ctx, 9); explores++; await explore(ctx, 24); continue; }
    const block = bot.blockAt(found[0]);
    if (!block) { markBad(state, found[0].toString()); continue; }
    if (await mineBlock(ctx, block, opts)) { fails = 0; dug++; if (dug >= 12 || haveFn() >= want) { dug = 0; await pickupDrops(ctx, 9); await cleanInventoryIfNeeded(ctx); } } else fails++;
  }
  await pickupDrops(ctx, 9); await cleanInventoryIfNeeded(ctx);
  return true;
}
