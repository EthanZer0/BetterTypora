/* 历史与差异查询服务，保持只读，避免面板直接拼装 Git 命令。 */
(function () {
    "use strict";

    function HistoryService(adapter, store) {
        this.adapter = adapter;
        this.store = store;
    }

    HistoryService.prototype.load = function (root, limit) {
        var self = this;
        return this.adapter.log(root, limit || 20).then(function (result) {
            if (result.success) self.store.update({ commits: result.commits || [] });
            return result;
        });
    };

    HistoryService.prototype.diff = function (root, filePath) {
        return this.adapter.diff(root, filePath).then(function (result) {
            return result.success ? { success: true, diff: result.output || "无未提交差异" } : result;
        });
    };

    if (typeof module !== "undefined") module.exports = HistoryService;
})();
