/**
 * Split Debug v0.4 — 侧边栏展开抽搐定位
 * ======================================
 * 验证"分屏容器/贴片是否遮挡侧边栏":
 *   1. 静态堆叠检查: sidebar/container/leftPane 的 z-index/rect/背景
 *   2. elementFromPoint 采样侧边栏区域 (120,400) — 该点最上层元素是谁
 *   3. 监听 #typora-sidebar 的 transitionrun (动画开始) → 每 50ms 采样
 *      顶层元素, 判断动画期间谁盖住了侧边栏
 *
 * 命令: split-debug:stack — 静态检查 + 绑定动画采样
 */
var BetterTypora = require("bettertypora:api");
var api = BetterTypora.api;
var logger = BetterTypora.logger;

var probeTimer = null;

function topAt(x, y) {
    try {
        var el = document.elementFromPoint(x, y);
        if (!el) return "null";
        var chain = [];
        var n = el;
        while (n && n !== document.body && chain.length < 4) {
            var cls = (typeof n.className === "string" ? n.className : "").split(" ")[0];
            chain.push(n.tagName.toLowerCase() + (n.id ? "#" + n.id : "") + (cls ? "." + cls : ""));
            n = n.parentElement;
        }
        return chain.join(" < ");
    } catch (e) {
        return "err:" + e.message;
    }
}

function runStack() {
    logger.log("===== 堆叠检查 =====");
    var sidebar = document.getElementById("typora-sidebar");
    var container = document.getElementById("bt-split-container");

    if (sidebar) {
        var cs = getComputedStyle(sidebar);
        var r = sidebar.getBoundingClientRect();
        logger.log("sidebar: z=" + cs.zIndex + " | pos=" + cs.position +
            " | left=" + cs.left + " | rect=" + Math.round(r.left) + "," + Math.round(r.top) +
            " " + Math.round(r.width) + "x" + Math.round(r.height));
    }
    if (container) {
        var cc = getComputedStyle(container);
        var cr = container.getBoundingClientRect();
        logger.log("container: z=" + cc.zIndex + " | rect左=" + Math.round(cr.left) + " 宽=" + Math.round(cr.width));
    }
    var left = document.getElementById("bt-split-left");
    if (left) {
        var lc = getComputedStyle(left);
        var lr = left.getBoundingClientRect();
        logger.log("leftPane: z=" + lc.zIndex + " | bg=" + lc.backgroundColor +
            " | rect左=" + Math.round(lr.left) + " 宽=" + Math.round(lr.width));
    }
    var editorFixed = document.querySelector(".bt-editor-fixed");
    if (editorFixed) {
        var ec = getComputedStyle(editorFixed);
        var er = editorFixed.getBoundingClientRect();
        logger.log("editorEl(贴片): z=" + ec.zIndex + " | rect=" + Math.round(er.left) + " 宽=" + Math.round(er.width));
    }

    // 侧边栏区域采样点 (展开后侧边栏应覆盖 0~239)
    logger.log("elementFromPoint (120,400): " + topAt(120, 400));
    logger.log("elementFromPoint (230,400): " + topAt(230, 400));
    logger.log("elementFromPoint (300,400): " + topAt(300, 400));

    // 监听侧边栏动画 (transitionrun 在过渡开始时触发)
    logger.log(">>> 已监听 #typora-sidebar transitionrun — 请现在收起/展开侧边栏");
    if (probeTimer) { clearInterval(probeTimer); probeTimer = null; }
    sidebar.addEventListener("transitionrun", function (e) {
        if (e.propertyName !== "left") return;
        logger.log(">>> 侧边栏动画开始 (property=" + e.propertyName + ")");
        var start = Date.now();
        if (probeTimer) clearInterval(probeTimer);
        probeTimer = setInterval(function () {
            var cs2 = getComputedStyle(sidebar);
            logger.log("  [t+" + (Date.now() - start) + "ms] sidebar.left=" + cs2.left +
                " | (120,400)顶层=" + topAt(120, 400) +
                " | (230,400)顶层=" + topAt(230, 400));
            if (Date.now() - start > 600) {
                clearInterval(probeTimer);
                probeTimer = null;
                logger.log(">>> 采样结束");
            }
        }, 50);
    }, true);
}

exports.onLoad = function () {
    api.registerCommand("stack", runStack, "堆叠检查 + 侧边栏动画采样");
    logger.log("split-debug v0.4 已加载: split-debug:stack");
};

exports.onUnload = function () {
    if (probeTimer) { clearInterval(probeTimer); probeTimer = null; }
};
