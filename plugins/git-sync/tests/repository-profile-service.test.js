/* 仓库档案与工作区边界测试：统一模式只能匹配并处理当前 scope。 */
"use strict";

var assert = require("assert");
var fs = require("fs");
var os = require("os");
var path = require("path");

global.reqnode = require;
var RepositoryProfileService = require("../repository-profile-service");
var WorkspaceService = require("../workspace-service");

function makeApi(values) {
    return {
        getSetting: function (key, fallback) { return values[key] === undefined ? fallback : values[key]; },
        setSetting: function (key, value) { values[key] = value; }
    };
}

var settings = {};
var profiles = new RepositoryProfileService(makeApi(settings), console);
profiles.registerLocal("/notes");
profiles.registerUnified("/notes/knowledge", "projects", "项目笔记");
profiles.registerUnified("/notes/knowledge", "daily", "日记");

assert.strictEqual(profiles.findForFile("/notes/loose.md").mode, "local", "普通文件应匹配本地模式");
var unified = profiles.findForFile("/notes/knowledge/projects/a.md");
assert.strictEqual(unified.mode, "unified", "更深的统一仓库应优先匹配");
assert.strictEqual(profiles.scopeForFile(unified, "/notes/knowledge/projects/a.md"), "projects", "应匹配当前工作区 scope");
assert.strictEqual(profiles.scopeForFile(unified, "/notes/knowledge/other/a.md"), null, "未登记目录不得被统一模式接管");

var root = fs.mkdtempSync(path.join(os.tmpdir(), "bettertypora-workspace-"));
var external = fs.mkdtempSync(path.join(os.tmpdir(), "bettertypora-external-"));
var source = path.join(external, "随手记.md");
fs.writeFileSync(source, "原始笔记", "utf8");
var current = source;
var workspace = new WorkspaceService({
    getMountFolder: function () { return path.dirname(current); },
    getCurrentFile: function () { return current; }
}, {}, function () {}, profiles, console);

assert.strictEqual(workspace.prepareUnified("", "inbox").success, false, "空统一仓库路径必须被拒绝");
var prepared = workspace.prepareUnified(root, "inbox");
assert.strictEqual(prepared.success, true, "仓库外文件应可准备导入");
assert.strictEqual(prepared.imported, true, "仓库外文件必须标记为复制导入");
var imported = workspace.importCurrentFile(prepared);
assert.strictEqual(fs.readFileSync(source, "utf8"), "原始笔记", "导入不得改写原始文件");
assert.strictEqual(fs.readFileSync(imported, "utf8"), "原始笔记", "导入文件应完整复制内容");
assert.strictEqual(workspace.prepareUnified(root, "../escape").success, false, "scope 不得越出统一仓库");

fs.rmSync(root, { recursive: true, force: true });
fs.rmSync(external, { recursive: true, force: true });
console.log("Repository profile and workspace tests passed");
