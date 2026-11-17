/**
 * 金蝶云星空「信息中心 → 我的流程」抓取
 *
 * 用法：
 *   node kd_myflow.js                # 完整流程：登录 → 我的流程 → 导出 JSON/报告
 *   node kd_myflow.js --parse-only flow_raw.json   # 只重新解析已抓取的原始数据
 *
 * 验证码：脚本把验证码截图写到 captcha.png，然后轮询 captcha.txt。
 *        由调用方（Agent 视觉识别或人工）把 4 位字符写入 captcha.txt 即可。
 */
const { chromium } = require('playwright-core');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const { parseFlows, buildReport } = require('./parse_flow');

const HERE = __dirname;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function loadCfg() {
  const base = { url: 'http://i.enpower.com:8600/k3cloud/html5/index.aspx', user: '', pass: '', datacenter: '珠海英搏尔', headless: true, outDir: HERE, captchaTimeoutSec: 360, useLocalOcr: true };
  // 1) 非敏感配置从 config.json 读
  let file = {};
  for (const p of [path.join(HERE, 'config.json'), path.join(HERE, '..', 'config.json')]) {
    if (fs.existsSync(p)) { file = JSON.parse(fs.readFileSync(p, 'utf8')); break; }
  }
  // 2) 敏感凭据优先从 credentials.json 读（独立文件，已 gitignore）
  let cred = {};
  for (const p of [path.join(HERE, 'credentials.json'), path.join(HERE, '..', 'credentials.json')]) {
    if (fs.existsSync(p)) {
      try { cred = JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { cred = {}; }
      break;
    }
  }
  const cfg = { ...base, ...file, ...cred };
  // 3) 环境变量可覆盖（优先级最高）
  if (process.env.KD_URL) cfg.url = process.env.KD_URL;
  if (process.env.KD_USER) cfg.user = process.env.KD_USER;
  if (process.env.KD_PASS) cfg.pass = process.env.KD_PASS;
  if (process.env.KD_DC) cfg.datacenter = process.env.KD_DC;
  if (process.env.KD_OUT) cfg.outDir = process.env.KD_OUT;
  if (process.env.KD_HEADLESS === '0') cfg.headless = false;
  if (process.env.KD_OCR === '0') cfg.useLocalOcr = false;
  if (!cfg.user || !cfg.pass) {
    console.error('缺少账号凭据：请在 scripts/credentials.json 填写 user/pass，或通过 KD_USER/KD_PASS 环境变量提供。首次运行请由 WorkBuddy 弹框收集后写入 credentials.json。');
    process.exit(2);
  }
  return cfg;
}

async function winText(page) {
  return page.evaluate(() => {
    const out = [];
    document.querySelectorAll('.k-window').forEach((w) => {
      if (w.getBoundingClientRect().width > 0) {
        const t = (w.innerText || '').replace(/\s+/g, ' ').trim();
        if (t) out.push(t.slice(0, 120));
      }
    });
    return out;
  });
}

/** 金蝶弹窗按钮是 <a class="k-button">，不能用 locator('button') 点 */
async function winClick(page, labels) {
  const r = await page.evaluate((labels) => {
    const wins = [...document.querySelectorAll('.k-window')].filter((w) => w.getBoundingClientRect().width > 0);
    for (let i = wins.length - 1; i >= 0; i--) {
      const btns = [...wins[i].querySelectorAll('a, div')].filter((e) => {
        const t = (e.innerText || '').trim();
        const b = e.getBoundingClientRect();
        return b.width > 0 && b.height > 0 && b.width < 260 && labels.indexOf(t) >= 0;
      });
      if (btns.length) { const a = btns.find((e) => e.tagName === 'A') || btns[0]; a.click(); return { ok: true, t: a.innerText.trim() }; }
    }
    return { ok: false };
  }, labels);
  await sleep(1500);
  return r;
}

/** dws 钉钉 CLI 真实入口（直接调 node 运行 dws.js，避免 shell 解析问题） */
const DWS_JS = path.join(
  process.env.HOME || process.env.USERPROFILE,
  '.workbuddy', 'binaries', 'node', 'cli-connector-packages', 'node_modules',
  'dingtalk-workspace-cli', 'bin', 'dws.js'
);

/** 获取当前 dws 登录用户的 userId（用于「发给使用者本人」） */
function getSelfUserId() {
  try {
    const out = execFileSync('node', [DWS_JS, 'profile', 'list', '--format', 'json'], { encoding: 'utf8', maxBuffer: 1024 * 1024 * 10 });
    const j = JSON.parse(out);
    const cp = j.currentProfile || '';
    const m = cp.match(/:(\d+)$/);
    if (m) return m[1];
    const prof = (j.profiles || [])[0];
    return (prof && prof.userId) || null;
  } catch (e) {
    return null;
  }
}

/** Windows 系统弹窗通知（非阻塞，用独立 wscript 进程弹 MsgBox） */
function notifyWindows(title, message) {
  if (process.platform !== 'win32') return false;
  try {
    // 用 VBScript MsgBox：最通用、无 .NET/COM 依赖、不被精简环境限制。
    // .vbs 以 UTF-16LE + BOM 写入，Windows 脚本宿主（wscript）能正确识别，中文不乱码。
    const vbsPath = path.join(os.tmpdir(), 'kd_kickoff_notify.vbs');
    const esc = (s) => String(s).replace(/"/g, '""');
    const body = 'MsgBox "' + esc(message.replace(/\r?\n/g, ' ')) + '", 48, "' + esc(title) + '"';
    // UTF-16LE BOM (FF FE) + utf16le 编码内容
    const bom = Buffer.from([0xff, 0xfe]);
    fs.writeFileSync(vbsPath, Buffer.concat([bom, Buffer.from(body, 'utf16le')]));
    const child = spawn('wscript', ['//nologo', vbsPath], { detached: true, stdio: 'ignore' });
    child.unref();
    return true;
  } catch (e) {
    return false;
  }
}

/** 钉钉通知（发给自己）：发送一条提醒消息 */
function notifyDingtalk(title, message) {
  try {
    const selfId = getSelfUserId();
    if (!selfId) return false;
    execFileSync('node', [DWS_JS, 'chat', 'message', 'send', '--user', selfId, '--title', title, '--content', message, '--format', 'json'], {
      encoding: 'utf8', maxBuffer: 1024 * 1024 * 10,
    });
    return true;
  } catch (e) {
    return false;
  }
}

/**
 * 踢下线提醒：当脚本需强制下线另一端登录会话时调用。
 * 同时用 Windows 弹窗 + 钉钉通知用户，避免用户不知情（自己的金蝶被登出）。
 */
function notifyKickoff(cfg, log) {
  const title = '金蝶云星空：账号已在别处登录';
  const msg = '金蝶流程查询工具检测到你的账号已在线，已强制下线上一会话并继续登录。\n\n如果你刚才正在用金蝶，说明它已被登出，属正常现象。';
  try {
    const w = notifyWindows(title, msg);
    const d = notifyDingtalk(title, msg.replace(/\n/g, ' '));
    log(`KICKOFF_NOTIFY windows=${w} dingtalk=${d}`);
  } catch (e) {
    log('KICKOFF_NOTIFY_FAILED ' + e.message);
  }
}

/**
 * 本地 OCR 识别验证码（ddddocr）。
 * 返回识别出的 4 位字符串；失败返回 null（此时回退到外部文件握手）。
 */
function ocrCaptcha(imgPath, log) {
  try {
    const ocrPy = path.join(HERE, 'captcha_ocr.py');
    if (!fs.existsSync(ocrPy)) return null;
    const out = execFileSync('python', [ocrPy, imgPath], { encoding: 'utf8', timeout: 15000 }).trim();
    const m = out.match(/^([0-9a-zA-Z]{4})$/);
    if (m) return m[1];
    log('OCR 未返回有效 4 位结果: ' + out.slice(0, 50));
    return null;
  } catch (e) {
    log('OCR 调用失败: ' + (e.message || '').slice(0, 80));
    return null;
  }
}

async function login(page, cfg, log) {
  await page.goto(cfg.url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(5000);

  for (let i = 0; i < 40; i++) {
    const n = await page.evaluate(() => (document.querySelector('#datacenter') || { options: [] }).options.length);
    if (n > 1) break;
    await sleep(1000);
  }
  const dc = await page.evaluate((name) => {
    const el = document.querySelector('#datacenter');
    const w = window.jQuery(el).data('kendoDropDownList');
    let idx = -1;
    for (let i = 0; i < el.options.length; i++) if (el.options[i].text.indexOf(name) >= 0) idx = i;
    if (idx >= 0) { w.select(idx); w.trigger('change'); }
    return el.options[el.selectedIndex] && el.options[el.selectedIndex].text;
  }, cfg.datacenter);
  log('数据中心=' + dc);
  await sleep(1200);

  const capPath = path.join(cfg.outDir, 'captcha.png');
  const ansPath = path.join(cfg.outDir, 'captcha.txt');
  const tries = 4;
  const maxPoll = Math.ceil((cfg.captchaTimeoutSec * 1000) / 400);

  for (let attempt = 1; attempt <= tries; attempt++) {
    try { fs.unlinkSync(ansPath); } catch (e) {}
    await winClick(page, ['确定', '确认', '关闭', '取消']);
    await page.evaluate(() => {
      document.querySelectorAll('.k-overlay, .k-loading-mask').forEach((e) => e.remove());
    });
    await page.locator('text=换一张').first().click({ timeout: 3000, force: true }).catch(() => {});
    await sleep(1200);
    await page.fill('#user', cfg.user);
    await page.fill('#password', cfg.pass);

    const cap = await page.$('#img_VelidationCode');
    if (!cap) { log('未找到验证码元素，可能已处于登录态'); break; }
    await cap.screenshot({ path: capPath });
    log(`captcha_saved ${capPath} attempt=${attempt}`);

    let ans = null;
    // 1) 优先本地 OCR（ddddocr），免外部介入，秒级完成
    if (cfg.useLocalOcr !== false) {
      const t0 = Date.now();
      ans = ocrCaptcha(capPath, log);
      if (ans) log(`captcha_ocr=${ans} (${Date.now() - t0}ms)`);
      else log('本地 OCR 未识别，回退到文件握手');
    }
    // 2) 回退：文件握手（轮询 captcha.txt，由外部 Agent 写入）
    if (!ans) {
      for (let i = 0; i < maxPoll; i++) {
        if (fs.existsSync(ansPath)) { ans = fs.readFileSync(ansPath, 'utf8').trim(); if (ans) break; }
        await sleep(400);
      }
      if (!ans) { log('等待 captcha.txt 超时'); return false; }
      log('captcha_answer=' + ans);
    }

    await page.fill('#velidationCode', ans);
    // 点击登录前先清掉残留的 k-overlay 遮罩层（金蝶「验证码错误」等弹窗关闭后，
    // 遮罩层偶发不消失，会拦截 #btnLogin 的 pointer 事件导致 click 超时）。
    await page.evaluate(() => {
      document.querySelectorAll('.k-overlay, .k-loading-mask').forEach((e) => e.remove());
    });
    await sleep(300);
    await page.click('#btnLogin', { force: true, timeout: 10000 }).catch(() => page.click('#btnLogin', { force: true }).catch(() => {}));
    await sleep(6000);

    for (let k = 0; k < 6; k++) {
      const d = await winText(page);
      if (!d.length) break;
      const j = d.join(' ');
      if (/已登录在线|让对方下线/.test(j)) { log('账号在线，按策略强制对方下线'); notifyKickoff(cfg, log); await winClick(page, ['确认']); await sleep(7000); continue; }
      if (/验证码/.test(j)) { log('验证码错误，重试'); await winClick(page, ['确定', '确认']); break; }
      if (/密码|用户不存在|锁定|禁用/.test(j)) { log('账号/密码或账号状态异常：' + j.slice(0, 50)); return false; }
      await winClick(page, ['确定', '确认', '关闭', '我知道了']);
      await sleep(1000);
    }

    const ok = await page.evaluate(() => {
      const u = document.querySelector('#user');
      return !u || u.getBoundingClientRect().width === 0;
    });
    if (ok) return true;
  }
  return false;
}

async function collectRows(page) {
  return page.evaluate(() => {
    const pick = (el) => (el ? (el.innerText || '').replace(/\s+/g, ' ').trim() : '');
    const tables = [...document.querySelectorAll('table.k-selectable')];
    let best = null;
    for (const t of tables) {
      const n = t.querySelectorAll('tbody tr').length;
      if (!best || n > best.n) best = { n, t };
    }
    if (!best) return null;
    const rows = [...best.t.querySelectorAll('tbody tr')].map((tr) => [...tr.querySelectorAll('td')].map(pick));
    const body = document.body.innerText || '';
    return {
      rows,
      total: (body.match(/共\s*(\d+)\s*行/) || [])[1] || null,
      updated: (body.match(/最近更新[:：]\s*([\d\-: ]+)/) || [])[1] || null,
      pager: (body.match(/第\s*(\d+)\s*页\s*\/\s*(\d+)\s*页/) || []).slice(1),
    };
  });
}

async function nextPage(page) {
  return page.evaluate(() => {
    const cands = [...document.querySelectorAll('[class*="arrow-e"], [class*="next-page"], [title*="下一页"], a, span, div')].filter((e) => {
      const c = (e.className || '').toString();
      const t = (e.getAttribute('title') || '') + (e.getAttribute('aria-label') || '');
      const b = e.getBoundingClientRect();
      return b.width > 0 && b.height > 0 && b.width < 60 && (/arrow-e/.test(c) || /next/i.test(c) || /下一页/.test(t));
    });
    if (!cands.length) return false;
    const el = cands[cands.length - 1];
    el.click();
    return true;
  });
}

(async () => {
  const argv = process.argv.slice(2);
  const log = (...a) => console.log('[kd]', ...a);

  if (argv[0] === '--parse-only') {
    const raw = JSON.parse(fs.readFileSync(argv[1], 'utf8'));
    const data = parseFlows(raw, { nowMs: Date.now() });
    const report = buildReport(data, { fetchedAt: new Date().toLocaleString('zh-CN', { hour12: false }), updatedAt: raw.updated });
    fs.writeFileSync(path.join(path.dirname(argv[1]), 'flow_data.json'), JSON.stringify(data, null, 1));
    fs.writeFileSync(path.join(path.dirname(argv[1]), 'flow_report.txt'), report, 'utf8');
    console.log(report);
    return;
  }

  const cfg = loadCfg();
  fs.mkdirSync(cfg.outDir, { recursive: true });
  const browser = await chromium.launch({ channel: 'chrome', headless: cfg.headless });
  const ctx = await browser.newContext({ viewport: { width: 1560, height: 940 }, deviceScaleFactor: 2, ignoreHTTPSErrors: true });
  const page = await ctx.newPage();

  try {
    if (!(await login(page, cfg, log))) { log('LOGIN_FAILED'); await browser.close(); process.exit(3); }
    log('登录成功');
    await sleep(8000);
    for (let i = 0; i < 3; i++) { const r = await winClick(page, ['知道了', '确定', '关闭']); if (!r.ok) break; await sleep(800); }

    await page.locator('text=信息中心').first().click({ timeout: 10000 });
    await sleep(12000);
    const my = page.locator('text=/我的流程/').first();
    if (await my.count().catch(() => 0)) { await my.click({ timeout: 5000 }).catch(() => {}); await sleep(6000); }
    await page.waitForFunction(() => /当前处理人/.test(document.body.innerText || ''), null, { timeout: 60000 }).catch(() => {});
    await sleep(3000);

    let all = [];
    let meta = null;
    for (let p = 0; p < 10; p++) {
      const snap = await collectRows(page);
      if (!snap) { log('未找到流程表格'); await page.screenshot({ path: path.join(cfg.outDir, 'no_grid.png') }); await browser.close(); process.exit(4); }
      meta = { total: snap.total, updated: snap.updated, pager: snap.pager };
      all = all.concat(snap.rows);
      const total = parseInt(snap.total || '0', 10);
      if (!total || all.length >= total) break;
      const moved = await nextPage(page);
      log(`翻页 ${p + 1} -> ${moved ? 'ok' : 'failed'}（已取 ${all.length}/${total}）`);
      if (!moved) break;
      await sleep(4000);
    }

    const raw = { rows: all, total: meta.total, updated: meta.updated };
    fs.writeFileSync(path.join(cfg.outDir, 'flow_raw.json'), JSON.stringify(raw, null, 1));
    const data = parseFlows(raw, { nowMs: Date.now() });
    const fetchedAt = new Date().toLocaleString('zh-CN', { hour12: false });
    const report = buildReport(data, { fetchedAt, updatedAt: meta.updated });
    fs.writeFileSync(path.join(cfg.outDir, 'flow_data.json'), JSON.stringify({ fetchedAt, updatedAt: meta.updated, ...data }, null, 1));
    fs.writeFileSync(path.join(cfg.outDir, 'flow_report.txt'), report, 'utf8');

    if (meta.total && all.length < parseInt(meta.total, 10)) log(`警告：页面共 ${meta.total} 行，仅取到 ${all.length} 行，报告可能不完整`);
    console.log(report);
    log('DONE');
  } finally {
    await browser.close();
  }
})();
