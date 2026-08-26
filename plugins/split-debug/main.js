/**
 * Split Debug v0.8 — 滚动恢复链路追踪
 * ======================================
 * 定位"恢复滚动失败跳顶部"。包装 File.recoverPosOrScroll 观察调用参数,
 * 监听编辑器滚动和文件打开事件, 输出完整时间线。
 *
 * 命令: split-debug:trace
 *   1. 包装 File.recoverPosOrScroll: 输出调用参数 (scrollOffset/timeStamp)
 *      + 当前文件 — 直接看到 split-view 恢复时传的值
 *   2. 监听 content(editorEl) 滚动: 输出 scrollTop — 确认滚动记录环节
 *   3. 监听 opened 事件: 输出文件路径 — 确认路径一致性
 */
var BetterTypora = require("bettertypora:api");
var api = BetterTypora.api;
var logger = BetterTypora.logger;

function editorEl() {
    try {
        return File.editor.writingArea.parentElement;
    } catch (e) {
        return null;
    }
}

function base(p) {
    return p ? String(p).split(/[\\/]/).pop() : "null";
}

function run() {
    logger.log("===== 滚动恢复链路追踪开始 =====");

    // 1. 包装 File.recoverPosOrScroll
    try {
        var orig = File.recoverPosOrScroll;
        if (orig && !File.__btTraced) {
            File.__btTraced = true;
            File.recoverPosOrScroll = function (e) {
                logger.log("[recover调用] e=" + JSON.stringify(e) +
                    " | 当前文件=" + base(File.bundle.filePath) +
                    " | content.scrollTop=" + (editorEl() ? editorEl().scrollTop : "?"));
                return orig.apply(this, arguments);
            };
            logger.log("已包装 File.recoverPosOrScroll");
        }
    } catch (e) {
        logger.log("包装失败: " + e.message);
    }

    // 2. 监听编辑器滚动
    var ee = editorEl();
    if (ee) {
        ee.addEventListener("scroll", function () {
            logger.log("[编辑器滚动] scrollTop=" + ee.scrollTop +
                " | 当前文件=" + base(BetterTypora.getCurrentFile()));
        }, { passive: true });
        logger.log("已监听编辑器滚动 (当前 content.scrollTop=" + ee.scrollTop + ")");
    }

    // 3. 监听 opened 事件
    window.BetterTypora.onFileEvent("opened", function (data) {
        logger.log("[opened事件] path=" + base(data && data.path));
    });
    logger.log("已监听 opened 事件");

    logger.log(">>> 操作: 1) 滚动编辑器到任意位置  2) 点击另一栏切换焦点");
    logger.log(">>> 追踪将持续 30 秒");
    setTimeout(function () {
        logger.log("===== 追踪结束 =====");
    }, 30000);
}

exports.onLoad = function () {
    api.registerCommand("trace", run, "滚动恢复链路追踪");
    logger.log("split-debug v0.8 已加载: split-debug:trace");
};

exports.onUnload = function () {};

/* =====================================================================
 * v0.9 — 布局诊断探针 (自动): 输出编辑器 vs 预览的行宽对比
 *   编辑器: content(editorEl) offsetW/clientW → 滚动条宽; #write 内容行宽
 *   预览:   容器 offsetW/clientW → 滚动条宽; 内容行宽 (clientW - padding)
 *   对比两者行宽差, 定位"预览行宽比编辑器小"的原因
 * ===================================================================== */
function installLayoutProbe() {
    if (document.__btLayoutProbe) return;
    document.__btLayoutProbe = true;
    var last = 0;
    function dump(tag) {
        var now = Date.now();
        if (now - last < 800) return;   // 节流
        last = now;
        try {
            var ee = editorEl();
            var writeEl = document.querySelector("#write");
            var pv = document.querySelector(".bt-split-preview");
            if (!ee || !writeEl || !pv) {
                logger.log("[布局] 未就绪 (" + tag + "): " +
                    (!ee ? "no editorEl " : "") + (!writeEl ? "no #write " : "") + (!pv ? "no preview" : ""));
                return;
            }
            var wcs = getComputedStyle(writeEl);
            var pcs = getComputedStyle(pv);
            var wLine = writeEl.clientWidth - parseFloat(wcs.paddingLeft) - parseFloat(wcs.paddingRight);
            var pLine = pv.clientWidth - parseFloat(pcs.paddingLeft) - parseFloat(pcs.paddingRight);
            logger.log("[布局] " + tag +
                " | #write box=" + wcs.boxSizing + " maxW=" + wcs.maxWidth +
                " | 预览 box=" + pcs.boxSizing + " maxW=" + pcs.maxWidth);
            logger.log(" | 编辑器: content offsetW=" + ee.offsetWidth + " clientW=" + ee.clientWidth +
                " (滚动条=" + (ee.offsetWidth - ee.clientWidth) + ")" +
                " | #write clientW=" + writeEl.clientWidth + " padLR=" + wcs.paddingLeft + "/" + wcs.paddingRight +
                " | 编辑行宽=" + Math.round(wLine) +
                " | 预览: 容器 offsetW=" + pv.offsetWidth + " clientW=" + pv.clientWidth +
                " (滚动条=" + (pv.offsetWidth - pv.clientWidth) + ")" +
                " padLR=" + pcs.paddingLeft + "/" + pcs.paddingRight +
                " | 预览行宽=" + Math.round(pLine) +
                " | 差=" + Math.round(wLine - pLine));
        } catch (e) { logger.log("[布局] 错误: " + e.message); }
    }
    // 预览容器出现/变化 → dump (切换焦点/渲染/滚动都会触发)
    var mo = new MutationObserver(function (muts) {
        var hit = false;
        for (var i = 0; i < muts.length; i++) {
            var t = muts[i].target;
            if (t.classList && t.classList.contains("bt-split-preview")) { hit = true; break; }
        }
        if (hit) setTimeout(function () { dump("变化"); }, 250);
    });
    var watch = setInterval(function () {
        var pv = document.querySelector(".bt-split-preview");
        if (pv) {
            clearInterval(watch);
            mo.observe(pv, { childList: true, subtree: true, characterData: true });
            setTimeout(function () { dump("初始"); }, 500);
            logger.log("[布局] 探针已挂载 (观察预览容器)");
        }
    }, 1000);
}

/* =====================================================================
 * v0.10 — 滚动条样式诊断: 左右栏滚动条一致性 + ::-webkit-scrollbar
 * 规则是否生效 (主题 claude 定义 6px 细滚动条, 但实测占宽 12px)
 * ===================================================================== */
function installScrollbarProbe() {
    function measure(el, tag) {
        if (!el) return;
        var sb = el.offsetWidth - el.clientWidth;
        logger.log("[滚动条] " + tag + ": offsetW=" + el.offsetWidth +
            " clientW=" + el.clientWidth + " 滚动条占宽=" + sb +
            " | rect.left=" + Math.round(el.getBoundingClientRect().left) +
            " rect.right=" + Math.round(el.getBoundingClientRect().right));
    }
    setTimeout(function () {
        try {
            var ee = editorEl();
            var pvL = document.getElementById("bt-split-left-content");
            var pvR = document.getElementById("bt-split-right-content");
            measure(ee, "编辑器content");
            measure(pvL, "左栏预览容器");
            measure(pvR, "右栏预览容器");

            // ::-webkit-scrollbar 规则是否生效: 注入 width:6px 测试
            var div = document.createElement("div");
            div.style.cssText = "position:fixed;left:-9999px;top:0;width:120px;height:120px;overflow:scroll;";
            document.body.appendChild(div);
            var native = div.offsetWidth - div.clientWidth;
            var st = document.createElement("style");
            st.textContent = ".bt-sb-test::-webkit-scrollbar { width: 6px; height: 6px; }" +
                ".bt-sb-test::-webkit-scrollbar-thumb { background: #f00; }";
            div.className = "bt-sb-test";
            document.head.appendChild(st);
            var styled = div.offsetWidth - div.clientWidth;
            document.body.removeChild(div);
            document.head.removeChild(st);
            logger.log("[滚动条] 测试: 无自定义规则占宽=" + native +
                ", 注入 webkit-scrollbar 6px 后占宽=" + styled +
                " → " + (styled === native ? "::-webkit-scrollbar 规则不生效 (环境禁用/被覆盖)"
                    : "规则生效, 主题6px应生效"));
        } catch (e) { logger.log("[滚动条] 诊断错误: " + e.message); }
    }, 800);
}

/* =====================================================================
 * v0.11 — 公式颜色诊断: 编辑器 vs 预览 mjx-container 的 SVG fill
 * 与容器 color 对比 (MathJax fill=currentColor, 颜色在渲染时固化)
 * ===================================================================== */
function installMathColorProbe() {
    setTimeout(function () {
        try {
            var writeEl = document.querySelector("#write");
            var pv = document.querySelector(".bt-split-preview");
            var container = document.getElementById("bt-split-container");
            var varVal = "?";
            if (container) {
                varVal = getComputedStyle(container).getPropertyValue("--bt-math-color") || "(空)";
            }
            var items = [];
            var els = document.querySelectorAll("mjx-container");
            var n = Math.min(els.length, 8);
            for (var i = 0; i < n; i++) {
                var el = els[i];
                var svg = el.querySelector("svg");
                var fill = "?";
                if (svg) {
                    var p = svg.querySelector("path[data-c]") || svg.querySelector("path");
                    if (p) fill = p.getAttribute("fill") || "(无fill属性)";
                    else fill = "(无path)";
                }
                var tag = el.closest(".bt-split-preview") ? "预览" : "编辑器";
                items.push(tag + "[color=" + getComputedStyle(el).color + " fill=" + fill + "]");
            }
            logger.log("[公式] 变量--bt-math-color=" + varVal +
                " | #write color=" + (writeEl ? getComputedStyle(writeEl).color : "?") +
                " | 预览容器 color=" + (pv ? getComputedStyle(pv).color : "?") +
                " | 公式" + els.length + "个: " + items.join("  "));
        } catch (e) { logger.log("[公式] 诊断错误: " + e.message); }
    }, 1500);
}

/* =====================================================================
 * v0.12 — 公式状态诊断: 文件打开后 dump 公式块 class/是否渲染/光标
 * 定位"获取焦点后块级公式显示语法" (编辑态 md-focus vs MathJax 未渲染)
 * ===================================================================== */
function installMathStateProbe() {
    window.BetterTypora.onFileEvent("opened", function () {
        setTimeout(function () {
            try {
                var els = document.querySelectorAll("#write .md-math-block");
                var parts = [];
                for (var i = 0; i < els.length && i < 4; i++) {
                    var el = els[i];
                    parts.push("cls[" + (el.className || "").replace("md-math-block", "") + "]" +
                        " svg=" + !!el.querySelector("svg") +
                        " cid=" + (el.getAttribute("cid") || "?") +
                        " txt=" + el.textContent.replace(/\s+/g, " ").slice(0, 24));
                }
                var sel = null;
                try {
                    var s = window.getSelection();
                    if (s.rangeCount) {
                        var n = s.getRangeAt(0).startContainer;
                        sel = (n.nodeType === 3 ? "TEXT@" +
                            (n.parentElement ? n.parentElement.className || n.parentElement.tagName : "?")
                            : (n.tagName || "?") + "." + (n.className || ""));
                    }
                } catch (e) {}
                // MathJax wrapper 渲染条件 (toHTML 公式分支):
                // cache[text] 命中 / mathCount<8 / !autoNumberingForMath / isMathJaxReady()
                var mbState = "?";
                try {
                    var mb = File.editor.mathBlock;
                    if (mb) {
                        mbState = "ready=" + (typeof mb.isMathJaxReady === "function" ? mb.isMathJaxReady() : "无函数") +
                            " autoNum=" + File.option.autoNumberingForMath +
                            " cacheN=" + Object.keys(mb.cache || {}).length +
                            " MathJaxGlobal=" + (window.MathJax ? "存在" : "无");
                    } else mbState = "mathBlock 不存在";
                } catch (e) { mbState = "错误: " + e.message; }
                logger.log("[公式态] 块数=" + els.length + " | " + parts.join("  ") +
                    " | active=" + (document.activeElement ?
                        document.activeElement.tagName + "." + (document.activeElement.className || "") : "?") +
                    " | 光标=" + sel +
                    " | mathBlock: " + mbState);
            } catch (e) { logger.log("[公式态] 错误: " + e.message); }
        }, 2000);
    });
}

/* =====================================================================
 * v0.14 — 表格样式对比: 编辑器 vs 预览 (claude 主题表格未正确渲染)
 * ===================================================================== */
function installTableProbe() {
    setTimeout(function () {
        try {
            function dump(el, tag) {
                if (!el) { logger.log("[表格] " + tag + " 不存在"); return; }
                var cs = getComputedStyle(el);
                logger.log("[表格] " + tag +
                    " | display=" + cs.display +
                    " | collapse=" + cs.borderCollapse +
                    " | border=" + cs.borderTopWidth + "/" + cs.borderBottomWidth + " " + cs.borderBottomStyle + " " + cs.borderBottomColor +
                    " | width=" + cs.width + " | margin=" + cs.marginTop + "/" + cs.marginBottom);
            }
            var et = document.querySelector("#write table");
            var pt = document.querySelector(".bt-write-clone table");
            dump(et, "编辑器table");
            dump(pt, "预览table");
            var etc = et ? getComputedStyle(et.querySelector("td") || et) : null;
            var ptc = pt ? getComputedStyle(pt.querySelector("td") || pt) : null;
            if (etc && ptc) {
                logger.log("[表格] 编辑器td: " + etc.borderBottomWidth + " " + etc.borderBottomStyle + " " + etc.borderBottomColor +
                    " | pad=" + etc.paddingTop + "/" + etc.paddingRight +
                    " | 预览td: " + ptc.borderBottomWidth + " " + ptc.borderBottomStyle + " " + ptc.borderBottomColor +
                    " | pad=" + ptc.paddingTop + "/" + ptc.paddingRight);
            }
            // 注入规则里表格相关条数
            var styleEl = document.getElementById("bt-preview-theme");
            var n = 0;
            var tdRules = [];
            if (styleEl) {
                var txt = styleEl.textContent || "";
                n = (txt.match(/bt-write-clone[^{]*table/g) || []).length;
                tdRules = txt.match(/[^{}]*bt-write-clone[^{]*(?:th|td)[^{}]*\{[^}]*\}/g) || [];
            }
            logger.log("[表格] 注入规则含 table 选择器: " + n + " 条, 含 th/td: " + tdRules.length + " 条");
            if (tdRules.length) {
                logger.log("[表格] 注入th/td规则样例: " + tdRules.slice(0, 2).join(" || ").slice(0, 600));
            }
        } catch (e) { logger.log("[表格] 错误: " + e.message); }
    }, 2000);
}

exports.onLoad = function () {
    api.registerCommand("trace", run, "滚动恢复链路追踪");
    installLayoutProbe();
    installScrollbarProbe();
    installMathColorProbe();
    installMathStateProbe();
    installTableProbe();
    logger.log("split-debug v0.14 已加载: trace + 布局 + 滚动条 + 公式 + 表格");
};
