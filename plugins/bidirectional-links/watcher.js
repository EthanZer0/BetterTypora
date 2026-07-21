/**
 * Bidirectional Links — File Watcher
 * ===================================
 * 文件监控策略（无 chokidar，纯 Node.js 内置 API）：
 *
 *   1. 轮询（主）：每 N 秒对索引中的文件做 fs.statSync，比较 mtime。
 *      变了的入队重索引。
 *   2. 保存钩子（辅助）：MutationObserver 监听 <title> 文本。
 *      当 `*` 后缀消失 → 文件刚保存 → 触发当前文件重索引。
 *   3. 窗口焦点（辅助）：window focus 时检查当前文件 mtime。
 *
 * 分批处理：每个 tick 最多处理 50 个文件的 stat，大 vault 不阻塞 UI。
 */

(function () {
    "use strict";

    /**
     * @param {object} index — LinkIndex 实例
     * @param {function} onFileChanged — 回调 (filePath)，文件内容变更时调用
     * @param {object} options
     *   pollIntervalMs: 轮询间隔（默认 2000）
     *   batchSize: 每批 stat 的数量（默认 50）
     */
    function FileWatcher(index, onFileChanged, options) {
        this._index = index;
        this._onFileChanged = onFileChanged;
        this._options = options || {};
        this._pollIntervalMs = this._options.pollIntervalMs || 2000;
        this._batchSize = this._options.batchSize || 50;

        this._pollTimer = null;
        this._titleObserver = null;
        this._focusHandler = null;
        this._pendingFiles = []; // 待重索引的文件队列
        this._processTimer = null;
        this._running = false;
    }

    /**
     * 启动所有监控
     */
    FileWatcher.prototype.start = function () {
        if (this._running) return;
        this._running = true;

        this._startPolling();
        this._startSaveHook();
        this._startFocusHook();
    };

    /**
     * 停止所有监控
     */
    FileWatcher.prototype.stop = function () {
        this._running = false;

        if (this._pollTimer) {
            clearTimeout(this._pollTimer);
            this._pollTimer = null;
        }
        if (this._processTimer) {
            clearTimeout(this._processTimer);
            this._processTimer = null;
        }
        if (this._titleObserver) {
            this._titleObserver.disconnect();
            this._titleObserver = null;
        }
        if (this._focusHandler) {
            window.removeEventListener("focus", this._focusHandler);
            this._focusHandler = null;
        }
        this._pendingFiles = [];
    };

    /**
     * 手动触发文件重索引（如保存后）
     */
    FileWatcher.prototype.onFileSaved = function (filePath) {
        if (!filePath) return;
        this._enqueue(filePath);
    };

    // ===================================================================
    // 轮询
    // ===================================================================

    FileWatcher.prototype._startPolling = function () {
        var self = this;
        var files = this._index.allMdFiles;
        var currentIdx = 0;

        function tick() {
            if (!self._running) return;

            // 获取当前批次
            var batch = [];
            var batchSize = self._batchSize;
            var total = files.length;

            if (total === 0) {
                self._pollTimer = setTimeout(tick, self._pollIntervalMs);
                return;
            }

            for (var i = 0; i < batchSize && currentIdx < total; i++, currentIdx++) {
                batch.push(files[currentIdx]);
            }

            // 检查这批文件的 mtime
            for (var j = 0; j < batch.length; j++) {
                try {
                    var filePath = batch[j];
                    var oldMtime = self._index.fileMTimes.get(filePath);
                    var stat = self._index._fs.statSync(filePath);
                    if (!oldMtime || stat.mtimeMs !== oldMtime) {
                        self._enqueue(filePath);
                    }
                } catch (e) {
                    // 文件可能已被删除
                    if (e.code === "ENOENT") {
                        self._enqueue(batch[j]); // 触发删除处理
                    }
                }
            }

            // 轮完一圈后重置
            if (currentIdx >= total) {
                currentIdx = 0;
                // 同步更新 files 和 total
                files = self._index.allMdFiles;
                total = files.length;
            }

            // 下一批（用 setTimeout 让出主线程）
            self._pollTimer = setTimeout(tick, Math.max(100, self._pollIntervalMs / Math.ceil(total / batchSize)));
        }

        // 启动第一次
        this._pollTimer = setTimeout(tick, 500); // 首次延迟 500ms
    };

    // ===================================================================
    // 保存钩子
    // ===================================================================

    FileWatcher.prototype._startSaveHook = function () {
        var self = this;
        var titleEl = document.querySelector("title");
        if (!titleEl) return;

        var wasDirty = document.title.endsWith("*");

        this._titleObserver = new MutationObserver(function () {
            var nowDirty = document.title.endsWith("*");
            // 从 dirty 变为 clean → 文件已保存
            if (wasDirty && !nowDirty) {
                var filePath = self._getCurrentFilePath();
                if (filePath) {
                    // 延迟 500ms 再读取，确保 Typora 已完成磁盘写入
                    setTimeout(function () {
                        self.onFileSaved(filePath);
                    }, 500);
                }
            }
            wasDirty = nowDirty;
        });

        this._titleObserver.observe(titleEl, {
            characterData: true,
            childList: true,
            subtree: true,
        });
    };

    // ===================================================================
    // 焦点钩子
    // ===================================================================

    FileWatcher.prototype._startFocusHook = function () {
        var self = this;
        this._focusHandler = function () {
            var filePath = self._getCurrentFilePath();
            if (filePath) {
                // 检查当前文件是否被外部修改
                try {
                    var oldMtime = self._index.fileMTimes.get(filePath);
                    var stat = self._index._fs.statSync(filePath);
                    if (!oldMtime || stat.mtimeMs !== oldMtime) {
                        self._enqueue(filePath);
                    }
                } catch (e) { /* ignore */ }
            }
        };
        window.addEventListener("focus", this._focusHandler);
    };

    // ===================================================================
    // 队列处理
    // ===================================================================

    FileWatcher.prototype._enqueue = function (filePath) {
        // 去重
        if (this._pendingFiles.indexOf(filePath) >= 0) return;
        this._pendingFiles.push(filePath);

        // 延迟处理：积累同一批的变更，100ms 后批量处理
        if (!this._processTimer) {
            var self = this;
            this._processTimer = setTimeout(function () {
                self._processQueue();
            }, 100);
        }
    };

    FileWatcher.prototype._processQueue = function () {
        var self = this;
        var pending = this._pendingFiles.slice();
        this._pendingFiles = [];
        this._processTimer = null;

        for (var i = 0; i < pending.length; i++) {
            try {
                this._onFileChanged(pending[i]);
            } catch (e) {
                // 忽略单个文件的处理错误
            }
        }
    };

    // ===================================================================
    // 辅助
    // ===================================================================

    FileWatcher.prototype._getCurrentFilePath = function () {
        try {
            if (typeof File !== "undefined" && File.bundle && File.bundle.filePath) {
                return File.bundle.filePath;
            }
        } catch (e) { /* ignore */ }
        return null;
    };

    module.exports = FileWatcher;
})();
