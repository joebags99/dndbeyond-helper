/**
 * Derives a display-ready stat block from a D&D Beyond character-service payload.
 *
 * Loaded both as a content script (assigns to globalThis.DDBStats) and by the
 * node tests (module.exports), so it stays dependency free and side effect free.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.DDBStats = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const ABILITIES = [
    { id: 1, key: 'str', label: 'STR', name: 'strength' },
    { id: 2, key: 'dex', label: 'DEX', name: 'dexterity' },
    { id: 3, key: 'con', label: 'CON', name: 'constitution' },
    { id: 4, key: 'int', label: 'INT', name: 'intelligence' },
    { id: 5, key: 'wis', label: 'WIS', name: 'wisdom' },
    { id: 6, key: 'cha', label: 'CHA', name: 'charisma' }
  ];

  const SKILLS = [
    { slug: 'acrobatics', label: 'Acrobatics', ability: 'dex' },
    { slug: 'animal-handling', label: 'Animal Handling', ability: 'wis' },
    { slug: 'arcana', label: 'Arcana', ability: 'int' },
    { slug: 'athletics', label: 'Athletics', ability: 'str' },
    { slug: 'deception', label: 'Deception', ability: 'cha' },
    { slug: 'history', label: 'History', ability: 'int' },
    { slug: 'insight', label: 'Insight', ability: 'wis' },
    { slug: 'intimidation', label: 'Intimidation', ability: 'cha' },
    { slug: 'investigation', label: 'Investigation', ability: 'int' },
    { slug: 'medicine', label: 'Medicine', ability: 'wis' },
    { slug: 'nature', label: 'Nature', ability: 'int' },
    { slug: 'perception', label: 'Perception', ability: 'wis' },
    { slug: 'performance', label: 'Performance', ability: 'cha' },
    { slug: 'persuasion', label: 'Persuasion', ability: 'cha' },
    { slug: 'religion', label: 'Religion', ability: 'int' },
    { slug: 'sleight-of-hand', label: 'Sleight of Hand', ability: 'dex' },
    { slug: 'stealth', label: 'Stealth', ability: 'dex' },
    { slug: 'survival', label: 'Survival', ability: 'wis' }
  ];

  const CONDITIONS = {
    1: 'Blinded', 2: 'Charmed', 3: 'Deafened', 4: 'Exhaustion', 5: 'Frightened',
    6: 'Grappled', 7: 'Incapacitated', 8: 'Invisible', 9: 'Paralyzed', 10: 'Petrified',
    11: 'Poisoned', 12: 'Prone', 13: 'Restrained', 14: 'Stunned', 15: 'Unconscious'
  };

  const CUSTOM_SENSES = { 1: 'Blindsight', 2: 'Darkvision', 3: 'Tremorsense', 4: 'Truesight' };

  // Armor categories as D&D Beyond numbers them. Shields are their own category.
  const ARMOR_LIGHT = 1, ARMOR_MEDIUM = 2, ARMOR_HEAVY = 3, ARMOR_SHIELD = 4;

  const num = (v) => (typeof v === 'number' && isFinite(v) ? v : null);
  const arr = (v) => (Array.isArray(v) ? v : []);
  const abilityMod = (score) => Math.floor((score - 10) / 2);
  const signed = (n) => (n >= 0 ? `+${n}` : `${n}`);

  function titleCase(slug) {
    return String(slug || '')
      .split('-')
      .filter(Boolean)
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join(' ');
  }

  function statValue(list, id) {
    const entry = arr(list).find((s) => s && s.id === id);
    return entry ? num(entry.value) : null;
  }

  /**
   * Item-granted modifiers only count while the item is equipped (and attuned,
   * when it demands attunement). D&D Beyond ships every item modifier in one
   * bucket, so match each back to its owning inventory entry by modifier id.
   */
  function itemModifierIsActive(data, modifier) {
    let owner = null;
    for (const item of arr(data.inventory)) {
      const granted = arr(item && item.definition && item.definition.grantedModifiers);
      if (granted.some((m) => m && m.id === modifier.id)) {
        owner = item;
        break;
      }
    }
    // Unmatched modifiers (homebrew, custom items) are kept rather than dropped.
    if (!owner) return true;
    if (!owner.equipped) return false;
    if (modifier.requiresAttunement && !owner.isAttuned) return false;
    return true;
  }

  function activeModifiers(data) {
    const groups = (data && data.modifiers) || {};
    const out = [];
    for (const group of Object.keys(groups)) {
      const list = arr(groups[group]);
      if (group === 'condition') continue; // applied situationally, not to the sheet
      for (const modifier of list) {
        if (!modifier) continue;
        if (group === 'item' && !itemModifierIsActive(data, modifier)) continue;
        out.push(modifier);
      }
    }
    return out;
  }

  const matches = (m, type, subType) => m.type === type && m.subType === subType;

  function sumBonus(mods, subType) {
    let total = 0;
    for (const m of mods) {
      if (!matches(m, 'bonus', subType)) continue;
      const v = num(m.value) !== null ? num(m.value) : num(m.fixedValue);
      if (v !== null) total += v;
    }
    return total;
  }

  function hasProficiency(mods, subType) {
    return mods.some((m) => matches(m, 'proficiency', subType));
  }

  function hasExpertise(mods, subType) {
    return mods.some((m) => matches(m, 'expertise', subType));
  }

  function totalLevel(data) {
    return arr(data.classes).reduce((sum, c) => sum + (num(c && c.level) || 0), 0);
  }

  function computeAbilities(data, mods) {
    const out = {};
    for (const ability of ABILITIES) {
      const base = statValue(data.stats, ability.id);
      const bonusStat = statValue(data.bonusStats, ability.id) || 0;
      const override = statValue(data.overrideStats, ability.id);
      let score = (base === null ? 10 : base) + bonusStat + sumBonus(mods, `${ability.name}-score`);
      for (const m of mods) {
        if (matches(m, 'set', `${ability.name}-score`) && num(m.value) !== null) {
          score = Math.max(score, num(m.value));
        }
      }
      if (override !== null) score = override;
      out[ability.key] = {
        key: ability.key,
        label: ability.label,
        name: titleCase(ability.name),
        score,
        modifier: abilityMod(score)
      };
    }
    return out;
  }

  function computeProficiencyBonus(data, mods) {
    const level = Math.max(1, totalLevel(data));
    return Math.ceil(level / 4) + 1 + sumBonus(mods, 'proficiency-bonus');
  }

  function computeHitPoints(data, abilities) {
    const level = totalLevel(data);
    const conMod = abilities.con.modifier;
    const base = num(data.baseHitPoints) || 0;
    const bonus = num(data.bonusHitPoints) || 0;
    const override = num(data.overrideHitPoints);
    const removed = num(data.removedHitPoints) || 0;
    const temp = num(data.temporaryHitPoints) || 0;

    let max;
    if (override !== null) {
      max = override;
    } else {
      const mods = activeModifiers(data);
      const perLevel = mods
        .filter((m) => matches(m, 'bonus', 'hit-points-per-level'))
        .reduce((sum, m) => sum + (num(m.value) || 0), 0);
      max = base + bonus + conMod * level + perLevel * level + sumBonus(mods, 'hit-points');
    }
    max = Math.max(0, max);
    const current = max - removed;
    return {
      max,
      current,
      temp,
      removed,
      isOverridden: override !== null,
      percent: max > 0 ? Math.max(0, Math.min(100, Math.round((current / max) * 100))) : 0
    };
  }

  function equippedArmor(data) {
    return arr(data.inventory).filter((item) => {
      const def = item && item.definition;
      return item && item.equipped && def && num(def.armorClass) !== null && num(def.armorTypeId) !== null;
    });
  }

  function computeArmorClass(data, mods, abilities) {
    const dex = abilities.dex.modifier;
    const worn = equippedArmor(data);
    const body = worn.filter((i) => i.definition.armorTypeId !== ARMOR_SHIELD);
    const shields = worn.filter((i) => i.definition.armorTypeId === ARMOR_SHIELD);

    let maxDexMedium = 2;
    for (const m of mods) {
      if (m.subType === 'ac-max-dex-armored-modifier' && num(m.value) !== null) {
        maxDexMedium = Math.max(maxDexMedium, num(m.value));
      }
    }

    const candidates = [];
    // Unarmoured, plus any Unarmoured Defense style feature.
    candidates.push(10 + dex);
    for (const m of mods) {
      if (m.subType !== 'unarmored-armor-class') continue;
      const statId = num(m.statId);
      if (statId !== null) {
        const ability = ABILITIES.find((a) => a.id === statId);
        if (ability) candidates.push(10 + dex + abilities[ability.key].modifier);
      } else if (num(m.value) !== null) {
        candidates.push(10 + dex + num(m.value));
      }
    }

    for (const item of body) {
      const def = item.definition;
      let dexPart = dex;
      if (def.armorTypeId === ARMOR_MEDIUM) dexPart = Math.min(dex, maxDexMedium);
      else if (def.armorTypeId === ARMOR_HEAVY) dexPart = 0;
      candidates.push(num(def.armorClass) + dexPart);
    }

    let ac = Math.max.apply(null, candidates);
    for (const shield of shields) ac += num(shield.definition.armorClass) || 0;
    ac += sumBonus(mods, 'armor-class');
    if (body.length > 0) ac += sumBonus(mods, 'armored-armor-class'); // e.g. the Defense fighting style
    if (shields.length > 0) ac += sumBonus(mods, 'shield-armor-class');

    return {
      value: ac,
      armor: body.map((i) => i.definition.name).filter(Boolean),
      shield: shields.length > 0
    };
  }

  function computeSaves(data, mods, abilities, proficiencyBonus) {
    const global = sumBonus(mods, 'saving-throws');
    return ABILITIES.map((ability) => {
      const subType = `${ability.name}-saving-throws`;
      const proficient = hasProficiency(mods, subType);
      const value =
        abilities[ability.key].modifier +
        (proficient ? proficiencyBonus : 0) +
        global +
        sumBonus(mods, subType);
      return { key: ability.key, label: ability.label, name: titleCase(ability.name), proficient, value };
    });
  }

  function computeSkills(data, mods, abilities, proficiencyBonus) {
    const jackOfAllTrades = mods.some((m) => matches(m, 'half-proficiency', 'ability-checks'));
    return SKILLS.map((skill) => {
      const proficient = hasProficiency(mods, skill.slug);
      const expert = hasExpertise(mods, skill.slug);
      const halfBySkill = mods.some((m) => matches(m, 'half-proficiency', skill.slug));
      const half = !proficient && !expert && (jackOfAllTrades || halfBySkill);

      let profPart = 0;
      let proficiency = 'none';
      if (expert) {
        profPart = proficiencyBonus * 2;
        proficiency = 'expertise';
      } else if (proficient) {
        profPart = proficiencyBonus;
        proficiency = 'proficient';
      } else if (half) {
        profPart = Math.floor(proficiencyBonus / 2);
        proficiency = 'half';
      }

      return {
        slug: skill.slug,
        label: skill.label,
        ability: skill.ability,
        abilityLabel: abilities[skill.ability].label,
        proficiency,
        value: abilities[skill.ability].modifier + profPart + sumBonus(mods, skill.slug)
      };
    });
  }

  function computePassive(skills, mods, slug, bonusSubType) {
    const skill = skills.find((s) => s.slug === slug);
    return 10 + (skill ? skill.value : 0) + sumBonus(mods, bonusSubType);
  }

  function computeSpeed(data, mods) {
    const speeds = (data.race && data.race.weightSpeeds && data.race.weightSpeeds.normal) || {};
    let walk = num(speeds.walk);
    if (walk === null) walk = 30;
    for (const m of mods) {
      if (matches(m, 'set', 'innate-speed-walking') && num(m.value) !== null) {
        walk = Math.max(walk, num(m.value));
      }
    }
    walk += sumBonus(mods, 'speed') + sumBonus(mods, 'unarmored-movement');
    const extras = [];
    for (const kind of ['fly', 'swim', 'climb', 'burrow']) {
      const v = num(speeds[kind]);
      if (v) extras.push({ name: titleCase(kind), distance: v });
    }
    return { walk, extras };
  }

  function computeSenses(data, mods) {
    const senses = new Map();
    const add = (name, distance) => {
      if (!distance) return;
      const current = senses.get(name) || 0;
      if (distance > current) senses.set(name, distance);
    };
    for (const m of mods) {
      if (m.type !== 'set' && m.type !== 'sense') continue;
      if (m.subType === 'darkvision') add('Darkvision', num(m.value) || 60);
      else if (m.subType === 'superior-darkvision') add('Darkvision', num(m.value) || 120);
      else if (m.subType === 'blindsight') add('Blindsight', num(m.value) || 10);
      else if (m.subType === 'tremorsense') add('Tremorsense', num(m.value) || 30);
      else if (m.subType === 'truesight') add('Truesight', num(m.value) || 30);
    }
    for (const custom of arr(data.customSenses)) {
      const name = CUSTOM_SENSES[custom && custom.senseId];
      if (name) add(name, num(custom.distance) || 0);
    }
    return Array.from(senses, ([name, distance]) => ({ name, distance }));
  }

  function computeLanguages(mods) {
    const seen = new Set();
    for (const m of mods) {
      if (m.type !== 'language') continue;
      seen.add(m.friendlySubtypeName || titleCase(m.subType));
    }
    return Array.from(seen).sort((a, b) => a.localeCompare(b));
  }

  function computeOtherProficiencies(mods) {
    const skillSlugs = new Set(SKILLS.map((s) => s.slug));
    const saveSlugs = new Set(ABILITIES.map((a) => `${a.name}-saving-throws`));
    const seen = new Set();
    for (const m of mods) {
      if (m.type !== 'proficiency') continue;
      if (skillSlugs.has(m.subType) || saveSlugs.has(m.subType)) continue;
      seen.add(m.friendlySubtypeName || titleCase(m.subType));
    }
    return Array.from(seen).sort((a, b) => a.localeCompare(b));
  }

  function computeSpellcasting(data, abilities, proficiencyBonus) {
    const casters = [];
    for (const cls of arr(data.classes)) {
      const def = cls && cls.definition;
      if (!def) continue;
      const statId =
        num(cls.subclassDefinition && cls.subclassDefinition.spellCastingAbilityId) ||
        num(def.spellCastingAbilityId);
      if (statId === null) continue;
      const ability = ABILITIES.find((a) => a.id === statId);
      if (!ability) continue;
      const mod = abilities[ability.key].modifier;
      casters.push({
        className: def.name || 'Spellcasting',
        ability: ability.label,
        dc: 8 + proficiencyBonus + mod,
        attack: proficiencyBonus + mod
      });
    }
    casters.sort((a, b) => b.dc - a.dc);
    return casters;
  }

  function computeSlots(data) {
    const level = (slot) => ({
      level: num(slot.level) || 0,
      used: num(slot.used) || 0,
      available: num(slot.available) || 0
    });
    return {
      spell: arr(data.spellSlots).map(level).filter((s) => s.available > 0),
      pact: arr(data.pactMagic).map(level).filter((s) => s.available > 0)
    };
  }

  function computeConditions(data) {
    return arr(data.conditions)
      .map((c) => {
        const name = CONDITIONS[c && c.id];
        if (!name) return null;
        const lvl = num(c.level);
        return lvl && name === 'Exhaustion' ? `${name} ${lvl}` : name;
      })
      .filter(Boolean);
  }

  function classSummary(data) {
    return arr(data.classes)
      .map((cls) => {
        const def = cls && cls.definition;
        const name = (def && def.name) || 'Unknown';
        const sub = cls && cls.subclassDefinition && cls.subclassDefinition.name;
        return `${name}${sub ? ` (${sub})` : ''} ${num(cls.level) || 0}`;
      })
      .join(' / ');
  }

  /** Accepts either the character-service envelope or a bare character object. */
  function unwrap(payload) {
    if (!payload || typeof payload !== 'object') return null;
    if (payload.data && typeof payload.data === 'object') return payload.data;
    return payload;
  }

  function build(payload) {
    const data = unwrap(payload);
    if (!data) throw new Error('Empty character payload');

    const mods = activeModifiers(data);
    const abilities = computeAbilities(data, mods);
    const proficiencyBonus = computeProficiencyBonus(data, mods);
    const skills = computeSkills(data, mods, abilities, proficiencyBonus);
    const hp = computeHitPoints(data, abilities);
    const ac = computeArmorClass(data, mods, abilities);
    const speed = computeSpeed(data, mods);

    return {
      id: data.id,
      name: data.name || 'Unnamed character',
      level: totalLevel(data),
      race: (data.race && (data.race.fullName || data.race.baseRaceName)) || '',
      classes: classSummary(data),
      background: (data.background && data.background.definition && data.background.definition.name) || '',
      avatarUrl: data.avatarUrl || (data.decorations && data.decorations.avatarUrl) || '',
      readonlyUrl: data.readonlyUrl || '',
      abilities: ABILITIES.map((a) => abilities[a.key]),
      proficiencyBonus,
      hp,
      ac,
      initiative: abilities.dex.modifier + sumBonus(mods, 'initiative'),
      speed,
      passives: {
        perception: computePassive(skills, mods, 'perception', 'passive-perception'),
        investigation: computePassive(skills, mods, 'investigation', 'passive-investigation'),
        insight: computePassive(skills, mods, 'insight', 'passive-insight')
      },
      saves: computeSaves(data, mods, abilities, proficiencyBonus),
      skills,
      senses: computeSenses(data, mods),
      languages: computeLanguages(mods),
      otherProficiencies: computeOtherProficiencies(mods),
      spellcasting: computeSpellcasting(data, abilities, proficiencyBonus),
      slots: computeSlots(data),
      conditions: computeConditions(data),
      inspiration: Boolean(data.inspiration),
      currentXp: num(data.currentXp) || 0,
      deathSaves: data.deathSaves || null
    };
  }

  return { build, signed, titleCase, ABILITIES, SKILLS, CONDITIONS };
});
