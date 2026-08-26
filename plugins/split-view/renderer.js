/**
 * Split View — Markdown 渲染器 (marked)
 * ======================================
 * 右栏/左栏预览区共用。职责:
 *   - marked 解析 (gfm + breaks)
 *   - raw HTML 黑名单过滤 (script/iframe 等危险标签丢弃)
 *   - 图片相对路径 → file:// 绝对路径 (基于文件所在目录)
 *   - 链接分类: 本地 .md → 主栏打开 (data-bt-link), http → 原样
 *   - MathJax 复用: 渲染后 typesetPromise 处理公式
 */
var path = require("path");
var url = require("url");

var DANGEROUS_TAGS = [
    "script", "iframe", "object", "embed", "style", "link",
    "meta", "form", "input", "textarea", "button", "select", "option"
];

/** 渲染器实例 (惰性创建) */
var _renderer = null;

function getRenderer() {
    if (_renderer) return _renderer;
    var marked = require("marked");
    var Renderer = marked.Renderer || (marked.marked && marked.marked.Renderer);
    var r = new Renderer();

    // raw HTML 过滤: 黑名单标签整体丢弃, 其余保留
    r.html = function (html) {
        var m = /^<\/?([a-zA-Z][a-zA-Z0-9]*)/.exec((html || "").trim());
        if (m && DANGEROUS_TAGS.indexOf(m[1].toLowerCase()) >= 0) return "";
        return html || "";
    };

    // 图片: 相对路径 → file:// 绝对路径
    r.image = function (href, title, text) {
        var src = resolveResource(href);
        var alt = (text || "").replace(/"/g, "&quot;");
        var t = title ? ' title="' + title.replace(/"/g, "&quot;") + '"' : "";
        return '<img src="' + src + '" alt="' + alt + '"' + t + '>';
    };

    // 链接: 本地 .md → data-bt-link (点击在主栏打开); 其余原样
    r.link = function (href, title, text) {
        if (!href) return text || "";
        var t = title ? ' title="' + title.replace(/"/g, "&quot;") + '"' : "";
        var safeHref = href.replace(/"/g, "&quot;");
        if (isLocalMarkdown(href)) {
            return '<a href="#" data-bt-link="' + safeHref.replace(/&quot;/g, "&quot;") + '"' + t + ">" + text + "</a>";
        }
        if (/^(https?:|mailto:|ftp:)/i.test(href)) {
            return '<a href="' + safeHref + '" target="_blank" rel="noopener"' + t + ">" + text + "</a>";
        }
        return text || "";
    };

    _renderer = {
        parse: function (md, filePath) {
            _currentDir = filePath ? path.dirname(filePath) : null;
            return marked.parse(md || "", {
                renderer: r,
                gfm: true,
                breaks: true
            });
        }
    };
    return _renderer;
}

/** 当前渲染文件的目录 (图片相对路径解析基准) */
var _currentDir = null;

function resolveResource(href) {
    if (!href) return "";
    // 外链 / 协议 / 锚点 / data 原样
    if (/^(https?:|file:|data:|mailto:|ftp:|\/\/|#)/i.test(href)) return href;
    if (_currentDir) {
        try {
            return url.pathToFileURL(path.resolve(_currentDir, href)).href;
        } catch (e) {}
    }
    return href;
}

function isLocalMarkdown(href) {
    if (/^(https?:|file:|data:|mailto:|ftp:|\/\/|#)/i.test(href)) return false;
    return /\.md$/i.test(href.split(/[?#]/)[0]) || /\.markdown$/i.test(href.split(/[?#]/)[0]);
}

/**
 * 渲染 markdown 到容器元素
 * 优先: BetterTypora.markdown (Typora 原生解析器, DOM 与编辑器一致)
 * 降级: marked (解析器不可用时)
 */
function renderTo(container, md, filePath) {
    var svc = window.BetterTypora && window.BetterTypora.markdown;
    if (svc && svc.isAvailable()) {
        var ok = svc.renderTo(container, md, {
            baseDir: filePath ? path.dirname(filePath) : null
        });
        if (ok) return;
    }
    // 降级: marked
    container.innerHTML = getRenderer().parse(md, filePath);
    try {
        if (window.MathJax && typeof window.MathJax.typesetPromise === "function") {
            window.MathJax.typesetPromise([container]);
        }
    } catch (e) {}
}

module.exports = {
    renderTo: renderTo,
    isLocalMarkdown: isLocalMarkdown
};
