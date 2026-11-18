#!/usr/bin/env node
/**
 * 金蝶云星空「我的流程」MCP Server（stdio 传输）
 *
 * 复用 ../scripts/ 下的抓取脚本（kd_myflow.js / parse_flow.js / notify_dingtalk.sh），
 * 暴露两个工具：
 *   1. query_myflow      —— 登录金蝶、抓取「信息中心 → 我的流程」，返回当前处理人与停留时长（JSON）。
 *   2. send_dingtalk     —— 把报告文本经钉钉发送给指定接收人（默认取 config.json 配置）。
 *
 * 凭据：从 ../scripts/config.json 读取（user / pass / datacenter），不落盘在本目录。
 * 验证码：抓取采用文件握手，由 MCP 客户端/用户在会话中识别 4 位字符后回填。
 *
 * 用法（作为 MCP Server 启动）：
 *   node server.js           # stdio
 *   node server.js --help
 */
const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  McpError,
  ErrorCode,
} = require('@modelcontextprotocol/sdk/types.js');

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const HERE = __dirname;
const SCRIPTS = path.join(HERE, '..', 'scripts');
const KD = path.join(SCRIPTS, 'kd_myflow.js');
const PARSE = path.join(SCRIPTS, 'parse_flow.js');
const NOTIFY = path.join(SCRIPTS, 'notify_dingtalk.sh');
const NOTIFY_OVERDUE = path.join(SCRIPTS, 'notify_overdue.js');
const SELF_UPDATE = path.join(SCRIPTS, 'self_update.js');
const CONFIG = path.join(SCRIPTS, 'config.json');
const CREDENTIALS = path.join(SCRIPTS, 'credentials.json');

const help = process.argv.includes('--help');
if (help) {
  console.log('kingdee-myflow-mcp — stdio MCP Server');
  console.log('工具：query_myflow, send_dingtalk');
  process.exit(0);
}

// ---------- 工具定义 ----------
const TOOLS = [
  {
    name: 'query_myflow',
    description:
      '登录金蝶云星空（珠海英搏尔），抓取「信息中心 → 我的流程」运行中流程的当前节点、当前处理人与停留时长（任务到达时间 → 取数时刻）。只读，不含审批。',
    inputSchema: {
      type: 'object',
      properties: {
        captcha: {
          type: 'string',
          description:
            '验证码（4 位字母/数字）。首次调用可先传空或省略，返回结果里会带 captchaPath 与提示；随后再传识别出的 4 位字符重试。',
        },
        user: {
          type: 'string',
          description:
            '金蝶用户名。可选：省略时优先读取 scripts/credentials.json。若 credentials.json 不存在，则必须传 user/pass。',
        },
        pass: {
          type: 'string',
          description:
            '金蝶密码。可选：省略时优先读取 scripts/credentials.json。若 credentials.json 不存在，则必须传 user/pass。',
        },
      },
    },
  },
  {
    name: 'send_dingtalk',
    description:
      '把「我的流程」报告文本通过钉钉单聊发送。省略 receiver 时自动发给当前 dws 登录用户本人；传 receiver 则发给指定人（openDingTalkId 或 userId）。',
    inputSchema: {
      type: 'object',
      properties: {
        report: { type: 'string', description: '要发送的报告文本（如 query_myflow 返回的 report 字段）。' },
        receiver: {
          type: 'string',
          description:
            '接收人：openDingTalkId（非纯数字，通常以 D 开头）或钉钉 userId（纯数字）。省略则自动发给当前登录用户本人。',
        },
      },
      required: ['report'],
    },
  },
  {
    name: 'save_credentials',
    description:
      '保存金蝶云星空登录凭据（用户名/密码）到本地 credentials.json，供后续 query_myflow 免输凭据使用。首次运行时由客户端弹框收集后调用本工具落盘。',
    inputSchema: {
      type: 'object',
      properties: {
        user: { type: 'string', description: '金蝶用户名。' },
        pass: { type: 'string', description: '金蝶密码。' },
      },
      required: ['user', 'pass'],
    },
  },
  {
    name: 'notify_overdue',
    description:
      '把停留超过阈值（默认 4 小时，可用 hours 覆盖）的未处理流程，按当前处理人分组，逐个通过钉钉发送催办通知。需要先运行 query_myflow 抓取数据。若处理人存在同名，会通过钉钉通知使用者本人判断，而不是擅自发送。',
    inputSchema: {
      type: 'object',
      properties: {
        hours: { type: 'number', description: '超时阈值（小时），默认 4。' },
        dryRun: { type: 'boolean', description: '为 true 时只预览不实际发送，默认 false。' },
        only: { type: 'string', description: '可选：只通知指定的人（逗号分隔姓名），省略则通知所有超时处理人。' },
        map: { type: 'string', description: '可选：同名时指定目标账号，形如 "姓名=userId或openDingTalkId"，多人逗号分隔。' },
      },
    },
  },
  {
    name: 'update_self',
    description:
      '手动检查 GitHub 远程仓库是否有新版本，有则拉取到最新并重装依赖，再返回更新结果。MCP 每次启动时也会自动执行一次同样的检查。',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
];

// ---------- 工具函数 ----------
function loadConfig() {
  if (!fs.existsSync(CONFIG)) return {};
  try {
    return JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
  } catch (e) {
    return {};
  }
}

/** 读取凭据（user/pass），优先 credentials.json，其次 config.json（兼容旧版） */
function loadCredentials() {
  if (fs.existsSync(CREDENTIALS)) {
    try {
      const c = JSON.parse(fs.readFileSync(CREDENTIALS, 'utf8'));
      if (c.user && c.pass) return { user: c.user, pass: c.pass };
    } catch (e) {}
  }
  const cfg = loadConfig();
  if (cfg.user && cfg.pass) return { user: cfg.user, pass: cfg.pass };
  return null;
}

/** 保存凭据到 credentials.json（由 WorkBuddy 客户端在弹框收集后调用/写入） */
function saveCredentials(user, pass) {
  fs.writeFileSync(CREDENTIALS, JSON.stringify({ user, pass }, null, 2), 'utf8');
  return { user, pass, saved: true, path: CREDENTIALS };
}

/** 读 config.json 中某项 */
function cfgGet(key) {
  const c = loadConfig();
  return c[key] || '';
}

/**
 * 自更新：启动时（与手动触发 update_self 工具时）检查 GitHub 远程是否有新版本，
 * 有则 pull 到最新并重装依赖，再继续。返回结构化结果；失败只降级、不阻塞主流程。
 * 用 --json 让 self_update 只输出一行 JSON，避免 git 日志污染 stdio 协议。
 */
function selfUpdate() {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SELF_UPDATE, '--json'], {
      cwd: SCRIPTS,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d.toString()));
    child.stderr.on('data', (d) => (err += d.toString()));
    const timer = setTimeout(() => {
      try { child.kill(); } catch (e) {}
      resolve({ updated: false, skipped: true, reason: 'self-update timeout', error: '[timeout]' });
    }, 60000);
    child.on('close', (code) => {
      clearTimeout(timer);
      let parsed = null;
      try { parsed = JSON.parse(out.trim()); } catch (e) {}
      if (!parsed) {
        parsed = { updated: false, skipped: true, reason: 'parse failed', raw: (out || err).slice(-500) };
      }
      parsed.exitCode = code;
      resolve(parsed);
    });
  });
}

function runNode(script, args, opts = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script, ...args], {
      cwd: SCRIPTS,
      env: { ...process.env, ...(opts.env || {}) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d.toString()));
    child.stderr.on('data', (d) => (err += d.toString()));
    const timer = setTimeout(() => {
      try { child.kill(); } catch (e) {}
      resolve({ code: 124, out, err: err + '\n[timeout]' });
    }, opts.timeout || 300000);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, out, err });
    });
  });
}

/**
 * 解析抓取脚本输出目录下的结果文件。
 */
function readResults(outDir) {
  const dataPath = path.join(outDir, 'flow_data.json');
  const reportPath = path.join(outDir, 'flow_report.txt');
  const capPath = path.join(outDir, 'captcha.png');
  const data = fs.existsSync(dataPath) ? JSON.parse(fs.readFileSync(dataPath, 'utf8')) : null;
  const report = fs.existsSync(reportPath) ? fs.readFileSync(reportPath, 'utf8') : '';
  return {
    data,
    report,
    captchaPath: fs.existsSync(capPath) ? capPath : null,
  };
}

// ---------- 工具执行 ----------
async function toolQueryMyflow(args) {
  args = args || {};
  // 解析凭据：优先调用方传入的 user/pass，其次 credentials.json / config.json
  let cred = null;
  const argUser = (args.user || '').trim();
  const argPass = (args.pass || '').trim();
  if (argUser && argPass) {
    cred = { user: argUser, pass: argPass };
    // 首次由客户端弹框收集后回传，同时落盘，后续免输
    saveCredentials(argUser, argPass);
  } else {
    cred = loadCredentials();
  }
  if (!cred || !cred.user || !cred.pass) {
    // 返回明确的“需要凭据”状态，由 WorkBuddy 客户端弹框收集后回传 user/pass
    return {
      status: 'need_credentials',
      message:
        '尚未配置金蝶凭据。请 WorkBuddy 客户端弹框收集用户名与密码后，作为 user/pass 参数重试本工具（或先运行 skill 由弹框收集并写入 credentials.json）。',
    };
  }

  // 用临时目录作为输出目录，避免污染 scripts 目录
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kd-mcp-'));

  // 若调用方直接提供了验证码，先写入 captcha.txt，脚本登录时直接读取
  const captcha = (args.captcha || '').trim();
  if (captcha) {
    fs.writeFileSync(path.join(outDir, 'captcha.txt'), captcha, 'utf8');
  }

  const res = await runNode(KD, [], {
    env: { KD_OUT: outDir, KD_USER: cred.user, KD_PASS: cred.pass },
    timeout: 420000, // 登录 + 抓取最长 7 分钟（含等待验证码）
  });

  const results = readResults(outDir);
  const logLines = (res.out || '').split('\n').filter((l) => l.includes('[kd]'));

  // 登录失败
  if (res.code === 3 || /LOGIN_FAILED/.test(res.out)) {
    const errLine = logLines.find((l) => /账号|密码|状态异常/.test(l)) || '';
    throw new McpError(ErrorCode.InternalError, '金蝶登录失败：' + (errLine || '请检查账号/密码/数据中心/验证码'));
  }
  // 缺验证码（脚本还在等，但我们已非阻塞返回）
  const waiting = logLines.find((l) => /等待 captcha.txt 超时/.test(l));
  const capSaved = logLines.filter((l) => /captcha_saved/.test(l)).pop() || '';

  if (!results.data && capSaved) {
    // 有验证码但尚未完成——返回验证码路径让客户端识别
    const capPath = (capSaved.match(/captcha_saved (\S+)/) || [])[1];
    return {
      status: 'need_captcha',
      message: '请识别验证码图片后，用 4 位字符作为 captcha 参数重试。',
      captchaPath: capPath || results.captchaPath,
    };
  }
  if (!results.data) {
    throw new McpError(ErrorCode.InternalError, '抓取未产出结果。日志尾部：' + (logLines.slice(-3).join(' | ') || res.err.slice(-500)));
  }

  return {
    status: 'ok',
    fetchedAt: results.data.fetchedAt,
    updatedAt: results.data.updatedAt,
    flowCount: results.data.flowCount,
    peopleCount: results.data.peopleCount,
    people: results.data.people,
    flows: results.data.flows,
    report: results.report,
    outDir,
  };
}

async function toolSendDingtalk(args) {
  const report = (args.report || '').trim();
  if (!report) {
    throw new McpError(ErrorCode.InvalidRequest, 'report 不能为空。');
  }
  const receiver = (args.receiver || '').trim();

  // 写临时报告文件
  const tmp = path.join(os.tmpdir(), 'kd-report-' + Date.now() + '.txt');
  fs.writeFileSync(tmp, report, 'utf8');

  const cmdArgs = [NOTIFY, tmp];
  if (receiver) cmdArgs.push(receiver);

  const res = await new Promise((resolve) => {
    const child = spawn('bash', cmdArgs, { cwd: SCRIPTS, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d.toString()));
    child.stderr.on('data', (d) => (err += d.toString()));
    const timer = setTimeout(() => { try { child.kill(); } catch (e) {}; resolve({ code: 124, out, err: err + '\n[timeout]' }); }, 60000);
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, out, err }); });
  });

  try { fs.unlinkSync(tmp); } catch (e) {}

  if (res.code !== 0) {
    throw new McpError(ErrorCode.InternalError, '钉钉发送失败：' + (res.err || res.out).slice(-500));
  }

  // 尝试从返回 JSON 提取 openTaskId / openMessageId
  let detail = {};
  try {
    detail = JSON.parse(res.out);
  } catch (e) {
    detail = { raw: res.out.slice(-500) };
  }

  return {
    status: 'ok',
    message: '报告已发送到钉钉。',
    receiver: receiver || '自己（当前 dws 登录用户）',
    detail,
  };
}

async function toolNotifyOverdue(args) {
  args = args || {};
  const cmdArgs = [NOTIFY_OVERDUE];
  if (args.hours) cmdArgs.push('--hours', String(args.hours));
  if (args.dryRun) cmdArgs.push('--dry-run');
  if (args.only) cmdArgs.push('--only', String(args.only));
  if (args.map) cmdArgs.push('--map', String(args.map));

  const res = await runNode(NOTIFY_OVERDUE, cmdArgs.slice(1), {
    timeout: 180000, // 逐人解析 + 发送，留足时间
  });

  if (res.code !== 0) {
    throw new McpError(ErrorCode.InternalError, '超时催办失败：' + (res.err || res.out).slice(-500));
  }
  return {
    status: 'ok',
    dryRun: !!args.dryRun,
    hours: args.hours || 4,
    output: res.out.trim(),
  };
}

// ---------- 启动 MCP ----------
async function main() {
  // 启动时先自更新到最新版本（失败只降级，不阻塞）
  const upd = await selfUpdate();
  if (upd.updated) {
    // 更新后自身代码可能已变化，但 stdio 进程已在本版本内存中运行，不影响本次会话；
    // 下次启动将使用新代码。这里仅记录，供日志排查。
  }

  const server = new Server(
    { name: 'kingdee-myflow-mcp', version: '1.0.0' },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    try {
      if (name === 'query_myflow') {
        const result = await toolQueryMyflow(args || {});
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      }
      if (name === 'send_dingtalk') {
        const result = await toolSendDingtalk(args || {});
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      }
      if (name === 'save_credentials') {
        const u = (args && args.user || '').trim();
        const p = (args && args.pass || '').trim();
        if (!u || !p) throw new McpError(ErrorCode.InvalidRequest, 'user 和 pass 均不能为空。');
        const saved = saveCredentials(u, p);
        return { content: [{ type: 'text', text: JSON.stringify({ status: 'ok', message: '凭据已保存到 credentials.json。', ...saved }, null, 2) }] };
      }
      if (name === 'notify_overdue') {
        const result = await toolNotifyOverdue(args || {});
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      }
      if (name === 'update_self') {
        const result = await selfUpdate();
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      }
      throw new McpError(ErrorCode.MethodNotFound, `未知工具: ${name}`);
    } catch (e) {
      if (e instanceof McpError) throw e;
      throw new McpError(ErrorCode.InternalError, String(e && e.message ? e.message : e));
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stdio 模式下保持运行
}

main().catch((e) => {
  console.error('MCP server 启动失败:', e);
  process.exit(1);
});
