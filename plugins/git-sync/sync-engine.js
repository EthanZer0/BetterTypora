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
        var initial = this.workspace.context();
        this.store.update({ phase: "checking", root: initial.root, currentFile: initial.currentFile, error: "", conflict: false });
        return this.workspace.resolve().then(function (resolved) {
            var context = resolved.context || initial;
            if (!resolved.success) {
                self.store.update({ phase: "idle", root: context.root, currentFile: context.currentFile, isRepo: false, mode: context.mode || "", scopePath: "", scopeLabel: "", suggestedScope: context.suggestedScope || "inbox", needsSetup: true, setupView: "choose", branch: "", files: [], ahead: 0, behind: 0, remoteUrl: "", message: resolved.error || "请先打开一个 Markdown 文件" });
                return { success: true, isRepo: false, context: context };
            }
            if (!resolved.isRepo) {
                self.store.update({ phase: "idle", root: resolved.root, currentFile: context.currentFile, isRepo: false, mode: context.mode || "", scopePath: context.scopePath || "", scopeLabel: context.scopeLabel || "", suggestedScope: context.suggestedScope || "inbox", needsSetup: true, setupView: "choose", branch: "", files: [], ahead: 0, behind: 0, remoteUrl: "", message: "当前文件尚未启用版本管理" });
                return { success: true, isRepo: false, root: resolved.root, context: context };
            }
            if (resolved.needsSetup) {
                self.store.update({ phase: "setup", root: resolved.root, currentFile: context.currentFile, isRepo: true, mode: "unified", scopePath: "", scopeLabel: "", suggestedScope: context.suggestedScope || "inbox", needsSetup: true, setupView: "scope", branch: "", files: [], ahead: 0, behind: 0, remoteUrl: "", message: "当前文件尚未加入统一笔记仓库" });
                return { success: true, isRepo: true, root: resolved.root, context: context, needsSetup: true };
            }
            return self._readRepoState(resolved.root, context.scopePath, context.mode, context.profile && context.profile.remoteName).then(function (state) {
                self.store.update({ phase: state.files.length ? "dirty" : "synced", isRepo: true, root: resolved.root, currentFile: context.currentFile, mode: context.mode || "local", scopePath: context.scopePath || "", scopeLabel: context.scopeLabel || "当前文件夹", suggestedScope: context.suggestedScope || "inbox", needsSetup: false, setupView: "", branch: state.branch, upstream: state.upstream, files: state.files, ahead: state.ahead, behind: state.behind, remoteUrl: state.remoteUrl, remoteName: state.remoteName, message: state.files.length ? "有未保存到 Git 的改动" : "工作区干净", error: "", conflict: false });
                return { success: true, isRepo: true, root: resolved.root, mode: context.mode || "local", state: state };
            });
        });
    };

    SyncEngine.prototype._readRepoState = function (root, scopePath, mode, remoteName) {
        var remote = mode === "unified" ? (remoteName || this.settings("remoteName", "origin")) : "";
        return Promise.all([
            this.adapter.status(root, scopePath),
            remote ? this.adapter.remoteUrl(root, remote) : Promise.resolve({ success: true, output: "" })
        ]).then(function (results) {
            var status = results[0];
            if (!status.success) return Promise.reject(new Error(status.error));
            return { branch: status.status.branch || "main", upstream: status.status.upstream || "", files: status.status.files || [], ahead: status.status.ahead || 0, behind: status.status.behind || 0, remoteUrl: remote && results[1].success ? results[1].output : "", remoteName: remote || "" };
        });
    };

    /* 兼容旧命令：未选择模式时默认进入本地文件夹模式。 */
    SyncEngine.prototype.initRepo = function () {
        return this.initLocal();
    };

    SyncEngine.prototype.initLocal = function (root) {
        var self = this;
        return this.enqueue(function () {
            var prepared = self.workspace.prepareLocal(root);
            if (!prepared.success) return self._fail(prepared.error);
            self.store.update({ phase: "checking", root: prepared.root, error: "" });
            return self._ensureInitializedRepository(prepared.root).then(function (result) {
                if (!result.success) return self._fail(result.error);
                self.workspace.profiles.registerLocal(prepared.root);
                return self._refresh().then(function () { return result; });
            }).catch(function (err) { return self._fail(err.message); });
        });
    };

    /*
     * 统一模式会把当前文件纳入一个明确的 scope。若文件在仓库外，只在用户点击
     * 初始化后复制一份到统一仓库，原始文件保持不动。
     */
    SyncEngine.prototype.initUnified = function (root, scopePath, remoteUrl) {
        var self = this;
        return this.enqueue(function () {
            var prepared = self.workspace.prepareUnified(root, scopePath);
            if (!prepared.success) return self._fail(prepared.error);
            self.store.update({ phase: "checking", root: prepared.root, error: "", message: prepared.imported ? "正在导入当前笔记…" : "正在设置统一笔记仓库…" });
            return self._saveAndWait().then(function (saved) {
                if (!saved.success && saved.reason === "timeout") return self._fail("保存当前文档超时，已停止导入");
                try { fs.mkdirSync(prepared.root, { recursive: true }); } catch (error) { return self._fail("无法创建统一笔记仓库目录：" + error.message); }
                return self._ensureInitializedRepository(prepared.root).then(function (initialized) {
                    if (!initialized.success) return self._fail(initialized.error);
                    var managedFile = prepared.currentFile;
                    try {
                        if (prepared.imported) managedFile = self.workspace.importCurrentFile(prepared);
                    } catch (importError) {
                        return self._fail("无法导入当前笔记：" + importError.message);
                    }
                    self.workspace.profiles.registerUnified(prepared.root, prepared.scopePath, prepared.scopeLabel);
                    if (!remoteUrl) return { success: true, managedFile: managedFile, imported: prepared.imported };
                    return self.adapter.setRemote(prepared.root, "origin", remoteUrl).then(function (remoteResult) {
                        if (!remoteResult.success) return remoteResult;
                        self.workspace.profiles.setRemote(prepared.root, "origin");
                        return { success: true, managedFile: managedFile, imported: prepared.imported };
                    });
                });
            }).then(function (result) {
                if (!result.success) return self._fail(formatGitError(result.error));
                if (result.imported && result.managedFile) {
                    var opener = self.api.openFileInCurrentWindow || self.api.openFile;
                    if (opener) opener(result.managedFile);
                }
                return self._refresh().then(function () {
                    self.store.update({ message: result.imported ? "已复制当前笔记到统一仓库，原文件未改动" : "已加入统一笔记仓库", error: "" });
                    return result;
                });
            }).catch(function (error) { return self._fail(error.message || "无法设置统一笔记仓库"); });
        });
    };

    SyncEngine.prototype.configureRemote = function (url) {
        var self = this;
        return this.enqueue(function () {
            var state = self.store.get();
            if (!state.isRepo || state.mode !== "unified") return self._fail("仅统一笔记仓库可以配置远程同步");
            self.store.update({ phase: "checking", error: "", message: "正在连接远程仓库…" });
            return self.adapter.setRemote(state.root, self._remoteName(state), url).then(function (result) {
                if (!result.success) return self._fail(formatGitError(result.error));
                self.workspace.profiles.setRemote(state.root, self._remoteName(state));
                return self._refresh().then(function () {
                    self.store.update({ message: "已连接远程笔记仓库", error: "" });
                    return { success: true };
                });
            });
        });
    };

    /* 检测或生成本机默认 SSH 密钥，并只把公钥交给界面。私钥永不进入状态或日志。 */
    SyncEngine.prototype.prepareSshKey = function () {
        var self = this;
        return this.enqueue(function () {
            var state = self.store.get();
            if (!state.isRepo || state.mode !== "unified") return self._fail("SSH 密钥助手仅适用于统一笔记仓库");
            self.store.update({ phase: "checking", error: "", message: "正在检查本机 SSH 密钥…", sshKeyStatus: "checking" });
            var found = self.adapter.findSshKey();
            var operation = found.found ? Promise.resolve({ success: true, generated: false, info: found }) : self.adapter.generateSshKey("BetterTypora Git Sync");
            return operation.then(function (generated) {
                if (!generated.success) return self._fail(generated.error || "无法生成 SSH 密钥");
                return self.adapter.readSshPublicKey(generated.info).then(function (publicResult) {
                    if (!publicResult.success) return self._fail(publicResult.error || "无法读取 SSH 公钥");
                    self.store.update({ sshPublicKey: publicResult.publicKey, sshKeyStatus: generated.generated ? "generated" : "found", phase: "synced", error: "", message: generated.generated ? "已生成 SSH 密钥，公钥已复制" : "已找到 SSH 密钥，公钥已复制" });
                    return self._copyText(publicResult.publicKey).then(function (copied) {
                        self.store.update({ message: copied ? (generated.generated ? "已生成 SSH 密钥，公钥已复制" : "已找到 SSH 密钥，公钥已复制") : "已找到 SSH 公钥，请点击复制按钮" });
                        return { success: true, generated: !!generated.generated, copied: copied, publicKey: publicResult.publicKey };
                    });
                });
            }).catch(function (error) { return self._fail(error.message || "SSH 密钥处理失败"); });
        });
    };

    SyncEngine.prototype.copySshPublicKey = function () {
        var self = this;
        var key = this.store.get().sshPublicKey;
        if (!key) return this.prepareSshKey();
        return this._copyText(key).then(function (copied) {
            self.store.update({ message: copied ? "公钥已复制到剪贴板" : "复制失败，请手动选择公钥" });
            return { success: copied, copied: copied, publicKey: key, error: copied ? "" : "无法访问系统剪贴板" };
        });
    };

    SyncEngine.prototype._copyText = function (value) {
        try {
            var electron = reqnode("electron");
            if (electron && electron.clipboard && electron.clipboard.writeText) {
                electron.clipboard.writeText(String(value || ""));
                return Promise.resolve(true);
            }
        } catch (e) {}
        try {
            if (typeof navigator !== "undefined" && navigator.clipboard && navigator.clipboard.writeText) return navigator.clipboard.writeText(String(value || "")).then(function () { return true; }, function () { return false; });
        } catch (error) {}
        return Promise.resolve(false);
    };

    SyncEngine.prototype.showSetup = function (view) {
        var state = this.store.get();
        if (view === "back") view = state.isRepo && !state.needsSetup ? "" : "choose";
        this.store.update({ setupView: view === undefined || view === null ? "choose" : view, error: "", message: state.message || "请选择笔记管理方式" });
        return { success: true };
    };

    SyncEngine.prototype._ensureInitializedRepository = function (root) {
        var self = this;
        return this.adapter.isRepo(root).then(function (check) {
            if (check.success) return { success: true, existed: true };
            return self.adapter.init(root).then(function (init) {
                if (!init.success) return init;
                try {
                    var ignorePath = path.join(root, ".gitignore");
                    if (!fs.existsSync(ignorePath)) fs.writeFileSync(ignorePath, IGNORE_CONTENT, "utf8");
                } catch (e) {
                    return { success: false, error: "无法创建 .gitignore：" + e.message };
                }
                return self.adapter.renameDefaultBranch(root).then(function () {
                    return { success: true, existed: false };
                });
            });
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
                    var paths = self._scopePaths(current);
                    return self.adapter.addAll(current.root, paths).then(function (added) {
                        if (!added.success) return self._fail(added.error);
                        var text = message || defaultMessage(current.currentFile, current.scopeLabel);
                        return self.adapter.commit(current.root, text, paths).then(function (committed) {
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
        var initial = this.store.get();
        if (!initial.isRepo || initial.mode !== "unified") return this._fail("远程同步仅在统一笔记仓库模式可用");
        return this._saveSnapshot().then(function (snapshot) {
            if (!snapshot.success) return snapshot;
            var state = self.store.get();
            if (!state.remoteUrl) {
                return self._fail("尚未连接远程笔记仓库，请先在面板中设置 GitHub 仓库地址");
            }
            self.store.update({ phase: "fetching", message: "正在检查远程仓库…", error: "" });
            return self.adapter.fetch(state.root, self._remoteName(state)).then(function (fetched) {
                if (!fetched.success) return self._fail(formatGitError(fetched.error));
                return self._refresh().then(function () {
                    var after = self.store.get();
                    if (after.ahead > 0 && after.behind > 0) {
                        self.store.update({ phase: "conflict", conflict: true, message: "本地与远程都有新提交，请先处理分叉" });
                        return { success: false, conflict: true, error: "本地与远程历史已分叉" };
                    }
                    if (after.behind > 0) {
                        self.store.update({ phase: "resolving", message: "正在安全快进远程改动…" });
                        return self.adapter.fastForward(after.root, after.upstream || self._remoteName(after) + "/" + after.branch).then(function (merged) {
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
        return this.adapter.push(state.root, this._remoteName(state), state.branch || "main").then(function (pushed) {
            if (!pushed.success) return self._fail(formatGitError(pushed.error));
            return self._refresh().then(function () { self.store.update({ phase: "synced", message: "同步完成" }); return { success: true, pushed: true }; });
        });
    };

    SyncEngine.prototype.fetch = function () {
        var self = this;
        return this.enqueue(function () {
            var state = self.store.get();
            if (!state.isRepo || state.mode !== "unified") return self._fail("远程同步仅在统一笔记仓库模式可用");
            if (!state.remoteUrl) return self._fail("尚未连接远程笔记仓库");
            self.store.update({ phase: "fetching", message: "正在获取远程状态…" });
            return self.adapter.fetch(state.root, self._remoteName(state)).then(function (result) {
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
        if (!state.root || !relative || !this._isInActiveScope(state, relative)) return Promise.resolve({ success: false, error: "当前文档不在正在管理的笔记工作区内" });
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
        if (!state.root || !relative || !this._isInActiveScope(state, relative)) return Promise.resolve(this._fail("当前文档不在正在管理的笔记工作区内"));
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
        return this.history.loadCommitFiles(state.root, revision, this._scopePaths(state)).then(function (result) {
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
        if (!this._isInActiveScope(state, fileInfo.path)) return Promise.resolve(this._fail("该文件不在当前统一笔记工作区内"));
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
            if (!self._isInActiveScope(state, fileInfo.path)) return self._fail("该文件不在当前统一笔记工作区内");
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
            var opener = this.api.openFileInCurrentWindow || this.api.openFile;
            if (opener) opener(filePath);
        } catch (e) {
            this.logger.warn("恢复后重载文档失败", e);
        }
        return false;
    };

    SyncEngine.prototype.loadHistory = function () {
        var state = this.store.get();
        if (!state.root || !state.isRepo) return Promise.resolve({ success: false, error: "当前还不是 Git 仓库" });
        return this.history.load(state.root, 20, this._scopePaths(state));
    };

    SyncEngine.prototype._ensureRepo = function () {
        var self = this;
        var state = this.store.get();
        if (state.needsSetup) return this._fail("请先将当前文件加入统一笔记工作区");
        if (state.isRepo && state.root) return Promise.resolve({ success: true, root: state.root });
        return this._refresh().then(function (result) {
            var current = self.store.get();
            return current.isRepo && current.root ? { success: true, root: current.root } : self._fail("当前工作区还不是 Git 仓库，请先初始化");
        });
    };

    SyncEngine.prototype._scopePaths = function (state) {
        if (!state || state.mode !== "unified" || !state.scopePath) return null;
        return [state.scopePath];
    };

    SyncEngine.prototype._isInActiveScope = function (state, relativePath) {
        if (!state || state.mode !== "unified") return true;
        return this.workspace.isInScope(state.scopePath, relativePath);
    };

    SyncEngine.prototype._remoteName = function (state) {
        return state && state.remoteName ? state.remoteName : this.settings("remoteName", "origin");
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

    function defaultMessage(currentFile, scopeLabel) {
        var name = currentFile ? path.basename(currentFile) : "笔记";
        return scopeLabel && scopeLabel !== "当前文件夹" && scopeLabel !== "全部笔记"
            ? "notes(" + scopeLabel + "): 保存「" + name + "」"
            : "notes: 保存「" + name + "」";
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
        if (/host key verification failed|remote host identification has changed|offending .* key/i.test(text)) return "SSH 主机指纹验证失败。为保护仓库安全，已拒绝连接；请在系统终端核对 GitHub 主机指纹并更新 SSH known_hosts 后重试";
        if (/terminal prompts disabled|authentication|permission denied|could not read username|publickey/i.test(text)) return "远程认证失败，请检查 SSH 或系统 Git 凭证管理器";
        if (/author identity unknown|user\.name|user\.email|empty ident name/i.test(text)) return "Git 尚未配置提交身份，请先设置 user.name 和 user.email";
        if (/not a git repository/i.test(text)) return "当前目录不是 Git 仓库";
        return text;
    }

    if (typeof module !== "undefined") module.exports = SyncEngine;
})();
