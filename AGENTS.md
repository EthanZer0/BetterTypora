# AGENTS.md

> An operating guide for AI coding agents working in this repository. The full development guide is [docs/PLUGIN-DEV.md](docs/PLUGIN-DEV.md) (architecture, complete API reference, theme adaptation guidelines, debugging) with an English mirror at [docs/PLUGIN-DEV_EN.md](docs/PLUGIN-DEV_EN.md). This file is the condensed version — read it before touching code to avoid known pitfalls.

## Project Overview

- **BetterTypora**: an open-source plugin system for Typora (MIT license, public repo).
- **Injection**: the Typora deployment file `resources/window.html` loads `./plugins/plugin-loader.js` before `</body>` (a single script line; no main-process changes). `resources/window.html` belongs to the Typora installation and may not exist in this source repository.
- **Plugin model**: each plugin is a `plugins/<plugin-id>/` directory with `manifest.json` + `main.js` (optional `style.css`, `package.json`, supporting modules, and committed tests). Lifecycle: `onLoad` → `enable` → `disable` → `onUnload`.
- **Runtime**: Typora Electron renderer process (DOM available, `reqnode` for Node modules). Runtime source is plain JavaScript with no transpilation; release packaging and plugin dependencies still have dedicated steps.

## Directory Layout

```
plugins/plugin-loader.js     # core bootloader (EventBus/Command/Settings/Hotkey/PluginManager/Theme/markdown/scroll/preference bridge)
plugins/<plugin-id>/         # one directory per plugin
docs/PLUGIN-DEV.md           # full development guide (CN); PLUGIN-DEV_EN.md is the EN mirror
README.md / README_en.md     # repository homepages (CN / EN)
AGENTS.md                    # this file
```

## Code Style Constraints

- **ES5 style** for runtime code (plugins, loader, and browser-facing supporting modules): `var`, function declarations; no arrow functions / `class` / `let` / `const` / template literals. Node-based tests may use APIs supported by the project's minimum Node version; WGSL shader source embedded in a JavaScript string is not runtime JavaScript.
- **Comments in Chinese**, explaining the *why* (constraints, pitfalls), not the *what*. Keep comments concise and document compatibility assumptions when a workaround depends on Typora internals.
- Plugins obtain the API via `require("bettertypora:api")`: `BT.api` (PluginAPI), `BT.logger`, `BT.pluginDir`, `BT.escapeHtml`, `BT.onFileEvent`, `BT.offFileEvent`, `BT.openFileInCurrentWindow`, `BT.createTimerGroup`, etc. (full list in PLUGIN-DEV.md).
- Timers must be created via `BT.createTimerGroup()` / `BetterTypora.createTimerGroup()` and `close()`d in `disable`/`onUnload` — the standard leak-prevention pattern.
- Every plugin must clean up its own DOM nodes, DOM listeners, event subscriptions, setting listeners, hotkeys, and other registrations when disabled. `api.onSettingChange()` currently has no unsubscribe return value, so registration must be idempotent across repeated enable/disable cycles.
- New configurable options: add a default to `manifest.settings` + declare UI in `manifest.settingsSchema` (`{key, label, type: boolean|number|text|select, default, desc, min/max}`); the preferences panel renders automatically. Apply changes in real time with `api.onSettingChange(fn)` (args: `key, value`).

## Theme Adaptation (Important)

- **Use Typora CSS variables only**; never `prefers-color-scheme` / `matchMedia` for light-dark detection (Typora's light/dark is unrelated to the OS setting).
- Fallback chains must bridge through variables: `var(--heading-text-color, var(--text-color, rgba(128,128,128,0.9)))`; hardcoded colors must be neutral gray `rgba(128,128,128,N)` — never `rgba(0,0,0,N)` or `rgba(255,255,255,N)` alone.
- In JS, prefer `BetterTypora.theme` (`isDark` / `onChange` / `getSidebarTabsMode` / `getSidebarTabSlots`); hand-written luminance parsing is allowed only in modules without `BetterTypora` access (e.g. workers).
- Full spec: Appendix A of PLUGIN-DEV.md.

## Build / Test / Deploy

- **Runtime has no transpilation step**, but release packaging does: use `scripts/build-release.ps1` to create a release archive. Plugins with a `package.json` must have their dependencies installed before deployment; run their declared tests.
- **Validation**: run `node --check` for changed runtime JavaScript, parse changed JSON manifests, and run relevant `*.test.js` files or package test scripts. Tests should be isolated from the project worktree when they create files.
- **Deployment**: copy changed plugin files to `Typora 安装目录/resources/plugins/`. The current development machine uses `D:\Fold\Tool\Typora\resources\plugins\`; do not assume this path for other environments. The loader injection line belongs to the deployed `resources/window.html` and should only be changed when explicitly required.
- **Verification**: changes to the loader or deployed window injection require restarting Typora. Plugin JavaScript and CSS can be manually refreshed with `reloadPlugin()` when supported; there is no automatic file-watching CSS hot update.
- Temporary test documents such as `*测试*.md` or `untitled.md` are not committed. Repository unit tests (`plugins/*/tests/*.test.js`) and intentional product assets are tracked source and may be committed.

## Commit Conventions

- Conventional commits: `feat:` / `fix:` / `style:` / `docs:` / `chore:`.
- Split logically independent changes into separate commits.
- Before committing, inspect `git status`, run the relevant automated checks, and exclude temporary documents, generated archives, caches, and personal local assets. Tracked unit tests and intentional product assets are allowed.
- For code changes, deploy and provide a verification point for the user. User acceptance is required before release or final integration; it should not prevent an otherwise validated development commit when Typora cannot be launched in the current environment.
