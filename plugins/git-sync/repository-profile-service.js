/* 仓库档案服务：区分本地文件夹与统一笔记仓库，并按当前文件路径匹配。 */
(function () {
    "use strict";

    var path = reqnode("path");

    function RepositoryProfileService(api, logger) {
        this.api = api;
        this.logger = logger || console;
        this._loaded = false;
        this._profiles = [];
    }

    RepositoryProfileService.prototype.list = function () {
        this._load();
        return cloneProfiles(this._profiles);
    };

    RepositoryProfileService.prototype.findForFile = function (filePath) {
        this._load();
        var target = normalizePath(filePath);
        var matched = null;
        for (var i = 0; i < this._profiles.length; i++) {
            var profile = this._profiles[i];
            if (!isInside(profile.root, target)) continue;
            if (!matched || profile.root.length > matched.root.length) matched = profile;
        }
        return matched ? cloneProfile(matched) : null;
    };

    RepositoryProfileService.prototype.findByRoot = function (root) {
        this._load();
        var target = normalizePath(root);
        for (var i = 0; i < this._profiles.length; i++) {
            if (samePath(this._profiles[i].root, target)) return cloneProfile(this._profiles[i]);
        }
        return null;
    };

    RepositoryProfileService.prototype.registerLocal = function (root) {
        return this._upsert({ mode: "local", root: root, scopes: [], remoteName: "origin" });
    };

    RepositoryProfileService.prototype.registerUnified = function (root, scopePath, label) {
        this._load();
        var normalizedRoot = normalizePath(root);
        var profile = this._findMutable(normalizedRoot);
        if (!profile) {
            profile = { mode: "unified", root: normalizedRoot, scopes: [], remoteName: "origin", createdAt: Date.now() };
            this._profiles.push(profile);
        }
        profile.mode = "unified";
        if (!profile.scopes) profile.scopes = [];
        var scope = normalizeScope(scopePath);
        if (!findScope(profile.scopes, scope)) profile.scopes.push({ path: scope, label: label || displayScope(scope) });
        this._save();
        return cloneProfile(profile);
    };

    RepositoryProfileService.prototype.setRemote = function (root, remoteName) {
        this._load();
        var profile = this._findMutable(normalizePath(root));
        if (!profile || profile.mode !== "unified") return null;
        profile.remoteName = String(remoteName || "origin").trim() || "origin";
        this._save();
        return cloneProfile(profile);
    };

    RepositoryProfileService.prototype.scopeForFile = function (profile, filePath) {
        if (!profile || profile.mode !== "unified") return "";
        var relative = relativePath(profile.root, filePath);
        if (relative === null) return null;
        var scopes = profile.scopes || [];
        var best = null;
        for (var i = 0; i < scopes.length; i++) {
            var value = normalizeScope(scopes[i].path);
            if (!scopeContains(value, relative)) continue;
            if (best === null || value.length > best.length) best = value;
        }
        return best;
    };

    RepositoryProfileService.prototype.suggestScope = function (filePath) {
        var target = normalizePath(filePath);
        var folder = path.basename(path.dirname(target));
        return normalizeScope(folder || "inbox") || "inbox";
    };

    RepositoryProfileService.prototype._upsert = function (candidate) {
        this._load();
        var root = normalizePath(candidate.root);
        var profile = this._findMutable(root);
        if (!profile) {
            profile = { mode: candidate.mode, root: root, scopes: candidate.scopes || [], remoteName: candidate.remoteName || "origin", createdAt: Date.now() };
            this._profiles.push(profile);
        } else {
            profile.mode = candidate.mode;
            profile.scopes = candidate.scopes || [];
            profile.remoteName = candidate.remoteName || profile.remoteName || "origin";
        }
        this._save();
        return cloneProfile(profile);
    };

    RepositoryProfileService.prototype._findMutable = function (root) {
        for (var i = 0; i < this._profiles.length; i++) if (samePath(this._profiles[i].root, root)) return this._profiles[i];
        return null;
    };

    RepositoryProfileService.prototype._load = function () {
        if (this._loaded) return;
        this._loaded = true;
        var raw = this.api.getSetting("repositoryProfiles", "");
        var values = [];
        try { values = typeof raw === "string" ? JSON.parse(raw || "[]") : (raw || []); } catch (e) { values = []; }
        if (!Array.isArray(values)) values = [];
        for (var i = 0; i < values.length; i++) {
            var profile = normalizeProfile(values[i]);
            if (profile) this._profiles.push(profile);
        }
        // 兼容旧版仅配置 repoPath 的用户：保留其原本的远程同步能力。
        if (!this._profiles.length) {
            var legacyRoot = String(this.api.getSetting("repoPath", "") || "").trim();
            if (legacyRoot) this._profiles.push({ mode: "unified", root: normalizePath(legacyRoot), scopes: [{ path: "", label: "全部笔记" }], remoteName: String(this.api.getSetting("remoteName", "origin") || "origin"), createdAt: Date.now() });
        }
    };

    RepositoryProfileService.prototype._save = function () {
        try {
            this.api.setSetting("repositoryProfiles", JSON.stringify(this._profiles));
        } catch (e) {
            this.logger.warn("无法保存 Git 仓库配置", e);
        }
    };

    function normalizeProfile(value) {
        if (!value || !value.root) return null;
        var mode = value.mode === "local" ? "local" : "unified";
        var scopes = [];
        if (mode === "unified") {
            var source = Array.isArray(value.scopes) ? value.scopes : [];
            for (var i = 0; i < source.length; i++) {
                var scope = normalizeScope(source[i] && source[i].path);
                if (scope === null || findScope(scopes, scope)) continue;
                scopes.push({ path: scope, label: source[i].label || displayScope(scope) });
            }
            if (!scopes.length) scopes.push({ path: "", label: "全部笔记" });
        }
        return { mode: mode, root: normalizePath(value.root), scopes: scopes, remoteName: String(value.remoteName || "origin").trim() || "origin", createdAt: value.createdAt || Date.now() };
    }

    function normalizePath(value) {
        return path.resolve(String(value || "").replace(/^file:\/\//i, ""));
    }

    function normalizeScope(value) {
        if (value === undefined || value === null || value === "") return "";
        var normalized = String(value).replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
        if (!normalized || normalized === ".") return "";
        if (normalized.indexOf("../") === 0 || normalized === ".." || /^[A-Za-z]:/.test(normalized) || path.isAbsolute(normalized)) return null;
        return normalized;
    }

    function relativePath(root, target) {
        var relative = path.relative(normalizePath(root), normalizePath(target)).replace(/\\/g, "/");
        if (!relative || relative === ".") return "";
        if (relative === ".." || relative.indexOf("../") === 0 || /^[A-Za-z]:/.test(relative)) return null;
        return relative;
    }

    function isInside(root, target) {
        return relativePath(root, target) !== null;
    }

    function samePath(left, right) {
        var a = normalizePath(left);
        var b = normalizePath(right);
        return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
    }

    function findScope(scopes, scope) {
        for (var i = 0; i < scopes.length; i++) if (normalizeScope(scopes[i].path) === scope) return scopes[i];
        return null;
    }

    function scopeContains(scope, relative) {
        return scope === "" || relative === scope || relative.indexOf(scope + "/") === 0;
    }

    function displayScope(scope) {
        return scope || "全部笔记";
    }

    function cloneProfile(profile) {
        return { mode: profile.mode, root: profile.root, scopes: (profile.scopes || []).map(function (scope) { return { path: scope.path, label: scope.label }; }), remoteName: profile.remoteName, createdAt: profile.createdAt };
    }

    function cloneProfiles(profiles) {
        return profiles.map(cloneProfile);
    }

    if (typeof module !== "undefined") module.exports = RepositoryProfileService;
})();
