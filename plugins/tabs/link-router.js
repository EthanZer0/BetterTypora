/* 本地 Markdown 链接解析。纯 Node 模块，避免把 DOM/Typora 状态带入测试。 */
(function () {
    "use strict";

    var path = require("path");

    function stripSuffix(value) {
        return String(value || "").split(/[?#]/)[0];
    }

    function decodePath(value) {
        try {
            return decodeURIComponent(String(value || ""));
        } catch (e) {
            return String(value || "");
        }
    }

    function isExternal(value) {
        return /^(https?:|mailto:|ftp:|data:|javascript:|\/\/|#)/i.test(String(value || ""));
    }

    function fileHrefToPath(value) {
        var text = String(value || "").trim();
        if (!/^file:/i.test(text)) return null;
        var rest = text.replace(/^file:\/\//i, "");
        rest = decodePath(stripSuffix(rest));
        // 兼容 file:///D:/x、file://D:/x、file://D:\\x。
        rest = rest.replace(/^[\\/]+([a-zA-Z]:)/, "$1");
        if (/^[a-zA-Z]:[\\/]/.test(rest)) return rest.replace(/\\/g, "/");
        // UNC 路径保留网络路径语义。
        return rest.replace(/^\\+/, "//").replace(/\\/g, "/");
    }

    function isMarkdownPath(value) {
        var clean = stripSuffix(decodePath(value));
        return /\.(md|markdown)$/i.test(clean);
    }

    /**
     * 解析本地 Markdown 链接。
     * explicitTarget 用于分屏/预览渲染器已经解析出的绝对路径。
     * 返回绝对路径；外链、锚点、非 Markdown 链接返回 null。
     */
    function resolveLocalMarkdownTarget(href, baseFile, explicitTarget) {
        var raw = explicitTarget || href || "";
        if (!raw || (!explicitTarget && href && isExternal(href) && !/^file:/i.test(href))) return null;

        var filePath = fileHrefToPath(raw);
        var target = filePath;
        if (!target) {
            if (!baseFile) return null;
            var clean = decodePath(stripSuffix(raw));
            if (!clean || isExternal(clean)) return null;
            target = path.resolve(path.dirname(baseFile), clean);
        }
        if (!isMarkdownPath(target)) return null;
        return target;
    }

    module.exports = {
        stripSuffix: stripSuffix,
        fileHrefToPath: fileHrefToPath,
        isMarkdownPath: isMarkdownPath,
        resolveLocalMarkdownTarget: resolveLocalMarkdownTarget
    };
})();
