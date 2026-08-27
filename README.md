# dsh-ollama-quota — 侧边栏 Ollama 云配额进度条

在 dsh web 侧边栏底部（**设置上方**）展示 Ollama 云配额：**会话 / 每周**两个用量百分比进度条 + 各自**重置倒计时** + 手工刷新按钮。会话结束（含心跳/webhook 后台会话）自动刷新。

## 工作原理

```
侧边栏渲染（sidebar.footer.action 槽位）
  → client 60s 轮询 RPC /dsh-ollama-quota（手工刷新传 {force:true}）
  → host 读 OLLAMA_API_KEY（env → ~/.dsh/.credentials.yaml）
  → GET https://ollama.com/api/usage（Bearer 认证）
  → 返回 { sessionPct, weeklyPct, sessionResetAt, weeklyResetAt }
```

- **API key 只在 host 端**，浏览器只拿到计算后的百分比，永不下发密钥
- **缓存**：用量数据 TTL 5 分钟；重置时间每次 RPC 实时计算（不缓存）
- **会话结束刷新**：监听 `agent/turn-stopping`（任何 agent 轮结束，含心跳/webhook 会话）→ **debounce 30 秒**再查——ollama 服务端用量统计有延迟，立即查会拿到旧数据；30 秒节流兜底 API 频率

## 展示内容

- **会话进度条**：5 小时滚动窗口用量 % + 重置倒计时
- **每周进度条**：7 天滚动窗口用量 % + 重置倒计时
- **颜色**：<60% 蓝 `#4f8cff`，60-80% 橙 `#f5a524`，>80% 红 `#e5484d`（固定色值，不依赖主题变量）
- **手工刷新**：标题右侧 ↻ 按钮，force 绕过缓存直接调 API
- **收起模式**：侧边栏 rail 时只显示状态圆点（按每周用量着色）

## 重置时间计算

Ollama 官方确认（[GitHub issue #12532](https://github.com/ollama/ollama/issues/12532)）：会话和每周重置**对所有人同时发生**，可精确计算：

- **会话**：每 5 小时（18000s）滚动窗口，锚点对齐 Unix epoch（UTC 整 5 小时边界）
- **每周**：每 7 天（604800s）滚动窗口，锚点 1970-01-05 00:00 UTC（周一）→ **每周一 00:00 UTC（北京时间周一 08:00）重置**

client 端基于 host 返回的 `resetAt` 本地每 30 秒 tick 倒计时，不额外调接口。

## 目录

```
dsh-ollama-quota/
├── index.js              # host 插件：API key 加载 + 缓存 + RPC（/dsh-ollama-quota）
├── client.js             # 浏览器 bundle：sidebar.footer.action 进度条
├── cordis.patch.yml
└── package.json
```

## 技术要点（踩过的坑）

- **`sidebar.footer.action` 容器是 `display:flex`**——组件必须 `flex:1 + minWidth:0 + width:100%` 才撑满侧边栏，否则进度条轨道被压成 0 宽（表现为"没占满、没进度条"）
- **别用 `--dsw-alias-brand-primary` 做填充色**——它链式引用 `--dsh-boot-brand`，暗色主题下解析为近黑 `#0f1115`，进度条会变黑；且变量"存在"时 fallback 不生效。固定色值最稳
- **client.js 改动刷新页面即生效**（动态 serve `/plugins/<id>/client.js`）；**host 端 index.js 改动需重启**：`launchctl kickstart -k system/com.dsh.web`
- **usage 按 token 算不按次数算**：长会话上下文大，每次调用消耗多；"晚上消耗快"是使用集中 + 滚动窗口 + 长上下文的叠加，非服务端问题
- **验证**：`bash ~/.dsh/scripts/verify-plugin.sh dsh-ollama-quota`（最小 profile 起实例验证插件树）
