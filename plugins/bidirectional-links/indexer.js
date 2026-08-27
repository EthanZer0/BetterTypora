/**
 * Bidirectional Links — LinkIndex
 * ================================
 * 维护 wikilink 的正向索引和反向索引。核心数据结构:
 *
 *   forwardIndex: Map<sourcePath, Map<targetString, LinkEdge>>
 *   reverseIndex: Map<targetKey, Set<sourcePath>>         ← 由 scanAll/indexFile/removeFile 同步维护
 *   fileMTimes:   Map<filePath, mtimeMs>
 *   allMdFiles:   string[]
 *   vaultRoot:     string
 *
 * 反向索引在 build/update 时同步更新，getBacklinks 为 O(1) 查询。
 * 索引可持久化为 JSON，重启时快速恢复。
 */

(function () {
    "use strict";

    function LinkIndex(cacheDir, fs, pathModule, parser, logger) {
        this._cacheDir = cacheDir;
        this._fs = fs;
        this._path = pathModule;
        this._parser = parser;
        this._logger = logger || { warn: function () {}, log: function () {} };
        this._maxSizeKb = 500; // 由调用方通过 setMaxSizeKb 配置

        this.forwardIndex = new Map();
        this.reverseIndex = new Map();
        this.fileMTimes   = new Map();
        this.allMdFiles   = [];
        this.vaultRoot    = null;
        this.ready        = false; // 索引扫描/加载完成标志 (图谱 vault 切换判断)
    }

    LinkIndex.prototype.setMaxSizeKb = function (kb) { this._maxSizeKb = kb; };

    LinkIndex.prototype._makeEdge = function (parsed) {
        return {
            target: parsed.target,
            alias: parsed.alias || null,
            heading: parsed.heading || null,
            isEmbed: parsed.isEmbed || false,
            lineNumber: null,
        };
    };

    /** 为 target 字符串生成所有可能的反向索引 key */
    LinkIndex.prototype._reverseKeys = function (targetStr, sourcePath) {
        var keys = [];
        // 精确 target 字符串
        keys.push(targetStr);
        // 小写版本（支持大小写不敏感的反向查询）
        keys.push("\x00ci:" + targetStr.toLowerCase());
        return keys;
    };

    /** 同步更新反向索引: 删除旧边，添加新边 */
    LinkIndex.prototype._updateReverse = function (filePath, oldEdgeMap, newEdgeMap) {
        var self = this;
        // 删除旧的反向边
        if (oldEdgeMap) {
            oldEdgeMap.forEach(function (edge, targetStr) {
                var keys = self._reverseKeys(targetStr, filePath);
                for (var k = 0; k < keys.length; k++) {
                    var set = self.reverseIndex.get(keys[k]);
                    if (set) set.delete(filePath);
                }
            });
        }
        // 添加新的反向边
        if (newEdgeMap) {
            newEdgeMap.forEach(function (edge, targetStr) {
                var keys = self._reverseKeys(targetStr, filePath);
                for (var k = 0; k < keys.length; k++) {
                    var set = self.reverseIndex.get(keys[k]);
                    if (!set) {
                        set = new Set();
                        self.reverseIndex.set(keys[k], set);
                    }
                    set.add(filePath);
                }
            });
        }
    };

    /**
     * 全量扫描所有 .md 文件构建索引
     */
    LinkIndex.prototype.scanAll = function (vaultRoot, mdFiles, onProgress) {
        this.vaultRoot = vaultRoot;
        this.allMdFiles = mdFiles.slice();
        this.forwardIndex.clear();
        this.reverseIndex.clear();
        this.fileMTimes.clear();

        var total = mdFiles.length;
        var done = 0;
        var maxSizeKb = this._maxSizeKb;

        for (var i = 0; i < total; i++) {
            var filePath = mdFiles[i];
            try {
                var stat = this._fs.statSync(filePath);
                this.fileMTimes.set(filePath, stat.mtimeMs);

                var sizeKb = stat.size / 1024;
                if (sizeKb > maxSizeKb) {
                    if (!this.forwardIndex.has(filePath)) {
                        this.forwardIndex.set(filePath, new Map());
                    }
                    done++;
                    if (onProgress) onProgress(done, total);
                    continue;
                }

                var content = this._fs.readFileSync(filePath, "utf8");
                var links = this._parser.parseAll(content);

                var oldEdgeMap = this.forwardIndex.get(filePath) || new Map();
                var newEdgeMap = new Map();
                for (var j = 0; j < links.length; j++) {
                    var link = links[j];
                    if (!link.target) continue;
                    if (!newEdgeMap.has(link.target)) {
                        newEdgeMap.set(link.target, this._makeEdge(link));
                    }
                }
                this.forwardIndex.set(filePath, newEdgeMap);
                this._updateReverse(filePath, oldEdgeMap, newEdgeMap);
            } catch (e) {
                this._logger.warn("索引文件失败: " + filePath + " — " + e.message);
                if (!this.forwardIndex.has(filePath)) {
                    this.forwardIndex.set(filePath, new Map());
                }
            }
            done++;
            if (onProgress && done % 50 === 0) onProgress(done, total);
        }
        if (onProgress) onProgress(done, total);
    };

    /**
     * 分批异步扫描：每批处理 8 个文件后 setTimeout 释放主线程，UI 不冻结
     * @param {function} onDone(total, success) — 完成回调
     * @param {function} [onProgress] — 进度回调 (done, total)
     */
    LinkIndex.prototype.scanAsync = function (vaultRoot, mdFiles, onDone, onProgress) {
        // 不清空 forwardIndex / reverseIndex / fileMTimes！
        // 旧索引在异步扫描期间保持可用，新数据逐批覆盖旧数据。
        // 扫描完成后清理已删除的文件。
        var oldFiles = new Set(this.forwardIndex.keys());
        // 快速查找表：新 mdFiles 列表中的文件
        var newSet = {};
        for (var i = 0; i < mdFiles.length; i++) {
            newSet[mdFiles[i]] = true;
        }

        this.vaultRoot = vaultRoot;
        this.allMdFiles = mdFiles.slice();
        this.ready = false;   // 扫描完成前不算就绪 (旧索引可能残留)

        var total = mdFiles.length;
        var done = 0;
        var CHUNK = 8;
        var maxSizeKb = this._maxSizeKb;
        var self = this;

        function processChunk() {
            var startTime = Date.now();
            var budgetMs = 14; // 每批最多占用 14ms，留出余量给浏览器 16ms 帧
            var end = Math.min(done + CHUNK, total);

            for (var i = done; i < end; i++) {
                var filePath = mdFiles[i];
                try {
                    var stat = self._fs.statSync(filePath);
                    self.fileMTimes.set(filePath, stat.mtimeMs);

                    var sizeKb = stat.size / 1024;
                    if (sizeKb > maxSizeKb) {
                        if (!self.forwardIndex.has(filePath)) {
                            self.forwardIndex.set(filePath, new Map());
                        }
                        done++;
                        continue;
                    }

                    var content = self._fs.readFileSync(filePath, "utf8");
                    var links = self._parser.parseAll(content);

                    var oldEdgeMap = self.forwardIndex.get(filePath) || new Map();
                    var newEdgeMap = new Map();
                    for (var j = 0; j < links.length; j++) {
                        var link = links[j];
                        if (!link.target) continue;
                        if (!newEdgeMap.has(link.target)) {
                            newEdgeMap.set(link.target, self._makeEdge(link));
                        }
                    }
                    self.forwardIndex.set(filePath, newEdgeMap);
                    self._updateReverse(filePath, oldEdgeMap, newEdgeMap);
                } catch (e) {
                    self._logger.warn("索引文件失败: " + filePath + " — " + e.message);
                    if (!self.forwardIndex.has(filePath)) {
                        self.forwardIndex.set(filePath, new Map());
                    }
                }
                done++;
            }

            if (onProgress) onProgress(done, total);

            if (done >= total) {
                // 清理旧索引中存在但新 mdFiles 列表中不存在的文件
                oldFiles.forEach(function (f) {
                    if (!newSet[f]) self.removeFile(f);
                });

                self.ready = true;   // 扫描完成 → 索引就绪
                if (onDone) onDone(true);
                return;
            }

            // 超出时间预算则用更长的延迟
            var elapsed = Date.now() - startTime;
            var delay = elapsed > budgetMs ? 20 : 5;
            setTimeout(processChunk, delay);
        }

        setTimeout(processChunk, 1);
    };

    /**
     * 增量更新单个文件的索引
     * @returns {{added: number, removed: number}}
     */
    LinkIndex.prototype.indexFile = function (filePath) {
        if (!this._fs.existsSync(filePath)) {
            this.removeFile(filePath);
            return { added: 0, removed: 0 };
        }

        var oldEdgeMap = this.forwardIndex.get(filePath) || new Map();
        var oldCount = oldEdgeMap.size;

        var stat = this._fs.statSync(filePath);
        this.fileMTimes.set(filePath, stat.mtimeMs);

        if (this.allMdFiles.indexOf(filePath) === -1) {
            this.allMdFiles.push(filePath);
        }

        var content = this._fs.readFileSync(filePath, "utf8");
        var links = this._parser.parseAll(content);

        var newEdgeMap = new Map();
        for (var i = 0; i < links.length; i++) {
            var link = links[i];
            if (!link.target) continue;
            if (!newEdgeMap.has(link.target)) {
                newEdgeMap.set(link.target, this._makeEdge(link));
            }
        }
        this.forwardIndex.set(filePath, newEdgeMap);
        this._updateReverse(filePath, oldEdgeMap, newEdgeMap);

        // 计算实际移除数
        var removedCount = 0;
        oldEdgeMap.forEach(function (v, key) {
            if (!newEdgeMap.has(key)) removedCount++;
        });

        return { added: newEdgeMap.size, removed: removedCount };
    };

    /** 从索引中删除文件 */
    LinkIndex.prototype.removeFile = function (filePath) {
        var oldEdgeMap = this.forwardIndex.get(filePath);
        if (oldEdgeMap) {
            this._updateReverse(filePath, oldEdgeMap, null);
        }
        this.forwardIndex.delete(filePath);
        this.fileMTimes.delete(filePath);
        var idx = this.allMdFiles.indexOf(filePath);
        if (idx >= 0) this.allMdFiles.splice(idx, 1);
    };

    /** 获取出链列表 */
    LinkIndex.prototype.getForward = function (filePath) {
        var edgeMap = this.forwardIndex.get(filePath);
        if (!edgeMap) return [];
        var result = [];
        edgeMap.forEach(function (edge, targetStr) {
            result.push({
                target: edge.target, alias: edge.alias,
                heading: edge.heading, isEmbed: edge.isEmbed,
            });
        });
        return result;
    };

    /**
     * 获取反链列表 — O(1) 通过预建的反向索引
     */
    LinkIndex.prototype.getBacklinks = function (filePath) {
        if (!filePath) return [];
        var targetNames = this._getTargetNames(filePath);
        var seen = new Set();
        var results = [];

        for (var n = 0; n < targetNames.length; n++) {
            var key = targetNames[n];
            // 精确匹配
            var set = this.reverseIndex.get(key);
            if (set) {
                set.forEach(function (sourcePath) {
                    if (!seen.has(sourcePath)) {
                        seen.add(sourcePath);
                        results.push({ source: sourcePath, target: key });
                    }
                });
            }
            // 大小写不敏感
            var ciSet = this.reverseIndex.get("\x00ci:" + key.toLowerCase());
            if (ciSet) {
                ciSet.forEach(function (sourcePath) {
                    if (!seen.has(sourcePath)) {
                        seen.add(sourcePath);
                        results.push({ source: sourcePath, target: key });
                    }
                });
            }
        }
        return results;
    };

    /** 获取文件可能被引用的名称列表 */
    LinkIndex.prototype._getTargetNames = function (filePath) {
        if (!filePath) return [];
        var names = [];
        var noExt = filePath.replace(/\.md$/i, "");

        // 相对路径
        if (this.vaultRoot) {
            var vaultNorm = this.vaultRoot.replace(/\\/g, "/");
            var fileNorm = noExt.replace(/\\/g, "/");
            if (fileNorm.toLowerCase().indexOf(vaultNorm.toLowerCase()) === 0) {
                var relPath = fileNorm.slice(vaultNorm.length).replace(/^\//, "");
                if (relPath) names.push(relPath);
            }
        }

        // basename
        var bn = filePath.replace(/\\/g, "/").split("/").pop().replace(/\.md$/i, "");
        if (names.indexOf(bn) === -1) names.push(bn);

        // 全路径
        var full = noExt.replace(/\\/g, "/");
        if (names.indexOf(full) === -1) names.push(full);

        return names;
    };

    /** 获取已链接文件列表 */
    LinkIndex.prototype.getLinkedFiles = function (filePath, resolverModule) {
        var edgeMap = this.forwardIndex.get(filePath);
        if (!edgeMap || !resolverModule) return [];
        var results = [];
        var allFiles = this.allMdFiles;
        edgeMap.forEach(function (edge, targetStr) {
            var resolved = resolverModule.resolve(targetStr, filePath, allFiles);
            if (resolved) results.push(resolved);
        });
        return results;
    };

    /** 统计信息 */
    LinkIndex.prototype.getStats = function () {
        var fileCount = this.forwardIndex.size;
        var linkCount = 0;
        this.forwardIndex.forEach(function (edgeMap) { linkCount += edgeMap.size; });
        return {
            fileCount: fileCount, linkCount: linkCount,
            vaultRoot: this.vaultRoot, cachedMTimes: this.fileMTimes.size,
        };
    };

    // ===================================================================
    // 持久化 — 含反向索引
    // ===================================================================

    LinkIndex.prototype._cachePath = function () {
        return this._path.join(this._cacheDir, "bidirectional-links.index.json");
    };

    LinkIndex.prototype.persist = function () {
        var forwardObj = {};
        this.forwardIndex.forEach(function (edgeMap, sourcePath) {
            var edgeObj = {};
            edgeMap.forEach(function (edge, targetStr) { edgeObj[targetStr] = edge; });
            forwardObj[sourcePath] = edgeObj;
        });

        var reverseObj = {};
        this.reverseIndex.forEach(function (set, key) {
            reverseObj[key] = Array.from(set);
        });

        var mtimesObj = {};
        this.fileMTimes.forEach(function (mtime, filePath) { mtimesObj[filePath] = mtime; });

        var data = {
            version: 2,  // bump: added reverseIndex
            vaultRoot: this.vaultRoot,
            updatedAt: new Date().toISOString(),
            forwardIndex: forwardObj,
            reverseIndex: reverseObj,
            fileMTimes: mtimesObj,
            allMdFiles: this.allMdFiles,
        };

        try {
            this._fs.writeFileSync(this._cachePath(), JSON.stringify(data, null, 2), "utf8");
            return true;
        } catch (e) {
            this._logger.warn("索引持久化失败: " + e.message);
            return false;
        }
    };

    LinkIndex.prototype.load = function () {
        var cachePath = this._cachePath();
        if (!this._fs.existsSync(cachePath)) return false;

        try {
            var raw = this._fs.readFileSync(cachePath, "utf8");
            var data = JSON.parse(raw);
            if (!data) return false;

            this.forwardIndex.clear();
            this.reverseIndex.clear();

            var fwd = data.forwardIndex || {};
            for (var sourcePath in fwd) {
                if (!fwd.hasOwnProperty(sourcePath)) continue;
                var edgeMap = new Map();
                var edgeObj = fwd[sourcePath];
                for (var targetStr in edgeObj) {
                    if (edgeObj.hasOwnProperty(targetStr)) edgeMap.set(targetStr, edgeObj[targetStr]);
                }
                this.forwardIndex.set(sourcePath, edgeMap);
            }

            // v2+: 恢复反向索引；v1 缓存中不包含则构建
            var reverseObj = data.reverseIndex || {};
            if (Object.keys(reverseObj).length > 0) {
                for (var rKey in reverseObj) {
                    if (!reverseObj.hasOwnProperty(rKey)) continue;
                    this.reverseIndex.set(rKey, new Set(reverseObj[rKey]));
                }
            } else {
                // 从 v1 缓存升级：从正向索引重建反向索引
                var self = this;
                this.forwardIndex.forEach(function (edgeMap, sourcePath) {
                    var old = new Map();
                    self._updateReverse(sourcePath, old, edgeMap);
                });
            }

            this.fileMTimes.clear();
            var mtimes = data.fileMTimes || {};
            for (var fp in mtimes) {
                if (mtimes.hasOwnProperty(fp)) this.fileMTimes.set(fp, mtimes[fp]);
            }

            this.vaultRoot = data.vaultRoot || null;
            this.allMdFiles = data.allMdFiles || [];
            this.ready = true;   // 缓存加载完成 → 索引就绪

            // 校验缓存有效性：抽样检查（大 vault 时避免全量 existsSync）
            if (this.allMdFiles.length > 0) {
                var sampleSize = Math.min(50, this.allMdFiles.length);
                var step = Math.max(1, Math.floor(this.allMdFiles.length / sampleSize));
                var missing = 0, checked = 0;
                for (var i = 0; i < this.allMdFiles.length; i += step) {
                    if (!this._fs.existsSync(this.allMdFiles[i])) missing++;
                    checked++;
                }
                if (checked > 0 && missing / checked > 0.1) return false;
            }

            return true;
        } catch (e) {
            this._logger.warn("索引缓存加载失败: " + e.message);
            return false;
        }
    };

    LinkIndex.prototype.isCacheValidFor = function (currentVaultRoot) {
        if (!this.vaultRoot) return false;
        return this.vaultRoot.replace(/\\/g, "/").toLowerCase() ===
               (currentVaultRoot || "").replace(/\\/g, "/").toLowerCase();
    };

    module.exports = LinkIndex;
})();
