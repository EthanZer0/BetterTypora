/* 状态栏入口：只占据 Typora footer 的自然布局空间，不覆盖编辑器或分屏容器。 */
(function () {
    "use strict";

    var icons = require("./icons");

    function Statusbar(store, onToggle, escapeHtml) {
        this.store = store;
        this.onToggle = onToggle;
        this.escapeHtml = escapeHtml || function (v) { return String(v || ""); };
        this.el = null;
        this.unsubscribe = null;
        this._click = null;
    }

    Statusbar.prototype.mount = function () {
        var footer = document.querySelector(".ty-footer");
        if (!footer) return false;
        this.el = document.createElement("button");
        this.el.type = "button";
        this.el.className = "bt-git-status";
        this.el.title = "Git 同步";
        this._click = function () { this.onToggle(); }.bind(this);
        this.el.addEventListener("click", this._click);
        footer.appendChild(this.el);
        this.unsubscribe = this.store.subscribe(this.render.bind(this));
        return true;
    };

    Statusbar.prototype.render = function (state) {
        if (!this.el) return;
        var phase = state.phase || "idle";
        var label = state.branch || "Git";
        var detail = "";
        if (!state.root) detail = "未连接工作区";
        else if (!state.isRepo) detail = "未初始化";
        else if (phase === "conflict") detail = "有分叉";
        else if (phase === "git-error") detail = "操作失败";
        else if (phase === "checking" || phase === "saving" || phase === "committing" || phase === "fetching" || phase === "resolving" || phase === "pushing") detail = state.message || "处理中…";
        else if (state.files && state.files.length) detail = state.files.length + " 个文件有改动";
        else if (state.ahead || state.behind) detail = (state.ahead ? "↑" + state.ahead + " " : "") + (state.behind ? "↓" + state.behind : "");
        else if (state.mode === "local") detail = "本地快照";
        else detail = "已同步";
        this.el.className = "bt-git-status bt-git-status-" + phase;
        this.el.innerHTML = icons.icon("git", 15) + '<span class="bt-git-status-branch">' + this.escapeHtml(label) + '</span><span class="bt-git-status-detail">' + this.escapeHtml(detail) + "</span>";
        this.el.setAttribute("aria-label", label + "，" + detail);
    };

    Statusbar.prototype.destroy = function () {
        if (this.unsubscribe) this.unsubscribe();
        if (this.el && this._click) this.el.removeEventListener("click", this._click);
        if (this.el && this.el.parentNode) this.el.parentNode.removeChild(this.el);
        this.el = null;
    };

    if (typeof module !== "undefined") module.exports = Statusbar;
})();
