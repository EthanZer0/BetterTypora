/**
 * Git Plugin — 修订视图渲染器
 * ==============================
 * Markdown 源码对齐 + 旧版渲染（仅 deleted 块）。
 * 不构建 DOM——由 revision-view.js 直接操作克隆体。
 */
(function () {
    "use strict";

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
        var r = [], used = {}, i = 0, j = 0;
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

    // 返回对齐结果 + 旧版渲染 HTML（仅 deleted 块需要）
    function prepareRevision(oldMd, newMd, editor) {
        var aligned = alignMdBlocks(parseMdBlocks(oldMd || ""), parseMdBlocks(newMd || ""));
        var oldHtml = "";
        try { oldHtml = _renderMdToHtml(editor, oldMd || ""); } catch (e) {}
        return { aligned: aligned, oldHtml: oldHtml };
    }

    // ===================================================================
    // Typora 渲染
    // ===================================================================

    function _renderMdToHtml(editor, md) {
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
