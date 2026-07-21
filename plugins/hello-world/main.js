/**
 * Hello World — BetterTypora 示例插件
 * ======================================
 * 演示: 命令注册、快捷键绑定、设置读写、事件监听、DOM 操作
 *
 * 通过 require('bettertypora:api') 获取 API (无需全局变量!)
 */
var BetterTypora = require("bettertypora:api");
var api = BetterTypora.api;
var manifest = BetterTypora.manifest;
var logger = BetterTypora.logger;

// 内部状态
var greetingCount = 0;

/**
 * 显示 Toast 通知 — 委托 BetterTypora.toast()
 * ===============================================
 * 直接复用系统级 toast, 不再重复手写 DOM。
 * 如果你想学习纯 DOM 实现, 参考 plugin-loader.js 中 BetterTypora.toast 的源码。
 */
function showToast(message, duration) {
    window.BetterTypora.toast(message, duration);
}

/**
 * 问候命令处理函数
 */
function handleGreet() {
    var greeting = api.getSetting("greeting", "Hello!");
    greetingCount += 1;

    logger.log("[" + greetingCount + "] " + greeting);

    var message = greeting + " (×" + greetingCount + ")";
    showToast(message, 3000);

    // 发射事件, 让其他插件也能监听
    api.emit("hello-world:greeted", {
        count: greetingCount,
        greeting: greeting,
        timestamp: new Date().toISOString(),
    });
}

module.exports = {
    /**
     * 插件首次加载时调用 (仅一次)
     */
    onLoad: function () {
        logger.log("Hello World v" + manifest.version + " 已加载");
        logger.log("插件目录: " + BetterTypora.pluginDir);
    },

    /**
     * 插件启用时调用
     */
    enable: function () {
        // 注册 greet 命令 (其他插件可通过 commands.execute("hello-world:greet") 调用)
        api.registerCommand("greet", handleGreet, "显示一个问候消息");

        // 注册 reset 命令
        api.registerCommand("reset", function () {
            greetingCount = 0;
            showToast("计数器已重置", 2000);
            logger.log("计数器已重置");
        }, "重置问候计数器");

        // 注册 status 命令
        api.registerCommand("status", function () {
            var info = {
                plugin: "hello-world",
                version: manifest.version,
                greetingCount: greetingCount,
                settings: api.getAllSettings(),
            };
            console.table(info);
            showToast("状态已输出到 Console", 2000);
            return info;
        }, "显示插件状态");

        // 监听系统事件
        api.on("plugin-system:ready", function () {
            logger.log("插件系统就绪 — Hello World 正在运行!");
        });

        api.on("hello-world:greeted", function (data) {
            logger.log("问候事件触发: 第 " + data.count + " 次, 消息: " + data.greeting);
        });

        logger.log("Hello World 已启用 ✅");
    },

    /**
     * 插件停用时调用
     */
    disable: function () {
        logger.log("Hello World 已停用. 总计问候: " + greetingCount);

        // 移除所有残留的 DOM 元素
        var leftovers = document.querySelectorAll("[data-plugin-id='hello-world']");
        for (var i = 0; i < leftovers.length; i++) {
            if (leftovers[i].parentNode) {
                leftovers[i].parentNode.removeChild(leftovers[i]);
            }
        }
    },

    /**
     * 插件卸载时调用
     */
    onUnload: function () {
        logger.log("Hello World 已卸载. 再见! 👋");
    },
};
