/* 工作区边界服务：按当前文件匹配本地仓库或统一笔记仓库，并严格限制统一模式的作用范围。 */
(function () {
    "use strict";

    var fs = reqnode("fs");
    var path = reqnode("path");

    function WorkspaceService(api, adapter, settings, profiles, logger) {
        this.api = api;
        this.adapter = adapter;
        this.settings = settings;
        this.profiles = profiles;
        this.logger = logger || console;
    }

    WorkspaceService.prototype.context = function () {
        var mount = this.api.getMountFolder ? this.api.getMountFolder() : null;
        var current = this.api.getCurrentFile ? this.api.getCurrentFile() : null;
        current = current ? normalize(current) : null;
        mount = mount ? normalize(mount) : null;
        var profile = current && this.profiles ? this.profiles.findForFile(current) : null;
        var scope = profile && profile.mode === "unified" ? this.profiles.scopeForFile(profile, current) : "";
        var candidate = mount || (current ? path.dirname(current) : null);
        return {
            currentFile: current,
            mountFolder: mount,
            candidateRoot: candidate,
            root: profile ? profile.root : candidate,
            mode: profile ? profile.mode : null,
            profile: profile,
            scopePath: scope,
            scopeLabel: scope === null ? "" : displayScope(scope),
            suggestedScope: current && this.profiles ? this.profiles.suggestScope(current) : "inbox"
        };
    };

    WorkspaceService.prototype.resolve = function () {
        var self = this;
        var context = this.context();
        if (!context.currentFile) return Promise.resolve({ success: false, context: context, error: "请先打开一个 Markdown 文件" });
        if (!context.root) return Promise.resolve({ success: false, context: context, error: "没有找到当前文件所在目录" });
        if (!fs.existsSync(context.root)) return Promise.resolve({ success: false, context: context, error: "笔记仓库路径不存在" });
        return this.adapter.isRepo(context.root).then(function (check) {
            if (!check.success) return { success: true, context: context, isRepo: false, root: context.root, needsSetup: !context.profile };
            var root = normalize(check.root || context.root);
            if (!context.profile) {
                // 已有 Git 仓库默认进入本地模式；不会擅自启用其远程地址。
                context.mode = "local";
                context.root = root;
                context.scopePath = "";
                context.scopeLabel = "当前文件夹";
            }
            return { success: true, context: context, isRepo: true, root: root, needsSetup: context.mode === "unified" && context.scopePath === null };
        }).catch(function (error) {
            self.logger.warn("解析 Git 工作区失败", error);
            return { success: false, context: context, error: error.message || "无法检查 Git 工作区" };
        });
    };

    WorkspaceService.prototype.prepareLocal = function (root) {
        var context = this.context();
        var rawRoot = String(root || context.candidateRoot || "").trim();
        if (!context.currentFile) return { success: false, error: "请先打开一个 Markdown 文件" };
        if (!rawRoot) return { success: false, error: "请填写本地仓库目录" };
        var target = normalize(rawRoot);
        if (!target || !isInside(target, context.currentFile)) return { success: false, error: "本地仓库目录必须包含当前文件" };
        return { success: true, root: target, currentFile: context.currentFile };
    };

    WorkspaceService.prototype.prepareUnified = function (root, scopeInput) {
        var context = this.context();
        if (!context.currentFile) return { success: false, error: "请先打开一个 Markdown 文件" };
        var rawRoot = String(root || "").trim();
        if (!rawRoot) return { success: false, error: "请填写统一笔记仓库位置" };
        var targetRoot = normalize(rawRoot);
        var relative = this.relative(targetRoot, context.currentFile);
        var scope = normalizeScope(scopeInput);
        if (scope === null) return { success: false, error: "工作区名称不能包含上级目录" };
        if (relative !== null) {
            if (!scope) scope = path.dirname(relative).replace(/\\/g, "/");
            if (scope === ".") scope = "";
            if (!scopeContains(scope, relative)) return { success: false, error: "当前文件不在指定的统一工作区目录内" };
            return { success: true, root: targetRoot, scopePath: scope, scopeLabel: displayScope(scope), currentFile: context.currentFile, imported: false };
        }
        scope = scope || context.suggestedScope || "inbox";
        return { success: true, root: targetRoot, scopePath: scope, scopeLabel: displayScope(scope), currentFile: context.currentFile, imported: true };
    };

    /* 导入仅复制当前文件，绝不删除或改写原始文件；调用前须完成用户确认与保存。 */
    WorkspaceService.prototype.importCurrentFile = function (prepared) {
        if (!prepared || !prepared.success || !prepared.imported) return prepared ? prepared.currentFile : null;
        var source = prepared.currentFile;
        var directory = path.join(prepared.root, prepared.scopePath);
        var target = uniquePath(directory, path.basename(source));
        fs.mkdirSync(directory, { recursive: true });
        fs.copyFileSync(source, target);
        return target;
    };

    WorkspaceService.prototype.relative = function (root, filePath) {
        if (!root || !filePath) return null;
        var relative = path.relative(normalize(root), normalize(filePath)).replace(/\\/g, "/");
        if (!relative || relative === ".") return "";
        if (relative.indexOf("../") === 0 || relative === ".." || /^[A-Za-z]:/.test(relative)) return null;
        return relative;
    };

    WorkspaceService.prototype.isInside = function (root, filePath) {
        return this.relative(root, filePath) !== null;
    };

    WorkspaceService.prototype.isInScope = function (scopePath, rootRelativePath) {
        return scopeContains(normalizeScope(scopePath), String(rootRelativePath || "").replace(/\\/g, "/"));
    };

    function uniquePath(directory, baseName) {
        var extension = path.extname(baseName);
        var name = path.basename(baseName, extension);
        var candidate = path.join(directory, baseName);
        var index = 2;
        while (fs.existsSync(candidate)) {
            candidate = path.join(directory, name + " (" + index + ")" + extension);
            index++;
        }
        return candidate;
    }

    function normalize(value) {
        return path.resolve(String(value || "").replace(/^file:\/\//i, ""));
    }

    function normalizeScope(value) {
        if (value === undefined || value === null || value === "") return "";
        var normalized = String(value).replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
        if (!normalized || normalized === ".") return "";
        if (normalized === ".." || normalized.indexOf("../") === 0 || /^[A-Za-z]:/.test(normalized) || path.isAbsolute(normalized)) return null;
        return normalized;
    }

    function isInside(root, target) {
        var relative = path.relative(normalize(root), normalize(target)).replace(/\\/g, "/");
        return relative === "" || (relative !== ".." && relative.indexOf("../") !== 0 && !/^[A-Za-z]:/.test(relative));
    }

    function scopeContains(scope, relative) {
        if (scope === null) return false;
        return scope === "" || relative === scope || relative.indexOf(scope + "/") === 0;
    }

    function displayScope(scope) {
        return scope || "全部笔记";
    }

    WorkspaceService.normalizeScope = normalizeScope;
    if (typeof module !== "undefined") module.exports = WorkspaceService;
})();
