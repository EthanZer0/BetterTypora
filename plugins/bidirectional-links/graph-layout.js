/**
 * Bidirectional Links — Graph Layout Engine
 * ==========================================
 * 自定义力导向布局算法，适用于 ≤2000 个节点的 vault 知识图谱。
 *
 * 布局策略:
 *   - 圆形初始位置（按 degree 偏移，避免重叠）
 *   - N² 库仑斥力（对所有节点对）
 *   - 弹簧引力（仅边连接的节点）
 *   - 弱中心引力（防止孤立节点无限漂移）
 *   - 速度阻尼 0.85，每步最大速度 5px
 *   - rAF 循环内每帧跑 10 步模拟
 */

(function () {
    "use strict";

    /**
     * @param {object} [options]
     *   repulsionStrength:  斥力强度（默认 8000）
     *   attractionStrength: 引力系数（默认 0.004）
     *   repulsionMinDist:   最小斥力距离（默认 1，防止除以零）
     *   edgeRestLength:     边弹簧自然长度（默认 80）
     *   centerGravity:      中心引力强度（默认 0.0003）
     *   maxVelocity:        每步最大速度 px（默认 8）
     *   damping:            速度阻尼 0~1（默认 0.82）
     *   energyThreshold:    收敛能量阈值（默认 0.5）
     *   maxIterations:      最大模拟步数（默认 400）
     *   stepsPerFrame:      每帧步数（默认 12）
     */
    function GraphLayout(options) {
        var opt = options || {};
        this._repulsionStrength = opt.repulsionStrength || 8000;
        this._attractionStrength = opt.attractionStrength || 0.004;
        this._repulsionMinDist = opt.repulsionMinDist || 1;
        this._edgeRestLength = opt.edgeRestLength || 80;
        this._centerGravity = opt.centerGravity || 0.0003;
        this._maxVelocity = opt.maxVelocity || 8;
        this._damping = opt.damping || 0.82;
        this._energyThreshold = opt.energyThreshold || 0.5;
        this._maxIterations = opt.maxIterations || 400;
        this._stepsPerFrame = opt.stepsPerFrame || 12;

        this._running = false;
        this._rafId = null;
        this._stepCount = 0;
    }

    // ===================================================================
    // 公共 API
    // ===================================================================

    /**
     * 从 LinkIndex 构建图数据
     * @param {Map} forwardIndex — Map<sourcePath, Map<targetStirng, LinkEdge>>
     * @param {string[]} allMdFiles
     * @param {object} resolver — { resolve(target, sourcePath, allMdFiles) → string|null }
     * @returns {{ nodes: Array, edges: Array }}
     */
    GraphLayout.prototype.buildFromIndex = function (forwardIndex, allMdFiles, resolver) {
        var filePathSet = new Set();
        for (var f = 0; f < allMdFiles.length; f++) {
            filePathSet.add(allMdFiles[f]);
        }

        // 预建 O(1) 查找索引：每条边不再 O(N) 扫描全部文件
        var lookupIndex = null;
        if (resolver && resolver.buildLookupIndex) {
            lookupIndex = resolver.buildLookupIndex(allMdFiles);
        }

        // 构建节点
        var degreeMap = {};
        var nodesById = {};
        var centerX = 400;
        var centerY = 300;

        for (var i = 0; i < allMdFiles.length; i++) {
            var fp = allMdFiles[i];
            degreeMap[fp] = 0;
            nodesById[fp] = {
                id: fp,
                label: basenameNoExt(fp),
                x: 0,
                y: 0,
                vx: 0,
                vy: 0,
                degree: 0,
                isOrphan: true, // 暂设，稍后覆盖
                _fx: 0,
                _fy: 0
            };
        }

        // 构建边
        var edges = [];
        var edgeKeys = new Set(); // 去重（同一对之间多条链接只留一条边）

        var self = this;
        forwardIndex.forEach(function (edgeMap, sourcePath) {
            if (!filePathSet.has(sourcePath)) return;
            var dg = degreeMap[sourcePath] || 0;

            edgeMap.forEach(function (edge, targetStr) {
                if (edge.isEmbed && !edge.target) return; // 跳过无效嵌入链接

                var resolved = resolver.resolve(
                    edge.target,
                    sourcePath,
                    lookupIndex || allMdFiles  // 优先用索引，回退原数组
                );
                if (!resolved || resolved === sourcePath) return; // 跳过自环和断链

                dg++;
                var targetDg = degreeMap[resolved];
                if (targetDg !== undefined) degreeMap[resolved] = targetDg + 1;

                // 去重（无向边）
                var ek = sourcePath < resolved
                    ? sourcePath + "|||" + resolved
                    : resolved + "|||" + sourcePath;
                if (edgeKeys.has(ek)) return;
                edgeKeys.add(ek);

                edges.push({ source: sourcePath, target: resolved });
            });

            degreeMap[sourcePath] = dg;
        });

        // 更新节点 degree 和 isOrphan
        var maxDegree = 0;
        for (var j = 0; j < allMdFiles.length; j++) {
            var fpp = allMdFiles[j];
            var node = nodesById[fpp];
            var d = degreeMap[fpp] || 0;
            node.degree = d;
            node.isOrphan = (d === 0);
            node._logDeg = Math.log(d + 1);     // 预计算对数，全局复用
            if (d > maxDegree) maxDegree = d;
        }

        // 初始位置: 圆形布局，degree 高的略靠近圆心
        var N = allMdFiles.length;
        var nodes = [];
        var idx = 0;
        var baseRadius = Math.max(200, Math.min(350, N * 0.6));

        // 排序让高 degree 节点先布局（圆的中心附近）
        var sortedFiles = allMdFiles.slice();
        sortedFiles.sort(function (a, b) { return (degreeMap[b] || 0) - (degreeMap[a] || 0); });

        for (var s = 0; s < sortedFiles.length; s++) {
            var fp3 = sortedFiles[s];
            var node3 = nodesById[fp3];
            var dg3 = node3.degree;
            // 高 degree 节点在圆中略靠近中心
            var radiusVariation = (maxDegree > 0) ? 1 - 0.4 * (dg3 / maxDegree) : 1;
            var r = baseRadius * radiusVariation;
            var angle = (2 * Math.PI * idx / N) - Math.PI / 2;
            node3.x = centerX + r * Math.cos(angle);
            node3.y = centerY + r * Math.sin(angle);
            // 添加小随机扰动，防止完全对称为同一条线
            node3.x += (Math.random() - 0.5) * 20;
            node3.y += (Math.random() - 0.5) * 20;
            node3.vx = 0;
            node3.vy = 0;
            nodes.push(node3);
            idx++;
        }

        return { nodes: nodes, edges: edges, maxDegree: maxDegree };
    };

    /**
     * 单步模拟 → 返回当前动能（总速度平方和）
     */
    GraphLayout.prototype.step = function (nodes, edges) {
        var repK = this._repulsionStrength;
        var attK = this._attractionStrength;
        var minDist = this._repulsionMinDist;
        var restLen = this._edgeRestLength;
        var centerG = this._centerGravity;
        var centerX = 400;
        var centerY = 300;

        // --- 斥力: 所有节点对（距离截止优化）---
        var N = nodes.length;
        var cutoffSq = 160000; // 400² — 覆盖足够远，维持聚簇间分离

        for (var i = 0; i < N; i++) {
            nodes[i]._fx = 0;
            nodes[i]._fy = 0;
        }
        for (var i = 0; i < N; i++) {
            var a = nodes[i];
            for (var j = i + 1; j < N; j++) {
                var b = nodes[j];
                var dx = a.x - b.x;
                var dy = a.y - b.y;
                var distSq = dx * dx + dy * dy;
                if (distSq > cutoffSq) continue; // 距离截止
                if (distSq < 1) distSq = 1;
                var f = repK / distSq;
                if (f > 100) f = 100;
                var invDist = 1 / Math.sqrt(distSq); // 用倒数替代 sqrt
                var fx = dx * invDist * f;
                var fy = dy * invDist * f;
                a._fx += fx;
                a._fy += fy;
                b._fx -= fx;
                b._fy -= fy;
            }
        }

        // --- 引力: 每条边 ---
        for (var e = 0; e < edges.length; e++) {
            var edge = edges[e];
            var src = this._nodeIndex[edge.source];
            var tgt = this._nodeIndex[edge.target];
            if (!src || !tgt) continue;

            var dx = src.x - tgt.x;
            var dy = src.y - tgt.y;
            var dist = Math.sqrt(dx * dx + dy * dy);
            if (dist < minDist) dist = minDist;
            var displacement = dist - restLen;
            var f = attK * displacement;
            if (f > 8) f = 8;
            if (f < -8) f = -8;
            var fx = (dx / dist) * f;
            var fy = (dy / dist) * f;
            src._fx -= fx;
            src._fy -= fy;
            tgt._fx += fx;
            tgt._fy += fy;
        }

        // --- 中心引力 ---
        for (var i = 0; i < nodes.length; i++) {
            var n = nodes[i];
            n._fx -= (n.x - centerX) * centerG;
            n._fy -= (n.y - centerY) * centerG;
        }

        // --- 更新速度 + 位置 ---
        var totalEnergy = 0;
        var maxV = this._maxVelocity;
        var damp = this._damping;

        for (var i = 0; i < nodes.length; i++) {
            var n = nodes[i];
            n.vx = (n.vx + n._fx) * damp;
            n.vy = (n.vy + n._fy) * damp;

            var speed = Math.sqrt(n.vx * n.vx + n.vy * n.vy);
            if (speed > maxV) {
                var scale = maxV / speed;
                n.vx *= scale;
                n.vy *= scale;
                speed = maxV;
            }

            n.x += n.vx;
            n.y += n.vy;

            totalEnergy += speed * speed;
        }

        this._stepCount++;
        return totalEnergy;
    };

    /**
     * 启动模拟
     * @param {Array} nodes
     * @param {Array} edges
     * @param {function} onTick — 每帧调用，参数 (nodes, energy, stepCount)
     * @param {function} onDone — 收敛/结束时调用
     */
    GraphLayout.prototype.run = function (nodes, edges, onTick, onDone) {
        var self = this;
        this._running = true;
        this._stepCount = 0;
        var stepsPerFrame = this._stepsPerFrame;

        // 一次性构建节点索引 — 节点集不变，step() 中复用不重建
        this._nodeIndex = {};
        for (var ni = 0; ni < nodes.length; ni++) {
            this._nodeIndex[nodes[ni].id] = nodes[ni];
        }

        function frame() {
            if (!self._running) return;

            var energy;
            var stepsPerFrame = self._stepsPerFrame;
            // 模拟期动态步数：前 3 帧加倍（快速收敛），之后恢复默认
            var spf = self._stepCount < (stepsPerFrame * 3) ? stepsPerFrame * 2 : stepsPerFrame;
            for (var s = 0; s < spf; s++) {
                energy = self.step(nodes, edges);
                if (self._stepCount >= self._maxIterations) {
                    self._running = false;
                    if (onTick) onTick(nodes, energy, self._stepCount);
                    if (onDone) onDone();
                    return;
                }
            }

            if (onTick) onTick(nodes, energy, self._stepCount);

            if (energy < self._energyThreshold) {
                self._running = false;
                if (onDone) onDone();
                return;
            }

            self._rafId = requestAnimationFrame(frame);
        }

        this._rafId = requestAnimationFrame(frame);
    };

    /**
     * 停止模拟
     */
    GraphLayout.prototype.stop = function () {
        this._running = false;
        if (this._rafId) {
            cancelAnimationFrame(this._rafId);
            this._rafId = null;
        }
    };

    /**
     * 节点半径: 4~18px 基于 degree
     */
    GraphLayout.prototype.getNodeRadius = function (degree, maxDegree, _logDeg) {
        // 对数映射：3~22px，匹配幂律度分布，hub 节点明显更大
        if (maxDegree <= 0) return 4;
        var logDegree = _logDeg !== undefined ? _logDeg : Math.log(degree + 1);
        var logMax = Math.log(maxDegree + 1);
        var t = logMax > 0 ? logDegree / logMax : 0;
        return 3 + t * 19;
    };

    // ===================================================================
    // 缓存
    // ===================================================================

    /**
     * 验证缓存是否与当前图数据匹配
     * @param {object} cache — 缓存的图数据
     * @param {Array} nodes — 当前节点
     * @param {Array} edges — 当前边
     * @param {string} vaultRoot — 当前 vault 根目录
     * @returns {boolean}
     */
    GraphLayout.prototype.isCacheValid = function (cache, nodes, edges, vaultRoot) {
        if (!cache || !cache.nodes || !cache.edges) return false;
        if (cache.vaultRoot !== vaultRoot) return false;
        if (cache.nodeCount !== nodes.length) return false;
        if (cache.edgeCount !== edges.length) return false;

        // 节点 ID 集合比较
        var cacheIds = {};
        for (var i = 0; i < cache.nodes.length; i++) {
            cacheIds[cache.nodes[i].id] = true;
        }
        for (var i = 0; i < nodes.length; i++) {
            if (!cacheIds[nodes[i].id]) return false;
        }

        // 边集合比较
        var cacheEdgeKeys = {};
        for (var ee = 0; ee < cache.edges.length; ee++) {
            var e = cache.edges[ee];
            var k = e.source < e.target ? e.source + "|||" + e.target : e.target + "|||" + e.source;
            cacheEdgeKeys[k] = true;
        }
        for (var ei = 0; ei < edges.length; ei++) {
            var ee2 = edges[ei];
            var key = ee2.source < ee2.target ? ee2.source + "|||" + ee2.target : ee2.target + "|||" + ee2.source;
            if (!cacheEdgeKeys[key]) return false;
        }

        return true;
    };

    /**
     * 从缓存恢复节点位置
     * @param {Array} nodes — 当前节点（会被原地修改 x, y）
     * @param {object} cache — 缓存的图数据
     */
    GraphLayout.prototype.loadCachedPositions = function (nodes, cache) {
        var posMap = {};
        for (var i = 0; i < cache.nodes.length; i++) {
            posMap[cache.nodes[i].id] = { x: cache.nodes[i].x, y: cache.nodes[i].y };
        }
        for (var i = 0; i < nodes.length; i++) {
            var cached = posMap[nodes[i].id];
            if (cached) {
                nodes[i].x = cached.x;
                nodes[i].y = cached.y;
                nodes[i].vx = 0;
                nodes[i].vy = 0;
            }
        }
    };

    // ===================================================================
    // 内部
    // ===================================================================


    function basenameNoExt(p) {
        var name = p.replace(/\\/g, "/").split("/").pop();
        var dot = name.lastIndexOf(".md");
        if (dot > 0) return name.slice(0, dot);
        return name;
    }

    module.exports = GraphLayout;
})();
