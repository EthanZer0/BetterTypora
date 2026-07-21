/**
 * Git Plugin — 修订视图控制器
 * ===============================
 * Wrapper 分屏方案：不修改 #write 任何样式，将 <content> 的所有子元素移入
 * wrapper 作为左列，修订面板作为右列。关闭时子元素原样回到 <content>。
 */
(function () {
    "use strict";

    var _api, _git, _store, _renderer, _editor;
    var _viewEl = null;
    var _isOpen = false;
    var _syncScrollActive = false;
    var _currentHash = "";             // 当前查看的版本 hash
    var _currentFilePath = "";         // 当前查看的文件路径
    var _restoring = false;            // 防止双击恢复并发
    var _closeTimer = null;            // 异步关闭定时器，用于取消竞态

    function init(api, repoStore, gitCore, renderer) {
        _api = api; _store = repoStore; _git = gitCore; _renderer = renderer;
    }

    // ===================================================================
    // 相对路径工具（含目录名前缀碰撞防护）
    // ===================================================================

    function _getRelativePath(filePath) {
        var repoPath = _store.state.repoPath;
        if (!repoPath || !filePath) return filePath || "";
        var absRepo = repoPath.replace(/\\/g, "/").toLowerCase();
        var absFile = filePath.replace(/\\/g, "/").toLowerCase();
        if (absFile.indexOf(absRepo + "/") === 0) {
            return absFile.substring(absRepo.length + 1);
        }
        if (absFile === absRepo) return "";
        return absFile;
    }

    // ===================================================================
    // 打开
    // ===================================================================

    function open(hash, filePath) {
        // 取消进行中的异步关闭，防止 _doClose 破坏新布局
        if (_closeTimer) { clearTimeout(_closeTimer); _closeTimer = null; }
        // 如果已打开（无关闭动画），同步清理掉当前视图
        if (_isOpen) {
            _doClose(_viewEl);
        }
        if (!_editor) { try { _editor = window.editor; } catch (e) {} }

        var writeEl = document.getElementById("write");
        var contentEl = document.querySelector("content");
        if (!writeEl || !contentEl) { window.BetterTypora.toast("找不到编辑器", 2000); return; }

        // ── ❶ 保存当前上下文 ──
        _currentHash = hash;
        _currentFilePath = filePath || _store.state.currentFilePath;
        var newHtml = writeEl.innerHTML;

        // 文件路径（回退逻辑直接更新 _currentFilePath，确保恢复按钮可用）
        var repoPath = _store.state.repoPath;
        if (!repoPath) { window.BetterTypora.toast("未检测到仓库路径", 3000); return; }
        if (!_currentFilePath) _currentFilePath = _store.state.currentFilePath;
        if (!_currentFilePath) {
            try { if (!_currentFilePath) _currentFilePath = BetterTypora.getCurrentFile(); } catch (e) {}
        }
        if (!_currentFilePath) { window.BetterTypora.toast("无法确定当前文件路径", 3000); return; }

        var relPath = _getRelativePath(_currentFilePath);

        // ── ❷ 获取旧版本 → 渲染 → DOM 重构 ──
        _git.showFile(repoPath, hash, relPath).then(function (result) {
            var oldMd = result.success ? result.output : "";
            if (!result.success && result.error) { oldMd = "# 无法获取旧版本\n" + result.error; }

            var diffResult = null;
            try {
                diffResult = _renderer.renderRevision(oldMd || "", newHtml, _editor, { hash: hash });
            } catch (e) {
                diffResult = {
                    leftHtml: "<p>渲染失败: " + e.message + "</p>",
                    stats: { additions: 0, deletions: 0 }
                };
            }

            try {
                _buildRevisionLayout(contentEl, writeEl, diffResult.leftHtml, hash, diffResult.stats);
            } catch (e) {
                // _buildRevisionLayout 内部异常时 close() 回滚 DOM 状态
                close();
                window.BetterTypora.toast("修订视图错误: " + (e.message || "未知错误"), 3000);
            }
        }).catch(function (err) {
            window.BetterTypora.toast("修订视图错误: " + (err.message || "未知错误"), 3000);
        });
    }

    // ===================================================================
    // DOM 重构（纯 DOM 操作，不触碰 Typora editor）
    // ===================================================================

    function _buildRevisionLayout(contentEl, writeEl, oldHtml, hash, stats) {
        var leftWrapper = document.createElement("div");
        leftWrapper.id = "git-rev-left";

        while (contentEl.firstChild) {
            leftWrapper.appendChild(contentEl.firstChild);
        }

        // wrapper 放回 content（现在 content 是空的，wrapper 是唯一子元素）
        contentEl.appendChild(leftWrapper);

        // ── ❷ 设置 content 为 flex row ──
        contentEl.style.display = "flex";
        contentEl.style.flexDirection = "row";
        contentEl.style.overflow = "hidden";
        // ⚠ 不改 content 的 position / top / bottom / left / right
        // ⚠ 不改 #write 的任何属性

        // ── ❸ 创建修订面板（右列）──
        var shell = document.createElement("div");
        shell.id = "git-revision-view";
        shell.setAttribute("data-plugin-id", "git-sync");
        shell.innerHTML =
            '<div class="git-rev-toolbar">' +
            '<button class="git-rev-btn" data-action="back">← 关闭</button>' +
            '<span id="git-rev-title" class="git-rev-title">📜 修订视图</span>' +
            '<button class="git-rev-btn git-rev-btn-danger" data-action="restore">↺ 恢复至此版本</button>' +
            '</div>' +
            '<div id="git-rev-col" class="git-rev-body">' +
            '<div class="git-rev-loading">⏳ 加载旧版本...</div>' +
            '</div>' +
            '<div class="git-rev-statusbar" id="git-rev-statusbar"></div>';

        contentEl.appendChild(shell);
        _viewEl = shell;
        _isOpen = true;

        // ── ❸b 克隆 #write 的结构到修订面板内容区 ──
        // 浅克隆复制标签名 + 所有 HTML 属性 (class, data-*, 等)
        // 但不复制子节点、事件监听器、JS expando 属性
        var revCol = document.getElementById("git-rev-col");
        if (revCol && writeEl) {
            var clone = writeEl.cloneNode(false);  // 浅克隆：只复制元素标签 + 属性
            clone.id = "git-rev-col";
            clone.classList.add("git-rev-body");  // 追加我们的布局类
            clone.removeAttribute("contenteditable");  // 只读
            // 保留 loading 提示文字，其余属性原样继承
            clone.innerHTML = revCol.innerHTML;
            revCol.parentNode.replaceChild(clone, revCol);
        }

        // ── ❸c 动态匹配标签栏高度 ──
        var toolbar = shell.querySelector(".git-rev-toolbar");
        var tabBar = document.getElementById("typora-tab-bar");
        var tabEffectiveHeight = 0;
        if (tabBar) {
            var tabCs = getComputedStyle(tabBar);
            if (tabCs.display !== "none") {
                tabEffectiveHeight = tabBar.offsetHeight; // 32 或 34 (native-window)
            }
        }
        if (toolbar) {
            if (tabEffectiveHeight > 0) {
                toolbar.style.height = tabEffectiveHeight + "px";
                toolbar.style.display = "";
            } else {
                // 无标签栏时：工具栏最小化，关闭按钮悬浮
                toolbar.classList.add("git-rev-toolbar--compact");
            }
        }

        // ── ❸d 克隆 #write 作用域的主题样式到 #git-rev-col ──
        _cloneWriteStyles();

        _bindEvents();

        // ── ❹ 注入旧版 HTML（已在 DOM 重构前渲染完成）──
        var col = document.getElementById("git-rev-col");
        col.innerHTML = oldHtml || '<p class="git-rev-empty-msg">(无内容)</p>';
        var titleEl = document.getElementById("git-rev-title");
        if (titleEl) titleEl.textContent = "📜 对比 " + hash.substring(0, 7);
        var statusbar = document.getElementById("git-rev-statusbar");
        if (statusbar && stats) {
            statusbar.innerHTML =
                '<span class="git-rev-stats-add">+' + (stats.additions || 0) + '</span> ' +
                '<span class="git-rev-stats-del">-' + (stats.deletions || 0) + '</span>';
        }
        _initSyncScroll();
    }

    // ===================================================================
    // 关闭
    // ===================================================================

    function close() {
        _isOpen = false;
        _syncScrollActive = false;

        // 1. 清理 ESC 监听（在移除 DOM 之前）
        if (_viewEl && _viewEl._escHandler) {
            document.removeEventListener("keydown", _viewEl._escHandler);
        }

        // 2. 播放关闭动画，动画结束后再清理 DOM
        if (_viewEl) {
            _viewEl.style.animation = "git-rev-slide-out 0.22s cubic-bezier(0.16, 1, 0.3, 1) forwards";
            var leftWrapper = document.getElementById("git-rev-left");
            if (leftWrapper) {
                leftWrapper.style.animation = "git-rev-left-out 0.18s ease-in forwards";
            }

            var viewEl = _viewEl;
            _closeTimer = setTimeout(function () {
                _closeTimer = null;
                _doClose(viewEl);
            }, 210);
        } else {
            _doClose(null);
        }
    }

    function _doClose(viewEl) {
        // 3. 移除修订面板
        if (viewEl && viewEl.parentNode) viewEl.parentNode.removeChild(viewEl);
        if (viewEl === _viewEl) _viewEl = null;

        // 4. 把 wrapper 的子元素移回 content
        var leftWrapper = document.getElementById("git-rev-left");
        var contentEl = document.querySelector("content");
        if (leftWrapper && contentEl) {
            while (leftWrapper.firstChild) {
                contentEl.appendChild(leftWrapper.firstChild);
            }
            leftWrapper.parentNode.removeChild(leftWrapper);
        }

        // 5. 恢复 content 样式（只清我们设的 3 个属性）
        if (contentEl) {
            contentEl.style.display = "";
            contentEl.style.flexDirection = "";
            contentEl.style.overflow = "";
        }

        // 6. 清理克隆的主题样式
        var clonedStyle = document.getElementById("git-rev-cloned-styles");
        if (clonedStyle && clonedStyle.parentNode) clonedStyle.parentNode.removeChild(clonedStyle);

        // 7. #write 完全没有被修改过，无需恢复

        // 7. 重置模块级状态
        _currentHash = "";
        _currentFilePath = "";
    }

    function isOpen() { return _isOpen; }

    // ===================================================================
    // 恢复文件
    // ===================================================================

    function restoreFile(hash, filePath) {
        if (_restoring) return;  // 防双击并发
        var repoPath = _store.state.repoPath;
        var rp = _getRelativePath(filePath || _store.state.currentFilePath);
        if (!rp) { window.BetterTypora.toast("无法确定文件路径", 3000); return; }
        if (!confirm("确认恢复 [" + rp + "] 到此版本？\n\n当前未保存的更改将丢失。")) return;
        _restoring = true;
        _git.checkoutFile(repoPath, hash, rp).then(function (result) {
            _restoring = false;
            if (result.success) {
                // 在 close() 之前保存路径，防止 DOM 清理影响状态
                var restoredPath = _store.state.currentFilePath;
                try { if (!restoredPath) restoredPath = BetterTypora.getCurrentFile(); } catch (e) {}

                close();
                window.BetterTypora.toast("已恢复到版本 " + hash.substring(0, 7), 2000);

                // 从磁盘读取恢复后的内容，重新加载到编辑器
                // File.getContent(path) 从磁盘读取 → File.reloadContent(content, opts) 写入编辑器
                // encoding 参数省略（让 Typora 自动检测），避免 session-restore 场景下 fileEncode 为 undefined
                if (restoredPath) {
                    try {
                        File.getContent(restoredPath).then(function (content) {
                            if (typeof File.reloadContent === "function") {
                                File.reloadContent(content, { fromDiskChange: true });
                                // 标记文档为干净（与 Typora 自己的文件监听器行为一致）
                                // 防御：非 macOS 平台 NSChangeAutoSaved 可能为 undefined
                                if (typeof File.updateChangeCount === "function" &&
                                    File.ChangeType != null &&
                                    File.ChangeType.NSChangeAutoSaved != null) {
                                    File.updateChangeCount(File.ChangeType.NSChangeAutoSaved);
                                }
                            }
                        }).catch(function (err) {
                            if (typeof console !== "undefined" && console.warn) {
                                console.warn("[git-sync] reloadContent failed:", err);
                            }
                        });
                    } catch (e) {
                        if (typeof console !== "undefined" && console.warn) {
                            console.warn("[git-sync] Editor reload after restore failed:", e);
                        }
                    }
                }
            } else {
                window.BetterTypora.toast("恢复失败: " + (result.error || "未知错误"), 3000);
            }
        }).catch(function (err) {
            _restoring = false;
            window.BetterTypora.toast("恢复操作异常: " + (err.message || "未知错误"), 3000);
        });
    }

    // ===================================================================
    // 事件
    // ===================================================================

    function _bindEvents() {
        var tb = _viewEl.querySelector(".git-rev-toolbar");
        if (tb) tb.addEventListener("click", function (e) {
            var btn = e.target.closest("[data-action]");
            if (!btn) return;
            if (btn.getAttribute("data-action") === "back") close();
            else if (btn.getAttribute("data-action") === "restore") restoreFile(_currentHash, _currentFilePath);
        });
        var escHandler = function (e) { if (e.key === "Escape") close(); };
        _viewEl._escHandler = escHandler;
        document.addEventListener("keydown", escHandler);
    }

    // ===================================================================
    // 同步滚动（左列 wrapper vs 修订面板内容区）
    // ===================================================================

    function _initSyncScroll() {
        _syncScrollActive = true;
        var leftCol = document.getElementById("git-rev-left");       // 左列滚动容器
        var revCol = document.getElementById("git-revision-view");   // 右列滚动容器
        if (!leftCol || !revCol) return;
        leftCol.addEventListener("scroll", _sync(leftCol, revCol));
        revCol.addEventListener("scroll", _sync(revCol, leftCol));
    }

    function _sync(source, target) {
        return function () {
            if (!_syncScrollActive) return;
            _syncScrollActive = false;
            var maxS = source.scrollHeight - source.clientHeight;
            var maxT = target.scrollHeight - target.clientHeight;
            if (maxS > 0 && maxT > 0) target.scrollTop = (source.scrollTop / maxS) * maxT;
            requestAnimationFrame(function () { _syncScrollActive = true; });
        };
    }

    // ===================================================================
    // 动态样式克隆 — 将 #write 作用域的主题规则克隆到 #git-rev-col
    // ===================================================================

    /**
     * 遍历 document.styleSheets，找出所有 #write 开头的 CSS 规则，
     * 将 #write 替换为 #git-rev-col，作为临时 <style> 注入 <head>。
     *
     * 排除规则：
     *   - 含 .md-focus / .CodeMirror / .code-tooltip / typewriter /
     *     .typora- / .on-focus-mode / .md-meta-block 的选择器
     *   - #write:after / #write:before 容器伪元素
     *
     * 递归处理 @media / @supports，保留其包装结构，确保暗色模式切换
     * 等条件规则不受影响。
     */
    function _cloneWriteStyles() {
        var exclude = [
            ".md-focus", ".CodeMirror", ".code-tooltip", "typewriter",
            ".typora-sourceview-on", ".typora-blink-area", ".typora-search",
            ".on-focus-mode", ".md-meta-block"
        ];
        var excludePseudo = [
            "#write:after", "#write:before", "#write::after", "#write::before"
        ];

        var css = "";
        var sheets = document.styleSheets;

        for (var i = 0; i < sheets.length; i++) {
            var rules;
            try { rules = sheets[i].cssRules; } catch (e) { /* 跨域样式表 */ continue; }
            if (!rules) continue;
            css += _collectCss(rules, exclude, excludePseudo);
        }

        // 移除旧的克隆（如果存在）
        var old = document.getElementById("git-rev-cloned-styles");
        if (old && old.parentNode) old.parentNode.removeChild(old);

        if (css) {
            var styleEl = document.createElement("style");
            styleEl.id = "git-rev-cloned-styles";
            styleEl.textContent = css;
            document.head.appendChild(styleEl);
        }
    }

    /**
     * 递归收集 CSS 规则。
     *  - type 1 (STYLE_RULE): 选择器含 #write 且不含排除标记 → 替换后输出
     *  - type 4 (MEDIA_RULE): 递归 → 用 @media 包装
     *  - type 12 (SUPPORTS_RULE): 递归 → 用 @supports 包装
     *  - type 3 (IMPORT_RULE): 尝试递归（同源 @import）
     *  其余类型跳过。
     */
    function _collectCss(rules, exclude, excludePseudo) {
        var out = "";
        for (var j = 0; j < rules.length; j++) {
            var rule = rules[j];
            try {
                var t = rule.type;
                if (t === 1) { // STYLE_RULE
                    var sel = rule.selectorText;
                    if (!sel || sel.indexOf("#write") === -1) continue;

                    var skip = false;
                    for (var k = 0; k < exclude.length; k++) {
                        if (sel.indexOf(exclude[k]) !== -1) { skip = true; break; }
                    }
                    if (skip) continue;
                    for (var k = 0; k < excludePseudo.length; k++) {
                        if (sel.indexOf(excludePseudo[k]) !== -1) { skip = true; break; }
                    }
                    if (skip) continue;

                    var newSel = sel.replace(/#write\b/g, "#git-rev-col");
                    var cssText = rule.style.cssText;
                    out += newSel + " { " + cssText + " }\n";
                } else if (t === 4) { // MEDIA_RULE
                    var inner = _collectCss(rule.cssRules, exclude, excludePseudo);
                    if (inner) out += "@media " + (rule.conditionText || "") + " {\n" + inner + "}\n";
                } else if (t === 12) { // SUPPORTS_RULE
                    var inner = _collectCss(rule.cssRules, exclude, excludePseudo);
                    if (inner) out += "@supports " + (rule.conditionText || "") + " {\n" + inner + "}\n";
                } else if (t === 3) { // IMPORT_RULE — 尝试同源导入
                    var importedSheet = rule.styleSheet;
                    if (importedSheet) {
                        try { out += _collectCss(importedSheet.cssRules, exclude, excludePseudo); } catch (e) {}
                    }
                }
            } catch (e) { /* 个别规则不可访问，跳过 */ }
        }
        return out;
    }

    // ===================================================================
    function checkDom() {
        if (_isOpen && !document.getElementById("git-revision-view")) { _isOpen = false; _viewEl = null; }
    }

    module.exports = { init: init, open: open, close: close, isOpen: isOpen, restoreFile: restoreFile, checkDom: checkDom };
})();
