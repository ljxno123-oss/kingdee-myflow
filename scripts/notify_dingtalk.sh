#!/usr/bin/env bash
# 把 flow_report.txt 通过钉钉单聊发送。
# 默认自动发给「当前 dws 登录用户本人」（从 dws profile list 取 userId）。
# 用法: ./notify_dingtalk.sh [报告文件] [接收人 openDingTalkId 或 userId] [额外参数...]
# 说明:
#   - 不传接收人时 → 自动发给自己（当前登录用户）。
#   - 传第二个参数 → 发给指定人（openDingTalkId 或 userId）。
#   - config.json 里的 dingtalkOpenId/dingtalkUserId 仅作为「默认发给别人」的可选覆盖项，
#     优先级：命令行参数 > config.json 的 dingtalkOpenId > dingtalkUserId > 自动发给自己。
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FILE="${1:-$DIR/flow_report.txt}"

if [ ! -f "$FILE" ]; then
  echo "找不到报告文件: $FILE" >&2
  exit 1
fi

read_cfg() {
  node -e "const c=JSON.parse(require('fs').readFileSync(process.argv[1],'utf8'));process.stdout.write(c[process.argv[2]]||'')" "$DIR/config.json" "$1"
}

# 取当前 dws 登录用户的 userId（发给自己）
self_user_id() {
  dws profile list --format json 2>/dev/null \
    | node -e "let s='';process.stdin.on('data',d=>s+=d);process.stdin.on('end',()=>{try{const j=JSON.parse(s);const p=(j.profiles||[]).find(x=>x.isCurrent)||(j.profiles||[])[0];process.stdout.write((p&&p.userId)||'');}catch(e){process.stdout.write('');}})"
}

OPEN_ID=""
USER_ID=""
TARGET="${2:-}"

if [ -n "$TARGET" ]; then
  # 以纯数字视为 userId，否则视为 openDingTalkId
  if [[ "$TARGET" =~ ^[0-9]+$ ]]; then USER_ID="$TARGET"; else OPEN_ID="$TARGET"; fi
elif [ -f "$DIR/config.json" ]; then
  # 可选覆盖：config.json 里显式配置了要发给「别人」时使用
  OPEN_ID="$(read_cfg dingtalkOpenId)"
  USER_ID="$(read_cfg dingtalkUserId)"
fi

# 仍未确定接收人 → 自动发给自己（当前登录用户）
if [ -z "$OPEN_ID" ] && [ -z "$USER_ID" ]; then
  USER_ID="$(self_user_id)"
fi

if [ -z "$OPEN_ID" ] && [ -z "$USER_ID" ]; then
  echo "无法确定接收人：请确认 dws 已登录（dws profile list 可见当前账号），或传第二个参数指定接收人" >&2
  exit 2
fi

CONTENT="$(cat "$FILE")"
TITLE="金蝶我的流程·当前处理人"

if [ -n "$OPEN_ID" ]; then
  dws chat message send --open-dingtalk-id "$OPEN_ID" --title "$TITLE" --content "$CONTENT" --format json "${@:3}"
elif [ -n "$USER_ID" ]; then
  dws chat message send --user "$USER_ID" --title "$TITLE" --content "$CONTENT" --format json "${@:3}"
fi
