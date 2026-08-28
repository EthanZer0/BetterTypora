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
        this.rows = [];
        this.changeRows = [];
        this.changeIndex = -1;
        this._syncing = false;
        this._keydown = null;
        this._dividerDown = null;
    }

    DiffSession.prototype.isOpen = function () {
        return !!this.el;
    };

    DiffSession.prototype.open = function (model) {
        this.close(false);
        this.rows = buildRows(model.beforeText, model.afterText, model.patch);
        this.changeRows = [];
        for (var i = 0; i < this.rows.length; i++) if (this.rows[i].change) this.changeRows.push(i);

        var root = document.createElement("div");
        root.className = "bt-split-diff-session";
        root.innerHTML =
            '<div class="bt-split-diff-toolbar">' +
            '  <div class="bt-split-diff-title"><span class="bt-split-diff-glyph">↔</span><span title="' + escapeHtml(model.path) + '">' + escapeHtml(fileName(model.path)) + '</span></div>' +
            '  <div class="bt-split-diff-summary">' + this.changeRows.length + ' 处改动</div>' +
            '  <div class="bt-split-diff-actions">' +
            '    <button type="button" data-action="prev" title="上一个改动">↑</button>' +
            '    <button type="button" data-action="next" title="下一个改动">↓</button>' +
            '    <button type="button" data-action="close" title="关闭差异视图">×</button>' +
            "  </div>" +
            "</div>" +
            '<div class="bt-split-diff-columns">' +
            '  <section class="bt-split-diff-pane"><div class="bt-split-diff-pane-title">' + escapeHtml(model.beforeLabel || "HEAD") + '</div><div class="bt-split-diff-body bt-split-diff-left"></div></section>' +
            '  <div class="bt-split-diff-divider" title="拖动调整左右宽度"></div>' +
            '  <section class="bt-split-diff-pane"><div class="bt-split-diff-pane-title">' + escapeHtml(model.afterLabel || "工作区") + '</div><div class="bt-split-diff-body bt-split-diff-right"></div></section>' +
            "</div>";
        document.body.appendChild(root);
        this.el = root;
        this.left = root.querySelector(".bt-split-diff-left");
        this.right = root.querySelector(".bt-split-diff-right");
        this.renderPane(this.left, "left");
        this.renderPane(this.right, "right");
        this.bind();
        if (this.changeRows.length) this.goTo(0);
        return true;
    };

    DiffSession.prototype.renderPane = function (container, side) {
        var fragment = document.createDocumentFragment();
        for (var i = 0; i < this.rows.length; i++) {
            var line = this.rows[i][side];
            var row = document.createElement("div");
            row.className = "bt-split-diff-row is-" + line.kind + (this.rows[i].change ? " is-change" : "");
            row.setAttribute("data-row", String(i));
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
        this.rows = [];
        this.changeRows = [];
        this.changeIndex = -1;
        this._keydown = null;
        this._dividerDown = null;
        if (notify !== false) this.onClose();
    };

    DiffSession.buildRows = buildRows;
    DiffSession.parseHunks = parseHunks;
    if (typeof module !== "undefined") module.exports = DiffSession;
})();
