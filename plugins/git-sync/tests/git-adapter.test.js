/* GitAdapter 恢复写入测试：在系统临时目录运行，不触碰项目工作区。 */
"use strict";

var assert = require("assert");
var fs = require("fs");
var os = require("os");
var path = require("path");

global.reqnode = require;
var GitAdapter = require("../git-adapter");
var adapter = new GitAdapter(console);
var tempBase = process.env.BETTERTYPORA_TEST_TMP || os.tmpdir();
var root = fs.mkdtempSync(path.join(tempBase, "bettertypora-restore-"));

function cleanup() {
    fs.rmSync(root, { recursive: true, force: true });
}

adapter.writeWorktreeFile(root, "笔记/恢复.md", "第一版\n")
    .then(function (result) {
        assert.strictEqual(result.success, true, "应能创建嵌套恢复文件");
        return adapter.writeWorktreeFile(root, "笔记/恢复.md", "第二版\n");
    })
    .then(function (result) {
        assert.strictEqual(result.success, true, "应能原子替换已有文件");
        return adapter.readWorktreeFile(root, "笔记/恢复.md");
    })
    .then(function (result) {
        assert.strictEqual(result.success, true, "应能读取恢复后的文件");
        assert.strictEqual(result.output, "第二版\n", "恢复内容应完整写入");
        return adapter.writeWorktreeFile(root, "../越界.md", "不应写入");
    })
    .then(function (result) {
        assert.strictEqual(result.success, false, "越出工作区的路径必须被拒绝");
        return adapter.removeWorktreeFile(root, "笔记/恢复.md");
    })
    .then(function (result) {
        assert.strictEqual(result.success, true, "应能删除快照中已删除的文件");
        return adapter.readWorktreeFile(root, "笔记/恢复.md");
    })
    .then(function (result) {
        assert.strictEqual(result.success, true, "删除后的读取不应报错");
        assert.strictEqual(result.missing, true, "删除后的文件应标记为不存在");
        cleanup();
        console.log("GitAdapter restore tests passed");
    })
    .catch(function (error) {
        cleanup();
        console.error(error.stack || error.message);
        process.exitCode = 1;
    });
