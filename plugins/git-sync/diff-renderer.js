/**
 * Git Plugin — Diff 渲染器
 * =============================
 * 将 git diff 原始文本输出转换为 HTML 高亮显示。
 * 支持统一视图 (unified) 和并排视图 (side-by-side)。
 */
(function () {
    "use strict";

    // ===================================================================
    // HTML 转义
    // ===================================================================

    function escapeHtml(str) {
        if (!str) return "";
        return str
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;");
    }

    // ===================================================================
    // Diff 统计解析
    // ===================================================================

    function parseDiffStats(rawDiff) {
        if (!rawDiff) return { additions: 0, deletions: 0, files: 0 };
        var lines = rawDiff.split("\n");
        var add = 0, del = 0, fileCount = 0;
        for (var i = 0; i < lines.length; i++) {
            var line = lines[i];
            if (line.indexOf("+++ ") === 0 || line.indexOf("--- ") === 0) continue;
            if (line.indexOf("diff --git") === 0) {
                fileCount++;
            }
            if (line.charAt(0) === "+" && line.indexOf("+++") !== 0) add++;
            if (line.charAt(0) === "-" && line.indexOf("---") !== 0) del++;
        }
        return { additions: add, deletions: del, files: fileCount };
    }

    // ===================================================================
    // 统一视图渲染 (类似 git diff 默认输出)
    // ===================================================================

    function renderUnified(rawDiff) {
        if (!rawDiff) return "<div class='git-diff-empty'>无改动</div>";

        var lines = rawDiff.split("\n");
        var html = "<div class='git-diff-unified'>";
        var inFileHeader = false;

        for (var i = 0; i < lines.length; i++) {
            var line = lines[i];
            var escaped = escapeHtml(line);

            // 文件头: diff --git a/xxx b/xxx
            if (line.indexOf("diff --git") === 0) {
                // 提取文件名
                var match = line.match(/diff --git a\/(.+) b\/(.+)/);
                if (match) {
                    html += "<div class='git-diff-file-header'>" + escapeHtml(match[1]) + "</div>";
                }
                inFileHeader = true;
                continue;
            }

            // index 行、mode 行等元数据
            if (inFileHeader && (line.indexOf("index ") === 0 || line.indexOf("new file") === 0 ||
                line.indexOf("deleted file") === 0 || line.indexOf("rename ") === 0 ||
                line.indexOf("similarity ") === 0)) {
                html += "<div class='git-diff-meta'>" + escaped + "</div>";
                continue;
            }

            // --- a/xxx 和 +++ b/xxx
            if (line.indexOf("--- ") === 0 || line.indexOf("+++ ") === 0) {
                inFileHeader = false;
                html += "<div class='git-diff-file-marker'>" + escaped + "</div>";
                continue;
            }

            // Hunk header: @@ -x,y +a,b @@
            if (line.indexOf("@@") === 0) {
                html += "<div class='git-diff-hunk-header'>" + escaped + "</div>";
                continue;
            }

            // 新增行
            if (line.charAt(0) === "+" && line.indexOf("+++") !== 0) {
                html += "<div class='git-diff-add'>" + escaped + "</div>";
                continue;
            }

            // 删除行
            if (line.charAt(0) === "-" && line.indexOf("---") !== 0) {
                html += "<div class='git-diff-del'>" + escaped + "</div>";
                continue;
            }

            // 上下文行
            html += "<div class='git-diff-ctx'>" + escaped + "</div>";
        }

        html += "</div>";
        return html;
    }

    // ===================================================================
    // 并排视图渲染
    // ===================================================================

    function renderSideBySide(rawDiff) {
        if (!rawDiff) return "<div class='git-diff-empty'>无改动</div>";

        // 解析 diff 为 hunks，然后并排渲染
        var hunks = parseHunks(rawDiff);
        if (!hunks.length) return "<div class='git-diff-empty'>无改动</div>";

        var html = "<div class='git-diff-side-by-side'>";

        for (var h = 0; h < hunks.length; h++) {
            var hunk = hunks[h];

            // 文件头
            if (hunk.fileName) {
                html += "<div class='git-diff-file-header'>" + escapeHtml(hunk.fileName) + "</div>";
            }

            // 列标题
            html += "<div class='git-diff-sbs-header'>";
            html += "<div class='git-diff-sbs-left-header'>旧版本</div>";
            html += "<div class='git-diff-sbs-right-header'>新版本</div>";
            html += "</div>";

            // Hunk header 跨越两列
            html += "<div class='git-diff-sbs-hunk'>";
            html += "<div class='git-diff-hunk-header'>" + escapeHtml(hunk.header || "") + "</div>";
            html += "</div>";

            // 处理 hunk 行，对齐左右
            var aligned = alignHunkLines(hunk.lines);

            for (var a = 0; a < aligned.length; a++) {
                var row = aligned[a];
                html += "<div class='git-diff-sbs-row'>";

                if (row.isFiller) {
                    // 只在右侧有内容
                    html += "<div class='git-diff-sbs-left git-diff-sbs-empty'></div>";
                    html += "<div class='git-diff-sbs-right " + row.rightClass + "'>" + escapeHtml(row.right || "") + "</div>";
                } else if (row.left && row.right && row.leftClass === "git-diff-del" && row.rightClass === "git-diff-add") {
                    // 修改行：左旧右新
                    html += "<div class='git-diff-sbs-left " + row.leftClass + "'>" + escapeHtml(row.left) + "</div>";
                    html += "<div class='git-diff-sbs-right " + row.rightClass + "'>" + escapeHtml(row.right) + "</div>";
                } else {
                    html += "<div class='git-diff-sbs-left " + (row.leftClass || "git-diff-ctx") + "'>" + escapeHtml(row.left || "") + "</div>";
                    html += "<div class='git-diff-sbs-right " + (row.rightClass || "git-diff-ctx") + "'>" + escapeHtml(row.right || "") + "</div>";
                }

                html += "</div>";
            }
        }

        html += "</div>";
        return html;
    }

    /**
     * 解析 diff 输出为 hunks 数组
     * [{fileName, header, lines: [{type, content}]}]
     */
    function parseHunks(rawDiff) {
        if (!rawDiff) return [];

        var lines = rawDiff.split("\n");
        var hunks = [];
        var currentHunk = null;
        var currentFileName = "";

        for (var i = 0; i < lines.length; i++) {
            var line = lines[i];

            // 文件头
            if (line.indexOf("diff --git") === 0) {
                if (currentHunk && currentHunk.lines.length > 0) {
                    hunks.push(currentHunk);
                }
                var match = line.match(/diff --git a\/(.+) b\/(.+)/);
                currentFileName = match ? match[1] : "";
                currentHunk = { fileName: currentFileName, header: "", lines: [] };
                continue;
            }

            // 跳过元数据行
            if (line.indexOf("index ") === 0 || line.indexOf("new file") === 0 ||
                line.indexOf("deleted file") === 0 || line.indexOf("rename ") === 0 ||
                line.indexOf("similarity ") === 0 || line.indexOf("--- ") === 0 ||
                line.indexOf("+++ ") === 0) {
                continue;
            }

            if (!currentHunk) {
                currentHunk = { fileName: currentFileName, header: "", lines: [] };
            }

            // Hunk header
            if (line.indexOf("@@") === 0) {
                currentHunk.header = line;
                currentHunk.lines.push({ type: "hunk", content: line });
                continue;
            }

            // 分类每行
            if (line.charAt(0) === "+" && line.indexOf("+++") !== 0) {
                currentHunk.lines.push({ type: "add", content: line.substring(1) });
            } else if (line.charAt(0) === "-" && line.indexOf("---") !== 0) {
                currentHunk.lines.push({ type: "del", content: line.substring(1) });
            } else {
                currentHunk.lines.push({ type: "ctx", content: line.substring(1) || line });
            }
        }

        if (currentHunk && currentHunk.lines.length > 0) {
            hunks.push(currentHunk);
        }

        return hunks;
    }

    /**
     * 对齐 hunk 行，使左侧和右侧能并排显示
     * 将连续的 del+add 配对为修改行，多余的 del 或 add 单独显示
     */
    function alignHunkLines(lines) {
        var result = [];
        var i = 0;

        while (i < lines.length) {
            var line = lines[i];

            if (line.type === "hunk") {
                result.push({ left: line.content, right: line.content, leftClass: "git-diff-hunk-header", rightClass: "git-diff-hunk-header" });
                i++;
                continue;
            }

            if (line.type === "ctx") {
                result.push({ left: line.content, right: line.content, leftClass: "git-diff-ctx", rightClass: "git-diff-ctx" });
                i++;
                continue;
            }

            // 尝试配对 del + add 作为修改行
            if (line.type === "del" && i + 1 < lines.length && lines[i + 1].type === "add") {
                result.push({
                    left: line.content,
                    right: lines[i + 1].content,
                    leftClass: "git-diff-del",
                    rightClass: "git-diff-add"
                });
                i += 2;
                continue;
            }

            // 连续的删除行
            if (line.type === "del") {
                result.push({
                    left: line.content,
                    right: "",
                    leftClass: "git-diff-del",
                    rightClass: "git-diff-sbs-empty"
                });
                i++;
                continue;
            }

            // 连续的新增行
            if (line.type === "add") {
                result.push({
                    left: "",
                    right: line.content,
                    leftClass: "git-diff-sbs-empty",
                    rightClass: "git-diff-add",
                    isFiller: true
                });
                i++;
                continue;
            }
        }

        return result;
    }

    // ===================================================================
    // 导出
    // ===================================================================

    module.exports = {
        renderUnified: renderUnified,
        renderSideBySide: renderSideBySide,
        parseDiffStats: parseDiffStats,
        escapeHtml: escapeHtml
    };

})();
