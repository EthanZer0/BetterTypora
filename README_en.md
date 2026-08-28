<p align="center">
  <img src="assets/logo.png" alt="BetterTypora" width="160">
</p>

<h1 align="center">BetterTypora</h1>

<p align="center">
  <a href="README.md">简体中文</a> | <b>English</b>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/version-v1.0.0-4c1?style=for-the-badge&logo=semver&logoColor=white" alt="v1.0.0">
  <img src="https://img.shields.io/badge/license-MIT-blue?style=for-the-badge" alt="MIT">
  <img src="https://img.shields.io/badge/JavaScript-F7DF1E?style=for-the-badge&logo=javascript&logoColor=black" alt="JavaScript">
  <img src="https://img.shields.io/badge/Windows-0078D6?style=for-the-badge&logo=windows&logoColor=white" alt="Windows">
  <img src="https://img.shields.io/badge/7%20plugins-2ea043?style=for-the-badge" alt="7 plugins">
</p>

An open-source plugin system for Typora. Enabled by injecting a single line of script into `resources/window.html`, it brings tabbed editing, split view, backlinks, knowledge graph, memory optimization and more to Typora.

## Features

- **Tabbed editing** — browser-style tab management: switching, drag-to-reorder, close/reopen, split-view collaboration, auto-hide
- **Split view** — write in two panes side by side, send tabs between panes, mount a live knowledge graph in the right pane
- **Backlinks + Knowledge Graph** — backlink panel, `[[]]` wikilink parsing & highlighting, Obsidian-style node graph (WebGPU accelerated)
- **Plugin settings panel** — configure every plugin graphically inside Typora's preferences, applied in real time
- **Lightweight** — each plugin is a single directory (`manifest.json` + `main.js` + `style.css`), drop-in installable

## Bundled Plugins

| Plugin | Description |
|--------|-------------|
| tabs | Tabbed editing: switching / drag-to-reorder / close & reopen / auto-hide |
| split-view | Split view: two panes, send tabs, mount knowledge graph in the right pane |
| bidirectional-links | Backlinks + wikilink highlighting + knowledge graph |
| memory-manager | Memory optimization: idle GC, webview cache cleanup, working-set trim |
| git-sync | Sync notes to a Git repository |
| word-translator | Selection translator (floating button + translation panel) |
| hello-world | Example plugin demonstrating the full API |

## Installation

**Option 1: Installer script (recommended, Windows)**

1. Download the repo (or `git clone`)
2. Run `安装.bat` (means "install.bat") — it auto-detects your Typora installation, backs up and injects `window.html`, and copies the plugins. Running without arguments shows a menu (install / uninstall / detect-only / exit).
3. Restart Typora

> Idempotent (re-running never double-injects), auto-backup (`window.html.bettertypora.bak`). Command-line passthrough: `安装.bat -Uninstall` to uninstall, `安装.bat -TyporaDir "D:\Tools\Typora\resources"` to specify the directory, `安装.bat -DetectOnly` to only detect the path.

**Option 2: Manual install**

1. Copy the `plugins/` directory into Typora's `resources/` folder
2. Add `<script src="./plugins/plugin-loader.js"></script>` before `</body>` in `resources/window.html`
3. Restart Typora — the plugin system starts automatically

## Documentation

- [Plugin Development Guide](docs/PLUGIN-DEV_EN.md) — architecture, API reference, manifest, events, debugging, theme adaptation guidelines

## License

[MIT License](LICENSE) — Copyright (c) 2026 BetterTypora contributors
