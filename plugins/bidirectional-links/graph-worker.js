/**
 * Bidirectional Links — Graph Worker
 * ===================================
 * Web Worker 中运行力导向物理模拟，通过 postMessage 与主线程通信。
 *
 * 协议:
 *   main → worker: {type:"init", nodes, edges, options}
 *   main → worker: {type:"start"}
 *   main → worker: {type:"stop"}
 *   main → worker: {type:"pin", nodeId, x, y}
 *   main → worker: {type:"unpin", nodeId}
 *
 *   worker → main: {type:"tick", positions:ArrayBuffer, stepCount}
 *     positions 为 Float32Array.buffer，格式 [x0,y0, x1,y1, ...]，transfer 零拷贝，按节点索引寻址
 *   worker → main: {type:"done"}
 */

// ===================================================================
// 物理参数（与 GraphLayout 默认值一致）
// ===================================================================

var repulsionStrength   = 8000;   // 回退到原始值 — 与 graph-layout.js O(N²) 默认值一致
var attractionStrength  = 0.004;
var repulsionMinDist    = 1;
var edgeRestLength      = 80;
var centerGravity       = 0.0003;
var maxVelocity         = 8;

// ===================================================================
// Alpha 冷却模型 — 统一控制力的强度和衰减
// ===================================================================
// 两阶段: Phase1 慢步高阻尼缓慢展开 → Phase2 正常步数精细沉降
//   - 配合节点初始中心聚集 → "星群展开"视觉效果
//   - 收敛后 idle (1步/帧) 永不停止，微小扰动可持续传播
//   - 拖拽/松手时将 alpha 重置为 alphaRestoreDrag

var alpha = 0;                  // 当前温度 0~1
var alphaInit = 1;              // 初始温度
var alphaDecay = 0.002;        // Phase 1: 慢速展开衰减 (~500 ticks≈8s)
var alphaDecay2 = 0.0015;       // Phase 2: 精细沉降衰减 (~660 ticks≈10.5s)
var ALPHA_PHASE2 = 0.5;        // 相位切换阈值 — alpha < 0.5 进入 Phase2
var alphaMin = 0.001;          // 低于此值保持最低步数，不停止
var alphaTarget = alphaMin;    // 目标温度（不得低于 alphaMin，防止力被清零）
var alphaRestoreDrag = 0.7;    // 拖拽/松手时恢复到的温度 — 高值=快速强力回弹
var ALPHA_IDLE = 0.015;        // 低于此进入 idle (1步/帧, 永不停止)
var SLEEP_STEPS = 2;           // 中间态步数
var IDLE_STEPS = 1;            // 收敛后最低步数，永不停止
var stepsPerFrame = 12;

// Phase 1 慢速展开参数
var PHASE1_STEPS = 8;          // BH 减少了 ~10x 力交互，加倍步数以弥补
var PHASE1_DAMP = 0.85;        // 降低阻尼帮助节点更快逃逸密集区
var PHASE1_MAXVEL = 5;         // 适度提高单步速度上限

// Barnes-Hut quadtree parameters
var BH_THETA = 0.7;    // standard value — stable cell COM across rebuilds, outerV monotonic decay
var BH_CUTOFF_SQ = 4000000;     // 2000² — 扩大外围直径，让外层节点分布更广
var MAX_QT_NODES = 0;
var _qtNodes = null;
var _qtCount = 0;
// computeBounds 复用容器 — 避免热循环中分配临时对象
var _bbResult = { x0: 0, y0: 0, x1: 0, y1: 0 };

// BH 诊断计数器
var _diag = null;           // 重置为 null，init 时按需分配
var _diagTickCount = 0;     // 从上次报告起的 tick 计数

// ===================================================================
// 状态
// ===================================================================

var nodes = null;
var edges = null;
var nodeIndex = null;
var running = false;
var stepCount = 0;
var intervalId = null;
var pinnedNodes = {};        // nodeId → { x, y }

// 自适应调度器——滑动窗口平滑帧率
var FRAME_WINDOW = 10;           // 滑动窗口大小
var frameTimes = new Array(FRAME_WINDOW); // 环形缓冲：最近 N 帧物理耗时
var frameIdx = 0;                // 写入位置
var frameCount = 0;              // 已记录帧数（< WINDOW 时为未填满）
var SCHEDULE_MIN_DELAY = 4;      // 最小延迟 ms — 防背靠背 postMessage
var SCHEDULE_TARGET = 16;        // 目标帧间隔 ms

// SAB 零拷贝输出（替代 postMessage tick）
var _useSAB = false;
var _sab = null;               // SharedArrayBuffer
var _sabHeader = null;         // Int32Array view of header (atomic ops)
var _sabHeaderFloat = null;    // Float32Array view of header (alpha/energy)
var _sabSlots = null;          // Float32Array view of both position slots
var _sabLocalFrameSeq = 0;     // 单调递增帧计数器
var _SAB_HEADER_INTS = 16;     // 64-byte header as 16 Int32s
var _lastTotalEnergy = 0;

/** 节点物理半径 — 与 getNodeRadius 一致的对数映射，3~22px */
var _maxDegree = 100;  // 默认为 100，由 init 消息中的 maxDegree 覆盖

function getNodePhysRadius(deg, logDeg) {
    if (deg <= 0) return 3;
    var logD = logDeg !== undefined ? logDeg : Math.log(deg + 1);
    var logM = _maxDegree > 0 ? Math.log(_maxDegree + 1) : Math.log(2);
    var t = logD / logM;
    return 3 + t * 19;
}

// ===================================================================
// Barnes-Hut quadtree helpers
// ===================================================================

/** 判断点 (x,y) 在 node 的哪个象限 */
function quadrant(node, x, y) {
    var midX = (node.x0 + node.x1) * 0.5;
    var midY = (node.y0 + node.y1) * 0.5;
    if (x <= midX) return y <= midY ? 0 : 2;
    else return y <= midY ? 1 : 3;
}

/** 从预分配池中取一个节点，重置所有字段 */
function allocateNode(x0, y0, x1, y1) {
    if (_qtCount >= MAX_QT_NODES) return -1;  // 池溢出保护
    var idx = _qtCount; _qtCount++;
    var node = _qtNodes[idx];
    node.cx = 0; node.cy = 0; node.mass = 0;
    node.x0 = x0; node.y0 = y0; node.x1 = x1; node.y1 = y1;
    node.child0 = -1; node.child1 = -1; node.child2 = -1; node.child3 = -1;
    node.body = null; node.maxR = 0; node.hasBody = false;
    return idx;
}

/** 为父节点的指定象限创建子节点 */
function createChild(parentIdx, quad) {
    var p = _qtNodes[parentIdx];
    var midX = (p.x0 + p.x1) * 0.5;
    var midY = (p.y0 + p.y1) * 0.5;
    switch (quad) {
        case 0: return allocateNode(p.x0, p.y0, midX, midY);
        case 1: return allocateNode(midX, p.y0, p.x1, midY);
        case 2: return allocateNode(p.x0, midY, midX, p.y1);
        case 3: return allocateNode(midX, midY, p.x1, p.y1);
    }
    return -1;
}

/** 递归插入节点，增量更新 COM */
function insertBody(nodeIdx, bodyNode) {
    if (nodeIdx === -1) return;  // 池溢出保护
    var node = _qtNodes[nodeIdx];
    var bx = bodyNode.x, by = bodyNode.y;
    var bodyR = bodyNode._physR || 3;

    // 增量 COM: 加权平均
    var totalMass = node.mass + 1;
    node.cx = (node.cx * node.mass + bx) / totalMass;
    node.cy = (node.cy * node.mass + by) / totalMass;
    node.mass = totalMass;
    if (bodyR > node.maxR) node.maxR = bodyR;

    if (node.mass === 1) {
        node.body = bodyNode;
        node.hasBody = true;
        return;
    }

    // mass === 2: 第一次分裂 — 把已有 body 推入子节点
    if (node.mass === 2) {
        var existing = node.body;
        node.body = null; node.hasBody = false;
        var exQuad = quadrant(node, existing.x, existing.y);
        var exField = "child" + exQuad;
        if (node[exField] === -1) node[exField] = createChild(nodeIdx, exQuad);
        insertBody(node[exField], existing);
    }

    var qi = quadrant(node, bx, by);
    var childField = "child" + qi;
    if (node[childField] === -1) node[childField] = createChild(nodeIdx, qi);
    insertBody(node[childField], bodyNode);
}

/** 扫描所有节点，计算包围盒（复用 _bbResult，零 GC） */
function computeBounds(nodes, N) {
    var x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (var i = 0; i < N; i++) {
        var n = nodes[i];
        if (n.x < x0) x0 = n.x;
        if (n.y < y0) y0 = n.y;
        if (n.x > x1) x1 = n.x;
        if (n.y > y1) y1 = n.y;
    }
    _bbResult.x0 = x0; _bbResult.y0 = y0;
    _bbResult.x1 = x1; _bbResult.y1 = y1;
    return _bbResult;
}

/** 构建 Barnes-Hut quadtree，返回根节点索引 */
function buildTree(nodes, N) {
    _qtCount = 0;
    var bb = computeBounds(nodes, N);

    // 防止退化边界盒子（单点或共线）
    var MIN_SIZE = 1;
    if (bb.x1 - bb.x0 < MIN_SIZE) { bb.x0 -= MIN_SIZE; bb.x1 += MIN_SIZE; }
    if (bb.y1 - bb.y0 < MIN_SIZE) { bb.y0 -= MIN_SIZE; bb.y1 += MIN_SIZE; }

    var padX = (bb.x1 - bb.x0) * 0.01 + 1;
    var padY = (bb.y1 - bb.y0) * 0.01 + 1;
    var rootIdx = allocateNode(bb.x0 - padX, bb.y0 - padY, bb.x1 + padX, bb.y1 + padY);

    for (var i = 0; i < N; i++) insertBody(rootIdx, nodes[i]);
    return rootIdx;
}

/** Barnes-Hut 斥力计算 — 递归遍历 quadtree，对 targetNode 施加斥力 */
function computeRepulsion(nodeIdx, targetNode, theta) {
    if (nodeIdx === -1) return;  // 池溢出保护
    var node = _qtNodes[nodeIdx];
    if (node.mass === 0) return;

    // 向量: 从 cell COM 指向 target（斥力沿此方向推开 target）
    var dx = targetNode.x - node.cx;
    var dy = targetNode.y - node.cy;
    var distSq = dx * dx + dy * dy;

    if (distSq > BH_CUTOFF_SQ) { _diag.cutoffSkips++; return; }
    // Self-guard: 跳过 targetNode 自己的叶子 cell
    if (node.hasBody && node.body === targetNode) { _diag.selfSkips++; return; }

    var cellSize = Math.max(node.x1 - node.x0, node.y1 - node.y0);
    var dist = Math.sqrt(distSq);

    if (node.hasBody || (cellSize / dist < theta)) {
        // 当作单体处理 — 斥力方向: 推开 target（沿 dx, dy 方向）
        var targetR = targetNode._physR || 3;
        var cellR = node.maxR || 3;
        var minDist = targetR + cellR;
        var dSq = distSq;
        // 近距离地板: 线性 minDist 作为 dSq 下限
        // （与原始 O(N²) 行为一致——数学上维度不一致但参数化以此为基石）
        if (dSq < minDist) dSq = minDist;

        var f = repulsionStrength / dSq;
        if (f > 100) f = 100;
        var invDist = 1 / dist;
        var fx = dx * invDist * f;
        var fy = dy * invDist * f;

        targetNode._fx += fx * node.mass;
        targetNode._fy += fy * node.mass;

        // 诊断
        if (node.hasBody) {
            _diag.leafHits++;
            _diag.leafForceSum += Math.abs(fx) + Math.abs(fy);
        } else {
            _diag.cellHits++;
            _diag.cellMassSum += node.mass;
            _diag.cellForceSum += (Math.abs(fx) + Math.abs(fy)) * node.mass;
        }
    } else {
        _diag.expansions++;
        // 展开子节点
        if (node.child0 !== -1) computeRepulsion(node.child0, targetNode, theta);
        if (node.child1 !== -1) computeRepulsion(node.child1, targetNode, theta);
        if (node.child2 !== -1) computeRepulsion(node.child2, targetNode, theta);
        if (node.child3 !== -1) computeRepulsion(node.child3, targetNode, theta);
    }
}

// ===================================================================
// 物理步进（从 graph-layout.js step() 复制，增加 pinnedNodes 支持）
// ===================================================================

function step() {
    var N = nodes.length;

    // 当前 alpha: 用于缩放所有力
    var curAlpha = alpha;

    // idle 完全冻结 — 零物理计算，消除 BH quadtree 逐步拓扑抖动
    if (curAlpha < ALPHA_IDLE) {
        for (var i = 0; i < N; i++) {
            nodes[i].vx = 0; nodes[i].vy = 0;
            nodes[i]._fx = 0; nodes[i]._fy = 0;
        }
        stepCount++;
        return 0;
    }

    // 初始化临时力
    for (var i = 0; i < N; i++) {
        nodes[i]._fx = 0;
        nodes[i]._fy = 0;
    }

    // 重置 BH 诊断计数器
    if (_diag) {
        _diag.leafHits = 0;
        _diag.cellHits = 0;
        _diag.cellMassSum = 0;
        _diag.cellForceSum = 0;
        _diag.expansions = 0;
        _diag.cutoffSkips = 0;
        _diag.selfSkips = 0;
        _diag.leafForceSum = 0;
    }

    // --- 斥力: Barnes-Hut quadtree (O(N log N), 替代 O(N²) 全对循环) ---
    var rootIdx = buildTree(nodes, N);
    for (var i = 0; i < N; i++) {
        if (pinnedNodes[nodes[i].id]) continue;
        computeRepulsion(rootIdx, nodes[i], BH_THETA);
    }

    // --- 引力: 每条边 ---
    for (var e = 0; e < edges.length; e++) {
        var edge = edges[e];
        var src = nodeIndex[edge.source];
        var tgt = nodeIndex[edge.target];
        if (!src || !tgt) continue;

        var dx = src.x - tgt.x;
        var dy = src.y - tgt.y;
        var dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < repulsionMinDist) dist = repulsionMinDist;
        var displacement = dist - edgeRestLength;
        var f = attractionStrength * displacement;
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
    for (var i = 0; i < N; i++) {
        var n = nodes[i];
        n._fx -= (n.x - 400) * centerGravity;
        n._fy -= (n.y - 300) * centerGravity;
    }

    // --- 更新速度 + 位置 ---
    var totalEnergy = 0;
    var inPhase1 = (curAlpha >= ALPHA_PHASE2);
    var damp = inPhase1 ? PHASE1_DAMP : 0.88;  // Phase 2 高阻尼抑制欠阻尼振荡
    var velCap = inPhase1 ? PHASE1_MAXVEL : 2;  // Phase 2: 更严格的步进限制，减少过冲

    for (var i = 0; i < N; i++) {
        var n = nodes[i];
        var pin = pinnedNodes[n.id];

        if (pin) {
            // 固定节点：不累积力，位置锁定
            n.vx = 0;
            n.vy = 0;
            n._fx = 0;
            n._fy = 0;
            n.x = pin.x;
            n.y = pin.y;
        } else {
            // 力乘以当前 alpha — 温度越低运动越慢
            n.vx = (n.vx + n._fx * curAlpha) * damp;
            n.vy = (n.vy + n._fy * curAlpha) * damp;

            var speed = Math.sqrt(n.vx * n.vx + n.vy * n.vy);
            if (speed > velCap) {
                var scale = velCap / speed;
                n.vx *= scale;
                n.vy *= scale;
                speed = velCap;
            }

            n.x += n.vx;
            n.y += n.vy;
        }

        totalEnergy += n.vx * n.vx + n.vy * n.vy;
    }

    stepCount++;
    return totalEnergy;
}

// ===================================================================
// 位置回传（Float32Array transfer 零拷贝，双缓冲复用 ArrayBuffer）
// ===================================================================

var _posBufA = null;   // Float32Array(N*2)
var _posBufB = null;
var _posToggle = false;

function postPositions() {
    var N = nodes.length;

    // === SAB 路径: 零拷贝，零分配 — 写入槽位后原子翻转 ===
    if (_useSAB) {
        var inactive = 1 - Atomics.load(_sabHeader, 1);
        var off = inactive * N * 2;
        for (var i = 0; i < N; i++) {
            _sabSlots[off + i * 2]     = nodes[i].x;
            _sabSlots[off + i * 2 + 1] = nodes[i].y;
        }
        _sabHeaderFloat[2] = alpha;
        _sabHeaderFloat[3] = _lastTotalEnergy;
        // Release 屏障: 先翻转 slot，再递增 frameSeq
        Atomics.store(_sabHeader, 1, inactive);
        _sabLocalFrameSeq++;
        Atomics.store(_sabHeader, 0, _sabLocalFrameSeq);
        return;
    }

    // === Transferable 回退路径 (修复双缓冲 bug) ===
    var buf = _posToggle ? _posBufA : _posBufB;
    _posToggle = !_posToggle;

    // BUGFIX: 原检查 buf.buffer.byteLength === 0 在 transfer 后永远为 true
    // → 每帧都 new Float32Array。改为检查长度匹配，仅节点数变化时重新分配。
    if (!buf || buf.length !== N * 2) {
        buf = new Float32Array(N * 2);
        if (_posToggle) _posBufA = buf; else _posBufB = buf;
    }

    for (var i = 0; i < N; i++) {
        buf[i * 2]     = nodes[i].x;
        buf[i * 2 + 1] = nodes[i].y;
    }
    // transfer list — Worker 放弃 buffer 所有权，零拷贝
    try {
        self.postMessage(
            { type: "tick", positions: buf.buffer, stepCount: stepCount },
            [buf.buffer]
        );
    } catch (e) {
        // 非 transferable 环境回退（如某些测试环境）
        self.postMessage(
            { type: "tick", positions: buf.buffer, stepCount: stepCount }
        );
    }
}

// ===================================================================
// 物理循环（自适应 setTimeout 调度，自动反压）
// ===================================================================

function physicsTick() {
    if (!running || !nodes) return;

    // Alpha 衰减 — 两阶段: 快速展开 → 精细沉降
    if (alpha > alphaMin && alpha > alphaTarget) {
        // 选择当前阶段衰减率: Phase1 快速展开 / Phase2 慢速沉降
        var decay = (alpha >= ALPHA_PHASE2) ? alphaDecay : alphaDecay2;
        alpha -= decay;
        if (alpha < alphaTarget) alpha = alphaTarget;
    }

    // 步数: Phase1(慢速展开) / Phase2(正常) / idle / low — 永不停止
    var steps;
    if (alpha >= ALPHA_PHASE2) {
        steps = PHASE1_STEPS;
    } else if (alpha >= ALPHA_IDLE) {
        steps = 4;  // Phase 2: 减少步数 (12→4)，防止 velCap 硬夹导致过冲振荡
    } else if (alpha >= alphaMin) {
        steps = SLEEP_STEPS;
    } else {
        steps = IDLE_STEPS;
    }

    for (var s = 0; s < steps; s++) {
        _lastTotalEnergy = step();
    }

    postPositions();
}

function scheduleNextTick() {
    if (!running || !nodes) return;

    var start = Date.now();
    physicsTick();
    var elapsed = Date.now() - start;

    // 滑动窗口 — 将当前帧耗时写入环形缓冲
    frameTimes[frameIdx] = elapsed;
    frameIdx = (frameIdx + 1) % FRAME_WINDOW;
    if (frameCount < FRAME_WINDOW) frameCount++;

    // 计算滑动窗口平均耗时（防止单帧抖动）
    var avgElapsed = 0;
    for (var i = 0; i < frameCount; i++) {
        avgElapsed += frameTimes[i];
    }
    avgElapsed /= frameCount;

    // 自适应反压: target - avg，但保底下限防背靠背
    var delay = Math.max(SCHEDULE_MIN_DELAY, SCHEDULE_TARGET - avgElapsed);

    intervalId = setTimeout(scheduleNextTick, delay);
}

// ===================================================================
// 消息处理
// ===================================================================

self.onmessage = function (e) {
    var msg = e.data;
    if (!msg || !msg.type) return;

    switch (msg.type) {
        case "init":
            // 接收实际 maxDegree 用于物理半径计算（必须在节点循环之前设置）
            if (msg.maxDegree !== undefined) _maxDegree = Math.max(1, msg.maxDegree);

            // 深拷贝节点数据，Worker 拥有独立副本
            nodes = [];
            if (msg.nodes) {
                for (var i = 0; i < msg.nodes.length; i++) {
                    var src = msg.nodes[i];
                    nodes.push({
                        id: src.id,
                        label: src.label,
                        x: src.x,
                        y: src.y,
                        vx: src.vx || 0,
                        vy: src.vy || 0,
                        degree: src.degree || 0,
                        isOrphan: src.isOrphan || false,
                        _logDeg: src._logDeg !== undefined ? src._logDeg : Math.log((src.degree || 0) + 1),
                        _physR: src._physR !== undefined ? src._physR : getNodePhysRadius(src.degree, src._logDeg),
                        _fx: 0,
                        _fy: 0
                    });
                }
            }

            edges = [];
            if (msg.edges) {
                for (var e = 0; e < msg.edges.length; e++) {
                    edges.push({
                        source: msg.edges[e].source,
                        target: msg.edges[e].target
                    });
                }
            }

            // 覆盖默认参数
            if (msg.options) {
                var o = msg.options;
                if (o.repulsionStrength   !== undefined) repulsionStrength   = o.repulsionStrength;
                if (o.attractionStrength  !== undefined) attractionStrength  = o.attractionStrength;
                if (o.repulsionMinDist    !== undefined) repulsionMinDist    = o.repulsionMinDist;
                if (o.edgeRestLength      !== undefined) edgeRestLength      = o.edgeRestLength;
                if (o.centerGravity       !== undefined) centerGravity       = o.centerGravity;
                if (o.maxVelocity         !== undefined) maxVelocity         = o.maxVelocity;
                if (o.damping             !== undefined) damping             = o.damping;
                if (o.energyThreshold     !== undefined) energyThreshold     = o.energyThreshold;
                if (o.maxIterations       !== undefined) maxIterations       = o.maxIterations;
                if (o.stepsPerFrame       !== undefined) stepsPerFrame       = o.stepsPerFrame;
            }

            stepCount = 0;
            pinnedNodes = {};

            // 初始化 BH 诊断
            _diag = {
                leafHits: 0, cellHits: 0, cellMassSum: 0, cellForceSum: 0,
                expansions: 0, cutoffSkips: 0, selfSkips: 0, leafForceSum: 0
            };
            _diagTickCount = 0;

            // 预分配双缓冲 ArrayBuffer — 消除 postPositions 每帧 new Float32Array
            var bufSize = nodes.length * 2;
            _posBufA = new Float32Array(bufSize);
            _posBufB = new Float32Array(bufSize);
            _posToggle = false;
            // 构建节点索引 — 节点集不变，只需在 init 时构建一次，step() 中复用
            nodeIndex = {};
            for (var ni = 0; ni < nodes.length; ni++) {
                nodeIndex[nodes[ni].id] = nodes[ni];
            }
            // 分配 Barnes-Hut quadtree 对象池（每次 init 重新分配，每步复用零 GC）
            MAX_QT_NODES = nodes.length * 4 + 100;
            _qtNodes = new Array(MAX_QT_NODES);
            for (var qi = 0; qi < MAX_QT_NODES; qi++) {
                _qtNodes[qi] = {
                    cx: 0, cy: 0, mass: 0,
                    x0: 0, y0: 0, x1: 0, y1: 0,
                    child0: -1, child1: -1, child2: -1, child3: -1,
                    body: null, maxR: 0, hasBody: false
                };
            }
            // 重置调度窗口和 Alpha 冷却
            frameIdx = 0;
            frameCount = 0;
            alpha = alphaInit;
            alphaTarget = alphaMin;

            // 尝试创建 SharedArrayBuffer 进行零拷贝通信
            _useSAB = false;
            _sab = null;
            _sabHeader = null;
            _sabHeaderFloat = null;
            _sabSlots = null;
            _sabLocalFrameSeq = 0;
            if (typeof SharedArrayBuffer !== "undefined") {
                try {
                    var sabSize = _SAB_HEADER_INTS * 4 + nodes.length * 2 * 2 * 4;
                    _sab = new SharedArrayBuffer(sabSize);
                    _sabHeader = new Int32Array(_sab, 0, _SAB_HEADER_INTS);
                    _sabHeaderFloat = new Float32Array(_sab, 0, _SAB_HEADER_INTS);
                    _sabSlots = new Float32Array(_sab, _SAB_HEADER_INTS * 4, nodes.length * 2 * 2);
                    // 初始化 header: frameSeq=0, slot=0, alpha=alphaInit
                    _sabHeaderFloat[2] = alphaInit;
                    _sabHeaderFloat[3] = 0;
                    // 写初始位置到 slot 0
                    for (var pi = 0; pi < nodes.length; pi++) {
                        _sabSlots[pi * 2]     = nodes[pi].x;
                        _sabSlots[pi * 2 + 1] = nodes[pi].y;
                    }
                    self.postMessage({ type: "sab-ready", sab: _sab, nodeCount: nodes.length });
                    _useSAB = true;
                } catch (e) {
                    // SAB creation failed — silently fall back to Transferable
                }
            }
            break;

        case "start":
            if (running) {
                // 可能处于 idle — 唤醒
                if (alpha <= alphaMin) {
                    alpha = alphaInit;
                    alphaTarget = alphaMin;
                    scheduleNextTick();
                }
                break;
            }
            running = true;
            alpha = alphaInit;
            alphaTarget = alphaMin;
            if (!intervalId) scheduleNextTick();
            break;

        case "stop":
            running = false;
            if (intervalId) {
                clearTimeout(intervalId);
                intervalId = null;
            }
            break;

        case "pin":
            if (msg.nodeId) {
                pinnedNodes[msg.nodeId] = { x: msg.x, y: msg.y };
                stepCount = 0;
                // 拖拽时恢复 alpha — 周围节点平滑适应新位置
                if (alpha < alphaRestoreDrag) {
                    alpha = alphaRestoreDrag;
                    alphaTarget = alphaMin;
                }
                // 唤醒闲置 Worker
                var wasIdle = (alpha <= alphaMin);
                if (!running) running = true;
                if (wasIdle || !intervalId) scheduleNextTick();
            }
            break;

        case "move_pin":
            // 拖拽中更新固定节点位置（不暂停物理）
            if (msg.nodeId && pinnedNodes[msg.nodeId]) {
                pinnedNodes[msg.nodeId].x = msg.x;
                pinnedNodes[msg.nodeId].y = msg.y;
                // 同步到 Worker 的节点副本
                var mpn = nodeIndex ? nodeIndex[msg.nodeId] : null;
                if (mpn) {
                    mpn.x = msg.x;
                    mpn.y = msg.y;
                }
                // 拖拽中保持 alpha 不低于 restore — 持续给周围节点赋能
                if (alpha < alphaRestoreDrag) alpha = alphaRestoreDrag;
            }
            break;

        case "set_param":
            // 运行时调整物理参数 — 从设置面板实时更新
            if (msg.key === "repulsionStrength") repulsionStrength = msg.value;
            else if (msg.key === "attractionStrength") attractionStrength = msg.value;
            else if (msg.key === "edgeRestLength") edgeRestLength = msg.value;
            else if (msg.key === "centerGravity") centerGravity = msg.value;
            else if (msg.key === "BH_THETA") BH_THETA = msg.value;
            else if (msg.key === "BH_CUTOFF") { BH_CUTOFF_SQ = msg.value * msg.value; }
            else if (msg.key === "maxVelocity") maxVelocity = msg.value;
            else if (msg.key === "alphaDecay") alphaDecay = msg.value;
            else if (msg.key === "alphaDecay2") alphaDecay2 = msg.value;
            else if (msg.key === "PHASE1_DAMP") PHASE1_DAMP = msg.value;
            else if (msg.key === "PHASE1_MAXVEL") PHASE1_MAXVEL = msg.value;
            else if (msg.key === "PHASE1_STEPS") PHASE1_STEPS = msg.value;
            // 唤醒模拟让新参数生效 — 高 alpha 注入产生明显运动，直观反馈参数变化
            if (alpha <= ALPHA_IDLE) {
                alpha = 0.45;
                alphaTarget = alphaMin;
                if (!running) running = true;
            }
            if (!intervalId) scheduleNextTick();
            break;

        case "set_alpha":
            // 能量注入 (不扰动位置): 重置 alpha 从注入值慢慢衰减到最低 —
            // 首次显示/重建后让图谱保持活跃运动直至自然收敛
            if (typeof msg.alpha === "number" && msg.alpha > 0) {
                alpha = Math.min(1, msg.alpha);
                alphaTarget = alphaMin;
                if (!running) running = true;
            }
            if (!intervalId) scheduleNextTick();
            break;

        case "unpin":
            if (msg.nodeId) {
                delete pinnedNodes[msg.nodeId];
                // 释放时高 alpha — 快速回弹，周围节点强力推开被拖拽节点
                if (alpha < alphaRestoreDrag) {
                    alpha = alphaRestoreDrag;
                    alphaTarget = alphaMin;
                }
            }
            break;
    }
};
