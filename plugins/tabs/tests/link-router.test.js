/* 本地 Markdown 链接解析测试：不依赖 Typora 或浏览器 DOM。 */
"use strict";

var assert = require("assert");
var router = require("../link-router");

function testRelativeLanguageLink() {
    var target = router.resolveLocalMarkdownTarget("README_CN.md", "/notes/README.md");
    assert.strictEqual(target, "/notes/README_CN.md");
}

function testEncodedAndSuffixedLink() {
    var target = router.resolveLocalMarkdownTarget("子目录/我的%20笔记.md?from=readme#标题", "/notes/README.md");
    assert.strictEqual(target, "/notes/子目录/我的 笔记.md");
}

function testPreviewAbsoluteTarget() {
    var target = router.resolveLocalMarkdownTarget("#", "/notes/README.md", "/notes/README_EN.md");
    assert.strictEqual(target, "/notes/README_EN.md");
}

function testFileUrl() {
    var target = router.resolveLocalMarkdownTarget("file:///notes/README_EN.md", "/notes/README.md");
    assert.strictEqual(target, "/notes/README_EN.md");
}

function testExternalAndNonMarkdownLinks() {
    assert.strictEqual(router.resolveLocalMarkdownTarget("https://example.com/a.md", "/notes/README.md"), null);
    assert.strictEqual(router.resolveLocalMarkdownTarget("README.txt", "/notes/README.md"), null);
    assert.strictEqual(router.resolveLocalMarkdownTarget("#section", "/notes/README.md"), null);
}

testRelativeLanguageLink();
testEncodedAndSuffixedLink();
testPreviewAbsoluteTarget();
testFileUrl();
testExternalAndNonMarkdownLinks();
console.log("tabs link-router tests passed");
