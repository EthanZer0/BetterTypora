# AGENTS.md

> 给 AI 编程代理的仓库操作指南。完整开发文档见 [docs/PLUGIN-DEV.md](docs/PLUGIN-DEV.md)（架构、API 全量参考、主题适配规范、调试）；本文件是浓缩版——改代码前先读这里，避免踩已知的坑。

## 项目概览

- **BetterTypora**：为 Typora 打造的插件系统（MIT 许可，公开仓库）。
- **注入方式**：`resources/window.html` 在 `</body>` 前加载 `./plugins/plugin-loader.js`（一行 script，无主进程修改）。
- **插件模型**：每个插件是 `plugins/<plugin-id>/` 目录，含 `manifest.json` + `main.js`（+ 可选 `style.css`）。生命周期：`onLoad` → `enable` → `disable` → `onUnload`。
- **运行环境**：Typora Electron 渲染进程（有 DOM、有 `reqnode` 可访问 Node 模块）。无构建步骤，纯 JS。

## 目录结构

```
plugins/plugin-loader.js     # 核心引导脚本 (EventBus/Command/Settings/Hotkey/PluginManager/Theme/markdown/scroll/偏好设置桥)
plugins/<plugin-id>/         # 每个插件独立目录
docs/PLUGIN-DEV.md           # 完整开发文档 (API 全量参考, 改 API 前先查这里)
README.md                    # 仓库主页
AGENTS.md                    # 本文件
```

## 代码风格约束

- **ES5 风格**（插件 main.js 与核心 loader 一致）：`var`、函数声明、无箭头函数/`class`/`let`/`const`/模板字符串。
- **注释用中文**，解释"为什么"（约束/坑）而非"做了什么"。
- 插件代码里 `require("bettertypora:api")` 拿 API：`BT.api`（PluginAPI）、`BT.logger`、`BT.pluginDir`、`BT.escapeHtml`、`BT.onFileEvent`、`BT.createTimerGroup` 等（全量清单见 PLUGIN-DEV.md）。
- 定时器一律用 `BT.createTimerGroup()` 或 `BetterTypora.createTimerGroup()` 创建，在 `disable`/`onUnload` 中 `close()`——防泄漏的标准做法。
- 新增可配置参数：`manifest.settings` 加默认值 + `manifest.settingsSchema` 声明 UI（`{key, label, type: boolean|number|text|select, default, desc, min/max}`），偏好设置面板自动渲染；设置变更用 `api.onSettingChange(fn)` 实时应用（参数 `key, value`）。

## 主题适配（重要）

- **只用 Typora CSS 变量**，禁止 `prefers-color-scheme` / `matchMedia` 判断亮暗（Typora 亮暗与 OS 设置无关）。
- 变量回退链必须经过桥接变量：`var(--heading-text-color, var(--text-color, #333))`；硬编码颜色用中性灰 `rgba(128,128,128,N)`，禁止 `rgba(0,0,0,N)`/`rgba(255,255,255,N)` 单独使用。
- 完整规范见 PLUGIN-DEV.md 附录 A。

## 构建 / 测试 / 部署

- **无构建步骤**。语法检查：`node --check plugins/<id>/main.js`（JSON 用 `JSON.parse` 验证）。
- **部署**：修改后同步复制到 Typora 部署目录 `D:\Fold\Tool\Typora\resources\plugins\`（loader 在 `resources\plugins\plugin-loader.js`；window.html 注入行已存在，勿改）。
- **验证需重启 Typora**（渲染进程注入，无热重载 CSS）。
- 测试用文件（`*测试*.md` 等）**不进 git**，提交前检查 `git status`。

## 已知陷阱（踩过的坑，改相关代码前必读）

1. **CSSOM 无法展开含 `var()` 的简写属性**——`getPropertyValue("background")` 对 `background: var(--x)` 返回空，不要依赖简写读值。
2. **`.bt-editor-fixed *` 禁动画规则**（split-view）会误伤 content 内标签栏拖拽缓动——已用 `:not(#typora-tab-bar):not(#typora-tab-bar *)` 排除，新增 fixed 贴片内容时注意同类问题。
3. **flex 子项收起动画**：`flex-basis` 置 0 会让 flex 布局立即重排、绕过 `height` 过渡（收起瞬跳）。收缩动画只改 `height`，不要动 flex-basis。
4. **图谱 `graphView` 是共享单例**（bidirectional-links 模块级）——分屏关闭只能 `close()`（已释放 GPU/worker），**绝不能 `destroy()`**（永久终结单例，图谱按钮从此无反应）。
5. **图谱相机**：缩放 lerp 插值期间每帧按锚点重写 `_ox/_oy` 会覆盖拖拽平移——mousedown 时需先 snap 完成缩放（graph-renderer.js `_md` 已有实现，改动相机代码注意保持）。
6. **嵌入容器失效**：`GraphView.open()` 前检查 `_embedContainer` 是否 `document.contains`，detached 时重置为 null（分屏关闭后全屏图谱挂 body）。
7. **Typora 升级会覆盖 `window.html`**——需重新添加注入行；`resources/plugins/` 不受影响。
8. **偏好设置面板注入**是 webview 内嵌 JS 字符串（`BT_PREF_INJECT_JS`），改面板 UI 时注意字符串转义层级（`\\'` 双层）与 `isTrusted` 过滤。

## 提交规范

- 提交信息用 conventional commits：`feat:` / `fix:` / `style:` / `docs:` / `chore:`，中文描述。
- 逻辑独立的改动拆多个提交；测试文件、本地素材（如 `assets/logo备用.png`）不提交。
- 代码改动需同步部署目录后由用户重启 Typora 验证；验证通过后再提交。
