/**
 * Git Plugin — SVG 图标模块
 * =============================
 * Phosphor-style 16×16 SVG icons. Stroke-based, currentColor.
 * All icons: viewBox="0 0 16 16", fill="none", stroke="currentColor",
 *           stroke-width="1.5", stroke-linecap="round", stroke-linejoin="round"
 */
(function () {
    "use strict";

    var SVG_ATTRS = 'fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"';

    var PATHS = {
        // Git branch icon — forked path with nodes
        git: '<circle cx="4.5" cy="4.5" r="2"/><circle cx="4.5" cy="11.5" r="2"/><circle cx="11.5" cy="6.5" r="2"/>' +
             '<path d="M4.5 6.5v3"/><path d="M4.5 9.5C4.5 7.5 7 7 7 6.5"/><path d="M7 6.5h2.5"/>',

        // Push — simple up-arrow for quick-push
        push: '<path d="M8 12V4"/>' +
              '<path d="M3.5 8l4.5-4.5L12.5 8"/>' +
              '<path d="M3 14h10"/>',

        // Close — X
        close: '<path d="M3 3l10 10M13 3l-10 10"/>',

        // Branch — forked nodes
        branch: '<circle cx="5" cy="4" r="1.5"/><circle cx="5" cy="12" r="1.5"/>' +
                '<circle cx="11" cy="8" r="1.5"/>' +
                '<path d="M5 5.5v4.5c0 1 2 1 2 0"/>',

        // Commit — dot with arc (checkmark circle)
        commit: '<circle cx="8" cy="8" r="5.5"/>' +
                '<path d="M5.5 8l1.8 1.8 3.2-3.2"/>',

        // Pull — arrow down from cloud
        pull: '<path d="M12.5 4l-1.5-2-1.5 2"/><path d="M11 9V2"/>' +
              '<path d="M11 8a3 3 0 1 0 0 6 3 3 0 0 0 .66-.07A5 5 0 0 0 1 9.5c0-1.77 1.19-3.27 2.84-3.76"/>',

        // Check — checkmark
        check: '<path d="M3 8l3.5 3.5 6.5-7"/>',

        // Settings — gear
        settings: '<circle cx="8" cy="8" r="2.5"/>' +
                  '<path d="M8 1.5v2M8 12.5v2M2.5 4.5l1.8 1M11.7 10.5l1.8 1M1.5 8h2M12.5 8h2M2.5 11.5l1.8-1M11.7 5.5l1.8-1"/>',

        // History — clock/counter-clockwise
        history: '<circle cx="8" cy="8" r="5.5"/>' +
                 '<path d="M8 4.5v4l2.5 2"/>' +
                 '<path d="M2 3v3h3"/>',

        // Status — document with check
        status: '<path d="M3 2h7l3 3v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1z"/>' +
                '<path d="M10 2v3h3"/>' +
                '<path d="M5.5 9l1.5 1.5L10.5 7"/>',

        // Plus — add
        plus: '<path d="M8 3v10M3 8h10"/>',

        // User — person silhouette
        user: '<circle cx="8" cy="5" r="3"/>' +
              '<path d="M2 14c0-3.3 2.7-6 6-6s6 2.7 6 6"/>',

        // Mail — envelope
        mail: '<rect x="1.5" y="3.5" width="13" height="9" rx="1"/>' +
              '<path d="M1.5 4.5l6.5 5 6.5-5"/>',

        // Chevron — small right arrow
        chevron: '<path d="M5.5 3l5 5-5 5"/>'
    };

    /**
     * Render an SVG icon string
     * @param {string} key  - icon key from PATHS
     * @param {number} size - width/height in px (default 16)
     * @returns {string} SVG element HTML
     */
    function renderIcon(key, size) {
        size = size || 16;
        var path = PATHS[key];
        if (!path) return '<svg width="' + size + '" height="' + size + '" viewBox="0 0 16 16" ' + SVG_ATTRS + '></svg>';
        return '<svg width="' + size + '" height="' + size + '" viewBox="0 0 16 16" style="display:block;" ' + SVG_ATTRS + '>' + path + '</svg>';
    }

    /**
     * Render an SVG icon as an <img> data-URI (useful for <img> tags)
     * @param {string} key
     * @param {number} size
     * @returns {string} data:image/svg+xml URI
     */
    function renderIconURI(key, size) {
        var svg = renderIcon(key, size);
        return 'data:image/svg+xml,' + encodeURIComponent(svg);
    }

    module.exports = {
        PATHS: PATHS,
        renderIcon: renderIcon,
        renderIconURI: renderIconURI
    };
})();
