/**
 * Bidirectional Links — WebGPU Graph Renderer
 * =============================================
 * 管理 WebGPU 设备、管线、缓冲区和每帧渲染。
 *
 * 双 Canvas 架构:
 *   z=0  → WebGPU canvas（背景纹理+边+节点+选中光环）
 *   z=1  → Canvas 2D    （文本标签 + 事件接收）
 *
 * 职责:
 *   - 设备初始化 + 着色器编译 → pipelines
 *   - Uniform buffer 管理（相机、颜色、LOD）
 *   - 背景纹理管理（从离屏 Canvas 上传）
 *   - 节点/边 Storage Buffer 管理（每帧 mapWrite 更新）
 *   - MSAA 4x 抗锯齿
 *   - 上下文丢失恢复
 */

(function () {
    "use strict";

    var SHADERS = require("./graph-shaders");

    // 最大容量（用于预分配缓冲）
    var MAX_NODES = 3000;
    var MAX_EDGES = 6000;

    // ===================================================================
    // Uniform Buffer 布局常量（与 WGSL Uniforms struct 对齐）
    //   Float32Array 56 entries = 224 bytes → padded to 256
    // ===================================================================

    var UNIFORM_LAYOUT = {
        SIZE_FLOATS: 56,
        SIZE_BYTES: 224,  // 实际有用数据
        BUFFER_BYTES: 256, // 对齐 256 字节（WebGPU 要求）

        // Float32Array 下标
        OFFSET_ORIGIN_X: 0,
        OFFSET_ORIGIN_Y: 1,
        OFFSET_SCALE: 2,
        // [3] = _pad0
        OFFSET_RESOLUTION_X: 4,
        OFFSET_RESOLUTION_Y: 5,
        OFFSET_DPR: 6,
        OFFSET_GLOBAL_ALPHA: 7,
        OFFSET_LOD_THRESHOLD: 8,
        // [9] = _pad1
        // [10-11] = _pad_vec2 (align fillColors[0] to offset 48)
        OFFSET_FILL_COLORS: 12,   // 12-15 tier0, 16-19 tier1, 20-23 tier2, 24-27 tier3
        OFFSET_STROKE_COLORS: 28, // 28-31 tier0, ..., 40-43 tier3
        OFFSET_EDGE_COLOR: 44,    // 44-47 r,g,b,a
        OFFSET_EDGE_COLOR_HI: 48, // 48-51 r,g,b,a
        OFFSET_SEL_COLOR: 52,     // 52-55 r,g,b,a
    };

    // ===================================================================
    // Storage Buffer 布局常量（WGSL 对齐 stride，非紧打包！）
    //   NodeInstance: pos(2) + radius(1) + alpha(1) + tier(1) + _pad(1) = 6 floats = 24 bytes
    //     → WGSL 要求 stride 为 24（vec2<f32> 8-byte 对齐）
    //   EdgeInstance: p1(2) + p2(2) + halfWidth(1) + alpha(1) + highlight(1) + _pad(1) = 8 floats = 32 bytes
    //     → WGSL 要求 stride 为 32
    // ===================================================================

    var NODE_STRIDE_FLOATS = 6;
    var EDGE_STRIDE_FLOATS = 8;

    // ===================================================================
    // 静态四边形几何体（节点和边共用 4 顶点 + 6 索引）
    // ===================================================================

    var QUAD_VERTICES = new Float32Array([
        -1, -1,   1, -1,   1, 1,  -1, 1,
    ]);

    var QUAD_INDICES = new Uint16Array([0, 1, 2, 0, 2, 3]);

    // ===================================================================
    // 纹理采样器（所有管线共享）
    // ===================================================================

    var SAMPLER_DESC = {
        addressModeU: "clamp-to-edge",
        addressModeV: "clamp-to-edge",
        magFilter: "linear",
        minFilter: "linear",
        mipmapFilter: "nearest",
    };

    // ===================================================================
    // 构造函数
    // ===================================================================

    function GraphRendererGPU(canvas, options) {
        this._canvas = canvas;
        this._maxNodes = (options && options.maxNodes) || MAX_NODES;
        this._maxEdges = (options && options.maxEdges) || MAX_EDGES;

        // GPU 对象
        this._device = null;
        this._context = null;
        this._presentFormat = null;
        this._sampleCount = 4; // MSAA

        // Pipelines
        this._bgPipeline = null;
        this._nodePipeline = null;
        this._edgePipeline = null;

        // Bind Group Layouts
        this._bgBindGroupLayout = null;
        this._geomBindGroupLayout = null;

        // Buffers
        this._uniformBuffer = null;
        this._uniformData = new Float32Array(UNIFORM_LAYOUT.SIZE_FLOATS);
        this._quadVertexBuffer = null;
        this._quadIndexBuffer = null;
        this._nodeBuffer = null;
        this._edgeBuffer = null;

        // Background texture
        this._bgTexture = null;
        this._bgSampler = null;
        this._bgBindGroup = null;
        this._bgTextureVersion = 0; // 用于失效检测

        // Per-frame bind groups (rebuilt when node/edge count changes)
        this._nodeBindGroup = null;
        this._edgeBindGroup = null;

        // MSAA multisampled texture (recreated on resize)
        this._msaaTexture = null;
        this._msaaView = null;

        // State
        this._initialized = false;
        this._nodeCount = 0;
        this._edgeCount = 0;
        this._canvasWidth = 0;
        this._canvasHeight = 0;

        // 异步初始化
        this._initPromise = null;
    }

    // ===================================================================
    // 静态检测
    // ===================================================================

    GraphRendererGPU.isSupported = function () {
        return typeof navigator !== "undefined" && !!navigator.gpu;
    };

    // ===================================================================
    // 预加载（插件初始化时调用，消除首帧空白延迟）
    // ===================================================================
    //
    // navigator.gpu.requestAdapter() + adapter.requestDevice() 异步耗时
    // 100–500ms，是图谱打开后空白延迟的根因。
    // 此方法在插件加载结束时后台调用，到用户打开图谱时 device 已就绪，
    // init() 可同步完成，GPU 从第 1 帧即渲染。

    var _preloadedDevice = null;
    var _preloadPromise = null;

    GraphRendererGPU.preloadDevice = function () {
        if (typeof navigator === "undefined" || !navigator.gpu) return;
        if (_preloadedDevice || _preloadPromise) return;

        _preloadPromise = (async function () {
            try {
                var adapter = await navigator.gpu.requestAdapter();
                if (!adapter) {
                    console.warn("[graph-renderer-gpu] preload: adapter not available");
                    return null;
                }
                var device = await adapter.requestDevice({
                    requiredFeatures: [],
                    requiredLimits: {
                        maxStorageBufferBindingSize: Math.max(
                            MAX_NODES * NODE_STRIDE_FLOATS * 4,
                            MAX_EDGES * EDGE_STRIDE_FLOATS * 4
                        ),
                    },
                });
                _preloadedDevice = device;
                return device;
            } catch (err) {
                console.warn("[graph-renderer-gpu] preload failed:", err);
                return null;
            }
        })();
    };

    /**
     * 消费预加载的 device（如果有）。设备存活时复用，避免每次开图都重新
     * requestAdapter + requestDevice。设备丢失时返回 null，由 init() 自己请求。
     */
    GraphRendererGPU.consumePreloadedDevice = function () {
        return _preloadedDevice || null;
    };

    /**
     * 清理预加载设备（丢失时调用），触发后台重新预加载。
     */
    GraphRendererGPU.clearPreloadedDevice = function () {
        _preloadedDevice = null;
        _preloadPromise = null;
        GraphRendererGPU.preloadDevice();
    };

    // ===================================================================
    // 异步初始化（在 graph-view 中调用）
    // ===================================================================

    GraphRendererGPU.prototype.init = async function () {
        if (this._initialized) return true;
        if (this._initPromise) return this._initPromise;

        var self = this;
        this._initPromise = (async function () {
            try {
                // 1. 获取 adapter + device（优先消费预加载结果）
                var device = GraphRendererGPU.consumePreloadedDevice();
                if (!device) {
                    var adapter = await navigator.gpu.requestAdapter();
                    if (!adapter) {
                        console.warn("[graph-renderer-gpu] WebGPU adapter not available");
                        return false;
                    }
                    device = await adapter.requestDevice({
                        requiredFeatures: [],
                        requiredLimits: {
                            maxStorageBufferBindingSize: Math.max(
                                self._maxNodes * NODE_STRIDE_FLOATS * 4,
                                self._maxEdges * EDGE_STRIDE_FLOATS * 4
                            ),
                        },
                    });
                }
                self._device = device;

                // 丢失恢复
                device.lost.then(function (info) {
                    console.warn("[graph-renderer-gpu] Device lost:", info.reason);
                    self._handleDeviceLost();
                });

                // 3. 配置 canvas context
                self._context = self._canvas.getContext("webgpu");
                self._presentFormat = navigator.gpu.getPreferredCanvasFormat();
                self._context.configure({
                    device: device,
                    format: self._presentFormat,
                    alphaMode: "premultiplied",
                });

                // 4. 创建 Bind Group Layouts
                self._createBindGroupLayouts();

                // 5. 创建 Pipelines
                self._createBgPipeline();
                self._createNodePipeline();
                self._createEdgePipeline();

                // 6. 创建共享缓冲区
                self._createSharedBuffers();

                // 7. 创建采样器
                self._bgSampler = device.createSampler(SAMPLER_DESC);

                self._initialized = true;
                return true;
            } catch (err) {
                console.error("[graph-renderer-gpu] Init failed:", err);
                return false;
            }
        })();

        var result = await this._initPromise;
        return result;
    };

    // ===================================================================
    // Bind Group Layouts
    // ===================================================================

    GraphRendererGPU.prototype._createBindGroupLayouts = function () {
        var device = this._device;

        // 背景管线: sampler + texture
        this._bgBindGroupLayout = device.createBindGroupLayout({
            entries: [
                { binding: 0, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
                { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } },
            ],
        });

        // 几何管线: uniform + storage（节点和边共用布局）
        this._geomBindGroupLayout = device.createBindGroupLayout({
            entries: [
                {
                    binding: 0,
                    visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
                    buffer: { type: "uniform", hasDynamicOffset: false },
                },
                {
                    binding: 1,
                    visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
                    buffer: { type: "read-only-storage", hasDynamicOffset: false },
                },
            ],
        });
    };

    // ===================================================================
    // Pipeline 创建
    // ===================================================================

    GraphRendererGPU.prototype._createBgPipeline = function () {
        var device = this._device;

        var bgVertModule = device.createShaderModule({
            label: "bg-vert",
            code: SHADERS.BG_VERT,
        });
        var bgFragModule = device.createShaderModule({
            label: "bg-frag",
            code: SHADERS.BG_FRAG,
        });

        var pipelineLayout = device.createPipelineLayout({
            bindGroupLayouts: [this._bgBindGroupLayout],
        });

        this._bgPipeline = device.createRenderPipeline({
            label: "bg-pipeline",
            layout: pipelineLayout,
            vertex: {
                module: bgVertModule,
                entryPoint: "main",
            },
            fragment: {
                module: bgFragModule,
                entryPoint: "main",
                targets: [{ format: this._presentFormat }],
            },
            primitive: {
                topology: "triangle-list",
            },
            multisample: { count: this._sampleCount },
        });
    };

    GraphRendererGPU.prototype._createNodePipeline = function () {
        var device = this._device;

        var vertModule = device.createShaderModule({
            label: "node-vert",
            code: SHADERS.NODE_VERT,
        });
        var fragModule = device.createShaderModule({
            label: "node-frag",
            code: SHADERS.NODE_FRAG,
        });

        var pipelineLayout = device.createPipelineLayout({
            bindGroupLayouts: [this._geomBindGroupLayout],
        });

        this._nodePipeline = device.createRenderPipeline({
            label: "node-pipeline",
            layout: pipelineLayout,
            vertex: {
                module: vertModule,
                entryPoint: "main",
                buffers: [
                    {
                        // 静态四边形角点（vec2 per vertex）
                        arrayStride: 2 * 4, // 2 floats × 4 bytes
                        attributes: [
                            // corner: 无需显式 attribute — instances 通过 vertex_index 索引 CORNERS
                        ],
                    },
                ],
            },
            fragment: {
                module: fragModule,
                entryPoint: "main",
                targets: [
                    {
                        format: this._presentFormat,
                        blend: {
                            color: {
                                srcFactor: "one",
                                dstFactor: "one-minus-src-alpha",
                                operation: "add",
                            },
                            alpha: {
                                srcFactor: "one",
                                dstFactor: "one-minus-src-alpha",
                                operation: "add",
                            },
                        },
                    },
                ],
            },
            primitive: {
                topology: "triangle-list",
            },
            multisample: { count: this._sampleCount },
        });
    };

    GraphRendererGPU.prototype._createEdgePipeline = function () {
        var device = this._device;

        var vertModule = device.createShaderModule({
            label: "edge-vert",
            code: SHADERS.EDGE_VERT,
        });
        var fragModule = device.createShaderModule({
            label: "edge-frag",
            code: SHADERS.EDGE_FRAG,
        });

        var pipelineLayout = device.createPipelineLayout({
            bindGroupLayouts: [this._geomBindGroupLayout],
        });

        this._edgePipeline = device.createRenderPipeline({
            label: "edge-pipeline",
            layout: pipelineLayout,
            vertex: {
                module: vertModule,
                entryPoint: "main",
                buffers: [
                    {
                        arrayStride: 2 * 4,
                        stepMode: "vertex",
                        attributes: [],
                    },
                ],
            },
            fragment: {
                module: fragModule,
                entryPoint: "main",
                targets: [
                    {
                        format: this._presentFormat,
                        blend: {
                            color: {
                                srcFactor: "one",
                                dstFactor: "one-minus-src-alpha",
                                operation: "add",
                            },
                            alpha: {
                                srcFactor: "one",
                                dstFactor: "one-minus-src-alpha",
                                operation: "add",
                            },
                        },
                    },
                ],
            },
            primitive: {
                topology: "triangle-list",
            },
            multisample: { count: this._sampleCount },
        });
    };

    // ===================================================================
    // 共享缓冲区
    // ===================================================================

    GraphRendererGPU.prototype._createSharedBuffers = function () {
        var device = this._device;

        // Uniform buffer
        this._uniformBuffer = device.createBuffer({
            label: "uniforms",
            size: UNIFORM_LAYOUT.BUFFER_BYTES,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });

        // 四边形顶点缓冲（2D 角点，节点和边共用 vertex_index 索引 CORNERS[]）
        this._quadVertexBuffer = device.createBuffer({
            label: "quad-vertices",
            size: QUAD_VERTICES.byteLength,
            usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
        });
        device.queue.writeBuffer(this._quadVertexBuffer, 0, QUAD_VERTICES);

        // 四边形索引缓冲
        this._quadIndexBuffer = device.createBuffer({
            label: "quad-indices",
            size: QUAD_INDICES.byteLength,
            usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
        });
        device.queue.writeBuffer(this._quadIndexBuffer, 0, QUAD_INDICES);

        // 节点 Storage Buffer（每帧直接 writeBuffer 或 mapWrite）
        this._nodeBuffer = device.createBuffer({
            label: "node-instances",
            size: this._maxNodes * NODE_STRIDE_FLOATS * 4,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
        });

        // 边 Storage Buffer
        this._edgeBuffer = device.createBuffer({
            label: "edge-instances",
            size: this._maxEdges * EDGE_STRIDE_FLOATS * 4,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
        });
    };

    // ===================================================================
    // 缓存 Bind Group 的 node/edge 实例数据（仅在 count 变化时重建）
    // ===================================================================

    GraphRendererGPU.prototype._ensureNodeBindGroup = function (count) {
        if (this._nodeBindGroup && this._nodeCount === count) return;
        this._nodeCount = count;

        var device = this._device;
        // 仅绑定前 count 个实例—WebGPU 的 storage buffer 大小限制绑定范围
        // 实际绘制数由 drawIndexed 的 instanceCount 控制
        this._nodeBindGroup = device.createBindGroup({
            label: "node-bind-group",
            layout: this._geomBindGroupLayout,
            entries: [
                { binding: 0, resource: { buffer: this._uniformBuffer } },
                { binding: 1, resource: { buffer: this._nodeBuffer, offset: 0, size: this._nodeBuffer.size } },
            ],
        });
    };

    GraphRendererGPU.prototype._ensureEdgeBindGroup = function (count) {
        if (this._edgeBindGroup && this._edgeCount === count) return;
        this._edgeCount = count;

        var device = this._device;
        this._edgeBindGroup = device.createBindGroup({
            label: "edge-bind-group",
            layout: this._geomBindGroupLayout,
            entries: [
                { binding: 0, resource: { buffer: this._uniformBuffer } },
                { binding: 1, resource: { buffer: this._edgeBuffer, offset: 0, size: this._edgeBuffer.size } },
            ],
        });
    };

    // ===================================================================
    // Uniform 更新（每帧调用，writeBuffer 到 GPU）
    // ===================================================================

    /**
     * @param {object} data
     *   data.originX, originY  — 相机偏移
     *   data.scale             — 相机缩放
     *   data.cw, data.ch       — canvas CSS 尺寸
     *   data.dpr               — devicePixelRatio
     *   data.globalAlpha       — 渐显进度 0-1
     *   data.lodThreshold      — LOD 阈值 (5.0)
     *   data.fillColors        — [r,g,b,a, r,g,b,a, r,g,b,a, r,g,b,a] (16)
     *   data.strokeColors      — [r,g,b,a, r,g,b,a, r,g,b,a, r,g,b,a] (16)
     *   data.edgeColor         — [r,g,b,a] (4)
     *   data.edgeColorHi       — [r,g,b,a] (4)
     *   data.selColor          — [r,g,b,a] (4)
     */
    GraphRendererGPU.prototype.updateUniforms = function (data) {
        var u = this._uniformData;
        var L = UNIFORM_LAYOUT;

        u[L.OFFSET_ORIGIN_X] = data.originX;
        u[L.OFFSET_ORIGIN_Y] = data.originY;
        u[L.OFFSET_SCALE] = data.scale;
        u[L.OFFSET_RESOLUTION_X] = data.cw;
        u[L.OFFSET_RESOLUTION_Y] = data.ch;
        u[L.OFFSET_DPR] = data.dpr;
        u[L.OFFSET_GLOBAL_ALPHA] = data.globalAlpha;
        u[L.OFFSET_LOD_THRESHOLD] = data.lodThreshold;

        // Fill colors: 4 × vec4
        for (var i = 0; i < 16; i++) {
            u[L.OFFSET_FILL_COLORS + i] = data.fillColors[i] || 0;
            u[L.OFFSET_STROKE_COLORS + i] = data.strokeColors[i] || 0;
        }

        // Edge / Selection colors
        for (var j = 0; j < 4; j++) {
            u[L.OFFSET_EDGE_COLOR + j] = data.edgeColor[j] || 0;
            u[L.OFFSET_EDGE_COLOR_HI + j] = data.edgeColorHi[j] || 0;
            u[L.OFFSET_SEL_COLOR + j] = data.selColor[j] || 0;
        }

        this._device.queue.writeBuffer(this._uniformBuffer, 0, this._uniformData.buffer,
            this._uniformData.byteOffset, UNIFORM_LAYOUT.SIZE_BYTES);
    };

    // ===================================================================
    // 节点数据上传（每帧调用）
    // ===================================================================

    /**
     * @param {Float32Array} data — [x, y, radius, alpha, tier, ...] × N
     */
    GraphRendererGPU.prototype.updateNodeBuffer = function (data) {
        var count = (data.length / NODE_STRIDE_FLOATS) | 0;
        var byteLen = count * NODE_STRIDE_FLOATS * 4;
        this._device.queue.writeBuffer(this._nodeBuffer, 0, data.buffer, data.byteOffset, byteLen);
        this._ensureNodeBindGroup(count);
    };

    // ===================================================================
    // 边数据上传（每帧调用）
    // ===================================================================

    /**
     * @param {Float32Array} data — [p1x, p1y, p2x, p2y, halfWidth, alpha, highlight, ...] × E
     */
    GraphRendererGPU.prototype.updateEdgeBuffer = function (data) {
        var count = (data.length / EDGE_STRIDE_FLOATS) | 0;
        var byteLen = count * EDGE_STRIDE_FLOATS * 4;
        this._device.queue.writeBuffer(this._edgeBuffer, 0, data.buffer, data.byteOffset, byteLen);
        this._ensureEdgeBindGroup(count);
    };

    // ===================================================================
    // 背景纹理更新（离屏 Canvas → GPU Texture）
    //    仅在背景缓存变化时调用（主题切换、尺寸变化）
    // ===================================================================

    /**
     * 同步上传背景纹理。用 OffscreenCanvas(transferControlToOffscreen)
     * 或直接 createImageBitmap（同步版不可用）。这里直接 copyExternalImage
     * —— 使用 ImageBitmap 但等待 Promise 完成后再允许渲染。
     *
     * 策略: upload 是同步非阻塞 fire-and-forget，但立即构建 bindGroup
     * 使用未填充的纹理。纹理内容可能延迟 1 帧，但 bindGroup 立即可用
     * 避免 null bindGroup 导致黑背景。
     *
     * 背景缓存只在主题/尺寸变化时重新生成 → 调用频率极低（通常首次），
     * 下一帧必然有内容。
     */
    GraphRendererGPU.prototype.updateBgTexture = function (bgCanvas) {
        if (!bgCanvas) return;

        var device = this._device;

        // 用 canvas 尺寸做版本检测
        var version = bgCanvas.width + "x" + bgCanvas.height;
        if (version === this._bgTextureVersion && this._bgBindGroup) return;

        // 首次: 创建纹理 + bindGroup（纹理内容可能空白 1-2 帧，比纯黑好）
        if (!this._bgTexture || version !== this._bgTextureVersion) {
            this._bgTextureVersion = version;

            var w = bgCanvas.width;
            var h = bgCanvas.height;

            if (this._bgTexture) { this._bgTexture.destroy(); }

            this._bgTexture = device.createTexture({
                label: "bg-texture",
                size: [w, h, 1],
                format: "rgba8unorm",
                usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
            });

            // 立即构建 bindGroup — 保证 GPU pipeline 至少有一个纹理可采样
            this._buildBgBindGroup();
        }

        // Fire-and-forget 异步上传。如果失败了至少 bindGroup 已存在（采黑色）
        var self = this;
        createImageBitmap(bgCanvas).then(function (bitmap) {
            if (!self._bgTexture) return;
            device.queue.copyExternalImageToTexture(
                { source: bitmap },
                { texture: self._bgTexture, origin: [0, 0, 0] },
                [bitmap.width, bitmap.height, 1]
            );
            bitmap.close();
        }).catch(function () {
            // 静默忽略 — bindGroup 已就位，纹理内容后续帧会更新
        });
    };

    GraphRendererGPU.prototype._buildBgBindGroup = function () {
        if (!this._bgTexture || !this._bgSampler) return;
        this._bgBindGroup = this._device.createBindGroup({
            label: "bg-bind-group",
            layout: this._bgBindGroupLayout,
            entries: [
                { binding: 0, resource: this._bgSampler },
                { binding: 1, resource: this._bgTexture.createView() },
            ],
        });
    };

    // ===================================================================
    // 调整大小（canvas 尺寸变化时调用）
    // ===================================================================

    GraphRendererGPU.prototype.resize = function (w, h, dpr) {
        var pw = Math.round(w * dpr);
        var ph = Math.round(h * dpr);

        if (pw === this._canvasWidth && ph === this._canvasHeight) return;

        this._canvasWidth = pw;
        this._canvasHeight = ph;

        // 设置 DOM canvas 的像素尺寸 — 驱动 swap chain 纹理大小
        this._canvas.width = pw;
        this._canvas.height = ph;

        // 重新配置 context 以匹配新尺寸
        if (this._context) {
            this._context.configure({
                device: this._device,
                format: this._presentFormat,
                alphaMode: "premultiplied",
            });
        }

        // 重建 MSAA 纹理（必须与 swap chain 纹理同尺寸）
        this._ensureMSAATexture();
    };

    GraphRendererGPU.prototype._ensureMSAATexture = function () {
        var device = this._device;
        if (!device) return;

        var pw = this._canvasWidth || 1;
        var ph = this._canvasHeight || 1;

        // 销毁旧 MSAA 纹理
        if (this._msaaTexture) {
            this._msaaTexture.destroy();
            this._msaaTexture = null;
            this._msaaView = null;
        }

        if (pw < 1 || ph < 1) return;

        this._msaaTexture = device.createTexture({
            label: "msaa-texture",
            size: [pw, ph, 1],
            sampleCount: this._sampleCount,
            format: this._presentFormat,
            usage: GPUTextureUsage.RENDER_ATTACHMENT,
        });
        this._msaaView = this._msaaTexture.createView();
    };

    // ===================================================================
    // 每帧渲染
    // ===================================================================

    GraphRendererGPU.prototype.render = function (nodeCount, edgeCount) {
        var device = this._device;
        if (!device || !this._initialized) return;

        // 确保 MSAA 纹理存在
        this._ensureMSAATexture();
        if (!this._msaaView) return;

        // 获取当前帧纹理
        var canvasTexture = this._context.getCurrentTexture();
        var canvasView = canvasTexture.createView();

        // 创建命令编码器
        var encoder = device.createCommandEncoder({ label: "frame-encoder" });

        // Render pass 描述 — MSAA + 背景清除
        var colorAttachment = {
            view: this._msaaView,
            resolveTarget: canvasView,
            clearValue: { r: 0.0, g: 0.0, b: 0.0, a: 0.0 },
            loadOp: "clear",
            storeOp: "store",
        };

        var pass = encoder.beginRenderPass({
            label: "main-pass",
            colorAttachments: [colorAttachment],
        });

        // ---- 通道 1: 背景纹理 quad ----
        if (this._bgBindGroup) {
            pass.setPipeline(this._bgPipeline);
            pass.setBindGroup(0, this._bgBindGroup);
            pass.draw(3, 1, 0, 0); // 全屏三角形 (3 顶点)
        }

        // ---- 通道 2: 边 ----
        if (edgeCount > 0 && this._edgeBindGroup) {
            pass.setPipeline(this._edgePipeline);
            pass.setVertexBuffer(0, this._quadVertexBuffer);
            pass.setIndexBuffer(this._quadIndexBuffer, "uint16");
            pass.setBindGroup(0, this._edgeBindGroup);
            pass.drawIndexed(6, edgeCount, 0, 0, 0);
        }

        // ---- 通道 3: 节点 ----
        if (nodeCount > 0 && this._nodeBindGroup) {
            pass.setPipeline(this._nodePipeline);
            pass.setVertexBuffer(0, this._quadVertexBuffer);
            pass.setIndexBuffer(this._quadIndexBuffer, "uint16");
            pass.setBindGroup(0, this._nodeBindGroup);
            pass.drawIndexed(6, nodeCount, 0, 0, 0);
        }

        pass.end();

        device.queue.submit([encoder.finish()]);
    };

    // ===================================================================
    // 设备丢失恢复
    // ===================================================================

    GraphRendererGPU.prototype._handleDeviceLost = function () {
        this._initialized = false;
        this._initPromise = null;
        this._bgTexture = null;
        this._bgBindGroup = null;
        this._nodeBindGroup = null;
        this._edgeBindGroup = null;
        // 清除已丢失的预加载设备，触发后台重新预加载
        GraphRendererGPU.clearPreloadedDevice();
    };

    // ===================================================================
    // 销毁
    // ===================================================================

    GraphRendererGPU.prototype.destroy = function () {
        if (this._bgTexture) { this._bgTexture.destroy(); this._bgTexture = null; }
        if (this._msaaTexture) { this._msaaTexture.destroy(); this._msaaTexture = null; }
        if (this._uniformBuffer) { this._uniformBuffer.destroy(); this._uniformBuffer = null; }
        if (this._quadVertexBuffer) { this._quadVertexBuffer.destroy(); this._quadVertexBuffer = null; }
        if (this._quadIndexBuffer) { this._quadIndexBuffer.destroy(); this._quadIndexBuffer = null; }
        if (this._nodeBuffer) { this._nodeBuffer.destroy(); this._nodeBuffer = null; }
        if (this._edgeBuffer) { this._edgeBuffer.destroy(); this._edgeBuffer = null; }
        this._initialized = false;
    };

    module.exports = GraphRendererGPU;
})();
