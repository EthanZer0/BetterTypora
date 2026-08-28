<p align="center">
  <img src="assets/logo.png" alt="BetterTypora" width="160">
</p>
<h1 align="center">BetterTypora</h1>

<p align="center">
  <b>简体中文</b> | <a href="README_en.md">English</a>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/version-v1.0.0-4c1?style=for-the-badge&logo=semver&logoColor=white" alt="v1.0.0">
  <img src="https://img.shields.io/badge/license-MIT-blue?style=for-the-badge" alt="MIT">
  <img src="https://img.shields.io/badge/JavaScript-F7DF1E?style=for-the-badge&logo=javascript&logoColor=black" alt="JavaScript">
  <img src="https://img.shields.io/badge/Windows-0078D6?style=for-the-badge&logo=windows&logoColor=white" alt="Windows">
  <img src="https://img.shields.io/badge/7%20plugins-2ea043?style=for-the-badge" alt="7 plugins">
</p>

为 Typora 打造的开源插件系统。通过在 `resources/window.html` 注入一行脚本启用，即可为 Typora 带来多标签页、分屏、双向链接、知识图谱、内存优化等能力。

## 特性

- **多标签页** — 浏览器式标签管理：切换、拖拽排序、关闭/重开、分屏协作，支持自动隐藏
- **分屏** — 左右双栏同时写作，标签可发送到另一栏，右栏可挂载实时知识图谱
- **双向链接 + 知识图谱** — 反链面板、`[[]]` 维基链接解析高亮、Obsidian 式节点图谱（WebGPU 加速）
- **插件设置面板** — 在 Typora 偏好设置内直接修改各插件配置，实时生效
- **轻量自足** — 单个插件就是一个目录（manifest + main.js + style.css），即插即用

## 内置插件

| 插件 | 说明 |
|------|------|
| tabs | 多标签页：切换/拖拽排序/关闭重开/自动隐藏 |
| split-view | 分屏：左右双栏、标签发送、右栏挂载图谱 |
| bidirectional-links | 双向链接 + 反链面板 + 知识图谱 |
| memory-manager | 内存优化：空闲自动 GC、webview 缓存清理、工作集修剪 |
| git-sync | 笔记同步到 Git 仓库 |
| word-translator | 划词翻译（悬浮按钮 + 翻译面板） |
| hello-world | 示例插件，演示 API 完整用法 |

## 安装

**方式一：安装脚本（推荐，Windows）**

1. 下载仓库到本地（或 `git clone`）
2. 双击运行 `安装.bat`（或命令行执行 `core.ps1`）——自动定位 Typora 安装目录、备份并注入 `window.html`、复制插件目录；无参数时显示菜单（安装/卸载/仅检测/退出）
3. 重启 Typora

> 脚本幂等（重复运行不重复注入）、自动备份原文件（`window.html.bettertypora.bak`）；命令行直通：`安装.bat -Uninstall` 卸载、`安装.bat -TyporaDir "D:\Tools\Typora\resources"` 指定目录、`安装.bat -DetectOnly` 仅检测路径

**方式二：手动安装**

1. 将 `plugins/` 目录复制到 Typora 的 `resources/` 下
2. 在 `resources/window.html` 的 `</body>` 前添加：`<script src="./plugins/plugin-loader.js"></script>`
3. 重启 Typora — 插件系统自动启动

## 文档

- [插件开发文档](docs/PLUGIN-DEV.md) — 架构、API、manifest、事件、调试、主题适配规范

## 许可

[MIT License](LICENSE) — Copyright (c) 2026 BetterTypora contributors
