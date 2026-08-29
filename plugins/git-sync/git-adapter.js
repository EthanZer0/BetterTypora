/* Git 适配层：只负责调用和解析 Git，不知道 Typora、状态栏或面板。 */
(function () {
    "use strict";

    var childProcess = reqnode("child_process");
    var fs = reqnode("fs");
    var os = reqnode("os");
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

    GitAdapter.prototype.status = function (root, pathspecs) {
        // -z 以 NUL 分隔路径，可保留中文、空格、引号和重命名的原始文件名。
        var args = ["-c", "core.quotePath=false", "status", "--porcelain=v1", "-z", "-b", "--untracked-files=all"];
        appendPathspecs(args, pathspecs);
        return this.exec(root, args, { timeout: 60000, maxBuffer: 32 * 1024 * 1024 }).then(function (result) {
            if (!result.success) return result;
            return { success: true, status: parseStatus(result.output), output: result.output };
        });
    };

    GitAdapter.prototype.remoteUrl = function (root, remote) {
        return this.exec(root, ["remote", "get-url", remote || "origin"], { timeout: 10000 });
    };

    GitAdapter.prototype.setRemote = function (root, remote, url) {
        var name = String(remote || "origin").trim() || "origin";
        var target = String(url || "").trim();
        if (!target) return Promise.resolve({ success: false, error: "请填写远程仓库地址" });
        var self = this;
        return this.exec(root, ["remote"], { timeout: 10000 }).then(function (result) {
            if (!result.success) return result;
            var names = String(result.output || "").split(/\s+/);
            var args = names.indexOf(name) >= 0 ? ["remote", "set-url", name, target] : ["remote", "add", name, target];
            return self.exec(root, args, { timeout: 15000 });
        });
    };

    /* 只检测常见默认密钥位置，不读取或返回私钥内容。 */
    GitAdapter.prototype.findSshKey = function () {
        var home = os.homedir ? os.homedir() : (process.env.USERPROFILE || process.env.HOME || "");
        var directory = path.join(home, ".ssh");
        var names = ["id_ed25519", "id_rsa", "id_ecdsa"];
        for (var i = 0; i < names.length; i++) {
            var privatePath = path.join(directory, names[i]);
            var publicPath = privatePath + ".pub";
            if (fs.existsSync(privatePath)) return { found: true, name: names[i], privatePath: privatePath, publicPath: publicPath, publicExists: fs.existsSync(publicPath) };
        }
        return { found: false, name: "id_ed25519", privatePath: path.join(directory, "id_ed25519"), publicPath: path.join(directory, "id_ed25519.pub"), publicExists: false };
    };

    /* 生成前由面板明确触发；绝不覆盖已有私钥。 */
    GitAdapter.prototype.generateSshKey = function (comment) {
        var self = this;
        var info = this.findSshKey();
        if (info.found) return Promise.resolve({ success: true, generated: false, info: info });
        return new Promise(function (resolve) {
            try {
                fs.mkdirSync(path.dirname(info.privatePath), { recursive: true, mode: 448 });
            } catch (mkdirError) {
                resolve({ success: false, error: "无法创建 SSH 密钥目录：" + mkdirError.message });
                return;
            }
            childProcess.execFile("ssh-keygen", ["-t", "ed25519", "-C", comment || "BetterTypora Git Sync", "-f", info.privatePath, "-N", ""], {
                env: copyEnv(),
                timeout: 30000,
                maxBuffer: 2 * 1024 * 1024,
                windowsHide: true
            }, function (error, stdout, stderr) {
                if (error) {
                    resolve({ success: false, error: String(stderr || error.message || "SSH 密钥生成失败").trim() });
                    return;
                }
                var next = self.findSshKey();
                resolve({ success: next.found, generated: true, info: next, error: next.found ? "" : "SSH 密钥生成后未找到文件" });
            });
        });
    };

    GitAdapter.prototype.readSshPublicKey = function (info) {
        var self = this;
        if (!info || !info.found) return Promise.resolve({ success: false, error: "未找到 SSH 私钥" });
        return new Promise(function (resolve) {
            fs.readFile(info.publicPath, "utf8", function (error, content) {
                if (!error && String(content || "").trim()) {
                    resolve({ success: true, publicKey: String(content).trim(), generated: false });
                    return;
                }
                /* 某些用户只保留了私钥：用 ssh-keygen 派生公钥到内存，不写回私钥。 */
                childProcess.execFile("ssh-keygen", ["-y", "-f", info.privatePath], { env: copyEnv(), timeout: 15000, maxBuffer: 1024 * 1024, windowsHide: true }, function (keyError, stdout, stderr) {
                    if (keyError || !String(stdout || "").trim()) {
                        resolve({ success: false, error: String(stderr || (keyError && keyError.message) || "无法读取 SSH 公钥").trim() });
                        return;
                    }
                    resolve({ success: true, publicKey: String(stdout).trim(), generated: false });
                });
            });
        });
    };

    GitAdapter.prototype.currentBranch = function (root) {
        return this.exec(root, ["branch", "--show-current"], { timeout: 10000 });
    };

    GitAdapter.prototype.addAll = function (root, pathspecs) {
        var args = ["add", "-A"];
        appendPathspecs(args, pathspecs);
        return this.exec(root, args, { timeout: 120000, maxBuffer: 32 * 1024 * 1024 });
    };

    GitAdapter.prototype.commit = function (root, message, pathspecs) {
        var args = ["commit", "-m", message];
        if (normalizePathspecs(pathspecs).length) {
            args.push("--only");
            appendPathspecs(args, pathspecs);
        }
        return this.exec(root, args, { timeout: 120000, maxBuffer: 8 * 1024 * 1024 });
    };

    GitAdapter.prototype.fetch = function (root, remote) {
        return this.exec(root, ["fetch", "--prune", remote || "origin"], remoteOptions(120000, 16 * 1024 * 1024));
    };

    GitAdapter.prototype.push = function (root, remote, branch) {
        var args = ["push"];
        if (remote) args.push("-u", remote, branch);
        else args.push("--set-upstream", "origin", branch);
        return this.exec(root, args, remoteOptions(120000, 16 * 1024 * 1024));
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

    GitAdapter.prototype.log = function (root, limit, pathspecs) {
        var args = ["-c", "core.quotePath=false", "log", "-n", String(limit || 20), "--date=iso", "--pretty=format:%H%x1f%an%x1f%ad%x1f%s"];
        appendPathspecs(args, pathspecs);
        return this.exec(root, args, { timeout: 30000, maxBuffer: 8 * 1024 * 1024 }).then(function (r) {
            if (!r.success) return r;
            r.commits = parseLog(r.output);
            return r;
        });
    };

    /* 返回某个快照直接改动过的文件；--root 令第一个提交也能正常列出新增文件。 */
    GitAdapter.prototype.commitFiles = function (root, revision, pathspecs) {
        var args = ["-c", "core.quotePath=false", "diff-tree", "--root", "--no-commit-id", "--name-status", "-z", "-r", "-M", revision];
        appendPathspecs(args, pathspecs);
        return this.exec(root, args, { timeout: 30000, maxBuffer: 16 * 1024 * 1024 }).then(function (result) {
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
        return this.exec(root, ["show", revision + ":" + filePath], { timeout: 60000, maxBuffer: 32 * 1024 * 1024 }).then(function (result) {
            if (result.success) result.binary = isLikelyBinary(result.output);
            return result;
        });
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
                fs.readFile(target, function (error, content) {
                    if (error) {
                        if (error.code === "ENOENT") return resolve({ success: true, missing: true, output: "" });
                        return resolve({ success: false, error: error.message || "无法读取工作区文件" });
                    }
                    if (isLikelyBinary(content)) return resolve({ success: true, missing: false, binary: true, output: "" });
                    resolve({ success: true, missing: false, binary: false, output: content.toString("utf8") });
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
        var entries = String(output || "").split("\0");
        for (var i = 0; i < entries.length; i++) {
            var entry = entries[i];
            if (!entry) continue;
            if (entry.indexOf("## ") === 0) {
                var header = entry.substring(3);
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
                var ahead = entry.match(/ahead (\d+)/);
                var behind = entry.match(/behind (\d+)/);
                result.ahead = ahead ? parseInt(ahead[1], 10) : 0;
                result.behind = behind ? parseInt(behind[1], 10) : 0;
                continue;
            }
            if (entry.length >= 3) {
                var code = entry.substring(0, 2);
                var file = entry.substring(3);
                var renamed = /[RC]/.test(code);
                // porcelain -z 对重命名按“新路径、旧路径”输出两个连续字段。
                var previousPath = renamed ? entries[++i] : null;
                if (!file) continue;
                result.files.push({ code: code, path: file, previousPath: previousPath || null });
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
        var entries = String(output || "").split("\0");
        for (var i = 0; i < entries.length; i++) {
            var code = entries[i] || "M";
            if (!entries[i]) continue;
            var renamed = /^(R|C)/.test(code);
            var oldPath = renamed ? entries[++i] : null;
            var filePath = entries[++i];
            if (!filePath) continue;
            files.push({ code: code, path: filePath, previousPath: oldPath });
        }
        return files;
    }

    function isLikelyBinary(value) {
        if (typeof Buffer !== "undefined" && Buffer.isBuffer && Buffer.isBuffer(value)) return value.indexOf(0) >= 0;
        return String(value || "").indexOf("\0") >= 0;
    }

    function normalizePathspecs(pathspecs) {
        if (!pathspecs) return [];
        var values = Array.isArray(pathspecs) ? pathspecs : [pathspecs];
        var result = [];
        for (var i = 0; i < values.length; i++) {
            var value = String(values[i] == null ? "" : values[i]).replace(/\\/g, "/");
            if (value && value !== ".") result.push(value);
        }
        return result;
    }

    /*
     * Typora 中没有可交互的 SSH 确认终端。accept-new 只接受“此前没有记录过”的
     * 指纹；如果已记录的主机指纹发生变化，OpenSSH 仍会拒绝连接，不能绕过安全校验。
     */
    function remoteOptions(timeout, maxBuffer) {
        return {
            timeout: timeout,
            maxBuffer: maxBuffer,
            env: { GIT_SSH_COMMAND: "ssh -o StrictHostKeyChecking=accept-new" }
        };
    }

    function appendPathspecs(args, pathspecs) {
        var values = normalizePathspecs(pathspecs);
        if (!values.length) return;
        args.push("--");
        for (var i = 0; i < values.length; i++) args.push(values[i]);
    }

    GitAdapter.parseStatus = parseStatus;
    GitAdapter.parseCommitFiles = parseCommitFiles;
    if (typeof module !== "undefined") module.exports = GitAdapter;
})();
