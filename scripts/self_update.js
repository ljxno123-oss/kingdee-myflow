#!/usr/bin/env node
/**
 * 自更新模块：运行前检查 GitHub 远程仓库是否有新版本，若有则拉取到最新，再继续运行。
 *
 * 用法：
 *   node self_update.js            # 检查 + 自动更新（默认），打印 [self-update] 日志
 *   node self_update.js --check    # 仅检查，不更新；退出码 0=已最新，1=有新版本，2=检查失败
 *   node self_update.js --json     # 输出一行 JSON 结果，供上层程序解析
 *   node self_update.js --off      # 跳过自更新（离线/禁止更新时用）
 *
 * 退出码：0 已最新或已更新；1 有新版本但未应用（--check 模式）；2 检查失败（网络等，不阻塞主流程）。
 *
 * 说明：
 * - 通过 `git ls-remote` 读取远程 HEAD（只读、不触碰本地工作区），与本地 HEAD 对比。
 * - 落后时 `git pull --ff-only`（仅快进，绝不产生合并/覆盖本地未提交改动）。
 * - 更新成功且依赖清单有变化时，按需 `npm i`（scripts 与 mcp 两个 package.json）。
 * - 任何失败都只降级、不抛出，绝不让自更新阻塞主流程。
 */
const { execFileSync, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.join(__dirname, '..');
const UPDATE_LOG_PREFIX = '[self-update]';

const args = process.argv.slice(2);
const CHECK_ONLY = args.includes('--check');
const AS_JSON = args.includes('--json');
const OFF = args.includes('--off');

function log(msg) {
  if (!AS_JSON) console.log(`${UPDATE_LOG_PREFIX} ${msg}`);
}

function run(cmd, argv, opts = {}) {
  const r = spawnSync(cmd, argv, {
    cwd: opts.cwd || REPO_ROOT,
    encoding: 'utf8',
    timeout: opts.timeout || 30000,
    env: { ...process.env, ...(opts.env || {}) },
    shell: process.platform === 'win32', // 让 spawn 能正确解析 git/npm 命令
  });
  return {
    code: r.status,
    out: (r.stdout || '').trim(),
    err: (r.stderr || '').trim(),
    error: r.error ? String(r.error) : null,
  };
}

function fail(msg) {
  log(`跳过：${msg}`);
  return { updated: false, skipped: true, reason: msg, latest: null, from: null, to: null };
}

function emit(result) {
  if (AS_JSON) console.log(JSON.stringify(result));
  return result;
}

function main() {
  if (OFF) {
    const r = { updated: false, skipped: true, reason: 'off' };
    log('自更新已关闭（--off）');
    return emit(r);
  }

  // 1. 确认在 git 仓库内
  if (!fs.existsSync(path.join(REPO_ROOT, '.git'))) {
    return emit(fail('不是 git 仓库，跳过自更新'));
  }

  // 2. 读取远程 HEAD（只读，不触碰本地）
  const remote = run('git', ['ls-remote', 'origin', 'HEAD']);
  if (remote.code !== 0) {
    return emit(fail(`读取远程失败：${remote.err || remote.error || '无网络/无远程'}`));
  }
  const remoteHead = (remote.out.match(/^([0-9a-f]{40})\s/) || [])[1];
  if (!remoteHead) {
    return emit(fail('解析远程 HEAD 失败'));
  }

  // 3. 读取本地 HEAD
  const local = run('git', ['rev-parse', 'HEAD']);
  if (local.code !== 0) {
    return emit(fail('读取本地 HEAD 失败：' + local.err));
  }
  const localHead = local.out;

  // 4. 版本一致 → 无需更新
  if (remoteHead === localHead) {
    log(`已是最新版本 ${localHead.slice(0, 7)}`);
    const r = { updated: false, latest: true, from: localHead, to: localHead };
    return emit(r);
  }

  // 5. 有更新
  if (CHECK_ONLY) {
    log(`发现新版本：${localHead.slice(0, 7)} → ${remoteHead.slice(0, 7)}（--check 模式，未更新）`);
    const r = { updated: false, latest: false, from: localHead, to: remoteHead };
    return emit(r);
  }

  log(`发现新版本：${localHead.slice(0, 7)} → ${remoteHead.slice(0, 7)}，开始更新…`);

  // 6. 拉取（仅快进，安全）
  const fetch = run('git', ['fetch', 'origin', '--quiet', '--prune']);
  if (fetch.code !== 0) {
    return emit(fail(`git fetch 失败：${fetch.err || fetch.error}`));
  }
  const pull = run('git', ['pull', '--ff-only', 'origin', 'HEAD']);
  if (pull.code !== 0) {
    return emit(fail(`git pull --ff-only 失败：${pull.err || pull.error}`));
  }

  // 7. 确认更新后 HEAD
  const after = run('git', ['rev-parse', 'HEAD']);
  const to = after.code === 0 ? after.out : remoteHead;

  // 8. 依赖清单变化则重装依赖
  let deps = [];
  const depPaths = [
    path.join(REPO_ROOT, 'scripts', 'package.json'),
    path.join(REPO_ROOT, 'mcp', 'package.json'),
  ];
  for (const p of depPaths) {
    if (!fs.existsSync(p)) continue;
    // 用 git diff 判断本次更新是否改动了 package.json
    const diff = run('git', ['diff', '--name-only', localHead, to, '--', p.replace(REPO_ROOT + path.sep, '').replace(/\\/g, '/')]);
    if (diff.code === 0 && diff.out) {
      const dir = path.dirname(p);
      log(`依赖清单已变化，重新安装 ${path.basename(dir)} 依赖…`);
      const npm = run('npm', ['install', '--no-audit', '--no-fund'], { cwd: dir, timeout: 120000 });
      if (npm.code !== 0) {
        log(`依赖安装失败（不影响继续运行）：${npm.err || npm.error}`);
      } else {
        deps.push(dir);
      }
    }
  }

  log(`更新完成：${localHead.slice(0, 7)} → ${to.slice(0, 7)}`);
  const r = {
    updated: true,
    latest: true,
    from: localHead,
    to,
    depsInstalled: deps,
  };
  return emit(r);
}

const result = main();
if (CHECK_ONLY) {
  process.exit(result.latest ? 0 : 1);
}
process.exit(result.updated ? 0 : 0); // 检查失败也以 0 退出，不阻塞调用方
