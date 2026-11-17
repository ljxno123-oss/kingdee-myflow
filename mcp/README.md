# 金蝶云星空「我的流程」MCP Server

一个 stdio 传输的 MCP Server，登录金蝶云星空（珠海英搏尔），抓取「信息中心 → 我的流程」的当前节点、当前处理人与停留时长，并可通过钉钉发送报告。

> 本目录复用 `../scripts/` 下的抓取脚本（`kd_myflow.js` / `parse_flow.js` / `notify_dingtalk.sh`），
> 凭据也从 `../scripts/credentials.json` 读取，MCP 目录本身不存任何密码。

## 工具

### 1. `query_myflow`

- **参数**：`captcha`（可选，4 位验证码字符）、`user` / `pass`（可选，金蝶凭据）
- **返回**：结构化 JSON（`flowCount` / `peopleCount` / `flows` / `people` / `report`），每个节点含 `stayed` 停留时长（任务到达时间 → 取数时刻）。
- **验证码流程**：脚本把验证码截图写入临时目录，`captcha.png` 由 MCP 客户端/用户在会话中识别；识别后把 4 位字符作为 `captcha` 参数重试。
- **首次凭据**：无凭据时返回 `status: need_credentials`，由客户端弹框收集后调 `save_credentials` 落盘或直接传 user/pass（传参时自动落盘）。

### 2. `send_dingtalk`

- **参数**：`report`（必填，报告文本）、`receiver`（可选，openDingTalkId 或 userId）
- **返回**：钉钉发送结果。省略 `receiver` 时**自动发给当前 dws 登录用户本人**；传 `receiver` 则发给指定人。

### 3. `save_credentials`

- **参数**：`user`（金蝶用户名）、`pass`（金蝶密码）
- **返回**：保存结果。把凭据写入 `../scripts/credentials.json`，供后续免输。

### 4. `notify_overdue`

- **参数**：`hours`（可选，超时阈值小时，默认 8）、`dryRun`（可选，true 只预览不发送）、`only`（可选，只通知指定人，逗号分隔）、`map`（可选，同名时指定目标账号，形如 `姓名=userId或openDingTalkId`，逗号分隔）
- **返回**：催办结果。把停留超过阈值的流程按处理人分组，逐个发钉钉催办通知。
- **同名处理**：若某处理人在钉钉通讯录中存在同名（或多个近似匹配），不会擅自选择，而是通过钉钉通知使用者本人，列出候选人（职位/userId）让其判断；使用者用 `map` 指定后重跑即可定向发送。
- **前置**：需先运行 `query_myflow` 抓取数据。

## 安装

```bash
cd mcp && npm install
```

## 接入 MCP 客户端

在客户端（Claude Desktop / Cursor / 其他）的 MCP 配置里加一条：

```json
{
  "mcpServers": {
    "kingdee-myflow": {
      "command": "node",
      "args": ["C:/Users/011387/.workbuddy/skills/kingdee-myflow-report/mcp/server.js"]
    }
  }
}
```

> Windows 上若 `node` 不在 PATH，请把 `command` 换成 node 的绝对路径。

## 凭据

用户名/密码存放在 `../scripts/credentials.json`（独立文件，已 gitignore）：

```json
{
  "user": "金蝶用户名",
  "pass": "金蝶密码"
}
```

非敏感配置（数据中心、钉钉接收人）在 `../scripts/config.json`：

```json
{
  "url": "http://i.enpower.com:8600/k3cloud/html5/index.aspx",
  "datacenter": "珠海英搏尔",
  "dingtalkOpenId": "可选：只想发给别人时填 openDingTalkId",
  "dingtalkUserId": "可选：或填 userId"
}
```

> 钉钉接收人字段均为**可选**。不填时，报告自动发给当前 `dws` 登录用户本人，无需配置。

**不要把密码提交到代码仓库。** 首次运行无凭据时，MCP 会返回 `need_credentials`，由 WorkBuddy 客户端弹框收集后调 `save_credentials` 落盘。

## 停留时长规则

- 停留时长 = `任务到达时间` → 取数时刻（当前时间），按天/小时/分钟人性化展示。
- 超时阈值：`>= 48h` 标 🔴 严重，`>= 24h` 标 🟡 警告（见 `parse_flow.js` 的 `DEFAULT_TIMEOUT_MS` / `SEVERE_TIMEOUT_MS`）。

## 说明

- 只读，不含审批（同意/驳回）、发起单据、修改数据。
- 同一账号重复登录会触发「该帐号已登录在线」，脚本会点「确认」踢掉上一会话，可能把你当前浏览器会话踢下线。
