/**
 * 解析「我的流程」Kendo 表格原始数据 -> 结构化流程/处理人
 * 输入 raw: { rows: [[cell...]], total, updated }
 * 列位（已按实际系统核对）：0 勾选 / 1 流程名称 / 2 流程实例 / 3 状态 / 4 发起时间 /
 *                          5 单据 / 6 当前节点 / 7 当前处理人 / 8 任务到达时间 / 9 未读反馈
 */
const COL = { name: 1, instance: 2, status: 3, started: 4, bill: 5, node: 6, handler: 7, arrived: 8 };

function splitPeople(s) {
  return (s || '').split(/[,，、;；\/]/).map((x) => x.trim()).filter(Boolean);
}

/**
 * 解析页面时间字符串为毫秒时间戳。
 * 支持格式：YYYY/MM/DD HH:mm:ss 与 YYYY-MM-DD HH:mm:ss（金蝶页面为服务器本地 GMT+8）。
 */
function parseTime(s) {
  if (!s) return null;
  const m = (s || '').trim().match(/(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})[ T](\d{1,2}):(\d{2}):(\d{2})/);
  if (!m) return null;
  return Date.parse(`${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}T${m[4].padStart(2, '0')}:${m[5]}:${m[6]}+08:00`);
}

/**
 * 计算停留时长：任务到达时间 -> 参考时间（默认取数时刻）。
 * 返回 { ms, text }；无法解析到达时间时返回 null。
 */
function calcStayed(arrived, refMs) {
  const t = parseTime(arrived);
  if (!t || !refMs) return null;
  const ms = Math.max(0, refMs - t);
  return { ms, text: fmtDuration(ms) };
}

function fmtDuration(ms) {
  const d = Math.floor(ms / 86400000);
  const h = Math.floor((ms % 86400000) / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  if (d > 0) return `${d}天${h}小时`;
  if (h > 0) return `${h}小时${m}分`;
  if (m > 0) return `${m}分钟`;
  return '1分钟内';
}

/** 超时阈值（毫秒），默认 24h 警告、48h 严重 */
const DEFAULT_TIMEOUT_MS = 24 * 3600 * 1000;
const SEVERE_TIMEOUT_MS = 48 * 3600 * 1000;

function parseFlows(raw, opts) {
  opts = opts || {};
  const refMs = opts.nowMs || Date.now();
  const flows = [];
  let cur = null;
  for (const r of raw.rows || []) {
    if (!r || r.length < 8) continue;
    const inst = r[COL.instance] || '';
    const node = r[COL.node] || '';
    const handler = r[COL.handler] || '';
    if (inst) {
      cur = { name: r[COL.name] || '', instance: inst, status: r[COL.status] || '', started: r[COL.started] || '', bill: r[COL.bill] || '', nodes: [] };
      flows.push(cur);
    }
    if (cur && (node || handler)) {
      const arrived = r[COL.arrived] || '';
      const stayed = calcStayed(arrived, refMs);
      cur.nodes.push({ node, handler, arrived, stayed: stayed ? stayed.text : null, stayedMs: stayed ? stayed.ms : null });
    }
  }
  const peopleMap = new Map();
  for (const f of flows) {
    for (const n of f.nodes) {
      for (const p of splitPeople(n.handler)) {
        if (!peopleMap.has(p)) peopleMap.set(p, []);
        peopleMap.get(p).push({ instance: f.instance, node: n.node, stayed: n.stayed, stayedMs: n.stayedMs });
      }
    }
  }
  const people = [...peopleMap.entries()].map(([name, refs]) => {
    const maxMs = refs.reduce((mx, r) => Math.max(mx, r.stayedMs || 0), 0);
    return { name, count: refs.length, maxStayed: fmtDuration(maxMs), refs: refs.map((r) => ({ instance: r.instance, node: r.node, stayed: r.stayed })) };
  }).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'zh'));
  return { flows, people, flowCount: flows.length, peopleCount: people.length };
}

function stayedFlag(ms) {
  if (ms == null) return '';
  if (ms >= SEVERE_TIMEOUT_MS) return '🔴';
  if (ms >= DEFAULT_TIMEOUT_MS) return '🟡';
  return '';
}

function buildReport(data, meta) {
  const L = [];
  L.push('金蝶云星空 · 我的流程当前处理人');
  L.push(`取数时间：${meta.fetchedAt}（页面更新 ${meta.updatedAt || '-'}）`);
  L.push(`共 ${data.flowCount} 个流程 / ${data.peopleCount} 位当前处理人`);
  data.flows.forEach((f, i) => {
    L.push('');
    L.push(`【${i + 1}】${f.name}`);
    L.push(`流程实例：${f.instance}｜状态：${f.status}｜发起：${f.started}`);
    if (f.bill) L.push(`单据：${f.bill}`);
    const byNode = {};
    f.nodes.forEach((n) => {
      const flag = stayedFlag(n.stayedMs);
      byNode[n.node] = (byNode[n.node] ? byNode[n.node] + '、' : '') + `${n.handler}${n.stayed ? `（停留${n.stayed}${flag}）` : ''}`;
    });
    Object.entries(byNode).forEach(([node, who]) => L.push(`  · ${node} → ${who}`));
  });
  L.push('');
  L.push('当前处理人汇总：');
  data.people.forEach((p) => L.push(`  ${p.name}（${p.count} 个节点，最长停留 ${p.maxStayed}）`));
  return L.join('\n');
}

module.exports = { parseFlows, buildReport, COL, parseTime, calcStayed, fmtDuration, DEFAULT_TIMEOUT_MS, SEVERE_TIMEOUT_MS };

if (require.main === module) {
  const fs = require('fs');
  const path = require('path');
  const file = process.argv[2];
  if (!file) { console.error('用法: node parse_flow.js flow_raw.json'); process.exit(1); }
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const data = parseFlows(raw);
  const report = buildReport(data, { fetchedAt: new Date().toLocaleString('zh-CN', { hour12: false }), updatedAt: raw.updated });
  fs.writeFileSync(path.join(path.dirname(file), 'flow_data.json'), JSON.stringify({ ...data, ...{ fetchedAt: new Date().toISOString() } }, null, 1));
  fs.writeFileSync(path.join(path.dirname(file), 'flow_report.txt'), report, 'utf8');
  console.log(report);
}
