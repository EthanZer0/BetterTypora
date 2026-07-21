# BetterTypora — Typora 插件系统

> 一个轻量级的 Typora 插件框架，通过注入渲染进程提供插件生命周期管理、事件总线、命令注册、设置持久化等核心能力。

---

## 快速开始

### 安装

BetterTypora 随 Typora 启动自动注入。无需用户操作。

> 前提：`resources/app/` 已从 `app.asar` 解包，`launch.dist.js` 中包含注入代码。

### 你的第一个插件

**1. 创建目录**

```
resources/plugins/my-plugin/
├── manifest.json
├── main.js
└── style.css        (可选)
```

**2. 编写 manifest.json**

```json
{
  "id": "my-plugin",
  "name": "我的插件",
  "version": "1.0.0",
  "description": "做什么的插件",
  "author": "你的名字",
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

**3. 编写 main.js**

```js
var BT = require("bettertypora:api");
var api = BT.api;
var logger = BT.logger;

module.exports = {
  enable: function () {
    api.registerCommand("hello", function () {
      var msg = api.getSetting("message", "Hello!");
      window.BetterTypora.toast(msg);
    }, "打个招呼");
    logger.log("我的插件已启用 ✅");
  },
  disable: function () {
    logger.log("我的插件已停用");
  }
};
```

**4. 重启 Typora** — 插件自动加载。

---

## 架构

```
launch.dist.js ── 主进程入口
  │
  ├─ /** Hook破解开始 */ … /** Hook破解结束 */  ← crack 脚本生成 (独立块)
  │   ├─ license 破解 (crypto.publicDecrypt hook)
  │   ├─ fs hook (app/ → app.bak/ 重定向)
  │   └─ 激活接口拦截 (protocol.handle https)
  │
  ├─ /** BetterTypora开始 */ … /** BetterTypora结束 */  ← 插件系统 (独立块)
  │   │
  │   ├─ browser-window-created → executeJavaScript(plugin-loader.js)
  │   ├─ require("plugins/*/main-process.js")  ← 自动扫描加载
  │   └─ hook Menu.setApplicationMenu → 追加 "插件" 菜单
  │
  ├─ 渲染进程
  │   plugin-loader.js (渲染进程, IIFE 单例)
  │     │
  │     ├── EventBus         — pub/sub 事件系统
  │     ├── CommandRegistry  — 命名命令注册/执行
  │     ├── SettingsManager  — 按插件持久化 JSON (.cache/<id>.settings.json)
  │     ├── HotkeyManager    — 键盘快捷键绑定
  │     ├── PluginManager    — 生命周期: scan → load → enable → disable → unload → reload
  │     ├── PluginAPI        — 每个插件通过 require("bettertypora:api") 获取
  │     └── window.BetterTypora — 全局 API
  │
  └─ 主进程 (插件专属)
      plugins/*/main-process.js
        │  由 launch.dist.js 在启动时自动扫描 require()
        │  可访问 Electron Menu, BrowserWindow 等主进程 API
        │  用于菜单拦截、原生窗口控制等渲染进程无法完成的事
```

### 关键设计决策

| 决策 | 选择 | 理由 |
|------|------|------|
| 插件目录 | `resources/plugins/` | 避开 `resources/app/` 的 fs hook 正则重定向 |
| 注入方式 | `window.html` `<script defer>` | 通过 `<script>` 标签自然加载 `plugin-loader.js`，比 `executeJavaScript` 更早到达渲染进程 |
| API 传递 | `require("bettertypora:api")` | 虚拟模块注入，干净无全局变量污染 |
| 加载时机 | `setTimeout(fn, 0)` | `frame.js` 是 `defer`，推迟一 tick 确保 Typora 初始化完毕 |
| 菜单注入 | 持续 500ms 守护 | `frame.js` 可能随时重建 `innerHTML`，持续守护确保菜单不丢失 |
| 主进程扩展 | 自动扫描 `plugins/*/main-process.js` | 插件系统通过 `require()` 桥接主进程能力，无需修改 `launch.dist.js` |

---

## 全局 API：`window.BetterTypora`

所有插件和 Console 脚本通过 `window.BetterTypora` 访问系统。

```js
// 插件状态
BetterTypora.status()            // → [{id, name, version, state, description}, ...]
BetterTypora.listPlugins()       // → ["hello-world", "my-plugin"]

// 插件管理
BetterTypora.getPlugin("id")     // → PluginInstance | null
BetterTypora.reloadPlugin("id")  // → 热重载 (unload → load → 如原 enabled 则 enable)

// Toast 通知
BetterTypora.toast("消息", 3000)  // → 在窗口顶部显示通知 (duration 可选, 默认 1.5s)

// File API — 封装 Typora 内部 File 对象
BetterTypora.saveFile()          // → 触发保存当前文档 (等同 Ctrl+S)
BetterTypora.getCurrentFile()    // → string | null  当前编辑文件的绝对路径
BetterTypora.getMountFolder()    // → string | null  打开的工作区根目录
BetterTypora.openFile(path)      // → 切换到指定文件
BetterTypora.isDocumentEdited()  // → bool  当前文档是否有未保存更改

// 核心服务 (高级)
BetterTypora.events              // EventBus 实例
BetterTypora.commands            // CommandRegistry 实例
BetterTypora.settings            // SettingsManager 实例
BetterTypora.hotkeys             // HotkeyManager 实例
BetterTypora.manager             // PluginManager 实例
```

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
BetterTypora.commands.register("id", fn, "描述")
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

---

## 插件 API：`require("bettertypora:api")`

在 `main.js` 中通过虚拟模块获取：

```js
var BT = require("bettertypora:api");
// BT.api            → PluginAPI 实例
// BT.manifest       → 解析后的 manifest.json 对象
// BT.logger         → 带 [plugin-id] 前缀的 logger {log, warn, error}
// BT.pluginDir      → 插件目录的绝对路径
// BT.saveFile       → function  触发保存当前文档
// BT.getCurrentFile → function  返回当前编辑文件路径 (string | null)
// BT.getMountFolder → function  返回打开的工作区根目录 (string | null)
// BT.openFile       → function  切换到指定文件
// BT.isDocumentEdited → function  返回当前文档是否有未保存更改 (bool)
```

### PluginAPI

```js
api.id                          // → "my-plugin"
api.manifest                    // → 完整 manifest 对象

// 设置
api.getSetting("key", default)   // → 读取设置
api.setSetting("key", value)     // → 写入 + 持久化
api.getAllSettings()             // → 全部设置对象

// 命令 (自动加 "my-plugin:" 前缀)
api.registerCommand("hello", fn, "描述")  // → 注册为 "my-plugin:hello"
api.commands.execute("other-plugin:cmd") // → 调用其他插件命令

// 热键
api.registerHotkey("my-plugin:hello", "Ctrl+Shift+J", "always")

// 事件
api.on("event", handler)
api.once("event", handler)
api.off("event", handler)
api.emit("event", ...args)
```

### 生命周期钩子

```js
module.exports = {
  onLoad:   function () { /* 首次加载, 仅一次 */ },
  enable:   function () { /* 激活时, 注册命令/DOM/事件 */ },
  disable:  function () { /* 停用时, 清理命令/DOM/事件 */ },
  onUnload: function () { /* 卸载时, 最后清理 */ },
};
```

### 主进程脚本：`main-process.js` <a id="main-process-script"></a>

插件可以通过 `main-process.js` 在 Electron 主进程中执行代码，访问菜单拦截、原生窗口控制等渲染进程无法触及的 API。

**发现规则**：`launch.dist.js` 启动时自动扫描 `resources/plugins/*/main-process.js`，存在则 `require()` 执行。无需修改 `launch.dist.js` 本身。

**加载时机**：同步加载，在 `<script>` 片段中位于 `setApplicationMenu` hook 之前、渲染进程注入之前。确保先于任何菜单构建完成。

**设计原则**：

| 原则 | 说明 |
|------|------|
| **独立可移除** | `main-process.js` 是插件的专属文件；删除插件目录即可彻底清空该功能，`launch.dist.js` 无需回退 |
| **自包含** | 每个 `main-process.js` 是一个独立 IIFE，不导出任何东西，通过 hook Electron API 生效 |
| **不写 `launch.dist.js`** | `launch.dist.js` 只保留通用的 BetterTypora 注入逻辑（插件系统加载、"插件"菜单），绝不在其中硬编码任何具体插件的功能 |
| **防御性编程** | `main-process.js` 运行在 `try/catch` 包裹中，加载失败不影响其他插件和 Typora 启动 |

**适用场景**：

- 拦截 Electron 原生菜单行为（如 `buildFromTemplate` 中 `role: "new"` → 当前窗口新建标签）
- 拦截原生窗口创建事件（如 `browser-window-created`）
- 注册自定义协议（`protocol.handle`）
- 主进程级别的 IPC 监听

**不适用场景**：

- DOM 操作、CSS 注入 → 渲染进程 `main.js` + `style.css`
- 快捷键绑定、命令注册 → 渲染进程 `api.registerCommand()` / `manifest.json` `hotkeys`
- 设置持久化 → 渲染进程 `api.getSetting()` / `api.setSetting()`

**模板**：

```js
/**
 * <插件名> — 主进程脚本
 * 由 launch.dist.js 的插件主进程加载器自动扫描 require()
 *
 * 职责: <一句话描述>
 */
(function () {
    var electron = require("electron");
    // ... hook Electron API ...

    // 示例: Hook buildFromTemplate
    var Menu = electron.Menu;
    var _orig = Menu.buildFromTemplate;
    Menu.buildFromTemplate = function (template) {
        // 深拷贝 template (纯 JS 对象, 可安全修改)
        // 修改副本 → 传给原始方法
        return _orig.call(this, modifiedTemplate);
    };
})();
```

**关键教训 — 为什么是 `buildFromTemplate` 阶段拦截而不是 `setApplicationMenu` 阶段**：

`Menu.buildFromTemplate(template)` 接收的是纯 JS 对象数组，尚未与 C++ 层绑定。此时 `delete item.role` 是安全的，因为 `MenuItem` 构造函数还未执行，`role: "new"` 的原生 IPC 行为尚未绑定。

而在 `Menu.setApplicationMenu` 阶段，`MenuItem` 实例已经完成 C++ 绑定——即使修改属性，OS 级原生行为已经不可撤销。这个顺序规则适用于所有 Electron 菜单拦截场景。

**关键教训 — 命令自动前缀补全**：

`api.registerCommand("hello")` 注册时自动加插件前缀 → 实际 ID 为 `my-plugin:hello`。但在 `main-process.js` 或其他跨进程场景通过 `executeJavaScript` 调用时，无需手动拼接前缀——`CommandRegistry.execute()` 支持短名自动匹配：

```js
// ✅ 短名 — 自动后缀匹配, 找到 tabs:create-untitled
win.webContents.executeJavaScript(
    "window.BetterTypora.commands.execute('create-untitled')"
);

// ✅ 完整名也支持
win.webContents.executeJavaScript(
    "window.BetterTypora.commands.execute('tabs:create-untitled')"
);
```

**规则**：传入的 ID 不含 `:` 时，`execute()` 自动以 `:<id>` 为后缀扫描注册表。唯一定位到 1 个命令时直接执行；0 个或 >1 个时失败。完整 ID（含 `:`）不受影响，精确匹配。

---

## manifest.json 字段

| 字段 | 类型 | 必填 | 说明 |
|------|------|:--:|------|
| `id` | string | ✅ | kebab-case 唯一标识, 也是目录名 |
| `name` | string | ✅ | 人类可读的显示名 |
| `version` | string | ✅ | semver 版本号 |
| `main` | string | ✅ | 入口 JS 文件, 相对于插件目录 |
| `description` | string | | 一句话描述 |
| `author` | string | | 作者名 |
| `license` | string | | 许可证 (如 MIT) |
| `style` | string | | CSS 文件路径, enable 时注入 `<head>`, disable 时移除 |
| `enabled` | bool | | 默认 `true`, `false` 则只加载不启用 |
| `hotkeys` | array | | 快捷键列表, enable 时注册, disable 时清除 |
| `settings` | object | | 默认设置, 运行时修改持久化到 `.cache/` |

### hotkeys 条目

```json
{
  "command": "plugin-id:command",  // 必须指向已注册的命令
  "key": "Ctrl+Shift+H",           // 格式: Ctrl/Alt/Shift/Meta + 键名 (全小写匹配)
  "when": "always"                 // "always" | "editorFocus"
}
```

---

## 内建命令

| 命令 | 说明 |
|------|------|
| `plugin-system:status` | 在 Console 输出所有插件状态表格 |
| `plugin-system:reload-all` | 热重载所有插件 |

---

## 内建事件

| 事件 | 携带数据 | 触发时机 |
|------|----------|----------|
| `plugin-system:initialized` | core services 引用 | 插件系统 boot 完成, 插件加载前 |
| `plugin-system:ready` | — | 所有插件加载并启用后 |
| `plugin:<id>:loaded` | — | 单个插件 load 完成 |
| `plugin:<id>:enabled` | — | 单个插件 enable 完成 |
| `plugin:<id>:disabled` | — | 单个插件 disable 完成 |
| `plugin:<id>:unloaded` | — | 单个插件卸载完成 |
| `plugin:<id>:error` | `{error}` | 插件 enable() 抛出异常 |

---

## 热键格式

统一用小写字符串比较，示例：

| 清单中 | 用户按键 | 匹配 |
|--------|----------|:--:|
| `Ctrl+Shift+H` | Ctrl + Shift + h | ✅ |
| `Ctrl+Alt+K` | Ctrl + Alt + k | ✅ |
| `Ctrl+H` | Ctrl + h | ✅ |

> **注意**：Windows 上 `Alt` 键会被菜单栏拦截。避免使用含 `Alt` 的组合键，推荐 `Ctrl+Shift+<key>`。

---

## 目录结构

```
resources/
├── plugins/                          # 插件系统根目录
│   ├── plugin-loader.js              # 核心引导脚本 (~950 行)
│   ├── .cache/                       # 运行时设置缓存 (gitignore)
│   │   └── <plugin-id>.settings.json
│   └── <plugin-id>/                  # 每个插件独立目录
│       ├── manifest.json
│       ├── main.js
│       ├── main-process.js            # 可选, 主进程脚本 (Electron Menu/BrowserWindow)
│       └── style.css
├── app/
│   ├── launch.dist.js                # 主进程入口 (含注入代码)
│   ├── atom.compiled.dist.jsc        # Typora 字节码核心 (不可修改)
│   └── package.json
└── window.html                       # 渲染进程 HTML (不修改)
```

---

## 调试

### 开启 DevTools

将 `resources/app/launch.dist.js` 第 13 行的 `if (false)` 改为 `if (true)`：

```js
if (true) win.webContents.openDevTools({ mode: "detach" });
```

### Console 常用命令

```js
BetterTypora.status()                     // 查看所有插件
BetterTypora.commands.list()              // 列出所有命令
BetterTypora.reloadPlugin("hello-world")  // 热重载 hello-world
BetterTypora.commands.execute("hello-world:greet")  // 手动触发命令
```

### 排查热键

取消 `plugin-loader.js` 第 372 行注释：

```js
console.log("[HotkeyManager] pressed:", pressed, "key:", b.key);
```

---

## 安全

- 插件运行在渲染进程，拥有完整 DOM 和 Node.js (`reqnode`) 访问权
- 没有插件沙箱——所有插件共享同一 JS 上下文
- 插件只从 `resources/plugins/<id>/` 扫描，不会自动执行外部代码
- 设置数据存储在插件目录内，不会写入系统其他位置

---

## 已知限制

| 限制 | 说明 |
|------|------|
| 无插件隔离 | 所有插件共享 JS 上下文，恶意插件可访问其他插件数据 |
| 无热重载 CSS | JS 可通过 `reloadPlugin()` 重载，CSS 需重启 |
| 启动速度 | 插件数量越多启动越慢 (每个插件同步 `require` 执行) |
| Typora 升级 | `launch.dist.js` 可能在升级时被覆盖，需重新应用补丁 |

---

## 许可

---

## 附录 A：CSS 主题适配规范

### A.1 核心原则

**不判断 Mode，只用 CSS 变量。** 插件样式必须始终跟随 Typora 当前主题，而非操作系统设置。

| ❌ 错误做法 | ✅ 正确做法 |
|---|---|
| `@media (prefers-color-scheme: dark) { ... }` | 用 CSS 变量：`var(--bg-color, #fafafa)` |
| `window.matchMedia("(prefers-color-scheme: dark)")` 在 JS 中检测 | 读 `getComputedStyle(el).getPropertyValue("--bg-color")` 判断亮度 |
| 硬编码浅色值 `#fafafa`、`rgba(0,0,0,0.08)` | 用中性值 `rgba(128,128,128,0.22)` 或 CSS 变量 |

**原因**：`prefers-color-scheme` 是操作系统设置。Windows 深色模式下 Typora 可能使用浅色主题（如 Claude Light）— 此时用 `@media (prefers-color-scheme: dark)` 会让插件 UI 变深色而页面主体保持浅色，出现「两张皮」。

### A.2 CSS 变量回退链规范

写 `var()` 时必须假设**任意中间变量都可能未定义**，回退链要一路退化到某个**所有主题都有的变量**。

**桥接变量 `--text-color`**：所有 Typora 主题（包括使用私有变量名的 Lightmind Dark）都会定义正文颜色。当 `--heading-text-color` 等专用变量缺失时，`--text-color` 是安全的兜底。

| ❌ 错误 | ✅ 正确 |
|---|---|
| `var(--heading-text-color, #333)` | `var(--heading-text-color, var(--text-color, #333))` |
| `var(--active-file-text-color, #4a90d9)` | `var(--active-file-text-color, var(--text-color, #4a90d9))` |
| 仅依赖 `--bg-color` 不做 fallback | `var(--bg-color, #fafafa)` — 始终保留硬编码最终回退 |

**规则**：任何引用「可能缺失」的 CSS 变量时，在回退链中插入 `--text-color` 或 `--bg-color` 作为桥接。

### A.3 硬编码值的亮暗兼容

| 类型 | 浅色安全值 | 暗色安全值 | 中性值（推荐） |
|---|---|---|---|
| 背景 | `#fafafa` | `#1e1e1e` | `var(--bg-color, #fafafa)` |
| 边框 | `rgba(0,0,0,0.08)` | `rgba(255,255,255,0.08)` | `var(--window-border, rgba(128,128,128,0.22))` |
| 阴影 | `rgba(0,0,0,0.08)` | `rgba(0,0,0,0.3)` | 用 CSS 变量或中性灰 |
| 点网格 | `rgba(0,0,0,0.12)` | `rgba(255,255,255,0.12)` | `var(--window-border, rgba(128,128,128,0.18))` |

**规则**：`rgba(0,0,0, N)` 在暗底上不可见（黑色叠加到深色上消失），`rgba(255,255,255, N)` 在亮底上不可见。如必须硬编码，用 `rgba(128,128,128, N)` — 中灰在亮底和暗底上都可见。

### A.4 JS 主题检测规范

如必须在 JS 中判断亮/暗：

```js
// ✅ 正确：读 Typora 主题的真实背景亮度
function isThemeDark() {
    var bg = getComputedStyle(document.documentElement)
        .getPropertyValue("--bg-color").trim();
    // 解析亮度 (ITU-R BT.601)，< 0.5 为暗色
    // ... 参见 graph-renderer.js 中的 _parseLuminance()
}

// ❌ 错误：读 OS 设置
var isDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
```

### A.5 审查清单

新建或修改插件 CSS/JS 时，检查以下项目：

- [ ] 无 `@media (prefers-color-scheme: dark)` 或 `(prefers-color-scheme: light)`
- [ ] 无 `window.matchMedia("(prefers-color-scheme: ...)"`
- [ ] 所有 `var(--heading-text-color, ...)` 回退链经过 `--text-color` 桥接
- [ ] 所有 `var(--active-file-text-color, ...)` 回退链经过 `--text-color` 桥接
- [ ] 所有硬编码颜色值为中性灰或 CSS 变量（避免 `rgba(0,0,0,N)` 和 `rgba(255,255,255,N)`）
- [ ] 至少用 Claude Dark、Inkwell Dark、Latex Dark 三个主题做目视验证

BetterTypora 是开源项目，可自由使用和修改。

---

## 致谢

- [Typora](https://typora.io) — 优秀的 Markdown 编辑器
- [typora-community-plugin](https://github.com/typora-community-plugin/typora-community-plugin) — 架构参考
- [obgnail/typora_plugin](https://github.com/obgnail/typora_plugin) — 架构参考
