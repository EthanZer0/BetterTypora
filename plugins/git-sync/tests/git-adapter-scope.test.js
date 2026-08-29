/* 统一仓库快照测试：提交和状态查询不能带上其他工作区的改动。 */
"use strict";

var assert = require("assert");
var fs = require("fs");
var os = require("os");
var path = require("path");

global.reqnode = require;
var GitAdapter = require("../git-adapter");
var adapter = new GitAdapter(console);
var root = fs.mkdtempSync(path.join(os.tmpdir(), "bettertypora-git-scope-"));

function cleanup() { fs.rmSync(root, { recursive: true, force: true }); }

adapter.init(root)
    .then(function (result) {
        assert.strictEqual(result.success, true, "应能初始化临时 Git 仓库");
        return adapter.exec(root, ["config", "user.name", "BetterTypora Test"]);
    })
    .then(function () { return adapter.exec(root, ["config", "user.email", "test@example.invalid"]); })
    .then(function () {
        fs.mkdirSync(path.join(root, "projects"), { recursive: true });
        fs.mkdirSync(path.join(root, "daily"), { recursive: true });
        fs.writeFileSync(path.join(root, "projects", "a.md"), "第一版\n");
        fs.writeFileSync(path.join(root, "daily", "b.md"), "第一版\n");
        return adapter.addAll(root);
    })
    .then(function () { return adapter.commit(root, "initial"); })
    .then(function (result) {
        assert.strictEqual(result.success, true, "应能创建初始提交");
        fs.writeFileSync(path.join(root, "projects", "a.md"), "项目改动\n");
        fs.writeFileSync(path.join(root, "daily", "b.md"), "日记改动\n");
        return adapter.status(root, "projects");
    })
    .then(function (result) {
        assert.strictEqual(result.status.files.length, 1, "统一模式状态只应读取当前 scope");
        assert.strictEqual(result.status.files[0].path, "projects/a.md", "状态路径应保持仓库相对路径");
        return adapter.addAll(root, ["projects"]);
    })
    .then(function () { return adapter.commit(root, "projects snapshot", ["projects"]); })
    .then(function (result) {
        assert.strictEqual(result.success, true, "scope 内改动应能独立提交");
        return adapter.exec(root, ["show", "--format=", "--name-only", "HEAD"]);
    })
    .then(function (result) {
        assert.strictEqual(result.output.trim(), "projects/a.md", "提交不得包含其他工作区的文件");
        return adapter.status(root);
    })
    .then(function (result) {
        assert.strictEqual(result.status.files.length, 1, "其他 scope 的改动应保持未提交");
        assert.strictEqual(result.status.files[0].path, "daily/b.md", "其他 scope 不得被隐式快照");
        cleanup();
        console.log("GitAdapter scoped snapshot tests passed");
    })
    .catch(function (error) {
        cleanup();
        console.error(error.stack || error.message);
        process.exitCode = 1;
    });
