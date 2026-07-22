/**
 * Git Plugin — 修订视图控制器
 * ===============================
 * Wrapper 分屏方案：不修改 #write 任何样式，将 <content> 的所有子元素移入
 * wrapper 作为左列，修订面板作为右列。关闭时子元素原样回到 <content>。
 *
 * 渲染链路：
 *   prepareRevision(oldMd, newMd) → { aligned, oldKids, newKids }
 *   两侧都使用 Typora 内部 API 渲染 → MathJax.typesetPromise() 在 DOM 插入后调用
 */
(function () {
    "use strict";

    var _api, _git, _store, _renderer, _editor;
    var _viewEl = null;
    var _isOpen = false;
    var _syncScrollActive = false;
    var _currentHash = "";
    var _currentFilePath = "";
    var _restoring = false;
    var _closeTimer = null;

    function init(api, repoStore, gitCore, renderer) {
        _api = api; _store = repoStore; _git = gitCore; _renderer = renderer;
    }

    // ===================================================================
    // 相对路径工具
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
        if (_closeTimer) { clearTimeout(_closeTimer); _closeTimer = null; }
        if (_isOpen) { _doClose(_viewEl); }
        if (!_editor) { try { _editor = window.editor; } catch (e) {} }

        var writeEl = document.getElementById("write");
        var contentEl = document.querySelector("content");
        if (!writeEl || !contentEl) { window.BetterTypora.toast("找不到编辑器", 2000); return; }

        _currentHash = hash;
        _currentFilePath = filePath || _store.state.currentFilePath;

        var repoPath = _store.state.repoPath;
        if (!repoPath) { window.BetterTypora.toast("未检测到仓库路径", 3000); return; }
        if (!_currentFilePath) _currentFilePath = _store.state.currentFilePath;
        if (!_currentFilePath) {
            try { _currentFilePath = BetterTypora.getCurrentFile(); } catch (e) {}
        }
        if (!_currentFilePath) { window.BetterTypora.toast("无法确定当前文件路径", 3000); return; }

        var relPath = _getRelativePath(_currentFilePath);

        // 获取当前 markdown 源码
        var newMdPromise;
        try { newMdPromise = File.getContent(_currentFilePath); }
        catch (e) { newMdPromise = Promise.resolve(""); }

        _git.showFile(repoPath, hash, relPath).then(function (result) {
            var oldMd = (result.success && result.output) ? result.output : "";

            return newMdPromise.then(function (newMd) {
                // prepareRevision 现在返回 { aligned, oldKids, newKids }
                // 两侧都用 _renderMdToHtml 渲染（统一管线）
                var prep = _renderer.prepareRevision(oldMd || "", newMd || "", _editor);

                // 按照对齐结果组装输出子元素
                var outKids = [];
                var marks = [];
                var adds = 0, dels = 0, mods = 0;

                for (var ai = 0; ai < prep.aligned.length; ai++) {
                    var p = prep.aligned[ai];

                    if (p.s === "deleted") {
                        if (p.l >= 0 && p.l < prep.oldKids.length) {
                            outKids.push(prep.oldKids[p.l]);
                            marks.push({ idx: outKids.length - 1, status: "deleted" });
                        }
                        dels++;
                    } else {
                        if (p.r >= 0 && p.r < prep.newKids.length) {
                            outKids.push(prep.newKids[p.r]);
                            if (p.s === "modified") { marks.push({ idx: outKids.length - 1, status: p.s }); mods++; }
                            else if (p.s === "added") { marks.push({ idx: outKids.length - 1, status: p.s }); adds++; }
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
    // DOM 重构
    // ===================================================================

    function _buildRevisionLayout(contentEl, writeEl, revisionData, hash, stats) {
        // ── 左列 wrapper ──
        var leftWrapper = document.createElement("div");
        leftWrapper.id = "git-rev-left";

        while (contentEl.firstChild) {
            leftWrapper.appendChild(contentEl.firstChild);
        }

        contentEl.appendChild(leftWrapper);
        contentEl.style.display = "flex";
        contentEl.style.flexDirection = "row";
        contentEl.style.overflow = "hidden";

        // ── 修订面板（右列）──
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

        // appendChild 插入所有子元素（不经过字符串，math 等保留 Typora 原始 DOM 结构）
        for (var ki = 0; ki < revisionData.children.length; ki++) {
            revContent.appendChild(revisionData.children[ki]);
        }
        shell.appendChild(revContent);

        // ── 贴上 diff 标记 ──
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

        // ── 匹配标签栏高度 ──
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

        // ── 克隆主题样式 ──
        _cloneWriteStyles();

        // ── MathJax 渲染：对修订面板内容进行 typeset ──
        _typesetMathAfterDom(revContent);

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
    // MathJax 渲染
    // ===================================================================

    /**
     * DOM 插入后调用 MathJax.typesetPromise() 渲染数学公式。
     * Typora 的 _renderMdToHtml 输出原始 HTML（含 .md-math-block / .md-inline-math
     * 及 LaTeX 源码），不会预先渲染为 SVG。需要 MathJax 对插入的 DOM 做 typeset。
     */
    function _typesetMathAfterDom(container) {
        // 检查是否真的有数学内容
        if (!container.querySelector(".md-math-block, .md-inline-math, .md-math")) return;

        // MathJax v3
        if (typeof MathJax !== "undefined" && MathJax.typesetPromise) {
            MathJax.typesetPromise([container]).catch(function (err) {
                if (typeof console !== "undefined" && console.warn) {
                    console.warn("[git-sync] MathJax typeset failed:", err);
                }
            });
            return;
        }

        // MathJax v2 回退
        if (typeof MathJax !== "undefined" && MathJax.Hub && MathJax.Hub.Queue) {
            MathJax.Hub.Queue(["Typeset", MathJax.Hub, container]);
            return;
        }

        // 兜底：全局遍历触发（某些 MathJax 配置不支持指定容器）
        if (typeof MathJax !== "undefined" && typeof MathJax.typeset === "function") {
            MathJax.typeset([container]);
        }
    }

    // ===================================================================
    // 关闭
    // ===================================================================

    function close() {
        _isOpen = false;
        _syncScrollActive = false;

        if (_viewEl && _viewEl._escHandler) {
            document.removeEventListener("keydown", _viewEl._escHandler);
        }

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
        if (viewEl && viewEl.parentNode) viewEl.parentNode.removeChild(viewEl);
        if (viewEl === _viewEl) _viewEl = null;

        var leftWrapper = document.getElementById("git-rev-left");
        var contentEl = document.querySelector("content");
        if (leftWrapper && contentEl) {
            while (leftWrapper.firstChild) {
                contentEl.appendChild(leftWrapper.firstChild);
            }
            leftWrapper.parentNode.removeChild(leftWrapper);
        }

        if (contentEl) {
            contentEl.style.display = "";
            contentEl.style.flexDirection = "";
            contentEl.style.overflow = "";
        }

        // 清理克隆的主题样式
        var clonedStyle = document.getElementById("git-rev-cloned-styles");
        if (clonedStyle && clonedStyle.parentNode) clonedStyle.parentNode.removeChild(clonedStyle);

        _currentHash = "";
        _currentFilePath = "";
    }

    function isOpen() { return _isOpen; }

    // ===================================================================
    // 恢复文件
    // ===================================================================

    function restoreFile(hash, filePath) {
        if (_restoring) return;
        var repoPath = _store.state.repoPath;
        var rp = _getRelativePath(filePath || _store.state.currentFilePath);
        if (!rp) { window.BetterTypora.toast("无法确定文件路径", 3000); return; }
        if (!confirm("确认恢复 [" + rp + "] 到此版本？\n\n当前未保存的更改将丢失。")) return;
        _restoring = true;
        _git.checkoutFile(repoPath, hash, rp).then(function (result) {
            _restoring = false;
            if (result.success) {
                var restoredPath = _store.state.currentFilePath;
                try { if (!restoredPath) restoredPath = BetterTypora.getCurrentFile(); } catch (e) {}

                close();
                window.BetterTypora.toast("已恢复到版本 " + hash.substring(0, 7), 2000);

                if (restoredPath) {
                    try {
                        File.getContent(restoredPath).then(function (content) {
                            if (typeof File.reloadContent === "function") {
                                File.reloadContent(content, { fromDiskChange: true });
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
    // 同步滚动
    // ===================================================================

    function _initSyncScroll() {
        _syncScrollActive = true;
        var leftCol = document.getElementById("git-rev-left");
        var revCol = document.getElementById("git-revision-view");
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
    // 主题样式克隆
    // ===================================================================

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

        // MathJax/SVG 全局样式：简化为克隆 ALL 非 #write 作用域的样式规则，
        // 避免遗漏关键样式导致数学公式显示异常
        css += _collectGlobalMathStyles(sheets);

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
     * 收集不包含 #write 前缀的全局 MathJax/MJX/SVG 样式规则。
     * 简化为只收集 selectorText 含 mjx/MathJax 的规则，不做过度的正则过滤。
     */
    function _collectGlobalMathStyles(sheets) {
        var out = "";
        for (var i = 0; i < sheets.length; i++) {
            var rules;
            try { rules = sheets[i].cssRules; } catch (e) { continue; }
            if (!rules) continue;
            for (var j = 0; j < rules.length; j++) {
                var rule = rules[j];
                try {
                    if (rule.type === 1) { // CSSStyleRule
                        var sel = rule.selectorText;
                        if (!sel || sel.indexOf("#write") !== -1) continue;
                        // 收集 MathJax 注入的全局样式（mjx-container, MJXc-*, etc.）
                        // 也包括 svg 相关（MathJax SVG 输出用的内联 svg）
                        if (/\bmjx\b|MathJax|MJX|svg\b/i.test(sel)) {
                            out += "#git-rev-col " + sel + " { " + rule.style.cssText + " }\n";
                        }
                    } else if (rule.type === 4 || rule.type === 12) { // @media / @supports
                        var inner = _collectGlobalMathStyles([rule]);
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
                if (t === 1) {
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
                    out += newSel + " { " + rule.style.cssText + " }\n";
                } else if (t === 4) {
                    var inner = _collectCss(rule.cssRules, exclude, excludePseudo);
                    if (inner) out += "@media " + (rule.conditionText || "") + " {\n" + inner + "}\n";
                } else if (t === 12) {
                    var inner = _collectCss(rule.cssRules, exclude, excludePseudo);
                    if (inner) out += "@supports " + (rule.conditionText || "") + " {\n" + inner + "}\n";
                } else if (t === 3) {
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
