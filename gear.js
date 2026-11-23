// gear.js - weapons, armor, food, and gear tier helpers

const WEAPONS = {
  netherite_sword: { damage: 8, cooldown: 625 },
  diamond_sword: { damage: 7, cooldown: 625 },
  iron_sword: { damage: 6, cooldown: 625 },
  stone_sword: { damage: 5, cooldown: 625 },
  golden_sword: { damage: 4, cooldown: 625 },
  wooden_sword: { damage: 4, cooldown: 625 },
  netherite_axe: { damage: 10, cooldown: 1000 },
  diamond_axe: { damage: 9, cooldown: 1000 },
  iron_axe: { damage: 9, cooldown: 1112 },
  stone_axe: { damage: 9, cooldown: 1250 },
  golden_axe: { damage: 7, cooldown: 1000 },
  wooden_axe: { damage: 7, cooldown: 1250 },
};

const ARMOR_TIERS = { netherite: 6, diamond: 5, iron: 4, chainmail: 3, golden: 2, leather: 1 };
const ARMOR_SLOTS = { head: 'helmet', torso: 'chestplate', legs: 'leggings', feet: 'boots' };

const BAD_FOOD = new Set([
  'rotten_flesh', 'spider_eye', 'pufferfish', 'poisonous_potato', 'suspicious_stew',
  'chorus_fruit', 'golden_apple', 'enchanted_golden_apple', 'chicken', 'tropical_fish',
]);

function bestWeapon(bot) {
  let best = null;
  let bestScore = 0;
  for (const item of bot.inventory.items()) {
    const w = WEAPONS[item.name];
    if (!w) continue;
    const score = w.damage / (w.cooldown / 1000);
    if (score > bestScore) {
      best = item;
      bestScore = score;
    }
  }
  return best;
}

async function equipBestWeapon(bot) {
  const w = bestWeapon(bot);
  if (!w) return null;
  if (bot.heldItem && bot.heldItem.name === w.name) return w;
  try { await bot.equip(w, 'hand'); } catch (_) {}
  return w;
}

function weaponCooldown(bot) {
  const held = bot.heldItem;
  return held && WEAPONS[held.name] ? WEAPONS[held.name].cooldown : 500;
}

function tierOf(name, piece) {
  if (!name || !name.endsWith('_' + piece)) return 0;
  return ARMOR_TIERS[name.slice(0, -(piece.length + 1))] || 0;
}

function equippedIn(bot, slot) {
  try {
    return bot.inventory.slots[bot.getEquipmentDestSlot(slot)] || null;
  } catch (_) {
    return null;
  }
}

async function equipBestArmor(bot) {
  for (const [slot, piece] of Object.entries(ARMOR_SLOTS)) {
    const cur = equippedIn(bot, slot);
    let bestTier = cur ? tierOf(cur.name, piece) : 0;
    let best = null;
    for (const item of bot.inventory.items()) {
      const t = tierOf(item.name, piece);
      if (t > bestTier) {
        best = item;
        bestTier = t;
      }
    }
    if (best) {
      try { await bot.equip(best, slot); } catch (_) {}
    }
  }
}

function hasTierArmor(bot, minTier) {
  return Object.entries(ARMOR_SLOTS).every(([slot, piece]) => {
    const cur = equippedIn(bot, slot);
    return cur && tierOf(cur.name, piece) >= minTier;
  });
}

function hasIronArmor(bot) {
  return hasTierArmor(bot, ARMOR_TIERS.iron);
}

function hasDiamondArmor(bot) {
  return hasTierArmor(bot, ARMOR_TIERS.diamond);
}

function equippedNames(bot) {
  return Object.keys(ARMOR_SLOTS)
    .map((slot) => equippedIn(bot, slot))
    .filter(Boolean)
    .map((i) => i.name);
}

function foodPoints(bot, name) {
  const f = bot.registry.foodsByName && bot.registry.foodsByName[name];
  return f ? f.foodPoints : 0;
}

function bestFood(bot) {
  let best = null;
  let pts = 0;
  for (const item of bot.inventory.items()) {
    if (BAD_FOOD.has(item.name)) continue;
    const p = foodPoints(bot, item.name);
    if (p > pts) {
      best = item;
      pts = p;
    }
  }
  return best;
}

function foodCount(bot) {
  let n = 0;
  for (const item of bot.inventory.items()) {
    if (!BAD_FOOD.has(item.name) && foodPoints(bot, item.name) > 0) n += item.count;
  }
  return n;
}

let eating = false;
async function eatIfNeeded(bot) {
  if (eating || bot.food === undefined) return false;
  const hungry = bot.food <= 16 || (bot.health <= 15 && bot.food < 20);
  if (!hungry) return false;
  const food = bestFood(bot);
  if (!food) return false;
  eating = true;
  try {
    if (bot.usingHeldItem) { try { bot.deactivateItem(); } catch (_) {} }
    await bot.equip(food, 'hand');
    await bot.consume();
    return true;
  } catch (_) {
    return false;
  } finally {
    eating = false;
  }
}

module.exports = {
  WEAPONS,
  bestWeapon,
  equipBestWeapon,
  weaponCooldown,
  equipBestArmor,
  hasIronArmor,
  hasDiamondArmor,
  equippedNames,
  foodCount,
  eatIfNeeded,
  isEating: () => eating,
};
