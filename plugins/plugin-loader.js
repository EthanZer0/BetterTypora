/**
 * Typora Plugin System — Core Bootloader
 * ========================================
 * 注入方式: 由 window.html 在 </body> 前以 <script src="./plugins/plugin-loader.js">
 *           加载到渲染进程 (无需修改 launch.dist.js / app.asar)
 * 运行环境: Electron 渲染进程 (有 DOM, 有 reqnode)
 * 全局出口: window.BetterTypora
 *
 * 目录结构:
 *   resources/plugins/              ← 插件根目录
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
    var url = reqnode("url");
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
            // 通用文件事件 (与 window.BetterTypora 保持一致)
            onFileEvent: window.BetterTypora.onFileEvent,
            offFileEvent: window.BetterTypora.offFileEvent,
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
    // ThemeService — 主题特征检测与切换事件 (BetterTypora.theme)
    // ===================================================================
    // 目标: 让插件感知"当前主题长什么样", 而非"当前主题叫什么名字"。
    // 特征驱动 (对应 README 附录 A): 侧边栏标签栏是否被胶囊化、是否亮/暗、
    // 滑块档位等, 全部通过 getComputedStyle 实测得出, 不硬编码主题名。
    //
    // 典型用法 (反链插件):
    //   var theme = BetterTypora.theme;
    //   if (theme.getSidebarTabsMode() === "capsule") { /* 胶囊适配 */ }
    //   theme.onChange(function(p){ /* 主题切换后重跑适配 */ });
    function ThemeService() {
        var listeners = [];
        var _timer = null;
        var _lastFp = null;
        var self = this;

        /** 解析颜色字符串亮度 (ITU-R BT.601), 返回 0..1; 未知颜色取 0.5 */
        function _luminance(colorStr) {
            if (!colorStr) return 0.5;
            var r = 0, g = 0, b = 0;
            var hex = colorStr.match(/#([0-9a-fA-F]{3,8})/);
            if (hex) {
                var h = hex[1];
                if (h.length >= 6) {
                    r = parseInt(h.substr(0, 2), 16);
                    g = parseInt(h.substr(2, 2), 16);
                    b = parseInt(h.substr(4, 2), 16);
                } else {
                    r = parseInt(h[0] + h[0], 16);
                    g = parseInt(h[1] + h[1], 16);
                    b = parseInt(h[2] + h[2], 16);
                }
            } else {
                var rgb = colorStr.match(/rgba?\(([^)]+)\)/);
                if (rgb) {
                    var parts = rgb[1].split(",");
                    r = parseFloat(parts[0]) || 0;
                    g = parseFloat(parts[1]) || 0;
                    b = parseFloat(parts[2]) || 0;
                } else {
                    return 0.5;
                }
            }
            return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
        }

        /** 解析 matrix 的 translateX 值 (第 5 个参数); 无平移返回 null */
        function _translateXOf(transform) {
            if (!transform || transform === "none") return null;
            var m = transform.match(/matrix\(\s*([^)]+)\)/);
            if (!m) return null;
            var nums = m[1].split(",").map(function (s) { return parseFloat(s.trim()); });
            if (nums.length >= 5 && !isNaN(nums[4])) return nums[4];
            return null;
        }

        /** 当前是否暗色主题 (读 --bg-color 亮度, 不依赖 OS 设置) */
        this.isDark = function () {
            var bg = getComputedStyle(document.documentElement)
                .getPropertyValue("--bg-color").trim();
            return _luminance(bg) < 0.5;
        };

        /**
         * 侧边栏标签栏形态:
         *   "capsule" — 胶囊化标签栏 (圆角≥半高 + 伪元素滑块指示), 如 Claude 主题
         *   "default" — 默认平铺标签栏 (GitHub / 原生样式)
         *   null      — 侧边栏标签栏不存在
         */
        this.getSidebarTabsMode = function () {
            var w = document.querySelector(".info-panel-tab-wrapper");
            if (!w) return null;
            var cs = getComputedStyle(w);
            var br = parseFloat(cs.borderRadius) || 0;
            var h = w.offsetHeight || parseFloat(cs.height) || 0;
            if (br > 6 && h > 0 && br >= h / 2) return "capsule";
            return "default";
        };

        /**
         * 胶囊滑块档位: 临时为 sidebar 逐个加上候选激活态类,
         * 读 wrapper::before 的 translateX, 还原后返回 { 类名: 位移px }。
         * 让插件"自动知道这个主题的滑块有几档、每档偏移多少", 无需硬编码坐标。
         */
        this.getSidebarTabSlots = function () {
            var sidebar = document.getElementById("typora-sidebar");
            var w = document.querySelector(".info-panel-tab-wrapper");
            if (!sidebar || !w) return {};
            var candidates = [
                "active-tab-files", "active-tab-outline",
                "ty-show-search", "active-tab-backlinks",
            ];
            var slots = {};
            var prevCls = sidebar.className;
            for (var i = 0; i < candidates.length; i++) {
                (function (cls) {
                    try {
                        sidebar.classList.add(cls);
                        var tx = _translateXOf(getComputedStyle(w, "::before").transform);
                        if (tx !== null) slots[cls] = tx;
                    } catch (e) {}
                })(candidates[i]);
            }
            sidebar.className = prevCls;
            return slots;
        };

        /** 主题指纹: 亮暗 + 核心 CSS 变量 + 标签栏形态, 任一变化即视为主题切换 */
        function _fingerprint() {
            var cs = getComputedStyle(document.documentElement);
            return (self.isDark() ? "d" : "l") + "|" +
                cs.getPropertyValue("--bg-color").trim() + "|" +
                cs.getPropertyValue("--text-color").trim() + "|" +
                cs.getPropertyValue("--active-file-text-color").trim() + "|" +
                (self.getSidebarTabsMode() || "");
        }

        function _notify() {
            var payload = {
                isDark: self.isDark(),
                sidebarTabsMode: self.getSidebarTabsMode(),
                slots: self.getSidebarTabSlots(),
            };
            for (var i = 0; i < listeners.length; i++) {
                try { listeners[i](payload); } catch (e) {}
            }
        }

        function _poll() {
            var fp = _fingerprint();
            if (_lastFp === null) { _lastFp = fp; return; }
            if (fp !== _lastFp) { _lastFp = fp; _notify(); }
        }

        /** 订阅主题切换; 有订阅者才启动 800ms 指纹轮询; 返回解绑函数 */
        this.onChange = function (fn) {
            if (typeof fn !== "function") return null;
            listeners.push(fn);
            if (!_timer) {
                _lastFp = _fingerprint();
                _timer = setInterval(function () { try { _poll(); } catch (e) {} }, 800);
            }
            return function () { self.offChange(fn); };
        };

        this.offChange = function (fn) {
            var i = listeners.indexOf(fn);
            if (i >= 0) listeners.splice(i, 1);
            if (listeners.length === 0 && _timer) {
                clearInterval(_timer);
                _timer = null;
            }
        };
    }

    // ===================================================================
    // PreferencePanelBridge — 偏好设置"插件"栏目 (webview 注入)
    // ===================================================================
    // Typora 偏好设置是独立 webview (page-dist/setting.html, React 应用)。
    // 通过 webview.executeJavaScript 注入"插件"栏目:
    //   侧边栏 .list-group-content 追加 nav-group-item, .pane 追加 content 面板
    // 通信: 主文档 webviewEl.send() → webview ipcRenderer.on() (数据推送)
    //       webview ipcRenderer.send() → 主文档 webviewEl 'ipc-message' (操作请求)
    // 面板复用 setting 页面样式类 (.panel-header/.input-group/table), 自动主题适配

    var _prefWebview = null;       // 偏好设置 webview 元素
    var _prefInjected = false;     // 注入标记
    var _prefWatchTimer = null;    // webview 出现轮询

    /** webview 内执行的注入代码 */
    var BT_PREF_INJECT_JS = [
        "(function(){",
        "  if (window.__btPrefInjected) return;",   // 幂等: 重复注入不再叠加监听/委托/定时器
        "  window.__btPrefInjected = true;",
        "  var NAV_ID = 'bt-pref-nav-plugins';",
        "  var PANEL_ID = 'bt-pref-panel-plugins';",
        "  function sendToHost(ch, data){ try { require('electron').ipcRenderer.sendToHost(ch, data); } catch (e) {} }",
        "  function ensureUI(){",
        "    if (document.getElementById(NAV_ID)) return true;",
        "    var sidebar = document.querySelector('.list-group-content');",
        "    var pane = document.querySelector('.pane');",
        "    if (!sidebar || !pane) return false;",
        "    var nav = document.createElement('span');",
        "    nav.id = NAV_ID;",
        "    nav.className = 'nav-group-item';",
        "    nav.setAttribute('data-index', 'bt-plugins');",
        "    nav.textContent = '插件';",
        "    sidebar.appendChild(nav);",
        "    var panel = document.createElement('div');",
        "    panel.id = PANEL_ID;",
        "    panel.className = 'content';",
        "    panel.setAttribute('data-index', 'bt-plugins');",
        "    panel.style.display = 'none';",
        "    panel.innerHTML =",
        "      '<style>' +",
        "        '.bt-plugin-list { margin-top: 8px; }' +",
        "        '.bt-plugin-row { display: flex; align-items: center; gap: 10px; padding: 8px 12px; border-radius: 6px; transition: background 0.15s ease; }' +",
        "        '.bt-plugin-row:hover { background: rgba(128,128,128,0.08); }' +",
        "        '.bt-switch { position: relative; display: inline-block; width: 34px; height: 20px; flex-shrink: 0; }' +",
        "        '.bt-switch input { opacity: 0; width: 0; height: 0; position: absolute; }' +",
        "        '.bt-switch-track { position: absolute; inset: 0; border-radius: 10px; background: rgba(128,128,128,0.3); transition: background 0.18s ease; cursor: pointer; }' +",
        "        '.bt-switch-track:before { content: \\'\\'; position: absolute; width: 14px; height: 14px; border-radius: 50%; left: 3px; top: 3px; background: #fff; box-shadow: 0 1px 3px rgba(0,0,0,0.3); transition: transform 0.18s ease; }' +",
        "        '.bt-switch input:checked + .bt-switch-track { background: var(--active-file-text-color, rgba(76,175,80,0.85)); }' +",
        "        '.bt-switch input:checked + .bt-switch-track:before { transform: translateX(14px); }' +",
        "        '.bt-switch input:disabled + .bt-switch-track { opacity: 0.5; }' +",
        "        '.bt-plugin-name { font-weight: 600; white-space: nowrap; }' +",
        "        '.bt-plugin-version { font-size: 12px; opacity: 0.5; white-space: nowrap; }' +",
        "        '.bt-plugin-desc { flex: 1; min-width: 0; font-size: 12px; opacity: 0.6; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }' +",
        "        '.bt-reload-btn { border: none; background: transparent; color: var(--text-color, #333); opacity: 0.6; font-size: 12px; padding: 3px 8px; border-radius: 6px; cursor: pointer; transition: background 0.15s ease, opacity 0.15s ease; }' +",
        "        '.bt-reload-btn:hover { background: rgba(128,128,128,0.12); opacity: 1; }' +",
        "        '.bt-reload-btn:disabled { opacity: 0.35; cursor: default; }' +",
        "      '</style>' +",
        "      '<h3 class=\\'panel-header\\'>插件</h3>' +",
        "      '<div class=\\'bt-plugin-list\\' id=\\'bt-pref-plugins-list\\'></div>' +",
        "      '<p style=\\'margin-top:8px;color:rgba(128,128,128,0.6);font-size:12px\\'>插件目录: resources/plugins/</p>';",
        "    pane.appendChild(panel);",
        "    nav.addEventListener('click', function(){",
        "      var cs = document.querySelectorAll('.content');",
        "      for (var i = 0; i < cs.length; i++) {",
        "        if (cs[i].id !== PANEL_ID) cs[i].style.display = 'none';",
        "      }",
        "      panel.classList.remove('display-none');",
        "      panel.style.display = '';",
        "      var ns = document.querySelectorAll('.nav-group-item');",
        "      for (var j = 0; j < ns.length; j++) ns[j].classList.remove('active');",
        "      nav.classList.add('active');",
        "    });",
        "    var ns2 = document.querySelectorAll('.nav-group-item');",
        "    for (var k = 0; k < ns2.length; k++) {",
        "      if (ns2[k].id !== NAV_ID) {",
        "        ns2[k].addEventListener('click', function(){",
        "          var cs3 = document.querySelectorAll('.content');",
        "          for (var m = 0; m < cs3.length; m++) {",
        "            if (cs3[m].id !== PANEL_ID) cs3[m].style.display = '';",
        "          }",
        "          panel.style.display = 'none';",
        "          nav.classList.remove('active');",
        "        });",
        "      }",
        "    }",
        "    return true;",
        "  }",
        "  function buildRowHTML(p){",
        "    var checked = p.state === 'enabled' ? 'checked' : '';",
        "    var errMark = p.state === 'error' ? ' <span class=\\'bt-plugin-err\\' style=\\'color:rgba(229,57,53,0.9);font-size:11px\\'>错误</span>' : '';",
        "    return '<div class=\\'bt-plugin-row\\' data-id=\\'' + p.id + '\\'>' +",
        "        '<label class=\\'bt-switch\\'><input type=\\'checkbox\\' data-id=\\'' + p.id + '\\' data-action=\\'toggle\\' ' + checked + '><span class=\\'bt-switch-track\\'></span></label>' +",
        "        '<span class=\\'bt-plugin-name\\'>' + (p.name || p.id) + '</span>' +",
        "        '<span class=\\'bt-plugin-version\\'>v' + (p.version || '') + '</span>' + errMark +",
        "        '<span class=\\'bt-plugin-desc\\'>' + (p.description || '') + '</span>' +",
        "        '<button class=\\'bt-reload-btn\\' data-id=\\'' + p.id + '\\'>重载</button>' +",
        "      '</div>';",
        "  }",
        "  function render(data){",
        "    if (!ensureUI()) return;",
        "    var list = document.getElementById('bt-pref-plugins-list');",
        "    if (!list) return;",
        "    var plugins = (data && data.plugins) || [];",
        "    var html = plugins.map(buildRowHTML).join('');",
        "    if (!html) html = '<div style=\\'padding:20px;text-align:center;color:rgba(128,128,128,0.6);font-size:13px\\'>暂无已安装的插件</div>';",
        "    // 全量重建 (简单直观); 仅 HTML 实际变化时写入, 避免保底推送打断 hover",
        "    if (list.innerHTML !== html) list.innerHTML = html;",
        "  }",
        "  document.addEventListener('click', function(e){",
        "    if (!e.isTrusted) return;  // 忽略程序化事件 (render 更新/脚本触发), 免疫反馈循环",
        "    // 开关: 用 click 而非 change — 程序化 checked 赋值不会触发真实 click",
        "    var sw = e.target && e.target.closest ? e.target.closest('.bt-switch') : null;",
        "    if (sw) {",
        "      var input = sw.querySelector('input');",
        "      var id = input ? input.getAttribute('data-id') : null;",
        "      if (id) {",
        "        input.disabled = true;",
        "        sendToHost('bettertypora:plugins-action', { action: 'toggle', id: id });",
        "        return;",
        "      }",
        "    }",
        "    var btn = e.target && e.target.closest ? e.target.closest('.bt-reload-btn') : null;",
        "    if (btn) {",
        "      btn.disabled = true;",
        "      btn.textContent = '重载中…';",
        "      sendToHost('bettertypora:plugins-action', { action: 'reload', id: btn.getAttribute('data-id') });",
        "    }",
        "  });",
        "  window.__btPref = { render: render, ensureUI: ensureUI };",
        "  // 监听主文档推送 (注入时 require 已就绪, 直接同步注册)",
        "  try {",
        "    if (window.require && window.require('electron') && window.require('electron').ipcRenderer) {",
        "      window.require('electron').ipcRenderer.on('bettertypora:plugins', function(evt, data){ render(data); });",
        "    }",
        "  } catch (e) {}",
        "  // UI 就绪后请求一次初始数据 (数据流: 请求 → 主文档推送 → render)",
        "  (function retry(){",
        "    if (ensureUI()) { sendToHost('bettertypora:plugins-request', {}); }",
        "    else { setTimeout(retry, 300); }",
        "  })();",
        "})();"
    ].join("\n");

    /** 当前插件状态快照 (供偏好设置面板显示) */
    function _btPrefGetData() {
        var mgr = window.BetterTypora && window.BetterTypora.manager;
        return { plugins: mgr ? mgr.status() : [] };
    }

    /** 向 webview 注入栏目代码并推送初始数据 (延迟 + 重试, 等 webview IPC 通道就绪) */
    function _btPrefInject(wv) {
        _prefInjected = true;
        wv.executeJavaScript(BT_PREF_INJECT_JS).then(function () {
            systemLogger.log("偏好设置「插件」栏目已注入");
            var tries = 0;
            var push = function () {
                try {
                    if (wv.send) wv.send("bettertypora:plugins", _btPrefGetData());
                } catch (e) {}
                tries++;
                if (tries < 5) setTimeout(push, 800);
            };
            setTimeout(push, 500);
        }).catch(function (e) {
            systemLogger.warn("偏好设置注入失败:", e.message);
            _prefInjected = false;   // 失败允许重试
        });
    }

    /** 处理 webview 内的操作请求 */
    function _btPrefHandleAction(msg) {
        var mgr = window.BetterTypora && window.BetterTypora.manager;
        if (!mgr || !msg || !msg.id) return;
        if (msg.action === "toggle") {
            var p = mgr.get(msg.id);
            if (!p) return;
            if (p.state === "enabled") {
                mgr.disable(msg.id);
            } else {
                mgr.enable(msg.id);
            }
        } else if (msg.action === "reload") {
            mgr.reload(msg.id);
        }
        // 操作后推送更新
        if (_prefWebview && _prefWebview.send) {
            _prefWebview.send("bettertypora:plugins", _btPrefGetData());
        }
    }

    /** 绑定 webview 事件 (注入 + 双向通信) */
    function _btPrefSetupWebview(wv) {
        var isNew = _prefWebview !== wv;
        if (isNew) {
            _prefWebview = wv;
            // 仅新 webview 重置注入标记; 同一 webview 每秒轮询不得重复注入
            _prefInjected = false;
            wv.addEventListener("dom-ready", function () {
                if (!_prefInjected) _btPrefInject(wv);
            });
            wv.addEventListener("ipc-message", function (e) {
                if (e.channel === "bettertypora:plugins-action") {
                    _btPrefHandleAction(e.args && e.args[0]);
                } else if (e.channel === "bettertypora:plugins-request") {
                    // webview 主动请求数据 (初始推送丢失时保底刷新)
                    if (_prefWebview && _prefWebview.send) {
                        _prefWebview.send("bettertypora:plugins", _btPrefGetData());
                    }
                }
            });
        }
        // 同一 webview 已注入 → 直接返回, 防止重复注入叠加监听/委托
        if (_prefInjected) return;
        // webview 已就绪 (dom-ready 已过) 且未注入 → 直接注入, 不依赖事件时机
        wv.executeJavaScript("1").then(function () {
            if (!_prefInjected) _btPrefInject(wv);
        }).catch(function () {
            // 未就绪: 等待 dom-ready 或下轮轮询
        });
    }

    /** 轮询偏好设置 webview (首次创建或元素重建时绑定) */
    function _btWatchPreferencePanel() {
        if (_prefWatchTimer) return;
        _prefWatchTimer = setInterval(function () {
            try {
                var wv = document.querySelector("#uni-preference-panel-view");
                if (wv) {
                    _btPrefSetupWebview(wv);
                }
            } catch (e) {}
        }, 1000);
    }

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
        // FileEventHub v2 — 统一文件事件系统
        // ===================================================================
        // 基于 Typora 原生接口的多数据源捕获 (替代旧版 library.openFile 单点补丁):
        //   A. hook File.loadFile         — 渲染进程加载入口 → opening
        //   B. hook File.onFileOpened     — 渲染进程加载完成回调 → opened
        //   C. hook File.setDocumentState — 主进程文档状态推送 (关联文件/拖拽/新建) → opened
        //   D. 包装 JSBridge.invoke       — 主进程调用观测 (app.openFile / app.onCloseWin / switchToUntitled)
        //   E. 轮询 File.bundle.filePath  — 兜底 (外部删除 deleted / 改名 renamed)
        //
        // 事件:
        //   opening  {path, isNew, untitled}      — 文件将被打开/切换 (意图)
        //   opened   {path, previousPath, bundle} — 文件真正打开完成 (bundle 已就绪)
        //   closing  {path, mountFolder}          — 窗口关闭前
        //   deleted  {path, originalPath}         — 当前文件被外部删除 (bundle.filePath 已清空)
        //   renamed  {path, previousPath}         — 文件路径变更 (重命名/另存为)
        //
        // 兼容旧接口: onFileOpen(fn) / offFileOpen(unsub) — fn(filePath),
        //            仅在 opened 且路径非空时触发

        var _fileOpenCallbacks = [];       // [{id, fn}] 旧接口回调
        var _fileOpenNextId = 0;
        var _fileEvents = {};              // type -> [fn]
        var _lastOpenedPath = null;
        var _lastOpenedTime = 0;
        var _fileHooks = {};               // {loadFile, onFileOpened, setDocumentState} -> 原函数
        var _jsBridgeWrapped = false;
        var _fileHookGuard = null;
        var _pollTimer = null;
        var _lastBundlePath = null;
        var _lastBundleObj = null;
        var _pollBaselineReady = false;

        /** 事件分发: type 事件 + opened 兼容旧 onFileOpen 回调 */
        function _emitFileEvent(type, data) {
            var list = _fileEvents[type];
            if (list) {
                var copy = list.slice();
                for (var i = 0; i < copy.length; i++) {
                    try { copy[i](data); } catch (e) {
                        systemLogger.warn("file event '" + type + "' handler:", e);
                    }
                }
            }
            if (type === "opened") {
                var fp = data.path || null;
                if (fp) {
                    var copy2 = _fileOpenCallbacks.slice();
                    for (var j = 0; j < copy2.length; j++) {
                        try { copy2[j].fn(fp); } catch (e) {}
                    }
                }
            }
        }

        /** opened 事件 (500ms 同路径去重, 防 setDocumentState 与 onFileOpened 双触发) */
        function _emitOpened(path, previousPath) {
            var now = Date.now();
            if (path === _lastOpenedPath && now - _lastOpenedTime < 500) return;
            _lastOpenedPath = path;
            _lastOpenedTime = now;
            var bundle = null;
            try { if (typeof File !== "undefined" && File.bundle) bundle = File.bundle; } catch (e) {}
            _emitFileEvent("opened", { path: path || null, previousPath: previousPath || null, bundle: bundle });
        }

        /** 安装 File hook (幂等), 返回 true 表示 3 个 hook 全部就位 */
        function _btInstallFileHooks() {
            if (typeof File === "undefined") return false;
            var installed = 0;

            if (!_fileHooks.loadFile && typeof File.loadFile === "function") {
                var origLoad = File.loadFile;
                _fileHooks.loadFile = origLoad;
                File.loadFile = function (filePath) {
                    var prev = null;
                    try { prev = (File.bundle && File.bundle.filePath) || null; } catch (e) {}
                    try { _emitFileEvent("opening", { path: filePath || null, previousPath: prev }); } catch (e) {}
                    return origLoad.apply(this, arguments);
                };
                installed++;
            }
            if (!_fileHooks.onFileOpened && typeof File.onFileOpened === "function") {
                var origOpened = File.onFileOpened;
                _fileHooks.onFileOpened = origOpened;
                File.onFileOpened = function () {
                    var prev = _lastOpenedPath;
                    var result = origOpened.apply(this, arguments);
                    try { _emitOpened((File.bundle && File.bundle.filePath) || null, prev); } catch (e) {}
                    return result;
                };
                installed++;
            }
            if (!_fileHooks.setDocumentState && typeof File.setDocumentState === "function") {
                var origSetState = File.setDocumentState;
                _fileHooks.setDocumentState = origSetState;
                File.setDocumentState = function (state) {
                    var prev = null;
                    try { prev = (File.bundle && File.bundle.filePath) || null; } catch (e) {}
                    var result = origSetState.apply(this, arguments);
                    try { _emitOpened((File.bundle && File.bundle.filePath) || null, prev); } catch (e) {}
                    return result;
                };
                installed++;
            }
            if (installed > 0) systemLogger.log("文件事件 hook 已安装 (" + installed + " 个)");
            return installed === 3;
        }

        /** 包装 JSBridge.invoke — 观测主进程调用 (幂等) */
        function _btWrapJSBridge() {
            if (_jsBridgeWrapped) return true;
            if (typeof JSBridge === "undefined" || typeof JSBridge.invoke !== "function") return false;
            var origInvoke = JSBridge.invoke;
            JSBridge.invoke = function (channel) {
                var args = Array.prototype.slice.call(arguments, 1);
                try {
                    if (channel === "app.openFile") {
                        _emitFileEvent("opening", { path: null, isNew: true });
                    } else if (channel === "document.switchToUntitled") {
                        _emitFileEvent("opening", { path: null, isNew: true, untitled: true });
                    } else if (channel === "app.onCloseWin") {
                        var p = null, m = null;
                        try { p = (File && File.bundle && File.bundle.filePath) || null; } catch (e) {}
                        m = args[0] || null;
                        _emitFileEvent("closing", { path: p, mountFolder: m });
                    }
                } catch (e) {}
                return origInvoke.apply(this, arguments);
            };
            _jsBridgeWrapped = true;
            systemLogger.log("已包装 JSBridge.invoke");
            return true;
        }

        /** bundle 轮询兜底 (500ms) — 捕获外部删除/改名等 hook 覆盖不到的路径
         *  区分逻辑: 打开/切换会重建 bundle 对象 (引用变化) → opened
         *           重命名/另存为只改 bundle.filePath (引用不变) → renamed
         *           有路径 → 无路径 (引用变或不变) → deleted */
        function _btStartBundlePoll() {
            if (_pollTimer) return;
            _pollTimer = setInterval(function () {
                try {
                    if (typeof File === "undefined" || !File.bundle) return;
                    var p = File.bundle.filePath || null;
                    if (!_pollBaselineReady) {
                        _pollBaselineReady = true;
                        _lastBundlePath = p;
                        _lastBundleObj = File.bundle;
                        return;
                    }
                    var prev = _lastBundlePath;
                    var bundleChanged = File.bundle !== _lastBundleObj;
                    _lastBundlePath = p;
                    _lastBundleObj = File.bundle;
                    if (p === prev) return;
                    if (prev && !p) {
                        var orig = File.bundle.originalPath || prev;
                        _emitFileEvent("deleted", { path: null, originalPath: orig });
                    } else if (!prev && p) {
                        _emitOpened(p, null);
                    } else if (prev && p) {
                        if (bundleChanged) {
                            // 打开/切换新文档
                            _emitOpened(p, prev);
                        } else {
                            // 同一文档路径变更 (重命名/另存为)
                            _emitFileEvent("renamed", { path: p, previousPath: prev });
                        }
                    }
                } catch (e) {}
            }, 500);
        }

        /** 守护: 每 1s 检查 File/JSBridge 就绪并安装 (安装完成后自停) */
        function _btStartFileHookGuard() {
            if (_fileHookGuard) return;
            _fileHookGuard = setInterval(function () {
                try {
                    if (typeof File === "undefined") return;
                    _btInstallFileHooks();
                    _btWrapJSBridge();
                    _btStartBundlePoll();
                    if (_fileHooks.loadFile && _fileHooks.onFileOpened
                        && _fileHooks.setDocumentState && _jsBridgeWrapped) {
                        clearInterval(_fileHookGuard);
                        _fileHookGuard = null;
                        systemLogger.log("文件事件系统就绪 ✅");
                    }
                } catch (e) {}
            }, 1000);
        }

        // ---- 公共接口 ----

        /** onFileOpen(fn) — 兼容旧接口, fn(filePath), 仅在文件真正打开完成且有路径时触发 */
        var _btOnFileOpen = function (callback) {
            if (typeof callback !== "function") return null;
            var id = ++_fileOpenNextId;
            _fileOpenCallbacks.push({ id: id, fn: callback });
            _btStartFileHookGuard();
            return function () {
                for (var i = 0; i < _fileOpenCallbacks.length; i++) {
                    if (_fileOpenCallbacks[i].id === id) {
                        _fileOpenCallbacks.splice(i, 1);
                        break;
                    }
                }
            };
        };

        var _btOffFileOpen = function (unsubFn) {
            if (typeof unsubFn === "function") unsubFn();
        };

        /** onFileEvent(type, fn) — 通用文件事件订阅, 返回取消订阅函数 */
        var _btOnFileEvent = function (type, callback) {
            if (!type || typeof callback !== "function") return null;
            if (!_fileEvents[type]) _fileEvents[type] = [];
            _fileEvents[type].push(callback);
            _btStartFileHookGuard();
            return function () {
                var list = _fileEvents[type];
                if (!list) return;
                for (var i = 0; i < list.length; i++) {
                    if (list[i] === callback) {
                        list.splice(i, 1);
                        break;
                    }
                }
            };
        };

        var _btOffFileEvent = function (unsubFn) {
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

        // 主题特征服务 (BetterTypora.theme): isDark/getSidebarTabsMode/getSidebarTabSlots/onChange
        var themeService = new ThemeService();

        // =================================================================
        // Markdown 渲染服务 (BetterTypora.markdown)
        // 复用 Typora 内部解析器 (nodeMap 节点类的静态 parseFrom), 产出与
        // 编辑器完全一致的 DOM。验证自 typora-render-probe 探针:
        //   - 入口: File.editor.nodeMap.allNodes.first().__proto__.constructor
        //   - Ctor.parseFrom(md) → [html, nodes] (静态方法, 参数即 markdown)
        //   - 无副作用 (write DOM / nodeMap 计数不变)
        // 若解析器不可用 (Typora 升级变动), parse/renderTo 返回 null/false,
        // 调用方 (如 split-view) 可降级到自有渲染器。
        // =================================================================
        var markdownService = (function () {
            var _ctor = null;
            var _ctorTried = false;
            var _lastError = null;
            var _cmSeq = 0;   // CodeMirror 实例唯一 id

            function getCtor() {
                if (_ctorTried) return _ctor;
                _ctorTried = true;
                try {
                    var allNodes = File.editor.nodeMap.allNodes;
                    var first = allNodes.first();
                    var C = first.__proto__.constructor;
                    if (typeof C.parseFrom === "function") {
                        _ctor = C;
                    }
                } catch (e) {
                    _lastError = e.message;
                }
                return _ctor;
            }

            /** markdown → Typora 原生 HTML (null 表示解析器不可用/失败) */
            function parse(md) {
                var C = getCtor();
                if (!C) return null;
                try {
                    var text = String(md == null ? "" : md);
                    // 去 BOM (Windows UTF-8 文件头) — 否则 ^--- 正则不匹配
                    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
                    // front matter (--- 元数据块) 由 Typora 顶层逻辑渲染成
                    // md-meta-block — parseFrom 是节点解析器不识别它,
                    // 需先剥离单独渲染, 再解析正文 (参照 typora-community-plugin)
                    var frontMatter = null;
                    var content = text;
                    var m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
                    if (m) {
                        frontMatter = m[1];
                        content = text.slice(m[0].length);
                        // 去前导空行 — parseFrom 对前导 \n 可能返回非数组
                        content = content.replace(/^\r?\n+/, "");
                    }
                    var r = C.parseFrom(content);
                    if (!Array.isArray(r)) {
                        _lastError = "parseFrom 非数组返回: " +
                            (r === null ? "null" : typeof r);
                        return null;
                    }
                    var html = String(r[0]);
                    if (html === null) return null;
                    if (frontMatter !== null) {
                        html = '<pre mdtype="meta_block" class="md-meta-block md-end-block">' +
                            _btEscapeHtml(frontMatter) + "</pre>" + html;
                    }
                    return html;
                } catch (e) {
                    _lastError = e.message;
                    return null;
                }
            }

            /** 解析器输出的路径是 URL 编码 (中文 → %E6...), 需解码;
             *  文件名本身含 % 时 decode 抛错, 保留原样 */
            function decodePath(s) {
                try {
                    return decodeURIComponent(s);
                } catch (e) {
                    return s;
                }
            }

            /**
             * 渲染到容器。options:
             *   baseDir: 相对图片/链接解析基准目录
             * @returns {boolean} 是否成功
             */
            function renderTo(container, md, options) {
                options = options || {};
                if (!container) return false;
                var html = parse(md);
                if (html === null) return false;
                container.innerHTML = html;

                // 预览容器禁编辑 (Typora 输出 contenteditable="true")
                var edits = container.querySelectorAll('[contenteditable="true"]');
                for (var i = 0; i < edits.length; i++) {
                    edits[i].setAttribute("contenteditable", "false");
                }

                // 图片处理: Typora 解析器输出基于"当前文档"的 file:// 绝对
                // 路径 (非标准格式 file://D:/ + ?lastModify query + Typora
                // 事件属性)。统一: 去 query → 重映射到预览文档目录 → 标准
                // file:/// 格式 → 移除 onerror/onload (函数在预览上下文不存在)
                if (options.baseDir) {
                    var imgs = container.querySelectorAll("img");
                    for (var j = 0; j < imgs.length; j++) {
                        var img = imgs[j];
                        var src = img.getAttribute("src");
                        if (!src) continue;
                        var clean = decodePath(src.split(/[?#]/)[0]);   // 去 query + URL 解码
                        try {
                            if (/^file:/i.test(clean)) {
                                var abs = clean.replace(/^file:\/\//i, "");
                                if (/^[a-zA-Z]:\//.test(abs)) {
                                    // Windows 盘符: 重映射到预览文档目录
                                    var cur = _btGetCurrentFile();
                                    var curDir = cur ? path.dirname(cur) : null;
                                    var rel = curDir ? path.relative(curDir, abs) : abs;
                                    img.src = url.pathToFileURL(
                                        path.resolve(options.baseDir, rel)
                                    ).href;
                                } else {
                                    img.src = clean;
                                }
                            } else if (!/^(https?:|data:|mailto:|\/\/|#)/i.test(clean)) {
                                img.src = url.pathToFileURL(
                                    path.resolve(options.baseDir, clean)
                                ).href;
                            } else if (clean !== src) {
                                img.src = clean;
                            }
                        } catch (e) {}
                        // Typora 事件处理器在预览上下文不存在, 移除避免报错
                        img.removeAttribute("onerror");
                        img.removeAttribute("onload");
                    }
                }

                // 本地链接: 解析目标 (同图片 — Typora 解析器把相对链接输出
                // 成基于"当前文档"的 file:// 绝对, 需重映射到预览目录) +
                // 标记 data-bt-link (绝对路径, 点击行为由调用方委托)
                var links = container.querySelectorAll("a[href]");
                for (var k = 0; k < links.length; k++) {
                    var href = links[k].getAttribute("href") || "";
                    if (/^(https?:|data:|mailto:|\/\/|#)/i.test(href)) continue;
                    var clean = decodePath(href.split(/[?#]/)[0]);   // 去 query + URL 解码
                    var target = null;
                    try {
                        if (/^file:/i.test(clean)) {
                            var abs2 = clean.replace(/^file:\/\//i, "");
                            if (/^[a-zA-Z]:\//.test(abs2)) {
                                var cur2 = _btGetCurrentFile();
                                var curDir2 = cur2 ? path.dirname(cur2) : null;
                                var rel2 = curDir2 ? path.relative(curDir2, abs2) : abs2;
                                target = path.resolve(options.baseDir, rel2);
                            } else {
                                target = abs2;
                            }
                        } else if (options.baseDir) {
                            target = path.resolve(options.baseDir, clean);
                        }
                    } catch (e) {}
                    if (target) {
                        links[k].setAttribute("data-bt-link", target);
                    }
                }

                // 代码块高亮 — Typora 同款 CodeMirror (环境不支持时静默跳过)
                // 参考 typora-community-plugin: pre.md-fences → CodeMirror(el, opts, fakeEditor, cid)
                try {
                    if (typeof window.CodeMirror === "function") {
                        var fences = container.querySelectorAll("pre.md-fences");
                        for (var m = 0; m < fences.length; m++) {
                            (function (pre) {
                                try {
                                    var code = pre.innerText || pre.textContent || "";
                                    pre.innerHTML = "";
                                    var lang = pre.getAttribute("lang") || "";
                                    var mode = (typeof window.getCodeMirrorMode === "function")
                                        ? window.getCodeMirrorMode(lang) : "text";
                                    var showLineNumbers = false;
                                    try {
                                        showLineNumbers = !!File.option.showLineNumbersForFence;
                                    } catch (e) {}
                                    var cmOpts = {
                                        mode: mode,
                                        readOnly: true,
                                        styleSelectedText: true,
                                        maxHighlightLength: 1 / 0,
                                        viewportMargin: 1 / 0,
                                        styleActiveLine: true,
                                        theme: " inner null-scroll",
                                        resetSelectionOnContextMenu: true,
                                        cursorScrollMargin: 60,
                                        dragDrop: false,
                                        scrollbarStyle: "null",
                                        lineNumbers: showLineNumbers,
                                        lineWrapping: false
                                    };
                                    var fakeEditor = {
                                        sourceView: { inSourceMode: false },
                                        undo: {
                                            register: function () {},
                                            lastRegisteredOperationCommand: function () {}
                                        }
                                    };
                                    var cm = window.CodeMirror(pre, cmOpts, fakeEditor,
                                        "bt-cm-" + (++_cmSeq));
                                    cm.setValue(code);
                                } catch (e) {}
                            })(fences[m]);
                        }
                    }
                } catch (e) {}

                // 公式 (Typora 已加载 MathJax)
                try {
                    if (window.MathJax && typeof window.MathJax.typesetPromise === "function") {
                        window.MathJax.typesetPromise([container]);
                    }
                } catch (e) {}
                return true;
            }

            return {
                isAvailable: function () { return !!getCtor(); },
                parse: parse,
                renderTo: renderTo,
                lastError: function () { return _lastError; }
            };
        })();

        // =================================================================
        // 滚动状态服务 (BetterTypora.scroll)
        // 按文件记录滚动位置 + 安装自动恢复: 包装 File.recoverPosOrScroll,
        // Typora 恢复时注入 scrollOffset (渲染未完成时 scrollHeight 不足,
        // scrollTop 被 clamp — 等待"可滚动到目标"条件成立后一次性补设)。
        // 记录由调用方 (如 split-view) 监听滚动并 record();
        // 调用方结束使用时 clear() 清空 → 包装不注入 (Typora 原行为)。
        // =================================================================
        var scrollService = (function () {
            var _state = {};         // filePath → scrollTop
            var _origRecover = null; // 原始 File.recoverPosOrScroll
            var _installed = false;

            function record(filePath, value) {
                if (!filePath) return;
                _state[filePath] = value || 0;
            }

            function get(filePath) {
                return _state[filePath];
            }

            function clear() {
                _state = {};
            }

            /** 安装自动恢复 (幂等) */
            function installAutoRestore() {
                if (_installed) return;
                _installed = true;
                if (!File || typeof File.recoverPosOrScroll !== "function") return;
                _origRecover = File.recoverPosOrScroll;
                File.recoverPosOrScroll = function (e) {
                    var injected = false;
                    var target = null;
                    if (e === undefined) {
                        try {
                            var cf = File.bundle && File.bundle.filePath;
                            if (cf && _state[cf] !== undefined) {
                                target = _state[cf];
                                e = { scrollOffset: target, timeStamp: Date.now() };
                                injected = true;
                            }
                        } catch (err) {}
                    }
                    // 必须传注入后的 e — apply(arguments) 会丢失注入值
                    var result = _origRecover.call(this, e);
                    if (injected) {
                        var waited = 0;
                        (function wait() {
                            setTimeout(function () {
                                var content = document.querySelector("content");
                                if (!content) return;
                                if (content.scrollTop === target) return;
                                waited++;
                                if (content.scrollHeight < target + content.clientHeight &&
                                        waited < 60) {
                                    wait();
                                } else {
                                    try {
                                        _origRecover.call(File, {
                                            scrollOffset: target,
                                            timeStamp: Date.now()
                                        });
                                    } catch (err2) {}
                                }
                            }, 50);
                        })();
                    }
                    return result;
                };
            }

            return {
                record: record,
                get: get,
                clear: clear,
                installAutoRestore: installAutoRestore,
                isInstalled: function () { return _installed; }
            };
        })();

        // 暴露全局 API
        window.BetterTypora = {
            events: eventBus,
            commands: commandRegistry,
            settings: settingsManager,
            hotkeys: hotkeyManager,
            manager: pluginManager,
            plugins: pluginManager._plugins,
            theme: themeService,
            markdown: markdownService,
            scroll: scrollService,

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

            // 通用文件事件 (BetterTypora.onFileEvent(type, fn)/offFileEvent)
            // type: "opening" | "opened" | "closing" | "deleted" | "renamed"
            onFileEvent: _btOnFileEvent,
            offFileEvent: _btOffFileEvent,

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

            // 偏好设置面板: 监听 webview 出现, 注入"插件"栏目
            _btWatchPreferencePanel();

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
                    '<style>' +
                        '.bt-plugin-list { margin-top: 4px; }' +
                        '.bt-plugin-row { display: flex; align-items: center; padding: 9px 12px; border-radius: 6px; transition: background 0.15s ease; }' +
                        '.bt-plugin-row:hover { background: rgba(128,128,128,0.08); }' +
                        '.bt-plugin-main { display: flex; align-items: center; gap: 8px; min-width: 200px; }' +
                        '.bt-plugin-name { font-weight: 600; }' +
                        '.bt-plugin-version { font-size: 12px; opacity: 0.5; }' +
                        '.bt-plugin-state { font-size: 11px; padding: 1px 8px; border-radius: 10px; white-space: nowrap; }' +
                        '.bt-state-enabled { background: rgba(76,175,80,0.14); color: rgba(76,175,80,0.95); }' +
                        '.bt-state-disabled { background: rgba(128,128,128,0.14); opacity: 0.75; }' +
                        '.bt-state-error { background: rgba(229,57,53,0.14); color: rgba(229,57,53,0.95); }' +
                        '.bt-plugin-desc { flex: 1; min-width: 0; font-size: 12px; opacity: 0.6; margin: 0 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }' +
                        '.bt-plugin-actions { display: flex; gap: 6px; }' +
                    '</style>' +
                    '<div class="megamenu-menu-panel">' +
                        '<h1>插件</h1>' +
                        '<div class="long-btn-wrap">' +
                            '<div class="long-btn" id="bt-plugins-reload-all">' +
                                '<i class="fa fa-refresh"></i><span>重载所有插件</span>' +
                            '</div>' +
                        '</div>' +
                        '<div class="bt-plugin-list" id="bt-plugins-list"></div>' +
                        '<p class="preference-item-hint" style="margin-top:12px" id="bt-plugins-count"></p>' +
                        '<div id="bt-plugins-empty" style="display:none;text-align:center;padding:36px 0;color:#999">' +
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

                // 行操作按钮事件委托 (启用/停用/重载)
                section.addEventListener("click", function (e) {
                    var btn = e.target && e.target.closest ? e.target.closest(".bt-plugin-action") : null;
                    if (!btn) return;
                    var id = btn.getAttribute("data-id");
                    var action = btn.getAttribute("data-action");
                    if (!id) return;
                    if (action === "toggle") {
                        var p = window.BetterTypora.manager.get(id);
                        if (!p) return;
                        if (p.state === "enabled") window.BetterTypora.manager.disable(id);
                        else window.BetterTypora.manager.enable(id);
                    } else if (action === "reload") {
                        window.BetterTypora.manager.reload(id);
                    }
                    _refreshPluginPanel();
                });

                // --- 2. 刷新面板内容的函数 ---
                var _refreshPluginPanel = function () {
                    var listEl = document.getElementById("bt-plugins-list");
                    var countEl = document.getElementById("bt-plugins-count");
                    var emptyEl = document.getElementById("bt-plugins-empty");
                    if (!listEl) return;
                    var pstatus = window.BetterTypora.status();
                    var _label = { enabled: "已启用", disabled: "已停用", error: "错误" };
                    var _cls = { enabled: "bt-state-enabled", disabled: "bt-state-disabled", error: "bt-state-error" };
                    var rows = "";
                    for (var i = 0; i < pstatus.length; i++) {
                        var p = pstatus[i];
                        var stateCls = _cls[p.state] || "bt-state-disabled";
                        var stateLabel = _label[p.state] || p.state;
                        var toggleLabel = p.state === "enabled" ? "停用" : "启用";
                        rows +=
                            '<div class="bt-plugin-row" data-id="' + p.id + '">' +
                                '<div class="bt-plugin-main">' +
                                    '<span class="bt-plugin-name">' + (p.name || p.id) + '</span>' +
                                    '<span class="bt-plugin-version">v' + (p.version || "") + '</span>' +
                                    '<span class="bt-plugin-state ' + stateCls + '">' + stateLabel + '</span>' +
                                '</div>' +
                                '<div class="bt-plugin-desc">' + (p.description || "") + '</div>' +
                                '<div class="bt-plugin-actions">' +
                                    '<button class="btn btn-default btn-xs bt-plugin-action" data-id="' + p.id + '" data-action="toggle">' + toggleLabel + '</button>' +
                                    '<button class="btn btn-default btn-xs bt-plugin-action" data-id="' + p.id + '" data-action="reload">重载</button>' +
                                '</div>' +
                            '</div>';
                    }
                    listEl.innerHTML = rows;
                    countEl.textContent = pstatus.length ? "共 " + pstatus.length + " 个插件" : "";
                    if (emptyEl) emptyEl.style.display = pstatus.length ? "none" : "";
                };

                // 注入时立即渲染一次 (面板打开即有数据)
                _refreshPluginPanel();

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
                    window.BetterTypora.toast("已显示插件状态 (" + count + " 个)", 1500);
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
