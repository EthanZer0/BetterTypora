/* HistoryService 比较语义测试：选中快照在左，当前工作区在右。 */
"use strict";

var assert = require("assert");
var HistoryService = require("../history-service");

var calls = [];
var adapter = {
    show: function (root, revision, filePath) {
        calls.push(["show", root, revision, filePath]);
        return Promise.resolve({ success: true, output: "快照内容\n" });
    },
    readWorktreeFile: function (root, filePath) {
        calls.push(["worktree", root, filePath]);
        return Promise.resolve({ success: true, output: "工作区内容\n" });
    },
    revisionWorktreeDiffPatch: function (root, revision, filePath) {
        calls.push(["patch", root, revision, filePath]);
        return Promise.resolve({ success: true, output: "@@ -1 +1 @@\n-快照内容\n+工作区内容" });
    },
    commitParent: function () {
        return Promise.resolve({ success: true, parent: "parent123" });
    },
    commitDiffPatch: function () {
        return Promise.resolve({ success: true, output: "@@ -1 +1 @@\n-父快照\n+快照内容" });
    }
};
var service = new HistoryService(adapter, {});

service.compareSnapshotToWorktree("/repo", "abcdef123", { path: "笔记.md", code: "M" })
    .then(function (model) {
        assert.strictEqual(model.success, true, "应返回比较模型");
        assert.strictEqual(model.beforeText, "快照内容\n", "左栏内容应来自选中快照");
        assert.strictEqual(model.afterText, "工作区内容\n", "右栏内容应来自当前工作区");
        assert.strictEqual(model.beforeLabel, "选中快照 · abcdef1", "左栏标题应标识选中快照");
        assert.strictEqual(model.afterLabel, "工作区", "右栏标题应标识工作区");
        assert.deepStrictEqual(calls, [
            ["show", "/repo", "abcdef123", "笔记.md"],
            ["worktree", "/repo", "笔记.md"],
            ["patch", "/repo", "abcdef123", "笔记.md"]
        ], "应以选中快照到工作区的顺序读取和构造补丁");
        return service.compareSnapshotFile("/repo", "abcdef123", { path: "笔记.md", code: "M" });
    })
    .then(function (model) {
        assert.strictEqual(model.displayOrder, "reverse", "历史审计模式也应将选中快照显示在左栏");
        assert.strictEqual(model.modeLabel, "选中快照 · 前一快照", "历史审计模式应有明确标题");
        var binaryService = new HistoryService({
            show: function () { return Promise.resolve({ success: true, binary: true, output: "" }); },
            readWorktreeFile: function () { return Promise.resolve({ success: true, binary: true, output: "" }); },
            diffPatch: function () { return Promise.resolve({ success: true, output: "Binary files differ" }); }
        }, {});
        return binaryService.compareFile("/repo", "附件.png", { code: "M" });
    })
    .then(function (model) {
        assert.strictEqual(model.isBinary, true, "二进制文件应标记为不可行级比较");
        assert.ok(model.unavailableReason, "二进制文件应返回明确提示");
        console.log("HistoryService comparison tests passed");
    })
    .catch(function (error) {
        console.error(error.stack || error.message);
        process.exitCode = 1;
    });
