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

## 提交规范

- 提交信息用 conventional commits：`feat:` / `fix:` / `style:` / `docs:` / `chore:`，中文描述。
- 逻辑独立的改动拆多个提交；测试文件、本地素材（如 `assets/logo备用.png`）不提交。
- 代码改动需同步部署目录后由用户重启 Typora 验证；验证通过后再提交。
