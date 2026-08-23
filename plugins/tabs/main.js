/**
 * 标签页插件 — Tab Pages
 * =========================
 * 为 Typora 添加多标签页支持, 像浏览器一样管理多个打开的文档。
 *
 * 依赖: BetterTypora 插件系统 (bettertypora:api)
 * 兼容: IE-style JS (ES5), Typora Electron 渲染进程
 */

var BetterTypora = require("bettertypora:api");
var api = BetterTypora.api;
var manifest = BetterTypora.manifest;
var logger = BetterTypora.logger;
var fs = reqnode("fs");
var path = reqnode("path");

// 定时器组 (enable 时创建，disable 时自动清理)
var _timers = null;
// 文件切换事件取消订阅
var _onFileOpenUnsub = null;

// ===================================================================
// TabDataStore — 纯数据层
// ===================================================================
var tabStore = {
    tabs: [],           // [{id, filePath, fileName, scrollTop, isDirty, isActive, lastAccessed, existsOnDisk}]
    activeTabId: null,  // 当前激活的标签 ID
    lastTabId: 0,       // 自增 ID 计数器
    closedStack: [],    // 最近关闭的标签栈 (用于 Ctrl+Shift+T 重新打开)
    maxClosedStack: 15,

    /**
     * 添加或激活标签。如果文件路径已存在 → 激活它; 否则创建新标签
     */
    addOrActivate: function (filePath) {
        // 去重: 相同路径的标签直接激活
        var existing = this.findByPath(filePath);
        if (existing) {
            this.activateTab(existing.id);
            return existing.id;
        }

        // 上限检查: 超过 maxTabs 则关闭最早的非脏、非激活标签
        var maxTabs = api.getSetting("maxTabs", 20);
        while (this.tabs.length >= maxTabs) {
            var evicted = false;
            // 从左往右 (索引 0 最早), 优先逐出最早的非脏、非激活标签
            for (var i = 0; i < this.tabs.length; i++) {
                if (!this.tabs[i].isDirty && this.tabs[i].id !== this.activeTabId) {
                    this.removeTab(this.tabs[i].id);
                    evicted = true;
                    break;
                }
            }
            if (!evicted) break; // 全是脏标签, 不再强制关闭
        }

        var fileName = path.basename(filePath);
        this.lastTabId++;
        var tab = {
            id: "tab_" + this.lastTabId,
            filePath: filePath,
            fileName: fileName,
            scrollTop: 0,
            isDirty: false,
            isActive: false,
            lastAccessed: Date.now(),
            existsOnDisk: true
        };

        // 插在末尾 (positional, not MRU)
        this.tabs.push(tab);
        this.activateTab(tab.id);
        logger.log("标签已创建: " + fileName + " (" + this.tabs.length + " 个标签)");
        return tab.id;
    },

    /**
     * 激活指定标签
     */
    activateTab: function (tabId) {
        var target = this.findById(tabId);
        if (!target) return false;

        // 缓存当前激活标签的状态
        this.cacheActiveState();

        // 取消所有激活
        for (var i = 0; i < this.tabs.length; i++) {
            this.tabs[i].isActive = false;
        }

        target.isActive = true;
        target.lastAccessed = Date.now();
        this.activeTabId = tabId;

        this.persist();
        return true;
    },

    /**
     * 关闭标签, 返回下一个应激活的标签 ID (或 null)
     */
    removeTab: function (tabId) {
        var idx = this._indexOf(tabId);
        if (idx < 0) return null;

        var tab = this.tabs[idx];
        var wasActive = tab.isActive;

        // 入栈 (用于重新打开)
        this.closedStack.push({
            filePath: tab.filePath,
            fileName: tab.fileName,
            scrollTop: tab.scrollTop,
            isDirty: tab.isDirty
        });
        if (this.closedStack.length > this.maxClosedStack) {
            this.closedStack.shift();
        }

        // 删除
        this.tabs.splice(idx, 1);

        // 选择下一个应激活的标签 (不在此处激活, 由调用方 switchToTab 统一处理)
        var nextId = null;
        if (wasActive && this.tabs.length > 0) {
            // 优先激活右侧 (idx 现在指向原本的下一个), 否则最后一个
            var nextIdx = idx < this.tabs.length ? idx : this.tabs.length - 1;
            nextId = this.tabs[nextIdx].id;
        } else if (this.tabs.length === 0) {
            this.activeTabId = null;
        }

        this.persist();
        logger.log("标签已关闭: " + tab.fileName + " (" + this.tabs.length + " 个标签)");
        return nextId;
    },

    /**
     * 重新打开最近关闭的标签
     */
    reopenLast: function () {
        if (this.closedStack.length === 0) return null;
        var entry = this.closedStack.pop();
        var tabId = this.addOrActivate(entry.filePath);
        // 恢复滚动位置
        var tab = this.findById(tabId);
        if (tab) tab.scrollTop = entry.scrollTop || 0;
        return tabId;
    },

    /**
     * 切换到下一个标签 (按位置顺序循环)
     */
    nextTab: function () {
        if (this.tabs.length < 2) return null;
        var idx = this._indexOf(this.activeTabId);
        var nextIdx = (idx + 1) % this.tabs.length;
        return this.tabs[nextIdx].id;
    },

    /**
     * 切换到上一个标签
     */
    prevTab: function () {
        if (this.tabs.length < 2) return null;
        var idx = this._indexOf(this.activeTabId);
        var prevIdx = (idx - 1 + this.tabs.length) % this.tabs.length;
        return this.tabs[prevIdx].id;
    },

    /**
     * 对当前激活标签缓存滚动位置和脏状态
     */
    cacheActiveState: function () {
        var active = this.getActive();
        if (!active) return;
        // 滚动位置
        var content = document.querySelector("content");
        if (content) active.scrollTop = content.scrollTop;
        // 脏状态
        active.isDirty = isDocumentDirty();
        // 文件是否还存在
        active.existsOnDisk = fs.existsSync(active.filePath);
    },

    /**
     * 获取当前激活标签
     */
    getActive: function () {
        return this.findById(this.activeTabId);
    },

    findById: function (tabId) {
        for (var i = 0; i < this.tabs.length; i++) {
            if (this.tabs[i].id === tabId) return this.tabs[i];
        }
        return null;
    },

    findByPath: function (filePath) {
        var normalized = normalizePath(filePath);
        for (var i = 0; i < this.tabs.length; i++) {
            if (normalizePath(this.tabs[i].filePath) === normalized) return this.tabs[i];
        }
        return null;
    },

    _indexOf: function (tabId) {
        for (var i = 0; i < this.tabs.length; i++) {
            if (this.tabs[i].id === tabId) return i;
        }
        return -1;
    },

    /**
     * 移动标签位置 (拖拽排序)
     * @param {number} fromIndex - 原位置索引
     * @param {number} toIndex - 目标位置索引
     */
    moveTab: function (fromIndex, toIndex) {
        if (fromIndex < 0 || fromIndex >= this.tabs.length) return;
        if (toIndex < 0 || toIndex >= this.tabs.length) return;
        if (fromIndex === toIndex) return;

        var removed = this.tabs.splice(fromIndex, 1)[0];
        this.tabs.splice(toIndex, 0, removed);
        this.persist();
        logger.log("标签已移动: " + removed.fileName + " (" + fromIndex + " → " + toIndex + ")");
    },
    persist: function () {
        var slim = [];
        for (var i = 0; i < this.tabs.length; i++) {
            var t = this.tabs[i];
            slim.push({
                filePath: t.filePath,
                scrollTop: t.scrollTop,
                isDirty: t.isDirty,
                isActive: t.isActive,
                lastAccessed: t.lastAccessed
            });
        }
        api.setSetting("openTabs", JSON.stringify(slim));
        api.setSetting("activeTabId", this.activeTabId || "");
    },

    /**
     * 从 SettingsManager 恢复标签列表
     */
    restore: function () {
        var raw = api.getSetting("openTabs", "");
        if (!raw) return 0;
        var slim;
        try {
            slim = JSON.parse(raw);
        } catch (e) {
            return 0;
        }
        if (!Array.isArray(slim) || slim.length === 0) return 0;

        var count = 0;
        for (var i = 0; i < slim.length; i++) {
            var s = slim[i];
            // 校验文件是否还存在
            if (!fs.existsSync(s.filePath)) {
                logger.log("恢复时跳过不存在的文件: " + s.filePath);
                window.BetterTypora.toast &&
                    window.BetterTypora.toast("⚠️ 标签恢复: 文件已不存在 — " + path.basename(s.filePath), 800);
                continue;
            }
            this.lastTabId++;
            var tab = {
                id: "tab_" + this.lastTabId,
                filePath: s.filePath,
                fileName: path.basename(s.filePath),
                scrollTop: s.scrollTop || 0,
                isDirty: s.isDirty || false,
                isActive: s.isActive || false,
                lastAccessed: s.lastAccessed || Date.now(),
                existsOnDisk: true
            };
            this.tabs.push(tab);
            if (tab.isActive) this.activeTabId = tab.id;
            count++;
        }

        // 如果没有 active 标签, 默认激活第一个
        if (!this.activeTabId && this.tabs.length > 0) {
            this.tabs[0].isActive = true;
            this.activeTabId = this.tabs[0].id;
        }

        logger.log("标签恢复: " + count + " 个标签");
        return count;
    }
};

// ===================================================================
// 辅助函数
// ===================================================================

/** 路径规范化 (统一反斜杠/斜杠, 小写盘符) */
function normalizePath(filePath) {
    if (!filePath) return "";
    return filePath.replace(/\\/g, "/").replace(/^([A-Z]):/i, function (_, d) {
        return d.toUpperCase() + ":";
    });
}

/** 检测文档是否有未保存修改
 *  保护: 无文档或文件不存在时不算脏 — 文件被外部删除后 Typora 会把
 *  bundle.hasModified 标记为 truthy (防数据丢失), 但标签即将被清理,
 *  此时显示脏状态没有意义, 还会污染下一个激活标签的显示 */
function isDocumentDirty() {
    var p = BetterTypora.getCurrentFile();
    if (!p || !fs.existsSync(p)) return false;
    return BetterTypora.isDocumentEdited();
}

/** 重置 Typora 的"伪修改"状态 (文件被外部删除后 Typora 会把文档标记为已修改)
 *  仅在被删标签删除前无真实修改时调用, 避免切换文档时弹"是否保存"框 */
function clearFakeModifiedState() {
    try {
        if (typeof File !== "undefined") {
            if (File.bundle) File.bundle.hasModified = false;
            if (File.changeCounter && typeof File.changeCounter.reset === "function") {
                File.changeCounter.reset();
            }
        }
    } catch (e) {
        logger.warn("clearFakeModifiedState:", e.message);
    }
}

// ===================================================================
// TabBarUI — DOM 注入与渲染
// ===================================================================
var tabBarUI = {
    barEl: null,
    _guardTimerRef: null,

    /**
     * 注入标签栏到 <content> 顶部
     */
    inject: function () {
        var content = document.querySelector("content");
        if (!content) {
            logger.warn("未找到 <content> 元素, 标签栏注入延迟");
            return false;
        }

        // 检查是否已存在
        if (document.getElementById("typora-tab-bar")) return true;

        var bar = document.createElement("div");
        bar.id = "typora-tab-bar";
        bar.setAttribute("data-plugin-id", "tabs");

        // 作为 content 的第一个子元素插入
        if (content.firstChild) {
            content.insertBefore(bar, content.firstChild);
        } else {
            content.appendChild(bar);
        }

        this.barEl = bar;
        this.render();
        logger.log("标签栏已注入");
        return true;
    },

    /**
     * 渲染标签芯片
     *
     * 拖拽排序: 纯鼠标事件 — 浏览器标签页同款"导轨滑动"
     *   mousedown → 记录起始位置
     *   mousemove → 超过 5px 进入拖拽: 芯片跟随鼠标 (transform),
     *               计算插入位置 (insertIndex), 用 CSS class 指示
     *   mouseup → moveTab(fromIndex, toIndex) → render() 重建 DOM + FLIP 落地动画
     *
     *   moveTab 只在 mouseup 调用一次, 不在 mousemove 中频繁
     *   调换数组 — 避免了 DOM 物理位置与数据不一致的混乱。
     */
    render: function () {
        if (!this.barEl) {
            this.barEl = document.getElementById("typora-tab-bar");
        }
        if (!this.barEl) return;

        // 清空
        this.barEl.innerHTML = "";

        // 无标签时隐藏
        if (tabStore.tabs.length === 0) {
            this.barEl.style.display = "none";
            return;
        }
        this.barEl.style.display = "flex";

        var self = this;

        // --- 拖拽状态 ---
        var drag = {
            chip: null,
            tabId: null,
            fromIndex: -1,       // 拖拽起始在 tabStore 中的索引
            insertIndex: -1,     // 当前插入位置 (芯片索引)
            startX: 0,
            barLeft: 0,
            barRight: 0,
            chipWidth: 0,
            active: false,
            moved: false,
            snapshot: null,       // mousedown 时所有芯片的位置快照
        };

        for (var i = 0; i < tabStore.tabs.length; i++) {
            var tab = tabStore.tabs[i];
            var chip = document.createElement("div");
            chip.className = "typora-tab-chip" + (tab.isActive ? " active" : "") + (tab.isDirty ? " dirty" : "");
            chip.setAttribute("data-tab-id", tab.id);
            chip.setAttribute("data-tab-index", String(i));
            chip.title = tab.filePath;
            chip.draggable = false;

            // --- 标签名 ---
            var label = document.createElement("span");
            label.className = "typora-tab-label";
            label.textContent = tab.fileName;
            chip.appendChild(label);

            // --- 关闭按钮 ---
            if (api.getSetting("showCloseButton", true)) {
                var closeBtn = document.createElement("span");
                closeBtn.className = "typora-tab-close";
                closeBtn.textContent = "×";
                (function (tabId) {
                    closeBtn.addEventListener("click", function (e) {
                        e.stopPropagation();
                        e.preventDefault();
                        closeTab(tabId);
                    });
                    closeBtn.addEventListener("mousedown", function (e) {
                        e.stopPropagation();
                    });
                })(tab.id);
                chip.appendChild(closeBtn);
            }

            // --- mousedown ---
            (function (tabId, index) {
                chip.addEventListener("mousedown", function (e) {
                    if (e.button !== 0) return;
                    e.preventDefault();

                    // 用 e.currentTarget 而非闭包 chip — 因为 render
                    // 可能在拖拽结束后重建 DOM, 旧 chip 引用已失效
                    drag.chip = e.currentTarget;
                    drag.tabId = tabId;
                    drag.fromIndex = index;
                    drag.insertIndex = index;
                    drag.startX = e.clientX;
                    drag.chipWidth = e.currentTarget.getBoundingClientRect().width;
                    drag.active = false;
                    drag.moved = false;

                    var barRect = self.barEl.getBoundingClientRect();
                    drag.barLeft = barRect.left + 4;
                    drag.barRight = barRect.right - 4;

                    // 快照所有芯片初始位置 (用于 insertIndex 稳定性)
                    var allChips = self.barEl.querySelectorAll(".typora-tab-chip");
                    drag.snapshot = [];
                    for (var ci = 0; ci < allChips.length; ci++) {
                        var cr = allChips[ci].getBoundingClientRect();
                        drag.snapshot.push({ left: cr.left, width: cr.width });
                    }
                });
            })(tab.id, i);

            // --- click ---
            (function (tabId) {
                chip.addEventListener("click", function () {
                    if (drag.moved) return;
                    switchToTab(tabId);
                });
            })(tab.id);

            // --- auxclick ---
            (function (tabId) {
                chip.addEventListener("auxclick", function (e) {
                    if (e.button === 1) {
                        e.preventDefault();
                        closeTab(tabId);
                    }
                });
            })(tab.id);

            this.barEl.appendChild(chip);
        }

        // --- document mousemove ---
        this._unbindDocumentDrag();
        var onMove = function (e) {
            if (!drag.chip) return;
            var dx = e.clientX - drag.startX;

            if (!drag.active && Math.abs(dx) < 5) return;
            if (!drag.active) {
                drag.active = true;
                drag.moved = true;
                drag.chip.classList.add("dragging");
                drag.chip.style.transition = "none";
            }

            // 夹持
            var clampedX = e.clientX;
            var minX = drag.barLeft;
            var maxX = drag.barRight - drag.chipWidth;
            if (clampedX < minX) clampedX = minX;
            if (clampedX > maxX) clampedX = maxX;

            drag.chip.style.transform = "translateX(" + (clampedX - drag.startX) + "px)";

            // 计算插入位置 — 拖拽芯片边缘 vs 其他芯片原始中点 (快照)
            var chips = self.barEl.querySelectorAll(".typora-tab-chip");
            // 拖拽芯片视觉基点 + 位移
            var chipBase = drag.snapshot[drag.fromIndex].left + (clampedX - drag.startX);
            // 右移用右边缘, 左移用左边缘, 两者都防止"连体"
            var chipCompareX = (clampedX >= drag.startX) ? chipBase + drag.chipWidth : chipBase;
            var newInsert = drag.fromIndex;
            var found = false;
            for (var j = 0; j < chips.length; j++) {
                if (j === drag.fromIndex) continue;
                var snapMid = drag.snapshot[j].left + drag.snapshot[j].width / 2;
                if (chipCompareX < snapMid) {
                    newInsert = parseInt(chips[j].getAttribute("data-tab-index"), 10);
                    found = true;
                    break;
                }
            }
            // 所有非拖拽芯片都在 clampedX 左侧 → 插入到末尾
            if (!found) {
                newInsert = chips.length;
            }

            if (newInsert !== drag.insertIndex) {
                drag.insertIndex = newInsert;

                // --- 避让动画: 被占位芯片统一偏移 ---
                var slotWidth = drag.snapshot[drag.fromIndex].width + 2; // +2 为左右 margin (各 1px)
                for (var k = 0; k < chips.length; k++) {
                    var idx = parseInt(chips[k].getAttribute("data-tab-index"), 10);
                    if (idx === drag.fromIndex) continue; // 拖拽芯片自身

                    var offset = 0;
                    if (drag.fromIndex < newInsert) {
                        // 向右拖: fromIndex+1 ~ newInsert-1 向左让位 (newInsert 本身不动)
                        if (idx > drag.fromIndex && idx < newInsert) {
                            offset = -slotWidth;
                        }
                    } else if (drag.fromIndex > newInsert) {
                        // 向左拖: newInsert ~ fromIndex-1 向右让位
                        if (idx >= newInsert && idx < drag.fromIndex) {
                            offset = slotWidth;
                        }
                    }

                    if (offset !== 0) {
                        chips[k].style.transform = "translateX(" + offset + "px)";
                        chips[k].classList.add("yielding");
                    } else {
                        chips[k].style.transform = "translateX(0px)";
                        chips[k].classList.add("yielding");
                    }

                    // 刷新插入指示器
                    chips[k].classList.remove("insert-before");
                }
                if (newInsert >= 0 && newInsert < chips.length && newInsert !== drag.fromIndex) {
                    var targetChip = self.barEl.querySelector('[data-tab-index="' + newInsert + '"]');
                    if (targetChip) {
                        targetChip.classList.add("insert-before");
                    }
                }
            }
        };
        document.addEventListener("mousemove", onMove);
        this._dragMove = onMove;

        // --- document mouseup ---
        var onUp = function () {
            if (!drag.chip) return;

            // 保存拖拽芯片的视觉位置 (用于 FLIP 落地动画)
            var dragVisualLeft = drag.chip.getBoundingClientRect().left;
            var draggedTabId = drag.tabId;
            var positionChanged = drag.active && drag.insertIndex !== drag.fromIndex;

            // 清理视觉
            drag.chip.classList.remove("dragging");
            var chips = self.barEl.querySelectorAll(".typora-tab-chip");
            for (var j = 0; j < chips.length; j++) {
                chips[j].classList.remove("insert-before", "yielding");
                chips[j].style.transform = "";
            }

            // 仅在位置改变时执行 moveTab + render
            if (positionChanged) {
                var toIndex = drag.insertIndex > drag.fromIndex
                    ? drag.insertIndex - 1
                    : drag.insertIndex;
                tabStore.moveTab(drag.fromIndex, toIndex);
                self.render();

                // FLIP 落地动画: 拖拽芯片从旧视觉位置平滑滑入新 flex 位置
                var newChip = self.barEl.querySelector('[data-tab-id="' + draggedTabId + '"]');
                if (newChip) {
                    var newRect = newChip.getBoundingClientRect();
                    var deltaX = dragVisualLeft - newRect.left;
                    if (Math.abs(deltaX) > 1) {
                        newChip.style.transition = "none";
                        newChip.style.transform = "translateX(" + deltaX + "px)";
                        newChip.offsetHeight; // 强制 reflow
                        newChip.style.transition = "transform 0.12s cubic-bezier(0.25, 0.46, 0.45, 0.94)";
                        newChip.style.transform = "translateX(0px)";
                        (function (chip) {
                            chip.addEventListener("transitionend", function cleanup() {
                                chip.removeEventListener("transitionend", cleanup);
                                chip.style.transition = "";
                                chip.style.transform = "";
                            });
                        })(newChip);
                    }
                }
            } else {
                // 未移动: 清理拖拽芯片自身 transform
                drag.chip.style.transform = "";
                drag.chip.style.transition = "";
            }

            drag.chip = null;
            drag.tabId = null;
            drag.active = false;
            _timers.setTimeout(function () { drag.moved = false; }, 0);
        };
        document.addEventListener("mouseup", onUp);
        this._dragUp = onUp;
    },

    /**
     * 解绑上一次 render 注册的 document 监听器
     */
    _unbindDocumentDrag: function () {
        if (this._dragMove) {
            document.removeEventListener("mousemove", this._dragMove);
            this._dragMove = null;
        }
        if (this._dragUp) {
            document.removeEventListener("mouseup", this._dragUp);
            this._dragUp = null;
        }
    },

    /**
     * 守护循环: 每 500ms 检查标签栏是否存在
     */
    startGuard: function () {
        if (this._guardTimerRef) return;
        var self = this;
        this._guardTimerRef = _timers.setInterval(function () {
            var existing = document.getElementById("typora-tab-bar");
            var content = document.querySelector("content");
            if (!existing && content && tabStore.tabs.length > 0) {
                logger.log("标签栏被移除, 重新注入");
                self.inject();
            }
        }, 500);
    },

    stopGuard: function () {
        if (this._guardTimerRef) {
            _timers.clearInterval(this._guardTimerRef);
            this._guardTimerRef = null;
        }
    }
};

// ===================================================================
// OpenFileInterceptor — 拦截文件打开
// ===================================================================
var interceptor = {
    _onFileOpenUnsub: null,

    /**
     * 通过 BetterTypora.onFileOpen 注册文件切换监听
     */
    install: function () {
        if (this._onFileOpenUnsub) return true;
        var self = this;
        this._onFileOpenUnsub = BetterTypora.onFileOpen(function (filePath) {
            tabStore.cacheActiveState();
            var tabId = tabStore.addOrActivate(filePath);
            self._restoreScrollAfterOpen(tabId, 0);
        });
        logger.log("已注册文件切换监听 (BetterTypora.onFileOpen)");
        return true;
    },

    /**
     * 等待 Typora 加载完毕后恢复滚动位置
     */
    _restoreScrollAfterOpen: function (tabId, attempt) {
        if (attempt === undefined) attempt = 0;

        var tab = tabStore.findById(tabId);

        // 超时或标签不存在 → 强制渲染后退出
        if (attempt > 40 || !tab) {
            tabBarUI.render();
            return;
        }
        var write = document.getElementById("write");
        var content = document.querySelector("content");

        // Typora 渲染完成的标志:
        //   1. #write 存在
        //   2. #write 内有内容 或 .ty-before-first-render 已移除
        //   3. 前 6 次 (300ms) 需要更严格的条件
        if (write) {
            var done = (write.textContent && write.textContent.trim().length > 0) ||
                       !write.classList.contains("ty-before-first-render");
            if (attempt < 6) {
                done = done && !write.classList.contains("ty-before-first-render");
            }
            if (done) {
                if (content && tab.scrollTop > 0) {
                    content.scrollTop = tab.scrollTop;
                }
                tabBarUI.render();
                return;
            }
        }

        var self = this;
        _timers.setTimeout(function () {
            self._restoreScrollAfterOpen(tabId, attempt + 1);
        }, 50);
    },

    uninstall: function () {
        if (this._onFileOpenUnsub) {
            BetterTypora.offFileOpen(this._onFileOpenUnsub);
            this._onFileOpenUnsub = null;
            logger.log("已取消文件切换监听");
        }
    }
};

// ===================================================================
// NewFileInterceptor — 将"新建文件"拦截在同一窗口内
// ===================================================================
var newFileInterceptor = {
    _installed: false,

    install: function () {
        if (this._installed) return;
        this._installed = true;

        // 1. 拦截 Ctrl+N (新建文件) — Typora 会打开新窗口
        document.addEventListener("keydown", function (e) {
            if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key === "n") {
                // 检查焦点在编辑器或窗口内
                var active = document.activeElement;
                if (active && (active.id === "write" || active.closest("#write") ||
                    active.tagName === "BODY" || active === document.body)) {
                    e.preventDefault();
                    e.stopPropagation();
                    newFileInterceptor.createUntitledTab();
                }
            }
        }, true); // 捕获阶段, 在 Typora 之前拦截

        // 2. 拦截一体化菜单中的 "新建" 项
        document.addEventListener("click", function (e) {
            var el = e.target;
            while (el) {
                var id = el.id;
                // megamenu 中的新建按钮
                if (id === "m-open-local" || id === "m-open") {
                    // 打开文件 — 正常流程, 会被 openFile 拦截器捕获
                    break;
                }
                // 侧边栏的新建文件按钮
                if (id === "sidebar-new-file-btn" || id === "new-file-btn") {
                    e.preventDefault();
                    e.stopPropagation();
                    newFileInterceptor.createUntitledTab();
                    break;
                }
                el = el.parentNode;
            }
        }, true);

        logger.log("已安装新建文件拦截器");
    },

    /**
     * 创建无标题新标签 (不打开新窗口)
     */
    createUntitledTab: function () {
        // 生成 untitled 文件名, 放在当前文档同目录
        var untitledDir = "";
        var activeTab = tabStore.getActive();
        if (activeTab) {
            untitledDir = path.dirname(activeTab.filePath);
        } else {
            // 尝试从 Typora 获取当前打开的文件夹
            try {
                var f = BetterTypora.getMountFolder();
                if (f) untitledDir = f;
            } catch (e) { /* skip */ }
            if (!untitledDir) {
                // 尝试使用当前文档的目录名，fallback 到用户文档目录
                try {
                    untitledDir = path.join(process.cwd(), "notes");
                } catch (e2) { /* skip */ }
                if (!untitledDir || !fs.existsSync(untitledDir)) {
                    try {
                        untitledDir = require("os").homedir();
                    } catch (e3) { /* skip */ }
                }
            }
        }

        // 找不冲突的文件名
        var baseName = "untitled";
        var filePath = path.join(untitledDir, baseName + ".md");
        var counter = 1;
        while (fs.existsSync(filePath)) {
            counter++;
            filePath = path.join(untitledDir, baseName + "-" + counter + ".md");
        }

        // 创建空文件
        try {
            fs.writeFileSync(filePath, "# " + baseName + "\n\n", "utf8");
        } catch (e) {
            logger.error("创建新文件失败:", e.message);
            window.BetterTypora.toast &&
                window.BetterTypora.toast("❌ 创建新文件失败: " + e.message, 800);
            return;
        }

        // 打开文件 — BetterTypora API 会自动处理 tab 管理
        BetterTypora.openFile(filePath);

        window.BetterTypora.toast &&
            window.BetterTypora.toast("📝 新建文件: " + path.basename(filePath), 800);
        logger.log("已创建新标签文件: " + filePath);
    },

    uninstall: function () {
        this._installed = false;
    }
};

// ===================================================================
// 核心操作
// ===================================================================

/**
 * 切换到指定标签
 */
function switchToTab(tabId) {
    var tab = tabStore.findById(tabId);
    if (!tab || tab.isActive) return;

    // 检查当前文档是否脏
    if (api.getSetting("confirmBeforeClose", true)) {
        var active = tabStore.getActive();
        if (active && active.isDirty) {
            var confirmed = confirm(
                "“" + active.fileName + "” 有未保存的修改。\n" +
                "切换标签前是否保存？\n\n" +
                "确定 = 保存后切换  |  取消 = 不切换"
            );
            if (confirmed) {
                // 尝试触发 Typora 的保存
                triggerSave();
            } else {
                return;
            }
        }
    }

    // 缓存当前状态
    tabStore.cacheActiveState();

    // 更新激活状态
    tabStore.activateTab(tabId);

    // 让 Typora 打开文件 (使用 BetterTypora API，自动处理 null 安全)
    BetterTypora.openFile(tab.filePath);

    // 恢复滚动位置 (内部完成后会调用 tabBarUI.render())
    interceptor._restoreScrollAfterOpen(tabId, 0);

    logger.log("切换到标签: " + tab.fileName);
    api.emit("tabs:switched", { tabId: tabId, filePath: tab.filePath });
}

/**
 * 关闭标签
 */
function closeTab(tabId) {
    var tab = tabStore.findById(tabId);
    if (!tab) return;

    // 脏文档确认
    if (tab.isDirty && api.getSetting("confirmBeforeClose", true)) {
        var confirmed = confirm(
            "“" + tab.fileName + "” 有未保存的修改。\n" +
            "关闭标签前是否保存？\n\n" +
            "确定 = 保存后关闭  |  取消 = 不关闭"
        );
        if (confirmed) {
            triggerSave();
        } else {
            return;
        }
    }

    var wasActive = tab.isActive;
    var nextTabId = tabStore.removeTab(tabId);

    // 如果关闭的是最后一个标签, 保持当前文档不变
    if (tabStore.tabs.length === 0) {
        tabBarUI.render();
        return;
    }

    // 如果关闭的是激活标签, 切换到下一个
    if (wasActive && nextTabId) {
        switchToTab(nextTabId);
    } else {
        tabBarUI.render();
    }
}

/**
 * 触发 Typora 的保存操作
 */
function triggerSave() {
    BetterTypora.saveFile();
}

// ===================================================================
// 事件监听
// ===================================================================

/** 滚动监听 — 实时缓存 */
var _scrollTimeout = null;
function onContentScroll() {
    if (_scrollTimeout) _timers.clearTimeout(_scrollTimeout);
    _scrollTimeout = _timers.setTimeout(function () {
        tabStore.cacheActiveState();
    }, 200);
}

/** 脏状态轮询 */
var _dirtyPollInterval = null;
function startDirtyPoll() {
    if (_dirtyPollInterval) return;
    _dirtyPollInterval = _timers.setInterval(function () {
        var active = tabStore.getActive();
        if (!active) return;
        var dirty = isDocumentDirty();
        if (dirty !== active.isDirty) {
            active.isDirty = dirty;
            tabBarUI.render();
            if (dirty) tabStore.persist();
        }
    }, 500);
}

function stopDirtyPoll() {
    if (_dirtyPollInterval) {
        _timers.clearInterval(_dirtyPollInterval);
        _dirtyPollInterval = null;
    }
}

/** 标题变化监听 (备用脏检测) */
var _titleObserver = null;
function startTitleObserver() {
    try {
        _titleObserver = new MutationObserver(function () {
            var active = tabStore.getActive();
            if (!active) return;
            var dirty = isDocumentDirty();
            if (dirty !== active.isDirty) {
                active.isDirty = dirty;
                tabBarUI.render();
            }
        });
        var titleEl = document.querySelector("title");
        if (titleEl) {
            _titleObserver.observe(titleEl, { childList: true, characterData: true, subtree: true });
        }
    } catch (e) {
        // MutationObserver 不可用, 依靠轮询
    }
}

function stopTitleObserver() {
    if (_titleObserver) {
        _titleObserver.disconnect();
        _titleObserver = null;
    }
}

/** 死标签检测: 每 2s 检查标签对应的文件是否还在磁盘上 */
var _deadTabInterval = null;
function startDeadTabWatcher() {
    if (_deadTabInterval) return;
    _deadTabInterval = _timers.setInterval(function () {
        var removed = [];
        for (var i = tabStore.tabs.length - 1; i >= 0; i--) {
            var t = tabStore.tabs[i];
            if (!fs.existsSync(t.filePath)) {
                removed.push(t);
                if (t.isActive) {
                    tabStore.cacheActiveState();
                    // 被删文件若删除前无真实修改 → 重置 Typora 伪修改状态,
                    // 否则切换文档时 Typora 会弹"是否保存更改"框 (文件已删, 提示无意义)
                    if (!t.isDirty) {
                        clearFakeModifiedState();
                    }
                }
                tabStore.tabs.splice(i, 1);
                logger.log("标签已自动清除 (文件不存在): " + t.fileName);
            }
        }
        if (removed.length > 0) {
            // 如果激活标签被移除, 且还有其他标签 → 切换到第一个
            if (tabStore.tabs.length > 0 && !tabStore.getActive()) {
                var next = tabStore.tabs[0];
                tabStore.activateTab(next.id);
                // 打开该文件 (BetterTypora API 自动处理 null 安全)
                BetterTypora.openFile(next.filePath);
            } else if (tabStore.tabs.length === 0) {
                tabStore.activeTabId = null;
            }
            tabBarUI.render();
            tabStore.persist();
            // 通知用户
            var names = [];
            for (var r = 0; r < removed.length && r < 3; r++) {
                names.push(removed[r].fileName);
            }
            var msg = "🗑 文件已不存在, 标签已清除: " + names.join(", ");
            if (removed.length > 3) msg += " 等 " + removed.length + " 个";
            window.BetterTypora.toast && window.BetterTypora.toast(msg, 800);
        }
    }, 2000);
}

function stopDeadTabWatcher() {
    if (_deadTabInterval) {
        _timers.clearInterval(_deadTabInterval);
        _deadTabInterval = null;
    }
}

/**
 * 自动检测 Typora 当前已打开的文档
 * 场景: Typora 启动时从上次会话恢复文件, 或用户通过命令行打开文件
 * 此时我们的拦截器尚未安装, 需要手动捕获当前文档路径
 */
function autoDetectCurrentDocument(hasRestoredTabs) {
    var currentPath = null;

    // 方法 1: 从 window.location.hash / query 获取
    if (window.location && window.location.hash) {
        // Typora 可能在 hash 中存储文件路径
        var hash = decodeURIComponent(window.location.hash.replace(/^#/, ""));
        if (hash && fs.existsSync(hash)) {
            currentPath = hash;
        }
    }

    // 方法 2: 从 document.title 反推
    if (!currentPath) {
        var title = document.title;
        if (title) {
            title = title.replace(/\*$/, "").replace(/ - Typora$/i, "").trim();
            // 尝试在已恢复的标签中匹配
            if (hasRestoredTabs) {
                for (var i = 0; i < tabStore.tabs.length; i++) {
                    if (tabStore.tabs[i].fileName === title ||
                        tabStore.tabs[i].fileName.replace(/\.(md|markdown|txt)$/i, "") === title) {
                        currentPath = tabStore.tabs[i].filePath;
                        break;
                    }
                }
            }
        }
    }

    // 方法 3: 查找 window 上记录当前文件路径的变量
    if (!currentPath) {
        try {
            var candidates = ["currentFilePath", "openedFilePath", "lastOpenedFile", "activeFilePath"];
            for (var j = 0; j < candidates.length; j++) {
                var val = window[candidates[j]];
                if (typeof val === "string" && val && fs.existsSync(val)) {
                    currentPath = val;
                    break;
                }
            }
        } catch (e) { /* skip */ }
    }

    // 方法 3.5: BetterTypora.getCurrentFile()
    if (!currentPath) {
        try {
            var bp = BetterTypora.getCurrentFile();
            if (bp && fs.existsSync(bp)) currentPath = bp;
        } catch (e) { /* skip */ }
    }

    // 方法 4: 恢复标签兜底 — 自动打开最后一个活跃标签
    if (!currentPath && hasRestoredTabs && tabStore.tabs.length > 0) {
        var bestTab = null;
        // 优先选标记为 active 的; 否则选 lastAccessed 最新的
        for (var k = 0; k < tabStore.tabs.length; k++) {
            var t = tabStore.tabs[k];
            if (fs.existsSync(t.filePath)) {
                if (t.isActive) { bestTab = t; break; }
                if (!bestTab || t.lastAccessed > bestTab.lastAccessed) {
                    bestTab = t;
                }
            }
        }
        if (bestTab) {
            currentPath = bestTab.filePath;
            logger.log("恢复打开文件: " + bestTab.fileName + " (" + bestTab.filePath + ")");
            // 关键: 实际打开文件 — 触发 openFile 拦截器, 通知所有订阅者
            BetterTypora.openFile(currentPath);
        }
    }

    // 如果找到了路径且尚未在标签列表中
    if (currentPath && /\.(md|markdown|mdown|txt|textile|rst|org)$/i.test(currentPath)) {
        var existing = tabStore.findByPath(currentPath);
        if (!existing) {
            logger.log("检测到当前文档: " + path.basename(currentPath));
            tabStore.addOrActivate(currentPath);
            tabBarUI.render();
        } else if (!existing.isActive) {
            // 存在但未激活 — 更新激活状态
            tabStore.activateTab(existing.id);
            tabBarUI.render();
        }
    } else if (tabStore.tabs.length === 0) {
        // 完全检测不到文件 — 显示空状态, 提示用户
        logger.log("未检测到已打开的文档, 等待用户打开文件...");
    }
}

// ===================================================================
// 插件生命周期
// ===================================================================
module.exports = {
    onLoad: function () {
        logger.log("标签页插件 v" + manifest.version + " 已加载");
    },

    enable: function () {
        _timers = BetterTypora.createTimerGroup();
        logger.log("正在启用标签页插件...");

        // 1. 恢复持久化的标签列表
        var restoreOnStartup = api.getSetting("restoreOnStartup", true);
        var restoredCount = 0;
        if (restoreOnStartup) {
            restoredCount = tabStore.restore();
            logger.log("已恢复 " + restoredCount + " 个标签");
        }

        // 2. 注入标签栏
        tabBarUI.inject();
        tabBarUI.startGuard();

        // 3. 安装文件打开拦截器 (必须在 auto-detect 之前, 以便后续文件打开都能被拦截)
        interceptor.install();

        // 3b. 安装新建文件拦截器 (Ctrl+N, 侧边栏新建按钮)
        newFileInterceptor.install();

        // 4. 自动检测当前已打开的文档 (Typora 可能从上次会话恢复)
        _timers.setTimeout(function () {
            autoDetectCurrentDocument(restoredCount > 0);
        }, 1500);

        // 5. 注册命令
        api.registerCommand("next-tab", function () {
            var nextId = tabStore.nextTab();
            if (nextId) switchToTab(nextId);
        }, "切换到下一个标签");

        api.registerCommand("prev-tab", function () {
            var prevId = tabStore.prevTab();
            if (prevId) switchToTab(prevId);
        }, "切换到上一个标签");

        api.registerCommand("close-tab", function () {
            var active = tabStore.getActive();
            if (!active) return;
            // 只有一个标签时不关闭
            if (tabStore.tabs.length <= 1) {
                window.BetterTypora.toast &&
                    window.BetterTypora.toast("📍 仅剩最后一个标签", 800);
                return;
            }
            closeTab(active.id);
        }, "关闭当前标签");

        api.registerCommand("reopen-tab", function () {
            var tabId = tabStore.reopenLast();
            if (tabId) {
                switchToTab(tabId);
                window.BetterTypora.toast &&
                    window.BetterTypora.toast("🔄 已恢复标签", 800);
            }
        }, "重新打开最后关闭的标签");

        // 6. 安装滚动监听
        var content = document.querySelector("content");
        if (content) {
            content.addEventListener("scroll", onContentScroll, { passive: true });
        }

        // 7. 安装脏状态检测
        startDirtyPoll();
        startTitleObserver();

        // 8. 安装死标签检测 (文件被删除后自动清理)
        startDeadTabWatcher();

        // 9. 注册 create-untitled 命令 (供主进程 IPC 调用)
        api.registerCommand("create-untitled", function () {
            newFileInterceptor.createUntitledTab();
        }, "创建无标题新标签 (由主进程新建菜单触发)");

        logger.log("标签页插件已启用 ✅ (" + tabStore.tabs.length + " 个标签)");
    },

    disable: function () {
        logger.log("正在停用标签页插件...");

        // 关闭定时器组 (自动清理所有定时器)
        if (_timers) {
            _timers.close();
            _timers = null;
        }
        _onFileOpenUnsub = null;

        // 停止拦截器
        interceptor.uninstall();
        newFileInterceptor.uninstall();

        // 停止守护循环
        tabBarUI.stopGuard();

        // 移除标签栏 DOM
        if (tabBarUI.barEl && tabBarUI.barEl.parentNode) {
            tabBarUI.barEl.parentNode.removeChild(tabBarUI.barEl);
            tabBarUI.barEl = null;
        }
        // 清理可能残留的 (守护循环创建的)
        var bars = document.querySelectorAll("#typora-tab-bar");
        for (var i = 0; i < bars.length; i++) {
            if (bars[i].parentNode) bars[i].parentNode.removeChild(bars[i]);
        }

        // 停止监听
        var content = document.querySelector("content");
        if (content) {
            content.removeEventListener("scroll", onContentScroll);
        }
        stopDirtyPoll();
        stopTitleObserver();
        stopDeadTabWatcher();

        logger.log("标签页插件已停用");
    },

    onUnload: function () {
        if (_timers) { _timers.close(); _timers = null; }
        logger.log("标签页插件已卸载");
    }
};
