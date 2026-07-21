/**
 * Git Plugin — Git 命令封装层
 * ===============================
 * 所有 Git 操作通过 child_process.execFile 调用系统 Git。
 * 数组形式传参避免 shell 注入。返回 Promise 风格。
 */
(function () {
    "use strict";

    var child_process = reqnode("child_process");
    var fs = reqnode("fs");
    var path = reqnode("path");

    // ===================================================================
    // 工具函数
    // ===================================================================

    /**
     * 执行 git 命令，返回 Promise
     * @param {string} repoPath - 仓库根目录
     * @param {string[]} args - git 命令参数数组
     * @param {Object} [opts] - 额外选项
     * @returns {Promise<{success: boolean, output?: string, stderr?: string, error?: string, exitCode?: number}>}
     */
    function execGit(repoPath, args, opts) {
        opts = opts || {};
        return new Promise(function (resolve) {
            var env = {};
            // 复制进程环境变量
            if (typeof process !== "undefined" && process.env) {
                var keys = Object.keys(process.env);
                for (var i = 0; i < keys.length; i++) {
                    env[keys[i]] = process.env[keys[i]];
                }
            }
            // Git 环境变量 — 禁止交互式凭证弹窗
            env.GIT_TERMINAL_PROMPT = "0";
            env.GIT_ASKPASS = "echo";
            env.GIT_SSH_ASKPASS = "echo";
            env.LANG = "en_US.UTF-8";
            if (opts.env) {
                var optKeys = Object.keys(opts.env);
                for (var j = 0; j < optKeys.length; j++) {
                    env[optKeys[j]] = opts.env[optKeys[j]];
                }
            }

            var options = {
                cwd: repoPath,
                maxBuffer: opts.maxBuffer || 10 * 1024 * 1024, // 10MB
                timeout: opts.timeout || 30000,
                env: env
            };

            // 规范化路径参数中的反斜杠（Windows 兼容）
            var normalizedArgs = args.map(function (a) {
                return typeof a === "string" ? a.replace(/\\/g, "/") : a;
            });

            child_process.execFile("git", normalizedArgs, options, function (err, stdout, stderr) {
                if (err) {
                    resolve({
                        success: false,
                        error: (stderr || err.message || "").trim(),
                        exitCode: err.code,
                        output: stdout ? stdout.trim() : "",
                        stderr: stderr ? stderr.trim() : ""
                    });
                } else {
                    resolve({
                        success: true,
                        output: stdout ? stdout.trim() : "",
                        stderr: stderr ? stderr.trim() : ""
                    });
                }
            });
        });
    }

    /**
     * 解析 git status --porcelain -b 的输出
     */
    function parsePorcelainStatus(output) {
        var result = { branch: "", files: [], aheadCount: 0, behindCount: 0 };
        if (!output) return result;

        var lines = output.split("\n");
        for (var i = 0; i < lines.length; i++) {
            var line = lines[i];
            if (!line) continue;

            // 分支行: "## branch_name...origin/branch_name [ahead N, behind M]"
            if (line.indexOf("## ") === 0) {
                var branchPart = line.substring(3);
                // 提取 ahead/behind
                var aheadMatch = branchPart.match(/\[ahead\s+(\d+)/);
                var behindMatch = branchPart.match(/behind\s+(\d+)/);
                if (aheadMatch) result.aheadCount = parseInt(aheadMatch[1], 10);
                if (behindMatch) result.behindCount = parseInt(behindMatch[1], 10);

                // 提取分支名（去除 ...remote 部分）
                var ellipsisIdx = branchPart.indexOf("...");
                if (ellipsisIdx >= 0) {
                    result.branch = branchPart.substring(0, ellipsisIdx);
                } else {
                    // 去除 ahead/behind 部分
                    var bracketIdx = branchPart.indexOf(" [");
                    if (bracketIdx >= 0) {
                        result.branch = branchPart.substring(0, bracketIdx);
                    } else {
                        result.branch = branchPart;
                    }
                }
                continue;
            }

            // 文件行: XY path
            // XY 是两个字符的状态码
            if (line.length >= 3) {
                var statusCode = line.substring(0, 2);
                var filePath = line.substring(3).trim();

                // 处理重命名: "R  old -> new"
                if (statusCode === "R" || statusCode.indexOf("R") >= 0) {
                    var arrowIdx = filePath.indexOf(" -> ");
                    if (arrowIdx >= 0) {
                        filePath = filePath.substring(arrowIdx + 4);
                    }
                }

                result.files.push({ path: filePath, status: statusCode });
            }
        }

        return result;
    }

    /**
     * 将 git log 格式化为对象数组
     * 输出格式: HASH|PARENTS|AUTHOR|DATE|REF|MESSAGE
     */
    function parseGitLog(output) {
        if (!output) return [];
        var lines = output.split("\n");
        var commits = [];
        for (var i = 0; i < lines.length; i++) {
            var line = lines[i].trim();
            if (!line) continue;
            var parts = line.split("|");
            if (parts.length >= 5) {
                var parentStr = parts[1] ? parts[1].trim() : "";
                commits.push({
                    hash: parts[0],
                    parents: parentStr ? parentStr.split(/\s+/) : [],
                    author: parts[2] || "",
                    date: parts[3] || "",
                    refs: parts[4] || "",
                    message: parts.slice(5).join("|") || ""
                });
            }
        }
        return commits;
    }

    /**
     * 解析 git branch -a 的输出
     */
    function parseBranchList(output) {
        if (!output) return [];
        var lines = output.split("\n");
        var branches = [];
        for (var i = 0; i < lines.length; i++) {
            var line = lines[i].trim();
            if (!line) continue;
            var current = line.indexOf("* ") === 0;
            var name = current ? line.substring(2) : line;
            // 去除 "remotes/origin/" 前缀用于显示
            var remote = false;
            if (name.indexOf("remotes/") === 0) {
                remote = true;
                name = name.substring(8); // 去除 "remotes/"
            }
            // 进一步去除 "origin/"
            var originIdx = name.indexOf("/");
            if (remote && originIdx >= 0) {
                name = name.substring(originIdx + 1);
            }
            branches.push({ name: name, current: current, remote: remote });
        }
        return branches;
    }

    /**
     * 解析 git remote -v 的输出
     */
    function parseRemotes(output) {
        if (!output) return [];
        var lines = output.split("\n");
        var remotes = [];
        var seen = {};
        for (var i = 0; i < lines.length; i++) {
            var line = lines[i].trim();
            if (!line) continue;
            var parts = line.split(/\s+/);
            if (parts.length >= 2) {
                var name = parts[0];
                var url = parts[1];
                var type = parts.length >= 3 ? parts[2].replace(/[()]/g, "") : "fetch";
                var key = name + "|" + url;
                if (!seen[key]) {
                    seen[key] = true;
                    remotes.push({ name: name, url: url, type: type });
                }
            }
        }
        return remotes;
    }

    // ===================================================================
    // 公共 API
    // ===================================================================

    /**
     * 检查指定目录是否是 Git 仓库
     */
    function isRepo(repoPath) {
        return fs.existsSync(path.join(repoPath, ".git"));
    }

    // ===================================================================
    // 新增：配置、分支、合并、远程操作
    // ===================================================================

    function configSet(repoPath, key, value) {
        return execGit(repoPath, ["config", key, value]);
    }

    function configGet(repoPath, key) {
        return execGit(repoPath, ["config", key]);
    }

    function checkoutBranch(repoPath, branch) {
        return execGit(repoPath, ["checkout", branch]);
    }

    function checkoutNewBranch(repoPath, branch, base) {
        var args = ["checkout", "-b", branch];
        if (base) args.push(base);
        return execGit(repoPath, args);
    }

    function mergeFFOnly(repoPath, branch) {
        return execGit(repoPath, ["merge", "--ff-only", branch]);
    }

    function mergeNoFF(repoPath, branch, message) {
        return execGit(repoPath, ["merge", "--no-ff", "-m", message, branch]);
    }

    function fetch(repoPath, remote, branch) {
        var args = ["fetch"];
        if (remote) args.push(remote);
        if (branch) args.push(branch);
        return execGit(repoPath, args, { timeout: 60000 });
    }

    function isAncestor(repoPath, child, parent) {
        return execGit(repoPath, ["merge-base", "--is-ancestor", child, parent]);
    }

    function hasUncommitted(repoPath) {
        return execGit(repoPath, ["status", "--porcelain"]).then(function (result) {
            if (result.success) {
                result.hasChanges = result.output.trim().length > 0;
            }
            return result;
        });
    }

    function lsUntrackedMd(repoPath) {
        return execGit(repoPath, ["ls-files", "--others", "--exclude-standard", "--", "*.md"]);
    }

    function currentBranch(repoPath) {
        return execGit(repoPath, ["rev-parse", "--abbrev-ref", "HEAD"]);
    }

    function addFile(repoPath, filePath) {
        return execGit(repoPath, ["add", "--", filePath.replace(/\\/g, "/")]);
    }

    function addUpdate(repoPath) {
        return execGit(repoPath, ["add", "-u"]);
    }

    function revParse(repoPath, ref) {
        return execGit(repoPath, ["rev-parse", "--verify", ref]);
    }

    function checkoutNewBranchForce(repoPath, branch, target) {
        return execGit(repoPath, ["checkout", "-B", branch, target]);
    }

    function mergeBase(repoPath, a, b) {
        return execGit(repoPath, ["merge-base", a, b]);
    }

    function resetBranch(repoPath, branch, target) {
        return execGit(repoPath, ["branch", "-f", branch, target]);
    }

    function deleteBranch(repoPath, branch) {
        return execGit(repoPath, ["branch", "-d", branch]);
    }

    function deleteBranchForce(repoPath, branch) {
        return execGit(repoPath, ["branch", "-D", branch]);
    }

    function listBranches(repoPath, pattern) {
        var args = ["branch", "--list"];
        if (pattern) args.push(pattern);
        return execGit(repoPath, args);
    }

    /**
     * 初始化 Git 仓库
     */
    function init(repoPath) {
        return execGit(repoPath, ["init"]);
    }

    /**
     * 获取仓库状态 (git status --porcelain -b)
     * @returns {Promise<{success, branch, files, aheadCount, behindCount}>}
     */
    function status(repoPath) {
        return execGit(repoPath, ["status", "--porcelain", "-b"]).then(function (result) {
            if (result.success) {
                var parsed = parsePorcelainStatus(result.output);
                return {
                    success: true,
                    branch: parsed.branch,
                    files: parsed.files,
                    aheadCount: parsed.aheadCount,
                    behindCount: parsed.behindCount
                };
            }
            return result;
        });
    }

    /**
     * 暂存文件
     * @param {string} repoPath
     * @param {string} [filePath] - 不传则 git add -A
     */
    function stage(repoPath, filePath) {
        var args = ["add"];
        if (filePath) {
            args.push("--");
            args.push(filePath);
        } else {
            args.push("-A");
        }
        return execGit(repoPath, args);
    }

    /**
     * 提交
     */
    function commit(repoPath, message) {
        return execGit(repoPath, ["commit", "-m", message]).then(function (result) {
            if (result.success) {
                // 提取 commit hash
                var hashMatch = result.output.match(/\[[\w\-.]+\s+([a-f0-9]+)\]/);
                result.hash = hashMatch ? hashMatch[1] : "";
            }
            return result;
        });
    }

    /**
     * 提交并推送
     */
    function commitAndPush(repoPath, message, remote, branch) {
        var self = this;
        return commit(repoPath, message).then(function (commitResult) {
            if (!commitResult.success) return commitResult;
            return push(repoPath, remote, branch).then(function (pushResult) {
                pushResult.commitHash = commitResult.hash;
                return pushResult;
            });
        });
    }

    /**
     * 获取提交历史
     * @param {string} repoPath
     * @param {number} [maxCount=50]
     * @param {string} [filePath] - 特定文件的提交历史
     */
    function log(repoPath, maxCount, filePath) {
        maxCount = maxCount || 50;
        var args = [
            "log",
            "--max-count=" + maxCount,
            "--format=%H|%P|%an|%ai|%d|%s",
            "--date=short"
        ];
        if (filePath) {
            args.push("--follow");
            args.push("--");
            args.push(filePath);
        }
        return execGit(repoPath, args).then(function (result) {
            if (result.success) {
                result.commits = parseGitLog(result.output);
            }
            return result;
        });
    }

    /**
     * 查看 diff
     * @param {string} repoPath
     * @param {string} [hash1] - 不传则 diff 工作区
     * @param {string} [hash2] - 与 hash1 比较
     * @param {string} [filePath] - 特定文件
     */
    function diff(repoPath, hash1, hash2, filePath) {
        var args = ["diff"];
        if (hash1) args.push(hash1);
        if (hash2) args.push(hash2);
        if (filePath) {
            args.push("--");
            args.push(filePath);
        }
        return execGit(repoPath, args, { maxBuffer: 20 * 1024 * 1024 });
    }

    /**
     * git show — 查看特定提交的完整 diff
     */
    function show(repoPath, hash, filePath) {
        var args = ["show", hash];
        if (filePath) {
            args.push("--");
            args.push(filePath);
        }
        return execGit(repoPath, args, { maxBuffer: 20 * 1024 * 1024 });
    }

    /**
     * git show <hash>:<file> — 获取某个文件在特定提交时的完整内容
     * 用于修订视图：拿到旧版本的 markdown 原文
     * @param {string} repoPath - 仓库根目录（绝对路径）
     * @param {string} hash - 提交哈希
     * @param {string} filePath - **相对于仓库根目录的文件路径**（不是绝对路径）
     */
    function showFile(repoPath, hash, filePath) {
        var spec = hash + ":" + (filePath || "").replace(/\\/g, "/");
        return execGit(repoPath, ["show", spec], { maxBuffer: 20 * 1024 * 1024 });
    }

    /**
     * git checkout <hash> -- <file> — 将某个文件恢复到特定提交的版本
     * 用于修订视图的"恢复到此版本"操作
     * @param {string} repoPath - 仓库根目录（绝对路径）
     * @param {string} hash - 提交哈希
     * @param {string} filePath - **相对于仓库根目录的文件路径**（不是绝对路径）
     */
    function checkoutFile(repoPath, hash, filePath) {
        return execGit(repoPath, ["checkout", hash, "--", (filePath || "").replace(/\\/g, "/")], { timeout: 30000 });
    }

    /**
     * 推送到远程仓库
     */
    function push(repoPath, remote, branch) {
        remote = remote || "origin";
        var args = ["push"];
        if (branch) {
            args.push(remote);
            args.push(branch);
        } else {
            args.push(remote);
        }
        return execGit(repoPath, args, { timeout: 60000 });
    }

    /**
     * 从远程仓库拉取
     */
    function pull(repoPath, remote, branch) {
        remote = remote || "origin";
        var args = ["pull"];
        if (branch) {
            args.push(remote);
            args.push(branch);
        } else {
            args.push(remote);
        }
        return execGit(repoPath, args, { timeout: 60000 }).then(function (result) {
            if (result.success) {
                // 尝试解析拉取的文件
                result.files = [];
                if (result.output) {
                    var lines = result.output.split("\n");
                    for (var i = 0; i < lines.length; i++) {
                        var line = lines[i].trim();
                        if (line && line.indexOf("|") >= 0) {
                            var filePart = line.split("|")[0].trim();
                            if (filePart) result.files.push(filePart);
                        }
                    }
                }
            }
            return result;
        });
    }

    /**
     * 获取分支列表
     */
    function branchList(repoPath) {
        return execGit(repoPath, ["branch", "-a"]).then(function (result) {
            if (result.success) {
                result.branches = parseBranchList(result.output);
            }
            return result;
        });
    }

    /**
     * 创建分支
     */
    function branchCreate(repoPath, name) {
        return execGit(repoPath, ["branch", name]);
    }

    /**
     * 切换分支
     */
    function branchSwitch(repoPath, name) {
        return execGit(repoPath, ["checkout", name]);
    }

    /**
     * 创建并切换到新分支
     */
    function branchCreateAndSwitch(repoPath, name) {
        return execGit(repoPath, ["checkout", "-b", name]);
    }

    /**
     * 合并分支
     */
    function branchMerge(repoPath, source) {
        return execGit(repoPath, ["merge", source]);
    }

    /**
     * 删除分支
     */
    function branchDelete(repoPath, name) {
        return execGit(repoPath, ["branch", "-d", name]);
    }

    /**
     * 获取远程仓库列表
     */
    function getRemotes(repoPath) {
        return execGit(repoPath, ["remote", "-v"]).then(function (result) {
            if (result.success) {
                result.remotes = parseRemotes(result.output);
            }
            return result;
        });
    }

    /**
     * 添加远程仓库
     */
    function remoteAdd(repoPath, name, url) {
        return execGit(repoPath, ["remote", "add", name, url]);
    }

    /**
     * 检查远程仓库是否存在
     */
    function remoteExists(repoPath, name) {
        return getRemotes(repoPath).then(function (result) {
            if (result.success && result.remotes) {
                for (var i = 0; i < result.remotes.length; i++) {
                    if (result.remotes[i].name === name) return true;
                }
            }
            return false;
        });
    }

    // ===================================================================
    // 导出
    // ===================================================================

    module.exports = {
        execGit: execGit,
        isRepo: isRepo,
        init: init,
        status: status,
        stage: stage,
        commit: commit,
        commitAndPush: commitAndPush,
        log: log,
        diff: diff,
        show: show,
        showFile: showFile,
        checkoutFile: checkoutFile,
        push: push,
        pull: pull,
        branchList: branchList,
        branchCreate: branchCreate,
        branchSwitch: branchSwitch,
        branchCreateAndSwitch: branchCreateAndSwitch,
        branchMerge: branchMerge,
        branchDelete: branchDelete,
        getRemotes: getRemotes,
        remoteAdd: remoteAdd,
        remoteExists: remoteExists,
        // v2.0 新增
        configSet: configSet,
        configGet: configGet,
        checkoutBranch: checkoutBranch,
        checkoutNewBranch: checkoutNewBranch,
        checkoutNewBranchForce: checkoutNewBranchForce,
        mergeFFOnly: mergeFFOnly,
        mergeNoFF: mergeNoFF,
        fetch: fetch,
        isAncestor: isAncestor,
        hasUncommitted: hasUncommitted,
        lsUntrackedMd: lsUntrackedMd,
        currentBranch: currentBranch,
        addFile: addFile,
        addUpdate: addUpdate,
        revParse: revParse,
        mergeBase: mergeBase,
        resetBranch: resetBranch,
        deleteBranch: deleteBranch,
        deleteBranchForce: deleteBranchForce,
        listBranches: listBranches
    };

})();
