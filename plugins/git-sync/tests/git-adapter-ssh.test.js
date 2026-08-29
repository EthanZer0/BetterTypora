/* SSH 远程策略测试：首次主机指纹允许记录，已变化的指纹仍由 OpenSSH 拒绝。 */
"use strict";

var assert = require("assert");
global.reqnode = require;
var GitAdapter = require("../git-adapter");

var adapter = new GitAdapter(console);
var calls = [];
adapter.exec = function (root, args, options) {
    calls.push({ root: root, args: args, options: options });
    return Promise.resolve({ success: true, output: "" });
};

adapter.fetch("/repo", "origin")
    .then(function () { return adapter.push("/repo", "origin", "main"); })
    .then(function () {
        assert.strictEqual(calls.length, 2, "fetch 和 push 都应调用 Git");
        assert.strictEqual(calls[0].options.env.GIT_SSH_COMMAND, "ssh -o StrictHostKeyChecking=accept-new", "fetch 应使用首次 SSH 主机信任策略");
        assert.strictEqual(calls[1].options.env.GIT_SSH_COMMAND, "ssh -o StrictHostKeyChecking=accept-new", "push 应使用首次 SSH 主机信任策略");
        console.log("GitAdapter SSH tests passed");
    })
    .catch(function (error) {
        console.error(error.stack || error.message);
        process.exitCode = 1;
    });
