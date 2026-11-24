// gear.js - Mace, swords, axes, tridents, armor & auto eat/heal handler
const WEAPON_POWER = {
  netherite_mace: 110,
  diamond_mace: 105,
  iron_mace: 100,
  mace: 98,
  netherite_sword: 90,
  netherite_axe: 88,
  diamond_sword: 80,
  diamond_axe: 78,
  iron_sword: 70,
  iron_axe: 68,
  stone_sword: 60,
  stone_axe: 58,
  wooden_sword: 50,
  golden_sword: 48,
  wooden_axe: 45,
  golden_axe: 43,
  trident: 75,
};

const ARMOR_TIER = {
  leather: 1,
  golden: 2,
  chainmail: 2.5,
  iron: 3,
  diamond: 4,
  netherite: 5,
};

const FOODS = new Set([
  'golden_apple', 'enchanted_golden_apple',
  'cooked_beef', 'cooked_porkchop', 'cooked_mutton',
  'cooked_chicken', 'cooked_rabbit', 'cooked_cod', 'cooked_salmon',
  'bread', 'baked_potato', 'cooked_mutton',
  'apple', 'carrot', 'golden_carrot', 'melon_slice', 'sweet_berries', 'glow_berries',
  'beef', 'porkchop', 'mutton', 'chicken', 'rabbit', 'cod', 'salmon', 'potato', 'cookie', 'pumpkin_pie',
]);

let eatingNow = false;
let lastEatAt = 0;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isEating() {
  return eatingNow;
}

function isWeaponName(name = '') {
  return (
    name === 'mace' ||
    name === 'trident' ||
    /_mace$/.test(name) ||
    /_sword$/.test(name) ||
    /_axe$/.test(name)
  );
}

function weaponScore(name = '') {
  if (WEAPON_POWER[name]) return WEAPON_POWER[name];
  if (/_mace$/.test(name) || name === 'mace') return 98;
  if (/_sword$/.test(name)) return 55;
  if (/_axe$/.test(name)) return 52;
  if (name === 'trident') return 75;
  return 0;
}

function bestWeapon(bot) {
  if (!bot || !bot.inventory) return null;
  let best = null;
  let bestScore = -1;
  for (const item of bot.inventory.items()) {
    if (!item || !isWeaponName(item.name)) continue;
    const sc = weaponScore(item.name);
    if (sc > bestScore) {
      bestScore = sc;
      best = item;
    }
  }
  return best;
}

function weaponCooldown(bot) {
  const held = bot && bot.heldItem ? bot.heldItem.name : '';
  if (/mace/.test(held)) return 650;
  if (/axe/.test(held)) return 850;
  if (/sword/.test(held)) return 600;
  return 620;
}

async function equipBestWeapon(bot) {
  if (!bot || !bot.entity) return null;
  const w = bestWeapon(bot);
  if (!w) return null;
  if (bot.heldItem && bot.heldItem.name === w.name) return w;
  try {
    await bot.equip(w, 'hand');
    return w;
  } catch (_) {
    return null;
  }
}

function equippedNames(bot) {
  if (!bot || !bot.inventory || !bot.inventory.slots) return [];
  const slots = [5, 6, 7, 8, 45]; // helmet, chestplate, leggings, boots, offhand
  const out = [];
  for (const idx of slots) {
    const it = bot.inventory.slots[idx];
    if (it && it.name) out.push(it.name);
  }
  return out;
}

function hasIronArmor(bot) {
  const names = equippedNames(bot);
  let count = 0;
  for (const n of names) {
    const prefix = n.split('_')[0];
    if ((ARMOR_TIER[prefix] || 0) >= 3) count++;
  }
  return count >= 2;
}

async function equipBestArmor(bot) {
  if (!bot || !bot.entity || !bot.inventory) return;
  const pieces = [
    { slot: 'head', re: /_(helmet|turtle_shell)$/ },
    { slot: 'torso', re: /_chestplate$/ },
    { slot: 'legs', re: /_leggings$/ },
    { slot: 'feet', re: /_boots$/ },
  ];

  for (const p of pieces) {
    let best = null;
    let bestTier = 0;
    for (const item of bot.inventory.items()) {
      if (!item || !p.re.test(item.name)) continue;
      const tier = ARMOR_TIER[item.name.split('_')[0]] || 1;
      if (tier > bestTier) {
        bestTier = tier;
        best = item;
      }
    }
    if (!best) continue;
    const current = bot.inventory.slots[
      p.slot === 'head' ? 5 : p.slot === 'torso' ? 6 : p.slot === 'legs' ? 7 : 8
    ];
    const currentTier = current ? (ARMOR_TIER[current.name.split('_')[0]] || 0) : 0;
    if (bestTier > currentTier) {
      try {
        await bot.equip(best, p.slot);
        await sleep(80);
      } catch (_) {}
    }
  }

  // Offhand shield if available
  const shield = bot.inventory.items().find((i) => i && i.name === 'shield');
  const offhand = bot.inventory.slots[45];
  if (shield && (!offhand || offhand.name !== 'shield')) {
    try {
      await bot.equip(shield, 'off-hand');
    } catch (_) {}
  }
}

function foodCount(bot) {
  if (!bot || !bot.inventory) return 0;
  return bot.inventory.items().reduce((sum, item) => {
    if (!item || !item.name) return sum;
    if (FOODS.has(item.name) || /cooked_|bread|apple|carrot|potato|berries|pie|soup|stew/.test(item.name)) {
      return sum + item.count;
    }
    return sum;
  }, 0);
}

function pickBestFood(bot, lowHp) {
  if (!bot || !bot.inventory) return null;
  const candidates = bot.inventory.items().filter(
    (item) => item && (FOODS.has(item.name) || /cooked_|bread|apple|carrot|potato|berries|pie/.test(item.name))
  );
  if (!candidates.length) return null;

  candidates.sort((a, b) => {
    const aHeal = /golden_apple|enchanted_golden_apple/.test(a.name) ? 100 : /cooked_|bread|steak|porkchop/.test(a.name) ? 50 : 20;
    const bHeal = /golden_apple|enchanted_golden_apple/.test(b.name) ? 100 : /cooked_|bread|steak|porkchop/.test(b.name) ? 50 : 20;
    if (lowHp && /golden_apple/.test(a.name) && !/golden_apple/.test(b.name)) return -1;
    if (lowHp && /golden_apple/.test(b.name) && !/golden_apple/.test(a.name)) return 1;
    return bHeal - aHeal;
  });

  return candidates[0];
}

async function eatIfNeeded(bot) {
  if (!bot || !bot.entity || eatingNow) return false;
  if (Date.now() - lastEatAt < 1200) return false;

  const hp = bot.health !== undefined ? bot.health : 20;
  const food = bot.food !== undefined ? bot.food : 20;
  const lowHp = hp <= 13;
  const hungry = food <= 16;

  if (!lowHp && !hungry) return false;

  const chosen = pickBestFood(bot, lowHp);
  if (!chosen) return false;

  eatingNow = true;
  lastEatAt = Date.now();
  try {
    try { bot.pathfinder.setGoal(null); } catch (_) {}
    await bot.equip(chosen, 'hand');
    await bot.consume();
    await sleep(150);
    await equipBestWeapon(bot);
    return true;
  } catch (_) {
    try {
      bot.activateItem();
      await sleep(1400);
      await equipBestWeapon(bot);
      return true;
    } catch (_) {
      return false;
    }
  } finally {
    eatingNow = false;
  }
}

module.exports = {
  isEating,
  bestWeapon,
  weaponCooldown,
  equipBestWeapon,
  equippedNames,
  hasIronArmor,
  equipBestArmor,
  foodCount,
  eatIfNeeded,
};
