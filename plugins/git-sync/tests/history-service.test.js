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
        console.log("HistoryService comparison tests passed");
    })
    .catch(function (error) {
        console.error(error.stack || error.message);
        process.exitCode = 1;
    });
