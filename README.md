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
- **历史趋势**：标题右侧 📈 按钮，展开近 7 天每日快照（日期 / 每周 % / 相对前一日 Δ / 周请求数），再点收起
- **收起模式**：侧边栏 rail 时只显示状态圆点（按每周用量着色）

## 每日快照落盘（历史趋势数据源）

每次**真实**查询 ollama.com usage API 成功（启动刷新 / 会话结束刷新 / 手工刷新，均受 30 秒节流 + 5 分钟缓存保护），host 端自动追加一条采样到 `$DSH_HOME/ollama-quota-history.json`：

```json
{"version":1,"samples":[{"t":1787924080188,"date":"2026-08-28","week":"2026-08-24","sessionPct":6.6,"weeklyPct":12.9,"sessionReqs":289,"weeklyReqs":3101}]}
```

- `date`：北京时区日期（快照聚合口径）；`week`：所属 Ollama 周窗口的 UTC 周一日期（周一 08:00 北京重置）
- **去重**：与最后一条采样同日且百分比完全相同 → 跳过（值没变不刷历史）；上限 20000 条，超出截掉最老一半
- **原子写**：tmp + rename，进程中断不会写坏文件
- **history RPC**：`/dsh-ollama-quota` endpoint `history`，参数 `{days}`（1-90，默认 7），返回按北京日期聚合的**每天最后一条采样**（日终值），按日期升序
- **只落真实值**：心跳 agent 复述的 HEARTBEAT.md 示例值（`每周 25.1%`）不经过本插件，不会污染历史

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
