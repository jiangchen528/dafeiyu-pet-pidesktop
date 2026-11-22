/**
 * 大肥鱼桌宠 — PI-Desktop 插件入口（CommonJS，宿主注入全局 `pi`）。
 *
 * 原项目 lilulj/dsh-dafeiyu-pet 是 DSH/Cordis 插件；这里用 PI-Desktop 的插件 API
 * 重新装配：主进程 spawn helper.exe（Qt 桌宠窗口，JSONL stdio 协议），
 * 通过 pi.agent.registerTool 暴露动作/语音两个 AI 工具，并复用原插件的设置页。
 */

const { spawn } = require("node:child_process");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const { pathToFileURL } = require("node:url");

/** 数据目录：与 DSH 的 ~/.dsh 隔离 */
/**
 * 数据目录。
 * 注意：插件进程里 APPDATA / USERPROFILE 可能都是空的（沙箱环境），
 * 而 pi.plugin.getDataPath() 返回的是 Promise，不能直接 path.join，
 * 所以这里统一按「盘符家目录 + AppData\Roaming」同步拼出来。
 *
 * 关键：原插件的 config-store / settings-server / voice 都靠 DSH_DESKTOP_NEXT_HOME
 * 找数据目录。插件进程里这个变量没有，它们会退到 ~/.dsh，
 * 于是设置页写的是 ~/.dsh、主进程读的是 %APPDATA%，两边永远对不上
 * （表现就是"设置页保存了但没生效"）。这里统一指定，路径完全一致。
 */
const PI_HOME =
  process.env.APPDATA && process.env.APPDATA.length > 0
    ? path.join(process.env.APPDATA, "PI-Desktop", "dafeiyu-pet-home")
    : path.join(
        process.env.USERPROFILE || os.homedir(),
        "AppData",
        "Roaming",
        "PI-Desktop",
        "dafeiyu-pet-home",
      );
process.env.DSH_DESKTOP_NEXT_HOME = PI_HOME;

let stateDirCache = null;
function stateDir() {
  if (stateDirCache) return stateDirCache;
  stateDirCache = path.join(PI_HOME, "dafeiyu-pet");
  return stateDirCache;
}

/**
 * 素材根目录（helper.exe + assets + lib），也就是数据目录下的 dafeiyu-pet。
 * 仓库里不带素材（561MB），首次运行会按 ASSETS_URL 自动下载解压到这里。
 */
const PET_ROOT = stateDir();
const HELPER_EXE = path.join(PET_ROOT, "runtime", "bin", "win32-x64", "dsh-dafeiyu-helper.exe");
const MANIFEST = path.join(PET_ROOT, "assets", "pet-manifest.json");

/** 上游素材包（原作者的 GitHub Release，MIT） */
const ASSETS_URL =
  process.env.DAFEIYU_PET_ASSETS_URL ||
  "https://github.com/lilulj/dsh-dafeiyu-pet/releases/download/v1.0.0/dafeiyu-pet-assets-1.0.0.tar.gz";

const CONTROL_PORT = 7799;
const SETTINGS_PORT = 7811;

/** 素材原始帧间隔：animSpeed = 1 时的速度 */
const BASE_FRAME_MS = 42;
/** 受速度影响的循环状态动画（其余一次性动作保持原速，避免动作变形） */
const SPEED_STATES = ["idle", "thinking", "working", "waiting"];
const READY_TIMEOUT_MS = 180000;

const DEFAULT_CONFIG = {
  enabled: true,
  petName: "大肥鱼",
  actionDelayMs: 4500,
  activityLevel: "lively",
  scale: 0.6,
  bubbleScale: 0.8,
  voiceName: "zh-CN-XiaoyiNeural",
  voiceRate: 1.08,
  voicePitch: "+6Hz",
  idleSummary: "PI-Desktop · 待命中",
};

let child = null;
let ready = false;
let starting = false;
let queue = [];
let logStream = null;

function log(level, message) {
  const line = `${new Date().toISOString()} [${level}] ${message}\n`;
  // 同时写 stderr：宿主的插件日志会收下它，文件写失败时也能看到原因
  try {
    process.stderr.write(`[dafeiyu-pet] ${line}`);
  } catch {
    /* ignore */
  }
  try {
    if (!logStream) {
      fs.mkdirSync(stateDir(), { recursive: true });
      logStream = fs.createWriteStream(path.join(stateDir(), "plugin.log"), { flags: "a" });
      logStream.on("error", () => {
        logStream = null;
      });
    }
    logStream.write(line);
  } catch (error) {
    try {
      process.stderr.write(`[dafeiyu-pet] 日志写入失败：${error.message}\n`);
    } catch {
      /* ignore */
    }
  }
}

function readConfig() {
  try {
    const file = path.join(stateDir(), "config.json");
    if (!fs.existsSync(file)) return { ...DEFAULT_CONFIG };
    return { ...DEFAULT_CONFIG, ...JSON.parse(fs.readFileSync(file, "utf8")) };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

function killTree(target) {
  const pid = target && target.pid;
  if (pid) {
    try {
      const killer = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], {
        windowsHide: true,
        stdio: "ignore",
      });
      killer.on("error", () => {});
    } catch {
      /* ignore */
    }
  }
  try {
    target.kill();
  } catch {
    /* ignore */
  }
}

function send(message) {
  const line = `${JSON.stringify({ protocolVersion: 1, timestamp: Date.now(), ...message })}\n`;
  if (!child || !ready) {
    queue.push(line);
    if (queue.length > 50) queue.shift();
    return;
  }
  try {
    if (child.stdin.writable) child.stdin.write(line);
  } catch (error) {
    log("warn", `写入 helper 失败：${error.message}`);
  }
}

function clamp(value, lo, hi, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback;
}

/** 控制口已在响应就说明有实例在跑，别再造一只（热重载/多窗口时尤其重要） */
async function helperAlreadyRunning() {
  try {
    const response = await fetch(`http://127.0.0.1:${CONTROL_PORT}/health`, {
      signal: AbortSignal.timeout(900),
    });
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * 把 animSpeed 写进素材清单：helper 没有运行时改帧率的接口，
 * 只能改 manifest 里的 frameMs 再让它重启重读。
 * 返回 true 表示文件确实变了（需要重启桌宠）。
 */
function applyAnimSpeed(speed) {
  const value = Math.min(2.5, Math.max(0.5, Number(speed) || 1.5));
  const frameMs = Math.max(8, Math.round(BASE_FRAME_MS / value));
  try {
    const manifest = JSON.parse(fs.readFileSync(MANIFEST, "utf8"));
    let changed = false;
    for (const key of SPEED_STATES) {
      const clip = manifest.clips?.[key];
      if (!clip) continue;
      if (clip.frameMs !== frameMs) {
        clip.frameMs = frameMs;
        changed = true;
      }
    }
    if (changed) {
      fs.writeFileSync(MANIFEST, JSON.stringify(manifest), "utf8");
      log("info", `动画速度 ${value}x → ${frameMs}ms/帧（原 ${BASE_FRAME_MS}ms）`);
    }
    return changed;
  } catch (error) {
    log("warn", `应用动画速度失败：${error.message}`);
    return false;
  }
}

/** 重启期间禁止并发的 ensureHelper，否则两次启动会互相把对方杀掉 */
let restarting = false;

function restartHelper() {
  restarting = true;
  const target = child;
  child = null;
  ready = false;
  starting = false;
  queue = [];
  if (target) {
    // 注意：这里不能走 send()——此时 child 已置空，send 会把消息塞进队列，
    // 新进程就绪时又被 flush 出去，等于让刚起来的桌宠立刻收到 shutdown 自杀。
    try {
      target.stdin.write(
        JSON.stringify({
          protocolVersion: 1,
          timestamp: Date.now(),
          kind: "shutdown",
          reason: "restart",
        }) + "\n",
      );
      target.stdin.end();
    } catch {
      /* ignore */
    }
    killTree(target);
  }
  setTimeout(() => {
    restarting = false;
    void ensureHelper();
  }, 1500);
}

let configWatcher = null;
let lastAnimSpeed = null;

/** 设置页保存后 config.json 会变；速度变了就改清单并重启桌宠 */
function watchAnimSpeed() {
  const file = path.join(stateDir(), "config.json");
  lastAnimSpeed = Number(readConfig().animSpeed) || 1.5;
  try {
    configWatcher = fs.watchFile(file, { interval: 800 }, () => {
      const speed = Number(readConfig().animSpeed) || 1.5;
      if (Math.abs(speed - lastAnimSpeed) < 0.001) return;
      lastAnimSpeed = speed;
      log("info", `设置页把动画速度改为 ${speed}x`);
      if (applyAnimSpeed(speed)) restartHelper();
    });
  } catch (error) {
    log("warn", `监听配置失败：${error.message}`);
  }
}
/**
 * 首次运行要把素材装好：仓库里只有插件代码（<100KB），
 * helper.exe 与 104 个动作的素材包共约 580MB，从上游 Release 下载。
 * 用系统 curl（会自动走系统代理，node 的 fetch 不走）+ 系统 tar 解压。
 */
function downloadAssets() {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(PET_ROOT, { recursive: true });
    const archive = path.join(os.tmpdir(), `dafeiyu-assets-${Date.now()}.tar.gz`);
    const curl = process.platform === "win32" ? "curl.exe" : "curl";
    log("info", `开始下载素材（约 580MB，只此一次）：${ASSETS_URL}`);

    const dl = spawn(
      curl,
      ["-L", "--fail", "--retry", "3", "--connect-timeout", "30", "-o", archive, ASSETS_URL],
      { stdio: ["ignore", "ignore", "pipe"], windowsHide: true },
    );
    let dlErr = "";
    dl.stderr.on("data", (chunk) => {
      dlErr += chunk.toString();
    });
    dl.once("error", (error) => reject(new Error(`调用 curl 失败：${error.message}`)));
    dl.once("exit", (code) => {
      if (code !== 0) {
        try {
          fs.unlinkSync(archive);
        } catch {
          /* ignore */
        }
        reject(new Error(`下载失败（curl exit ${code}）：${dlErr.trim().slice(-200)}`));
        return;
      }
      log("info", "下载完成，开始解压…");
      const tar = spawn("tar", ["-xzf", archive, "-C", PET_ROOT], {
        stdio: ["ignore", "ignore", "pipe"],
        windowsHide: true,
      });
      let tarErr = "";
      tar.stderr.on("data", (chunk) => {
        tarErr += chunk.toString();
      });
      tar.once("error", (error) => {
        try {
          fs.unlinkSync(archive);
        } catch {
          /* ignore */
        }
        reject(new Error(`调用 tar 失败：${error.message}`));
      });
      tar.once("exit", (tarCode) => {
        try {
          fs.unlinkSync(archive);
        } catch {
          /* ignore */
        }
        if (tarCode !== 0) {
          reject(new Error(`解压失败（exit ${tarCode}）：${tarErr.trim().slice(-200)}`));
          return;
        }
        if (!fs.existsSync(MANIFEST)) {
          reject(new Error("解压完成但缺少 assets/pet-manifest.json，素材包结构可能不对"));
          return;
        }
        log("info", "素材安装完成");
        resolve();
      });
    });
  });
}

let assetsInstalling = false;

/** 素材齐全返回 true；缺失时下载一次（失败返回 false，不抛） */
async function ensureAssets() {
  if (fs.existsSync(MANIFEST) && fs.existsSync(HELPER_EXE)) return true;
  if (assetsInstalling) return false;
  assetsInstalling = true;
  try {
    await downloadAssets();
    return true;
  } catch (error) {
    log("error", `素材安装失败：${error.message}`);
    return false;
  } finally {
    assetsInstalling = false;
  }
}
async function ensureHelper() {
  if (child || starting || restarting) return;
  // 素材（helper.exe + 动作包）不在仓库里，首次运行先装好
  if (!(await ensureAssets())) return;
  if (await helperAlreadyRunning()) {
    log("info", `检测到已有的桌宠实例（控制口 ${CONTROL_PORT}），复用而不重复启动`);
    return;
  }
  // 启动前先把动画速度写进素材清单
  applyAnimSpeed(readConfig().animSpeed);
  startHelper();
}
function startHelper() {
  if (!fs.existsSync(MANIFEST)) {
    log("error", `素材缺失：${MANIFEST}`);
    return;
  }
  if (child || starting) return;
  if (!fs.existsSync(HELPER_EXE)) {
    log("error", `找不到 helper：${HELPER_EXE}`);
    return;
  }
  starting = true;
  fs.mkdirSync(stateDir(), { recursive: true });

  const tmp = path.join(stateDir(), "tmp");
  fs.mkdirSync(tmp, { recursive: true });

  const env = {
    ...process.env,
    DSH_DAFEIYU_LAYOUT_PATH: path.join(stateDir(), "layout.json"),
    DSH_DAFEIYU_LOG_FILE: path.join(stateDir(), "helper.log"),
    TEMP: tmp,
    TMP: tmp,
  };

  try {
    child = spawn(HELPER_EXE, [], {
      cwd: PET_ROOT,
      env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
  } catch (error) {
    starting = false;
    log("error", `spawn helper 失败：${error.message}`);
    return;
  }
  log("info", `helper 已启动 pid=${child.pid}`);

  child.stdin.on("error", () => {});
  child.stdout.on("error", () => {});
  child.stderr.on("error", () => {});

  let buffer = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (!line) continue;
      let reply;
      try {
        reply = JSON.parse(line);
      } catch {
        continue;
      }
      if (reply.kind === "ready") {
        ready = true;
        starting = false;
        log("info", "helper 就绪");
        const pending = queue.splice(0);
        for (const item of pending) {
          try {
            child.stdin.write(item);
          } catch {
            /* ignore */
          }
        }
        // 就绪后立刻下发一次配置（缩放/活跃度/打开地址）；不再重复发送，避免打断动画
        pushConfig();
      } else if (reply.kind === "closed") {
        log("info", "用户从右键菜单关闭了桌宠");
      }
    }
  });

  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    const text = String(chunk).trim();
    if (text) log("helper", text);
  });

  child.on("exit", (code) => {
    log("warn", `helper 退出 code=${code}`);
    child = null;
    ready = false;
    starting = false;
  });

  const timer = setTimeout(() => {
    if (!ready) log("warn", `${READY_TIMEOUT_MS}ms 内 helper 未就绪`);
  }, READY_TIMEOUT_MS);
  timer.unref?.();
}

function pushConfig() {
  const config = readConfig();
  const activity = ["quiet", "normal", "lively"].includes(String(config.activityLevel))
    ? String(config.activityLevel)
    : "lively";
  send({
    kind: "config",
    scale: clamp(config.scale, 0.55, 1.4, 0.6),
    bubbleScale: clamp(config.bubbleScale, 0.8, 1.2, 0.8),
    activityLevel: activity,
    reducedMotion: false,
    soundEnabled: true,
    soundStates: ["ERROR"],
    bubbleMode: "always",
    bubbleStates: ["SUCCESS", "ERROR", "WAITING"],
    // 右键「打开」菜单项会打开这个地址；留空会退回内置的 DSH 逻辑并报“无法打开 DSH”
    openUrl: `http://127.0.0.1:${SETTINGS_PORT}/`,
    openLabel: "打开桌宠设置",
  });
  pushBalance();
}

/**
 * 气泡左下角那行常驻文案（协议里的 balance.summary）。
 * 支持占位符，并在空闲时定时刷新，否则它永远是启动时那一句。
 *   {time}    → 14:23
 *   {date}    → 2026-11-22
 *   {weekday} → 六
 */
function formatSummary(raw) {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const weekday = "日一二三四五六"[now.getDay()];
  return String(raw)
    .replace(/\{time\}/g, `${pad(now.getHours())}:${pad(now.getMinutes())}`)
    .replace(/\{date\}/g, `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`)
    .replace(/\{weekday\}/g, weekday);
}

let lastSummary = "";
function pushBalance() {
  const config = readConfig();
  const raw = String(config.idleSummary || "🐳 待命中 · {time}");
  const summary = formatSummary(raw);
  if (summary !== lastSummary) {
    lastSummary = summary;
    log("info", `气泡文案 → ${summary}`);
  }
  send({ kind: "balance", summary });
}

let balanceTimer = null;

async function playClip(clip) {
  try {
    const response = await fetch(`http://127.0.0.1:${CONTROL_PORT}/play`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clip }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.ok === false) {
      log("warn", `播放 ${clip} 失败 HTTP ${response.status}`);
      return false;
    }
    log("info", `播放动作 ${clip}`);
    return true;
  } catch (error) {
    log("warn", `播放 ${clip} 异常：${error.message}`);
    return false;
  }
}

/**
 * 转发节流：agent extension 跑在 agent 进程里，插件热重载不会重载它，
 * 所以这里必须自己兜住——状态切换会让桌宠动画从头重播，
 * 241 帧 × 42ms ≈ 10 秒的循环被高频切断就等于"播放特别慢"。
 */
const FORWARD_MIN_GAP_MS = 900;
let lastForwardKey = "";
let lastForwardAt = 0;

function shouldForward(message) {
  const kind = String(message?.kind ?? "");
  const state = String(message?.state ?? "");
  const now = Date.now();
  // pulse 是短暂提示，放行但记时间
  if (kind === "pulse") {
    lastForwardKey = `${kind}:${state}`;
    lastForwardAt = now;
    return true;
  }
  if (kind === "state") {
    const key = `${kind}:${state}`;
    if (key === lastForwardKey) return false; // 同状态重复
    if (now - lastForwardAt < FORWARD_MIN_GAP_MS) return false; // 太密
    lastForwardKey = key;
    lastForwardAt = now;
    return true;
  }
  return true;
}

/**
 * 语音模块按需加载。
 * ESM 对同一 URL 只执行一次，改了 voice.js 后插件进程仍会拿到旧模块，
 * 所以带时间戳查询串强制重新加载（模块级变量在插件重载时会重置）。
 */
let voiceModule = null;
async function loadVoiceModule() {
  if (!voiceModule) {
    const url = `${pathToFileURL(path.join(PET_ROOT, "lib", "voice.js")).href}?t=${Date.now()}`;
    voiceModule = await import(url);
  }
  return voiceModule;
}
let settingsServer = null;

/**
 * pulse 是「临时提示」：ttl 到期后 helper 会退回**上一个 state**，
 * 而上一轮的状态通常是 WORKING，于是气泡一直卡在「干活中」。
 * 所以脉冲后必须补一条真正的 state:IDLE，让它回到待命。
 */
let idleTimer = null;
function scheduleIdleAfterPulse(message) {
  const kind = String(message?.kind ?? "");
  if (kind === "state") {
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
    return;
  }
  if (kind !== "pulse") return;
  const ttl = Number(message?.ttlMs) || 2000;
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    idleTimer = null;
    lastForwardKey = "state:IDLE";
    lastForwardAt = Date.now();
    send({ kind: "state", state: "IDLE" });
    log("info", "脉冲结束，气泡回到待命");
  }, ttl + 400);
  idleTimer.unref?.();
}
let forwardDropped = 0;

/** 状态桥：agent extension 把事件追加到 state.jsonl，这里转发成helper 能懂的 JSONL */
let stateWatcher = null;
let stateOffset = 0;

function stateFile() {
  return path.join(stateDir(), "state.jsonl");
}

function drainState() {
  const file = stateFile();
  try {
    const size = fs.statSync(file).size;
    if (size < stateOffset) stateOffset = 0;
    if (size === stateOffset) return;
    const fd = fs.openSync(file, "r");
    const buffer = Buffer.alloc(size - stateOffset);
    fs.readSync(fd, buffer, 0, buffer.length, stateOffset);
    fs.closeSync(fd);
    stateOffset = size;
    for (const line of buffer.toString("utf8").split("\n")) {
      const text = line.trim();
      if (!text) continue;
      let message;
      try {
        message = JSON.parse(text);
      } catch {
        continue;
      }
      if (!shouldForward(message)) {
        forwardDropped += 1;
        continue;
      }
      if (forwardDropped > 0) {
        log("info", `跳过 ${forwardDropped} 条高频状态（避免动画被反复重置）`);
        forwardDropped = 0;
      }
      send(message);
      scheduleIdleAfterPulse(message);
    }
  } catch {
    /* 文件暂时不可读就跳过这一轮 */
  }
}

function startStateBridge() {
  const file = stateFile();
  try {
    fs.mkdirSync(stateDir(), { recursive: true });
    fs.writeFileSync(file, "");
    stateOffset = 0;
    stateWatcher = fs.watch(file, { persistent: false }, () => drainState());
    stateWatcher.on?.("error", () => {
      stateWatcher = null;
    });
    log("info", "状态桥已接上（agent 事件 → 桌宠状态）");
  } catch (error) {
    log("warn", `状态桥启动失败：${error.message}`);
  }
}
async function startSettingsPage() {
  try {
    const mod = await import(pathToFileURL(path.join(PET_ROOT, "lib", "settings-server.js")).href);
    settingsServer = mod.startSettingsServer({
      port: SETTINGS_PORT,
      logger: { info: (m) => log("info", m), warn: (m) => log("warn", m), error: (m) => log("error", m) },
    });
    log("info", `设置页 http://127.0.0.1:${SETTINGS_PORT}/`);
  } catch (error) {
    log("warn", `设置页启动失败：${error.message}`);
  }
}

async function onLoad() {
  try {
    const config = readConfig();
    if (config.enabled === false) {
      log("info", "配置里已禁用，桌宠不启动");
    } else {
      await ensureHelper();
      // 等 helper READY 后再发 config，避免被丢弃
      void startSettingsPage();
      startStateBridge();
      watchAnimSpeed();
      // 每 30 秒刷新一次常驻文案，{time} 这类占位符才会跟着走
      balanceTimer = setInterval(() => {
        if (ready) pushBalance();
      }, 30000);
      balanceTimer.unref?.();
    }

    await pi.agent.registerTool({
      name: "dafeiyu_play_action",
      description:
        "让桌面上的大肥鱼做一个动作。回完话之后调用一次，让她的动作和内容对上。" +
        "情绪用 ext_happy/ext_shy/ext_angry，互动用 poke/head_pat/tail，写代码用 ext_coding，吃东西用 ext_rice/ext_snack。",
      risk: "low",
      schema: {
        type: "object",
        properties: { clip: { type: "string", description: "动作 id，例如 ext_happy" } },
        required: ["clip"],
        additionalProperties: false,
      },
      execute: async (args) => {
        const clip = String(args?.clip ?? "").trim();
        if (!clip) return { ok: false, error: "clip 不能为空" };
        const ok = await playClip(clip);
        return { ok, clip };
      },
    });

    await pi.agent.registerTool({
      name: "dafeiyu_speak",
      description: "用大肥鱼的声音在电脑上念一句话（edge-tts 合成，本机播放，不需要 key）。",
      risk: "low",
      schema: {
        type: "object",
        properties: { text: { type: "string", description: "要念出来的话，一到两句" } },
        required: ["text"],
        additionalProperties: false,
      },
      execute: async (args) => {
        const text = String(args?.text ?? "").trim();
        if (!text) return { ok: false, error: "text 不能为空" };
        try {
          const voice = await loadVoiceModule();
          await voice.speak(text, { qq: false, config: readConfig() });
          log("info", "本地语音已播放");
          return { ok: true, mode: "local" };
        } catch (error) {
          log("warn", `语音失败：${error.message}`);
          return { ok: false, error: error.message };
        }
      },
    });

    log("info", "工具已注册：dafeiyu_play_action / dafeiyu_speak");
  } catch (error) {
    log("error", `onLoad 失败：${error?.stack || error}`);
  }
}

async function onUnload() {
  try {
    await pi.agent.unregisterTool("dafeiyu_play_action");
    await pi.agent.unregisterTool("dafeiyu_speak");
  } catch {
    /* 工具可能未注册 */
  }
  try {
    settingsServer?.close?.();
  } catch {
    /* ignore */
  }
  settingsServer = null;
  try {
    stateWatcher?.close?.();
  } catch {
    /* ignore */
  }
  stateWatcher = null;
  try {
    if (configWatcher) fs.unwatchFile(path.join(stateDir(), "config.json"));
  } catch {
    /* ignore */
  }
  configWatcher = null;
  if (balanceTimer) {
    clearInterval(balanceTimer);
    balanceTimer = null;
  }
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
  if (child) {
    const target = child;
    try {
      send({ kind: "shutdown", reason: "plugin-unload" });
    } catch {
      /* ignore */
    }
    try {
      target.stdin.end();
    } catch {
      /* ignore */
    }
    // 必须同步杀掉并连进程树一起杀：PyInstaller onefile 有父+子两个进程，
    // 只 kill 父进程会留下子进程继续占用 7799，下次启动就检测成“已有实例”。
    killTree(target);
    child = null;
    ready = false;
    starting = false;
  }
  log("info", "插件已卸载");
}

module.exports = { onLoad, onUnload };
