/**
 * Git Sync Plugin — 同步引擎
 * =============================
 * 封装所有同步相关的 Git 操作：锁管理、分支编排、暂存、提交、合并、远程。
 * 不直接操作 DOM 或 UI。通过 git-core.js 执行命令。
 */

(function () {
    "use strict";

    var fs = reqnode("fs");
    var path = reqnode("path");

    // ===================================================================
    // 常量
    // ===================================================================

    var COMMITTER_NAME = "TyporaSync";
    var COMMITTER_EMAIL = "sync@typora.local";

    // ===================================================================
    // 内存级串行队列 (Async Mutex)
    // 所有修改 .git/index 的操作必须入队，防止并发 git add 导致 index.lock 崩溃
    // ===================================================================

    function GitQueue() {
        this._queue = Promise.resolve();
    }

    /**
     * 将异步操作入队，串行执行。
     * @param {Function} fn — 返回 Promise 的工厂函数
     * @returns {Promise} — 当 fn 完成后 resolve
     */
    GitQueue.prototype.enqueue = function (fn) {
        var self = this;
        var p = this._queue.then(function () {
            return fn();
        }).catch(function (err) {
            // 吞掉错误，不阻塞后续队列
            console.error("[git-sync] 队列操作失败:", err.message);
            return { success: false, error: err.message };
        });
        this._queue = p.then(function () {});  // 无论成败都继续队列
        return p;
    };

    // 全局单例
    var _gitQueue = new GitQueue();

    // ===================================================================
    // 常量
    // ===================================================================

    var GITIGNORE_CONTENT = [
        "# === Typora 运行时产物 ===",
        ".trash/",
        "*.swp",
        "*.swo",
        "*~",
        ".typora-sync.log",
        "",
        "# === 操作系统垃圾 ===",
        ".DS_Store",
        "Thumbs.db",
        "desktop.ini",
        "ehthumbs.db",
        "",
        "# === 编辑器/IDE 缓存 ===",
        ".obsidian/workspace.json",
        ".obsidian/workspace-mobile.json",
        ".vscode/",
        ".idea/",
        ""
    ].join("\n");

    // ===================================================================
    // 凭证阻断
    // ===================================================================

    function blockCredentials() {
        // git-core.js 的 execGit 已设置 GIT_TERMINAL_PROMPT=0 / GIT_ASKPASS=echo
        // 这里额外设置进程级全局兜底
        if (typeof process !== "undefined" && process.env) {
            process.env.GIT_TERMINAL_PROMPT = "0";
            process.env.GIT_ASKPASS = "echo";
            process.env.GIT_SSH_ASKPASS = "echo";
        }
    }

    // ===================================================================
    // 提交者身份
    // ===================================================================

    function ensureCommitterIdent(repoPath, gitCore) {
        return gitCore.configSet(repoPath, "user.name", COMMITTER_NAME).then(function () {
            return gitCore.configSet(repoPath, "user.email", COMMITTER_EMAIL);
        }).then(function () {
            return { success: true };
        });
    }

    // ===================================================================
    // 仓库初始化
    // ===================================================================

    function generateGitignore(repoPath, gitCore) {
        var giPath = path.join(repoPath, ".gitignore");
        if (fs.existsSync(giPath)) {
            return Promise.resolve({ success: true, existed: true });
        }
        try {
            fs.writeFileSync(giPath, GITIGNORE_CONTENT, "utf8");
        } catch (e) {
            return Promise.resolve({ success: false, error: e.message });
        }
        return _gitQueue.enqueue(function () {
            return gitCore.addFile(repoPath, giPath).then(function (addResult) {
                if (!addResult.success) return addResult;
                return gitCore.commit(repoPath, "sync: add .gitignore").then(function (cmt) {
                    return { success: cmt.success, error: cmt.error };
                });
            });
        });
    }

    function autoInitRepo(repoPath, gitCore) {
        if (gitCore.isRepo(repoPath)) {
            return Promise.resolve({ success: true, existed: true });
        }

        return gitCore.init(repoPath).then(function (initResult) {
            if (!initResult.success) {
                return { success: false, error: initResult.error };
            }

            var steps = Promise.resolve();
            // 确保 main 分支存在（git init 可能创建 master）
            steps = steps.then(function () {
                return gitCore.currentBranch(repoPath).then(function (br) {
                    if (br.success && br.output !== "main") {
                        return gitCore.execGit(repoPath, ["branch", "-m", "main"]);
                    }
                    return br;
                });
            });

            // 创建 .gitignore + 首次提交
            steps = steps.then(function () {
                return generateGitignore(repoPath, gitCore);
            });

            // 确保至少一个提交（create baseline if needed）
            steps = steps.then(function () {
                return gitCore.hasUncommitted(repoPath).then(function (hu) {
                    if (hu.success && hu.hasChanges) {
                        return gitCore.stage(repoPath).then(function () {
                            return gitCore.commit(repoPath, "sync: initial baseline");
                        });
                    }
                    // .gitignore commit 已创建，检查
                    return { success: true };
                });
            });

            return steps.then(function () {
                return { success: true, existed: false };
            }).catch(function (err) {
                return { success: false, error: err.message };
            });
        });
    }

    /**
     * 组合初始化：autoInitRepo + ensureCommitterIdent
     * 供面板「初始化仓库」按钮调用
     */
    function initRepo(repoPath, gitCore) {
        return autoInitRepo(repoPath, gitCore).then(function (initResult) {
            if (!initResult.success) return initResult;
            return ensureCommitterIdent(repoPath, gitCore).then(function () {
                return initResult;
            });
        });
    }

    // ===================================================================
    // 暂存
    // ===================================================================

    /**
     * 全量暂存：已跟踪修改/删除 + 未跟踪的 .md 文件
     */
    function stageTrackedAndNewMd(repoPath, gitCore) {
        return _gitQueue.enqueue(function () {
            // 1. git add -u（捕获修改、删除）
            return gitCore.addUpdate(repoPath).then(function (uResult) {
                // 2. git ls-files --others -- '*.md'
                return gitCore.lsUntrackedMd(repoPath).then(function (lsResult) {
                    if (!lsResult.success || !lsResult.output) {
                        return { success: uResult.success };
                    }
                    // 3. 逐个 add 新 md 文件
                    var files = lsResult.output.split("\n").filter(Boolean);
                    if (files.length === 0) {
                        return { success: uResult.success };
                    }
                    var chain = Promise.resolve();
                    for (var i = 0; i < files.length; i++) {
                        (function (fp) {
                            chain = chain.then(function () {
                                return gitCore.addFile(repoPath, fp);
                            });
                        })(files[i]);
                    }
                    return chain.then(function () {
                        return { success: true };
                    });
                });
            });
        });
    }

    // ===================================================================
    // 提交

    function commitSync(repoPath, fileName, gitCore) {
        var msg = (fileName || "notes");
        return _gitQueue.enqueue(function () {
            return gitCore.commit(repoPath, msg);
        });
    }

    // ===================================================================
    // 远程同步
    // ===================================================================

    function configureRemote(repoPath, remoteUrl, remoteName, gitCore) {
        remoteName = remoteName || "origin";
        return gitCore.getRemotes(repoPath).then(function (result) {
            if (result.success && result.remotes) {
                for (var i = 0; i < result.remotes.length; i++) {
                    if (result.remotes[i].name === remoteName) {
                        // 已存在，仅当 URL 不同时更新
                        if (result.remotes[i].url !== remoteUrl) {
                            return gitCore.execGit(repoPath, ["remote", "set-url", remoteName, remoteUrl]);
                        }
                        return { success: true };
                    }
                }
            }
            return gitCore.remoteAdd(repoPath, remoteName, remoteUrl);
        });
    }

    /**
     * 启动时拉取远程更新
     */
    function pullBeforeWork(repoPath, remoteName, gitCore, branch) {
        remoteName = remoteName || "origin";
        branch = branch || "main";
        return gitCore.fetch(repoPath, remoteName, branch).then(function (fetchResult) {
            if (!fetchResult.success) {
                var classified = classifyRemoteError(fetchResult.error || fetchResult.stderr || "", fetchResult.exitCode);
                return { success: false, error: classified.guidance, conflict: false, errorType: classified.type };
            }
            // 尝试快进合并远程分支
            return gitCore.mergeFFOnly(repoPath, remoteName + "/" + branch).then(function (mergeResult) {
                if (mergeResult.success) {
                    return { success: true, files: [] };
                }
                return { success: false, error: "无法自动合并远端更新，请手动合并", conflict: true };
            });
        });
    }

    /**
     * 退出时推送到远程
     */
    function pushAfterMerge(repoPath, remoteName, gitCore, branch) {
        remoteName = remoteName || "origin";
        branch = branch || "main";
        return gitCore.push(repoPath, remoteName, branch).then(function (result) {
            if (result.success) {
                return { success: true };
            }
            var classified = classifyRemoteError(result.error || result.stderr || "", result.exitCode);
            return { success: false, error: classified.guidance, errorType: classified.type };
        });
    }

    /**
     * 手动触发同步（面板 "同步" 按钮）
     */
    function manualSync(repoPath, remoteName, gitCore, branch) {
        remoteName = remoteName || "origin";
        branch = branch || "main";
        // pull → commit → push
        return pullBeforeWork(repoPath, remoteName, gitCore, branch).then(function (pullResult) {
            return stageTrackedAndNewMd(repoPath, gitCore).then(function () {
                return commitSync(repoPath, "manual-sync", gitCore).then(function (commitResult) {
                    if (!commitResult.success) return { phase: "commit", success: false, error: commitResult.error };
                    return pushAfterMerge(repoPath, remoteName, gitCore, branch).then(function (pushResult) {
                        if (pushResult.success) {
                            return { success: true, pullResult: pullResult, pushResult: pushResult };
                        }
                        return { phase: "push", success: false, error: pushResult.error };
                    });
                });
            });
        });
    }

    /**
     * 网络连通性诊断
     */
    function checkRemoteConnectivity(repoPath, remoteName, gitCore) {
        remoteName = remoteName || "origin";
        return gitCore.execGit(repoPath, ["ls-remote", "--heads", remoteName], { timeout: 15000 }).then(function (result) {
            if (result.success) {
                return { success: true, reachable: true };
            }
            var classified = classifyRemoteError(result.error || result.stderr || "", result.exitCode);
            return { success: true, reachable: false, error: result.error,
                errorType: classified.type, errorDetail: classified.detail, errorGuidance: classified.guidance };
        }).catch(function (err) {
            var classified = classifyRemoteError(err.message || "", 0);
            return { success: false, reachable: false, error: err.message,
                errorType: classified.type, errorDetail: classified.detail, errorGuidance: classified.guidance };
        });
    }

    /**
     * 解析远端错误信息，返回分类 + 引导
     * @param {string} stderr — git 的 stderr 输出
     * @param {number} exitCode — git 退出码
     * @returns {{type: string, detail: string, guidance: string}}
     */
    function classifyRemoteError(stderr, exitCode) {
        var msg = (stderr || "").toLowerCase();

        // 认证失败
        if (msg.indexOf("permission denied") >= 0 ||
            msg.indexOf("authentication failed") >= 0 ||
            msg.indexOf("could not read username") >= 0 ||
            msg.indexOf("could not read password") >= 0 ||
            msg.indexOf("access denied") >= 0 ||
            msg.indexOf("invalid username or password") >= 0 ||
            msg.indexOf("remote: invalid credentials") >= 0 ||
            (exitCode === 128 && msg.indexOf("repository") >= 0 && msg.indexOf("not found") >= 0)) {
            return {
                type: "auth",
                detail: "认证失败",
                guidance: "SSH: 请检查密钥 (~/.ssh/id_rsa) 是否已添加到远程服务。HTTPS: 请使用 Personal Access Token 替代密码。"
            };
        }

        // 网络不可达
        if (msg.indexOf("could not resolve host") >= 0 ||
            msg.indexOf("unable to connect") >= 0 ||
            msg.indexOf("connection timed out") >= 0 ||
            msg.indexOf("connection refused") >= 0 ||
            msg.indexOf("network is unreachable") >= 0 ||
            msg.indexOf("no route to host") >= 0 ||
            msg.indexOf("couldn't connect to server") >= 0) {
            return {
                type: "network",
                detail: "网络不可达",
                guidance: "无法连接远端服务器，请检查网络，或确认远程仓库地址是否正确。"
            };
        }

        // 仓库不存在（有认证但仓库名错误）
        if (msg.indexOf("remote: repository not found") >= 0 ||
            msg.indexOf("remote: not found") >= 0) {
            return {
                type: "repo_not_found",
                detail: "仓库不存在",
                guidance: "仓库未找到，请检查地址中的用户名和仓库名是否正确，或确认是否有访问权限。"
            };
        }

        // 远程未配置
        if (msg.indexOf("does not appear to be a git repository") >= 0 ||
            msg.indexOf("no such remote") >= 0) {
            return {
                type: "no_remote",
                detail: "远程地址无效",
                guidance: "URL 对应的仓库不存在。SSH 格式: git@host:user/repo.git，HTTPS 格式: https://host/user/repo.git"
            };
        }

        return {
            type: "unknown",
            detail: "连接失败",
            guidance: "未知错误，请检查远程地址和网络。详情: " + (stderr || "").substring(0, 80)
        };
    }

    /**
     * 仓库完整性检查
     */
    function checkRepoHealth(repoPath, gitCore) {
        return gitCore.execGit(repoPath, ["fsck", "--no-dangling", "--name-objects"], { timeout: 30000 }).then(function (result) {
            if (result.success) {
                return { success: true, healthy: true, output: result.output };
            }
            // fsck 可能返回警告，仍认为健康
            return { success: true, healthy: true, warnings: result.stderr };
        }).catch(function () {
            return { success: false, healthy: false, error: "仓库检查失败" };
        });
    }

    // ===================================================================
    // 导出
    // ===================================================================

    module.exports = {
        // 常量
        GITIGNORE_CONTENT: GITIGNORE_CONTENT,

        // 安全
        blockCredentials: blockCredentials,
        ensureCommitterIdent: ensureCommitterIdent,

        // 仓库
        autoInitRepo: autoInitRepo,
        initRepo: initRepo,
        generateGitignore: generateGitignore,

        // 暂存
        stageTrackedAndNewMd: stageTrackedAndNewMd,

        // 提交
        commitSync: commitSync,

        // 远程
        configureRemote: configureRemote,
        pullBeforeWork: pullBeforeWork,
        pushAfterMerge: pushAfterMerge,
        manualSync: manualSync,
        checkRemoteConnectivity: checkRemoteConnectivity,
        classifyRemoteError: classifyRemoteError,

        // 运维
        checkRepoHealth: checkRepoHealth
    };

})();
