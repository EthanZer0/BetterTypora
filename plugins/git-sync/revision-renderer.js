/**
 * Git Plugin — 修订视图渲染器
 * ==============================
 * 临时 NodeMap 渲染：将任意 markdown 文本渲染为 Typora 风格 HTML，
 * 不触碰 editor.reset()。附加 Myers 逐词 Diff 引擎。
 */
(function () {
    "use strict";

    // ===================================================================
    // 分词器（CJK 字符独立分词，拉丁按空格分词）
    // ===================================================================

    function isCJK(ch) {
        var c = ch.charCodeAt(0);
        return (c >= 0x4E00 && c <= 0x9FFF) ||
               (c >= 0x3400 && c <= 0x4DBF) ||
               (c >= 0x3000 && c <= 0x303F) ||
               (c >= 0xFF00 && c <= 0xFFEF) ||
               (c >= 0xF900 && c <= 0xFAFF) ||
               (c >= 0x2F800 && c <= 0x2FA1F);
    }

    /**
     * 将文本分词，CJK 字符每个独立，其他按空格+标点边界分割
     */
    function tokenize(text) {
        if (!text) return [];
        var tokens = [];
        var i = 0;
        while (i < text.length) {
            var ch = text[i];
            if (isCJK(ch)) {
                tokens.push(ch);
                i++;
            } else if (/\s/.test(ch)) {
                tokens.push(ch);
                i++;
            } else {
                var j = i;
                while (j < text.length && !isCJK(text[j]) && !/\s/.test(text[j])) { j++; }
                if (j > i) {
                    tokens.push(text.substring(i, j));
                }
                i = j;
            }
        }
        return tokens;
    }

    /**
     * 从分词数组重建文本
     */
    function untokenize(tokens) {
        return tokens.join("");
    }

    // ===================================================================
    // Myers Diff 算法
    // ===================================================================

    /**
     * 对两个数组做 Myers diff，返回操作序列
     * [{type: "eq"|"add"|"del", items: [...]}]
     */
    function myersDiff(oldArr, newArr) {
        var n = oldArr.length;
        var m = newArr.length;
        var max = n + m;
        var maxD = max + 1;
        var size = 2 * maxD + 1;
        var offset = maxD;

        // V 数组存x值
        var V = new Int32Array(size);

        // 初始化 V[1] = 0（k=1 时 x=0）
        V[offset + 1] = 0;

        // 保存每轮 V 快照用于回溯
        var snapshots = [];

        var d, k;
        for (d = 0; d <= maxD; d++) {
            var snapshot = new Int32Array(size);
            snapshot.set(V);
            snapshots.push(snapshot);

            for (k = -d; k <= d; k += 2) {
                var x;
                if (k === -d || (k !== d && V[offset + k - 1] < V[offset + k + 1])) {
                    x = V[offset + k + 1];        // 向下移动
                } else {
                    x = V[offset + k - 1] + 1;    // 向右移动
                }
                var y = x - k;

                // 沿对角线走（匹配）
                while (x < n && y < m && oldArr[x] === newArr[y]) {
                    x++;
                    y++;
                }

                V[offset + k] = x;

                if (x >= n && y >= m) {
                    // 找到终点，回溯
                    return _backtrack(n, m, snapshots, offset, d, k, oldArr, newArr);
                }
            }
        }

        // 无法到达（应该不会发生）
        return [{ type: "eq", items: oldArr.slice() }];
    }

    function _backtrack(n, m, snapshots, offset, endD, endK, oldArr, newArr) {
        var ops = [];
        var x = n;
        var y = m;
        var d = endD;
        var k = endK;

        // 用于给 eq/add 操作标记在 newArr 中的位置，后续按位置重新排序
        // newIdx 是当前已处理的 newArr 位置（从末尾往回走），初始为 m
        var newIdx = m;

        while (d > 0) {
            var prevV = snapshots[d];
            var prevK, prevX;
            var isDown;

            if (k === -d || (k !== d && prevV[offset + k - 1] < prevV[offset + k + 1])) {
                // 来自向下移动 (insert)
                isDown = true;
                prevK = k + 1;
                prevX = prevV[offset + prevK];
                var prevYP = prevX - prevK;
                // 说明新增了 newArr[prevY]
                ops.unshift({ type: "add", items: [newArr[prevYP]], _newStart: prevYP });
                newIdx = prevYP;
            } else {
                // 来自向右移动 (delete)
                isDown = false;
                prevK = k - 1;
                prevX = prevV[offset + prevK];
                // 说明删除了 oldArr[prevX]
                ops.unshift({ type: "del", items: [oldArr[prevX]] });
            }

            var prevY = prevX - prevK;

            // 对角线（匹配部分）
            // rightward 时 x 已 +1，对角线长度要减去这一步
            var diagLen = isDown ? (x - prevX) : (x - prevX - 1);
            if (diagLen > 0) {
                var eqItems = oldArr.slice(x - diagLen, x);
                if (eqItems.length > 0) {
                    // newIdx 已由 isDown 分支设置：insert 时是 prevY, delete 时是 prevY
                    // eq 对应的 newArr 位置是 newIdx（delete）或者上一轮的位置（insert）
                    var eqNewStart = isDown ? (newIdx + 1) : newIdx;
                    ops.unshift({ type: "eq", items: eqItems, _newStart: eqNewStart });
                    newIdx = eqNewStart + eqItems.length;
                }
            }

            x = prevX;
            y = prevY;
            k = prevK;
            d = d - 1;
        }

        // d=0，只有对角线
        if (x > 0) {
            ops.unshift({ type: "eq", items: oldArr.slice(0, x), _newStart: 0 });
        }

        return _mergeAdjacent(ops);
    }

    function _mergeAdjacent(ops) {
        if (ops.length === 0) return ops;
        var merged = [ops[0]];
        for (var i = 1; i < ops.length; i++) {
            var last = merged[merged.length - 1];
            // 不合并 eq: eq 粒度保持以保留 insert/delete 的位置信息
            if (last.type !== "eq" && last.type === ops[i].type) {
                last.items = last.items.concat(ops[i].items);
            } else {
                merged.push(ops[i]);
            }
        }
        return merged;
    }

    /**
     * 按 _newStart 对 ops 排序（升序），稳定排序。
     * del 不设置 _newStart（在 old 中有但 new 中无），其位置由前后 eq/add 的上下文确定。
     * del 使用前一个 op 的 _newStart（如果没有则用 0）。
     */
    function _sortByNewStart(ops) {
        // 为 del 推断 _newStart：删除的内容在 newArr 中没有对应，其位置
        // 由最近的 add/eq 确定。往前找有 _newStart 的 op 作为锚点。
        var fallback = 0;
        for (var i = 0; i < ops.length; i++) {
            var op = ops[i];
            if (op._newStart !== undefined) {
                fallback = op._newStart;
            } else {
                op._newStart = fallback;
            }
        }
        // 稳定排序
        return ops.sort(function (a, b) {
            return (a._newStart || 0) - (b._newStart || 0);
        });
    }

    // ===================================================================
    // HTML 解析与操作
    // ===================================================================

    /**
     * 将 HTML 字符串解析为块级元素数组
     * 提取 #write 下的直接子元素作为块
     */
    function parseBlocks(html) {
        if (!html) return [];
        var blocks = [];
        // 用正则提取顶级元素（h1-h6, p, ul, ol, pre, blockquote, table, div, hr）
        var tagRe = /<(h[1-6]|p|ul|ol|pre|blockquote|table|div|hr|figure)(\s[^>]*)?>/g;

        var pos = 0;
        while (pos < html.length) {
            tagRe.lastIndex = pos;
            var startMatch = tagRe.exec(html);
            if (!startMatch) break;

            var rawTagName = startMatch[1];
            var fullMatchStr = startMatch[0];
            var tagName = rawTagName;

            // Typora 实时编辑器用 <figure class="md-fences"> 包裹代码块，
            // 而 parseFrom 产出 <pre class="md-fences">。统一化为 "pre"
            // 以便 alignBlocks 正确匹配同一代码块。
            if (tagName === "figure" && /md-fences/.test(fullMatchStr)) {
                tagName = "pre";
            }
            var startIdx = startMatch.index;
            var endIdx;

            if (tagName === "hr") {
                endIdx = startIdx + startMatch[0].length;
                blocks.push({
                    tag: tagName,
                    html: html.substring(startIdx, endIdx),
                    text: _stripHtml(html.substring(startIdx, endIdx)),
                    fullMatch: startMatch[0]
                });
                pos = endIdx;
                continue;
            }

            // 找对应的结束标签（双指针追踪 open/close，不重建正则）
            // 注意：关闭标签搜索必须用 rawTagName（HTML 中的真实标签名），
            // 而非统一化后的 tagName（如 figure→pre 映射）。
            var depth = 1;
            var searchPos = startIdx + startMatch[0].length;
            var openRe = new RegExp("<" + rawTagName + "(\\s[^>]*)?>", "g");
            var closeRe = new RegExp("<\\/" + rawTagName + ">", "g");

            while (depth > 0 && searchPos < html.length) {
                openRe.lastIndex = searchPos;
                closeRe.lastIndex = searchPos;

                var nextOpen = openRe.exec(html);
                var nextClose = closeRe.exec(html);

                var openIdx = nextOpen ? nextOpen.index : Infinity;
                var closeIdx = nextClose ? nextClose.index : Infinity;

                if (openIdx < closeIdx) {
                    // 先遇到嵌套开始标签
                    depth++;
                    searchPos = openIdx + (nextOpen[0] || "").length;
                } else if (closeIdx < Infinity) {
                    // 先遇到结束标签
                    depth--;
                    if (depth === 0) {
                        endIdx = closeIdx + (nextClose[0] || "").length;
                        break;
                    }
                    searchPos = closeIdx + (nextClose[0] || "").length;
                } else {
                    // 找不到任何标签，取到末尾
                    endIdx = html.length;
                    break;
                }
            }

            blocks.push({
                tag: tagName,
                html: html.substring(startIdx, endIdx),
                text: (tagName === "pre") ? _stripCodeText(html.substring(startIdx, endIdx)) : _stripHtml(html.substring(startIdx, endIdx)),
                fullMatch: startMatch[0]
            });
            pos = endIdx;
        }

        return blocks;
    }

    /**
     * 去除 HTML 标签，提取纯文本
     */
    function _stripHtml(html) {
        if (!html) return "";
        return html.replace(/<[^>]*>/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
                   .replace(/&amp;/g, "&").replace(/&quot;/g, "\"").replace(/&#39;/g, "'")
                   .replace(/&nbsp;/gi, " ").replace(/&#x200b;/gi, "")
                   .replace(/​/g, "")
                   .replace(/\s+/g, " ").trim();
    }

    /**
     * 从代码块 HTML 中提取纯文本，只取 .CodeMirror-line 内容
     * Typora 实时编辑器的代码块 DOM 包含 gutter 行号、wrapping x-padding，
     * 需过滤这些才能与 parseFrom 产出（无 gutter）正确匹配。
     */
    function _stripCodeText(html) {
        if (!html) return "";
        // 匹配任意带有 CodeMirror-line class 的元素（Typora 可能用不同标签）
        var re = /<(\w+)[^>]*\bclass="[^"]*\bCodeMirror-line\b[^"]*"[^>]*>([\s\S]*?)<\/\1>/g;
        var parts = [];
        var m;
        while ((m = re.exec(html)) !== null) {
            var line = m[2];
            // Typora wrapping: 行首有 x{1,20} 作为 wrapping 占位缩进
            line = line.replace(/^x{1,20}(?:&nbsp;|\s)*/, "");
            parts.push(line);
        }
        if (parts.length === 0) {
            // 回退：普通 pre/code 内容（parseFrom 无高亮场景）
            return _stripHtml(html);
        }
        var text = parts.join("\n");
        return _stripHtml(text);
    }

    /**
     * HTML 实体转义
     */
    function escapeHtml(str) {
        if (!str) return "";
        return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
                  .replace(/"/g, "&quot;");
    }

    // ===================================================================
    // 块级对齐
    // ===================================================================

    /**
     * 对两个块的文本做相似度评分（0-1）
     */
    function blockSimilarity(textA, textB) {
        if (textA === textB) return 1.0;
        if (!textA || !textB) return 0.0;
        // 简单的共同词比例
        var wordsA = textA.split(/\s+/);
        var wordsB = textB.split(/\s+/);
        var setB = {};
        for (var i = 0; i < wordsB.length; i++) { setB[wordsB[i]] = true; }
        var common = 0;
        for (var j = 0; j < wordsA.length; j++) {
            if (setB[wordsA[j]]) common++;
        }
        var maxLen = Math.max(wordsA.length, wordsB.length);
        return maxLen > 0 ? common / maxLen : 0;
    }

    /**
     * 对齐两个块数组，返回对齐对
     * [{left: block|null, right: block|null, status: "same"|"modified"|"added"|"deleted"}]
     */
    function alignBlocks(oldBlocks, newBlocks) {
        var result = [];
        var usedNew = {};
        var i = 0, j = 0;

        // 使用基于content hash的贪心匹配
        while (i < oldBlocks.length && j < newBlocks.length) {
            var oldB = oldBlocks[i];
            var newB = newBlocks[j];

            if (oldB.tag === newB.tag && oldB.text === newB.text) {
                result.push({ left: oldB, right: newB, status: "same" });
                i++; j++;
                continue;
            }

            // 尝试在newBlocks中寻找与oldB匹配的
            var bestMatch = -1;
            var bestScore = 0.4; // 最低阈值
            var lookAhead = Math.min(j + 5, newBlocks.length);
            for (var nj = j; nj < lookAhead; nj++) {
                if (usedNew[nj]) continue;
                var score = blockSimilarity(oldB.text, newBlocks[nj].text);
                if (score > bestScore && oldB.tag === newBlocks[nj].tag) {
                    bestScore = score;
                    bestMatch = nj;
                }
            }

            if (bestMatch >= 0) {
                // 中间的新块是added
                while (j < bestMatch) {
                    result.push({ left: null, right: newBlocks[j], status: "added" });
                    usedNew[j] = true;
                    j++;
                }
                var alignStatus = (oldB.text === newBlocks[bestMatch].text) ? "same" : "modified";
                result.push({ left: oldB, right: newBlocks[bestMatch], status: alignStatus });
                usedNew[bestMatch] = true;
                i++;
                j = bestMatch + 1;
            } else {
                // 在newBlocks中尝试寻找与oldB完全相同的text
                var found = false;
                for (var fj = j; fj < Math.min(j + 10, newBlocks.length); fj++) {
                    if (!usedNew[fj] && oldB.text === newBlocks[fj].text && oldB.tag === newBlocks[fj].tag) {
                        // 中间的都是added
                        while (j < fj) {
                            result.push({ left: null, right: newBlocks[j], status: "added" });
                            usedNew[j] = true;
                            j++;
                        }
                        result.push({ left: oldB, right: newBlocks[fj], status: "same" });
                        usedNew[fj] = true;
                        i++; j = fj + 1;
                        found = true;
                        break;
                    }
                }
                if (!found) {
                    // 兜底：相同 tag 不同 text → modified
                    if (j < newBlocks.length && oldB.tag === newBlocks[j].tag) {
                        result.push({ left: oldB, right: newBlocks[j], status: "modified" });
                        usedNew[j] = true;
                        i++; j++;
                    } else {
                        result.push({ left: oldB, right: null, status: "deleted" });
                        i++;
                    }
                }
            }
        }

        // 剩余旧块 = deleted
        while (i < oldBlocks.length) {
            result.push({ left: oldBlocks[i], right: null, status: "deleted" });
            i++;
        }
        // 剩余新块 = added
        while (j < newBlocks.length) {
            result.push({ left: null, right: newBlocks[j], status: "added" });
            j++;
        }

        return result;
    }

    // ===================================================================
    // 逐词 Diff 标注 HTML
    // ===================================================================

    /**
     * 对两个 HTML 块做逐词 Diff，输出带标注的 HTML 对
     * @returns {{leftHtml: string, rightHtml: string}}
     */
    function diffBlockHTML(oldHtml, newHtml) {
        if (!oldHtml && !newHtml) return { leftHtml: "", rightHtml: "" };

        var oldText = _stripHtml(oldHtml || "");
        var newText = _stripHtml(newHtml || "");

        if (!oldHtml) {
            return {
                leftHtml: "",
                rightHtml: _wrapBlock(newHtml, "git-rev-block-add", "新增")
            };
        }
        if (!newHtml) {
            return {
                leftHtml: _wrapBlock(oldHtml, "git-rev-block-del", "删除"),
                rightHtml: ""
            };
        }

        var oldTokens = tokenize(oldText);
        var newTokens = tokenize(newText);
        var ops = _mergeAdjacent(_sortByNewStart(myersDiff(oldTokens, newTokens)));

        // 生成 diff 文本 — 按 newArr 中的出现顺序遍历
        var leftParts = [];
        var rightParts = [];

        for (var i = 0; i < ops.length; i++) {
            var op = ops[i];
            var text = untokenize(op.items);
            var escaped = escapeHtml(text);
            switch (op.type) {
                case "eq":
                    leftParts.push(escaped);
                    rightParts.push(escaped);
                    break;
                case "del":
                    leftParts.push('<del class="git-rev-del">' + escaped + "</del>");
                    break;
                case "add":
                    rightParts.push('<mark class="git-rev-add">' + escaped + "</mark>");
                    break;
            }
        }

        return {
            leftHtml: leftParts.join("") || "&nbsp;",
            rightHtml: rightParts.join("") || "&nbsp;"
        };
    }

    /**
     * DOM 保留的逐词 diff：保留外层 HTML 标签结构，仅对文本节点做 token 级 diff。
     * diffBlockHTML 的 _stripHtml 会破坏 blockquote/pre/ul 等复杂结构，
     * 此函数用 DOM 解析保持标签完整，同时精准标记文本变化。
     */
    function diffInlineHTML(oldHtml, newHtml) {
        console.log("[diffInlineHTML] ENTER — old len=" + (oldHtml ? oldHtml.length : 0) + " new len=" + (newHtml ? newHtml.length : 0));

        if (!oldHtml && !newHtml) { console.log("[diffInlineHTML] both empty"); return { leftHtml: "", rightHtml: "" }; }
        if (!oldHtml) {
            console.log("[diffInlineHTML] old empty → wrap new as added");
            return {
                leftHtml: "",
                rightHtml: _wrapBlock(newHtml, "git-rev-block-add", "新增")
            };
        }
        if (!newHtml) {
            console.log("[diffInlineHTML] new empty → wrap old as deleted");
            return {
                leftHtml: _wrapBlock(oldHtml, "git-rev-block-del", "删除"),
                rightHtml: ""
            };
        }

        oldHtml = _normalizeTyporaHtml(oldHtml);
        newHtml = _normalizeTyporaHtml(newHtml);

        var oldDiv = document.createElement("div");
        oldDiv.innerHTML = oldHtml;
        var oldRoot = oldDiv.firstElementChild;

        var newDiv = document.createElement("div");
        newDiv.innerHTML = newHtml;
        var newRoot = newDiv.firstElementChild;

        if (!oldRoot || !newRoot) {
            console.log("[diffInlineHTML] missing root → wrap fallback (oldRoot=" + (oldRoot ? oldRoot.tagName : "null") + " newRoot=" + (newRoot ? newRoot.tagName : "null") + ")");
            return {
                leftHtml: _wrapBlock(oldRoot ? _outerHtml(oldRoot) : (oldHtml || "&nbsp;"), "git-rev-block-del", "旧"),
                rightHtml: _wrapBlock(newRoot ? _outerHtml(newRoot) : (newHtml || "&nbsp;"), "git-rev-block-add", "新")
            };
        }

        console.log("[diffInlineHTML] root tag — old=" + oldRoot.tagName + " new=" + newRoot.tagName);
        var result = _diffNodes(oldRoot, newRoot);
        console.log("[diffInlineHTML] RESULT:\n  L: " + result.leftHtml.substring(0, 200));
        console.log("[diffInlineHTML] RESULT:\n  R: " + result.rightHtml.substring(0, 200));
        return result;
    }

    // ── diffInlineHTML 内部辅助函数 ──

    function _diffNodes(oldNode, newNode) {
        // 1. both null
        if (!oldNode && !newNode) return { leftHtml: "", rightHtml: "" };
        // 2. old only → deleted
        if (!oldNode) {
            console.log("[_diffNodes] ONLY-NEW tag=" + (newNode.tagName || "#text") + " text=\"" + _getNodeText(newNode).substring(0, 40) + "\"");
            return {
                leftHtml: "",
                rightHtml: _wrapSubtree(newNode, "git-rev-block-add", "新增")
            };
        }
        // 3. new only → added — 但空排版元素直接透传，不包裹
        if (!newNode) {
            if (_isEmptyLayoutNode(oldNode)) {
                console.log("[_diffNodes] ONLY-OLD (layout, passthru) tag=" + (oldNode.tagName || "#text"));
                return { leftHtml: _outerHtml(oldNode), rightHtml: "" };
            }
            console.log("[_diffNodes] ONLY-OLD (wrapped) tag=" + (oldNode.tagName || "#text") + " text=\"" + _getNodeText(oldNode).substring(0, 40) + "\"");
            return {
                leftHtml: _wrapSubtree(oldNode, "git-rev-block-del", "删除"),
                rightHtml: ""
            };
        }
        // 4. both text nodes
        if (oldNode.nodeType === 3 && newNode.nodeType === 3) {
            var td = _diffTextNodes(oldNode.textContent || "", newNode.textContent || "");
            if (td.leftHtml !== td.rightHtml) {
                console.log("[_diffNodes] TEXT-DIFF old=\"" + oldNode.textContent.substring(0, 40) + "\" new=\"" + newNode.textContent.substring(0, 40) + "\"");
            }
            return td;
        }
        // 5. different nodeType or tagName → structural mismatch
        if (oldNode.nodeType !== newNode.nodeType) {
            console.log("[_diffNodes] STRUCT-MISMATCH nodeType — old=" + oldNode.nodeType + "(" + (oldNode.tagName || "#text") + ") new=" + newNode.nodeType + "(" + (newNode.tagName || "#text") + ")");
            return {
                leftHtml: _wrapSubtree(oldNode, "git-rev-block-del", "删除"),
                rightHtml: _wrapSubtree(newNode, "git-rev-block-add", "新增")
            };
        }
        // text node vs element (already handled by nodeType check, but be safe)
        if (oldNode.nodeType !== 1 || newNode.nodeType !== 1) {
            return {
                leftHtml: _wrapSubtree(oldNode, "git-rev-block-del", "删除"),
                rightHtml: _wrapSubtree(newNode, "git-rev-block-add", "新增")
            };
        }
        if (oldNode.tagName !== newNode.tagName) {
            console.log("[_diffNodes] STRUCT-MISMATCH tag — old=" + oldNode.tagName + " new=" + newNode.tagName);
            return {
                leftHtml: _wrapSubtree(oldNode, "git-rev-block-del", "删除"),
                rightHtml: _wrapSubtree(newNode, "git-rev-block-add", "新增")
            };
        }
        // 6. same tagName → recurse into children
        var oldKids = _getSignificantChildren(oldNode);
        var newKids = _getSignificantChildren(newNode);
        console.log("[_diffNodes] SAME-TAG " + oldNode.tagName + " — kids old=" + oldKids.length + " new=" + newKids.length);
        for (var di = 0; di < Math.max(oldKids.length, newKids.length); di++) {
            var oLabel = di < oldKids.length ? (oldKids[di].nodeType === 3 ? "#text" : oldKids[di].tagName) : "-";
            var nLabel = di < newKids.length ? (newKids[di].nodeType === 3 ? "#text" : newKids[di].tagName) : "-";
            var oTxt = di < oldKids.length ? ("\"" + _getNodeText(oldKids[di]).substring(0, 30) + "\"") : "-";
            var nTxt = di < newKids.length ? ("\"" + _getNodeText(newKids[di]).substring(0, 30) + "\"") : "-";
            console.log("[_diffNodes]   child[" + di + "] old=" + oLabel + " " + oTxt + " new=" + nLabel + " " + nTxt);
        }
        var pairs = _alignChildren(oldKids, newKids);

        var leftInner = "", rightInner = "";
        for (var i = 0; i < pairs.length; i++) {
            var p = pairs[i];
            var pd = _diffNodes(p.left, p.right);
            leftInner += pd.leftHtml;
            rightInner += pd.rightHtml;
        }

        return {
            leftHtml: _elementWithContent(oldNode, leftInner),
            rightHtml: _elementWithContent(newNode, rightInner)
        };
    }

    function _diffTextNodes(oldText, newText) {
        if (oldText === newText) {
            var esc = escapeHtml(oldText);
            return { leftHtml: esc, rightHtml: esc };
        }

        var oldTokens = tokenize(oldText);
        var newTokens = tokenize(newText);
        var ops = _mergeAdjacent(_sortByNewStart(myersDiff(oldTokens, newTokens)));

        var leftParts = [];
        var rightParts = [];

        for (var i = 0; i < ops.length; i++) {
            var op = ops[i];
            var text = untokenize(op.items);
            var escaped = escapeHtml(text);
            switch (op.type) {
                case "eq":
                    leftParts.push(escaped);
                    rightParts.push(escaped);
                    break;
                case "del":
                    leftParts.push('<del class="git-rev-del">' + escaped + "</del>");
                    break;
                case "add":
                    rightParts.push('<mark class="git-rev-add">' + escaped + "</mark>");
                    break;
            }
        }

        return { leftHtml: leftParts.join(""), rightHtml: rightParts.join("") };
    }

    function _alignChildren(oldArr, newArr) {
        var pairs = [];
        var i = 0, j = 0;

        while (i < oldArr.length && j < newArr.length) {
            var oldChild = oldArr[i];
            var newChild = newArr[j];

            if (_nodesMatch(oldChild, newChild)) {
                pairs.push({ left: oldChild, right: newChild });
                i++; j++;
                continue;
            }

            var found = false;
            var maxLook = Math.min(j + 3, newArr.length);
            for (var k = j + 1; k < maxLook; k++) {
                if (_nodesMatch(oldChild, newArr[k])) {
                    for (var a = j; a < k; a++) {
                        console.log("[_alignChildren] ADDED tag=" + (newArr[a].tagName || "#text") + " \"" + _getNodeText(newArr[a]).substring(0, 40) + "\"");
                        pairs.push({ left: null, right: newArr[a] });
                    }
                    pairs.push({ left: oldChild, right: newArr[k] });
                    i++;
                    j = k + 1;
                    found = true;
                    break;
                }
            }

            if (!found) {
                console.log("[_alignChildren] DELETED tag=" + (oldChild.tagName || "#text") + " \"" + _getNodeText(oldChild).substring(0, 40) + "\"");
                pairs.push({ left: oldChild, right: null });
                i++;
            }
        }

        while (i < oldArr.length) {
            console.log("[_alignChildren] DELETED(tail) tag=" + (oldArr[i].tagName || "#text") + " \"" + _getNodeText(oldArr[i]).substring(0, 40) + "\"");
            pairs.push({ left: oldArr[i], right: null });
            i++;
        }
        while (j < newArr.length) {
            console.log("[_alignChildren] ADDED(tail) tag=" + (newArr[j].tagName || "#text") + " \"" + _getNodeText(newArr[j]).substring(0, 40) + "\"");
            pairs.push({ left: null, right: newArr[j] });
            j++;
        }

        return pairs;
    }

    function _nodesMatch(a, b) {
        if (!a && !b) return true;
        if (!a || !b) return false;
        // different nodeType: can't match
        if (a.nodeType !== b.nodeType) return false;
        // both text nodes: always pair them — _diffTextNodes handles the actual diff
        if (a.nodeType === 3) return true;
        // both element nodes: match by tag name, text differences handled recursively
        return a.tagName === b.tagName;
    }

    function _getNodeText(node) {
        if (node.nodeType === 3) return (node.textContent || "").trim();
        return _stripHtml(node.innerHTML || node.textContent || "");
    }

    function _isEmptyLayoutNode(node) {
        if (node.nodeType !== 1) return false;
        var html = _outerHtml(node).trim();
        return html !== "" && _getNodeText(node) === "";
    }

    /**
     * Typora 内部 HTML → 干净 HTML。
     * 将 <span class="md-softbreak"> → <br>，去除非语义属性。
     */
    function _normalizeTyporaHtml(html) {
        if (!html) return html;
        // softbreak → br
        html = html.replace(/<span\b[^>]*\bclass="[^"]*\bmd-softbreak\b[^"]*"[^>]*>\s*<\/span>/gi, "<br>");
        // 去掉 Typora 内部属性：md-inline, mdtype, cid, contenteditable
        html = html.replace(/\s*(?:md-inline|mdtype|cid|contenteditable)="[^"]*"/gi, "");
        return html;
    }

    /**
     * 块匹配前预处理：消除两条渲染路径（parseFrom vs writeEl.innerHTML）
     * 产生的结构性差异，使 alignBlocks 能正确匹配相同内容。
     */
    function _normalizeForBlockMatching(html) {
        if (!html) return html;

        // A. CodeMirror wrapping padding — 去掉 CodeMirror-line 内容前的 x{1,20}
        html = html.replace(
            /(<pre\b[^>]*\bclass="[^"]*\bCodeMirror-line\b[^"]*"[^>]*>)(x{1,20}(?:&nbsp;|\s)*)/g,
            "$1"
        );

        // B. MathJax → LaTeX source — 从 mjx-container 中提取原始 LaTeX
        //    MathJax 将源码存在 <script type="math/tex"> 内
        html = html.replace(
            /<mjx-container[^>]*>[\s\S]*?<script[^>]*\btype="math\/tex"[^>]*>([\s\S]*?)<\/script>[\s\S]*?<\/mjx-container>/g,
            function (match, tex) { return _escAttr(tex); }
        );

        // C. Footnote backlink — 去掉 Typora 注入的 ↩ 回链字符
        html = html.replace(/<a\b[^>]*\brev="footnote"[^>]*>\s*↩\s*<\/a>/gi, "");

        return html;
    }

    function _getSignificantChildren(node) {
        var result = [];
        var children = node.childNodes;
        for (var i = 0; i < children.length; i++) {
            var child = children[i];
            if (child.nodeType === 3 && /^\s*$/.test(child.textContent || "")) {
                continue;
            }
            result.push(child);
        }
        return result;
    }

    function _outerHtml(node) {
        var wrapper = document.createElement("div");
        wrapper.appendChild(node.cloneNode(true));
        return wrapper.innerHTML;
    }

    function _elementWithContent(node, innerHtml) {
        var clone = node.cloneNode(false);
        clone.innerHTML = innerHtml;
        return _outerHtml(clone);
    }

    function _wrapSubtree(node, className, label) {
        // 用 <del>/<mark> 包裹，纯 inline 不干扰子元素 display
        var wrappedClass = (className === "git-rev-block-del") ? "git-rev-subtree-del" : "git-rev-subtree-add";
        var tagName = (className === "git-rev-block-del") ? "del" : "mark";
        return '<' + tagName + ' class="' + wrappedClass + '">' + _outerHtml(node) + '</' + tagName + '>';
    }

    function _wrapBlock(innerHtml, className, label) {
        return '<div class="' + className + '"><span class="git-rev-block-label">' + label + "</span>" + (innerHtml || "&nbsp;") + "</div>";
    }

    function _wrapInline(innerHtml, className, label) {
        return '<span class="' + className + '"><span class="git-rev-block-label">' + label + "</span>" + (innerHtml || "&nbsp;") + "</span>";
    }

    // ===================================================================
    // 主入口：渲染修订视图
    // ===================================================================

    /**
     * 渲染修订视图（纯函数，不修改编辑器状态）
     * @param {string} oldMd - 旧版本 markdown 原文
     * @param {string} newHtml - 当前编辑器已渲染的 HTML (直接读 #write.innerHTML)
     * @param {Object} editor - Typora 的 window.editor
     * @param {Object} commitInfo
     */
    function renderRevision(oldMd, newHtml, editor, commitInfo) {
        commitInfo = commitInfo || {};

        // 1. 将旧 markdown 渲染为 Typora 原生 HTML（使用临时隐藏容器隔离）
        var oldHtml = "";
        try {
            oldHtml = _renderMdToHtml(editor, oldMd || "");
        } catch (e) {
            oldHtml = "<p>渲染失败: " + escapeHtml(e.message) + "</p>";
        }

        // 2. 块级对齐 — 预处理消除两条渲染路径的结构差异
        var oldBlocks = parseBlocks(_normalizeForBlockMatching(oldHtml));
        var newBlocks = parseBlocks(_normalizeForBlockMatching(newHtml || ""));
        var aligned = alignBlocks(oldBlocks, newBlocks);

        // 3. 逐块渲染
        var leftParts = [];
        var rightParts = [];
        var additions = 0;
        var deletions = 0;

        for (var i = 0; i < aligned.length; i++) {
            var pair = aligned[i];
            switch (pair.status) {
                case "same":
                    leftParts.push(pair.left.html);
                    rightParts.push(pair.right.html);
                    break;

                case "modified": {
                    console.log("[renderRevision] MODIFIED tag=" + pair.left.tag + " oldTxt=\"" + (pair.left.text || "").substring(0, 60) + "\" newTxt=\"" + (pair.right.text || "").substring(0, 60) + "\"");
                    var d = diffInlineHTML(pair.left.html, pair.right.html);
                    leftParts.push('<div class="git-rev-row">' +
                        _wrapBlock(d.leftHtml, "git-rev-block-del", "旧") + "</div>");
                    rightParts.push('<div class="git-rev-row">' +
                        _wrapBlock(d.rightHtml, "git-rev-block-add", "新") + "</div>");
                    additions++;
                    deletions++;
                    break;
                }

                case "added":
                    leftParts.push('<div class="git-rev-row git-rev-empty"></div>');
                    rightParts.push('<div class="git-rev-row">' +
                        _wrapBlock(pair.right.html, "git-rev-block-add", "新增段落") + "</div>");
                    additions++;
                    break;

                case "deleted":
                    leftParts.push('<div class="git-rev-row">' +
                        _wrapBlock(pair.left.html, "git-rev-block-del", "删除段落") + "</div>");
                    rightParts.push('<div class="git-rev-row git-rev-empty"></div>');
                    deletions++;
                    break;
            }
        }

        return {
            leftHtml: leftParts.join("\n"),
            rightHtml: rightParts.join("\n"),
            stats: {
                additions: additions,
                deletions: deletions
            }
        };
    }

    // ===================================================================
    // 安全渲染：用临时 NodeMap 渲染 markdown → Typora 原生 HTML
    // 不触碰 editor.reset()，避免破坏编辑器内部状态
    // ===================================================================

    function _renderMdToHtml(editor, mdText) {
        var File = window.File;
        var NodeDef = window.NodeDef;
        if (!File || !NodeDef || !File.editor) {
            return "<p>渲染失败：无法访问编辑器内部 API</p>";
        }

        // 获取 NodeMap 构造函数（从编辑器自身的 nodeMap 原型链）
        var NodeMapCtor = File.editor.nodeMap.constructor;

        // 创建临时 NodeMap，与编辑器完全隔离
        var tempNodeMap = new NodeMapCtor();
        var tempNode = new NodeDef({
            type: NodeDef.TYPE.raw_edit,
            in: tempNodeMap,
            attachTo: tempNodeMap,
            text: mdText || ""
        });

        var parsed = tempNode.parseFrom({ skips: { old_code: false } });
        var html = parsed[0] || "";

        // 关键：清除 cid 属性，防止 validateContentForSave 误匹配
        html = html.replace(/\s*cid\s*=\s*['"][^'"]*['"]/gi, "");

        // 清理：删除临时节点从全局 nodePool 中移除
        var blocks = parsed[1] || [];
        for (var i = 0; i < blocks.length; i++) {
            try { blocks[i]._delete(true); } catch (e) {}
        }

        // ── 语法高亮后处理 ──
        // parseFrom 产出的 <pre> 会丢失换行符（lines:1），需要从原始
        // markdown 文本中提取代码围栏内容才能保持正确的多行结构。
        html = _highlightCodeFences(html, mdText);

        return html;
    }

    /**
     * 从原始 markdown 中提取所有围栏代码块，返回 {lang → text} 映射。
     * 返回数组，与 parseFrom 产出的 HTML 中 pre.md-fences 顺序一一对应。
     */
    function _extractFenceTexts(mdText) {
        var result = [];
        if (!mdText) return result;
        // 匹配 ```language\n content \n``` 的围栏代码块
        // 支持可选的 > 前缀（引用块内的代码）
        var re = /^(?:>\s*)?```(\S*)\s*\n([\s\S]*?)\n(?:>\s*)?```/gm;
        var m;
        while ((m = re.exec(mdText)) !== null) {
            var lang = (m[1] || "").trim();
            var code = m[2];
            // 去掉每一行开头的 > 前缀（quote 引用符号）
            code = code.replace(/^>\s?/gm, "");
            // 去掉末尾可能多出的一个换行
            if (code.charAt(code.length - 1) === "\n") {
                code = code.substring(0, code.length - 1);
            }
            result.push({ lang: lang, code: code });
        }
        return result;
    }

    /**
     * 对 HTML 字符串中的所有 <pre class="md-fences"> 代码块做语法高亮后处理。
     *
     * 核心思路：
     *   1. 从原始 markdown 提取代码文本（保留换行，不走 parseFrom 的单行 textContent）
     *   2. 用 CM.getMode() + CM.StringStream 逐 token 做离线高亮
     *   3. 每行输出一个 <pre class="CodeMirror-line">
     *   4. 包裹在 CodeMirror 标准 DOM 结构中（.cm-s-inner .CodeMirror-wrap …）
     *
     * ❌ 不用真实 CM 实例：CM 实例会在 host 上挂 __CM__ 引用，
     *   搬入文档后 Typora 的 getTextInSelection() 访问已销毁实例导致卡死。
     *
     * 若 CodeMirror 完全不可用则返回原 HTML。
     */
    function _highlightCodeFences(html, mdText) {
        // ── 获取 CodeMirror 引用 ──
        var CM = null;
        if (typeof window !== "undefined" && window.CodeMirror) {
            CM = window.CodeMirror;
        }
        if (!CM && typeof require === "function") {
            try { CM = require("codemirror"); } catch (e) {}
        }
        if (!CM || typeof CM.getMode !== "function" || typeof CM.StringStream !== "function") {
            return html;
        }

        // ── 从原始 markdown 中提取代码文本（保留换行）──
        // parseFrom 产出的 HTML 中 fence 的 innerText 已被压缩成单行
        var fenceTexts = _extractFenceTexts(mdText || "");

        var div = document.createElement("div");
        div.innerHTML = html;

        var fences = div.querySelectorAll("pre.md-fences");
        for (var i = 0; i < fences.length; i++) {
            var fence = fences[i];
            var lang = (fence.getAttribute("lang") || "").trim().toLowerCase();
            if (!lang) continue;

            var modeName = _codeMirrorMode(lang);
            if (!modeName) continue;

            // 用原始 markdown 提取的文本（保留换行）
            var code = "";
            if (i < fenceTexts.length) {
                code = fenceTexts[i].code;
            } else {
                // 回退：从 HTML 取（单行，但至少不会卡死）
                var codeEl = fence.querySelector("code");
                code = codeEl ? codeEl.textContent : fence.textContent;
            }
            if (!code) continue;

            try {
                // ── 纯字符串 token 循环（不创建 CM 实例）──
                var modeObj = CM.getMode(CM.defaults || {}, modeName);
                if (!modeObj || typeof modeObj.token !== "function") continue;

                var lines = code.split("\n");
                var state = CM.startState ? CM.startState(modeObj) : null;
                var cmCodeHtml = "";

                for (var li = 0; li < lines.length; li++) {
                    var lineText = lines[li];
                    var lineHtml = "";
                    // 空白行：CodeMirror 的 min-height 靠 .CodeMirror-line 自身的高度撑开，
                    // 但空的 <pre> 高度为 0。给空行一个零宽空格保证行高。
                    if (lineText.length === 0) {
                        // 空行：通知 mode 更新状态（如 python 的缩进上下文）
                        if (modeObj.blankLine && typeof modeObj.blankLine === "function") {
                            modeObj.blankLine(state);
                        }
                        lineHtml = "&#x200B;";
                    } else {
                        var stream = new CM.StringStream(lineText);
                        while (!stream.eol()) {
                            var style = modeObj.token(stream, state);
                            var cur = stream.current();
                            if (style) {
                                // 拆分复合样式（如 "keyword strong"）为独立 class
                                var cls = style.split(/\s+/).map(function (s) {
                                    s = s.replace(/[^\w\-]/g, "");
                                    return s ? "cm-" + s : "";
                                }).filter(Boolean).join(" ");
                                lineHtml += '<span class="' + cls + '">' + _escAttr(cur) + "</span>";
                            } else {
                                lineHtml += _escAttr(cur);
                            }
                            stream.start = stream.pos;
                        }
                    }
                    cmCodeHtml += '<pre class="CodeMirror-line">' + lineHtml + "</pre>";
                }

                // 匹配 Typora CodeMirror 实际 DOM 结构
                fence.innerHTML =
                    '<div class="CodeMirror cm-s-inner CodeMirror-wrap">' +
                    '<div class="CodeMirror-scroll">' +
                    '<div class="CodeMirror-sizer">' +
                    '<div class="CodeMirror-lines">' +
                    '<div class="CodeMirror-code">' +
                    cmCodeHtml +
                    "</div></div></div></div>";

            } catch (e) {
                // 高亮失败则保留原始纯文本
            }
        }

        return div.innerHTML;
    }

    /**
     * 将语言标识映射到 CodeMirror mode 名称。
     * Typora 通过 mode.min.js 加载全部 mode，名称即 require 时用的 mode id。
     */
    function _codeMirrorMode(lang) {
        var MAP = {
            "javascript": "javascript", "js": "javascript",
            "typescript": "javascript", "ts": "javascript",
            "jsx": "jsx", "tsx": "jsx",
            "python": "python", "py": "python",
            "ruby": "ruby", "rb": "ruby",
            "java": "clike",
            "c": "clike", "cpp": "clike", "c++": "clike",
            "csharp": "clike", "cs": "clike",
            "go": "go", "golang": "go",
            "rust": "rust", "rs": "rust",
            "php": "php",
            "swift": "swift",
            "kotlin": "clike", "scala": "clike",
            "html": "htmlmixed", "htm": "htmlmixed",
            "xml": "xml", "svg": "xml",
            "css": "css", "scss": "css", "sass": "css", "less": "css",
            "sql": "sql", "mysql": "sql", "pgsql": "sql",
            "shell": "shell", "bash": "shell", "sh": "shell", "zsh": "shell",
            "powershell": "powershell", "ps1": "powershell",
            "json": "javascript",
            "yaml": "yaml", "yml": "yaml",
            "markdown": "markdown", "md": "markdown",
            "diff": "diff",
            "dockerfile": "dockerfile", "docker": "dockerfile",
            "makefile": "cmake",
            "nginx": "nginx",
            "ini": "properties", "cfg": "properties", "toml": "toml",
            "lua": "lua",
            "r": "r",
            "perl": "perl", "pl": "perl",
            "haskell": "haskell", "hs": "haskell",
            "elm": "elm",
            "erlang": "erlang", "erl": "erlang",
            "clojure": "clojure", "clj": "clojure",
            "dart": "dart",
            "groovy": "groovy",
            "julia": "julia", "jl": "julia",
            "ocaml": "mllike", "ml": "mllike",
            "pascal": "pascal",
            "protobuf": "protobuf", "proto": "protobuf",
            "puppet": "puppet",
            "sass": "sass",
            "scheme": "scheme",
            "smalltalk": "smalltalk",
            "smarty": "smarty",
            "sparql": "sparql",
            "stex": "stex",
            "stylus": "stylus",
            "tcl": "tcl",
            "tiddlywiki": "tiddlywiki",
            "tiki": "tiki",
            "tornado": "tornado",
            "troff": "troff",
            "ttcn": "ttcn",
            "turtle": "turtle",
            "velocity": "velocity",
            "verilog": "verilog",
            "vhdl": "vhdl",
            "vue": "vue",
            "webidl": "webidl",
            "xquery": "xquery",
            "yacas": "yacas",
            "z80": "z80"
        };
        var mode = MAP[lang];
        // 如果不在映射表中，试着用 lang 直接当 mode 名（很多 mode id 同语言名）
        if (!mode) mode = lang;
        return mode;
    }

    /**
     * HTML 属性上下文中的转义（比通用 escapeHtml 更精确）。
     * runMode 输出的文本要放进 HTML attribute / innerHTML，只需要处理 & < >。
     */
    function _escAttr(str) {
        if (!str) return "";
        return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    }

    // ===================================================================
    // 导出
    // ===================================================================

    module.exports = {
        renderRevision: renderRevision,
        _renderMdToHtml: _renderMdToHtml,
        tokenize: tokenize,
        myersDiff: myersDiff,
        parseBlocks: parseBlocks,
        alignBlocks: alignBlocks,
        diffBlockHTML: diffBlockHTML,
        diffInlineHTML: diffInlineHTML,
        _stripHtml: _stripHtml
    };

})();
