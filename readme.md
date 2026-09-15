# D&D Beyond Campaign Stat Blocks

A Chrome extension for DMs. On a D&D Beyond campaign page each character card
normally shows only a name, level, species and class. This adds a stat block
under every card so you can read the whole party at a glance.

Always visible on each card:

- **Hit points** — current / max, with a colour-coded bar and any temp HP
- **AC**, **passive Perception**, **passive Insight**, **initiative**, **walking speed**,
  **proficiency bonus**
- **Spell save DC** for anyone with a casting class (hover for the attack bonus,
  casting ability, and every class when multiclassed)
- Flags for active **conditions**, **inspiration**, and characters at 0 HP

Behind a per-card *Show details* toggle (open by default):

- **Ability scores** with modifiers
- **Saving throws**, with proficient ones highlighted
- **Skill proficiencies** (expertise marked `EX`; optionally all eighteen skills)
- **Passive Perception / Investigation / Insight**, plus darkvision and other senses
- **Languages**, and optionally armour / weapon / tool proficiencies
- **Spell save DC**, spell attack bonus and remaining spell or pact slots

A toolbar above the character list expands or collapses every card at once and
forces a refresh.

## Install

The extension is unpacked (it is not on the Chrome Web Store):

1. Clone or download this repository.
2. Open `chrome://extensions` and turn on **Developer mode** (top right).
3. Click **Load unpacked** and pick this folder — the one containing `manifest.json`.
4. Open a campaign page, e.g. `https://www.dndbeyond.com/campaigns/5889945`.

Stay signed in to D&D Beyond in that browser profile. Settings live at
`chrome://extensions` → *Details* → *Extension options*, or via the **Options**
button in the toolbar on the campaign page.

## How it works

- The content script reads only the character ids out of the `/characters/<id>`
  links already on the campaign page.
- The service worker fetches each sheet from
  `character-service.dndbeyond.com/character/v5/character/<id>`. It first trades
  your existing D&D Beyond session cookie for a short-lived token at
  `auth-service.dndbeyond.com/v1/cobalt-token`, which is what lets a DM read
  characters that are not set to fully public. If that exchange fails, it falls
  back to an unauthenticated request, which still resolves public characters.
- Sheets are cached in `chrome.storage.local` for five minutes by default
  (configurable, `0` disables it). *Refresh* always bypasses the cache. If a
  fetch fails but a cached copy exists, the cached copy is shown and labelled.
- Nothing is sent anywhere except to D&D Beyond's own APIs. There is no
  analytics, no third-party host, and no remote code.

## Accuracy

Everything is derived from the character JSON the same way the sheet does it, so
the common cases line up: ability bonuses from species, feats and ASIs; armour
class from worn armour plus equipped shields, unarmoured defence and attuned
items; HP from hit dice plus Constitution per level (including Tough and
Dwarven Toughness style per-level bonuses); proficiency, expertise and Jack of
All Trades on skills.

Known gaps, all of which err toward showing the plain sheet value:

- Item modifiers count only while the item is equipped, and attuned when it
  requires attunement. Modifiers from homebrew or custom items that cannot be
  matched back to an inventory entry are counted.
- Per-level HP bonuses are applied over total character level, so an unusual
  multiclass can read a point or two high.
- Situational bonuses (conditions, spells like *Bless*, temporary effects) are
  not applied — conditions are shown as flags instead.

Treat the numbers as a fast reference. The character sheet remains the source of
truth.

## Development

```sh
npm install     # jsdom, for the DOM tests only
npm test        # stat maths + content-script injection against real page markup
npm run icons   # regenerate src/icons/*.png
```

- `src/lib/ddb-stats.js` — pure, dependency-free translation of a character
  payload into a display-ready stat block. Runs in the content script and in the
  tests.
- `src/content/campaign.js` — finds cards, injects panels, owns the toolbar.
- `src/background.js` — auth, fetching, caching, request fan-out.
- `test/fixtures/campaign-page.html` — trimmed copy of the markup D&D Beyond
  serves, so selector changes get caught by `npm test`.
