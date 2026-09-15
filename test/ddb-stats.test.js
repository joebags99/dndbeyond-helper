const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const DDBStats = require('../src/lib/ddb-stats.js');

const payload = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'fixtures', 'warlock6.json'), 'utf8')
);
const sheet = DDBStats.build(payload);

const skill = (slug) => sheet.skills.find((s) => s.slug === slug);
const save = (key) => sheet.saves.find((s) => s.key === key);
const ability = (key) => sheet.abilities.find((a) => a.key === key);

test('unwraps the character-service envelope', () => {
  assert.equal(sheet.name, 'Cailynn Falkrest');
  assert.equal(sheet.level, 6);
  assert.equal(sheet.classes, 'Warlock (The Great Old One) 6');
  assert.equal(sheet.race, 'High Elf');
});

test('ability scores fold in racial and feat bonuses', () => {
  assert.equal(ability('dex').score, 16); // 14 base + 2 racial
  assert.equal(ability('dex').modifier, 3);
  assert.equal(ability('cha').score, 19); // 17 base + 2 from an ASI/feat
  assert.equal(ability('cha').modifier, 4);
  assert.equal(ability('str').modifier, -1);
});

test('proficiency bonus follows total level', () => {
  assert.equal(sheet.proficiencyBonus, 3);
});

test('hit points use base + con per level, minus damage taken', () => {
  assert.equal(sheet.hp.max, 45); // 33 + (2 con x 6 levels)
  assert.equal(sheet.hp.current, 38);
  assert.equal(sheet.hp.temp, 5);
  assert.equal(sheet.hp.percent, 84);
});

test('armor class uses worn armor, dex, and attuned item bonuses', () => {
  assert.equal(sheet.ac.value, 16); // 12 studded leather + 3 dex + 1 cloak
  assert.deepEqual(sheet.ac.armor, ['Studded Leather']);
  assert.equal(sheet.ac.shield, false); // the shield is carried, not equipped
});

test('condition-group modifiers never leak into the sheet', () => {
  assert.ok(sheet.ac.value < 99);
});

test('skills apply proficiency to the right ability', () => {
  assert.equal(skill('perception').value, 4); // +1 wis +3 prof
  assert.equal(skill('perception').proficiency, 'proficient');
  assert.equal(skill('deception').value, 7); // +4 cha +3 prof
  assert.equal(skill('stealth').value, 3); // dex only, unproficient
  assert.equal(skill('stealth').proficiency, 'none');
  assert.equal(sheet.skills.filter((s) => s.proficiency !== 'none').length, 4);
});

test('passive scores start from the matching skill', () => {
  assert.equal(sheet.passives.perception, 14);
  assert.equal(sheet.passives.investigation, 10);
  assert.equal(sheet.passives.insight, 11);
});

test('saving throws add proficiency and the cloak bonus', () => {
  assert.equal(save('cha').value, 8); // +4 cha +3 prof +1 cloak
  assert.equal(save('cha').proficient, true);
  assert.equal(save('wis').value, 5);
  assert.equal(save('str').value, 0); // -1 str +1 cloak
  assert.equal(save('str').proficient, false);
});

test('languages, senses, and other proficiencies are collected', () => {
  assert.deepEqual(sheet.languages, ['Common', 'Draconic', 'Elvish']);
  assert.deepEqual(sheet.senses, [{ name: 'Darkvision', distance: 60 }]);
  assert.deepEqual(sheet.otherProficiencies, ['Light Armor']);
});

test('spellcasting DC comes from the class casting ability', () => {
  assert.equal(sheet.spellcasting.length, 1);
  assert.equal(sheet.spellcasting[0].dc, 15); // 8 + 3 prof + 4 cha
  assert.equal(sheet.spellcasting[0].attack, 7);
  assert.deepEqual(sheet.slots.pact, [{ level: 3, used: 1, available: 2 }]);
});

test('initiative, speed, conditions, and inspiration are surfaced', () => {
  assert.equal(sheet.initiative, 3);
  assert.equal(sheet.speed.walk, 30);
  assert.deepEqual(sheet.conditions, ['Poisoned']);
  assert.equal(sheet.inspiration, true);
});

test('unequipping armor falls back to the unarmored calculation', () => {
  const copy = JSON.parse(JSON.stringify(payload));
  copy.data.inventory[0].equipped = false;
  copy.data.inventory[1].isAttuned = false;
  assert.equal(DDBStats.build(copy).ac.value, 13); // 10 + 3 dex, no cloak
});

test('an equipped shield and unarmored defense stack as expected', () => {
  const copy = JSON.parse(JSON.stringify(payload));
  copy.data.inventory[0].equipped = false;
  copy.data.inventory[2].equipped = true;
  copy.data.modifiers.class.push({
    id: 'monk-ud', type: 'set', subType: 'unarmored-armor-class', statId: 5, value: null
  });
  const out = DDBStats.build(copy);
  assert.equal(out.ac.value, 17); // 10 + 3 dex + 1 wis + 2 shield + 1 cloak
  assert.equal(out.ac.shield, true);
});

test('overridden max HP wins over the computed total', () => {
  const copy = JSON.parse(JSON.stringify(payload));
  copy.data.overrideHitPoints = 60;
  const out = DDBStats.build(copy);
  assert.equal(out.hp.max, 60);
  assert.equal(out.hp.current, 53);
  assert.equal(out.hp.isOverridden, true);
});

test('expertise doubles proficiency and jack-of-all-trades halves it', () => {
  const copy = JSON.parse(JSON.stringify(payload));
  copy.data.modifiers.class.push(
    { id: 'e1', type: 'expertise', subType: 'deception' },
    { id: 'j1', type: 'half-proficiency', subType: 'ability-checks' }
  );
  const out = DDBStats.build(copy);
  const deception = out.skills.find((s) => s.slug === 'deception');
  const stealth = out.skills.find((s) => s.slug === 'stealth');
  assert.equal(deception.value, 10); // +4 cha + (3 x 2)
  assert.equal(deception.proficiency, 'expertise');
  assert.equal(stealth.value, 4); // +3 dex + floor(3/2)
  assert.equal(stealth.proficiency, 'half');
});

test('multiclass levels drive one shared proficiency bonus', () => {
  const copy = JSON.parse(JSON.stringify(payload));
  copy.data.classes.push({
    level: 5, definition: { name: 'Rogue', spellCastingAbilityId: null }, subclassDefinition: null
  });
  const out = DDBStats.build(copy);
  assert.equal(out.level, 11);
  assert.equal(out.proficiencyBonus, 4);
  assert.equal(out.classes, 'Warlock (The Great Old One) 6 / Rogue 5');
});

test('a bare character object (no envelope) also works', () => {
  const out = DDBStats.build(payload.data);
  assert.equal(out.name, 'Cailynn Falkrest');
});
