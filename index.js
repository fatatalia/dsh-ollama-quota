/**
 * dsh-ollama-quota — host 半部分
 *
 * 侧边栏 Ollama 云配额进度条的数据通道：
 *  - 读 OLLAMA_API_KEY（环境变量优先，其次 ~/.dsh/.credentials.yaml）
 *  - GET https://ollama.com/api/usage 取会话/每周用量百分比
 *  - RPC 通道 "/dsh-ollama-quota"（endpoint: quota）供 client 端轮询
 *  - 监听 agent/turn-stopping（每轮结束，含心跳/webhook 后台会话）触发刷新，
 *    30 秒节流 + 5 分钟缓存，避免频繁打 ollama.com
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";

export const name = "dsh-ollama-quota";

export const inject = ["connection"];

const USAGE_URL = "https://ollama.com/api/usage";
const CACHE_TTL_MS = 5 * 60 * 1000; // 缓存 5 分钟
const REFRESH_COOLDOWN_MS = 30 * 1000; // 会话事件节流 30 秒

/** 读取 API key：环境变量优先，其次 DSH_HOME/.credentials.yaml。 */
function loadApiKey() {
  if (process.env.OLLAMA_API_KEY) return process.env.OLLAMA_API_KEY;
  try {
    const credsPath = join(process.env.DSH_HOME || join(homedir(), ".dsh"), ".credentials.yaml");
    const text = readFileSync(credsPath, "utf8");
    const m = text.match(/^\s*OLLAMA_API_KEY:\s*["']?([^"'\s]+)/m);
    if (m) return m[1];
  } catch {
    /* 文件不存在或不可读：返回 null，由调用方告警 */
  }
  return null;
}

/** usage 0-1 比例 → 百分比数字（5.4 表示 5.4%）；非法值返回 null。 */
function toPct(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 1000) / 10;
}

/** 请求 ollama.com usage API。 */
async function fetchQuota(apiKey) {
  const res = await fetch(USAGE_URL, {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`ollama usage API HTTP ${res.status}`);
  const data = await res.json();
  const limits = data?.limits || {};
  const session = limits.session || {};
  const weekly = limits.weekly || {};
  return {
    sessionPct: toPct(session.usage),
    weeklyPct: toPct(weekly.usage),
    fetchedAt: new Date().toISOString(),
  };
}

/**
 * 计算配额重置时间（Ollama 官方确认：重置对所有人同时发生，可精确计算）。
 *  - 会话：每 5 小时（18000s）滚动窗口，锚点对齐 Unix epoch（UTC 整 5 小时边界）
 *  - 每周：每 7 天（604800s）滚动窗口，锚点 1970-01-05 00:00 UTC（周一）→ 每周一 00:00 UTC 重置
 * @returns 下次重置的剩余秒数与绝对时间（ISO）。
 */
function resetInfo(now = Date.now()) {
  const nowSec = Math.floor(now / 1000);
  const sessionRemainSec = 18000 - (nowSec % 18000);
  const WEEK_ANCHOR = 345600; // 1970-01-05 00:00:00 UTC（周一）
  const weeklyRemainSec = 604800 - ((nowSec - WEEK_ANCHOR) % 604800);
  return {
    sessionResetInSec: sessionRemainSec,
    weeklyResetInSec: weeklyRemainSec,
    sessionResetAt: new Date((nowSec + sessionRemainSec) * 1000).toISOString(),
    weeklyResetAt: new Date((nowSec + weeklyRemainSec) * 1000).toISOString(),
  };
}

export function apply(ctx) {
  const Logger = ctx.logger;
  // 本地时间戳（时区跟随系统，Asia/Shanghai +08）。dsh 无自动加时间的 logger，
  // 惯例是插件自己格式化（同 dsh-imessage 的 ts() 模式）。
  const ts = () => {
    const d = new Date();
    const p = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  };
  const log = {
    info: (m) => { console.log(`[${ts()}] [oq] ${m}`); try { Logger?.info?.(m); } catch {} },
    warn: (m) => { console.warn(`[${ts()}] [oq:warn] ${m}`); try { Logger?.warn?.(m); } catch {} },
    error: (m) => { console.error(`[${ts()}] [oq:err] ${m}`); try { Logger?.error?.(m); } catch {} },
  };

  const apiKey = loadApiKey();
  if (!apiKey) {
    log.warn("OLLAMA_API_KEY 未找到（环境变量或 ~/.dsh/.credentials.yaml），配额展示将不可用");
  }

  let cache = null; // { data, at }
  let lastRefreshAt = 0;
  let refreshing = null;

  /**
   * 刷新配额数据。
   * @param force 会话事件触发时 true：忽略缓存 TTL，但仍遵守 30 秒节流。
   * @returns 最新数据（失败时返回旧缓存或 null）。
   */
  async function refresh(force) {
    if (!apiKey) return cache?.data ?? null;
    const now = Date.now();
    if (!force && cache && now - cache.at < CACHE_TTL_MS) return cache.data;
    if (now - lastRefreshAt < REFRESH_COOLDOWN_MS) return cache?.data ?? null;
    if (refreshing) return refreshing;
    lastRefreshAt = now;
    refreshing = (async () => {
      try {
        const data = await fetchQuota(apiKey);
        cache = { data, at: Date.now() };
        log.info(`配额已刷新：会话 ${data.sessionPct}% / 每周 ${data.weeklyPct}%`);
        return data;
      } catch (e) {
        log.error(`配额刷新失败：${e instanceof Error ? e.message : String(e)}`);
        return cache?.data ?? null;
      } finally {
        refreshing = null;
      }
    })();
    return refreshing;
  }

  // web 端数据通道：client 轮询取配额（返回缓存，最多 5 分钟旧）；
  // 手工刷新传 { force: true } 忽略缓存 TTL 直接调 API（仍受 30 秒节流保护）。
  ctx.connection.rpc.handle("/dsh-ollama-quota", async (endpoint, payload, signal) => {
    try {
      if (signal?.aborted) throw new Error("The request was cancelled.");
      switch (endpoint) {
        case "quota": {
          const value = await refresh(payload?.force === true);
          if (!value) return { ok: true, value: null };
          // 用量走缓存，重置时间每次 RPC 实时计算（不缓存，避免过期）。
          return { ok: true, value: { ...value, ...resetInfo() } };
        }
        default:
          throw new Error(`unknown endpoint: ${endpoint}`);
      }
    } catch (e) {
      return { ok: false, error: { code: "ERR", message: e instanceof Error ? e.message : String(e) } };
    }
  }, { authority: "trusted" });
  log.info("配额 RPC 已注册（/dsh-ollama-quota）");

  // 会话结束刷新：任何 agent 轮结束（含心跳/webhook 后台会话）都触发。
  // debounce 30 秒再查——ollama 服务端用量统计有延迟，立即查会拿到旧数据；
  // 连续轮次（间隔 <30s）自动合并为一次；30 秒节流兜底 API 频率。
  let refreshTimer = null;
  ctx.on("agent/turn-stopping", () => {
    if (refreshTimer) clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => {
      refreshTimer = null;
      refresh(true).catch(() => {});
    }, 30000);
  });

  // 启动时先刷一次，让侧边栏首次打开就有数据。
  refresh(true).catch(() => {});

  ctx.on("dispose", () => {
    if (refreshTimer) clearTimeout(refreshTimer);
  });
  log.info("Ollama 配额插件已启动");
}
