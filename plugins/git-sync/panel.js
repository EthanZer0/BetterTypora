/**
 * Git Plugin — 详细面板
 * =========================
 * 右侧滑入面板，4 个 Tab: 状态/历史/分支/设置
 * 宽度 380px，从右侧滑入 (transform: translateX)。
 * ESC / 遮罩点击关闭。
 */
(function () {
    "use strict";

    // ===================================================================
    // 工具函数
    // ===================================================================

    function escapeHtml(str) {
        if (!str) return "";
        return str
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;");
    }

    function escapeHtmlAttr(str) {
        return str.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    }

    // ===================================================================

    /**
     * @param {Object} api - PluginAPI 实例
     * @param {Object} repoStore - RepoStore 实例
     * @param {Object} gitCore - git-core.js 导出
     * @param {Object} gitSync - git-sync.js 导出 (v2.0)
     * @param {Object} diffRenderer - diff-renderer.js 导出
     * @param {Object} revisionView - revision-view.js 导出 (可选)
     */
    function Panel(api, repoStore, gitCore, gitSync, diffRenderer, revisionView, iconsModule) {
        this._api = api;
        this._store = repoStore;
        this._git = gitCore;
        this._sync = gitSync || null;
        this._diff = diffRenderer;
        this._revision = revisionView || null;
        this._icons = iconsModule || null;

        this._clickCatcherEl = null;  // transparent full-screen click-to-close
        this._panelEl = null;
        this._contentEl = null;
        this._activeTab = "status";
        this._open = false;
        this._injected = false;
        this._statusTextEl = null;
        this._spinnerEl = null;
    }

    // ===================================================================
    // 注入 DOM
    // ===================================================================

    Panel.prototype.inject = function () {
        if (this._injected) return;

        // ── Transparent click catcher (closes panel on outside click) ──
        var catcher = document.createElement("div");
        catcher.id = "git-panel-catcher";
        catcher.setAttribute("data-plugin-id", "git-sync");
        catcher.addEventListener("click", (function (self) {
            return function () { self.close(); };
        })(this));

        // ── Popup panel ──
        var panel = document.createElement("div");
        panel.className = "git-popup-panel";
        panel.id = "git-popup-panel";

        panel.appendChild(this._createHeader());
        panel.appendChild(this._createContent());
        panel.appendChild(this._createStatusBar());

        // Prevent clicks inside panel from bubbling to catcher
        panel.addEventListener("click", function (e) {
            e.stopPropagation();
        });

        catcher.appendChild(panel);
        document.body.appendChild(catcher);

        this._clickCatcherEl = catcher;
        this._panelEl = panel;
        this._contentEl = panel.querySelector(".git-panel-content");
        this._statusTextEl = panel.querySelector("#git-status-text");
        this._spinnerEl = panel.querySelector("#git-status-spinner");

        this._bindEvents();
        this._injected = true;
    };

    Panel.prototype._createHeader = function () {
        var header = document.createElement("div");
        header.className = "git-popup-header";

        var tabs = document.createElement("div");
        tabs.className = "git-popup-tabs";

        var tabDefs = [
            { id: "status", icon: "status", label: "状态" },
            { id: "history", icon: "history", label: "历史" },
            { id: "branches", icon: "branch", label: "分支" },
            { id: "settings", icon: "settings", label: "设置" }
        ];

        var icons = this._icons;
        for (var i = 0; i < tabDefs.length; i++) {
            var td = tabDefs[i];
            var tab = document.createElement("button");
            tab.className = "git-popup-tab" + (td.id === "status" ? " active" : "");
            tab.setAttribute("data-tab", td.id);
            tab.setAttribute("title", td.label);
            if (icons && typeof icons.renderIcon === "function") {
                tab.innerHTML = icons.renderIcon(td.icon, 16);
            } else {
                tab.textContent = td.label;
            }
            tab.onclick = (function (self, tabId) {
                return function () { self.switchTab(tabId); };
            })(this, td.id);
            tabs.appendChild(tab);
        }

        // Close button
        var closeBtn = document.createElement("button");
        closeBtn.className = "git-popup-close";
        if (icons && typeof icons.renderIcon === "function") {
            closeBtn.innerHTML = icons.renderIcon("close", 16);
        } else {
            closeBtn.textContent = "×";
        }
        closeBtn.setAttribute("title", "关闭");
        closeBtn.onclick = (function (self) { return function () { self.close(); }; })(this);

        header.appendChild(tabs);
        header.appendChild(closeBtn);

        return header;
    };

    Panel.prototype._createContent = function () {
        var content = document.createElement("div");
        content.className = "git-panel-content";

        // === Tab 1: 状态 ===
        var statusTab = document.createElement("div");
        statusTab.className = "git-panel-tab-content active";
        statusTab.id = "git-tab-status";

        statusTab.innerHTML =
            // 仓库信息栏
            "<div class='git-status-header' style='margin-bottom:12px;padding:8px 10px;border-radius:6px;background:var(--window-border,rgba(0,0,0,0.03));'>" +
                "<div style='display:flex;align-items:center;gap:8px;flex-wrap:wrap;'>" +
                    "<span class='git-branch-label' id='git-branch-label' style='font-weight:600;font-size:14px;'></span>" +
                    "<span class='git-remote-info' id='git-remote-info' style='font-size:11px;opacity:0.7;'></span>" +
                "</div>" +
                "<div style='margin-top:4px;font-size:12px;'>" +
                    "<span id='git-ahead-behind' style='color:var(--text-color,#888);'></span>" +
                "</div>" +
            "</div>" +

            // 文件列表
            "<div class='git-file-list-section'>" +
                "<div style='font-size:12px;font-weight:600;margin-bottom:6px;color:var(--heading-text-color,var(--text-color,#333));'>改动文件</div>" +
                "<div class='git-file-list' id='git-file-list'></div>" +
                "<div id='git-no-changes' style='display:none;padding:20px;text-align:center;color:var(--text-color,#888);font-size:13px;'>" +
                    "没有改动的文件 ✓" +
                "</div>" +
            "</div>" +

            // 内联 Diff 预览区
            "<div id='git-inline-diff' style='display:none;margin-top:12px;'></div>" +

            // 提交区域
            "<div class='git-commit-area' style='margin-top:12px;border-top:1px solid var(--window-border,rgba(0,0,0,0.06));padding-top:12px;'>" +
                "<textarea class='git-commit-msg' id='git-commit-msg' " +
                    "placeholder='输入提交信息...'" +
                    "rows='3' " +
                    "style='width:100%;padding:8px;border-radius:4px;border:1px solid var(--window-border,#ccc);" +
                    "background:var(--bg-color,#fff);color:var(--text-color,#555);" +
                    "font-family:var(--font-sans,system-ui);font-size:13px;resize:vertical;box-sizing:border-box;'" +
                "></textarea>" +
                "<div class='git-commit-actions' style='margin-top:8px;display:flex;gap:6px;'>" +
                    "<button class='git-btn git-btn-primary' id='git-btn-commit' " +
                        "style='padding:6px 14px;border-radius:4px;border:none;cursor:pointer;font-size:13px;'>提交</button>" +
                    "<button class='git-btn' id='git-btn-commit-push' " +
                        "style='padding:6px 14px;border-radius:4px;border:1px solid var(--window-border,#ddd);" +
                        "background:var(--bg-color,#fff);color:var(--text-color,#555);cursor:pointer;font-size:13px;'>提交并推送</button>" +
                    "<button class='git-btn' id='git-btn-stage-all' " +
                        "style='padding:6px 14px;border-radius:4px;border:1px solid var(--window-border,#ddd);" +
                        "background:var(--bg-color,#fff);color:var(--text-color,#555);cursor:pointer;font-size:13px;'>暂存全部</button>" +
                "</div>" +
            "</div>" +

            // 同步按钮
            "<div class='git-sync-actions' style='margin-top:8px;display:flex;gap:6px;'>" +
                "<button class='git-btn' id='git-btn-pull-panel' " +
                    "style='flex:1;padding:6px;border-radius:4px;border:1px solid var(--window-border,#ddd);" +
                    "background:var(--bg-color,#fff);color:var(--text-color,#555);cursor:pointer;font-size:13px;text-align:center;'>" +
                    "↓ Pull</button>" +
                "<button class='git-btn' id='git-btn-push-panel' " +
                    "style='flex:1;padding:6px;border-radius:4px;border:1px solid var(--window-border,#ddd);" +
                    "background:var(--bg-color,#fff);color:var(--text-color,#555);cursor:pointer;font-size:13px;text-align:center;'>" +
                    "↑ Push</button>" +
            "</div>";

        // === Tab 2: 历史 ===
        var historyTab = document.createElement("div");
        historyTab.className = "git-panel-tab-content";
        historyTab.id = "git-tab-history";

        historyTab.innerHTML =
            // 过滤栏
            "<div class='git-history-filter' style='margin-bottom:10px;display:flex;gap:6px;'>" +
                "<input class='git-filter-input' id='git-filter-commits' placeholder='搜索提交...' " +
                    "style='flex:1;padding:6px 8px;border-radius:4px;border:1px solid var(--window-border,#ccc);" +
                    "background:var(--bg-color,#fff);color:var(--text-color,#555);font-size:12px;'>" +
                "<select class='git-filter-file' id='git-filter-file' " +
                    "style='padding:6px;border-radius:4px;border:1px solid var(--window-border,#ccc);" +
                    "background:var(--bg-color,#fff);color:var(--text-color,#555);font-size:12px;max-width:130px;'>" +
                    "<option value=''>所有文件</option>" +
                "</select>" +
            "</div>" +
            // 提交列表
            "<div class='git-commit-list' id='git-commit-list'></div>" +
            "<div id='git-no-commits' style='display:none;padding:20px;text-align:center;color:var(--text-color,#888);font-size:13px;'>" +
                "暂无提交记录" +
            "</div>" +
            // 加载更多
            "<button class='git-btn git-btn-load-more' id='git-btn-load-more' " +
                "style='display:none;width:100%;margin-top:10px;padding:6px;border-radius:4px;" +
                "border:1px solid var(--window-border,#ddd);background:var(--bg-color,#fff);" +
                "color:var(--text-color,#555);cursor:pointer;font-size:13px;'>加载更多...</button>" +
            // Diff 查看区
            "<div id='git-history-diff'></div>";

        // === Tab 3: 分支 ===
        var branchesTab = document.createElement("div");
        branchesTab.className = "git-panel-tab-content";
        branchesTab.id = "git-tab-branches";

        branchesTab.innerHTML =
            // 当前分支
            "<div class='git-branch-current' style='margin-bottom:12px;padding:8px 10px;border-radius:6px;background:var(--window-border,rgba(0,0,0,0.03));'>" +
                "当前分支: <strong id='git-branch-current-name'>—</strong>" +
            "</div>" +
            // 分支列表
            "<div class='git-branch-list-title' style='font-size:12px;font-weight:600;margin-bottom:6px;color:var(--heading-text-color,var(--text-color,#333));'>分支列表</div>" +
            "<div class='git-branch-list' id='git-branch-list'></div>" +
            "<div id='git-no-branches' style='display:none;padding:20px;text-align:center;color:var(--text-color,#888);font-size:13px;'>" +
                "无分支信息" +
            "</div>" +
            // ── Branch graph ──
            "<div style='font-size:12px;font-weight:600;margin-top:14px;margin-bottom:6px;color:var(--heading-text-color,var(--text-color,#333));'>提交关系图</div>" +
            "<div class='git-branch-graph-container' id='git-branch-graph'></div>" +
            // 新建分支
            "<div class='git-branch-create' style='margin-top:12px;border-top:1px solid var(--window-border,rgba(0,0,0,0.06));padding-top:12px;'>" +
                "<div style='font-size:12px;font-weight:600;margin-bottom:6px;color:var(--heading-text-color,var(--text-color,#333));'>创建新分支</div>" +
                "<div style='display:flex;gap:6px;'>" +
                    "<input class='git-branch-input' id='git-branch-new-name' placeholder='新分支名...' " +
                        "style='flex:1;padding:6px 8px;border-radius:4px;border:1px solid var(--window-border,#ccc);" +
                        "background:var(--bg-color,#fff);color:var(--text-color,#555);font-size:12px;'>" +
                    "<button class='git-btn git-btn-primary' id='git-btn-create-branch' " +
                        "style='padding:6px 12px;border-radius:4px;border:none;cursor:pointer;font-size:12px;white-space:nowrap;'>创建并切换</button>" +
                "</div>" +
            "</div>" +
            // 合并区域
            "<div class='git-merge-area' style='margin-top:12px;border-top:1px solid var(--window-border,rgba(0,0,0,0.06));padding-top:12px;'>" +
                "<div style='font-size:12px;font-weight:600;margin-bottom:6px;color:var(--heading-text-color,var(--text-color,#333));'>合并分支</div>" +
                "<div style='display:flex;gap:6px;align-items:center;'>" +
                    "<span style='font-size:12px;'>合并</span>" +
                    "<select id='git-merge-source-select' " +
                        "style='flex:1;padding:6px;border-radius:4px;border:1px solid var(--window-border,#ccc);" +
                        "background:var(--bg-color,#fff);color:var(--text-color,#555);font-size:12px;'></select>" +
                    "<span style='font-size:12px;'>到当前分支</span>" +
                    "<button class='git-btn' id='git-btn-merge' " +
                        "style='padding:6px 12px;border-radius:4px;border:1px solid var(--window-border,#ddd);" +
                        "background:var(--bg-color,#fff);color:var(--text-color,#555);cursor:pointer;font-size:12px;white-space:nowrap;'>合并</button>" +
                "</div>" +
            "</div>";

        // === Tab 4: 设置 ===
        var settingsTab = document.createElement("div");
        settingsTab.className = "git-panel-tab-content";
        settingsTab.id = "git-tab-settings";

        settingsTab.innerHTML = this._renderSettingsContent();

        content.appendChild(statusTab);
        content.appendChild(historyTab);
        content.appendChild(branchesTab);
        content.appendChild(settingsTab);

        // ── 初始化遮罩层（无仓库时覆盖内容区）──
        this._initOverlayEl = document.createElement("div");
        this._initOverlayEl.id = "git-init-overlay";
        this._initOverlayEl.className = "git-init-overlay";
        this._initOverlayEl.setAttribute("data-plugin-id", "git-sync");
        this._initOverlayEl.innerHTML =
            "<div class='git-init-card'>" +
                "<div class='git-init-icon'>🔧</div>" +
                "<div class='git-init-title'>初始化 Git 仓库</div>" +
                "<div class='git-init-desc'>" +
                    "当前目录尚未初始化 Git 仓库。<br>" +
                    "初始化后将自动创建 .gitignore<br>" +
                    "并完成首次提交。" +
                "</div>" +
                "<button class='git-btn git-btn-primary' id='git-btn-init-repo'>" +
                    "初始化仓库" +
                "</button>" +
            "</div>";
        this._initOverlayEl.style.display = "none";
        content.appendChild(this._initOverlayEl);

        return content;
    };

    Panel.prototype._createStatusBar = function () {
        var bar = document.createElement("div");
        bar.className = "git-panel-statusbar";
        bar.style.cssText =
            "display:flex;align-items:center;justify-content:space-between;padding:6px 12px;" +
            "border-top:1px solid var(--window-border,rgba(0,0,0,0.06));flex-shrink:0;font-size:11px;color:var(--text-color,#888);";

        var statusText = document.createElement("span");
        statusText.id = "git-status-text";
        statusText.textContent = "就绪";

        var spinner = document.createElement("span");
        spinner.id = "git-status-spinner";
        spinner.textContent = "↻"; // ↻
        spinner.style.cssText = "display:none;animation:git-spin 0.8s linear infinite;";
        spinner.style.fontSize = "14px";

        bar.appendChild(statusText);
        bar.appendChild(spinner);

        return bar;
    };

    // ===================================================================
    // 设置内容渲染
    // ===================================================================

    Panel.prototype._renderSettingsContent = function () {
        var api = this._api;
        var store = this._store;
        var remoteEnabled = api.getSetting("remoteEnabled", false);
        var remoteURL = api.getSetting("remoteURL", "");
        var diffMode = api.getSetting("diffViewMode", "unified");
        var maxHistory = api.getSetting("maxHistoryCount", 50);

        function checked(val) { return val ? " checked" : ""; }

        // 状态摘要
        var repoStatus = "未检测到仓库";
        var statusColor = "#e05555";
        if (store && store.state.isRepo) {
            repoStatus = "已就绪";
            statusColor = "#2ea043";
        }
        var branchName = store ? (store.state.branch || "") : "";
        var lockInfo = "未锁定";
        var lockColor = "#888";
        return "" +
            // ===== 仓库状态 =====
            "<div class='git-setting-group' style='margin-bottom:16px;'>" +
                "<div style='font-size:13px;font-weight:600;margin-bottom:8px;color:var(--heading-text-color,var(--text-color,#333));'>仓库状态</div>" +
                "<div class='git-setting-row' style='font-size:12px;margin-bottom:4px;'>" +
                    "<span>状态：</span><span id='git-setting-repo-status' style='color:" + statusColor + ";'>" + repoStatus + "</span>" +
                "</div>" +
                "<div class='git-setting-row' style='font-size:12px;margin-bottom:4px;'>" +
                    "<span>当前分支：</span><span id='git-setting-branch'>" + escapeHtmlAttr(branchName || "-") + "</span>" +
                "</div>" +
                "<div class='git-setting-row' style='font-size:12px;margin-bottom:4px;'>" +
                    "<span>同步锁：</span><span id='git-setting-lock-info' style='color:" + lockColor + ";'>" + lockInfo + "</span>" +
                "</div>" +
            "</div>" +

            // ===== 远程仓库 =====
            "<div class='git-setting-group' style='margin-bottom:16px;'>" +
                "<div style='font-size:13px;font-weight:600;margin-bottom:8px;color:var(--heading-text-color,var(--text-color,#333));'>远程仓库</div>" +
                "<label class='git-setting-row' style='display:flex;align-items:center;gap:8px;margin-bottom:8px;font-size:13px;cursor:pointer;'>" +
                    "<input type='checkbox' id='git-setting-remote-enabled'" + checked(remoteEnabled) + ">" +
                    "<span>启用远程同步</span>" +
                "</label>" +
                "<label class='git-setting-row' style='display:flex;align-items:center;gap:8px;margin-bottom:8px;font-size:13px;'>" +
                    "<span style='min-width:40px;'>地址：</span>" +
                    "<input type='text' id='git-setting-remote-url' value='" + escapeHtmlAttr(remoteURL) + "' " +
                        "placeholder='git@github.com:user/repo.git 或 https://github.com/user/repo.git' " +
                        "style='flex:1;padding:4px 8px;border-radius:4px;border:1px solid var(--window-border,#ccc);" +
                        "background:var(--bg-color,#fff);color:var(--text-color,#555);font-size:13px;'>" +
                "</label>" +
                "<p class='git-url-hint'>" +
                    "SSH 地址: <code>git@github.com:user/repo.git</code>（推荐，需配置 SSH 密钥）<br>" +
                    "HTTPS 地址: <code>https://github.com/user/repo.git</code>（需使用 Personal Access Token 替代密码）" +
                "</p>" +
                // v2.0: 手动同步按钮 + 诊断按钮
                "<div style='display:flex;gap:6px;margin-top:6px;'>" +
                    "<button class='git-btn git-btn-primary' id='git-btn-manual-sync' " +
                        "style='flex:1;padding:6px 10px;border-radius:4px;border:none;cursor:pointer;font-size:12px;'>" +
                        "同步到云端" +
                    "</button>" +
                    "<button class='git-btn' id='git-btn-remote-test' " +
                        "style='padding:6px 8px;border-radius:4px;border:1px solid var(--window-border,#ccc);cursor:pointer;font-size:12px;' " +
                        "title='检查远程仓库连通性'>" +
                        "测试" +
                    "</button>" +
                "</div>" +
            "</div>" +

            // ===== 运维工具 =====
            "<div class='git-setting-group' style='margin-bottom:16px;'>" +
                "<div style='font-size:13px;font-weight:600;margin-bottom:8px;color:var(--heading-text-color,var(--text-color,#333));'>运维工具</div>" +
                "<div style='display:flex;gap:6px;flex-wrap:wrap;'>" +
                    "<button class='git-btn' id='git-btn-check-health' " +
                        "style='padding:5px 10px;border-radius:4px;border:1px solid var(--window-border,#ccc);cursor:pointer;font-size:12px;' " +
                        "title='检查 Git 仓库完整性'>" +
                        "仓库检查" +
                    "</button>" +
                "</div>" +
                "<p style='font-size:10px;color:#999;margin-top:6px;line-height:1.4;'>" +
                    "提示：仓库检查可诊断 Git 仓库健康状态。" +
                "</p>" +
            "</div>" +

            // ===== 显示 =====
            "<div class='git-setting-group' style='margin-bottom:16px;'>" +
                "<div style='font-size:13px;font-weight:600;margin-bottom:8px;color:var(--heading-text-color,var(--text-color,#333));'>显示</div>" +
                "<label class='git-setting-row' style='display:flex;align-items:center;gap:8px;margin-bottom:8px;font-size:13px;'>" +
                    "<span style='min-width:60px;'>变更视图：</span>" +
                    "<select id='git-setting-diff-mode' " +
                        "style='padding:4px 8px;border-radius:4px;border:1px solid var(--window-border,#ccc);" +
                        "background:var(--bg-color,#fff);color:var(--text-color,#555);font-size:13px;'>" +
                        "<option value='unified'" + (diffMode === "unified" ? " selected" : "") + ">统一视图</option>" +
                        "<option value='side-by-side'" + (diffMode === "side-by-side" ? " selected" : "") + ">并排视图</option>" +
                    "</select>" +
                "</label>" +
                "<label class='git-setting-row' style='display:flex;align-items:center;gap:8px;margin-bottom:8px;font-size:13px;'>" +
                    "<span style='min-width:60px;'>历史条数：</span>" +
                    "<input type='number' id='git-setting-max-history' min='10' max='500' value='" + maxHistory + "' " +
                        "style='width:70px;padding:4px 8px;border-radius:4px;border:1px solid var(--window-border,#ccc);" +
                        "background:var(--bg-color,#fff);color:var(--text-color,#555);font-size:13px;'>" +
                "</label>" +
            "</div>";
    };

    // ===================================================================
    // 事件绑定
    // ===================================================================

    Panel.prototype._bindEvents = function () {
        var self = this;

        // ESC 关闭
        document.addEventListener("keydown", function (e) {
            if (e.key === "Escape" && self._open) {
                self.close();
            }
        });

        // ===== Tab 1: 状态 =====
        this._bindClick("git-btn-commit", function () { self._handleCommit(); });
        this._bindClick("git-btn-commit-push", function () { self._handleCommitAndPush(); });
        this._bindClick("git-btn-stage-all", function () { self._handleStageAll(); });
        this._bindClick("git-btn-pull-panel", function () { window.BetterTypora.commands.execute("git-sync:pull"); });
        this._bindClick("git-btn-push-panel", function () { window.BetterTypora.commands.execute("git-sync:push"); });

        // ===== Tab 2: 历史 =====
        var filterInput = document.getElementById("git-filter-commits");
        if (filterInput) {
            filterInput.addEventListener("input", function () {
                self._filterCommits();
            });
        }
        var filterFile = document.getElementById("git-filter-file");
        if (filterFile) {
            filterFile.addEventListener("change", function () {
                self._filterCommits();
            });
        }
        this._bindClick("git-btn-load-more", function () { self._loadMoreHistory(); });

        // ===== Tab 3: 分支 =====
        this._bindClick("git-btn-create-branch", function () { self._handleCreateBranch(); });
        this._bindClick("git-btn-merge", function () { self._handleMerge(); });

        // ===== Tab 4: 设置 =====
        this._bindChange("git-setting-remote-enabled", function (el) {
            self._api.setSetting("remoteEnabled", el.checked);
            self.refreshSettings();
        });
        this._bindChange("git-setting-remote-url", function (el) {
            self._api.setSetting("remoteURL", el.value.trim());
        });
        this._bindChange("git-setting-diff-mode", function (el) {
            self._api.setSetting("diffViewMode", el.value);
        });
        this._bindChange("git-setting-max-history", function (el) {
            self._api.setSetting("maxHistoryCount", parseInt(el.value, 10) || 50);
        });
        this._bindClick("git-btn-manual-sync", function () { self._handleManualSync(); });
        this._bindClick("git-btn-remote-test", function () { self._handleRemoteTest(); });
        this._bindClick("git-btn-check-health", function () { self._handleCheckHealth(); });

        // ── 初始化仓库按钮（遮罩层中）──
        this._bindClick("git-btn-init-repo", function () { self._handleInitRepo(); });
    };

    Panel.prototype._bindClick = function (id, handler) {
        var self = this;
        safeBind(document.getElementById(id), "click", function () { handler.call(self); });
    };

    Panel.prototype._bindChange = function (id, handler) {
        var self = this;
        safeBind(document.getElementById(id), "change", function () { handler.call(self, this); });
    };

    function safeBind(el, event, handler) {
        if (el) el.addEventListener(event, handler);
    }

    /**
     * 根据仓库状态控制初始化遮罩显隐
     */
    Panel.prototype._updateInitOverlay = function (store) {
        if (!this._initOverlayEl) return;
        if (store && store.state.isDetected && !store.state.isRepo) {
            this._initOverlayEl.style.display = "";
        } else {
            this._initOverlayEl.style.display = "none";
        }
    };

    // ===================================================================
    // Tab 切换
    // ===================================================================

    Panel.prototype.switchTab = function (tabId) {
        this._activeTab = tabId;

        // 更新 tab 按钮样式
        var tabs = this._panelEl ? this._panelEl.querySelectorAll(".git-popup-tab") : [];
        for (var i = 0; i < tabs.length; i++) {
            var t = tabs[i];
            if (t.getAttribute("data-tab") === tabId) {
                t.classList.add("active");
            } else {
                t.classList.remove("active");
            }
        }

        // 切换内容
        var contents = this._contentEl ? this._contentEl.querySelectorAll(".git-panel-tab-content") : [];
        for (var j = 0; j < contents.length; j++) {
            contents[j].classList.remove("active");
        }

        var target = document.getElementById("git-tab-" + tabId);
        if (target) {
            this._contentEl.scrollTop = 0;
            target.classList.add("active");
        }

        // 刷新 Tab 内容
        if (tabId === "status") this.refreshStatus();
        if (tabId === "history") this.refreshHistory();
        if (tabId === "branches") this.refreshBranches();
        if (tabId === "settings") this.refreshSettings();

        // 确保遮罩状态正确
        if (this._store) this._updateInitOverlay(this._store);
    };

    /**
     * Open popup panel — fade in + scale, with click-away catcher.
     */
    Panel.prototype.open = function () {
        if (!this._clickCatcherEl || !this._panelEl) return;

        this._syncThemeFontsIfNeeded();
        this._clickCatcherEl.style.display = "block";
        this._panelEl.style.animation = "git-popup-in 0.22s var(--git-transition-ease, cubic-bezier(0.16, 1, 0.3, 1)) both";
        this._open = true;

        // Notify sidebar to stay hidden
        try {
            var tb = require(path.join(PLUGIN_DIR, "toolbar.js"));
            if (tb && typeof tb.setPanelOpen === "function") tb.setPanelOpen(true);
        } catch (e) {}

        this.switchTab(this._activeTab);
    };

    Panel.prototype.close = function () {
        if (!this._clickCatcherEl || !this._panelEl || !this._open) return;

        this._panelEl.style.animation = "git-popup-out 0.16s ease-in forwards";

        var self = this;
        setTimeout(function () {
            if (self._clickCatcherEl) self._clickCatcherEl.style.display = "none";
            self._open = false;
        }, 150);

        // Notify sidebar panel is closed
        try {
            var tb = require(path.join(PLUGIN_DIR, "toolbar.js"));
            if (tb && typeof tb.setPanelOpen === "function") tb.setPanelOpen(false);
        } catch (e) {}
    };

    Panel.prototype._syncThemeFontsIfNeeded = function () {
        // Called each time panel opens to ensure fonts match current theme.
        // The heavy work is done by main.js syncThemeFonts via MutationObserver.
        // This is a lightweight re-check.
        try {
            var rootStyle = getComputedStyle(document.documentElement);
            var sansFont = rootStyle.getPropertyValue('--git-font-sans').trim();
            var monoFont = rootStyle.getPropertyValue('--git-font-mono').trim();
            if (sansFont) document.documentElement.style.setProperty('--git-font-sans', sansFont);
            if (monoFont) document.documentElement.style.setProperty('--git-font-mono', monoFont);
        } catch (e) {}
    };

    Panel.prototype.toggle = function () {
        if (this._open) this.close(); else this.open();
    };

    Panel.prototype.isOpen = function () {
        return this._open;
    };

    // ===================================================================
    // 设置状态文字
    // ===================================================================

    Panel.prototype.setStatus = function (text, isLoading) {
        if (this._statusTextEl) this._statusTextEl.textContent = text || "就绪";
        if (this._spinnerEl) this._spinnerEl.style.display = isLoading ? "inline-block" : "none";
    };

    // ===================================================================
    // 聚焦提交消息
    // ===================================================================

    Panel.prototype.focusCommitMessage = function () {
        var self = this;
        setTimeout(function () {
            var textarea = document.getElementById("git-commit-msg");
            if (textarea) textarea.focus();
        }, 300);
    };

    // ===================================================================
    // 刷新状态 Tab
    // ===================================================================

    Panel.prototype.refreshStatus = function () {
        if (this._activeTab !== "status") return;
        var store = this._store;
        if (!store) return;

        // 更新初始化遮罩
        this._updateInitOverlay(store);

        // 仓库信息
        var branchLabel = document.getElementById("git-branch-label");
        if (branchLabel) branchLabel.textContent = "⎇ " + (store.state.branch || "未知");

        var remoteInfo = document.getElementById("git-remote-info");
        if (remoteInfo && store.state.remotes.length > 0) {
            var r = store.state.remotes[0];
            remoteInfo.textContent = r.name + ": " + r.url;
            remoteInfo.style.display = "";
        } else if (remoteInfo) {
            remoteInfo.style.display = "none";
        }

        var aheadBehind = document.getElementById("git-ahead-behind");
        if (aheadBehind) {
            var parts = [];
            if (store.state.aheadCount > 0) parts.push("+" + store.state.aheadCount);
            if (store.state.behindCount > 0) parts.push("-" + store.state.behindCount);
            aheadBehind.textContent = parts.length > 0 ? parts.join(" / ") : "与远程同步";
        }

        // 文件列表
        this._renderFileList();

        // 非仓库提示
        var hint = document.getElementById("git-no-repo-hint");
        if (hint) {
            if (!store.state.isRepo && store.state.isDetected) {
                hint.style.display = "block";
            } else if (store.state.isRepo) {
                hint.style.display = "none";
            }
        }
    };

    Panel.prototype._renderFileList = function () {
        var listEl = document.getElementById("git-file-list");
        var noChangesEl = document.getElementById("git-no-changes");
        if (!listEl) return;

        var files = this._store ? this._store.state.files : [];
        var hasChanges = false;

        var html = "";
        var filePaths = [];  // 用索引避免 data-file 的 HTML 编码问题
        for (var i = 0; i < files.length; i++) {
            var f = files[i];
            if (f.status === "!") continue; // 跳过 ignored
            hasChanges = true;

            var statusLabel = this._statusLabel(f.status);
            var statusColor = this._statusColor(f.status);
            var fileName = f.path || "";
            // 只显示文件名，不显示完整路径
            var displayName = fileName;
            var lastSlash = Math.max(fileName.lastIndexOf("/"), fileName.lastIndexOf("\\"));
            if (lastSlash >= 0) {
                var dir = fileName.substring(0, lastSlash);
                displayName = "<span style='opacity:0.6;'>" + escapeHtml(dir) + "/</span>" + escapeHtml(fileName.substring(lastSlash + 1));
            } else {
                displayName = escapeHtml(displayName);
            }

            filePaths.push(fileName);
            html += "<div class='git-file-item' data-file-idx='" + i + "' " +
                "style='display:flex;align-items:center;gap:8px;padding:6px 8px;margin:2px 0;" +
                "border-radius:4px;cursor:pointer;transition:background 0.15s;font-size:12px;'>" +
                "<span class='git-file-status' style='min-width:20px;font-weight:600;color:" + statusColor + ";'>" + statusLabel + "</span>" +
                "<span class='git-file-name' style='flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;'>" + displayName + "</span>" +
                "<span class='git-file-action' style='font-size:11px;opacity:0;transition:opacity 0.15s;color:var(--active-file-text-color,#4a90d9);'>查看 Diff</span>" +
                "</div>";
        }

        listEl.innerHTML = html;

        if (noChangesEl) {
            noChangesEl.style.display = hasChanges ? "none" : "block";
        }

        // 点击文件行 → 显示 Diff
        var self = this;
        var items = listEl.querySelectorAll(".git-file-item");
        for (var j = 0; j < items.length; j++) {
            (function (idx) {
                items[j].addEventListener("click", function () {
                    var file = filePaths[idx];
                    self._showInlineDiff(file);
                });
                // hover 显示 "查看 Diff"
                items[j].addEventListener("mouseenter", function () {
                    var action = this.querySelector(".git-file-action");
                    if (action) action.style.opacity = "1";
                });
                items[j].addEventListener("mouseleave", function () {
                    var action = this.querySelector(".git-file-action");
                    if (action) action.style.opacity = "0";
                });
            })(j);
        }
    };

    Panel.prototype._showInlineDiff = function (filePath) {
        var self = this;
        var diffEl = document.getElementById("git-inline-diff");
        if (!diffEl) return;
        diffEl.style.display = "block";
        diffEl.innerHTML = "<div style='padding:10px;text-align:center;color:var(--text-color,#888);'>加载中...</div>";

        this.setStatus("正在获取 Diff...", true);

        this._git.diff(this._store.state.repoPath, null, null, filePath).then(function (result) {
            self.setStatus("就绪", false);
            if (result.success) {
                var mode = self._api.getSetting("diffViewMode", "unified");
                var html = mode === "side-by-side"
                    ? self._diff.renderSideBySide(result.output)
                    : self._diff.renderUnified(result.output);
                diffEl.innerHTML =
                    "<div style='margin-bottom:6px;font-size:12px;font-weight:600;color:var(--heading-text-color,var(--text-color,#333));'>" +
                        escapeHtml(filePath) +
                        " <button style='margin-left:8px;padding:2px 8px;border-radius:3px;border:1px solid var(--window-border,#ddd);" +
                        "background:var(--bg-color,#fff);color:var(--text-color,#555);cursor:pointer;font-size:11px;' " +
                        "onclick='document.getElementById(\"git-inline-diff\").style.display=\"none\"'>关闭</button>" +
                    "</div>" +
                    "<div style='max-height:400px;overflow-y:auto;'>" + html + "</div>";
            } else {
                diffEl.innerHTML = "<div style='padding:10px;color:#e05555;font-size:12px;'>Diff 失败: " +
                    escapeHtml(result.error || "未知错误") + "</div>";
            }
        });
    };

    // ===================================================================
    // 刷新历史 Tab
    // ===================================================================

    Panel.prototype.refreshHistory = function () {
        if (this._activeTab !== "history") return;

        this._renderCommitList();
        this._updateFileFilter();
    };

    Panel.prototype._renderCommitList = function (filterText) {
        var listEl = document.getElementById("git-commit-list");
        var noCommitsEl = document.getElementById("git-no-commits");
        if (!listEl) return;

        var commits = this._store ? this._store.state.commits : [];
        var html = "";

        for (var i = 0; i < commits.length; i++) {
            var c = commits[i];
            if (filterText) {
                var searchIn = c.message + " " + c.author + " " + c.hash;
                if (searchIn.toLowerCase().indexOf(filterText.toLowerCase()) < 0) continue;
            }

            var hashShort = c.hash ? c.hash.substring(0, 7) : "";
            var refs = "";
            if (c.refs && c.refs !== "|") {
                var refList = c.refs.replace(/[()]/g, "").split(",");
                for (var r = 0; r < refList.length; r++) {
                    var ref = refList[r].trim();
                    if (ref) {
                        refs += "<span style='display:inline-block;margin-left:4px;padding:1px 4px;border-radius:3px;" +
                            "font-size:10px;background:var(--window-border,rgba(0,0,0,0.05));color:var(--text-color,#666);'>" +
                            escapeHtml(ref) + "</span>";
                    }
                }
            }

            html += "<div class='git-commit-item' data-hash='" + escapeHtml(c.hash || "") + "' " +
                "style='display:flex;flex-direction:column;gap:2px;padding:8px 10px;margin:2px 0;" +
                "border-radius:4px;cursor:pointer;transition:background 0.15s;border-left:3px solid transparent;'>" +
                "<div style='display:flex;align-items:center;gap:8px;'>" +
                    "<span class='git-commit-hash'>" + hashShort + "</span>" +
                    "<span class='git-commit-message' style='flex:1;font-size:13px;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;'>" + escapeHtml(c.message) + "</span>" +
                    refs +
                "</div>" +
                "<div style='display:flex;gap:12px;font-size:11px;color:var(--text-color,#888);'>" +
                    "<span>" + escapeHtml(c.author) + "</span>" +
                    "<span>" + escapeHtml(c.date) + "</span>" +
                "</div>" +
                "</div>";
        }

        listEl.innerHTML = html || "";

        if (noCommitsEl) {
            noCommitsEl.style.display = commits.length === 0 ? "block" : "none";
        }

        // 绑定点击 → 展开 Diff
        var self = this;
        var items = listEl.querySelectorAll(".git-commit-item");
        for (var j = 0; j < items.length; j++) {
            items[j].addEventListener("click", function () {
                var hash = this.getAttribute("data-hash");
                // 高亮选中（CSS class .git-commit-item.selected）
                var allItems = listEl.querySelectorAll(".git-commit-item");
                for (var k = 0; k < allItems.length; k++) {
                    allItems[k].classList.remove("selected");
                }
                this.classList.add("selected");
                self._showCommitDiff(hash);
            });
        }
    };

    Panel.prototype._showCommitDiff = function (hash) {
        var self = this;
        var diffEl = document.getElementById("git-history-diff");
        if (!diffEl) return;

        var wasOpen = diffEl.classList.contains("expanded");

        if (wasOpen) {
            diffEl.style.minHeight = diffEl.scrollHeight + "px";
            var bodyEl = diffEl.querySelector(".git-diff-body");
            if (bodyEl) {
                bodyEl.classList.add("git-diff-switching");
            }
        } else {
            diffEl.style.display = "";
            diffEl.innerHTML = "<div class='git-diff-body'></div>";
            diffEl.classList.add("expanded");
        }

        this.setStatus("获取提交详情...", true);

        this._git.show(this._store.state.repoPath, hash).then(function (result) {
            self.setStatus("就绪", false);
            var bodyEl = diffEl.querySelector(".git-diff-body");
            if (!bodyEl) return;

            if (result.success) {
                var mode = self._api.getSetting("diffViewMode", "unified");
                var html = mode === "side-by-side"
                    ? self._diff.renderSideBySide(result.output)
                    : self._diff.renderUnified(result.output);

                var headerHtml =
                    "<div style='display:flex;align-items:center;margin-bottom:6px;'>" +
                        "<span style='font-size:12px;font-weight:600;color:var(--heading-text-color,var(--text-color,#333));'>" +
                            "提交 " + hash.substring(0, 7) +
                        "</span>" +
                        "<span style='flex:1'></span>";

                if (self._revision) {
                    headerHtml +=
                        "<button class='git-rev-open-btn' style='margin-right:6px;padding:4px 10px;border-radius:5px;" +
                        "border:1px solid var(--active-file-text-color,#5b7f95);" +
                        "background:var(--bg-color,#fff);color:var(--active-file-text-color,#5b7f95);" +
                        "cursor:pointer;font-size:11.5px;font-weight:500;transition:background 0.15s;'" +
                        "onmouseover='this.style.background=\"var(--active-file-text-color, #5b7f95)\";" +
                        "this.style.color=\"#fff\"'" +
                        "onmouseout='this.style.background=\"var(--bg-color, #fff)\";" +
                        "this.style.color=\"var(--active-file-text-color, #5b7f95)\"'" +
                        ">📜 修订视图</button>";
                }

                headerHtml +=
                        "<button style='padding:2px 8px;border-radius:3px;border:1px solid var(--window-border,#ddd);" +
                        "background:var(--bg-color,#fff);color:var(--text-color,#555);cursor:pointer;font-size:11px;' " +
                        "onclick='document.getElementById(\"git-history-diff\").classList.remove(\"expanded\")'>× 关闭</button>" +
                    "</div>";

                bodyEl.innerHTML = headerHtml +
                    "<div style='max-height:400px;overflow-y:auto;'>" + html + "</div>";
                void bodyEl.offsetWidth;
                bodyEl.classList.remove("git-diff-switching");
                diffEl.style.minHeight = "";

                var revBtn = diffEl.querySelector(".git-rev-open-btn");
                if (revBtn && self._revision) {
                    revBtn.addEventListener("click", function () {
                        var path = self._store.state.currentFilePath;
                        if (path) {
                            self._revision.open(hash, path);
                        } else {
                            window.BetterTypora.toast("无法确定当前文件路径", 2000);
                        }
                    });
                }
            } else {
                bodyEl.innerHTML = "<div style='padding:10px;color:#e05555;font-size:12px;'>获取 Diff 失败: " +
                    escapeHtml(result.error || "未知错误") + "</div>";
                void bodyEl.offsetWidth;
                bodyEl.classList.remove("git-diff-switching");
                diffEl.style.minHeight = "";
            }
        });
    };

    Panel.prototype._filterCommits = function () {
        var filterInput = document.getElementById("git-filter-commits");
        this._renderCommitList(
            filterInput ? filterInput.value : ""
        );
    };

    Panel.prototype._loadMoreHistory = function () {
        if (!this._store || !this._store.state.isRepo) return;
        var maxCount = this._api.getSetting("maxHistoryCount", 50);
        var newMax = maxCount + 50;
        this._api.setSetting("maxHistoryCount", newMax);

        var self = this;
        this.setStatus("加载更多...", true);
        this._store.refreshHistory(newMax).then(function () {
            self.setStatus("就绪", false);
            self._renderCommitList();
            var btn = document.getElementById("git-btn-load-more");
            if (btn) btn.style.display = "block";
        });
    };

    Panel.prototype._updateFileFilter = function () {
        var files = this._store ? this._store.state.files : [];
        var select = document.getElementById("git-filter-file");
        if (!select) return;

        // 保留第一个 option "所有文件"
        while (select.options.length > 1) {
            select.remove(1);
        }

        for (var i = 0; i < files.length; i++) {
            var f = files[i];
            if (f.status === "!") continue;
            var opt = document.createElement("option");
            opt.value = f.path;
            opt.textContent = f.path;
            select.appendChild(opt);
        }
    };

    /**
     * 显示当前文件的 Diff（快捷键触发）
     */
    Panel.prototype.showCurrentFileDiff = function () {
        if (!this._store || !this._store.state.currentFilePath) {
            window.BetterTypora.toast("未找到当前文件", 2000);
            return;
        }
        this.switchTab("history");

        var self = this;
        var currentFile = this._store.state.currentFilePath;

        // 显示当前文件最近的提交历史
        this.setStatus("获取文件历史...", true);
        var relFile = this._store._relativePath ? this._store._relativePath(currentFile) : currentFile;
        this._git.log(this._store.state.repoPath, 20, relFile).then(function (result) {
            self.setStatus("就绪", false);
            if (result.success && result.commits) {
                // 同步更新 store，保持数据一致性
                self._store.state.commits = result.commits;
                if (self._store.state.commits.length > 0) {
                    self._store.state.lastCommitHash = self._store.state.commits[0].hash;
                }
                self._store.state.lastUpdate = Date.now();
                if (self._store._callbacks && self._store._callbacks.onHistoryChanged) {
                    self._store._callbacks.onHistoryChanged(self._store.state.commits);
                }
                self._renderCommitList();
            }
        });
    };

    // ===================================================================
    // 刷新分支 Tab
    // ===================================================================

    Panel.prototype.refreshBranches = function () {
        if (this._activeTab !== "branches") return;
        var store = this._store;
        if (!store || !store.state.isRepo) return;

        var currentName = document.getElementById("git-branch-current-name");
        if (currentName) currentName.textContent = store.state.branch || "—";

        var self = this;
        this.setStatus("获取分支列表...", true);

        // Load branch list + commit log (for graph)
        Promise.all([
            this._git.branchList(store.state.repoPath),
            this._git.log(store.state.repoPath, 50)
        ]).then(function (results) {
            self.setStatus("就绪", false);

            var branchResult = results[0];
            var logResult = results[1];

            // ── Branch list ──
            var listEl = document.getElementById("git-branch-list");
            var noBranchesEl = document.getElementById("git-no-branches");

            if (branchResult.success && branchResult.branches && branchResult.branches.length > 0) {
                if (noBranchesEl) noBranchesEl.style.display = "none";
                var html = "";
                for (var i = 0; i < branchResult.branches.length; i++) {
                    var b = branchResult.branches[i];
                    var icon = b.current ? "● " : (b.remote ? "☁ " : "○ ");
                    var style = b.current
                        ? "font-weight:600;color:var(--active-file-text-color,#4a90d9);"
                        : "color:var(--text-color,#555);";
                    var remoteLabel = b.remote ? " <span style='font-size:10px;opacity:0.6;'>remote</span>" : "";

                    html += "<div class='git-branch-item' data-branch='" + escapeHtml(b.name) + "' " +
                        "style='display:flex;align-items:center;gap:8px;padding:7px 10px;margin:2px 0;border-radius:4px;" +
                        "cursor:pointer;transition:background 0.15s;" + style + "'>" +
                        "<span>" + icon + escapeHtml(b.name) + "</span>" +
                        remoteLabel +
                        (b.current ? "<span style='flex:1;text-align:right;font-size:10px;opacity:0.6;'>当前</span>" : "") +
                        "</div>";
                }
                if (listEl) listEl.innerHTML = html;

                // Update merge select
                self._updateMergeSelect(branchResult.branches);

                // Bind branch click → switch
                if (listEl) {
                    var items = listEl.querySelectorAll(".git-branch-item");
                    for (var j = 0; j < items.length; j++) {
                        (function (item) {
                            item.addEventListener("click", function () {
                                var branchName = item.getAttribute("data-branch");
                                if (!branchName) return;
                                if (store.getChangeCount() > 0) {
                                    if (!confirm("有未提交的改动，切换分支可能会丢失改动。\n\n确定切换到 " + branchName + " 吗？")) return;
                                }
                                self.setStatus("切换到 " + branchName + "...", true);
                                self._git.branchSwitch(store.state.repoPath, branchName).then(function (switchResult) {
                                    if (switchResult.success) {
                                        self._api.emit("git-sync:branch-changed", { oldBranch: store.state.branch, newBranch: branchName });
                                        store.refreshAll().then(function () {
                                            self.setStatus("已切换到 " + branchName, false);
                                            self.refreshBranches(); self.refreshStatus(); self.refreshHistory();
                                            var evt = new CustomEvent("git-sync:status-changed");
                                            document.dispatchEvent(evt);
                                        });
                                    } else {
                                        self.setStatus("切换失败: " + (switchResult.error || ""), false);
                                        window.BetterTypora.toast("分支切换失败: " + (switchResult.error || "").substring(0, 60), 3000);
                                    }
                                });
                            });
                        })(items[j]);
                    }
                }
            } else {
                if (noBranchesEl) noBranchesEl.style.display = "block";
                if (listEl) listEl.innerHTML = "";
            }

            // ── Branch graph (below the branch list) ──
            var graphContainer = document.getElementById("git-branch-graph");
            if (graphContainer && logResult.success && logResult.commits && logResult.commits.length > 0) {
                try {
                    var branchViz = require("./branch-viz.js");
                    if (branchViz && typeof branchViz.render === "function") {
                        branchViz.render(graphContainer, logResult.commits, branchResult.branches || [], function (hash) {
                            // When a graph node is clicked, show commit diff
                            if (self._revision) {
                                var path = store.state.currentFilePath;
                                if (path) self._revision.open(hash, path);
                            }
                        });
                    }
                } catch (e) { console.error("[git-sync] branch-viz load failed:", e.message); }
            }
        });
    };

    Panel.prototype._updateMergeSelect = function (branches) {
        var select = document.getElementById("git-merge-source-select");
        if (!select) return;

        while (select.options.length > 0) select.remove(0);

        for (var i = 0; i < branches.length; i++) {
            var b = branches[i];
            if (b.current || b.remote) continue;
            var opt = document.createElement("option");
            opt.value = b.name;
            opt.textContent = b.name;
            select.appendChild(opt);
        }
    };

    Panel.prototype._handleCreateBranch = function () {
        var store = this._store;
        if (!store || !store.state.isRepo) return;

        var input = document.getElementById("git-branch-new-name");
        var name = input ? input.value.trim() : "";
        if (!name) {
            window.BetterTypora.toast("请输入分支名", 1500);
            return;
        }

        var self = this;
        this.setStatus("创建分支 " + name + "...", true);
        this._git.branchCreateAndSwitch(store.state.repoPath, name).then(function (result) {
            if (result.success) {
                window.BetterTypora.toast("已创建并切换到 " + name, 2000);
                self._api.emit("git-sync:branch-changed", { oldBranch: store.state.branch, newBranch: name });
                store.refreshAll().then(function () {
                    self.setStatus("已切换到 " + name, false);
                    self.refreshBranches();
                    self.refreshStatus();
                });
                if (input) input.value = "";
            } else {
                self.setStatus("创建失败", false);
                window.BetterTypora.toast("创建分支失败: " + (result.error || "").substring(0, 60), 3000);
            }
        });
    };

    Panel.prototype._handleMerge = function () {
        var store = this._store;
        if (!store || !store.state.isRepo) return;

        var select = document.getElementById("git-merge-source-select");
        var sourceBranch = select ? select.value : "";
        if (!sourceBranch) {
            window.BetterTypora.toast("请选择要合并的分支", 1500);
            return;
        }

        if (!confirm("确定将 " + sourceBranch + " 合并到 " + store.state.branch + " 吗？")) return;

        var self = this;
        this.setStatus("合并 " + sourceBranch + "...", true);
        this._git.branchMerge(store.state.repoPath, sourceBranch).then(function (result) {
            if (result.success) {
                window.BetterTypora.toast("合并成功", 2000);
                store.refreshAll().then(function () {
                    self.setStatus("合并完成", false);
                    self.refreshBranches();
                    self.refreshStatus();
                    self.refreshHistory();
                });
            } else {
                self.setStatus("合并失败", false);
                var errMsg = result.error || "";
                if (errMsg.indexOf("CONFLICT") >= 0) {
                    window.BetterTypora.toast("合并冲突！请手动解决冲突后提交", 4000);
                } else {
                    window.BetterTypora.toast("合并失败: " + errMsg.substring(0, 60), 3000);
                }
            }
        });
    };

    // ===================================================================
    // 刷新设置 Tab
    // ===================================================================

    Panel.prototype.refreshSettings = function () {
        if (this._activeTab !== "settings") return;

        var self = this;
        var store = this._store;

        // 动态更新仓库状态（初渲染时 store 可能尚未完成检测）
        var statusEl = document.getElementById("git-setting-repo-status");
        if (statusEl && store) {
            if (store.state.isRepo) {
                statusEl.textContent = "已就绪";
                statusEl.style.color = "#2ea043";
            } else if (store.state.isDetected && !store.state.isRepo) {
                statusEl.textContent = "未检测到仓库";
                statusEl.style.color = "#e05555";
            } else {
                statusEl.textContent = "检测中...";
                statusEl.style.color = "#e09146";
            }
        }

        var branchEl = document.getElementById("git-setting-branch");
        if (branchEl && store) {
            branchEl.textContent = store.state.branch || "-";
        }

        var lockEl = document.getElementById("git-setting-lock-info");
        if (lockEl && store) {
            lockEl.textContent = "未锁定";
            lockEl.style.color = "#888";
        }

        // 更新初始化遮罩
        self._updateInitOverlay(store);

        var hint = document.getElementById("git-no-repo-hint");
        if (hint && store) {
            if (!store.state.isRepo && store.state.isDetected) {
                hint.style.display = "block";
            } else {
                hint.style.display = "none";
            }
        }
    };

    // ===================================================================
    // v2.0: 设置 Tab 操作处理
    // ===================================================================

    Panel.prototype._handleInitRepo = function () {
        var store = this._store;
        if (!store || !store.state.repoPath) {
            window.BetterTypora.toast("仓库路径未就绪", 2000);
            return;
        }

        var btn = document.getElementById("git-btn-init-repo");
        if (btn) { btn.disabled = true; btn.textContent = "初始化中..."; }

        var self = this;
        this.setStatus("初始化仓库...", true);

        this._sync.initRepo(store.state.repoPath, this._git).then(function (result) {
            self.setStatus("就绪", false);
            if (result.success) {
                store.setRepo(store.state.repoPath);
                if (!result.existed) {
                    window.BetterTypora.toast("仓库初始化成功", 2000);
                }
                // 如果已配置远程，拉取
                var remoteUrl = self._api.getSetting("remoteURL", "");
                var remoteName = self._api.getSetting("remoteName", "origin");
                var remoteEnabled = self._api.getSetting("remoteEnabled", false);
                var remotePromise = Promise.resolve();
                if (remoteEnabled && remoteUrl) {
                    var currentBranch = store.state.branch || "main";
                    remotePromise = self._sync.configureRemote(store.state.repoPath, remoteUrl, remoteName, self._git).then(function () {
                        return self._sync.pullBeforeWork(store.state.repoPath, remoteName, self._git, currentBranch);
                    });
                }
                return remotePromise.then(function () {
                    return store.refreshAll().then(function () {
                        self._api.emit("git-sync:status-changed", store.state);
                        self.refreshSettings();
                        self.refreshStatus();
                        // 通知 main.js 初始化完成，触发待处理操作
                        try { self._api.emit("git-sync:repo-initialized"); } catch (e) {}
                    });
                });
            } else {
                if (btn) { btn.disabled = false; btn.textContent = "初始化仓库"; }
                window.BetterTypora.toast(
                    "初始化失败: " + (result.error || "未知错误").substring(0, 60), 3000
                );
            }
        }).catch(function (err) {
            self.setStatus("就绪", false);
            if (btn) { btn.disabled = false; btn.textContent = "初始化仓库"; }
            window.BetterTypora.toast("初始化异常: " + (err.message || ""), 3000);
        });
    };

    Panel.prototype._handleManualSync = function () {
        if (!this._sync) {
            window.BetterTypora.toast("同步引擎未加载", 3000);
            return;
        }
        window.BetterTypora.commands.execute("git-sync:manual-sync");
    };

    Panel.prototype._handleRemoteTest = function () {
        var store = this._store;
        if (!store || !store.state.repoPath || !store.state.isRepo) {
            window.BetterTypora.toast("仓库未就绪", 2000);
            return;
        }
        var remoteUrl = this._api.getSetting("remoteURL", "");
        if (!remoteUrl) {
            window.BetterTypora.toast("请先填写远程仓库地址", 2000);
            return;
        }
        var remoteName = this._api.getSetting("remoteName", "origin");
        var self = this;
        self.setStatus("配置远程...", true);
        this._sync.configureRemote(store.state.repoPath, remoteUrl, remoteName, this._git).then(function () {
            self.setStatus("测试连接...", true);
            return self._sync.checkRemoteConnectivity(store.state.repoPath, remoteName, self._git);
        }).then(function (result) {
            self.setStatus("", false);
            if (result.reachable) {
                window.BetterTypora.toast("远程仓库连接成功 ✓", 2500);
            } else {
                var guidance = result.errorGuidance || result.errorDetail || "连接失败";
                window.BetterTypora.toast(guidance, 5000);
            }
        }).catch(function (err) {
            self.setStatus("", false);
            window.BetterTypora.toast("配置失败: " + ((err.message || "").substring(0, 60)), 3000);
        });
    };

    Panel.prototype._handleCheckHealth = function () {
        var store = this._store;
        if (!store || !store.state.repoPath || !store.state.isRepo) {
            window.BetterTypora.toast("仓库未就绪", 2000);
            return;
        }
        var self = this;
        self.setStatus("检查仓库...", true);
        this._sync.checkRepoHealth(store.state.repoPath, this._git).then(function (result) {
            self.setStatus("", false);
            if (result.healthy) {
                window.BetterTypora.toast("仓库状态正常 ✓", 2000);
            } else {
                window.BetterTypora.toast("仓库异常: " + (result.error || "未知"), 3000);
            }
        });
    };

    // ===================================================================
    // 提交处理
    // ===================================================================

    Panel.prototype._handleCommit = function () {
        var self = this;
        this._doCommit(false);
    };

    Panel.prototype._handleCommitAndPush = function () {
        var self = this;
        this._doCommit(true);
    };

    Panel.prototype._handleStageAll = function () {
        var self = this;
        if (window.__gitSync_initRepoIfNeeded) {
            window.__gitSync_initRepoIfNeeded().then(function (ok) { if (!ok) return; _stageAll(); });
        } else { _stageAll(); }
        function _stageAll() {

        this.setStatus("暂存所有文件...", true);
        this._git.stage(this._store.state.repoPath).then(function (result) {
            if (result.success) {
                window.BetterTypora.toast("已暂存所有改动", 1500);
                self._store.refreshStatus().then(function () {
                    self.setStatus("就绪", false);
                    self.refreshStatus();
                });
            } else {
                self.setStatus("暂存失败", false);
                window.BetterTypora.toast("暂存失败: " + (result.error || "").substring(0, 60), 3000);
            }
        });
        } // end _stageAll
    };

    Panel.prototype._doCommit = function (andPush) {
        var self = this;
        if (window.__gitSync_initRepoIfNeeded) {
            window.__gitSync_initRepoIfNeeded().then(function (ok) { if (!ok) return; _doCommitBody(); });
        } else { _doCommitBody(); }
        function _doCommitBody() {

        var store = this._store;
        var message = textarea ? textarea.value.trim() : "";
        if (!message) {
            window.BetterTypora.toast("请输入提交信息", 1500);
            if (textarea) textarea.focus();
            return;
        }

        var self = this;
        this.setStatus("正在提交...", true);

        function finish(status) {
            self.setStatus(status, false);
            self.refreshStatus();
            self.refreshHistory();
        }

        function doStageAndCommit() {
            // 1. git add -A
            self._git.stage(store.state.repoPath).then(function (stageResult) {
                if (!stageResult.success) {
                    finish("暂存失败");
                    window.BetterTypora.toast("暂存失败: " + (stageResult.error || "").substring(0, 60), 3000);
                    return;
                }

                // 2. git commit
                return self._git.commit(store.state.repoPath, message).then(function (commitResult) {
                    if (commitResult.success) {
                        window.BetterTypora.toast("提交成功: " + (commitResult.hash || "").substring(0, 7), 2000);
                        self._api.emit("git-sync:commit-completed", {
                            hash: commitResult.hash,
                            message: message
                        });

                        if (textarea) textarea.value = "";

                        // 3. 如果 andPush，push 完成后统一 refresh+finish
                        if (andPush) {
                            var remote = self._api.getSetting("remoteName", "origin");
                            var branch = store.state.branch || "";
                            return self._git.push(store.state.repoPath, remote, branch).then(function (pushResult) {
                                if (pushResult.success) {
                                    window.BetterTypora.toast("提交并推送成功 ✓", 2000);
                                    return store.refreshAll().then(function () {
                                        finish("提交并推送完成");
                                    });
                                } else {
                                    window.BetterTypora.toast("提交成功，推送失败: " + (pushResult.error || "").substring(0, 60), 3000);
                                    return store.refreshAll().then(function () {
                                        finish("提交完成，推送失败");
                                    });
                                }
                            }).catch(function (err) {
                                finish("操作异常");
                                window.BetterTypora.toast("操作异常: " + (err.message || "未知错误"), 3000);
                            });
                        }

                        // 无 push：直接 refresh + finish
                        return store.refreshAll().then(function () {
                            finish("提交完成");
                        });
                    } else {
                        // 检测是否因 "nothing to commit" 导致失败
                        var errMsg = (commitResult.error || "").toLowerCase();
                        if (errMsg.indexOf("nothing to commit") >= 0 || errMsg.indexOf("nothing added") >= 0) {
                            finish("无变更");
                            window.BetterTypora.toast("文件没有变化，无需提交 ✓", 2000);
                        } else {
                            finish("提交失败");
                            window.BetterTypora.toast("提交失败: " + (commitResult.error || "").substring(0, 60), 3000);
                        }
                    }
                });
            });
        }

        // 0. 先触发 Typora 保存当前文件
        if (window.BetterTypora && window.BetterTypora.saveFile) {
            window.BetterTypora.saveFile();
        }

        // 等 Typora 写入磁盘后再 git add
        setTimeout(function () {
            // 检查工作区是否有变更
            self._git.hasUncommitted(store.state.repoPath).then(function (hu) {
                if (!hu.success || !hu.hasChanges) {
                    finish("无变更");
                    window.BetterTypora.toast("文件没有变化，无需提交", 2000);
                    return;
                }
                doStageAndCommit();
            });
        }, 400);
    } // end _doCommitBody
    };

    // ===================================================================
    // 主题样式
    // ===================================================================

    Panel.prototype._updateThemeStyles = function () {
        if (!this._panelEl) return;

        // 用 Typora 主题 --bg-color 亮度判断暗/亮，而非 OS matchMedia
        var isDark = false;
        try {
            var bg = getComputedStyle(document.documentElement).getPropertyValue("--bg-color").trim();
            if (bg) isDark = _parseLuminance(bg) < 0.5;
        } catch (e) {}
        var bg = "var(--bg-color, " + (isDark ? "#1e1e1e" : "#fff") + ")";
        this._panelEl.style.background = bg;

        // 按钮主色
        var btns = this._panelEl.querySelectorAll(".git-btn-primary");
        for (var i = 0; i < btns.length; i++) {
            btns[i].style.background = "var(--active-file-text-color, #4a90d9)";
            btns[i].style.color = "#fff";
        }
    };


    // ===================================================================
    // UI 辅助
    // ===================================================================

    Panel.prototype._statusLabel = function (status) {
        var map = {
            "M": "M", " M": "M", "MM": "MM",
            "A": "A", " A": "A",
            "D": "D", " D": "D",
            "R": "R", " R": "R",
            "??": "?", "!": "!", "": ""
        };
        return map[status] || status;
    };

    Panel.prototype._statusColor = function (status) {
        if (!status) return "var(--text-color,#888)";
        if (status.indexOf("M") >= 0) return "#e09146";  // orange
        if (status.indexOf("A") >= 0) return "#2ea043";   // green
        if (status.indexOf("D") >= 0) return "#f85149";   // red
        if (status.indexOf("R") >= 0) return "#4a90d9";   // blue
        if (status === "??") return "#8b949e";            // gray
        return "var(--text-color,#888)";
    };

    function _parseLuminance(color) {
        try {
            var r = 0, g = 0, b = 0;
            if (color.indexOf("rgb") === 0) {
                var m = color.match(/[\d.]+/g);
                if (m && m.length >= 3) { r = +m[0]; g = +m[1]; b = +m[2]; }
            } else if (color[0] === "#") {
                var h = color.substring(1);
                if (h.length === 3) h = h[0]+h[0]+h[1]+h[1]+h[2]+h[2];
                if (h.length >= 6) { r = parseInt(h.substring(0,2), 16); g = parseInt(h.substring(2,4), 16); b = parseInt(h.substring(4,6), 16); }
            }
            var lin = function (c) { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
            return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
        } catch (e) { return 0.5; }
    }

    // ===================================================================
    // 主题样式初始化
    // ===================================================================

    // ===================================================================
    // 生命周期
    // ===================================================================

    Panel.prototype.checkDom = function () {
        if (!document.getElementById("git-popup-panel") && this._injected) {
            this._injected = false;
            this.inject();
        }
    };

    Panel.prototype.remove = function () {
        if (this._clickCatcherEl && this._clickCatcherEl.parentNode) {
            this._clickCatcherEl.parentNode.removeChild(this._clickCatcherEl);
        }
        this._clickCatcherEl = null;
        this._panelEl = null;
        this._contentEl = null;
        this._injected = false;
        this._open = false;
    };

    // ===================================================================
    // 导出
    // ===================================================================

    module.exports = Panel;

})();
