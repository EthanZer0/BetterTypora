# BetterTypora — Typora Plugin System

> A lightweight plugin framework for Typora. Injected into the renderer process via `window.html`, it provides plugin lifecycle management, an event bus, command registration, settings persistence, and more.

---

## Quick Start

### Installation

**1. Inject one line of script**

Edit `resources/window.html` in your Typora installation directory, add the following before `</body>`:

```html
<script src="./plugins/plugin-loader.js"></script>
```

**2. Copy the plugin system files**

Copy the `plugins/` directory from this repository into Typora's `resources/` folder (i.e. `resources/plugins/plugin-loader.js`, `resources/plugins/<plugin-id>/`).

**3. Restart Typora** — the plugin system starts automatically.

> `window.html` is a plain HTML file under `resources/` and can be edited directly.

### Your First Plugin

**1. Create a directory**

```
resources/plugins/my-plugin/
├── manifest.json
├── main.js
└── style.css        (optional)
```

**2. Write manifest.json**

```json
{
  "id": "my-plugin",
  "name": "My Plugin",
  "version": "1.0.0",
  "description": "What this plugin does",
  "author": "Your name",
  "main": "main.js",
  "style": "style.css",
  "enabled": true,
  "hotkeys": [
    {
      "command": "my-plugin:hello",
      "key": "Ctrl+Shift+J",
      "when": "always"
    }
  ],
  "settings": {
    "message": "Hello World!"
  }
}
```

**3. Write main.js**

```js
var BT = require("bettertypora:api");
var api = BT.api;
var logger = BT.logger;

module.exports = {
  enable: function () {
    api.registerCommand("hello", function () {
      var msg = api.getSetting("message", "Hello!");
      window.BetterTypora.toast(msg);
    }, "Say hello");
    logger.log("My plugin enabled ✅");
  },
  disable: function () {
    logger.log("My plugin disabled");
  }
};
```

**4. Restart Typora** — the plugin loads automatically.

---

## Architecture

```
window.html ── renderer entry (Typora's own, just one injected line)
  │
  └─ <script src="./plugins/plugin-loader.js">   ← BetterTypora's single injection point
       │
       ├── EventBus          — pub/sub event system
       ├── CommandRegistry   — named command register/execute
       ├── SettingsManager   — per-plugin JSON persistence (.cache/<id>.settings.json)
       ├── HotkeyManager     — keyboard shortcut binding
       ├── PluginManager     — lifecycle: scan → load → enable → disable → unload → reload
       ├── PluginAPI         — obtained by each plugin via require("bettertypora:api")
       └── window.BetterTypora — global API
```

### Key Design Decisions

| Decision | Choice | Rationale |
|------|------|------|
| Injection point | One `<script>` at the end of `window.html` | `window.html` is a plain-text file under `resources/` |
| Plugin directory | `resources/plugins/` | Independent from Typora's own files; survives Typora upgrades |
| API passing | `require("bettertypora:api")` | Virtual module injection, no global pollution |
| Load timing | Sync at body end + `setTimeout(fn, 0)` | `frame.js` is `defer`; plugins load one tick later so Typora is initialized |
| Menu injection | 500ms guard loop | `frame.js` may rebuild `innerHTML` anytime; the guard keeps menus alive |
| Main-process dependency | None | Pure renderer architecture; native menu/window events are unavailable |

---

## Global API: `window.BetterTypora`

All plugins and console scripts access the system through `window.BetterTypora`.

```js
// Plugin status
BetterTypora.status()            // → [{id, name, version, state, description, settingsSchema, settings}, ...]
BetterTypora.listPlugins()       // → ["hello-world", "my-plugin"]

// Plugin management
BetterTypora.getPlugin("id")     // → PluginInstance | null
BetterTypora.reloadPlugin("id")  // → hot reload (unload → load → enable if it was enabled)

// Toast notification
BetterTypora.toast("message", 3000)  // → top-of-window notification (duration optional, default 1.5s)

// File API — wraps Typora's internal File object
BetterTypora.saveFile()          // → trigger save of the current document (same as Ctrl+S)
BetterTypora.getCurrentFile()    // → string | null  absolute path of the current file
BetterTypora.getMountFolder()    // → string | null  opened workspace root
BetterTypora.openFile(path)      // → switch to the given file
BetterTypora.openFileInCurrentWindow(path) // → switch in the current window
BetterTypora.reloadFile(path)    // → reload the given file from disk
BetterTypora.isDocumentEdited()  // → bool  whether the current document has unsaved changes

// Utilities
BetterTypora.escapeHtml(str)     // → XSS-safe escaping (& < > ")

// File events — unified capture of open/switch/close/delete/rename/save
BetterTypora.onFileEvent(type, fn)   // → subscribe, returns an unsubscribe function
BetterTypora.offFileEvent(unsubFn)   // → unsubscribe
BetterTypora.onFileOpen(fn)          // → legacy interface: fn(filePath), fires when a file finishes opening
BetterTypora.offFileOpen(unsubFn)    // → unsubscribe

// Core services (advanced)
BetterTypora.events              // EventBus instance
BetterTypora.commands            // CommandRegistry instance
BetterTypora.settings            // SettingsManager instance
BetterTypora.hotkeys             // HotkeyManager instance
BetterTypora.manager             // PluginManager instance
BetterTypora.theme               // ThemeService instance (theme feature detection + change events)
BetterTypora.markdown            // Markdown rendering service (Typora's native parser, see below)
BetterTypora.scroll              // Scroll state service (per-file record + auto restore, see below)
BetterTypora.plugins             // Raw plugin registry reference (internal object, use with care)

// Timer groups (BetterTypora.createTimerGroup())
// All timers in a group can be cleared at once with close() — the standard way
// for plugins to prevent leaks at lifecycle teardown
BetterTypora.createTimerGroup()  // → {setTimeout, setInterval, setImmediate, delay, clearTimeout, clearInterval, clearAll, close, count, closed}
```

### Markdown Rendering Service — `BetterTypora.markdown`

Reuses Typora's internal node parser (`parseFrom`) to produce HTML DOM **identical to the editor**. When the parser is unavailable (e.g. Typora upgraded), `parse`/`renderTo` return `null`/`false` so callers can fall back to their own renderer.

```js
BetterTypora.markdown.isAvailable()            // → bool  is the native parser available
BetterTypora.markdown.parse(md)                // → string | null  markdown → Typora-native HTML (front matter handled)
BetterTypora.markdown.renderTo(container, md, options)  // → bool  render into a container
BetterTypora.markdown.lastError()              // → string | null  reason of the last failure
```

`renderTo` produces a `.bt-write-clone.write` content layer (mirrors the editor's `#write`, theme rules apply automatically) and handles:

- **Code block highlighting** — Typora's own CodeMirror (`pre.md-fences`), line numbers/wrapping follow editor options
- **Math formula rendering** — block formulas in source state are fed to `MathJax.tex2svgPromise` (the editor's `#write` post-render does not cover external containers)
- **Image/link remapping** — `options.baseDir` is the base for relative paths; relative references are remapped to the preview document's directory; local links get a `data-bt-link` attribute (absolute path, click behavior delegated to the caller)
- Preview containers are made non-editable (`contenteditable="false"`), Typora event attributes (`onerror`/`onload`) removed
- For image/link remapping, pass `sourcePath` as the full path of the preview file; it takes precedence over the legacy `baseDir` option.

### Scroll State Service — `BetterTypora.scroll`

Records scroll positions per file and installs auto-restore: wraps `File.recoverPosOrScroll` to inject `scrollOffset` (while rendering is incomplete the scrollHeight is too small and scrollTop gets clamped — waits until "scrollable to target" then applies it once).

```js
BetterTypora.scroll.record(filePath, scrollTop) // → record a file's scroll position (call after listening to scroll)
BetterTypora.scroll.get(filePath)               // → number | undefined
BetterTypora.scroll.clear()                     // → clear all records (stops injection, Typora's original behavior returns)
BetterTypora.scroll.installAutoRestore()        // → install auto-restore (idempotent)
BetterTypora.scroll.isInstalled()               // → bool
```

### Timer Groups — `BetterTypora.createTimerGroup()`

All timers in a group can be cleared at once with `close()` — the standard way for plugins to prevent leaks at lifecycle teardown (every bundled plugin's `disable`/`onUnload` is built on this).

```js
var timers = BetterTypora.createTimerGroup();
timers.setTimeout(fn, 1000)       // → id (returns -1 after the group is closed)
timers.setInterval(fn, 5000)      // → id
timers.setImmediate(fn)           // = setTimeout(fn, 0)
timers.delay(ms)                  // → Promise (awaitable)
timers.clearTimeout(id)
timers.clearInterval(id)
timers.clearAll()                 // → clear everything (without closing)
timers.close()                    // → close + clear everything (set* returns -1 afterwards)
timers.count                      // → number of live timers
timers.closed                     // → bool
```

### ThemeService — Theme Feature Detection

Detects *what the current theme looks like* rather than *what it is called*.

```js
BetterTypora.theme.isDark()                    // → bool  dark theme? (reads --bg-color luminance)
BetterTypora.theme.getSidebarTabsMode()        // → "capsule" | "default" | null
                                               //   is the sidebar tab bar capsule-styled (radius ≥ half height + pseudo-element slider)
BetterTypora.theme.getSidebarTabSlots()        // → {active-class: slider-offset-px}
                                               //   auto-discovers capsule slider slots (temporarily adds classes, reads ::before transform)
BetterTypora.theme.onChange(fn)                // → subscribe to theme switches (CSS variable fingerprint polling), returns an unsubscribe function
BetterTypora.theme.offChange(fn)               // → unsubscribe
```

- A theme switch = change in the CSS variable fingerprint (`--bg-color`/`--text-color`/`--active-file-text-color` + tab bar shape); switching theme files or light/dark both trigger it
- When the theme has no capsule features (GitHub/default), `getSidebarTabsMode()` returns `"default"` and capsule adaptation code is a no-op
- **Capsule slider adaptation mode** (built into bidirectional-links): under a capsule theme, the wrapper gets `.bt-capsule` (`width:max-content` to hold the plugin's tab slots); on backlink activation JS writes `tab.offsetLeft - sliderLeft` into the CSS variable `--bt-tab-x`, driving the theme's slider with one line of `translateX(var(--bt-tab-x))` — all offsets measured, never hardcoded

### EventBus

```js
BetterTypora.events.on("event:name", handler)
BetterTypora.events.once("event:name", handler)
BetterTypora.events.off("event:name", handler)
BetterTypora.events.emit("event:name", ...args)
BetterTypora.events.emitAsync("event:name", ...args)
```

### CommandRegistry

```js
BetterTypora.commands.register("id", fn, "description")
BetterTypora.commands.execute("id", ...args)
BetterTypora.commands.unregister("id")
BetterTypora.commands.list()    // → ["id1", "id2"]
BetterTypora.commands.has("id") // → bool
```

### SettingsManager

```js
BetterTypora.settings.get("plugin-id", "key", defaultValue)
BetterTypora.settings.getAll("plugin-id")
BetterTypora.settings.set("plugin-id", "key", value)
```

Settings are persisted to `.cache/<plugin-id>.settings.json` (defaults are filled from `manifest.settings` on first load; persisted values win). Besides code-level read/write, settings can also be edited graphically in the **Preferences → Plugins** page's gear panel (driven by `manifest.settingsSchema`, see below); changes there go through `PluginManager.updateSetting`, which persists and **notifies the plugin in real time** (triggers `api.onSettingChange`) — no restart or reload needed.

### File Events (FileEventHub)

Unified capture of Typora's file operations, covering **every** open/switch path (sidebar, quick open, menus, file associations, drag-and-drop, new file), built on Typora's native interfaces:

| Event | Callback payload | When it fires |
|------|----------|----------|
| `opening` | `{path, previousPath, isNew, untitled}` | A file is about to be opened/switched (intent, can be cancelled) |
| `opened` | `{path, previousPath, bundle}` | File **really finished opening** (bundle ready, includes the initial document) |
| `closing` | `{path, mountFolder}` | Before window close |
| `deleted` | `{path, originalPath}` | Current file deleted externally (bundle.filePath cleared) |
| `renamed` | `{path, previousPath}` | File renamed / saved as |
| `saved` | `{path}` | File **finished saving** (auto-save / manual save / save-as) |

```js
var unsub = BetterTypora.onFileEvent("opened", function (data) {
    console.log("opened:", data.path, "previous:", data.previousPath);
});
BetterTypora.offFileEvent(unsub);
```

**Implementation** (multiple sources + fallback):
- hooks `File.loadFile` → `opening` (renderer load entry)
- hooks `File.onFileOpened` / `File.setDocumentState` → `opened` (load complete / main-process state push)
- wraps `File.FileSave.saveUseNode` / `saveAsUseNode` → `saved` (after async save completes; the precise auto-save moment, replaces file-polling)
- wraps `JSBridge.invoke` → `opening`(new) / `closing`(window close)
- polls `File.bundle` (500ms) → `deleted` / `renamed` fallback (bundle reference change = open, path-only change = rename)

**Legacy interface `onFileOpen(fn)`**: `fn(filePath)`, equivalent to subscribing `opened` and firing when the path is non-empty (kept for backward compatibility).

---

## Plugin API: `require("bettertypora:api")`

Obtained in `main.js` via the virtual module:

```js
var BT = require("bettertypora:api");
// BT.api            → PluginAPI instance
// BT.manifest       → parsed manifest.json object
// BT.logger         → logger with [plugin-id] prefix {log, warn, error}
// BT.pluginDir      → absolute path of the plugin directory
// BT.saveFile       → function  trigger save of the current document
// BT.saveFileAndWait → function  trigger save and wait for completion (Promise)
// BT.getCurrentFile → function  current file path (string | null)
// BT.getMountFolder → function  opened workspace root (string | null)
// BT.openFile       → function  switch to the given file
// BT.reloadFile     → function  reload the given file from disk
// BT.isDocumentEdited → function  whether the current document has unsaved changes (bool)
// BT.escapeHtml     → function  XSS-safe escaping (same as BetterTypora.escapeHtml)
// BT.onFileOpen     → function  subscribe to file open (fn(filePath)), returns unsubscribe
// BT.offFileOpen    → function  unsubscribe
// BT.onFileEvent    → function  subscribe to generic file events (same as BetterTypora.onFileEvent)
// BT.offFileEvent   → function  unsubscribe
// BT.createTimerGroup → function  create a timer group (same as BetterTypora.createTimerGroup)
```

### PluginAPI

```js
api.id                          // → "my-plugin"
api.manifest                    // → full manifest object

// Settings
api.getSetting("key", default)   // → read a setting
api.setSetting("key", value)     // → write + persist
api.getAllSettings()             // → all settings object
api.onSettingChange(fn)          // → subscribe to setting changes (fires on preference-panel edits, args: key, value)

// Commands (auto-prefixed with "my-plugin:")
api.registerCommand("hello", fn, "description")  // → registered as "my-plugin:hello"
api.commands.execute("other-plugin:cmd")         // → call another plugin's command

// Hotkeys
api.registerHotkey("my-plugin:hello", "Ctrl+Shift+J", "always")

// Events
api.on("event", handler)
api.once("event", handler)
api.off("event", handler)
api.emit("event", ...args)
```

### Lifecycle Hooks

```js
module.exports = {
  onLoad:   function () { /* first load, once */ },
  enable:   function () { /* on activation: register commands/DOM/events */ },
  disable:  function () { /* on deactivation: clean up commands/DOM/events */ },
  onUnload: function () { /* on unload: final cleanup */ },
};
```

### Automatic Command Prefix

`api.registerCommand("hello")` auto-prefixes with the plugin id → the actual ID is `my-plugin:hello`. `CommandRegistry.execute()` supports short-name auto-matching, so cross-plugin calls don't need the manual prefix:

```js
// ✅ Short name — suffix-matches to tabs:create-untitled
window.BetterTypora.commands.execute('create-untitled');

// ✅ Full name also works
window.BetterTypora.commands.execute('tabs:create-untitled');
```

**Rule**: when the passed ID contains no `:`, `execute()` scans the registry with `:<id>` as suffix. It executes if exactly one command matches; fails with 0 or >1 matches. Full IDs (with `:`) are unaffected and match exactly.

---

## manifest.json Fields

| Field | Type | Required | Description |
|------|------|:--:|------|
| `id` | string | ✅ | kebab-case unique id, also the directory name |
| `name` | string | ✅ | human-readable display name |
| `version` | string | ✅ | semver version |
| `main` | string | ✅ | entry JS file, relative to the plugin directory |
| `description` | string | | one-line description |
| `author` | string | | author name |
| `license` | string | | license (e.g. MIT) |
| `style` | string | | CSS file path; injected into `<head>` on enable, removed on disable |
| `enabled` | bool | | default `true`; `false` loads without enabling |
| `hotkeys` | array | | shortcut list; registered on enable, cleared on disable |
| `settings` | object | | default settings; runtime changes persist to `.cache/` |
| `settingsSchema` | array | | settings-panel UI description (see next section) |

### settingsSchema Entries — Preferences Settings Panel

In Typora **Preferences → Plugins**, each plugin row has a gear button (SVG) on the right; clicking it expands the plugin's settings panel. The panel's items are declared by `manifest.settingsSchema` — the plugin **writes no UI code**:

```json
{
  "id": "tabs",
  "settings": { "autoHideTabbar": false },
  "settingsSchema": [
    {
      "key": "autoHideTabbar",
      "label": "Auto-hide tab bar",
      "type": "boolean",
      "default": false,
      "desc": "Auto-collapse the tab bar when the mouse leaves; move back to the top area to re-expand"
    }
  ]
}
```

| Field | Type | Description |
|------|------|------|
| `key` | string | Setting key, matching a key in `settings` |
| `label` | string | Display name in the panel |
| `type` | string | Control type: `boolean`(switch) \| `number`(number input) \| `text`(text input) \| `select`(dropdown, needs `options` array) |
| `default` | any | Default value (used when not persisted) |
| `desc` | string | Optional description below the item |
| `options` | array | Required for `select`; the dropdown options |
| `min` / `max` | number | Optional bounds for `number` inputs |

**Interaction chain**: edit in panel → ipc back to the main document → `PluginManager.updateSetting` (persist to `.cache/` + fire all `onSettingChange` callbacks of that plugin) → plugin applies in real time. The panel's expanded state survives re-render after data pushes.

### hotkeys Entries

```json
{
  "command": "plugin-id:command",  // must point to a registered command
  "key": "Ctrl+Shift+H",           // format: Ctrl/Alt/Shift/Meta + key (lowercase matching)
  "when": "always"                 // "always" | "editorFocus"
}
```

---

## Built-in Commands

| Command | Description |
|------|------|
| `plugin-system:status` | Print all plugin states to the console |
| `plugin-system:reload-all` | Hot-reload all plugins |

---

## Built-in Events

| Event | Payload | When it fires |
|------|----------|----------|
| `plugin-system:initialized` | core services reference | Plugin system boot complete, before plugins load |
| `plugin-system:ready` | — | After all plugins are loaded and enabled |
| `plugin:<id>:loaded` | — | Single plugin load complete |
| `plugin:<id>:enabled` | — | Single plugin enable complete |
| `plugin:<id>:disabled` | — | Single plugin disable complete |
| `plugin:<id>:unloaded` | — | Single plugin unloaded |
| `plugin:<id>:error` | `{error}` | `enable()` threw |

---

## Hotkey Format

Comparison uses lowercase strings:

| Declared | User presses | Match |
|--------|----------|:--:|
| `Ctrl+Shift+H` | Ctrl + Shift + h | ✅ |
| `Ctrl+Alt+K` | Ctrl + Alt + k | ✅ |
| `Ctrl+H` | Ctrl + h | ✅ |

> **Note**: On Windows the `Alt` key is intercepted by the menu bar. Avoid `Alt` combinations; prefer `Ctrl+Shift+<key>`.

---

## Directory Structure

```
resources/
├── plugins/                          # plugin system root
│   ├── plugin-loader.js              # core bootloader
│   ├── .cache/                       # runtime settings cache (gitignored)
│   │   └── <plugin-id>.settings.json
│   └── <plugin-id>/                  # one directory per plugin
│       ├── manifest.json
│       ├── main.js
│       └── style.css
├── window.html                       # renderer entry (injection line added)
└── app/                              # Typora main process (untouched)
```

---

## Debugging

### Opening DevTools

Use Typora's built-in entry: menu **View → Toggle Developer Tools**. No file modifications needed.

### Console Commands

```js
BetterTypora.status()                     // view all plugins
BetterTypora.commands.list()              // list all commands
BetterTypora.reloadPlugin("hello-world")  // hot-reload hello-world
BetterTypora.commands.execute("hello-world:greet")  // manually trigger a command
```

### Debugging Hotkeys

Uncomment line 390 of `plugin-loader.js`:

```js
console.log("[HotkeyManager] pressed:", pressed, "key:", b.key);
```

---

## Security

- Plugins run in the renderer process with full DOM and Node.js (`reqnode`) access
- No plugin sandbox — all plugins share the same JS context
- Plugins are only scanned from `resources/plugins/<id>/`; external code is never executed automatically
- Settings data lives inside the plugin directory, never written elsewhere on the system

---

## Known Limitations

| Limitation | Description |
|------|------|
| No plugin isolation | All plugins share the JS context; a malicious plugin can access other plugins' data |
| No CSS hot-reload | JS can be reloaded via `reloadPlugin()`; CSS requires a restart |
| Startup speed | More plugins → slower startup (each plugin is a synchronous `require`) |
| No main-process capabilities | Plugins run only in the renderer; cannot intercept Typora's native menu/window events (e.g. the native Ctrl+N "New"), cannot run async cleanup before exit |
| Typora upgrades | Upgrading overwrites `resources/window.html` — re-add the injection line; `resources/plugins/` and plugin data are unaffected |

---

## License

BetterTypora is an open-source project, free to use and modify. See the repository homepage for the license.

---

## Appendix A: CSS Theme Adaptation Guidelines

### A.1 Core Principle

**Never check the mode — use CSS variables only.** Plugin styles must always follow Typora's current theme, not the OS setting.

| ❌ Wrong | ✅ Right |
|---|---|
| `@media (prefers-color-scheme: dark) { ... }` | CSS variables: `var(--bg-color, #fafafa)` |
| `window.matchMedia("(prefers-color-scheme: dark)")` in JS | Read `getComputedStyle(el).getPropertyValue("--bg-color")` and judge luminance |
| Hardcoded light values `#fafafa`, `rgba(0,0,0,0.08)` | Neutral values `rgba(128,128,128,0.22)` or CSS variables |

**Why**: `prefers-color-scheme` reflects the OS setting. On Windows dark mode, Typora may use a light theme (e.g. Claude Light) — using `@media (prefers-color-scheme: dark)` would darken the plugin UI while the page stays light, producing a "two skins" mismatch.

### A.2 CSS Variable Fallback Chain

When writing `var()`, assume **any intermediate variable may be undefined**; the fallback chain must degrade to a variable **every theme defines**.

**Bridge variable `--text-color`**: every Typora theme (including Lightmind Dark with its private variable names) defines the body text color. When dedicated variables like `--heading-text-color` are missing, `--text-color` is the safe fallback.

| ❌ Wrong | ✅ Right |
|---|---|
| `var(--heading-text-color, #333)` | `var(--heading-text-color, var(--text-color, #333))` |
| `var(--active-file-text-color, #4a90d9)` | `var(--active-file-text-color, var(--text-color, #4a90d9))` |
| `var(--bg-color)` with no fallback | `var(--bg-color, #fafafa)` — always keep a final hardcoded fallback |

**Rule**: whenever referencing a possibly-missing CSS variable, insert `--text-color` or `--bg-color` into the fallback chain as the bridge.

### A.3 Hardcoded Values Across Light/Dark

| Type | Light-safe | Dark-safe | Neutral (recommended) |
|---|---|---|---|
| Background | `#fafafa` | `#1e1e1e` | `var(--bg-color, #fafafa)` |
| Border | `rgba(0,0,0,0.08)` | `rgba(255,255,255,0.08)` | `var(--window-border, rgba(128,128,128,0.22))` |
| Shadow | `rgba(0,0,0,0.08)` | `rgba(0,0,0,0.3)` | CSS variable or neutral gray |
| Dot grid | `rgba(0,0,0,0.12)` | `rgba(255,255,255,0.12)` | `var(--window-border, rgba(128,128,128,0.18))` |

**Rule**: `rgba(0,0,0, N)` is invisible on dark backgrounds (black on dark disappears); `rgba(255,255,255, N)` is invisible on light backgrounds. When you must hardcode, use `rgba(128,128,128, N)` — mid-gray is visible on both.

### A.4 JS Theme Detection

If you must detect light/dark or subscribe to theme switches in JS, **prefer BetterTypora's theme service** (it reads Typora's real CSS variables + fingerprint polling internally, consistent with the editor — don't reimplement):

```js
// ✅ Correct: official wrapper — reads Typora's real background luminance
var dark = BetterTypora.theme.isDark();            // → bool
BetterTypora.theme.onChange(function (p) {        // → theme switch (theme file change / light-dark), returns unsubscribe
    // p: {isDark, sidebarTabsMode, slots}
    rerunThemeAdaptation();
});
BetterTypora.theme.getSidebarTabsMode()           // → "capsule" | "default" | null — capsule tab bar shape
BetterTypora.theme.getSidebarTabSlots()           // → {active-class: slider-offset-px} — capsule slider slots
```

- **Don't poll CSS variables yourself** — `theme.onChange` already wraps fingerprint comparison, and polling only starts when there are subscribers (zero idle cost)
- Capsule theme adaptation (slider following plugin tabs) uses `getSidebarTabsMode`/`getSidebarTabSlots`; see bidirectional-links' `.bt-capsule` pattern (plugin tab slots `width:max-content` + JS writing `--bt-tab-x` to drive the slider)
- Hand-written luminance parsing is only allowed in **modules that cannot access `BetterTypora`** (e.g. Web Workers, offline renderers; see `_parseLuminance()` in graph-renderer.js)

```js
// ❌ Wrong: read the OS setting (Typora's light/dark is unrelated to the OS)
var isDark = window.matchMedia("(prefers-color-scheme: dark)").matches;

// ⚠ Only acceptable in standalone modules: hand-written luminance parsing
function isThemeDark() {
    var bg = getComputedStyle(document.documentElement)
        .getPropertyValue("--bg-color").trim();
    return luminance(bg) < 0.5;   // ITU-R BT.601
}
```

### A.5 Review Checklist

When creating or modifying plugin CSS/JS, check:

- [ ] No `@media (prefers-color-scheme: dark)` or `(prefers-color-scheme: light)`
- [ ] No `window.matchMedia("(prefers-color-scheme: ...)"`
- [ ] JS light/dark detection and theme switching use `BetterTypora.theme` (no self-written variable polling or luminance parsing, except in standalone modules)
- [ ] All `var(--heading-text-color, ...)` fallback chains bridge through `--text-color`
- [ ] All `var(--active-file-text-color, ...)` fallback chains bridge through `--text-color`
- [ ] All hardcoded colors are neutral gray or CSS variables (avoid `rgba(0,0,0,N)` and `rgba(255,255,255,N)`)
- [ ] Visually verified with at least Claude Dark, Inkwell Dark and Latex Dark

---

## Credits

- [Typora](https://typora.io) — the excellent Markdown editor
- [typora-community-plugin](https://github.com/typora-community-plugin/typora-community-plugin) — architecture reference
- [obgnail/typora_plugin](https://github.com/obgnail/typora_plugin) — architecture reference
