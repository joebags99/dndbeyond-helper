/**
 * Injects an at-a-glance stat block into every character card on a D&D Beyond
 * campaign page. Reads nothing from the page beyond the character ids in the
 * card links; everything else comes from the character service.
 */
(function () {
  'use strict';

  const DEFAULTS = {
    showAbilities: true,
    showSaves: true,
    showSkills: true,
    skillMode: 'proficient',
    showLanguages: true,
    showSenses: true,
    showSpellcasting: true,
    showOtherProficiencies: false,
    startExpanded: true,
    cacheTtlSeconds: 300
  };

  const CARD_SELECTORS = [
    '.ddb-campaigns-character-card',
    '.ddb-campaigns-character-card-wrapper',
    'li[class*="character-card"]'
  ];
  const CHARACTER_HREF = /\/characters\/(\d+)/;

  let settings = { ...DEFAULTS };
  let expandedByDefault = DEFAULTS.startExpanded;
  const panels = new Map(); // character id -> { root, card }

  const el = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  };

  const signed = (n) => (n >= 0 ? `+${n}` : `${n}`);

  function relativeTime(timestamp) {
    const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
    if (seconds < 45) return 'just now';
    const minutes = Math.round(seconds / 60);
    if (minutes < 60) return `${minutes} min ago`;
    const hours = Math.round(minutes / 60);
    return hours < 24 ? `${hours} hr ago` : `${Math.round(hours / 24)} d ago`;
  }

  /** Every character card that carries a /characters/<id> link. */
  function findCards() {
    const found = new Map();
    for (const link of document.querySelectorAll('a[href*="/characters/"]')) {
      const match = CHARACTER_HREF.exec(link.getAttribute('href') || '');
      if (!match) continue;
      const id = match[1];

      let card = null;
      for (const selector of CARD_SELECTORS) {
        card = link.closest(selector);
        if (card) break;
      }
      if (!card) continue;
      if (!found.has(card)) found.set(card, id);
    }
    return Array.from(found, ([card, id]) => ({ card, id }));
  }

  function statChip(label, value, options) {
    const { extraClass, title } = options || {};
    const chip = el('div', `ddbh-chip${extraClass ? ` ${extraClass}` : ''}`);
    chip.append(el('div', 'ddbh-chip__label', label), el('div', 'ddbh-chip__value', value));
    if (title) chip.title = title;
    return chip;
  }

  /** Highest save DC across casting classes; the rest go in the tooltip. */
  function spellSaveChip(sheet) {
    if (sheet.spellcasting.length === 0) return null;
    const [primary] = sheet.spellcasting;
    const title = sheet.spellcasting
      .map((c) => `${c.className}: DC ${c.dc}, attack ${signed(c.attack)} (${c.ability})`)
      .join(' \u00b7 ');
    return statChip('Spell Save DC', primary.dc, { extraClass: 'ddbh-chip--spell', title });
  }

  function hitPointChip(hp) {
    const chip = el('div', 'ddbh-chip ddbh-chip--hp');
    const label = el('div', 'ddbh-chip__label', 'Hit Points');
    const value = el('div', 'ddbh-chip__value', `${hp.current} / ${hp.max}`);
    if (hp.temp > 0) value.append(el('span', 'ddbh-chip__temp', ` +${hp.temp} temp`));

    let tone = 'ok';
    if (hp.current <= 0) tone = 'down';
    else if (hp.percent <= 25) tone = 'critical';
    else if (hp.percent <= 50) tone = 'hurt';

    const track = el('div', 'ddbh-hpbar');
    const fill = el('div', `ddbh-hpbar__fill ddbh-hpbar__fill--${tone}`);
    fill.style.width = `${hp.percent}%`;
    track.append(fill);

    chip.append(label, value, track);
    return chip;
  }

  function section(title, body) {
    const wrapper = el('section', 'ddbh-section');
    wrapper.append(el('h4', 'ddbh-section__title', title), body);
    return wrapper;
  }

  function tagList(values, className) {
    const list = el('div', `ddbh-tags${className ? ` ${className}` : ''}`);
    for (const value of values) list.append(el('span', 'ddbh-tag', value));
    return list;
  }

  function abilitiesGrid(sheet) {
    const grid = el('div', 'ddbh-abilities');
    for (const ability of sheet.abilities) {
      const box = el('div', 'ddbh-ability');
      box.append(
        el('div', 'ddbh-ability__label', ability.label),
        el('div', 'ddbh-ability__mod', signed(ability.modifier)),
        el('div', 'ddbh-ability__score', ability.score)
      );
      box.title = `${ability.name} ${ability.score} (${signed(ability.modifier)})`;
      grid.append(box);
    }
    return grid;
  }

  function savesRow(sheet) {
    const row = el('div', 'ddbh-saves');
    for (const save of sheet.saves) {
      const box = el('div', `ddbh-save${save.proficient ? ' is-proficient' : ''}`);
      box.append(el('span', 'ddbh-save__label', save.label), el('span', 'ddbh-save__value', signed(save.value)));
      box.title = `${save.name} save${save.proficient ? ' (proficient)' : ''}`;
      row.append(box);
    }
    return row;
  }

  function skillsList(sheet) {
    const all = settings.skillMode === 'all';
    const shown = all ? sheet.skills : sheet.skills.filter((s) => s.proficiency !== 'none');
    if (shown.length === 0) return el('div', 'ddbh-empty', 'No skill proficiencies.');

    const list = el('div', 'ddbh-skills');
    for (const skill of shown) {
      const row = el('div', `ddbh-skill ddbh-skill--${skill.proficiency}`);
      const name = el('span', 'ddbh-skill__name', skill.label);
      if (skill.proficiency === 'expertise') name.append(el('span', 'ddbh-skill__badge', 'EX'));
      row.append(
        name,
        el('span', 'ddbh-skill__ability', skill.abilityLabel),
        el('span', 'ddbh-skill__value', signed(skill.value))
      );
      row.title = `${skill.label} (${skill.abilityLabel}) ${signed(skill.value)}`;
      list.append(row);
    }
    return list;
  }

  function spellcastingBody(sheet) {
    const body = el('div', 'ddbh-spellcasting');
    for (const caster of sheet.spellcasting) {
      const row = el('div', 'ddbh-spell-row');
      row.append(
        el('span', 'ddbh-spell-row__class', caster.className),
        el('span', 'ddbh-spell-row__stat', `DC ${caster.dc}`),
        el('span', 'ddbh-spell-row__stat', `atk ${signed(caster.attack)}`),
        el('span', 'ddbh-spell-row__ability', caster.ability)
      );
      body.append(row);
    }
    const slots = [
      ...sheet.slots.spell.map((s) => `L${s.level}: ${s.available - s.used}/${s.available}`),
      ...sheet.slots.pact.map((s) => `Pact L${s.level}: ${s.available - s.used}/${s.available}`)
    ];
    if (slots.length > 0) {
      const row = el('div', 'ddbh-slots');
      row.append(el('span', 'ddbh-slots__label', 'Slots'), el('span', 'ddbh-slots__value', slots.join(' · ')));
      body.append(row);
    }
    return body;
  }

  function renderSheet(panel, sheet, meta) {
    panel.replaceChildren();
    panel.dataset.state = 'ready';

    const flags = el('div', 'ddbh-flags');
    if (sheet.hp.current <= 0) flags.append(el('span', 'ddbh-flag ddbh-flag--danger', 'Unconscious / dying'));
    for (const condition of sheet.conditions) flags.append(el('span', 'ddbh-flag ddbh-flag--warn', condition));
    if (sheet.inspiration) flags.append(el('span', 'ddbh-flag ddbh-flag--good', 'Inspiration'));
    if (flags.childElementCount > 0) panel.append(flags);

    const bar = el('div', 'ddbh-bar');
    bar.append(
      hitPointChip(sheet.hp),
      statChip('AC', sheet.ac.value, { title: sheet.ac.armor.join(', ') || 'Unarmored' }),
      statChip('Passive Perception', sheet.passives.perception),
      statChip('Passive Insight', sheet.passives.insight),
      statChip('Initiative', signed(sheet.initiative)),
      statChip('Speed', `${sheet.speed.walk} ft`),
      statChip('Prof. Bonus', signed(sheet.proficiencyBonus))
    );
    const spellChip = spellSaveChip(sheet);
    if (spellChip) bar.append(spellChip);
    panel.append(bar);

    const details = el('div', 'ddbh-details');
    if (!expandedByDefault) details.hidden = true;

    if (settings.showAbilities) details.append(section('Ability Scores', abilitiesGrid(sheet)));
    if (settings.showSaves) details.append(section('Saving Throws', savesRow(sheet)));
    if (settings.showSkills) {
      details.append(
        section(settings.skillMode === 'all' ? 'Skills' : 'Skill Proficiencies', skillsList(sheet))
      );
    }
    if (settings.showSenses) {
      const passives = [
        `Perception ${sheet.passives.perception}`,
        `Investigation ${sheet.passives.investigation}`,
        `Insight ${sheet.passives.insight}`
      ];
      const senses = sheet.senses.map((s) => `${s.name} ${s.distance} ft`);
      const extraSpeeds = sheet.speed.extras.map((s) => `${s.name} ${s.distance} ft`);
      details.append(section('Passive Scores & Senses', tagList([...passives, ...senses, ...extraSpeeds])));
    }
    if (settings.showLanguages) {
      details.append(
        section(
          'Languages',
          sheet.languages.length > 0
            ? tagList(sheet.languages)
            : el('div', 'ddbh-empty', 'No languages listed.')
        )
      );
    }
    if (settings.showOtherProficiencies && sheet.otherProficiencies.length > 0) {
      details.append(section('Other Proficiencies', tagList(sheet.otherProficiencies)));
    }
    if (settings.showSpellcasting && (sheet.spellcasting.length > 0 || sheet.slots.spell.length > 0)) {
      details.append(section('Spellcasting', spellcastingBody(sheet)));
    }

    const footer = el('div', 'ddbh-panel__footer');
    const toggle = el('button', 'ddbh-toggle', expandedByDefault ? 'Hide details' : 'Show details');
    toggle.type = 'button';
    toggle.addEventListener('click', () => {
      details.hidden = !details.hidden;
      toggle.textContent = details.hidden ? 'Show details' : 'Hide details';
    });
    const stamp = el('span', 'ddbh-stamp', meta.stale ? `cached ${relativeTime(meta.fetchedAt)}` : relativeTime(meta.fetchedAt));
    footer.append(toggle, stamp);

    panel.append(details, footer);
  }

  function renderError(panel, message, id) {
    panel.replaceChildren();
    panel.dataset.state = 'error';
    const box = el('div', 'ddbh-error');
    box.append(el('span', 'ddbh-error__text', message));
    const retry = el('button', 'ddbh-retry', 'Retry');
    retry.type = 'button';
    retry.addEventListener('click', () => refresh([id], true));
    box.append(retry);
    panel.append(box);
  }

  function renderLoading(panel) {
    panel.replaceChildren();
    panel.dataset.state = 'loading';
    panel.append(el('div', 'ddbh-loading', 'Loading stats…'));
  }

  function ensurePanel(card, id) {
    const tracked = panels.get(id);
    // The listing re-renders on paging, and can hand back markup that already
    // contains one of our panels; drop anything we are not actively tracking.
    for (const stale of card.querySelectorAll('.ddbh-panel')) {
      if (!tracked || stale !== tracked.root) stale.remove();
    }
    if (tracked && tracked.root.isConnected) return tracked.root;

    const panel = el('div', 'ddbh-panel');
    panel.dataset.characterId = id;

    // Cards render as header + footer links; sit between them when we can.
    const footer = card.querySelector('.ddb-campaigns-character-card-footer');
    if (footer && footer.parentElement) footer.parentElement.insertBefore(panel, footer);
    else card.append(panel);

    card.classList.add('ddbh-enhanced');
    panels.set(id, { root: panel, card });
    return panel;
  }

  function setToolbarStatus(text) {
    const status = document.querySelector('.ddbh-toolbar__status');
    if (status) status.textContent = text;
  }

  async function refresh(ids, force) {
    if (ids.length === 0) return;
    for (const id of ids) {
      const entry = panels.get(id);
      if (entry) renderLoading(entry.root);
    }
    setToolbarStatus(force ? 'Refreshing…' : 'Loading…');

    let response;
    try {
      response = await chrome.runtime.sendMessage({ type: 'getCharacters', ids, force });
    } catch (error) {
      // Happens when the extension is reloaded out from under the page.
      for (const id of ids) {
        const entry = panels.get(id);
        if (entry) renderError(entry.root, 'Extension was reloaded — refresh the page.', id);
      }
      setToolbarStatus('Disconnected');
      return;
    }

    if (!response || !response.ok) {
      for (const id of ids) {
        const entry = panels.get(id);
        if (entry) renderError(entry.root, (response && response.error) || 'Unknown error.', id);
      }
      setToolbarStatus('Error');
      return;
    }

    let failures = 0;
    for (const result of response.results) {
      const entry = panels.get(String(result.id));
      if (!entry) continue;
      if (!result.ok) {
        failures += 1;
        renderError(entry.root, result.error, String(result.id));
        continue;
      }
      try {
        renderSheet(entry.root, DDBStats.build(result.payload), result);
      } catch (error) {
        failures += 1;
        renderError(entry.root, `Couldn’t read this sheet (${error.message}).`, String(result.id));
      }
    }

    const total = response.results.length;
    setToolbarStatus(
      failures > 0
        ? `${total - failures}/${total} loaded · updated ${relativeTime(Date.now())}`
        : `${total} character${total === 1 ? '' : 's'} · updated ${relativeTime(Date.now())}`
    );
  }

  function buildToolbar() {
    if (document.querySelector('.ddbh-toolbar')) return;
    const listing = document.querySelector('.rpgcharacter-listing, .listing-rpgcharacter');
    const anchor = (listing && listing.closest('.listing-container')) || listing;
    if (!anchor || !anchor.parentElement) return;

    const toolbar = el('div', 'ddbh-toolbar');
    const title = el('span', 'ddbh-toolbar__title', 'Stat blocks');
    const status = el('span', 'ddbh-toolbar__status', '');

    const expandAll = el('button', 'ddbh-toolbar__button', 'Expand all');
    expandAll.type = 'button';
    expandAll.addEventListener('click', () => setAllExpanded(true));

    const collapseAll = el('button', 'ddbh-toolbar__button', 'Collapse all');
    collapseAll.type = 'button';
    collapseAll.addEventListener('click', () => setAllExpanded(false));

    const refreshButton = el('button', 'ddbh-toolbar__button', 'Refresh');
    refreshButton.type = 'button';
    refreshButton.addEventListener('click', () => refresh(Array.from(panels.keys()), true));

    const options = el('button', 'ddbh-toolbar__button ddbh-toolbar__button--ghost', 'Options');
    options.type = 'button';
    options.addEventListener('click', () => chrome.runtime.sendMessage({ type: 'openOptions' }).catch(() => {}));

    toolbar.append(title, expandAll, collapseAll, refreshButton, options, status);
    anchor.parentElement.insertBefore(toolbar, anchor);
  }

  function setAllExpanded(expanded) {
    expandedByDefault = expanded;
    for (const { root } of panels.values()) {
      const details = root.querySelector('.ddbh-details');
      const toggle = root.querySelector('.ddbh-toggle');
      if (!details || !toggle) continue;
      details.hidden = !expanded;
      toggle.textContent = expanded ? 'Hide details' : 'Show details';
    }
  }

  function scan() {
    const cards = findCards();
    const fresh = [];
    for (const { card, id } of cards) {
      const known = panels.get(id);
      if (known && known.root.isConnected) continue;
      const panel = ensurePanel(card, id);
      renderLoading(panel);
      fresh.push(id);
    }
    if (fresh.length > 0) {
      buildToolbar();
      refresh(fresh, false);
    }
  }

  function watchForCardChanges() {
    const observer = new MutationObserver((mutations) => {
      const touched = mutations.some((m) =>
        Array.from(m.addedNodes).some(
          (node) => node.nodeType === 1 && (node.matches('a[href*="/characters/"]') || node.querySelector('a[href*="/characters/"]'))
        )
      );
      if (touched) scan();
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  async function init() {
    const stored = await chrome.storage.sync.get(DEFAULTS);
    settings = { ...DEFAULTS, ...stored };
    expandedByDefault = settings.startExpanded;
    scan();
    watchForCardChanges();

    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'sync') return;
      for (const [key, change] of Object.entries(changes)) settings[key] = change.newValue;
      expandedByDefault = settings.startExpanded;
      refresh(Array.from(panels.keys()), false);
    });
  }

  init();
})();
