/* 只保存同步状态，不保存 DOM 引用；这样面板重绘不会影响 Git 操作中的状态。 */
(function () {
    "use strict";

    function StateStore() {
        this._state = {
            phase: "idle",
            root: null,
            isRepo: false,
            branch: "",
            upstream: "",
            remoteUrl: "",
            files: [],
            ahead: 0,
            behind: 0,
            currentFile: null,
            commits: [],
            diff: "",
            message: "",
            error: "",
            conflict: false,
            lastUpdated: 0
        };
        this._listeners = [];
    }

    StateStore.prototype.get = function () {
        var copy = {};
        var keys = Object.keys(this._state);
        for (var i = 0; i < keys.length; i++) {
            var value = this._state[keys[i]];
            copy[keys[i]] = Array.isArray(value) ? value.slice() : value;
        }
        return copy;
    };

    StateStore.prototype.update = function (patch) {
        patch = patch || {};
        var keys = Object.keys(patch);
        for (var i = 0; i < keys.length; i++) this._state[keys[i]] = patch[keys[i]];
        this._state.lastUpdated = Date.now();
        var snapshot = this.get();
        var list = this._listeners.slice();
        for (var j = 0; j < list.length; j++) {
            try { list[j](snapshot); } catch (e) {}
        }
        return snapshot;
    };

    StateStore.prototype.subscribe = function (fn) {
        if (typeof fn !== "function") return function () {};
        this._listeners.push(fn);
        fn(this.get());
        var self = this;
        return function () {
            var index = self._listeners.indexOf(fn);
            if (index >= 0) self._listeners.splice(index, 1);
        };
    };

    StateStore.prototype.clear = function () {
        this.update({ phase: "idle", root: null, isRepo: false, branch: "", upstream: "", remoteUrl: "", files: [], ahead: 0, behind: 0, currentFile: null, commits: [], diff: "", message: "", error: "", conflict: false });
    };

    if (typeof module !== "undefined") module.exports = StateStore;
})();
