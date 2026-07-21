/**
 * Git Plugin — Branch Visualization (分支可视化) v3.0
 * =====================================================
 * DAG-based vertical node-axis branch graph.
 *
 * Algorithm (5 phases):
 *   A. _buildDag        — hash→row index, populate children arrays
 *   B. _buildBranchLanes — assign a stable lane index to every unique branch name
 *   C. _assignCommitLanes — DAG-aware lane assignment per commit
 *   D. _computeLaneSpans — min/max row per lane for column marker lines
 *   E. SVG render        — 3 layers: column lines → edges → nodes+labels
 *
 * Unlike v2 which drew Bézier curves between adjacent array entries pretending
 * they were parent-child, v3 reads real %P parent hashes and draws edges only
 * between actual topological neighbours.
 */
(function () {
    "use strict";

    // ── Layout constants ──
    var NODE_RADIUS = 5;
    var MERGE_NODE_RADIUS = 6;
    var H_GAP = 100;
    var V_GAP = 52;
    var PADDING_LEFT = 84;
    var PADDING_TOP = 28;
    var LINE_WIDTH = 2;
    var BOX_WIDTH = 170;

    var COLORS = [
        "var(--git-accent, #5b7f95)",
        "#2ea043",
        "#c96a1e",
        "#cf222e",
        "#8250df",
        "#0969da",
        "#bf3989"
    ];

    // ===================================================================
    // Public
    // ===================================================================

    /**
     * @param {HTMLElement} container
     * @param {Array}  commits  — [{hash, parents:[], author, date, refs, message}, …]
     * @param {Array}  branches — [{name, current, remote}, …]
     * @param {Function} onCommitClick — callback(hash)
     */
    function render(container, commits, branches, onCommitClick) {
        if (!container) return;
        container.innerHTML = "";

        if (!commits || !commits.length) {
            container.innerHTML =
                '<div style="padding:24px;text-align:center;color:var(--git-text-muted,#888);font-size:13px;">' +
                    '暂无提交记录' +
                '</div>';
            return;
        }

        // ── Phase A: DAG index ──
        var indexed = _buildDag(commits);

        // ── Phase B: branch → lane mapping ──
        var branchLanes = _buildBranchLanes(commits, branches);

        // ── Phase C: assign a lane to every commit ──
        var entries = _assignCommitLanes(commits, branchLanes, indexed.hashToRow);

        // ── Phase D: lane column spans ──
        var maxLane = 0;
        for (var i = 0; i < entries.length; i++) {
            if (entries[i].lane > maxLane) maxLane = entries[i].lane;
        }
        var numLanes = maxLane + 1;
        var laneSpans = _computeLaneSpans(entries, numLanes, indexed.hashToRow);

        // ── SVG dimensions ──
        var totalHeight = PADDING_TOP * 2 + commits.length * V_GAP;
        var svgWidth = PADDING_LEFT + numLanes * H_GAP + BOX_WIDTH + 16;

        // ── Phase E: SVG rendering ──
        var svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
        svg.setAttribute("class", "git-branch-graph-svg");
        svg.setAttribute("width", "100%");
        svg.setAttribute("height", "100%");
        svg.setAttribute("viewBox", "0 0 " + svgWidth + " " + totalHeight);
        svg.setAttribute("preserveAspectRatio", "xMidYMid meet");

        // Dot-grid background is handled by CSS on the container,
        // so the SVG itself is transparent and the pattern stays fixed
        // regardless of viewBox pan/zoom.

        // Layer 1: column marker lines (back)
        var colGroup = document.createElementNS("http://www.w3.org/2000/svg", "g");
        _drawColumnLines(colGroup, laneSpans, numLanes, PADDING_TOP, V_GAP, PADDING_LEFT, H_GAP);
        svg.appendChild(colGroup);

        // Layer 2: parent-child edges (middle)
        var edgeGroup = document.createElementNS("http://www.w3.org/2000/svg", "g");
        _drawEdges(edgeGroup, entries, indexed.hashToRow, PADDING_TOP, V_GAP, PADDING_LEFT, H_GAP);
        svg.appendChild(edgeGroup);

        // Layer 3: nodes + labels (front)
        _drawNodes(svg, entries, numLanes, onCommitClick, PADDING_TOP, V_GAP, PADDING_LEFT, H_GAP, BOX_WIDTH);

        container.appendChild(svg);

        // ── Pan & Zoom (viewBox manipulation) ──
        _installPanZoom(svg, container, svgWidth, totalHeight);
    }

    // ===================================================================
    // Phase A: Build DAG index
    // ===================================================================

    function _buildDag(commits) {
        var hashToRow = {};
        for (var i = 0; i < commits.length; i++) {
            hashToRow[commits[i].hash] = i;
        }

        // Populate children arrays
        for (var j = 0; j < commits.length; j++) {
            var c = commits[j];
            c.children = c.children || [];
            if (!c.parents || !c.parents.length) continue;
            for (var p = 0; p < c.parents.length; p++) {
                var parentRow = hashToRow[c.parents[p]];
                if (parentRow !== undefined) {
                    var parentCommit = commits[parentRow];
                    parentCommit.children = parentCommit.children || [];
                    parentCommit.children.push(c.hash);
                }
            }
        }

        return { hashToRow: hashToRow };
    }

    // ===================================================================
    // Phase B: Build branch → lane map
    // ===================================================================

    function _buildBranchLanes(commits, branches) {
        var branchLanes = {};
        var nextLane = 0;

        // First pass: assign lanes for local branches from the branches array
        if (branches && branches.length) {
            for (var i = 0; i < branches.length; i++) {
                var b = branches[i];
                if (!b.remote && !(b.name in branchLanes)) {
                    branchLanes[b.name] = nextLane++;
                }
            }
        }

        // Second pass: catch any branch names in commit refs not in the branch list
        for (var j = 0; j < commits.length; j++) {
            var refNames = _extractRefNames(commits[j].refs);
            for (var k = 0; k < refNames.length; k++) {
                var name = refNames[k];
                if (!(name in branchLanes)) {
                    branchLanes[name] = nextLane++;
                }
            }
        }

        return branchLanes;
    }

    function _extractRefNames(refsStr) {
        if (!refsStr || refsStr === "|") return [];
        var names = [];
        var cleaned = refsStr.replace(/[()]/g, "");
        var parts = cleaned.split(",");
        for (var i = 0; i < parts.length; i++) {
            var ref = parts[i].trim();
            if (!ref) continue;
            // Strip "HEAD -> " prefix
            var name = ref.replace(/^HEAD\s*->\s*/, "").trim();
            // Skip tag refs
            if (name && name.indexOf("tag:") === -1) {
                names.push(name);
            }
        }
        return names;
    }

    // ===================================================================
    // Phase C: Assign lane to every commit (DAG-aware)
    // ===================================================================

    function _assignCommitLanes(commits, branchLanes, hashToRow) {
        var entries = [];

        for (var i = 0; i < commits.length; i++) {
            var c = commits[i];
            var lane = 0;
            var branchLabel = null;

            var refNames = _extractRefNames(c.refs);

            if (refNames.length > 0) {
                // Commit has branch ref(s) — use the first's lane
                var firstName = refNames[0];
                lane = branchLanes[firstName] !== undefined ? branchLanes[firstName] : 0;
                branchLabel = refNames.join(", ");
            } else {
                // No ref — follow DAG structure
                // Prefer child (newer commit, already processed since we go newest-first)
                if (c.children && c.children.length > 0) {
                    var childRow = hashToRow[c.children[0]];
                    if (childRow !== undefined && childRow < i) {
                        lane = entries[childRow].lane;
                    }
                } else if (c.parents && c.parents.length > 0) {
                    // No children in window — follow first parent
                    var parentRow = hashToRow[c.parents[0]];
                    if (parentRow !== undefined) {
                        // Parent hasn't been processed yet (it's older = larger row #)
                        // Defer: we'll resolve when rendering edges using the parent's eventual lane
                        // For now, choose a lane close to the first parent branch
                        lane = _findLaneNearParent(commits, parentRow, branchLanes, hashToRow);
                    }
                    // else: parent outside window, default lane 0
                }
                // else: root commit, stays on lane 0
            }

            entries.push({
                hash: c.hash,
                message: c.message,
                author: c.author,
                date: c.date,
                parents: c.parents || [],
                children: c.children || [],
                lane: lane,
                branchLabel: branchLabel
            });
        }

        return entries;
    }

    /**
     * For a commit without its own ref, try to determine a lane by looking
     * at what branch its ancestors eventually land on.
     */
    function _findLaneNearParent(commits, parentRow, branchLanes, hashToRow) {
        // Walk down the parent chain a few steps to find a branch ref
        var row = parentRow;
        var steps = 0;
        while (row !== undefined && row < commits.length && steps < 10) {
            var c = commits[row];
            var refs = _extractRefNames(c.refs);
            if (refs.length > 0) {
                var lane = branchLanes[refs[0]];
                return lane !== undefined ? lane : 0;
            }
            if (c.parents && c.parents.length > 0) {
                row = hashToRow[c.parents[0]];
            } else {
                break;
            }
            steps++;
        }
        return 0;
    }

    // ===================================================================
    // Phase D: Lane column spans
    // ===================================================================

    function _computeLaneSpans(entries, numLanes, hashToRow) {
        var spans = [];
        for (var l = 0; l < numLanes; l++) {
            spans.push({ min: Infinity, max: -Infinity });
        }

        for (var i = 0; i < entries.length; i++) {
            var c = entries[i];

            // Commit's own lane
            if (c.lane >= 0) {
                spans[c.lane].min = Math.min(spans[c.lane].min, i);
                spans[c.lane].max = Math.max(spans[c.lane].max, i);
            }

            // Lanes touched by cross-lane parent edges
            if (c.parents) {
                for (var p = 0; p < c.parents.length; p++) {
                    var parentRow = hashToRow[c.parents[p]];
                    if (parentRow === undefined) continue;
                    if (parentRow >= entries.length) continue;
                    var parentLane = entries[parentRow].lane;
                    if (parentLane >= 0 && parentLane !== c.lane) {
                        spans[parentLane].min = Math.min(spans[parentLane].min, i);
                        spans[parentLane].max = Math.max(spans[parentLane].max, parentRow);
                    }
                }
            }
        }

        return spans;
    }

    // ===================================================================
    // SVG Drawing helpers
    // ===================================================================

    function _drawColumnLines(group, laneSpans, numLanes, padTop, vGap, padLeft, hGap) {
        for (var l = 0; l < numLanes; l++) {
            var span = laneSpans[l];
            if (span.min === Infinity) continue;

            var y1 = padTop + span.min * vGap;
            var y2 = padTop + span.max * vGap;
            var x = padLeft + l * hGap;

            var line = document.createElementNS("http://www.w3.org/2000/svg", "line");
            line.setAttribute("x1", x);
            line.setAttribute("y1", y1);
            line.setAttribute("x2", x);
            line.setAttribute("y2", y2);
            line.setAttribute("stroke", COLORS[l % COLORS.length]);
            line.setAttribute("stroke-width", "2.5");
            line.setAttribute("stroke-linecap", "round");
            line.setAttribute("class", "git-branch-column-line");
            group.appendChild(line);
        }
    }

    function _drawEdges(group, entries, hashToRow, padTop, vGap, padLeft, hGap) {
        for (var i = 0; i < entries.length; i++) {
            var c = entries[i];
            var cy = padTop + i * vGap;
            var cx = padLeft + c.lane * hGap;

            if (!c.parents || !c.parents.length) continue;

            for (var p = 0; p < c.parents.length; p++) {
                var parentRow = hashToRow[c.parents[p]];
                if (parentRow === undefined) continue;
                if (parentRow >= entries.length) continue;

                var parentLane = entries[parentRow].lane;
                var pcy = padTop + parentRow * vGap;
                var pcx = padLeft + parentLane * hGap;

                if (c.lane === parentLane) {
                    // Same lane — straight vertical line
                    var line = document.createElementNS("http://www.w3.org/2000/svg", "line");
                    line.setAttribute("x1", cx);
                    line.setAttribute("y1", cy + NODE_RADIUS);
                    line.setAttribute("x2", pcx);
                    line.setAttribute("y2", pcy - NODE_RADIUS);
                    line.setAttribute("stroke", COLORS[c.lane % COLORS.length]);
                    line.setAttribute("stroke-width", String(LINE_WIDTH));
                    line.setAttribute("stroke-linecap", "round");
                    line.setAttribute("class", "git-branch-edge");
                    group.appendChild(line);
                } else {
                    // Cross-lane — Bézier curve from child (top) to parent (bottom)
                    var d = _bezierChildToParent(
                        cx, cy + NODE_RADIUS,
                        pcx, pcy - NODE_RADIUS,
                        c.lane, parentLane
                    );
                    var curve = document.createElementNS("http://www.w3.org/2000/svg", "path");
                    curve.setAttribute("d", d);
                    curve.setAttribute("stroke", COLORS[parentLane % COLORS.length]);
                    curve.setAttribute("stroke-width", String(LINE_WIDTH));
                    curve.setAttribute("fill", "none");
                    curve.setAttribute("stroke-linecap", "round");
                    curve.setAttribute("stroke-linejoin", "round");
                    curve.setAttribute("class", "git-branch-edge git-branch-merge-curve");
                    group.appendChild(curve);
                }
            }
        }
    }

    /**
     * Smooth S-curve from child node (top) to parent node (bottom).
     *
     * Control-point design:
     *   CP1 — close to child, slight downward angle → no vertical stub at exit
     *   CP2 — close to parent, nearly horizontal → no vertical stub at entry
     */
    function _bezierChildToParent(fromX, fromY, toX, toY, fromLane, toLane) {
        var dx = toX - fromX;
        var dy = toY - fromY;
        var cp1x = fromX + dx * 0.15;
        var cp1y = fromY + dy * 0.25;
        var cp2x = toX - dx * 0.15;
        var cp2y = toY - dy * 0.25;
        return "M " + fromX + " " + fromY +
               " C " + cp1x + " " + cp1y + "," + cp2x + " " + cp2y + "," + toX + " " + toY;
    }

    function _drawNodes(svg, entries, numLanes, onCommitClick, padTop, vGap, padLeft, hGap, boxWidth) {
        for (var i = 0; i < entries.length; i++) {
            var e = entries[i];
            var cy = padTop + i * vGap;
            var cx = padLeft + e.lane * hGap;
            var isMerge = e.parents && e.parents.length > 1;
            var radius = isMerge ? MERGE_NODE_RADIUS : NODE_RADIUS;

            // Node circle
            var circle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
            circle.setAttribute("cx", cx);
            circle.setAttribute("cy", cy);
            circle.setAttribute("r", radius);
            circle.setAttribute("fill", COLORS[e.lane % COLORS.length]);
            circle.setAttribute("stroke", "var(--bg-color, #fff)");
            circle.setAttribute("stroke-width", isMerge ? "2.5" : "2");
            circle.setAttribute("class", isMerge ? "git-branch-node git-branch-merge-node" : "git-branch-node");
            circle.setAttribute("data-hash", e.hash || "");
            circle.style.cursor = "pointer";

            if (onCommitClick) {
                circle.addEventListener("click", (function (hash) {
                    return function (ev) { ev.stopPropagation(); onCommitClick(hash); };
                })(e.hash));
            }

            svg.appendChild(circle);

            // Commit message box — to the right of its own node circle, not at the far right
            if (e.message) {
                var fo = document.createElementNS("http://www.w3.org/2000/svg", "foreignObject");
                var foX = cx + radius + 8;
                var foY = cy - 12;
                var FO_WIDTH = boxWidth;
                var FO_HEIGHT = 24;

                fo.setAttribute("x", foX);
                fo.setAttribute("y", foY);
                fo.setAttribute("width", FO_WIDTH * 2);
                fo.setAttribute("height", FO_HEIGHT);
                fo.setAttribute("class", "git-branch-commit-fo");
                fo.style.overflow = "visible";

                var div = document.createElement("div");
                div.className = "git-branch-commit-box";
                var fullHash = e.hash || "";
                div.innerHTML =
                    '<span class="git-branch-commit-msg">' + _esc(e.message || "") + '</span>';
                div.setAttribute("data-hash", fullHash);
                div.style.cursor = "pointer";

                // Hover on node circle: show short hash label to the left
                (function (hash, circ, radius, cx, cy) {
                    var hashLabel = null;
                    var shortHash = hash.substring(0, 7);
                    circ.addEventListener("mouseenter", function () {
                        hashLabel = document.createElementNS("http://www.w3.org/2000/svg", "text");
                        hashLabel.setAttribute("x", cx - radius - 10);
                        hashLabel.setAttribute("y", cy + 4);
                        hashLabel.setAttribute("text-anchor", "end");
                        hashLabel.setAttribute("class", "git-branch-hash-label");
                        hashLabel.setAttribute("fill", COLORS[e.lane % COLORS.length]);
                        hashLabel.textContent = shortHash;
                        svg.appendChild(hashLabel);
                    });
                    circ.addEventListener("mouseleave", function () {
                        if (hashLabel && hashLabel.parentNode) {
                            hashLabel.parentNode.removeChild(hashLabel);
                        }
                        hashLabel = null;
                    });
                })(fullHash, circle, radius, cx, cy);

                // Hover on card: slightly highlight
                div.addEventListener("mouseenter", function () {
                    this.style.background = "var(--git-accent-soft, rgba(91,127,149,0.12))";
                });
                div.addEventListener("mouseleave", function () {
                    this.style.background = "";
                });

                if (onCommitClick) {
                    div.addEventListener("click", (function (hash) {
                        return function () { onCommitClick(hash); };
                    })(e.hash));
                }

                fo.appendChild(div);
                svg.appendChild(fo);
            }

            // Branch label — to the left of the node circle
            if (e.branchLabel) {
                var labelX = cx - radius - 6;
                var labelY = cy + 4;
                var txt = document.createElementNS("http://www.w3.org/2000/svg", "text");
                txt.setAttribute("x", labelX);
                txt.setAttribute("y", labelY);
                txt.setAttribute("text-anchor", "end");
                txt.setAttribute("class", "git-branch-label");
                txt.setAttribute("fill", COLORS[e.lane % COLORS.length]);
                txt.textContent = e.branchLabel;
                svg.appendChild(txt);
            }
        }
    }

    function _esc(str) {
        if (!str) return "";
        return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    }

    // ===================================================================
    // Pan & Zoom (viewBox manipulation, like a "knowledge graph")
    // ===================================================================

    function _installPanZoom(svg, container, svgWidth, totalHeight) {
        var dragging = false;
        var startX = 0, startY = 0;
        var viewX = 0, viewY = 0;
        var viewW = svgWidth, viewH = totalHeight;
        var ZOOM_MIN = 0.2;
        var ZOOM_MAX = 5.0;

        function _readViewBox() {
            var vb = (svg.getAttribute("viewBox") || "").split(/\s+/);
            viewX = parseFloat(vb[0]) || 0;
            viewY = parseFloat(vb[1]) || 0;
            viewW = parseFloat(vb[2]) || svgWidth;
            viewH = parseFloat(vb[3]) || totalHeight;
        }

        function _writeViewBox() {
            svg.setAttribute("viewBox", viewX + " " + viewY + " " + viewW + " " + viewH);
        }

        svg.style.cursor = "grab";

        svg.addEventListener("mousedown", function (e) {
            if (e.button !== 0) return; // left button only
            dragging = true;
            startX = e.clientX;
            startY = e.clientY;
            _readViewBox();
            svg.style.cursor = "grabbing";
            e.preventDefault();
        });

        window.addEventListener("mousemove", function (e) {
            if (!dragging) return;
            var dx = e.clientX - startX;
            var dy = e.clientY - startY;
            var rect = svg.getBoundingClientRect();
            // Use uniform scale so horizontal and vertical drag feel identical
            var scale = viewW / rect.width;
            viewX = viewX - dx * scale;
            viewY = viewY - dy * scale;
            _writeViewBox();
            startX = e.clientX;
            startY = e.clientY;
        });

        window.addEventListener("mouseup", function () {
            if (dragging) {
                dragging = false;
                svg.style.cursor = "grab";
            }
        });

        container.addEventListener("wheel", function (e) {
            e.preventDefault();
            _readViewBox();

            // Zoom factor
            var delta = e.deltaY > 0 ? 1.12 : 1 / 1.12;
            var newW = viewW * delta;
            var newH = viewH * delta;

            // Respect zoom limits
            if (newW / svgWidth < ZOOM_MIN || newW / svgWidth > ZOOM_MAX) return;

            // Zoom towards cursor position
            var rect = svg.getBoundingClientRect();
            var mx = e.clientX - rect.left;
            var my = e.clientY - rect.top;
            var ratioX = mx / rect.width;
            var ratioY = my / rect.height;

            viewX = viewX + (viewW - newW) * ratioX;
            viewY = viewY + (viewH - newH) * ratioY;
            viewW = newW;
            viewH = newH;
            _writeViewBox();
        }, { passive: false });
    }

    module.exports = {
        render: render
    };
})();
