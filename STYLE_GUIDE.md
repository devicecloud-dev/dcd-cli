# CLI output style guide

All human-facing terminal output is rendered through a single layer so every
command looks the same. The visual language is a **tree**, inspired by Claude
Code: top-level `⏺` section headings, with `⎿` branch groups of indented detail
rows beneath them.

```
⏺ Upload Status
  ⎿ ✓ passed
    name        Checkout flow
    upload id   a1b2c3d4
    created     Jun 22 2026, 10:30
    console     https://console.devicecloud.dev/…

⏺ Test Results
  ⎿ ✓ login.yaml      12s
    ✗ checkout.yaml    8s · assertion failed
```

## The rules

1. **Never build output by hand.** Commands compose from `src/utils/ui.ts` and
   the helpers in `src/utils/styling.ts`. Do not concatenate `colors.*`,
   `symbols.*`, or raw strings into bespoke layouts inside a command — if you
   need a shape that isn't there, add it to `ui` so every command gets it.

2. **Print through the logger.** Use `logger` from `src/utils/cli.ts`
   (`logger.log` / `logger.warn` / `logger.error`). Never `console.log` directly
   except for the single `JSON.stringify` line in `--json` mode.

3. **Sections then branches.** A screen is one or more `ui.section(title)`
   headings, each followed by a `ui.branch([...])` group of detail rows. Key/
   value detail uses `ui.fields([[label, value], …])` (dim, aligned labels) fed
   into `ui.branch`.

4. **Status is centralised.** Anything with a run/test status
   (passed/failed/running/pending/queued/cancelled) renders via `ui.status`,
   `ui.statusSymbol`, or `ui.statusWord`, which all draw from
   `statusPalette` in `styling.ts`. Never re-derive the status→colour→symbol
   mapping in a command or service.

5. **Standalone messages have a glyph.** Use `ui.success` (`✓`, emphasised),
   `ui.info` (`ℹ`), `ui.warn` (`⚠`), `ui.running` (`▶`), and `ui.note` (dim
   secondary text). Errors go through `logger.error`, which prepends `✗ Error:`.

6. **Colour carries meaning, structure stays muted.** The `⏺`/`⎿` glyphs and
   field labels are dim; colour is reserved for status and for emphasising a
   value (IDs via `formatId`, URLs via `formatUrl`). Don't colour a label.

7. **`--json` suppresses everything else.** When `--json` is set, emit only the
   single serialized object and gate all other output behind the flag (the
   `out()` wrapper pattern in `cloud.ts`/`upload.ts`).

8. **No full-width rulers.** The 80-char `dividers` and `box` are deprecated;
   the tree provides the structure. Status words are lowercase.

## Cookbook

```ts
import { logger } from '../utils/cli';
import { ui } from '../utils/ui';
import { formatId, formatUrl } from '../utils/styling';

// A section with a key/value detail block:
logger.log(ui.section('Upload Status'));
logger.log(
  ui.branch([
    ui.status(status),
    ...ui.fields([
      ['name', name],
      ['upload id', formatId(uploadId)],
      ['console', formatUrl(consoleUrl)],
    ]),
  ]),
);

// A list of status rows:
logger.log(ui.section('Test Results'));
logger.log(
  ui.branch(
    tests.map((t) => `${ui.statusSymbol(t.status)} ${t.name}`),
  ),
);

// Standalone messages:
logger.log(ui.success('Upload complete'));
logger.log(ui.info('Keeping existing session'));
logger.log(ui.warn('No devices matched; using defaults'));
```
