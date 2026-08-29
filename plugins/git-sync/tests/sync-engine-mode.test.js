/* 同步模式测试：本地模式不得发起远程操作，统一模式历史必须带 scope。 */
"use strict";

var assert = require("assert");

global.reqnode = require;
var SyncEngine = require("../sync-engine");

function makeStore(initial) {
    var state = initial;
    return {
        get: function () { return state; },
        update: function (patch) {
            var keys = Object.keys(patch || {});
            for (var i = 0; i < keys.length; i++) state[keys[i]] = patch[keys[i]];
        }
    };
}

var localStore = makeStore({ isRepo: true, mode: "local", root: "/repo", files: [] });
var localEngine = new SyncEngine({}, {}, { isInScope: function () { return true; } }, localStore, {}, function () { return "origin"; }, console);
var captured = null;
localEngine.sync()
    .then(function (result) {
        assert.strictEqual(result.success, false, "本地模式不得执行远程同步");
        assert.ok(/统一笔记仓库/.test(result.error), "本地模式应给出明确提示");
        var unifiedStore = makeStore({ isRepo: true, mode: "unified", scopePath: "projects", root: "/repo" });
        var unifiedEngine = new SyncEngine({}, {}, { isInScope: function () { return true; } }, unifiedStore, {
            load: function (root, limit, paths) { captured = [root, limit, paths]; return Promise.resolve({ success: true }); }
        }, function () { return "origin"; }, console);
        return unifiedEngine.loadHistory();
    })
    .then(function (result) {
        assert.strictEqual(result.success, true, "统一模式应能读取历史");
        assert.deepStrictEqual(captured, ["/repo", 20, ["projects"]], "历史查询必须限制在当前 scope");
        console.log("SyncEngine mode tests passed");
    })
    .catch(function (error) {
        console.error(error.stack || error.message);
        process.exitCode = 1;
    });
