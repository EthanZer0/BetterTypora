/**
 * Callouts — Obsidian 风格标注块
 * =================================
 * 语法:   > [!note] 可选标题
 *         > 内容
 *
 * 机制:   扫描 blockquote 首段, 正则匹配 [!type] 标记 →
 *         给 blockquote 加 class/属性 (类型色/折叠状态), 不改文本、
 *         不包裹元素 — 与 highlight-renderer 同原则, 不破坏 Typora
 *         渲染循环。MutationObserver 跟随 Typora DOM 重建。
 *
 * 交互:   点击标题行折叠/展开 (preventDefault 阻止光标进入标题行)。
 *
 * 主题:   类型色为深浅通用的中亮色 + 同色 10% 透明背景 (附录 A)。
 *
 * 已知限制: Typora 导出 HTML/PDF 时 callout 会渲染为普通引用块
 *          (标记文本可见), v1 不做导出增强。
 */

var BetterTypora = require("bettertypora:api");
var api = BetterTypora.api;
var logger = BetterTypora.logger;

// ===================================================================
// 匹配规则
// ===================================================================

var CALLOUT_RE = /^\[!(\w+)\]([+-]?)\s*(.*)$/;

/** 类型别名归一化 (Obsidian 兼容) */
var TYPE_ALIASES = {
    abstract: "abstract", summary: "abstract", tldr: "abstract",
    info: "info",
    tip: "tip", hint: "tip", important: "tip",
    success: "success", check: "success", done: "success",
    question: "question", help: "question", faq: "question",
    warning: "warning", caution: "warning", attention: "warning",
    failure: "failure", fail: "failure", missing: "failure",
    danger: "danger", error: "danger",
    bug: "bug",
    example: "example",
    quote: "quote", cite: "quote",
};

// ===================================================================
// 状态
// ===================================================================

var state = {
    observer: null,
    rafPending: false,
    unsubFileOpen: null,
    clickHandler: null,
};

// ===================================================================
// 扫描与修饰
// ===================================================================

var _rescanTimer = null;

/** 编辑态失焦后的延迟重扫 (防抖): 光标移出标题段落后完成标记隐藏 */
function scheduleRescan(delay) {
    if (_rescanTimer) return;
    _rescanTimer = setTimeout(function () {
        _rescanTimer = null;
        try { scan(); } catch (e) {}
    }, delay);
}

/**
 * 同步标题字号到 Typora 正文大小 (主题自适应):
 * 各主题 #write 字号不同 (14-18px), 硬编码会偏小/偏大。
 * 读取计算字号写入 CSS 变量, 标题/编辑态标记统一使用。
 */
function syncTitleSize() {
    try {
        var writeEl = document.getElementById("write");
        if (!writeEl) return;
        var fs = parseFloat(getComputedStyle(writeEl).fontSize);
        if (fs && fs > 0) {
            document.documentElement.style.setProperty("--bt-callout-title-size", fs + "px");
        }
    } catch (e) {}
}

function scan() {
    if (!document.getElementById("write")) return;
    syncTitleSize();
    var bqs = document.querySelectorAll("#write blockquote");
    for (var i = 0; i < bqs.length; i++) {
        decorate(bqs[i]);
    }
}

function decorate(bq) {
    var firstP = bq.querySelector("p");
    if (!firstP) return;

    // 首段文本: Typora 常把首段文本包在 span 中, 标记可能独立成 span
    var firstSpan = firstP.querySelector("span");
    var text = (
        firstSpan && firstSpan.textContent ? firstSpan.textContent : firstP.textContent || ""
    ).trim();
    var m = text.match(CALLOUT_RE);

    if (!m) {
        // 非 callout → 清理残留修饰 (用户把 [!note] 改回普通文本时)
        if (bq.classList.contains("bt-callout")) {
            bq.classList.remove("bt-callout");
            bq.removeAttribute("data-callout-type");
            bq.classList.remove("bt-callout-collapsed");
            if (firstP) firstP.classList.remove("bt-callout-title");
            if (firstSpan) {
                firstSpan.classList.remove("bt-callout-marker");
                firstSpan.classList.remove("bt-callout-marker-inline");
            }
        }
        return;
    }

    var type = TYPE_ALIASES[m[1].toLowerCase()] || m[1].toLowerCase();
    var collapsed = m[2] === "-";

    bq.classList.add("bt-callout");
    bq.setAttribute("data-callout-type", type);
    bq.classList.toggle("bt-callout-collapsed", collapsed);

    firstP.classList.add("bt-callout-title");

    // 编辑态保护: 光标在标题段落时 (Typora 的 md-focus class),
    // 跳过标记拆分/隐藏 — 否则输入中的每次字符变化都会触发
    // splitMarker 重组 DOM, 打断光标 (表现为"失去焦点")。
    // 同时主动移除已应用的隐藏 class (双保险, 不依赖 CSS 选择器),
    // 保证编辑时标记可见; 失焦后由 scheduleRescan 延迟重扫完成隐藏。
    var editing = firstP.classList && firstP.classList.contains("md-focus");
    if (editing) {
        if (firstSpan) {
            firstSpan.classList.remove("bt-callout-marker");
            firstSpan.classList.remove("bt-callout-marker-inline");
        }
        scheduleRescan(300);
        return;
    }

    // 标记文本隐藏 (obgnail 方案):
    // 注意: firstSpan 是 Typora 的 md-plain (标题行文字容器, 含标记+标题),
    // 绝不能给它加隐藏 class (会把整个标题行压小/隐藏) —
    // 隐藏 class 只能加在拆出的标记子 span 上 (splitMarker 内部处理)。
    if (firstSpan && firstSpan.textContent) {
        // 清理历史残留 (早期版本误加在 md-plain 上的隐藏 class)
        firstSpan.classList.remove("bt-callout-marker");
        firstSpan.classList.remove("bt-callout-marker-inline");

        var spanText = firstSpan.textContent.trim();
        if (spanText.match(/^\[!\w+\][+-]?$/)) {
            // 纯标记 (无标题): 标记就是整个 span → 直接隐藏
            firstSpan.classList.add("bt-callout-marker");
        } else if (spanText.match(/^\[!\w+\][+-]?/)) {
            // 标记+标题同 span → 拆分: splitMarker 给拆出的子 span 加 marker
            var markerMatch = spanText.match(/^\[!\w+\][+-]?/);
            if (markerMatch) splitMarker(firstSpan, markerMatch[0]);
            // 拆分失败 → 原样显示 (标记可见), 不做任何降级 (避免压小标题)
        }
    }
}

/**
 * 拆分标记: 把 span 文本开头的 [!type] 标记拆分为独立 span。
 * 用 splitText 拆文本节点 (不改字符流), 标记部分包进新 span 并加
 * bt-callout-marker class (由 CSS font-size:0 隐藏)。
 * 返回是否成功; 失败时调用方降级为 badge。
 */
function splitMarker(span, markerText) {
    try {
        var node = span.firstChild;
        if (!node || node.nodeType !== 3) return false;
        var text = node.textContent || "";
        if (text.indexOf(markerText) !== 0) return false;
        var tail = node.splitText(markerText.length);   // node 保留标记, tail 为标题
        var markerSpan = document.createElement("span");
        node.parentNode.insertBefore(markerSpan, tail);
        markerSpan.appendChild(node);
        markerSpan.className = "bt-callout-marker";
        return true;
    } catch (e) {
        return false;
    }
}

// ===================================================================
// 折叠交互 — 点击标题行切换
// ===================================================================

function onClick(e) {
    var t = e.target;
    if (!t || !t.closest) return;
    var bq = t.closest("blockquote.bt-callout");
    if (!bq) return;
    var firstP = bq.querySelector("p");
    if (!firstP || !firstP.contains(t)) return;   // 仅标题行响应
    e.preventDefault();                            // 阻止光标进入标题行
    e.stopPropagation();
    bq.classList.toggle("bt-callout-collapsed");
}

// ===================================================================
// 生命周期
// ===================================================================

function startObserver() {
    if (state.observer) return;
    state.observer = new MutationObserver(function () {
        if (state.rafPending) return;
        state.rafPending = true;
        requestAnimationFrame(function () {
            state.rafPending = false;
            try { scan(); } catch (e) {}
        });
    });
    var writeEl = document.getElementById("write");
    if (writeEl) {
        state.observer.observe(writeEl, {
            childList: true, subtree: true, characterData: true,
        });
    }
    // #write 可能晚出现, 延迟重试绑定
    if (!writeEl) {
        setTimeout(startObserver, 300);
        return;
    }
    logger.log("callouts 观察器已启动");
}

function stopObserver() {
    if (state.observer) {
        state.observer.disconnect();
        state.observer = null;
    }
}

module.exports = {
    onLoad: function () {
        logger.log("callouts 插件加载完成");
    },

    enable: function () {
        // 首次扫描 (等 Typora 初始渲染)
        setTimeout(function () { try { scan(); } catch (e) {} }, 500);
        startObserver();

        // 文件切换 → 重扫 (新文件 DOM 重建)
        if (!state.unsubFileOpen && BetterTypora.onFileOpen) {
            state.unsubFileOpen = BetterTypora.onFileOpen(function () {
                setTimeout(function () { try { scan(); } catch (e) {} }, 150);
            });
        }

        // 折叠交互
        if (!state.clickHandler) {
            state.clickHandler = onClick;
            document.addEventListener("click", state.clickHandler, true);
        }

        logger.log("callouts 插件已启用 ✅");
    },

    disable: function () {
        stopObserver();
        if (state.unsubFileOpen) {
            try { BetterTypora.offFileOpen(state.unsubFileOpen); } catch (e) {}
            state.unsubFileOpen = null;
        }
        if (state.clickHandler) {
            document.removeEventListener("click", state.clickHandler, true);
            state.clickHandler = null;
        }
        // 清理 DOM 修饰
        var bqs = document.querySelectorAll("blockquote.bt-callout");
        for (var i = 0; i < bqs.length; i++) {
            var bq = bqs[i];
            bq.classList.remove("bt-callout");
            bq.removeAttribute("data-callout-type");
            bq.classList.remove("bt-callout-collapsed");
            var fp = bq.querySelector("p");
            if (fp) fp.classList.remove("bt-callout-title");
            var fs = fp ? fp.querySelector("span") : null;
            if (fs) {
                fs.classList.remove("bt-callout-marker");
                fs.classList.remove("bt-callout-marker-inline");
            }
        }
        logger.log("callouts 插件已停用");
    },

    onUnload: function () {
        // disable 已清理
    },
};
