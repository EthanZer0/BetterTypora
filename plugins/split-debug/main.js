/**
 * Split Debug v0.8 — 滚动恢复链路追踪
 * ======================================
 * 定位"恢复滚动失败跳顶部"。包装 File.recoverPosOrScroll 观察调用参数,
 * 监听编辑器滚动和文件打开事件, 输出完整时间线。
 *
 * 命令: split-debug:trace
 *   1. 包装 File.recoverPosOrScroll: 输出调用参数 (scrollOffset/timeStamp)
 *      + 当前文件 — 直接看到 split-view 恢复时传的值
 *   2. 监听 content(editorEl) 滚动: 输出 scrollTop — 确认滚动记录环节
 *   3. 监听 opened 事件: 输出文件路径 — 确认路径一致性
 */
var BetterTypora = require("bettertypora:api");
var api = BetterTypora.api;
var logger = BetterTypora.logger;

function editorEl() {
    try {
        return File.editor.writingArea.parentElement;
    } catch (e) {
        return null;
    }
}

function base(p) {
    return p ? String(p).split(/[\\/]/).pop() : "null";
}

function run() {
    logger.log("===== 滚动恢复链路追踪开始 =====");

    // 1. 包装 File.recoverPosOrScroll
    try {
        var orig = File.recoverPosOrScroll;
        if (orig && !File.__btTraced) {
            File.__btTraced = true;
            File.recoverPosOrScroll = function (e) {
                logger.log("[recover调用] e=" + JSON.stringify(e) +
                    " | 当前文件=" + base(File.bundle.filePath) +
                    " | content.scrollTop=" + (editorEl() ? editorEl().scrollTop : "?"));
                return orig.apply(this, arguments);
            };
            logger.log("已包装 File.recoverPosOrScroll");
        }
    } catch (e) {
        logger.log("包装失败: " + e.message);
    }

    // 2. 监听编辑器滚动
    var ee = editorEl();
    if (ee) {
        ee.addEventListener("scroll", function () {
            logger.log("[编辑器滚动] scrollTop=" + ee.scrollTop +
                " | 当前文件=" + base(BetterTypora.getCurrentFile()));
        }, { passive: true });
        logger.log("已监听编辑器滚动 (当前 content.scrollTop=" + ee.scrollTop + ")");
    }

    // 3. 监听 opened 事件
    window.BetterTypora.onFileEvent("opened", function (data) {
        logger.log("[opened事件] path=" + base(data && data.path));
    });
    logger.log("已监听 opened 事件");

    logger.log(">>> 操作: 1) 滚动编辑器到任意位置  2) 点击另一栏切换焦点");
    logger.log(">>> 追踪将持续 30 秒");
    setTimeout(function () {
        logger.log("===== 追踪结束 =====");
    }, 30000);
}

exports.onLoad = function () {
    api.registerCommand("trace", run, "滚动恢复链路追踪");
    logger.log("split-debug v0.8 已加载: split-debug:trace");
};

exports.onUnload = function () {};
