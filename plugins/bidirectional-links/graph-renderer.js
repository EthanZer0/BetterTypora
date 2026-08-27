/**
 * Bidirectional Links — Graph Renderer
 * =====================================
 * Canvas 2D 渲染器，处理:
 *   - 相机系统（pan / zoom / world↔screen 坐标变换）
 *   - 节点绘制（原生 arc + 径向渐变 → 任意缩放级别原生清晰度）
 *   - 边绘制（细半透明直线 → 悬停/选中时高亮加粗）
 *   - 标签显示（屏幕空间固定字号 → 永不模糊；视口裁剪 + 密度限制）
 *   - 高分屏适配（devicePixelRatio）
 *   - 交互: 命中测试、单击选中、双击打开、拖拽/缩放
 *   - 动画: _animStates lerp 系统 — hover 缩放、filter 渐隐
 *   - 背景: 底色 + 圆点网格图案 + 径向暗角
 *
 * 视觉配色: "Slate & Indigo" 调色板
 */

(function () {
    "use strict";

    var FONT_STACK = "'Microsoft YaHei', '微软雅黑', 'PingFang SC', sans-serif";

    // ===================================================================
    // 调色板
    // ===================================================================

    var PALETTE_LIGHT = {
        // 扁平节点按 degree 分层 — 纯色 fill + 描边 stroke
        NODE_HUB_FILL:    "#3050C0",
        NODE_HUB_STROKE:  "rgba(255,255,255,0.30)",
        NODE_MID_FILL:    "#6880D0",
        NODE_MID_STROKE:  "rgba(255,255,255,0.20)",
        NODE_LOW_FILL:    "#A0B8E8",
        NODE_LOW_STROKE:  "rgba(255,255,255,0.14)",
        ORPHAN_FILL:      "#C5C8D0",
        ORPHAN_STROKE:    "rgba(255,255,255,0.08)",

        // 边: 暖灰 — 适中透明度，鸟瞰可见
        COLOR_EDGE:         "rgba(145,150,168,0.20)",
        COLOR_EDGE_HI:      "rgba(95,125,195,0.48)",

        // 标签
        COLOR_LABEL:        "#3C414D",
        COLOR_LABEL_SEL:    "#D44A28",
        COLOR_LABEL_BG:     "rgba(248,249,251,0.85)",
        COLOR_LABEL_BG_BORDER: "rgba(0,0,0,0.06)",
        COLOR_LABEL_OUTLINE:"rgba(255,255,255,0.65)",

        // 选中环: 鲜亮橙红
        COLOR_SELECTION:    "#E84020",
        COLOR_SELECTION_GLOW:"rgba(232,64,32,0.18)",

        // 背景
        COLOR_BG:           "#EEF0F4",
        COLOR_BG_DOT:       "rgba(0,0,0,0.038)",
        COLOR_BG_VIGNETTE:  "rgba(0,0,0,0.025)",
    };

    var PALETTE_DARK = {
        // 扁平节点按 degree 分层 — 纯色 fill + 描边 stroke
        NODE_HUB_FILL:    "#5078F0",
        NODE_HUB_STROKE:  "rgba(255,255,255,0.22)",
        NODE_MID_FILL:    "#788CC0",
        NODE_MID_STROKE:  "rgba(255,255,255,0.14)",
        NODE_LOW_FILL:    "#8E9CC0",
        NODE_LOW_STROKE:  "rgba(255,255,255,0.10)",
        ORPHAN_FILL:      "#5A5D65",
        ORPHAN_STROKE:    "rgba(255,255,255,0.06)",

        // 边
        COLOR_EDGE:         "rgba(170,178,195,0.17)",
        COLOR_EDGE_HI:      "rgba(120,148,220,0.45)",

        // 标签
        COLOR_LABEL:        "#C8CCD4",
        COLOR_LABEL_SEL:    "#F0805A",
        COLOR_LABEL_BG:     "rgba(28,30,36,0.80)",
        COLOR_LABEL_BG_BORDER: "rgba(255,255,255,0.06)",
        COLOR_LABEL_OUTLINE:"rgba(28,30,36,0.58)",

        // 选中环
        COLOR_SELECTION:    "#F05030",
        COLOR_SELECTION_GLOW:"rgba(240,80,48,0.16)",

        // 背景
        COLOR_BG:           "#1A1C22",
        COLOR_BG_DOT:       "rgba(255,255,255,0.032)",
        COLOR_BG_VIGNETTE:  "rgba(0,0,0,0.15)",
    };

    function detectDarkMode() {
        if (typeof document === "undefined") return false;
        // 优先使用 BetterTypora.theme 平台统一检测 (CSS 变量指纹, 与所有插件一致)
        if (window.BetterTypora && window.BetterTypora.theme) {
            try { return !!window.BetterTypora.theme.isDark(); } catch (e) {}
        }
        // 降级: 读 --bg-color 亮度判断暗/亮模式
        // 而不是 @media (prefers-color-scheme: dark)（那是系统设置，不是 Typora 主题）
        try {
            var bg = getComputedStyle(document.documentElement).getPropertyValue("--bg-color").trim();
            if (!bg) return false;
            // 解析 rgb/rgba/#hex → 相对亮度 (0-1)
            var lum = _parseLuminance(bg);
            return lum < 0.5;
        } catch (e) { return false; }
    }

    /** 从 CSS 颜色字符串计算相对亮度 (ITU-R BT.601) */
    function _parseLuminance(color) {
        try {
            var r = 0, g = 0, b = 0;
            if (color.indexOf("rgb") === 0) {
                var m = color.match(/[\d.]+/g);
                if (m && m.length >= 3) { r = +m[0]; g = +m[1]; b = +m[2]; }
            } else if (color[0] === "#") {
                var h = color.substring(1);
                if (h.length === 3) h = h[0]+h[0]+h[1]+h[1]+h[2]+h[2];
                if (h.length >= 6) { r = parseInt(h.substring(0,2), 16); g = parseInt(h.substring(2,4), 16); b = parseInt(h.substring(4,6), 16); }
            }
            // sRGB → 线性 → 相对亮度
            var lin = function (c) { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
            return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
        } catch (e) { return 0.5; }
    }

    // ===================================================================
    // 构造函数
    // ===================================================================

    function GraphRenderer(canvas, options) {
        this._canvas = canvas;
        this._ctx = canvas.getContext("2d");
        this._options = options || {};
        this._onNodeClick = this._options.onNodeClick || null;
        this._onNodeDblClick = this._options.onNodeDblClick || null;
        this._onNodeDragStart = this._options.onNodeDragStart || null;
        this._onNodeDragEnd = this._options.onNodeDragEnd || null;
        this._onNodeDragMove = this._options.onNodeDragMove || null;
        this._onReady = this._options.onReady || null;   // 渐显完成后回调（触发 Worker 物理启动）
        this._getNodeRadius = this._options.getNodeRadius || function (d, max, logDeg) {
            if (max <= 0) return 4.5;
            var t = (logDeg !== undefined ? logDeg : Math.log(d + 1)) / Math.log(max + 1);
            return 3 + t * 19;
        };
        this._maxDegree = this._options.maxDegree || 0;
        this._dpr = (typeof window !== "undefined" && window.devicePixelRatio) || 1;

        // 主题
        this._dark = detectDarkMode();
        this._palette = this._dark ? PALETTE_DARK : PALETTE_LIGHT;

        // 相机 (CSS 像素坐标)
        this._ox = 0;
        this._oy = 0;
        this._s  = 1;
        this._targetS = 1;  // 缩放目标值，_s 每帧 lerp 逼近
        this._zoomAnchorX = 0; this._zoomAnchorY = 0; // 缩放锚点 (world 坐标)
        this._zoomAnchorSX = 0; this._zoomAnchorSY = 0; // 缩放锚点 (screen 坐标)
        this._minS = 0.06;
        this._maxS = 4.5;

        // 交互
        this._hoverId = null;
        this._selId   = null;
        this._selNeighborSet = null;  // 选中节点+邻居ID集合; null=无选中→无淡化
        this._dragging = false;
        this._dragMode = null;
        this._dragSX = 0;
        this._dragSY = 0;
        this._dragMoved = false;

        // 相机惯性 — pan 松手后衰减滑动
        this._panVX = 0;            // 相机平移速度 (px/frame)
        this._panVY = 0;
        this._panMomentum = 0.92;   // 每帧衰减系数
        this._panMinVelocity = 0.3; // 低于此速度归零

        // 缓动释放：拖拽松手后 N 帧内从 pinned 坐标线性过渡回物理坐标
        this._releaseNode = null;     // { id, fromX, fromY, ticksLeft }
        this._releaseTicks = 6;       // 过渡帧数

        // 渲染状态
        this._nodes = [];
        this._edges = [];
        this._byId  = {};
        this._raf  = null;
        this._dirty = true;
        this._alive = false;
        this._sim   = false;

        // GPU 模式标志
        this._gpuMode = false;
        this._gpuRenderer = null;
        this._labelCanvas = null;

        // 渐显动画（无星群展开 — 首帧即完全可见）
        this._fadeIn = 1;           // 直接全不透明，无渐显过渡
        this._fadeInActive = false; // 渐显已完成

        // 过滤
        this._filter = null;

        // 边 alpha 平滑缓存 — edgeKey → { currentAlpha, targetAlpha }
        this._edgeAlpha = {};

        // backing store
        this._pxW = 0;
        this._pxH = 0;

        // 动画状态
        this._animStates = {};

        // 平滑坐标缓存（布局运动的缓动效果）
        this._smooth = {};  // nodeId → { sx, sy }

        // SAB 零拷贝同步
        this._sabHeader = null;       // Int32Array view (frameSeq, activeSlot)
        this._sabHeaderFloat = null;  // Float32Array view (alpha, energy)
        this._sabSlots = null;        // Float32Array view (双槽位 positions)
        this._lastSabSeq = -1;        // 上次看到的 frameSeq

        // 背景点阵图案（懒创建）
        this._dotPattern = null;
        this._dotPatternDPR = 0;

        // 离屏背景缓存 — 底色 + 点阵 + 暗角，仅在主题/尺寸变化时重建
        this._bgCanvas = null;
        this._bgDpr = 0;
        this._bgDark = null;

        // 复用的临时坐标对象 — 消除热路径 GC 分配
        this._selScratch = { x: 0, y: 0 };  // 选中环 worldToScreen 复用

        // 标签对象池 — 每帧复用消除 200 个临时对象分配
        var MAX_LABELS = 200;
        this._labelPool = new Array(MAX_LABELS);
        for (var lp = 0; lp < MAX_LABELS; lp++) {
            this._labelPool[lp] = { sx: 0, sy: 0, text: "", pri: 0, isHi: false, isSel: false, degree: 0 };
        }
        this._labelCount = 0;

        this._bind();
    }

    // ===================================================================
    // 调色板
    // ===================================================================

    GraphRenderer.prototype._ensurePalette = function () {
        var isDark = detectDarkMode();
        if (isDark !== this._dark) {
            this._dark = isDark;
            this._palette = isDark ? PALETTE_DARK : PALETTE_LIGHT;
            this._dotPattern = null;
            this._bgCanvas = null; // 主题切换 → 背景缓存失效
            // 颜色缓存失效
            var nodes = this._nodes;
            if (nodes) {
                for (var ni = 0; ni < nodes.length; ni++) {
                    delete nodes[ni]._ccache;
                }
            }
        }
    };

    // ===================================================================
    // 背景点阵图案
    // ===================================================================

    GraphRenderer.prototype._ensureDotPattern = function () {
        var dpr = this._dpr;
        if (this._dotPatternDPR === dpr && this._dotPattern) return;

        var cellSize = 24;
        var px = Math.round(cellSize * dpr);
        var off = document.createElement("canvas");
        off.width = px;
        off.height = px;
        var octx = off.getContext("2d");

        var dotR = 1.2 * dpr;
        octx.fillStyle = this._palette.COLOR_BG_DOT;
        octx.beginPath();
        octx.arc(px / 2, px / 2, dotR, 0, Math.PI * 2);
        octx.fill();

        this._dotPattern = octx.createPattern(off, "repeat");
        this._dotPatternDPR = dpr;
    };

    /**
     * 将静态背景（底色 + 点阵 + 暗角）缓存到离屏 canvas，
     * 每帧只需 drawImage() blit，避免重复绘制。
     * 在主题切换或 canvas 尺寸变化时自动重建缓存。
     */
    GraphRenderer.prototype._renderBackground = function () {
        var dpr = this._dpr;
        var isDark = detectDarkMode();
        var pw = this._pxW;
        var ph = this._pxH;

        // 主题背景色 (CSS 变量) — 跟随当前主题 (含同亮度主题切换,
        // 如 claude 米白 ↔ github 白, isDark 不变但背景色不同)
        var bgColor = null;
        try {
            bgColor = getComputedStyle(document.documentElement)
                .getPropertyValue("--bg-color").trim();
        } catch (e) {}
        if (!bgColor) bgColor = isDark ? "#1A1C22" : "#EEF0F4";

        // 失效检测：主题背景变化 / 明暗变化 / dpr 变化 / 尺寸变化 / 首次
        if (!this._bgCanvas || this._bgDpr !== dpr || this._bgDark !== isDark ||
            this._bgColorValue !== bgColor ||
            this._bgCanvas.width !== pw || this._bgCanvas.height !== ph) {

            var bg = document.createElement("canvas");
            bg.width = pw;
            bg.height = ph;
            var bgCtx = bg.getContext("2d");
            if (!bgCtx) return; // 极端情况：无法获取 2D 上下文

            var cw = pw / dpr;
            var ch = ph / dpr;
            var p = isDark ? PALETTE_DARK : PALETTE_LIGHT;

            // 1. 底色 = 当前主题 --bg-color
            bgCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
            bgCtx.fillStyle = bgColor;
            bgCtx.fillRect(0, 0, cw, ch);
            this._bgColorValue = bgColor;
            if (window.__btGraphBgLog) {
                console.log("[图谱主题] 背景重建 bg=" + bgColor + " (旧=" +
                    (this._bgColorValue === bgColor ? "同" : this._bgColorValue) + ")");
            }

            // 2. 点阵图案（确保已创建）
            this._ensureDotPattern();
            if (this._dotPattern) {
                bgCtx.fillStyle = this._dotPattern;
                bgCtx.fillRect(0, 0, cw, ch);
            }

            // 3. 径向暗角
            var vignetteR = Math.sqrt(cw * cw + ch * ch) * 0.55;
            var grad = bgCtx.createRadialGradient(
                cw / 2, ch / 2, vignetteR * 0.35,
                cw / 2, ch / 2, vignetteR
            );
            grad.addColorStop(0, "rgba(0,0,0,0)");
            grad.addColorStop(1, p.COLOR_BG_VIGNETTE);
            bgCtx.fillStyle = grad;
            bgCtx.fillRect(0, 0, cw, ch);

            this._bgCanvas = bg;
            this._bgDpr = dpr;
            this._bgDark = isDark;
        }

        // 清空主画布 + blit 背景缓存（GPU 模式：背景由 GPU 纹理处理，跳过 blit）
        if (!this._gpuMode) {
            this._ctx.clearRect(0, 0, pw, ph);
            this._ctx.drawImage(this._bgCanvas, 0, 0);
        }
    };

    // ===================================================================
    // 动画系统
    // ===================================================================

    GraphRenderer.prototype._getAnimState = function (nodeId) {
        if (!this._animStates[nodeId]) {
            this._animStates[nodeId] = { currentScale: 1, targetScale: 1,
                                         currentAlpha: 1, targetAlpha: 1 };
        }
        return this._animStates[nodeId];
    };

    GraphRenderer.prototype._lerpAnimations = function () {
        var LERP = 0.18;
        var EPSILON = 0.0005;
        var anyAnimating = false;

        for (var id in this._animStates) {
            var st = this._animStates[id];
            st.currentScale += (st.targetScale - st.currentScale) * LERP;
            st.currentAlpha  += (st.targetAlpha  - st.currentAlpha)  * LERP;

            if (Math.abs(st.currentScale - st.targetScale) > EPSILON ||
                Math.abs(st.currentAlpha  - st.targetAlpha)  > EPSILON) {
                anyAnimating = true;
            }
        }

        if (anyAnimating) this._dirty = true;
        return anyAnimating;
    };

    /** 坐标缓动：用平滑坐标渲染，每帧向真实坐标逼近 */
    GraphRenderer.prototype._lerpPositions = function (nodes) {
    var LERP = this._sim ? (this._lerpSpeed || 0.45) : (this._lerpSpeed ? this._lerpSpeed * 0.67 : 0.30);
        var smooth = this._smooth;
        var anyMoving = false;

        for (var i = 0; i < nodes.length; i++) {
            var n = nodes[i];
            var sm = smooth[n.id];
            if (!sm) {
                smooth[n.id] = { sx: n.x, sy: n.y };
                continue; // 第一帧不对齐，等下一帧
            }

            var dx = n.x - sm.sx;
            var dy = n.y - sm.sy;
            var distSq = dx * dx + dy * dy;

            // 距离太小：直接对齐
            if (distSq < 0.0001) { sm.sx = n.x; sm.sy = n.y; continue; }

            // 大跳跃：直接对齐（避免长距离滑动）
            if (distSq > 250000) { sm.sx = n.x; sm.sy = n.y; anyMoving = true; continue; }

            sm.sx += dx * LERP;
            sm.sy += dy * LERP;

            if (distSq < 0.002) { sm.sx = n.x; sm.sy = n.y; }
            anyMoving = true;
        }

        // 惰性清理已不存在的节点 — 每 60 帧执行一次
        this._smoothCleanFrame = (this._smoothCleanFrame || 0) + 1;
        if (this._smoothCleanFrame >= 60) {
            this._smoothCleanFrame = 0;
            for (var id in smooth) {
                if (!this._byId[id]) delete smooth[id];
            }
        }

        if (anyMoving) this._dirty = true;
    };

    // ===================================================================
    // SAB 零拷贝同步
    // ===================================================================

    /** 接收来自 graph-view 的 SAB 视图引用 */
    GraphRenderer.prototype.setSAB = function (header, headerFloat, slots) {
        this._sabHeader = header;
        this._sabHeaderFloat = headerFloat;
        this._sabSlots = slots;
        this._lastSabSeq = -1;
    };

    /**
     * 从 SharedArrayBuffer 读取最新物理位置到 nodes[i].x/y。
     * 在 render() 顶部调用，仅当有新帧时才拷贝数据。
     * @returns {boolean} 是否有新数据
     */
    GraphRenderer.prototype._syncFromSAB = function (nodes) {
        if (!this._sabHeader) return false;

        var seq = Atomics.load(this._sabHeader, 0);
        if (seq === this._lastSabSeq) return false; // 无新帧

        this._lastSabSeq = seq;
        var activeSlot = Atomics.load(this._sabHeader, 1);
        var N = nodes.length;
        var slots = this._sabSlots;
        var sourceN = (slots.length >>> 1) >>> 1; // slots 总 N = (slots.length / 2) / 2
        var copyN = N < sourceN ? N : sourceN;    // 防御: 取较小者
        var offset = activeSlot * sourceN * 2;

        for (var i = 0; i < copyN; i++) {
            nodes[i].x = slots[offset + i * 2];
            nodes[i].y = slots[offset + i * 2 + 1];
        }

        this._dirty = true;
        return true;
    };

    // ===================================================================
    // 相机
    // ===================================================================

    GraphRenderer.prototype.screenToWorld = function (sx, sy, out) {
        var wx = (sx - this._ox) / this._s;
        var wy = (sy - this._oy) / this._s;
        if (out) { out.x = wx; out.y = wy; return out; }
        return { x: wx, y: wy };
    };

    GraphRenderer.prototype.worldToScreen = function (wx, wy, out) {
        var sx = wx * this._s + this._ox;
        var sy = wy * this._s + this._oy;
        if (out) { out.x = sx; out.y = sy; return out; }
        return { x: sx, y: sy };
    };

    GraphRenderer.prototype._cam = function () {
        var d = this._dpr, s = this._s;
        this._ctx.setTransform(d * s, 0, 0, d * s, d * this._ox, d * this._oy);
    };

    GraphRenderer.prototype.centerCamera = function (nodes) {
        if (!nodes || !nodes.length) return;
        var x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
        for (var i = 0; i < nodes.length; i++) {
            var n = nodes[i];
            if (n.x < x0) x0 = n.x; if (n.y < y0) y0 = n.y;
            if (n.x > x1) x1 = n.x; if (n.y > y1) y1 = n.y;
        }
        var ww = x1 - x0 + 48, wh = y1 - y0 + 48;
        var cw = this._canvas.clientWidth || 900, ch = this._canvas.clientHeight || 600;
        var s = Math.min(cw / ww, ch / wh);
        s = Math.max(this._minS, Math.min(this._maxS, s));
        // 默认缩放不超过 0.75，鸟瞰全局
        if (s > 0.75) s = 0.75;
        this._s = s;
        this._targetS = s;  // zoom target in sync
        this._ox = (cw - (x0 + x1) * s) / 2;
        this._oy = (ch - (y0 + y1) * s) / 2;
    };

    // ===================================================================
    // 节点绘制（扁平纯色 + LOD 三级）
    // ===================================================================

    /** 确保节点颜色缓存 — 懒创建 nd._ccache { fill, stroke, tier } */
    GraphRenderer.prototype._ensureNodeColor = function (nd) {
        if (nd._ccache) return;
        var p = this._palette;
        var isOrphan = nd.isOrphan;
        var logTee = this._maxDegree > 0
            ? (nd._logDeg !== undefined ? nd._logDeg : Math.log((nd.degree || 0) + 1)) / Math.log(this._maxDegree + 1)
            : 0;
        if (logTee !== logTee) logTee = 0;
        if (isOrphan) {
            nd._ccache = { fill: p.ORPHAN_FILL, stroke: p.ORPHAN_STROKE, tier: 3 };
        } else if (logTee > 0.65) {
            nd._ccache = { fill: p.NODE_HUB_FILL, stroke: p.NODE_HUB_STROKE, tier: 0 };
        } else if (logTee > 0.30) {
            nd._ccache = { fill: p.NODE_MID_FILL, stroke: p.NODE_MID_STROKE, tier: 1 };
        } else {
            nd._ccache = { fill: p.NODE_LOW_FILL, stroke: p.NODE_LOW_STROKE, tier: 2 };
        }
    };

    // ===================================================================
    // 主渲染
    // ===================================================================

    GraphRenderer.prototype.render = function (nodes, edges, byId) {
        this._nodes = nodes; this._edges = edges; this._byId = byId || this._byId;

        // 从 SharedArrayBuffer 同步物理位置（零拷贝；无新帧时直接返回）
        this._syncFromSAB(nodes);

        this._ensurePalette();
        this._lerpAnimations();

        // 缓动释放 — 拖拽松手后 N 帧内从 pinned 位置过渡到 Worker 物理坐标
        if (this._releaseNode) {
            var rel = this._releaseNode;
            var rn = this._byId[rel.id];
            if (rn && rel.ticksLeft > 0) {
                // 直接用 _smooth 驱动显示位置：ease-out 插值
                var sm = this._smooth[rel.id];
                var physX = sm ? sm.sx : rn.x;
                var physY = sm ? sm.sy : rn.y;
                var rawT = (this._releaseTicks - rel.ticksLeft + 1) / this._releaseTicks;
                // cubic ease-out: 先快后慢，视觉更自然的回弹
                var t = 1 - Math.pow(1 - rawT, 3);
                this._smooth[rel.id] = {
                    sx: rel.fromX + (physX - rel.fromX) * t,
                    sy: rel.fromY + (physY - rel.fromY) * t
                };
                rel.ticksLeft--;
                this._dirty = true;
            } else {
                this._releaseNode = null;
            }
        }

        // 坐标缓动
        this._lerpPositions(nodes);

        // 渐显进度（已移除 — _fadeIn 初始化为 1，无需衰减）

        if (!this._sim && !this._dirty) return;
        this._dirty = false;

        var ctx = this._ctx, dpr = this._dpr, p = this._palette;
        var cw = this._canvas.clientWidth, ch = this._canvas.clientHeight;
        // 尺寸未就绪 (布局未完成, 如嵌入容器首帧) → 跳过本帧, 渲染循环
        // 下一帧重试 — 0 尺寸会让 canvas.width=0 且 drawImage(0尺寸) 抛错
        if (!cw || !ch) return;
        var pw = Math.round(cw * dpr), ph = Math.round(ch * dpr);

        if (this._pxW !== pw || this._pxH !== ph) {
            this._canvas.width = pw; this._canvas.height = ph;
            this._pxW = pw; this._pxH = ph;
            this._dotPattern = null;
            this._bgCanvas = null; // 尺寸变化 → 背景缓存失效
        }

        // 离屏背景缓存：底色 + 点阵 + 暗角（仅失效时重建，否则 blit）
        this._renderBackground();

        // 前景 alpha（无星群展开 — 始终为 1）
        var fadeAlpha = 1;

        // ---- 预计算：边 alpha + 节点状态（Canvas 2D 和 GPU 路径共享） ----
        var hovNode  = this._hoverId ? this._byId[this._hoverId] : null;
        var selNode  = this._selId   ? this._byId[this._selId]   : null;
        var anyHi    = !!(hovNode || selNode);
        var filt     = this._filter;

        var s = this._s;
        var edgePre = null;  // [{smoothAlpha, hi, skip, sxx1, syy1, sxx2, syy2, smA, smB}]
        var nodePre = null;  // [{sx, sy, baseR, scale, alpha, tier, isSel, isHi, skip, sxx, syy, screenR}]

        if (this._gpuMode && this._gpuRenderer) {
            edgePre = this._prepEdges(fadeAlpha, hovNode, selNode, anyHi, filt);
            nodePre = this._prepNodes(fadeAlpha, anyHi, filt);
            this._renderGPU(fadeAlpha, edgePre, nodePre);
        } else {
            // Canvas 2D 路径：内联计算，避免构建中间数组
            edgePre = null; nodePre = null;

        // ---- 屏幕空间：连线（原生分辨率，消除亚像素模糊） ----
        ctx.save();
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

        // --- 边 (使用内联计算) ---
        var tMax = this._maxDegree > 0 ? this._maxDegree : 1;

        for (var e = 0; e < edges.length; e++) {
            var ee = edges[e];
            var a = this._byId[ee.source], b = this._byId[ee.target];
            if (!a || !b) continue;

            var isIncident = anyHi && (
                (hovNode && (a.id === hovNode.id || b.id === hovNode.id)) ||
                (selNode && (a.id === selNode.id || b.id === selNode.id))
            );

            var alpha = 1.0;

            if (filt) {
                var aIn = filt.has(a.id), bIn = filt.has(b.id);
                if (!aIn && !bIn) {
                    alpha = 0.03;
                } else if (!aIn || !bIn) {
                    alpha = 0.10;
                }
            }

            if (!isIncident) {
                if (anyHi) {
                    alpha *= 0.10;
                }
                if (filt && filt.has(a.id) && filt.has(b.id)) {
                    alpha = Math.max(alpha, 0.9);
                }
            }

            var hi = isIncident && !filt;
            if (isIncident && filt && filt.has(a.id) && filt.has(b.id)) hi = true;

            // 度加权透明度：连接至少一个 hub 的边更显眼
            if (!hi && !filt) {
                var edgeDegree = Math.max(a.degree, b.degree) / tMax;
                // 低度边 0.7x → 高度边 2.2x alpha 乘数（hub 网络泛光）
                alpha *= 0.7 + edgeDegree * 1.5;
                // 缩小时跳过仅有低度节点连接的边 — 减少视觉噪点和绘制开销
                if (this._s < 0.3 && edgeDegree < 0.25) continue;
            }

            // 平滑坐标 → 屏幕空间（内联，零分配）
            var smA = this._smooth[a.id];
            var smB = this._smooth[b.id];
            var ax = smA ? smA.sx : a.x, ay = smA ? smA.sy : a.y;
            var bx = smB ? smB.sx : b.x, by = smB ? smB.sy : b.y;
            var sxx1 = ax * this._s + this._ox, syy1 = ay * this._s + this._oy;
            var sxx2 = bx * this._s + this._ox, syy2 = by * this._s + this._oy;

            // 视口裁剪 — 两端都在屏幕外（含 60px margin）则跳过
            if (sxx1 < -60 && sxx2 < -60) continue;
            if (sxx1 > cw + 60 && sxx2 > cw + 60) continue;
            if (syy1 < -60 && syy2 < -60) continue;
            if (syy1 > ch + 60 && syy2 > ch + 60) continue;

            // 边 alpha 平滑过渡 — 每帧 lerp 到目标值
            var ek = ee._ea || (ee._ea = a.id + "|" + b.id);
            var ae = this._edgeAlpha[ek];
            if (!ae) { ae = { current: 1, target: 1 }; this._edgeAlpha[ek] = ae; }
            ae.target = alpha;
            var EDGE_LERP = 0.22;
            ae.current += (ae.target - ae.current) * EDGE_LERP;
            if (Math.abs(ae.current - ae.target) < 0.001) ae.current = ae.target;
            var smoothAlpha = ae.current;

            // 屏幕空间边长渐变透明度 — 远边淡化增强深度感
            var sdx = sxx2 - sxx1, sdy = syy2 - syy1;
            var screenLen = Math.sqrt(sdx * sdx + sdy * sdy);
            if (screenLen > 350) {
                smoothAlpha *= 1 - Math.min(1, (screenLen - 350) / 500) * 0.35;
            }

            ctx.beginPath();
            ctx.strokeStyle = hi ? p.COLOR_EDGE_HI : p.COLOR_EDGE;
            ctx.lineWidth = hi ? 1.8 : 1.0;
            ctx.globalAlpha = smoothAlpha * fadeAlpha;
            ctx.moveTo(sxx1, syy1);
            ctx.lineTo(sxx2, syy2);
            ctx.stroke();
            ctx.globalAlpha = 1;
        }

        ctx.restore();

        // ---- 节点 (两趟: 批量 fill + 选中环/描边) ----
        // 第一趟: 收集节点到颜色桶中 (tier 0=hub, 1=mid, 2=low, 3=orphan)
        var BUCKETS = 4;
        var bucketNodes = [[], [], [], []];  // bucketNodes[tier] → [{sxx,syy,screenR}, ...]
        var selCandidates = [];              // [{nd, baseR, scale, sx, sy, alpha, isHi}]

        for (var i = 0; i < nodes.length; i++) {
            var nd = nodes[i];

            var baseR = this._getNodeRadius(nd.degree, this._maxDegree, nd._logDeg);
            var isHi = (nd.id === this._hoverId || nd.id === this._selId);
            var isSel = (nd.id === this._selId);

            var anim = this._getAnimState(nd.id);
            var scale = anim.currentScale;
            var alpha = anim.currentAlpha;

            nd._baseR = baseR;
            nd._animCache = anim;

            // 平滑坐标
            var sm = this._smooth[nd.id];
            var sx = sm ? sm.sx : nd.x;
            var sy = sm ? sm.sy : nd.y;

            // 视口裁剪 — 跳过屏幕外节点（选中/悬停节点不跳）
            if (!isSel && !isHi && s > 0.85) {
                var marginR = (baseR * scale + 4) * s;
                var qx = sx * s + this._ox;
                var qy = sy * s + this._oy;
                if (qx < -marginR || qx > this._pxW + marginR ||
                    qy < -marginR || qy > this._pxH + marginR) {
                    continue;
                }
            }

            // 确保颜色缓存
            this._ensureNodeColor(nd);
            var tier = nd._ccache.tier;

            var effR = baseR * scale;
            var screenR = effR * s * (this._nodeScale || 1.0);
            if (screenR !== screenR || screenR <= 0 || screenR > 5000) continue;

            var sxx = sx * s + this._ox;
            var syy = sy * s + this._oy;

            // 全不透明度节点进入批量桶（选中/悬停节点单独绘制以保留个性化 alpha）
            if (!isSel && !isHi && alpha > 0.95) {
                bucketNodes[tier].push({sxx: sxx, syy: syy, screenR: screenR});
            } else {
                // 高亮/选中节点 — 单独绘制 fill + stroke（保留个性化 scale/alpha）
                ctx.save();
                ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
                ctx.globalAlpha = alpha * fadeAlpha;
                ctx.fillStyle = nd._ccache.fill;
                ctx.beginPath();
                ctx.arc(sxx, syy, screenR, 0, Math.PI * 2);
                ctx.fill();
                if (screenR >= 5) {
                    ctx.strokeStyle = nd._ccache.stroke;
                    ctx.lineWidth = Math.max(0.5, screenR * 0.06);
                    ctx.stroke();
                }
                ctx.restore();
            }

            // 选中的圆环在批量 fill 之后统一绘制
            if (isSel) {
                selCandidates.push({nd: nd, baseR: baseR, scale: scale, sx: sx, sy: sy, alpha: alpha, isHi: isHi});
            }
        }

        // 第二趟: 分批绘制
        //   LOD0 (screenR<5, fill only): 按颜色批量 fill — 零描边无 Z 序问题
        //   LOD1 (screenR≥5, fill+stroke): 逐节点绘制 — 保持 fill→stroke 顺序，
        //     避免 stroke 穿透背面节点；同时每个节点使用精确 lineWidth
        ctx.save();
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.globalAlpha = fadeAlpha;

        for (var tier = 0; tier < BUCKETS; tier++) {
            var bucket = bucketNodes[tier];
            if (!bucket || bucket.length === 0) continue;

            var fillColor, strokeColor;
            switch (tier) {
                case 0: fillColor = p.NODE_HUB_FILL;   strokeColor = p.NODE_HUB_STROKE;   break;
                case 1: fillColor = p.NODE_MID_FILL;   strokeColor = p.NODE_MID_STROKE;   break;
                case 2: fillColor = p.NODE_LOW_FILL;   strokeColor = p.NODE_LOW_STROKE;   break;
                case 3: fillColor = p.ORPHAN_FILL;     strokeColor = p.ORPHAN_STROKE;     break;
            }

            // LOD0 批量 fill — fill only 无描边，可以安全合并为一个路径
            ctx.fillStyle = fillColor;
            ctx.beginPath();
            for (var bi = 0; bi < bucket.length; bi++) {
                var be = bucket[bi];
                if (be.screenR >= 5) continue;
                ctx.moveTo(be.sxx, be.syy);
                ctx.arc(be.sxx, be.syy, be.screenR, 0, Math.PI * 2);
            }
            // 仅当有 LOD0 节点时才 fill（beginPath 后无 arc 的 fill 无影响但跳过更干净）
            ctx.fill();

            // LOD1 逐节点 fill + stroke — 保持 Z 序正确 + 精确 lineWidth
            for (var bi = 0; bi < bucket.length; bi++) {
                var be2 = bucket[bi];
                if (be2.screenR < 5) continue;
                ctx.fillStyle = fillColor;
                ctx.beginPath();
                ctx.arc(be2.sxx, be2.syy, be2.screenR, 0, Math.PI * 2);
                ctx.fill();

                ctx.strokeStyle = strokeColor;
                ctx.lineWidth = Math.max(0.5, be2.screenR * 0.06);
                ctx.beginPath();
                ctx.arc(be2.sxx, be2.syy, be2.screenR, 0, Math.PI * 2);
                ctx.stroke();
            }
        }

        ctx.restore();

        // 第三趟: 选中圆环（必须在批量节点之上）
        for (var si = 0; si < selCandidates.length; si++) {
            var sc = selCandidates[si];
            var selRWorld = sc.baseR * sc.scale + 3;
            var selSP = this.worldToScreen(sc.sx, sc.sy, this._selScratch);
            var selR = selRWorld * this._s * (this._nodeScale || 1.0);
            ctx.save();
            ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
            ctx.globalAlpha = sc.alpha * fadeAlpha;
            ctx.beginPath();
            ctx.arc(selSP.x, selSP.y, selR, 0, Math.PI * 2);
            ctx.strokeStyle = p.COLOR_SELECTION;
            ctx.lineWidth = 2.5;
            if (!this._dragging) {
                ctx.shadowColor = p.COLOR_SELECTION_GLOW;
                ctx.shadowBlur = 8;
            }
            ctx.stroke();
            ctx.shadowBlur = 0;
            ctx.strokeStyle = p.COLOR_SELECTION;
            ctx.lineWidth = 2;
            ctx.stroke();
            ctx.restore();
        }

        }

        // ---- 标签 (屏幕空间，GPU 和 Canvas 2D 共享) ----
        if (this._s < 0.13) return;

        // GPU 模式: 用 labels canvas 的 2D context；否则沿用主 ctx
        if (this._gpuMode && this._labelCanvas) {
            ctx = this._labelCanvas.getContext("2d");
            // 标签 canvas 也需要清空上一帧的内容
            ctx.clearRect(0, 0, pw, ph);
        }
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

        var FONT_BASE = this._labelSize || 12;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";

        var s = this._s;

        var scratch = {x:0, y:0}; // _inView 复用缓冲区，消除 worldToScreen 重复分配

        // 预扫描：统计视口内节点占比，用于密度感知标签阈值
        var inViewCount = 0;
        var totalCount = 0;
        for (var pci = 0; pci < nodes.length; pci++) {
            var pcn = nodes[pci];
            if (filt && !filt.has(pcn.id)) continue;
            if (this._selNeighborSet && !this._selNeighborSet.has(pcn.id)) continue;
            totalCount++;
            var pcx = this._smooth[pcn.id];
            if (_inView(this, pcx ? pcx.sx : pcn.x, pcx ? pcx.sy : pcn.y, scratch)) inViewCount++;
        }

        // 密度偏差：视口内节点密度越高，阈值越高 → 标签越少
        var density = totalCount > 0 ? inViewCount / totalCount : 0;
        var densityBias = density * 0.5;  // 最多把三个阈值分别提高 0.5

        var showAll = s > (0.8 + densityBias);
        var showMid = s > (0.5 + densityBias);
        var showTop = s > (0.13 + densityBias);

        // 中位数缓存 — degree 仅在数据变化时重新排序
        var medianDeg = 0;
        if (!showAll && showTop) {
            if (this._cachedMedianDeg === undefined || this._nodes !== nodes) {
                var degs = [];
                for (var di = 0; di < nodes.length; di++) degs.push(nodes[di].degree);
                degs.sort(function (a, b) { return a - b; });
                this._cachedMedianDeg = degs.length > 0 ? degs[Math.floor(degs.length / 2)] : 0;
            }
            medianDeg = this._cachedMedianDeg;
        }

        var MAX_LABELS = 200;
        var pool = this._labelPool;
        this._labelCount = 0;

        for (var i = 0; i < nodes.length; i++) {
            var n = nodes[i];
            if (filt && !filt.has(n.id)) continue;
            if (this._selNeighborSet && !this._selNeighborSet.has(n.id)) continue;

            // 平滑坐标 — 仅计算一次
            var sm2 = this._smooth[n.id];
            var nx = sm2 ? sm2.sx : n.x;
            var ny = sm2 ? sm2.sy : n.y;
            // _inView 传入 scratch 复用屏幕坐标，消除 redundant worldToScreen
            if (!_inView(this, nx, ny, scratch)) continue;

            var hi = (n.id === this._hoverId || n.id === this._selId);
            var isSel = (n.id === this._selId);
            var visible = false;
            var pri = 0;

            if (hi) {
                visible = true;
                pri = isSel ? 10 : 9;
            } else if (showAll) {
                visible = true;
                pri = n.degree > 0 ? 3 : 1;
            } else if (showMid && n.degree > 0) {
                visible = true;
                pri = n.degree > medianDeg ? 5 : 3;
            } else if (showTop && n.degree > medianDeg) {
                visible = true;
                pri = 4;
            }

            if (!visible) continue;

            // 复用节点循环的缓存数据，消除 _getNodeRadius + _getAnimState 重复调用
            var nr2 = n._baseR !== undefined ? n._baseR : this._getNodeRadius(n.degree, this._maxDegree, n._logDeg);
            var anim2 = n._animCache || this._getAnimState(n.id);
            var drawR2 = nr2 * anim2.currentScale;

            // 从池中取对象，写入字段 — 消除每帧 GC
            if (this._labelCount >= 200) continue;
            var item = pool[this._labelCount];
            item.sx = scratch.x;
            item.sy = scratch.y + drawR2 * this._s + 10;
            item.text = n.label;
            item.pri = pri;
            item.isHi = hi;
            item.isSel = isSel;
            item.degree = n.degree;
            this._labelCount++;
        }

        // 将未使用的池条目标记为 pri=-1，确保它们排序后落到末尾
        for (var pi = this._labelCount; pi < 200; pi++) {
            pool[pi].pri = -1;
        }
        // 惰性排序 — 仅可见标签集合变化时执行（缩放跨阈值、选中/过滤变化）
        var sk = this._s.toFixed(2) + "|" + (this._selId || "") + "|" + (filt ? filt.size : 0) + "|" + showAll + "|" + showMid + "|" + showTop + "|" + inViewCount;
        if (sk !== this._labelSortKey) {
            this._labelSortKey = sk;
            pool.sort(function (a, b) { return b.pri - a.pri; });
        }

        // 提升不变状态到循环外
        ctx.lineWidth = 3;
        ctx.lineJoin = "round";
        var lastFontWt = "";
        var lastFontSize = 0;
        var lastAlpha = -1;

        for (var li = 0; li < this._labelCount && li < 200; li++) {
            var it = pool[li];

            // pri 映射到基础透明度 + 缩放级联：放大时 alpha 拉向 1.0
            var alpha;
            if (it.pri >= 10) {
                alpha = 1.0;
            } else {
                var base = 0.05 + it.pri * 0.095;
                // s≥1.0 时 alpha→1.0, s≤0.3 时 alpha→base
                var zoomT = this._s < 0.3 ? 0 : this._s > 1.0 ? 1 : (this._s - 0.3) / 0.7;
                alpha = base + (1 - base) * zoomT;
            }
            if (alpha !== lastAlpha) {
                ctx.globalAlpha = alpha;
                lastAlpha = alpha;
            }

            // 字号按节点度缩放: hub 大字 ~15px, 低度小字 ~10px
            var logT = this._maxDegree > 0
                ? (it._logDeg !== undefined ? it._logDeg : Math.log((it.degree || 0) + 1)) / Math.log(this._maxDegree + 1)
                : 0;
            if (logT !== logT) logT = 0;
            var fontSize = it.isHi
                ? FONT_BASE + 2  // hover/select 固定略大
                : Math.round(FONT_BASE * (0.85 + logT * 0.45));
            var fontWt = it.isSel ? "700" : (it.isHi || logT > 0.5) ? "600" : "500";
            // 仅值变化时设 ctx.font — 避免每标签重复字符串拼接
            if (fontWt !== lastFontWt || fontSize !== lastFontSize) {
                ctx.font = fontWt + " " + fontSize + "px " + FONT_STACK;
                lastFontWt = fontWt;
                lastFontSize = fontSize;
            }

            if (it.isHi) {
                // hover/select 标签背景也需要透明度
                var ph2 = fontSize + 6;
                var metrics = ctx.measureText(it.text);
                var pw2 = metrics.width + ph2;
                var px2 = it.sx - pw2 / 2;
                var py2 = it.sy - ph2 / 2;

                ctx.save();
                ctx.fillStyle = p.COLOR_LABEL_BG;
                ctx.strokeStyle = p.COLOR_LABEL_BG_BORDER;
                ctx.lineWidth = 1;
                _roundRect(ctx, px2, py2, pw2, ph2, Math.round(ph2 * 0.35));
                ctx.fill();
                ctx.stroke();
                ctx.restore();
            }

            ctx.save();
            ctx.strokeStyle = p.COLOR_LABEL_OUTLINE;
            ctx.strokeText(it.text, it.sx, it.sy);

            ctx.fillStyle = it.isSel ? p.COLOR_LABEL_SEL : p.COLOR_LABEL;
            ctx.fillText(it.text, it.sx, it.sy);
            ctx.restore();
        }
        // 恢复全局 alpha，避免影响后续绘制
        ctx.globalAlpha = 1;
    };

    /** 视口裁剪 + 屏幕坐标复用 */
    function _inView(self, nx, ny, out) {
        self.worldToScreen(nx, ny, out);
        // GPU 模式: 使用 labels canvas 尺寸判断视口（两个 canvas 同尺寸）
        var refCanvas = self._labelCanvas || self._canvas;
        var m = 80;
        return out.x > -m && out.x < refCanvas.clientWidth + m &&
               out.y > -m && out.y < refCanvas.clientHeight + m;
    }

    function _roundRect(ctx, x, y, w, h, r) {
        ctx.beginPath();
        ctx.moveTo(x + r, y);
        ctx.lineTo(x + w - r, y);
        ctx.arcTo(x + w, y, x + w, y + r, r);
        ctx.lineTo(x + w, y + h - r);
        ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
        ctx.lineTo(x + r, y + h);
        ctx.arcTo(x, y + h, x, y + h - r, r);
        ctx.lineTo(x, y + r);
        ctx.arcTo(x, y, x + r, y, r);
        ctx.closePath();
    }

    /**
     * CSS 颜色字符串 → [r, g, b, a] (归一化 0-1)
     * 用于填充 GPU uniform。支持 rgba(r,g,b,a) 和 #RRGGBB 格式。
     */
    function _parseCSSColor(str) {
        // rgba(r, g, b, a) 或 rgb(r, g, b)
        var m = str.match(/rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+))?\s*\)/);
        if (m) {
            return [
                parseFloat(m[1]) / 255,
                parseFloat(m[2]) / 255,
                parseFloat(m[3]) / 255,
                m[4] !== undefined ? parseFloat(m[4]) : 1
            ];
        }
        // #RRGGBB
        if (str[0] === "#" && str.length >= 7) {
            return [
                parseInt(str.substring(1, 3), 16) / 255,
                parseInt(str.substring(3, 5), 16) / 255,
                parseInt(str.substring(5, 7), 16) / 255,
                1
            ];
        }
        // fallback: black
        return [0, 0, 0, 1];
    }

    // ===================================================================
    // 渲染循环
    // ===================================================================

    GraphRenderer.prototype.startRenderLoop = function () {
        if (this._alive) return;
        this._alive = true;
        this._sim = true;
        var self = this;
        (function F() {
            if (!self._alive) return;

            // 相机惯性衰减 — 非拖拽期间自动滑动
            if (!self._dragging && (Math.abs(self._panVX) > self._panMinVelocity ||
                                    Math.abs(self._panVY) > self._panMinVelocity)) {
                self._ox += self._panVX;
                self._oy += self._panVY;
                self._panVX *= self._panMomentum;
                self._panVY *= self._panMomentum;
                self._dirty = true;
            } else if (!self._dragging && (self._panVX || self._panVY)) {
                self._panVX = 0; self._panVY = 0;
            }

            // 缩放平滑插值 — _s 每帧向 _targetS 逼近，保持锚点不动
            var zDiff = self._targetS - self._s;
            if (Math.abs(zDiff) > 0.0001) {
                self._s += zDiff * 0.18;  // lerp 因子 0.18 = 柔和渐进
                if (Math.abs(self._targetS - self._s) < 0.0001) self._s = self._targetS;

                // 以锚点为中心缩放，保持鼠标下方 world 点不飘
                self._ox = self._zoomAnchorSX - self._zoomAnchorX * self._s;
                self._oy = self._zoomAnchorSY - self._zoomAnchorY * self._s;
                self._dirty = true;
            }

            // 模拟期间每帧渲染，结束后按 dirty 标记渲染
            if (self._sim || self._dirty) {
                self.render(self._nodes, self._edges, self._byId);
            }
            self._raf = requestAnimationFrame(F);
        })();
    };

    GraphRenderer.prototype.onSimulationDone = function () {
        this._sim = false;
        this._dirty = true;
    };

    GraphRenderer.prototype.stopRenderLoop = function () {
        this._alive = false;
        if (this._raf) { cancelAnimationFrame(this._raf); this._raf = null; }
    };

    GraphRenderer.prototype.tick = function () {
        this._dirty = true;
        // 不在此渲染 — rAF 循环负责绘制，避免双渲染
    };

    /** 主题切换后刷新: 背景缓存失效 (bgColor 变化在下次 render 检测重建),
     *  标记重绘 — 即使模拟已停止 (rAF 循环仍在跑) */
    GraphRenderer.prototype.refreshTheme = function () {
        this._themeRefreshPending = true;
        this._bgCanvas = null;
        this._bgColorValue = null;
        this.tick();
    };

    // ===================================================================
    // 事件
    // ===================================================================

    GraphRenderer.prototype._bind = function () {
        var self = this, c = this._canvas;
        c.addEventListener("mousemove",  function (e) { self._mm(e); });
        c.addEventListener("mousedown",  function (e) { self._md(e); });
        c.addEventListener("mouseup",    function (e) { self._mu(e); });
        c.addEventListener("wheel",      function (e) { self._mw(e); }, { passive: false });
        c.addEventListener("dblclick",   function (e) { self._db(e); });
        c.addEventListener("mouseleave", function (e) { self._ml(e); });
    };

    GraphRenderer.prototype._hit = function (mx, my) {
        var wp = this.screenToWorld(mx, my, this._hitScratch || (this._hitScratch = {x:0, y:0}));
        var best = Infinity, bestN = null;
        for (var i = 0; i < this._nodes.length; i++) {
            var n = this._nodes[i];
            var sm = this._smooth[n.id];
            var nx = sm ? sm.sx : n.x;
            var ny = sm ? sm.sy : n.y;
            var dx = nx - wp.x, dy = ny - wp.y;
            var d = dx * dx + dy * dy;
            var anim = this._animStates[n.id];
            var sc = anim ? anim.currentScale : 1;
            var rr = (this._getNodeRadius(n.degree, this._maxDegree, n._logDeg) * sc) + 3;
            if (d < rr * rr && d < best) { best = d; bestN = n; }
        }
        return bestN;
    };

    GraphRenderer.prototype._mm = function (e) {
        var mx = e.offsetX, my = e.offsetY, node = this._hit(mx, my);

        if (this._dragMode === "node" && this._dragging) {
            var wp = this.screenToWorld(mx, my, this._dragScratch || (this._dragScratch = {x:0, y:0}));
            var dn = this._byId[this._hoverId];
            if (dn) {
                dn.x = wp.x; dn.y = wp.y;
                this._dragMoved = true;
                if (this._onNodeDragMove) this._onNodeDragMove(dn);
            }
            this._dirty = true; return;
        }
        if (this._dragMode === "pan" && this._dragging) {
            var dx = mx - this._dragSX, dy = my - this._dragSY;
            if (Math.abs(dx) > 1 || Math.abs(dy) > 1) this._dragMoved = true;
            this._ox += dx; this._oy += dy;
            // 记录速度用于松手后惯性滑动（最近 3 帧指数平滑）
            this._panVX = this._panVX * 0.5 + dx * 0.5;
            this._panVY = this._panVY * 0.5 + dy * 0.5;
            this._dragSX = mx; this._dragSY = my;
            this._dirty = true; return;
        }

        var prevHov = this._hoverId;
        var nid = node ? node.id : null;
        if (nid !== prevHov) {
            if (prevHov) {
                var prevSt = this._getAnimState(prevHov);
                prevSt.targetScale = 1;
            }
            if (nid) {
                var newSt = this._getAnimState(nid);
                newSt.targetScale = 1.15;
            }
            this._hoverId = nid;
            this._canvas.style.cursor = nid ? "pointer" : "grab";
            this._dirty = true;
        }
    };

    GraphRenderer.prototype._md = function (e) {
        this._dragSX = e.offsetX; this._dragSY = e.offsetY;
        this._dragMoved = false;
        var node = this._hit(e.offsetX, e.offsetY);
        if (node) {
            this._dragMode = "node";
            this._hoverId = node.id;
            // 通知外部拖拽开始（Worker 固定节点）
            if (this._onNodeDragStart) this._onNodeDragStart(node);
        } else {
            this._dragMode = "pan";
        }
        this._dragging = true;
    };

    GraphRenderer.prototype._mu = function (e) {
        var nid = this._hoverId;
        var wasNodeDrag = (this._dragMode === "node" && this._dragMoved);
        this._dragging = false;
        this._dragMode = null;
        if (!this._dragMoved) {
            if (nid) {
                var prevSel = this._selId;
                this._selId = (this._selId === nid) ? null : nid;
                if (prevSel && prevSel !== nid) {
                    var ps = this._getAnimState(prevSel);
                    ps.targetScale = 1;
                }
                if (this._selId) {
                    var ns = this._getAnimState(this._selId);
                    ns.targetScale = 1.08;
                }
                this._dirty = true;
                this._computeSelectionSet();
                this._resolveTargetAlphas();
                if (this._onNodeClick && this._byId[nid]) this._onNodeClick(this._byId[nid]);
            } else {
                if (this._selId) {
                    var ps = this._getAnimState(this._selId);
                    ps.targetScale = 1;
                }
                this._selId = null;
                this._dirty = true;
                this._selNeighborSet = null;
                this._resolveTargetAlphas();
            }
        }
        // 拖拽结束 → 通知外部（Worker 取消固定节点）
        if (wasNodeDrag && nid && this._onNodeDragEnd) {
            // 缓动释放：记录当前 pinned 位置，render 期间临时覆盖物理坐标
            var dn = this._byId[nid];
            if (dn) {
                this._releaseNode = { id: nid, fromX: dn.x, fromY: dn.y, ticksLeft: this._releaseTicks };
            }
            this._onNodeDragEnd(this._byId[nid]);
        } else if (!wasNodeDrag && nid && this._onNodeDragEnd) {
            // 单击未拖动：_md 里已 pin 节点，mu 必须平衡 unpin，防止 pinnedNodes 残留
            this._onNodeDragEnd(this._byId[nid]);
        }
    };

    GraphRenderer.prototype._mw = function (e) {
        e.preventDefault();
        // 对数步长: min(|deltaY|/100, 0.5) 确保慢滚微调、快滚大跳
        var step = Math.min(Math.abs(e.deltaY) / 200, 0.25);
        var factor = e.deltaY > 0 ? (1 - step) : (1 + step);
        var newTarget = this._targetS * factor;
        newTarget = Math.max(this._minS, Math.min(this._maxS, newTarget));

        // 记录锚点 (world 坐标)，用于平滑过渡过程中保持鼠标下方点不动
        this._zoomAnchorSX = e.offsetX;
        this._zoomAnchorSY = e.offsetY;
        this._zoomAnchorX = (e.offsetX - this._ox) / this._s;
        this._zoomAnchorY = (e.offsetY - this._oy) / this._s;

        this._targetS = newTarget;
        this._dirty = true;
    };

    GraphRenderer.prototype._db = function (e) {
        var node = this._hit(e.offsetX, e.offsetY);
        if (node && this._onNodeDblClick) this._onNodeDblClick(node);
    };

    GraphRenderer.prototype._ml = function () {
        if (this._hoverId) {
            var st = this._getAnimState(this._hoverId);
            st.targetScale = 1;
        }
        // 鼠标离开 canvas 时处理拖拽取消 — 否则节点卡在边界
        var wasNodeDrag = (this._dragMode === "node" && this._dragMoved);
        var nid = this._hoverId;
        if (wasNodeDrag && nid) {
            // 通知外部取消固定 — 防止 Worker pinnedNodes 残留
            if (this._onNodeDragEnd) this._onNodeDragEnd(this._byId[nid]);
            // 恢复节点到最近的物理位置（Worker 已有该坐标）
        }
        this._hoverId = null;
        this._dragging = false;
        this._dragMode = null;
        this._dirty = true;
    };

    // ===================================================================
    // 过滤
    // ===================================================================

    /** 根据当前 _selId 构建选中节点+邻居集合，供透明度计算使用 */
    GraphRenderer.prototype._computeSelectionSet = function () {
        if (!this._selId) { this._selNeighborSet = null; return; }
        var set = new Set();
        set.add(this._selId);
        for (var i = 0; i < this._edges.length; i++) {
            var e = this._edges[i];
            if (e.source === this._selId) set.add(e.target);
            if (e.target === this._selId) set.add(e.source);
        }
        this._selNeighborSet = set;
    };

    /** 统一计算节点 targetAlpha：综合 _filter 和 _selNeighborSet，两者取 AND */
    GraphRenderer.prototype._resolveTargetAlphas = function () {
        var filt = this._filter, selSet = this._selNeighborSet;
        for (var i = 0; i < this._nodes.length; i++) {
            var id = this._nodes[i].id;
            var passes = (!filt || filt.has(id)) && (!selSet || selSet.has(id));
            this._getAnimState(id).targetAlpha = passes ? 1 : 0.08;
        }
    };

    GraphRenderer.prototype.setFilter = function (q) {
        if (!q || !q.trim()) {
            this._filter = null;
            this._resolveTargetAlphas();
            return;
        }
        var lq = q.toLowerCase().trim();
        var s = new Set();
        for (var i = 0; i < this._nodes.length; i++) {
            if (this._nodes[i].label.toLowerCase().indexOf(lq) >= 0) s.add(this._nodes[i].id);
        }
        this._filter = s.size ? s : null;
        this._resolveTargetAlphas();
    };

    GraphRenderer.prototype.clearFilter = function () {
        this._filter = null;
        this._resolveTargetAlphas();
    };

    // ===================================================================
    // 设置面板接口 — 运行时调整视觉/动画参数
    // ===================================================================

    /** @param {string} key @param {number} value */
    GraphRenderer.prototype.setParam = function (key, value) {
        switch (key) {
            case "labelSize":
                this._labelSize = value; break;
            case "nodeScale":
                this._nodeScale = value; break;
            case "lerpSpeed":
                this._lerpSpeed = value; break;
            case "panMomentum":
                this._panMomentum = value; break;
            case "releaseTicks":
                this._releaseTicks = value; break;
            case "minS":
                this._minS = value; break;
            case "maxS":
                this._maxS = value; break;
        }
    };

    // ===================================================================
    // 获取当前可调参数的快照 (供设置面板初始化)
    // ===================================================================

    GraphRenderer.prototype.getParams = function () {
        return {
            labelSize: this._labelSize || 12,
            nodeScale: this._nodeScale || 1.0,
            lerpSpeed: this._lerpSpeed || 0.45,
            panMomentum: this._panMomentum || 0.92,
            releaseTicks: this._releaseTicks || 6,
            minS: this._minS,
            maxS: this._maxS
        };
    };

    // ===================================================================
    // 共享边预处理（Canvas 2D + GPU 共用 alpha/筛选/裁剪逻辑）
    // ===================================================================

    GraphRenderer.prototype._prepEdges = function (fadeAlpha, hovNode, selNode, anyHi, filt) {
        var edges = this._edges;
        var result = new Array(edges.length);
        var ri = 0;
        var s = this._s;
        var cw = this._canvas.clientWidth;
        var ch = this._canvas.clientHeight;
        var tMax = this._maxDegree > 0 ? this._maxDegree : 1;

        for (var e = 0; e < edges.length; e++) {
            var ee = edges[e];
            var a = this._byId[ee.source], b = this._byId[ee.target];
            if (!a || !b) continue;

            var isIncident = anyHi && (
                (hovNode && (a.id === hovNode.id || b.id === hovNode.id)) ||
                (selNode && (a.id === selNode.id || b.id === selNode.id))
            );

            var alpha = 1.0;
            if (filt) {
                var aIn = filt.has(a.id), bIn = filt.has(b.id);
                if (!aIn && !bIn) alpha = 0.03;
                else if (!aIn || !bIn) alpha = 0.10;
            }
            if (!isIncident) {
                if (anyHi) alpha *= 0.10;
                if (filt && filt.has(a.id) && filt.has(b.id)) alpha = Math.max(alpha, 0.9);
            }

            var hi = isIncident && !filt;
            if (isIncident && filt && filt.has(a.id) && filt.has(b.id)) hi = true;

            if (!hi && !filt) {
                var edgeDegree = Math.max(a.degree, b.degree) / tMax;
                alpha *= 0.7 + edgeDegree * 1.5;
                if (s < 0.3 && edgeDegree < 0.25) continue;
            }

            // 平滑坐标
            var smA = this._smooth[a.id], smB = this._smooth[b.id];
            var ax = smA ? smA.sx : a.x, ay = smA ? smA.sy : a.y;
            var bx = smB ? smB.sx : b.x, by = smB ? smB.sy : b.y;
            var sxx1 = ax * s + this._ox, syy1 = ay * s + this._oy;
            var sxx2 = bx * s + this._ox, syy2 = by * s + this._oy;

            // 视口裁剪
            if (sxx1 < -60 && sxx2 < -60 || sxx1 > cw + 60 && sxx2 > cw + 60 ||
                syy1 < -60 && syy2 < -60 || syy1 > ch + 60 && syy2 > ch + 60) continue;

            // alpha 平滑
            var ek = ee._ea || (ee._ea = a.id + "|" + b.id);
            var ae = this._edgeAlpha[ek];
            if (!ae) { ae = { current: 1, target: 1 }; this._edgeAlpha[ek] = ae; }
            ae.target = alpha;
            ae.current += (ae.target - ae.current) * 0.22;
            if (Math.abs(ae.current - ae.target) < 0.001) ae.current = ae.target;
            var smoothAlpha = ae.current;

            // 屏幕长度淡化
            var sdx = sxx2 - sxx1, sdy = syy2 - syy1;
            var screenLen = Math.sqrt(sdx * sdx + sdy * sdy);
            if (screenLen > 350) {
                smoothAlpha *= 1 - Math.min(1, (screenLen - 350) / 500) * 0.35;
            }
            if (smoothAlpha > 1.0) smoothAlpha = 1.0;
            if (smoothAlpha < 0.0) smoothAlpha = 0.0;

            result[ri++] = {
                smoothAlpha: smoothAlpha, hi: hi,
                sxx1: sxx1, syy1: syy1, sxx2: sxx2, syy2: syy2,
                ax: ax, ay: ay, bx: bx, by: by,
                aa: a, ab: b  // source/target node refs
            };
        }
        result.length = ri;
        return result;
    };

    // ===================================================================
    // 共享节点预处理（Canvas 2D + GPU 共用筛选/入场/视口裁剪逻辑）
    // ===================================================================

    GraphRenderer.prototype._prepNodes = function (fadeAlpha, anyHi, filt) {
        var nodes = this._nodes;
        var result = [];
        var s = this._s;

        for (var i = 0; i < nodes.length; i++) {
            var nd = nodes[i];

            var baseR = this._getNodeRadius(nd.degree, this._maxDegree, nd._logDeg);
            var isSel = (nd.id === this._selId);
            var isHi = isSel || (nd.id === this._hoverId);

            var anim = this._getAnimState(nd.id);
            var scale = anim.currentScale;
            var alpha = anim.currentAlpha;

            nd._baseR = baseR;
            nd._animCache = anim;

            var sm = this._smooth[nd.id];
            var sx = sm ? sm.sx : nd.x;
            var sy = sm ? sm.sy : nd.y;

            // 视口裁剪（选中/悬停不跳）
            if (!isSel && !isHi && s > 0.85) {
                var marginR = (baseR * scale + 4) * s;
                var qx = sx * s + this._ox;
                var qy = sy * s + this._oy;
                if (qx < -marginR || qx > this._pxW + marginR ||
                    qy < -marginR || qy > this._pxH + marginR) continue;
            }

            this._ensureNodeColor(nd);
            var tier = nd._ccache.tier;

            var effR = baseR * scale;
            var screenR = effR * s * (this._nodeScale || 1.0);
            if (screenR !== screenR || screenR <= 0 || screenR > 5000) continue;

            result.push({
                nd: nd, sx: sx, sy: sy,
                baseR: baseR, scale: scale, alpha: alpha,
                tier: tier, isSel: isSel, isHi: isHi,
                sxx: sx * s + this._ox, syy: sy * s + this._oy,
                screenR: screenR
            });
        }
        return result;
    };

    // ===================================================================
    // GPU 渲染器集成
    // ===================================================================

    /**
     * 设置外部 GPU 渲染器（从 graph-view.js 注入）
     */
    GraphRenderer.prototype.setGpuRenderer = function (gpu) {
        this._gpuRenderer = gpu;
    };

    /**
     * 设置标签 canvas（GPU 模式下标签绘制到独立层）
     */
    GraphRenderer.prototype.setLabelCanvas = function (canvas) {
        this._labelCanvas = canvas;
    };

    /**
     * GPU 模式的 render() 分支 — 构建 buffer → GPU draw
     * 复用 Canvas 2D 路径的全部 alpha 复合 + 动画逻辑
     */
    GraphRenderer.prototype._renderGPU = function (fadeAlpha, edgePre, nodePre) {
        var gpu = this._gpuRenderer;
        if (!gpu) return;

        var dpr = this._dpr;
        var cw = this._canvas.clientWidth;
        var ch = this._canvas.clientHeight;
        var p = this._palette;

        // ---- 背景纹理上传 ----
        if (this._bgCanvas) gpu.updateBgTexture(this._bgCanvas);

        // ---- Uniform 更新 ----
        var fillColors = [];
        var strokeColors = [];
        var tierFills   = [p.NODE_HUB_FILL, p.NODE_MID_FILL, p.NODE_LOW_FILL, p.ORPHAN_FILL];
        var tierStrokes = [p.NODE_HUB_STROKE, p.NODE_MID_STROKE, p.NODE_LOW_STROKE, p.ORPHAN_STROKE];
        for (var t = 0; t < 4; t++) {
            var cf = _parseCSSColor(tierFills[t]);
            var cs = _parseCSSColor(tierStrokes[t]);
            fillColors.push(cf[0], cf[1], cf[2], cf[3]);
            strokeColors.push(cs[0], cs[1], cs[2], cs[3]);
        }
        var ec  = _parseCSSColor(p.COLOR_EDGE);
        var ehi = _parseCSSColor(p.COLOR_EDGE_HI);
        var sel = _parseCSSColor(p.COLOR_SELECTION);

        gpu.updateUniforms({
            originX: this._ox, originY: this._oy,
            scale: this._s, cw: cw, ch: ch, dpr: dpr,
            globalAlpha: fadeAlpha, lodThreshold: 5.0,
            fillColors: fillColors, strokeColors: strokeColors,
            edgeColor: ec, edgeColorHi: ehi, selColor: sel,
        });

        gpu.resize(cw, ch, dpr);

        // ---- 构建边 Storage Buffer（使用预计算数据） ----
        var NODE_HALF_W = 0.5, HI_HALF_W = 0.9;
        var edgeCount = 0;
        var edgeData = new Float32Array(edgePre.length * 8);

        for (var e = 0; e < edgePre.length; e++) {
            var ep = edgePre[e];
            var off = edgeCount * 8;
            edgeData[off]     = ep.ax;
            edgeData[off + 1] = ep.ay;
            edgeData[off + 2] = ep.bx;
            edgeData[off + 3] = ep.by;
            edgeData[off + 4] = ep.hi ? HI_HALF_W : NODE_HALF_W;
            edgeData[off + 5] = ep.smoothAlpha;
            edgeData[off + 6] = ep.hi ? 1.0 : 0.0;
            edgeData[off + 7] = 0;  // _pad
            edgeCount++;
        }
        gpu.updateEdgeBuffer(new Float32Array(edgeData.buffer, 0, edgeCount * 8));

        // ---- 构建节点 Storage Buffer（使用预计算数据） ----
        var nodeCount = 0;
        var nodeData = new Float32Array((nodePre.length + 1) * 6);

        for (var ni = 0; ni < nodePre.length; ni++) {
            var np = nodePre[ni];
            var noff = nodeCount * 6;
            nodeData[noff]     = np.sx;
            nodeData[noff + 1] = np.sy;
            nodeData[noff + 2] = np.baseR * np.scale * (this._nodeScale || 1.0);
            nodeData[noff + 3] = np.alpha;
            nodeData[noff + 4] = np.tier;
            nodeData[noff + 5] = 0;  // _pad
            nodeCount++;
        }
        gpu.updateNodeBuffer(new Float32Array(nodeData.buffer, 0, nodeCount * 6));

        gpu.render(nodeCount, edgeCount);
    };

    GraphRenderer.prototype.destroy = function () {
        this.stopRenderLoop();
        this._nodes = []; this._edges = []; this._byId = {};
        this._animStates = {};
        this._smooth = {};
        this._smoothCleanFrame = 0;
        this._dotPattern = null;
        this._bgCanvas = null;
        this._edgeAlpha = {};
        // 清理 SAB 引用
        this._sabHeader = null;
        this._sabHeaderFloat = null;
        this._sabSlots = null;
        this._lastSabSeq = -1;
    };

    module.exports = GraphRenderer;
})();
