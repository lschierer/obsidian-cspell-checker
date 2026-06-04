# CSpell Checker for Obsidian

An offline spell-checking plugin for Obsidian that uses [cspell-lib](https://github.com/streetsidesoftware/cspell) — the same engine behind the popular VS Code spell checker. It reads your project's existing `cspell.json` configuration, so dictionaries, custom word lists, and settings are shared across your editor tooling.

## Features

- **Uses your existing cspell.json** — walks up from the vault directory to find `cspell.json`, `.cspell.json`, `cspell.config.json`, `cspell.yaml`, or `cspell.yml`.
- **Bundled dictionaries** — automatically locates the `@cspell/dict-en_us` trie from `node_modules` (pnpm or npm layouts).
- **Custom dictionaries** — honors `dictionaryDefinitions` with file paths (absolute or relative, `~` expanded).
- **Add to dictionary** — right-click a misspelled word to add it to whichever dictionary has `addWords: true`.
- **Suggestions** — right-click for up to 5 spelling suggestions from cspell's suggestion engine.
- **Viewport-only checking** — only processes visible text via CodeMirror 6 `visibleRanges`, keeping performance constant regardless of document size.
- **Completely offline** — no network requests, no external APIs.
- **Disables native spellcheck** — suppresses the browser/OS spell checker to avoid duplicate squiggles and conflicting context menus.

## Requirements

- Obsidian (desktop only — uses Node.js `fs` and `path`)
- A `cspell.json` config file somewhere in or above your vault directory
- Dictionary packages installed in the project's `node_modules` (e.g. `@cspell/dict-en_us`)

## Installation

Copy `main.js`, `manifest.json`, and `styles.css` into your vault's `.obsidian/plugins/cspell-checker/` directory, then enable "CSpell Checker" in Settings → Community Plugins.

**Important:** Disable Obsidian's built-in spell checker (Settings → Editor → Spell check) to avoid duplicate/conflicting squiggles. This plugin replaces it with cspell-powered checking that respects your project's `cspell.json` configuration.

If you're developing this plugin alongside the vault, use `mise run install` from this project directory (see mise.toml).

## Configuration

The plugin reads configuration from your `cspell.json`. A minimal example:

```json
{
  "version": "0.2",
  "language": "en-US",
  "dictionaries": ["en-us", "project-words"],
  "dictionaryDefinitions": [
    {
      "name": "project-words",
      "path": "./.cspell/project-words.txt",
      "addWords": true
    }
  ]
}
```

## Settings

- **Enable/disable** — toggle spell checking on and off
- **Reload** — re-scan for `cspell.json` and reload all dictionaries after config changes

## Building

```sh
mise run build
```

## License

MIT
