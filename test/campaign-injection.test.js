/**
 * Runs the content script against the markup D&D Beyond actually serves for a
 * campaign page, with the extension APIs stubbed out.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const html = fs.readFileSync(path.join(__dirname, 'fixtures', 'campaign-page.html'), 'utf8');
const statsSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'lib', 'ddb-stats.js'), 'utf8');
const contentSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'content', 'campaign.js'), 'utf8');
const payload = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'warlock6.json'), 'utf8'));

const IDS = ['132553946', '132557509', '131883097'];

function characterPayload(id, name) {
  const copy = JSON.parse(JSON.stringify(payload));
  copy.data.id = Number(id);
  copy.data.name = name;
  return copy;
}

/** Boots a jsdom page with the content script loaded and the chrome API stubbed. */
async function bootPage({ failFor = [] } = {}) {
  const dom = new JSDOM(html, { url: 'https://www.dndbeyond.com/campaigns/5889945', runScripts: 'outside-only' });
  const { window } = dom;
  const requests = [];

  window.chrome = {
    runtime: {
      sendMessage: async (message) => {
        requests.push(message);
        if (message.type !== 'getCharacters') return { ok: true };
        return {
          ok: true,
          results: message.ids.map((id) =>
            failFor.includes(id)
              ? { id, ok: false, error: 'Not readable.' }
              : { id, ok: true, payload: characterPayload(id, `Character ${id}`), fetchedAt: Date.now() }
          )
        };
      }
    },
    storage: {
      sync: { get: async (defaults) => ({ ...defaults }) },
      onChanged: { addListener() {} }
    }
  };

  window.eval(statsSource);
  window.eval(contentSource);

  await waitFor(window, () => window.document.querySelectorAll('.ddbh-panel[data-state="ready"], .ddbh-panel[data-state="error"]').length === IDS.length);
  return { window, document: window.document, requests };
}

function waitFor(window, predicate, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      if (predicate()) return resolve();
      if (Date.now() - started > timeoutMs) return reject(new Error('timed out waiting for the page'));
      setTimeout(tick, 5);
    };
    tick();
  });
}

test('injects one panel per character card', async () => {
  const { document } = await bootPage();
  const injected = document.querySelectorAll('.ddbh-panel');
  assert.equal(injected.length, IDS.length);
  assert.deepEqual(Array.from(injected, (p) => p.dataset.characterId).sort(), [...IDS].sort());
});

test('requests exactly the character ids found in the card links', async () => {
  const { requests } = await bootPage();
  const fetches = requests.filter((r) => r.type === 'getCharacters');
  assert.equal(fetches.length, 1);
  assert.deepEqual(Array.from(fetches[0].ids).sort(), [...IDS].sort());
  assert.equal(fetches[0].force, false);
});

test('places the panel between the card body and its action links', async () => {
  const { document } = await bootPage();
  const card = document.querySelector('.ddb-campaigns-character-card');
  const children = Array.from(card.children).map((c) => c.className.split(' ')[0]);
  assert.deepEqual(children, [
    'ddb-campaigns-character-card-header',
    'ddbh-panel',
    'ddb-campaigns-character-card-footer'
  ]);
});

test('renders the headline numbers a DM scans for', async () => {
  const { document } = await bootPage();
  const panel = document.querySelector('.ddbh-panel[data-character-id="132553946"]');
  const text = panel.textContent;
  assert.match(text, /38 \/ 45/); // current / max hit points
  assert.match(text, /\+5 temp/);
  assert.ok(text.includes('Passive Perc.'));
  assert.ok(text.includes('14')); // passive perception

  const chips = Array.from(panel.querySelectorAll('.ddbh-chip'), (c) => c.querySelector('.ddbh-chip__label').textContent);
  assert.deepEqual(chips, ['Hit Points', 'AC', 'Passive Perc.', 'Initiative', 'Speed', 'Prof.']);
});

test('lists only proficient skills by default, with languages and senses', async () => {
  const { document } = await bootPage();
  const panel = document.querySelector('.ddbh-panel[data-character-id="132553946"]');
  const skills = Array.from(panel.querySelectorAll('.ddbh-skill__name'), (n) => n.textContent);
  assert.deepEqual(skills.sort(), ['Arcana', 'Deception', 'History', 'Perception']);

  const tags = Array.from(panel.querySelectorAll('.ddbh-tag'), (t) => t.textContent);
  assert.ok(tags.includes('Common'));
  assert.ok(tags.includes('Elvish'));
  assert.ok(tags.includes('Darkvision 60 ft'));
});

test('surfaces conditions as a flag', async () => {
  const { document } = await bootPage();
  const flags = Array.from(
    document.querySelector('.ddbh-panel').querySelectorAll('.ddbh-flag'),
    (f) => f.textContent
  );
  assert.ok(flags.includes('Poisoned'));
  assert.ok(flags.includes('Inspiration'));
});

test('shows a per-card message when one sheet is unreadable', async () => {
  const { document } = await bootPage({ failFor: ['132557509'] });
  const failed = document.querySelector('.ddbh-panel[data-character-id="132557509"]');
  assert.equal(failed.dataset.state, 'error');
  assert.match(failed.textContent, /Not readable/);
  assert.ok(failed.querySelector('.ddbh-retry'));

  const ok = document.querySelector('.ddbh-panel[data-character-id="132553946"]');
  assert.equal(ok.dataset.state, 'ready');
});

test('adds a toolbar above the listing and toggles every panel', async () => {
  const { document, window } = await bootPage();
  const toolbar = document.querySelector('.ddbh-toolbar');
  assert.ok(toolbar);
  assert.equal(toolbar.nextElementSibling.classList.contains('listing-container'), true);

  const buttons = Array.from(toolbar.querySelectorAll('button'), (b) => b.textContent);
  assert.deepEqual(buttons, ['Expand all', 'Collapse all', 'Refresh', 'Options']);

  const collapse = Array.from(toolbar.querySelectorAll('button')).find((b) => b.textContent === 'Collapse all');
  collapse.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  assert.equal(Array.from(document.querySelectorAll('.ddbh-details')).every((d) => d.hidden), true);

  const expand = Array.from(toolbar.querySelectorAll('button')).find((b) => b.textContent === 'Expand all');
  expand.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  assert.equal(Array.from(document.querySelectorAll('.ddbh-details')).some((d) => d.hidden), false);
});

test('picks up cards added after the first render without duplicating panels', async () => {
  const { document, window, requests } = await bootPage();
  const list = document.querySelector('ul.listing-rpgcharacter');
  const clone = list.firstElementChild.cloneNode(true);
  for (const link of clone.querySelectorAll('a[href*="/characters/"]')) {
    link.setAttribute('href', link.getAttribute('href').replace('132553946', '999111222'));
  }
  list.append(clone);

  await waitFor(window, () => document.querySelectorAll('.ddbh-panel').length === IDS.length + 1);
  assert.equal(document.querySelectorAll('.ddbh-panel[data-character-id="132553946"]').length, 1);

  const lastFetch = requests.filter((r) => r.type === 'getCharacters').pop();
  assert.deepEqual(Array.from(lastFetch.ids), ['999111222']);
});
