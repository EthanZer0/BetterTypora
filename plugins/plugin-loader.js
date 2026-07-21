/**
 * Typora Plugin System — Core Bootloader
 * ========================================
 * 注入方式: 由 launch.dist.js 通过 executeJavaScript 注入到渲染进程
 * 运行环境: Electron 渲染进程 (有 DOM, 有 reqnode)
 * 全局出口: window.BetterTypora
 *
 * 目录结构:
 *   resources/plugins/              ← 插件根目录 (避开 fs hook 正则)
 *   resources/plugins/.cache/       ← 运行时配置缓存
 *   resources/plugins/<plugin-id>/  ← 每个插件一个子目录
 *     manifest.json
 *     main.js
 *     style.css (可选)
 */
(function () {
    "use strict";

    // ===================================================================
    // Guard: 只初始化一次
    // ===================================================================
    if (window.BetterTypora) return;

    // ===================================================================
    // Node.js 能力 (通过 Typora 保留的 reqnode)
    // ===================================================================
    var reqnode = window.reqnode;
    if (!reqnode) {
        console.error("[BetterTypora] window.reqnode 不可用, 插件系统无法启动");
        return;
    }

    var fs = reqnode("fs");
    var path = reqnode("path");
    var Module = reqnode("module");

    // 插件根目录: resources/plugins/
    // window.dirname 由 window.html 第 327 行设置, 指向 resources/ 目录
    var PLUGINS_ROOT = path.join(window.dirname || "", "plugins");
    var CACHE_DIR = path.join(PLUGINS_ROOT, ".cache");

    // ===================================================================
    // 工具函数
    // ===================================================================

    /** 带插件名前缀的日志 */
    function createLogger(pluginId) {
        return {
            log: function () {
                var args = ["[" + pluginId + "]"].concat(Array.prototype.slice.call(arguments));
                console.log.apply(console, args);
            },
            warn: function () {
                var args = ["[" + pluginId + "]"].concat(Array.prototype.slice.call(arguments));
                console.warn.apply(console, args);
            },
            error: function () {
                var args = ["[" + pluginId + "]"].concat(Array.prototype.slice.call(arguments));
                console.error.apply(console, args);
            },
        };
    }

    var systemLogger = createLogger("BetterTypora");

    /** 安全 JSON 解析 */
    function safeJSONParse(str, fallback) {
        try {
            return JSON.parse(str);
        } catch (e) {
            return fallback;
        }
    }

    /** 安全 JSON 序列化 */
    function safeJSONStringify(obj, fallback) {
        try {
            return JSON.stringify(obj, null, 2);
        } catch (e) {
            return fallback;
        }
    }

    // ===================================================================
    // Core Service: EventBus
    // ===================================================================
    function EventBus() {
        this._listeners = {}; // eventName -> [{callback, once}]
    }

    EventBus.prototype.on = function (event, callback) {
        if (!this._listeners[event]) this._listeners[event] = [];
        this._listeners[event].push({ callback: callback, once: false });
        return this;
    };

    EventBus.prototype.once = function (event, callback) {
        if (!this._listeners[event]) this._listeners[event] = [];
        this._listeners[event].push({ callback: callback, once: true });
        return this;
    };

    EventBus.prototype.off = function (event, callback) {
        if (!this._listeners[event]) return this;
        if (callback) {
            this._listeners[event] = this._listeners[event].filter(function (l) {
                return l.callback !== callback;
            });
        } else {
            delete this._listeners[event];
        }
        return this;
    };

    EventBus.prototype.emit = function (event) {
        if (!this._listeners[event]) return;
        var args = Array.prototype.slice.call(arguments, 1);
        var listeners = this._listeners[event].slice(); // copy to avoid mutation during iteration
        for (var i = 0; i < listeners.length; i++) {
            var l = listeners[i];
            try {
                l.callback.apply(null, args);
            } catch (e) {
                systemLogger.error("EventBus emit error for event '" + event + "':", e);
            }
            if (l.once) {
                var idx = this._listeners[event].indexOf(l);
                if (idx >= 0) this._listeners[event].splice(idx, 1);
            }
        }
    };

    EventBus.prototype.emitAsync = function (event) {
        if (!this._listeners[event]) return Promise.resolve();
        var args = Array.prototype.slice.call(arguments, 1);
        var self = this;
        var listeners = this._listeners[event].slice();
        var promises = [];
        for (var i = 0; i < listeners.length; i++) {
            var l = listeners[i];
            try {
                var result = l.callback.apply(null, args);
                if (result && typeof result.then === "function") {
                    promises.push(result);
                }
            } catch (e) {
                systemLogger.error("EventBus emitAsync error for event '" + event + "':", e);
            }
            if (l.once) {
                var idx = self._listeners[event].indexOf(l);
                if (idx >= 0) self._listeners[event].splice(idx, 1);
            }
        }
        return Promise.all(promises);
    };

    EventBus.prototype.listenerCount = function (event) {
        return this._listeners[event] ? this._listeners[event].length : 0;
    };

    // ===================================================================
    // Core Service: CommandRegistry
    // ===================================================================
    function CommandRegistry() {
        this._commands = {}; // commandId -> {execute, description}
    }

    CommandRegistry.prototype.register = function (id, execute, description) {
        if (this._commands[id]) {
            systemLogger.warn("Command '" + id + "' 被覆盖");
        }
        this._commands[id] = { execute: execute, description: description || "" };
        systemLogger.log("Command registered: " + id);
    };

    CommandRegistry.prototype.unregister = function (id) {
        if (this._commands[id]) {
            delete this._commands[id];
            systemLogger.log("Command unregistered: " + id);
        }
    };

    CommandRegistry.prototype.execute = function (id) {
        var cmd = this._commands[id];
        // 自动前缀补全: 直接匹配失败时, 尝试以 "plugin-id:" 后缀匹配
        // 仅在 id 不含 ":" 时触发, 避免干扰已有的完整命令 ID
        if (!cmd && id.indexOf(":") === -1) {
            var suffix = ":" + id;
            var candidates = [];
            for (var key in this._commands) {
                if (this._commands.hasOwnProperty(key) && key.slice(key.length - suffix.length) === suffix) {
                    candidates.push(key);
                }
            }
            if (candidates.length === 1) {
                cmd = this._commands[candidates[0]];
            } else if (candidates.length > 1) {
                systemLogger.warn("Command '" + id + "' 有多个匹配: " + candidates.join(", ") + " , 请用完整名");
                return undefined;
            }
        }
        if (!cmd) {
            systemLogger.warn("Command not found: " + id);
            return undefined;
        }
        var args = Array.prototype.slice.call(arguments, 1);
        try {
            return cmd.execute.apply(null, args);
        } catch (e) {
            systemLogger.error("Command execution error '" + id + "':", e);
            return undefined;
        }
    };

    CommandRegistry.prototype.list = function () {
        return Object.keys(this._commands);
    };

    CommandRegistry.prototype.has = function (id) {
        return !!this._commands[id];
    };

    /** 按前缀取消注册 (用于插件卸载) */
    CommandRegistry.prototype.unregisterPrefix = function (prefix) {
        var self = this;
        Object.keys(this._commands).forEach(function (id) {
            if (id.indexOf(prefix) === 0) {
                self.unregister(id);
            }
        });
    };

    // ===================================================================
    // Core Service: SettingsManager
    // ===================================================================
    function SettingsManager(cacheDir) {
        this._cacheDir = cacheDir;
        this._cache = {}; // pluginId -> settings object
        this._ensureCacheDir();
    }

    SettingsManager.prototype._ensureCacheDir = function () {
        try {
            if (!fs.existsSync(this._cacheDir)) {
                fs.mkdirSync(this._cacheDir, { recursive: true });
            }
        } catch (e) {
            systemLogger.error("无法创建配置缓存目录:", e.message);
        }
    };

    SettingsManager.prototype._settingsPath = function (pluginId) {
        return path.join(this._cacheDir, pluginId + ".settings.json");
    };

    SettingsManager.prototype.get = function (pluginId, key, defaultValue) {
        var all = this.getAll(pluginId);
        return all.hasOwnProperty(key) ? all[key] : defaultValue;
    };

    SettingsManager.prototype.getAll = function (pluginId) {
        if (!this._cache[pluginId]) {
            this._load(pluginId);
        }
        return this._cache[pluginId] || {};
    };

    SettingsManager.prototype.set = function (pluginId, key, value) {
        if (!this._cache[pluginId]) this._load(pluginId);
        if (!this._cache[pluginId]) this._cache[pluginId] = {};
        this._cache[pluginId][key] = value;
        this._save(pluginId);
    };

    SettingsManager.prototype.setAll = function (pluginId, settings) {
        if (!this._cache[pluginId]) this._load(pluginId);
        var current = this._cache[pluginId] || {};
        var merged = mergeObjects(current, settings);
        this._cache[pluginId] = merged;
        this._save(pluginId);
    };

    SettingsManager.prototype.initDefaults = function (pluginId, defaults) {
        if (!this._cache[pluginId]) {
            this._load(pluginId);
            // 合并: 已持久化的值优先, 默认值填底
            var current = this._cache[pluginId] || {};
            this._cache[pluginId] = mergeObjects(defaults, current);
            this._save(pluginId);
        }
    };

    SettingsManager.prototype._load = function (pluginId) {
        var filePath = this._settingsPath(pluginId);
        try {
            if (fs.existsSync(filePath)) {
                var raw = fs.readFileSync(filePath, "utf8");
                this._cache[pluginId] = safeJSONParse(raw, {});
            } else {
                this._cache[pluginId] = {};
            }
        } catch (e) {
            systemLogger.error("加载配置失败 '" + pluginId + "':", e.message);
            this._cache[pluginId] = {};
        }
    };

    SettingsManager.prototype._save = function (pluginId) {
        var filePath = this._settingsPath(pluginId);
        try {
            fs.writeFileSync(filePath, safeJSONStringify(this._cache[pluginId], "{}"), "utf8");
        } catch (e) {
            systemLogger.error("保存配置失败 '" + pluginId + "':", e.message);
        }
    };

    /** 浅合并, b 覆盖 a */
    function mergeObjects(a, b) {
        var result = {};
        var key;
        for (key in a) {
            if (a.hasOwnProperty(key)) result[key] = a[key];
        }
        for (key in b) {
            if (b.hasOwnProperty(key)) result[key] = b[key];
        }
        return result;
    }

    // ===================================================================
    // Core Service: HotkeyManager
    // ===================================================================
    function HotkeyManager(commandRegistry) {
        this._commands = commandRegistry;
        this._bindings = []; // [{commandId, key, when, pluginId}]
        this._domInstalled = false;
    }

    HotkeyManager.prototype.register = function (commandId, keyString, when, pluginId) {
        if (!commandId || !keyString) return;
        // 避免重复注册
        for (var i = 0; i < this._bindings.length; i++) {
            if (this._bindings[i].commandId === commandId) {
                this._bindings[i] = { commandId: commandId, key: keyString.toLowerCase(), when: when || "editorFocus", pluginId: pluginId };
                return;
            }
        }
        this._bindings.push({
            commandId: commandId,
            key: keyString.toLowerCase(),
            when: when || "editorFocus",
            pluginId: pluginId,
        });
        this._installDOMListener();
    };

    HotkeyManager.prototype.unregister = function (commandId) {
        this._bindings = this._bindings.filter(function (b) {
            return b.commandId !== commandId;
        });
    };

    HotkeyManager.prototype.unregisterAll = function (pluginId) {
        this._bindings = this._bindings.filter(function (b) {
            return b.pluginId !== pluginId;
        });
    };

    /** 将 KeyboardEvent 转成标准化按键字符串 "ctrl+shift+h" (全小写) */
    HotkeyManager.prototype._eventToString = function (e) {
        var parts = [];
        if (e.ctrlKey || e.metaKey) parts.push("ctrl");
        if (e.altKey) parts.push("alt");
        if (e.shiftKey) parts.push("shift");
        var key = e.key.toLowerCase();
        if (key !== "control" && key !== "alt" && key !== "shift" && key !== "meta") {
            parts.push(key);
        }
        return parts.join("+");
    };

    HotkeyManager.prototype._installDOMListener = function () {
        if (this._domInstalled) return;
        this._domInstalled = true;
        var self = this;
        document.addEventListener("keydown", function (e) {
            var pressed = self._eventToString(e);
            // DEBUG: 取消注释下面这行来排查热键匹配
            // console.log("[HotkeyManager] pressed:", pressed, "key:", b.key);

            for (var i = 0; i < self._bindings.length; i++) {
                var b = self._bindings[i];
                // when 检查: "editorFocus" 仅编辑器焦点时生效, 其他一律触发
                if (b.when === "editorFocus") {
                    var active = document.activeElement;
                    if (!active || (active.id !== "write" && !active.closest && !active.closest("#write"))) {
                        continue;
                    }
                }
                // else: "always" 或任何其他值 — 无条件触发

                if (pressed === b.key) {
                    e.preventDefault();
                    e.stopPropagation();
                    self._commands.execute(b.commandId);
                    return;
                }
            }
        }, true); // capture 阶段, 在 Typora 之前拦截
    };

    // ===================================================================
    // PluginAPI (传递给每个插件的 API 门面)
    // ===================================================================
    function PluginAPI(pluginId, manifest, eventBus, commands, settings, hotkeys) {
        this.id = pluginId;
        this.manifest = manifest;
        this.events = eventBus;
        this.commands = commands;
        this.settings = settings;
        this.hotkeys = hotkeys;
    }

    PluginAPI.prototype.getSetting = function (key, defaultValue) {
        return this.settings.get(this.id, key, defaultValue);
    };

    PluginAPI.prototype.setSetting = function (key, value) {
        return this.settings.set(this.id, key, value);
    };

    PluginAPI.prototype.getAllSettings = function () {
        return this.settings.getAll(this.id);
    };

    PluginAPI.prototype.registerCommand = function (localId, execute, description) {
        var fullId = this.id + ":" + localId;
        return this.commands.register(fullId, execute, description);
    };

    PluginAPI.prototype.registerHotkey = function (commandId, keyString, when) {
        return this.hotkeys.register(commandId, keyString, when, this.id);
    };

    PluginAPI.prototype.on = function (event, callback) {
        return this.events.on(event, callback);
    };

    PluginAPI.prototype.once = function (event, callback) {
        return this.events.once(event, callback);
    };

    PluginAPI.prototype.off = function (event, callback) {
        return this.events.off(event, callback);
    };

    PluginAPI.prototype.emit = function (event) {
        var args = Array.prototype.slice.call(arguments, 1);
        return this.events.emit.apply(this.events, [event].concat(args));
    };

    // ===================================================================
    // PluginManager: 生命周期管理
    // ===================================================================
    function PluginManager(pluginsRoot, eventBus, commands, settings, hotkeys) {
        this._root = pluginsRoot;
        this._eventBus = eventBus;
        this._commands = commands;
        this._settings = settings;
        this._hotkeys = hotkeys;
        this._plugins = {};       // pluginId -> PluginInstance
        this._instances = {};     // pluginId -> exported module
        this._apis = {};          // pluginId -> PluginAPI
        this._cssElements = {};   // pluginId -> <style> DOM element
        this._loadOrder = [];     // ordered list of plugin ids
        this._logger = createLogger("PluginManager");
    }

    /**
     * 扫描 plugins 目录, 返回有效的插件描述符列表
     */
    PluginManager.prototype.scan = function () {
        var self = this;
        var descriptors = [];
        var entries;
        try {
            entries = fs.readdirSync(this._root, { withFileTypes: true });
        } catch (e) {
            this._logger.error("无法读取插件目录:", e.message);
            return descriptors;
        }

        for (var i = 0; i < entries.length; i++) {
            var entry = entries[i];
            if (!entry.isDirectory()) continue;
            if (entry.name.charAt(0) === ".") continue; // 跳过 .cache, 隐藏目录

            var dirPath = path.join(this._root, entry.name);
            var manifestPath = path.join(dirPath, "manifest.json");
            if (!fs.existsSync(manifestPath)) {
                this._logger.warn("跳过无 manifest 的目录: " + entry.name);
                continue;
            }

            var raw;
            try {
                raw = fs.readFileSync(manifestPath, "utf8");
            } catch (e) {
                this._logger.error("读取 manifest 失败: " + entry.name, e.message);
                continue;
            }

            var manifest = safeJSONParse(raw, null);
            if (!manifest || !manifest.id) {
                this._logger.warn("manifest 无效 (缺 id): " + entry.name);
                continue;
            }
            if (!manifest.main) {
                this._logger.warn("manifest 无效 (缺 main): " + entry.name);
                continue;
            }

            descriptors.push({
                dir: entry.name,
                manifest: manifest,
                dirPath: dirPath,
            });
        }

        return descriptors;
    };

    /**
     * 加载单个插件: 读取 main.js, 执行, 存储导出
     * 返回 true 表示加载成功, false 表示失败
     */
    PluginManager.prototype.load = function (descriptor) {
        var manifest = descriptor.manifest;
        var pluginId = manifest.id;
        var dirPath = descriptor.dirPath;
        var mainFile = manifest.main;

        this._logger.log("加载插件: " + pluginId + " (v" + (manifest.version || "0.0.0") + ")");

        // 检查是否已加载
        if (this._plugins[pluginId]) {
            this._logger.warn("插件已加载, 跳过: " + pluginId);
            return false;
        }

        // 读 main.js
        var mainPath = path.join(dirPath, mainFile);
        if (!fs.existsSync(mainPath)) {
            this._logger.error("main.js 不存在: " + mainPath);
            return false;
        }

        // 初始化默认设置 (manifest.settings 作为默认值)
        if (manifest.settings) {
            this._settings.initDefaults(pluginId, manifest.settings);
        }

        // 创建 PluginAPI / logger
        var api = new PluginAPI(pluginId, manifest, this._eventBus, this._commands, this._settings, this._hotkeys);
        this._apis[pluginId] = api;
        var logger = createLogger(pluginId);

        // 通过 Module.createRequire 创建插件专用的 require 函数
        var pluginRequire;
        try {
            pluginRequire = Module.createRequire ? Module.createRequire(mainPath) : reqnode;
        } catch (e) {
            pluginRequire = reqnode;
        }

        // Hook Module._resolveFilename + Module._load 注入虚拟模块 "bettertypora:api"
        // 必须 hook 原生方法而非包装 pluginRequire: 插件 main.js 内部的 require()
        // 走原生 Module.prototype.require → 只会查 Module._resolveFilename → Module._load,
        // 外部函数包装无法介入这条链。
        var apiInjected = { api: api, manifest: manifest, logger: logger, pluginDir: dirPath,
            // File APIs — 从 window.BetterTypora 引用，确保与全局对象一致
            saveFile: window.BetterTypora.saveFile,
            getCurrentFile: window.BetterTypora.getCurrentFile,
            getMountFolder: window.BetterTypora.getMountFolder,
            openFile: window.BetterTypora.openFile,
            isDocumentEdited: window.BetterTypora.isDocumentEdited,
            // 工具
            escapeHtml: window.BetterTypora.escapeHtml,
            // 文件切换事件
            onFileOpen: window.BetterTypora.onFileOpen,
            offFileOpen: window.BetterTypora.offFileOpen,
            // 定时器组
            createTimerGroup: window.BetterTypora.createTimerGroup,
        };
        var _origResolveFilename = Module._resolveFilename;
        var _origLoad = Module._load;
        Module._resolveFilename = function (id, mod) {
            return id === "bettertypora:api" ? id : _origResolveFilename.apply(this, arguments);
        };
        Module._load = function (id, parent, isMain) {
            return id === "bettertypora:api" ? apiInjected : _origLoad.apply(this, arguments);
        };

        var pluginModule;
        try {
            var resolvedPath;
            try { resolvedPath = pluginRequire.resolve(mainPath); } catch (e) { resolvedPath = mainPath; }
            delete pluginRequire.cache[resolvedPath]; // 清除缓存以支持 reload
            pluginModule = pluginRequire(resolvedPath);
        } catch (e) {
            this._logger.error("执行 main.js 失败:", e.message, e.stack);
            return false;
        } finally {
            // 无论成功失败都恢复钩子, 避免污染 Typora 后续模块加载
            Module._resolveFilename = _origResolveFilename;
            Module._load = _origLoad;
        }

        // 验证导出
        if (!pluginModule || typeof pluginModule !== "object") {
            this._logger.warn("main.js 导出不是对象, 插件可能无法正常工作");
        }

        // 存储
        this._plugins[pluginId] = {
            manifest: manifest,
            descriptor: descriptor,
            state: "loaded", // loaded | enabled | disabled | error
        };
        this._instances[pluginId] = pluginModule;
        this._loadOrder.push(pluginId);

        // 调用 onLoad
        if (pluginModule && typeof pluginModule.onLoad === "function") {
            try {
                pluginModule.onLoad();
            } catch (e) {
                this._logger.error("onLoad 失败:", e.message);
            }
        }

        this._eventBus.emit("plugin:" + pluginId + ":loaded");
        return true;
    };

    /**
     * 启用插件: 注入 CSS, 注册热键, 调用 enable()
     */
    PluginManager.prototype.enable = function (pluginId) {
        var plugin = this._plugins[pluginId];
        if (!plugin) {
            this._logger.warn("未找到插件, 无法启用: " + pluginId);
            return false;
        }
        if (plugin.state === "enabled") {
            return true; // 已经启用
        }

        var manifest = plugin.manifest;
        var descriptor = plugin.descriptor;
        var instance = this._instances[pluginId];

        this._logger.log("启用插件: " + pluginId);

        // 注入 CSS
        if (manifest.style) {
            var cssPath = path.join(descriptor.dirPath, manifest.style);
            if (fs.existsSync(cssPath)) {
                try {
                    var css = fs.readFileSync(cssPath, "utf8");
                    var styleEl = document.createElement("style");
                    styleEl.id = "typora-plugin-css-" + pluginId;
                    styleEl.setAttribute("data-plugin-id", pluginId);
                    styleEl.textContent = css;
                    document.head.appendChild(styleEl);
                    this._cssElements[pluginId] = styleEl;
                } catch (e) {
                    this._logger.error("注入 CSS 失败:", e.message);
                }
            }
        }

        // 调用 enable() — 必须在注册热键之前!
        // 理由: enable() 中调用 api.registerCommand() 创建命令,
        //       manifest hotkeys 指向的 commandId (如 "hello-world:greet")
        //       在 registerCommand 之前尚不存在, 按热键只会触发空命令
        if (instance && typeof instance.enable === "function") {
            try {
                instance.enable();
            } catch (e) {
                this._logger.error("enable() 失败:", e.message, e.stack);
                plugin.state = "error";
                this._eventBus.emit("plugin:" + pluginId + ":error", { error: e });
                return false;
            }
        }

        // 注册 manifest 中声明的热键 (enable 之后, 命令一定存在)
        if (manifest.hotkeys && Array.isArray(manifest.hotkeys)) {
            for (var i = 0; i < manifest.hotkeys.length; i++) {
                var hk = manifest.hotkeys[i];
                this._hotkeys.register(hk.command, hk.key, hk.when, pluginId);
            }
        }

        plugin.state = "enabled";
        this._eventBus.emit("plugin:" + pluginId + ":enabled");
        return true;
    };

    /**
     * 停用插件: 调用 disable(), 移除 CSS, 取消热键
     */
    PluginManager.prototype.disable = function (pluginId) {
        var plugin = this._plugins[pluginId];
        if (!plugin) return false;
        if (plugin.state === "disabled") return true;

        var instance = this._instances[pluginId];

        // 调用 disable()
        if (instance && typeof instance.disable === "function") {
            try {
                instance.disable();
            } catch (e) {
                this._logger.error("disable() 失败:", e.message);
            }
        }

        // 移除注入的 CSS
        if (this._cssElements[pluginId]) {
            var el = this._cssElements[pluginId];
            if (el.parentNode) el.parentNode.removeChild(el);
            delete this._cssElements[pluginId];
        }

        // 取消该插件的所有热键
        this._hotkeys.unregisterAll(pluginId);

        // 取消注册该插件的所有命令
        this._commands.unregisterPrefix(pluginId + ":");

        plugin.state = "disabled";
        this._eventBus.emit("plugin:" + pluginId + ":disabled");
        return true;
    };

    /**
     * 卸载插件: disable + onUnload + 从注册表中移除
     */
    PluginManager.prototype.unload = function (pluginId) {
        var plugin = this._plugins[pluginId];
        if (!plugin) return false;

        // 先停用
        this.disable(pluginId);

        var instance = this._instances[pluginId];

        // 调用 onUnload
        if (instance && typeof instance.onUnload === "function") {
            try {
                instance.onUnload();
            } catch (e) {
                this._logger.error("onUnload() 失败:", e.message);
            }
        }

        // 清除 require 缓存
        var mainPath = path.join(plugin.descriptor.dirPath, plugin.manifest.main);
        try {
            var mod = reqnode("module");
            // 遍历 Module._cache 找到该插件模块的缓存 key 并清除
            var cache = mod._cache;
            if (cache) {
                var keys = Object.keys(cache);
                for (var k = 0; k < keys.length; k++) {
                    if (keys[k].indexOf(plugin.descriptor.dir.replace(/\\/g, "/")) >= 0 ||
                        keys[k].indexOf(plugin.descriptor.dir.replace(/\\/g, "\\\\")) >= 0) {
                        delete cache[keys[k]];
                    }
                }
            }
        } catch (e) { /* ignore */ }

        // 从注册表中移除
        delete this._plugins[pluginId];
        delete this._instances[pluginId];
        delete this._apis[pluginId];
        var idx = this._loadOrder.indexOf(pluginId);
        if (idx >= 0) this._loadOrder.splice(idx, 1);

        this._eventBus.emit("plugin:" + pluginId + ":unloaded");
        return true;
    };

    /**
     * 重载插件
     */
    PluginManager.prototype.reload = function (pluginId) {
        var plugin = this._plugins[pluginId];
        if (!plugin) return false;
        var descriptor = plugin.descriptor;
        var wasEnabled = plugin.state === "enabled";

        this.unload(pluginId);
        if (this.load(descriptor)) {
            if (wasEnabled) {
                this.enable(pluginId);
            }
            return true;
        }
        return false;
    };

    /**
     * 扫描并加载所有插件, 根据 manifest.enabled 决定是否启用
     */
    PluginManager.prototype.loadAll = function () {
        var descriptors = this.scan();
        for (var i = 0; i < descriptors.length; i++) {
            var d = descriptors[i];
            if (this.load(d)) {
                // manifest.enabled 默认为 true
                if (d.manifest.enabled !== false) {
                    this.enable(d.manifest.id);
                }
            }
        }
        this._logger.log("已加载 " + this._loadOrder.length + " 个插件: " + this._loadOrder.join(", "));
    };

    PluginManager.prototype.get = function (pluginId) {
        return this._plugins[pluginId] || null;
    };

    PluginManager.prototype.list = function () {
        return this._loadOrder.slice();
    };

    /** 返回插件状态的快照 */
    PluginManager.prototype.status = function () {
        var self = this;
        return this._loadOrder.map(function (id) {
            var p = self._plugins[id];
            return {
                id: id,
                name: p.manifest.name || id,
                version: p.manifest.version || "0.0.0",
                state: p.state,
                description: p.manifest.description || "",
            };
        });
    };

    // ===================================================================
    // Bootstrap: 初始化并扫描
    // ===================================================================
    function bootstrap() {
        systemLogger.log("正在初始化... 插件根目录: " + PLUGINS_ROOT);

        // 确保插件目录和缓存目录存在
        try {
            if (!fs.existsSync(PLUGINS_ROOT)) {
                fs.mkdirSync(PLUGINS_ROOT, { recursive: true });
            }
            if (!fs.existsSync(CACHE_DIR)) {
                fs.mkdirSync(CACHE_DIR, { recursive: true });
            }
        } catch (e) {
            systemLogger.error("无法创建目录:", e.message);
            return;
        }

        // 实例化核心服务
        var eventBus = new EventBus();
        var commandRegistry = new CommandRegistry();
        var settingsManager = new SettingsManager(CACHE_DIR);
        var hotkeyManager = new HotkeyManager(commandRegistry);
        var pluginManager = new PluginManager(PLUGINS_ROOT, eventBus, commandRegistry, settingsManager, hotkeyManager);

        // ===================================================================
        // File APIs — 封装 Typora 内部 File 对象，避免各插件各自探索
        // 注意：这些函数在 IIFE 尾部定义，然后挂到 window.BetterTypora 上
        // 插件 enable() 在 pluginManager.loadAll() 中被异步调用,
        // 此时 window.BetterTypora 已完全初始化, 所以安全。
        // ===================================================================

        var _btSaveFile = function () {
            try {
                if (typeof File !== "undefined" && typeof File.saveUseNode === "function") {
                    File.saveUseNode();
                }
            } catch (e) {
                systemLogger.warn("saveFile:", e.message);
            }
        };

        var _btGetCurrentFile = function () {
            try {
                if (typeof File !== "undefined" && File.bundle && File.bundle.filePath) {
                    return String(File.bundle.filePath);
                }
            } catch (e) {}
            return null;
        };

        var _btGetMountFolder = function () {
            try {
                if (typeof File !== "undefined" && typeof File.getMountFolder === "function") {
                    var dir = File.getMountFolder();
                    if (dir && typeof dir === "string" && dir.length > 0) return dir;
                }
            } catch (e) {}
            return null;
        };

        var _btOpenFile = function (filePath) {
            try {
                if (typeof File !== "undefined" && File.editor && File.editor.library
                    && typeof File.editor.library.openFile === "function") {
                    File.editor.library.openFile(filePath);
                }
            } catch (e) {
                systemLogger.warn("openFile:", e.message);
            }
        };

        var _btIsDocumentEdited = function () {
            try {
                if (typeof File !== "undefined" && typeof File.isDocumentEdited === "function") {
                    return File.isDocumentEdited();
                }
            } catch (e) {}
            return false;
        };

        // ===================================================================
        // escapeHtml — 防 XSS 工具
        // ===================================================================
        var _btEscapeHtml = function (str) {
            if (!str) return "";
            return String(str)
                .replace(/&/g, "&amp;")
                .replace(/</g, "&lt;")
                .replace(/>/g, "&gt;")
                .replace(/"/g, "&quot;");
        };

        // ===================================================================
        // onFileOpen / offFileOpen — 统一文件切换事件
        // ===================================================================
        // 所有插件共享同一个 openFile 猴子补丁和守护，不各自探测。
        // 回调签名: function(filePath)  — filePath 为 string

        var _fileOpenCallbacks = [];       // [{id, fn}]
        var _fileOpenNextId = 0;
        var _fileOpenObj = null;
        var _fileOpenMethod = null;
        var _fileOpenOrig = null;
        var _fileOpenGuardInterval = null;

        /** 探测 Typora 的 library.openFile (3 层回退) */
        function _btFindOpenFileFn() {
            try {
                if (typeof File !== "undefined" && File.editor && File.editor.library
                    && typeof File.editor.library.openFile === "function") {
                    return { obj: File.editor.library, method: "openFile" };
                }
            } catch (e) {}
            try {
                var keys = Object.keys(window);
                for (var i = 0; i < keys.length; i++) {
                    try {
                        var o = window[keys[i]];
                        if (o && o !== window && typeof o === "object"
                            && o.library && typeof o.library.openFile === "function") {
                            return { obj: o.library, method: "openFile" };
                        }
                    } catch (e) {}
                }
            } catch (e) {}
            try {
                var keys2 = Object.keys(window);
                for (var j = 0; j < keys2.length; j++) {
                    try {
                        var root = window[keys2[j]];
                        if (!root || root === window || typeof root !== "object") continue;
                        var subKeys = Object.keys(root);
                        for (var k = 0; k < subKeys.length; k++) {
                            try {
                                var child = root[subKeys[k]];
                                if (child && typeof child === "object"
                                    && child.library && typeof child.library.openFile === "function") {
                                    return { obj: child.library, method: "openFile" };
                                }
                            } catch (e) {}
                        }
                    } catch (e) {}
                }
            } catch (e) {}
            return null;
        }

        /** 安装 openFile 补丁 (幂等) */
        function _btInstallOpenFilePatch() {
            if (_fileOpenObj && _fileOpenMethod) return true;
            var found = _btFindOpenFileFn();
            if (!found) return false;
            _fileOpenObj = found.obj;
            _fileOpenMethod = found.method;
            _fileOpenOrig = _fileOpenObj[_fileOpenMethod];
            _fileOpenObj[_fileOpenMethod] = function (filePath) {
                var result = _fileOpenOrig.apply(this, arguments);
                if (filePath) {
                    var fp = String(filePath);
                    // 通知所有注册的回调
                    var copy = _fileOpenCallbacks.slice();
                    for (var c = 0; c < copy.length; c++) {
                        try { copy[c].fn(fp); } catch (e) {}
                    }
                }
                return result;
            };
            systemLogger.log("已安装 openFile 拦截");
            return true;
        }

        /** 卸载 openFile 补丁 */
        function _btUninstallOpenFilePatch() {
            if (_fileOpenObj && _fileOpenMethod && _fileOpenOrig) {
                _fileOpenObj[_fileOpenMethod] = _fileOpenOrig;
                _fileOpenObj = null;
                _fileOpenMethod = null;
                _fileOpenOrig = null;
            }
            if (_fileOpenGuardInterval) {
                clearInterval(_fileOpenGuardInterval);
                _fileOpenGuardInterval = null;
            }
        }

        /** 启动 openFile 补丁守护 (每 1.5s 检查，被 Typora 覆盖则重新注入) */
        function _btStartOpenFileGuard() {
            if (_fileOpenGuardInterval) return;
            _fileOpenGuardInterval = setInterval(function () {
                if (!_fileOpenObj || !_fileOpenMethod || !_fileOpenOrig) {
                    // 补丁丢失，尝试重装
                    _btInstallOpenFilePatch();
                    return;
                }
                // 检查补丁是否被覆盖
                if (_fileOpenObj[_fileOpenMethod] !== _fileOpenOrig
                    && !_isOurWrapper(_fileOpenObj[_fileOpenMethod])) {
                    systemLogger.log("openFile 补丁被覆盖，重新注入");
                    _fileOpenOrig = _fileOpenObj[_fileOpenMethod]; // 以当前函数为新的原始
                    _fileOpenObj[_fileOpenMethod] = function (filePath) {
                        var result = _fileOpenOrig.apply(this, arguments);
                        if (filePath) {
                            var fp = String(filePath);
                            var copy = _fileOpenCallbacks.slice();
                            for (var c = 0; c < copy.length; c++) {
                                try { copy[c].fn(fp); } catch (e) {}
                            }
                        }
                        return result;
                    };
                }
            }, 1500);
        }

        /** 判断函数是否是我们的包装器 (通过 toString 特征检测) */
        function _isOurWrapper(fn) {
            if (typeof fn !== "function") return false;
            var src = String(fn);
            return src.indexOf("_fileOpenCallbacks") !== -1 && src.indexOf("_fileOpenOrig") !== -1;
        }

        var _btOnFileOpen = function (callback) {
            if (typeof callback !== "function") return null;
            var id = ++_fileOpenNextId;
            _fileOpenCallbacks.push({ id: id, fn: callback });

            // 首个订阅者 → 安装补丁 + 启动守护
            if (_fileOpenCallbacks.length === 1) {
                if (_btInstallOpenFilePatch()) {
                    _btStartOpenFileGuard();
                } else {
                    // 补丁探测失败，稍后重试
                    var _retry = setInterval(function () {
                        if (_btInstallOpenFilePatch()) {
                            _btStartOpenFileGuard();
                            clearInterval(_retry);
                        }
                    }, 1000);
                    // 30s 后放弃
                    setTimeout(function () { try { clearInterval(_retry); } catch (e) {} }, 30000);
                }
            }

            // 返回取消订阅函数
            return function () {
                for (var i = 0; i < _fileOpenCallbacks.length; i++) {
                    if (_fileOpenCallbacks[i].id === id) {
                        _fileOpenCallbacks.splice(i, 1);
                        break;
                    }
                }
                // 无订阅者 → 卸载补丁 + 停止守护
                if (_fileOpenCallbacks.length === 0) {
                    _btUninstallOpenFilePatch();
                }
            };
        };

        var _btOffFileOpen = function (unsubFn) {
            if (typeof unsubFn === "function") unsubFn();
        };

        // ===================================================================
        // createTimerGroup — 插件定时器组 (disable 时自动清理)
        // ===================================================================
        var _btCreateTimerGroup = function () {
            var _tgTimers = [];
            var _closed = false;

            return {
                setTimeout: function (fn, delay) {
                    if (_closed) return -1;
                    var id = setTimeout(function () {
                        // 执行后从列表中移除
                        for (var t = 0; t < _tgTimers.length; t++) {
                            if (_tgTimers[t].ref === id) { _tgTimers.splice(t, 1); break; }
                        }
                        fn();
                    }, delay);
                    _tgTimers.push({ ref: id, type: "timeout" });
                    return id;
                },
                setInterval: function (fn, interval) {
                    if (_closed) return -1;
                    var id = setInterval(fn, interval);
                    _tgTimers.push({ ref: id, type: "interval" });
                    return id;
                },
                setImmediate: function (fn) {
                    return this.setTimeout(fn, 0);
                },
                delay: function (ms) {
                    return new Promise(function (resolve) {
                        if (_closed) { resolve(); return; }
                        var id = setTimeout(function () {
                            for (var t = 0; t < _tgTimers.length; t++) {
                                if (_tgTimers[t].ref === id) { _tgTimers.splice(t, 1); break; }
                            }
                            resolve();
                        }, ms);
                        _tgTimers.push({ ref: id, type: "timeout" });
                    });
                },
                clearTimeout: function (id) {
                    clearTimeout(id);
                    for (var t = _tgTimers.length - 1; t >= 0; t--) {
                        if (_tgTimers[t].ref === id) { _tgTimers.splice(t, 1); break; }
                    }
                },
                clearInterval: function (id) {
                    clearInterval(id);
                    for (var t = _tgTimers.length - 1; t >= 0; t--) {
                        if (_tgTimers[t].ref === id) { _tgTimers.splice(t, 1); break; }
                    }
                },
                clearAll: function () {
                    for (var t = 0; t < _tgTimers.length; t++) {
                        var item = _tgTimers[t];
                        try {
                            if (item.type === "interval") clearInterval(item.ref);
                            else clearTimeout(item.ref);
                        } catch (e) {}
                    }
                    _tgTimers = [];
                },
                close: function () {
                    _closed = true;
                    this.clearAll();
                },
                get count() { return _tgTimers.length; },
                get closed() { return _closed; }
            };
        };

        // 暴露全局 API
        window.BetterTypora = {
            events: eventBus,
            commands: commandRegistry,
            settings: settingsManager,
            hotkeys: hotkeyManager,
            manager: pluginManager,
            plugins: pluginManager._plugins,

            // 快捷方法
            getPlugin: function (id) { return pluginManager.get(id); },
            listPlugins: function () { return pluginManager.list(); },
            reloadPlugin: function (id) { return pluginManager.reload(id); },
            status: function () { return pluginManager.status(); },

            // File APIs
            saveFile: _btSaveFile,
            getCurrentFile: _btGetCurrentFile,
            getMountFolder: _btGetMountFolder,
            openFile: _btOpenFile,
            isDocumentEdited: _btIsDocumentEdited,

            // 工具
            escapeHtml: _btEscapeHtml,

            // 文件切换事件 (BetterTypora.onFileOpen/offFileOpen)
            onFileOpen: _btOnFileOpen,
            offFileOpen: _btOffFileOpen,

            // 定时器组 (BetterTypora.createTimerGroup())
            createTimerGroup: _btCreateTimerGroup,

            // Toast 通知 (BetterTypora.toast(message, duration))
            // 其他插件可直接用 BetterTypora.toast("消息") 不必各自实现
            // 多个 toast 向下堆叠，通过递归 _layout(i) 计算每个 toast 的偏移
            toast: (function () {
                var _baseCss = "position:fixed;top:60px;left:50%;z-index:99999;" +
                    "background:#2d2925;color:#faf9f5;padding:10px 24px;border-radius:8px;" +
                    "font-family:var(--font-sans,sans-serif);font-size:14px;" +
                    "box-shadow:0 4px 18px rgba(0,0,0,0.25);" +
                    "transition:opacity 0.35s ease,transform 0.35s ease;" +
                    "white-space:pre-line;opacity:0";
                var _stack = [];   // 当前存活的 toast 元素（从旧到新）
                var _gap = 8;      // toast 间距

                // 递归布局：从第 i 个 toast 开始向下排列
                function _layout(i) {
                    if (i >= _stack.length) return;              // base: 超出范围
                    var prevOffset = i === 0 ? 0 : _layout(i - 1); // recurse: 先算前面
                    var el = _stack[i];
                    el.style.transform = "translateX(-50%) translateY(" + prevOffset + "px)";
                    return prevOffset + (el.offsetHeight || 36) + _gap; // 返回自己的底部偏移
                }

                return function (message, duration) {
                    if (duration === undefined) duration = 1500;

                    var el = document.createElement("div");
                    el.style.cssText = _baseCss;
                    el.textContent = message;
                    document.body.appendChild(el);
                    _stack.push(el);

                    // 淡入
                    requestAnimationFrame(function () {
                        el.style.opacity = "1";
                        _layout(_stack.length - 1); // 只递归最后一个
                    });

                    // 定时移除
                    setTimeout(function () {
                        var idx = _stack.indexOf(el);
                        if (idx >= 0) _stack.splice(idx, 1);
                        el.style.opacity = "0";
                        setTimeout(function () {
                            if (el.parentNode) el.parentNode.removeChild(el);
                            // 从 idx 开始重新布局后续 toast
                            for (var k = idx; k < _stack.length; k++) {
                                _layout(k);
                            }
                        }, 350);
                    }, duration);
                };
            })(),
        };

        // 注册内建命令
        commandRegistry.register("plugin-system:status", function () {
            return pluginManager.status();
        }, "显示所有插件状态");

        commandRegistry.register("plugin-system:reload-all", function () {
            var ids = pluginManager.list();
            var ok = 0, fail = 0;
            for (var i = 0; i < ids.length; i++) {
                if (pluginManager.reload(ids[i])) ok++; else fail++;
            }
            // 重载反馈
            var msg = "🔄 插件重载完成: " + ok + " 成功";
            if (fail > 0) msg += ", " + fail + " 失败";
            if (ok === 0 && fail === 0) msg = "🔄 没有需要重载的插件";
            (window.BetterTypora || {}).toast && window.BetterTypora.toast(msg, 1500);
            // 刷新面板 (如果有)
            if (typeof window._btRefreshPluginPanel === "function") window._btRefreshPluginPanel();
            return pluginManager.status();
        }, "重载所有插件");

        // 发射初始化完成事件
        eventBus.emit("plugin-system:initialized", {
            events: eventBus,
            commands: commandRegistry,
            settings: settingsManager,
            hotkeys: hotkeyManager,
        });

        // 异步加载插件 + 菜单注入
        setTimeout(function () {
            pluginManager.loadAll();
            eventBus.emit("plugin-system:ready");
            systemLogger.log("初始化完成 ✅");
            // BetterTypora 加载完成 — 弹窗提示
            (window.BetterTypora || {}).toast && window.BetterTypora.toast(
                "🧩 BetterTypora 已就绪 (" + pluginManager.list().length + " 个插件)", 1500
            );

            // 菜单注入: 每 500ms 检查 megamenu 是否有我们的元素,
            // frame.js 可能随时重建 innerHTML, 需要持续守护
            var _injectMenu = function () {
                var menuList = document.getElementById("megamenu-menu-list");
                // 未就绪 或 已注入 → 稍后重试
                if (!menuList || !menuList.children.length || !menuList.children[0].nodeName ||
                    (document.getElementById("bettertypora-menu-divider") &&
                     document.getElementById("megamenu-section-plugins"))) {
                    setTimeout(_injectMenu, 500);
                    return;
                }

                // --- 1. 创建插件子页面 ---
                var section = document.createElement("div");
                section.className = "megamenu-section hide";
                section.id = "megamenu-section-plugins";
                section.innerHTML =
                    '<div class="megamenu-menu-panel">' +
                        '<h1>🧩 插件管理</h1>' +
                        '<div class="long-btn-wrap" id="bt-plugins-reload-all">' +
                            '<div class="long-btn"><span>🔄 重载所有插件</span></div>' +
                        '</div>' +
                        '<table class="table table-striped table-hover" style="margin-top:12px">' +
                            '<thead><tr><th width="32"></th><th width="20%">插件</th>' +
                            '<th width="10%">版本</th><th width="10%">状态</th><th>描述</th></tr></thead>' +
                            '<tbody id="bt-plugins-tbody"></tbody>' +
                        '</table>' +
                        '<p class="preference-item-hint" style="margin-top:16px" id="bt-plugins-count"></p>' +
                        '<div id="bt-plugins-empty" style="display:none;text-align:center;padding:40px 0;color:#999">' +
                            '<div style="font-size:48px;margin-bottom:12px">📦</div>' +
                            '<div>暂无已安装的插件</div>' +
                            '<div style="font-size:12px;margin-top:4px">将插件放入 resources/plugins/ 目录即可自动加载</div>' +
                        '</div>' +
                    '</div>';
                var content = document.getElementById("megamenu-content");
                if (content) content.appendChild(section);

                // "重载所有插件" 点击事件
                section.querySelector("#bt-plugins-reload-all").addEventListener("click", function () {
                    window.BetterTypora.commands.execute("plugin-system:reload-all");
                    _refreshPluginPanel();
                });

                // --- 2. 刷新面板内容的函数 ---
                var _refreshPluginPanel = function () {
                    var tbody = document.getElementById("bt-plugins-tbody");
                    var countEl = document.getElementById("bt-plugins-count");
                    var emptyEl = document.getElementById("bt-plugins-empty");
                    if (!tbody) return;
                    var pstatus = window.BetterTypora.status();
                    var _e = { enabled: "✅", disabled: "⏸", error: "❌" };
                    var _label = { enabled: "已启用", disabled: "已停用", error: "错误" };
                    var rows = "";
                    for (var i = 0; i < pstatus.length; i++) {
                        var p = pstatus[i];
                        rows +=
                            '<tr>' +
                                '<td style="text-align:center">' + (_e[p.state] || "ℹ") + '</td>' +
                                '<td>' + (p.name || p.id) + '</td>' +
                                '<td>' + (p.version || "") + '</td>' +
                                '<td>' + (_label[p.state] || p.state) + '</td>' +
                                '<td style="color:#999">' + (p.description || "") + '</td>' +
                            '</tr>';
                    }
                    tbody.innerHTML = rows;
                    countEl.textContent = pstatus.length ? "共 " + pstatus.length + " 个插件" : "";
                    if (emptyEl) emptyEl.style.display = pstatus.length ? "none" : "";
                };

                // --- 3. 菜单项: 插入到 "关闭" 之前 ---
                var closeLi = null;
                var closeAnchor = document.getElementById("m-close");
                if (closeAnchor) closeLi = closeAnchor.parentNode;
                // Close 前面的原始 divider（如果有的话）
                var beforeDivider = closeLi ? closeLi.previousElementSibling : null;
                var hasOriginalDivider = beforeDivider && beforeDivider.classList.contains("divider");

                var divider = document.createElement("li");
                divider.id = "bettertypora-menu-divider";
                divider.className = "divider";

                var item = document.createElement("li");
                var link = document.createElement("a");
                link.role = "menuitem";
                link.id = "m-plugins";
                link.innerHTML = '<i class="fa fa-puzzle-piece"></i><span>插件</span>';
                link.addEventListener("click", function () {
                    // 模仿 frame.js e() 的面板切换逻辑
                    var sections = document.querySelectorAll("#megamenu-content > .megamenu-section");
                    for (var s = 0; s < sections.length; s++) sections[s].classList.add("hide");
                    var pluginSection = document.getElementById("megamenu-section-plugins");
                    if (pluginSection) pluginSection.classList.remove("hide");
                    var allLinks = document.querySelectorAll("#megamenu-menu-list a");
                    for (var a = 0; a < allLinks.length; a++) allLinks[a].classList.remove("active");
                    this.classList.add("active");
                    _refreshPluginPanel();
                    // 弹窗提示
                    var count = (window.BetterTypora.status() || []).length;
                    window.BetterTypora.toast("🧩 已显示插件状态 (" + count + " 个)", 1500);
                });
                item.appendChild(link);

                if (closeLi) {
                    if (hasOriginalDivider) {
                        // 删除 Typora 原来的 divider (Close之前那个),
                        // 用 ours 替换 — 保持菜单结构干净
                        beforeDivider.parentNode.removeChild(beforeDivider);
                    }
                    menuList.insertBefore(divider, closeLi);
                    menuList.insertBefore(item, closeLi);
                } else {
                    menuList.appendChild(divider);
                    menuList.appendChild(item);
                }

                // 暴露刷新函数供外部调用（如 reload-all 后自动刷新）
                window._btRefreshPluginPanel = _refreshPluginPanel;

                // 持续守护: 500ms 后再次检查, 元素被清除则重新注入
                setTimeout(_injectMenu, 500);
            };
            _injectMenu();
        }, 0);

        // 输出快速开始指南
        var _c = console.log, _bold = "font-weight:bold;color:#d97757;", _dim = "color:#888;";
        _c("%c🧩 BetterTypora %c已就绪", _bold, "");
        _c("%c  BetterTypora.status()  %c→ 查看插件状态", _dim, "");
        _c("%c  BetterTypora.commands.list() %c→ 列出命令", _dim, "");
        _c("%c  BetterTypora.reloadPlugin('id') %c→ 热重载插件", _dim, "");
    }

    // --- 启动 ---
    bootstrap();
})();
