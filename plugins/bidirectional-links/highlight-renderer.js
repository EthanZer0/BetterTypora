/**
 * Bidirectional Links — Highlight Renderer
 * ========================================
 * 使用 CSS Custom Highlight API 在 paint 层渲染 [[wikilink]] 的视觉样式。
 *
 * 核心原则：不触碰 DOM 节点，不修改文本内容，不破坏 Typora 的渲染循环。
 * 仅在 paint 层叠加颜色/下划线/背景，与编辑完全解耦。
 *
 * 流程：
 *   Typora 渲染段落 → MutationObserver → rAF 节流 → TreeWalker →
 *   找到 [[...]] 文本 → 创建 Range → resolver 验证 → Highlight registry
 *    → resolved → 蓝色下划线
 *    → broken   → 灰色虚线/隐约提示
 */

(function () {
    "use strict";

    // ===================================================================
    // 构造函数
    // ===================================================================

    function HighlightRenderer(parser, resolver, linkIndex, fs, path) {
        this._parser = parser;
        this._resolver = resolver;
        this._linkIndex = linkIndex;
        this._fs = fs;          // 父目录兜底解析用
        this._path = path;

        this._observer = null;
        this._rafPending = false;
        this._processing = false;    // 防止自触发循环
        this._enabled = false;
        this._themeUnsub = null;     // BetterTypora.theme.onChange 解绑函数

        // hover 交互状态 (highlight 无法响应 :hover, 由 mousemove 命中检测驱动)
        this._linkRanges = [];       // [{ range, type: "resolved"|"broken", target }] 全部链接
        this._linkBrackets = [];     // 括号 Range 列表
        this._hovered = null;        // 当前悬停的链接条目
        this._hoverBound = false;
        this._hoverHandler = null;
        this._tooltipEl = null;      // 断链气泡

        // 主题感知（初始化时检测，暗色模式切换需重新设置）
        this._darkMode = false;
    }

    // ===================================================================
    // 启用/停用
    // ===================================================================

    HighlightRenderer.prototype.enable = function () {
        if (this._enabled) return;
        this._enabled = true;
        this._detectTheme();

        var writeEl = document.getElementById("write");
        if (!writeEl) {
            console.warn("[HighlightRenderer] #write 不存在，延迟启动");
            var self = this;
            setTimeout(function () { self.enable(); }, 500);
            return;
        }

        var self = this;
        // 初始渲染全量扫描
        this._scheduleScan(writeEl);

        // MutationObserver 监听增量变化
        this._observer = new MutationObserver(function (records) {
            self._onMutation(records);
        });
        this._observer.observe(writeEl, {
            childList: true,
            subtree: true,
            characterData: true,
        });

        // 主题切换 → 强制全量重扫。
        // 主题切换可能重建 #write DOM, 旧 Range 失效后高亮消失;
        // _darkObserver 只在"暗色状态变化"时重扫, 深↔深等切换会漏。
        // BetterTypora.theme.onChange 指纹事件覆盖任意主题切换。
        if (!this._themeUnsub && window.BetterTypora && window.BetterTypora.theme) {
            this._themeUnsub = window.BetterTypora.theme.onChange(function () {
                if (self._enabled) self._rescanAll();
            });
        }

        // hover 交互 (mousemove 命中检测)
        this._initHover();

        console.log("[HighlightRenderer] 已启用");
    };

    HighlightRenderer.prototype.disable = function () {
        this._enabled = false;
        if (this._observer) {
            this._observer.disconnect();
            this._observer = null;
        }
        // 解绑主题订阅
        if (this._themeUnsub) {
            try { this._themeUnsub(); } catch (e) {}
            this._themeUnsub = null;
        }
        // 清理 hover 监听/气泡 + hover 组注册
        this._disposeHover();
        try {
            if (CSS.highlights) {
                CSS.highlights.delete("wikilink-resolved-hover");
                CSS.highlights.delete("wikilink-broken-hover");
            }
        } catch (e) { /* ignore */ }

        // 清除所有已注册的 highlight
        try {
            if (CSS.highlights) {
                CSS.highlights.delete("wikilink-resolved");
                CSS.highlights.delete("wikilink-broken");
                CSS.highlights.delete("wikilink-bracket");
            }
        } catch (e) { /* ignore */ }

        console.log("[HighlightRenderer] 已停用");
    };

    // ===================================================================
    // 主题检测
    // ===================================================================

    HighlightRenderer.prototype._detectTheme = function () {
        try {
            var html = document.documentElement;
            this._darkMode = html.classList.contains("ty-dark") ||
                html.getAttribute("data-theme") === "dark" ||
                document.body.classList.contains("ty-dark");
        } catch (e) {
            this._darkMode = false;
        }

        // 监听暗色模式切换
        var self = this;
        this._darkObserver = new MutationObserver(function () {
            var prev = self._darkMode;
            self._detectTheme();
            if (prev !== self._darkMode && self._enabled) {
                // 主题变化，重建所有 highlight（paint 层自动重新计算颜色）
                self._rescanAll();
            }
        });
        this._darkObserver.observe(document.documentElement, {
            attributes: true,
            attributeFilter: ["class", "data-theme"],
        });
    };

    // ===================================================================
    // 调度
    // ===================================================================

    HighlightRenderer.prototype._scheduleScan = function (rootEl) {
        // 覆盖前一次 pending，不节流。DOM 重建时多轮 mutation 之间
        // 只有最后一次的 DOM 状态是完整的 — 节流会捕获错误的中间态。
        this._rafPending = false;
        var self = this;
        var el = rootEl || document.getElementById("write");
        if (!el) return;
        this._rafPending = true;
        requestAnimationFrame(function () {
            self._rafPending = false;
            self._scan(el);
        });
    };

    // ===================================================================
    // 增量变更处理
    // ===================================================================

    HighlightRenderer.prototype._onMutation = function (records) {
        if (this._processing) return;   // 防自触发

        var writeEl = document.getElementById("write");
        if (!writeEl) return;

        // 检查 observer 是否还挂在有效的 DOM 元素上。
        // Typora 切换标签页时可能整体替换 #write → observer 挂在已脱离的节点上
        // → 不再收到新内容的 mutation。检测到后自动重连。
        var relevant = false;
        for (var i = 0; i < records.length; i++) {
            var t = records[i].target;
            try {
                if (t === writeEl || writeEl.contains(t) || t === document.body) {
                    relevant = true;
                    break;
                }
            } catch (e) {
                // 节点已脱离 DOM，说明旧 #write 被整体替换 → 用新 #write 重连
                relevant = true;
                break;
            }
        }

        if (relevant) {
            this._scheduleScan(writeEl);
        }
    };

    // ===================================================================
    // 全量重扫
    // ===================================================================

    HighlightRenderer.prototype._rescanAll = function () {
        // 外部主动调用（如 onFileOpened），不走 _scheduleScan 的 rAF。
        // 直接当前帧扫描，确保切换标签页后高亮即刻可见。
        this._rafPending = false;
        var writeEl = document.getElementById("write");
        if (writeEl) this._scan(writeEl);
    };

    // ===================================================================
    // 扫描
    // ===================================================================

    HighlightRenderer.prototype._scan = function (rootEl) {
        if (!rootEl) return;
        this._processing = true;

        // 收集到实例字段 (hover 命中检测依赖)
        this._linkRanges = [];
        this._linkBrackets = [];
        // 旧 Range 已失效, 重置 hover 状态 (mousemove 会重新命中)
        this._hovered = null;
        this._hideTooltip();

        // TreeWalker 遍历所有文本节点
        var walker = document.createTreeWalker(
            rootEl,
            NodeFilter.SHOW_TEXT,
            null,
            false
        );

        var textNode;
        while ((textNode = walker.nextNode())) {
            this._extractRanges(textNode);
        }

        this._applyHighlights();
        this._processing = false;
    };

    /** 注册全部 highlight 到 CSS Highlight Registry (含 hover 分组) */
    HighlightRenderer.prototype._applyHighlights = function () {
        try {
            var hl = CSS.highlights;
            var h = this._hovered;
            // 常规组 = 全部 - 悬停项; hover 组 = 悬停项
            var res = [], bro = [], resHover = [], broHover = [];
            for (var i = 0; i < this._linkRanges.length; i++) {
                var lr = this._linkRanges[i];
                if (lr === h) {
                    if (lr.type === "resolved") resHover.push(lr.range);
                    else broHover.push(lr.range);
                } else {
                    if (lr.type === "resolved") res.push(lr.range);
                    else bro.push(lr.range);
                }
            }
            _setGroup(hl, "wikilink-resolved", res);
            _setGroup(hl, "wikilink-resolved-hover", resHover);
            _setGroup(hl, "wikilink-broken", bro);
            _setGroup(hl, "wikilink-broken-hover", broHover);
            _setGroup(hl, "wikilink-bracket", this._linkBrackets);
        } catch (e) {
            console.warn("[HighlightRenderer] Highlight set:", e.message);
        }
    };

    /** 把 Range 列表注册为一个 highlight 组 (空则删除) */
    function _setGroup(hl, name, ranges) {
        if (ranges.length > 0) {
            var h = new Highlight();
            for (var i = 0; i < ranges.length; i++) h.add(ranges[i]);
            hl.set(name, h);
        } else {
            hl.delete(name);
        }
    }

    // ===================================================================
    // 从文本节点中提取 [[...]] Range
    // ===================================================================

    HighlightRenderer.prototype._extractRanges = function (textNode) {
        var text = textNode.textContent || "";
        if (text.length < 4) return;   // 最少 "[[x]]"

        var regex = /!?\[\[([^\]]+)\]\]/g;
        var match;
        while ((match = regex.exec(text)) !== null) {
            // 空括号跳过
            if (match[1].trim() === "") continue;

            var parsed = this._parser.parseOne(match[0]);
            if (!parsed || !parsed.target) continue;   // 没有 target 的纯 #heading 引用暂不渲染

            // 验证链接是否可解析 (带父目录顶层兜底, 覆盖 Typora 自动挂载
            // 文件目录时链接到父目录文档的场景)
            var currentFile = this._getCurrentFilePath();
            var allMd = this._linkIndex ? this._linkIndex.allMdFiles : [];
            var resolvedPath;
            if (this._resolver.resolveWithParentFallback) {
                resolvedPath = this._resolver.resolveWithParentFallback(
                    parsed.target, currentFile, allMd, true, this._fs, this._path
                );
            } else {
                resolvedPath = this._resolver.resolve(parsed.target, currentFile, allMd, true);
            }

            try {
                var fullMatch = match[0];
                var innerText = match[1];
                var innerStartInMatch = fullMatch.indexOf(innerText);

                var absStart = match.index;
                var absInnerStart = absStart + innerStartInMatch;
                var absInnerEnd = absInnerStart + innerText.length;
                var absMatchEnd = absStart + fullMatch.length;

                // 左括号 Range（含可选的 ! 前缀）
                if (absInnerStart > absStart) {
                    var openRange = new Range();
                    openRange.setStart(textNode, absStart);
                    openRange.setEnd(textNode, absInnerStart);
                    this._linkBrackets.push(openRange);
                }

                // 内容 Range：有别名时，目标+管道→bracket，别名→resolved/broken
                var innerRange = new Range();
                innerRange.setStart(textNode, absInnerStart);
                innerRange.setEnd(textNode, absInnerEnd);

                if (parsed.alias) {
                    // innerText 形如 "Target|Alias"，找 alias 起始位置
                    var pipePos = innerText.lastIndexOf("|");
                    var aliasStartInInner = innerText.indexOf(parsed.alias, pipePos + 1);
                    if (aliasStartInInner >= 0) {
                        // 别名之前的部分（目标+管道+空白）→ bracket
                        if (aliasStartInInner > 0) {
                            var prefixRange = new Range();
                            prefixRange.setStart(textNode, absInnerStart);
                            prefixRange.setEnd(textNode, absInnerStart + aliasStartInInner);
                            this._linkBrackets.push(prefixRange);
                        }
                        // 别名 → resolved/broken
                        var aliasRange = new Range();
                        aliasRange.setStart(textNode, absInnerStart + aliasStartInInner);
                        aliasRange.setEnd(textNode, absInnerStart + aliasStartInInner + parsed.alias.length);
                        if (resolvedPath) {
                            this._pushLink(aliasRange, "resolved", parsed.target);
                        } else {
                            this._pushLink(aliasRange, "broken", parsed.target);
                        }
                        // alias 之后剩余（如 #heading 后缀）→ bracket
                        var tailStartInInner = aliasStartInInner + parsed.alias.length;
                        if (tailStartInInner < innerText.length) {
                            var tailRange = new Range();
                            tailRange.setStart(textNode, absInnerStart + tailStartInInner);
                            tailRange.setEnd(textNode, absInnerEnd);
                            this._linkBrackets.push(tailRange);
                        }
                    } else {
                        // 回退：找不到 alias 时整个 content 走原逻辑
                        if (resolvedPath) {
                            this._pushLink(innerRange, "resolved", parsed.target);
                        } else {
                            this._pushLink(innerRange, "broken", parsed.target);
                        }
                    }
                } else {
                    // 无别名，整个内容走原逻辑
                    if (resolvedPath) {
                        this._pushLink(innerRange, "resolved", parsed.target);
                    } else {
                        this._pushLink(innerRange, "broken", parsed.target);
                    }
                }

                // 右括号 Range
                if (absMatchEnd > absInnerEnd) {
                    var closeRange = new Range();
                    closeRange.setStart(textNode, absInnerEnd);
                    closeRange.setEnd(textNode, absMatchEnd);
                    this._linkBrackets.push(closeRange);
                }
            } catch (e) {
                // Range 创建失败（极罕见），跳过
            }
        }
    };

    // ===================================================================
    // hover 交互 — highlight 无法响应 :hover, 由 mousemove 命中检测驱动
    // ===================================================================

    /** 记录一个链接 Range 及元数据 (hover 命中检测 + 断链气泡用) */
    HighlightRenderer.prototype._pushLink = function (range, type, target) {
        this._linkRanges.push({ range: range, type: type, target: target });
    };

    /** 绑定 mousemove 监听 (enable 时调用, 幂等) */
    HighlightRenderer.prototype._initHover = function () {
        if (this._hoverBound) return;
        this._hoverBound = true;
        var self = this;
        var lastHit = null;
        var lastTime = 0;
        this._hoverHandler = function (e) {
            var now = Date.now();
            if (now - lastTime < 40) return;   // 节流 40ms
            lastTime = now;
            var hit = self._hitTest(e.clientX, e.clientY);
            if (hit === lastHit) {
                // 气泡跟随鼠标移动
                if (hit && self._tooltipEl && self._tooltipEl.style.display !== "none") {
                    self._moveTooltip(e);
                }
                return;
            }
            lastHit = hit;
            self._setHover(hit, e);
        };
        document.addEventListener("mousemove", this._hoverHandler, true);
    };

    /** 鼠标位置命中检测: 落在某个链接 Range 内则返回该条目 */
    HighlightRenderer.prototype._hitTest = function (x, y) {
        if (!this._enabled) return null;
        var range;
        try { range = document.caretRangeFromPoint(x, y); } catch (e) { return null; }
        if (!range || !range.startContainer) return null;
        var node = range.startContainer;
        var off = range.startOffset;
        var links = this._linkRanges;
        for (var i = 0; i < links.length; i++) {
            var lr = links[i];
            var r = lr.range;
            if (r.startContainer === node && off >= r.startOffset && off <= r.endOffset) {
                return lr;
            }
        }
        return null;
    };

    /** 切换 hover 状态: 重建 highlight 分组 + 断链气泡 */
    HighlightRenderer.prototype._setHover = function (hit, e) {
        this._hovered = hit;
        this._applyHighlights();
        if (hit && hit.type === "broken") {
            this._showTooltip(hit);
            if (e) this._moveTooltip(e);
        } else {
            this._hideTooltip();
        }
    };

    /** 断链气泡: 显示「目标不存在: xxx」 */
    HighlightRenderer.prototype._showTooltip = function (hit) {
        if (!this._tooltipEl) {
            this._tooltipEl = document.createElement("div");
            this._tooltipEl.className = "bt-link-tooltip";
            this._tooltipEl.setAttribute("data-plugin-id", "bidirectional-links");
            document.body.appendChild(this._tooltipEl);
        }
        this._tooltipEl.textContent = "目标不存在: " + (hit.target || "");
        this._tooltipEl.style.display = "block";
    };

    HighlightRenderer.prototype._hideTooltip = function () {
        if (this._tooltipEl) this._tooltipEl.style.display = "none";
    };

    HighlightRenderer.prototype._moveTooltip = function (e) {
        var el = this._tooltipEl;
        if (!el) return;
        var pad = 12;
        var left = e.clientX + pad;
        var top = e.clientY + pad;
        // 靠近右/下边缘时翻转, 避免出屏
        var w = el.offsetWidth || 160;
        var h = el.offsetHeight || 28;
        if (left + w > window.innerWidth - 8) left = e.clientX - w - pad;
        if (top + h > window.innerHeight - 8) top = e.clientY - h - pad;
        el.style.left = left + "px";
        el.style.top = top + "px";
    };

    /** 清理 hover 状态 (disable 时) */
    HighlightRenderer.prototype._disposeHover = function () {
        if (this._hoverHandler) {
            document.removeEventListener("mousemove", this._hoverHandler, true);
            this._hoverHandler = null;
        }
        this._hoverBound = false;
        this._hovered = null;
        if (this._tooltipEl) {
            try { if (this._tooltipEl.parentNode) this._tooltipEl.parentNode.removeChild(this._tooltipEl); } catch (e) {}
            this._tooltipEl = null;
        }
    };

    // ===================================================================
    // 获取当前文件路径
    // ===================================================================

    HighlightRenderer.prototype._getCurrentFilePath = function () {
        try {
            if (typeof File !== "undefined" && File.bundle && File.bundle.filePath) {
                return File.bundle.filePath;
            }
        } catch (e) { /* ignore */ }
        return null;
    };

    // ===================================================================
    // 导出
    // ===================================================================

    if (typeof module !== "undefined" && module.exports) {
        module.exports = HighlightRenderer;
    }
})();
