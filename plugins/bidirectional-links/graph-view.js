/**
 * Bidirectional Links — Graph View Overlay
 * =========================================
 * 知识图谱覆盖层面板的控制器，负责:
 *   1. 注入/移除全屏覆盖层 DOM
 *   2. 从 LinkIndex 提取图数据，启动力布局模拟
 *   3. 编排 Canvas 渲染器
 *   4. 搜索/过滤
 *   5. ESC/背景点击关闭
 */

(function () {
    "use strict";

    var reqnode = (typeof window !== "undefined" && window.reqnode) || global.reqnode;
    var Module = reqnode("module");
    var pathModule = reqnode("path");
    var fs = reqnode("fs");

    function GraphView(index, resolverModule, openFileFn, pluginDir) {
        this._index = index;
        this._resolver = resolverModule;
        this._openFile = openFileFn;
        this._pluginDir = pluginDir || ".";

        // 子模块
        this._layout = null;
        this._renderer = null;

        // DOM
        this._overlayEl = null;
        this._canvasEl = null;
        this._searchInput = null;
        this._embedContainer = null;   // 嵌入模式挂载容器 (分屏右栏等), null = 全屏 overlay

        // 状态
        this._isOpen = false;
        this._nodes = [];
        this._edges = [];
        this._nodesById = {};
        this._maxDegree = 0;
        this._hasCachedLayout = false;
        this._destroyed = false;

        // Worker 物理模拟
        this._worker = null;
        this._useWorker = false;
        this._workerStarted = false;  // onReady 触发后置 true，防止重复 start

        // SAB 零拷贝通信
        this._sab = null;                // SharedArrayBuffer 引用
        this._sabHeader = null;          // Int32Array view (frameSeq, activeSlot)
        this._sabHeaderFloat = null;     // Float32Array view (alpha, energy)
        this._sabSlots = null;           // Float32Array view (双槽位 positions)
        this._lastSabSeq = -1;           // 上次看到的 frameSeq (检测新帧)
        this._useSAB = false;

        // 绑定处理函数（用于 removeEventListener）
        this._onKeyDownBound = null;
        this._onResizeBound = null;
        this._onBackdropClickBound = null;
    }

    // ===================================================================
    // 公共 API
    // ===================================================================

    GraphView.prototype.open = function (container) {
        if (this._destroyed || this._isOpen) return;

        // 嵌入模式: 挂载到指定容器 (无遮罩, 面板铺满), 复用 overlay 结构
        if (container) this._embedContainer = container;

        // 延迟加载子模块
        if (!this._layout || !this._renderer) {
            this._loadModules();
        }

        this._createOverlay();

        // 先让浏览器绘制 overlay（面板 + 背景），再执行耗时的图构建。
        // rAF 在下一帧绘制前触发 → 内层 setTimeout 延迟到该帧绘制后。
        var self = this;
        requestAnimationFrame(function () {
            setTimeout(function () {
                if (self._destroyed || !self._isOpen) return;
                try {
                    self._buildGraph();
                    self._centerAndStart();
                    // 索引未就绪 → 空图自动等待 (异步分批构建, 对齐 30s 窗口)
                    self._ensureGraph();
                } catch (e) {
                    console.log("[图谱] open 构建异常: " + e.message);
                }
            }, 0);
        });

        this._isOpen = true;
    };

    GraphView.prototype.close = function () {
        if (!this._isOpen) return;

        // 保存当前位置缓存 → 下次打开直接恢复，不再星群展开
        if (this._nodes && this._nodes.length > 0) {
            this._saveGraphCache(this._nodes, this._edges, this._maxDegree);
        }

        // 停止模拟和渲染循环
        if (this._layout) this._layout.stop();
        if (this._renderer) this._renderer.stopRenderLoop();
        this._stopWorker();
        this._workerStarted = false;

        // 清理 GPU 渲染器
        if (this._rendererGPU) {
            this._rendererGPU.destroy();
            this._rendererGPU = null;
        }

        // 播放退场动画，结束后移除 DOM
        this._animateOut();
    };

    GraphView.prototype._animateOut = function () {
        // 嵌入模式: 无退场动画, 直接移除
        if (this._embedContainer) {
            this._removeOverlay();
            this._isOpen = false;
            return;
        }
        var panel = this._overlayEl ? this._overlayEl.querySelector(".graph-view-panel") : null;
        var backdrop = this._overlayEl ? this._overlayEl.querySelector(".graph-view-backdrop") : null;
        var self = this;

        // 加退场 class 触发 CSS 动画
        if (panel) panel.classList.add("closing");
        if (backdrop) backdrop.classList.add("closing");

        // 动画结束后移除
        var duration = 130; // 与 CSS 动画时长对齐（0.12s + 小 buffer）
        if (this._outTimer) clearTimeout(this._outTimer);
        this._outTimer = setTimeout(function () {
            self._removeOverlay();
            self._isOpen = false;
            self._outTimer = null;
        }, duration);
    };

    GraphView.prototype.toggle = function () {
        if (this._isOpen) this.close(); else this.open();
    };

    GraphView.prototype.isOpen = function () {
        return this._isOpen;
    };

    /** 暂停模拟与渲染 (嵌入模式标签切走时调用, 保留数据) */
    GraphView.prototype.pause = function () {
        if (!this._isOpen) return;
        if (this._layout) this._layout.stop();
        if (this._renderer) this._renderer.stopRenderLoop();
        this._stopWorker();
        this._workerStarted = false;
    };

    /** 恢复模拟与渲染 (嵌入模式标签切回时调用) */
    GraphView.prototype.resume = function () {
        if (!this._isOpen || !this._renderer) return;
        this._startSimulation();
    };

    /** 高亮中心节点 (实时跟随当前文件) */
    GraphView.prototype.setCenter = function (filePath) {
        if (!filePath || !this._isOpen) return;
        // 渲染器/图未就绪时挂起, 构建完成后自动应用
        this._pendingCenter = filePath;
        if (!this._renderer || !this._nodesById) return;
        var node = this._nodesById[filePath];
        this._renderer._selId = node ? node.id : null;
        this._renderer.tick();
    };

    /** 构建完成后应用挂起的中心节点 */
    GraphView.prototype._applyPendingCenter = function () {
        if (this._pendingCenter) this.setCenter(this._pendingCenter);
    };

    GraphView.prototype.destroy = function () {
        this._destroyed = true;
        this.close();
        if (this._renderer) this._renderer.destroy();
        this._layout = null;
        this._renderer = null;
        this._rendererGPU = null;
        this._nodes = [];
        this._edges = [];
        this._nodesById = {};
    };

    // ===================================================================
    // Worker 物理模拟
    // ===================================================================

    /**
     * 创建 Web Worker 运行物理模拟。
     * 返回 false 时调用方应回退到主线程 layout.run()。
     */
    GraphView.prototype._initWorker = function () {
        if (typeof Worker === "undefined" || typeof Blob === "undefined") return false;

        try {
            var workerPath = pathModule.join(this._pluginDir, "graph-worker.js");
            var workerSrc = fs.readFileSync(workerPath, "utf8");
            var blob = new Blob([workerSrc], { type: "application/javascript" });
            var blobUrl = URL.createObjectURL(blob);
            var worker = new Worker(blobUrl);
            URL.revokeObjectURL(blobUrl); // Blob URL 传给 Worker 后可立即回收
            var self = this;

            worker.onmessage = function (e) {
                var msg = e.data;
                if (!msg || !msg.type) return;
                if (!self._renderer) return; // 面板已关闭，忽略

                switch (msg.type) {
                    case "sab-ready":
                        // SAB 协商: Worker 创建了 SharedArrayBuffer
                        if (msg.sab && msg.nodeCount > 0) {
                            var HEADER_INTS = 16;
                            self._sab = msg.sab;
                            self._sabHeader = new Int32Array(msg.sab, 0, HEADER_INTS);
                            self._sabHeaderFloat = new Float32Array(msg.sab, 0, HEADER_INTS);
                            self._sabSlots = new Float32Array(msg.sab, HEADER_INTS * 4, msg.nodeCount * 2 * 2);
                            self._lastSabSeq = -1;
                            self._useSAB = true;
                            if (self._renderer) {
                                self._renderer.setSAB(self._sabHeader, self._sabHeaderFloat, self._sabSlots);
                            }
                        }
                        break;

                    case "tick":
                        // SAB 路径: 跳过拷贝，renderer 直接从 SAB 读取
                        // 非 SAB 路径 (Transferable 回退): 从 ArrayBuffer 拷贝到 nodes
                        if (!self._useSAB && msg.positions) {
                            var view = new Float32Array(msg.positions);
                            var nodes = self._nodes;
                            var len = Math.min(nodes.length, view.length >>> 1);
                            for (var i = 0; i < len; i++) {
                                nodes[i].x = view[i * 2];
                                nodes[i].y = view[i * 2 + 1];
                            }
                        }
                        if (self._renderer) self._renderer.tick();
                        break;
                }
            };

            worker.onerror = function (err) {
                self._stopWorker();
                self._runFallbackSimulation();
            };

            this._worker = worker;
            this._useWorker = true;
            return true;
        } catch (e) {
            return false;
        }
    };

    GraphView.prototype._postToWorker = function (msg) {
        if (this._worker) {
            try { this._worker.postMessage(msg); } catch (e) { /* Worker 可能已终止 */ }
        }
    };

    GraphView.prototype._stopWorker = function () {
        if (this._worker) {
            try {
                this._worker.postMessage({ type: "stop" });
                this._worker.terminate();
            } catch (e) { /* 忽略 */ }
            this._worker = null;
        }
        this._useWorker = false;
        // 清理 SAB 引用
        this._sab = null;
        this._sabHeader = null;
        this._sabHeaderFloat = null;
        this._sabSlots = null;
        this._lastSabSeq = -1;
        this._useSAB = false;
    };

    /**
     * 回退路径：Worker 不可用时使用原始主线程模拟
     */
    GraphView.prototype._runFallbackSimulation = function () {
        if (!this._layout || !this._renderer) return;

        var self = this;
        var renderer = this._renderer;

        this._layout.run(
            this._nodes,
            this._edges,
            function (nodes, energy, step) {
                var statsEl = document.getElementById("graph-stats");
                if (statsEl) {
                    statsEl.textContent =
                        self._nodes.length + " 节点 · " + self._edges.length + " 条链接";
                }
                if (renderer) renderer.tick();
            },
            function () {
                if (renderer) renderer.onSimulationDone();
                self._saveGraphCache(self._nodes, self._edges, self._maxDegree);
            }
        );
        renderer.startRenderLoop();
    };

    // ===================================================================
    // 模块加载
    // ===================================================================

    GraphView.prototype._loadModules = function () {
        var pluginDir = this._pluginDir;

        var pluginRequire;
        try {
            pluginRequire = Module.createRequire
                ? Module.createRequire(pathModule.join(pluginDir, "graph-view.js"))
                : reqnode;
        } catch (e) {
            pluginRequire = reqnode;
        }

        var GraphLayout = pluginRequire(pathModule.join(pluginDir, "graph-layout.js"));
        var GraphRenderer = pluginRequire(pathModule.join(pluginDir, "graph-renderer.js"));

        // WebGPU 渲染器：仅在 navigator.gpu 可用时才尝试加载
        var GraphRendererGPU = null;
        if (typeof navigator !== "undefined" && navigator.gpu) {
            try {
                GraphRendererGPU = pluginRequire(pathModule.join(pluginDir, "graph-renderer-gpu.js"));
            } catch (e) {
                // GPU 渲染器加载失败，自动回退
            }
        }

        this._layout = new GraphLayout();
        this._rendererModule = {
            GraphLayout: GraphLayout,
            GraphRenderer: GraphRenderer,
            GraphRendererGPU: GraphRendererGPU,
        };
    };

    // ===================================================================
    // DOM 创建 / 移除
    // ===================================================================

    GraphView.prototype._createOverlay = function () {
        var doc = document;
        var embed = !!this._embedContainer;

        // 覆盖层容器 (嵌入模式: 挂到目标容器, CSS 铺满; 全屏: body + 遮罩)
        var overlay = doc.createElement("div");
        overlay.id = "graph-view-overlay";
        overlay.setAttribute("data-plugin-id", "bidirectional-links");
        if (embed) overlay.className = "graph-view-embed";

        // 背景
        var backdrop = doc.createElement("div");
        backdrop.className = "graph-view-backdrop";
        overlay.appendChild(backdrop);

        // 面板
        var panel = doc.createElement("div");
        panel.className = "graph-view-panel";

        // --- 头部 ---
        var header = doc.createElement("div");
        header.className = "graph-view-header";

        var title = doc.createElement("span");
        title.className = "graph-view-title";
        title.textContent = "知识图谱";
        header.appendChild(title);

        var stats = doc.createElement("span");
        stats.className = "graph-view-stats";
        stats.id = "graph-stats";
        header.appendChild(stats);

        var search = doc.createElement("input");
        search.className = "graph-view-search";
        search.id = "graph-search";
        search.type = "text";
        search.placeholder = "搜索文件…";
        search.autocomplete = "off";
        search.autocorrect = "off";
        search.spellcheck = false;
        header.appendChild(search);
        this._searchInput = search;

        var self = this;
        var gearBtn = doc.createElement("button");
        gearBtn.className = "graph-view-settings-btn";
        gearBtn.id = "graph-settings-btn";
        gearBtn.innerHTML = "&#9881;";
        gearBtn.title = "设置面板";
        gearBtn.addEventListener("click", function (e) { e.stopPropagation(); self._toggleSettings(); });
        header.appendChild(gearBtn);

        // 渲染引擎切换按钮
        var engineBtn = doc.createElement("button");
        engineBtn.className = "graph-view-engine-btn";
        engineBtn.id = "graph-engine-btn";
        engineBtn.title = "切换渲染引擎 (WebGPU / Canvas 2D)";
        engineBtn.textContent = "WebGPU";
        engineBtn.addEventListener("click", function (e) { e.stopPropagation(); self._toggleEngine(); });
        header.appendChild(engineBtn);
        this._engineBtn = engineBtn;

        var closeBtn = doc.createElement("button");
        closeBtn.className = "graph-view-close-btn";
        closeBtn.id = "graph-close-btn";
        closeBtn.innerHTML = "&times;";
        closeBtn.title = "关闭 (Esc)";
        header.appendChild(closeBtn);

        panel.appendChild(header);

        // --- Canvas（双 Canvas 堆叠：GPU 在下，标签+事件在上）---
        var canvasContainer = doc.createElement("div");
        canvasContainer.className = "graph-canvas-container";

        // z=0: WebGPU 绘制（背景纹理 + 边 + 节点）
        var gpuCanvas = doc.createElement("canvas");
        gpuCanvas.id = "graph-canvas-gpu";
        canvasContainer.appendChild(gpuCanvas);
        this._gpuCanvasEl = gpuCanvas;

        // z=1: Canvas 2D 标签 + 事件接收
        var labelsCanvas = doc.createElement("canvas");
        labelsCanvas.id = "graph-canvas-labels";
        canvasContainer.appendChild(labelsCanvas);
        this._canvasEl = labelsCanvas;  // 事件绑定到 labels canvas

        panel.appendChild(canvasContainer);

        // --- 底部提示 ---
        var footer = doc.createElement("div");
        footer.className = "graph-view-footer";
        footer.innerHTML =
            '<span class="graph-view-hint">滚轮缩放</span>' +
            '<span class="graph-view-hint">拖拽移动</span>' +
            '<span class="graph-view-hint">双击打开</span>' +
            '<span class="graph-view-hint">单击选中</span>' +
            '<span class="graph-view-hint">Esc 关闭</span>';
        panel.appendChild(footer);

        // --- 设置面板（右侧滑出）---
        var settingsPanel = doc.createElement("div");
        settingsPanel.className = "graph-view-settings-panel";
        settingsPanel.id = "graph-settings-panel";
        settingsPanel.innerHTML = this._buildSettingsHTML();
        panel.appendChild(settingsPanel);
        this._settingsPanel = settingsPanel;

        // 设置面板关闭按钮
        var settingsClose = settingsPanel.querySelector(".graph-settings-close");
        if (settingsClose) {
            settingsClose.addEventListener("click", function () { self._toggleSettings(); });
        }

        // 设置面板重置按钮
        var settingsReset = settingsPanel.querySelector(".graph-settings-reset");
        if (settingsReset) {
            settingsReset.addEventListener("click", function () { self._resetSettings(); });
        }

        overlay.appendChild(panel);
        (embed ? this._embedContainer : doc.body).appendChild(overlay);
        this._overlayEl = overlay;

        // --- 绑定事件 (嵌入模式: 关闭由外部管理, 不绑 ESC/背景点击) ---
        var self = this;

        // 关闭按钮 (嵌入模式 CSS 隐藏)
        closeBtn.addEventListener("click", function () { self.close(); });

        if (!embed) {
            // 背景点击关闭
            this._onBackdropClickBound = function (e) {
                if (e.target === backdrop || e.target === overlay) {
                    self.close();
                }
            };
            overlay.addEventListener("mousedown", this._onBackdropClickBound);

            // ESC 关闭
            this._onKeyDownBound = function (e) {
                if (e.key === "Escape") {
                    self.close();
                }
            };
            document.addEventListener("keydown", this._onKeyDownBound);
        }

        // Resize
        this._onResizeBound = function () {
            if (self._renderer) self._renderer.tick();
        };
        window.addEventListener("resize", this._onResizeBound);

        // 搜索
        search.addEventListener("input", function () {
            self._handleSearch(search.value);
        });
    };

    // ===================================================================
    // 设置面板
    // ===================================================================

    GraphView.prototype._buildSettingsHTML = function () {
        var html = '<div class="graph-settings-header">';
        html += '<span class="graph-settings-title">参数设置</span>';
        html += '<button class="graph-settings-close" title="关闭">&times;</button>';
        html += '</div>';

        // --- 物理参数 ---
        html += '<div class="graph-settings-group">';
        html += '<div class="graph-settings-group-title">物理参数</div>';
        html += this._sliderHTML("repulsionStrength", "斥力强度", 1000, 20000, 8000, 100);
        html += this._sliderHTML("attractionStrength", "引力系数", 0.001, 0.02, 0.004, 0.001);
        html += this._sliderHTML("edgeRestLength", "弹簧自然长度", 30, 200, 80, 1);
        html += this._sliderHTML("centerGravity", "中心引力", 0, 0.01, 0.0003, 0.0001);
        html += this._sliderHTML("BH_THETA", "BH 精度 (θ)", 0.3, 1.5, 0.7, 0.05);
        html += this._sliderHTML("BH_CUTOFF", "BH 截止距离", 200, 3000, 2000, 10);
        html += '</div>';

        // --- 视觉参数 ---
        html += '<div class="graph-settings-group">';
        html += '<div class="graph-settings-group-title">视觉参数</div>';
        html += this._sliderHTML("labelSize", "标签字号", 8, 18, 12, 1);
        html += this._sliderHTML("nodeScale", "节点大小倍率", 0.5, 2.0, 1.0, 0.05);
        html += '</div>';

        // --- 动画参数 ---
        html += '<div class="graph-settings-group">';
        html += '<div class="graph-settings-group-title">动画参数</div>';
        html += this._sliderHTML("alphaDecay", "Phase1 衰减率", 0.0005, 0.010, 0.002, 0.0005);
        html += this._sliderHTML("alphaDecay2", "Phase2 衰减率", 0.0005, 0.010, 0.0015, 0.0005);
        html += this._sliderHTML("lerpSpeed", "物理平滑速度", 0.10, 0.80, 0.45, 0.01);
        html += this._sliderHTML("panMomentum", "相机惯性", 0.80, 0.98, 0.92, 0.01);
        html += '</div>';

        // --- 底部 ---
        html += '<div class="graph-settings-footer">';
        html += '<button class="graph-settings-reset">重置默认</button>';
        html += '</div>';

        return html;
    };

    GraphView.prototype._sliderHTML = function (key, label, min, max, deflt, step) {
        var html = '<div class="graph-settings-row" data-key="' + key + '">';
        html += '<label class="graph-settings-label">' + label + '</label>';
        html += '<input type="range" class="graph-settings-slider" min="' + min + '" max="' + max +
                '" step="' + step + '" value="' + deflt + '" data-default="' + deflt + '">';
        html += '<span class="graph-settings-value">' + (Number(deflt) === Math.floor(deflt) ? deflt : deflt.toFixed(4)) + '</span>';
        html += '</div>';
        return html;
    };

    GraphView.prototype._toggleSettings = function () {
        var panel = this._settingsPanel;
        if (!panel) return;
        var open = panel.classList.contains("open");
        if (open) {
            panel.classList.remove("open");
        } else {
            panel.classList.add("open");
        }
    };

    /**
     * 初始化 GPU 渲染器（首次加载和切换共用）
     *
     * 当预加载的 device 就绪时，同步完成初始化（GPU 从第 1 帧即渲染）。
     * 预加载未完成时回退到异步路径。
     *
     * @param {function} [callback] — (ok: boolean)
     */
    GraphView.prototype._initGPURenderer = function (renderer, callback) {
        var GraphRendererGPU = this._rendererModule.GraphRendererGPU;
        if (!GraphRendererGPU || !GraphRendererGPU.isSupported || !GraphRendererGPU.isSupported()) {
            if (callback) callback(false); return;
        }
        if (!this._gpuCanvasEl) { if (callback) callback(false); return; }

        var gpu = new GraphRendererGPU(this._gpuCanvasEl, {
            maxNodes: renderer._nodes.length + 200,
            maxEdges: renderer._edges.length + 200,
        });

        var self = this;
        gpu.init().then(function (ok) {
            if (ok) {
                self._rendererGPU = gpu;
                renderer.setGpuRenderer(gpu);
                renderer.setLabelCanvas(self._canvasEl);
                renderer._gpuMode = true;
            }
            if (callback) callback(ok);
        }).catch(function () {
            if (callback) callback(false);
        });
    };

    GraphView.prototype._toggleEngine = function () {
        var renderer = this._renderer;
        if (!renderer) return;

        if (renderer._gpuMode) {
            renderer._gpuMode = false;
            if (this._gpuCanvasEl) this._gpuCanvasEl.style.display = "none";
            if (this._engineBtn) { this._engineBtn.textContent = "Canvas"; this._engineBtn.title = "切换到 WebGPU"; }
            renderer.tick();
        } else if (this._rendererGPU) {
            // GPU 渲染器已存在：直接切换
            renderer._gpuMode = true;
            if (this._gpuCanvasEl) this._gpuCanvasEl.style.display = "";
            if (this._engineBtn) { this._engineBtn.textContent = "WebGPU"; this._engineBtn.title = "切换到 Canvas 2D"; }
            renderer.tick();
        } else {
            // 首次或丢失后重新初始化
            var self = this;
            this._initGPURenderer(renderer, function (ok) {
                if (!ok) return;
                renderer._gpuMode = true;
                if (self._gpuCanvasEl) self._gpuCanvasEl.style.display = "";
                if (self._engineBtn) { self._engineBtn.textContent = "WebGPU"; self._engineBtn.title = "切换到 Canvas 2D"; }
                renderer.tick();
            });
        }
    };

    GraphView.prototype._bindSettings = function () {
        var self = this;
        var panel = this._settingsPanel;
        if (!panel) return;

        var sliders = panel.querySelectorAll(".graph-settings-slider");
        for (var i = 0; i < sliders.length; i++) {
            (function (slider) {
                slider.addEventListener("input", function () {
                    var row = slider.parentNode;
                    var key = row.getAttribute("data-key");
                    var val = parseFloat(slider.value);
                    // 更新显示值
                    var valSpan = row.querySelector(".graph-settings-value");
                    if (valSpan) {
                        valSpan.textContent = (val === Math.floor(val) && slider.step >= 1) ? val : val;
                    }
                    // 转发参数
                    self._onSettingChange(key, val);
                });
            })(sliders[i]);
        }
    };

    GraphView.prototype._onSettingChange = function (key, value) {
        // Worker 参数 → postMessage
        var workerKeys = ["repulsionStrength", "attractionStrength", "edgeRestLength",
                          "centerGravity", "BH_THETA", "BH_CUTOFF", "maxVelocity", "alphaDecay", "alphaDecay2",
                          "PHASE1_DAMP", "PHASE1_MAXVEL", "PHASE1_STEPS"];
        if (workerKeys.indexOf(key) >= 0) {
            this._postToWorker({ type: "set_param", key: key, value: value });
        }

        // Renderer 参数 → 直接调用
        if (this._renderer && this._renderer.setParam) {
            this._renderer.setParam(key, value);
        }
    };

    GraphView.prototype._resetSettings = function () {
        var panel = this._settingsPanel;
        if (!panel) return;
        var sliders = panel.querySelectorAll(".graph-settings-slider");
        for (var i = 0; i < sliders.length; i++) {
            var slider = sliders[i];
            var deflt = parseFloat(slider.getAttribute("data-default"));
            slider.value = deflt;
            var row = slider.parentNode;
            var valSpan = row.querySelector(".graph-settings-value");
            if (valSpan) {
                valSpan.textContent = (deflt === Math.floor(deflt) && parseFloat(slider.step) >= 1) ? deflt : deflt;
            }
            var key = row.getAttribute("data-key");
            this._onSettingChange(key, deflt);
        }
    };

    GraphView.prototype._removeOverlay = function () {
        if (this._overlayEl && this._overlayEl.parentNode) {
            this._overlayEl.parentNode.removeChild(this._overlayEl);
        }
        this._overlayEl = null;
        this._canvasEl = null;
        this._searchInput = null;

        if (this._onKeyDownBound) {
            document.removeEventListener("keydown", this._onKeyDownBound);
            this._onKeyDownBound = null;
        }
        if (this._onResizeBound) {
            window.removeEventListener("resize", this._onResizeBound);
            this._onResizeBound = null;
        }
    };

    // ===================================================================
    // 图构建 + 模拟
    // ===================================================================

    GraphView.prototype._buildGraph = function () {
        var index = this._index;
        if (!index || !index.forwardIndex || !index.allMdFiles) return;

        var result = this._layout.buildFromIndex(
            index.forwardIndex,
            index.allMdFiles,
            this._resolver
        );

        this._nodes = result.nodes;
        this._edges = result.edges;
        this._maxDegree = result.maxDegree;

        // 构建快速查找表
        this._nodesById = {};
        for (var i = 0; i < this._nodes.length; i++) {
            this._nodesById[this._nodes[i].id] = this._nodes[i];
        }

        // 尝试从缓存加载位置
        var vaultRoot = this._getVaultRoot();
        var cached = this._loadGraphCache();
        this._hasCachedLayout = false;
        if (cached && this._layout.isCacheValid(cached, this._nodes, this._edges, vaultRoot)) {
            this._layout.loadCachedPositions(this._nodes, cached);
            this._hasCachedLayout = true;
        }
    };

    /** 重建图数据与渲染器 (索引就绪后刷新空图) */
    GraphView.prototype.refresh = function () {
        if (!this._isOpen || this._destroyed) return false;
        try {
            // 停止当前模拟/渲染
            if (this._layout) this._layout.stop();
            if (this._renderer) this._renderer.stopRenderLoop();
            this._stopWorker();
            this._workerStarted = false;
            this._rendererGPU = null;
            // 重建图
            this._buildGraph();
            if (!this._nodes || !this._nodes.length) return false;   // 索引仍未就绪
            this._centerAndStart();
            return true;
        } catch (e) {
            return false;
        }
    };

    /** open 后空图自动等待索引 (索引构建是异步分批的, 最多 30s) */
    GraphView.prototype._ensureGraph = function () {
        var self = this;
        var tries = 0;
        (function check() {
            if (!self._isOpen || self._destroyed) return;
            if (self._nodes && self._nodes.length > 0) return;   // 图已就绪
            tries++;
            if (tries > 60) return;   // 60 × 500ms = 30s (对齐索引初始化窗口)
            setTimeout(function () {
                if (self.refresh()) return;
                check();
            }, 500);
        })();
    };

    GraphView.prototype._centerAndStart = function () {
        var canvas = this._canvasEl;
        if (!canvas) return;

        var self = this;
        var GraphRenderer = this._rendererModule.GraphRenderer;

        var renderer = new GraphRenderer(canvas, {
            maxDegree: this._maxDegree,
            getNodeRadius: function (degree, maxDegree, logDeg) {
                return self._layout.getNodeRadius(degree, maxDegree, logDeg);
            },
            onNodeClick: function (node) {
                // 单击选中已由 renderer 内部处理
            },
            onNodeDblClick: function (node) {
                if (self._openFile) {
                    self._openFile(node.id);
                    // 嵌入模式 (分屏图谱标签): 不关闭 — 图谱标签的切换/
                    // 卸载由 split-view 的 applyRightPane/onFileOpened 管理
                    // (打开的文件在右栏则标签切换卸载, 在左栏则图谱保留
                    // 且中心跟随新文件)
                    if (!self._embedContainer) self.close();
                }
            },
            onNodeDragStart: function (node) {
                // 拖拽开始：固定节点位置并确保 Worker 运行
                if (self._useWorker) {
                    self._postToWorker({ type: "pin", nodeId: node.id, x: node.x, y: node.y });
                }
            },
            onNodeDragMove: function (node) {
                // 拖拽中：实时更新被拖拽节点位置，Worker 持续对其他节点施力
                if (self._useWorker) {
                    self._postToWorker({ type: "move_pin", nodeId: node.id, x: node.x, y: node.y });
                }
            },
            onNodeDragEnd: function (node) {
                // 拖拽结束：取消固定，节点恢复自由物理
                if (self._useWorker) {
                    self._postToWorker({ type: "unpin", nodeId: node.id });
                }
            },
        });

        renderer._nodes = this._nodes;
        renderer._edges = this._edges;
        renderer._byId = this._nodesById;

        // ---- WebGPU 渲染器初始化 ----
        var GraphRendererGPU = this._rendererModule.GraphRendererGPU;
        this._rendererGPU = null;

        if (GraphRendererGPU && GraphRendererGPU.isSupported && GraphRendererGPU.isSupported()) {
            var self = this;
            this._initGPURenderer(renderer, function (ok) {
                if (ok && self._engineBtn) self._engineBtn.textContent = "WebGPU";
                else if (self._engineBtn) self._engineBtn.textContent = "Canvas";
            });
        }


        // 初始居中
        renderer.centerCamera(this._nodes);

        this._renderer = renderer;

        // 绑定设置面板滑块事件
        this._bindSettings();

        this._startSimulation();

        // 挂起的中心节点 (mountGraphPane 在渲染器就绪前调 setCenter)
        this._applyPendingCenter();

        // 更新统计
        var statsEl = document.getElementById("graph-stats");
        if (statsEl) {
            statsEl.textContent =
                this._nodes.length + " 节点 · " + this._edges.length + " 条链接";
        }
    };

    /** 启动物理模拟 (Worker 优先, 回退主线程) — 初次与 resume 复用 */
    GraphView.prototype._startSimulation = function () {
        var renderer = this._renderer;
        if (!renderer) return;

        if (this._initWorker()) {
            // 打包所有节点位置（可能来自缓存或刚生成）
            var workerNodes = [];
            for (var i = 0; i < this._nodes.length; i++) {
                var n = this._nodes[i];
                workerNodes.push({
                    id: n.id, label: n.label,
                    x: n.x, y: n.y,
                    vx: n.vx || 0, vy: n.vy || 0,
                    degree: n.degree, isOrphan: n.isOrphan,
                    _logDeg: n._logDeg
                });
            }
            var workerEdges = [];
            for (var j = 0; j < this._edges.length; j++) {
                var e = this._edges[j];
                workerEdges.push({ source: e.source, target: e.target });
            }

            this._postToWorker({ type: "init", nodes: workerNodes, edges: workerEdges, maxDegree: this._maxDegree, options: {} });
            // 立即启动 Worker 物理（不再等待渐显 → onReady）
            if (!this._workerStarted) {
                this._workerStarted = true;
                this._postToWorker({ type: "start" });
            }

            renderer.startRenderLoop();
        } else {
            // 路径 3：回退 → 原始主线程模拟
            this._runFallbackSimulation();
        }
    };

    // ===================================================================
    // 搜索
    // ===================================================================

    GraphView.prototype._handleSearch = function (query) {
        if (!this._renderer) return;
        this._renderer.setFilter(query);
        this._renderer.tick();
    };

    // ===================================================================
    // 缓存
    // ===================================================================

    GraphView.prototype._getCachePath = function () {
        var cacheDir = pathModule.join(this._pluginDir, "..", ".cache");
        return pathModule.join(cacheDir, "bidirectional-links.graph-cache.json");
    };

    GraphView.prototype._loadGraphCache = function () {
        try {
            var cachePath = this._getCachePath();
            if (!fs.existsSync(cachePath)) return null;
            var raw = fs.readFileSync(cachePath, "utf-8");
            return JSON.parse(raw);
        } catch (e) {
            return null;
        }
    };

    GraphView.prototype._saveGraphCache = function (nodes, edges, maxDegree) {
        try {
            var cachePath = this._getCachePath();
            var cacheDir = pathModule.dirname(cachePath);
            if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir, { recursive: true });

            var cacheNodes = [];
            for (var i = 0; i < nodes.length; i++) {
                cacheNodes.push({ id: nodes[i].id, x: nodes[i].x, y: nodes[i].y });
            }

            var cacheEdges = [];
            for (var e = 0; e < edges.length; e++) {
                cacheEdges.push({ source: edges[e].source, target: edges[e].target });
            }

            var cache = {
                version: 1,
                vaultRoot: this._getVaultRoot(),
                nodeCount: nodes.length,
                edgeCount: edges.length,
                maxDegree: maxDegree,
                nodes: cacheNodes,
                edges: cacheEdges,
            };

            fs.writeFileSync(cachePath, JSON.stringify(cache, null, 2), "utf-8");
        } catch (e) {
            // 静默失败，缓存不是关键路径
        }
    };

    GraphView.prototype._getVaultRoot = function () {
        return BetterTypora.getMountFolder();
    };

    module.exports = GraphView;
})();
