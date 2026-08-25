/**
 * Bidirectional Links — Backlinks Panel UI
 * =========================================
 * 在 Typora 侧边栏中注入反链面板，包括：
 *   - 一个 "反链" tab 按钮（在 Search tab 旁边）
 *   - 一个内容面板显示当前文件的反链
 *
 * DOM 注入目标: #typora-sidebar 内的 .info-panel-tab-wrapper 和 #sidebar-content
 */

(function () {
    "use strict";

    function BacklinksPanel(index, resolverModule, fs, pathModule, openFileFn, getCurrentFilePath) {
        this._index = index;
        this._resolver = resolverModule;
        this._fs = fs;
        this._path = pathModule;
        this._openFile = openFileFn;
        this._getCurrentFilePath = getCurrentFilePath || function () { return null; };

        this._tabEl = null;
        this._contentEl = null;
        this._active = false;
        this._currentFilePath = null;
        this._guardInterval = null;
        this._pathPollInterval = null; // 面板打开时快速轮询当前文件路径
        this._snippetCache = {};  // sourcePath → fileContent
        this._themeUnsub = null;  // BetterTypora.theme.onChange 解绑函数
    }

    var MAX_SNIPPETS_PER_SOURCE = 3;

    /**
     * 注入 tab 按钮和内容面板到侧边栏
     */
    BacklinksPanel.prototype.inject = function () {
        var self = this;
        var sidebar = document.getElementById("typora-sidebar");
        if (!sidebar) return false;

        // 检查是否已完整注入（tab + content 都存在）
        var tabExists = !!document.getElementById("info-panel-tab-backlinks");
        var contentExists = !!document.getElementById("backlinks-content");

        if (!tabExists) {
            this._injectTab(sidebar);
        }
        if (!contentExists) {
            this._injectContent();
        }

        // 绑定 tab 点击事件（幂等）
        if (this._tabEl) {
            var self = this;
            this._tabEl.onclick = function () { self.show(); };
        }

        // 监听原生 tab 点击
        this._observeTabSwitching();

        // 订阅主题切换 (幂等): 胶囊类主题切换时重算滑块位置
        if (!this._themeUnsub && window.BetterTypora && window.BetterTypora.theme) {
            this._themeUnsub = window.BetterTypora.theme.onChange(function () {
                self._adaptToTheme();
            });
        }
        // 注入后先适配一次 (延迟到布局稳定后测量 offsetLeft)
        setTimeout(function () { self._adaptToTheme(); }, 120);

        // 渲染初始状态
        this._renderEmpty();

        // 启动守护
        if (!this._guardInterval) this._startGuard();

        return true;
    };

    BacklinksPanel.prototype._injectTab = function (sidebar) {
        var tabWrapper = sidebar.querySelector(".info-panel-tab-wrapper");
        if (!tabWrapper) return;

        var spacer = document.createElement("div");
        spacer.style.cssText = "flex:1;";

        var tab = document.createElement("div");
        tab.className = "info-panel-tab";
        tab.id = "info-panel-tab-backlinks";
        tab.setAttribute("data-plugin-id", "bidirectional-links");
        tab.innerHTML =
            '<div class="info-panel-tab-title">反链</div>' +
            '<div class="info-panel-tab-border"></div>';

        var searchTab = document.getElementById("info-panel-tab-search");
        if (searchTab) {
            var searchSpacer = searchTab.nextElementSibling;
            if (searchSpacer && searchSpacer.style && searchSpacer.style.flex === "1") {
                searchSpacer.parentNode.insertBefore(spacer, searchSpacer.nextSibling);
                spacer.parentNode.insertBefore(tab, spacer.nextSibling);
            } else {
                tabWrapper.appendChild(spacer);
                tabWrapper.appendChild(tab);
            }
        } else {
            tabWrapper.appendChild(spacer);
            tabWrapper.appendChild(tab);
        }
        this._tabEl = tab;
    };

    BacklinksPanel.prototype._injectContent = function () {
        var sidebarContent = document.getElementById("sidebar-content");
        if (!sidebarContent) return;
        var content = document.createElement("div");
        content.id = "backlinks-content";
        content.className = "sidebar-content-content";
        content.setAttribute("data-plugin-id", "bidirectional-links");
        sidebarContent.appendChild(content);
        this._contentEl = content;
    };

    /**
     * 监听 Typora 原生 tab 点击 → 自动关闭反链面板
     */
    BacklinksPanel.prototype._observeTabSwitching = function () {
        var self = this;
        var nativeTabIds = [
            "info-panel-tab-file", "info-panel-tab-outline",
            "info-panel-tab-search", "info-panel-tab-search-back",
        ];
        for (var i = 0; i < nativeTabIds.length; i++) {
            var el = document.getElementById(nativeTabIds[i]);
            if (el) {
                el.addEventListener("click", function () {
                    if (self._active) self.hide();
                }, true);
            }
        }
    };

    /**
     * 胶囊标签栏主题适配 (BetterTypora.theme 特征驱动)
     * 把侧边栏标签栏胶囊化(Capsule)的主题 (如 Claude):
     *  - 反链标签重排为大纲后的第 3 槽 (避开原生 search 等尾部标签)
     *  - wrapper 自适应宽度容纳第 3 槽
     *  - 反链槽收窄 (--bt-tab-w), 空间不足时只压缩反链槽, 不动原生槽
     *  - 胶囊滑块 (wrapper::before) 在反链激活时滑到反链标签下方并贴合其宽度
     * 位移/宽度全部由 JS 实测 (offsetLeft / offsetWidth / ::before.left),
     * 不硬编码坐标, 任何胶囊主题通用。GitHub/默认主题 getSidebarTabsMode()
     * ="default", 自动回退, 零副作用。
     */
    BacklinksPanel.prototype._adaptToTheme = function () {
        var theme = window.BetterTypora && window.BetterTypora.theme;
        var wrapper = document.querySelector(".info-panel-tab-wrapper");
        var tab = document.getElementById("info-panel-tab-backlinks");
        if (!wrapper || !tab) return;
        var mode = theme ? theme.getSidebarTabsMode() : "default";
        if (mode === "capsule") {
            wrapper.classList.add("bt-capsule");  // CSS: 接管槽体系 (等宽/等比压缩)
            // 重排: 紧邻大纲标签之后作为第 3 槽, 避免与 search 等原生标签争夺尾部空间
            var outlineTab = document.getElementById("info-panel-tab-outline");
            if (outlineTab && outlineTab.nextSibling !== tab && tab.parentNode === wrapper) {
                wrapper.insertBefore(tab, outlineTab.nextSibling);
            }
            // 统一槽宽 = 首个原生槽实测宽 (等宽体系下三槽一致; 压缩后自动跟随)
            var firstTab = wrapper.querySelector(".info-panel-tab");
            var slotW = (firstTab && firstTab.offsetWidth) || 82;
            wrapper.style.setProperty("--bt-tab-w", slotW + "px");
            // 滑块基准 left (主题自定义), 实测可得
            var slideLeft = parseFloat(getComputedStyle(wrapper, "::before").left) || 0;
            // 为每个槽写入滑块档位位移: 槽 offsetLeft - 滑块基准
            var slots = {
                "info-panel-tab-file": "--bt-tab-x-files",
                "info-panel-tab-outline": "--bt-tab-x-outline",
                "info-panel-tab-search": "--bt-tab-x-search",
                "info-panel-tab-search-back": "--bt-tab-x-search",
                "info-panel-tab-backlinks": "--bt-tab-x"
            };
            for (var sid in slots) {
                var sEl = document.getElementById(sid);
                if (sEl && sEl.parentNode === wrapper) {
                    wrapper.style.setProperty(slots[sid], ((sEl.offsetLeft || 0) - slideLeft) + "px");
                }
            }
        } else {
            wrapper.classList.remove("bt-capsule");
            wrapper.style.removeProperty("--bt-tab-x");
            wrapper.style.removeProperty("--bt-tab-x-files");
            wrapper.style.removeProperty("--bt-tab-x-outline");
            wrapper.style.removeProperty("--bt-tab-x-search");
            wrapper.style.removeProperty("--bt-tab-w");
        }
    };

    /**
     * 显示反链面板（纯 CSS 驱动）
     */
    BacklinksPanel.prototype.show = function () {
        if (!this._tabEl || !this._contentEl) return;
        var sidebar = document.getElementById("typora-sidebar");
        if (sidebar) {
            sidebar.classList.remove("active-tab-files");
            sidebar.classList.remove("active-tab-outline");
            sidebar.classList.add("active-tab-backlinks");
        }
        // 取消所有原生 tab 的 active 状态
        var nativeTabs = document.querySelectorAll(
            "#info-panel-tab-file, #info-panel-tab-outline, #info-panel-tab-search, #info-panel-tab-search-back"
        );
        for (var i = 0; i < nativeTabs.length; i++) {
            nativeTabs[i].classList.remove("active");
        }
        this._tabEl.classList.add("active");
        // 胶囊主题下激活时同步滑块位置
        this._adaptToTheme();
        this._active = true;

        // 同步当前文件路径并渲染
        var cf = this._getCurrentFilePath();
        if (cf && cf !== this._currentFilePath) {
            this._currentFilePath = cf;
        }
        if (this._currentFilePath) this.update(this._currentFilePath);

        // 面板打开期间，每 250ms 检查 File.bundle.filePath 以感知标签切换
        this._startPathPolling();
    };

    BacklinksPanel.prototype.hide = function () {
        var sidebar = document.getElementById("typora-sidebar");
        if (sidebar) sidebar.classList.remove("active-tab-backlinks");
        if (this._tabEl) this._tabEl.classList.remove("active");
        this._active = false;
        this._stopPathPolling();
    };

    BacklinksPanel.prototype.toggle = function () {
        if (this._active) this.hide(); else this.show();
    };

    BacklinksPanel.prototype.update = function (filePath) {
        this._currentFilePath = filePath;
        if (!this._contentEl) return;
        if (!filePath) { this._renderNoVault(); return; }
        var backlinks = this._index.getBacklinks(filePath);
        if (backlinks.length === 0) { this._renderEmpty(); return; }
        this._clearSnippetCache();
        this._renderBacklinks(backlinks);
    };

    BacklinksPanel.prototype.refresh = function () {
        if (this._currentFilePath) this.update(this._currentFilePath);
    };

    // ===================================================================
    // 渲染
    // ===================================================================

    BacklinksPanel.prototype._renderBacklinks = function (backlinks) {
        if (!this._contentEl) return;

        var grouped = {};
        for (var i = 0; i < backlinks.length; i++) {
            var bl = backlinks[i];
            if (!grouped[bl.source]) grouped[bl.source] = [];
            grouped[bl.source].push(bl);
        }
        var sources = Object.keys(grouped);

        var html = '<div class="backlinks-header">' +
            '<span class="backlinks-title">🔗 反链</span>' +
            '<span class="backlinks-count">' + sources.length + ' 条结果</span>' +
            '<span style="flex:1"></span>' +
            '<button class="backlinks-graph-btn" title="打开知识图谱 (Ctrl+Shift+G)">🕸️</button>' +
            '</div>' +
            '<div class="backlinks-section">' +
            '<div class="backlinks-section-header">引用 (' + sources.length + ')</div>';

        for (var s = 0; s < sources.length; s++) {
            var sourcePath = sources[s];
            var links = grouped[sourcePath];
            var displayName = this._path.basename(sourcePath, ".md");

            html += '<div class="backlink-group" data-source-path="' + this._escapeAttr(sourcePath) + '">' +
                '<div class="backlink-source"><span class="file-icon">📄</span>' +
                this._escapeHtml(displayName) + '</div>';

            var snippets = this._getSnippetsCached(sourcePath, links);
            var snipCount = Math.min(snippets.length, MAX_SNIPPETS_PER_SOURCE);
            for (var l = 0; l < snipCount; l++) {
                html += '<div class="backlink-context">' + snippets[l] + '</div>';
            }
            if (links.length > MAX_SNIPPETS_PER_SOURCE) {
                html += '<div class="backlink-context" style="opacity:0.4">... 还有 ' +
                    (links.length - MAX_SNIPPETS_PER_SOURCE) + ' 处引用</div>';
            }
            html += '</div>';
        }
        html += '</div>';
        this._contentEl.innerHTML = html;
        this._bindPanelClicks();
    };

    BacklinksPanel.prototype._renderEmpty = function () {
        if (!this._contentEl) return;
        this._contentEl.innerHTML =
            '<div class="backlinks-header">' +
                '<span class="backlinks-title">🔗 反链</span>' +
                '<span class="backlinks-count">0 条结果</span>' +
            '</div>' +
            '<div class="backlinks-empty">' +
                '<span class="empty-icon">🔍</span>暂无反向链接' +
                '<div style="font-size:11px;margin-top:4px">打开文件夹以启用反链面板</div>' +
            '</div>';
    };

    BacklinksPanel.prototype._renderNoVault = function () {
        if (!this._contentEl) return;
        this._contentEl.innerHTML =
            '<div class="backlinks-no-vault">' +
                '<span style="font-size:36px;display:block;margin-bottom:8px">📂</span>' +
                '打开文件夹以启用反链面板' +
            '</div>';
    };

    // ===================================================================
    // Snippet（缓存 + 事件委托）
    // ===================================================================

    BacklinksPanel.prototype._bindPanelClicks = function () {
        var self = this;
        var contentEl = this._contentEl;
        if (!contentEl) return;
        if (contentEl._backlinkClickHandler) {
            contentEl.removeEventListener("click", contentEl._backlinkClickHandler);
        }
        var handler = function (e) {
            // 图谱按钮
            var graphBtn = e.target.closest(".backlinks-graph-btn");
            if (graphBtn) {
                try {
                    window.BetterTypora && window.BetterTypora.commands &&
                        window.BetterTypora.commands.execute("bidirectional-links:graph-view");
                } catch (ex) {}
                return;
            }
            // 反链分组点击 → 打开文件
            var group = e.target.closest(".backlink-group");
            if (!group) return;
            var p = group.getAttribute("data-source-path");
            if (p && self._openFile) self._openFile(p);
        };
        contentEl._backlinkClickHandler = handler;
        contentEl.addEventListener("click", handler);
    };

    BacklinksPanel.prototype._getSnippetsCached = function (sourcePath, links) {
        var contextChars = 40;
        var results = [];
        var content = this._snippetCache[sourcePath];
        if (content === undefined) {
            try { content = this._fs.readFileSync(sourcePath, "utf8"); }
            catch (e) { content = ""; }
            this._snippetCache[sourcePath] = content;
        }
        if (!content) {
            for (var i = 0; i < links.length; i++) {
                results.push('<span class="highlight-link">[[' + this._escapeHtml(links[i].target) + ']]</span>');
            }
            return results;
        }
        for (var i = 0; i < links.length; i++) {
            results.push(this._extractSnippet(content, links[i].target, contextChars));
        }
        return results;
    };

    BacklinksPanel.prototype._extractSnippet = function (content, targetName, contextChars) {
        var searchStr = "[[" + targetName;
        var idx = content.indexOf(searchStr);
        if (idx === -1) { searchStr = "[[ " + targetName; idx = content.indexOf(searchStr); }
        if (idx === -1) { idx = content.toLowerCase().indexOf(("[[" + targetName).toLowerCase()); }
        if (idx >= 0) {
            var closeEnd = content.indexOf("]]", idx);
            var linkEnd = closeEnd >= 0 ? closeEnd + 2 : idx + targetName.length + 4;
            var start = Math.max(0, idx - contextChars);
            var end = Math.min(content.length, linkEnd + contextChars);
            var before = content.slice(start, idx).replace(/\n/g, " ").trim();
            var linkText = content.slice(idx, linkEnd);
            var after = content.slice(linkEnd, end).replace(/\n/g, " ").trim();
            return '<span class="context-before">' + this._escapeHtml(before) + '</span>' +
                   '<span class="highlight-link">' + this._escapeHtml(linkText) + '</span>' +
                   '<span class="context-after">' + this._escapeHtml(after) + '</span>';
        }
        return '<span class="highlight-link">[[' + this._escapeHtml(targetName) + ']]</span>';
    };

    BacklinksPanel.prototype._clearSnippetCache = function () {
        this._snippetCache = {};
    };

    // ===================================================================
    // 清理
    // ===================================================================

    BacklinksPanel.prototype.remove = function () {
        if (this._tabEl && this._tabEl.parentNode) {
            var prev = this._tabEl.previousElementSibling;
            if (prev && prev.style && prev.style.flex === "1") prev.parentNode.removeChild(prev);
            this._tabEl.parentNode.removeChild(this._tabEl);
        }
        if (this._contentEl && this._contentEl.parentNode) {
            this._contentEl.parentNode.removeChild(this._contentEl);
        }
        this._tabEl = null;
        this._contentEl = null;
        this._active = false;
        this._clearSnippetCache();
        // 解绑主题切换订阅 + 清理胶囊适配痕迹
        if (this._themeUnsub) { try { this._themeUnsub(); } catch (e) {} this._themeUnsub = null; }
        var wrapper = document.querySelector(".info-panel-tab-wrapper");
        if (wrapper) {
            wrapper.classList.remove("bt-capsule");
            wrapper.style.removeProperty("--bt-tab-x");
        }
        if (this._guardInterval) { clearInterval(this._guardInterval); this._guardInterval = null; }
        if (this._pathPollInterval) { clearInterval(this._pathPollInterval); this._pathPollInterval = null; }
    };

    BacklinksPanel.prototype._startGuard = function () {
        var self = this;
        this._guardInterval = setInterval(function () {
            var tabExists = !!document.getElementById("info-panel-tab-backlinks");
            var contentExists = !!document.getElementById("backlinks-content");
            var sidebar = document.getElementById("typora-sidebar");
            // 任一缺失则重新注入（修复部分移除的 bug）
            if ((!tabExists || !contentExists) && sidebar && self._index.allMdFiles.length > 0) {
                self._tabEl = tabExists ? self._tabEl : null;
                self._contentEl = contentExists ? self._contentEl : null;
                self.inject();
                if (self._currentFilePath) self.update(self._currentFilePath);
            }
            // 周期重测胶囊槽位 (窗口 resize / 侧边栏宽度变化后槽宽位移自愈)
            try { self._adaptToTheme(); } catch (e) {}
        }, 2000);
    };

    // 面板打开时快速轮询——标签切换感知
    // 注意: 快速轮询主力逻辑已移至 main.js startGuard() 中 (250ms)，
    // 那边有 access linkIndex.allMdFiles 用于 title 解析兜底。
    // 这里仅作同频备份：直接读 File.bundle.filePath
    BacklinksPanel.prototype._startPathPolling = function () {
        var self = this;
        if (this._pathPollInterval) return;
        this._pathPollInterval = setInterval(function () {
            if (!self._active) { self._stopPathPolling(); return; }
            var cf = self._getCurrentFilePath();
            if (cf && cf !== self._currentFilePath) {
                self._currentFilePath = cf;
                self.update(cf);
            }
        }, 250);
    };

    BacklinksPanel.prototype._stopPathPolling = function () {
        if (this._pathPollInterval) {
            clearInterval(this._pathPollInterval);
            this._pathPollInterval = null;
        }
    };

    // ===================================================================
    // 辅助
    // ===================================================================

    BacklinksPanel.prototype._escapeHtml = function (text) {
        if (!text) return "";
        return text.replace(/&/g, "&amp;").replace(/</g, "&lt;")
                   .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
    };

    BacklinksPanel.prototype._escapeAttr = function (text) {
        if (!text) return "";
        return text.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
    };

    module.exports = BacklinksPanel;
})();
