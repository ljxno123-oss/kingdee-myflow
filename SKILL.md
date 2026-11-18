---
name: kingdee-myflow-report
agent_created: true
description: 登录金蝶云星空网页版（K3Cloud HTML5），进入「信息中心 → 我的流程」，读取运行中流程的当前节点与当前处理人，计算每个节点的停留时长（任务到达时间 → 取数时刻），生成结构化 JSON 与中文汇总报告，并可经钉钉发送给指定人，或按当前处理人分组发送超时催办通知。当用户说「我的流程」「流程当前处理人是谁」「谁在审批 / 卡在谁那里」「流程停留多久了」「金蝶流程待办排查」「催一下超时的流程」「通知处理人尽快处理」「信息中心我的流程」时使用。仅做只读查询，不含审批（同意/驳回）、发起单据、修改金蝶数据。配套一个可独立接入的 MCP Server，见 mcp/ 目录（query_myflow / send_dingtalk / save_credentials / notify_overdue 四个工具）。
---

# 金蝶云星空「我的流程」当前处理人查询

只读抓取金蝶云星空「信息中心 → 我的流程」列表，输出流程 / 节点 / 当前处理人，并按人汇总。

## 前置条件

1. Node.js ≥ 18 与本机 Chrome（脚本用 `channel: 'chrome'`，不下载 Chromium）。
2. 依赖：`cd scripts && npm i`（只需一次；`playwright-core` 单包）。
3. 非敏感配置在 `scripts/config.json`；**用户名/密码独立存放于 `scripts/credentials.json`**（已 gitignore，不提交）。
   凭据优先级：环境变量 `KD_USER`/`KD_PASS` > `credentials.json` > `config.json`（兼容旧版）。
4. 发钉钉需要 `dws` CLI 已登录（`dws profile list --format json` 能看到 current profile）。
   报告默认自动发给当前登录用户本人，无需配置接收人。
5. 本地 OCR（可选，推荐，用于自动识别验证码）：`python -m pip install ddddocr opencv-python numpy`（只需一次）。
   不装则回退到人工/视觉握手识别验证码。

## 运行时自更新（自动，无需手动操作）

每次运行 Skill（`kd_myflow.js`）或启动 MCP Server 时，都会**先检查 GitHub 远程仓库是否有新版本**，
若有则自动 `git pull --ff-only` 拉取到最新，并在依赖清单变化时自动 `npm i`，再继续执行原任务。

- 自更新由 `scripts/self_update.js` 统一实现，通过 `git ls-remote origin HEAD` 只读比对本地/远程 HEAD。
- 仅做**快进合并**（`--ff-only`），绝不覆盖本地未提交改动；更新失败（如离线）只降级跳过，**不阻塞主流程**。
- 跳过自更新：设环境变量 `KD_NO_UPDATE=1`（脚本方式）或运行 `self_update.js --off`。
- 手动触发：`node scripts/self_update.js`（默认检查并更新）、`--check`（只检查）、`--json`（输出一行 JSON）。
- MCP 额外暴露 `update_self` 工具，可随时手动检查并更新到最新。

## 凭据首次收集（关键流程）

**每次运行前先检查 `scripts/credentials.json` 是否存在且含非空 `user`/`pass`。**

- 若存在 → 直接用，跳过收集。
- 若不存在或为空 → 用 `AskUserQuestion` 弹框向用户收集用户名和密码，然后把结果写入
  `scripts/credentials.json`（格式 `{ "user": "...", "pass": "..." }`），再继续。**不要**把密码写进 `config.json` 或 SKILL 说明里。
- 收集时需说明用途（登录金蝶云星空珠海英搏尔）与保存位置，提醒密码仅存本地、不提交到仓库。

## 执行流程

### 1. 启动抓取

在 Skill 的 `scripts/` 目录执行（`KD_OUT` 可指定输出目录，默认就是 `scripts/`）：

```bash
node kd_myflow.js
```

这是长任务（登录 ~40s + 页面加载 ~30s），用后台方式运行，然后读输出。日志前缀为 `[kd]`。

### 2. 验证码识别（本地 OCR 优先，人工/视觉兜底）

脚本优先用**本地 OCR**（ddddocr + 图像预处理）自动识别验证码，秒级完成，无需外部介入：

1. 截图验证码后，直接调用 `scripts/captcha_ocr.py`（依赖 `ddddocr` + `opencv-python` + `numpy`，用 `beta` 模型 + 中值滤波/Otsu 二值化/放大预处理，对金蝶带干扰线验证码识别率高）。
2. 日志出现 `captcha_ocr=<4位> (<耗时>ms)` ⇒ 本地识别成功，自动填码登录，全程无需人工。
3. 若本地 OCR 失败（日志出现 `本地 OCR 未识别，回退到文件握手`），回退到原来的文件握手：日志出现 `[kd] captcha_saved <绝对路径>` 时，**立即读取该 `captcha.png`**（用图片查看工具，按 4 位字符逐个辨认），把 4 个字符写入同目录 `captcha.txt`（UTF-8、单行、无空格），脚本每 400ms 轮询，最多等待 `captchaTimeoutSec`（默认 360 秒）。

判断规则：

- 日志再次出现 `captcha_saved ... attempt=2` ⇒ 第一次验证码错了（本地 OCR 误识或人工识别错），会自动刷新验证码重试，最多 `tries=4` 次。
- 日志出现 `账号/密码或账号状态异常` ⇒ 停止，报告错误文案，不要反复试。
- 日志出现 `等待 captcha.txt 超时` ⇒ 询问用户是否仍要继续。
- 日志出现 `KICKOFF_NOTIFY windows=true dingtalk=true` ⇒ 脚本检测到账号在线、已强制下线上一会话，并**同时用 Windows 弹窗 + 钉钉通知了用户本人**。若其中某项为 `false`，说明该渠道通知失败（如未登录 dws 或无桌面会话），需在汇报时口头提醒用户。

> 本地 OCR 依赖：`python -m pip install ddddocr opencv-python numpy`（首次需安装一次）。若不想用本地 OCR，在 `config.json` 设 `useLocalOcr: false` 或环境变量 `KD_OCR=0`，则回到纯人工握手。

### 3. 校验结果

脚本产出四个文件在输出目录：`flow_raw.json`（原始行）、`flow_data.json`（结构化）、`flow_report.txt`（中文摘要）、`captcha.png`。

必须检查：

- `flow_report.txt` 中流程数与「共 N 行」是否自洽（每流程至少 1 个节点行）。
- 若 stderr 出现 `警告：页面共 N 行，仅取到 M 行`，说明分页没翻完，报告不完整——需在报告开头显式标注「数据不完整」，或调大每页行数后重跑。

### 4. 发送钉钉

```bash
bash notify_dingtalk.sh /path/to/flow_report.txt [openDingTalkId 或 userId] [额外参数]
```

**默认自动发给「当前 dws 登录用户本人」**——即谁运行这个 skill，报告就发到谁的钉钉，无需配置接收人。
只有想发给别人时才传第二个参数，或在 `config.json` 显式配置 `dingtalkOpenId`（优先）/`dingtalkUserId`。

接收人优先级：命令行参数 > `config.json` 的 `dingtalkOpenId` > `dingtalkUserId` > 自动发给自己。

建议发给别人时用 openDingTalkId：`dws contact user search --keyword "姓名" --format json` 获取。

发送前把接收人和内容摘要告知用户确认；发送后用返回的 `openTaskId` 调
`dws chat message query-send-status --open-task-id <id> --format json` 确认 `openMessageId` 存在，并回报消息已送达。

### 5. 超时催办通知（通知当前处理人本人，自动发送）

把停留超过阈值的流程，按「当前处理人」分组，逐个通过钉钉发给处理人本人催办。

```bash
node notify_overdue.js                 # 用 config.json 的 overdueHours（默认 4 小时），自动发送
node notify_overdue.js --hours 12      # 指定阈值（小时）
node notify_overdue.js --dry-run       # 只预览要通知谁、发什么，不实际发送
node notify_overdue.js --only 叶新,何梅娟   # 只通知指定的人
node notify_overdue.js --map 何梅娟=177xxx,叶新=178xxx  # 同名时指定目标账号（userId 或 openDingTalkId）
```

工作方式：

1. 读 `flow_data.json`，遍历 `flows[].nodes[]`，筛出 `stayedMs >= 阈值` 的节点。
2. 按处理人姓名分组（多处理人按 `,`/`、` 拆分）。
3. 用 `dws contact user search --query 姓名` 把中文姓名解析成钉钉账号。
4. 逐人发送一条只含他本人待办的催办消息（流程名、节点、停留时长、流程实例）。
5. 解析不到钉钉账号的人会在结果里列出并跳过。

**自动发送（默认行为）**：直接运行 `node notify_overdue.js`（不带 `--dry-run`）即**自动发送催办通知，无需询问用户确认**。只有解析到钉钉账号的唯一匹配处理人才会自动发送；发送完成后向用户回报「已发送给谁」。

**同名处理**（重要，仅同名/近似匹配时才需要介入）：若某姓名在钉钉通讯录中存在同名（多个精确匹配），或只有近似匹配（可能错字/别称），脚本**不会擅自选择**，而是：
- 把这些「待确认」的人汇总成一条消息，通过钉钉发给**使用者本人**，列出各候选人的职位与 userId，请使用者判断催办信息应发给谁；
- 使用者确认后，用 `--map "姓名=目标userId或openDingTalkId"` 重新运行，即可定向发送。

阈值默认 4 小时，可在 `config.json` 的 `overdueHours` 改。

### 6. 汇报

给出：取数时间、流程数、处理人数、每个流程的节点→处理人、按人汇总（谁压了几个节点）。把「已强制下线另一端登录会话」如实告知。

## 硬性约束

- **只读**。允许的动作仅限：关闭提示弹窗、点「信息中心 / 我的流程」、翻页、刷新。严禁点同意 / 驳回 / 提交 / 删除 / 修改单据。
- **「该帐号已登录在线」弹窗点「确认」会把用户当前浏览器踢下线**。这是已确认的策略，但每次都要在汇报中说明。
- **不要用 `storageState` 复用登录态**：登录态在 sessionStorage 里，保存的 state 恢复后仍回到登录页，每次必须完整登录。
- 金蝶弹窗按钮是 `<a class="k-button">` 而非 `<button>`，且弹窗会遮挡验证码截图；重试前先关弹窗。实现细节与选择器见 [references/page-structure.md](references/page-structure.md)。
- **验证码错误弹窗关闭后可能残留 `k-overlay` 遮罩层**，会拦截 `#btnLogin` 与「换一张」的 pointer 事件导致 `page.click` 超时。脚本已在每次点击前移除 `.k-overlay`/`.k-loading-mask` 并对关键点击加 `force: true` 兜底；若未来仍复现，优先排查遮罩层残留。

## 输出结构（`flow_data.json`）

```json
{
  "fetchedAt": "2026/11/16 11:21:00",
  "updatedAt": "2026-11-16-11:20:39",
  "flowCount": 2,
  "flows": [
    { "name": "新ECN审核流程(珠海)", "instance": "ECN-20261111-0010_...", "status": "运行中",
      "started": "2026/11/11 15:49:37", "bill": "业务类型_ECN(变更单)",
      "nodes": [{ "node": "签收", "handler": "叶新,何梅娟", "arrived": "2026/11/14 11:49:46",
                 "stayed": "2天0小时", "stayedMs": 172800000 }] }
  ],
  "people": [{ "name": "何梅娟", "count": 2, "maxStayed": "2天0小时",
               "refs": [{ "instance": "...", "node": "签收", "stayed": "2天0小时" }] }]
}
```

## 停留时长规则

- `stayed` = 节点「任务到达时间」→ 取数时刻（当前时间），按 `X天X小时 / X小时X分 / X分钟` 人性化展示。
- 超时标记（写入报告文本，JSON 里用 `stayedMs` 自行判断）：
  - `>= 48h` → 🔴 严重
  - `>= 24h` → 🟡 警告
- 阈值常量在 `scripts/parse_flow.js` 的 `DEFAULT_TIMEOUT_MS` / `SEVERE_TIMEOUT_MS`，可按需改。

## MCP Server（可选）

`mcp/` 目录提供一个可独立接入的 stdio MCP Server，暴露四个工具：
`query_myflow`（抓取+停留时长）、`send_dingtalk`（发钉钉）、`save_credentials`（保存凭据）、`notify_overdue`（超时催办），凭据复用 `scripts/credentials.json`。
接入方式见 `mcp/README.md`。

**MCP 首次凭据收集**：`query_myflow` 若发现无凭据，会返回 `status: need_credentials`。
此时由 WorkBuddy 客户端（作为 MCP 调用方）弹框收集用户名/密码，再调用 `save_credentials` 落盘，
或直接把 user/pass 作为 `query_myflow` 参数回传（回传时自动落盘）。之后免输。

## 失败处理

| 退出码 / 现象 | 含义与动作 |
|---|---|
| exit 2 | 缺账号配置，补 `config.json` 或环境变量 |
| exit 3 | 登录失败（账号 / 密码 / 数据中心 / 验证码），报告最后弹窗文案 |
| exit 4 | 没找到流程表格，看 `no_grid.png`；多为信息中心加载慢，加大等待重试一次 |
| 选择器全失效 | 系统升级导致，按 `references/page-structure.md` 逐项核对并更新脚本 |
