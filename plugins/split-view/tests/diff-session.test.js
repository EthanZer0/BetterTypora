/* DiffSession 纯数据层测试：无需 Typora 或浏览器 DOM，可直接由 Node 运行。 */
"use strict";

var assert = require("assert");
var DiffSession = require("../diff-session");

function makeText(count, changed) {
    var lines = [];
    for (var i = 1; i <= count; i++) lines.push(changed && changed[i] ? changed[i] : "line " + i);
    return lines.join("\n") + "\n";
}

function countCoveredRows(rows) {
    var count = 0;
    for (var i = 0; i < rows.length; i++) count += rows[i].fold ? rows[i].hiddenCount : 1;
    return count;
}

function testLargeFileFolding() {
    var before = makeText(120);
    var after = makeText(120, { 50: "changed 50" });
    var patch = "@@ -50 +50 @@\n-line 50\n+changed 50";
    var rows = DiffSession.buildRows(before, after, patch);
    var folded = DiffSession.foldRows(rows, 3);
    var folds = folded.filter(function (row) { return row.fold; });
    var changes = folded.filter(function (row) { return row.change; });

    assert.strictEqual(rows.length, 120, "完整模型必须保留全部行");
    assert.strictEqual(folds.length, 2, "改动前后应各产生一个长区间折叠");
    assert.strictEqual(changes.length, 1, "折叠不能丢失改动行");
    assert.strictEqual(countCoveredRows(folded), rows.length, "可见行和折叠占位必须完整覆盖原始行");
    assert.ok(folded.length < rows.length / 10, "大文件默认渲染的行数应显著降低");
}

function testExpandAndShowAll() {
    var before = makeText(80);
    var after = makeText(80, { 40: "changed 40" });
    var rows = DiffSession.buildRows(before, after, "@@ -40 +40 @@\n-line 40\n+changed 40");
    var folded = DiffSession.foldRows(rows, 3);
    var firstFold = folded.filter(function (row) { return row.fold; })[0];
    var expanded = DiffSession.foldRows(rows, 3, [{ start: firstFold.sourceStart, end: firstFold.sourceEnd }]);
    var all = DiffSession.foldRows(rows, 3, [{ start: 0, end: rows.length - 1 }]);

    assert.strictEqual(countCoveredRows(expanded), rows.length, "单段展开后仍需覆盖全部原始行");
    assert.ok(expanded.length > folded.length, "展开指定区间应增加可见行");
    assert.strictEqual(all.length, rows.length, "查看全部必须恢复每一行");
    assert.strictEqual(all.filter(function (row) { return row.fold; }).length, 0, "查看全部时不应保留折叠占位");
}

function testBoundaryChangesAndNoChange() {
    var before = makeText(20);
    var after = makeText(20, { 1: "changed 1", 20: "changed 20" });
    var patch = "@@ -1 +1 @@\n-line 1\n+changed 1\n@@ -20 +20 @@\n-line 20\n+changed 20";
    var rows = DiffSession.buildRows(before, after, patch);
    var folded = DiffSession.foldRows(rows, 3);
    var noChange = DiffSession.foldRows(DiffSession.buildRows("same\n", "same\n", ""), 3);

    assert.strictEqual(folded.filter(function (row) { return row.change; }).length, 2, "首尾改动都必须保留");
    assert.strictEqual(folded.filter(function (row) { return row.fold; }).length, 1, "只应折叠两处改动之间的长区间");
    assert.strictEqual(noChange.length, 1, "无差异文件应原样显示，不应被折叠成占位行");
    assert.strictEqual(noChange[0].fold, undefined, "无差异行不应带折叠标记");
}

testLargeFileFolding();
testExpandAndShowAll();
testBoundaryChangesAndNoChange();
console.log("DiffSession tests passed");
