/**
 * Git Sync Plugin — 主入口
 * ============================
 * 纯手动模式：用户决定何时提交、推送，无自动同步。
 * 仓库不存在时也不自动初始化，需用户在面板中手动点击初始化。
 *
 * enable() 流程:
 *   1. 凭证阻断 + UI 注入
 *   2. 仓库检测（不自动初始化）
 *   3. 远程拉取（如仓库已存在且配置了远程）
 *   4. 命令注册 + 守护循环
 */

var BetterTypora = require("bettertypora:api");
var api = BetterTypora.api;
var logger = BetterTypora.logger;
var PLUGIN_DIR = BetterTypora.pluginDir;

var fs = reqnode("fs");
var path = reqnode("path");
var Module = reqnode("module");

// ===================================================================
// 加载子模块
// ===================================================================

var pluginRequire;
try {
    pluginRequire = Module.createRequire
        ? Module.createRequire(path.join(PLUGIN_DIR, "main.js"))
        : reqnode;
} catch (e) {
    pluginRequire = reqnode;
}

var gitCore = pluginRequire(path.join(PLUGIN_DIR, "git-core.js"));
var gitSync = pluginRequire(path.join(PLUGIN_DIR, "git-sync.js"));
var RepoStore = pluginRequire(path.join(PLUGIN_DIR, "repo-store.js"));
var diffRenderer = pluginRequire(path.join(PLUGIN_DIR, "diff-renderer.js"));
var toolbarModule = pluginRequire(path.join(PLUGIN_DIR, "toolbar.js"));
var Panel = pluginRequire(path.join(PLUGIN_DIR, "panel.js"));
var revisionView = pluginRequire(path.join(PLUGIN_DIR, "revision-view.js"));
var revisionRenderer = pluginRequire(path.join(PLUGIN_DIR, "revision-renderer.js"));
var icons = pluginRequire(path.join(PLUGIN_DIR, "icons.js"));
var branchViz = pluginRequire(path.join(PLUGIN_DIR, "branch-viz.js"));

// ===================================================================
// 全局单例
// ===================================================================

var repoStore = null;
var toolbar = null;
var panel = null;

var _guardInterval = null;
var _timers = null;
var _onFileOpenUnsub = null;
var _pendingAction = null;   // 初始化完成后待执行的操作

// ===================================================================
// 工具函数
// ===================================================================

/**
 * 多级回退获取 Typora 打开的文件夹根目录
 */
function getVaultRoot() {
    return BetterTypora.getMountFolder();
}

function findGitRoot(startDir) {
    var dir = String(startDir);
    while (dir && dir !== path.dirname(dir)) {
        if (fs.existsSync(path.join(dir, ".git"))) return dir;
        dir = path.dirname(dir);
    }
    return null;
}

/**
 * 通俗化 Git 操作结果通知
 */
function toastResult(success, okMsg, failMsg) {
    if (success) {
        if (okMsg) window.BetterTypora.toast(okMsg, 2000);
    } else {
        if (failMsg) window.BetterTypora.toast(failMsg, 3000);
    }
}

// ===================================================================
// 仓库检测与初始化
// ===================================================================

function detectRepoWithRetry(attempt) {
    attempt = attempt || 0;
    var root = getVaultRoot();

    if (root) {
        logger.log("检测到仓库根目录:", root);

        // 检查 vault 目录本身是否就是 git 仓库（不向上查找）
        var isRepo = fs.existsSync(path.join(root, ".git")) || gitCore.isRepo(root);

        if (isRepo) {
            // 仓库已存在 → 直接设置
            repoStore.setRepo(root);

            // 获取已打开的当前文件路径
            try {
                var fp = BetterTypora.getCurrentFile();
                if (fp) {
                    repoStore.setCurrentFile(fp);
                    logger.log("当前文件:", fp);
                }
            } catch (e) { /* ignore */ }

            // 远程拉取（如配置）
            var remoteUrl = api.getSetting("remoteURL", "");
            var remoteName = api.getSetting("remoteName", "origin");
            var remoteEnabled = api.getSetting("remoteEnabled", false);

            var remotePromise = Promise.resolve();
            if (remoteEnabled && remoteUrl) {
                var currentBranch = repoStore.state.branch || "main";
                remotePromise = gitSync.configureRemote(root, remoteUrl, remoteName, gitCore).then(function () {
                    return gitSync.pullBeforeWork(root, remoteName, gitCore, currentBranch).then(function (pullResult) {
                        if (pullResult.success) {
                            logger.log("远程拉取成功");
                        } else if (pullResult.conflict) {
                            window.BetterTypora.toast(
                                "无法自动合并远端更新，请手动处理", 4000
                            );
                        } else if (pullResult.error) {
                            window.BetterTypora.toast(pullResult.error, 4000);
                        }
                    });
                });
            }

            // 刷新状态
            return remotePromise.then(function () {
                return repoStore.refreshAll().then(function () {
                    api.emit("git-sync:status-changed", repoStore.state);
                    updateToolbarBadge();
                    if (toolbar) toolbar.render();
                    if (panel) {
                        panel.refreshStatus();
                        panel.refreshSettings();
                    }
                });
            });
        } else {
            // 仓库不存在 → 记录路径供面板初始化，设置 isDetected
            logger.log("未检测到 Git 仓库，等待用户手动初始化");
            repoStore.state.repoPath = root;
            repoStore.state.isRepo = false;
            repoStore.state.isDetected = true;
            if (toolbar) toolbar.render();
            if (panel) {
                panel.refreshSettings();
                panel.refreshStatus();
            }
        }

        return;
    }

    if (attempt < 60) {
        _timers.setTimeout(function () {
            detectRepoWithRetry(attempt + 1);
        }, 100);
    } else {
        logger.warn("无法获取 Typora 打开的文件夹路径");
        if (toolbar) toolbar.render();
    }
}


// ===================================================================
// 仓库初始化守卫
// ===================================================================

/**
 * 确保仓库已初始化。若未初始化，自动打开面板显示初始化遮罩；
 * 初始化完成后自动继续原操作。
 * @returns {Promise<boolean>} — true 表示可继续操作
 */
function initRepoIfNeeded() {
    return new Promise(function (resolve) {
        if (repoStore && repoStore.state.isRepo) {
            resolve(true);
            return;
        }
        if (!repoStore || !repoStore.state.repoPath) {
            resolve(false);
            return;
        }
        // 打开面板，遮罩层会自动显示初始化卡片
        if (panel) {
            if (!panel.isOpen()) panel.open();
        }
        window.BetterTypora.toast("请先初始化 Git 仓库", 2500);
        // 注册回调，初始化完成后继续
        _pendingAction = function () { resolve(true); };
    });
}

/**
 * 初始化完成后被 panel.js 通过事件调用
 */
function onRepoInitialized() {
    if (_pendingAction) {
        var cb = _pendingAction;
        _pendingAction = null;
        cb();
    }
}

// 暴露到 window 供 panel.js / toolbar.js 调用
window.__gitSync_initRepoIfNeeded = initRepoIfNeeded;

// ===================================================================
// 文件切换事件 — 通过 BetterTypora.onFileOpen 统一注册
// ===================================================================

function onFileOpened(filePath) {
    if (!repoStore) return;

    // 检测仓库切换：只检查 vault 根目录，不向上查找
    // （向上查找会把 C:\Users\Lin\.git 误判为当前仓库）
    var vaultRoot = getVaultRoot();
    var newRepoPath = null;
    if (vaultRoot) {
        if (fs.existsSync(path.join(vaultRoot, ".git"))) {
            newRepoPath = vaultRoot;
        } else {
            // vault 本身不是 git 仓库 → 设置为非仓库状态
            newRepoPath = null;
        }
    }
    var currentRepoPath = repoStore.state.repoPath;
    var repoChanged = false;

    if (newRepoPath) {
        // 新文件属于一个 git 仓库
        repoChanged = (newRepoPath !== currentRepoPath);
        if (repoChanged) {
            repoStore.setRepo(newRepoPath);
            repoStore.refreshRemotes();
        }
    } else if (currentRepoPath) {
        // 新文件不在任何仓库中，但之前有仓库 → 清除
        repoStore.state.repoPath = vaultRoot || path.dirname(filePath);
        repoStore.state.isRepo = false;
        repoStore.state.isDetected = true;
        repoChanged = true;
    }

    if (repoChanged) {
        if (panel && typeof panel.refreshSettings === "function") {
            panel.refreshSettings();
        }
        if (panel && typeof panel.refreshStatus === "function") {
            panel.refreshStatus();
        }
    }

    repoStore.setCurrentFile(filePath);
    // 刷新状态（仅当有仓库时）
    if (repoStore.state.isRepo) {
        repoStore.refreshAll().then(function () {
            updateToolbarBadge();
            if (panel) {
                panel.refreshStatus();
                panel.refreshHistory();
            }
        });
    }
}

function installFileOpenListener() {
    if (_onFileOpenUnsub) return;
    _onFileOpenUnsub = BetterTypora.onFileOpen(onFileOpened);
}

function uninstallFileOpenListener() {
    if (_onFileOpenUnsub) {
        BetterTypora.offFileOpen(_onFileOpenUnsub);
        _onFileOpenUnsub = null;
    }
}

// ===================================================================
// Guardian 守护
// ===================================================================

function startGuardian() {
    if (_guardInterval) return;

    _guardInterval = _timers.setInterval(function () {
        if (toolbar && typeof toolbar.checkDom === "function") toolbar.checkDom();
        if (panel && typeof panel.checkDom === "function") panel.checkDom();
        if (revisionView && typeof revisionView.checkDom === "function") revisionView.checkDom();
    }, 1500);
}

// ===================================================================
// 工具栏徽章
// ===================================================================

function updateToolbarBadge() {
    if (!repoStore) return;
    var count = repoStore.getChangeCount();
    if (toolbar && typeof toolbar.updateBadge === "function") {
        toolbar.updateBadge(count);
    }
}

// ===================================================================
// 主题字体同步
// ===================================================================

function syncThemeFonts() {
    try {
        var rootStyle = getComputedStyle(document.documentElement);
        var bodyStyle = getComputedStyle(document.body);
        var writeEl = document.getElementById("write");
        var writeStyle = writeEl ? getComputedStyle(writeEl) : null;

        var sansFont =
            rootStyle.getPropertyValue("--font-sans").trim()
            || rootStyle.getPropertyValue("--sans-font").trim()
            || rootStyle.getPropertyValue("--font-family").trim()
            || bodyStyle.fontFamily
            || 'system-ui, -apple-system, "Segoe UI", "Noto Sans SC", sans-serif';

        var monoFont =
            rootStyle.getPropertyValue("--font-mono").trim()
            || rootStyle.getPropertyValue("--font-monospace").trim()
            || rootStyle.getPropertyValue("--monospace").trim()
            || '"Cascadia Code", "JetBrains Mono", "Fira Code", "SF Mono", Consolas, monospace';

        document.documentElement.style.setProperty("--git-font-sans", sansFont);
        document.documentElement.style.setProperty("--git-font-mono", monoFont);
    } catch (e) { /* silent */ }
}

var _themeObserver = null;
var _themeUnsub = null;   // BetterTypora.theme.onChange 解绑函数

function installThemeObserver() {
    if (_themeObserver || _themeUnsub) return;
    // 优先使用 BetterTypora.theme 平台主题事件 (CSS 变量指纹, 比监听 stylesheet 更可靠)
    if (window.BetterTypora && window.BetterTypora.theme &&
        typeof window.BetterTypora.theme.onChange === "function") {
        _themeUnsub = window.BetterTypora.theme.onChange(function () {
            _timers.setTimeout(syncThemeFonts, 50);
        });
        return;
    }
    // 降级: 旧方案 — 监听 <link rel=stylesheet> 增删
    _themeObserver = new MutationObserver(function (mutations) {
        for (var i = 0; i < mutations.length; i++) {
            var m = mutations[i];
            if (m.type === "childList") {
                for (var j = 0; j < m.addedNodes.length; j++) {
                    var node = m.addedNodes[j];
                    if (node.tagName === "LINK" && node.getAttribute("rel") === "stylesheet") {
                        _timers.setTimeout(syncThemeFonts, 200);
                        return;
                    }
                }
                for (var k = 0; k < m.removedNodes.length; k++) {
                    var node2 = m.removedNodes[k];
                    if (node2.tagName === "LINK" && node2.getAttribute("rel") === "stylesheet") {
                        _timers.setTimeout(syncThemeFonts, 200);
                        return;
                    }
                }
            }
        }
    });
    _themeObserver.observe(document.head, { childList: true, subtree: false });
}

// ===================================================================
// 标签切换联动
// ===================================================================

var _lastSwitchPath = "";
var _lastSwitchTime = 0;

function installTabSwitchListener() {
    try {
        if (window.BetterTypora && window.BetterTypora.events) {
            window.BetterTypora.events.on("tabs:switched", function (payload) {
                if (!payload || !payload.filePath) return;
                var now = Date.now();
                if (payload.filePath === _lastSwitchPath && (now - _lastSwitchTime) < 200) return;
                _lastSwitchPath = payload.filePath;
                _lastSwitchTime = now;

                _timers.setTimeout(function () {
                    if (!repoStore) return;

                    // 检测仓库切换：只看 vault 根目录，不向上查找
                    var vaultRoot = getVaultRoot();
                    var newRepoPath = null;
                    if (vaultRoot) {
                        if (fs.existsSync(path.join(vaultRoot, ".git"))) {
                            newRepoPath = vaultRoot;
                        }
                    }
                    var currentRepoPath = repoStore.state.repoPath;
                    if (newRepoPath && newRepoPath !== currentRepoPath) {
                        repoStore.setRepo(newRepoPath);
                        repoStore.refreshRemotes();
                        if (panel) { panel.refreshSettings(); panel.refreshStatus(); }
                    } else if (!newRepoPath && currentRepoPath) {
                        // 之前有仓库，现在切到了无仓库的 vault
                        repoStore.state.repoPath = vaultRoot || path.dirname(payload.filePath);
                        repoStore.state.isRepo = false;
                        repoStore.state.isDetected = true;
                        if (panel) { panel.refreshSettings(); panel.refreshStatus(); }
                    }

                    repoStore.setCurrentFile(payload.filePath);
                    if (repoStore.state.isRepo) {
                        repoStore.refreshAll().then(function () {
                            updateToolbarBadge();
                            if (panel) { panel.refreshStatus(); panel.refreshHistory(); }
                        });
                    }
                }, 50);
            });
        }
    } catch (e) {
        logger.log("tabs:switched 监听安装失败:", e.message);
    }
}

// ===================================================================
// 命令注册
// ===================================================================

function registerCommands() {
    api.registerCommand("toggle-panel", function () {
        if (panel) panel.toggle();
    }, "切换 Git 面板显隐");

    // 面板初始化仓库后通知 main.js 继续待处理操作
    api.on("git-sync:repo-initialized", function () {
        onRepoInitialized();
    });

    api.registerCommand("quick-commit", function () {
        window.__gitSync_initRepoIfNeeded().then(function (ok) {
            if (!ok) return;
            if (panel) {
                if (!panel.isOpen()) panel.open();
                panel.switchTab("status");
                panel.focusCommitMessage();
            }
        });
    }, "快速提交");

    api.registerCommand("show-diff-current", function () {
        window.__gitSync_initRepoIfNeeded().then(function (ok) {
            if (!ok) return;
            if (panel) {
                if (!panel.isOpen()) panel.open();
                panel.switchTab("history");
                panel.showCurrentFileDiff();
            }
        });
    }, "显示当前文件的变更");

    api.registerCommand("show-history", function () {
        window.__gitSync_initRepoIfNeeded().then(function (ok) {
            if (!ok) return;
            if (panel) {
                if (!panel.isOpen()) panel.open();
                panel.switchTab("history");
            }
        });
    }, "显示提交历史");

    // v2.0: 手动同步按钮
    api.registerCommand("manual-sync", function () {
        window.__gitSync_initRepoIfNeeded().then(function (ok) {
            if (!ok) return;
            handleManualSync();
        });
    }, "手动同步到云端");

    api.registerCommand("sync-push", function () {
        window.__gitSync_initRepoIfNeeded().then(function (ok) {
            if (!ok) return;
            handleSyncPush();
        });
    }, "推送到云端");

    api.registerCommand("sync-pull", function () {
        window.__gitSync_initRepoIfNeeded().then(function (ok) {
            if (!ok) return;
            handleSyncPull();
        });
    }, "从云端拉取");
}

// ===================================================================
// 保存辅助
// ===================================================================

/**
 * 触发 Typora 保存当前文件
 *
 * 调试版：遍历 File 对象查找保存方法
 */
function triggerSave() {
    BetterTypora.saveFile();
}

// ===================================================================
// 手动同步操作
// ===================================================================

// 暴露到 window 上供 toolbar.js / panel.js 调用
window.__gitSync_triggerSave = triggerSave;

function handleManualSync() {

    var remoteUrl = api.getSetting("remoteURL", "");
    var remoteName = api.getSetting("remoteName", "origin");
    if (!remoteUrl) {
        window.BetterTypora.toast("请先在设置中配置远程仓库地址", 3000);
        return;
    }

    var root = repoStore.state.repoPath;
    var branch = repoStore.state.branch || "main";

    // 先保存
    triggerSave();

    setTimeout(function () {
        // 检查是否有变更
        gitCore.hasUncommitted(root).then(function (hu) {
            if (hu.success && !hu.hasChanges) {
                window.BetterTypora.toast("文件没有变化，无需同步", 2000);
                return;
            }

            window.BetterTypora.toast("正在同步...", 1500);

            gitSync.manualSync(root, remoteName, gitCore, branch).then(function (result) {
                if (result.success) {
                    window.BetterTypora.toast("同步成功 ✓", 2000);
                    repoStore.refreshAll().then(function () {
                        updateToolbarBadge();
                        if (panel) { panel.refreshStatus(); panel.refreshHistory(); }
                    });
                } else {
                    var phaseMsg = { "commit": "提交", "push": "推送", "pull": "拉取" }[result.phase || ""] || "同步";
                    window.BetterTypora.toast(phaseMsg + "失败: " + (result.error || "").substring(0, 80), 3000);
                }
            });
        });
    }, 400);
}

function handleSyncPush() {
    var remoteUrl = api.getSetting("remoteURL", "");
    if (!remoteUrl) {
        window.BetterTypora.toast("请先在设置中配置远程仓库地址", 3000);
        return;
    }

    var root = repoStore.state.repoPath;
    var remoteName = api.getSetting("remoteName", "origin");
    var branch = repoStore.state.branch || "main";

    // 先保存
    triggerSave();

    setTimeout(function () {
        // 检查是否有变更
        gitCore.hasUncommitted(root).then(function (hu) {
            if (hu.success && !hu.hasChanges) {
                window.BetterTypora.toast("文件没有变化，无需推送", 2000);
                return;
            }

            window.BetterTypora.toast("正在推送...", 1500);

            gitSync.stageTrackedAndNewMd(root, gitCore).then(function () {
                var fileName = repoStore.state.currentFilePath
                    ? path.basename(repoStore.state.currentFilePath)
                    : "notes";
                return gitSync.commitSync(root, fileName, gitCore);
            }).then(function () {
                return gitSync.pushAfterMerge(root, remoteName, gitCore, branch);
            }).then(function (result) {
                toastResult(result.success, "推送成功 ✓", result.error || "推送失败，请检查网络");
                repoStore.refreshAll().then(function () {
                    updateToolbarBadge();
                    if (panel) panel.refreshStatus();
                });
            });
        });
    }, 400);
}

function handleSyncPull() {
    var remoteUrl = api.getSetting("remoteURL", "");
    if (!remoteUrl) {
        window.BetterTypora.toast("请先在设置中配置远程仓库地址", 3000);
        return;
    }

    var remoteName = api.getSetting("remoteName", "origin");
    var branch = repoStore.state.branch || "main";
    window.BetterTypora.toast("正在拉取...", 1500);

    gitSync.pullBeforeWork(repoStore.state.repoPath, remoteName, gitCore, branch).then(function (result) {
        toastResult(result.success, "拉取成功 ✓", result.conflict ?
            "无法自动合并远端更新，请手动处理" : (result.error || "拉取失败，请检查网络"));
        repoStore.refreshAll().then(function () {
            updateToolbarBadge();
            if (panel) { panel.refreshStatus(); panel.refreshHistory(); }
        });
    });
}

// ===================================================================
// 生命周期
// ===================================================================

module.exports = {
    onLoad: function () {
        logger.log("Git 同步插件 v2.0.0 已加载");
    },

    enable: function () {
        try {
            logger.log("Git 同步插件正在启动...");

            if (!gitCore || !RepoStore || !gitSync) {
                logger.error("子模块加载失败，无法启用");
                return;
            }

            // 步骤 0: 创建定时器组
            _timers = BetterTypora.createTimerGroup();

            // 步骤 1: 阻断凭证弹窗
            gitSync.blockCredentials();

            // 1. 初始化 repo-store
            repoStore = new RepoStore(gitCore);

            // 2. 注入 UI（先注入，后续状态更新时组件已就绪）
            if (toolbarModule && typeof toolbarModule.inject === "function") {
                toolbar = toolbarModule;
                toolbarModule.init(api, repoStore, gitCore, gitSync, icons);
                toolbarModule.inject();
            }

            if (revisionView && typeof revisionView.init === "function") {
                revisionView.init(api, repoStore, gitCore, revisionRenderer);
            }

            if (Panel && typeof Panel === "function") {
                panel = new Panel(api, repoStore, gitCore, gitSync, diffRenderer, revisionView, icons);
                panel.inject();
            }

            // 3. 注册命令
            registerCommands();

            // 4. 检测仓库（带重试，内部执行完整启动序列）
            detectRepoWithRetry(0);

            // 5. 注册文件切换监听（BetterTypora 统一管理 openFile 补丁）
            installFileOpenListener();

            // 6. 启动 guardian
            _timers.setTimeout(function () {
                startGuardian();
            }, 2000);

            // 7. 主题字体同步
            syncThemeFonts();
            installThemeObserver();

            // 8. 标签切换监听
            installTabSwitchListener();

        } catch (e) {
            logger.error("enable() error:", e.message, e.stack);
            window.BetterTypora.toast("Git 插件启动失败: " + e.message, 5000);
        }
    },

    disable: function () {
        logger.log("Git 同步插件正在停用...");

        // 1. 清除所有定时器
        if (_timers) {
            _timers.close();
            _timers = null;
        }
        _guardInterval = null;

        // 2. 取消文件切换监听
        uninstallFileOpenListener();

        // 3. 移除 UI
        if (toolbar && typeof toolbar.remove === "function") {
            toolbar.remove();
            toolbar = null;
        }
        if (panel && typeof panel.remove === "function") {
            panel.remove();
            panel = null;
        }

        // 4. 断开 MutationObserver / 解绑主题事件
        if (_themeObserver) {
            _themeObserver.disconnect();
            _themeObserver = null;
        }
        if (_themeUnsub) {
            try { _themeUnsub(); } catch (e) {}
            _themeUnsub = null;
        }

        // 5. 清理 DOM 残留
        try {
            var artifacts = document.querySelectorAll("[data-plugin-id='git-sync']");
            for (var i = 0; i < artifacts.length; i++) {
                var el = artifacts[i];
                if (el.parentNode) el.parentNode.removeChild(el);
            }
        } catch (e) {}

        // 6. 清除 repo-store
        if (repoStore) {
            repoStore.clear();
            repoStore = null;
        }

        logger.log("Git 同步插件已停用");
    },

    onUnload: function () {
        if (_timers) { _timers.close(); _timers = null; }
        uninstallFileOpenListener();
        if (_themeObserver) { _themeObserver.disconnect(); _themeObserver = null; }
        if (_themeUnsub) { try { _themeUnsub(); } catch (e) {} _themeUnsub = null; }
        logger.log("Git 同步插件已卸载");
    }
};
