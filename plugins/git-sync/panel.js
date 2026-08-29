/* 轻量同步面板：把高频操作放在首屏，历史和差异作为只读信息展示。 */
(function () {
    "use strict";

    var path = reqnode("path");
    var icons = require("./icons");

    function Panel(store, engine, api, escapeHtml, timers) {
        this.store = store;
        this.engine = engine;
        this.api = api;
        this.escapeHtml = escapeHtml || function (v) { return String(v || ""); };
        this.timers = timers || null;
        this.el = null;
        this.backdrop = null;
        this.unsubscribe = null;
        this._click = null;
        this._closeTimer = null;
    }

    Panel.prototype.mount = function () {
        var self = this;
        this.backdrop = document.createElement("div");
        this.backdrop.className = "bt-git-backdrop";
        this.backdrop.hidden = true;
        this.backdrop.addEventListener("click", function (event) { if (event.target === self.backdrop) self.close(); });
        document.body.appendChild(this.backdrop);

        this.el = document.createElement("section");
        this.el.className = "bt-git-panel";
        this.el.hidden = true;
        this._click = function (event) { self.handleClick(event); };
        this.el.addEventListener("click", this._click);
        document.body.appendChild(this.el);
        this.unsubscribe = this.store.subscribe(function (state) { self.render(state); });
    };

    Panel.prototype.toggle = function () {
        if (!this.el) this.mount();
        if (this.el.hidden) this.open(); else this.close();
    };

    Panel.prototype.open = function () {
        var self = this;
        if (!this.el) this.mount();
        if (this._closeTimer && this.timers) this.timers.clearTimeout(this._closeTimer);
        this._closeTimer = null;
        this.el.hidden = false;
        this.backdrop.hidden = false;
        this.el.classList.remove("is-open");
        this.backdrop.classList.add("is-visible");
        // 强制一次轻量布局，让从 display:none 恢复时也能稳定触发滑入过渡。
        this.el.offsetWidth;
        this.el.classList.add("is-open");
        this.engine.refresh().then(function () { if (self.el && !self.el.hidden) self.engine.loadHistory(); });
    };

    Panel.prototype.close = function () {
        if (!this.el) return;
        this.el.classList.remove("is-open");
        this.backdrop.classList.remove("is-visible");
        var self = this;
        if (this._closeTimer && this.timers) this.timers.clearTimeout(this._closeTimer);
        if (this.timers) {
            this._closeTimer = this.timers.setTimeout(function () {
                if (self.el && !self.el.classList.contains("is-open")) {
                    self.el.hidden = true;
                    self.backdrop.hidden = true;
                }
                self._closeTimer = null;
            }, 240);
        } else {
            this.el.hidden = true;
            this.backdrop.hidden = true;
        }
    };

    Panel.prototype.handleClick = function (event) {
        var self = this;
        var target = event.target;
        while (target && target !== this.el && !target.getAttribute("data-action") && !target.getAttribute("data-file")) target = target.parentNode;
        if (!target || target === this.el) return;
        var action = target.getAttribute("data-action");
        var file = target.getAttribute("data-file");
        var state = this.store.get();
        if (action === "history-commit") {
            this.engine.openSnapshotDetail(target.getAttribute("data-commit"));
            return;
        }
        if (action === "history-back") {
            this.engine.closeSnapshotDetail();
            return;
        }
        if (action === "snapshot-compare-mode") {
            this.engine.setSnapshotCompareMode(target.getAttribute("data-mode"));
            return;
        }
        if (action === "snapshot-diff-file") {
            this.engine.openSnapshotDiff(target.getAttribute("data-commit"), file).then(function (result) {
                if (result && result.success) self.close();
            });
            return;
        }
        if (action === "diff-file") {
            this.engine.openDiff(file).then(function (result) {
                if (result && result.success) self.close();
            });
            return;
        }
        if (file && state.root) {
            if (this.api.openFile) this.api.openFile(path.join(state.root, file));
            return;
        }
        if (action === "close") this.close();
        else if (action === "init") this.engine.showSetup("choose");
        else if (action === "setup-back") this.engine.showSetup("back");
        else if (action === "setup-local") this.engine.showSetup("local");
        else if (action === "setup-unified") this.engine.showSetup("unified");
        else if (action === "setup-scope") this.engine.showSetup("scope");
        else if (action === "remote-setup") this.engine.showSetup("remote");
        else if (action === "initialize-local") this.engine.initLocal(this._inputValue("local-root"));
        else if (action === "initialize-unified") this.engine.initUnified(this._inputValue("unified-root"), this._inputValue("unified-scope"), this._inputValue("unified-remote"));
        else if (action === "save-remote") this.engine.configureRemote(this._inputValue("unified-remote"));
        else if (action === "ssh-key-helper") this.engine.prepareSshKey();
        else if (action === "copy-ssh-key") this.engine.copySshPublicKey();
        else if (action === "refresh") this.engine.refresh();
        else if (action === "snapshot") this.engine.saveSnapshot().then(function () { self.engine.loadHistory(); });
        else if (action === "sync") this.engine.sync().then(function () { self.engine.loadHistory(); });
        else if (action === "fetch") this.engine.fetch();
        else if (action === "diff") this.engine.openDiff().then(function (result) {
            if (result && result.success) self.close();
        });
        else if (action === "history") this.engine.loadHistory();
    };

    Panel.prototype._inputValue = function (name) {
        if (!this.el) return "";
        var input = this.el.querySelector('[data-input="' + name + '"]');
        return input ? input.value : "";
    };

    function getFileChange(code) {
        var value = String(code || "");
        if (value === "??") return { kind: "untracked", label: "未跟踪" };
        if (value.indexOf("U") >= 0) return { kind: "conflict", label: "存在冲突" };
        if (value.indexOf("R") >= 0 || value.indexOf("C") >= 0) return { kind: "renamed", label: "已重命名" };
        if (value.indexOf("D") >= 0) return { kind: "deleted", label: "已删除" };
        if (value.indexOf("A") >= 0) return { kind: "added", label: "已新增" };
        return { kind: "modified", label: "已修改" };
    }

    function splitFilePath(filePath) {
        var value = String(filePath || "").replace(/\\/g, "/");
        var index = value.lastIndexOf("/");
        return index < 0 ? { name: value, directory: "" } : { name: value.substring(index + 1), directory: value.substring(0, index) };
    }

    function formatSnapshotTime(value) {
        var date = new Date(value);
        if (isNaN(date.getTime())) return String(value || "");
        var now = new Date();
        var delta = now.getTime() - date.getTime();
        var clock = (date.getHours() < 10 ? "0" : "") + date.getHours() + ":" + (date.getMinutes() < 10 ? "0" : "") + date.getMinutes();
        if (delta >= 0 && delta < 60000) return "刚刚";
        if (delta >= 0 && delta < 3600000) return Math.max(1, Math.floor(delta / 60000)) + " 分钟前";
        if (date.toDateString() === now.toDateString()) return "今天 " + clock;
        var yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
        if (date.toDateString() === yesterday.toDateString()) return "昨天 " + clock;
        return (date.getMonth() + 1) + "月" + date.getDate() + "日 " + clock;
    }

    function renderSetup(state, escapeHtml) {
        var view = state.setupView || "choose";
        var root = escapeHtml(state.root || "");
        var scope = escapeHtml(state.scopePath || state.suggestedScope || "inbox");
        var html = '<section class="bt-git-setup">';
        if (view === "local") {
            html += '<div class="bt-git-setup-title">本地文件夹</div><p>在当前文件夹建立本地 Git 快照。它不会配置远程，也不会上传笔记。</p>';
            html += '<label>本地仓库目录<input data-input="local-root" value="' + root + '" placeholder="包含当前 Markdown 文件的文件夹"></label>';
            html += '<div class="bt-git-setup-actions"><button class="bt-git-secondary" data-action="setup-back">返回</button><button class="bt-git-primary" data-action="initialize-local">启用本地快照</button></div>';
        } else if (view === "unified" || view === "scope") {
            var scopeOnly = view === "scope";
            html += '<div class="bt-git-setup-title">' + (scopeOnly ? "加入统一笔记仓库" : "统一笔记仓库") + '</div>';
            html += '<p>' + (scopeOnly ? "为当前文件指定一个受管理的工作区。快照与历史只会处理这个目录。" : "将多个笔记工作区存进同一仓库，并按工作区分别保存快照与同步。") + '</p>';
            html += '<label>统一仓库目录<input data-input="unified-root" value="' + root + '" placeholder="例如 D:\\TyporaNotes"></label>';
            html += '<label>当前工作区目录<input data-input="unified-scope" value="' + scope + '" placeholder="例如 projects / daily"></label>';
            if (!scopeOnly) html += '<label>GitHub 仓库地址（可稍后填写）<input data-input="unified-remote" value="" placeholder="https://github.com/you/notes.git 或 git@github.com:you/notes.git"></label>';
            if (!scopeOnly) html += '<div class="bt-git-setup-note">若当前文件不在统一仓库内，会复制一份到该工作区；原文件不会被移动或删除。</div>';
            html += '<div class="bt-git-setup-actions"><button class="bt-git-secondary" data-action="setup-back">返回</button><button class="bt-git-primary" data-action="initialize-unified">' + (scopeOnly ? "加入工作区" : "创建统一仓库") + '</button></div>';
        } else if (view === "remote") {
            html += '<div class="bt-git-setup-title">连接 GitHub 仓库</div><p>远程同步只在统一笔记仓库中可用。凭证仍由 SSH 或系统 Git 凭证管理器处理。</p>';
            html += '<label>远程仓库地址<input data-input="unified-remote" value="' + escapeHtml(state.remoteUrl || "") + '" placeholder="https://github.com/you/notes.git 或 git@github.com:you/notes.git"></label>';
            html += '<div class="bt-git-setup-note">首次使用请连接一个空仓库；已有远程内容需要先导入或克隆，避免产生无关历史。</div>';
            html += '<div class="bt-git-ssh-box"><div class="bt-git-ssh-title">SSH 密钥</div><div class="bt-git-ssh-desc">插件会先检测本机默认密钥；没有时，点击后生成一对新的免密码密钥。私钥只保存在本机，公钥需要添加到 GitHub。</div><button class="bt-git-secondary" data-action="ssh-key-helper">' + (state.sshKeyStatus === "checking" ? "正在检查…" : (state.sshPublicKey ? "重新检测密钥" : "检测或生成密钥")) + '</button>';
            if (state.sshPublicKey) html += '<textarea class="bt-git-ssh-public" readonly aria-label="SSH 公钥">' + escapeHtml(state.sshPublicKey) + '</textarea><button class="bt-git-link bt-git-copy-key" data-action="copy-ssh-key">复制公钥</button>';
            html += '</div>';
            html += '<div class="bt-git-setup-actions"><button class="bt-git-secondary" data-action="setup-back">返回</button><button class="bt-git-primary" data-action="save-remote">连接远程</button></div>';
        } else {
            html += '<div class="bt-git-setup-title">为笔记启用版本管理</div><p>根据你的写作方式选择即可，之后不会混用两种规则。</p>';
            html += '<button class="bt-git-mode-card" data-action="setup-local"><span class="bt-git-mode-card-title">本地文件夹</span><span>给当前文件夹建立本地快照。适合零散 Markdown，不提供远程同步。</span></button>';
            html += '<button class="bt-git-mode-card" data-action="setup-unified"><span class="bt-git-mode-card-title">统一笔记仓库</span><span>把不同工作区归入一个笔记仓库，按工作区隔离快照，并可同步到 GitHub。</span></button>';
        }
        return html + '</section>';
    }

    Panel.prototype.renderLegacy = function (state) {
        if (!this.el) return;
        var busy = /^(checking|saving|committing|fetching|resolving|pushing)$/.test(state.phase);
        var files = state.files || [];
        var max = 80;
        try { max = parseInt(this.api.getSetting("maxStatusFiles", 80), 10) || 80; } catch (e) {}
        var html = '<header class="bt-git-panel-header"><div class="bt-git-panel-title">' + icons.icon("git", 17) + '<span>Git 同步</span></div><button class="bt-git-icon-button" data-action="close" title="关闭">' + icons.icon("close", 16) + "</button></header>";
        html += '<div class="bt-git-panel-body">';
        html += '<div class="bt-git-repo-card"><div class="bt-git-repo-name">' + this.escapeHtml(state.branch || "未连接分支") + '</div><div class="bt-git-repo-path" title="' + this.escapeHtml(state.root || "") + '">' + this.escapeHtml(state.root || "请打开 Typora 工作区") + "</div>";
        if (state.remoteUrl) html += '<div class="bt-git-remote">' + this.escapeHtml(state.remoteUrl) + "</div>";
        html += "</div>";
        if (state.error) html += '<div class="bt-git-notice bt-git-notice-error">' + icons.icon("warning", 15) + '<span>' + this.escapeHtml(state.error) + "</span></div>";
        else if (state.message) html += '<div class="bt-git-notice bt-git-notice-' + this.escapeHtml(state.phase) + '">' + this.escapeHtml(state.message) + "</div>";
        if (!state.isRepo) {
            html += '<div class="bt-git-empty"><div>这个工作区还没有 Git 仓库。</div><button class="bt-git-primary" data-action="init">初始化笔记仓库</button></div>';
        } else {
            html += '<div class="bt-git-actions"><button class="bt-git-primary" data-action="snapshot"' + (busy ? " disabled" : "") + '>保存快照</button><button class="bt-git-secondary" data-action="sync"' + (busy ? " disabled" : "") + '>同步</button></div>';
            html += '<div class="bt-git-sub-actions"><button data-action="fetch"' + (busy ? " disabled" : "") + '>' + icons.icon("download", 14) + '获取</button><button data-action="diff"' + (busy ? " disabled" : "") + '>查看当前差异</button><button data-action="refresh"' + (busy ? " disabled" : "") + '>' + icons.icon("refresh", 14) + '刷新</button></div>';
            html += '<div class="bt-git-section-title"><span>工作区改动</span><span>' + files.length + "</span></div>";
            if (!files.length) html += '<div class="bt-git-empty-small">当前没有未提交改动</div>';
            else {
                html += '<div class="bt-git-file-list">';
                for (var i = 0; i < files.length && i < max; i++) {
                    html += '<button class="bt-git-file" data-file="' + this.escapeHtml(files[i].path) + '"><span class="bt-git-file-code">' + this.escapeHtml(files[i].code) + '</span><span>' + this.escapeHtml(files[i].path) + "</span></button>";
                }
                if (files.length > max) html += '<div class="bt-git-more">还有 ' + (files.length - max) + " 个文件未显示</div>";
                html += "</div>";
            }
            if (state.diff) html += '<div class="bt-git-section-title"><span>当前差异</span></div><pre class="bt-git-diff">' + this.escapeHtml(state.diff) + "</pre>";
            if (state.commits && state.commits.length) {
                html += '<div class="bt-git-section-title"><span>最近快照</span><button class="bt-git-link" data-action="history">刷新</button></div><div class="bt-git-history">';
                for (var j = 0; j < state.commits.length; j++) html += '<div class="bt-git-commit"><code>' + this.escapeHtml(state.commits[j].hash.substring(0, 7)) + '</code><span>' + this.escapeHtml(state.commits[j].message) + '</span><time>' + this.escapeHtml(state.commits[j].date) + "</time></div>";
                html += "</div>";
            } else html += '<div class="bt-git-section-title"><span>最近快照</span><button class="bt-git-link" data-action="history">查看</button></div>';
        }
        html += "</div><footer class=\"bt-git-panel-footer\">凭证使用 SSH 或系统 Git 凭证管理器 · 不在 Typora 中保存密码</footer>";
        this.el.innerHTML = html;
    };

    /* 首页只保留操作栏、工作区改动和最近快照，避免用户打开面板时被状态卡片淹没。 */
    Panel.prototype.render = function (state) {
        if (!this.el) return;
        var busy = /^(checking|saving|committing|fetching|resolving|pushing)$/.test(state.phase);
        var files = state.files || [];
        var max = 80;
        try { max = parseInt(this.api.getSetting("maxStatusFiles", 80), 10) || 80; } catch (e) {}
        var setup = !state.isRepo || state.needsSetup || !!state.setupView;
        var branch = setup ? "Git 同步" : (state.mode === "unified" ? (state.scopeLabel || "统一笔记") : (state.branch || "本地快照"));
        // 不能使用原生 header：Typora 将所有 header 全局设为 fixed，会使抽屉工具栏被父容器上沿裁切。
        var html = '<div class="bt-git-panel-toolbar" role="toolbar"><div class="bt-git-panel-context">' + icons.icon("git", 16) + '<span title="' + this.escapeHtml(state.root || "") + '">' + this.escapeHtml(branch) + "</span></div><div class=\"bt-git-panel-actions\">";
        if (setup) html += '<button class="bt-git-action-button" data-action="init" title="选择笔记管理方式">' + icons.icon("folder", 15) + "</button>";
        else {
            html += '<button class="bt-git-action-button" data-action="snapshot" title="保存快照"' + (busy ? " disabled" : "") + ">" + icons.icon("upload", 15) + "</button>";
            if (state.mode === "unified") {
                html += state.remoteUrl ? '<button class="bt-git-action-button" data-action="sync" title="同步笔记"' + (busy ? " disabled" : "") + ">" + icons.icon("sync", 15) + "</button>" : '<button class="bt-git-action-button" data-action="remote-setup" title="连接 GitHub 仓库">' + icons.icon("upload", 15) + "</button>";
                html += '<button class="bt-git-action-button" data-action="remote-setup" title="远程设置">' + icons.icon("settings", 15) + "</button>";
            }
            html += '<button class="bt-git-action-button" data-action="diff" title="比较当前文件差异"' + (busy ? " disabled" : "") + ">" + icons.icon("compare", 15) + "</button>";
        }
        html += '<button class="bt-git-action-button" data-action="refresh" title="刷新"' + (busy ? " disabled" : "") + ">" + icons.icon("refresh", 15) + '</button><button class="bt-git-action-button" data-action="close" title="关闭">' + icons.icon("close", 15) + "</button></div></div>";
        html += '<main class="bt-git-panel-body">';
        if (state.error) html += '<div class="bt-git-inline-error">' + icons.icon("warning", 14) + '<span>' + this.escapeHtml(state.error) + "</span></div>";
        if (setup) {
            html += renderSetup(state, this.escapeHtml);
            html += "</main>";
            this.el.innerHTML = html;
            return;
        }
        if (state.mode === "unified") html += '<div class="bt-git-scope-line" title="' + this.escapeHtml(state.root || "") + '"><span>统一笔记仓库</span><span>' + this.escapeHtml(state.scopeLabel || "当前工作区") + "</span></div>";
        else html += '<div class="bt-git-scope-line"><span>本地文件夹模式</span><span>仅本地快照</span></div>';
        html += '<section class="bt-git-section"><div class="bt-git-section-title"><span>工作区改动</span><span class="bt-git-section-count">' + (state.isRepo ? files.length : "—") + "</span></div>";
        if (!state.isRepo) html += '<div class="bt-git-simple-empty">当前工作区尚未初始化 Git</div>';
        else if (!files.length) html += '<div class="bt-git-simple-empty">没有未提交改动</div>';
        else {
            html += '<div class="bt-git-file-list">';
            for (var i = 0; i < files.length && i < max; i++) {
                var change = getFileChange(files[i].code);
                var fileInfo = splitFilePath(files[i].path);
                html += '<button class="bt-git-file bt-git-file-' + change.kind + '" data-file="' + this.escapeHtml(files[i].path) + '" title="' + this.escapeHtml(change.label + " · " + files[i].path) + '"><span class="bt-git-file-status" aria-label="' + this.escapeHtml(change.label) + '">' + icons.changeIcon(change.kind, 16) + '</span><span class="bt-git-file-text"><span class="bt-git-file-name">' + this.escapeHtml(fileInfo.name) + '</span>';
                if (fileInfo.directory) html += '<span class="bt-git-file-directory">' + this.escapeHtml(fileInfo.directory) + "</span>";
                html += '</span><span class="bt-git-file-diff" data-action="diff-file" data-file="' + this.escapeHtml(files[i].path) + '" title="比较此文件差异">' + icons.icon("compare", 14) + "</span></button>";
            }
            if (files.length > max) html += '<div class="bt-git-more">还有 ' + (files.length - max) + " 个文件</div>";
            html += "</div>";
        }
        var detail = state.historyDetail;
        html += "</section><section class=\"bt-git-section bt-git-snapshots\">";
        if (detail) {
            var compareMode = detail.compareMode === "parent" ? "parent" : "worktree";
            var comparisonLabel = compareMode === "parent" ? "与前一快照比较" : "与工作区比较";
            html += '<div class="bt-git-section-title bt-git-history-detail-title"><button class="bt-git-history-back" data-action="history-back" title="返回快照列表">‹</button><span>快照详情</span></div>';
            html += '<div class="bt-git-history-detail-meta"><div title="' + this.escapeHtml(detail.message || "") + '">' + this.escapeHtml(detail.message || "快照") + '</div><code>' + this.escapeHtml(String(detail.hash || "").substring(0, 7)) + "</code></div>";
            html += '<div class="bt-git-compare-mode" role="group" aria-label="快照比较方式"><button type="button" data-action="snapshot-compare-mode" data-mode="worktree"' + (compareMode === "worktree" ? ' class="is-active" aria-pressed="true"' : ' aria-pressed="false"') + ' title="将选中快照与当前工作区比较">与工作区</button><button type="button" data-action="snapshot-compare-mode" data-mode="parent"' + (compareMode === "parent" ? ' class="is-active" aria-pressed="true"' : ' aria-pressed="false"') + ' title="将选中快照与其前一快照比较">与前一快照</button></div>';
            if (!detail.files || !detail.files.length) html += '<div class="bt-git-simple-empty">这个快照没有文件改动</div>';
            else {
                html += '<div class="bt-git-file-list bt-git-history-file-list">';
                for (var j = 0; j < detail.files.length; j++) {
                    var historyChange = getFileChange(detail.files[j].code);
                    var historyFile = splitFilePath(detail.files[j].path);
                    html += '<button type="button" class="bt-git-file bt-git-history-file bt-git-file-' + historyChange.kind + '" data-action="snapshot-diff-file" data-commit="' + this.escapeHtml(detail.hash) + '" data-file="' + this.escapeHtml(detail.files[j].path) + '" title="' + this.escapeHtml(comparisonLabel + " · " + historyChange.label + " · " + detail.files[j].path) + '"><span class="bt-git-file-status">' + icons.changeIcon(historyChange.kind, 16) + '</span><span class="bt-git-file-text"><span class="bt-git-file-name">' + this.escapeHtml(historyFile.name) + '</span>';
                    if (historyFile.directory) html += '<span class="bt-git-file-directory">' + this.escapeHtml(historyFile.directory) + "</span>";
                    html += '</span><span class="bt-git-history-file-open">' + icons.icon("compare", 14) + "</span></button>";
                }
                html += "</div>";
            }
        } else {
            html += '<div class="bt-git-section-title"><span>最近快照</span><button class="bt-git-history-refresh" data-action="history" title="刷新快照">' + icons.icon("refresh", 13) + "</button></div>";
            if (!state.isRepo || !state.commits || !state.commits.length) html += '<div class="bt-git-simple-empty">暂无快照</div>';
            else {
                html += '<div class="bt-git-history">';
                for (var k = 0; k < state.commits.length; k++) html += '<button type="button" class="bt-git-commit" data-action="history-commit" data-commit="' + this.escapeHtml(state.commits[k].hash) + '" title="查看此快照的文件改动"><span class="bt-git-commit-marker"></span><span class="bt-git-commit-content"><span class="bt-git-commit-main"><span>' + this.escapeHtml(state.commits[k].message) + '</span><code>' + this.escapeHtml(state.commits[k].hash.substring(0, 7)) + '</code></span><time>' + this.escapeHtml(formatSnapshotTime(state.commits[k].date)) + "</time></span></button>";
                html += "</div>";
            }
        }
        html += "</section></main>";
        this.el.innerHTML = html;
    };

    Panel.prototype.destroy = function () {
        if (this._closeTimer && this.timers) this.timers.clearTimeout(this._closeTimer);
        if (this.unsubscribe) this.unsubscribe();
        if (this.el && this._click) this.el.removeEventListener("click", this._click);
        if (this.el && this.el.parentNode) this.el.parentNode.removeChild(this.el);
        if (this.backdrop && this.backdrop.parentNode) this.backdrop.parentNode.removeChild(this.backdrop);
        this.el = null;
        this.backdrop = null;
    };

    if (typeof module !== "undefined") module.exports = Panel;
})();
