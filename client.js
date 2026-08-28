/**
 * dsh-ollama-quota — client 半部分（浏览器 bundle）
 *
 * 在侧边栏底部（sidebar.footer.action 槽位，设置上方）展示 Ollama 云配额：
 * 会话 / 每周 两个用量百分比进度条。数据经 connection.rpc 走
 * "/dsh-ollama-quota" 通道，页面加载时拉一次 + 每 60 秒轮询
 * （host 端在会话结束时刷新缓存，轮询最多滞后 60 秒）。
 * 侧边栏收起（rail 模式）时只显示一个状态圆点。
 */
window.__ModuleLoader__.load({
  id: "dsh-ollama-quota",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    const React = require("react");
    const S = require("react/jsx-runtime");

    const CHANNEL = "/dsh-ollama-quota";
    const POLL_MS = 60 * 1000;

    // 刷新按钮旋转动画（幂等注入）。
    if (typeof document !== "undefined" && !document.querySelector("style[data-plugin-css=dsh-ollama-quota]")) {
      const tag = document.createElement("style");
      tag.dataset.pluginCss = "dsh-ollama-quota";
      tag.textContent = "@keyframes oq-spin{to{transform:rotate(360deg)}}";
      document.head.appendChild(tag);
    }

    // 用量颜色：<60% 蓝，60-80% 橙，>80% 红。
    // 不用 --dsw-alias-brand-primary：它链式引用 --dsh-boot-brand，
    // 暗色主题下解析为 #0f1115（近黑），进度条会变黑。固定色值最稳。
    function pctColor(pct) {
      if (pct == null) return "var(--dsw-alias-border-l2, rgba(128,128,128,.3))";
      if (pct >= 80) return "#e5484d";
      if (pct >= 60) return "#f5a524";
      return "#4f8cff";
    }

    function Bar({ label, pct, reset }) {
      const value = pct == null ? 0 : Math.min(Math.max(pct, 0), 100);
      const color = pctColor(pct);
      return S.jsxs("div", {
        style: { marginBottom: 4 },
        children: [
          S.jsxs("div", {
            style: { display: "flex", alignItems: "center", gap: 6 },
            children: [
              S.jsx("span", { style: { fontSize: 11, color: "var(--dsw-alias-label-secondary)", width: 28, flex: "none" }, children: label }),
              S.jsx("div", {
                style: { flex: 1, height: 4, borderRadius: 2, background: "var(--dsw-alias-border-l2, rgba(128,128,128,.2))", overflow: "hidden" },
                children: S.jsx("div", {
                  style: { width: `${value}%`, height: "100%", borderRadius: 2, background: color, transition: "width .3s ease" },
                }),
              }),
              S.jsx("span", { style: { fontSize: 11, color: "var(--dsw-alias-label-tertiary)", width: 36, textAlign: "right", flex: "none" }, children: pct == null ? "—" : `${pct}%` }),
            ],
          }),
          reset
            ? S.jsx("div", { style: { fontSize: 10, color: "var(--dsw-alias-label-tertiary)", marginTop: 1, paddingLeft: 34 }, children: `重置 ${reset}` })
            : null,
        ],
      });
    }

    // 剩余秒数 → 紧凑时长（3d10h / 1h50m / 45m）。
    function fmtDuration(sec) {
      if (sec == null || !Number.isFinite(sec)) return "—";
      const d = Math.floor(sec / 86400);
      const h = Math.floor((sec % 86400) / 3600);
      const m = Math.floor((sec % 3600) / 60);
      if (d > 0) return `${d}d${h}h`;
      if (h > 0) return `${h}h${m}m`;
      return `${m}m`;
    }

    function QuotaView({ wide, rpc }) {
      const [data, setData] = React.useState(null);
      const [error, setError] = React.useState("");
      const [busy, setBusy] = React.useState(false);
      // 历史趋势：展开状态 + 按天聚合数据
      const [histOpen, setHistOpen] = React.useState(false);
      const [histRows, setHistRows] = React.useState(null);
      // 本地倒计时 tick：每 30 秒重算剩余时间（基于 host 返回的 resetAt，不重新调 RPC）。
      const [, setTick] = React.useState(0);

      React.useEffect(() => {
        const timer = window.setInterval(() => setTick((t) => t + 1), 30 * 1000);
        return () => window.clearInterval(timer);
      }, []);

      React.useEffect(() => {
        let current = true;
        const load = async () => {
          try {
            const response = await rpc.call(CHANNEL, "quota", {});
            if (!response || !response.ok) throw new Error(response?.error?.message || "quota failed");
            if (current) {
              setData(response.value);
              setError("");
            }
          } catch (e) {
            if (current) setError(e instanceof Error ? e.message : String(e));
          }
        };
        load();
        const timer = window.setInterval(load, POLL_MS);
        return () => {
          current = false;
          window.clearInterval(timer);
        };
      }, [rpc]);

      // 手工刷新：force 绕过缓存 TTL 直接调 ollama.com API
      //（host 端 30 秒节流内仍返回缓存，防连点打爆接口）。
      const manualRefresh = async () => {
        setBusy(true);
        try {
          const response = await rpc.call(CHANNEL, "quota", { force: true });
          if (!response || !response.ok) throw new Error(response?.error?.message || "quota failed");
          setData(response.value);
          setError("");
        } catch (e) {
          setError(e instanceof Error ? e.message : String(e));
        } finally {
          setBusy(false);
        }
      };

      // 拉历史趋势（近 7 天按天聚合），展开/收起。
      const toggleHistory = async () => {
        if (histOpen) {
          setHistOpen(false);
          return;
        }
        setHistOpen(true);
        if (histRows) return; // 已有数据直接展开
        try {
          const response = await rpc.call(CHANNEL, "history", { days: 7 });
          if (!response || !response.ok) throw new Error(response?.error?.message || "history failed");
          setHistRows(response.value?.rows || []);
          setError("");
        } catch (e) {
          setError(e instanceof Error ? e.message : String(e));
          setHistOpen(false);
        }
      };

      // 收起（rail）模式：只显示状态圆点（按每周用量着色）。
      if (!wide) {
        const dotColor = pctColor(data?.weeklyPct);
        return S.jsx("div", {
          style: { display: "flex", justifyContent: "center", padding: "6px 0" },
          title: data ? `Ollama 会话 ${data.sessionPct}% / 每周 ${data.weeklyPct}%` : "Ollama 配额",
          children: S.jsx("span", {
            style: { width: 8, height: 8, borderRadius: "50%", background: dotColor, display: "inline-block" },
          }),
        });
      }

      return S.jsxs("div", {
        style: {
          flex: 1,
          minWidth: 0,
          width: "100%",
          boxSizing: "border-box",
          padding: "8px 4px 6px",
          borderTop: "1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.12))",
        },
        children: [
          S.jsxs("div", {
            style: { display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 },
            children: [
              S.jsx("span", { style: { fontSize: 11, fontWeight: 600, color: "var(--dsw-alias-label-tertiary)", letterSpacing: ".02em" }, children: "Ollama 配额" }),
              S.jsxs("div", { style: { display: "flex", alignItems: "center", gap: 4 }, children: [
                S.jsx("button", {
                  type: "button",
                  onClick: toggleHistory,
                  title: histOpen ? "收起历史趋势" : "近 7 天配额趋势",
                  style: {
                    border: "none",
                    background: "transparent",
                    color: histOpen ? "var(--dsw-alias-label-primary, #fff)" : "var(--dsw-alias-label-tertiary)",
                    cursor: "pointer",
                    fontSize: 11,
                    lineHeight: 1,
                    padding: "1px 3px",
                    opacity: 0.85,
                  },
                  children: "📈",
                }),
                S.jsx("button", {
                  type: "button",
                  onClick: manualRefresh,
                  title: "刷新配额",
                  style: {
                    border: "none",
                    background: "transparent",
                    color: "var(--dsw-alias-label-tertiary)",
                    cursor: "pointer",
                    fontSize: 12,
                    lineHeight: 1,
                    padding: "1px 3px",
                    opacity: busy ? 1 : 0.65,
                    animation: busy ? "oq-spin 1s linear infinite" : undefined,
                  },
                  children: "↻",
                }),
              ]}),
            ],
          }),
          S.jsx(Bar, {
            label: "会话",
            pct: data?.sessionPct ?? null,
            reset: fmtDuration(data ? (new Date(data.sessionResetAt).getTime() - Date.now()) / 1000 : null),
          }),
          S.jsx(Bar, {
            label: "每周",
            pct: data?.weeklyPct ?? null,
            reset: fmtDuration(data ? (new Date(data.weeklyResetAt).getTime() - Date.now()) / 1000 : null),
          }),
          // 历史趋势表格（近 7 天，每天日终值 + 相对前一日增量 + 周请求数）
          histOpen
            ? S.jsx("div", {
                style: {
                  marginTop: 6,
                  borderTop: "1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.12))",
                  paddingTop: 5,
                  fontSize: 10,
                  color: "var(--dsw-alias-label-tertiary)",
                },
                children: histRows && histRows.length
                  ? S.jsxs("div", {
                      children: [
                        S.jsxs("div", {
                          style: { display: "flex", gap: 6, marginBottom: 2, fontWeight: 600, color: "var(--dsw-alias-label-secondary)" },
                          children: [
                            S.jsx("span", { style: { width: 34, flex: "none" }, children: "日期" }),
                            S.jsx("span", { style: { width: 42, textAlign: "right" }, children: "每周" }),
                            S.jsx("span", { style: { width: 32, textAlign: "right" }, children: "Δ" }),
                            S.jsx("span", { style: { flex: 1, textAlign: "right" }, children: "请求" }),
                          ],
                        }),
                        ...histRows.map((r, i) => {
                          const prev = i > 0 ? histRows[i - 1].weeklyPct : null;
                          const delta = prev != null && r.weeklyPct != null ? r.weeklyPct - prev : null;
                          const dot = pctColor(r.weeklyPct);
                          return S.jsxs("div", {
                            key: r.date,
                            style: { display: "flex", gap: 6, alignItems: "center", marginBottom: 1 },
                            children: [
                              S.jsxs("span", { style: { width: 34, flex: "none" }, children: [
                                S.jsx("span", { style: { display: "inline-block", width: 6, height: 6, borderRadius: "50%", background: dot, marginRight: 4, verticalAlign: 1 } }),
                                r.date.slice(5),
                              ]}),
                              S.jsx("span", { style: { width: 42, textAlign: "right" }, children: r.weeklyPct == null ? "—" : `${r.weeklyPct}%` }),
                              S.jsx("span", {
                                style: {
                                  width: 32,
                                  textAlign: "right",
                                  color: delta == null ? "var(--dsw-alias-label-tertiary)" : delta >= 0 ? "#e5484d" : "#4f8cff",
                                },
                                children: delta == null ? "—" : `+${delta}`,
                              }),
                              S.jsx("span", { style: { flex: 1, textAlign: "right" }, children: r.weeklyReqs == null ? "—" : String(r.weeklyReqs) }),
                            ],
                          });
                        }),
                      ],
                    })
                  : S.jsx("div", { children: "暂无历史数据（重启后开始记录）" }),
              })
            : null,
          error
            ? S.jsx("div", { style: { fontSize: 10, color: "var(--dsw-alias-label-tertiary)", marginTop: 2 }, children: "配额数据不可用" })
            : null,
        ],
      });
    }

    const inject = ["slots", "connection"];

    function apply(ctx) {
      // 侧边栏底部、设置上方的配额进度条（sidebar.footer.action 为 list 槽位）。
      ctx.slots.inject("sidebar.footer.action", () =>
        ctx.slots.register(
          {
            name: "sidebar.footer.action",
            id: "ollama-quota",
            order: 10,
            label: () => "Ollama 配额",
            inject: () => ({ rpc: ctx.connection.rpc }),
          },
          QuotaView,
        ),
      );
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
