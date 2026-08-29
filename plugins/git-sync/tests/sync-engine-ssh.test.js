/* SSH 密钥助手测试：只把公钥放入状态，不得泄露私钥。 */
"use strict";

var assert = require("assert");
global.reqnode = require;
var SyncEngine = require("../sync-engine");

var state = { isRepo: true, mode: "unified", root: "/notes", sshPublicKey: "", sshKeyStatus: "" };
var store = {
    get: function () { return state; },
    update: function (patch) {
        var keys = Object.keys(patch || {});
        for (var i = 0; i < keys.length; i++) state[keys[i]] = patch[keys[i]];
    }
};
var adapter = {
    findSshKey: function () { return { found: false, privatePath: "C:/private", publicPath: "C:/public" }; },
    generateSshKey: function () { return Promise.resolve({ success: true, generated: true, info: { found: true, privatePath: "C:/private", publicPath: "C:/public" } }); },
    readSshPublicKey: function () { return Promise.resolve({ success: true, publicKey: "ssh-ed25519 AAAA public-only" }); }
};
var engine = new SyncEngine({}, adapter, {}, store, {}, function () { return "origin"; }, console);
engine._copyText = function (value) {
    assert.strictEqual(value, "ssh-ed25519 AAAA public-only", "剪贴板只能接收公钥");
    return Promise.resolve(true);
};

engine.prepareSshKey()
    .then(function (result) {
        assert.strictEqual(result.success, true, "应能生成并处理 SSH 密钥");
        assert.strictEqual(result.generated, true, "没有默认密钥时应生成新密钥");
        assert.strictEqual(state.sshPublicKey, "ssh-ed25519 AAAA public-only", "状态只能保存公钥");
        assert.strictEqual(state.privatePath, undefined, "私钥路径不得进入状态");
        console.log("SyncEngine SSH helper tests passed");
    })
    .catch(function (error) {
        console.error(error.stack || error.message);
        process.exitCode = 1;
    });
