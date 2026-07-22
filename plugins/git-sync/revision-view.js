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

        // 深克隆 #write 的所有子元素（保留 MathJax/链接等完整渲染状态）
        var newKids = [];
        for (var wi = 0; wi < writeEl.children.length; wi++) {
            var wc = writeEl.children[wi];
            if (wc.tagName === "P" && !wc.textContent.trim()) continue;
            newKids.push(wc.cloneNode(true));
        }

        // 文件路径（回退逻辑直接更新 _currentFilePath，确保恢复按钮可用）
        var repoPath = _store.state.repoPath;
        if (!repoPath) { window.BetterTypora.toast("未检测到仓库路径", 3000); return; }
        if (!_currentFilePath) _currentFilePath = _store.state.currentFilePath;
        if (!_currentFilePath) {
            try { if (!_currentFilePath) _currentFilePath = BetterTypora.getCurrentFile(); } catch (e) {}
        }
        if (!_currentFilePath) { window.BetterTypora.toast("无法确定当前文件路径", 3000); return; }

        var relPath = _getRelativePath(_currentFilePath);

        // ── ❷ 获取旧版 markdown → 渲染 → DOM 重构 ──
        // 同时获取当前 markdown 源码用于块对齐（绕过渲染差异）
        var newMdPromise;
        try {
            newMdPromise = File.getContent(_currentFilePath);
        } catch (e) {
            newMdPromise = Promise.resolve("");
        }

        _git.showFile(repoPath, hash, relPath).then(function (result) {
            var oldMd = result.success ? result.output : "";
            if (!result.success && result.error) { oldMd = "# 无法获取旧版本\n" + result.error; }

            return newMdPromise.then(function (newMd) {
                // prepareRevision 返回 { aligned, oldHtml }
                var prep = _renderer.prepareRevision(oldMd || "", newMd || "", _editor);

                // 旧版子元素（_renderMdToHtml 产物，不得已走字符串）
                var oldKids = [];
                var oldContainer = document.createElement("div");
                oldContainer.innerHTML = prep.oldHtml || "";
                for (var oi = 0; oi < oldContainer.children.length; oi++) {
                    var oc = oldContainer.children[oi];
                    if (oc.tagName === "P" && !oc.textContent.trim()) continue;
                    oldKids.push(oc);
                }

                // 构建最终子元素列表 + marks
                var outKids = [];
                var marks = [];
                var adds = 0, dels = 0, mods = 0;

                for (var ai = 0; ai < prep.aligned.length; ai++) {
                    var p = prep.aligned[ai];

                    if (p.s === "deleted") {
                        if (p.l >= 0 && p.l < oldKids.length) {
                            outKids.push(oldKids[p.l].cloneNode(true));
                            marks.push({ idx: outKids.length - 1, status: "deleted" });
                        }
                        dels++;
                    } else {
                        if (p.r >= 0 && p.r < newKids.length) {
                            // cloneNode(true) 保留完整 MathJax SVG 等渲染
                            outKids.push(newKids[p.r].cloneNode(true));
                            if (p.s !== "same") {
                                marks.push({ idx: outKids.length - 1, status: p.s });
                            }
                            if (p.s === "modified") mods++;
                            else if (p.s === "added") adds++;
                        }
                    }
                }

                var revisionData = { children: outKids, marks: marks };
                var stats = { additions: adds, deletions: dels, modifications: mods };

                try {
                    _buildRevisionLayout(contentEl, writeEl, revisionData, hash, stats);
                } catch (e) {
                    close();
                    window.BetterTypora.toast("修订视图错误: " + (e.message || "未知错误"), 3000);
                }
            });
        }).catch(function (err) {
            window.BetterTypora.toast("修订视图错误: " + (err.message || "未知错误"), 3000);
        });
    }

    // ===================================================================
    // DOM 重构（纯 DOM 操作，不触碰 Typora editor）
    // ===================================================================

    function _buildRevisionLayout(contentEl, writeEl, revisionData, hash, stats) {
        var leftWrapper = document.createElement("div");
        leftWrapper.id = "git-rev-left";

        while (contentEl.firstChild) {
            leftWrapper.appendChild(contentEl.firstChild);
        }

        contentEl.appendChild(leftWrapper);
        contentEl.style.display = "flex";
        contentEl.style.flexDirection = "row";
        contentEl.style.overflow = "hidden";

        // ── 创建修订面板（右列）──
        var shell = document.createElement("div");
        shell.id = "git-revision-view";
        shell.setAttribute("data-plugin-id", "git-sync");
        shell.innerHTML =
            '<div class="git-rev-toolbar">' +
            '<button class="git-rev-btn" data-action="back">← 关闭</button>' +
            '<span id="git-rev-title" class="git-rev-title">📜 修订视图</span>' +
            '<button class="git-rev-btn git-rev-btn-danger" data-action="restore">↺ 恢复至此版本</button>' +
            '</div>' +
            '<div class="git-rev-statusbar" id="git-rev-statusbar"></div>';

        contentEl.appendChild(shell);
        _viewEl = shell;
        _isOpen = true;

        // ── 右列内容区 ──
        var revContent = document.createElement("div");
        revContent.id = "git-rev-col";
        revContent.className = writeEl.className + " git-rev-body";
        for (var ai = 0; ai < writeEl.attributes.length; ai++) {
            var attr = writeEl.attributes[ai];
            if (attr.name === "id" || attr.name === "contenteditable") continue;
            revContent.setAttribute(attr.name, attr.value);
        }
        revContent.removeAttribute("contenteditable");

        // 直接 appendChild cloneNode 节点（不经过字符串，保留渲染状态）
        for (var ki = 0; ki < revisionData.children.length; ki++) {
            revContent.appendChild(revisionData.children[ki]);
        }
        shell.appendChild(revContent);

        // ── 动态匹配标签栏高度 ──
        var toolbar = shell.querySelector(".git-rev-toolbar");
        var tabBar = document.getElementById("typora-tab-bar");
        var tabEffectiveHeight = 0;
        if (tabBar) {
            var tabCs = getComputedStyle(tabBar);
            if (tabCs.display !== "none") {
                tabEffectiveHeight = tabBar.offsetHeight;
            }
        }
        if (toolbar) {
            if (tabEffectiveHeight > 0) {
                toolbar.style.height = tabEffectiveHeight + "px";
                toolbar.style.display = "";
            } else {
                toolbar.classList.add("git-rev-toolbar--compact");
            }
        }

        // ── 在克隆体上注入差异 CSS 类 ──
        if (revisionData.marks && revContent.children.length > 0) {
            var children = revContent.children;
            for (var mi = 0; mi < revisionData.marks.length; mi++) {
                var mark = revisionData.marks[mi];
                if (mark.idx >= 0 && mark.idx < children.length) {
                    var el = children[mark.idx];
                    if (mark.status === "modified") el.classList.add("git-rev-block-mod");
                    else if (mark.status === "added") el.classList.add("git-rev-block-add");
                    else if (mark.status === "deleted") el.classList.add("git-rev-block-del");
                }
            }
        }

        // ── 克隆 #write 的主题样式到 #git-rev-col ──
        _cloneWriteStyles();

        _bindEvents();

        var titleEl = document.getElementById("git-rev-title");
        if (titleEl) titleEl.textContent = "📜 对比 " + hash.substring(0, 7);
        var statusbar = document.getElementById("git-rev-statusbar");
        if (statusbar && stats) {
            statusbar.innerHTML =
                '<span class="git-rev-stats-add">+' + (stats.additions || 0) + '</span> ' +
                '<span class="git-rev-stats-mod">~' + (stats.modifications || 0) + '</span> ' +
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

        // 5. 恢复 content 样式
        if (contentEl) {
            contentEl.style.display = "";
            contentEl.style.flexDirection = "";
            contentEl.style.overflow = "";
        }

        // 6. 清理克隆的主题样式
        var clonedStyle = document.getElementById("git-rev-cloned-styles");
        if (clonedStyle && clonedStyle.parentNode) clonedStyle.parentNode.removeChild(clonedStyle);

        // 7. #write 完全没有被修改过，无需恢复

        // 6. 清理克隆的主题样式
        var clonedStyle = document.getElementById("git-rev-cloned-styles");
        if (clonedStyle && clonedStyle.parentNode) clonedStyle.parentNode.removeChild(clonedStyle);

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
            try { rules = sheets[i].cssRules; } catch (e) { continue; }
            if (!rules) continue;
            css += _collectCss(rules, exclude, excludePseudo);
        }

        // 追加全局 MathJax 样式（非 #write 作用域的规则需显式注入）
        css += _collectMathJaxStyles(sheets);

        var old = document.getElementById("git-rev-cloned-styles");
        if (old && old.parentNode) old.parentNode.removeChild(old);

        if (css) {
            var styleEl = document.createElement("style");
            styleEl.id = "git-rev-cloned-styles";
            styleEl.textContent = css;
            document.head.appendChild(styleEl);
        }
    }

    // 收集全局 MathJax 样式（不带 #write 前缀的 MJX 规则）
    function _collectMathJaxStyles(sheets) {
        var out = "";
        for (var i = 0; i < sheets.length; i++) {
            var rules;
            try { rules = sheets[i].cssRules; } catch (e) { continue; }
            if (!rules) continue;
            for (var j = 0; j < rules.length; j++) {
                var rule = rules[j];
                try {
                    if (rule.type === 1) {
                        var sel = rule.selectorText;
                        if (!sel) continue;
                        // 收集 MathJax/MJX 相关的全局样式
                        if (sel.indexOf("#write") === -1 &&
                            /(mjx-container|MJX|MathJax|\.md-math\b|\.md-math-block|\.md-inline-math|math\b)/i.test(sel) &&
                            !/mtext|merror/.test(sel)) {
                            // 限制作用域到修订面板
                            out += "#git-rev-col " + sel + " { " + rule.style.cssText + " }\n";
                        }
                    } else if (rule.type === 4 || rule.type === 12) {
                        var inner = _collectMathJaxStyles([rule]);
                        if (inner) out += (rule.type === 4 ? "@media " : "@supports ") + (rule.conditionText || "") + " {\n" + inner + "}\n";
                    }
                } catch (e) {}
            }
        }
        return out;
    }

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
                } else if (t === 3) { // IMPORT_RULE
                    var importedSheet = rule.styleSheet;
                    if (importedSheet) {
                        try { out += _collectCss(importedSheet.cssRules, exclude, excludePseudo); } catch (e) {}
                    }
                }
            } catch (e) {}
        }
        return out;
    }

    // ===================================================================
    function checkDom() {
        if (_isOpen && !document.getElementById("git-revision-view")) { _isOpen = false; _viewEl = null; }
    }

    module.exports = { init: init, open: open, close: close, isOpen: isOpen, restoreFile: restoreFile, checkDom: checkDom };
})();
