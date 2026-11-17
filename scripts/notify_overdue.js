#!/usr/bin/env node
/**
 * 金蝶「我的流程」超时催办通知
 *
 * 读取 flow_data.json，筛选停留时长超过阈值的节点，按「当前处理人」分组，
 * 通过钉钉通讯录把中文姓名解析成 openDingTalkId，再逐人发送催办通知。
 *
 * 用法：
 *   node notify_overdue.js                       # 用 config.json 的 overdueHours（默认 4）
 *   node notify_overdue.js --hours 12            # 指定阈值（小时）
 *   node notify_overdue.js --dry-run             # 只预览，不实际发送
 *   node notify_overdue.js --data flow_data.json # 指定数据文件
 *   node notify_overdue.js --only 叶新,何梅娟     # 只通知指定的人（逗号分隔）
 *   node notify_overdue.js --map 何梅娟=177xxx,叶新=178xxx  # 同名时指定目标账号
 *
 * 说明：通知用 openDingTalkId 发送（dws contact user search 解析姓名获得）。
 *       解析不到钉钉账号的人会在结果里列出，但跳过不发送。
 *       若某姓名在钉钉通讯录中存在同名（多个精确匹配），不擅自选择，
 *       而是通过钉钉通知「使用者本人」，让其判断催办信息应发给谁；
 *       使用者可用 --map "姓名=userId或openDingTalkId" 指定后重跑。
 */
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const HERE = __dirname;
const DEFAULT_HOURS = 4;

// dws 真实入口：直接调 node 运行 dws.js，避免走 shell 导致多行 content 丢失
const DWS_JS = path.join(
  process.env.HOME || process.env.USERPROFILE,
  '.workbuddy', 'binaries', 'node', 'cli-connector-packages', 'node_modules',
  'dingtalk-workspace-cli', 'bin', 'dws.js'
);

function parseArgs(argv) {
  const o = { hours: null, dryRun: false, data: path.join(HERE, 'flow_data.json'), only: null, map: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--hours') o.hours = parseFloat(argv[++i]);
    else if (a === '--dry-run') o.dryRun = true;
    else if (a === '--data') o.data = argv[++i];
    else if (a === '--only') o.only = argv[++i].split(/[,，、]/).map((s) => s.trim()).filter(Boolean);
    else if (a === '--map') {
      o.map = {};
      argv[++i].split(/[,，]/).forEach((kv) => {
        const idx = kv.indexOf('=');
        if (idx > 0) o.map[kv.slice(0, idx).trim()] = kv.slice(idx + 1).trim();
      });
    }
  }
  return o;
}

function loadConfig() {
  const p = path.join(HERE, 'config.json');
  if (fs.existsSync(p)) {
    try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return {}; }
  }
  return {};
}

/** 拆多处理人 */
function splitPeople(s) {
  return (s || '').split(/[,，、;；\/]/).map((x) => x.trim()).filter(Boolean);
}

/** dws 命令统一入口：用 execFileSync + 数组参数，多行 content 完整保留 */
function dws(args) {
  try {
    const stdout = execFileSync('node', [DWS_JS, ...args], { encoding: 'utf8', maxBuffer: 1024 * 1024 * 10 });
    try { return { ok: true, json: JSON.parse(stdout) }; }
    catch (e) { return { ok: true, raw: stdout }; }
  } catch (e) {
    return { ok: false, err: (e.stderr || e.stdout || String(e)).slice(-300) };
  }
}

/** 判断目标 id 是纯数字（userId）还是 openDingTalkId（非纯数字，通常 D 开头） */
function isUserId(id) {
  return /^\d+$/.test(String(id).trim());
}

/**
 * 用 openDingTalkId 或 userId 发送单聊，返回 dws 结果。
 * 兼容性说明：dws 的 chat message send 走 Markdown 通道，换行最终被规范化为
 * Markdown 硬换行（行尾双空格），旧版钉钉客户端（如 7.0）对其渲染不佳会导致换行
 * 错乱。因此催办正文的每条流程信息已改为「单行 + ｜ 分隔」的结构（见 main 中
 * content 构建），即使换行失效，流程编号/节点/停留时长/实例也完整可读。
 * 这里对 content 不再做额外的换行转换，直接原样传递。
 */
function sendChat(target, title, content) {
  const args = ['chat', 'message', 'send', '--title', title, '--content', content, '--format', 'json'];
  if (isUserId(target)) args.push('--user', target);
  else args.push('--open-dingtalk-id', target);
  return dws(args);
}

/**
 * 姓名 → 候选人解析结果。
 * 返回 { candidates, exact }：exact=true 表示是精确 name 匹配；false 表示仅有近似匹配（可能错字/别称）。
 * 调用方据此决定：精确且唯一 → 直接发；否则 → 待确认。
 */
function resolveCandidates(name) {
  const r = dws(['contact', 'user', 'search', '--query', name, '--format', 'json']);
  if (!r.ok) return { candidates: [], exact: false };
  const list = (r.json && r.json.result) || [];
  if (!list.length) return { candidates: [], exact: false };
  const exact = list.filter((u) => u.name === name);
  const pick = exact.length ? exact : list;
  const candidates = pick.map((u) => ({
    name: u.name,
    openDingTalkId: u.openDingTalkId || null,
    userId: u.userId || null,
    title: u.title || '',
    nick: u.nick || '',
  }));
  return { candidates, exact: exact.length > 0 };
}

/** 获取当前 dws 登录用户的 userId（用于「发给使用者本人」） */
function getSelfUserId() {
  const r = dws(['profile', 'list', '--format', 'json']);
  if (!r.ok || !r.json) return null;
  const cp = r.json.currentProfile || '';
  // currentProfile 形如 "dingxxx:userId"，取冒号后的 userId
  const m = cp.match(/:(\d+)$/);
  if (m) return m[1];
  const prof = (r.json.profiles || [])[0];
  return (prof && prof.userId) || null;
}

function fmtDuration(ms) {
  const h = ms / 3600000;
  if (h >= 24) return (h / 24).toFixed(1) + '天';
  if (h >= 1) return h.toFixed(1) + '小时';
  return Math.round(ms / 60000) + '分钟';
}

function main() {
  const o = parseArgs(process.argv.slice(2));
  const cfg = loadConfig();
  const hours = o.hours != null ? o.hours : (cfg.overdueHours || DEFAULT_HOURS);
  const thresholdMs = hours * 3600 * 1000;

  if (!fs.existsSync(o.data)) {
    console.error('找不到数据文件: ' + o.data + '（请先运行 kd_myflow.js 抓取）');
    process.exit(1);
  }
  const data = JSON.parse(fs.readFileSync(o.data, 'utf8'));

  // 1) 遍历 flows[].nodes[]，筛选超时节点，按人分组
  const byPerson = new Map(); // name -> { nodes: [{flow, node, arrived, stayedMs}] }
  for (const f of data.flows || []) {
    for (const n of f.nodes || []) {
      if (n.stayedMs == null || n.stayedMs < thresholdMs) continue;
      for (const p of splitPeople(n.handler)) {
        if (!byPerson.has(p)) byPerson.set(p, []);
        byPerson.get(p).push({
          flow: f.name,
          instance: f.instance,
          node: n.node,
          arrived: n.arrived,
          stayedMs: n.stayedMs,
        });
      }
    }
  }

  // 2) 可选：只通知指定的人
  if (o.only) {
    for (const k of [...byPerson.keys()]) {
      if (!o.only.includes(k)) byPerson.delete(k);
    }
  }

  if (!byPerson.size) {
    console.log('没有超过 ' + hours + ' 小时的未处理流程，无需通知。');
    return;
  }

  const people = [...byPerson.entries()].map(([name, nodes]) => ({
    name,
    nodes: nodes.sort((a, b) => b.stayedMs - a.stayedMs),
    maxMs: Math.max(...nodes.map((n) => n.stayedMs)),
  })).sort((a, b) => b.maxMs - a.maxMs);

  console.log('阈值：' + hours + ' 小时；共 ' + people.length + ' 位超时处理人。\n');

  // 3) 逐人解析 + 发送
  const sent = [];
  const skipped = [];
  const ambiguous = []; // 同名待确认：{ name, content, candidates }
  for (const p of people) {
    const lines = [];
    lines.push('【金蝶流程催办】');
    lines.push('您好 ' + p.name + '，以下流程停留已超过 ' + hours + ' 小时，请尽快处理：');
    lines.push('');
    p.nodes.forEach((n, i) => {
      // 每条流程合并成一行，字段用 ｜ 分隔：即使旧版客户端换行渲染失效，信息也完整可读。
      // 编号用【N】避免被 Markdown 有序列表语法劫持（1. 2. 会被自动重编号）。
      lines.push('【' + (i + 1) + '】' + n.flow + '｜节点：' + n.node + '｜停留：' + fmtDuration(n.stayedMs) + '｜实例：' + n.instance);
      if (i < p.nodes.length - 1) lines.push(''); // 多条流程之间留空行，避免换行折叠后粘连
    });
    lines.push('');
    lines.push('请登录金蝶云星空及时处理，谢谢！');
    const content = lines.join('\n');

    if (o.dryRun) {
      sent.push({ name: p.name, dryRun: true, content });
      continue;
    }

    // 使用者通过 --map 显式指定了该姓名的目标账号
    let resolved = null;
    if (o.map && o.map[p.name]) {
      resolved = { openDingTalkId: o.map[p.name], userId: o.map[p.name], viaMap: true };
    } else {
      const rc = resolveCandidates(p.name);
      if (!rc.candidates.length) {
        skipped.push({ name: p.name, reason: '未在钉钉通讯录找到' });
        continue;
      }
      // 同名（≥2 个精确匹配）或仅有近似匹配（可能错字/别称）→ 都交给使用者判断
      if (rc.candidates.length > 1 || !rc.exact) {
        ambiguous.push({ name: p.name, content, candidates: rc.candidates });
        continue;
      }
      resolved = rc.candidates[0];
    }

    const send = sendChat(resolved.openDingTalkId, '金蝶流程催办提醒', content);
    if (send.ok) {
      sent.push({ name: p.name, openDingTalkId: resolved.openDingTalkId, ok: true });
    } else {
      skipped.push({ name: p.name, reason: '发送失败: ' + (send.err || '') });
    }
  }

  // 4) 同名待确认：通过钉钉通知使用者本人，让其判断发给谁
  if (ambiguous.length && !o.dryRun) {
    const selfId = getSelfUserId();
    if (selfId) {
      const msg = buildAmbiguousNotice(ambiguous, hours);
      sendChat(selfId, '金蝶催办：同名待确认', msg);
      console.log('\n有 ' + ambiguous.length + ' 位处理人存在同名，已通过钉钉通知你本人判断，未直接发送。');
    } else {
      console.log('\n有 ' + ambiguous.length + ' 位处理人存在同名（无法确定当前登录用户，未发送通知）。');
    }
  }

  console.log('=== 结果 ===');
  console.log('已发送 ' + sent.filter((s) => !s.dryRun).length + ' 人：');
  sent.forEach((s) => console.log('  - ' + s.name + (s.dryRun ? '（dry-run 预览）' : ' ✔')));
  if (ambiguous.length) {
    console.log('同名待确认 ' + ambiguous.length + ' 人（已跳过，需你指定）：');
    ambiguous.forEach((a) => {
      const opts = a.candidates.map((c) => `${c.name}${c.title ? '（' + c.title + '）' : ''}[${c.userId}]`).join(' / ');
      console.log('  - ' + a.name + ' → ' + opts);
    });
    console.log('  用 --map "' + ambiguous.map((a) => a.name + '=<userId或openDingTalkId>').join(',') + '" 指定后重跑。');
  }
  if (skipped.length) {
    console.log('跳过 ' + skipped.length + ' 人：');
    skipped.forEach((s) => console.log('  - ' + s.name + '（' + s.reason + '）'));
  }
}

/** 构造「同名待确认」通知文案 */
function buildAmbiguousNotice(ambiguous, hours) {
  const L = [];
  L.push('【金蝶催办 · 同名待确认】');
  L.push('以下处理人在钉钉通讯录中存在同名，请你判断催办信息应发给谁：');
  L.push('');
  ambiguous.forEach((a, i) => {
    L.push((i + 1) + '. ' + a.name + '（停留超 ' + hours + ' 小时）');
    L.push('   待办：' + a.content.split('\n').slice(2, -1).filter((x) => x.trim() && !x.startsWith('请登录')).join('；'));
    L.push('   候选人：');
    a.candidates.forEach((c, j) => {
      L.push('     ' + (j + 1) + ') ' + c.name + (c.title ? ' · ' + c.title : '') + '（userId: ' + c.userId + '）');
    });
    L.push('');
  });
  L.push('确认后，可重新运行并指定：');
  L.push('node notify_overdue.js --map "' + ambiguous.map((a) => a.name + '=<目标userId>').join(',') + '"');
  return L.join('\n');
}

main();
