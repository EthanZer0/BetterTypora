/**
 * word-translator — 划词翻译插件
 * ========================================
 * 类沙拉查词: 划选文字 → 悬浮按钮 → hover 展开翻译面板
 *
 * 设计原则:
 *  - UI 对齐 Typora 原生语言 (毛玻璃面板 + CSS 变量, 主题自适应, 见 README 附录 A)
 *  - 翻译走 Node https (无 CORS 限制), MyMemory 默认源 + Google 备选
 *  - 纯渲染进程, 无主进程依赖
 */
var BT = require("bettertypora:api");
var api = BT.api;
var logger = BT.logger;

var reqnode = window.reqnode;
var https = reqnode("https");

// ===================================================================
// 配置
// ===================================================================
var CONFIG = {
    targetLang: api.getSetting("targetLang", "zh-CN"),
    panelWidth: api.getSetting("panelWidth", 340),
    maxTextLength: api.getSetting("maxTextLength", 500),
};

// ===================================================================
// 工具
// ===================================================================
function normalizeText(t) {
    if (!t) return "";
    return String(t)
        .replace(/\xa0/g, " ")          // 不换行空格 → 普通空格 (代码块等)
        .replace(/[ \t]+/g, " ")        // 连续空白合并
        .replace(/^\s+|\s+$/g, "");     // 首尾修剪
}

function isOurUI(el) {
    while (el) {
        if (el.id === "wt-float-button" || el.id === "wt-panel") return true;
        el = el.parentNode;
    }
    return false;
}

/** 取选区包围盒 (视口坐标), 多行选区取整体 */
function getSelectionRect() {
    var sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return null;
    var range = sel.getRangeAt(0);
    var rects = range.getClientRects();
    if (!rects || rects.length === 0) {
        var r = range.getBoundingClientRect();
        if (!r || (!r.width && !r.height)) return null;
        return r;
    }
    // 合并所有片段 rect
    var left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
    for (var i = 0; i < rects.length; i++) {
        var r = rects[i];
        if (r.width === 0 && r.height === 0) continue;
        left = Math.min(left, r.left);
        top = Math.min(top, r.top);
        right = Math.max(right, r.right);
        bottom = Math.max(bottom, r.bottom);
    }
    if (!isFinite(left)) return null;
    return { left: left, top: top, right: right, bottom: bottom, width: right - left, height: bottom - top };
}

// ===================================================================
// 翻译源 (Node https, 无 CORS 限制)
// ===================================================================
function httpsGetJson(url, timeoutMs) {
    return new Promise(function (resolve, reject) {
        var req;
        try {
            req = https.get(url, { headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36" } }, function (res) {
                var data = "";
                res.on("data", function (c) { data += c; });
                res.on("end", function () {
                    try {
                        resolve({ status: res.statusCode, body: data });
                    } catch (e) {
                        reject(e);
                    }
                });
            });
            req.on("error", reject);
            req.setTimeout(timeoutMs || 8000, function () {
                req.destroy();
                reject(new Error("请求超时"));
            });
        } catch (e) {
            reject(e);
        }
    });
}

/** MyMemory 免费翻译 (无需 key, 单次约 500 字符) */
function translateMyMemory(text, targetLang) {
    var q = encodeURIComponent(text.slice(0, 500));
    var pair = "autodetect|" + encodeURIComponent(targetLang);
    var url = "https://api.mymemory.translated.net/get?q=" + q + "&langpair=" + pair;
    return httpsGetJson(url).then(function (res) {
        if (res.status !== 200) throw new Error("MyMemory HTTP " + res.status);
        var j = JSON.parse(res.body);
        if (!j.responseData || !j.responseData.translatedText) {
            throw new Error(j.responseStatus ? "MyMemory " + j.responseStatus : "MyMemory 无结果");
        }
        return { text: j.responseData.translatedText, source: "mymemory" };
    });
}

/** Google 免费端点 (备选) */
function translateGoogle(text, targetLang) {
    var q = encodeURIComponent(text);
    var url = "https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=" +
        encodeURIComponent(targetLang) + "&dt=t&q=" + q;
    return httpsGetJson(url).then(function (res) {
        if (res.status !== 200) throw new Error("Google HTTP " + res.status);
        var j = JSON.parse(res.body);
        var parts = [];
        if (j && j[0]) {
            for (var i = 0; i < j[0].length; i++) {
                if (j[0][i] && j[0][i][0]) parts.push(j[0][i][0]);
            }
        }
        if (!parts.length) throw new Error("Google 无结果");
        return { text: parts.join(""), source: "google" };
    });
}

/** 翻译入口: MyMemory 主源, 失败回退 Google */
function translateText(text, targetLang) {
    return translateMyMemory(text, targetLang).catch(function (e) {
        logger.warn("MyMemory 失败, 回退 Google:", e.message);
        return translateGoogle(text, targetLang);
    });
}

// ===================================================================
// 状态
// ===================================================================
var state = {
    selText: null,
    selRect: null,          // {left, top, right, bottom}
    buttonVisible: false,
    panelOpen: false,
    translated: null,       // {text, source}
    translatePromise: null,
    closeTimer: null,
    hideButtonTimer: null,
};

// ===================================================================
// DOM 构建
// ===================================================================
var buttonEl = null;
var panelEl = null;

function ensureUI() {
    if (buttonEl) return;
    // --- 悬浮按钮 ---
    buttonEl = document.createElement("div");
    buttonEl.id = "wt-float-button";
    buttonEl.innerHTML = '<span class="wt-btn-icon">译</span>';
    document.body.appendChild(buttonEl);

    // hover 展开面板
    buttonEl.addEventListener("mouseenter", function () {
        clearTimeout(state.closeTimer);
        clearTimeout(state.hideButtonTimer);
        openPanel();
    });
    buttonEl.addEventListener("mouseleave", function () {
        scheduleClose(150);
    });

    // --- 翻译面板 ---
    panelEl = document.createElement("div");
    panelEl.id = "wt-panel";
    panelEl.style.width = CONFIG.panelWidth + "px";
    panelEl.innerHTML =
        '<div class="wt-panel-head">' +
            '<span class="wt-source-text"></span>' +
            '<button class="wt-copy-btn" title="复制译文">复制</button>' +
        '</div>' +
        '<div class="wt-panel-body">' +
            '<div class="wt-original"></div>' +
            '<div class="wt-divider"></div>' +
            '<div class="wt-result"></div>' +
        '</div>' +
        '<div class="wt-panel-foot">' +
            '<span class="wt-lang-label"></span>' +
        '</div>';
    document.body.appendChild(panelEl);

    panelEl.addEventListener("mouseenter", function () {
        clearTimeout(state.closeTimer);
    });
    panelEl.addEventListener("mouseleave", function () {
        scheduleClose(150);
    });

    // 复制按钮
    panelEl.querySelector(".wt-copy-btn").addEventListener("click", function (e) {
        e.stopPropagation();
        copyResult();
    });
}

// ===================================================================
// 显示 / 隐藏
// ===================================================================
function showButton(rect, mouseX, mouseY) {
    ensureUI();
    state.selRect = rect;
    state.buttonVisible = true;
    state.translated = null;
    state.translatePromise = null;

    // 定位: 锚定鼠标释放点 (光标附近), 右下方偏移
    // 跨行选区时选区整体包围盒会被满行拉偏, 光标位置更符合直觉
    var x = mouseX + 10;
    var y = mouseY + 10;
    // 右侧空间不足 → 放左侧
    if (x + 34 > window.innerWidth) x = mouseX - 44;
    // 下方空间不足 → 放上方
    if (y + 34 > window.innerHeight) y = mouseY - 44;

    buttonEl.style.left = Math.round(x) + "px";
    buttonEl.style.top = Math.round(y) + "px";
    buttonEl.classList.add("wt-visible");

    // 按钮 hover 才展开面板, 面板暂关
    closePanel();
}

function hideButton() {
    state.buttonVisible = false;
    if (buttonEl) buttonEl.classList.remove("wt-visible");
    closePanel();
}

function scheduleClose(delay) {
    clearTimeout(state.closeTimer);
    state.closeTimer = setTimeout(function () {
        closePanel();
        // 面板关闭后按钮保留? 不 — 鼠标离开即整体隐藏
        if (buttonEl) buttonEl.classList.remove("wt-visible");
        state.buttonVisible = false;
    }, delay || 150);
}

function openPanel() {
    if (!state.buttonVisible || !state.selRect) return;
    ensureUI();
    state.panelOpen = true;

    // 面板定位: 浮钮下方 (视口坐标)
    var btnRect = buttonEl.getBoundingClientRect();
    var x = btnRect.left;
    var y = btnRect.bottom + 6;
    // 底部空间不足 → 面板放浮钮上方
    if (y + 300 > window.innerHeight) y = btnRect.top - 306;
    // 右侧溢出 → 左移
    if (x + CONFIG.panelWidth > window.innerWidth - 8) {
        x = window.innerWidth - CONFIG.panelWidth - 8;
    }
    if (x < 8) x = 8;

    panelEl.style.left = Math.round(x) + "px";
    panelEl.style.top = Math.round(y) + "px";

    // 面板内容: 原文 + 翻译
    var sourceEl = panelEl.querySelector(".wt-source-text");
    var originalEl = panelEl.querySelector(".wt-original");
    var resultEl = panelEl.querySelector(".wt-result");
    sourceEl.textContent = "";
    originalEl.textContent = state.selText;
    resultEl.className = "wt-result wt-loading";
    resultEl.innerHTML = '<div class="wt-loading-bar"></div><span>正在翻译…</span>';

    panelEl.classList.add("wt-visible");
    triggerTranslate();
}

function closePanel() {
    state.panelOpen = false;
    if (panelEl) panelEl.classList.remove("wt-visible");
}

function hideAll() {
    hideButton();
}

// ===================================================================
// 翻译调度
// ===================================================================
function triggerTranslate() {
    if (!state.selText) return;
    // 相同文本已翻译 → 直接复用
    if (state.translated && state.translated.query === state.selText) return;
    // 进行中 → 不重复
    if (state.translatePromise) return;

    var text = state.selText;
    state.translatePromise = translateText(text, CONFIG.targetLang).then(function (res) {
        res.query = text;
        state.translated = res;
        renderResult(res);
    }).catch(function (e) {
        logger.warn("翻译失败:", e.message);
        renderError(e.message);
    }).then(function () {
        state.translatePromise = null;
    });
}

function renderResult(res) {
    var panel = panelEl;
    if (!panel) return;
    var resultEl = panel.querySelector(".wt-result");
    resultEl.className = "wt-result";
    resultEl.textContent = res.text;
    var srcEl = panel.querySelector(".wt-source-text");
    srcEl.textContent = res.source === "google" ? "Google" : "MyMemory";
    var langEl = panel.querySelector(".wt-lang-label");
    langEl.textContent = "→ " + CONFIG.targetLang;
}

function renderError(msg) {
    var panel = panelEl;
    if (!panel) return;
    var resultEl = panel.querySelector(".wt-result");
    resultEl.className = "wt-result wt-error";
    resultEl.innerHTML = '<span class="wt-error-msg">翻译失败</span>' +
        '<button class="wt-retry-btn">重试</button>';
    resultEl.querySelector(".wt-retry-btn").addEventListener("click", function (e) {
        e.stopPropagation();
        state.translated = null;
        var originalEl = panel.querySelector(".wt-result");
        originalEl.className = "wt-result wt-loading";
        originalEl.innerHTML = '<div class="wt-loading-bar"></div><span>正在翻译…</span>';
        state.translatePromise = null;
        triggerTranslate();
    });
}

function copyResult() {
    if (!state.translated || !state.translated.text) return;
    try {
        if (reqnode && reqnode("electron") && reqnode("electron").clipboard) {
            reqnode("electron").clipboard.writeText(state.translated.text);
        } else if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(state.translated.text);
        } else {
            return;
        }
        var btn = panelEl.querySelector(".wt-copy-btn");
        if (btn) {
            btn.textContent = "已复制";
            setTimeout(function () { if (btn) btn.textContent = "复制"; }, 1200);
        }
    } catch (e) {
        logger.warn("复制失败:", e.message);
    }
}

// ===================================================================
// 事件
// ===================================================================
function onMouseUp(e) {
    // 点击插件 UI 内不处理
    if (isOurUI(e.target)) return;
    // 记录鼠标释放位置 (浮钮锚点), 等选区稳定再处理
    state.mouseX = e.clientX;
    state.mouseY = e.clientY;
    setTimeout(processSelection, 15);
}

function processSelection() {
    var sel = window.getSelection();
    var text = sel ? sel.toString() : "";
    text = normalizeText(text);
    if (!text || text.length < 2) {
        // 空选区 → 隐藏
        if (!state.panelOpen) hideAll();
        return;
    }
    if (text.length > CONFIG.maxTextLength) {
        text = text.slice(0, CONFIG.maxTextLength);
    }
    var rect = getSelectionRect();
    if (!rect) {
        hideAll();
        return;
    }
    state.selText = text;
    showButton(rect, state.mouseX, state.mouseY);
}

function onKeyDown(e) {
    if (e.key === "Escape" && (state.panelOpen || state.buttonVisible)) {
        hideAll();
        // 清除选区? 保留 (Typora 原生行为)
    }
}

function onDocMouseDown(e) {
    // 点击插件 UI 外部 → 关闭
    if (isOurUI(e.target)) return;
    if (state.panelOpen || state.buttonVisible) {
        hideAll();
    }
}

function onScroll(e) {
    // 翻译面板内部滚动 (译文过长) 不隐藏 — 仅文档滚动 (选区失效) 才隐藏
    if (e.target && isOurUI(e.target)) return;
    if (state.buttonVisible) {
        hideAll();
    }
}

function onSelectionChange() {
    // 选区被清空 (点击空白处) → 隐藏
    var sel = window.getSelection();
    if (!sel || !sel.toString()) {
        if (!state.panelOpen) hideAll();
    }
}

// ===================================================================
// 生命周期
// ===================================================================
module.exports = {
    enable: function () {
        document.addEventListener("mouseup", onMouseUp, true);
        document.addEventListener("keydown", onKeyDown, true);
        document.addEventListener("mousedown", onDocMouseDown, true);
        document.addEventListener("selectionchange", onSelectionChange);
        window.addEventListener("scroll", onScroll, true);
        logger.log("划词翻译已启用 ✅");
    },
    disable: function () {
        document.removeEventListener("mouseup", onMouseUp, true);
        document.removeEventListener("keydown", onKeyDown, true);
        document.removeEventListener("mousedown", onDocMouseDown, true);
        document.removeEventListener("selectionchange", onSelectionChange);
        window.removeEventListener("scroll", onScroll, true);
        if (buttonEl && buttonEl.parentNode) buttonEl.parentNode.removeChild(buttonEl);
        if (panelEl && panelEl.parentNode) panelEl.parentNode.removeChild(panelEl);
        buttonEl = null;
        panelEl = null;
        logger.log("划词翻译已停用");
    },
};
