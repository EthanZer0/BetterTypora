/* SyncEngine 比较模式测试：默认快照对工作区，审计模式对前一快照。 */
"use strict";

var assert = require("assert");
global.reqnode = require;
var SyncEngine = require("../sync-engine");

var state = {
    root: "/repo",
    isRepo: true,
    historyDetail: { hash: "snapshot", compareMode: "worktree", files: [{ path: "笔记.md", code: "M" }] }
};
var calls = [];
var store = {
    get: function () { return state; },
    update: function (patch) {
        var keys = Object.keys(patch || {});
        for (var i = 0; i < keys.length; i++) state[keys[i]] = patch[keys[i]];
    }
};
var history = {
    compareSnapshotToWorktree: function () {
        calls.push("worktree");
        return Promise.resolve({ success: true, beforeMissing: false, isBinary: false });
    },
    compareSnapshotFile: function () {
        calls.push("parent");
        return Promise.resolve({ success: true, afterMissing: false, isBinary: false, displayOrder: "reverse" });
    }
};
var engine = new SyncEngine({}, {}, {}, store, history, function () {}, console);
engine._openDiffModel = function (model) { calls.push(model); return { success: true }; };

engine.openSnapshotDiff("snapshot", "笔记.md")
    .then(function (result) {
        assert.strictEqual(result.success, true, "默认模式应能打开比较");
        assert.strictEqual(calls[0], "worktree", "默认应比较选中快照与工作区");
        assert.strictEqual(calls[1].restore.mode, "restore", "默认模式恢复来源应为选中快照");
        assert.strictEqual(engine.setSnapshotCompareMode("parent").mode, "parent", "应能切换至审计模式");
        return engine.openSnapshotDiff("snapshot", "笔记.md");
    })
    .then(function (result) {
        assert.strictEqual(result.success, true, "审计模式应能打开比较");
        assert.strictEqual(calls[2], "parent", "审计模式应比较选中快照与前一快照");
        assert.strictEqual(calls[3].restore.mode, "restore", "审计模式恢复来源仍应为选中快照");
        console.log("SyncEngine comparison mode tests passed");
    })
    .catch(function (error) {
        console.error(error.stack || error.message);
        process.exitCode = 1;
    });
