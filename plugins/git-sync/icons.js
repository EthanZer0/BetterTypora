/* Git 同步图标。主图标用双向同步环包围提交节点，颜色始终继承 Typora 当前主题。 */
(function () {
    "use strict";

    function icon(name, size) {
        var s = size || 16;
        var paths = {
            git: '<circle cx="4" cy="3.4" r="1.25"/><circle cx="4" cy="12.6" r="1.25"/><circle cx="12" cy="5.7" r="1.25"/><path d="M4 4.7v6.6M4 6.3c0 2.1 1.65 3.3 4.1 3.3 2.15 0 3.9-.9 3.9-3.25V4.5"/>',
            sync: '<path d="M2.4 6.4A5.8 5.8 0 0 1 12 4.3"/><path d="m10.5 2.7 1.8 1.5-1.6 1.8"/><path d="M13.6 9.6A5.8 5.8 0 0 1 4 11.7"/><path d="m5.5 13.3-1.8-1.5L5.3 10"/><circle cx="8" cy="8" r="1.55" fill="currentColor" stroke="none"/>',
            compare: '<path d="M3 3.2h4.1M3 3.2v4.1M13 12.8H8.9m4.1 0V8.7"/><path d="m3 7.3 3.2-3.2M13 8.7 9.8 11.9"/><path d="M5.4 12.8H3v-2.4M10.6 3.2H13v2.4"/>',
            check: '<path d="m3.2 8.2 3.1 3.1 6.5-6.6"/>',
            refresh: '<path d="M13.5 5.2A5.5 5.5 0 1 0 14 10"/><path d="M13.5 2.5v2.7h-2.7"/>',
            upload: '<path d="M8 13.8V3.1M4.7 6.4 8 3.1l3.3 3.3"/><path d="M3 14.5h10"/>',
            download: '<path d="M8 2.3v10.6m-3.3-3.3L8 12.9l3.3-3.3"/><path d="M3 14.5h10"/>',
            close: '<path d="m4 4 8 8m0-8-8 8"/>',
            settings: '<path d="M8 2.6v1.3m0 8.2v1.3M2.6 8h1.3m8.2 0h1.3M4.2 4.2l.9.9m5.8 5.8.9.9m0-7.6-.9.9m-5.8 5.8-.9.9"/><circle cx="8" cy="8" r="2.4"/><circle cx="8" cy="8" r="5.1"/>',
            folder: '<path d="M2.5 4.5h4l1.2 1.3h5.8v6.7h-11z"/>',
            file: '<path d="M4 2.5h5l2.5 2.5v8.5H4zM9 2.5V5h2.5"/>',
            warning: '<path d="m8 2.4 5.4 10H2.6z"/><path d="M8 6.1v3.1m0 2.1v.1"/>'
        };
        return '<svg class="bt-git-icon" width="' + s + '" height="' + s + '" viewBox="0 0 16 16" aria-hidden="true" focusable="false"><g fill="none" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round">' + (paths[name] || paths.git) + '</g></svg>';
    }

    /* 工作区状态不再直接展示 Git 的双字符代码，而是以图形和悬浮说明表达。 */
    function changeIcon(kind, size) {
        var s = size || 16;
        var paths = {
            modified: '<path d="m4.1 11.9 7.1-7.1 1.8 1.8-7.1 7.1-2.5.7z"/><path d="m10.4 5.6 1.8 1.8"/>',
            added: '<circle cx="8" cy="8" r="5.4"/><path d="M8 5.2v5.6M5.2 8h5.6"/>',
            deleted: '<circle cx="8" cy="8" r="5.4"/><path d="M5.2 8h5.6"/>',
            untracked: '<path d="M4 2.5h5l2.7 2.7v8.3H4zM9 2.5v2.8h2.7"/><path d="M5.7 10.8h4.6"/>',
            renamed: '<path d="M3.1 5.7h7.1l-1.7-1.8"/><path d="M12.9 10.3H5.8l1.7 1.8"/><path d="m10.2 3.9 1.8 1.8-1.8 1.8M5.8 8.5 4 10.3l1.8 1.8"/>',
            conflict: '<path d="m8 2.3 5.5 10H2.5z"/><path d="M8 5.8v3.2m0 2.1v.1"/>'
        };
        return '<svg class="bt-git-change-icon" width="' + s + '" height="' + s + '" viewBox="0 0 16 16" aria-hidden="true" focusable="false"><g fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round">' + (paths[kind] || paths.modified) + '</g></svg>';
    }

    if (typeof module !== "undefined") module.exports = { icon: icon, changeIcon: changeIcon };
})();
