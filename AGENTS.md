# AGENTS.md

> An operating guide for AI coding agents working in this repository. The full development guide is [docs/PLUGIN-DEV.md](docs/PLUGIN-DEV.md) (architecture, complete API reference, theme adaptation guidelines, debugging) with an English mirror at [docs/PLUGIN-DEV_EN.md](docs/PLUGIN-DEV_EN.md). This file is the condensed version — read it before touching code to avoid known pitfalls.

## Project Overview

- **BetterTypora**: an open-source plugin system for Typora (MIT license, public repo).
- **Injection**: `resources/window.html` loads `./plugins/plugin-loader.js` before `</body>` (a single script line; no main-process changes).
- **Plugin model**: each plugin is a `plugins/<plugin-id>/` directory with `manifest.json` + `main.js` (optional `style.css`). Lifecycle: `onLoad` → `enable` → `disable` → `onUnload`.
- **Runtime**: Typora Electron renderer process (DOM available, `reqnode` for Node modules). No build step, plain JS.

## Directory Layout

```
plugins/plugin-loader.js     # core bootloader (EventBus/Command/Settings/Hotkey/PluginManager/Theme/markdown/scroll/preference bridge)
plugins/<plugin-id>/         # one directory per plugin
docs/PLUGIN-DEV.md           # full development guide (CN); PLUGIN-DEV_EN.md is the EN mirror
README.md / README_en.md     # repository homepages (CN / EN)
AGENTS.md                    # this file
```

## Code Style Constraints

- **ES5 style** (both plugins and the loader): `var`, function declarations; no arrow functions / `class` / `let` / `const` / template literals.
- **Comments in Chinese**, explaining the *why* (constraints, pitfalls), not the *what*.
- Plugins obtain the API via `require("bettertypora:api")`: `BT.api` (PluginAPI), `BT.logger`, `BT.pluginDir`, `BT.escapeHtml`, `BT.onFileEvent`, `BT.createTimerGroup`, etc. (full list in PLUGIN-DEV.md).
- Timers must be created via `BT.createTimerGroup()` / `BetterTypora.createTimerGroup()` and `close()`d in `disable`/`onUnload` — the standard leak-prevention pattern.
- New configurable options: add a default to `manifest.settings` + declare UI in `manifest.settingsSchema` (`{key, label, type: boolean|number|text|select, default, desc, min/max}`); the preferences panel renders automatically. Apply changes in real time with `api.onSettingChange(fn)` (args: `key, value`).

## Theme Adaptation (Important)

- **Use Typora CSS variables only**; never `prefers-color-scheme` / `matchMedia` for light-dark detection (Typora's light/dark is unrelated to the OS setting).
- Fallback chains must bridge through variables: `var(--heading-text-color, var(--text-color, #333))`; hardcoded colors must be neutral gray `rgba(128,128,128,N)` — never `rgba(0,0,0,N)` or `rgba(255,255,255,N)` alone.
- In JS, prefer `BetterTypora.theme` (`isDark` / `onChange` / `getSidebarTabsMode` / `getSidebarTabSlots`); hand-written luminance parsing is allowed only in modules without `BetterTypora` access (e.g. workers).
- Full spec: Appendix A of PLUGIN-DEV.md.

## Build / Test / Deploy

- **No build step**. Syntax check: `node --check plugins/<id>/main.js` (JSON via `JSON.parse`).
- **Deployment**: after changes, copy to the Typora deployment directory `D:\Fold\Tool\Typora\resources\plugins\` (loader at `resources\plugins\plugin-loader.js`; the window.html injection line already exists — don't touch it).
- **Verification requires restarting Typora** (renderer injection; no CSS hot-reload).
- Test files (`*测试*.md` etc.) are **never committed** — check `git status` before committing.

## Commit Conventions

- Conventional commits: `feat:` / `fix:` / `style:` / `docs:` / `chore:`.
- Split logically independent changes into separate commits; never commit test files or local assets.
- Code changes must be deployed and verified by the user (restart Typora) before committing.
