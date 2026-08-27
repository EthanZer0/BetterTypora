# BetterTypora — Typora 插件系统

> 一个轻量级的 Typora 插件框架，通过在 `window.html` 注入渲染进程提供插件生命周期管理、事件总线、命令注册、设置持久化等核心能力。

---

## 快速开始

### 安装

**1. 注入一行脚本**

编辑 Typora 安装目录下的 `resources/window.html`，在文件末尾 `</body>` 之前添加：

```html
<script src="./plugins/plugin-loader.js"></script>
```

**2. 复制插件系统文件**

将本仓库的 `plugins/` 目录复制到 Typora 的 `resources/` 下（即 `resources/plugins/plugin-loader.js`、`resources/plugins/<插件目录>/`）。

**3. 重启 Typora** — 插件系统自动启动。

> `window.html` 是 `resources/` 下的普通 HTML 文件，可以直接编辑。

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
window.html ── 渲染进程入口 (Typora 自带, 仅添加一行注入)
  │
  └─ <script src="./plugins/plugin-loader.js">   ← BetterTypora 唯一注入点
       │
       ├── EventBus          — pub/sub 事件系统
       ├── CommandRegistry   — 命名命令注册/执行
       ├── SettingsManager   — 按插件持久化 JSON (.cache/<id>.settings.json)
       ├── HotkeyManager     — 键盘快捷键绑定
       ├── PluginManager     — 生命周期: scan → load → enable → disable → unload → reload
       ├── PluginAPI         — 每个插件通过 require("bettertypora:api") 获取
       └── window.BetterTypora — 全局 API
```

### 关键设计决策

| 决策 | 选择 | 理由 |
|------|------|------|
| 注入点 | `window.html` 末尾一行 `<script>` | window.html 是 resources/ 下的明文文件，直接添加一行 script 即可 |
| 插件目录 | `resources/plugins/` | 独立于 Typora 本体文件，升级 Typora 时插件及其数据不受影响 |
| API 传递 | `require("bettertypora:api")` | 虚拟模块注入，干净无全局变量污染 |
| 加载时机 | body 末尾同步执行 + `setTimeout(fn, 0)` | `frame.js` 是 `defer`，注入脚本在解析时先执行；插件加载推迟一 tick，确保 Typora 初始化完毕 |
| 菜单注入 | 持续 500ms 守护 | `frame.js` 可能随时重建 `innerHTML`，持续守护确保菜单不丢失 |
| 主进程依赖 | 无 | 纯渲染进程架构，不修改 launch.dist.js；原生菜单/窗口事件等主进程能力不可用 |

---

## 全局 API：`window.BetterTypora`

所有插件和 Console 脚本通过 `window.BetterTypora` 访问系统。

```js
// 插件状态
BetterTypora.status()            // → [{id, name, version, state, description, settingsSchema, settings}, ...]
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

// 文件事件 — 统一捕获 Typora 文件打开/切换/关闭/删除/改名/保存
BetterTypora.onFileEvent(type, fn)   // → 订阅事件, 返回取消函数
BetterTypora.offFileEvent(unsubFn)   // → 取消订阅
BetterTypora.onFileOpen(fn)          // → 兼容旧接口: fn(filePath), 文件打开完成时触发
BetterTypora.offFileOpen(unsubFn)    // → 取消订阅

// 核心服务 (高级)
BetterTypora.events              // EventBus 实例
BetterTypora.commands            // CommandRegistry 实例
BetterTypora.settings            // SettingsManager 实例
BetterTypora.hotkeys             // HotkeyManager 实例
BetterTypora.manager             // PluginManager 实例
BetterTypora.theme               // ThemeService 实例 (主题特征检测 + 切换事件)
```

### ThemeService — 主题特征检测

对「当前主题长什么样」做特征检测，不认主题名（与附录 A 同理念）。

```js
BetterTypora.theme.isDark()                    // → bool  是否暗色主题 (读 --bg-color 亮度)
BetterTypora.theme.getSidebarTabsMode()        // → "capsule" | "default" | null
                                               //   侧边栏标签栏是否被胶囊化 (圆角≥半高 + 伪元素滑块)
BetterTypora.theme.getSidebarTabSlots()        // → {激活态类名: 滑块位移px}
                                               //   胶囊滑块档位自动发现 (临时加类读 ::before transform)
BetterTypora.theme.onChange(fn)                // → 订阅主题切换 (CSS 变量指纹轮询), 返回解绑函数
BetterTypora.theme.offChange(fn)               // → 取消订阅
```

- 主题切换 = CSS 变量指纹（`--bg-color`/`--text-color`/`--active-file-text-color` + 标签栏形态）变化，换主题文件、亮暗切换都会触发
- GitHub/默认主题等无胶囊特征时 `getSidebarTabsMode()` 返回 `"default"`，胶囊适配代码零副作用
- **胶囊滑块适配模式**（bidirectional-links 已内置）：胶囊主题下 wrapper 加 `.bt-capsule`（`width:max-content` 容纳插件的标签槽），反链激活时用 JS 把 `tab.offsetLeft - 滑块left` 写入 CSS 变量 `--bt-tab-x`，配一行 `translateX(var(--bt-tab-x))` 让主题的滑块物理跟随插件标签——位移全部实测，不硬编码坐标

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

设置持久化到 `.cache/<plugin-id>.settings.json`（首次加载用 `manifest.settings` 填充默认值，已持久化的值优先）。除了代码内读写，设置也可以在 **偏好设置 → 插件** 页面的齿轮设置面板中图形化修改（由 `manifest.settingsSchema` 驱动，见下文）；面板中的改动由 `PluginManager.updateSetting` 持久化并**实时通知插件**（触发 `api.onSettingChange`），无需重启或重载。

### 文件事件（FileEventHub）

统一捕获 Typora 的文件操作，覆盖**所有**打开/切换路径（侧边栏、快速打开、菜单、关联文件、拖拽、新建），基于 Typora 原生接口实现：

| 事件 | 回调参数 | 触发时机 |
|------|----------|----------|
| `opening` | `{path, previousPath, isNew, untitled}` | 文件将被打开/切换（意图，可被取消） |
| `opened` | `{path, previousPath, bundle}` | 文件**真正打开完成**（bundle 已就绪，含初始文档） |
| `closing` | `{path, mountFolder}` | 窗口关闭前 |
| `deleted` | `{path, originalPath}` | 当前文件被外部删除（bundle.filePath 已清空） |
| `renamed` | `{path, previousPath}` | 文件重命名/另存为 |
| `saved` | `{path}` | 文件**保存完成**（自动保存/手动保存/另存为） |

```js
var unsub = BetterTypora.onFileEvent("opened", function (data) {
    console.log("打开了:", data.path, "之前:", data.previousPath);
});
BetterTypora.offFileEvent(unsub);
```

**实现原理**（多数据源 + 兜底）：
- hook `File.loadFile` → `opening`（渲染进程加载入口）
- hook `File.onFileOpened` / `File.setDocumentState` → `opened`（加载完成 / 主进程状态推送）
- 包装 `File.FileSave.saveUseNode` / `saveAsUseNode` → `saved`（异步保存完成后，精确的自动保存时机，替代文件轮询检测）
- 包装 `JSBridge.invoke` → `opening`(新建) / `closing`(关窗)
- 轮询 `File.bundle`（500ms）→ `deleted` / `renamed` 兜底（bundle 引用变化=打开，仅路径变化=改名）

**旧接口 `onFileOpen(fn)`**：`fn(filePath)`，等价于订阅 `opened` 且路径非空时触发（保持向后兼容）。

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
api.onSettingChange(fn)          // → 订阅设置变更 (偏好面板修改时触发, 参数 key, value)

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

### 命令自动前缀补全

`api.registerCommand("hello")` 注册时自动加插件前缀 → 实际 ID 为 `my-plugin:hello`。`CommandRegistry.execute()` 支持短名自动匹配，跨插件调用时无需手动拼接前缀：

```js
// ✅ 短名 — 自动后缀匹配, 找到 tabs:create-untitled
window.BetterTypora.commands.execute('create-untitled');

// ✅ 完整名也支持
window.BetterTypora.commands.execute('tabs:create-untitled');
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
| `settingsSchema` | array | | 偏好设置面板的设置项 UI 描述 (见下节) |

### settingsSchema 条目 — 偏好设置面板

在 Typora **偏好设置 → 插件** 页面，每个插件行右侧有一个齿轮按钮（SVG），点击展开该插件的设置面板。面板中的设置项由 `manifest.settingsSchema` 声明，插件**无需写任何 UI 代码**：

```json
{
  "id": "tabs",
  "settings": { "autoHideTabbar": false },
  "settingsSchema": [
    {
      "key": "autoHideTabbar",
      "label": "自动隐藏标签栏",
      "type": "boolean",
      "default": false,
      "desc": "鼠标离开标签栏后自动收起隐藏, 移回顶部区域重新展开"
    }
  ]
}
```

| 字段 | 类型 | 说明 |
|------|------|------|
| `key` | string | 设置键名, 对应 `settings` 中的键 |
| `label` | string | 面板中显示的设置名 |
| `type` | string | 控件类型: `boolean`(开关) \| `number`(数字输入) \| `text`(文本输入) \| `select`(下拉, 需 `options` 数组) |
| `default` | any | 默认值 (未持久化时使用) |
| `desc` | string | 可选, 设置项下方的说明文字 |
| `options` | array | `select` 类型必填, 下拉选项列表 |
| `min` / `max` | number | 可选, `number` 类型输入框的上下限 |

**交互链路**：面板中修改 → ipc 发回主文档 → `PluginManager.updateSetting`（持久化到 `.cache/` + 触发该插件全部 `onSettingChange` 回调）→ 插件实时应用。面板展开状态在数据推送重渲染后保持。

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
│   ├── plugin-loader.js              # 核心引导脚本
│   ├── .cache/                       # 运行时设置缓存 (gitignore)
│   │   └── <plugin-id>.settings.json
│   └── <plugin-id>/                  # 每个插件独立目录
│       ├── manifest.json
│       ├── main.js
│       └── style.css
├── window.html                       # 渲染进程入口 (已添加一行注入脚本)
└── app/                              # Typora 主进程 (无需修改)
```

---

## 调试

### 开启 DevTools

使用 Typora 自带的开发者工具入口：菜单 **视图(View) → 切换开发者工具(Toggle Developer Tools)**。无需修改任何文件。

（旧方案"修改 `launch.dist.js` 的 `if (false)`"已随架构迁移废弃。）

### Console 常用命令

```js
BetterTypora.status()                     // 查看所有插件
BetterTypora.commands.list()              // 列出所有命令
BetterTypora.reloadPlugin("hello-world")  // 热重载 hello-world
BetterTypora.commands.execute("hello-world:greet")  // 手动触发命令
```

### 排查热键

取消 `plugin-loader.js` 第 390 行注释：

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
| 无主进程能力 | 插件只运行在渲染进程；无法拦截 Typora 原生菜单/窗口事件（如原生"新建"菜单的 Ctrl+N），无法在退出前执行异步清理 |
| Typora 升级 | 升级会覆盖 `resources/window.html`，需重新添加一行注入脚本；`resources/plugins/` 目录及插件数据不受影响 |

---

## 许可

BetterTypora 是开源项目，可自由使用和修改。许可证见仓库主页。

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

---

## 附录 B：开发流程经验教训

### B.1 脚本化替换文件必须验证结构完整性

**事故**：用 python 按行号切片替换 `style.css` 图谱段时，段尾边界定位到注释内容行而非注释头，导致 Wikilink 段注释起始行 `/* ====` 被误删。后果：`::highlight(wikilink-resolved)` 规则被 CSS 解析器吞进错误配对的注释中——**规则"存在但永远不生效"**，且只影响排在错误配对之后的规则。排查极难（文件正常、注册正常、渲染层正常，唯独浏览器 cssRules 里没有这条规则）。

**验证清单（任何脚本化替换后必做）**：
- [ ] `/*` 与 `*/` 数量配对（node 统计）
- [ ] `{` 与 `}` 数量配对
- [ ] 每个段注释头（`/* ====`）存在且闭合
- [ ] 浏览器实测：`document.styleSheets` 遍历 `cssRules`，确认目标规则在列——**语法配对只是必要条件，解析层才是最终真相**

### B.2 超长 bash heredoc 会被截断

写入超过约 300 行的 heredoc 内容时，bash 可能报 `here-document delimited by end-of-file` 并**截断内容**（写入不完整文件），用该文件替换会造成数据丢失。改用 Write 工具写文件，或写完后校验行数/尾行内容。

### B.3 CSS Custom Highlight 在 Typora 旧版 Chromium 不支持 var()

`::highlight()` 规则中 `var(--xxx, ...)` 会被整体丢弃（规则不生效），**必须硬编码颜色**。详见 style.css Wikilink 段注释。

### B.4 JS 自动分号插入（ASI）：`return` 后换行 = `return;`

`return\n<expr>` 被解析为 `return;`——函数恒返回 undefined。**`return` 与表达式必须同行**。曾导致 `buildRowHTML` 恒返回 undefined、列表显示"暂无已安装的插件"。

### B.5 解析规则宁严勿宽

resolver 的双向子串模糊匹配让 `[[前缀]]` 误跳转 `前缀A.md`（删除 A 后跳 B）。**无精确匹配即断链**，容错便利应通过显式 UI（如补全列表）实现，而非放宽解析规则。

---

## 致谢

- [Typora](https://typora.io) — 优秀的 Markdown 编辑器
- [typora-community-plugin](https://github.com/typora-community-plugin/typora-community-plugin) — 架构参考
- [obgnail/typora_plugin](https://github.com/obgnail/typora_plugin) — 架构参考
