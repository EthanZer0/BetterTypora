/**
 * Memory Manager — 内存优化器 (无 UI)
 * =========================================
 * 定位: 实时减小内存占用, 不是监控。
 *
 * 手段 (按收益排序, 全部无害可逆):
 *   1. 强制 GC (gc_interval flag 技巧): 通过 v8.setFlagsFromString 临时开启
 *      --gc_interval 触发 full GC 后立即恢复。几乎不分配, 不推高 V8 动态
 *      堆水位 (分配压力法会让堆记住高水位、回收后不收缩 — 教训)。
 *   2. webview 缓存清理: 对主窗口内的 webview 元素 (偏好设置等) 调用
 *      clearData({cache:true}), 清除其图片/字体等磁盘+内存缓存。
 *   3. (附带) 采样与报告: 记录整理前后的堆差值, 证明优化效果。
 *
 * 触发: 空闲 (无编辑活动) 时每 N 分钟自动整理一次; 手动命令立即整理。
 * 边界: 渲染进程 RSS 的大头 (Chromium DOM/合成层/GPU) 插件无法触碰,
 *       本插件优化的上限是 JS 堆 + webview 缓存。
 */
var BetterTypora = require("bettertypora:api");
var api = BetterTypora.api;
var logger = BetterTypora.logger;

/* ------------------------------------------------------------------ */
/* 状态                                                                 */
/* ------------------------------------------------------------------ */

var lastActivity = Date.now();      // 最后编辑活动时间 (空闲判断)
var lastOptimizeAt = 0;             // 上次自动整理时间
var lastWebviewClearAt = 0;         // 上次 webview 缓存清理时间
var lastTrimAt = 0;                 // 上次工作集修剪时间
var trimBusy = false;               // 修剪进行中 (防重入)
var optimizeStats = [];             // 最近整理记录 {t, freedMB}
var timers = [];                    // 待清理定时器

var RING_MAX = 60;
var ring = [];                      // 采样 {t, rss, heapUsed} (报告/效果展示)

/* ------------------------------------------------------------------ */
/* 工具                                                                 */
/* ------------------------------------------------------------------ */

function mb(bytes) {
    return bytes === undefined || bytes === null ? "N/A" : (bytes / 1048576).toFixed(1) + " MB";
}

function tryGet(fn, fallback) {
    try {
        var v = fn();
        return v === undefined ? fallback : v;
    } catch (e) {
        return fallback;
    }
}

function heapUsedNow() {
    var mu = tryGet(function () { return process.memoryUsage(); }, null);
    return mu ? mu.heapUsed : 0;
}

/* ------------------------------------------------------------------ */
/* 活动监听 (空闲判断 → 自动整理时机)                                      */
/* ------------------------------------------------------------------ */

function markActivity() {
    lastActivity = Date.now();
}

function bindActivityListeners() {
    var evts = ["keydown", "mousedown", "wheel", "touchstart"];
    for (var i = 0; i < evts.length; i++) {
        document.addEventListener(evts[i], markActivity, true);
    }
    try {
        window.BetterTypora.onFileEvent("opened", markActivity);
        window.BetterTypora.onFileEvent("closing", markActivity);
    } catch (e) {}
}

/* ------------------------------------------------------------------ */
/* 强制 GC — gc_interval flag 技巧                                       */
/* ------------------------------------------------------------------ */

/**
 * 通过 v8.setFlagsFromString 临时开启 --gc_interval (运行时可变 flag):
 * 每次分配超过指定字节数即触发 full GC, 随后立刻恢复。几乎不分配,
 * 因此不会像"分配压力法"那样推高 V8 动态堆水位 (后者会导致堆
 * 记住高水位, 回收后也不收缩 — 教训)。
 * 若 flag 在 Electron 中被禁用, 返回 false, 调用方降级 (放弃主动 GC)。
 */
function forceGC() {
    var v8 = tryGet(function () { return require("v8"); }, null);
    if (!v8 || typeof v8.setFlagsFromString !== "function") return false;
    try {
        v8.setFlagsFromString("--gc_interval=512");   // 每 512KB 分配触发 full GC
        var trigger = new Array(128 * 1024).fill(1);  // ~1MB 分配, 必然触发
        trigger = null;
        v8.setFlagsFromString("--gc_interval=0");     // 恢复默认
        return true;
    } catch (e) {
        try { v8.setFlagsFromString("--gc_interval=0"); } catch (e2) {}
        return false;
    }
}

/* ------------------------------------------------------------------ */
/* 工作集修剪 — SetProcessWorkingSetSize                                */
/* ------------------------------------------------------------------ */

/**
 * 对全部 Typora 进程执行工作集修剪 (页面换出到页面文件)。
 * 机制诚实说明: 不是释放内存, 是让出驻留物理内存; 任务管理器数字立降,
 * 系统内存紧张时 OS 会直接回收这些页面; 代价是切回时短暂缺页。
 * 单个 PowerShell 脚本内完成 修剪前统计 → 修剪 → 修剪后统计, 输出
 * "sum0|sum1" (字节)。execFile 直传参数, 避免 cmd 引号转义层。
 */
function trimWorkingSet(cb) {
    var script =
        "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;" +
        "$procs = Get-Process | Where-Object { $_.Name -like '*ypora*' };" +
        "$sum0 = ($procs | Measure-Object -Property WorkingSet64 -Sum).Sum;" +
        "Add-Type -TypeDefinition 'using System;using System.Runtime.InteropServices;" +
        "public class MemWS{[DllImport(\"kernel32.dll\")]public static extern bool SetProcessWorkingSetSize(System.IntPtr proc,int min,int max);}';" +
        "$procs | ForEach-Object { [MemWS]::SetProcessWorkingSetSize($_.Handle,-1,-1) };" +
        "Start-Sleep -Milliseconds 500;" +
        "$sum1 = (Get-Process | Where-Object { $_.Name -like '*ypora*' } | Measure-Object -Property WorkingSet64 -Sum).Sum;" +
        "Write-Output (\"$sum0|$sum1\")";

    try {
        require("child_process").execFile("powershell",
            ["-NoProfile", "-Command", script],
            { windowsHide: true, timeout: 20000 },
            function (err, stdout) {
                if (err || !stdout) { cb(null); return; }
                var m = /(\d+)\|(\d+)/.exec(stdout);
                if (!m) { cb(null); return; }
                cb({
                    before: parseInt(m[1], 10),
                    after: parseInt(m[2], 10)
                });
            });
    } catch (e) {
        cb(null);
    }
}

/* ------------------------------------------------------------------ */
/* webview 缓存清理                                                     */
/* ------------------------------------------------------------------ */

function clearWebviewCaches() {
    var views = document.querySelectorAll("webview");
    var cleared = 0;
    for (var i = 0; i < views.length; i++) {
        try {
            if (typeof views[i].clearData === "function") {
                views[i].clearData({ cache: true }, function () {});
                cleared++;
            }
        } catch (e) {}
    }
    if (cleared > 0) {
        logger.log("已清理 " + cleared + " 个 webview 的缓存");
    }
    return cleared;
}

/* ------------------------------------------------------------------ */
/* 核心: 内存整理                                                        */
/* ------------------------------------------------------------------ */

/**
 * 执行一轮内存整理, 返回释放的 JS 堆字节数。
 * @param {boolean} manual 手动触发 (webview 缓存清理不受 1h 限频约束)
 */
function optimize(manual) {
    var before = heapUsedNow();

    // 两轮强制 GC (gc_interval 技巧, 不推高堆水位)
    var gcOk1 = forceGC();
    var gcOk2 = forceGC();

    var after = heapUsedNow();
    var freed = before - after;

    // webview 缓存: 手动整理不受限频; 自动整理限频 (默认 1h, 可设置)
    var now = Date.now();
    var clearIntervalMs = api.getSetting("webviewClearIntervalMinutes", 60) * 60000;
    if (manual || now - lastWebviewClearAt > clearIntervalMs) {
        clearWebviewCaches();
        lastWebviewClearAt = now;
    }

    var freedMB = freed / 1048576;
    optimizeStats.push({
        t: now,
        freedMB: Math.round(freedMB * 10) / 10
    });
    if (optimizeStats.length > 20) optimizeStats.shift();

    var msg = "内存整理完成: JS 堆 " + mb(before) + " → " + mb(after) +
        (freedMB > 1 ? " (释放 " + freedMB.toFixed(1) + " MB)" : " (堆已紧凑)");
    if (!gcOk1 && !gcOk2) {
        msg += " [主动GC不可用, 仅清理webview缓存]";
    }
    logger.log(msg);

    // 顺带修剪工作集 (异步, 单独汇报)
    trimWorkingSet(function (res) {
        if (res) {
            logger.log("工作集修剪: " + mb(res.before) + " → " + mb(res.after));
        }
    });
    return freed;
}

/** 手动命令: 仅修剪工作集 */
function trimNow() {
    window.BetterTypora.toast("正在修剪工作集...", 2000);
    trimWorkingSet(function (res) {
        if (!res) {
            window.BetterTypora.toast("工作集修剪失败 (PowerShell 不可用?)", 3000);
            return;
        }
        var freedMB = (res.before - res.after) / 1048576;
        var msg = "工作集 " + mb(res.before) + " → " + mb(res.after) +
            (freedMB > 1 ? " (减少 " + freedMB.toFixed(1) + " MB)" : "");
        logger.log(msg);
        window.BetterTypora.toast(msg, 4000);
    });
}

/* ------------------------------------------------------------------ */
/* 自动调度: 空闲时每 N 分钟整理一次                                       */
/* ------------------------------------------------------------------ */

function autoTick() {
    var now = Date.now();
    var idleMs = api.getSetting("optimizeIdleMinutes", 5) * 60000;
    var intervalMs = api.getSetting("optimizeIntervalMinutes", 15) * 60000;

    // 采样 (报告用)
    ring.push({
        t: now,
        rss: tryGet(function () { return process.memoryUsage().rss; }, 0),
        heapUsed: heapUsedNow()
    });
    if (ring.length > RING_MAX) ring.shift();

    // 空闲超过阈值且距上次整理超过间隔 → 自动整理
    if (now - lastActivity >= idleMs && now - lastOptimizeAt >= intervalMs) {
        lastOptimizeAt = now;
        optimize(false);
    }

    // 空闲时低频修剪工作集 (默认 30 分钟一次)
    var trimIntervalMs = api.getSetting("trimIntervalMinutes", 30) * 60000;
    if (!trimBusy && now - lastTrimAt >= trimIntervalMs &&
            now - lastActivity >= idleMs) {
        trimBusy = true;
        trimWorkingSet(function () {
            trimBusy = false;
        });
        lastTrimAt = now;
    }
}

/* ------------------------------------------------------------------ */
/* 命令                                                                 */
/* ------------------------------------------------------------------ */

function optimizeNow() {
    var before = heapUsedNow();
    optimize(true);
    var after = heapUsedNow();
    var freedMB = (before - after) / 1048576;
    window.BetterTypora.toast(
        freedMB > 1 ? "内存整理完成, 释放 " + freedMB.toFixed(1) + " MB" : "内存整理完成 (堆已紧凑)",
        3000
    );
}

function report() {
    logger.log("===== 内存整理报告 =====");
    var mu = tryGet(function () { return process.memoryUsage(); }, null);
    console.table([{
        rendererRss: mb(mu && mu.rss),
        jsHeapUsed: mb(mu && mu.heapUsed),
        jsHeapTotal: mb(mu && mu.heapTotal),
        samples: ring.length
    }]);
    if (optimizeStats.length) {
        logger.log("【近期整理记录】");
        console.table(optimizeStats.slice(-10));
    } else {
        logger.log("尚未执行过整理 (空闲 5 分钟后自动开始)");
    }
    logger.log("===== 报告结束 =====");
    window.BetterTypora.toast("报告已输出到控制台", 2500);
}

/* ------------------------------------------------------------------ */
/* 生命周期                                                             */
/* ------------------------------------------------------------------ */

exports.onLoad = function () {
    bindActivityListeners();

    api.registerCommand("optimize-now", optimizeNow, "立即内存整理");
    api.registerCommand("trim-now", trimNow, "立即修剪工作集");
    api.registerCommand("report", report, "内存整理报告 (控制台)");

    // 调度: 每 30s 检查一次空闲状态
    timers.push(setInterval(autoTick, 30000));
    autoTick();

    logger.log("内存优化器已启用: 空闲 " + api.getSetting("optimizeIdleMinutes", 5) +
        " 分钟后每 " + api.getSetting("optimizeIntervalMinutes", 15) + " 分钟自动整理");
};

exports.onUnload = function () {
    for (var i = 0; i < timers.length; i++) {
        clearInterval(timers[i]);
    }
    timers = [];
    ring = [];
    optimizeStats = [];
    try {
        window.BetterTypora.offFileEvent("opened", markActivity);
        window.BetterTypora.offFileEvent("closing", markActivity);
    } catch (e) {}
    logger.log("内存优化器已卸载, 自动整理停止");
};
