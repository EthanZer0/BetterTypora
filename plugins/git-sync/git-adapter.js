/* Git 适配层：只负责调用和解析 Git，不知道 Typora、状态栏或面板。 */
(function () {
    "use strict";

    var childProcess = reqnode("child_process");
    var fs = reqnode("fs");
    var path = reqnode("path");

    function GitAdapter(logger) {
        this.logger = logger || console;
    }

    function copyEnv(extra) {
        var env = {};
        var source = typeof process !== "undefined" && process.env ? process.env : {};
        var keys = Object.keys(source);
        for (var i = 0; i < keys.length; i++) env[keys[i]] = source[keys[i]];
        // 同步必须失败可返回，不能在 Typora 中等待终端输入凭证。
        env.GIT_TERMINAL_PROMPT = "0";
        env.GIT_ASKPASS = "echo";
        env.GIT_SSH_ASKPASS = "echo";
        env.LANG = "en_US.UTF-8";
        extra = extra || {};
        keys = Object.keys(extra);
        for (var j = 0; j < keys.length; j++) env[keys[j]] = extra[keys[j]];
        return env;
    }

    GitAdapter.prototype.exec = function (root, args, options) {
        options = options || {};
        var self = this;
        return new Promise(function (resolve) {
            childProcess.execFile("git", args, {
                cwd: root,
                env: copyEnv(options.env),
                timeout: options.timeout || 60000,
                maxBuffer: options.maxBuffer || 16 * 1024 * 1024,
                windowsHide: true
            }, function (error, stdout, stderr) {
                var out = stdout ? String(stdout) : "";
                var err = stderr ? String(stderr) : "";
                if (error) {
                    resolve({ success: false, output: out.trim(), stderr: err.trim(), error: (err || error.message || "Git 操作失败").trim(), code: error.code });
                    return;
                }
                resolve({ success: true, output: out.trim(), stderr: err.trim(), error: "" });
            });
        });
    };

    GitAdapter.prototype.isRepo = function (root) {
        return this.exec(root, ["rev-parse", "--show-toplevel"], { timeout: 10000 }).then(function (r) {
            return { success: r.success, root: r.success ? r.output : null, error: r.error };
        });
    };

    GitAdapter.prototype.init = function (root) {
        return this.exec(root, ["init"], { timeout: 30000 });
    };

    GitAdapter.prototype.renameDefaultBranch = function (root) {
        return this.exec(root, ["branch", "-M", "main"], { timeout: 10000 });
    };

    GitAdapter.prototype.status = function (root) {
        // Git 默认会把非 ASCII 路径转成八进制转义（例如 \344\270\255），
        // 这不是文件路径本身；命令级关闭后，Node 可以直接按 UTF-8 接收中文。
        return this.exec(root, ["-c", "core.quotePath=false", "status", "--porcelain=v1", "-b", "--untracked-files=all"], { timeout: 60000, maxBuffer: 32 * 1024 * 1024 }).then(function (result) {
            if (!result.success) return result;
            return { success: true, status: parseStatus(result.output), output: result.output };
        });
    };

    GitAdapter.prototype.remoteUrl = function (root, remote) {
        return this.exec(root, ["remote", "get-url", remote || "origin"], { timeout: 10000 });
    };

    GitAdapter.prototype.currentBranch = function (root) {
        return this.exec(root, ["branch", "--show-current"], { timeout: 10000 });
    };

    GitAdapter.prototype.addAll = function (root) {
        return this.exec(root, ["add", "-A"], { timeout: 120000, maxBuffer: 32 * 1024 * 1024 });
    };

    GitAdapter.prototype.commit = function (root, message) {
        return this.exec(root, ["commit", "-m", message], { timeout: 120000, maxBuffer: 8 * 1024 * 1024 });
    };

    GitAdapter.prototype.fetch = function (root, remote) {
        return this.exec(root, ["fetch", "--prune", remote || "origin"], { timeout: 120000, maxBuffer: 16 * 1024 * 1024 });
    };

    GitAdapter.prototype.push = function (root, remote, branch) {
        var args = ["push"];
        if (remote) args.push("-u", remote, branch);
        else args.push("--set-upstream", "origin", branch);
        return this.exec(root, args, { timeout: 120000, maxBuffer: 16 * 1024 * 1024 });
    };

    GitAdapter.prototype.fastForward = function (root, upstream) {
        return this.exec(root, ["merge", "--ff-only", upstream], { timeout: 120000, maxBuffer: 16 * 1024 * 1024 });
    };

    GitAdapter.prototype.diff = function (root, filePath) {
        var args = ["-c", "core.quotePath=false", "diff", "--no-ext-diff", "--unified=3", "HEAD"];
        if (filePath) args.push("--", filePath);
        return this.exec(root, args, { timeout: 60000, maxBuffer: 32 * 1024 * 1024 });
    };

    /* 供双栏比较使用的零上下文 patch；行级布局由视图层按 hunk 构造。 */
    GitAdapter.prototype.diffPatch = function (root, oldPath, worktreePath) {
        var args = ["-c", "core.quotePath=false", "diff", "--no-ext-diff", "--no-color", "--unified=0", "--find-renames", "HEAD", "--"];
        if (oldPath) args.push(oldPath);
        if (worktreePath && worktreePath !== oldPath) args.push(worktreePath);
        return this.exec(root, args, { timeout: 60000, maxBuffer: 32 * 1024 * 1024 });
    };

    /* 从指定快照到当前工作区的零上下文 patch，供“快照｜工作区”比较使用。 */
    GitAdapter.prototype.revisionWorktreeDiffPatch = function (root, revision, filePath) {
        var args = ["-c", "core.quotePath=false", "diff", "--no-ext-diff", "--no-color", "--unified=0", "--find-renames", revision, "--"];
        if (filePath) args.push(filePath);
        return this.exec(root, args, { timeout: 60000, maxBuffer: 32 * 1024 * 1024 });
    };

    GitAdapter.prototype.log = function (root, limit) {
        return this.exec(root, ["-c", "core.quotePath=false", "log", "-n", String(limit || 20), "--date=iso", "--pretty=format:%H%x1f%an%x1f%ad%x1f%s"], { timeout: 30000, maxBuffer: 8 * 1024 * 1024 }).then(function (r) {
            if (!r.success) return r;
            r.commits = parseLog(r.output);
            return r;
        });
    };

    /* 返回某个快照直接改动过的文件；--root 令第一个提交也能正常列出新增文件。 */
    GitAdapter.prototype.commitFiles = function (root, revision) {
        return this.exec(root, ["-c", "core.quotePath=false", "diff-tree", "--root", "--no-commit-id", "--name-status", "-r", "-M", revision], { timeout: 30000, maxBuffer: 16 * 1024 * 1024 }).then(function (result) {
            if (!result.success) return result;
            return { success: true, files: parseCommitFiles(result.output) };
        });
    };

    /* rev-list 对根提交也会成功返回，因此无需依赖失败文本判断“没有父提交”。 */
    GitAdapter.prototype.commitParent = function (root, revision) {
        return this.exec(root, ["rev-list", "--parents", "-n", "1", revision], { timeout: 10000 }).then(function (result) {
            if (!result.success) return result;
            var parts = String(result.output || "").trim().split(/\s+/);
            return { success: true, parent: parts.length > 1 ? parts[1] : null };
        });
    };

    /* 比较两个快照的零上下文 patch，首个提交使用 --root 与空树比较。 */
    GitAdapter.prototype.commitDiffPatch = function (root, parent, revision, oldPath, newPath) {
        var args = ["-c", "core.quotePath=false", "diff", "--no-ext-diff", "--no-color", "--unified=0", "--find-renames"];
        if (parent) args.push(parent, revision);
        else args.push("--root", revision);
        args.push("--");
        if (oldPath) args.push(oldPath);
        if (newPath && newPath !== oldPath) args.push(newPath);
        return this.exec(root, args, { timeout: 60000, maxBuffer: 32 * 1024 * 1024 });
    };

    GitAdapter.prototype.show = function (root, revision, filePath) {
        return this.exec(root, ["show", revision + ":" + filePath], { timeout: 60000, maxBuffer: 32 * 1024 * 1024 });
    };

    /* 统一校验工作区内的相对路径，恢复操作绝不允许越出当前仓库。 */
    function resolveWorktreePath(root, filePath) {
        if (!root || !filePath) return null;
        var base = path.resolve(root);
        var target = path.resolve(base, String(filePath));
        var relative = path.relative(base, target);
        if (!relative || relative === ".." || relative.indexOf(".." + path.sep) === 0 || path.isAbsolute(relative)) return null;
        return target;
    }

    GitAdapter.prototype.readWorktreeFile = function (root, filePath) {
        return new Promise(function (resolve) {
            try {
                var target = resolveWorktreePath(root, filePath);
                if (!target) return resolve({ success: false, error: "文件路径不在当前工作区内" });
                fs.readFile(target, "utf8", function (error, content) {
                    if (error) {
                        if (error.code === "ENOENT") return resolve({ success: true, missing: true, output: "" });
                        return resolve({ success: false, error: error.message || "无法读取工作区文件" });
                    }
                    resolve({ success: true, missing: false, output: String(content || "") });
                });
            } catch (e) {
                resolve({ success: false, error: e.message || "无法读取工作区文件" });
            }
        });
    };

    /* 同目录临时文件 + rename，避免恢复途中留下半写入的 Markdown 文件。 */
    GitAdapter.prototype.writeWorktreeFile = function (root, filePath, content) {
        return new Promise(function (resolve) {
            var target = resolveWorktreePath(root, filePath);
            if (!target) return resolve({ success: false, error: "文件路径不在当前工作区内" });
            var temp = target + ".bettertypora-restore-" + Date.now() + "-" + Math.floor(Math.random() * 1000000);
            fs.mkdir(path.dirname(target), { recursive: true }, function (mkdirError) {
                if (mkdirError) return resolve({ success: false, error: mkdirError.message || "无法创建目标目录" });
                fs.writeFile(temp, String(content == null ? "" : content), "utf8", function (writeError) {
                    if (writeError) return resolve({ success: false, error: writeError.message || "无法写入恢复文件" });
                    fs.rename(temp, target, function (renameError) {
                        if (!renameError) return resolve({ success: true, path: target });
                        fs.unlink(temp, function () {
                            resolve({ success: false, error: renameError.message || "无法替换工作区文件" });
                        });
                    });
                });
            });
        });
    };

    /* 仅删除单个文件；目录、工作区根目录和越界路径都会被拒绝。 */
    GitAdapter.prototype.removeWorktreeFile = function (root, filePath) {
        return new Promise(function (resolve) {
            var target = resolveWorktreePath(root, filePath);
            if (!target) return resolve({ success: false, error: "文件路径不在当前工作区内" });
            fs.unlink(target, function (error) {
                if (!error) return resolve({ success: true, path: target, missing: false });
                if (error.code === "ENOENT") return resolve({ success: true, path: target, missing: true });
                resolve({ success: false, error: error.message || "无法删除工作区文件" });
            });
        });
    };

    function parseStatus(output) {
        var result = { branch: "", upstream: "", ahead: 0, behind: 0, files: [] };
        var lines = (output || "").split("\n");
        for (var i = 0; i < lines.length; i++) {
            var line = lines[i];
            if (!line) continue;
            if (line.indexOf("## ") === 0) {
                var header = line.substring(3);
                var tracking = header.indexOf("...");
                if (tracking >= 0) {
                    result.branch = header.substring(0, tracking);
                    header = header.substring(tracking + 3);
                    var bracket = header.indexOf(" [");
                    result.upstream = bracket >= 0 ? header.substring(0, bracket) : header;
                } else {
                    var bracketOnly = header.indexOf(" [");
                    result.branch = bracketOnly >= 0 ? header.substring(0, bracketOnly) : header;
                    var noCommit = result.branch.match(/^No commits yet on (.+)$/);
                    if (noCommit) result.branch = noCommit[1];
                }
                var ahead = line.match(/ahead (\d+)/);
                var behind = line.match(/behind (\d+)/);
                result.ahead = ahead ? parseInt(ahead[1], 10) : 0;
                result.behind = behind ? parseInt(behind[1], 10) : 0;
                continue;
            }
            if (line.length >= 3) {
                var code = line.substring(0, 2);
                var file = line.substring(3);
                if (file.indexOf('"') === 0) file = file.replace(/^"|"$/g, "");
                var arrow = file.indexOf(" -> ");
                result.files.push({ code: code, path: arrow >= 0 ? file.substring(arrow + 4) : file, previousPath: arrow >= 0 ? file.substring(0, arrow) : null });
            }
        }
        return result;
    }

    function parseLog(output) {
        var commits = [];
        var lines = (output || "").split("\n");
        for (var i = 0; i < lines.length; i++) {
            var parts = lines[i].split("\x1f");
            if (parts.length >= 4) commits.push({ hash: parts[0], author: parts[1], date: parts[2], message: parts.slice(3).join("\x1f") });
        }
        return commits;
    }

    function parseCommitFiles(output) {
        var files = [];
        var lines = String(output || "").split("\n");
        for (var i = 0; i < lines.length; i++) {
            if (!lines[i]) continue;
            var parts = lines[i].split("\t");
            var code = parts[0] || "M";
            var renamed = /^(R|C)/.test(code);
            var oldPath = renamed ? parts[1] : null;
            var filePath = renamed ? parts[2] : parts[1];
            if (!filePath) continue;
            files.push({ code: code, path: filePath, previousPath: oldPath });
        }
        return files;
    }

    if (typeof module !== "undefined") module.exports = GitAdapter;
})();
