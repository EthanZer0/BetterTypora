/**
 * Bidirectional Links — File Path Resolver
 * =========================================
 * 将 wikilink target 字符串解析为 .md 文件的绝对路径。
 *
 * 解析策略（多步回退）:
 *   1. 精确匹配: target + ".md" 与文件列表比对
 *   2. 大小写不敏感: 纯小写比对
 *   3. 纯 basename 匹配: 忽略目录前缀
 *   4. 同目录优先: 多个匹配时选距离源文件最近的
 *
 * 返回 null = 未解析（幽灵链接）
 */

(function () {
    "use strict";

    /**
     * 规范化路径：统一正斜杠，去 .md 后缀
     */
    function normalizePath(p) {
        return p.replace(/\\/g, "/").replace(/\.md$/i, "");
    }

    /**
     * 获取不带扩展名的 basename
     */
    function basenameNoExt(p) {
        var name = p.replace(/\\/g, "/").split("/").pop();
        return name.replace(/\.md$/i, "");
    }

    /**
     * 获取文件所在目录
     */
    function dirname(p) {
        var parts = p.replace(/\\/g, "/").split("/");
        parts.pop();
        return parts.join("/");
    }

    /**
     * 计算两个路径的目录距离（共同前缀深度）
     */
    function directoryDistance(pathA, pathB) {
        var dirsA = dirname(pathA).split("/").filter(Boolean);
        var dirsB = dirname(pathB).split("/").filter(Boolean);
        var common = 0;
        var len = Math.min(dirsA.length, dirsB.length);
        for (var i = 0; i < len; i++) {
            if (dirsA[i].toLowerCase() === dirsB[i].toLowerCase()) common++;
            else break;
        }
        // 距离 = A 剩余深度 + B 剩余深度
        return (dirsA.length - common) + (dirsB.length - common);
    }

    /**
     * 解析 wikilink target 到绝对文件路径
     * @param {string} target — wikilink 的 target 字段（不含 .md）
     * @param {string} sourceFilePath — 包含该链接的源 .md 文件路径
     * @param {string[]|object} allMdFiles — vault 中所有 .md 文件路径，或预建索引对象
     * @param {boolean} [caseSensitiveFirst=true] — 是否优先精确大小写匹配
     * @returns {string|null} 绝对路径或 null
     */
    function resolve(target, sourceFilePath, allMdFiles, caseSensitiveFirst) {
        if (!target || !allMdFiles) return null;
        if (caseSensitiveFirst === undefined) caseSensitiveFirst = true;

        // 快速路径：如果传入的是预建索引对象，走 O(1) 查找
        if (!Array.isArray(allMdFiles)) {
            return resolveWithIndex(target, sourceFilePath, allMdFiles);
        }
        if (!allMdFiles.length) return null;

        var normTarget = normalizePath(target);

        // --- Pass 1: 精确匹配（大小写敏感） ---
        var exactMatches = [];
        for (var i = 0; i < allMdFiles.length; i++) {
            var normalized = normalizePath(allMdFiles[i]);
            if (normalized === normTarget || normalized.endsWith("/" + normTarget)) {
                exactMatches.push(allMdFiles[i]);
            }
        }
        if (exactMatches.length === 1) return exactMatches[0];
        if (exactMatches.length > 1) {
            // 选距离源文件最近的
            return pickClosest(exactMatches, sourceFilePath);
        }

        // --- Pass 2: 大小写不敏感 ---
        var lowerTarget = normTarget.toLowerCase();
        var caseInsensitiveMatches = [];
        for (var j = 0; j < allMdFiles.length; j++) {
            var n = normalizePath(allMdFiles[j]);
            if (n.toLowerCase() === lowerTarget || n.toLowerCase().endsWith("/" + lowerTarget)) {
                caseInsensitiveMatches.push(allMdFiles[j]);
            }
        }
        if (caseInsensitiveMatches.length === 1) return caseInsensitiveMatches[0];
        if (caseInsensitiveMatches.length > 1) {
            return pickClosest(caseInsensitiveMatches, sourceFilePath);
        }

        // --- Pass 3: 纯 basename 匹配 ---
        var basenameMatches = [];
        for (var k = 0; k < allMdFiles.length; k++) {
            if (basenameNoExt(allMdFiles[k]).toLowerCase() === lowerTarget.split("/").pop().toLowerCase()) {
                basenameMatches.push(allMdFiles[k]);
            }
        }
        if (basenameMatches.length === 1) return basenameMatches[0];
        if (basenameMatches.length > 1) {
            return pickClosest(basenameMatches, sourceFilePath);
        }

        // 无精确匹配 → 断链 (不启用子串模糊匹配: [[前缀]] 会误配 前缀A.md 等)
        return null;
    }

    /**
     * 为 allMdFiles 预建 O(1) 查找索引，避免 resolve() 每次 O(N) 扫描。
     * 返回闭包对象，给 resolve() 的快速路径消费。
     *
     * 在 buildFromIndex 开始时调用一次，resolve() 在每条边内部
     * 变为 O(1) 哈希查找，将 3600×1000×4 的线性扫描降到常数时间。
     */
    function buildLookupIndex(allMdFiles) {
        var idx = {
            // 精确规范路径 → 原始路径
            _exact: {},
            // 精确 basename（大小写敏感）→ 原始路径（单值/数组）
            _basenameExact: {},
            // 小写规范路径 → 原始路径
            _lower: {},
            // 小写 basename → 候选数组
            _basenameLower: {},
        };

        // 所有文件的规范化路径（预计算，避免 resolve 时每次 normalizePath）
        var _norms = new Array(allMdFiles.length);
        var _lowers = new Array(allMdFiles.length);
        var _bns = new Array(allMdFiles.length);

        for (var i = 0; i < allMdFiles.length; i++) {
            var fp = allMdFiles[i];
            var norm = normalizePath(fp);
            var lower = norm.toLowerCase();
            var bn = basenameFromNorm(norm);       // 从已规范化路径提取，避免重复 split
            var bnLower = bn.toLowerCase();

            _norms[i] = norm;
            _lowers[i] = lower;
            _bns[i] = bnLower;

            // 全路径精确匹配
            idx._exact[norm] = fp;

            // basename 精确匹配（大小写敏感）— 这是热路径
            var be = idx._basenameExact[bn];
            if (!be) {
                idx._basenameExact[bn] = fp;
            } else if (typeof be === "string") {
                idx._basenameExact[bn] = [be, fp];
            } else {
                be.push(fp);
            }

            // 小写全路径
            if (!(lower in idx._lower)) {
                idx._lower[lower] = fp;
            }

            // 小写 basename → 候选数组
            var bl = idx._basenameLower[bnLower];
            if (!bl) {
                idx._basenameLower[bnLower] = [fp];
            } else {
                bl.push(fp);
            }
        }

        // 挂到索引上供回退使用
        idx._norms  = _norms;
        idx._lowers = _lowers;
        idx._bns   = _bns;
        idx._raw   = allMdFiles;

        return idx;
    }

    /** 从已规范化的路径提取 basename（无 ext，无 regex） */
    function basenameFromNorm(norm) {
        var lastSlash = norm.lastIndexOf("/");
        var name = lastSlash >= 0 ? norm.slice(lastSlash + 1) : norm;
        var dot = name.lastIndexOf(".md");
        if (dot > 0) name = name.slice(0, dot);
        return name;
    }

    /**
     * O(1) 索引查找版 resolve — 零 O(N) 回退
     */
    function resolveWithIndex(target, sourceFilePath, idx) {
        var targetNoExt = target.replace(/\\/g, "/").replace(/\.md$/i, "");
        // 规范化 target 后提取 basename 和路径部分
        var lastSlash = targetNoExt.lastIndexOf("/");
        var targetBase = lastSlash >= 0 ? targetNoExt.slice(lastSlash + 1) : targetNoExt;
        var hasPath = lastSlash >= 0;

        if (!hasPath) {
            // ---- 纯 basename 路径（绝大多数 wikilink）----

            // Pass 1: 精确 basename（大小写敏感）→ O(1)
            var bx = idx._basenameExact[targetBase];
            if (bx) {
                if (typeof bx === "string") return bx;
                if (bx.length === 1) return bx[0];
                return pickClosest(bx, sourceFilePath);
            }

            // Pass 2: 小写 basename → O(1)
            var bxL = idx._basenameLower[targetBase.toLowerCase()];
            if (bxL) {
                if (bxL.length === 1) return bxL[0];
                return pickClosest(bxL, sourceFilePath);
            }
        } else {
            // ---- 含路径的 target（少见）----
            var tLower = targetNoExt.toLowerCase();

            // 全路径精确匹配
            var ex = idx._exact[targetNoExt];
            if (ex) return ex;

            // endsWith "/targetNoExt" — 预计算路径扫一次
            var suffix = "/" + targetNoExt;
            var lSuffix = "/" + tLower;
            var endsExact = null, endsCi = [];
            var norms = idx._norms;
            for (var a = 0; a < norms.length; a++) {
                if (norms[a].endsWith(suffix)) {
                    if (endsExact === null) endsExact = idx._raw[a];
                    else if (!Array.isArray(endsExact)) endsExact = [endsExact, idx._raw[a]];
                    else endsExact.push(idx._raw[a]);
                }
            }
            if (endsExact) {
                if (typeof endsExact === "string") return endsExact;
                if (endsExact.length === 1) return endsExact[0];
                return pickClosest(endsExact, sourceFilePath);
            }

            // 大小写不敏感
            var ciExact = idx._lower[tLower];
            if (ciExact) return ciExact;

            // endsWith 小写
            for (var b = 0; b < idx._lowers.length; b++) {
                if (idx._lowers[b] === tLower || idx._lowers[b].endsWith(lSuffix)) {
                    endsCi.push(idx._raw[b]);
                }
            }
            if (endsCi.length === 1) return endsCi[0];
            if (endsCi.length > 1) return pickClosest(endsCi, sourceFilePath);

            // basename 回退
            var bn = idx._basenameLower[targetBase.toLowerCase()];
            if (bn) {
                if (bn.length === 1) return bn[0];
                return pickClosest(bn, sourceFilePath);
            }
        }

        // 无精确匹配 → 断链 (不启用子串模糊匹配: [[前缀]] 会误配 前缀A.md 等)
        return null;
    }

    /**
     * 从多个匹配中选择距离源文件最近的
     */
    function pickClosest(candidates, sourceFilePath) {
        if (candidates.length === 1) return candidates[0];
        var best = candidates[0];
        var bestDist = directoryDistance(candidates[0], sourceFilePath || "");
        for (var i = 1; i < candidates.length; i++) {
            var dist = directoryDistance(candidates[i], sourceFilePath || "");
            if (dist < bestDist) {
                bestDist = dist;
                best = candidates[i];
            }
        }
        return best;
    }

    /**
     * 批量解析所有 wikilink target
     * @returns {Map<string, string|null>} target → 绝对路径或 null
     */
    function resolveAll(targets, sourceFilePath, allMdFiles, caseSensitiveFirst) {
        var result = {};
        var uniqTargets = [];
        var seen = {};
        for (var i = 0; i < targets.length; i++) {
            if (!seen[targets[i]]) {
                seen[targets[i]] = true;
                uniqTargets.push(targets[i]);
            }
        }
        for (var j = 0; j < uniqTargets.length; j++) {
            result[uniqTargets[j]] = resolve(uniqTargets[j], sourceFilePath, allMdFiles, caseSensitiveFirst);
        }
        return result;
    }

    /**
     * 扫描目录及所有子目录中的 .md 文件
     * @param {object} fs — Node.js fs 模块
     * @param {object} path — Node.js path 模块
     * @param {string} rootDir — 起始目录
     * @param {Array<string>} [ignoreDirs=['.git', '.obsidian', 'node_modules', '.trash']]
     * @returns {string[]} 所有 .md 文件的绝对路径
     */
    function scanMdFiles(fs, path, rootDir, ignoreDirs) {
        if (!fs || !rootDir) return [];
        if (!ignoreDirs) ignoreDirs = [".git", ".obsidian", "node_modules", ".trash"];
        var results = [];
        try {
            _walk(rootDir, fs, path, ignoreDirs, results);
        } catch (e) {
            // 权限问题等，返回已收集的结果
        }
        return results;
    }

    function _walk(dir, fs, path, ignoreDirs, results) {
        var entries;
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch (e) {
            return; // 跳过不可读的目录
        }
        for (var i = 0; i < entries.length; i++) {
            var entry = entries[i];
            // 跳过隐藏文件和目录（除了 .）
            if (entry.name.charAt(0) === ".") continue;
            var fullPath = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                if (ignoreDirs.indexOf(entry.name.toLowerCase()) === -1) {
                    _walk(fullPath, fs, path, ignoreDirs, results);
                }
            } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
                results.push(fullPath);
            }
        }
    }

    module.exports = {
        resolve: resolve,
        resolveAll: resolveAll,
        scanMdFiles: scanMdFiles,
        normalizePath: normalizePath,
        basenameNoExt: basenameNoExt,
        buildLookupIndex: buildLookupIndex,
    };
})();
