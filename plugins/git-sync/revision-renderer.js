/**
 * Git Plugin — 修订视图渲染器
 * ==============================
 * 统一通过 _renderMdToHtml 渲染两侧内容，MathJax typeset 在 revision-view.js
 * 插入 DOM 后调用。
 */
(function () {
    "use strict";

    // ===================================================================
    // Markdown 源码 → 块切分
    // ===================================================================

    function parseMdBlocks(md) {
        if (!md) return [];
        var lines = md.split("\n"), blocks = [], buf = [], inFence = false;
        for (var i = 0; i < lines.length; i++) {
            var line = lines[i];
            if (/^\s*```/.test(line)) {
                if (inFence) { buf.push(line); blocks.push(buf.join("\n")); buf = []; inFence = false; }
                else { if (buf.length > 0) { blocks.push(buf.join("\n")); buf = []; } buf.push(line); inFence = true; }
            } else if (!inFence && /^\s*$/.test(line)) {
                if (buf.length > 0) { blocks.push(buf.join("\n")); buf = []; }
            } else { buf.push(line); }
        }
        if (buf.length > 0) blocks.push(buf.join("\n"));
        return blocks;
    }

    function mdDigest(md) { return md.replace(/\s+/g, " ").trim().substring(0, 120); }

    function alignMdBlocks(oldBlocks, newBlocks) {
        var r = [], used = {};
        var i = 0, j = 0;
        while (i < oldBlocks.length && j < newBlocks.length) {
            var a = mdDigest(oldBlocks[i]), b = mdDigest(newBlocks[j]);
            if (a === b) { r.push({ l: i, r: j, s: "same" }); i++; j++; continue; }
            var fn = -1;
            for (var nj = j + 1; nj < Math.min(j + 4, newBlocks.length); nj++) {
                if (!used[nj] && mdDigest(newBlocks[nj]) === a) { fn = nj; break; }
            }
            if (fn >= 0) {
                while (j < fn) { r.push({ l: -1, r: j, s: "added" }); used[j] = true; j++; }
                r.push({ l: i, r: j, s: "same" }); used[j] = true; i++; j = fn + 1;
            } else {
                var fo = -1;
                for (var oi = i + 1; oi < Math.min(i + 4, oldBlocks.length); oi++) {
                    if (mdDigest(oldBlocks[oi]) === b) { fo = oi; break; }
                }
                if (fo >= 0) {
                    while (i < fo) { r.push({ l: i, r: -1, s: "deleted" }); i++; }
                    r.push({ l: i, r: j, s: "same" }); used[j] = true; i++; j++;
                } else {
                    r.push({ l: i, r: j, s: "modified" }); used[j] = true; i++; j++;
                }
            }
        }
        while (i < oldBlocks.length) { r.push({ l: i, r: -1, s: "deleted" }); i++; }
        while (j < newBlocks.length) { r.push({ l: -1, r: j, s: "added" }); j++; }
        return r;
    }

    // ===================================================================
    // 统一渲染：两侧都用 _renderMdToHtml → 解析为 DOM → 对齐 → 组装
    // ===================================================================

    /**
     * @param {string} oldMd  — 旧版 markdown 源码
     * @param {string} newMd  — 当前 markdown 源码
     * @param {object} editor — 编辑器引用（未使用，保留签名兼容性）
     * @returns {{ aligned: array, oldKids: Element[], newKids: Element[] }}
     */
    function prepareRevision(oldMd, newMd, editor) {
        var oldBlocks = parseMdBlocks(oldMd || "");
        var newBlocks = parseMdBlocks(newMd || "");
        var aligned = alignMdBlocks(oldBlocks, newBlocks);

        // 两侧都通过 Typora 内部 API 渲染为 HTML
        var oldHtml = "";
        var newHtml = "";
        try { oldHtml = _renderMdToHtml(oldMd || ""); } catch (e) {}
        try { newHtml = _renderMdToHtml(newMd || ""); } catch (e) {}

        // 解析为 DOM 元素数组（跳过空 <p>）
        function htmlToKids(html) {
            var container = document.createElement("div");
            container.innerHTML = html || "";
            var kids = [];
            for (var i = 0; i < container.children.length; i++) {
                var c = container.children[i];
                if (c.tagName === "P" && !c.textContent.trim()) continue;
                kids.push(c);
            }
            return kids;
        }

        return {
            aligned: aligned,
            oldKids: htmlToKids(oldHtml),
            newKids: htmlToKids(newHtml)
        };
    }

    // ===================================================================
    // Typora 渲染
    // ===================================================================

    function _renderMdToHtml(md) {
        var F = window.File, N = window.NodeDef;
        if (!F || !N || !F.editor) return "";
        var Ctor = F.editor.nodeMap.constructor;
        var nm = new Ctor();
        var nd = new N({ type: N.TYPE.raw_edit, in: nm, attachTo: nm, text: md || "" });
        var p = nd.parseFrom({ skips: { old_code: false } });
        var h = (p[0] || "").replace(/\s*cid\s*=\s*['"][^'"]*['"]/gi, "");
        (p[1] || []).forEach(function (b) { try { b._delete(true); } catch (e) {} });
        return _highlightCodeFences(h, md);
    }

    function _extractFenceTexts(md) {
        var r = [], re = /^(?:>\s*)?```(\S*)\s*\n([\s\S]*?)\n(?:>\s*)?```/gm, m;
        while ((m = re.exec(md || "")) !== null) {
            var c = m[2].replace(/^>\s?/gm, "");
            if (c.slice(-1) === "\n") c = c.slice(0, -1);
            r.push({ lang: (m[1] || "").trim(), code: c });
        }
        return r;
    }

    function _highlightCodeFences(html, md) {
        var CM = (typeof window !== "undefined" && window.CodeMirror) ? window.CodeMirror : null;
        if (!CM && typeof require === "function") { try { CM = require("codemirror"); } catch (e) {} }
        if (!CM || typeof CM.getMode !== "function") return html;
        var texts = _extractFenceTexts(md), div = document.createElement("div");
        div.innerHTML = html;
        var fences = div.querySelectorAll("pre.md-fences");
        for (var i = 0; i < fences.length; i++) {
            var f = fences[i], lang = (f.getAttribute("lang") || "").toLowerCase();
            if (!lang || !_cmMode(lang)) continue;
            var code = i < texts.length ? texts[i].code : (f.textContent || "");
            if (!code) continue;
            try {
                var mo = CM.getMode(CM.defaults || {}, _cmMode(lang));
                if (!mo || !mo.token) continue;
                var lines = code.split("\n"), st = CM.startState ? CM.startState(mo) : null, out = "";
                for (var li = 0; li < lines.length; li++) {
                    var lt = lines[li], lh = "";
                    if (!lt) { if (mo.blankLine) mo.blankLine(st); lh = "&#x200B;"; }
                    else { var ss = new CM.StringStream(lt); while (!ss.eol()) { var s = mo.token(ss, st), c = ss.current(); lh += s ? '<span class="' + s.split(/\s+/).map(function (x) { return "cm-" + x.replace(/[^\w\-]/g, ""); }).filter(Boolean).join(" ") + '">' + _esc(c) + "</span>" : _esc(c); ss.start = ss.pos; } }
                    out += '<pre class="CodeMirror-line">' + lh + "</pre>";
                }
                f.innerHTML = '<div class="CodeMirror cm-s-inner CodeMirror-wrap"><div class="CodeMirror-scroll"><div class="CodeMirror-sizer"><div class="CodeMirror-lines"><div class="CodeMirror-code">' + out + "</div></div></div></div>";
            } catch (e) {}
        }
        return div.innerHTML;
    }

    function _cmMode(l) {
        var M = {js:"javascript",ts:"javascript",jsx:"jsx",tsx:"jsx",py:"python",rb:"ruby",rs:"rust",php:"php",go:"go",java:"clike",c:"clike",cpp:"clike",cs:"clike",swift:"swift",kotlin:"clike",scala:"clike",html:"htmlmixed",xml:"xml",svg:"xml",css:"css",scss:"css",less:"css",sql:"sql",sh:"shell",bash:"shell",ps1:"powershell",json:"javascript",yaml:"yaml",md:"markdown",diff:"diff",lua:"lua",r:"r",pl:"perl",hs:"haskell",elm:"elm",erl:"erlang",clj:"clojure",dart:"dart",groovy:"groovy",jl:"julia",ml:"mllike",vue:"vue"};
        return M[l] || l;
    }
    function _esc(s) { return (s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }

    module.exports = {
        prepareRevision: prepareRevision,
        _renderMdToHtml: _renderMdToHtml
    };
})();
