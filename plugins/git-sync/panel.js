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
        if (file && state.root) {
            if (this.api.openFile) this.api.openFile(path.join(state.root, file));
            return;
        }
        if (action === "close") this.close();
        else if (action === "init") this.engine.initRepo();
        else if (action === "refresh") this.engine.refresh();
        else if (action === "snapshot") this.engine.saveSnapshot().then(function () { self.engine.loadHistory(); });
        else if (action === "sync") this.engine.sync().then(function () { self.engine.loadHistory(); });
        else if (action === "fetch") this.engine.fetch();
        else if (action === "diff") this.engine.diffCurrent();
        else if (action === "history") this.engine.loadHistory();
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
        var branch = state.branch || "未初始化";
        // 不能使用原生 header：Typora 将所有 header 全局设为 fixed，会使抽屉工具栏被父容器上沿裁切。
        var html = '<div class="bt-git-panel-toolbar" role="toolbar"><div class="bt-git-panel-context">' + icons.icon("git", 16) + '<span title="' + this.escapeHtml(state.root || "") + '">' + this.escapeHtml(branch) + "</span></div><div class=\"bt-git-panel-actions\">";
        if (!state.isRepo) html += '<button class="bt-git-action-button" data-action="init" title="初始化笔记仓库">' + icons.icon("folder", 15) + "</button>";
        else html += '<button class="bt-git-action-button" data-action="snapshot" title="保存快照"' + (busy ? " disabled" : "") + ">" + icons.icon("upload", 15) + '</button><button class="bt-git-action-button" data-action="sync" title="同步"' + (busy ? " disabled" : "") + ">" + icons.icon("sync", 15) + "</button>";
        html += '<button class="bt-git-action-button" data-action="refresh" title="刷新"' + (busy ? " disabled" : "") + ">" + icons.icon("refresh", 15) + '</button><button class="bt-git-action-button" data-action="close" title="关闭">' + icons.icon("close", 15) + "</button></div></div>";
        html += '<main class="bt-git-panel-body">';
        if (state.error) html += '<div class="bt-git-inline-error">' + icons.icon("warning", 14) + '<span>' + this.escapeHtml(state.error) + "</span></div>";
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
                html += "</span></button>";
            }
            if (files.length > max) html += '<div class="bt-git-more">还有 ' + (files.length - max) + " 个文件</div>";
            html += "</div>";
        }
        html += "</section><section class=\"bt-git-section bt-git-snapshots\"><div class=\"bt-git-section-title\"><span>最近快照</span><button class=\"bt-git-history-refresh\" data-action=\"history\" title=\"刷新快照\">" + icons.icon("refresh", 13) + "</button></div>";
        if (!state.isRepo || !state.commits || !state.commits.length) html += '<div class="bt-git-simple-empty">暂无快照</div>';
        else {
            html += '<div class="bt-git-history">';
            for (var j = 0; j < state.commits.length; j++) html += '<div class="bt-git-commit"><span class="bt-git-commit-marker"></span><div class="bt-git-commit-content"><div class="bt-git-commit-main"><span>' + this.escapeHtml(state.commits[j].message) + '</span><code>' + this.escapeHtml(state.commits[j].hash.substring(0, 7)) + '</code></div><time>' + this.escapeHtml(formatSnapshotTime(state.commits[j].date)) + "</time></div></div>";
            html += "</div>";
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
