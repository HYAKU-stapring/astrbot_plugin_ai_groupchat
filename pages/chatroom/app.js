/* ai_groupchat 前端逻辑 v1.9.0：全外链加载，index.html 内 0 个内联 <script>。
   宿主会破坏内联 <script>（表现为 Invalid or unexpected token），
   因此本文件是唯一脚本载体，与已跑通的 diary 插件范式一致。 */
/* ==========================================================================
 * ai_groupchat 前端（v1.9.0 —— 拟真群聊版）
 * 本版在 v1.8.0 手机窄栏基础上新增 4 类"更像真人群聊"的能力：
 *   8. 连锁接话：模型一轮可返回多条、同一角色可多次发言，气泡上显示
 *      "回复 某某" 引用条，还原 A 说 -> B 怼 -> A 震惊 的连续互动；
 *   9. 分段刷屏：content 里的分隔符（默认反斜杠）把一条话切成多条气泡，
 *      逐条带打字间隔弹出，一个人也能刷屏；两个连续符号 = 字面转义；
 *  10. 输入中提示：等待期显示"N 人输入中…"，人数不超过 typingNames（默认 3）
 *      时直接点名"A、B、C 输入中…"；随后按角色逐条播放"某某输入中…"，
 *      时长按字数拟真，偶尔还会"打了一半又删掉"；
 *  11. 拟真增强包：消息引用、表情回应、消息撤回、时间分隔条、已读回执、
 *      连续发言合并头像、新消息计数、时段语感（后端注入当前时间）。
 *  所有拟真参数在设置弹窗「拟真」页可实时调整，存 localStorage。
 * 本版本在 v1.7.0 基础上补齐 7 项能力：
 *   1. 手机式窄栏布局：整站收进 460px 居中"手机壳"，侧边栏改抽屉，
 *      消息不再被拉到屏幕两侧；
 *   2. 聊天记录滚动：根因是 grid 子项 min-height:auto 让 .chat-log 的
 *      overflow-y:auto 完全失效（行被内容撑高 -> 输入栏被顶出视口）。
 *      现在 grid 行用 minmax(0,1fr) + min-height:0 双保险，并加了
 *      "智能吸底"：用户手动上滑看历史时不再被强行拉回底部；
 *   3. 表情引用：面板重定位到输入栏上方并加宽，内置 48 个 Unicode 表情
 *      兜底（原来表情库为空时面板是 0 高度，点😀看起来"没反应"），
 *      支持点击外部收起、已选表情缩略图与一键取消；
 *   4. 识图发图：📷 / 粘贴 / 拖拽 三种入口，前端 canvas 压缩后随消息
 *      上传，后端交给视觉模型；模型不支持视觉时自动降级并提示；
 *   5. 自定义聊天背景：内置预设 + 自定义图片 + CSS 颜色/渐变，
 *      可按房间保存，也可存为全局默认；
 *   6. @提及：输入 @ 弹角色浮层，支持上下键 / Enter / Tab 选择，
 *      被 @ 的角色在后端提示词里被强制要求接话，前端高亮显示；
 *   7. 自主对话：可设间隔秒数 + 随机偏移秒数 + 每轮发言人数上限，
 *      递归 setTimeout 实现"间隔 + 随机抖动"，按钮实时显示倒计时，
 *      配置按房间存 localStorage，切房自动接管。
 *
 * 沿用上版的三条硬规矩：
 *   a. 全文件 0 个内联事件属性（onclick / onerror），一律 addEventListener
 *      + data-* 事件委托；
 *   b. 全文件 0 个 innerHTML，节点一律 createElement + textContent；
 *   c. 所有函数都在 IIFE 内，调试入口 window.__aiGroupChat。
 * ========================================================================== */
"use strict";
(function () {
  var PLUGIN = "ai_groupchat";
  var bridge = null;
  var rooms = [];
  var roles = [];
  var emojis = [];
  var history = [];
  var summaries = [];
  var currentRoomId = null;
  var selectedEmojiName = "";
  var newAvatarB64 = "";
  var newEmojiB64 = "";
  var allowYoosungPrivate = false;
  var memItems = [];
  var pendingImage = "";            /* 待发送图片 dataURL */
  var currentBg = "";               /* 当前房间背景值 */
  var stickBottom = true;           /* 是否吸底 */
  var themeManual = null;           /* 手动指定的主题 */

  /* ---- v2.0.0 QQ 化社交视图状态 ---- */
  var currentView = "messages";      /* messages | friends | moments | settings */
  var chatOpen = false;              /* 聊天覆盖层是否打开 */
  var profileOpen = false;           /* 资料主页覆盖层是否打开 */
  var conversations = [];            /* 会话列表（群聊+私聊） */
  var friends = [];                 /* 好友（全部角色） */
  var moments = [];                  /* 动态信息流 */
  var currentConv = null;            /* 当前会话对象 {conv_id, kind, role_key, name, avatar} */
  var profileKey = "";               /* 当前资料页 role_key */
  var emoTab = "uni";                /* 表情面板标签：uni | pack */
  var ctxMenu = null;               /* 长按上下文菜单节点 */
  /* ---- v2.1.0 状态 ---- */
  var USER_NICK = "我";              /* 用户昵称（设置页可改） */
  var USER_AVATAR = "";              /* 用户头像 dataURL */
  var friendGroups = [];             /* 好友自定义分组 [{name, keys}] */
  var collapsedGroups = {};          /* 折叠的分组名 */
  var lightboxList = [];             /* 大图查看器图片列表（左右切换） */
  var lightboxIdx = 0;
  var RENDER_BATCH = 50;             /* 消息懒加载批大小 */
  var renderFrom = 0;                /* 已渲染到的 history 下标 */
  var renderTarget = null;           /* 懒加载追加上屏时的目标容器 */
  var lazyReady = false;             /* 首屏定位到底部后才允许懒加载，避免打开会话瞬间误触发 */
  var loadingOlder = false;          /* 加载历史期间禁止自动吸底/累计新消息，否则破坏阅读锚点 */
  var quickReplies = [];             /* 快捷回复短语 */
  var draftTimer = null;
  var pendingMomentImage = "";       /* 待发动态附图 */
  /* ---- v1.9.0 拟真群聊状态 ---- */
  var DEFAULT_SPLIT = "\\";      /* 分段刷屏符号，与后端默认一致 */
  var REAL = {
    splitSymbol: DEFAULT_SPLIT,     /* 分段符号，空字符串 = 关闭刷屏 */
    allowMultiRound: true,          /* 允许连锁接话（同一角色多次发言） */
    maxReplyMessages: 8,            /* 一轮最多多少条气泡 */
    timeAwareness: true,            /* 时段语感（后端注入当前时间） */
    typingEnabled: true,            /* 输入中提示 */
    typingNames: 3,                 /* 最多显示几个人名，超过则显示"N 人输入中" */
    typeSpeed: 1,                   /* 打字速度倍率，越大越快 */
    readReceipt: true,              /* 已读回执 */
    timeDivider: true,              /* 时间分隔条 */
    mergeAvatar: true,              /* 连续发言合并头像 */
    typingInterrupt: true           /* 偶发"打一半又删掉" */
  };
  var quoteDraft = null;            /* 当前引用中的消息对象 */
  var reactionMap = {};             /* {msg_id: [emoji,...]} */
  var lastMsgAt = 0;                /* 上一条消息时间戳，用于时间分隔条 */
  var lastWho = "";                 /* 上一条消息发言人，用于合并头像 */
  var newMsgCount = 0;              /* 上滑看历史期间累计的新消息数 */
  var typingTimer = null;
  var typingSeq = 0;                /* 防止上一轮的 typing 定时器串到新轮 */
  var reactPickerFor = null;        /* 当前弹出表情回应选择器的消息 id */
  /* 由 /api/config 下发的运行时配置（插件配置页可改） */
  var IMG_MAX_SIDE = 1024;
  var VISION_ENABLED = true;

  /* 内置 Unicode 表情：表情库为空时也能立刻用，解决"点😀出不来" */
  var UNI_EMOJI = [
    "😀", "😂", "🤣", "😊", "😍", "😘", "😜", "🤪",
    "🤔", "😏", "😌", "😴", "🥱", "😎", "🥳", "😭",
    "😅", "🙂", "🙃", "😇", "🤗", "🤭", "😳", "🥺",
    "😤", "😡", "🤯", "😱", "🤢", "🤒", "🤕", "🤠",
    "👍", "👎", "👏", "🙏", "💪", "👀", "🧠", "❤️",
    "💔", "🔥", "✨", "🎉", "🍚", "☕", "🌙", "⭐"
  ];

  /* 内置聊天背景预设 */
  var BG_PRESETS = [
    { name: "无", value: "none", css: "repeating-linear-gradient(45deg,#f2f2f2 0 8px,#fff 8px 16px)" },
    { name: "浅灰", value: "color:#eceff3", css: "#eceff3" },
    { name: "薄荷", value: "color:linear-gradient(160deg,#e0f7fa,#f1f8e9)", css: "linear-gradient(160deg,#e0f7fa,#f1f8e9)" },
    { name: "暖阳", value: "color:linear-gradient(160deg,#fff5e6,#ffe3ec)", css: "linear-gradient(160deg,#fff5e6,#ffe3ec)" },
    { name: "天空", value: "color:linear-gradient(180deg,#e0eafc,#cfdef3)", css: "linear-gradient(180deg,#e0eafc,#cfdef3)" },
    { name: "竹青", value: "color:#dfe7dd", css: "#dfe7dd" },
    { name: "暗夜", value: "color:#1b1f24", css: "#1b1f24" },
    { name: "紫雾", value: "color:linear-gradient(160deg,#e8e0f7,#d9e4f5)", css: "linear-gradient(160deg,#e8e0f7,#d9e4f5)" }
  ];

  /* ------------------------------ 基础工具 ------------------------------ */
  function $(id) { return document.getElementById(id); }

  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) { node.className = cls; }
    if (text !== undefined && text !== null) { node.textContent = String(text); }
    return node;
  }

  function clearNode(node) {
    while (node && node.firstChild) { node.removeChild(node.firstChild); }
  }

  function initial(name) {
    var s = String(name || "?").trim();
    return s ? s.charAt(0).toUpperCase() : "?";
  }

  function escapeRegExp(s) {
    return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  function lsGet(key, def) {
    try {
      var v = window.localStorage.getItem(key);
      return v === null || v === undefined ? def : v;
    } catch (e) { return def; }
  }

  function lsSet(key, val) {
    try { window.localStorage.setItem(key, val); } catch (e) { /* 沙箱禁用时忽略 */ }
  }

  /* 头像：有图用 img，图裂/无图退化为姓氏首字占位，不写 onerror 属性 */
  function makeAvatar(cls, src, name) {
    if (!src) { return el("div", cls + " avatar-fallback", initial(name)); }
    var img = el("img", cls);
    img.addEventListener("error", function () {
      var ph = el("div", cls + " avatar-fallback", initial(name));
      if (img.parentNode) { img.parentNode.replaceChild(ph, img); }
    });
    img.src = src;
    return img;
  }

  function toast(msg, isErr) {
    var node = $("toast");
    node.textContent = String(msg);
    node.className = "toast show" + (isErr ? " err" : "");
    if (node._t) { clearTimeout(node._t); }
    node._t = setTimeout(function () { node.className = "toast"; }, 3600);
  }

  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  function clampNum(v, min, max, def) {
    var n = Number(v);
    if (!isFinite(n)) { return def; }
    n = Math.round(n);
    return Math.min(max, Math.max(min, n));
  }
  /* 按分隔符把一段话切成多条消息（与后端 _split_segments 同规则）：
     连续两个符号视为转义，输出一个字面符号；逐条 trim 后丢弃空段。 */
  function splitSegments(text, symbol) {
    var sym = (symbol === undefined) ? REAL.splitSymbol : symbol;
    var t = String(text || "");
    if (!sym || t.indexOf(sym) === -1) { return t.trim() ? [t.trim()] : []; }
    var ph = "\u0000AGCESC\u0000";
    var tmp = t.split(sym + sym).join(ph);
    var out = [];
    tmp.split(sym).forEach(function (piece) {
      piece = piece.split(ph).join(sym).trim();
      if (piece) { out.push(piece); }
    });
    return out;
  }

  /* ------------------------------ 拟真配置（localStorage） ------------------------------ */
  function loadRealCfg() {
    var raw = lsGet("agc_real", "");
    if (raw) {
      try {
        var o = JSON.parse(raw);
        if (typeof o.splitSymbol === "string") { REAL.splitSymbol = o.splitSymbol.slice(0, 2); }
        ["allowMultiRound", "timeAwareness", "typingEnabled", "readReceipt",
         "timeDivider", "mergeAvatar", "typingInterrupt"].forEach(function (k) {
          if (typeof o[k] === "boolean") { REAL[k] = o[k]; }
        });
        REAL.maxReplyMessages = clampNum(o.maxReplyMessages, 1, 30, 8);
        REAL.typingNames = clampNum(o.typingNames, 0, 10, 3);
        REAL.typeSpeed = (function () {
          var n = Number(o.typeSpeed);
          return isFinite(n) && n > 0 ? Math.min(5, Math.max(0.2, n)) : 1;
        })();
      } catch (e) { /* 配置损坏用默认值 */ }
    }
    renderRealPanel();
  }

  function saveRealCfg() {
    lsSet("agc_real", JSON.stringify(REAL));
    renderRealPanel();
  }

  /* 随每个请求下发给后端的拟真参数 */
  function buildOpts() {
    return {
      split_symbol: REAL.splitSymbol,
      allow_multi_round: REAL.allowMultiRound,
      max_reply_messages: REAL.maxReplyMessages,
      time_awareness: REAL.timeAwareness
    };
  }

  function renderRealPanel() {
    if ($("realSplit")) { $("realSplit").value = REAL.splitSymbol; }
    if ($("realMaxMsg")) { $("realMaxMsg").value = REAL.maxReplyMessages; }
    if ($("realTypingNames")) { $("realTypingNames").value = REAL.typingNames; }
    if ($("realTypeSpeed")) { $("realTypeSpeed").value = REAL.typeSpeed; }
    var sw = {
      switchMulti: REAL.allowMultiRound, switchTimeAw: REAL.timeAwareness,
      switchTyping: REAL.typingEnabled, switchRead: REAL.readReceipt,
      switchDivider: REAL.timeDivider, switchMerge: REAL.mergeAvatar,
      switchInterrupt: REAL.typingInterrupt
    };
    Object.keys(sw).forEach(function (id) {
      var node = $(id);
      if (node) { node.classList.toggle("on", !!sw[id]); }
    });
    if ($("realStatus")) {
      $("realStatus").textContent = "分段符号：" + (REAL.splitSymbol || "（已关闭）") +
        " ｜ 一轮最多 " + REAL.maxReplyMessages + " 条 ｜ 输入中显示 " +
        (REAL.typingNames > 0 ? "最多 " + REAL.typingNames + " 个人名" : "只显示人数") +
        " ｜ 打字速度 " + REAL.typeSpeed + "x";
    }
  }

  /* ------------------------------ 页面内对话框 ------------------------------ *
   * 宿主把本页放在 sandbox iframe 中且没有开放 allow-modals，
   * window.prompt / confirm / alert 会被静默忽略，因此自绘模态框。
   * v1.8 起 type 额外支持 "number" 与 "select"。
   * ======================================================================== */
  function ensureDialogDom() {
    var mask = $("agcDialog");
    if (!mask) {
      mask = el("div", "dlg-mask");
      mask.id = "agcDialog";
      var box = el("div", "dlg-box");
      var title = el("div", "dlg-title");
      var body = el("div", "dlg-body");
      var foot = el("div", "dlg-foot");
      var cancel = el("button", "dlg-cancel", "取消");
      var ok = el("button", "dlg-ok", "确定");
      cancel.type = "button";
      ok.type = "button";
      foot.appendChild(cancel);
      foot.appendChild(ok);
      box.appendChild(title);
      box.appendChild(body);
      box.appendChild(foot);
      mask.appendChild(box);
      document.body.appendChild(mask);
    }
    if (!mask._bound) {
      mask._bound = true;
      var okEl = mask.querySelector(".dlg-ok");
      var cancelEl = mask.querySelector(".dlg-cancel");
      if (okEl) { okEl.addEventListener("click", function () { if (mask._submit) { mask._submit(); } }); }
      if (cancelEl) { cancelEl.addEventListener("click", function () { closeDialog(mask, null); }); }
      mask.addEventListener("click", function (e) { if (e.target === mask) { closeDialog(mask, null); } });
    }
    return mask;
  }

  function closeDialog(mask, result) {
    mask.classList.remove("show");
    if (mask._onKey) {
      document.removeEventListener("keydown", mask._onKey, true);
      mask._onKey = null;
    }
    var resolve = mask._resolve;
    mask._resolve = null;
    if (resolve) { resolve(result); }
  }

  function openDialog(opts) {
    opts = opts || {};
    var mask = ensureDialogDom();
    if (mask.classList.contains("show")) { closeDialog(mask, null); }

    var title = mask.querySelector(".dlg-title");
    var body = mask.querySelector(".dlg-body");
    var okBtn = mask.querySelector(".dlg-ok");
    var cancelBtn = mask.querySelector(".dlg-cancel");

    clearNode(title);
    title.appendChild(document.createTextNode(opts.title || "提示"));
    clearNode(body);
    if (opts.message) { body.appendChild(el("div", "dlg-msg", opts.message)); }

    var fields = opts.fields || [];
    var store = {};
    fields.forEach(function (f) {
      var item = el("div", "dlg-field");
      if (f.label) { item.appendChild(el("label", null, f.label)); }
      var node;
      if (f.type === "textarea") {
        node = el("textarea");
        node.rows = f.rows || 5;
        node.value = f.value || "";
      } else if (f.type === "file") {
        node = el("input");
        node.type = "file";
        node.accept = "image/*";
      } else if (f.type === "number") {
        node = el("input");
        node.type = "number";
        if (f.min !== undefined) { node.min = f.min; }
        if (f.max !== undefined) { node.max = f.max; }
        node.step = f.step || 1;
        node.value = (f.value === undefined || f.value === null) ? "" : f.value;
      } else if (f.type === "select") {
        node = el("select");
        (f.options || []).forEach(function (op) {
          var o = el("option", null, op.label);
          o.value = op.value;
          if (String(op.value) === String(f.value)) { o.selected = true; }
          node.appendChild(o);
        });
      } else {
        node = el("input");
        node.type = "text";
        node.value = f.value || "";
      }
      if (f.placeholder) { node.placeholder = f.placeholder; }
      item.appendChild(node);
      var hintNode = null;
      if (f.hint) { hintNode = el("small", "dlg-hint", f.hint); item.appendChild(hintNode); }
      body.appendChild(item);
      store[f.key] = { def: f, node: node, value: f.value || "" };
      if (f.type === "file") {
        node.addEventListener("change", function () {
          var file = node.files && node.files[0];
          if (!file) { return; }
          readFile(file).then(function (dataUrl) {
            store[f.key].value = dataUrl;
            if (hintNode) { hintNode.textContent = "已选择新图片：" + file.name; }
          });
        });
      }
    });

    function submit() {
      var out = {};
      for (var i = 0; i < fields.length; i++) {
        var f = fields[i];
        var it = store[f.key];
        if (f.type === "file") { out[f.key] = it.value || ""; continue; }
        if (f.type === "number") { out[f.key] = it.node.value; continue; }
        var v = String(it.node.value || "");
        if (!f.optional && v.trim() === "") {
          toast((f.label || "内容") + "不能为空", true);
          it.node.focus();
          return;
        }
        out[f.key] = v;
      }
      closeDialog(mask, out);
    }

    okBtn.textContent = opts.okText || "确定";
    cancelBtn.textContent = opts.cancelText || "取消";
    mask._submit = submit;

    mask._onKey = function (e) {
      if (e.key === "Escape") { e.stopPropagation(); closeDialog(mask, null); }
      else if (e.key === "Enter" && !e.shiftKey && e.target && e.target.tagName === "INPUT") {
        e.preventDefault();
        e.stopPropagation();
        submit();
      }
    };
    document.addEventListener("keydown", mask._onKey, true);

    mask.classList.add("show");
    var first = body.querySelector("input[type=text], input[type=number], textarea, select");
    if (first) { setTimeout(function () { first.focus(); }, 30); }

    return new Promise(function (resolve) { mask._resolve = resolve; });
  }

  function uiPrompt(title, message, defaultValue, opts) {
    opts = opts || {};
    return openDialog({
      title: title,
      message: message,
      okText: opts.okText || "确定",
      fields: [{
        key: "value", label: opts.label || "内容",
        type: opts.multiline ? "textarea" : "text",
        value: defaultValue || "", placeholder: opts.placeholder || "", rows: opts.rows || 5
      }]
    }).then(function (v) { return v ? v.value : null; });
  }

  function uiConfirm(title, message, okText) {
    return openDialog({ title: title, message: message, okText: okText || "确定", fields: [] })
      .then(function (v) { return !!v; });
  }

  /* ------------------------------ 自检面板 ------------------------------ */
  var DIAG = {
    build: "qq-2026-11-20-3",
    plugin: "", script: "app.js 已执行", bridge: "未开始", api: "未测试",
    last: "-", err: [], bridgeMs: 0
  };

  function diag(key, val) {
    if (key === "apiErr") {
      if (DIAG.err.length < 8) { DIAG.err.push(String(val)); }
      DIAG.api = "失败";
    } else { DIAG[key] = val; }
    renderDiag();
  }

  function renderDiag() {
    var body = $("agcDiagBody");
    if (!body) { return; }
    var panel = $("agcDiag"), toggle = $("agcDiagToggle");
    var wantDiag = /[?&]diag=1/.test(window.location.search);
    var broken = DIAG.err.length > 0 || String(DIAG.bridge).indexOf("ok") !== 0;
    if (panel) {
      if (broken || wantDiag) {
        panel.className = "show";
        if (toggle) { toggle.textContent = "自检面板 -"; }
      } else { panel.className = ""; }
    }
    clearNode(body);
    function line(k, v, cls) {
      var row = el("div");
      row.appendChild(el("span", "k", k + " "));
      row.appendChild(el("span", cls || "", String(v)));
      body.appendChild(row);
    }
    line("build", DIAG.build);
    line("插件名", DIAG.plugin || "-");
    line("脚本通道", DIAG.script, "ok");
    line("桥接", DIAG.bridge, DIAG.bridge === "ok" ? "ok" : "bad");
    line("接口", DIAG.api, DIAG.api === "ok" ? "ok" : (DIAG.api === "未测试" ? "warn" : "bad"));
    line("最近请求", DIAG.last);
    line("URL", window.location.href.slice(0, 120));
    if (DIAG.err.length > 0) {
      body.appendChild(el("div", "bad", "-- 捕获到 " + DIAG.err.length + " 条报错 --"));
      for (var i = 0; i < DIAG.err.length; i++) {
        body.appendChild(el("div", "bad", "[" + (i + 1) + "] " + DIAG.err[i]));
      }
    }
  }

  function initDiag() {
    var head = $("agcDiagHead"), panel = $("agcDiag"), toggle = $("agcDiagToggle");
    if (toggle && head) {
      head.addEventListener("click", function () {
        var opened = panel.className.indexOf("show") >= 0;
        panel.className = opened ? "" : "show";
        toggle.textContent = opened ? "自检面板 +" : "自检面板 -";
      });
    }
    var seg = window.location.pathname.split("/");
    DIAG.plugin = seg[seg.indexOf("content") + 1] || PLUGIN;
    window.addEventListener("error", function (e) {
      diag("apiErr", "error: " + (e.message || "unknown") + " @" + String(e.filename || "").slice(0, 60) + ":" + e.lineno);
    });
    window.addEventListener("unhandledrejection", function (e) {
      var r = e.reason;
      diag("apiErr", "promise: " + (r && r.message ? r.message : String(r)));
    });
    renderDiag();
  }

  /* ------------------------------ 桥接层 ------------------------------ */
  function ensureBridge(timeout) {
    timeout = timeout || 15000;
    return new Promise(function (resolve, reject) {
      var t0 = Date.now();
      (function check() {
        if (window.AstrBotPluginPage) { return resolve(window.AstrBotPluginPage); }
        if (Date.now() - t0 > timeout) {
          return reject(new Error("未检测到 AstrBotPluginPage 桥接对象：请确认 metadata.yaml 已写 dashboard 字段、插件已启用、且页面是从 WebUI 侧边栏进入的"));
        }
        setTimeout(check, 50);
      })();
    });
  }

  function unwrap(res) {
    var cur = res, guard = 0;
    while (cur && typeof cur === "object" && guard < 6) {
      guard += 1;
      if (cur.data && typeof cur.data === "object") {
        var rest = Object.keys(cur).filter(function (k) { return k !== "ok" && k !== "data"; });
        if (rest.length === 0) { cur = cur.data; continue; }
      }
      break;
    }
    return cur;
  }

  function toEndpoint(path) {
    var p = String(path || "");
    if (p.indexOf(PLUGIN + "/") === 0) { p = p.slice(PLUGIN.length + 1); }
    if (p.charAt(0) !== "/") { p = "/" + p; }
    return "/api" + p;
  }

  async function proxyCall(endpoint, params, body) {
    var b = bridge || (bridge = await ensureBridge());
    var payload = { path: endpoint, method: body ? "POST" : "GET" };
    if (params && Object.keys(params).length > 0) { payload.params = params; }
    if (body) { payload.body = body; }
    diag("last", endpoint);
    var raw = await b.apiPost("ui/proxy", payload);
    return unwrap(raw);
  }

  async function apiGet(path, params) {
    try {
      return await proxyCall(toEndpoint(path), params || {}, null);
    } catch (e) {
      diag("apiErr", (e && e.message ? e.message : String(e)));
      toast("请求失败：" + (e && e.message ? e.message : e), true);
      return null;
    }
  }

  async function apiPost(path, body) {
    try {
      return await proxyCall(toEndpoint(path), {}, body || {});
    } catch (e) {
      diag("apiErr", (e && e.message ? e.message : String(e)));
      toast("请求失败：" + (e && e.message ? e.message : e), true);
      return null;
    }
  }

  /* ------------------------------ 主题 ------------------------------ */
  function applyTheme(force) {
    var theme = force || themeManual;
    if (theme !== "dark" && theme !== "light") {
      var q = new URLSearchParams(window.location.search);
      theme = q.get("theme");
      if (theme !== "dark" && theme !== "light") {
        theme = (window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches) ? "dark" : "light";
      }
    }
    themeManual = theme;
    lsSet("agc_theme", theme);
    document.documentElement.setAttribute("data-theme", theme);
  }

  function toggleTheme() {
    applyTheme(themeManual === "dark" ? "light" : "dark");
    toast(themeManual === "dark" ? "已切换为深色" : "已切换为浅色");
  }

  /* ------------------------------ 主视图导航 ------------------------------ */
  function switchTab(name) {
    currentView = name;
    document.querySelectorAll(".view").forEach(function (v) { v.classList.remove("active"); });
    var view = $(name === "messages" ? "viewMessages" : name === "friends" ? "viewFriends"
      : name === "moments" ? "viewMoments" : "viewSettings");
    if (view) { view.classList.add("active"); }
    document.querySelectorAll(".tab-item").forEach(function (t) {
      t.classList.toggle("active", t.dataset.tab === name);
    });
    if (name === "messages") { loadConversations(); }
    else if (name === "friends") { loadFriends(); }
    else if (name === "moments") { loadMoments(); }
  }

  /* ------------------------------ 会话列表 ------------------------------ */
  async function loadConversations() {
    var res = await apiGet(PLUGIN + "/conversations");
    if (res && res.ok) { diag("api", "ok"); }
    conversations = (res && res.conversations) || [];
    rooms = conversations
      .filter(function (c) { return c.kind === "group"; })
      .map(function (c) { return { room_id: c.conv_id, room_name: c.name }; });
    renderConversations();
  }

  function convSnippet(c) {
    if (!c.last_msg) { return "暂无消息"; }
    var who = c.last_msg.who === "user" ? USER_NICK : c.last_msg.who;
    var txt = c.last_msg.content || "[图片]";
    return who + "：" + txt;
  }

  function renderConversations() {
    var wrap = $("convList");
    clearNode(wrap);

    var nb = el("div", "conv-item");
    nb.style.color = "var(--primary)";
    var nbAv = el("div", "conv-avatar");
    var nbCircle = el("div", "item-avatar avatar-fallback", "＋");
    nbAv.appendChild(nbCircle);
    nb.appendChild(nbAv);
    var nbMain = el("div", "conv-main");
    nbMain.appendChild(el("span", "conv-name", "新建聊天室"));
    nbMain.appendChild(el("span", "conv-snippet", "创建一个新的 AI 群聊"));
    nb.appendChild(nbMain);
    nb.addEventListener("click", createNewRoom);
    wrap.appendChild(nb);

    if (!conversations.length) {
      wrap.appendChild(el("div", "empty-tip",
        "还没有其它会话。到「好友」页点角色可发起 1V1 私聊。"));
      return;
    }
    conversations.forEach(function (c) {
      var item = el("div", "conv-item" + (c.pinned ? " pinned" : "") + (c.special_care ? " special" : ""));
      item.dataset.cid = c.conv_id;
      item.dataset.kind = c.kind;
      if (c.role_key) { item.dataset.rk = c.role_key; }

      var avBox = el("div", "conv-avatar");
      var av = c.kind === "dm"
        ? makeAvatar("item-avatar", c.avatar, c.name)
        : makeAvatar("item-avatar", "", c.name);
      avBox.appendChild(av);
      if (c.kind === "dm") {
        var dot = el("span", "status-dot " + ((c.status && c.status.state) || "online"));
        avBox.appendChild(dot);
      }
      item.appendChild(avBox);

      var main = el("div", "conv-main");
      var top = el("div", "conv-top");
      top.appendChild(el("span", "conv-name", c.name));
      top.appendChild(el("span", "conv-time", c.last_at ? fmtTime(c.last_at) : ""));
      main.appendChild(top);

      var bottom = el("div", "conv-bottom");
      bottom.appendChild(el("span", "conv-snippet", convSnippet(c)));
      var badges = el("span", "conv-badges");
      if (c.pinned) { badges.appendChild(el("span", "pin-ico", "📌")); }
      if (c.muted) { badges.appendChild(el("span", "mute-ico", "🔕")); }
      if (c.unread > 0 && !c.muted) {
        /* 前端兜底截断：≥100 固定显示 99+，徽章固定宽度不撑坏布局 */
        badges.appendChild(el("span", "unread-badge",
          (c.unread >= 99 || c.unread_overflow) ? "99+" : String(c.unread)));
      }
      bottom.appendChild(badges);
      main.appendChild(bottom);
      item.appendChild(main);
      wrap.appendChild(item);
    });
  }

  async function createNewRoom() {
    var name = await uiPrompt("新建聊天室", "给这个群聊起个名字，例如「宿舍夜话」：", "",
      { label: "聊天室名称", placeholder: "未命名聊天室", okText: "创建" });
    if (name === null) { return; }
    name = name.trim();
    if (!name) { return toast("聊天室名称不能为空", true); }
    var rid = "room_" + Date.now();
    var res = await apiPost(PLUGIN + "/new_room", { room_id: rid, room_name: name });
    if (!res || !res.ok) { return; }
    toast("聊天室「" + name + "」已创建");
    await loadConversations();
    await openChatByRoom(rid, { conv_id: rid, kind: "group", role_key: "", name: name, avatar: "" });
  }

  async function renameRoom(rid) {
    var cur = rooms.find(function (r) { return r.room_id === rid; });
    var newName = await uiPrompt("重命名聊天室", "修改这个聊天室的名称：",
      cur ? cur.room_name : "", { label: "聊天室名称", okText: "保存" });
    if (newName === null) { return; }
    newName = newName.trim();
    if (!newName) { return toast("名称不能为空", true); }
    var res = await apiPost(PLUGIN + "/rename_room", { room_id: rid, room_name: newName });
    if (!res || !res.ok) { return; }
    toast("已改名");
    await loadConversations();
    if (currentRoomId === rid) { $("currentRoomName").textContent = newName; }
  }

  async function delRoom(rid) {
    var cur = rooms.find(function (r) { return r.room_id === rid; });
    var sure = await uiConfirm("删除聊天室",
      "确定删除「" + (cur ? cur.room_name : rid) + "」？\n所有消息、角色、表情、摘要都会被清除，且无法恢复。",
      "确认删除");
    if (!sure) { return; }
    var res = await apiPost(PLUGIN + "/del_room", { room_id: rid });
    if (!res || !res.ok) { return; }
    if (currentRoomId === rid) { backFromChat(); }
    await loadConversations();
  }

  /* 隐藏一条会话（私聊删除会话 / 群聊也可从列表移除，不删库） */
  async function hideConversation(conv) {
    await apiPost(PLUGIN + "/conv_state", { conv_id: conv.conv_id, field: "hidden", value: 1 });
    if (conv.kind === "group") {
      /* 群聊隐藏后若再点不回来，这里同时走删除，避免幽灵会话 */
      await apiPost(PLUGIN + "/del_room", { room_id: conv.conv_id });
    }
    toast("会话已删除");
    await loadConversations();
  }

  async function openChatByRoom(rid, conv) {
    /* 切房先停掉上一间的自主对话，避免两个房间同时往模型发请求 */
    stopAutoTalk(true);
    currentRoomId = rid;
    currentConv = conv || { conv_id: rid, kind: "group", role_key: "", name: "", avatar: "" };
    var d = await apiGet(PLUGIN + "/room", { room_id: rid });
    if (!d) { return; }
    roles = d.roles || [];
    emojis = d.emojis || [];
    history = d.history || [];
    summaries = d.summaries || [];
    $("currentRoomName").textContent = d.room_name || rid;
    var sub = "";
    if (currentConv.kind === "dm" && roles[0]) {
      sub = roles[0].mood || roles[0].signature || "在线";
    } else if (roles.length) {
      sub = roles.length + " 位成员";
    }
    /* 私聊：睡觉中顶栏显示离线状态；睡→醒切换插一条上线系统提示 */
    if (currentConv.kind === "dm") {
      var fr = findFriend(currentConv.role_key);
      if (fr && fr.status && fr.status.state === "sleep") { sub = "睡觉中"; }
      var prevKey = "agc_prev_state_" + rid;
      var prev = lsGet(prevKey, "");
      if (fr && fr.status) {
        if (prev === "sleep" && fr.status.state !== "sleep") {
          setTimeout(function () {
            var tip = el("div", "sys-tip", (currentConv.name || "对方") + " 上线了");
            $("chatLog").appendChild(tip);
            scrollToBottom(true);
          }, 300);
        }
        lsSet(prevKey, fr.status.state || "online");
      }
    }
    $("currentRoomStatus").textContent = sub;
    selectedEmojiName = "";
    updatePickedEmo();
    renderRoles();
    renderEmojis();
    /* 房间没单独设过背景时，回落到 localStorage 里的全局默认背景 */
    setChatBg(d.bg || lsGet("agc_bg_default", "") || "");
    clearQuote();
    reactPickerFor = null;
    hideTyping();
    await loadReactions();
    renderChat();
    restoreDraft(rid);
    renderSummaryList();
    loadAutoCfg();
    chatOpen = true;
    $("chatWrap").classList.add("open");
    $("tabbar").classList.add("hide");
    markRead(rid);
  }

  function backFromChat() {
    stopAutoTalk(true);
    chatOpen = false;
    $("chatWrap").classList.remove("open");
    $("tabbar").classList.remove("hide");
    hideTyping();
    switchTab("messages");
  }

  async function markRead(rid) {
    /* 一次性把已读水位拉到本房间最大消息 id（后端 -1 特殊值），避免逐次累加误差 */
    await apiPost(PLUGIN + "/conv_state", { conv_id: rid, field: "read_id", value: -1 });
  }

  /* ------------------------------ 好友列表 ------------------------------ */
  async function loadFriends() {
    var res = await apiGet(PLUGIN + "/friends");
    friends = (res && res.friends) || [];
    var g = await apiGet(PLUGIN + "/friend_groups");
    friendGroups = (g && g.groups) || [];
    renderFriends();
  }

  function renderFriends() {
    var wrap = $("friendList");
    clearNode(wrap);
    if (!friends.length) {
      wrap.appendChild(el("div", "empty-tip", "还没有角色。到聊天室设置里先添加几个 AI 角色吧。"));
      return;
    }
    /* 自定义分组优先（friend_groups 配置），未分组回落所属房间名 */
    var groups = {};
    var order = [];
    function bucket(name) {
      if (!groups[name]) { groups[name] = []; order.push(name); }
      return groups[name];
    }
    var keyToGroup = {};
    friendGroups.forEach(function (g) {
      (g.keys || []).forEach(function (k) { keyToGroup[k] = g.name; });
    });
    friends.forEach(function (f) {
      var g = keyToGroup[f.role_key] || f.room_name || "我的AI好友";
      bucket(g).push(f);
    });
    order.forEach(function (gname) {
      if (collapsedGroups[gname]) {
        var t0 = el("div", "friend-group-title collapsed", gname + "（" + groups[gname].length + "） ▸");
        t0.dataset.gname = gname;
        wrap.appendChild(t0);
        return;
      }
      var t = el("div", "friend-group-title", gname + "（" + groups[gname].length + "） ▾");
      t.dataset.gname = gname;
      wrap.appendChild(t);
      groups[gname].forEach(function (f) {
        var item = el("div", "friend-item");
        item.dataset.rk = f.role_key;
        item.appendChild(makeAvatar("item-avatar", f.avatar, f.name));
        var main = el("div", "friend-main");
        var nameRow = el("div", "friend-name");
        nameRow.appendChild(document.createTextNode(f.name || ""));
        if (f.intimacy && f.intimacy.badge && f.intimacy.badge.icon) {
          nameRow.appendChild(el("span", "friend-badge",
            f.intimacy.badge.icon + " " + (f.intimacy.badge.name || "")));
        }
        main.appendChild(nameRow);
        var meta = f.mood || f.signature || "还没有签名";
        main.appendChild(el("div", "friend-meta", meta));
        item.appendChild(main);
        item.addEventListener("click", function () { openProfile(f.role_key); });
        wrap.appendChild(item);
      });
    });
  }

  /* ------------------------------ 动态信息流 ------------------------------ */
  async function loadMoments() {
    var res = await apiGet(PLUGIN + "/moments");
    moments = (res && res.moments) || [];
    (res && res.events || []).forEach(function (ev) {
      if (!ev) { return; }
      var txt = ev.type === "comment"
        ? ev.who + " 评论了一条动态：" + (ev.content || "")
        : ev.who + " 赞了一条动态";
      toast(txt);
    });
    renderMoments();
  }

  function renderMoments() {
    var wrap = $("momentList");
    clearNode(wrap);
    if (!moments.length) {
      wrap.appendChild(el("div", "empty-tip", "还没有动态。角色聊得投入时会偶尔发一条说说。"));
      return;
    }
    moments.forEach(function (m) { wrap.appendChild(buildMomentCard(m)); });
  }

  function buildMomentCard(m) {
    var card = el("div", "moment-card");
    var head = el("div", "moment-head");
    var isUserMoment = m.role_key === "user";
    var av = makeAvatar("item-avatar", isUserMoment ? USER_AVATAR : m.avatar,
      isUserMoment ? USER_NICK : m.role_name);
    av.style.cursor = "pointer";
    av.addEventListener("click", function () { if (m.role_key) { openProfile(m.role_key); } });
    head.appendChild(av);
    var hm = el("div", "moment-head-main");
    var nameRow = el("div", "moment-name");
    nameRow.appendChild(document.createTextNode(isUserMoment ? USER_NICK : (m.role_name || "")));
    if (isUserMoment) { nameRow.appendChild(el("span", "moment-vis", "我的动态")); }
    if (m.visibility === "self") { nameRow.appendChild(el("span", "moment-vis", "仅自己")); }
    hm.appendChild(nameRow);
    hm.appendChild(el("div", "moment-time", fmtTime(m.created_at)));
    head.appendChild(hm);
    card.appendChild(head);

    if (m.content) { card.appendChild(el("div", "moment-content", m.content)); }
    if (m.image) {
      var img = el("img", "moment-img");
      img.src = m.image;
      img.addEventListener("click", function () { openLightbox(m.image); });
      card.appendChild(img);
    }

    var acts = el("div", "moment-acts");
    var like = el("span", "moment-act" + (m.liked ? " liked" : ""));
    like.dataset.act = "like";
    like.appendChild(document.createTextNode((m.liked ? "❤ " : "🤍 ") + (m.likes_count || 0)));
    acts.appendChild(like);
    var cmt = el("span", "moment-act");
    cmt.dataset.act = "comment";
    cmt.appendChild(document.createTextNode("💬 " + ((m.comments || []).length)));
    acts.appendChild(cmt);
    card.appendChild(acts);

    var cmtBox = el("div", "moment-comments");
    (m.comments || []).forEach(function (c) {
      var row = el("div", "moment-comment");
      row.appendChild(el("span", "mc-who", c.who === "user" ? USER_NICK : c.who));
      row.appendChild(document.createTextNode(c.content || ""));
      cmtBox.appendChild(row);
    });
    var inputRow = el("div", "moment-comment-input");
    var inp = el("input");
    inp.placeholder = "写下评论…";
    var btn = el("button", null, "发送");
    btn.type = "button";
    inputRow.appendChild(inp);
    inputRow.appendChild(btn);
    cmtBox.appendChild(inputRow);
    card.appendChild(cmtBox);

    like.addEventListener("click", function () { toggleMomentLike(m, like); });
    cmt.addEventListener("click", function () { inp.focus(); });
    btn.addEventListener("click", function () { postMomentComment(m, inp, cmtBox); });
    inp.addEventListener("keydown", function (e) {
      if (e.key === "Enter") { postMomentComment(m, inp, cmtBox); }
    });
    return card;
  }

  async function toggleMomentLike(m, likeEl) {
    var res = await apiPost(PLUGIN + "/moment_like", { moment_id: m.id });
    if (!res || !res.ok) { return; }
    m.liked = res.liked;
    m.likes_count = Math.max(0, (m.likes_count || 0) + (res.liked ? 1 : -1));
    likeEl.classList.toggle("liked", res.liked);
    likeEl.textContent = (res.liked ? "❤ " : "🤍 ") + m.likes_count;
  }

  async function postMomentComment(m, inp, box) {
    var text = inp.value.trim();
    if (!text) { return; }
    var res = await apiPost(PLUGIN + "/moment_comment", { moment_id: m.id, content: text });
    if (!res || !res.ok) { return toast(res.msg || "评论失败", true); }
    m.comments = m.comments || [];
    m.comments.push({ who: "user", content: text });
    inp.value = "";
    var row = el("div", "moment-comment");
    row.appendChild(el("span", "mc-who", USER_NICK));
    row.appendChild(document.createTextNode(text));
    box.insertBefore(row, box.lastChild);
  }

  /* ------------------------------ 好友分组管理（v2.1） ------------------------------ */
  function groupCtxMenu(gname, x, y) {
    showCtxMenu(x, y, [
      { label: "重命名分组", act: async function () {
        var v = await uiPrompt("重命名分组", "新分组名：", gname, { label: "分组名" });
        if (!v || !v.trim()) { return; }
        friendGroups.forEach(function (g) { if (g.name === gname) { g.name = v.trim(); } });
        await apiPost(PLUGIN + "/friend_groups", { groups: friendGroups });
        renderFriends();
        toast("分组已重命名");
      } },
      { label: "新增分组", act: async function () {
        var v = await uiPrompt("新增分组", "分组名：", "", { label: "分组名" });
        if (!v || !v.trim()) { return; }
        friendGroups.push({ name: v.trim(), keys: [] });
        await apiPost(PLUGIN + "/friend_groups", { groups: friendGroups });
        renderFriends();
      } }
    ]);
  }

  function friendCtxMenu(f, x, y) {
    showCtxMenu(x, y, [
      { label: "移动到分组…", act: async function () {
        var names = friendGroups.map(function (g) { return g.name; });
        if (!names.length) {
          var v = await uiPrompt("新增分组", "先创建一个分组：", "我的AI好友", { label: "分组名" });
          if (!v || !v.trim()) { return; }
          friendGroups.push({ name: v.trim(), keys: [f.role_key] });
        } else {
          var vals = await openDialog({
            title: "移动到分组", okText: "移动",
            fields: [{ key: "g", label: "目标分组", type: "select",
              options: names.map(function (n) { return { label: n, value: n }; }) }]
          });
          if (!vals) { return; }
          friendGroups.forEach(function (g) {
            g.keys = (g.keys || []).filter(function (k) { return k !== f.role_key; });
            if (g.name === vals.g) { g.keys.push(f.role_key); }
          });
        }
        await apiPost(PLUGIN + "/friend_groups", { groups: friendGroups });
        renderFriends();
        toast("已移动");
      } },
      { label: "查看资料主页", act: function () { openProfile(f.role_key); } }
    ]);
  }

  /* ------------------------------ 聊天记录搜索（v2.1） ------------------------------ */
  async function openSearchDialog() {
    var roomsOpt = [{ label: "全部会话", value: "" }].concat(rooms.map(function (r) {
      return { label: r.room_name, value: r.room_id };
    }));
    var vals = await openDialog({
      title: "搜索聊天记录", okText: "搜索",
      fields: [
        { key: "kw", label: "关键词", type: "text", placeholder: "输入要搜索的内容" },
        { key: "room", label: "搜索范围", type: "select", optional: true, options: roomsOpt }
      ]
    });
    if (!vals) { return; }
    var kw = String(vals.kw || "").trim();
    if (!kw) { return toast("请输入关键词", true); }
    var res = await apiGet(PLUGIN + "/search_msg", { keyword: kw, room_id: vals.room || "" });
    var results = (res && res.results) || [];
    if (!results.length) { return toast("没有找到包含「" + kw + "」的消息", true); }
    var lines = results.map(function (r, i) {
      return (i + 1) + ". [" + r.room_name + "] " + (r.who === "user" ? USER_NICK : r.who) + "：" + r.snippet;
    });
    var pick = await openDialog({
      title: "搜索结果（" + results.length + " 条）",
      message: lines.join("\n"),
      okText: "跳转",
      fields: [{ key: "idx", label: "跳转到第几条（填序号）", type: "number", value: 1, optional: true }]
    });
    if (!pick) { return; }
    var idx = clampNum(pick.idx, 1, results.length, 1) - 1;
    var target = results[idx];
    await openChatByRoom(target.room_id, {
      conv_id: target.room_id, kind: target.room_id.indexOf("dm@@") === 0 ? "dm" : "group",
      role_key: "", name: target.room_name, avatar: ""
    });
    setTimeout(function () { highlightMsg(target.id); }, 500);
  }

  function highlightMsg(mid) {
    var wrap = $("chatLog").querySelector('.msg-wrap[data-mid="' + mid + '"]');
    if (!wrap) {
      var idx = -1;
      for (var i = 0; i < history.length; i++) {
        if (String(history[i].id) === String(mid)) { idx = i; break; }
      }
      var guard = 0;
      while (idx >= 0 && renderFrom > idx && guard < 60) { loadOlderMessages(); guard++; }
      wrap = $("chatLog").querySelector('.msg-wrap[data-mid="' + mid + '"]');
    }
    if (wrap) {
      wrap.scrollIntoView({ block: "center" });
      wrap.classList.add("flash");
      setTimeout(function () { wrap.classList.remove("flash"); }, 3200);
    }
  }

  /* ------------------------------ 快捷回复短语（v2.1） ------------------------------ */
  function loadQuickReplies() {
    try { quickReplies = JSON.parse(lsGet("agc_quick", "[]")) || []; } catch (e) { quickReplies = []; }
    renderQuickChips();
  }

  function renderQuickChips() {
    var wrap = $("quickChips");
    if (!wrap) { return; }
    clearNode(wrap);
    if (!quickReplies.length) { wrap.classList.remove("show"); return; }
    wrap.classList.add("show");
    quickReplies.forEach(function (q) {
      var chip = el("span", "quick-chip", q);
      chip.addEventListener("click", function () {
        var input = $("msgInput");
        input.value = (input.value ? input.value + " " : "") + q;
        input.focus();
        autoGrowInput();
        saveDraftDebounced();
      });
      wrap.appendChild(chip);
    });
  }

  async function openQuickDialog() {
    var v = await uiPrompt("快捷回复短语", "每行一条，聊天框下方会显示快捷按钮（最多 12 条）：",
      quickReplies.join("\n"), { label: "短语列表", multiline: true, okText: "保存" });
    if (v === null) { return; }
    quickReplies = String(v).split("\n").map(function (x) { return x.trim(); })
      .filter(Boolean).slice(0, 12);
    lsSet("agc_quick", JSON.stringify(quickReplies));
    renderQuickChips();
    toast("快捷回复已保存");
  }

  /* ------------------------------ 消息转发（v2.1） ------------------------------ */
  async function forwardMessage(msg) {
    if (!msg.id) { return toast("这条消息还没入库，暂时不能转发", true); }
    var targets = conversations.filter(function (c) { return c.conv_id !== currentRoomId; });
    if (!targets.length) { return toast("还没有其它会话可以转发", true); }
    var vals = await openDialog({
      title: "转发消息",
      message: (msg.who === "user" ? USER_NICK : msg.who) + "：" + (msg.content || "[图片]"),
      okText: "转发",
      fields: [{
        key: "to", label: "转发到", type: "select",
        options: targets.map(function (c) {
          return { label: (c.kind === "dm" ? "私聊 · " : "群聊 · ") + c.name, value: c.conv_id };
        })
      }]
    });
    if (!vals) { return; }
    var res = await apiPost(PLUGIN + "/forward_msg", { msg_id: msg.id, to_room_id: vals.to });
    if (!res || !res.ok) { return toast((res && res.msg) || "转发失败", true); }
    toast("已转发");
    loadConversations();
  }

  function msgCtxMenu(msg, wrap, x, y) {
    var items = [
      { label: "引用", act: function () { setQuote(msg); } },
      { label: "表情回应", act: function () { toggleReactPicker(msg); } },
      { label: "转发到…", act: function () { forwardMessage(msg); } }
    ];
    if (msg.who === "user") {
      items.push({ label: "撤回", danger: true, act: function () { recallMessage(msg, wrap); } });
    }
    showCtxMenu(x, y, items);
  }

  /* ------------------------------ 用户发说说（v2.1，零模型调用） ------------------------------ */
  function rebuildMomentAttach() {
    var box = $("momentPostAttach");
    if (!box) { return; }
    clearNode(box);
    if (pendingMomentImage) {
      var im = el("img");
      im.src = pendingMomentImage;
      im.alt = "";
      box.appendChild(im);
      var btn = el("button", null, "移除");
      btn.type = "button";
      btn.addEventListener("click", function () { pendingMomentImage = ""; rebuildMomentAttach(); });
      box.appendChild(btn);
    }
    box.classList.toggle("show", !!pendingMomentImage);
  }

  async function postUserMoment() {
    var inp = $("momentPostInput");
    var text = inp.value.trim();
    if (!text && !pendingMomentImage) { return toast("先写点什么吧", true); }
    var res = await apiPost(PLUGIN + "/user_moment", { content: text, image: pendingMomentImage });
    if (!res || !res.ok) { return toast((res && res.msg) || "发布失败", true); }
    inp.value = "";
    pendingMomentImage = "";
    rebuildMomentAttach();
    moments = res.moments || moments;
    renderMoments();
    toast("动态已发布");
  }

  /* ------------------------------ 资料主页 ------------------------------ */
  async function openProfile(roleKey) {
    if (!roleKey) { return; }
    profileKey = roleKey;
    var res = await apiGet(PLUGIN + "/profile", { role_key: roleKey });
    if (!res || !res.ok) { return toast("资料加载失败", true); }
    await apiPost(PLUGIN + "/visit", { role_key: roleKey });
    renderProfile(res);
    profileOpen = true;
    $("profilePage").classList.add("open");
  }

  function renderProfile(view) {
    var role = view.role || {};
    var prof = view.profile || {};
    var intim = view.intimacy || {};
    var status = view.status || {};
    var body = $("profileBody");
    clearNode(body);

    body.appendChild(el("div", "profile-banner"));
    var card = el("div", "profile-card");
    card.appendChild(makeAvatar("profile-avatar", role.avatar, role.name));
    var nameRow = el("div", "profile-name-row");
    nameRow.appendChild(el("span", "profile-name", role.name || ""));
    nameRow.appendChild(el("span", "profile-status", status.text || "在线"));
    card.appendChild(nameRow);
    if (prof.signature) { card.appendChild(el("div", "profile-sign", "“" + prof.signature + "”")); }
    if (prof.mood) { card.appendChild(el("div", "profile-mood", "当前心情：" + prof.mood)); }

    var stats = el("div", "profile-stats");
    [
      [prof.visits || 0, "访问量"],
      [intim.points || 0, "亲密度"],
      [(prof.likes || 0), "获赞"]
    ].forEach(function (s) {
      var st = el("div", "profile-stat");
      st.appendChild(el("b", null, String(s[0])));
      st.appendChild(el("span", null, s[1]));
      stats.appendChild(st);
    });
    card.appendChild(stats);

    if (intim.badge && intim.badge.icon) {
      var br = el("div", "profile-badge-row");
      br.appendChild(el("span", "profile-badge-chip", intim.badge.icon + " " + (intim.badge.name || "")));
      card.appendChild(br);
    }
    body.appendChild(card);

    var acts = el("div", "profile-actions");
    var dmBtn = el("button", "btn-dm", "发起私聊");
    dmBtn.type = "button";
    var pokeBtn = el("button", "btn-poke", "👋 戳一戳");
    pokeBtn.type = "button";
    acts.appendChild(dmBtn);
    acts.appendChild(pokeBtn);
    body.appendChild(acts);

    dmBtn.addEventListener("click", function () { startDm(role.role_key); });
    pokeBtn.addEventListener("click", function () { poke(role.role_key, role.name); });

    body.appendChild(el("div", "profile-section-title", "TA 的动态"));
    var momentsWrap = el("div");
    var list = view.moments || [];
    if (!list.length) {
      momentsWrap.appendChild(el("div", "empty-tip", "TA 还没有发过动态。"));
    } else {
      list.forEach(function (m) { momentsWrap.appendChild(buildMomentCard(m)); });
    }
    body.appendChild(momentsWrap);
  }

  async function startDm(roleKey) {
    var res = await apiPost(PLUGIN + "/dm", { role_key: roleKey });
    if (!res || !res.ok) { return toast(res.msg || "发起私聊失败", true); }
    profileOpen = false;
    $("profilePage").classList.remove("open");
    await openChatByRoom(res.room_id, {
      conv_id: res.room_id, kind: "dm", role_key: roleKey,
      name: (res.role && res.role.name) || "", avatar: (res.role && res.role.avatar) || ""
    });
  }

  async function poke(roleKey, roleName) {
    var res = await apiPost(PLUGIN + "/poke", { role_key: roleKey });
    if (!res || !res.ok) { return toast("戳一戳失败", true); }
    toast("你拍了拍 " + (roleName || "TA"));
    /* 若正处在与该角色的私聊，把反应作为系统提示条插入聊天流 */
    if (currentConv && currentConv.kind === "dm" && currentConv.role_key === roleKey) {
      var tip = el("div", "sys-tip", (roleName || "TA") + "：" + (res.reply || "在呢在呢"));
      $("chatLog").appendChild(tip);
      scrollToBottom();
    }
  }

  /* ------------------------------ 长按上下文菜单 ------------------------------ */
  function closeCtxMenu() {
    if (ctxMenu) { ctxMenu.remove(); ctxMenu = null; }
  }

  function showCtxMenu(x, y, items) {
    closeCtxMenu();
    ctxMenu = el("div", "ctx-menu");
    items.forEach(function (it) {
      var row = el("div", "ctx-item" + (it.danger ? " danger" : ""), it.label);
      row.addEventListener("click", function () { closeCtxMenu(); it.act(); });
      ctxMenu.appendChild(row);
    });
    document.body.appendChild(ctxMenu);
    var rect = ctxMenu.getBoundingClientRect();
    var left = Math.min(x, window.innerWidth - rect.width - 10);
    var top = Math.min(y, window.innerHeight - rect.height - 10);
    ctxMenu.style.left = Math.max(6, left) + "px";
    ctxMenu.style.top = Math.max(6, top) + "px";
  }

  function convCtxMenu(conv, x, y) {
    var items = [
      { label: conv.pinned ? "取消置顶" : "置顶会话", act: function () {
        apiPost(PLUGIN + "/conv_state", { conv_id: conv.conv_id, field: "pinned", value: conv.pinned ? 0 : 1 })
          .then(loadConversations);
      } },
      { label: conv.muted ? "取消免打扰" : "免打扰", act: function () {
        apiPost(PLUGIN + "/conv_state", { conv_id: conv.conv_id, field: "muted", value: conv.muted ? 0 : 1 })
          .then(loadConversations);
      } },
      { label: conv.special_care ? "取消特别关心" : "特别关心", act: function () {
        apiPost(PLUGIN + "/conv_state", { conv_id: conv.conv_id, field: "special_care", value: conv.special_care ? 0 : 1 })
          .then(loadConversations);
      } },
      { label: "删除会话", danger: true, act: function () { hideConversation(conv); } }
    ];
    showCtxMenu(x, y, items);
  }

  /* ------------------------------ 角色 ------------------------------ */
  function renderRoles() {
    var wrap = $("roleListWrap");
    clearNode(wrap);
    if (!roles.length) {
      wrap.appendChild(el("div", "empty-tip", "暂无角色，请在下方添加"));
      return;
    }
    roles.forEach(function (r, i) {
      var card = el("div", "item-card");
      card.dataset.act = "edit-role";
      card.dataset.idx = String(i);
      card.title = "点击编辑这个角色";
      card.appendChild(makeAvatar("item-avatar", r.avatar, r.name));
      var info = el("div", "item-info");
      info.appendChild(el("b", null, r.name));
      var p = String(r.prompt || "");
      info.appendChild(el("small", null, p ? (p.slice(0, 40) + (p.length > 40 ? "..." : "")) : "（还没写人设 prompt，点编辑补充）"));
      card.appendChild(info);
      var edit = el("button", "btn-edit", "编辑");
      edit.type = "button";
      edit.dataset.act = "edit-role";
      edit.dataset.idx = String(i);
      card.appendChild(edit);
      var btn = el("button", "btn-del", "删");
      btn.type = "button";
      btn.dataset.act = "del-role";
      btn.dataset.idx = String(i);
      card.appendChild(btn);
      wrap.appendChild(card);
    });
  }

  async function addRole() {
    var name = $("rName").value.trim();
    var promptText = $("rPrompt").value.trim();
    if (!name) { return toast("请填写角色名", true); }
    roles.push({ name: name, prompt: promptText, avatar: newAvatarB64 });
    newAvatarB64 = "";
    $("rName").value = "";
    $("rPrompt").value = "";
    $("newAvatarIn").value = "";
    renderRoles();
    renderChat();
    await saveRoles();
    loadFriends();
    toast("角色「" + name + "」已添加");
  }

  async function editRole(i) {
    var r = roles[i];
    if (!r) { return; }
    var vals = await openDialog({
      title: "编辑角色设定",
      message: "修改后点「保存修改」立即写入数据库，下一轮对话就会用新设定。",
      okText: "保存修改",
      fields: [
        { key: "name", label: "角色名", type: "text", value: r.name || "", placeholder: "例如：金流星" },
        { key: "prompt", label: "人设 prompt（性格 / 说话风格 / 背景设定）", type: "textarea", value: r.prompt || "", rows: 7, placeholder: "例：22岁大学生，毒舌但心软，说话爱用短句" },
        { key: "avatar", label: "更换头像（不选则保留原头像）", type: "file", value: "", hint: r.avatar ? "当前已有头像" : "当前使用首字占位头像" }
      ]
    });
    if (!vals) { return; }
    var name = String(vals.name || "").trim();
    if (!name) { return toast("角色名不能为空", true); }
    var dup = roles.some(function (x, xi) { return xi !== i && String(x.name).trim() === name; });
    if (dup) { return toast("已经有同名角色了，请换一个名字", true); }
    roles[i] = { name: name, prompt: String(vals.prompt || "").trim(), avatar: vals.avatar || r.avatar || "" };
    renderRoles();
    renderChat();
    await saveRoles();
    loadFriends();
    toast("角色「" + name + "」的设定已保存");
  }

  async function delRole(i) {
    var r = roles[i];
    var sure = await uiConfirm("删除角色",
      "确定删除角色「" + (r ? r.name : i) + "」？该角色的人设与头像会被移除，历史消息保留。",
      "确认删除");
    if (!sure) { return; }
    roles.splice(i, 1);
    renderRoles();
    await saveRoles();
    loadFriends();
    toast("角色已删除");
  }

  async function saveRoles() {
    if (!currentRoomId) { return toast("请先选择聊天室", true); }
    await apiPost(PLUGIN + "/save_roles", { room_id: currentRoomId, roles: roles });
  }

  /* ------------------------------ 表情 ------------------------------ *
   * 上一版点😀"出不来"的直接原因：面板里只渲染用户上传的表情图，
   * 表情库为空时 .emo-panel 是 display:grid 但 0 个子节点 -> 高度 0，
   * 视觉上完全无反应。现在：
   *   - 顶部先渲染内置 Unicode 表情（永远有内容可点）；
   *   - 用户上传的表情图排在其下；
   *   - 库为空时给出明确的引导文案；
   *   - 面板改为绝对定位浮在输入栏上方，不再被 grid 行裁切。
   * ======================================================================== */
  function renderEmojis() {
    var wrap = $("emojiListWrap");
    clearNode(wrap);
    if (!emojis.length) {
      wrap.appendChild(el("div", "empty-tip", "暂无自定义表情（聊天框的😀面板里仍可直接使用内置表情）"));
    } else {
      emojis.forEach(function (e, i) {
        var card = el("div", "item-card");
        card.dataset.act = "edit-emoji";
        card.dataset.idx = String(i);
        card.title = "点击编辑这个表情";
        card.appendChild(makeAvatar("item-avatar", e.preview, e.name));
        var info = el("div", "item-info");
        info.appendChild(el("b", null, e.name));
        info.appendChild(el("small", null, e.desc || "（暂无描述）"));
        card.appendChild(info);
        var edit = el("button", "btn-edit", "编辑");
        edit.type = "button";
        edit.dataset.act = "edit-emoji";
        edit.dataset.idx = String(i);
        card.appendChild(edit);
        var btn = el("button", "btn-del", "删");
        btn.type = "button";
        btn.dataset.act = "del-emoji";
        btn.dataset.idx = String(i);
        card.appendChild(btn);
        wrap.appendChild(card);
      });
    }
    renderEmoPicker();
  }

  function renderEmoPicker() {
    var panel = $("emoPanel");
    /* 切换标签会重建面板内容：记住展开状态，否则点「表情包」页签会连带把面板关掉 */
    var wasOpen = panel.classList.contains("show");
    clearNode(panel);

    var tabs = el("div", "emo-tabs");
    var tUni = el("div", "emo-tab" + (emoTab === "uni" ? " active" : ""), "表情");
    tUni.dataset.emoTab = "uni";
    var tPack = el("div", "emo-tab" + (emoTab === "pack" ? " active" : ""), "表情包");
    tPack.dataset.emoTab = "pack";
    tabs.appendChild(tUni);
    tabs.appendChild(tPack);
    tabs.addEventListener("click", function (e) {
      var t = e.target.closest(".emo-tab");
      if (!t) { return; }
      /* 旧节点会被 clearNode 移除，若不拦截冒泡，document 上的"点外部收起"
         会因 closest 找不到面板而误判为外部点击，导致面板直接关闭 */
      e.stopPropagation();
      emoTab = t.dataset.emoTab;
      renderEmoPicker();
    });
    panel.appendChild(tabs);

    var grid = el("div", "emo-grid");
    if (emoTab === "uni") {
      UNI_EMOJI.forEach(function (u) {
        var cell = el("div", "emo-uni", u);
        cell.title = "插入 " + u;
        cell.addEventListener("click", function () {
          insertAtCursor(u);
          panel.classList.remove("show");
        });
        grid.appendChild(cell);
      });
    } else if (emojis.length) {
      emojis.forEach(function (e) {
        var img = el("img", "emo-option");
        img.title = e.name || "";
        img.alt = e.name || "";
        if (e.preview) { img.src = e.preview; }
        img.addEventListener("click", function () {
          selectedEmojiName = e.name;
          updatePickedEmo();
          panel.classList.remove("show");
          toast("已引用表情「" + e.name + "」，发送时一并带上");
        });
        grid.appendChild(img);
      });
    } else {
      grid.appendChild(el("div", "emo-empty",
        "还没有自定义表情包。可在「⚙️ 设置 → 表情」里上传图片表情。"));
    }
    panel.appendChild(grid);
    if (wasOpen) { panel.classList.add("show"); }
  }

  function updatePickedEmo() {
    var node = $("pickedEmo");
    clearNode(node);
    if (selectedEmojiName) {
      var e = emojis.find(function (x) { return x.name === selectedEmojiName; });
      if (e && e.preview) {
        var im = el("img");
        im.src = e.preview;
        im.alt = "";
        node.appendChild(im);
      }
      node.appendChild(el("span", null, "已引用：" + selectedEmojiName));
      var x = el("span", "pe-x", "✕");
      x.title = "取消引用";
      x.addEventListener("click", function () {
        selectedEmojiName = "";
        updatePickedEmo();
      });
      node.appendChild(x);
      node.classList.add("show");
    } else {
      node.classList.remove("show");
    }
  }

  /* 在光标处插入文本（内置表情 / @提及 共用） */
  function insertAtCursor(text, replaceFrom) {
    var input = $("msgInput");
    var v = input.value;
    var pos = input.selectionStart === null || input.selectionStart === undefined ? v.length : input.selectionStart;
    if (replaceFrom !== undefined && replaceFrom >= 0) {
      input.value = v.slice(0, replaceFrom) + text + v.slice(pos);
      var np = replaceFrom + text.length;
      input.setSelectionRange(np, np);
    } else {
      input.value = v.slice(0, pos) + text + v.slice(pos);
      var np2 = pos + text.length;
      input.setSelectionRange(np2, np2);
    }
    input.focus();
    autoGrowInput();
  }

  async function addEmoji() {
    var name = $("eName").value.trim();
    var desc = $("eDesc").value.trim();
    if (!name || !desc) { return toast("表情名称和描述都要填写", true); }
    emojis.push({ name: name, desc: desc, preview: newEmojiB64 });
    newEmojiB64 = "";
    $("eName").value = "";
    $("eDesc").value = "";
    $("newEmojiIn").value = "";
    renderEmojis();
    await saveEmojis();
    toast("表情「" + name + "」已添加");
  }

  async function editEmoji(i) {
    var e = emojis[i];
    if (!e) { return; }
    var vals = await openDialog({
      title: "编辑表情",
      okText: "保存修改",
      fields: [
        { key: "name", label: "表情名称（给 AI 调用，需与提示词里的名字一致）", type: "text", value: e.name || "" },
        { key: "desc", label: "表情描述（告诉 AI 什么场合用这个表情）", type: "textarea", value: e.desc || "", rows: 4 },
        { key: "preview", label: "更换表情图（不选则保留原图）", type: "file", value: "", hint: e.preview ? "当前已有图片" : "当前无图片" }
      ]
    });
    if (!vals) { return; }
    var name = String(vals.name || "").trim();
    var desc = String(vals.desc || "").trim();
    if (!name || !desc) { return toast("表情名称和描述都要填写", true); }
    emojis[i] = { name: name, desc: desc, preview: vals.preview || e.preview || "" };
    renderEmojis();
    await saveEmojis();
    toast("表情已更新");
  }

  async function delEmoji(i) {
    var e = emojis[i];
    var sure = await uiConfirm("删除表情", "确定删除表情「" + (e ? e.name : i) + "」？", "确认删除");
    if (!sure) { return; }
    emojis.splice(i, 1);
    renderEmojis();
    await saveEmojis();
    toast("表情已删除");
  }

  async function saveEmojis() {
    if (!currentRoomId) { return toast("请先选择聊天室", true); }
    await apiPost(PLUGIN + "/save_emojis", { room_id: currentRoomId, emojis: emojis });
  }

  function readFile(file) {
    return new Promise(function (resolve) {
      var fr = new FileReader();
      fr.onload = function () { resolve(fr.result); };
      fr.onerror = function () { resolve(""); };
      fr.readAsDataURL(file);
    });
  }

  /* ------------------------------ 发图 / 识图 ------------------------------ *
   * 前端 canvas 等比压缩（默认最长边 1024、JPEG 0.82），既保证视觉模型
   * 能看清内容，又把 dataURL 体积压到 bridge 单次 POST 可承受的范围。
   * ======================================================================== */
  function compressImage(file, maxSide, quality) {
    maxSide = maxSide || 1024;
    quality = quality || 0.82;
    return new Promise(function (resolve) {
      readFile(file).then(function (dataUrl) {
        if (!dataUrl) { return resolve(""); }
        if (!maxSide || maxSide <= 0) { return resolve(dataUrl); }
        var img = new Image();
        img.onload = function () {
          try {
            var w = img.naturalWidth || img.width;
            var h = img.naturalHeight || img.height;
            if (!w || !h) { return resolve(dataUrl); }
            var scale = Math.min(1, maxSide / Math.max(w, h));
            var tw = Math.max(1, Math.round(w * scale));
            var th = Math.max(1, Math.round(h * scale));
            var canvas = document.createElement("canvas");
            canvas.width = tw;
            canvas.height = th;
            var ctx = canvas.getContext("2d");
            ctx.fillStyle = "#ffffff";
            ctx.fillRect(0, 0, tw, th);
            ctx.drawImage(img, 0, 0, tw, th);
            resolve(canvas.toDataURL("image/jpeg", quality));
          } catch (e) { resolve(dataUrl); }
        };
        img.onerror = function () { resolve(dataUrl); };
        img.src = dataUrl;
      });
    });
  }

  function setPendingImage(dataUrl, label) {
    pendingImage = dataUrl || "";
    rebuildAttachBox(label);
  }

  /* 附件预览条重建：保持 DOM 结构固定（img + 名称 + 移除按钮） */
  function rebuildAttachBox(label) {
    var box = $("attachPreview");
    clearNode(box);
    var im = el("img");
    im.alt = "";
    if (pendingImage) { im.src = pendingImage; }
    box.appendChild(im);
    var kb = pendingImage ? Math.round(pendingImage.length * 0.75 / 1024) : 0;
    box.appendChild(el("div", "ap-name", (label || "图片已就绪") + (kb ? "（约 " + kb + " KB）" : "")));
    var btn = el("button", null, "移除");
    btn.type = "button";
    btn.addEventListener("click", function () { setPendingImage(""); $("imgInput").value = ""; });
    box.appendChild(btn);
    box.classList.toggle("show", !!pendingImage);
  }

  async function handleImageFile(file) {
    if (!file) { return; }
    if (!/^image\//.test(file.type)) { return toast("只能发送图片文件", true); }
    if (!VISION_ENABLED) {
      toast("插件配置里已关闭「开启发图识图」，图片仍会发送但不会被识别", true);
    }
    toast("正在压缩图片…");
    var dataUrl = await compressImage(file, IMG_MAX_SIDE, 0.82);
    if (!dataUrl) { return toast("图片读取失败，请换一张试试", true); }
    setPendingImage(dataUrl, file.name || "图片");
    toast("图片已就绪，点发送即可（会同时让 AI 识图）");
  }

  /* ------------------------------ 聊天背景 ------------------------------ */
  function setChatBg(value) {
    currentBg = value || "";
    var log = $("chatLog");
    if (!log) { return; }
    log.style.backgroundImage = "none";
    log.style.backgroundColor = "";
    log.classList.remove("has-bg");
    if (!currentBg || currentBg === "none") { return; }
    if (currentBg.indexOf("image:") === 0) {
      log.style.backgroundImage = "url(" + currentBg.slice(6) + ")";
      log.classList.add("has-bg");
    } else if (currentBg.indexOf("color:") === 0) {
      var c = currentBg.slice(6);
      if (/gradient\(/.test(c)) { log.style.backgroundImage = c; }
      else { log.style.backgroundColor = c; }
      log.classList.add("has-bg");
    }
  }

  function renderBgPanel() {
    var grid = $("bgGrid");
    clearNode(grid);
    BG_PRESETS.forEach(function (p) {
      var cell = el("div", "bg-cell");
      cell.style.background = p.css;
      cell.title = p.name;
      cell.dataset.value = p.value;
      if (p.value === currentBg) { cell.classList.add("active"); }
      cell.appendChild(el("span", null, p.name));
      cell.addEventListener("click", function () {
        grid.querySelectorAll(".bg-cell").forEach(function (x) { x.classList.remove("active"); });
      cell.classList.add("active");
        pendingBg = p.value;
        setChatBg(p.value);
        renderBgCurrent();
      });
      grid.appendChild(cell);
    });
    renderBgCurrent();
  }

  function renderBgCurrent() {
    var box = $("bgCur");
    if (!box) { return; }
    clearNode(box);
    var v = pendingBg || currentBg;
    if (!v || v === "none") {
      box.appendChild(el("div", "bc-txt", "未设置（跟随主题底色）"));
      return;
    }
    if (v.indexOf("image:") === 0) {
      var im = el("img");
      im.src = v.slice(6);
      im.alt = "";
      box.appendChild(im);
      box.appendChild(el("div", "bc-txt", "自定义图片背景"));
    } else {
      var sw = el("div");
      sw.style.cssText = "width:54px;height:54px;border-radius:6px;flex-shrink:0;background:" + v.slice(6);
      box.appendChild(sw);
      box.appendChild(el("div", "bc-txt", v.slice(6)));
    }
  }

  var pendingBg = "";

  function openBgModal() {
    pendingBg = currentBg || "";
    renderBgPanel();
    $("bgMask").classList.add("show");
  }

  function closeBgModal() {
    $("bgMask").classList.remove("show");
    /* 未保存则回滚预览 */
    setChatBg(currentBg || "");
  }

  async function saveBg(scope) {
    if (!currentRoomId) { return toast("请先选择聊天室", true); }
    var val = pendingBg || "none";
    var res = await apiPost(PLUGIN + "/set_bg", {
      room_id: currentRoomId, bg: val, scope: scope || "room"
    });
    if (!res || !res.ok) { return; }
    currentBg = val === "none" ? "" : val;
    setChatBg(currentBg);
    lsSet("agc_bg_default", currentBg);
    closeBgModal();
    toast(scope === "all" ? "已把该背景设为所有房间的默认" : "聊天背景已保存");
  }

  async function resetBg(scope) {
    pendingBg = "none";
    await saveBg(scope);
  }

  /* ------------------------------ 用户资料（v2.1） ------------------------------ */
  async function saveUserProfile() {
    var nick = String($("spNick").value || "").trim() || "我";
    var res = await apiPost(PLUGIN + "/user_profile", { nickname: nick });
    if (res && res.ok) {
      USER_NICK = res.nickname || nick;
      renderUserProfileBox();
      renderConversations();
      renderFriends();
      toast("昵称已保存");
    }
  }

  function renderUserProfileBox() {
    var box = $("spAvatar");
    if (!box) { return; }
    clearNode(box);
    if (USER_AVATAR) {
      box.appendChild(makeAvatar("sp-avatar-img", USER_AVATAR, USER_NICK));
    } else {
      box.appendChild(document.createTextNode(initial(USER_NICK)));
    }
    if ($("spNick")) { $("spNick").value = USER_NICK; }
  }

  /* ------------------------------ 设置弹窗 ------------------------------ */
  function openModal() {
    $("mask").classList.add("show");
    loadGlobalMem();
    renderSummaryList();
    renderAutoPanel();
  }
  function closeModal() { $("mask").classList.remove("show"); }

  async function loadGlobalMem() {
    var d = await apiGet(PLUGIN + "/global_memory");
    if (!d) { return; }
    var raw = d.memory || "";
    memItems = splitMemoryItems(raw);
    var box = $("globalMemInput");
    if (box) { box.value = raw; }
    allowYoosungPrivate = !!d.allow_yoosung_private;
    $("switchYoosung").classList.toggle("on", allowYoosungPrivate);
    renderMemList();
  }

  function splitMemoryItems(text) {
    var raw = String(text || "");
    if (!raw.trim()) { return []; }
    return raw.split(/\n(?=【)/)
      .map(function (x) { return x.trim(); })
      .filter(function (x) { return x.length > 0; });
  }

  function joinMemoryItems(items) {
    return (items || []).filter(function (x) { return x && String(x).trim(); }).join("\n");
  }

  function renderMemList() {
    var wrap = $("memListWrap");
    if (!wrap) { return; }
    clearNode(wrap);
    if (!memItems.length) {
      wrap.appendChild(el("div", "empty-tip", "还没有任何记忆条目。发送消息、主动对话或点「总结本房间记忆」后会自动积累。"));
      return;
    }
    memItems.forEach(function (txt, i) {
      wrap.appendChild(buildFeedCard({
        time: "记忆 #" + (i + 1), text: txt,
        editAct: "edit-mem", delAct: "del-mem", idx: i
      }));
    });
  }

  async function editMemItem(i) {
    var old = memItems[i];
    if (old === undefined) { return; }
    var vals = await openDialog({
      title: "编辑记忆 #" + (i + 1),
      message: "这条记忆会被所有聊天室的角色看到，改成事实即可。",
      okText: "保存",
      fields: [{ key: "value", label: "记忆内容", type: "textarea", value: old, rows: 7 }]
    });
    if (!vals) { return; }
    var text = String(vals.value || "").trim();
    if (!text) { return toast("记忆内容不能为空，如需移除请点删除", true); }
    memItems[i] = text;
    await persistMemItems("记忆已更新");
  }

  async function delMemItem(i) {
    var sure = await uiConfirm("删除记忆条目",
      "确定删除这条记忆？\n\n" + String(memItems[i] || "").slice(0, 120), "确认删除");
    if (!sure) { return; }
    memItems.splice(i, 1);
    await persistMemItems("该条记忆已删除");
  }

  async function addMemItem() {
    var vals = await openDialog({
      title: "手动添加一条记忆",
      message: "写一条所有角色都应知道的事实，例如「用户是售电公司业务员，主做福建电力交易平台」。",
      okText: "添加",
      fields: [{ key: "value", label: "记忆内容", type: "textarea", value: "", rows: 5, placeholder: "直接写内容即可，系统会自动打上【手动记录】标记" }]
    });
    if (!vals) { return; }
    var text = String(vals.value || "").trim();
    if (!text) { return toast("内容不能为空", true); }
    if (text.charAt(0) !== "【") { text = "【手动记录】" + text; }
    memItems.push(text);
    await persistMemItems("已添加一条记忆");
  }

  async function persistMemItems(okMsg) {
    var joined = joinMemoryItems(memItems);
    var res = await apiPost(PLUGIN + "/set_global_memory", { memory: joined });
    if (res && res.ok) {
      var box = $("globalMemInput");
      if (box) { box.value = joined; }
      renderMemList();
      if (okMsg) { toast(okMsg); }
    }
  }

  async function toggleSwitch() {
    allowYoosungPrivate = !allowYoosungPrivate;
    var res = await apiPost(PLUGIN + "/set_switch", { allow: allowYoosungPrivate });
    if (!res || !res.ok) {
      allowYoosungPrivate = !allowYoosungPrivate;
      return;
    }
    $("switchYoosung").classList.toggle("on", allowYoosungPrivate);
    toast(allowYoosungPrivate ? "已开启私聊记忆读取" : "已关闭私聊记忆读取");
  }

  async function saveGlobalMem() {
    var res = await apiPost(PLUGIN + "/set_global_memory", { memory: $("globalMemInput").value });
    if (res && res.ok) { toast("全局记忆已保存"); }
  }

  async function summaryRoom() {
    if (!currentRoomId) { return toast("请先选择聊天室", true); }
    toast("正在总结本房间…");
    var res = await apiPost(PLUGIN + "/summary_room", {
      room_id: currentRoomId, roles: roles, emojis: emojis
    });
    if (!res) { return; }
    if (!res.ok) { return toast(res.msg || "总结失败", true); }
    toast("摘要生成成功，已作为一条新记忆追加");
    summaries = res.summaries || [];
    renderSummaryList();
    await loadGlobalMem();
  }

  async function clearHistory() {
    if (!currentRoomId) { return toast("请先选择聊天室", true); }
    var sure = await uiConfirm("清空聊天历史",
      "清空本房间的聊天历史？（角色、表情、摘要不会删除）", "确认清空");
    if (!sure) { return; }
    var res = await apiPost(PLUGIN + "/clear", { room_id: currentRoomId });
    if (!res || !res.ok) { return; }
    history = [];
    clearNode($("chatLog"));
    toast("历史已清空");
  }

  function buildFeedCard(cfg) {
    var card = el("div", "sum-card");
    var head = el("div", "sum-head");
    head.appendChild(el("span", "sum-time", cfg.time));
    var acts = el("span", "sum-acts");
    var edit = el("button", null, "编辑");
    edit.type = "button";
    edit.dataset.act = cfg.editAct;
    edit.dataset.idx = String(cfg.idx);
    if (cfg.id !== undefined && cfg.id !== null) { edit.dataset.id = String(cfg.id); }
    var del = el("button", "danger", "删除");
    del.type = "button";
    del.dataset.act = cfg.delAct;
    del.dataset.idx = String(cfg.idx);
    if (cfg.id !== undefined && cfg.id !== null) { del.dataset.id = String(cfg.id); }
    acts.appendChild(edit);
    acts.appendChild(del);
    head.appendChild(acts);
    card.appendChild(head);
    card.appendChild(el("div", "sum-text", cfg.text));
    return card;
  }

  function fmtTime(v) {
    if (!v) { return "时间未知"; }
    var ts = parseUtc(v);
    if (!ts) { return String(v).slice(0, 16); }
    var d = new Date(ts);
    var now = new Date();
    var hh = ("0" + d.getHours()).slice(-2);
    var mm = ("0" + d.getMinutes()).slice(-2);
    if (d.toDateString() === now.toDateString()) { return hh + ":" + mm; }
    return (d.getMonth() + 1) + "月" + d.getDate() + "日 " + hh + ":" + mm;
  }

  /* 后端统一存 UTC（字符串不带时区后缀），前端必须按 UTC 解析再转本地展示；
     否则服务器时区 ≠ 本地时区就会出现"显示4点实际12点半"的偏差 */
  function parseUtc(v) {
    var s = String(v || "").trim();
    if (!s) { return 0; }
    if (!/[zZ]$|[+-]\d{2}:?\d{2}$/.test(s)) { s = s.replace(" ", "T") + "Z"; }
    var t = Date.parse(s);
    return isNaN(t) ? 0 : t;
  }

  function renderSummaryList() {
    var wrap = $("sumListWrap");
    if (!wrap) { return; }
    clearNode(wrap);
    if (!summaries.length) {
      wrap.appendChild(el("div", "empty-tip", "还没有摘要。先在房间里聊几句，再点上方「立即总结本房间」。"));
      return;
    }
    summaries.forEach(function (s, i) {
      wrap.appendChild(buildFeedCard({
        time: "摘要 #" + (summaries.length - i) + " · " + fmtTime(s.created_at),
        text: String(s.summary || ""),
        editAct: "edit-sum", delAct: "del-sum", idx: i, id: s.id
      }));
    });
  }

  async function editSummary(i) {
    var s = summaries[i];
    if (!s) { return; }
    if (s.id === undefined || s.id === null) {
      return toast("这条摘要缺少 id，请刷新页面后重试", true);
    }
    var vals = await openDialog({
      title: "编辑摘要",
      message: "摘要会作为记忆注入后续对话，改成你希望角色记住的版本。",
      okText: "保存",
      fields: [{ key: "value", label: "摘要内容", type: "textarea", value: String(s.summary || ""), rows: 7 }]
    });
    if (!vals) { return; }
    var text = String(vals.value || "").trim();
    if (!text) { return toast("摘要内容不能为空", true); }
    var res = await apiPost(PLUGIN + "/update_summary", {
      id: s.id, summary: text, room_id: currentRoomId
    });
    if (!res || !res.ok) { return; }
    summaries = res.summaries || summaries;
    renderSummaryList();
    toast("摘要已更新");
  }

  async function delSummary(i) {
    var s = summaries[i];
    if (!s) { return; }
    if (s.id === undefined || s.id === null) {
      return toast("这条摘要缺少 id，请刷新页面后重试", true);
    }
    var sure = await uiConfirm("删除摘要", "确定删除这条摘要？\n\n" + String(s.summary || "").slice(0, 120), "确认删除");
    if (!sure) { return; }
    var res = await apiPost(PLUGIN + "/del_summary", { id: s.id, room_id: currentRoomId });
    if (!res || !res.ok) { return; }
    summaries = res.summaries || [];
    renderSummaryList();
    toast("摘要已删除");
  }

  /* ------------------------------ 消息渲染 ------------------------------ */
  function findAvatar(who) {
    var r = roles.find(function (x) { return x.name === who; });
    return (r && r.avatar) || "";
  }

  /* 角色在当前会话里的全局 key：私聊直接用会话 role_key；群聊用 房间|名字 */
  function roleKeyOf(who) {
    if (!who || who === "user" || who === "系统") { return ""; }
    if (currentConv && currentConv.kind === "dm" && currentConv.role_key) {
      return currentConv.role_key;
    }
    return (currentRoomId || "") + "|" + who;
  }

  function findFriend(roleKey) {
    for (var i = 0; i < friends.length; i++) {
      if (friends[i].role_key === roleKey) { return friends[i]; }
    }
    return null;
  }

  /* 头像节点：非自己的 AI 角色头像可点开资料主页；离线状态置灰 */
  function buildMsgAvatar(who, cont) {
    if (cont) { return el("div", "msg-avatar avatar-blank"); }
    var key = roleKeyOf(who);
    var friend = key ? findFriend(key) : null;
    var offline = !!(friend && friend.status && friend.status.state === "sleep");
    var av = makeAvatar("msg-avatar" + (offline ? " offline" : ""), findAvatar(who), who);
    if (key) {
      av.style.cursor = "pointer";
      av.addEventListener("click", function (e) {
        e.stopPropagation();
        openProfile(key);
      });
    }
    return av;
  }
  function findEmojiImg(ename) {
    if (!ename) { return ""; }
    var e = emojis.find(function (x) { return x.name === ename; });
    return (e && e.preview) || "";
  }

  /* 把 @角色名 渲染成高亮 span，其余保持纯文本（仍然 0 innerHTML） */
  function appendContentText(node, text) {
    var names = roles.map(function (r) { return String(r.name || "").trim(); })
      .filter(Boolean)
      .sort(function (a, b) { return b.length - a.length; });
    if (!names.length) {
      node.appendChild(document.createTextNode(text));
      return;
    }
    var re = new RegExp("@(" + names.map(escapeRegExp).join("|") + ")", "g");
    var last = 0, m;
    while ((m = re.exec(text)) !== null) {
      if (m.index > last) { node.appendChild(document.createTextNode(text.slice(last, m.index))); }
      node.appendChild(el("span", "mention", m[0]));
      last = m.index + m[0].length;
    }
    if (last < text.length) { node.appendChild(document.createTextNode(text.slice(last))); }
  }

  function openLightbox(src, list, idx) {
    lightboxList = (list && list.length) ? list : [src];
    lightboxIdx = (idx === undefined || idx === null || idx < 0 || idx >= lightboxList.length) ? 0 : idx;
    $("lightboxImg").src = lightboxList[lightboxIdx];
    $("lightbox").classList.add("show");
    updateLightboxNav();
  }

  function updateLightboxNav() {
    var prev = $("lbPrev"), next = $("lbNext"), counter = $("lbCounter");
    var multi = lightboxList.length > 1;
    if (prev) { prev.style.display = multi ? "flex" : "none"; }
    if (next) { next.style.display = multi ? "flex" : "none"; }
    if (counter) { counter.textContent = multi ? ((lightboxIdx + 1) + " / " + lightboxList.length) : ""; }
  }

  function stepLightbox(delta) {
    if (lightboxList.length < 2) { return; }
    lightboxIdx = (lightboxIdx + delta + lightboxList.length) % lightboxList.length;
    $("lightboxImg").src = lightboxList[lightboxIdx];
    updateLightboxNav();
  }

  /* 收集当前会话内全部图片消息，供大图查看器左右切换 */
  function imageListInChat() {
    return history.filter(function (m) { return m.image && !m.recalled; })
      .map(function (m) { return m.image; });
  }

  /* --------------------- 时间分隔条 / 已读回执 辅助 --------------------- */
  var DIVIDER_GAP = 5 * 60 * 1000;      /* 间隔超过 5 分钟插一条时间分隔 */

  function parseMsgTime(v) {
    return parseUtc(v);
  }

  function fmtClock(ts) {
    var d = new Date(ts);
    var now = new Date();
    var hh = ("0" + d.getHours()).slice(-2);
    var mm = ("0" + d.getMinutes()).slice(-2);
    if (d.toDateString() === now.toDateString()) { return hh + ":" + mm; }
    return (d.getMonth() + 1) + "月" + d.getDate() + "日 " + hh + ":" + mm;
  }

  function insertTimeDivider(ts) {
    var row = el("div", "time-divider");
    row.appendChild(el("span", null, fmtClock(ts)));
    (renderTarget || $("chatLog")).appendChild(row);
  }

  /* AI 回话后，把本轮所有还挂着"已发送"的用户消息一并标成"已读" */
  function markUserRead() {
    if (!REAL.readReceipt) { return; }
    var selves = $("chatLog").querySelectorAll(".msg-wrap.self");
    for (var i = 0; i < selves.length; i++) {
      var st = selves[i].querySelector(".msg-status");
      if (st && st.textContent === "已发送") {
        st.textContent = "已读";
        st.classList.add("read");
      }
    }
  }

  function isDMConv() { return !!(currentConv && currentConv.kind === "dm"); }

  /* 返回 history 中最后一条用户消息的对象引用：用引用比较而不是 id，
     刚发出还没回填 id 的乐观消息也能正确命中，且只命中一条 */
  function lastUserMsgInHistory() {
    for (var i = history.length - 1; i >= 0; i--) {
      if (history[i].who === "user") { return history[i]; }
    }
    return null;
  }

  function midOf(msg) {
    return (msg.id === undefined || msg.id === null || msg.id === "") ? "" : String(msg.id);
  }

  function appendMsg(msg, immediate) {
    var log = renderTarget || $("chatLog");
    var isSelf = msg.who === "user";
    var ts = parseMsgTime(msg.created_at) || Date.now();

    /* 1) 时间分隔条：与上一条隔得久就插一条，像真聊天软件那样 */
    if (REAL.timeDivider && lastMsgAt && (ts - lastMsgAt) > DIVIDER_GAP) {
      insertTimeDivider(ts);
    }
    var cont = !!(REAL.mergeAvatar && msg.who === lastWho);
    lastMsgAt = ts;
    lastWho = msg.who;

    var wrap = el("div", "msg-wrap" + (isSelf ? " self" : "") + (cont ? " cont" : ""));
    var mid = midOf(msg);
    if (mid) { wrap.dataset.mid = mid; }
    /* 2) 连续同一人发言时隐藏头像，视觉上并成一组 */
    wrap.appendChild(buildMsgAvatar(msg.who, cont));

    var main = el("div", "msg-main");
    var bubble = el("div", "msg-bubble");

    /* 3) 撤回：只留一行灰色提示，不再渲染内容 */
    if (msg.recalled) {
      main.appendChild(el("div", "msg-recalled",
        (isSelf ? "你" : msg.who) + " 撤回了一条消息"));
      wrap.appendChild(main);
      log.appendChild(wrap);
      if (!loadingOlder && (stickBottom || isSelf)) { scrollToBottom(immediate); }
      if (immediate) { wrap.classList.add("show"); }
      else { setTimeout(function () { wrap.classList.add("show"); }, 30); }
      return;
    }

    if (!cont) { bubble.appendChild(el("div", "msg-name", msg.who === "user" ? USER_NICK : msg.who)); }

    /* 4) 连锁接话：这条在回应谁 */
    if (msg.reply_to) {
      bubble.appendChild(el("div", "msg-reply-to",
        "↳ 回复 " + (msg.reply_to === "user" ? "你" : msg.reply_to)));
    }
    /* 5) 引用原文 / 转发引用条（FWD:: 前缀为转发消息，点击展开完整上下文） */
    if (msg.quote) {
      if (msg.quote.indexOf("FWD::") === 0) {
        var fwd = el("div", "msg-quote msg-forward");
        var body = msg.quote.slice(5);
        var label = body.split("：")[0] || "转发的消息";
        fwd.appendChild(el("div", "mf-label", "🔁 " + label + "（点击展开）"));
        var mfBody = el("div", "mf-body", body);
        mfBody.style.display = "none";
        fwd.appendChild(mfBody);
        fwd.addEventListener("click", function (e) {
          e.stopPropagation();
          mfBody.style.display = mfBody.style.display === "none" ? "block" : "none";
        });
        bubble.appendChild(fwd);
      } else {
        bubble.appendChild(el("div", "msg-quote", msg.quote));
      }
    }

    var content = el("div", "msg-content");
    var eImg = findEmojiImg(msg.emoji_name);
    if (eImg && (msg.is_big_emoji || !msg.content)) {
      /* 表情包独立大气泡：无气泡底、无边框、单独成行，对齐微信/QQ 体验 */
      bubble.classList.add("bubble-plain");
      var big = el("img", "big-emoji");
      big.src = eImg;
      big.alt = msg.emoji_name || "";
      big.addEventListener("click", function (e) { e.stopPropagation(); openLightbox(eImg, [eImg], 0); });
      content.appendChild(big);
    } else if (eImg) {
      var im = el("img", "msg-emoji");
      im.src = eImg;
      im.alt = msg.emoji_name || "";
      content.appendChild(im);
    }
    if (msg.content) { appendContentText(content, String(msg.content)); }
    bubble.appendChild(content);

    /* 识图消息：气泡内直接显示图片，点击放大 */
    if (msg.image) {
      var mimg = el("img", "msg-img");
      mimg.src = msg.image;
      mimg.alt = "图片消息";
      mimg.loading = "lazy";
      mimg.addEventListener("click", function (e) {
        e.stopPropagation();
        var list = imageListInChat();
        openLightbox(msg.image, list, list.indexOf(msg.image));
      });
      bubble.appendChild(mimg);
    }

    /* 6) 消息操作条：引用 / 表情回应 / 撤回（仅自己），点气泡开合，移动端也可用 */
    bubble.appendChild(buildMsgActions(msg, wrap));
    bubble.addEventListener("click", function (e) {
      if (e.target.closest(".msg-img")) { return; }
      wrap.classList.toggle("act-open");
    });
    main.appendChild(bubble);

    /* 7) 已读回执：仅私聊显示，且只显示在用户最后一条消息上（对齐真实 IM） */
    var isLastUser = isSelf && lastUserMsgInHistory() === msg;
    if (isSelf && REAL.readReceipt && isDMConv() && isLastUser) {
      main.appendChild(el("div", "msg-status", "已发送"));
    }
    if (msg.created_at && !cont) { main.appendChild(el("div", "msg-time", fmtTime(msg.created_at))); }

    /* 8) 表情回应聚合展示 */
    if (mid && reactionMap[mid] && reactionMap[mid].length) {
      main.appendChild(buildReactionRow(mid, msg));
    }

    wrap.appendChild(main);
    log.appendChild(wrap);

    /* 智能吸底：用户手动上滑看历史时不要把他拽回底部，同时累计新消息数 */
    if (!loadingOlder && (stickBottom || isSelf)) { scrollToBottom(immediate); }
    else if (!loadingOlder && !isSelf) { newMsgCount++; updateToBottomBtn(); }

    if (immediate) { wrap.classList.add("show"); }
    else { setTimeout(function () { wrap.classList.add("show"); }, 30); }
    return wrap;
  }

  /* 消息操作条。乐观渲染时消息还没有 id，回填 id 后会用同一份函数重挂一次。 */
  function buildMsgActions(msg, wrap) {
    var acts = el("div", "msg-actions");
    var bQuote = el("span", "ma-btn", "↩︎");
    bQuote.title = "引用这条消息";
    bQuote.addEventListener("click", function (e) { e.stopPropagation(); setQuote(msg); });
    acts.appendChild(bQuote);
    var mid = midOf(msg);
    if (mid) {
      var bReact = el("span", "ma-btn", "😀");
      bReact.title = "表情回应";
      bReact.addEventListener("click", function (e) { e.stopPropagation(); toggleReactPicker(msg); });
      acts.appendChild(bReact);
    }
    if (msg.who === "user" && mid) {
      var bRecall = el("span", "ma-btn", "🗑");
      bRecall.title = "撤回这条消息";
      bRecall.addEventListener("click", function (e) { e.stopPropagation(); recallMessage(msg, wrap); });
      acts.appendChild(bRecall);
    }
    if (mid) {
      var bFwd = el("span", "ma-btn", "🔁");
      bFwd.title = "转发到其它会话";
      bFwd.addEventListener("click", function (e) { e.stopPropagation(); forwardMessage(msg); });
      acts.appendChild(bFwd);
    }
    return acts;
  }

  function buildReactionRow(mid, msg) {
    var rrow = el("div", "msg-reactions");
    var counts = {};
    (reactionMap[mid] || []).forEach(function (e) { counts[e] = (counts[e] || 0) + 1; });
    Object.keys(counts).forEach(function (emoji) {
      var chip = el("span", "reaction-chip",
        counts[emoji] > 1 ? (emoji + " " + counts[emoji]) : emoji);
      chip.title = "点击取消这个回应";
      chip.addEventListener("click", function (e) { e.stopPropagation(); reactTo(msg, emoji); });
      rrow.appendChild(chip);
    });
    return rrow;
  }

  function scrollToBottom(immediate) {
    var log = $("chatLog");
    var doIt = function () { log.scrollTop = log.scrollHeight; };
    if (immediate) { doIt(); }
    else { requestAnimationFrame(doIt); }
    stickBottom = true;
    updateToBottomBtn();
  }

  /* 回到底部按钮：上滑期间来新消息时改成"↓ N 条新消息" */
  function updateToBottomBtn() {
    var btn = $("btnToBottom");
    if (!btn) { return; }
    if (stickBottom) { newMsgCount = 0; }
    btn.classList.toggle("show", !stickBottom);
    btn.textContent = newMsgCount > 0 ? ("↓ " + newMsgCount + " 条新消息") : "↓ 回到底部";
  }

  function bindChatScroll() {
    var log = $("chatLog");
    log.addEventListener("scroll", function () {
      var gap = log.scrollHeight - log.scrollTop - log.clientHeight;
      stickBottom = gap < 60;
      updateToBottomBtn();
      /* 懒加载：滚动到顶部自动加载上一批 50 条；
         lazyReady 守卫见 renderChat；clientHeight>0 守卫避免布局未就绪时
         scrollHeight/clientHeight 同为 0 被误判成"内容没撑满"而瞬间加载全部 */
      if (lazyReady && renderFrom > 0 && log.clientHeight > 0) {
        if (log.scrollTop < 40) { loadOlderMessages(); }
        /* 兜底：内容还没撑满容器（无法再向上滚动）但仍有更早消息时继续加载 */
        else if (log.scrollHeight <= log.clientHeight + 4) { loadOlderMessages(); }
      }
    }, { passive: true });
    $("btnToBottom").addEventListener("click", function () { scrollToBottom(false); });
  }

  function renderChat() {
    var log = $("chatLog");
    clearNode(log);
    lastMsgAt = 0;
    lastWho = "";
    newMsgCount = 0;
    /* 懒加载：默认只渲染最近 RENDER_BATCH 条，滚动到顶部再加载更早批次 */
    renderFrom = Math.max(0, history.length - RENDER_BATCH);
    for (var i = renderFrom; i < history.length; i++) { appendMsg(history[i], true); }
    /* 覆盖层刚从 display:none 切到可见时 scrollHeight 还是 0，这一帧滚动会失效，
       而此刻 scrollTop 仍是 0，会被懒加载逻辑误判成"用户滚到了顶部"。
       因此先关掉懒加载开关，双帧把位置钉在底部后再打开。 */
    lazyReady = false;
    scrollToBottom(true);
    requestAnimationFrame(function () { scrollToBottom(true); });
    /* 气泡入场动画（transform/transition）与图片加载会在头几百毫秒内反复重排，
       浏览器把 scrollTop 钳制出 4 这类小值，会被误判成"用户滚到了顶部"而瞬间加载全部。
       等首屏彻底稳定（动画 250ms + 余量）后再钉一次底部并打开懒加载开关。 */
    setTimeout(function () {
      scrollToBottom(true);
      lazyReady = true;
    }, 700);
  }

  /* 滚动到顶部加载上一批 50 条；加载后保持当前阅读位置不跳动 */
  function loadOlderMessages() {
    if (renderFrom <= 0) { return; }
    var log = $("chatLog");
    /* 锚点：用 offsetTop（文档流坐标，不受滚动影响）记录当前可见的第一条消息，
       插入历史后再把 scrollTop 补回同样的量 —— rect 坐标会混入滚动变化，不可用 */
    var anchorEl = log.querySelector(".msg-wrap[data-mid]");
    var anchorTop = anchorEl ? anchorEl.offsetTop : 0;
    var start = Math.max(0, renderFrom - RENDER_BATCH);
    var frag = document.createDocumentFragment();
    renderTarget = frag;
    loadingOlder = true;
    try {
      for (var i = start; i < renderFrom; i++) { appendMsg(history[i], true); }
    } finally {
      loadingOlder = false;
    }
    renderTarget = null;
    log.insertBefore(frag, log.firstChild);
    renderFrom = start;
    if (anchorEl && anchorEl.parentNode === log) {
      /* 读 offsetTop 触发同步重排，拿到插入后的真实文档流位置；
         .chat-log 开了 scroll-behavior:smooth，必须用 behavior:'instant' 覆盖，
         否则补偿会变成一段滑动动画，用户依旧看到位置跳动 */
      var target = log.scrollTop + (anchorEl.offsetTop - anchorTop);
      if (typeof log.scrollTo === "function") {
        log.scrollTo({ top: target, behavior: "instant" });
      } else {
        log.scrollTop = target;
      }
    }
    if (renderFrom <= 0) {
      var tip = log.querySelector(".load-all-tip");
      if (!tip) {
        tip = el("div", "load-all-tip sys-tip", "已加载全部历史消息");
        log.insertBefore(tip, log.firstChild);
      }
    }
  }

  function setBusy(busy) {
    $("btnSend").disabled = busy;
    if (!auto.enabled) { $("btnAuto").disabled = busy; }
  }

  /* ====================== 输入中提示（v1.9.0 核心） ====================== *
   * 等待模型期间先按预测显示"谁在输入"；拿到 replies 后逐条播放
   * "某某输入中…"，时长按字数拟真，再插入气泡。人数不超过 typingNames
   * 时直接点名（"小美、阿强 输入中…"），超过则显示"N 人输入中…"。
   * ==================================================================== */
  var typingToken = 0;
  var playing = false;

  function typingDelay(text) {
    var len = String(text || "").length;
    var base = 320 + Math.min(len, 60) * 38;
    var ms = base + base * 0.25 * (Math.random() * 2 - 1);
    ms = ms / Math.max(0.2, REAL.typeSpeed);
    return Math.max(180, Math.min(2600, Math.round(ms)));
  }

  function burstDelay() {
    /* 同一个人连发多条时的"手速"间隔 */
    return Math.round((160 + Math.random() * 420) / Math.max(0.2, REAL.typeSpeed));
  }

  /* 预测本轮谁可能说话：被 @ 的排前面，其余从角色池里随机抽 */
  function estimateTypers(mentions) {
    var pool = roles.map(function (r) { return String(r.name || "").trim(); }).filter(Boolean);
    if (!pool.length) { return []; }
    var head = (mentions || []).filter(function (m) { return pool.indexOf(m) !== -1; });
    var rest = pool.filter(function (n) { return head.indexOf(n) === -1; });
    var want = Math.min(pool.length, 1 + Math.floor(Math.random() * Math.min(3, pool.length)));
    if (head.length > want) { want = head.length; }
    var picked = head.slice(0, want);
    while (picked.length < want && rest.length) {
      picked.push(rest.splice(Math.floor(Math.random() * rest.length), 1)[0]);
    }
    return picked;
  }

  function toggleTypingShell(on) {
    var wrap = $("chatWrap");
    if (wrap) { wrap.classList.toggle("typing-on", !!on); }
  }

  function showTyping(names) {
    typingToken++;
    if (!REAL.typingEnabled) { toggleTypingShell(false); return typingToken; }
    var row = $("typingRow");
    if (!row) { return typingToken; }
    toggleTypingShell(true);
    clearNode(row);
    var list = (names || []).filter(Boolean);
    if (!list.length) { list = ["有人"]; }

    var av = el("div", "typing-avatars");
    list.slice(0, 3).forEach(function (n, i) {
      var a = makeAvatar("typing-avatar", findAvatar(n), n);
      a.style.zIndex = String(10 - i);
      av.appendChild(a);
    });
    row.appendChild(av);

    var bubble = el("div", "typing-bubble");
    var txt = list.length <= REAL.typingNames
      ? (list.join("、") + " 输入中")
      : (list.length + " 人输入中");
    bubble.appendChild(el("span", "typing-text", txt));
    var dots = el("span", "typing-dots");
    for (var i = 0; i < 3; i++) { dots.appendChild(el("i", null, ".")); }
    bubble.appendChild(dots);
    row.appendChild(bubble);
    row.classList.add("show");
    if (stickBottom) { scrollToBottom(false); }
    return typingToken;
  }

  function hideTyping() {
    typingToken++;
    toggleTypingShell(false);
    var row = $("typingRow");
    if (row) { row.classList.remove("show"); clearNode(row); }
  }

  /* 模拟"打了一半又删掉"：文案闪成省略号再恢复 */
  function flickerTyping(name) {
    var row = $("typingRow");
    if (!row) { return; }
    var t = row.querySelector(".typing-text");
    if (t) { t.textContent = name + " 正在输入"; }
  }

  /* 逐条播放：输入中 -> 气泡 -> 下一条。返回 false 表示被新一轮接管而中断。 */
  async function playReplies(msgs) {
    if (!msgs || !msgs.length) { hideTyping(); return true; }
    playing = true;
    try {
      for (var i = 0; i < msgs.length; i++) {
        var m = msgs[i];
        var token = showTyping([m.who]);
        var ms = typingDelay(m.content);
        var interrupted = !!(REAL.typingInterrupt && Math.random() < 0.14 && ms > 800);
        var first = Math.round(ms * (interrupted ? 0.45 : 0.6));
        await sleep(first);
        if (token !== typingToken) { return false; }
        if (interrupted) {
          flickerTyping(m.who);
          await sleep(320);
          if (token !== typingToken) { return false; }
        }
        await sleep(Math.max(120, ms - first - (interrupted ? 320 : 0)));
        if (token !== typingToken) { return false; }
        hideTyping();
        if (m.who !== "user") { markUserRead(); }
        appendMsg(m);
        if (i < msgs.length - 1) {
          await sleep(m.who === msgs[i + 1].who ? burstDelay() : burstDelay() + 260);
        }
      }
    } finally {
      playing = false;
      hideTyping();
    }
    return true;
  }

  /* 上一轮还在播放时，先把 history 里已落库的消息一次性刷到屏幕上 */
  function flushPlaying() {
    if (playing) { hideTyping(); renderChat(); }
  }

  /* ------------------------------ 引用消息 ------------------------------ */
  function setQuote(msg) {
    if (msg.recalled) { return toast("这条消息已撤回，无法引用", true); }
    if (!msg.content && !msg.image) { return toast("这条消息没有可引用的文字", true); }
    quoteDraft = { who: msg.who, content: msg.content || "[图片]", id: msg.id };
    renderQuotePreview();
    $("emoPanel").classList.remove("show");
    if ($("msgInput")) { $("msgInput").focus(); }
  }

  function clearQuote() {
    quoteDraft = null;
    renderQuotePreview();
  }

  function renderQuotePreview() {
    var box = $("quotePreview");
    if (!box) { return; }
    clearNode(box);
    if (!quoteDraft) { box.classList.remove("show"); return; }
    box.classList.add("show");
    var col = el("div", "qp-main");
    col.appendChild(el("div", "qp-label", "引用 " + (quoteDraft.who === "user" ? "自己" : quoteDraft.who)));
    col.appendChild(el("div", "qp-text", quoteDraft.content));
    box.appendChild(col);
    var btn = el("button", null, "取消");
    btn.type = "button";
    btn.addEventListener("click", clearQuote);
    box.appendChild(btn);
  }

  /* ------------------------------ 撤回消息 ------------------------------ */
  async function recallMessage(msg, wrap) {
    var ts = parseMsgTime(msg.created_at);
    if (ts && Date.now() - ts > 2 * 60 * 1000) {
      return toast("超过 2 分钟的消息不能撤回了", true);
    }
    var ok = await uiConfirm("撤回消息", "确定撤回这条消息吗？撤回后只留下一行提示。", "撤回");
    if (!ok) { return; }
    var res = await apiPost(PLUGIN + "/recall", { room_id: currentRoomId, msg_id: msg.id });
    if (!res || !res.ok) { return toast((res && res.msg) || "撤回失败", true); }
    msg.recalled = 1;
    for (var i = 0; i < history.length; i++) {
      if (String(history[i].id) === String(msg.id)) { history[i].recalled = 1; }
    }
    if (wrap) {
      clearNode(wrap);
      wrap.appendChild(el("div", "msg-avatar avatar-blank"));
      var main = el("div", "msg-main");
      main.appendChild(el("div", "msg-recalled",
        (msg.who === "user" ? "你" : msg.who) + " 撤回了一条消息"));
      wrap.appendChild(main);
      wrap.classList.add("show");
    }
    toast("已撤回");
  }

  /* ------------------------------ 表情回应 ------------------------------ */
  function toggleReactPicker(msg) {
    var panel = $("reactPicker");
    if (!panel) { return; }
    var mid = midOf(msg);
    if (!mid) { return toast("这条消息还没入库，暂时不能回应", true); }
    if (reactPickerFor === mid && panel.classList.contains("show")) {
      reactPickerFor = null; panel.classList.remove("show"); clearNode(panel);
      return;
    }
    reactPickerFor = mid;
    clearNode(panel);
    panel.appendChild(el("div", "rp-tip", "给这条消息加个表情回应"));
    var grid = el("div", "rp-grid");
    UNI_EMOJI.slice(0, 16).forEach(function (e) {
      var cell = el("div", "emo-uni", e);
      cell.addEventListener("click", function (ev) {
        ev.stopPropagation();
        reactPickerFor = null; panel.classList.remove("show"); clearNode(panel);
        reactTo(msg, e);
      });
      grid.appendChild(cell);
    });
    panel.appendChild(grid);
    panel.classList.add("show");
  }

  async function reactTo(msg, emoji) {
    var mid = midOf(msg);
    if (!mid) { return; }
    var res = await apiPost(PLUGIN + "/react",
      { room_id: currentRoomId, msg_id: msg.id, emoji: emoji });
    if (!res || !res.ok) { return toast((res && res.msg) || "表情回应失败", true); }
    reactionMap = res.reactions || {};
    refreshReactions();
    toast(res.action === "added" ? ("已回应 " + emoji) : ("已取消 " + emoji));
  }

  /* 只重绘表情行，不整屏重绘，避免打断正在播放的气泡动画 */
  function refreshReactions() {
    var wraps = $("chatLog").querySelectorAll(".msg-wrap[data-mid]");
    for (var i = 0; i < wraps.length; i++) {
      var mid = wraps[i].dataset.mid;
      var old = wraps[i].querySelector(".msg-reactions");
      if (old && old.parentNode) { old.parentNode.removeChild(old); }
      if (reactionMap[mid] && reactionMap[mid].length) {
        var main = wraps[i].querySelector(".msg-main");
        if (main) { main.appendChild(buildReactionRow(mid, { id: Number(mid) })); }
      }
    }
  }

  async function loadReactions() {
    reactionMap = {};
    var res = await apiGet(PLUGIN + "/reactions", { room_id: currentRoomId });
    if (res && res.ok) { reactionMap = res.reactions || {}; }
  }

  /* 乐观渲染的用户消息没有 id，响应回来后回填，撤回/表情回应才可用 */
  function backfillUserMsgs(localMsgs, wraps, newMsgs) {
    for (var i = 0; i < localMsgs.length; i++) {
      var real = newMsgs[i];
      if (!real || real.who !== "user") { continue; }
      localMsgs[i].id = real.id;
      var wrap = wraps[i];
      if (!wrap) { continue; }
      wrap.dataset.mid = String(real.id);
      var old = wrap.querySelector(".msg-actions");
      if (old && old.parentNode) {
        old.parentNode.replaceChild(buildMsgActions(localMsgs[i], wrap), old);
      }
    }
  }

  /* ------------------------------ 发送消息 ------------------------------ */
  function extractMentions(text) {
    return roles.map(function (r) { return String(r.name || "").trim(); })
      .filter(function (n) { return n && text.indexOf("@" + n) !== -1; });
  }

  async function send() {
    var input = $("msgInput");
    var text = input.value.trim();
    if (!pendingImage && !text) { return; }
    if (!currentRoomId) { return toast("请先选择聊天室", true); }
    if (!roles.length) { return toast("当前房间还没有角色，请先到设置里添加角色", true); }

    flushPlaying();

    var picked = selectedEmojiName;
    var mentions = extractMentions(text);
    var image = pendingImage;
    var quote = quoteDraft;

    input.value = "";
    lsSet("draft_" + currentRoomId, "");
    autoGrowInput();
    setPendingImage("");
    selectedEmojiName = "";
    updatePickedEmo();
    hideMentionPanel();
    clearQuote();

    /* 用户自己也能用分隔符刷屏：本地先按段乐观渲染，不等模型；
       表情+文字同条时与后端一致拆成「大表情 + 文字」两个气泡 */
    var segs = splitSegments(text);
    if (!segs.length) { segs = [""]; }
    var localMsgs = [], wraps = [];
    function pushLocal(mm) {
      var w = appendMsg(mm, true);
      localMsgs.push(mm); wraps.push(w);
      history.push(mm);
    }
    for (var i = 0; i < segs.length; i++) {
      var qtxt = (i === 0 && quote) ? ((quote.who === "user" ? USER_NICK : quote.who) + "：" + quote.content) : "";
      if (i === 0 && picked) {
        pushLocal({ who: "user", content: "", emoji_name: picked, is_big_emoji: 1, image: image, quote: qtxt });
        if (segs[i]) { pushLocal({ who: "user", content: segs[i], emoji_name: "", image: "", quote: "" }); }
      } else {
        pushLocal({ who: "user", content: segs[i], emoji_name: "", image: i === 0 ? image : "", quote: qtxt });
      }
    }

    setBusy(true);
    var est = estimateTypers(mentions);
    if (est.length) { showTyping(est); }

    var payload = {
      room_id: currentRoomId, content: text, emoji_name: picked,
      image: image, mentions: mentions, roles: roles, emojis: emojis,
      quote: quote ? (quote.content || "[图片]") : "",
      reply_to: quote ? quote.who : "",
      opts: buildOpts()
    };
    var res = await apiPost(PLUGIN + "/send", payload);
    setBusy(false);
    if (!res) { hideTyping(); return; }
    if (!res.ok) { hideTyping(); return toast(res.msg || "发送失败", true); }

    /* 对方离线：不显示输入中，插入灰色系统提示，醒来后由后端合并回复 */
    if (res.offline) {
      hideTyping();
      history = res.new_history || history;
      var tip = el("div", "sys-tip", "对方当前离线（睡觉中），醒来后会回复你");
      $("chatLog").appendChild(tip);
      scrollToBottom(false);
      loadConversations();
      return;
    }

    if (res.vision === false) {
      toast("图片已发出，但当前模型未能识图（不支持视觉输入），可在插件配置里换支持视觉的 provider", true);
    }

    history = res.new_history || history;
    var newMsgs = res.new_msgs || [];
    backfillUserMsgs(localMsgs, wraps, newMsgs);

    var aiMsgs = newMsgs.slice(localMsgs.length);
    if (!aiMsgs.length) {
      hideTyping();
      /* 后端没回 new_msgs（老版本）时退回按 replies 渲染 */
      aiMsgs = (res.replies || []).map(function (r) {
        return { who: r.role_name, content: r.content, emoji_name: r.emoji_name, reply_to: r.reply_to };
      });
    }
    if (!aiMsgs.length) {
      hideTyping();
      /* 本轮没有聊天回复，但角色仍可能更新了签名/心情、发了动态或在评论区回帖，
         这些变更必须照常落地并提示，不能被"没有接话"提前 return 吞掉 */
      var touched = applySocial(res);
      if (!touched) { toast("本轮没有角色接话"); }
      return;
    }
    await playReplies(aiMsgs);
    applySocial(res);
  }

  /* 采纳后端回传的签名/心情/动态变更，同步到本地缓存与界面 */
  function applySocial(res) {
    var socialTouched = false;
    if (!res || !res.social) { return false; }
    var social = res.social;
    if (social.profiles && social.profiles.length) {
      socialTouched = true;
      social.profiles.forEach(function (p) {
        var f = findFriend(p.role_key);
        if (f) {
          f.signature = p.signature || f.signature;
          f.mood = p.mood || f.mood;
        }
      });
      if (currentConv && currentConv.kind === "dm" && roles[0]) {
        $("currentRoomStatus").textContent = roles[0].mood || roles[0].signature || "在线";
      }
    }
    if (social.moment) {
      socialTouched = true;
      toast((social.moment.name || "角色") + " 发了一条新动态，去「动态」看看吧");
      if (social.moment.comments && social.moment.comments.length) {
        toast(social.moment.comments.map(function (c) { return c.who; }).join("、") + " 评论了这条动态");
      }
    }
    if (social.moment_replies && social.moment_replies.length) {
      socialTouched = true;
      toast(social.moment_replies.map(function (c) { return c.who; }).join("、") + " 在动态评论区回复了");
    }
    return socialTouched;
  }

  /* ------------------------------ 自主对话（定时 + 随机偏移） ------------------------------ */
  var auto = {
    enabled: false, interval: 30, jitter: 10, count: 0,
    timer: null, ticking: null, nextAt: 0, busy: false
  };

  function autoCfgKey() { return "agc_auto_" + (currentRoomId || "default"); }

  function loadAutoCfg() {
    var raw = lsGet(autoCfgKey(), "");
    if (raw) {
      try {
        var o = JSON.parse(raw);
        auto.interval = clampNum(o.interval, 5, 3600, 30);
        auto.jitter = clampNum(o.jitter, 0, 600, 10);
        auto.count = clampNum(o.count, 0, 10, 0);
        auto.enabled = !!o.enabled;
      } catch (e) { /* 配置损坏则用默认值 */ }
    }
    renderAutoPanel();
    if (auto.enabled) { startAutoTalk(false); } else { updateAutoBtn(); }
  }

  function saveAutoCfg() {
    lsSet(autoCfgKey(), JSON.stringify({
      interval: auto.interval, jitter: auto.jitter,
      count: auto.count, enabled: auto.enabled
    }));
  }

  function renderAutoPanel() {
    if ($("autoInterval")) { $("autoInterval").value = auto.interval; }
    if ($("autoJitter")) { $("autoJitter").value = auto.jitter; }
    if ($("autoCount")) { $("autoCount").value = auto.count; }
    if ($("switchAuto")) { $("switchAuto").classList.toggle("on", auto.enabled); }
    if ($("autoStatus")) {
      $("autoStatus").textContent = auto.enabled
        ? "当前状态：运行中，每 " + auto.interval + "s + 0~" + auto.jitter + "s 随机触发一轮"
        : "当前状态：未开启";
    }
    updateAutoBtn();
  }

  function updateAutoBtn() {
    var btn = $("btnAuto"), txt = $("autoBtnText");
    if (!btn || !txt) { return; }
    btn.classList.toggle("running", auto.enabled);
    if (auto.enabled && auto.nextAt) {
      var left = Math.max(0, Math.ceil((auto.nextAt - Date.now()) / 1000));
      txt.textContent = "自主对话 " + left + "s";
    } else if (auto.enabled) {
      txt.textContent = "自主对话 运行中";
    } else {
      txt.textContent = "主动对话";
    }
    var cfgBtn = $("btnAutoCfg");
    if (cfgBtn) { cfgBtn.classList.toggle("on", auto.enabled); }
  }

  function startAutoTalk(notify) {
    stopAutoTalk(false);
    auto.enabled = true;
    auto.busy = false;
    saveAutoCfg();
    scheduleNext();
    auto.ticking = setInterval(updateAutoBtn, 500);
    renderAutoPanel();
    if (notify !== false) {
      toast("已开启自主对话：每 " + auto.interval + "s + 0~" + auto.jitter + "s 随机一轮");
    }
  }

  function stopAutoTalk(notify) {
    auto.enabled = false;
    auto.busy = false;
    auto.nextAt = 0;
    if (auto.timer) { clearTimeout(auto.timer); auto.timer = null; }
    if (auto.ticking) { clearInterval(auto.ticking); auto.ticking = null; }
    saveAutoCfg();
    renderAutoPanel();
    if (notify) { toast("已停止自主对话"); }
  }

  function scheduleNext() {
    var delay = (auto.interval + Math.random() * auto.jitter) * 1000;
    auto.nextAt = Date.now() + delay;
    auto.timer = setTimeout(async function () {
      auto.timer = null;
      if (!auto.enabled) { return; }
      await runAutoRound(true);
      if (auto.enabled) { scheduleNext(); }
    }, delay);
    updateAutoBtn();
  }

  async function runAutoRound(silent) {
    if (!currentRoomId) { return; }
    if (auto.busy) { return; }
    if (!roles.length) {
      if (!silent) { toast("当前房间还没有角色，请先到设置里添加角色", true); }
      return;
    }
    flushPlaying();
    auto.busy = true;
    setBusy(true);
    var est = estimateTypers([]);
    if (est.length) { showTyping(est); }
    var res = await apiPost(PLUGIN + "/auto_talk", {
      room_id: currentRoomId, roles: roles, emojis: emojis,
      count: auto.count, opts: buildOpts()
    });
    auto.busy = false;
    setBusy(false);
    if (!res) { hideTyping(); return; }
    if (!res.ok) {
      hideTyping();
      if (!silent) { toast(res.msg || "主动对话失败", true); }
      else { toast("自主对话一轮失败：" + (res.msg || "未知错误"), true); }
      return;
    }
    if (res.offline) {
      hideTyping();
      if (!silent) { toast("对方当前离线，醒来后会回复"); }
      return;
    }
    history = res.new_history || history;
    var msgs = res.new_msgs || [];
    if (!msgs.length) {
      msgs = (res.replies || []).map(function (r) {
        return { who: r.role_name, content: r.content, emoji_name: r.emoji_name, reply_to: r.reply_to };
      });
    }
    if (!msgs.length) {
      hideTyping();
      /* 同 send：没有聊天回复时，动态/评论区/签名变更仍要落地 */
      var touched = applySocial(res);
      if (!touched && !silent) { toast("本轮没有角色接话"); }
      return;
    }
    await playReplies(msgs);
    applySocial(res);
  }

  function toggleAutoTalk() {
    if (auto.enabled) { stopAutoTalk(true); }
    else {
      if (!currentRoomId) { return toast("请先选择聊天室", true); }
      if (!roles.length) { return toast("当前房间还没有角色，请先到设置里添加角色", true); }
      startAutoTalk(true);
    }
  }

  function applyAutoForm() {
    auto.interval = clampNum($("autoInterval").value, 5, 3600, 30);
    auto.jitter = clampNum($("autoJitter").value, 0, 600, 10);
    auto.count = clampNum($("autoCount").value, 0, 10, 0);
    $("autoInterval").value = auto.interval;
    $("autoJitter").value = auto.jitter;
    $("autoCount").value = auto.count;
    saveAutoCfg();
    if (auto.enabled) {
      startAutoTalk(false);
      toast("已按新节奏重启自主对话");
    } else {
      renderAutoPanel();
      toast("自主对话参数已保存（未开启）");
    }
  }

  /* ------------------------------ 拟真设置表单 ------------------------------ */
  var REAL_DEFAULTS = {
    splitSymbol: DEFAULT_SPLIT, allowMultiRound: true, maxReplyMessages: 8,
    timeAwareness: true, typingEnabled: true, typingNames: 3, typeSpeed: 1,
    readReceipt: true, timeDivider: true, mergeAvatar: true, typingInterrupt: true
  };

  function applyRealForm() {
    REAL.splitSymbol = String($("realSplit").value || "").slice(0, 2);
    REAL.maxReplyMessages = clampNum($("realMaxMsg").value, 1, 30, 8);
    REAL.typingNames = clampNum($("realTypingNames").value, 0, 10, 3);
    var sp = Number($("realTypeSpeed").value);
    REAL.typeSpeed = (isFinite(sp) && sp > 0) ? Math.min(5, Math.max(0.2, sp)) : 1;
    saveRealCfg();
    toast("拟真参数已保存：分段符号「" + (REAL.splitSymbol || "无") + "」，一轮最多 " +
      REAL.maxReplyMessages + " 条");
  }

  function resetRealCfg() {
    Object.keys(REAL_DEFAULTS).forEach(function (k) { REAL[k] = REAL_DEFAULTS[k]; });
    saveRealCfg();
    toast("已恢复默认拟真参数");
  }

  /* ------------------------------ 输入草稿本地保留（v2.1） ------------------------------ */
  function saveDraftDebounced() {
    if (draftTimer) { clearTimeout(draftTimer); }
    draftTimer = setTimeout(function () {
      if (!currentRoomId) { return; }
      lsSet("draft_" + currentRoomId, $("msgInput").value);
    }, 400);
  }

  function restoreDraft(rid) {
    var input = $("msgInput");
    input.value = lsGet("draft_" + rid, "");
    autoGrowInput();
  }

  /* ------------------------------ @提及浮层 ------------------------------ */
  var mentionState = { open: false, items: [], active: -1, start: -1 };

  function hideMentionPanel() {
    mentionState.open = false;
    mentionState.active = -1;
    mentionState.start = -1;
    var p = $("mentionPanel");
    if (p) { p.classList.remove("show"); clearNode(p); }
  }

  function renderMentionPanel(list, keyword) {
    var p = $("mentionPanel");
    clearNode(p);
    if (!list.length) {
      p.appendChild(el("div", "mention-tip", keyword ? "没有匹配「" + keyword + "」的角色" : "本房间还没有角色"));
      p.classList.add("show");
      mentionState.open = true;
      mentionState.items = [];
      return;
    }
    list.forEach(function (r, i) {
      var row = el("div", "mention-item" + (i === mentionState.active ? " active" : ""));
      row.dataset.idx = String(i);
      row.appendChild(makeAvatar("item-avatar", r.avatar, r.name));
      row.appendChild(el("span", null, "@" + r.name));
      row.addEventListener("click", function () { chooseMention(r); });
      p.appendChild(row);
    });
    p.classList.add("show");
    mentionState.open = true;
    mentionState.items = list;
  }

  function chooseMention(role) {
    var input = $("msgInput");
    var v = input.value;
    var pos = input.selectionStart === null ? v.length : input.selectionStart;
    var start = mentionState.start;
    if (start < 0) { start = pos; }
    insertAtCursor("@" + role.name + " ", start);
    hideMentionPanel();
  }

  function updateMention() {
    var input = $("msgInput");
    var v = input.value;
    var pos = input.selectionStart === null ? v.length : input.selectionStart;
    var before = v.slice(0, pos);
    var m = before.match(/@([^\s@]{0,20})$/);
    if (!m) { hideMentionPanel(); return; }
    var kw = m[1];
    var start = pos - m[0].length;
    var list = roles.filter(function (r) {
      var n = String(r.name || "");
      return !kw || n.indexOf(kw) !== -1;
    });
    mentionState.start = start;
    mentionState.active = list.length ? 0 : -1;
    renderMentionPanel(list, kw);
  }

  function moveMention(delta) {
    if (!mentionState.open || !mentionState.items.length) { return; }
    var n = mentionState.items.length;
    mentionState.active = (mentionState.active + delta + n) % n;
    var p = $("mentionPanel");
    var rows = p.querySelectorAll(".mention-item");
    for (var i = 0; i < rows.length; i++) {
      rows[i].classList.toggle("active", i === mentionState.active);
    }
  }

  /* 输入框自动增高 */
  function autoGrowInput() {
    var input = $("msgInput");
    input.style.height = "42px";
    var h = Math.min(120, Math.max(42, input.scrollHeight));
    input.style.height = h + "px";
  }

  /* ------------------------------ 事件绑定 ------------------------------ */
  function switchToTab(name) {
    document.querySelectorAll(".tab").forEach(function (x) { x.classList.remove("active"); });
    document.querySelectorAll(".tab-content").forEach(function (p) { p.classList.remove("active"); });
    var tab = document.querySelector('.tab[data-tab="' + name + '"]');
    if (tab) { tab.classList.add("active"); }
    var target = $(name);
    if (target) { target.classList.add("active"); }
  }

  function bindEvents() {
    /* 底部 TabBar 切换 */
    document.querySelectorAll(".tab-item").forEach(function (t) {
      t.addEventListener("click", function () { switchTab(t.dataset.tab); });
    });

    /* 聊天覆盖层返回消息列表 */
    $("btnBack").addEventListener("click", backFromChat);
    /* 资料页返回 */
    $("btnProfileBack").addEventListener("click", function () {
      profileOpen = false;
      $("profilePage").classList.remove("open");
    });
    /* 聊天顶栏标题点头像/名称进资料页（私聊） */
    $("currentRoomName").addEventListener("click", function () {
      if (currentConv && currentConv.kind === "dm" && currentConv.role_key) {
        openProfile(currentConv.role_key);
      }
    });

    /* 设置 Tab 各行 */
    $("rowTheme").addEventListener("click", toggleTheme);
    $("rowRoomSettings").addEventListener("click", openModal);
    $("rowGlobalMem").addEventListener("click", function () { openModal(); switchToTab("memTab"); });
    $("rowClearHistory").addEventListener("click", clearHistory);

    /* 顶栏按钮 */
    $("btnTheme").addEventListener("click", toggleTheme);
    $("btnBg").addEventListener("click", openBgModal);
    $("btnAutoCfg").addEventListener("click", function () {
      openModal();
      switchToTab("autoTab");
    });
    $("btnSetting").addEventListener("click", openModal);
    $("btnCloseModal").addEventListener("click", closeModal);

    /* 表情面板 */
    $("btnEmo").addEventListener("click", function (e) {
      e.stopPropagation();
      hideMentionPanel();
      $("emoPanel").classList.toggle("show");
    });
    document.addEventListener("click", function (e) {
      var p = $("emoPanel");
      if (!p.classList.contains("show")) { return; }
      if (p.contains(e.target) || e.target === $("btnEmo")) { return; }
      p.classList.remove("show");
    });

    /* @ 按钮：直接在光标处插入 @ 并弹出角色列表 */
    $("btnAt").addEventListener("click", function () {
      var input = $("msgInput");
      var pos = input.selectionStart === null ? input.value.length : input.selectionStart;
      input.value = input.value.slice(0, pos) + "@" + input.value.slice(pos);
      input.setSelectionRange(pos + 1, pos + 1);
      input.focus();
      updateMention();
    });

    /* 发图：按钮 / 文件框 / 粘贴 / 拖拽 四种入口 */
    $("btnImg").addEventListener("click", function () { $("imgInput").click(); });
    $("imgInput").addEventListener("change", function (e) {
      var f = e.target.files && e.target.files[0];
      handleImageFile(f);
      e.target.value = "";
    });
    $("msgInput").addEventListener("paste", function (e) {
      var items = (e.clipboardData && e.clipboardData.items) || [];
      for (var i = 0; i < items.length; i++) {
        if (items[i].type && items[i].type.indexOf("image") === 0) {
          var f = items[i].getAsFile();
          if (f) { e.preventDefault(); handleImageFile(f); return; }
        }
      }
    });
    var shell = $("appShell");
    shell.addEventListener("dragover", function (e) { e.preventDefault(); });
    shell.addEventListener("drop", function (e) {
      e.preventDefault();
      var f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (f) { handleImageFile(f); }
    });

    /* 发送 / 自主对话 */
    $("btnSend").addEventListener("click", send);
    $("btnAuto").addEventListener("click", toggleAutoTalk);
    $("btnAutoSave").addEventListener("click", applyAutoForm);
    $("btnAutoNow").addEventListener("click", function () { runAutoRound(false); });
    $("switchAuto").addEventListener("click", function () {
      if (auto.enabled) { stopAutoTalk(true); }
      else {
        auto.interval = clampNum($("autoInterval").value, 5, 3600, 30);
        auto.jitter = clampNum($("autoJitter").value, 0, 600, 10);
        auto.count = clampNum($("autoCount").value, 0, 10, 0);
        startAutoTalk(true);
      }
    });

    /* 设置弹窗内其它按钮 */
    $("btnAddRole").addEventListener("click", addRole);
    $("btnAddEmoji").addEventListener("click", addEmoji);
    $("btnSaveMem").addEventListener("click", saveGlobalMem);
    $("btnSummary").addEventListener("click", summaryRoom);
    $("btnClearHistory").addEventListener("click", clearHistory);
    if ($("btnSummary2")) { $("btnSummary2").addEventListener("click", summaryRoom); }
    if ($("btnAddMem")) { $("btnAddMem").addEventListener("click", addMemItem); }
    if ($("btnToggleRawMem")) {
      $("btnToggleRawMem").addEventListener("click", function () {
        var raw = $("rawMemWrap");
        var opened = raw.style.display === "none" || raw.style.display === "";
        raw.style.display = opened ? "block" : "none";
        if (opened) { $("globalMemInput").value = joinMemoryItems(memItems); }
        this.textContent = opened ? "收起整体编辑" : "整体编辑文本";
      });
    }
    $("switchYoosung").addEventListener("click", toggleSwitch);

    /* 输入框：键盘导航 + 自动增高 + mention 联动 */
    $("msgInput").addEventListener("input", function () {
      autoGrowInput();
      updateMention();
      saveDraftDebounced();
    });
    $("msgInput").addEventListener("keyup", function (e) {
      if (["ArrowUp", "ArrowDown", "Enter", "Escape", "Tab"].indexOf(e.key) === -1) { updateMention(); }
    });
    $("msgInput").addEventListener("click", updateMention);
    $("msgInput").addEventListener("keydown", function (e) {
      if (mentionState.open && mentionState.items.length) {
        if (e.key === "ArrowDown") { e.preventDefault(); moveMention(1); return; }
        if (e.key === "ArrowUp") { e.preventDefault(); moveMention(-1); return; }
        if (e.key === "Enter" || e.key === "Tab") {
          e.preventDefault();
          chooseMention(mentionState.items[Math.max(0, mentionState.active)]);
          return;
        }
        if (e.key === "Escape") { e.preventDefault(); hideMentionPanel(); return; }
      }
      if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
    });

    /* 头像 / 表情上传 */
    $("newAvatarIn").addEventListener("change", async function (e) {
      var f = e.target.files[0];
      if (!f) { return; }
      newAvatarB64 = await compressImage(f, 256, 0.85);
      toast("头像已就绪，点击添加角色后保存");
    });
    $("newEmojiIn").addEventListener("change", async function (e) {
      var f = e.target.files[0];
      if (!f) { return; }
      newEmojiB64 = await compressImage(f, 256, 0.85);
      toast("表情图已就绪，点击添加表情后保存");
    });

    /* 背景弹窗 */
    $("btnBgClose").addEventListener("click", closeBgModal);
    $("btnBgApplyRoom").addEventListener("click", function () { saveBg("room"); });
    $("btnBgApplyAll").addEventListener("click", function () { saveBg("all"); });
    $("btnBgReset").addEventListener("click", function () { resetBg("room"); });
    $("bgMask").addEventListener("click", function (e) { if (e.target === $("bgMask")) { closeBgModal(); } });
    $("bgFileIn").addEventListener("change", async function (e) {
      var f = e.target.files && e.target.files[0];
      if (!f) { return; }
      toast("正在压缩背景图…");
      var dataUrl = await compressImage(f, 1400, 0.78);
      if (!dataUrl) { return toast("背景图读取失败", true); }
      pendingBg = "image:" + dataUrl;
      setChatBg(pendingBg);
      renderBgPanel();
      toast("背景已预览，记得点「仅应用到本房间」保存");
      e.target.value = "";
    });

    /* 拟真设置：开关组 + 保存 / 重置 */
    var realSwitches = {
      switchMulti: "allowMultiRound", switchTimeAw: "timeAwareness",
      switchTyping: "typingEnabled", switchRead: "readReceipt",
      switchDivider: "timeDivider", switchMerge: "mergeAvatar",
      switchInterrupt: "typingInterrupt"
    };
    Object.keys(realSwitches).forEach(function (id) {
      var node = $(id);
      if (!node) { return; }
      node.addEventListener("click", function () {
        REAL[realSwitches[id]] = !REAL[realSwitches[id]];
        saveRealCfg();
      });
    });
    if ($("btnRealSave")) { $("btnRealSave").addEventListener("click", applyRealForm); }
    if ($("btnRealReset")) { $("btnRealReset").addEventListener("click", resetRealCfg); }

    /* 表情回应选择器：点击外部收起 */
    document.addEventListener("click", function (e) {
      var p = $("reactPicker");
      if (!p || !p.classList.contains("show")) { return; }
      if (p.contains(e.target)) { return; }
      reactPickerFor = null;
      p.classList.remove("show");
      clearNode(p);
    });

    /* 图片灯箱：点空白关闭；左右箭头 / 键盘方向键切换 */
    $("lightbox").addEventListener("click", function (e) {
      if (e.target && e.target.id === "lbPrev") { stepLightbox(-1); return; }
      if (e.target && e.target.id === "lbNext") { stepLightbox(1); return; }
      $("lightbox").classList.remove("show");
      $("lightboxImg").src = "";
    });
    document.addEventListener("keydown", function (e) {
      if (!$("lightbox").classList.contains("show")) { return; }
      if (e.key === "ArrowLeft") { stepLightbox(-1); }
      else if (e.key === "ArrowRight") { stepLightbox(1); }
    });

    /* 分组切换 */
    document.querySelectorAll(".tab").forEach(function (t) {
      t.addEventListener("click", function () { switchToTab(t.dataset.tab); });
    });

    /* 会话列表：点击进入聊天；长按弹出操作菜单 */
    var convWrap = $("convList");
    convWrap.addEventListener("click", function (e) {
      var item = e.target.closest(".conv-item");
      if (!item) { return; }
      var conv = conversations.find(function (c) { return c.conv_id === item.dataset.cid; });
      if (conv) { openChatByRoom(conv.conv_id, conv); }
    });
    var pressTimer = null;
    convWrap.addEventListener("contextmenu", function (e) {
      var item = e.target.closest(".conv-item");
      if (!item) { return; }
      e.preventDefault();
      var conv = conversations.find(function (c) { return c.conv_id === item.dataset.cid; });
      if (conv) { convCtxMenu(conv, e.clientX, e.clientY); }
    });
    convWrap.addEventListener("touchstart", function (e) {
      var item = e.target.closest(".conv-item");
      if (!item) { return; }
      var conv = conversations.find(function (c) { return c.conv_id === item.dataset.cid; });
      if (!conv) { return; }
      pressTimer = setTimeout(function () {
        var t = e.touches[0];
        convCtxMenu(conv, t.clientX, t.clientY);
      }, 500);
    }, { passive: true });
    convWrap.addEventListener("touchend", function () { clearTimeout(pressTimer); });
    convWrap.addEventListener("touchmove", function () { clearTimeout(pressTimer); });

    /* 消息长按（移动端）弹出操作菜单；桌面端 hover 悬浮操作条 */
    var msgPressTimer = null;
    var chatLogEl = $("chatLog");
    chatLogEl.addEventListener("touchstart", function (e) {
      var wrapEl = e.target.closest(".msg-wrap");
      if (!wrapEl || !wrapEl.dataset.mid) { return; }
      var mid = wrapEl.dataset.mid;
      var touch = e.touches[0];
      msgPressTimer = setTimeout(function () {
        var m = null;
        for (var i = 0; i < history.length; i++) {
          if (String(history[i].id) === mid) { m = history[i]; break; }
        }
        if (m) { msgCtxMenu(m, wrapEl, touch.clientX, touch.clientY); }
      }, 500);
    }, { passive: true });
    chatLogEl.addEventListener("touchend", function () { clearTimeout(msgPressTimer); });
    chatLogEl.addEventListener("touchmove", function () { clearTimeout(msgPressTimer); });

    /* 好友页：点分组标题折叠/展开；长按分组管理；长按好友移动分组 */
    var friendWrap = $("friendList");
    friendWrap.addEventListener("click", function (e) {
      var t = e.target.closest(".friend-group-title");
      if (t && t.dataset.gname) {
        collapsedGroups[t.dataset.gname] = !collapsedGroups[t.dataset.gname];
        renderFriends();
      }
    });
    friendWrap.addEventListener("contextmenu", function (e) {
      var t = e.target.closest(".friend-group-title");
      if (t && t.dataset.gname) {
        e.preventDefault();
        groupCtxMenu(t.dataset.gname, e.clientX, e.clientY);
        return;
      }
      var item = e.target.closest(".friend-item");
      if (item && item.dataset.rk) {
        e.preventDefault();
        var f = null;
        for (var i = 0; i < friends.length; i++) {
          if (friends[i].role_key === item.dataset.rk) { f = friends[i]; break; }
        }
        if (f) { friendCtxMenu(f, e.clientX, e.clientY); }
      }
    });

    /* 用户资料 / 搜索 / 快捷回复 设置行 */
    if ($("rowSearchMsg")) { $("rowSearchMsg").addEventListener("click", openSearchDialog); }
    if ($("rowQuick")) { $("rowQuick").addEventListener("click", openQuickDialog); }
    if ($("spNick")) { $("spNick").addEventListener("change", saveUserProfile); }
    if ($("spAvatarIn")) {
      $("spAvatarIn").addEventListener("change", async function (e) {
        var f = e.target.files && e.target.files[0];
        if (!f) { return; }
        var dataUrl = await compressImage(f, 256, 0.85);
        if (!dataUrl) { return; }
        var res = await apiPost(PLUGIN + "/user_profile", { avatar: dataUrl });
        if (res && res.ok) {
          USER_AVATAR = dataUrl;
          renderUserProfileBox();
          toast("头像已更新");
        }
        e.target.value = "";
      });
    }

    /* 动态页发说说 */
    if ($("momentPostBtn")) {
      $("momentPostBtn").addEventListener("click", postUserMoment);
      $("momentPostImgBtn").addEventListener("click", function () { $("momentPostFile").click(); });
      $("momentPostFile").addEventListener("change", async function (e) {
        var f = e.target.files && e.target.files[0];
        if (!f) { return; }
        var dataUrl = await compressImage(f, 800, 0.8);
        if (dataUrl) {
          pendingMomentImage = dataUrl;
          rebuildMomentAttach();
          toast("图片已添加，点发布");
        }
        e.target.value = "";
      });
    }

    /* 点击空白处收起长按菜单 */
    document.addEventListener("click", function (e) {
      if (ctxMenu && !ctxMenu.contains(e.target)) { closeCtxMenu(); }
    });

    /* 角色：先判"删"再判"编辑"，整张卡片是编辑热区 */
    $("roleListWrap").addEventListener("click", function (e) {
      var delBtn = e.target.closest('[data-act="del-role"]');
      if (delBtn) { delRole(Number(delBtn.dataset.idx)); return; }
      var editBtn = e.target.closest('[data-act="edit-role"]');
      if (editBtn) { editRole(Number(editBtn.dataset.idx)); }
    });

    $("emojiListWrap").addEventListener("click", function (e) {
      var delBtn = e.target.closest('[data-act="del-emoji"]');
      if (delBtn) { delEmoji(Number(delBtn.dataset.idx)); return; }
      var editBtn = e.target.closest('[data-act="edit-emoji"]');
      if (editBtn) { editEmoji(Number(editBtn.dataset.idx)); }
    });

    if ($("sumListWrap")) {
      $("sumListWrap").addEventListener("click", function (e) {
        var btn = e.target.closest("[data-act]");
        if (!btn) { return; }
        var idx = Number(btn.dataset.idx);
        if (btn.dataset.act === "edit-sum") { editSummary(idx); }
        else if (btn.dataset.act === "del-sum") { delSummary(idx); }
      });
    }

    if ($("memListWrap")) {
      $("memListWrap").addEventListener("click", function (e) {
        var btn = e.target.closest("[data-act]");
        if (!btn) { return; }
        var idx = Number(btn.dataset.idx);
        if (btn.dataset.act === "edit-mem") { editMemItem(idx); }
        else if (btn.dataset.act === "del-mem") { delMemItem(idx); }
      });
    }

    $("mask").addEventListener("click", function (e) {
      if (e.target === $("mask")) { closeModal(); }
    });

    bindChatScroll();

    /* 全局快捷键：Esc 关所有浮层 */
    document.addEventListener("keydown", function (e) {
      if (e.key !== "Escape") { return; }
      $("emoPanel").classList.remove("show");
      hideMentionPanel();
      var rp = $("reactPicker");
      if (rp && rp.classList.contains("show")) { rp.classList.remove("show"); clearNode(rp); }
      reactPickerFor = null;
      if (quoteDraft) { clearQuote(); }
      if ($("lightbox").classList.contains("show")) { $("lightbox").classList.remove("show"); }
    });
  }

  /* ------------------------------ 启动 ------------------------------ */
  async function init() {
    applyTheme(lsGet("agc_theme", null));
    loadRealCfg();
    initDiag();
    bindEvents();
    rebuildAttachBox();
    var hint = $("bootHint");
    if (hint && hint.parentNode) { hint.parentNode.removeChild(hint); }
    var t0 = Date.now();
    try {
      bridge = await ensureBridge();
      if (bridge && typeof bridge.ready === "function") { await bridge.ready(); }
      DIAG.bridgeMs = Date.now() - t0;
      DIAG.bridge = "ok（" + DIAG.bridgeMs + "ms）";
      diag("bridge", DIAG.bridge);
    } catch (e) {
      DIAG.bridge = e.message;
      diag("bridge", e.message);
      toast(e.message, true);
      return;
    }
    /* 拉取运行时配置：识图开关 + 图片压缩最长边 */
    var cfg = await apiGet(PLUGIN + "/config");
    if (cfg && cfg.ok) {
      VISION_ENABLED = cfg.vision_enabled !== false;
      IMG_MAX_SIDE = clampNum(cfg.max_image_side, 0, 4096, 1024);
      /* 用户没在「拟真」页存过偏好时，采纳插件配置页下发的默认值 */
      if (!lsGet("agc_real", "")) {
        if (typeof cfg.split_symbol === "string") { REAL.splitSymbol = cfg.split_symbol.slice(0, 2); }
        if (typeof cfg.allow_multi_round === "boolean") { REAL.allowMultiRound = cfg.allow_multi_round; }
        if (typeof cfg.time_awareness === "boolean") { REAL.timeAwareness = cfg.time_awareness; }
        REAL.maxReplyMessages = clampNum(cfg.max_reply_messages, 1, 30, 8);
        saveRealCfg();
      }
    }

    /* 用户资料（昵称/头像）与快捷回复短语 */
    var up = await apiGet(PLUGIN + "/user_profile");
    if (up && up.ok) {
      USER_NICK = up.nickname || "我";
      USER_AVATAR = up.avatar || "";
      renderUserProfileBox();
    }
    loadQuickReplies();

    /* 进入消息 Tab，加载会话列表；不自动打开聊天室 */
    await loadConversations();
    loadFriends();
    switchTab("messages");
  }

  window.__aiGroupChat = {
    getState: function () {
      return {
        rooms: rooms, currentRoomId: currentRoomId, roles: roles,
        emojis: emojis, history: history, auto: auto, bg: currentBg,
        real: REAL, quote: quoteDraft, reactions: reactionMap, playing: playing
      };
    },
    reload: loadConversations,
    editRole: editRole,
    editSummary: editSummary,
    openDialog: openDialog,
    uiPrompt: uiPrompt,
    uiConfirm: uiConfirm,
    startAuto: startAutoTalk,
    stopAuto: function () { stopAutoTalk(true); },
    autoOnce: function () { return runAutoRound(false); },
    setBg: setChatBg,
    /* v1.9.0 拟真能力入口（同时供自动化测试断言） */
    REAL: REAL,
    applyReal: applyRealForm,
    resetReal: resetRealCfg,
    splitSegments: splitSegments,
    buildOpts: buildOpts,
    estimateTypers: estimateTypers,
    showTyping: showTyping,
    hideTyping: hideTyping,
    playReplies: playReplies,
    getTypingText: function () {
      var row = $("typingRow");
      if (!row || !row.classList.contains("show")) { return ""; }
      var t = row.querySelector(".typing-text");
      return t ? t.textContent : "";
    },
    setQuote: setQuote,
    clearQuote: clearQuote,
    getQuote: function () { return quoteDraft; },
    reactTo: reactTo,
    recallMessage: function (msg) { return recallMessage(msg, null); },
    loadReactions: loadReactions,
    getReactions: function () { return reactionMap; },
    markUserRead: markUserRead,
    /* v2.1 能力入口（供自动化测试断言） */
    forwardMessage: forwardMessage,
    postUserMoment: postUserMoment,
    openSearchDialog: openSearchDialog,
    highlightMsg: highlightMsg,
    loadOlderMessages: loadOlderMessages,
    stepLightbox: stepLightbox,
    parseUtc: parseUtc,
    userProfile: function () { return { nickname: USER_NICK, avatar: USER_AVATAR }; },
    getRenderFrom: function () { return renderFrom; }
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
