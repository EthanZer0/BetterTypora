/* 同步引擎：所有改变工作区或 .git 的动作串行执行，且不替用户决定如何解决冲突。 */
(function () {
    "use strict";

    var fs = reqnode("fs");
    var path = reqnode("path");

    var IGNORE_CONTENT = [
        "# BetterTypora / Typora 运行时产物",
        ".cache/",
        ".trash/",
        "*.swp",
        "*.swo",
        "*~",
        "Thumbs.db",
        "desktop.ini",
        ".DS_Store",
        "",
        "# 常见编辑器缓存",
        ".vscode/",
        ".idea/",
        ""
    ].join("\n");

    function SyncEngine(api, adapter, workspace, store, history, settings, logger) {
        this.api = api;
        this.adapter = adapter;
        this.workspace = workspace;
        this.store = store;
        this.history = history;
        this.settings = settings;
        this.logger = logger || console;
        this._queue = Promise.resolve();
    }

    SyncEngine.prototype.enqueue = function (fn) {
        var self = this;
        var task = this._queue.then(fn, fn);
        this._queue = task.then(function () {}, function () {});
        return task;
    };

    SyncEngine.prototype.refresh = function () {
        var self = this;
        return this.enqueue(function () { return self._refresh(); });
    };

    SyncEngine.prototype._refresh = function () {
        var self = this;
        var context = this.workspace.context();
        this.store.update({ phase: "checking", root: context.root, currentFile: context.currentFile, error: "", conflict: false });
        if (!context.root) {
            this.store.update({ phase: "idle", isRepo: false, message: "请打开一个 Typora 工作区" });
            return Promise.resolve({ success: true, isRepo: false });
        }
        return this.adapter.isRepo(context.root).then(function (repo) {
            if (!repo.success) {
                self.store.update({ phase: "idle", isRepo: false, branch: "", files: [], ahead: 0, behind: 0, remoteUrl: "", message: "当前工作区还不是 Git 仓库" });
                return { success: true, isRepo: false, root: context.root };
            }
            return self._readRepoState(context.root).then(function (state) {
                self.store.update({ phase: state.files.length ? "dirty" : "synced", isRepo: true, root: context.root, branch: state.branch, upstream: state.upstream, files: state.files, ahead: state.ahead, behind: state.behind, remoteUrl: state.remoteUrl, message: state.files.length ? "有未保存到 Git 的改动" : "工作区干净", error: "", conflict: false });
                return { success: true, isRepo: true, root: context.root, state: state };
            });
        });
    };

    SyncEngine.prototype._readRepoState = function (root) {
        var self = this;
        return Promise.all([
            this.adapter.status(root),
            this.adapter.remoteUrl(root, this.settings("remoteName", "origin"))
        ]).then(function (results) {
            var status = results[0];
            if (!status.success) return Promise.reject(new Error(status.error));
            return { branch: status.status.branch || "main", upstream: status.status.upstream || "", files: status.status.files || [], ahead: status.status.ahead || 0, behind: status.status.behind || 0, remoteUrl: results[1].success ? results[1].output : "" };
        });
    };

    SyncEngine.prototype.initRepo = function () {
        var self = this;
        return this.enqueue(function () {
            var context = self.workspace.context();
            if (!context.root) return self._fail("没有找到 Typora 工作区");
            self.store.update({ phase: "checking", root: context.root, error: "" });
            return self.adapter.isRepo(context.root).then(function (check) {
                if (check.success) return { success: true, existed: true };
                return self.adapter.init(context.root).then(function (init) {
                    if (!init.success) return init;
                    try {
                        var ignorePath = path.join(context.root, ".gitignore");
                        if (!fs.existsSync(ignorePath)) fs.writeFileSync(ignorePath, IGNORE_CONTENT, "utf8");
                    } catch (e) {
                        return { success: false, error: "无法创建 .gitignore：" + e.message };
                    }
                    return self.adapter.renameDefaultBranch(context.root).then(function () {
                        return { success: true, existed: false };
                    });
                });
            }).then(function (result) {
                if (!result.success) return self._fail(result.error);
                return self._refresh().then(function () { return result; });
            }).catch(function (err) { return self._fail(err.message); });
        });
    };

    SyncEngine.prototype.saveSnapshot = function (message) {
        var self = this;
        return this.enqueue(function () { return self._saveSnapshot(message); });
    };

    SyncEngine.prototype._saveSnapshot = function (message) {
        var self = this;
        return this._ensureRepo().then(function (repo) {
            if (!repo.success) return repo;
            self.store.update({ phase: "saving", message: "正在保存当前文档…", error: "" });
            return self._saveAndWait().then(function (saved) {
                if (!saved.success && saved.reason === "timeout") return self._fail("保存当前文档超时，已停止同步");
                return self._refresh().then(function () {
                    var current = self.store.get();
                    if (!current.files.length) {
                        self.store.update({ phase: "synced", message: "没有新的改动" });
                        return { success: true, committed: false };
                    }
                    self.store.update({ phase: "committing", message: "正在保存本地快照…" });
                    return self.adapter.addAll(current.root).then(function (added) {
                        if (!added.success) return self._fail(added.error);
                        var text = message || defaultMessage(current.currentFile);
                        return self.adapter.commit(current.root, text).then(function (committed) {
                            if (!committed.success) return self._fail(formatGitError(committed.error));
                            return self._refresh().then(function () { return { success: true, committed: true, message: text }; });
                        });
                    });
                });
            });
        });
    };

    SyncEngine.prototype.sync = function () {
        var self = this;
        return this.enqueue(function () { return self._sync(); });
    };

    SyncEngine.prototype._sync = function () {
        var self = this;
        return this._saveSnapshot().then(function (snapshot) {
            if (!snapshot.success) return snapshot;
            var state = self.store.get();
            if (!state.remoteUrl) {
                self.store.update({ phase: "synced", message: "本地快照已保存；尚未配置远程仓库" });
                return { success: true, remote: false };
            }
            self.store.update({ phase: "fetching", message: "正在检查远程仓库…", error: "" });
            return self.adapter.fetch(state.root, self.settings("remoteName", "origin")).then(function (fetched) {
                if (!fetched.success) return self._fail(formatGitError(fetched.error));
                return self._refresh().then(function () {
                    var after = self.store.get();
                    if (after.ahead > 0 && after.behind > 0) {
                        self.store.update({ phase: "conflict", conflict: true, message: "本地与远程都有新提交，请先处理分叉" });
                        return { success: false, conflict: true, error: "本地与远程历史已分叉" };
                    }
                    if (after.behind > 0) {
                        self.store.update({ phase: "resolving", message: "正在安全快进远程改动…" });
                        return self.adapter.fastForward(after.root, after.upstream || self.settings("remoteName", "origin") + "/" + after.branch).then(function (merged) {
                            if (!merged.success) return self._fail(formatGitError(merged.error));
                            return self._refresh().then(function () { return self._pushIfNeeded(); });
                        });
                    }
                    return self._pushIfNeeded();
                });
            });
        });
    };

    SyncEngine.prototype._pushIfNeeded = function () {
        var self = this;
        var state = this.store.get();
        // 新仓库或首次绑定远程时没有 upstream，但本地快照仍需要 push -u。
        if (!state.ahead && !state.behind && state.upstream) {
            self.store.update({ phase: "synced", message: "已与远程同步" });
            return Promise.resolve({ success: true, pushed: false });
        }
        self.store.update({ phase: "pushing", message: "正在推送到远程仓库…" });
        return this.adapter.push(state.root, this.settings("remoteName", "origin"), state.branch || "main").then(function (pushed) {
            if (!pushed.success) return self._fail(formatGitError(pushed.error));
            return self._refresh().then(function () { self.store.update({ phase: "synced", message: "同步完成" }); return { success: true, pushed: true }; });
        });
    };

    SyncEngine.prototype.fetch = function () {
        var self = this;
        return this.enqueue(function () {
            var state = self.store.get();
            if (!state.isRepo || !state.remoteUrl) return self._fail("当前仓库没有可用的远程仓库");
            self.store.update({ phase: "fetching", message: "正在获取远程状态…" });
            return self.adapter.fetch(state.root, self.settings("remoteName", "origin")).then(function (result) {
                if (!result.success) return self._fail(formatGitError(result.error));
                return self._refresh().then(function () { return { success: true }; });
            });
        });
    };

    SyncEngine.prototype.diffCurrent = function () {
        var self = this;
        var state = this.store.get();
        var file = this.api.getCurrentFile ? this.api.getCurrentFile() : state.currentFile;
        var relative = this.workspace.relative(state.root, file);
        if (!state.root || !relative) return Promise.resolve({ success: false, error: "当前文档不在同步仓库内" });
        return this.history.diff(state.root, relative).then(function (result) {
            if (result.success) self.store.update({ diff: result.diff });
            return result;
        });
    };

    SyncEngine.prototype.openDiff = function (relativePath) {
        var self = this;
        var state = this.store.get();
        var file = this.api.getCurrentFile ? this.api.getCurrentFile() : state.currentFile;
        var relative = relativePath || this.workspace.relative(state.root, file);
        if (!state.root || !relative) return Promise.resolve(this._fail("当前文档不在同步仓库内"));
        var fileInfo = null;
        var files = state.files || [];
        for (var i = 0; i < files.length; i++) {
            if (files[i].path === relative) {
                fileInfo = files[i];
                break;
            }
        }
        if (!fileInfo) return Promise.resolve(this._fail("该文件没有可显示的未提交差异"));
        return this.history.compareFile(state.root, relative, fileInfo).then(function (result) {
            if (!result.success) return self._fail(result.error);
            var opened = self._openDiffModel(result);
            if (!opened.success) return self._fail(opened.error);
            return result;
        });
    };

    SyncEngine.prototype.openSnapshotDetail = function (revision) {
        var self = this;
        var state = this.store.get();
        if (!state.root || !state.isRepo || !revision) return Promise.resolve(this._fail("无法读取快照详情"));
        return this.history.loadCommitFiles(state.root, revision).then(function (result) {
            if (!result.success) return self._fail(result.error || "无法读取快照文件");
            var commit = null;
            var commits = state.commits || [];
            for (var i = 0; i < commits.length; i++) if (commits[i].hash === revision) commit = commits[i];
            self.store.update({ historyDetail: { hash: revision, message: commit ? commit.message : "快照 " + String(revision).substring(0, 7), date: commit ? commit.date : "", files: result.files || [], compareMode: "worktree" }, error: "" });
            return { success: true, files: result.files || [] };
        });
    };

    SyncEngine.prototype.closeSnapshotDetail = function () {
        this.store.update({ historyDetail: null });
    };

    /* 历史详情中的模式只影响接下来打开的文件比较，不改变快照或工作区内容。 */
    SyncEngine.prototype.setSnapshotCompareMode = function (mode) {
        var state = this.store.get();
        var detail = state.historyDetail;
        if (!detail) return { success: false, error: "请先打开一个快照详情" };
        var next = mode === "parent" ? "parent" : "worktree";
        if (detail.compareMode === next) return { success: true, mode: next };
        var updated = {};
        var keys = Object.keys(detail);
        for (var i = 0; i < keys.length; i++) updated[keys[i]] = detail[keys[i]];
        updated.compareMode = next;
        this.store.update({ historyDetail: updated, error: "" });
        return { success: true, mode: next };
    };

    SyncEngine.prototype.openSnapshotDiff = function (revision, filePath, mode) {
        var self = this;
        var state = this.store.get();
        var detail = state.historyDetail;
        if (!state.root || !detail || detail.hash !== revision) return Promise.resolve(this._fail("快照详情已失效，请重新打开"));
        var fileInfo = null;
        var files = detail.files || [];
        for (var i = 0; i < files.length; i++) if (files[i].path === filePath) fileInfo = files[i];
        if (!fileInfo) return Promise.resolve(this._fail("未找到该快照中的文件"));
        var compareMode = mode === "parent" ? "parent" : (detail.compareMode === "parent" ? "parent" : "worktree");
        var comparison = compareMode === "parent"
            ? this.history.compareSnapshotFile(state.root, revision, fileInfo)
            : this.history.compareSnapshotToWorktree(state.root, revision, fileInfo);
        return comparison.then(function (result) {
            if (!result.success) return self._fail(result.error);
            result.compareMode = compareMode;
            // 二进制内容不能安全地经 UTF-8 恢复，仍可明确查看其比较状态。
            if (!result.isBinary) {
                result.restore = {
                    revision: revision,
                    filePath: fileInfo.path,
                    mode: compareMode === "parent" ? (result.afterMissing ? "delete" : "restore") : (result.beforeMissing ? "delete" : "restore")
                };
            }
            var opened = self._openDiffModel(result);
            if (!opened.success) return self._fail(opened.error);
            return result;
        });
    };

    /*
     * 确认已由 DiffSession 完成后才会调用本方法。
     * 写入前保存当前活动文档，写入后强制重载，避免内存中的编辑器内容
     * 与磁盘文件分叉；恢复本身不创建提交也不触发同步。
     */
    SyncEngine.prototype.restoreSnapshotFile = function (revision, filePath) {
        var self = this;
        return this.enqueue(function () {
            var state = self.store.get();
            var detail = state.historyDetail;
            if (!state.root || !detail || detail.hash !== revision) return self._fail("快照详情已失效，请重新打开");
            var fileInfo = findSnapshotFile(detail.files || [], filePath);
            if (!fileInfo) return self._fail("未找到该快照中的文件");
            var target = path.resolve(state.root, fileInfo.path);
            var currentFile = self.api.getCurrentFile ? self.api.getCurrentFile() : state.currentFile;
            var reloadCurrent = samePath(currentFile, target);
            self.store.update({ phase: "restoring", message: "正在从快照恢复文件…", error: "" });
            return self.history.readSnapshotFile(state.root, revision, fileInfo.path).then(function (snapshot) {
                if (!snapshot || !snapshot.success) return snapshot;
                if (snapshot.binary) return self._fail("二进制文件暂不支持恢复，避免损坏原始内容");
                // Typora 正在编辑的文件不能直接从磁盘删除，否则编辑器内存仍可
                // 继续保存并重新创建它；要求先切换文档是更安全的原生语义。
                if (snapshot.missing && reloadCurrent) return self._fail("请先切换至其他文档，再恢复此快照的删除状态");
                var saveCurrent = reloadCurrent ? self._saveAndWait() : Promise.resolve({ success: true });
                return saveCurrent.then(function (saved) {
                    if (!saved.success) return self._fail("当前文档未能保存，已取消恢复");
                    var operation = snapshot.missing
                        ? self.adapter.removeWorktreeFile(state.root, fileInfo.path)
                        : self.adapter.writeWorktreeFile(state.root, fileInfo.path, snapshot.output || "");
                    return operation.then(function (written) {
                        if (!written.success) return self._fail(written.error || "无法恢复快照文件");
                        return self._refresh().then(function () {
                            if (reloadCurrent) self._reloadFile(target);
                            var action = snapshot.missing ? "已按快照删除文件" : "已从快照恢复文件";
                            self.store.update({ phase: "restored", message: action, error: "" });
                            return { success: true, deleted: !!snapshot.missing, path: fileInfo.path };
                        });
                    });
                });
            }).then(function (result) {
                if (!result || !result.success) return result && result.error ? result : self._fail("恢复快照失败");
                return result;
            }).catch(function (error) { return self._fail(error.message || "恢复快照失败"); });
        });
    };

    SyncEngine.prototype._openDiffModel = function (model) {
        if (!window.BetterTypora.commands.has || !window.BetterTypora.commands.has("split-view:open-diff")) {
            return { success: false, error: "分屏插件不可用，无法打开差异视图" };
        }
        var opened = window.BetterTypora.commands.execute("split-view:open-diff", model);
        return opened === false ? { success: false, error: "无法打开差异视图" } : { success: true };
    };

    SyncEngine.prototype._reloadFile = function (filePath) {
        try {
            if (this.api.reloadFile && this.api.reloadFile(filePath)) return true;
            if (this.api.openFile) this.api.openFile(filePath);
        } catch (e) {
            this.logger.warn("恢复后重载文档失败", e);
        }
        return false;
    };

    SyncEngine.prototype.loadHistory = function () {
        var state = this.store.get();
        if (!state.root || !state.isRepo) return Promise.resolve({ success: false, error: "当前还不是 Git 仓库" });
        return this.history.load(state.root, 20);
    };

    SyncEngine.prototype._ensureRepo = function () {
        var self = this;
        var state = this.store.get();
        if (state.isRepo && state.root) return Promise.resolve({ success: true, root: state.root });
        return this._refresh().then(function (result) {
            var current = self.store.get();
            return current.isRepo && current.root ? { success: true, root: current.root } : self._fail("当前工作区还不是 Git 仓库，请先初始化");
        });
    };

    SyncEngine.prototype._saveAndWait = function () {
        if (this.api.saveFileAndWait) return this.api.saveFileAndWait(12000);
        if (this.api.saveFile) this.api.saveFile();
        return Promise.resolve({ success: true, reason: "legacy-save" });
    };

    SyncEngine.prototype._fail = function (message) {
        var text = message || "Git 操作失败";
        this.store.update({ phase: "git-error", error: text, message: text });
        return Promise.resolve({ success: false, error: text });
    };

    function defaultMessage(currentFile) {
        var name = currentFile ? path.basename(currentFile) : "笔记";
        return "notes: 保存「" + name + "」";
    }

    function findSnapshotFile(files, filePath) {
        for (var i = 0; i < files.length; i++) if (files[i].path === filePath) return files[i];
        return null;
    }

    function samePath(left, right) {
        if (!left || !right) return false;
        var a = path.resolve(String(left));
        var b = path.resolve(String(right));
        return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
    }

    function formatGitError(error) {
        var text = String(error || "Git 操作失败");
        if (/terminal prompts disabled|authentication|permission denied|could not read username|publickey/i.test(text)) return "远程认证失败，请检查 SSH 或系统 Git 凭证管理器";
        if (/author identity unknown|user\.name|user\.email|empty ident name/i.test(text)) return "Git 尚未配置提交身份，请先设置 user.name 和 user.email";
        if (/not a git repository/i.test(text)) return "当前目录不是 Git 仓库";
        return text;
    }

    if (typeof module !== "undefined") module.exports = SyncEngine;
})();
