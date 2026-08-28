/* 工作区边界服务：默认只认 Typora 当前挂载目录，避免把上层任意 Git 仓库当成笔记仓库。 */
(function () {
    "use strict";

    var fs = reqnode("fs");
    var path = reqnode("path");

    function WorkspaceService(api, adapter, settings, logger) {
        this.api = api;
        this.adapter = adapter;
        this.settings = settings;
        this.logger = logger || console;
    }

    WorkspaceService.prototype.context = function () {
        var configured = String(this.settings("repoPath", "") || "").trim();
        var mount = this.api.getMountFolder ? this.api.getMountFolder() : null;
        var current = this.api.getCurrentFile ? this.api.getCurrentFile() : null;
        var root = configured || mount || (current ? path.dirname(current) : null);
        if (root) root = normalize(root);
        return { configured: configured, mountFolder: mount ? normalize(mount) : null, currentFile: current ? normalize(current) : null, root: root };
    };

    WorkspaceService.prototype.resolve = function () {
        var context = this.context();
        if (!context.root) return Promise.resolve({ success: false, context: context, error: "没有找到 Typora 工作区" });
        if (!fs.existsSync(context.root)) return Promise.resolve({ success: false, context: context, error: "笔记仓库路径不存在" });
        return this.adapter.isRepo(context.root).then(function (check) {
            return { success: true, context: context, isRepo: check.success, root: context.root, gitRoot: check.root };
        });
    };

    WorkspaceService.prototype.relative = function (root, filePath) {
        if (!root || !filePath) return null;
        var relative = path.relative(root, filePath).replace(/\\/g, "/");
        if (!relative || relative === "." || relative.indexOf("../") === 0 || relative === ".." || /^[A-Za-z]:/.test(relative)) return null;
        return relative;
    };

    WorkspaceService.prototype.isInside = function (root, filePath) {
        return !!this.relative(root, filePath);
    };

    function normalize(value) {
        return path.resolve(String(value).replace(/^file:\/\//i, ""));
    }

    if (typeof module !== "undefined") module.exports = WorkspaceService;
})();
