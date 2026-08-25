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

    function HighlightRenderer(parser, resolver, linkIndex) {
        this._parser = parser;
        this._resolver = resolver;
        this._linkIndex = linkIndex;

        this._observer = null;
        this._rafPending = false;
        this._processing = false;    // 防止自触发循环
        this._enabled = false;
        this._themeUnsub = null;     // BetterTypora.theme.onChange 解绑函数

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

        var ranges = { resolved: [], broken: [], bracket: [] };

        // TreeWalker 遍历所有文本节点
        var walker = document.createTreeWalker(
            rootEl,
            NodeFilter.SHOW_TEXT,
            null,
            false
        );

        var textNode;
        while ((textNode = walker.nextNode())) {
            this._extractRanges(textNode, ranges);
        }

        // 注册到 CSS Highlight Registry
        try {
            var hl = CSS.highlights;
            if (ranges.resolved.length > 0) {
                var rh = new Highlight();
                for (var ri = 0; ri < ranges.resolved.length; ri++) { rh.add(ranges.resolved[ri]); }
                hl.set("wikilink-resolved", rh);
            } else {
                hl.delete("wikilink-resolved");
            }
            if (ranges.broken.length > 0) {
                var bh = new Highlight();
                for (var bi = 0; bi < ranges.broken.length; bi++) { bh.add(ranges.broken[bi]); }
                hl.set("wikilink-broken", bh);
            } else {
                hl.delete("wikilink-broken");
            }
            if (ranges.bracket.length > 0) {
                var brh = new Highlight();
                for (var bri = 0; bri < ranges.bracket.length; bri++) { brh.add(ranges.bracket[bri]); }
                hl.set("wikilink-bracket", brh);
            } else {
                hl.delete("wikilink-bracket");
            }
        } catch (e) {
            console.warn("[HighlightRenderer] Highlight set:", e.message);
        }

        this._processing = false;
    };

    // ===================================================================
    // 从文本节点中提取 [[...]] Range
    // ===================================================================

    HighlightRenderer.prototype._extractRanges = function (textNode, ranges) {
        var text = textNode.textContent || "";
        if (text.length < 4) return;   // 最少 "[[x]]"

        var regex = /!?\[\[([^\]]+)\]\]/g;
        var match;
        while ((match = regex.exec(text)) !== null) {
            // 空括号跳过
            if (match[1].trim() === "") continue;

            var parsed = this._parser.parseOne(match[0]);
            if (!parsed || !parsed.target) continue;   // 没有 target 的纯 #heading 引用暂不渲染

            // 验证链接是否可解析
            var currentFile = this._getCurrentFilePath();
            var resolvedPath = this._resolver.resolve(
                parsed.target,
                currentFile,
                this._linkIndex ? this._linkIndex.allMdFiles : [],
                true
            );

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
                    ranges.bracket.push(openRange);
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
                            ranges.bracket.push(prefixRange);
                        }
                        // 别名 → resolved/broken
                        var aliasRange = new Range();
                        aliasRange.setStart(textNode, absInnerStart + aliasStartInInner);
                        aliasRange.setEnd(textNode, absInnerStart + aliasStartInInner + parsed.alias.length);
                        if (resolvedPath) {
                            ranges.resolved.push(aliasRange);
                        } else {
                            ranges.broken.push(aliasRange);
                        }
                        // alias 之后剩余（如 #heading 后缀）→ bracket
                        var tailStartInInner = aliasStartInInner + parsed.alias.length;
                        if (tailStartInInner < innerText.length) {
                            var tailRange = new Range();
                            tailRange.setStart(textNode, absInnerStart + tailStartInInner);
                            tailRange.setEnd(textNode, absInnerEnd);
                            ranges.bracket.push(tailRange);
                        }
                    } else {
                        // 回退：找不到 alias 时整个 content 走原逻辑
                        if (resolvedPath) {
                            ranges.resolved.push(innerRange);
                        } else {
                            ranges.broken.push(innerRange);
                        }
                    }
                } else {
                    // 无别名，整个内容走原逻辑
                    if (resolvedPath) {
                        ranges.resolved.push(innerRange);
                    } else {
                        ranges.broken.push(innerRange);
                    }
                }

                // 右括号 Range
                if (absMatchEnd > absInnerEnd) {
                    var closeRange = new Range();
                    closeRange.setStart(textNode, absInnerEnd);
                    closeRange.setEnd(textNode, absMatchEnd);
                    ranges.bracket.push(closeRange);
                }
            } catch (e) {
                // Range 创建失败（极罕见），跳过
            }
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
