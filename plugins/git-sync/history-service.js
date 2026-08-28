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
            if (result.success) self.store.update({ commits: result.commits || [], historyDetail: null });
            return result;
        });
    };

    HistoryService.prototype.diff = function (root, filePath) {
        return this.adapter.diff(root, filePath).then(function (result) {
            return result.success ? { success: true, diff: result.output || "无未提交差异" } : result;
        });
    };

    function isMissingRevisionFile(error) {
        return /does not exist in|exists on disk, but not in|path .* not in/i.test(String(error || ""));
    }

    function revisionFile(adapter, root, revision, filePath) {
        if (!revision) return Promise.resolve({ success: true, missing: true, output: "" });
        return adapter.show(root, revision, filePath).then(function (result) {
            if (!result.success && isMissingRevisionFile(result.error)) return { success: true, missing: true, output: "" };
            return result;
        });
    }

    /* 构造纯只读比较模型：旧版本来自 HEAD，右侧始终是工作区落盘内容。 */
    HistoryService.prototype.compareFile = function (root, filePath, fileInfo) {
        var info = fileInfo || {};
        var oldPath = info.previousPath || filePath;
        var code = String(info.code || "");
        var isUntracked = code === "??";
        var before = isUntracked
            ? Promise.resolve({ success: true, missing: true, output: "" })
            : revisionFile(this.adapter, root, "HEAD", oldPath);
        return Promise.all([
            before,
            this.adapter.readWorktreeFile(root, filePath),
            this.adapter.diffPatch(root, oldPath, filePath)
        ]).then(function (results) {
            var left = results[0];
            var right = results[1];
            var patch = results[2];
            if (!left.success) return { success: false, error: left.error || "无法读取 HEAD 版本" };
            if (!right.success) return { success: false, error: right.error || "无法读取工作区版本" };
            if (!patch.success) return { success: false, error: patch.error || "无法读取 Git 差异" };
            return {
                success: true,
                root: root,
                path: filePath,
                oldPath: oldPath,
                beforeText: left.output || "",
                afterText: right.output || "",
                patch: patch.output || "",
                beforeMissing: !!left.missing,
                afterMissing: !!right.missing,
                changeCode: code,
                beforeLabel: left.missing ? "HEAD · 不存在" : "HEAD",
                afterLabel: right.missing ? "工作区 · 已删除" : "工作区"
            };
        });
    };

    /* 读取快照详情时只返回该提交的直接变更，不扫描整个仓库。 */
    HistoryService.prototype.loadCommitFiles = function (root, revision) {
        return this.adapter.commitFiles(root, revision);
    };

    /* 构造“父快照 → 当前快照”的只读文件比较模型。 */
    HistoryService.prototype.compareSnapshotFile = function (root, revision, fileInfo) {
        var info = fileInfo || {};
        var oldPath = info.previousPath || info.path;
        var newPath = info.path;
        var self = this;
        return this.adapter.commitParent(root, revision).then(function (parentResult) {
            if (!parentResult.success) return parentResult;
            var parent = parentResult.parent;
            return Promise.all([
                revisionFile(self.adapter, root, parent, oldPath),
                revisionFile(self.adapter, root, revision, newPath),
                self.adapter.commitDiffPatch(root, parent, revision, oldPath, newPath)
            ]).then(function (results) {
                var left = results[0];
                var right = results[1];
                var patch = results[2];
                if (!left.success) return { success: false, error: left.error || "无法读取前一快照" };
                if (!right.success) return { success: false, error: right.error || "无法读取目标快照" };
                if (!patch.success) return { success: false, error: patch.error || "无法读取快照差异" };
                var shortRevision = String(revision).substring(0, 7);
                var shortParent = parent ? String(parent).substring(0, 7) : "无";
                return {
                    success: true,
                    root: root,
                    path: newPath,
                    oldPath: oldPath,
                    beforeText: left.output || "",
                    afterText: right.output || "",
                    patch: patch.output || "",
                    beforeMissing: !!left.missing,
                    afterMissing: !!right.missing,
                    changeCode: info.code || "M",
                    beforeLabel: left.missing ? "前一快照 · 不存在" : "前一快照 · " + shortParent,
                    afterLabel: right.missing ? "当前快照 · 已删除" : "当前快照 · " + shortRevision
                };
            });
        });
    };

    if (typeof module !== "undefined") module.exports = HistoryService;
})();
