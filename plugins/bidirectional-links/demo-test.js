/**
 * 双向链接插件 — Demo 测试脚本
 * ================================
 * 独立 Node.js 脚本，不依赖 Typora 运行时。
 * 创建临时测试 vault → 测试 parser / resolver / indexer → 清理。
 *
 * 运行方式：在 Typora 渲染进程 DevTools console 中执行，
 * 或通过 node 直接运行（需在 Typora 环境中才能用 reqnode）。
 *
 * 如果在 Typora 环境外运行，请确保已安装 Node.js 并调整 require 路径。
 */

(function () {
    "use strict";

    // ===================================================================
    // 环境兼容：检测 Typora 或 Node.js 环境
    // ===================================================================
    var fs, path, Module, PLUGIN_DIR;

    if (typeof reqnode !== "undefined") {
        // Typora 渲染进程环境
        fs = reqnode("fs");
        path = reqnode("path");
        Module = reqnode("module");
        PLUGIN_DIR = null;
    } else if (typeof require !== "undefined") {
        // 纯 Node.js 环境
        fs = require("fs");
        path = require("path");
        Module = require("module");
    } else {
        console.error("无法确定运行环境（需要 reqnode 或 require）");
        return;
    }

    // ===================================================================
    // 查找插件目录
    // ===================================================================
    if (!PLUGIN_DIR) {
        var baseDir = typeof __dirname !== "undefined" ? path.dirname(__dirname) : ".";
        var searchDirs = [
            path.join(baseDir, "bidirectional-links"),
            path.join(process.cwd(), "resources", "plugins", "bidirectional-links"),
        ];
        // Demo 调用方传入绝对插件路径
        if (typeof DEMO_PLUGIN_DIR !== "undefined" && DEMO_PLUGIN_DIR) {
            searchDirs.unshift(DEMO_PLUGIN_DIR);
        }
        for (var d = 0; d < searchDirs.length; d++) {
            try {
                if (fs.existsSync(path.join(searchDirs[d], "parser.js"))) {
                    PLUGIN_DIR = searchDirs[d];
                    break;
                }
            } catch (e) {}
        }
    }

    if (!PLUGIN_DIR) {
        console.error("❌ 找不到 bidirectional-links 插件目录");
        return;
    }

    console.log("📂 插件目录: " + PLUGIN_DIR);

    // ===================================================================
    // 加载模块
    // ===================================================================
    var pluginRequire;
    try {
        pluginRequire = Module.createRequire ?
            Module.createRequire(path.join(PLUGIN_DIR, "main.js")) :
            (typeof require !== "undefined" ? require : reqnode);
    } catch (e) {
        pluginRequire = typeof require !== "undefined" ? require : reqnode;
    }

    var parser = pluginRequire(path.join(PLUGIN_DIR, "parser.js"));
    var resolver = pluginRequire(path.join(PLUGIN_DIR, "resolver.js"));
    var LinkIndex = pluginRequire(path.join(PLUGIN_DIR, "indexer.js"));

    console.log("✅ 模块加载成功\n");

    // ===================================================================
    // 测试结果收集
    // ===================================================================
    var passed = 0;
    var failed = 0;
    var errors = [];

    function assert(condition, testName) {
        if (condition) {
            passed++;
            console.log("  ✅ " + testName);
        } else {
            failed++;
            var msg = "  ❌ FAIL: " + testName;
            console.error(msg);
            errors.push(msg);
        }
    }

    function section(title) {
        console.log("\n━━━ " + title + " ━━━");
    }

    // ===================================================================
    // Phase 1: parser.js 测试
    // ===================================================================
    section("1. parser.js — 基本解析");

    var p1 = parser.parseOne("[[Page]]");
    assert(p1 !== null, "parseOne('[[Page]]') 返回非 null");
    assert(p1.target === "Page", "target = 'Page'");
    assert(p1.alias === null, "alias = null");
    assert(p1.heading === null, "heading = null");
    assert(p1.isEmbed === false, "isEmbed = false");

    section("1.2 别名解析");
    var p2 = parser.parseOne("[[Page|Alias]]");
    assert(p2.target === "Page", "target = 'Page'");
    assert(p2.alias === "Alias", "alias = 'Alias'");
    assert(p2.heading === null, "heading = null");

    section("1.3 标题锚点解析");
    var p3 = parser.parseOne("[[Page#Section]]");
    assert(p3.target === "Page", "target = 'Page'");
    assert(p3.heading === "Section", "heading = 'Section'");
    assert(p3.alias === null, "alias = null");

    section("1.4 标题 + 别名");
    var p4 = parser.parseOne("[[Page#Section|Display]]");
    assert(p4.target === "Page", "target = 'Page'");
    assert(p4.heading === "Section", "heading = 'Section'");
    assert(p4.alias === "Display", "alias = 'Display'");

    section("1.5 嵌入链接");
    var p5 = parser.parseOne("![[Embed]]");
    assert(p5.isEmbed === true, "isEmbed = true");
    assert(p5.target === "Embed", "target = 'Embed'");

    section("1.6 边界情况");
    assert(parser.parseOne("[[]]") === null, "空括号 [[]] 返回 null");
    assert(parser.parseOne("[[#heading]]") !== null, "[[#heading]] 自引用非 null");
    var p7 = parser.parseOne("[[#heading]]");
    assert(p7 && p7.target === null, "自引用 target = null");
    assert(p7 && p7.heading === "heading", "自引用 heading 正确");
    assert(parser.parseOne("[[ ]]") === null, "[[ ]] 空白返回 null");

    section("1.7 parseAll 多链接解析");
    var text1 = "See [[Page A]] and [[Page B|Alias]] for details.";
    var all1 = parser.parseAll(text1);
    assert(all1.length === 2, "parseAll 找到 2 个链接");
    assert(all1[0].target === "Page A", "第 1 个链接 target = 'Page A'");
    assert(all1[1].alias === "Alias", "第 2 个链接 alias = 'Alias'");
    assert(all1[0].startOffset === 4, "第 1 个链接 startOffset = 4");
    assert(all1[1].startOffset > all1[0].endOffset, "第 2 个链接在第 1 个之后");

    var all2 = parser.parseAll("No links here.");
    assert(all2.length === 0, "无链接文本返回空数组");

    var all3 = parser.parseAll("");
    assert(all3.length === 0, "空字符串返回空数组");

    var all4 = parser.parseAll(null);
    assert(all4.length === 0, "null 返回空数组");

    section("1.8 特殊字符");
    var p8 = parser.parseOne("[[My Note (2024)]]");
    assert(p8.target === "My Note (2024)", "target 包含括号");
    var p9 = parser.parseOne("[[C++ Programming|C++]]");
    assert(p9.target === "C++ Programming", "target 包含 ++");
    var p10 = parser.parseOne("[[路径/子目录/文件|显示名]]");
    assert(p10.target === "路径/子目录/文件", "target 包含路径分隔符");

    // ===================================================================
    // Phase 2: 创建临时测试 vault
    // ===================================================================
    section("2. 创建临时测试 vault");

    var tmpDir = path.join(
        typeof process !== "undefined" && process.env.TEMP ?
            process.env.TEMP :
            (fs.existsSync("/tmp") ? "/tmp" : __dirname),
        "bt-test-vault-" + Date.now()
    );
    fs.mkdirSync(tmpDir, { recursive: true });
    console.log("  📁 临时 vault: " + tmpDir);

    // 创建测试文件
    var testFiles = {
        "Home.md": "# Home\n\nWelcome to my vault.\n\nSee [[Getting Started]] for help.\nAlso check [[Advanced Tips|Tips]].\n",
        "Getting Started.md": "# Getting Started\n\nThis is the getting started guide.\n\nBack to [[Home]].\nSee also [[Advanced Tips#Shortcuts]].\n",
        "Advanced Tips.md": "# Advanced Tips\n\n## Shortcuts\n\nUse keyboard shortcuts.\n\nRelated: [[Home]] and [[Getting Started]].\n\nEmbed: ![[logo.png]]\n",
        "Projects/Project Alpha.md": "# Project Alpha\n\nSubfolder test.\n\nRef: [[Home]].\n",
        "日记/2024-01-01.md": "# 2024-01-01\n\n今天学习了 [[Getting Started]]。\n也参考了 [[Project Alpha]]。\n",
        "orphan.md": "# Orphan\n\nThis file has no incoming links.\n\nBut it links to [[Home]].\n",
        "Case Test.md": "# Case Test\n\nLinks with different case: [[case test]].\n",
        "Big File.md": "A".repeat(600 * 1024),  // > 500KB, 应被跳过
    };

    for (var fileName in testFiles) {
        if (testFiles.hasOwnProperty(fileName)) {
            var fullPath = path.join(tmpDir, fileName);
            var dir = path.dirname(fullPath);
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }
            fs.writeFileSync(fullPath, testFiles[fileName], "utf8");
        }
    }

    var allMd = resolver.scanMdFiles(fs, path, tmpDir);
    console.log("  📄 创建了 " + allMd.length + " 个 .md 文件");
    assert(allMd.length >= 7, "至少 7 个文件（Big File 被排除因 .md 扩展名正确）");

    // ===================================================================
    // Phase 3: resolver.js 测试
    // ===================================================================
    section("3. resolver.js — 文件路径解析");

    var sourceFile = path.join(tmpDir, "Home.md");

    var r1 = resolver.resolve("Getting Started", sourceFile, allMd);
    assert(r1 !== null, "精确匹配 'Getting Started'");
    assert(r1.indexOf("Getting Started.md") > 0, "解析路径包含文件名");

    var r2 = resolver.resolve("Home", sourceFile, allMd);
    assert(r2 !== null, "解析 'Home'");
    assert(r2.indexOf("Home.md") > 0, "解析路径为 Home.md");

    var r3 = resolver.resolve("Advanced Tips", sourceFile, allMd);
    assert(r3 !== null, "解析 'Advanced Tips'");

    section("3.2 大小写不敏感");
    var r4 = resolver.resolve("getting started", sourceFile, allMd);
    assert(r4 !== null, "大小写不敏感 'getting started'");
    assert(r4.indexOf("Getting Started.md") > 0, "解析到正确文件");

    section("3.3 子目录路径");
    var r5 = resolver.resolve("Projects/Project Alpha", sourceFile, allMd);
    assert(r5 !== null, "解析子目录路径 'Projects/Project Alpha'");

    var r6 = resolver.resolve("Project Alpha", sourceFile, allMd);
    assert(r6 !== null, "basename 匹配 'Project Alpha'");

    section("3.4 非 ASCII 路径");
    var r7 = resolver.resolve("日记/2024-01-01", sourceFile, allMd);
    assert(r7 !== null, "解析中文路径");

    section("3.5 断链");
    var r8 = resolver.resolve("Non Existent", sourceFile, allMd);
    assert(r8 === null, "不存在的文件返回 null");

    // ===================================================================
    // Phase 4: indexer.js 测试
    // ===================================================================
    section("4. indexer.js — 索引构建");

    var cacheDir = path.join(tmpDir, ".cache");
    fs.mkdirSync(cacheDir, { recursive: true });

    var index = new LinkIndex(cacheDir, fs, path, parser);

    section("4.1 全量扫描");
    index.scanAll(tmpDir, allMd);
    var stats = index.getStats();
    console.log("  📊 索引统计: " + stats.fileCount + " 文件, " + stats.linkCount + " 链接");
    assert(stats.fileCount === allMd.length, "所有文件被索引");
    assert(stats.linkCount > 0, "至少有一些链接");

    section("4.2 正向索引（出链）");
    var homeForward = index.getForward(path.join(tmpDir, "Home.md"));
    assert(homeForward.length >= 2, "Home.md 至少有 2 个出链");
    var targets = homeForward.map(function (e) { return e.target; });
    assert(targets.indexOf("Getting Started") >= 0, "Home 链接到 Getting Started");
    assert(targets.indexOf("Advanced Tips") >= 0, "Home 链接到 Advanced Tips");

    section("4.3 反向索引（反链）");
    var homeBacklinks = index.getBacklinks(path.join(tmpDir, "Home.md"));
    console.log("  🔗 Home.md 的反链: " + homeBacklinks.map(function (b) {
        return path.basename(b.source, ".md");
    }).join(", "));
    assert(homeBacklinks.length >= 3, "Home.md 至少有 3 条反链");
    var sourceNames = homeBacklinks.map(function (b) {
        return path.basename(b.source, ".md");
    });
    assert(sourceNames.indexOf("Getting Started") >= 0, "Getting Started 链接到 Home");
    assert(sourceNames.indexOf("Advanced Tips") >= 0, "Advanced Tips 链接到 Home");
    assert(sourceNames.indexOf("orphan") >= 0, "orphan 链接到 Home");

    section("4.4 自链接排除");
    var selfCheck = homeBacklinks.filter(function (b) {
        return b.source === path.join(tmpDir, "Home.md");
    });
    assert(selfCheck.length === 0, "Home 不在自己的反链中");

    section("4.5 孤儿文件");
    var orphanBacklinks = index.getBacklinks(path.join(tmpDir, "orphan.md"));
    assert(orphanBacklinks.length === 0, "orphan.md 无反链（没有文件链接它）");

    section("4.6 增量更新");
    // 修改 Home.md，添加新链接
    var homePath = path.join(tmpDir, "Home.md");
    var newContent = "# Home\n\nSee [[Getting Started]] and [[Case Test]].\n[[New Page]] too.\n";
    fs.writeFileSync(homePath, newContent, "utf8");

    var result = index.indexFile(homePath);
    console.log("  updated: added=" + result.added + " removed=" + result.removed);
    var homeForward2 = index.getForward(homePath);
    var targets2 = homeForward2.map(function (e) { return e.target; });
    assert(targets2.indexOf("Case Test") >= 0, "更新后包含 Case Test");
    assert(targets2.indexOf("New Page") >= 0, "更新后包含 New Page");
    assert(targets2.indexOf("Advanced Tips") === -1, "更新后不包含 Advanced Tips");

    section("4.7 文件删除");
    var caseTestPath = path.join(tmpDir, "Case Test.md");
    index.removeFile(caseTestPath);
    assert(index.forwardIndex.has(caseTestPath) === false, "forwardIndex 中已删除");
    assert(index.allMdFiles.indexOf(caseTestPath) === -1, "allMdFiles 中已删除");

    // 恢复（重新索引）
    index.indexFile(caseTestPath);

    section("4.8 持久化 round-trip");
    var persistOk = index.persist();
    assert(persistOk, "persist() 成功");

    // 记录 persist 前的状态（已被步骤 4.6-4.7 修改）
    var statsBeforePersist = index.getStats();

    var index2 = new LinkIndex(cacheDir, fs, path, parser);
    var loadOk = index2.load();
    assert(loadOk, "load() 成功");
    var stats2 = index2.getStats();
    assert(stats2.fileCount === statsBeforePersist.fileCount, "文件数一致");
    assert(stats2.linkCount === statsBeforePersist.linkCount, "链接数一致");
    assert(index2.isCacheValidFor(tmpDir), "cache vaultRoot 校验通过");

    section("4.9 缓存校验 — 不同 vault");
    assert(!index2.isCacheValidFor("/some/other/vault"), "不同 vault 返回 false");

    // ===================================================================
    // Phase 5: 边界情况
    // ===================================================================
    section("5. 边界情况");

    section("5.1 大文件跳过");
    var bigFilePath = path.join(tmpDir, "Big File.md");
    var bigForward = index.getForward(bigFilePath);
    // Big File 应该被扫描但无链接（内容被跳过）
    assert(bigForward.length === 0, "超大文件出链为空（内容被跳过）");

    section("5.2 循环链接");
    // A→B, B→A 已经存在于 Home ↔ Getting Started 之间
    var gsBacklinks = index.getBacklinks(path.join(tmpDir, "Getting Started.md"));
    var gsSources = gsBacklinks.map(function (b) { return path.basename(b.source, ".md"); });
    assert(gsSources.indexOf("Home") >= 0, "循环链接: Home 出现在 Getting Started 反链中");

    section("5.3 中文文件名");
    var diaryPath = path.join(tmpDir, "日记", "2024-01-01.md");
    var diaryForward = index.getForward(diaryPath);
    assert(diaryForward.length >= 1, "中文路径文件有出链");
    var diaryBacklinks = index.getBacklinks(diaryPath);
    // diary 目前没有反链
    console.log("  📄 日记文件出链: " + diaryForward.map(function (e) { return e.target; }).join(", "));

    // ===================================================================
    // 清理
    // ===================================================================
    section("6. 清理");
    try {
        // 递归删除临时目录
        function rmdirRecursive(dir) {
            if (!fs.existsSync(dir)) return;
            var entries = fs.readdirSync(dir, { withFileTypes: true });
            for (var i = 0; i < entries.length; i++) {
                var entry = entries[i];
                var fullPath = path.join(dir, entry.name);
                if (entry.isDirectory()) {
                    rmdirRecursive(fullPath);
                } else {
                    fs.unlinkSync(fullPath);
                }
            }
            fs.rmdirSync(dir);
        }
        rmdirRecursive(tmpDir);
        console.log("  🗑 已删除临时 vault: " + tmpDir);
    } catch (e) {
        console.log("  ⚠️ 清理失败: " + e.message);
        console.log("  📁 请手动删除: " + tmpDir);
    }

    // ===================================================================
    // 结果汇总
    // ===================================================================
    section("结果汇总");
    console.log("  ✅ 通过: " + passed);
    console.log("  ❌ 失败: " + failed);
    console.log("  总计: " + (passed + failed));

    if (errors.length > 0) {
        console.log("\n  失败详情:");
        for (var e = 0; e < errors.length; e++) {
            console.log("    " + errors[e]);
        }
    }

    if (failed === 0) {
        console.log("\n🎉 所有测试通过！\n");
    } else {
        console.log("\n⚠️ 存在 " + failed + " 个失败用例，请检查。\n");
    }

    // 导出结果供外部使用
    return {
        passed: passed,
        failed: failed,
        errors: errors,
    };
})();
