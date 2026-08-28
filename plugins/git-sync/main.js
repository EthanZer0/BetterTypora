/* Git 同步入口：只编排生命周期，Git、工作区、同步流程和 UI 各自保持独立。 */
var BT = require("bettertypora:api");
var api = BT.api;
var logger = BT.logger;
var GitAdapter = require("./git-adapter");
var WorkspaceService = require("./workspace-service");
var StateStore = require("./state-store");
var HistoryService = require("./history-service");
var SyncEngine = require("./sync-engine");
var Statusbar = require("./statusbar");
var Panel = require("./panel");

var adapter = null;
var workspace = null;
var store = null;
var history = null;
var engine = null;
var statusbar = null;
var panel = null;
var timers = null;
var unsubscribers = [];

function setting(key, fallback) {
    var value = api.getSetting(key, fallback);
    return value === undefined || value === null ? fallback : value;
}

function addUnsubscriber(unsubscribe) {
    if (typeof unsubscribe === "function") unsubscribers.push(unsubscribe);
}

function scheduleStatusbarMount() {
    if (statusbar.mount()) return;
    // footer 可能在插件加载后才由 Typora 创建，延迟挂载但不启动独立轮询。
    timers.setTimeout(function () { if (statusbar && !statusbar.el) statusbar.mount(); }, 1200);
}

module.exports = {
    onLoad: function () {
        store = new StateStore();
        adapter = new GitAdapter(logger);
        workspace = new WorkspaceService(BT, adapter, setting, logger);
        history = new HistoryService(adapter, store);
        engine = new SyncEngine(BT, adapter, workspace, store, history, setting, logger);
        timers = BT.createTimerGroup();
        statusbar = new Statusbar(store, function () { if (panel) panel.toggle(); }, BT.escapeHtml);
        panel = new Panel(store, engine, BT, BT.escapeHtml, timers);
    },

    enable: function () {
        var self = this;
        panel.mount();
        scheduleStatusbarMount();

        api.registerCommand("toggle-panel", function () { panel.toggle(); }, "打开 Git 同步面板");
        api.registerCommand("save-snapshot", function () { return engine.saveSnapshot(); }, "保存 Git 本地快照");
        api.registerCommand("sync", function () { return engine.sync(); }, "同步笔记仓库");
        api.registerCommand("fetch", function () { return engine.fetch(); }, "获取远程仓库状态");
        api.registerCommand("show-diff", function () { panel.open(); return engine.diffCurrent(); }, "查看当前文档差异");
        api.registerCommand("show-history", function () { panel.open(); return engine.loadHistory(); }, "查看 Git 快照历史");

        addUnsubscriber(BT.onFileEvent("opened", function () {
            engine.refresh();
            if (setting("autoFetchOnOpen", false)) timers.setTimeout(function () { engine.fetch(); }, 250);
        }));
        addUnsubscriber(BT.onFileEvent("saved", function () { engine.refresh(); }));
        addUnsubscriber(BT.onFileEvent("renamed", function () { engine.refresh(); }));
        addUnsubscriber(api.onSettingChange(function () { engine.refresh(); }));

        engine.refresh();
    },

    disable: function () {
        for (var i = 0; i < unsubscribers.length; i++) {
            try { unsubscribers[i](); } catch (e) {}
        }
        unsubscribers = [];
        if (panel) panel.close();
        if (statusbar) statusbar.destroy();
        if (panel) panel.destroy();
        if (timers) timers.close();
    },

    onUnload: function () {
        engine = null;
        history = null;
        workspace = null;
        adapter = null;
        store = null;
        statusbar = null;
        panel = null;
        timers = null;
    }
};
