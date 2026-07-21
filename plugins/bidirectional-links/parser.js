/**
 * Bidirectional Links — Wikilink Parser
 * =====================================
 * 纯正则解析，不依赖 DOM。将 markdown 原始文本中的 [[wiki-link]] 提取为结构化数据。
 *
 * 支持的语法:
 *   [[Page]]              → 基本链接
 *   [[Page|Alias]]        → 带别名的链接
 *   [[Page#Heading]]      → 链接到特定标题
 *   [[Page#Heading|Alias]]→ 标题链接 + 别名
 *   ![[Page]]             → 嵌入（识别但暂不处理导航）
 *
 * 排除:
 *   [[]]                  → 空括号，跳过
 *   [text](url)           → 标准 markdown 链接，不匹配（由 Typora 原生处理）
 */

(function () {
    "use strict";

    /** 匹配 [[...]] 或 ![[...]] 的正则 */
    var WIKILINK_REGEX = /!?\[\[([^\]]+)\]\]/g;

    /**
     * 解析单个 wikilink 的原始文本（不含 ! 前缀和双方括号）
     * @param {string} rawLink — "Page|Alias" 或 "Page#Heading" 等
     * @returns {{target: string, alias: string|null, heading: string|null, isEmbed: boolean}}
     */
    function parseOne(rawLink) {
        var isEmbed = rawLink.charAt(0) === "!";
        // 去掉 ! 前缀和双方括号
        var inner = rawLink;
        if (isEmbed) {
            inner = inner.slice(1);
        }
        inner = inner.replace(/^\[\[|\]\]$/g, "").trim();

        if (!inner) return null; // 空括号 [[]]

        var alias = null;
        var heading = null;

        // 按最后一个 | 分割 — 右边是 alias（对齐 Obsidian 行为）
        var pipeIdx = inner.lastIndexOf("|");
        var targetPart;
        if (pipeIdx >= 0) {
            targetPart = inner.slice(0, pipeIdx).trim();
            alias = inner.slice(pipeIdx + 1).trim();
            if (!alias) alias = null;
        } else {
            targetPart = inner;
        }

        // target 部分按最后一个 # 分割 — 右边是 heading（对齐 Obsidian 行为）
        var hashIdx = targetPart.lastIndexOf("#");
        var target;
        if (hashIdx >= 0) {
            target = targetPart.slice(0, hashIdx).trim();
            heading = targetPart.slice(hashIdx + 1).trim();
            if (!heading) heading = null;
        } else {
            target = targetPart;
        }

        // target 为空（如 "[[#heading]]"）→ 是当前页面的内部引用
        if (!target && heading) {
            target = null; // 表示自引用
        }
        if (!target && !heading) return null; // 完全空

        return {
            target: target,
            alias: alias,
            heading: heading,
            isEmbed: isEmbed,
        };
    }

    /**
     * 解析文本中所有 wikilink
     * @param {string} text — markdown 原始文本
     * @returns {Array<{target: string, alias: string|null, heading: string|null, isEmbed: boolean, raw: string, startOffset: number, endOffset: number}>}
     */
    function parseAll(text) {
        if (!text || typeof text !== "string") return [];

        var results = [];
        var regex = new RegExp(WIKILINK_REGEX.source, "g"); // fresh regex to avoid sticky state
        var match;
        while ((match = regex.exec(text)) !== null) {
            var parsed = parseOne(match[0]);
            if (!parsed) continue;
            parsed.raw = match[0];
            parsed.startOffset = match.index;
            parsed.endOffset = match.index + match[0].length;
            results.push(parsed);
        }
        return results;
    }

    // ===================================================================
    // 导出 (通过 module.exports，供 main.js require)
    // ===================================================================
    module.exports = {
        parseOne: parseOne,
        parseAll: parseAll,
        WIKILINK_REGEX: WIKILINK_REGEX,
    };
})();
