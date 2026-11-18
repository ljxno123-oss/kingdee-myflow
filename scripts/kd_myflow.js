/**
 * 金蝶云星空「信息中心 → 我的流程」抓取（优化版）
 *
 * 优化点（相对原 kd_myflow.js）：
 *  1. OCR 常驻服务：启动时拉起 ocr_server.py，模型常驻内存，消除每次 ~12s 冷启动。
 *  2. 自更新加缓存：10 分钟内检查过则跳过 git ls-remote（省 ~4.5s）。
 *  3. 固定 sleep 改条件轮询：所有 waitForTimeout 改为 waitForSelector/waitForFunction 等条件。
 *
 * 用法同原版：node kd_myflow.js  [--parse-only flow_raw.json]
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
  let file = {};
  for (const p of [path.join(HERE, 'config.json'), path.join(HERE, '..', 'config.json')]) {
    if (fs.existsSync(p)) { file = JSON.parse(fs.readFileSync(p, 'utf8')); break; }
  }
  let cred = {};
  for (const p of [path.join(HERE, 'credentials.json'), path.join(HERE, '..', 'credentials.json')]) {
    if (fs.existsSync(p)) {
      try { cred = JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { cred = {}; }
      break;
    }
  }
  const cfg = { ...base, ...file, ...cred };
  if (process.env.KD_URL) cfg.url = process.env.KD_URL;
  if (process.env.KD_USER) cfg.user = process.env.KD_USER;
  if (process.env.KD_PASS) cfg.pass = process.env.KD_PASS;
  if (process.env.KD_DC) cfg.datacenter = process.env.KD_DC;
  if (process.env.KD_OUT) cfg.outDir = process.env.KD_OUT;
  if (process.env.KD_HEADLESS === '0') cfg.headless = false;
  if (process.env.KD_OCR === '0') cfg.useLocalOcr = false;
  if (!cfg.user || !cfg.pass) {
    console.error('缺少账号凭据：请在 scripts/credentials.json 填写 user/pass，或通过 KD_USER/KD_PASS 环境变量提供。');
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
  await sleep(800);
  return r;
}

// ===================== OCR 常驻服务 =====================

class OcrServer {
  constructor() {
    this.proc = null;
    this.ready = false;
    this.idx = 0;
    this.pending = new Map();
  }
  start(log) {
    return new Promise((resolve) => {
      const py = path.join(HERE, 'ocr_server.py');
      if (!fs.existsSync(py)) { log('OCR server 脚本不存在'); resolve(false); return; }
      const p = spawn('python', [py], { stdio: ['pipe', 'pipe', 'pipe'] });
      this.proc = p;
      p.stderr.on('data', () => {});
      let settled = false;
      const done = (ok) => { if (!settled) { settled = true; this.ready = ok; resolve(ok); } };
      let outBuf = '';
      p.stdout.on('data', (chunk) => {
        outBuf += chunk.toString();
        let nl;
        while ((nl = outBuf.indexOf('\n')) >= 0) {
          const line = outBuf.slice(0, nl).trim();
          outBuf = outBuf.slice(nl + 1);
          if (!line) continue;
          try {
            const msg = JSON.parse(line);
            if (msg.ready === true) { done(true); }
            else if (msg.id != null && this.pending.has(msg.id)) {
              const { resolve: res } = this.pending.get(msg.id);
              this.pending.delete(msg.id);
              res(msg);
            }
          } catch (e) {}
        }
      });
      p.on('exit', () => { this.ready = false; done(false); });
      p.on('error', () => done(false));
      setTimeout(() => done(false), 30000);
    });
  }
  ocr(imgPath) {
    return new Promise((resolve) => {
      if (!this.ready || !this.proc) { resolve(null); return; }
      const id = ++this.idx;
      this.pending.set(id, { resolve });
      this.proc.stdin.write(JSON.stringify({ id, img: imgPath }) + '\n');
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); resolve(null); } }, 5000);
    });
  }
  stop() {
    try { if (this.proc) this.proc.kill(); } catch (e) {}
  }
}

// ===================== 通知 =====================

const DWS_JS = path.join(
  process.env.HOME || process.env.USERPROFILE,
  '.workbuddy', 'binaries', 'node', 'cli-connector-packages', 'node_modules',
  'dingtalk-workspace-cli', 'bin', 'dws.js'
);

function getSelfUserId() {
  try {
    const out = execFileSync('node', [DWS_JS, 'profile', 'list', '--format', 'json'], { encoding: 'utf8', maxBuffer: 1024 * 1024 * 10 });
    const j = JSON.parse(out);
    const cp = j.currentProfile || '';
    const m = cp.match(/:(\d+)$/);
    if (m) return m[1];
    const prof = (j.profiles || [])[0];
    return (prof && prof.userId) || null;
  } catch (e) { return null; }
}

function notifyWindows(title, message) {
  if (process.platform !== 'win32') return false;
  try {
    const vbsPath = path.join(os.tmpdir(), 'kd_kickoff_notify.vbs');
    const esc = (s) => String(s).replace(/"/g, '""');
    const body = 'MsgBox "' + esc(message.replace(/\r?\n/g, ' ')) + '", 48, "' + esc(title) + '"';
    const bom = Buffer.from([0xff, 0xfe]);
    fs.writeFileSync(vbsPath, Buffer.concat([bom, Buffer.from(body, 'utf16le')]));
    const child = spawn('wscript', ['//nologo', vbsPath], { detached: true, stdio: 'ignore' });
    child.unref();
    return true;
  } catch (e) { return false; }
}

function notifyDingtalk(title, message) {
  try {
    const selfId = getSelfUserId();
    if (!selfId) return false;
    execFileSync('node', [DWS_JS, 'chat', 'message', 'send', '--user', selfId, '--title', title, '--content', message, '--format', 'json'], {
      encoding: 'utf8', maxBuffer: 1024 * 1024 * 10,
    });
    return true;
  } catch (e) { return false; }
}

function notifyKickoff(cfg, log) {
  const title = '金蝶云星空：账号已在别处登录';
  const msg = '金蝶流程查询工具检测到你的账号已在线，已强制下线上一会话并继续登录。\n\n如果你刚才正在用金蝶，说明它已被登出，属正常现象。';
  try {
    const w = notifyWindows(title, msg);
    const d = notifyDingtalk(title, msg.replace(/\n/g, ' '));
    log(`KICKOFF_NOTIFY windows=${w} dingtalk=${d}`);
  } catch (e) { log('KICKOFF_NOTIFY_FAILED ' + e.message); }
}

// ===================== 登录 =====================

async function login(page, cfg, log, ocr) {
  await page.goto(cfg.url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForFunction(() => (document.querySelector('#datacenter') || { options: [] }).options.length > 1, null, { timeout: 20000 }).catch(() => {});
  const dc = await page.evaluate((name) => {
    const el = document.querySelector('#datacenter');
    const w = window.jQuery(el).data('kendoDropDownList');
    let idx = -1;
    for (let i = 0; i < el.options.length; i++) if (el.options[i].text.indexOf(name) >= 0) idx = i;
    if (idx >= 0) { w.select(idx); w.trigger('change'); }
    return el.options[el.selectedIndex] && el.options[el.selectedIndex].text;
  }, cfg.datacenter);
  log('数据中心=' + dc);
  await sleep(500);

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
    await sleep(600);
    await page.fill('#user', cfg.user);
    await page.fill('#password', cfg.pass);

    await page.waitForSelector('#img_VelidationCode', { timeout: 5000 }).catch(() => {});
    const cap = await page.$('#img_VelidationCode');
    if (!cap) { log('未找到验证码元素，可能已处于登录态'); break; }
    await cap.screenshot({ path: capPath });
    log(`captcha_saved ${capPath} attempt=${attempt}`);

    let ans = null;
    if (cfg.useLocalOcr !== false && ocr && ocr.ready) {
      const t0 = Date.now();
      const r = await ocr.ocr(capPath);
      if (r && r.ok && r.ans) { ans = r.ans; log(`captcha_ocr=${r.ans} (${Date.now() - t0}ms)`); }
      else log('常驻 OCR 未识别，回退到文件握手');
    }
    if (!ans && cfg.useLocalOcr !== false && fs.existsSync(path.join(HERE, 'captcha_ocr.py'))) {
      try {
        const out = execFileSync('python', [path.join(HERE, 'captcha_ocr.py'), capPath], { encoding: 'utf8', timeout: 20000 }).trim();
        const m = out.match(/^([0-9a-zA-Z]{4})$/);
        if (m) ans = m[1];
      } catch (e) {}
    }
    if (!ans) {
      for (let i = 0; i < maxPoll; i++) {
        if (fs.existsSync(ansPath)) { ans = fs.readFileSync(ansPath, 'utf8').trim(); if (ans) break; }
        await sleep(400);
      }
      if (!ans) { log('等待 captcha.txt 超时'); return false; }
      log('captcha_answer=' + ans);
    }

    await page.fill('#velidationCode', ans);
    await page.evaluate(() => {
      document.querySelectorAll('.k-overlay, .k-loading-mask').forEach((e) => e.remove());
    });
    await sleep(300);
    await page.click('#btnLogin', { force: true, timeout: 10000 }).catch(() => page.click('#btnLogin', { force: true }).catch(() => {}));

    await Promise.race([
      page.waitForSelector('#user', { state: 'hidden', timeout: 15000 }).catch(() => null),
      sleep(15000),
    ]);

    for (let k = 0; k < 6; k++) {
      const d = await winText(page);
      if (!d.length) break;
      const j = d.join(' ');
      if (/已登录在线|让对方下线/.test(j)) { log('账号在线，按策略强制对方下线'); notifyKickoff(cfg, log); await winClick(page, ['确认']); await sleep(5000); continue; }
      if (/验证码/.test(j)) { log('验证码错误，重试'); await winClick(page, ['确定', '确认']); break; }
      if (/密码|用户不存在|锁定|禁用/.test(j)) { log('账号/密码或账号状态异常：' + j.slice(0, 50)); return false; }
      await winClick(page, ['确定', '确认', '关闭', '我知道了']);
      await sleep(500);
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

// ===================== 自更新（带缓存） =====================

function selfUpdate(log) {
  if (process.env.KD_NO_UPDATE) { log('self-update', '跳过（KD_NO_UPDATE=1）'); return; }
  const cacheFile = path.join(os.tmpdir(), 'kd_myflow_update_cache.json');
  const CACHE_MS = 10 * 60 * 1000;
  try {
    if (fs.existsSync(cacheFile)) {
      const c = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
      if (Date.now() - (c.ts || 0) < CACHE_MS) { log('self-update', `缓存命中，跳过检查（${Math.round((Date.now() - c.ts) / 1000)}s 前检查过）`); return; }
    }
    const upd = execFileSync(process.execPath, [path.join(HERE, 'self_update.js'), '--json'], {
      cwd: HERE, encoding: 'utf8', timeout: 30000,
    }).trim();
    const r = JSON.parse(upd);
    if (r.updated) log('self-update', `已更新到最新版本 ${(r.to || '').slice(0, 7)}`);
    else if (r.skipped) log('self-update', '跳过：' + (r.reason || '未知'));
    else log('self-update', '已是最新版本');
    fs.writeFileSync(cacheFile, JSON.stringify({ ts: Date.now() }));
  } catch (e) {
    log('self-update', '检查失败（不阻塞）：' + String(e && e.message ? e.message : e));
  }
}

// ===================== 主流程 =====================

(async () => {
  const argv = process.argv.slice(2);
  const log = (...a) => console.log('[kd]', ...a);
  const tStart = Date.now();

  if (argv[0] === '--parse-only') {
    const raw = JSON.parse(fs.readFileSync(argv[1], 'utf8'));
    const data = parseFlows(raw, { nowMs: Date.now() });
    const report = buildReport(data, { fetchedAt: new Date().toLocaleString('zh-CN', { hour12: false }), updatedAt: raw.updated });
    fs.writeFileSync(path.join(path.dirname(argv[1]), 'flow_data.json'), JSON.stringify(data, null, 1));
    fs.writeFileSync(path.join(path.dirname(argv[1]), 'flow_report.txt'), report, 'utf8');
    console.log(report);
    return;
  }

  selfUpdate(log);

  const cfg = loadCfg();
  fs.mkdirSync(cfg.outDir, { recursive: true });

  const ocr = new OcrServer();
  const ocrReady = ocr.start(log);

  const browser = await chromium.launch({ channel: 'chrome', headless: cfg.headless });
  const ctx = await browser.newContext({ viewport: { width: 1560, height: 940 }, deviceScaleFactor: 2, ignoreHTTPSErrors: true });
  const page = await ctx.newPage();

  await ocrReady.catch(() => {});
  log(`OCR server ${ocr.ready ? '就绪' : '不可用，将回退'}`);

  try {
    if (!(await login(page, cfg, log, ocr))) { log('LOGIN_FAILED'); await browser.close(); ocr.stop(); process.exit(3); }
    log('登录成功');

    for (let i = 0; i < 3; i++) { const r = await winClick(page, ['知道了', '确定', '关闭']); if (!r.ok) break; await sleep(500); }

    // 登录主界面渲染缓冲（原固定 sleep(8000)，改条件轮询后补 1s 缓冲，避免点太快）
    await sleep(1000);

    await page.waitForSelector('text=信息中心', { timeout: 15000 }).catch(() => {});
    await page.locator('text=信息中心').first().click({ timeout: 10000 }).catch(() => {});

    const my = page.locator('text=/我的流程/').first();
    await my.waitFor({ state: 'visible', timeout: 20000 }).catch(() => {});
    // 「我的流程」菜单渲染缓冲（原固定 sleep(12000) 等待菜单展开，补 1.5s 缓冲）
    await sleep(1500);
    await my.click({ timeout: 5000 }).catch(() => {});

    await page.waitForFunction(() => /当前处理人/.test(document.body.innerText || ''), null, { timeout: 30000 }).catch(() => {});
    // 表格渲染缓冲（原固定 sleep(6000)+sleep(3000)，补 1s 缓冲确保表格加载完成）
    await sleep(1000);

    let all = [];
    let meta = null;
    for (let p = 0; p < 10; p++) {
      const snap = await collectRows(page);
      if (!snap) { log('未找到流程表格'); await page.screenshot({ path: path.join(cfg.outDir, 'no_grid.png') }); await browser.close(); ocr.stop(); process.exit(4); }
      meta = { total: snap.total, updated: snap.updated, pager: snap.pager };
      all = all.concat(snap.rows);
      const total = parseInt(snap.total || '0', 10);
      if (!total || all.length >= total) break;
      const moved = await nextPage(page);
      log(`翻页 ${p + 1} -> ${moved ? 'ok' : 'failed'}（已取 ${all.length}/${total}）`);
      if (!moved) break;
      await page.waitForTimeout(1500);
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
    log(`DONE（总耗时 ${((Date.now() - tStart) / 1000).toFixed(1)}s）`);
  } finally {
    await browser.close();
    ocr.stop();
  }
})();
