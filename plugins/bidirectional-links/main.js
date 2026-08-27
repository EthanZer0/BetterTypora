/**
 * Bidirectional Links — Main Entry
 * =================================
 * 插件生命周期管理 + 组件编排。
 *
 * enable() 流程:
 *   1. 获取 vault 根目录
 *   2. 加载缓存索引 → 校验 → 必要时全量扫描
 *   3. 启动 FileWatcher
 *   4. 注入 BacklinksPanel 到侧边栏
 *   5. Monkey-patch openFile 检测文件切换
 *   6. 安装 click 拦截处理 [[...]] 导航
 *   7. 注册命令和热键
 */

var BetterTypora = require("bettertypora:api");
var api = BetterTypora.api;
var logger = BetterTypora.logger;
var PLUGIN_DIR = BetterTypora.pluginDir;

var fs = reqnode("fs");
var path = reqnode("path");
var Module = reqnode("module");

// ===================================================================
// 加载子模块
// ===================================================================

// 使用 Node.js 内置的 require 能力加载同目录下的 JS 文件
var pluginRequire;
try {
    pluginRequire = Module.createRequire
        ? Module.createRequire(path.join(PLUGIN_DIR, "main.js"))
        : reqnode;
} catch (e) {
    pluginRequire = reqnode;
}

var parser = pluginRequire(path.join(PLUGIN_DIR, "parser.js"));
var resolver = pluginRequire(path.join(PLUGIN_DIR, "resolver.js"));
var LinkIndex = pluginRequire(path.join(PLUGIN_DIR, "indexer.js"));
var BacklinksPanel = pluginRequire(path.join(PLUGIN_DIR, "panel.js"));
var FileWatcher = pluginRequire(path.join(PLUGIN_DIR, "watcher.js"));
var GraphView = pluginRequire(path.join(PLUGIN_DIR, "graph-view.js"));
var HighlightRenderer = pluginRequire(path.join(PLUGIN_DIR, "highlight-renderer.js"));

// ===================================================================
// 全局状态（组件的单例引用）
// ===================================================================
var linkIndex = null;
var graphView = null;
var backlinksPanel = null;
var fileWatcher = null;
var highlightRenderer = null;
var _onFileOpenUnsub = null;
var _onSavedUnsub = null;   // 保存完成事件订阅 (saved → 索引增量 + 图谱刷新)
var _clickHandler = null;
var _guardInterval = null;
var _initialized = false;
var _timers = null;

// ===================================================================
// 工具函数
// ===================================================================

/** 获取当前 vault 根目录 */
function getVaultRoot() {
    var mount = BetterTypora.getMountFolder();
    if (mount) return mount;
    // 单文件模式 (未打开文件夹): 降级用当前文件所在目录作为 vault,
    // 让同目录链接可解析 — 修复直接从桌面打开 md 时所有链接灰显
    var cf = BetterTypora.getCurrentFile();
    if (cf) return path.dirname(cf);
    return null;
}

/** 获取当前打开的文件路径 */
function getCurrentFilePath() {
    return BetterTypora.getCurrentFile();
}

/** 获取缓存目录 */
function getCacheDir() {
    // 使用 BetterTypora 的 .cache 目录
    var cacheDir = path.join(
        path.dirname(PLUGIN_DIR),
        ".cache"
    );
    return cacheDir;
}

/**
 * 自动注入 SharedArrayBuffer flag 到 Typora conf.user.json。
 * 下次重启后 Worker↔Main 零拷贝通信生效。
 * 幂等 — 已存在时不重复添加。
 */
function ensureSABFlag() {
    try {
        var confDir = path.join(process.env.APPDATA || "", "Typora", "conf");
        var confPath = path.join(confDir, "conf.user.json");
        var raw = fs.readFileSync(confPath, "utf-8");
        if (raw.indexOf("SharedArrayBuffer") >= 0) return; // 已注入，跳过

        // 找到 "flags" 字段并注入
        var flagsMatch = raw.match(/("flags"\s*:\s*)\[([^\]]*)\]/);
        if (!flagsMatch) {
            logger.warn("无法找到 flags 字段，SAB flag 注入失败");
            return;
        }

        var flagsContent = flagsMatch[2].trim();
        var sabEntry = '["enable-features", "SharedArrayBuffer"]';
        if (flagsContent.length > 0 && !flagsContent.endsWith(",")) {
            flagsContent += ", ";
        }
        flagsContent += sabEntry;

        var updated = raw.replace(
            /"flags"\s*:\s*\[[^\]]*\]/,
            '"flags": [' + flagsContent + ']'
        );

        // 备份 + 写入
        fs.writeFileSync(confPath + ".bak", raw, "utf-8");
        fs.writeFileSync(confPath, updated, "utf-8");
        logger.log("✅ 已注入 SharedArrayBuffer flag — 下次重启后零拷贝通信生效");
    } catch (e) {
        logger.warn("SAB flag 注入失败（非关键）: " + e.message);
    }
}

/** 从 document.title 解析出文件名，在 linkIndex.allMdFiles 中匹配全路径 */
function resolvePathFromTitle(title) {
    if (!title || !linkIndex || !linkIndex.allMdFiles) return null;
    // Typora 标题格式: "filename.md - Typora" 或 "filename.md — VaultName - Typora"
    var basename = title.replace(/\s*[-—–]\s*Typora\s*$/i, "").trim();
    // 去除末尾的 vault 名称（如果有多个 —）
    var lastDash = basename.lastIndexOf(" — ");
    if (lastDash > 0) basename = basename.substring(0, lastDash).trim();
    lastDash = basename.lastIndexOf(" - ");
    if (lastDash > 0) basename = basename.substring(0, lastDash).trim();
    // 去除 * 后缀（未保存标记）
    basename = basename.replace(/\s*\*\s*$/, "").trim();
    if (!basename) return null;
    // 添加 .md 后缀（如果尚未包含）
    if (!/\.md$/i.test(basename)) basename += ".md";
    var bnLower = basename.toLowerCase();
    var allFiles = linkIndex.allMdFiles;
    for (var i = 0; i < allFiles.length; i++) {
        var fname = allFiles[i].replace(/\\/g, "/").split("/").pop();
        if (fname.toLowerCase() === bnLower) return allFiles[i];
    }
    return null;
}

// ===================================================================
// Monkey-patch File.editor.library
// ===================================================================

// --- library.switch() patch（修复侧边栏双重选中 bug） ---
// 链路：toggleSidebar() → hideSidebar()（不清理 active-tab-backlinks）
//       → 再次 showSidebar() → switch(getActiveTab()|defaultTab)
//       → Typora 加 active-tab-files/outline，与残留的 active-tab-backlinks
//         同时存在 → 双重选中。
// switch() 是所有 native tab 切换的唯一瓶颈，在此处埋点统一清理。
var _origLibSwitch = null;
var _libSwitchObj = null;

function patchLibrarySwitch() {
    try {
        if (typeof File === "undefined" || !File.editor || !File.editor.library) return false;
        var lib = File.editor.library;
        if (typeof lib.switch !== "function") return false;

        _libSwitchObj = lib;
        _origLibSwitch = lib.switch;

        lib.switch = function (tabId, force) {
            // 在 Typora 加 active-tab-files/outline 之前，先清理反链面板 CSS 状态，
            // 防止和残留的 active-tab-backlinks 同时出现 (双重选中 bug)。
            // 注意: 不设置 _active = false, 因为 library.switch 可能在文件标签页
            // 切换时也被调用, 会意外停止 panel 的快速轮询。
            var sidebar = document.getElementById("typora-sidebar");
            if (sidebar && sidebar.classList.contains("active-tab-backlinks")) {
                sidebar.classList.remove("active-tab-backlinks");
            }
            var ourTab = document.getElementById("info-panel-tab-backlinks");
            if (ourTab) ourTab.classList.remove("active");

            return _origLibSwitch.apply(this, arguments);
        };

        logger.log("已拦截 library.switch");
        return true;
    } catch (e) {
        logger.warn("library.switch 拦截失败:", e.message);
        return false;
    }
}

function unpatchLibrarySwitch() {
    if (_origLibSwitch && _libSwitchObj) {
        _libSwitchObj.switch = _origLibSwitch;
        _origLibSwitch = null;
        _libSwitchObj = null;
        logger.log("已恢复 library.switch");
    }
}

// ===================================================================
// 文件切换事件 — 通过 BetterTypora.onFileOpen 统一注册
// ===================================================================

function onFileOpened(filePath) {
    if (filePath && backlinksPanel) {
        _timers.setTimeout(function () {
            if (backlinksPanel) {
                backlinksPanel.update(filePath);
            }
        }, 300);
    }

    // 触发 highlight 重扫。切换标签页时 Typora 会重建 #write 的 DOM，
    // MutationObserver 可能来不及响应（或挂载在已销毁的旧元素上），
    // 因此直接触发同步扫描作为可靠触发源。
    if (highlightRenderer && highlightRenderer._enabled) {
        // DOM 在下一个微任务就绪，rAF 确保在布局完成后扫描
        requestAnimationFrame(function () {
            if (highlightRenderer) highlightRenderer._rescanAll();
        });
    }

    api.emit("bidirectional-links:file-opened", { filePath: filePath });
}

var _onFileOpenUnsub = null;

function installFileOpenListener() {
    if (_onFileOpenUnsub) return;
    _onFileOpenUnsub = BetterTypora.onFileOpen(onFileOpened);
    // 保存完成 → 增量索引 + 图谱刷新 (精确时机, 替代文件轮询检测延迟)
    if (!_onSavedUnsub) {
        _onSavedUnsub = BetterTypora.onFileEvent("saved", function (data) {
            var fp = data && data.path;
            if (!fp || !linkIndex) return;
            linkIndex.indexFile(fp);
            scheduleGraphRefresh();
        });
    }
    logger.log("已注册文件切换监听");
}

function uninstallFileOpenListener() {
    if (_onFileOpenUnsub) {
        BetterTypora.offFileOpen(_onFileOpenUnsub);
        _onFileOpenUnsub = null;
    }
    if (_onSavedUnsub) {
        BetterTypora.offFileEvent("saved", _onSavedUnsub);
        _onSavedUnsub = null;
    }
}

// ===================================================================
// [[wikilink]] click 拦截
// ===================================================================

/**
 * 从点击位置的正反向扫描中提取 [[...]] 文本
 * @param {Node} textNode — 点击位置的文本节点
 * @param {number} offset — 点击在文本节点中的偏移
 * @returns {{raw: string, start: number, end: number}|null}
 */
function extractWikiLinkAtPosition(textNode, offset) {
    if (!textNode || textNode.nodeType !== 3) return null; // 必须是文本节点
    var text = textNode.textContent;

    // 正向扫描找 ]]
    var closeIdx = -1;
    for (var i = offset; i < text.length - 1; i++) {
        if (text.charAt(i) === "]" && text.charAt(i + 1) === "]") {
            closeIdx = i;
            break;
        }
    }

    // 反向扫描找 [[ （包括 ![[）
    var openIdx = -1;
    for (var j = offset; j >= 1; j--) {
        if (text.charAt(j - 1) === "[" && text.charAt(j) === "[") {
            openIdx = j - 1;
            break;
        }
        if (j >= 2 && text.charAt(j - 2) === "!" &&
            text.charAt(j - 1) === "[" && text.charAt(j) === "[") {
            openIdx = j - 2;
            break;
        }
    }

    if (openIdx < 0 || closeIdx < 0 || openIdx >= closeIdx) return null;

    // 点击位置必须在 [[ 和 ]] 之间
    if (offset < openIdx || offset > closeIdx + 2) return null;

    // 检查 openIdx 和 closeIdx 之间没有其他 ]] 或 [[，
    // 防止误抓相邻两个 [[A]] [[B]] 的跨链接匹配
    for (var k = openIdx + 2; k < closeIdx; k++) {
        if (text.charAt(k) === "]" && text.charAt(k + 1) === "]") return null;
        if (text.charAt(k) === "[" && text.charAt(k + 1) === "[") return null;
    }

    var raw = text.slice(openIdx, closeIdx + 2);
    return {
        raw: raw,
        start: openIdx,
        end: closeIdx + 2,
    };
}

/**
 * 从「拆分隐藏结构」重建完整链接。
 * 两种结构:
 *   别名: [hide: [[][hide: 标题|][alias: 别名][hide: ]]
 *   普通: [hide: [[][title: 标题][hide: ]]
 * 点击落在拆分 span 内时, 普通提取找不到 [[/]], 从兄弟 span 重建 raw。
 */
function extractWikiLinkFromSplit(textNode) {
    try {
        var el = textNode && textNode.parentElement;
        if (!el || !el.classList) return null;
        var raw = null;
        if (el.classList.contains("bt-wl-alias")) {
            // 别名链接: 标题从兄弟 hide span 提取 (去掉尾部管道)
            var open = el.previousElementSibling;
            var close = el.nextElementSibling;
            if (!open || !close) return null;
            var titlePart = (open.textContent || "").replace(/\|$/, "");
            raw = "[[" + titlePart + "|" + (el.textContent || "") + "]]";
        } else if (el.classList.contains("bt-wl-title")) {
            // 普通链接: 标题即 span 自身文本
            var t = (el.textContent || "").trim();
            if (!t) return null;
            raw = "[[" + t + "]]";
        } else {
            return null;
        }
        if (raw.length < 4) return null;
        return { raw: raw, start: 0, end: raw.length };
    } catch (e) {
        return null;
    }
}

/**
 * Click 事件处理器（capture 阶段）
 */
function handleWikiLinkClick(e) {
    // 不拦截 Ctrl/Cmd + Click（Typora 原生链接行为）
    if (e.ctrlKey || e.metaKey) return;

    // 检查点击是否在 #write 内
    var writeEl = document.getElementById("write");
    if (!writeEl) return;

    // 检查点击目标是否在 #write 内
    var target = e.target;
    var inWrite = false;
    var el = target;
    while (el) {
        if (el === writeEl) {
            inWrite = true;
            break;
        }
        el = el.parentNode;
    }
    if (!inWrite) return;

    // 如果点击在已有的 <a> 标签上，不拦截（Typora 原生链接）
    if (target.closest("a") || target.closest("[md-inline='link']")) {
        return;
    }

    // 使用 caretRangeFromPoint 获取文本位置
    var range;
    try {
        range = document.caretRangeFromPoint(e.clientX, e.clientY);
    } catch (err) {
        // 备选：document.elementFromPoint
        return;
    }
    if (!range) return;

    var textNode = range.startContainer;
    var offset = range.startOffset;

    // 从点击位置提取 [[...]] 文本
    var extracted = extractWikiLinkAtPosition(textNode, offset);
    // 别名隐藏拆分了文本节点 ([[标题|别名]] → 别名独立成 span),
    // 普通提取找不到完整链接 → 从拆分结构重建
    if (!extracted) extracted = extractWikiLinkFromSplit(textNode);
    if (!extracted) return;

    // 跳过无效的（如空括号、只有闭合标记等）
    if (extracted.raw.length < 4) return; // 最小 "[[x]]"

    // 解析
    var parsed = parser.parseOne(extracted.raw);
    if (!parsed) return;
    // 完全空（既无 target 也无 heading）→ 无效
    if (!parsed.target && !parsed.heading) return;
    // 自引用 [[#heading]]：target=null, heading 有值 — 合法，target 用当前文件
    var isSelfRef = !parsed.target && parsed.heading;

    // 如果是嵌入链接 ![[...]]，暂不处理
    if (parsed.isEmbed) {
        logger.log("嵌入链接，v1 暂不支持导航:", extracted.raw);
        return;
    }

    // 解析文件路径
    var currentFile = getCurrentFilePath();
    var resolvedPath;
    if (isSelfRef) {
        // 自引用 [[#heading]]：target 就是自己
        resolvedPath = currentFile;
    } else {
        // 带父目录顶层兜底 (覆盖 Typora 自动挂载文件目录时链接父目录文档)
        resolvedPath = resolver.resolveWithParentFallback
            ? resolver.resolveWithParentFallback(
                parsed.target, currentFile,
                linkIndex ? linkIndex.allMdFiles : [],
                api.getSetting("caseSensitiveFirst", true),
                fs, path
              )
            : resolver.resolve(
                parsed.target,
                currentFile,
                linkIndex ? linkIndex.allMdFiles : [],
                api.getSetting("caseSensitiveFirst", true)
              );
    }

    if (!resolvedPath) {
        // 断链：toast 提示
        window.BetterTypora.toast &&
            window.BetterTypora.toast(
                '🔗 链接目标不存在: "' + parsed.target + '"',
                2000
            );
        e.preventDefault();
        e.stopPropagation();
        return;
    }

    logger.log("导航到:", parsed.target || "(当前文件)", "→", resolvedPath);

    // 打开目标文件（自引用跳过，只做锚点滚动）
    if (!isSelfRef) {
        try {
            BetterTypora.openFile(resolvedPath);
        } catch (err) {
            logger.error("打开文件失败:", err.message);
        }
    }

    // 如果有 heading 锚点，等文件渲染完成后滚动到锚点
    if (parsed.heading) {
        scrollToHeadingAfterOpen(parsed.heading);
    }

    e.preventDefault();
    e.stopPropagation();
}

/**
 * 文件打开后，延迟滚动到 #heading 锚点
 * Typora 内部已有 tryOpenUrl("#heading") 机制，通过 location.hash 触发。
 * 我们在文件渲染完成后设置 hash 来触发滚动。
 */
function scrollToHeadingAfterOpen(heading) {
    if (!heading) return;

    // 检查是否已经是目标文件（文件可能已打开，不需要切换）
    // 等待 Typora 完成渲染（通常 300-500ms）
    _timers.setTimeout(function () {
        try {
            // 方法 1: 利用 Typora 的 tryOpenUrl（处理 "#heading" 格式）
            if (typeof File !== "undefined" && File.editor && typeof File.editor.tryOpenUrl === "function") {
                File.editor.tryOpenUrl("#" + heading);
                logger.log("锚点跳转 (tryOpenUrl): #" + heading);
                return;
            }

            // 方法 2: findAnchorElem + jumpIntoElemBegin + scrollAdjust
            if (typeof File !== "undefined" && typeof File.editor !== "undefined") {
                // EditHelper 在 Typora 内部，尝试从 File.editor 访问
                var editor = File.editor;
                if (editor.selection && typeof editor.selection.jumpIntoElemBegin === "function") {
                    var anchor = findHeadingElement(heading);
                    if (anchor) {
                        editor.selection.jumpIntoElemBegin(anchor);
                        editor.selection.scrollAdjust(anchor, 10);
                        logger.log("锚点跳转 (selection): #" + heading);
                        return;
                    }
                }
            }

            // 方法 3: 纯 DOM 查找 + scrollIntoView
            var anchorElem = findHeadingElement(heading);
            if (anchorElem) {
                anchorElem.scrollIntoView({ behavior: "smooth", block: "start" });
                logger.log("锚点跳转 (DOM): #" + heading);
            } else {
                logger.warn("未找到锚点元素: #" + heading);
            }
        } catch (e) {
            logger.warn("锚点跳转失败:", e.message);
        }
    }, 600);
}

/**
 * 在 #write 中查找匹配 heading 的元素
 */
function findHeadingElement(heading) {
    if (!heading) return null;
    var writeEl = document.getElementById("write");
    if (!writeEl) return null;

    var hText = heading.trim();

    // 遍历 h1-h6 元素，匹配文本内容
    var headings = writeEl.querySelectorAll("[mdtype='heading']");
    for (var i = 0; i < headings.length; i++) {
        var text = (headings[i].textContent || "").trim();
        if (text === hText || text.toLowerCase() === hText.toLowerCase()) {
            return headings[i];
        }
    }

    // fallback: 查找 id 匹配
    var byId = writeEl.querySelector("#" + CSS.escape(hText));
    if (byId) return byId;

    return null;
}

function installClickInterceptor() {
    _clickHandler = handleWikiLinkClick;
    document.addEventListener("dblclick", _clickHandler, true); // 双击触发，避免编辑时误跳转
    logger.log("已安装 dblclick 拦截");
}

function uninstallClickInterceptor() {
    if (_clickHandler) {
        document.removeEventListener("dblclick", _clickHandler, true);
        _clickHandler = null;
        logger.log("已移除 click 拦截");
    }
}

// ===================================================================
// 索引构建
// ===================================================================

function buildIndex(onComplete) {
    var vaultRoot = getVaultRoot();
    if (!vaultRoot) {
        logger.warn("未打开文件夹，无法构建索引");
        if (onComplete) onComplete(false);
        return;
    }

    // 检测 vault 是否变化（如用户切换到了不同文件夹的标签页）
    var oldVaultRoot = linkIndex.vaultRoot;
    var vaultChanged = oldVaultRoot && (
        oldVaultRoot.replace(/\\/g, "/").toLowerCase() !== vaultRoot.replace(/\\/g, "/").toLowerCase()
    );
    if (vaultChanged) {
        logger.log("Vault 变化: " + path.basename(oldVaultRoot) + " → " + path.basename(vaultRoot));
        linkIndex.forwardIndex.clear();
        linkIndex.reverseIndex.clear();
        linkIndex.fileMTimes.clear();
        linkIndex.allMdFiles = [];
        linkIndex.vaultRoot = null;
        linkIndex.ready = false;   // 索引重建中, 图谱等就绪再刷新
        // 重启 FileWatcher（旧 vault 的轮询不再有用）
        if (fileWatcher) fileWatcher.stop();
    }

        logger.log("开始索引构建: " + vaultRoot);

        // 扫描所有 .md 文件（walk 本身很快）
        var mdFiles = resolver.scanMdFiles(fs, path, vaultRoot);
        logger.log("找到 " + mdFiles.length + " 个 .md 文件");

    // 分批异步扫描，不阻塞 UI
    linkIndex.scanAsync(vaultRoot, mdFiles, function (success) {
        if (success) {
            var stats = linkIndex.getStats();
            logger.log("索引构建完成: " + stats.fileCount + " 文件, " + stats.linkCount + " 链接");

            // 持久化
            linkIndex.persist();

            // 索引就绪 → 图谱 (若打开) 即刻重建 — 不等图谱的 500ms 轮询
            // (vault 切换时旧索引残留在扫描期, 完成后立即刷新新图谱)
            try {
                if (graphView && typeof graphView.refresh === "function" &&
                    graphView.isOpen && graphView.isOpen()) {
                    graphView.refresh();
                }
            } catch (e) {}

            // 更新当前文件的面板
            var currentFile = getCurrentFilePath();
            if (currentFile && backlinksPanel) {
                backlinksPanel.update(currentFile);
            }

            // 索引就绪 → 重扫 wikilink 高亮。
            // 修复: 文件打开早于索引构建完成时, 所有链接因 allMdFiles 为空
            // 按断链灰显, 且不会自动恢复 (需切换标签页触发 DOM 重建才重扫)。
            if (highlightRenderer) highlightRenderer._rescanAll();

            // 索引构建完成后启动 FileWatcher
            if (fileWatcher) fileWatcher.start();

            if (onComplete) onComplete(true);
        }
    }, function (done, total) {
        // onProgress: 仅在慢索引时（>3s）显示进度
        // 当前不做额外处理，保持静默
    });
}

// ===================================================================
// 文件变更回调
// ===================================================================

function onFileChanged(filePath) {
    if (!linkIndex) return;
    logger.log("文件变更: " + path.basename(filePath));
    var result = linkIndex.indexFile(filePath);

    // 如果变化的是当前文件（新增/删除链接），刷新面板
    var currentFile = getCurrentFilePath();
    if (currentFile && backlinksPanel) {
        // 需要更新面板的情况：
        // 1. 变更的文件链接到了当前文件（反链可能变化）
        // 2. 当前文件自己变了（出链可能变化）
        backlinksPanel.update(currentFile);
    }

    // 图谱 (若打开) 增量刷新 — 编辑新增/删除双向链接后响应更新,
    // 防抖合并 (输入暂停 800ms 才重建, 避免编辑过程反复重建)
    scheduleGraphRefresh();

    // 定期持久化（文件变更后延迟 5 秒持久化）
    if (_persistTimer) _timers.clearTimeout(_persistTimer);
    _persistTimer = _timers.setTimeout(function () {
        if (linkIndex) linkIndex.persist();
        _persistTimer = null;
    }, 5000);
}

var _persistTimer = null;

// 图谱防抖刷新 (Obsidian 式: 编辑文件后图谱增量响应)
var _graphRefreshTimer = null;
function scheduleGraphRefresh() {
    if (!graphView || !graphView.isOpen || !graphView.isOpen()) return;
    if (_graphRefreshTimer) _timers.clearTimeout(_graphRefreshTimer);
    _graphRefreshTimer = _timers.setTimeout(function () {
        _graphRefreshTimer = null;
        try {
            if (graphView && graphView.isOpen && graphView.isOpen()) {
                graphView.refresh();
            }
        } catch (e) {}
    }, 800);
}

// ===================================================================
// 守护
// ===================================================================

function startGuard() {
    var _lastKnownPath = getCurrentFilePath();
    var _lastTitle = document.title || "";

    // 100ms 快速轮询 document.title — 读字符串零成本，标签切换必然变化
    var _fastPoll = _timers.setInterval(function () {
        // 只在面板打开时轮询
        if (!backlinksPanel || !backlinksPanel._active) return;
        var title = document.title || "";
        if (title !== _lastTitle) {
            _lastTitle = title;
            var resolved = resolvePathFromTitle(title);
            if (resolved && resolved !== _lastKnownPath) {
                _lastKnownPath = resolved;
                backlinksPanel.update(resolved);
            }
        }
    }, 100);

    _guardInterval = _timers.setInterval(function () {
        // 1. 检查文件是否切换（独立于 monkey-patch，tabs 切换时也会检测到）
        var currentPath = getCurrentFilePath();
        if (currentPath && currentPath !== _lastKnownPath) {
            _lastKnownPath = currentPath;
            if (backlinksPanel) {
                backlinksPanel.update(currentPath);
            }
        }
        // 更新 _lastKnownPath 防止错过（如文件关闭变为 null 后再打开）
        if (!currentPath) {
            _lastKnownPath = null;
        }

        // 2. 检查面板是否仍然存在
        var panelEl = document.getElementById("backlinks-content");
        var tabEl = document.getElementById("info-panel-tab-backlinks");
        var sidebar = document.getElementById("typora-sidebar");

        if (!panelEl && !tabEl && sidebar && linkIndex && linkIndex.allMdFiles.length > 0) {
            logger.log("面板 DOM 丢失，重新注入");
            if (backlinksPanel) {
                backlinksPanel.inject();
                var cf = getCurrentFilePath();
                if (cf) backlinksPanel.update(cf);
                _lastKnownPath = cf;
            }
        }

        // 3. 检查 monkey-patch 是否丢失 (library.switch only — openFile 由 BetterTypora 守护)
        if (_origLibSwitch && _libSwitchObj) {
            if (_libSwitchObj.switch === _origLibSwitch) {
                logger.log("library.switch patch 丢失，重新注入");
                patchLibrarySwitch();
            }
        }
    }, 1500);
}

// ===================================================================
// 生命周期
// ===================================================================

module.exports = {
    onLoad: function () {
        logger.log("双向链接插件加载完成");
    },

    enable: function () {
        _timers = BetterTypora.createTimerGroup();

        if (_initialized) {
            // 如果已经初始化过（disable 后又 enable），恢复面板即可
            if (backlinksPanel) {
                backlinksPanel.inject();
                var cf = getCurrentFilePath();
                if (cf) backlinksPanel.update(cf);
            }
            if (highlightRenderer) highlightRenderer.enable();
            if (fileWatcher) fileWatcher.start();
            patchLibrarySwitch();
            installFileOpenListener();
            installClickInterceptor();
            startGuard();
            return;
        }

        // --- 首次初始化（同步部分：毫秒级完成） ---
        var cacheDir = getCacheDir();

        // 1. 创建索引实例
        linkIndex = new LinkIndex(cacheDir, fs, path, parser, logger);
        linkIndex.setMaxSizeKb(api.getSetting("maxFileSizeKb", 500));

        // 2. 创建面板实例
        backlinksPanel = new BacklinksPanel(
            linkIndex, resolver, fs, path,
            function (filePath) {
                BetterTypora.openFile(filePath);
            },
            getCurrentFilePath
        );

        // 2b. 包装 panel.update：检测 vault 变化自动重建索引
        //     所有路径检测（patchOpenFile / title轮询 / 面板轮询 / guard）
        //     最终都调用 panel.update — 此处是唯一拦截点，无需额外轮询
        var _origPanelUpdate = backlinksPanel.update;
        backlinksPanel.update = function (filePath) {
            var vault = getVaultRoot();
            var indexVault = linkIndex ? linkIndex.vaultRoot : null;
            if (vault && indexVault &&
                vault.replace(/\\/g, "/").toLowerCase() !== indexVault.replace(/\\/g, "/").toLowerCase()) {
                logger.log("Vault 变化，自动重建索引: " +
                    path.basename(indexVault) + " → " + path.basename(vault));
                buildIndex();
                return;
            }
            return _origPanelUpdate.call(this, filePath);
        };

        // 3. 创建文件监控实例
        fileWatcher = new FileWatcher(linkIndex, onFileChanged, {
            pollIntervalMs: api.getSetting("pollIntervalMs", 2000),
        });

        // 4. Monkey-patch（同步，不阻塞）
        patchLibrarySwitch();

        // 5. 注册命令和热键（同步）
        api.registerCommand("toggle-panel", function () { if (backlinksPanel) backlinksPanel.toggle(); }, "切换反链面板");
        api.registerCommand("rebuild-index", function () {
            if (linkIndex) {
                buildIndex(function (success) {
                    if (success) window.BetterTypora.toast && window.BetterTypora.toast("🔄 索引已重建", 1500);
                });
            }
        }, "重建链接索引");
        api.registerCommand("open-backlink", function () { if (backlinksPanel) backlinksPanel.show(); }, "显示反链面板");

        // 6. 创建知识图谱视图（不挂载 DOM）
        if (!graphView) {
            graphView = new GraphView(linkIndex, resolver, function (filePath) {
                BetterTypora.openFile(filePath);
            }, PLUGIN_DIR);
        }
        api.registerCommand("graph-view", function () {
            if (graphView) graphView.toggle();
        }, "打开知识图谱");
        api.registerHotkey("bidirectional-links:graph-view", "Ctrl+Shift+G", "editorFocus");

        // 6a. 嵌入模式 (分屏图谱标签): 挂载 GraphView 到指定容器
        api.registerCommand("embed-graph", function (container) {
            if (!graphView) {
                graphView = new GraphView(linkIndex, resolver, function (filePath) {
                    BetterTypora.openFile(filePath);
                }, PLUGIN_DIR);
            }
            if (container) graphView.open(container);
            return graphView;
        }, "挂载知识图谱到容器 (split-view 图谱标签)");

        // 6b. 预加载 WebGPU device — 消除图谱打开后空白延迟
        //     requestAdapter + requestDevice 是唯一的异步操作（100–500ms），
        //     在插件加载时后台完成，用户打开图谱时 device 已就绪。
        var GraphRendererGPU_preload;
        try {
            GraphRendererGPU_preload = pluginRequire(path.join(PLUGIN_DIR, "graph-renderer-gpu.js"));
            if (GraphRendererGPU_preload && GraphRendererGPU_preload.preloadDevice) {
                GraphRendererGPU_preload.preloadDevice();
            }
        } catch (e) { /* GPU 不可用，跳过 */ }

        // 7. 引导面板（立刻注入空壳，有缓存则快速填充）
        _timers.setTimeout(function () {
            if (backlinksPanel) backlinksPanel.inject();
        }, 50);

        // --- 异步初始化（分批 schedule，不阻塞 UI） ---
        _timers.setTimeout(function () {
            installFileOpenListener();
        }, 50);

        _timers.setTimeout(function () { installClickInterceptor(); }, 100);

        // 8a. 启动 Wikilink Highlight 渲染（CSS Custom Highlight API，零 DOM 触碰）
        highlightRenderer = new HighlightRenderer(parser, resolver, linkIndex, fs, path);
        // 延迟启用，等 Typora 先完成初始渲染
        _timers.setTimeout(function () { highlightRenderer.enable(); }, 800);

        // 8b. 加载缓存 + 索引（带重试，Typora 初始化可能滞后于 setTimeout 30ms）
        var _initTimer;
        var _initRetries = 0;
        _initTimer = _timers.setTimeout(function () {
            var vaultRoot = getVaultRoot();
            if (!vaultRoot) {
                _initRetries++;
                // 放宽重试窗口 (50ms × 600 = 30s): Typora 延迟恢复文件夹上下文时,
                // vault 可能在打开文件后才出现 (单文件打开后切到文件夹内其他文件)
                if (_initRetries <= 600) {
                    _initTimer = _timers.setTimeout(arguments.callee, 50);
                    return;
                }
                logger.warn("无法获取 vault 根目录，跳过索引初始化");
                return;
            }

            var cacheLoaded = linkIndex.load();
            if (cacheLoaded && linkIndex.isCacheValidFor(vaultRoot)) {
                var stats = linkIndex.getStats();
                logger.log("从缓存加载索引: " + stats.fileCount + " 文件, " + stats.linkCount + " 链接");
                fileWatcher.start();
                var cf = getCurrentFilePath();
                if (cf && backlinksPanel) backlinksPanel.update(cf);
                // 索引就绪 → 重扫高亮 (同上: 避免打开早于索引加载导致链接全灰)
                if (highlightRenderer) highlightRenderer._rescanAll();
            } else {
                buildIndex();
            }
        }, 30);

        // 9. 启动守护
        _timers.setTimeout(function () { startGuard(); }, 200);

        // 10. 自动注入 SharedArrayBuffer flag 到 conf.user.json
        //     下次重启 Typora 后生效，Worker↔Main 零拷贝通信
        _timers.setTimeout(function () { ensureSABFlag(); }, 500);

        _initialized = true;
        logger.log("双向链接插件启用完成 ✅");
    },

    disable: function () {
        logger.log("停用双向链接插件");

        // 停止文件监控
        if (fileWatcher) {
            fileWatcher.stop();
        }

        // 移除面板
        if (backlinksPanel) {
            backlinksPanel.remove();
        }

        // 恢复 library.switch
        unpatchLibrarySwitch();
        uninstallFileOpenListener();

        // 移除 click 拦截
        uninstallClickInterceptor();

        // 移除 highlight 渲染
        if (highlightRenderer) {
            highlightRenderer.disable();
            highlightRenderer = null;
        }

        // 关闭并销毁图谱
        if (graphView) {
            graphView.destroy();
            graphView = null;
        }

        // 清理所有定时器
        if (_timers) {
            _timers.close();
            _timers = null;
        }

        // 停止守护
        if (_guardInterval) {
            clearInterval(_guardInterval);
            _guardInterval = null;
        }

        // 持久化索引
        if (linkIndex) {
            if (_persistTimer) clearTimeout(_persistTimer);
            linkIndex.persist();
        }

        // 清理 DOM 残留
        var leftovers = document.querySelectorAll("[data-plugin-id='bidirectional-links']");
        for (var i = 0; i < leftovers.length; i++) {
            if (leftovers[i].parentNode) {
                leftovers[i].parentNode.removeChild(leftovers[i]);
            }
        }

        logger.log("双向链接插件已停用");
    },

    onUnload: function () {
        if (_initialized) {
            if (fileWatcher) fileWatcher.stop();
            unpatchLibrarySwitch();
            uninstallFileOpenListener();
            uninstallClickInterceptor();
            if (highlightRenderer) { highlightRenderer.disable(); highlightRenderer = null; }
            if (graphView) { graphView.destroy(); graphView = null; }
            if (_timers) { _timers.close(); _timers = null; }
            if (_guardInterval) clearInterval(_guardInterval);
            if (_persistTimer) clearTimeout(_persistTimer);
            if (linkIndex) linkIndex.persist();
        }
        logger.log("双向链接插件已卸载");
    },
};
