/**
 * Split View — 左右分屏插件 v5 (Tabs 协作版)
 * ======================================
 * 架构 (方案 B: 标签系统唯一 = tabs 插件, split-view 不建自己的标签条):
 *   - 左栏 = Typora 编辑器 + tabs 标签栏 (分屏时标签栏 CSS 浮动到左栏
 *     顶部, 编辑器贴片从标签栏下方开始)
 *   - 右栏 = 接收栏: 右标签栈 + marked 预览, 可接管编辑器
 *   - "发送到右栏" (tabs 标签右键菜单): tabs 插件把该标签加入排除集
 *     (标签栏不再显示它), 右栏加入 + 编辑器切右栏; 左栏显示"邻近标签"
 *     的预览。发送回左栏/关闭右标签 → 移出排除集, 标签恢复
 *   - 联动: 活动栏=右时, 左栏标签切换 (opened 且不在右栈) → 编辑器
 *     自动回左栏
 *   - 渲染: BetterTypora.markdown (Typora 原生解析器 + CodeMirror 高亮)
 *
 * 命令: split-view:toggle / split-view:send-file (tabs 菜单调用)
 */
var BetterTypora = require("bettertypora:api");
var api = BetterTypora.api;
var logger = BetterTypora.logger;
var fs = require("fs");
var path = require("path");
var renderer = require("./renderer");

var escapeHtml = function (s) {
    return String(s == null ? "" : s)
        .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
};

/* ------------------------------------------------------------------ */
/* 状态                                                                 */
/* ------------------------------------------------------------------ */

var _active = false;
var _activeSide = "left";
var _pendingSide = null;       // 挂起迁移: 等 opened 确认目标文件加载完成
var _leftPreviewPath = null;   // 左栏预览文件 (活动栏=右时渲染; 发送时=邻近标签)
var _rightTabs = [];           // 右栏标签栈 [{path, name}]
var _rightActive = -1;
var _closedStack = [];         // 右栏最近关闭 (重新打开)
var MAX_CLOSED = 15;
var _editorEl = null;          // writingArea 父容器 (贴片目标)
var _tabBarEl = null;          // #typora-tab-bar (分屏时浮动到左栏顶部)
var _els = {};
var _sidebarRight = 0;
var _footerH = 0;            // Typora 底部 footer 高度 (容器让位, 避免盖住)
var _lastContW = 0;          // 容器宽度快照 (变化检测)
var _layoutTimer = null;
var _handlers = {};
var _ctxMenu = null;
var _ctxTargetIdx = -1;
var _previewThemeStyle = null;  // 注入的主题预览样式元素
var _themeUnsub = null;         // theme.onChange 解绑

/* ------------------------------------------------------------------ */
/* tabs 插件协作 (命令通道)                                               */
/* ------------------------------------------------------------------ */

function tabsCmd(cmd) {
    try {
        var args = Array.prototype.slice.call(arguments, 1);
        return window.BetterTypora.commands.execute("tabs:" + cmd, args[0], args[1]);
    } catch (e) {
        return null;
    }
}

/* ------------------------------------------------------------------ */
/* DOM 构建/销毁                                                        */
/* ------------------------------------------------------------------ */

function buildDom() {
    var c = document.createElement("div");
    c.id = "bt-split-container";
    c.innerHTML =
        '<div class="bt-split-left" id="bt-split-left">' +
        '  <div class="bt-split-content bt-split-preview" id="bt-split-left-content"></div>' +
        "</div>" +
        '<div class="bt-split-divider" id="bt-split-divider"></div>' +
        '<div class="bt-split-right" id="bt-split-right">' +
        '  <div class="bt-split-tabs" id="bt-split-right-tabs"></div>' +
        '  <div class="bt-split-content bt-split-preview" id="bt-split-right-content"></div>' +
        "</div>";
    document.body.appendChild(c);

    _els.container = c;
    _els.left = document.getElementById("bt-split-left");
    _els.divider = document.getElementById("bt-split-divider");
    _els.right = document.getElementById("bt-split-right");
    _els.tabs = document.getElementById("bt-split-right-tabs");
    _els.leftContent = document.getElementById("bt-split-left-content");
    _els.rightContent = document.getElementById("bt-split-right-content");
}

function destroyDom() {
    if (_els.container && _els.container.parentNode) {
        _els.container.parentNode.removeChild(_els.container);
    }
    _els = {};
}

/* ------------------------------------------------------------------ */
/* 布局                                                                 */
/* ------------------------------------------------------------------ */

/**
 * 侧边栏右缘 (布局值)。
 * Typora 原生机制 (frame.js + window.css 分析):
 *   - 展开: #typora-sidebar 加 "open" class; 收起: 移除 "open" class
 *   - 宽度: JS 设置 --sidebar-width (如 192px), 动画 = left + transition .3s
 * 测量: open class 在动画第一帧即切换 → 立即返回目标值。
 * 宽度优先级: CSS 变量 → 缓存 (首次实测) — showSidebar 加 class 后
 * 变量可能稍后才设置, 依赖变量会让内容让位延后 ("不跟手")。
 */
var _sidebarW = 0;   // 侧边栏宽度缓存 (变量未就绪时兜底)

function getSidebarRight() {
    var sidebar = document.getElementById("typora-sidebar");
    if (!sidebar) return 0;
    var cs = getComputedStyle(sidebar);
    if (cs.display === "none") return 0;
    if (!sidebar.classList.contains("open")) return 0;   // 收起 (含动画开始瞬间)

    var w = parseFloat(getComputedStyle(document.documentElement)
        .getPropertyValue("--sidebar-width"));
    if (w > 0) {
        _sidebarW = w;
        return w;
    }
    if (_sidebarW > 0) return _sidebarW;                 // 变量未就绪 → 缓存
    var rw = sidebar.getBoundingClientRect().width;      // 首次实测兜底
    if (rw > 0) _sidebarW = rw;
    return rw > 0 ? rw : 0;
}

function measureLayout() {
    _sidebarRight = getSidebarRight();
    // footer 让位: 容器 bottom 止于 footer 上方, 否则 fixed 容器会盖住它
    var footerEl = document.querySelector(".ty-footer");
    _footerH = footerEl ? footerEl.offsetHeight : 0;
    // 容器全宽 (右栏滚动条贴窗口右缘; 内容右缘留白由 #write padding 提供)
    _els.container.style.left = _sidebarRight + "px";
    _els.container.style.width = Math.max(0, window.innerWidth - _sidebarRight) + "px";
    _els.container.style.bottom = _footerH + "px";
}

/** 活动栏内容区矩形 (视口坐标) */
function getActivePaneRect() {
    if (_activeSide === "left") {
        var tabH = _tabBarEl ? _tabBarEl.offsetHeight : 0;
        return {
            left: _sidebarRight,
            top: tabH,
            width: _els.left.offsetWidth,
            height: Math.max(0, window.innerHeight - tabH - _footerH)
        };
    }
    return _els.rightContent.getBoundingClientRect();
}

function syncEditor() {
    if (!_editorEl || !_active) return;
    var r = getActivePaneRect();
    _editorEl.style.setProperty("--bt-editor-top", r.top + "px");
    _editorEl.style.setProperty("--bt-editor-left", r.left + "px");
    _editorEl.style.setProperty("--bt-editor-width", r.width + "px");
    _editorEl.style.setProperty("--bt-editor-height", r.height + "px");
    // 浮动标签栏 (左栏顶部)
    if (_tabBarEl) {
        _tabBarEl.style.setProperty("--bt-tabbar-left", _sidebarRight + "px");
        _tabBarEl.style.setProperty("--bt-tabbar-width", _els.left.offsetWidth + "px");
        // 左栏容器让位高度 = 标签栏实测高度 (与贴片 top=tabH 对齐)
        _els.left.style.setProperty("--bt-tabbar-h", _tabBarEl.offsetHeight + "px");
    }
}

function onLayoutTick() {
    if (!_active) return;
    var right = getSidebarRight();
    var footerEl = document.querySelector(".ty-footer");
    var fh = footerEl ? footerEl.offsetHeight : 0;
    // 容器宽度变化检测 (窗口 resize / 自身宽度调整时贴片需同步)
    var contW = _els.container.offsetWidth;
    var contChanged = contW && Math.abs(contW - _lastContW) > 2;
    if (Math.abs(right - _sidebarRight) > 2 || Math.abs(fh - _footerH) > 2 || contChanged) {
        _lastContW = contW;
        measureLayout();
        syncEditor();
    }
    // 编辑器滚动持续恢复已移除 (滚动同步方案放弃)

    syncPreviewSbw();
    updateDirty();
}

/** dirty 轮询: 当前文件被编辑时右栏对应标签显示脏点 */
function updateDirty() {
    var cur = BetterTypora.getCurrentFile();
    var dirty = cur ? !!BetterTypora.isDocumentEdited() : false;
    var chips = _els.tabs.querySelectorAll(".typora-tab-chip");
    for (var i = 0; i < chips.length; i++) {
        var idx = parseInt(chips[i].getAttribute("data-idx"), 10);
        var t = _rightTabs[idx];
        if (t && t.path === cur && dirty) chips[i].classList.add("dirty");
        else chips[i].classList.remove("dirty");
    }
}

/* ------------------------------------------------------------------ */
/* 右栏标签栈                                                           */
/* 条目模型: {type:"file", path, name} | {type:"graph"} (知识图谱)       */
/* 所有"激活条目内容应用"走 applyRightPane — 文件 → 预览/编辑器,          */
/* 图谱 → 图谱面板; 变更后统一调用, 避免各处手写 openFile/syncPanes 分支   */
/* ------------------------------------------------------------------ */

function isGraphTab(tab) {
    return !!(tab && tab.type === "graph");
}

/** 当前激活的右栏条目 (无则 null) */
function activeRightTab() {
    return _rightActive >= 0 ? _rightTabs[_rightActive] : null;
}

/** 应用右栏当前激活条目到对应面板 (变更后统一入口) */
function applyRightPane() {
    var tab = activeRightTab();
    if (!tab) {
        syncPanes();
        return;
    }
    if (isGraphTab(tab)) {
        mountGraphPane();   // 图谱面板 (graph-view 嵌入, 第二阶段)
        return;
    }
    if (_activeSide === "right") {
        if (tab.path !== BetterTypora.getCurrentFile()) BetterTypora.openFile(tab.path);
    } else {
        syncPanes();
    }
}

function findRightTab(filePath) {
    for (var i = 0; i < _rightTabs.length; i++) {
        var t = _rightTabs[i];
        if (!isGraphTab(t) && t.path === filePath) return i;
    }
    return -1;
}

function addRightTab(filePath) {
    var idx = findRightTab(filePath);
    if (idx >= 0) {
        _rightActive = idx;
        renderRightTabs();
        return;
    }
    _rightTabs.push({ type: "file", path: filePath, name: path.basename(filePath) });
    _rightActive = _rightTabs.length - 1;
    renderRightTabs();
}

function selectRightTab(idx) {
    if (idx < 0 || idx >= _rightTabs.length) return;
    _rightActive = idx;
    renderRightTabs();
    applyRightPane();
}

function adjustRightActive(idx) {
    if (idx < _rightActive) _rightActive--;
    else if (idx === _rightActive) {
        _rightActive = _rightTabs.length ? Math.min(idx, _rightTabs.length - 1) : -1;
    }
}

/** 文件不再被右栈持有 → 通知 tabs 移出排除集 */
function maybeUnexclude(filePath) {
    if (filePath && findRightTab(filePath) < 0) {
        tabsCmd("set-excluded", filePath, false);
    }
}

function closeRightTab(idx) {
    if (idx < 0 || idx >= _rightTabs.length) return;
    var closed = _rightTabs[idx];
    _rightTabs.splice(idx, 1);
    if (!isGraphTab(closed)) {
        _closedStack.push(closed.path);
        if (_closedStack.length > MAX_CLOSED) _closedStack.shift();
    }
    adjustRightActive(idx);
    renderRightTabs();
    if (!isGraphTab(closed)) maybeUnexclude(closed.path);

    afterRightTabsChanged();
}

/** 右栈变化后: 空 → 自动关闭分屏; 否则应用激活条目 */
function afterRightTabsChanged() {
    if (_rightTabs.length === 0) {
        // 右栏没有任何标签 → 自动关闭分屏
        disable();
        return;
    }
    applyRightPane();
}

function renderRightTabs() {
    _els.tabs.innerHTML = "";
    for (var i = 0; i < _rightTabs.length; i++) {
        (function (idx) {
            var t = _rightTabs[idx];
            var chip = document.createElement("div");
            chip.className = "typora-tab-chip" + (idx === _rightActive ? " active" : "");
            chip.setAttribute("data-idx", idx);
            var label = document.createElement("span");
            label.className = "typora-tab-label";
            label.textContent = t.name;
            var closeBtn = document.createElement("span");
            closeBtn.className = "typora-tab-close";
            closeBtn.textContent = "×";
            chip.appendChild(label);
            chip.appendChild(closeBtn);

            chip.addEventListener("click", function (ev) {
                ev.stopPropagation();
                if (ev.target === closeBtn) closeRightTab(idx);
                else selectRightTab(idx);
            });
            chip.addEventListener("contextmenu", function (ev) {
                ev.preventDefault();
                ev.stopPropagation();
                openCtxMenu(ev.clientX, ev.clientY, idx);
            });
            _els.tabs.appendChild(chip);
        })(i);
    }
}

/* ------------------------------------------------------------------ */
/* 右标签右键菜单 (与 tabs 菜单同构, 操作右栈)                              */
/* ------------------------------------------------------------------ */

var CTX_ITEMS = [
    { fn: "send-left", label: "发送到左栏" },
    { sep: true },
    { fn: "close", label: "关闭此标签" },
    { sep: true },
    { fn: "others", label: "关闭其他标签" },
    { fn: "left", label: "关闭左侧标签" },
    { fn: "right", label: "关闭右侧标签" },
    { sep: true },
    { fn: "all", label: "关闭全部标签" },
    { fn: "reopen", label: "重新打开已关闭标签" }
];

function openCtxMenu(x, y, idx) {
    closeCtxMenu();
    _ctxTargetIdx = idx;

    var menu = document.createElement("div");
    menu.className = "typora-tab-menu";
    menu.setAttribute("data-plugin-id", "split-view");
    for (var i = 0; i < CTX_ITEMS.length; i++) {
        var it = CTX_ITEMS[i];
        if (it.sep) {
            var sep = document.createElement("div");
            sep.className = "typora-tab-menu-sep";
            menu.appendChild(sep);
            continue;
        }
        var item = document.createElement("div");
        item.className = "typora-tab-menu-item";
        item.setAttribute("data-action", it.fn);
        item.textContent = it.label;
        (function (fn) {
            item.addEventListener("mousedown", function (e) { e.preventDefault(); });
            item.addEventListener("click", function (e) {
                e.stopPropagation();
                ctxExec(fn);
            });
        })(it.fn);
        menu.appendChild(item);
    }
    document.body.appendChild(menu);
    _ctxMenu = menu;

    var n = _rightTabs.length;
    var setState = function (action, disabled) {
        var el = menu.querySelector('[data-action="' + action + '"]');
        if (el) el.classList.toggle("disabled", disabled);
    };
    setState("others", n < 2);
    setState("left", idx <= 0);
    setState("right", idx < 0 || idx >= n - 1);
    setState("all", n < 2);
    setState("reopen", _closedStack.length === 0);

    menu.style.display = "block";
    var w = menu.offsetWidth || 180;
    var h = menu.offsetHeight || 240;
    var left = x, top = y;
    if (left + w > window.innerWidth - 8) left = x - w - 4;
    if (top + h > window.innerHeight - 8) top = y - h - 4;
    menu.style.left = Math.max(4, left) + "px";
    menu.style.top = Math.max(4, top) + "px";
    requestAnimationFrame(function () { menu.classList.add("open"); });

    setTimeout(function () {
        document.addEventListener("mousedown", _ctxDismissHandler, true);
        document.addEventListener("keydown", _ctxEscHandler, true);
    }, 0);
}

function _ctxEscHandler(e) {
    if (e.key === "Escape") closeCtxMenu();
}

/** 点击菜单外部关闭 (菜单内部 mousedown 不清状态, 否则动作全部失效) */
function _ctxDismissHandler(e) {
    if (_ctxMenu && !_ctxMenu.contains(e.target)) closeCtxMenu();
}

function closeCtxMenu() {
    if (_ctxMenu) {
        _ctxMenu.classList.remove("open");
        if (_ctxMenu.parentNode) _ctxMenu.parentNode.removeChild(_ctxMenu);
        _ctxMenu = null;
    }
    _ctxTargetIdx = -1;
    document.removeEventListener("mousedown", _ctxDismissHandler, true);
    document.removeEventListener("keydown", _ctxEscHandler, true);
}

function ctxExec(fn) {
    var idx = _ctxTargetIdx;
    closeCtxMenu();
    switch (fn) {
        case "send-left":
            sendToLeft(idx);
            break;
        case "close":
            closeRightTab(idx);
            break;
        case "others":
            closeRightOthers(idx);
            break;
        case "left":
            closeRightLeftOf(idx);
            break;
        case "right":
            closeRightRightOf(idx);
            break;
        case "all":
            closeAllRight();
            break;
        case "reopen":
            reopenRightClosed();
            break;
    }
}

function closeRightOthers(idx) {
    _rightTabs = [_rightTabs[idx]];
    _rightActive = 0;
    renderRightTabs();
    afterRightTabsChanged();
}

function closeRightLeftOf(idx) {
    _rightTabs.splice(0, idx);
    _rightActive = Math.max(0, _rightActive - idx);
    renderRightTabs();
    afterRightTabsChanged();
}

function closeRightRightOf(idx) {
    _rightTabs.splice(idx + 1);
    if (_rightActive > idx) _rightActive = idx;
    renderRightTabs();
    afterRightTabsChanged();
}

function closeAllRight() {
    _rightTabs = [];
    _rightActive = -1;
    renderRightTabs();
    afterRightTabsChanged();
}

function reopenRightClosed() {
    var fp = _closedStack.pop();
    if (fp) {
        addRightTab(fp);
        tabsCmd("set-excluded", fp, true);
        afterRightTabsChanged();
    }
}

/* ------------------------------------------------------------------ */
/* 预览主题样式注入 — 预览与编辑器共享主题语法样式                           */
/* ------------------------------------------------------------------ */

// #write 选择器精确匹配: 后跟选择器边界 (类/伪类/属性/空格/组合器/逗号/结束),
// 避免子串误匹配 (#write-x、#writeArea 等)
var WRITE_SEL = /#write(?=[.#:\[\s>~,+]|$)/;
var WRITE_SEL_G = /#write(?=[.#:\[\s>~,+]|$)/g;

/** 重写含 #write 的选择器 → 内容层版。预览内容包在 .bt-write-clone 内,
 * 结构镜像编辑器 #write (子组合器直接对应) */
function rewriteSelector(sel) {
    return sel
        .replace(/#write\s*>/g, ".bt-write-clone >")
        .replace(WRITE_SEL_G, ".bt-write-clone");
}

/**
 * 遍历样式表, 把含 #write 的选择器复制一份 .bt-write-clone 版
 * (如 `#write h1` → 追加 `.bt-write-clone h1`), 声明原样注入 —
 * 内容层 (镜像 #write) 与滚动容器分离, 布局属性 (padding/margin/
 * max-width/display:flex 等) 作用于内容层不破坏栏布局, 无需白名单
 * 过滤; 装饰性伪元素 (语言标签/YAML 标签/任务勾号) 依赖的 position
 * 保留, 正常渲染。极小黑名单: 只挡 z-index (防主题层级干扰分屏)。
 * 主题切换时 (theme.onChange) 重新注入。
 */
function installPreviewTheme() {
    removePreviewTheme();
    try {
        function rewriteRules(rules, out) {
            for (var i = 0; i < rules.length; i++) {
                var r = rules[i];
                try {
                    if (r.selectorText && r.style && WRITE_SEL.test(r.selectorText)) {
                        // 只挡 z-index — 主题给 #write 设层级会干扰分屏布局
                        var hasZ = false;
                        for (var zi = 0; zi < r.style.length; zi++) {
                            if (r.style[zi] === "z-index") { hasZ = true; break; }
                        }
                        if (hasZ) continue;
                        var css = "";
                        for (var ci = 0; ci < r.style.length; ci++) {
                            css += r.style[ci] + ":" +
                                r.style.getPropertyValue(r.style[ci]) + ";";
                        }
                        if (!css) continue;
                        var parts = r.selectorText.split(",");
                        var extra = [];
                        for (var j = 0; j < parts.length; j++) {
                            if (WRITE_SEL.test(parts[j])) {
                                extra.push(rewriteSelector(parts[j]));
                            }
                        }
                        if (extra.length) {
                            out.push(r.selectorText + ", " + extra.join(", ") +
                                " {" + css + "}");
                        }
                    } else if (r.cssRules && r.media) {
                        // @media: 递归处理内部规则。必须检查 r.media —
                        // @keyframes/@supports 也有 cssRules 但无 media
                        var inner = [];
                        rewriteRules(r.cssRules, inner);
                        if (inner.length) {
                            out.push("@media " + r.media.mediaText + " {\n" +
                                inner.join("\n") + "\n}");
                        }
                    } else if (r.styleSheet && r.styleSheet.cssRules) {
                        // @import 子样式表: 递归处理 (跨域子表由 try 跳过)
                        rewriteRules(r.styleSheet.cssRules, out);
                    }
                } catch (e) {
                    // 单条规则异常不中断整个样式表处理
                }
            }
        }

        var out = [];
        // 遍历所有样式表 (base.css 基础 + 当前主题, 按 DOM 顺序叠加 —
        // 与编辑器一致)。跨域 sheet (如 typora-bg://) cssRules 访问抛错,
        // 单独跳过
        var sheets = document.styleSheets;
        for (var si = 0; si < sheets.length; si++) {
            var sheet = sheets[si];
            if (!sheet) continue;
            if (sheet.ownerNode && sheet.ownerNode.id === "bt-preview-theme") continue;
            var rules = null;
            try {
                rules = sheet.cssRules;
            } catch (e) {
                continue;   // 跨域 sheet 跳过
            }
            if (!rules) continue;
            rewriteRules(rules, out);
        }
        if (!out.length) return;

        var style = document.createElement("style");
        style.id = "bt-preview-theme";
        style.textContent = out.join("\n");
        document.head.appendChild(style);
        _previewThemeStyle = style;
        logger.log("预览主题样式注入: " + out.length + " 条规则");
    } catch (e) {
        logger.log("预览主题注入失败: " + e.message);
    }
}

function removePreviewTheme() {
    if (_previewThemeStyle) {
        if (_previewThemeStyle.parentNode) {
            _previewThemeStyle.parentNode.removeChild(_previewThemeStyle);
        }
        _previewThemeStyle = null;
    }}

var _lastSbw = -1;

/** 滚动条占宽补偿: Typora 编辑器 #write 内容区宽 = 滚动容器 offsetWidth
 * - padding (滚动条不占写作区宽, 实测 #write clientW == content offsetW),
 * 预览滚动层 clientWidth 被滚动条占掉 → 内容层行宽窄一个滚动条宽。
 * 实测滚动层滚动条宽, 从内容层 (.bt-write-clone) padding-right 扣除,
 * 行宽与编辑器一致。padding 由主题注入 (#write 规则), 补偿仅扣差值 */
function syncPreviewSbw() {
    if (!_active) return;
    var list = [_els.leftContent, _els.rightContent];
    for (var i = 0; i < list.length; i++) {
        var el = list[i];                    // 外层滚动容器
        if (!el) continue;
        var sbw = el.offsetWidth - el.clientWidth;   // 滚动条占宽
        if (sbw < 0) sbw = 0;
        var inner = el.querySelector(".bt-write-clone");
        if (!inner) continue;
        if (inner.__btSbw === sbw) continue;  // 无变化跳过 (避免重排)
        inner.__btSbw = sbw;
        inner.style.paddingRight = "";        // 恢复主题 padding-right
        var pr = 0;
        try { pr = parseFloat(getComputedStyle(inner).paddingRight) || 0; } catch (e) {}
        inner.style.paddingRight = Math.max(0, pr - sbw) + "px";
    }
}

/* ------------------------------------------------------------------ */
/* 发送 (Tabs 协作)                                                     */
/* ------------------------------------------------------------------ */

/** tabs 右键菜单入口: 发送文件到右栏 (未开启时自动开启) */
function sendToRight(filePath) {
    if (!_active) {
        enable();
        if (!_active) return false;
    }
    if (!filePath) return false;

    if (findRightTab(filePath) < 0) {
        // 左栏预览 = 发送文件的邻近可见标签 (右优先, 无则左);
        // 同步左栏标签栏高亮 (纯视觉, 不切 Typora 当前文件 —
        // set-excluded 只在排除激活标签时自动激活邻近)
        try {
            var visible = tabsCmd("get-visible-paths") || [];
            var vi = visible.indexOf(filePath);
            var neighbor = visible[vi + 1] || visible[vi - 1] || null;
            if (neighbor && findRightTab(neighbor) < 0) {
                _leftPreviewPath = neighbor;
                try { tabsCmd("visual-activate", neighbor); } catch (e) {}
            }
        } catch (e) {}
        addRightTab(filePath);
        tabsCmd("set-excluded", filePath, true);
    }
    if (_activeSide === "right") {
        // 焦点已在右栏 (左栏是预览): setActiveSide 不会迁移 —
        // 应用右栏新激活条目 (编辑器打开), 左栏预览刷新为邻近标签
        applyRightPane();
        syncPanes();
    } else {
        setActiveSide("right");
    }
    return true;
}

/** 右标签右键: 发送到左栏 (移出排除集, 标签恢复, 编辑器回左栏) */
function sendToLeft(idx) {
    if (idx < 0 || idx >= _rightTabs.length) return;
    var tab = _rightTabs[idx];
    if (isGraphTab(tab)) return;   // 图谱面板不可发送到左栏
    var fp = tab.path;
    _rightTabs.splice(idx, 1);
    adjustRightActive(idx);
    renderRightTabs();
    tabsCmd("set-excluded", fp, false);
    _leftPreviewPath = fp;
    if (_rightTabs.length === 0) {
        // 右栏清空 → 自动关闭分屏
        disable();
        return;
    }
    if (_activeSide === "left") {
        // 焦点已在左栏 (右栏是预览): setActiveSide 不会迁移 —
        // 左栏编辑器打开发送的文件 (对称 sendToRight 的右栏分支),
        // 右栏预览刷新为邻近标签
        if (fp && fp !== BetterTypora.getCurrentFile()) BetterTypora.openFile(fp);
        syncPanes();
        // 左栏标签栏高亮同步 (发送文件已回标签栏; addOrActivate 已
        // 立即 render, 此处显式同步保证与左栏预览一致)
        try { tabsCmd("visual-activate", fp); } catch (e) {}
    } else {
        setActiveSide("left");
    }
}

/* ------------------------------------------------------------------ */
/* 预览渲染                                                             */
/* ------------------------------------------------------------------ */

/** 右栏图谱面板挂载 (graph-view 嵌入, 第二阶段实现) */
function mountGraphPane() {
    // TODO(第二阶段): 在右栏内容区挂载嵌入式知识图谱, 跟随当前文件
}

function renderPreviewInto(container, filePath) {
    if (!filePath) {
        container.innerHTML = '<div class="bt-split-empty">此栏暂无文件</div>';
        return;
    }
    try {
        var md = fs.readFileSync(filePath, "utf8");
        renderer.renderTo(container, md, filePath);
    } catch (e) {
        container.innerHTML = '<div class="bt-split-empty">读取失败: ' + escapeHtml(e.message) + "</div>";
    }
}

function syncPanes() {
    if (_activeSide === "left") {
        // 左栏被编辑器贴片覆盖; 右栏渲染预览
        _els.leftContent.innerHTML = "";
        var fp = _rightActive >= 0 ? _rightTabs[_rightActive].path : null;
        renderPreviewInto(_els.rightContent, fp);
        restorePreviewScroll(_els.rightContent, fp);
    } else {
        // 编辑器在右栏; 左栏渲染左预览 (邻近标签)
        renderPreviewInto(_els.leftContent, _leftPreviewPath);
        _els.rightContent.innerHTML = "";
        restorePreviewScroll(_els.leftContent, _leftPreviewPath);
        // 左栏标签栏高亮同步到预览文件 (纯视觉, 不切 Typora 当前文件)
        if (_leftPreviewPath) {
            try { tabsCmd("visual-activate", _leftPreviewPath); } catch (e) {}
        }
    }
}

/** 预览渲染后恢复该文件滚动位置 (简单重试防渲染时序) */
function restorePreviewScroll(container, filePath) {
    if (!container || !filePath || window.BetterTypora.scroll.get(filePath) === undefined) return;
    var v = window.BetterTypora.scroll.get(filePath);
    var tries = 0;
    (function retry() {
        if (!container) return;
        container.scrollTop = v;
        tries++;
        if (tries < 3) setTimeout(retry, 150);
    })();
}

/* ------------------------------------------------------------------ */
/* 活动栏切换                                                           */
/* ------------------------------------------------------------------ */

function doActivate(side) {
    _activeSide = side;
    // 活动栏切换: 贴片瞬移 (无过渡)
    syncEditor();
    syncPanes();
    afterActivate();
}

/** 活动栏切换后的统一收尾 (历史补丁归并):
 * 1. 标签栏高亮跟随编辑器当前文件 — 无 opened 事件的迁移路径
 *    (发送的是当前文件时 setActiveSide 不 openFile; 500ms 同路径
 *    opened 去重) 不会触发 tabs addOrActivate, 此处显式同步;
 *    右栏迁移时当前文件在排除集, visual-activate 无可见标签不生效
 * 2. 公式补渲染 — Typora 加载后的自动补渲染 renderUnder(document)
 *    会查询全文档公式块, 预览容器公式块 (被 syncPanes 清空/重建) 会
 *    触发 A 的 contains 检查失败 → 批量渲染中断 → 编辑器公式停在源码
 *    态。手动限定 #write 范围补渲染 (false = 只处理未渲染的公式块) */
function afterActivate() {
    try {
        var cur = BetterTypora.getCurrentFile();
        if (cur) tabsCmd("visual-activate", cur);
    } catch (e) {}
    setTimeout(function () {
        if (!_active) return;
        try {
            var mb = File.editor.mathBlock;
            var writeEl = document.querySelector("#write");
            if (mb && writeEl && typeof mb.renderUnder === "function") {
                mb.renderUnder(writeEl, false);
            }
        } catch (e) {}
    }, 100);
}

/**
 * 切换活动栏。目标文件 ≠ Typora 当前文件时先 openFile 并挂起,
 * 等 opened 事件确认加载完成再迁移 — 避免贴片带旧内容闪现。
 */
function setActiveSide(side) {
    if (!_active || side === _activeSide) return;
    if (side === "right" && _rightActive < 0) return;

    // 切换前记录"目标栏预览的可视位置" (跟预览位置语义: 编辑器切过去后
    // 从预览当前的位置进入, 无论预览滚没滚都以预览为准)
    if (side === "right" && _activeSide === "left" && _rightActive >= 0) {
        window.BetterTypora.scroll.record(_rightTabs[_rightActive].path, _els.rightContent.scrollTop || 0);
    } else if (side === "left" && _activeSide === "right" && _leftPreviewPath) {
        window.BetterTypora.scroll.record(_leftPreviewPath, _els.leftContent.scrollTop || 0);
    }

    // 离开前记录当前编辑文件滚动位置
    var curFile = BetterTypora.getCurrentFile();
    if (curFile && _editorEl) window.BetterTypora.scroll.record(curFile, _editorEl.scrollTop || 0);

    var target = side === "right" ? _rightTabs[_rightActive].path : _leftPreviewPath;
    var cur = BetterTypora.getCurrentFile();
    if (target && target !== cur) {
        _pendingSide = side;
        BetterTypora.openFile(target);
        return;
    }
    _pendingSide = null;
    doActivate(side);
}

/* ------------------------------------------------------------------ */
/* 命令                                                                 */
/* ------------------------------------------------------------------ */

function toggle() {
    if (_active) disable();
    else enable();
}

function enable() {
    if (_active) return;
    var wa = null;
    try {
        wa = File.editor.writingArea;
    } catch (e) {}
    if (!wa) {
        window.BetterTypora.toast("无法访问编辑器, 分屏不可用", 3000);
        return;
    }
    _editorEl = wa.parentElement;
    _tabBarEl = document.getElementById("typora-tab-bar");
    _leftPreviewPath = BetterTypora.getCurrentFile();
    _rightTabs = [];
    _rightActive = -1;
    _closedStack = [];

    // 标签栏浮动到左栏顶部 (不隐藏, 保留 tabs 插件全部能力)
    if (_tabBarEl) _tabBarEl.classList.add("bt-tabbar-floating");
    _editorEl.classList.add("bt-editor-fixed");

    buildDom();
    _active = true;
    _activeSide = "left";
    _pendingSide = null;

    measureLayout();
    syncEditor();
    syncPanes();
    renderRightTabs();
    window.BetterTypora.scroll.installAutoRestore();
    installPreviewTheme();
    _themeUnsub = window.BetterTypora.theme.onChange(function () {
        installPreviewTheme();
        // 公式 fill 固化渲染时的颜色, 主题切换后重渲染预览
        syncPanes();
    });
    bindEvents();

    _layoutTimer = setInterval(onLayoutTick, 150);
    logger.log("分屏已开启 (活动栏: 左)");
    window.BetterTypora.toast("分屏已开启 — 右键标签可发送到右栏", 2500);
}

function disable() {
    if (!_active) return;
    _active = false;
    _pendingSide = null;
    if (_layoutTimer) { clearInterval(_layoutTimer); _layoutTimer = null; }
    unbindEvents();
    closeCtxMenu();
    if (_editorEl) _editorEl.classList.remove("bt-editor-fixed");
    if (_tabBarEl) _tabBarEl.classList.remove("bt-tabbar-floating");
    // 恢复所有被排除的标签
    tabsCmd("clear-excluded");
    _editorEl = null;
    _tabBarEl = null;
    destroyDom();
    _rightTabs = [];
    _rightActive = -1;
    _closedStack = [];
    _leftPreviewPath = null;
    window.BetterTypora.scroll.clear();   // 清空记录, 避免分屏关闭后注入旧值
    removePreviewTheme();
    if (_themeUnsub) { _themeUnsub(); _themeUnsub = null; }
    logger.log("分屏已关闭");
    window.BetterTypora.toast("分屏已关闭", 2000);
}

/* ------------------------------------------------------------------ */
/* 事件                                                                 */
/* ------------------------------------------------------------------ */

function onFileOpened(data) {
    if (!_active) return;
    var fp = data && data.path;
    if (!fp) return;

    handlePendingMigration(fp);

    if (_activeSide === "left") {
        _leftPreviewPath = fp;
    } else {
        syncRightPaneOnFileOpened(fp);
    }

    // openFile 触发 tabs 插件 addOrActivate 激活被排除的发送文件
    // (不可见) — 覆盖左栏预览邻近标签的高亮; 打开完成后重新同步
    resyncTabHighlight();
}

/** 挂起迁移: 目标文件加载完成 → 迁移贴片。
 * 注意: 不能提前 return — 后面的左栏预览/高亮同步仍需执行
 * (曾导致带 scrollOffset 的 recoverPosOrScroll 从不执行) */
function handlePendingMigration(fp) {
    if (!_pendingSide) return;
    var targetSide = _pendingSide;
    var want = targetSide === "right"
        ? (_rightActive >= 0 ? _rightTabs[_rightActive].path : null)
        : _leftPreviewPath;
    if (want === fp) {
        _pendingSide = null;
        doActivate(targetSide);
    } else {
        _pendingSide = null;
    }
}

/** 焦点在右栏时文件打开后的右栏同步:
 * 右栈内 → 激活对应标签并同步预览; 右栈外 (左栏/外部切换) → 编辑器回左栏 */
function syncRightPaneOnFileOpened(fp) {
    var idx = findRightTab(fp);
    if (idx >= 0) {
        if (idx !== _rightActive) {
            _rightActive = idx;
            renderRightTabs();
            // 预览内容同步到新激活标签 — 否则预览内容与标签脱节
            // (预览还显示旧文件, 点击切换时编辑器加载新文件 → "跳顶部")
            syncPanes();
        }
    } else {
        // 左栏标签/外部切换 → 编辑器回左栏 (Typora 已切, 不重复 openFile)
        _leftPreviewPath = fp;
        doActivate("left");
    }
}

/** 延迟重同步左栏标签栏高亮 (openFile 会激活被排除的发送文件覆盖高亮) */
function resyncTabHighlight() {
    if (!_leftPreviewPath) return;
    setTimeout(function () {
        if (!_active || _activeSide !== "right") return;
        try { tabsCmd("visual-activate", _leftPreviewPath); } catch (e) {}
    }, 100);
}

/**
 * 窗口 resize (含 Typora 侧边栏动画第一帧的 resize 广播 —
 * frame.js listenCurrentTransition: transitionstart → dispatch resize)。
 * 侧边栏展开/收起时 open class 已切换, getSidebarRight 立即返回目标值,
 * 此处同步布局 — 无滞后无抽搐, 也不需要额外的 transitionrun 监听。
 */
function onWindowResize() {
    if (!_active) return;
    measureLayout();
    syncEditor();
}

function onClickContainer(e) {
    if (!_active) return;
    // 拦截所有链接: 本地 (data-bt-link) → 左栏打开;
    // 外链 (http/mailto/ftp) → 系统浏览器 (preventDefault 阻止应用内
    // 导航 — 否则 Electron 窗口直接导航到外部站点会闪退)
    var a = e.target.closest ? e.target.closest("a") : null;
    if (a) {
        e.preventDefault();
        e.stopPropagation();
        var link = a.getAttribute("data-bt-link");
        if (link) {
            openLinkTarget(link);
            return;
        }
        var href = a.getAttribute("href") || "";
        if (/^(https?:|mailto:|ftp:)/i.test(href)) {
            try {
                var shell = require("electron").shell;
                if (shell && typeof shell.openExternal === "function") {
                    shell.openExternal(href);
                }
            } catch (err) {}
            return;
        }
        if (href.charAt(0) === "#") {
            scrollToAnchor(a, href);
            return;
        }
        return;
    }
    // 点击预览空白 → 切换活动栏 (编辑器唤过来)
    var pv = e.target.closest ? e.target.closest(".bt-split-preview") : null;
    if (pv) {
        var side = pv === _els.leftContent ? "left" : "right";
        setActiveSide(side);
    }
}

/** 预览链接点击: data-bt-link 已是绝对路径 (renderTo 时解析) → 左栏打开 */
function openLinkTarget(target) {
    if (!target) return;
    _leftPreviewPath = target;
    setActiveSide("left");
    BetterTypora.openFile(target);
}

/** 锚点链接 (#标题): 在预览容器内按标题文本匹配并平滑滚动
 *  (Typora 解析器输出的标题无 id, 锚点按文本定位) */
function scrollToAnchor(a, href) {
    var container = a.closest ? a.closest(".bt-split-preview") : null;
    if (!container) return;
    var hash = href.slice(1);
    try {
        hash = decodeURIComponent(hash);
    } catch (e) {}
    var headers = container.querySelectorAll("h1, h2, h3, h4, h5, h6");
    for (var i = 0; i < headers.length; i++) {
        if ((headers[i].textContent || "").trim() === hash) {
            headers[i].scrollIntoView({ behavior: "smooth", block: "start" });
            return;
        }
    }
}

function onDividerMouseDown(e) {
    if (!_active) return;
    e.preventDefault();
    _els.divider.classList.add("dragging");
    var startX = e.clientX;
    var leftW = _els.left.offsetWidth;
    var totalW = _els.container.offsetWidth;
    var minW = 200;

    function onMove(ev) {
        var delta = ev.clientX - startX;
        var newLeft = Math.max(minW, Math.min(totalW - minW - 4, leftW + delta));
        // 像素宽度直接控制左栏 (内联 style 最高优先级, 不经 flex 算法)
        _els.left.style.width = newLeft + "px";
        syncEditor();
    }
    function onUp() {
        _els.divider.classList.remove("dragging");
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
    }
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
}

function bindEvents() {
    _handlers.onFileOpened = onFileOpened;
    _handlers.onWindowResize = onWindowResize;
    _handlers.onClickContainer = onClickContainer;
    _handlers.onDividerMouseDown = onDividerMouseDown;
    // 编辑器滚动实时记录 — 切换瞬间的采样可能已被 Typora 焦点逻辑重置为 0,
    // 滚动过程中的值才是真实位置 (recoverPosOrScroll 恢复用)
    _handlers.onEditorScroll = function () {
        if (!_active || !_editorEl) return;
        var cur = BetterTypora.getCurrentFile();
        if (cur) window.BetterTypora.scroll.record(cur, _editorEl.scrollTop || 0);
    };
    // 预览滚动实时记录 — 切到右栏打开的文件若在预览里滚过, 位置同样恢复
    _handlers.onLeftScroll = function () {
        if (_activeSide === "right" && _leftPreviewPath) {
            window.BetterTypora.scroll.record(_leftPreviewPath, _els.leftContent.scrollTop || 0);
        }
    };
    _handlers.onRightScroll = function () {
        if (_activeSide === "left" && _rightActive >= 0) {
            window.BetterTypora.scroll.record(_rightTabs[_rightActive].path, _els.rightContent.scrollTop || 0);
        }
    };
    window.addEventListener("resize", _handlers.onWindowResize);
    _els.container.addEventListener("click", _handlers.onClickContainer);
    _els.divider.addEventListener("mousedown", _handlers.onDividerMouseDown);
    _editorEl.addEventListener("scroll", _handlers.onEditorScroll, { passive: true });
    _els.leftContent.addEventListener("scroll", _handlers.onLeftScroll, { passive: true });
    _els.rightContent.addEventListener("scroll", _handlers.onRightScroll, { passive: true });
    window.BetterTypora.onFileEvent("opened", _handlers.onFileOpened);
}

function unbindEvents() {
    if (_handlers.onWindowResize) window.removeEventListener("resize", _handlers.onWindowResize);
    if (_els.container && _handlers.onClickContainer) {
        _els.container.removeEventListener("click", _handlers.onClickContainer);
    }
    if (_els.divider && _handlers.onDividerMouseDown) {
        _els.divider.removeEventListener("mousedown", _handlers.onDividerMouseDown);
    }
    if (_editorEl && _handlers.onEditorScroll) {
        _editorEl.removeEventListener("scroll", _handlers.onEditorScroll);
    }
    if (_els.leftContent && _handlers.onLeftScroll) {
        _els.leftContent.removeEventListener("scroll", _handlers.onLeftScroll);
    }
    if (_els.rightContent && _handlers.onRightScroll) {
        _els.rightContent.removeEventListener("scroll", _handlers.onRightScroll);
    }
    if (_handlers.onFileOpened) {
        window.BetterTypora.offFileEvent("opened", _handlers.onFileOpened);
    }
    _handlers = {};
}

/* ------------------------------------------------------------------ */
/* 生命周期                                                             */
/* ------------------------------------------------------------------ */

exports.onLoad = function () {
    api.registerCommand("toggle", toggle, "开关分屏");
    api.registerCommand("send-file", function (filePath) {
        sendToRight(filePath);
    }, "发送指定文件到右栏 (tabs 菜单调用)");
    logger.log("分屏插件已加载 (split-view:toggle 开启)");
};

exports.onUnload = function () {
    if (_active) disable();
    logger.log("分屏插件已卸载");
};
