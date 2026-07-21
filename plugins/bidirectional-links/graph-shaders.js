/**
 * Bidirectional Links — WebGPU Shaders (WGSL)
 * =============================================
 * 4 个着色器模块:
 *   - node.vert.wgsl + node.frag.wgsl  (实例化四边形 → 圆盘 + 描边)
 *   - edge.vert.wgsl + edge.frag.wgsl  (实例化四边形 → 线段 + MSAA)
 *   - bg.vert.wgsl   + bg.frag.wgsl    (全屏三角形 → 背景纹理采样)
 */

(function () {
    "use strict";

    // ===================================================================
    // 背景着色器（全屏三角形 + 纹理采样）
    // ===================================================================

    var BG_VERT = /* wgsl */`
struct VertexOutput {
    @builtin(position) pos: vec4<f32>,
    @location(0) uv: vec2<f32>,
}

@vertex
fn main(@builtin(vertex_index) vid: u32) -> VertexOutput {
    // 全屏三角形，覆盖 NDC [-1,1]²（仅 3 个顶点，无需索引缓冲）
    let pos = array<vec2<f32>, 3>(
        vec2(-1.0, -1.0),
        vec2( 3.0, -1.0),
        vec2(-1.0,  3.0),
    );
    let uv = array<vec2<f32>, 3>(
        vec2(0.0, 0.0),
        vec2(2.0, 0.0),
        vec2(0.0, 2.0),
    );
    var out: VertexOutput;
    out.pos = vec4(pos[vid], 0.0, 1.0);
    out.uv = uv[vid];
    return out;
}
`;

    var BG_FRAG = /* wgsl */`
@group(0) @binding(0) var bgSampler: sampler;
@group(0) @binding(1) var bgTexture: texture_2d<f32>;

@fragment
fn main(@location(0) uv: vec2<f32>) -> @location(0) vec4<f32> {
    return textureSample(bgTexture, bgSampler, uv);
}
`;

    // ===================================================================
    // 共享 Uniform 结构体（节点和边着色器共用）
    //
    // Float32Array 布局（56 floats = 224 bytes → buffer 256 bytes）:
    //   [0-1]   origin.x, origin.y          (offset 0)
    //   [2]     scale                       (offset 8)
    //   [3]     _pad0                       (offset 12)
    //   [4-5]   resolution.x, resolution.y  (offset 16)
    //   [6]     dpr                         (offset 24)
    //   [7]     globalAlpha                 (offset 28)
    //   [8]     lodThreshold                (offset 32)
    //   [9]     _pad1                       (offset 36)
    //   [10-11] _pad_a, _pad_b             (offset 40,44 — align fillColors to 48)
    //   [12-15] fillColors[0] r,g,b,a      (offset 48)
    //   [16-19] fillColors[1]              (offset 64)
    //   [20-23] fillColors[2]              (offset 80)
    //   [24-27] fillColors[3]              (offset 96)
    //   [28-31] strokeColors[0]            (offset 112)
    //   [32-35] strokeColors[1]            (offset 128)
    //   [36-39] strokeColors[2]            (offset 144)
    //   [40-43] strokeColors[3]            (offset 160)
    //   [44-47] edgeColor r,g,b,a          (offset 176)
    //   [48-51] edgeColorHi r,g,b,a        (offset 192)
    //   [52-55] selColor r,g,b,a           (offset 208)
    // ===================================================================

    var UNIFORM_DEFS = /* wgsl */`
struct Uniforms {
    origin: vec2<f32>,
    scale: f32,
    _pad0: f32,
    resolution: vec2<f32>,
    dpr: f32,
    globalAlpha: f32,
    lodThreshold: f32,
    _pad1: f32,
    _pad_vec2: vec2<f32>,            // alignment padding → fillColors at offset 48
    fillColors: array<vec4<f32>, 4>,
    strokeColors: array<vec4<f32>, 4>,
    edgeColor: vec4<f32>,
    edgeColorHi: vec4<f32>,
    selColor: vec4<f32>,
}

struct NodeInstance {
    pos: vec2<f32>,      // offset 0
    radius: f32,         // offset 8
    alpha: f32,          // offset 12
    tier: f32,           // offset 16
    _pad: f32,           // offset 20 → stride 24 (align 8)
}

struct EdgeInstance {
    p1: vec2<f32>,
    p2: vec2<f32>,
    halfWidth: f32,
    alpha: f32,
    highlight: f32,
    _pad: f32,           // stride 32 (align 8)
}
`;

    // ===================================================================
    // 节点着色器（实例化四边形 → 圆盘 + 描边）
    // ===================================================================

    var NODE_VERT = /* wgsl */`
${UNIFORM_DEFS}

struct VertexOutput {
    @builtin(position) pos: vec4<f32>,
    @location(0) centerX: f32,
    @location(1) centerY: f32,
    @location(2) screenRpx: f32,   // device pixels — 用于像素距离计算
    @location(3) screenR: f32,     // CSS pixels — 用于 LOD 决策（与 Canvas 2D 一致）
    @location(4) alpha: f32,
    @location(5) tier: f32,
}

@group(0) @binding(0) var<uniform> u: Uniforms;
@group(0) @binding(1) var<storage> instances: array<NodeInstance>;

// 四边形角点 (4 vertices × 6 indexed draws = 2 triangles)
var<private> CORNERS: array<vec2<f32>, 4> = array(
    vec2(-1.0, -1.0),
    vec2( 1.0, -1.0),
    vec2( 1.0,  1.0),
    vec2(-1.0,  1.0),
);

@vertex
fn main(
    @builtin(vertex_index) vid: u32,
    @builtin(instance_index) iid: u32,
) -> VertexOutput {
    let inst = instances[iid];

    // World → screen CSS pixels
    let sx = inst.pos.x * u.scale + u.origin.x;
    let sy = inst.pos.y * u.scale + u.origin.y;
    let sr = inst.radius * u.scale;

    // CSS → device pixels
    let cpx = sx * u.dpr;
    let cpy = sy * u.dpr;
    let srpx = sr * u.dpr;

    // 四边形角点偏移（+4px 给 AA 留空间）
    let margin = 4.0;
    let off = CORNERS[vid] * (srpx + margin);
    let px = cpx + off.x;
    let py = cpy + off.y;

    // Device pixels → NDC (Y 轴翻转: WebGPU Y-up vs screen Y-down)
    let ndcX = px / (u.resolution.x * u.dpr) * 2.0 - 1.0;
    let ndcY = 1.0 - py / (u.resolution.y * u.dpr) * 2.0;

    var out: VertexOutput;
    out.pos = vec4(ndcX, ndcY, 0.0, 1.0);
    out.centerX = cpx;
    out.centerY = cpy;
    out.screenRpx = srpx;
    out.screenR = sr;     // CSS pixels — LOD 决策用
    out.alpha = inst.alpha;
    out.tier = inst.tier;
    return out;
}
`;

    var NODE_FRAG = /* wgsl */`
${UNIFORM_DEFS}

@group(0) @binding(0) var<uniform> u: Uniforms;

@fragment
fn main(
    @location(0) centerX: f32,
    @location(1) centerY: f32,
    @location(2) screenRpx: f32,
    @location(3) screenR: f32,
    @location(4) alpha: f32,
    @location(5) tier: f32,
    @builtin(position) pixelPos: vec4<f32>,
) -> @location(0) vec4<f32> {
    // 像素到圆心的距离
    let dx = pixelPos.x - centerX;
    let dy = pixelPos.y - centerY;
    let dist = sqrt(dx * dx + dy * dy);

    let t = u32(clamp(tier, 0.0, 3.0));
    let fc = u.fillColors[t];
    let sc = u.strokeColors[t];

    if (screenR < u.lodThreshold) {
        // LOD0: 仅填充，无描边（screenR < 5px 时描边不可见）
        let aa = 1.0 - smoothstep(screenRpx - 1.0, screenRpx + 1.0, dist);
        let finalAlpha = fc.a * aa * alpha * u.globalAlpha;
        return vec4(fc.rgb * finalAlpha, finalAlpha);
    } else {
        // LOD1: fill + stroke（strokeWidth = 6% screenR）
        let sw = max(0.5, screenRpx * 0.06);
        let r = screenRpx;

        // Fill 区域: 内侧到 (r - sw) 处
        let fillInner = r - sw;
        let fillAA = 1.0 - smoothstep(fillInner - 0.7, fillInner + 0.7, dist);

        // Stroke 区域: (r - sw) 到 r
        let strokeAA =
            smoothstep(fillInner - 1.0, fillInner + 0.3, dist)
            * (1.0 - smoothstep(r - 1.0, r + 1.0, dist));

        // 混合 fill 和 stroke 颜色: fill 主导内部, stroke 主导边缘
        let fa = fillAA;
        let sa = max(fillAA, strokeAA);
        let blendF = fa / max(sa, 0.001);
        let col = mix(sc.rgb, fc.rgb, blendF);

        let finalAlpha = max(fc.a * fa, sc.a * strokeAA) * alpha * u.globalAlpha;
        return vec4(col * finalAlpha, finalAlpha);
    }
}
`;

    // ===================================================================
    // 边着色器（实例化四边形 → 定向线段）
    //   - WebGPU lineWidth 强制 = 1，因此用四边形模拟可变宽度
    //   - MSAA 4x 自动抗锯齿，无需手工 smoothstep
    // ===================================================================

    var EDGE_VERT = /* wgsl */`
${UNIFORM_DEFS}

struct VertexOutput {
    @builtin(position) pos: vec4<f32>,
    @location(0) alpha: f32,
    @location(1) highlight: f32,
}

@group(0) @binding(0) var<uniform> u: Uniforms;
@group(0) @binding(1) var<storage> instances: array<EdgeInstance>;

// 四边形角点 — x=t(沿边), y=side(垂直侧, -1=左, +1=右)
var<private> CORNERS: array<vec2<f32>, 4> = array(
    vec2(0.0, -1.0),  // 起点, 左侧
    vec2(1.0, -1.0),  // 终点, 左侧
    vec2(1.0,  1.0),  // 终点, 右侧
    vec2(0.0,  1.0),  // 起点, 右侧
);

@vertex
fn main(
    @builtin(vertex_index) vid: u32,
    @builtin(instance_index) iid: u32,
) -> VertexOutput {
    let e = instances[iid];

    // 端点 world → screen CSS
    let s1x = e.p1.x * u.scale + u.origin.x;
    let s1y = e.p1.y * u.scale + u.origin.y;
    let s2x = e.p2.x * u.scale + u.origin.x;
    let s2y = e.p2.y * u.scale + u.origin.y;

    // 边方向 + 法线
    let edx = s2x - s1x;
    let edy = s2y - s1y;
    let len = sqrt(edx * edx + edy * edy);
    let ux = edx / max(len, 0.001);
    let uy = edy / max(len, 0.001);
    let nx = -uy;  // 垂直方向
    let ny =  ux;

    let t  = CORNERS[vid].x;   // 0=起点, 1=终点
    let side = CORNERS[vid].y; // -1=左, +1=右

    // 四边形角点在设备像素空间的位置
    let px = (s1x + ux * t * len + nx * side * e.halfWidth) * u.dpr;
    let py = (s1y + uy * t * len + ny * side * e.halfWidth) * u.dpr;

    // NDC (Y 翻转)
    let ndcX = px / (u.resolution.x * u.dpr) * 2.0 - 1.0;
    let ndcY = 1.0 - py / (u.resolution.y * u.dpr) * 2.0;

    var out: VertexOutput;
    out.pos = vec4(ndcX, ndcY, 0.0, 1.0);
    out.alpha = e.alpha;
    out.highlight = e.highlight;
    return out;
}
`;

    var EDGE_FRAG = /* wgsl */`
${UNIFORM_DEFS}

@group(0) @binding(0) var<uniform> u: Uniforms;

@fragment
fn main(
    @location(0) alpha: f32,
    @location(1) highlight: f32,
) -> @location(0) vec4<f32> {
    let col = mix(u.edgeColor, u.edgeColorHi, highlight);
    let finalAlpha = col.a * alpha * u.globalAlpha;
    return vec4(col.rgb * finalAlpha, finalAlpha);
}
`;

    // ===================================================================
    // 统一导出
    // ===================================================================

    var SHADERS = {
        BG_VERT:    BG_VERT,
        BG_FRAG:    BG_FRAG,
        NODE_VERT:  NODE_VERT,
        NODE_FRAG:  NODE_FRAG,
        EDGE_VERT:  EDGE_VERT,
        EDGE_FRAG:  EDGE_FRAG,
    };

    module.exports = SHADERS;
})();
