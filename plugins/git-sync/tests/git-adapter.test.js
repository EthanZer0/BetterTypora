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

var status = GitAdapter.parseStatus("## main...origin/main [ahead 2, behind 1]\0 M 笔记/中文 文件.md\0R  新文件.md\0旧文件.md\0?? 未跟踪 文件.md\0");
assert.strictEqual(status.branch, "main", "应解析 NUL 格式的分支信息");
assert.strictEqual(status.files[0].path, "笔记/中文 文件.md", "中文和空格路径不得被转义");
assert.deepStrictEqual(status.files[1], { code: "R ", path: "新文件.md", previousPath: "旧文件.md" }, "重命名应保留新旧路径");
assert.strictEqual(status.files[2].code, "??", "未跟踪文件状态应保持原样");

var commitFiles = GitAdapter.parseCommitFiles("R100\0旧文件.md\0新文件.md\0A\0笔记/新增 文件.md\0");
assert.deepStrictEqual(commitFiles[0], { code: "R100", path: "新文件.md", previousPath: "旧文件.md" }, "快照重命名应保留新旧路径");
assert.strictEqual(commitFiles[1].path, "笔记/新增 文件.md", "快照中的中文路径不得损坏");

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
        fs.writeFileSync(path.join(root, "附件.bin"), Buffer.from([0, 1, 2, 3]));
        return adapter.readWorktreeFile(root, "附件.bin");
    })
    .then(function (result) {
        assert.strictEqual(result.success, true, "应能识别工作区二进制文件");
        assert.strictEqual(result.binary, true, "二进制文件不得作为 UTF-8 文本处理");
        cleanup();
        console.log("GitAdapter restore tests passed");
    })
    .catch(function (error) {
        cleanup();
        console.error(error.stack || error.message);
        process.exitCode = 1;
    });
