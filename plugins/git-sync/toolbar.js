/**
 * Git Plugin — Floating Sidebar (悬浮侧边栏) v2.0
 * ================================================
 * Auto-hiding right-edge sidebar with buttons:
 *   1. Git icon  → toggle panel
 *   2. Commit icon → 提交到本地（如开启远程同步则同时推送到云端）
 *
 * Behavior:
 *   - Fixed right-center, NOT draggable
 *   - Hover near right edge → sidebar eases left to reveal
 *   - Cursor leaves + panel closed → sidebar eases right to hide
 *   - Only ~6px visible edge when hidden
 */
(function () {
    "use strict";

    var _api = null;
    var _store = null;
    var _git = null;
    var _sync = null;
    var _icons = null;
    var _sidebarEl = null;
    var _trackEl = null;
    var _injected = false;

    // ===================================================================
    // Public
    // ===================================================================

    function init(api, repoStore, gitCore, gitSync, iconsModule) {
        _api = api;
        _store = repoStore;
        _git = gitCore;
        _sync = gitSync;
        _icons = iconsModule;
    }

    function inject() {
        if (document.getElementById("git-floating-sidebar")) return;

        var sidebar = document.createElement("div");
        sidebar.id = "git-floating-sidebar";
        sidebar.setAttribute("data-plugin-id", "git-sync");

        var track = document.createElement("div");
        track.className = "git-fs-track";

        var btns = document.createElement("div");
        btns.className = "git-fs-buttons";

        // Button 1: Git icon → toggle panel
        btns.appendChild(_makeBtn("panel", _icons.renderIcon("git", 14), "Git 面板"));

        // Button 2: Commit icon → 提交到本地（开启远程则同步到云端）
        btns.appendChild(_makeBtn("commit-local", _icons.renderIcon("push", 14), "提交到本地"));

        track.appendChild(btns);
        sidebar.appendChild(track);

        track.addEventListener("mouseenter", _onTrackEnter);
        track.addEventListener("mouseleave", _onTrackLeave);

        document.body.appendChild(sidebar);

        _sidebarEl = sidebar;
        _trackEl = track;
        _injected = true;

        document.addEventListener("mousemove", _onGlobalMouse);
    }

    // ===================================================================
    // Button factory
    // ===================================================================

    function _makeBtn(action, svgHtml, title) {
        var btn = document.createElement("button");
        btn.className = "git-fs-btn";
        btn.setAttribute("data-action", action);
        btn.setAttribute("title", title);
        btn.innerHTML = svgHtml;

        btn.addEventListener("click", function (e) {
            e.stopPropagation();
            _fireAction(action);
        });

        return btn;
    }

    function _fireAction(action) {
        switch (action) {
            case "panel":
                window.BetterTypora.commands.execute("git-sync:toggle-panel");
                break;
            case "commit-local":
                _handleCommitLocal();
                break;
        }
    }

    // ===================================================================
    // 提交到本地（如开启远程则同步到云端）
    // ===================================================================

    function _handleCommitLocal() {
        if (window.__gitSync_initRepoIfNeeded) {
            window.__gitSync_initRepoIfNeeded().then(function (ok) { if (ok) _doCommit(); });
        } else {
            _doCommit();
        }

        function _doCommit() {
            // 0. 先触发 Typora 保存
            if (window.BetterTypora && window.BetterTypora.saveFile) {
                window.BetterTypora.saveFile();
            }

        // 等 Typora 写入磁盘后再操作
        setTimeout(function () {
            // 1. 检查是否有变更
            _git.hasUncommitted(_store.state.repoPath).then(function (hu) {
                if (!hu.success || !hu.hasChanges) {
                    window.BetterTypora.toast("文件没有变化，无需提交", 2000);
                    return;
                }

                window.BetterTypora.toast("正在提交...", 1500);

                _sync.stageTrackedAndNewMd(_store.state.repoPath, _git).then(function () {
                    var fileName = _store.state.currentFilePath
                        ? require("path").basename(_store.state.currentFilePath)
                        : "notes";
                    return _sync.commitSync(_store.state.repoPath, fileName, _git);
                }).then(function (commitResult) {
                    if (!commitResult.success) {
                        window.BetterTypora.toast("提交失败: " + (commitResult.error || "").substring(0, 60), 3000);
                        return;
                    }

                    _store.refreshAll().then(function () {
                        updateBadge(_store.getChangeCount());
                    });

                    var remoteEnabled = _api.getSetting("remoteEnabled", false);
                    var remoteUrl = _api.getSetting("remoteURL", "");
                    var remoteName = _api.getSetting("remoteName", "origin");

                    if (remoteEnabled && remoteUrl) {
                        window.BetterTypora.toast("已提交，正在推送到云端...", 2000);
                        return _sync.pushAfterMerge(_store.state.repoPath, remoteName, _git).then(function (pushResult) {
                            if (pushResult.success) {
                                window.BetterTypora.toast("提交并同步成功 ✓", 2000);
                            } else {
                                window.BetterTypora.toast("已提交到本地，但推送失败，请检查网络", 3000);
                            }
                        });
                    } else {
                        window.BetterTypora.toast("已提交到本地 ✓", 2000);
                    }
                }).catch(function (err) {
                    window.BetterTypora.toast("操作异常: " + (err.message || ""), 3000);
                });
            });
        }, 400);
        } // end _doCommit
    }

    // ===================================================================
    // Auto-hide mouse tracking
    // ===================================================================

    var _isHovering = false;
    var _panelOpen = false;

    function _onTrackEnter() {
        _isHovering = true;
        if (_sidebarEl) _sidebarEl.classList.add("git-fs-visible");
    }

    function _onTrackLeave() {
        _isHovering = false;
        if (!_panelOpen && _sidebarEl) {
            _sidebarEl.classList.remove("git-fs-visible");
        }
    }

    function _onGlobalMouse(e) {
        if (_isHovering) return;
        if (!_sidebarEl) return;

        var rect = _sidebarEl.getBoundingClientRect();
        var edgeX = window.innerWidth - 36;

        if (e.clientX > edgeX && e.clientY >= rect.top - 60 && e.clientY <= rect.bottom + 60) {
            _sidebarEl.classList.add("git-fs-visible");
        } else if (!_panelOpen) {
            _sidebarEl.classList.remove("git-fs-visible");
        }
    }

    function setPanelOpen(open) {
        _panelOpen = open;
        if (open && _sidebarEl) {
            _sidebarEl.classList.remove("git-fs-visible");
        }
    }

    function updateBadge(count) {
        // no-op: badge display handled by panel
    }

    function render() {
        // no-op
    }

    function checkDom() {
        if (!document.getElementById("git-floating-sidebar") && _injected) {
            _injected = false;
            inject();
        }
    }

    function remove() {
        document.removeEventListener("mousemove", _onGlobalMouse);
        if (_sidebarEl && _sidebarEl.parentNode) _sidebarEl.parentNode.removeChild(_sidebarEl);
        _sidebarEl = null;
        _trackEl = null;
        _injected = false;
    }

    module.exports = {
        init: init,
        inject: inject,
        remove: remove,
        render: render,
        updateBadge: updateBadge,
        checkDom: checkDom,
        setPanelOpen: setPanelOpen
    };
})();
