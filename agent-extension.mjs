/**
 * 大肥鱼桌宠 —— agent extension（把会话事件翻译成桌宠状态）。
 *
 * 关键约束：桌宠每个循环动画是 241 帧 × 42ms ≈ 10 秒。**状态切换会让动画从头重播**，
 * 所以这里必须避免抖动——早期版本对每个 tool_call/tool_result 都发一条，
 * 一轮对话里 WORKING↔THINKING 来回切十几次，动画永远播不完，看起来就像“播放特别慢”。
 *
 * 策略：只发粗粒度状态 + 同状态去重 + 最小间隔节流。
 *   before_agent_start → THINKING
 *   tool_call          → WORKING（同一轮内只发第一次，之后保持）
 *   tool_result        → 仅出错时发 ERROR 脉冲，正常不发
 *   agent_settled      → SUCCESS 脉冲（几秒后自己回常驻文案）
 *   session_shutdown   → IDLE
 *
 * 事件名以 PI-Desktop 运行时为准（sidecar 的 extensionRunner 只 emit 这些）：
 *   before_agent_start / before_provider_request / before_provider_headers /
 *   after_provider_response / context / tool_call / tool_result /
 *   agent_settled / session_before_compact / session_info_changed / session_shutdown
 * 注意：turn_start、turn_end、agent_start、agent_end、message_start 在 PI-Desktop 里不存在。
 *
 * 另外：扩展进程里 APPDATA 可能为空，路径要用 os.homedir() 兜底。
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** 两次状态切换的最小间隔：小于它就不发，避免动画被反复重置 */
const MIN_GAP_MS = 900;

function stateFile() {
  const home = process.env.USERPROFILE || homedir();
  const roaming = process.env.APPDATA || join(home, "AppData", "Roaming");
  const dir = join(roaming, "PI-Desktop", "dafeiyu-pet-home", "dafeiyu-pet");
  mkdirSync(dir, { recursive: true });
  return join(dir, "state.jsonl");
}

function write(message) {
  try {
    const line = JSON.stringify({ protocolVersion: 1, timestamp: Date.now(), ...message }) + "\n";
    appendFileSync(stateFile(), line);
  } catch {
    /* 写不进去就当没发生，不能影响宿主 */
  }
}

let lastKey = "";
let lastAt = 0;
let workingSent = false;

function emitState(state, extra = {}) {
  const key = `state:${state}`;
  const now = Date.now();
  if (key === lastKey) return; // 同状态重复，跳过
  if (now - lastAt < MIN_GAP_MS) return; // 刚切过，先稳一会儿
  lastKey = key;
  lastAt = now;
  write({ kind: "state", state, ...extra });
}

function emitPulse(state, ttlMs) {
  const now = Date.now();
  if (now - lastAt < 300) return;
  lastKey = `pulse:${state}`;
  lastAt = now;
  write({ kind: "pulse", state, ttlMs });
}

export default function register(pi) {
  pi.on("before_agent_start", () => {
    workingSent = false;
    emitState("THINKING");
  });

  pi.on("tool_call", (event) => {
    // 一轮里只切一次「干活中」；连续工具调用不再重置动画
    if (workingSent) return;
    workingSent = true;
    emitState("WORKING", {
      toolName: String(event?.toolName ?? event?.name ?? "tool"),
    });
  });

  pi.on("tool_result", (event) => {
    const failed = event?.isError === true || event?.result?.isError === true;
    // 正常返回不切状态（保持 WORKING，动画不被打断）；出错才提示一下
    if (failed) emitPulse("ERROR", 2600);
  });

  pi.on("agent_settled", () => {
    workingSent = false;
    emitPulse("SUCCESS", 2400);
  });

  pi.on("session_shutdown", () => {
    workingSent = false;
    emitState("IDLE");
  });
}
