/* SyncEngine 恢复流程测试：验证活动文件保护与成功恢复后的刷新。 */
"use strict";

var assert = require("assert");

global.reqnode = require;
var SyncEngine = require("../sync-engine");

function makeEngine(options) {
    var state = {
        root: "/repo",
        isRepo: true,
        currentFile: "/repo/笔记.md",
        historyDetail: { hash: "snapshot", files: [{ path: "笔记.md", code: "M" }] }
    };
    var calls = { saved: 0, removed: 0, written: 0, reloaded: 0, refreshed: 0 };
    var store = {
        get: function () { return state; },
        update: function (patch) {
            var keys = Object.keys(patch || {});
            for (var i = 0; i < keys.length; i++) state[keys[i]] = patch[keys[i]];
        }
    };
    var api = {
        getCurrentFile: function () { return "/repo/笔记.md"; },
        saveFileAndWait: function () { calls.saved++; return Promise.resolve({ success: true }); },
        reloadFile: function () { calls.reloaded++; return true; }
    };
    var adapter = {
        removeWorktreeFile: function () { calls.removed++; return Promise.resolve({ success: true }); },
        writeWorktreeFile: function (root, filePath, content) {
            calls.written++;
            calls.content = content;
            return Promise.resolve({ success: true });
        }
    };
    var history = {
        readSnapshotFile: function () {
            return Promise.resolve(options.deleted
                ? { success: true, missing: true, output: "" }
                : { success: true, missing: false, output: "已恢复\n" });
        }
    };
    var engine = new SyncEngine(api, adapter, {}, store, history, function () {}, console);
    engine._refresh = function () { calls.refreshed++; return Promise.resolve({ success: true }); };
    return { engine: engine, calls: calls };
}

var deleted = makeEngine({ deleted: true });
deleted.engine.restoreSnapshotFile("snapshot", "笔记.md")
    .then(function (result) {
        assert.strictEqual(result.success, false, "不能删除当前正在编辑的文件");
        assert.strictEqual(deleted.calls.saved, 0, "拒绝删除前不应额外保存当前文件");
        assert.strictEqual(deleted.calls.removed, 0, "拒绝删除前不应执行删除");
        var restored = makeEngine({ deleted: false });
        return restored.engine.restoreSnapshotFile("snapshot", "笔记.md").then(function (result) {
            assert.strictEqual(result.success, true, "应能恢复快照中的文件");
            assert.strictEqual(restored.calls.saved, 1, "恢复当前文件前应先保存编辑器内容");
            assert.strictEqual(restored.calls.written, 1, "应将快照内容写回工作区");
            assert.strictEqual(restored.calls.content, "已恢复\n", "写回内容必须来自快照");
            assert.strictEqual(restored.calls.refreshed, 1, "恢复后应刷新 Git 状态");
            assert.strictEqual(restored.calls.reloaded, 1, "恢复后应重载当前编辑器文件");
            console.log("SyncEngine restore tests passed");
        });
    })
    .catch(function (error) {
        console.error(error.stack || error.message);
        process.exitCode = 1;
    });
