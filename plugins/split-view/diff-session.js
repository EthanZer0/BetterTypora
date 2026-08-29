/*
 * DiffSession — 分屏插件的只读源码比较会话。
 *
 * 它不接管 Typora 的全局源码编辑器，也不触碰 tabs 的右栏标签栈；
 * 只在现有界面之上临时创建一组左右源码栏，关闭后直接移除，因此普通
 * 分屏和编辑器状态无需重建。
 */
(function () {
    "use strict";

    function escapeHtml(value) {
        return String(value == null ? "" : value)
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/\"/g, "&quot;");
    }

    function linesOf(text) {
        var value = String(text || "").replace(/\r\n/g, "\n");
        if (!value) return [];
        var lines = value.split("\n");
        if (lines.length && lines[lines.length - 1] === "") lines.pop();
        return lines;
    }

    function parseHunks(patch) {
        var lines = String(patch || "").split("\n");
        var hunks = [];
        var current = null;
        for (var i = 0; i < lines.length; i++) {
            var match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(lines[i]);
            if (match) {
                current = {
                    oldStart: parseInt(match[1], 10),
                    oldCount: match[2] === undefined ? 1 : parseInt(match[2], 10),
                    newStart: parseInt(match[3], 10),
                    newCount: match[4] === undefined ? 1 : parseInt(match[4], 10),
                    lines: []
                };
                hunks.push(current);
                continue;
            }
            if (current && /^[ +\-]/.test(lines[i]) && lines[i].indexOf("--- ") !== 0 && lines[i].indexOf("+++ ") !== 0) {
                current.lines.push(lines[i]);
            }
        }
        return hunks;
    }

    function blank(kind) {
        return { number: null, text: "", kind: kind || "blank" };
    }

    function makeLine(number, text, kind) {
        return { number: number, text: text == null ? "" : text, kind: kind || "context" };
    }

    function addContext(rows, before, after, oldIndex, newIndex, oldStop, newStop) {
        while (oldIndex.value < oldStop && newIndex.value < newStop) {
            rows.push({
                left: makeLine(oldIndex.value + 1, before[oldIndex.value], "context"),
                right: makeLine(newIndex.value + 1, after[newIndex.value], "context"),
                change: false
            });
            oldIndex.value++;
            newIndex.value++;
        }
    }

    function flushChangeGroup(rows, removed, added, oldIndex, newIndex) {
        var count = Math.max(removed.length, added.length);
        for (var i = 0; i < count; i++) {
            var hasLeft = i < removed.length;
            var hasRight = i < added.length;
            var modified = hasLeft && hasRight;
            rows.push({
                left: hasLeft ? makeLine(oldIndex.value + 1, removed[i], modified ? "modified" : "removed") : blank("blank"),
                right: hasRight ? makeLine(newIndex.value + 1, added[i], modified ? "modified" : "added") : blank("blank"),
                change: true
            });
            if (hasLeft) oldIndex.value++;
            if (hasRight) newIndex.value++;
        }
    }

    function buildFallback(before, after) {
        var rows = [];
        var count = Math.max(before.length, after.length);
        for (var i = 0; i < count; i++) {
            var left = i < before.length ? before[i] : null;
            var right = i < after.length ? after[i] : null;
            var same = left === right;
            rows.push({
                left: left === null ? blank("blank") : makeLine(i + 1, left, same ? "context" : "removed"),
                right: right === null ? blank("blank") : makeLine(i + 1, right, same ? "context" : "added"),
                change: !same
            });
        }
        return rows;
    }

    function buildRows(beforeText, afterText, patch) {
        var before = linesOf(beforeText);
        var after = linesOf(afterText);
        var hunks = parseHunks(patch);
        if (!hunks.length) {
            if (beforeText === afterText) return buildFallback(before, after);
            return buildFallback(before, after);
        }

        var rows = [];
        var oldIndex = { value: 0 };
        var newIndex = { value: 0 };
        for (var h = 0; h < hunks.length; h++) {
            var hunk = hunks[h];
            // 零行 hunk 的起点表示“插入/删除发生在该行之后”，与常规
            // hunk 的“从该行开始替换”语义不同，需保留其前一行上下文。
            var oldTarget = hunk.oldCount === 0 ? hunk.oldStart : (hunk.oldStart > 0 ? hunk.oldStart - 1 : 0);
            var newTarget = hunk.newCount === 0 ? hunk.newStart : (hunk.newStart > 0 ? hunk.newStart - 1 : 0);
            addContext(rows, before, after, oldIndex, newIndex, oldTarget, newTarget);

            var removed = [];
            var added = [];
            for (var i = 0; i < hunk.lines.length; i++) {
                var line = hunk.lines[i];
                if (line.charAt(0) === "-") {
                    removed.push(line.substring(1));
                    continue;
                }
                if (line.charAt(0) === "+") {
                    added.push(line.substring(1));
                    continue;
                }
                flushChangeGroup(rows, removed, added, oldIndex, newIndex);
                removed = [];
                added = [];
                rows.push({
                    left: makeLine(oldIndex.value + 1, before[oldIndex.value], "context"),
                    right: makeLine(newIndex.value + 1, after[newIndex.value], "context"),
                    change: false
                });
                oldIndex.value++;
                newIndex.value++;
            }
            flushChangeGroup(rows, removed, added, oldIndex, newIndex);
        }
        addContext(rows, before, after, oldIndex, newIndex, before.length, after.length);
        return rows;
    }

    /*
     * Git patch 必须按“旧 → 新”构造行模型；展示层可在不破坏 hunk、行号和
     * 折叠计算的前提下交换左右栏，用于“用户选择的主体｜参照版本”。
     */
    function swapRows(rows) {
        var swapped = [];
        for (var i = 0; i < rows.length; i++) {
            swapped.push({
                left: rows[i].right,
                right: rows[i].left,
                change: rows[i].change
            });
        }
        return swapped;
    }

    /*
     * 将长的未变化区间收起为一行占位。完整行模型仍保留在内存中，
     * 因此展开后行号和导航目标不会重新计算或产生跳变。
     */
    function foldRows(rows, contextLines, expandedRanges) {
        var context = typeof contextLines === "number" ? contextLines : 3;
        var minimum = context * 2 + 1;
        var keep = [];
        var ranges = expandedRanges || [];
        var i;
        var hasChange = false;
        for (i = 0; i < rows.length; i++) keep[i] = false;
        for (i = 0; i < rows.length; i++) {
            if (!rows[i].change) continue;
            hasChange = true;
            var start = Math.max(0, i - context);
            var end = Math.min(rows.length - 1, i + context);
            for (var j = start; j <= end; j++) keep[j] = true;
        }
        // 没有文本改动时保留原样，避免把“无差异”误显示为一条折叠占位。
        if (!hasChange) {
            var unchanged = [];
            for (i = 0; i < rows.length; i++) unchanged.push(copyRow(rows[i], i));
            return unchanged;
        }
        for (i = 0; i < ranges.length; i++) {
            var range = ranges[i];
            var rangeStart = Math.max(0, range.start || 0);
            var rangeEnd = Math.min(rows.length - 1, range.end == null ? rows.length - 1 : range.end);
            for (var k = rangeStart; k <= rangeEnd; k++) keep[k] = true;
        }

        var visible = [];
        i = 0;
        while (i < rows.length) {
            if (keep[i]) {
                visible.push(copyRow(rows[i], i));
                i++;
                continue;
            }
            var hiddenStart = i;
            while (i < rows.length && !keep[i]) i++;
            var hiddenEnd = i - 1;
            if (hiddenEnd - hiddenStart + 1 < minimum) {
                for (var m = hiddenStart; m <= hiddenEnd; m++) visible.push(copyRow(rows[m], m));
                continue;
            }
            visible.push(makeFoldRow(rows, hiddenStart, hiddenEnd));
        }
        return visible;
    }

    function copyRow(row, sourceRow) {
        return { left: row.left, right: row.right, change: row.change, sourceRow: sourceRow };
    }

    function makeFoldRow(rows, start, end) {
        return {
            fold: true,
            change: false,
            sourceStart: start,
            sourceEnd: end,
            hiddenCount: end - start + 1,
            left: blank("fold"),
            right: blank("fold")
        };
    }

    function foldLabel(row, rows, side) {
        var start = row.sourceStart;
        var end = row.sourceEnd;
        var first = rows[start] || null;
        var last = rows[end] || null;
        var firstNumber = first && first[side] ? first[side].number : null;
        var lastNumber = last && last[side] ? last[side].number : null;
        var range = firstNumber === null || lastNumber === null ? "" : "（" + firstNumber + "–" + lastNumber + "）";
        return "展开 " + row.hiddenCount + " 行未变化内容" + range;
    }

    function fileName(filePath) {
        var value = String(filePath || "").replace(/\\/g, "/");
        var index = value.lastIndexOf("/");
        return index >= 0 ? value.substring(index + 1) : value;
    }

    function DiffSession(options) {
        options = options || {};
        this.onClose = options.onClose || function () {};
        this.el = null;
        this.left = null;
        this.right = null;
        this.allRows = [];
        this.rows = [];
        this.changeRows = [];
        this.expandedRanges = [];
        this.contextLines = 3;
        this.changeIndex = -1;
        this.activeSourceRow = null;
        this.restore = null;
        this.restoreBusy = false;
        this._syncing = false;
        this._keydown = null;
        this._dividerDown = null;
    }

    DiffSession.prototype.isOpen = function () {
        return !!this.el;
    };

    DiffSession.prototype.open = function (model) {
        this.close(false);
        this.allRows = buildRows(model.beforeText, model.afterText, model.patch);
        var reverseDisplay = model.displayOrder === "reverse";
        if (reverseDisplay) this.allRows = swapRows(this.allRows);
        this.rows = [];
        this.expandedRanges = [];
        this.restore = model.restore || null;
        this.restoreBusy = false;
        var restoreButton = this.restore
            ? '    <button type="button" data-action="restore" title="将此文件恢复到当前工作区">↺</button>'
            : "";

        var root = document.createElement("div");
        root.className = "bt-split-diff-session";
        root.innerHTML =
            '<div class="bt-split-diff-toolbar">' +
            '  <div class="bt-split-diff-title"><span class="bt-split-diff-glyph">↔</span><span title="' + escapeHtml(model.path) + '">' + escapeHtml(fileName(model.path)) + '</span></div>' +
            '  <div class="bt-split-diff-summary"></div>' +
            '  <div class="bt-split-diff-actions">' +
            '    <button type="button" data-action="prev" title="上一个改动">↑</button>' +
            '    <button type="button" data-action="next" title="下一个改动">↓</button>' +
            '    <button type="button" data-action="show-all" title="显示全部未变化内容">≡</button>' +
            restoreButton +
            '    <button type="button" data-action="close" title="关闭差异视图">×</button>' +
            "  </div>" +
            "</div>" +
            '<div class="bt-split-diff-columns">' +
            '  <section class="bt-split-diff-pane"><div class="bt-split-diff-pane-title">' + escapeHtml(reverseDisplay ? (model.afterLabel || "工作区") : (model.beforeLabel || "HEAD")) + '</div><div class="bt-split-diff-body bt-split-diff-left"></div></section>' +
            '  <div class="bt-split-diff-divider" title="拖动调整左右宽度"></div>' +
            '  <section class="bt-split-diff-pane"><div class="bt-split-diff-pane-title">' + escapeHtml(reverseDisplay ? (model.beforeLabel || "HEAD") : (model.afterLabel || "工作区")) + '</div><div class="bt-split-diff-body bt-split-diff-right"></div></section>' +
            "</div>" +
            '<div class="bt-split-diff-confirm" hidden><div class="bt-split-diff-confirm-card"><div class="bt-split-diff-confirm-title">恢复此文件？</div><div class="bt-split-diff-confirm-text"></div><div class="bt-split-diff-confirm-error" hidden></div><div class="bt-split-diff-confirm-actions"><button type="button" data-action="cancel-restore">取消</button><button type="button" class="bt-split-diff-confirm-primary" data-action="confirm-restore">确认恢复</button></div></div></div>';
        document.body.appendChild(root);
        this.el = root;
        this.left = root.querySelector(".bt-split-diff-left");
        this.right = root.querySelector(".bt-split-diff-right");
        this.rebuildRows();
        this.bind();
        if (this.changeRows.length) this.goTo(0);
        return true;
    };

    DiffSession.prototype.renderPane = function (container, side) {
        container.textContent = "";
        var fragment = document.createDocumentFragment();
        for (var i = 0; i < this.rows.length; i++) {
            var row = document.createElement("div");
            var source = this.rows[i];
            var line = source[side];
            if (source.fold) {
                row.className = "bt-split-diff-row is-fold";
                row.setAttribute("data-row", String(i));
                var expand = document.createElement("button");
                expand.type = "button";
                expand.className = "bt-split-diff-fold-button";
                expand.setAttribute("data-action", "expand");
                expand.setAttribute("data-start", String(source.sourceStart));
                expand.setAttribute("data-end", String(source.sourceEnd));
                expand.textContent = foldLabel(source, this.allRows, side);
                row.appendChild(expand);
                fragment.appendChild(row);
                continue;
            }
            row.className = "bt-split-diff-row is-" + line.kind + (source.change ? " is-change" : "");
            row.setAttribute("data-row", String(i));
            row.setAttribute("data-source-row", String(source.sourceRow));
            var number = document.createElement("span");
            number.className = "bt-split-diff-line-number";
            number.textContent = line.number === null ? "" : String(line.number);
            var code = document.createElement("code");
            code.className = "bt-split-diff-code";
            code.textContent = line.text;
            row.appendChild(number);
            row.appendChild(code);
            fragment.appendChild(row);
        }
        container.appendChild(fragment);
    };

    DiffSession.prototype.rebuildRows = function () {
        this.rows = foldRows(this.allRows, this.contextLines, this.expandedRanges);
        this.changeRows = [];
        for (var i = 0; i < this.rows.length; i++) if (this.rows[i].change) this.changeRows.push(i);
        if (this.el) {
            this.renderPane(this.left, "left");
            this.renderPane(this.right, "right");
            this.updateSummary();
            this.restoreActiveChange();
        }
    };

    DiffSession.prototype.restoreActiveChange = function () {
        if (this.activeSourceRow === null) return;
        for (var i = 0; i < this.changeRows.length; i++) {
            var rowIndex = this.changeRows[i];
            if (this.rows[rowIndex].sourceRow !== this.activeSourceRow) continue;
            this.changeIndex = i;
            this.setActive(rowIndex, true);
            return;
        }
        this.activeSourceRow = null;
        this.changeIndex = -1;
    };

    DiffSession.prototype.updateSummary = function () {
        if (!this.el) return;
        var summary = this.el.querySelector(".bt-split-diff-summary");
        if (!summary) return;
        var hidden = 0;
        for (var i = 0; i < this.rows.length; i++) if (this.rows[i].fold) hidden += this.rows[i].hiddenCount;
        summary.textContent = this.changeRows.length + " 处改动" + (hidden ? " · 已折叠 " + hidden + " 行" : "");
    };

    DiffSession.prototype.expandRange = function (start, end) {
        if (isNaN(start) || isNaN(end)) return;
        var scrollTop = this.left ? this.left.scrollTop : 0;
        this.expandedRanges.push({ start: start, end: end });
        this.rebuildRows();
        var target = this.left ? this.left.querySelector('[data-source-row="' + start + '"]') : null;
        if (target) {
            var top = Math.max(0, target.offsetTop - 22);
            this.left.scrollTop = top;
            this.right.scrollTop = top;
        } else if (this.left) {
            this.left.scrollTop = scrollTop;
            this.right.scrollTop = scrollTop;
        }
    };

    DiffSession.prototype.showAll = function () {
        if (this.expandedRanges.length === 1 && this.expandedRanges[0].start === 0 && this.expandedRanges[0].end === this.allRows.length - 1) return;
        var scrollTop = this.left ? this.left.scrollTop : 0;
        this.expandedRanges = [{ start: 0, end: this.allRows.length - 1 }];
        this.rebuildRows();
        if (this.left) {
            this.left.scrollTop = scrollTop;
            this.right.scrollTop = scrollTop;
        }
    };

    DiffSession.prototype.showRestoreConfirm = function () {
        if (!this.restore || !this.el) return;
        var dialog = this.el.querySelector(".bt-split-diff-confirm");
        var text = this.el.querySelector(".bt-split-diff-confirm-text");
        if (!dialog || !text) return;
        var error = this.el.querySelector(".bt-split-diff-confirm-error");
        var button = this.el.querySelector('[data-action="confirm-restore"]');
        this.restoreBusy = false;
        if (error) {
            error.hidden = true;
            error.textContent = "";
        }
        if (button) {
            button.disabled = false;
            button.textContent = "确认恢复";
        }
        var name = fileName(this.restore.filePath);
        text.textContent = this.restore.mode === "delete"
            ? "该快照中「" + name + "」已被删除。确认后将从当前工作区删除此文件。"
            : "确认后将用该快照中的「" + name + "」替换当前工作区版本。当前未提交改动会被覆盖。";
        dialog.hidden = false;
    };

    DiffSession.prototype.hideRestoreConfirm = function () {
        if (!this.el) return;
        var dialog = this.el.querySelector(".bt-split-diff-confirm");
        if (dialog) dialog.hidden = true;
    };

    DiffSession.prototype.confirmRestore = function () {
        var self = this;
        if (!this.restore || this.restoreBusy) return;
        var registry = window.BetterTypora && window.BetterTypora.commands;
        if (!registry || !registry.has || !registry.has("git-sync:restore-snapshot-file")) {
            this.setRestoreError("Git 恢复功能不可用");
            return;
        }
        this.restoreBusy = true;
        var button = this.el.querySelector('[data-action="confirm-restore"]');
        if (button) {
            button.disabled = true;
            button.textContent = "正在恢复…";
        }
        var result = registry.execute("git-sync:restore-snapshot-file", this.restore.revision, this.restore.filePath);
        Promise.resolve(result).then(function (restored) {
            if (restored && restored.success) {
                self.close(false);
                return;
            }
            self.setRestoreError(restored && restored.error ? restored.error : "恢复失败，请重试");
        }).catch(function (error) {
            self.setRestoreError(error && error.message ? error.message : "恢复失败，请重试");
        });
    };

    DiffSession.prototype.setRestoreError = function (message) {
        if (!this.el) return;
        this.restoreBusy = false;
        var error = this.el.querySelector(".bt-split-diff-confirm-error");
        var button = this.el.querySelector('[data-action="confirm-restore"]');
        if (error) {
            error.textContent = message;
            error.hidden = false;
        }
        if (button) {
            button.disabled = false;
            button.textContent = "确认恢复";
        }
    };

    DiffSession.prototype.bind = function () {
        var self = this;
        this.left.addEventListener("scroll", function () { self.syncScroll(self.left, self.right); }, { passive: true });
        this.right.addEventListener("scroll", function () { self.syncScroll(self.right, self.left); }, { passive: true });
        this.el.addEventListener("click", function (event) {
            var target = event.target;
            while (target && target !== self.el && !target.getAttribute("data-action")) target = target.parentNode;
            if (!target || target === self.el) return;
            var action = target.getAttribute("data-action");
            if (action === "close") self.close();
            else if (action === "prev") self.goTo(self.changeIndex - 1);
            else if (action === "next") self.goTo(self.changeIndex + 1);
            else if (action === "show-all") self.showAll();
            else if (action === "expand") self.expandRange(parseInt(target.getAttribute("data-start"), 10), parseInt(target.getAttribute("data-end"), 10));
            else if (action === "restore") self.showRestoreConfirm();
            else if (action === "cancel-restore") self.hideRestoreConfirm();
            else if (action === "confirm-restore") self.confirmRestore();
        });
        this._keydown = function (event) {
            if (!self.el) return;
            if (event.key === "Escape") {
                event.preventDefault();
                self.close();
            } else if (event.altKey && event.key === "ArrowUp") {
                event.preventDefault();
                self.goTo(self.changeIndex - 1);
            } else if (event.altKey && event.key === "ArrowDown") {
                event.preventDefault();
                self.goTo(self.changeIndex + 1);
            }
        };
        document.addEventListener("keydown", this._keydown, true);
        this.installDivider();
    };

    DiffSession.prototype.syncScroll = function (from, to) {
        if (this._syncing) return;
        this._syncing = true;
        to.scrollTop = from.scrollTop;
        this._syncing = false;
    };

    DiffSession.prototype.goTo = function (index) {
        if (!this.changeRows.length) return;
        if (index < 0) index = this.changeRows.length - 1;
        if (index >= this.changeRows.length) index = 0;
        var old = this.changeRows[this.changeIndex];
        if (old !== undefined) this.setActive(old, false);
        this.changeIndex = index;
        var rowIndex = this.changeRows[index];
        this.activeSourceRow = this.rows[rowIndex].sourceRow;
        this.setActive(rowIndex, true);
        var target = this.left.querySelector('[data-row="' + rowIndex + '"]');
        if (target) {
            var top = Math.max(0, target.offsetTop - Math.max(0, this.left.clientHeight / 2 - target.offsetHeight / 2));
            this.left.scrollTop = top;
            this.right.scrollTop = top;
        }
    };

    DiffSession.prototype.setActive = function (rowIndex, active) {
        var nodes = this.el ? this.el.querySelectorAll('[data-row="' + rowIndex + '"]') : [];
        for (var i = 0; i < nodes.length; i++) nodes[i].classList.toggle("is-current-change", active);
    };

    DiffSession.prototype.installDivider = function () {
        var self = this;
        var divider = this.el.querySelector(".bt-split-diff-divider");
        this._dividerDown = function (event) {
            event.preventDefault();
            var columns = self.el.querySelector(".bt-split-diff-columns");
            var leftPane = columns.querySelector(".bt-split-diff-pane");
            var startX = event.clientX;
            var startWidth = leftPane.getBoundingClientRect().width;
            var total = columns.getBoundingClientRect().width;
            divider.classList.add("dragging");
            function move(moveEvent) {
                var width = Math.max(240, Math.min(total - 244, startWidth + moveEvent.clientX - startX));
                leftPane.style.flex = "0 0 " + width + "px";
            }
            function up() {
                divider.classList.remove("dragging");
                document.removeEventListener("mousemove", move);
                document.removeEventListener("mouseup", up);
            }
            document.addEventListener("mousemove", move);
            document.addEventListener("mouseup", up);
        };
        divider.addEventListener("mousedown", this._dividerDown);
    };

    DiffSession.prototype.close = function (notify) {
        if (!this.el) return;
        if (this._keydown) document.removeEventListener("keydown", this._keydown, true);
        var divider = this.el.querySelector(".bt-split-diff-divider");
        if (divider && this._dividerDown) divider.removeEventListener("mousedown", this._dividerDown);
        if (this.el.parentNode) this.el.parentNode.removeChild(this.el);
        this.el = null;
        this.left = null;
        this.right = null;
        this.allRows = [];
        this.rows = [];
        this.changeRows = [];
        this.expandedRanges = [];
        this.changeIndex = -1;
        this.activeSourceRow = null;
        this.restore = null;
        this.restoreBusy = false;
        this._keydown = null;
        this._dividerDown = null;
        if (notify !== false) this.onClose();
    };

    DiffSession.buildRows = buildRows;
    DiffSession.swapRows = swapRows;
    DiffSession.foldRows = foldRows;
    DiffSession.parseHunks = parseHunks;
    if (typeof module !== "undefined") module.exports = DiffSession;
})();
