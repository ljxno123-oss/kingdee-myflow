# 金蝶云星空「我的流程」查询与超时催办 Skill

登录金蝶云星空（K3Cloud HTML5），进入「信息中心 → 我的流程」，读取运行中流程的**当前节点**与**当前处理人**，计算每个节点的**停留时长**，并可通过**钉钉**发送报告 / 自动催办超时流程。

> 仅做**只读查询**，不含审批（同意/驳回）、发起单据、修改金蝶数据。

## 核心能力

- 🔍 **流程查询**：抓取「我的流程」列表，输出流程 → 节点 → 当前处理人，按人汇总谁压了几个节点。
- ⏱ **停留时长**：节点「任务到达时间」→ 取数时刻，按天/小时/分钟人性化展示；超 24h 标 🟡、超 48h 标 🔴。
- 🤖 **自动识别验证码**：本地 OCR（ddddocr）自动识别金蝶带干扰线验证码，秒级完成，全程无需人工。
- 📨 **钉钉报告**：报告默认自动发给「当前运行者本人」，无需配置接收人。
- ⏰ **超时催办**：停留超过阈值（默认 **4 小时**）的流程，按处理人分组**自动发送**钉钉催办；遇同名处理人时先通知使用者判断，不擅自发送。
- 🔔 **踢下线双通知**：当需强制下线另一端登录会话时，同时用 Windows 弹窗 + 钉钉通知使用者。
- 🔄 **运行时自更新**：每次运行 Skill / 启动 MCP 前自动检查 GitHub 远程是否有新版本，有则 `git pull --ff-only` 拉取到最新并重装依赖，失败只降级不阻塞。

## 前置条件

| 依赖 | 说明 |
|---|---|
| Node.js ≥ 18 | 运行抓取脚本与 MCP Server |
| 本机 Chrome | 脚本用 `channel: 'chrome'`，不下载 Chromium |
| 钉钉 `dws` CLI | 发钉钉需要已登录（`dws profile list --format json` 能看到 current profile） |
| Python + ddddocr（可选，推荐） | `pip install ddddocr opencv-python numpy`，用于自动识别验证码；不装则回退人工识别 |

## 快速开始（WorkBuddy Skill 方式）

把本仓库放到 WorkBuddy 的 skills 目录：

```bash
# 克隆仓库到用户级 skills 目录
git clone https://github.com/ljxno123-oss/kingdee-myflow.git \
  ~/.workbuddy/skills/kingdee-myflow-report

# 安装依赖（只需一次）
cd ~/.workbuddy/skills/kingdee-myflow-report/scripts && npm i

# 可选：安装本地 OCR 依赖（推荐，自动识别验证码）
python -m pip install ddddocr opencv-python numpy
```

然后对 WorkBuddy 说「**我的流程**」「**流程当前处理人是谁**」「**催一下超时的流程**」等即可触发本 Skill。

首次运行会通过弹框收集金蝶用户名/密码，保存到本地 `scripts/credentials.json`（已 gitignore，不提交）。

## 配置

### 凭据（首次弹框收集，或手动创建）

`scripts/credentials.json`（**已 gitignore，切勿提交**）：

```json
{ "user": "金蝶用户名", "pass": "金蝶密码" }
```

### 非敏感配置

`scripts/config.json`（参考 `scripts/config.example.json` 创建）：

```json
{
  "url": "http://i.enpower.com:8600/k3cloud/html5/index.aspx",
  "datacenter": "珠海英搏尔",
  "headless": true,
  "overdueHours": 4,
  "useLocalOcr": true
}
```

| 字段 | 说明 |
|---|---|
| `url` | 金蝶云星空登录地址 |
| `datacenter` | 数据中心名称 |
| `overdueHours` | 催办阈值（小时），默认 4 |
| `useLocalOcr` | 是否用本地 OCR 自动识别验证码 |
| `dingtalkOpenId` / `dingtalkUserId` | **可选**。不填则报告自动发给当前 dws 登录用户本人 |

## 命令行用法（不用 Skill，直接跑脚本）

```bash
cd scripts

# 1) 查询流程（登录 + 抓取 + 生成报告）
node kd_myflow.js

# 2) 报告发给本人钉钉（默认）
bash notify_dingtalk.sh flow_report.txt

# 3) 超时催办（默认 4 小时，自动发送）
node notify_overdue.js
node notify_overdue.js --hours 12      # 指定阈值
node notify_overdue.js --dry-run       # 只预览不发送
node notify_overdue.js --only 叶新,何梅娟              # 只通知指定人
node notify_overdue.js --map 何梅娟=177xxx,叶新=178xxx # 同名时指定目标账号
```

## 目录结构

```
.
├── SKILL.md                    # WorkBuddy Skill 定义（触发词、完整流程）
├── scripts/
│   ├── kd_myflow.js            # 登录 + 抓取主脚本（运行前自动自更新）
│   ├── self_update.js          # 运行时自更新：检查 GitHub 新版本并 pull 到最新
│   ├── parse_flow.js           # 解析 + 停留时长计算 + 报告生成
│   ├── notify_overdue.js       # 超时催办（按处理人分组发钉钉）
│   ├── notify_dingtalk.sh      # 报告发钉钉（默认发本人）
│   ├── captcha_ocr.py          # 本地 OCR 验证码识别
│   ├── config.example.json     # 配置样例
│   └── credentials.example.json# 凭据样例
├── mcp/
│   ├── server.js               # stdio MCP Server
│   └── README.md               # MCP 接入说明
└── references/
    └── page-structure.md       # 金蝶页面结构 / 选择器说明
```

## MCP Server（可选）

`mcp/` 提供可独立接入的 stdio MCP Server，暴露四个工具：
`query_myflow`（查询+停留时长）、`send_dingtalk`（发钉钉）、`save_credentials`（保存凭据）、`notify_overdue`（超时催办）。

接入方式见 [`mcp/README.md`](mcp/README.md)。

## 安全说明

- 凭据（金蝶用户名/密码、钉钉账号）均通过 `.gitignore` 排除，**不会**提交到仓库。
- 脚本为**只读**操作：仅关闭提示弹窗、点「信息中心/我的流程」、翻页刷新，不点任何审批/提交/删除按钮。
- 同一账号重复登录会触发「该帐号已登录在线」，脚本会点「确认」强制下线上一会话（属既定策略，会双渠道通知使用者）。
