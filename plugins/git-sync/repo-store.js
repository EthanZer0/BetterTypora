/**
 * Git Plugin — 仓库状态缓存
 * ===============================
 * 追踪当前仓库的状态，作为 UI 的单一数据源。
 * 所有 UI 组件状态变化都必须更新到这里。
 */
(function () {
    "use strict";

    var path = reqnode("path");

    /**
     * @param {Object} gitCore - git-core.js 的导出
     */
    function RepoStore(gitCore) {
        this._git = gitCore;
        this.state = {
            // 仓库基础信息
            repoPath: null,
            isRepo: false,
            isDetected: false,

            // Git 状态
            branch: "",
            files: [],          // [{path, status}]
            aheadCount: 0,
            behindCount: 0,

            // 提交历史缓存
            commits: [],        // [{hash, message, author, date, refs}]
            lastCommitHash: "",

            // 当前文件信息
            currentFilePath: null,
            currentFileStatus: null,

            // 远程信息
            remotes: [],        // [{name, url, type}]

            // UI 状态
            lastUpdate: 0,
            isLoading: false,
            operationError: null // 最后一次 Git 操作错误
        };

        this._callbacks = {
            onStatusChanged: null,   // function(newState)
            onHistoryChanged: null,  // function(commits)
            onError: null            // function(operation, error)
        };
    }

    /**
     * 检测仓库 — 从文件路径向上查找 .git 目录
     * @param {string} startPath — 起始路径 (通常是 BetterTypora.getMountFolder() 结果)
     */
    RepoStore.prototype.detectRepo = function (startPath) {
        var fs = reqnode("fs");
        var dir = startPath;
        var root = null;

        // 若 startPath 本身就是 git 仓库 (含 .git 目录)
        if (dir && typeof dir === "string" && fs.existsSync(path.join(dir, ".git"))) {
            root = dir;
        } else if (dir && typeof dir === "string") {
            // 向上查找
            while (dir && dir !== path.dirname(dir)) {
                if (fs.existsSync(path.join(dir, ".git"))) {
                    root = dir;
                    break;
                }
                dir = path.dirname(dir);
            }
        }

        if (root) {
            this.state.repoPath = root;
            this.state.isRepo = true;
            this.state.isDetected = true;
            return true;
        }

        // 未找到 .git，但仍记录路径（可能需要在设置中初始化）
        this.state.repoPath = startPath || null;
        this.state.isRepo = false;
        this.state.isDetected = true;
        return false;
    };

    /**
     * 强制设置仓库路径（用于初始化后）
     */
    RepoStore.prototype.setRepo = function (repoPath) {
        this.state.repoPath = repoPath;
        this.state.isRepo = true;
        this.state.isDetected = true;
    };

    /**
     * 刷新 Git 状态
     */
    RepoStore.prototype.refreshStatus = function () {
        if (!this.state.repoPath || !this.state.isRepo) {
            return Promise.resolve(null);
        }

        var self = this;
        this.state.isLoading = true;
        this.state.operationError = null;

        return this._git.status(this.state.repoPath).then(function (result) {
            self.state.isLoading = false;
            if (result.success) {
                self.state.branch = result.branch || "";
                self.state.files = result.files || [];
                self.state.aheadCount = typeof result.aheadCount === "number" ? result.aheadCount : self.state.aheadCount;
                self.state.behindCount = typeof result.behindCount === "number" ? result.behindCount : self.state.behindCount;
                self.state.lastUpdate = Date.now();

                // 更新当前文件状态
                if (self.state.currentFilePath) {
                    var rel = self._relativePath(self.state.currentFilePath);
                    self.state.currentFileStatus = self._findFileStatus(rel);
                }
            } else {
                self.state.operationError = result.error || "git status 失败";
            }

            if (self._callbacks.onStatusChanged) {
                self._callbacks.onStatusChanged(self.state);
            }

            return result;
        });
    };

    /**
     * 刷新提交历史
     */
    RepoStore.prototype.refreshHistory = function (maxCount) {
        if (!this.state.repoPath || !this.state.isRepo) {
            return Promise.resolve(null);
        }

        var self = this;
        maxCount = maxCount || 50;
        this.state.isLoading = true;

        return this._git.log(this.state.repoPath, maxCount).then(function (result) {
            self.state.isLoading = false;
            if (result.success) {
                self.state.commits = result.commits || [];
                if (self.state.commits.length > 0) {
                    self.state.lastCommitHash = self.state.commits[0].hash;
                }
                self.state.lastUpdate = Date.now();
            } else {
                self.state.operationError = result.error || "git log 失败";
            }

            if (self._callbacks.onHistoryChanged) {
                self._callbacks.onHistoryChanged(self.state.commits);
            }

            return result;
        });
    };

    /**
     * 刷新远程信息
     */
    RepoStore.prototype.refreshRemotes = function () {
        if (!this.state.repoPath || !this.state.isRepo) {
            return Promise.resolve(null);
        }

        var self = this;
        return this._git.getRemotes(this.state.repoPath).then(function (result) {
            if (result.success) {
                self.state.remotes = result.remotes || [];
            }
            return result;
        });
    };

    /**
     * 刷新所有状态
     */
    RepoStore.prototype.refreshAll = function () {
        var self = this;
        return this.refreshStatus().then(function () {
            return self.refreshHistory();
        }).then(function () {
            return self.refreshRemotes();
        });
    };

    /**
     * 获取指定文件在 git status 中的状态
     */
    RepoStore.prototype.getFileStatus = function (filePath) {
        var rel = this._relativePath(filePath);
        return this._findFileStatus(rel);
    };

    /**
     * 获取改动文件数（不含 ignored）
     */
    RepoStore.prototype.getChangeCount = function () {
        if (!this.state.files) return 0;
        var count = 0;
        for (var i = 0; i < this.state.files.length; i++) {
            var s = this.state.files[i].status;
            // 排除 ignored (!)
            if (s !== "!") count++;
        }
        return count;
    };

    /**
     * 获取未暂存文件数
     */
    RepoStore.prototype.getUnstagedCount = function () {
        if (!this.state.files) return 0;
        var count = 0;
        for (var i = 0; i < this.state.files.length; i++) {
            var s = this.state.files[i].status;
            // " M" (index 未改但工作区改了) 或 "??" (未跟踪)
            if (s === " M" || s === "??" || s === " D" || s === "MM") count++;
        }
        return count;
    };

    /**
     * 设置当前文件路径
     */
    RepoStore.prototype.setCurrentFile = function (filePath) {
        this.state.currentFilePath = filePath;
        if (filePath) {
            var rel = this._relativePath(filePath);
            this.state.currentFileStatus = this._findFileStatus(rel);
        } else {
            this.state.currentFileStatus = null;
        }
    };

    /**
     * 清除所有状态
     */
    RepoStore.prototype.clear = function () {
        this.state.repoPath = null;
        this.state.isRepo = false;
        this.state.isDetected = false;
        this.state.branch = "";
        this.state.files = [];
        this.state.aheadCount = 0;
        this.state.behindCount = 0;
        this.state.commits = [];
        this.state.lastCommitHash = "";
        this.state.currentFilePath = null;
        this.state.currentFileStatus = null;
        this.state.remotes = [];
        this.state.lastUpdate = 0;
        this.state.isLoading = false;
        this.state.operationError = null;
    };

    /**
     * 设置回调
     */
    RepoStore.prototype.on = function (event, callback) {
        if (event === "statusChanged") this._callbacks.onStatusChanged = callback;
        if (event === "historyChanged") this._callbacks.onHistoryChanged = callback;
        if (event === "error") this._callbacks.onError = callback;
    };

    // ===================================================================
    // 内部方法
    // ===================================================================

    RepoStore.prototype._relativePath = function (filePath) {
        if (!filePath || !this.state.repoPath) return filePath;
        var repoPath = this.state.repoPath.replace(/\\/g, "/").toLowerCase();
        filePath = filePath.replace(/\\/g, "/").toLowerCase();
        // 用 repoPath + "/" 做前缀匹配，防止 "D:/project" 误匹配 "D:/project-backup"
        if (filePath.indexOf(repoPath + "/") === 0) {
            return filePath.substring(repoPath.length + 1);
        }
        if (filePath === repoPath) return "";
        return filePath;
    };

    RepoStore.prototype._findFileStatus = function (relativePath) {
        if (!this.state.files || !relativePath) return null;
        var rp = relativePath.replace(/\\/g, "/");
        for (var i = 0; i < this.state.files.length; i++) {
            var f = this.state.files[i];
            // 精确匹配（git status --porcelain 总是返回 repo-root 相对路径）
            if (f.path.replace(/\\/g, "/") === rp) {
                return f.status;
            }
        }
        return null;
    };

    // ===================================================================
    // 导出
    // ===================================================================

    module.exports = RepoStore;

})();
