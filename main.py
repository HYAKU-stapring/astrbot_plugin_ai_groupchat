"""AI 趣味群聊（ai_groupchat）—— AstrBot v4.28.x 插件，v1.8.0。

本版本新增能力
--------------
1. 发图 + 识图：/api/send 接收 image（dataURL），交给视觉模型；模型不支持
   视觉输入时自动降级为纯文本并在响应里回 vision=false，前端据此提示。
2. @提及：/api/send 接收 mentions，命中的角色在系统提示词里被强制要求接话。
3. 自主对话：/api/auto_talk 接收 count（本轮最多发言角色数），前端按
   "间隔 + 随机偏移" 的递归定时器循环调用。
4. 自定义聊天背景：新增 /api/set_bg，支持"仅本房间"与"所有房间"两种作用域，
   值存在 plugin_cfg 表（bg_<room_id> / bg_global），不新增表、不动旧数据。
5. messages 表新增 image 列，_init_db 里用 PRAGMA table_info 做幂等迁移，
   老库升级不会丢历史聊天记录。

沿用的既有约束
--------------
1. 插件类继承 astrbot.api.star.Star；HTTP 接口用 self.context.register_web_api。
2. 调用大模型统一走 self.context.llm_generate(...)，读 LLMResponse.completion_text。
3. 数据库放在 AstrBot 的 data 目录，升级 / 重装插件不会清空聊天记录。
""""""AI 趣味群聊（ai_groupchat）—— AstrBot v4.28.x 插件，v1.9.0。
本版本在 v1.8.0 基础上补齐"更像真人群聊"的四类能力：
1. 连锁接话（反复回复）：replies 允许同一角色出现多次、角色之间互相追问反驳，
   形成 "A：巴拉巴拉 -> B：（怼A）巴拉巴拉 -> A：什么！巴拉巴拉" 的自然互动；
   每条 reply 新增 reply_to 字段标明在回应谁，前端渲染成"回复 xxx"引用条。
2. 分段刷屏：content 里用分隔符（默认 \）把一段话切成多条消息，服务端拆成
   多条记录入库，前端逐条带间隔弹出，一个人也能刷屏；两个连续符号视为字面转义。
3. 输入中提示：随响应返回 new_msgs（含自增 id），前端在等待期显示"N 人输入中"，
   人数不超过 typing_show_names（默认 3）时直接显示人名，之后按角色逐条播放
   "某某输入中…"，打字时长按字数拟真。
4. 拟真增强：时段语感（把当前时间注入提示词）、消息引用 quote、表情回应
   reactions、消息撤回 recalled、时间分隔条与已读回执（后三者由前端呈现）。

存储变更（全部为幂等迁移，老库升级不丢数据）：
  - messages 新增 reply_to / quote / recalled 三列；
  - 新增 reactions 表（room_id, msg_id, emoji）。
沿用的既有约束：继承 Star、register_web_api 注册接口、llm_generate 调模型、
数据落在 AstrBot data 目录、前端全部请求走 /api/ui/proxy 统一代理。
"""

from __future__ import annotations

import json
import os
import random
import re
import sqlite3
import time
from contextlib import closing
from typing import Any, Dict, List, Optional, Tuple

from astrbot.api import logger
from astrbot.api.star import Context, Star
from astrbot.api.web import request

PLUGIN_NAME = "ai_groupchat"
MAX_MEMORY_CHARS = 6000
TRIM_MEMORY_CHARS = 5500
HISTORY_WINDOW = 15
MEMORY_KEEP_ROWS = 30
MAX_IMAGE_CHARS = 4_000_000  # 约 3MB 二进制，超出直接拒收，避免撑爆事件循环

# ---- v1.9.0 拟真聊天相关默认值 ----
DEFAULT_SPLIT_SYMBOL = chr(92)      # 分段刷屏符号，默认反斜杠
MAX_REPLY_MESSAGES_DEFAULT = 8      # 一轮最多生成多少条气泡（含分段与连锁）
MAX_QUOTE_CHARS = 200               # 引用原文入库上限
WEEKDAYS = ("周一", "周二", "周三", "周四", "周五", "周六", "周日")

# ---- v2.0.0 QQ 化社交相关常量 ----
DM_PREFIX = "dm@@"                  # 私聊房间 id 前缀：dm@@<group_room>@@<role>
ROOM_CONV_PREFIX = "room@@"         # 群聊会话 id 前缀
MOOD_CHANCE_DEFAULT = 12            # 每轮发言后采纳签名/心情变化的概率（%）
MOMENT_CHANCE_DEFAULT = 6           # 每轮发言后角色发动态的概率（%）
MOMENT_AMBIENT_CHANCE = 0.12        # 打开动态页时随机角色点赞旧动态的概率
MOMENT_COMMENT_CHANCE_DEFAULT = 40  # 模型生成动态时顺带采纳其他角色评论的概率（%）
FORWARD_CHANCE_DEFAULT = 8          # 角色转发"和别人的私聊截图"的概率（%）
DEFAULT_TZ_OFFSET = 8               # 默认时区偏移（小时）：8 = 东八区
TZ_OFFSET = DEFAULT_TZ_OFFSET       # 运行时时区偏移，启动时按插件配置改写
MAX_MOMENT_CHARS = 500
MAX_SIGNATURE_CHARS = 40
MAX_MOOD_CHARS = 16
POKE_FALLBACKS = (
    "干嘛打扰我睡觉…",
    "哎呀，别戳了别戳了！",
    "在呢在呢，找我什么事？",
    "唔？我脸上有东西吗？",
    "再戳就要收费了啊！",
    "（被你戳得一个激灵）吓我一跳！",
    "戳我干嘛，有事快说～",
    "哼，不理你了。（其实偷偷开心）",
)


def _data_dir() -> str:
    """持久化目录：优先 AstrBot 的 data 目录，退化到插件目录。"""
    try:
        from astrbot.core.utils.astrbot_path import get_astrbot_data_path

        root = get_astrbot_data_path()
    except Exception:
        root = os.path.join(os.path.dirname(os.path.abspath(__file__)), "runtime_data")
    path = os.path.join(root, PLUGIN_NAME)
    os.makedirs(path, exist_ok=True)
    return path


def _extract_json(text: str) -> Dict[str, Any]:
    """从模型输出里稳健地抠出 JSON（兼容 markdown 代码围栏与前后解释文字）。"""
    if not text:
        return {}
    cleaned = text.strip()
    fence = re.search("`" * 3 + r"(?:json)?\s*(.+?)" + "`" * 3, cleaned, re.S | re.I)
    if fence:
        cleaned = fence.group(1).strip()
    start, end = cleaned.find("{"), cleaned.rfind("}")
    if start == -1 or end == -1 or end <= start:
        raise ValueError("模型输出中不包含 JSON 对象")
    return json.loads(cleaned[start : end + 1])


def _split_segments(text: str, symbol: str = DEFAULT_SPLIT_SYMBOL) -> List[str]:
    """把一段台词按分隔符切成多条消息，模拟真人连发刷屏。

    规则：
    - symbol 为空、或 text 中不含 symbol：原样返回单条（全空白则返回空列表）；
    - 连续两个 symbol 视为转义，输出一个字面 symbol，不做切分；
    - 逐条 strip 后丢弃空段。
    """
    text = str(text or "")
    sym = str(symbol or "")
    if not sym or sym not in text:
        return [text.strip()] if text.strip() else []
    placeholder = "\u0000AGC_ESC\u0000"
    tmp = text.replace(sym + sym, placeholder)
    out = []
    for piece in tmp.split(sym):
        piece = piece.replace(placeholder, sym).strip()
        if piece:
            out.append(piece)
    return out


def _expand_emoji_rows(rows: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """表情包拆分：一条消息同时带 emoji_name 和文字时，强制拆成两条独立记录。

    第一条只含表情（is_big_emoji=1，前端渲染大尺寸独立气泡），第二条只含文字；
    纯表情消息同样标记 is_big_emoji=1。连续多个表情天然被拆成独立大表情气泡，
    对齐微信/QQ 的表情包体验。
    """
    out: List[Dict[str, Any]] = []
    for r in rows:
        emo = str(r.get("emoji_name", "") or "")
        content = str(r.get("content", "") or "")
        if emo and content.strip():
            r1 = dict(r); r1["content"] = ""; r1["is_big_emoji"] = 1
            r2 = dict(r); r2["emoji_name"] = ""; r2["is_big_emoji"] = 0
            out.append(r1); out.append(r2)
        elif emo:
            r1 = dict(r); r1["is_big_emoji"] = 1
            out.append(r1)
        else:
            r1 = dict(r); r1["is_big_emoji"] = 0
            out.append(r1)
    return out


def _local_now() -> time.struct_time:
    """按插件配置 timezone_offset 校正的"当前时间"。

    根因：SQLite CURRENT_TIMESTAMP 存 UTC，time.localtime() 读服务器时区；
    服务器时区与用户所在地不一致时（如 UTC vs 东八区）会出现"显示4点实际12点半"。
    约定：数据库一律存 UTC，提示词语义时间走本函数（UTC + 偏移），
    展示层由前端统一按浏览器本地时区格式化，双端对齐。
    """
    return time.gmtime(time.time() + TZ_OFFSET * 3600)


def _now_desc() -> str:
    """当前时间描述，用于把"现在是几点"注入提示词，让角色状态符合时段。"""
    now = _local_now()
    h = now.tm_hour
    if 5 <= h < 8:
        slot = "清晨"
    elif 8 <= h < 11:
        slot = "上午"
    elif 11 <= h < 13:
        slot = "中午"
    elif 13 <= h < 18:
        slot = "下午"
    elif 18 <= h < 23:
        slot = "晚上"
    else:
        slot = "深夜"
    return "{0}-{1:02d}-{2:02d} {3}:{4:02d} {5}（{6}）".format(
        now.tm_year, now.tm_mon, now.tm_mday, h, now.tm_min,
        WEEKDAYS[now.tm_wday], slot,
    )


def _role_status(now: Optional[time.struct_time] = None) -> Dict[str, str]:
    """24 小时作息：深夜（1:00-6:30）显示"睡觉中"，饭点显示"干饭中"等。

    返回 {"state": "sleep|dining|study|work|online", "text": "睡觉中", "busy": 0.8}
    busy 用于前端计算拟真回复延迟。
    """
    now = now or _local_now()
    h = now.tm_hour + now.tm_min / 60.0
    if 1.0 <= h < 6.5:
        return {"state": "sleep", "text": "睡觉中", "busy": 0.9}
    if 7.0 <= h < 8.0 or 11.5 <= h < 12.5 or 18.0 <= h < 19.0:
        return {"state": "dining", "text": "干饭中", "busy": 0.5}
    if 9.0 <= h < 12.0 or 14.0 <= h < 17.5:
        if 5 <= now.tm_wday <= 6:
            return {"state": "online", "text": "在线", "busy": 0.15}
        return {"state": "work", "text": "摸鱼中", "busy": 0.35}
    if 19.0 <= h < 23.0:
        return {"state": "online", "text": "在线", "busy": 0.1}
    return {"state": "online", "text": "在线", "busy": 0.25}

class AIGroupChat(Star):
    """QQ 移动端风格多人 AI 群聊面板。"""

    def __init__(self, context: Context, config: dict | None = None) -> None:
        super().__init__(context, config)
        self.config: Dict[str, Any] = dict(config or {})

        global TZ_OFFSET
        TZ_OFFSET = self._cfg_int("timezone_offset", DEFAULT_TZ_OFFSET)

        self.db_path = os.path.join(_data_dir(), "chatroom.db")
        self.global_memory = ""
        self.allow_yoosung_private = False
        self._init_db()

        apis = [
            ("/rooms", self.api_room_list, ["GET"], "获取聊天室列表"),
            ("/new_room", self.api_new_room, ["POST"], "新建聊天室"),
            ("/rename_room", self.api_rename_room, ["POST"], "重命名聊天室"),
            ("/del_room", self.api_del_room, ["POST"], "删除聊天室"),
            ("/room", self.api_get_room, ["GET"], "获取单个聊天室数据"),
            ("/send", self.api_send, ["POST"], "发送消息并获取 AI 回复"),
            ("/auto_talk", self.api_auto_talk, ["POST"], "角色主动对话"),
            ("/summary_room", self.api_summary_room, ["POST"], "生成本房间摘要"),
            ("/save_roles", self.api_save_roles, ["POST"], "保存角色列表"),
            ("/update_summary", self.api_update_summary, ["POST"], "编辑单条房间摘要"),
            ("/del_summary", self.api_del_summary, ["POST"], "删除单条房间摘要"),
            ("/save_emojis", self.api_save_emojis, ["POST"], "保存表情库"),
            ("/clear", self.api_clear_history, ["POST"], "清空房间历史"),
            ("/global_memory", self.api_get_global_mem, ["GET"], "读取全局记忆"),
            ("/set_global_memory", self.api_set_global_mem, ["POST"], "写入全局记忆"),
            ("/set_switch", self.api_set_switch, ["POST"], "设置私聊可见开关"),
            ("/set_bg", self.api_set_bg, ["POST"], "设置聊天背景"),
            ("/recall", self.api_recall, ["POST"], "撤回一条消息"),
            ("/react", self.api_react, ["POST"], "给消息加表情回应（再点取消）"),
            ("/reactions", self.api_reactions, ["GET"], "读取本房间表情回应"),
            ("/config", self.api_client_config, ["GET"], "前端运行时配置"),
            # ---- v2.0.0 QQ 化社交端点 ----
            ("/conversations", self.api_conversations, ["GET"], "会话列表（群聊+私聊）"),
            ("/friends", self.api_friends, ["GET"], "好友（全部角色）列表"),
            ("/profile", self.api_profile, ["GET"], "角色资料主页"),
            ("/visit", self.api_visit, ["POST"], "资料页访问量 +1"),
            ("/moments", self.api_moments, ["GET"], "动态信息流"),
            ("/moment_like", self.api_moment_like, ["POST"], "点赞/取消点赞动态"),
            ("/moment_comment", self.api_moment_comment, ["POST"], "评论动态"),
            ("/dm", self.api_dm, ["POST"], "发起与角色的私聊"),
            ("/poke", self.api_poke, ["POST"], "戳一戳角色"),
            ("/conv_state", self.api_conv_state, ["POST"], "会话置顶/免打扰/隐藏/已读水位/特别关心"),
            ("/user_moment", self.api_user_moment, ["POST"], "用户发布动态说说（零模型调用）"),
            ("/user_profile", self.api_user_profile, ["GET", "POST"], "用户昵称/头像读写"),
            ("/friend_groups", self.api_friend_groups, ["GET", "POST"], "好友分组读写"),
            ("/forward_msg", self.api_forward_msg, ["POST"], "转发消息到其它会话"),
            ("/search_msg", self.api_search_msg, ["GET"], "聊天记录关键词搜索"),
            ("/ui/proxy", self.api_ui_proxy, ["POST"], "WebUI 统一代理端点"),
        ]
        for suffix, handler, methods, desc in apis:
            self.context.register_web_api(
                route="/{0}{1}".format(PLUGIN_NAME, suffix),
                view_handler=handler,
                methods=methods,
                desc=desc,
            )
        self.logger.info(
            "ai_groupchat 已注册 %d 个 Web API，数据库: %s", len(apis), self.db_path
        )

    # ------------------------------------------------------------------
    # 配置读取
    # ------------------------------------------------------------------
    def _cfg_bool(self, key: str, default: bool) -> bool:
        raw = self.config.get(key)
        if raw is None:
            return default
        if isinstance(raw, bool):
            return raw
        return str(raw).strip().lower() in ("1", "true", "yes", "on")

    def _cfg_int(self, key: str, default: int) -> int:
        try:
            return int(self.config.get(key))
        except (TypeError, ValueError):
            return default

    @property
    def vision_enabled(self) -> bool:
        return self._cfg_bool("vision_enabled", True)

    def _norm_opts(self, raw: Any) -> Dict[str, Any]:
        """归一化前端下发的拟真参数；缺省项回落到插件配置页的值。

        前端设置面板优先于插件配置文件，用户不用改 _conf_schema 也能即时调整。
        """
        raw = raw if isinstance(raw, dict) else {}

        sym = raw.get("split_symbol")
        if sym is None:
            sym = self.config.get("split_symbol", DEFAULT_SPLIT_SYMBOL)
        sym = str(sym)
        if len(sym) > 2:
            sym = sym[:2]
        sym = sym.replace("\n", "").replace("\r", "")

        multi = raw.get("allow_multi_round")
        if multi is None:
            multi = self._cfg_bool("allow_multi_round", True)
        elif not isinstance(multi, bool):
            multi = str(multi).strip().lower() in ("1", "true", "yes", "on")

        limit = self._cfg_int("max_reply_messages", MAX_REPLY_MESSAGES_DEFAULT)
        try:
            client_limit = int(raw.get("max_reply_messages"))
        except (TypeError, ValueError):
            client_limit = 0
        if 1 <= client_limit <= 30:
            limit = client_limit
        if limit <= 0:
            limit = 30

        tawa = raw.get("time_awareness")
        if tawa is None:
            tawa = self._cfg_bool("time_awareness", True)
        elif not isinstance(tawa, bool):
            tawa = str(tawa).strip().lower() in ("1", "true", "yes", "on")

        return {
            "split_symbol": sym,
            "allow_multi_round": bool(multi),
            "max_reply_messages": limit,
            "time_awareness": bool(tawa),
        }

    # ------------------------------------------------------------------
    # 存储层
    # ------------------------------------------------------------------
    def _get_conn(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.db_path, timeout=15)
        conn.row_factory = sqlite3.Row
        return conn

    def _init_db(self) -> None:
        with closing(self._get_conn()) as conn, conn:
            c = conn.cursor()
            c.execute(
                "CREATE TABLE IF NOT EXISTS rooms ("
                "room_id TEXT PRIMARY KEY,"
                "room_name TEXT NOT NULL,"
                "created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)"
            )
            c.execute(
                "CREATE TABLE IF NOT EXISTS roles ("
                "id INTEGER PRIMARY KEY AUTOINCREMENT,"
                "room_id TEXT, name TEXT, prompt TEXT, avatar TEXT,"
                "FOREIGN KEY(room_id) REFERENCES rooms(room_id) ON DELETE CASCADE)"
            )
            c.execute(
                'CREATE TABLE IF NOT EXISTS emojis ('
                "id INTEGER PRIMARY KEY AUTOINCREMENT,"
                'room_id TEXT, name TEXT, "desc" TEXT, preview TEXT,'
                "FOREIGN KEY(room_id) REFERENCES rooms(room_id) ON DELETE CASCADE)"
            )
            c.execute(
                "CREATE TABLE IF NOT EXISTS messages ("
                "id INTEGER PRIMARY KEY AUTOINCREMENT,"
                "room_id TEXT, who TEXT, content TEXT, emoji_name TEXT,"
                "created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,"
                "FOREIGN KEY(room_id) REFERENCES rooms(room_id) ON DELETE CASCADE)"
            )
            c.execute(
                "CREATE TABLE IF NOT EXISTS global_memory ("
                "id INTEGER PRIMARY KEY AUTOINCREMENT,"
                "memory_text TEXT,"
                "updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)"
            )
            c.execute(
                "CREATE TABLE IF NOT EXISTS room_summary ("
                "id INTEGER PRIMARY KEY AUTOINCREMENT,"
                "room_id TEXT, summary TEXT,"
                "created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,"
                "FOREIGN KEY(room_id) REFERENCES rooms(room_id) ON DELETE CASCADE)"
            )
            c.execute(
                "CREATE TABLE IF NOT EXISTS plugin_cfg (k TEXT PRIMARY KEY, v TEXT)"
            )

            c.execute(
                "CREATE TABLE IF NOT EXISTS reactions ("
                "id INTEGER PRIMARY KEY AUTOINCREMENT,"
                "room_id TEXT, msg_id INTEGER, emoji TEXT,"
                "created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,"
                "FOREIGN KEY(room_id) REFERENCES rooms(room_id) ON DELETE CASCADE)"
            )

            # ---- v2.0.0 QQ 化社交：角色资料 / 动态 / 亲密度 / 会话状态 ----
            c.execute(
                "CREATE TABLE IF NOT EXISTS profiles ("
                "role_key TEXT PRIMARY KEY, signature TEXT DEFAULT '', mood TEXT DEFAULT '',"
                "visits INTEGER DEFAULT 0, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,"
                "updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)"
            )
            c.execute(
                "CREATE TABLE IF NOT EXISTS moments ("
                "id INTEGER PRIMARY KEY AUTOINCREMENT,"
                "role_key TEXT, content TEXT, image TEXT DEFAULT '', visibility TEXT DEFAULT 'public',"
                "created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)"
            )
            c.execute(
                "CREATE TABLE IF NOT EXISTS moment_likes ("
                "id INTEGER PRIMARY KEY AUTOINCREMENT,"
                "moment_id INTEGER, liker TEXT,"
                "UNIQUE(moment_id, liker))"
            )
            c.execute(
                "CREATE TABLE IF NOT EXISTS moment_comments ("
                "id INTEGER PRIMARY KEY AUTOINCREMENT,"
                "moment_id INTEGER, who TEXT, content TEXT,"
                "created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)"
            )
            c.execute(
                "CREATE TABLE IF NOT EXISTS intimacy ("
                "role_key TEXT PRIMARY KEY, points INTEGER DEFAULT 0,"
                "last_active TEXT, streak INTEGER DEFAULT 0)"
            )
            c.execute(
                "CREATE TABLE IF NOT EXISTS conv_state ("
                "conv_id TEXT PRIMARY KEY, pinned INTEGER DEFAULT 0,"
                "muted INTEGER DEFAULT 0, hidden INTEGER DEFAULT 0,"
                "read_id INTEGER DEFAULT 0)"
            )
            c.execute(
                "CREATE TABLE IF NOT EXISTS pending_reply ("
                "id INTEGER PRIMARY KEY AUTOINCREMENT,"
                "room_id TEXT, role_key TEXT, content TEXT, status TEXT DEFAULT 'pending',"
                "created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)"
            )

            # ---- 幂等迁移：老库补列，历史数据一律不动 ----
            cols = [r["name"] for r in c.execute("PRAGMA table_info(messages)").fetchall()]
            migrations = [
                ("image", "ALTER TABLE messages ADD COLUMN image TEXT DEFAULT ''", "识图发图"),
                ("reply_to", "ALTER TABLE messages ADD COLUMN reply_to TEXT DEFAULT ''", "连锁接话"),
                ("quote", "ALTER TABLE messages ADD COLUMN quote TEXT DEFAULT ''", "消息引用"),
                ("recalled", "ALTER TABLE messages ADD COLUMN recalled INTEGER DEFAULT 0", "消息撤回"),
                ("is_big_emoji", "ALTER TABLE messages ADD COLUMN is_big_emoji INTEGER DEFAULT 0", "大表情独立气泡"),
            ]
            for col_name, ddl, why in migrations:
                if col_name not in cols:
                    c.execute(ddl)
                    logger.info("ai_groupchat: messages 表已补 %s 列（%s）", col_name, why)

            role_cols = [r["name"] for r in c.execute("PRAGMA table_info(roles)").fetchall()]
            role_migrations = [
                ("signature", "ALTER TABLE roles ADD COLUMN signature TEXT DEFAULT ''", "个性签名"),
                ("mood", "ALTER TABLE roles ADD COLUMN mood TEXT DEFAULT ''", "当前心情"),
            ]
            for col_name, ddl, why in role_migrations:
                if col_name not in role_cols:
                    c.execute(ddl)
                    logger.info("ai_groupchat: roles 表已补 %s 列（%s）", col_name, why)

            mc_cols = [r["name"] for r in c.execute("PRAGMA table_info(moment_comments)").fetchall()]
            if "reply_to" not in mc_cols:
                c.execute("ALTER TABLE moment_comments ADD COLUMN reply_to INTEGER DEFAULT 0")
                logger.info("ai_groupchat: moment_comments 表已补 reply_to 列（楼中楼）")
            cs_cols = [r["name"] for r in c.execute("PRAGMA table_info(conv_state)").fetchall()]
            if "special_care" not in cs_cols:
                c.execute("ALTER TABLE conv_state ADD COLUMN special_care INTEGER DEFAULT 0")
                logger.info("ai_groupchat: conv_state 表已补 special_care 列（特别关心）")

            c.execute("SELECT memory_text FROM global_memory ORDER BY id DESC LIMIT 1")
            row = c.fetchone()
            if row:
                self.global_memory = row["memory_text"] or ""
            c.execute("SELECT v FROM plugin_cfg WHERE k='allow_yoosung_private'")
            sw = c.fetchone()
            self.allow_yoosung_private = bool(sw and sw["v"] == "1")

    def save_global_memory(self) -> None:
        with closing(self._get_conn()) as conn, conn:
            c = conn.cursor()
            c.execute(
                "INSERT INTO global_memory(memory_text) VALUES (?)",
                (self.global_memory,),
            )
            c.execute(
                "DELETE FROM global_memory WHERE id NOT IN ("
                "SELECT id FROM global_memory ORDER BY id DESC LIMIT ?)",
                (MEMORY_KEEP_ROWS,),
            )

    def save_switch(self, val: bool) -> None:
        with closing(self._get_conn()) as conn, conn:
            conn.cursor().execute(
                "REPLACE INTO plugin_cfg(k,v) VALUES ('allow_yoosung_private', ?)",
                ("1" if val else "0",),
            )
        self.allow_yoosung_private = bool(val)

    # ---- 聊天背景（存 plugin_cfg，不新增表）----
    def get_room_bg(self, room_id: str) -> str:
        with closing(self._get_conn()) as conn:
            c = conn.cursor()
            row = c.execute("SELECT v FROM plugin_cfg WHERE k=?", ("bg_" + room_id,)).fetchone()
            if row and row["v"]:
                return str(row["v"])
            row = c.execute("SELECT v FROM plugin_cfg WHERE k='bg_global'").fetchone()
            return str(row["v"]) if row and row["v"] else ""

    def set_room_bg(self, room_id: str, bg: str, scope: str = "room") -> None:
        with closing(self._get_conn()) as conn, conn:
            c = conn.cursor()
            if scope == "all":
                c.execute("REPLACE INTO plugin_cfg(k,v) VALUES ('bg_global', ?)", (bg,))
                # 房间级设置优先于全局，设为全局默认时清掉本房间的历史设置
                c.execute("DELETE FROM plugin_cfg WHERE k=?", ("bg_" + room_id,))
            else:
                c.execute("REPLACE INTO plugin_cfg(k,v) VALUES (?, ?)", ("bg_" + room_id, bg))

    def _ensure_room(self, room_id: str, room_name: str) -> None:
        with closing(self._get_conn()) as conn, conn:
            conn.cursor().execute(
                "INSERT OR IGNORE INTO rooms(room_id, room_name) VALUES (?, ?)",
                (room_id, room_name),
            )

    def list_all_rooms(self) -> List[Dict[str, Any]]:
        """群聊房间列表；dm@@ 开头的私聊房间不出现在这里（由会话列表接口管理）。"""
        with closing(self._get_conn()) as conn:
            rows = conn.execute(
                "SELECT room_id, room_name FROM rooms "
                "WHERE room_id NOT LIKE ? ORDER BY created_at",
                (DM_PREFIX + "%",),
            ).fetchall()
        return [dict(r) for r in rows]

    def rename_room(self, room_id: str, new_name: str) -> None:
        with closing(self._get_conn()) as conn, conn:
            conn.execute(
                "UPDATE rooms SET room_name = ? WHERE room_id = ?", (new_name, room_id)
            )

    def delete_room(self, room_id: str) -> None:
        with closing(self._get_conn()) as conn, conn:
            c = conn.cursor()
            c.execute("DELETE FROM rooms WHERE room_id = ?", (room_id,))
            c.execute("DELETE FROM roles WHERE room_id = ?", (room_id,))
            c.execute("DELETE FROM emojis WHERE room_id = ?", (room_id,))
            c.execute("DELETE FROM messages WHERE room_id = ?", (room_id,))
            c.execute("DELETE FROM room_summary WHERE room_id = ?", (room_id,))
            c.execute("DELETE FROM reactions WHERE room_id = ?", (room_id,))
            c.execute("DELETE FROM plugin_cfg WHERE k=?", ("bg_" + room_id,))
            # 连带清理该房间角色的资料 / 动态 / 亲密度（role_key = room_id|name）
            prefix = room_id + "|"
            c.execute("DELETE FROM profiles WHERE role_key LIKE ?", (prefix + "%",))
            c.execute("DELETE FROM intimacy WHERE role_key LIKE ?", (prefix + "%",))
            c.execute(
                "DELETE FROM moment_likes WHERE moment_id IN "
                "(SELECT id FROM moments WHERE role_key LIKE ?)", (prefix + "%",)
            )
            c.execute(
                "DELETE FROM moment_comments WHERE moment_id IN "
                "(SELECT id FROM moments WHERE role_key LIKE ?)", (prefix + "%",)
            )
            c.execute("DELETE FROM moments WHERE role_key LIKE ?", (prefix + "%",))

    def load_room(self, room_id: str) -> Dict[str, Any]:
        with closing(self._get_conn()) as conn:
            c = conn.cursor()
            rn = c.execute(
                "SELECT room_name FROM rooms WHERE room_id = ?", (room_id,)
            ).fetchone()
            room_name = rn["room_name"] if rn else room_id
            roles = [
                dict(r)
                for r in c.execute(
                    "SELECT name, prompt, avatar, signature, mood FROM roles WHERE room_id = ?",
                    (room_id,),
                )
            ]
            emojis = [
                {"name": r["name"], "desc": r["desc"], "preview": r["preview"]}
                for r in c.execute(
                    'SELECT name, "desc", preview FROM emojis WHERE room_id = ?',
                    (room_id,),
                )
            ]
            history = [
                self._row_to_msg(r)
                for r in c.execute("SELECT * FROM messages WHERE room_id = ? ORDER BY id ASC", (room_id,))
            ]
            summaries = [
                dict(r)
                for r in c.execute(
                    "SELECT id, summary, created_at FROM room_summary "
                    "WHERE room_id = ? ORDER BY id DESC",
                    (room_id,),
                )
            ]
        return {
            "room_name": room_name,
            "roles": roles,
            "emojis": emojis,
            "history": history,
            "summaries": summaries,
            "bg": self.get_room_bg(room_id),
        }

    def save_roles(self, room_id: str, roles: List[Dict[str, Any]]) -> None:
        """整表重写本房间角色；signature/mood 若前端没带则保留数据库旧值，
        防止改名/编辑人设时把 AI 自主更新的签名与心情冲掉。"""
        with closing(self._get_conn()) as conn, conn:
            c = conn.cursor()
            old = {
                r["name"]: r
                for r in c.execute(
                    "SELECT name, signature, mood FROM roles WHERE room_id = ?",
                    (room_id,),
                )
            }
            c.execute("DELETE FROM roles WHERE room_id = ?", (room_id,))
            for r in roles or []:
                if not isinstance(r, dict) or not r.get("name"):
                    continue
                name = str(r.get("name"))
                prev = old.get(name)
                sig = r.get("signature")
                if sig is None:
                    sig = prev["signature"] if prev else ""
                mood = r.get("mood")
                if mood is None:
                    mood = prev["mood"] if prev else ""
                c.execute(
                    "INSERT INTO roles(room_id, name, prompt, avatar, signature, mood) "
                    "VALUES (?,?,?,?,?,?)",
                    (
                        room_id,
                        name,
                        str(r.get("prompt", "")),
                        str(r.get("avatar", "")),
                        str(sig or "")[:MAX_SIGNATURE_CHARS],
                        str(mood or "")[:MAX_MOOD_CHARS],
                    ),
                )

    def save_emojis(self, room_id: str, emojis: List[Dict[str, Any]]) -> None:
        with closing(self._get_conn()) as conn, conn:
            c = conn.cursor()
            c.execute("DELETE FROM emojis WHERE room_id = ?", (room_id,))
            for e in emojis or []:
                if not isinstance(e, dict) or not e.get("name"):
                    continue
                c.execute(
                    'INSERT INTO emojis(room_id, name, "desc", preview) VALUES (?,?,?,?)',
                    (
                        room_id,
                        str(e.get("name")),
                        str(e.get("desc", "")),
                        str(e.get("preview", "")),
                    ),
                )

    @staticmethod
    def _row_to_msg(row: sqlite3.Row) -> Dict[str, Any]:
        """统一把 messages 行转成前端结构（老库缺列时给默认值，绝不抛异常）。"""
        keys = row.keys()
        return {
            "id": row["id"],
            "who": row["who"],
            "content": row["content"] or "",
            "emoji_name": row["emoji_name"] or "",
            "image": (row["image"] if "image" in keys else "") or "",
            "reply_to": (row["reply_to"] if "reply_to" in keys else "") or "",
            "quote": (row["quote"] if "quote" in keys else "") or "",
            "recalled": int((row["recalled"] if "recalled" in keys else 0) or 0),
            "is_big_emoji": int((row["is_big_emoji"] if "is_big_emoji" in keys else 0) or 0),
            "created_at": row["created_at"],
        }

    def append_msg(
        self,
        room_id: str,
        who: str,
        content: str,
        emoji_name: str = "",
        image: str = "",
        reply_to: str = "",
        quote: str = "",
    ) -> Dict[str, Any]:
        """写一条消息并回读完整记录（含 id / created_at），供前端直接渲染。"""
        with closing(self._get_conn()) as conn, conn:
            c = conn.cursor()
            c.execute(
                "INSERT INTO messages(room_id, who, content, emoji_name, image, reply_to, quote) "
                "VALUES (?,?,?,?,?,?,?)",
                (room_id, who, content, emoji_name, image or "", reply_to or "", quote or ""),
            )
            row = c.execute("SELECT * FROM messages WHERE id = ?", (c.lastrowid,)).fetchone()
        return self._row_to_msg(row)

    def append_msgs(self, room_id: str, rows: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        """批量入库（单事务），回读本次新增的完整记录。

        分段刷屏会把一条 reply 展开成多条，逐条插入会产生 N 次事务；
        这里一次提交，并用 id 水位线把新增行捞回来。
        """
        if not rows:
            return []
        rows = _expand_emoji_rows(rows)
        with closing(self._get_conn()) as conn, conn:
            c = conn.cursor()
            before = c.execute(
                "SELECT COALESCE(MAX(id), 0) AS m FROM messages WHERE room_id = ?",
                (room_id,),
            ).fetchone()["m"]
            for r in rows:
                c.execute(
                    "INSERT INTO messages(room_id, who, content, emoji_name, image, reply_to, quote, is_big_emoji) "
                    "VALUES (?,?,?,?,?,?,?,?)",
                    (
                        room_id,
                        str(r.get("role_name") or r.get("who") or ""),
                        str(r.get("content", "")),
                        str(r.get("emoji_name", "") or ""),
                        str(r.get("image", "") or ""),
                        str(r.get("reply_to", "") or ""),
                        str(r.get("quote", "") or ""),
                        1 if r.get("is_big_emoji") else 0,
                    ),
                )
            return [
                self._row_to_msg(r)
                for r in c.execute(
                    "SELECT * FROM messages WHERE room_id = ? AND id > ? ORDER BY id ASC",
                    (room_id, before),
                )
            ]

    def recall_msg(self, room_id: str, msg_id: int) -> bool:
        """撤回：只打标记不删行，历史条数与记忆统计都不受影响。"""
        with closing(self._get_conn()) as conn, conn:
            c = conn.cursor()
            c.execute(
                "UPDATE messages SET recalled = 1 WHERE room_id = ? AND id = ?",
                (room_id, msg_id),
            )
            return c.rowcount > 0

    def list_reactions(self, room_id: str) -> Dict[str, List[str]]:
        """返回 {消息id: [表情, ...]}，前端按 msg_id 挂到气泡下方。"""
        out: Dict[str, List[str]] = {}
        with closing(self._get_conn()) as conn:
            for r in conn.execute(
                "SELECT msg_id, emoji FROM reactions WHERE room_id = ? ORDER BY id",
                (room_id,),
            ):
                out.setdefault(str(r["msg_id"]), []).append(str(r["emoji"]))
        return out

    def toggle_reaction(self, room_id: str, msg_id: int, emoji: str) -> Optional[Dict[str, Any]]:
        """同一消息同一表情：首次点击添加，再次点击取消。消息不存在返回 None。"""
        with closing(self._get_conn()) as conn, conn:
            c = conn.cursor()
            if not c.execute(
                "SELECT id FROM messages WHERE room_id = ? AND id = ?", (room_id, msg_id)
            ).fetchone():
                return None
            exist = c.execute(
                "SELECT id FROM reactions WHERE room_id = ? AND msg_id = ? AND emoji = ?",
                (room_id, msg_id, emoji),
            ).fetchone()
            if exist:
                c.execute("DELETE FROM reactions WHERE id = ?", (exist["id"],))
                action = "removed"
            else:
                c.execute(
                    "INSERT INTO reactions(room_id, msg_id, emoji) VALUES (?,?,?)",
                    (room_id, msg_id, emoji),
                )
                action = "added"
        return {
            "action": action,
            "msg_id": msg_id,
            "emoji": emoji,
            "reactions": self.list_reactions(room_id),
        }

    def add_summary(self, room_id: str, summary: str) -> None:
        with closing(self._get_conn()) as conn, conn:
            conn.execute(
                "INSERT INTO room_summary(room_id, summary) VALUES (?,?)",
                (room_id, summary),
            )

    def update_summary(self, summary_id: int, text: str) -> bool:
        with closing(self._get_conn()) as conn, conn:
            c = conn.cursor()
            c.execute("UPDATE room_summary SET summary = ? WHERE id = ?", (text, summary_id))
            return c.rowcount > 0

    def delete_summary(self, summary_id: int) -> bool:
        with closing(self._get_conn()) as conn, conn:
            c = conn.cursor()
            c.execute("DELETE FROM room_summary WHERE id = ?", (summary_id,))
            return c.rowcount > 0

    def clear_history(self, room_id: str) -> None:
        with closing(self._get_conn()) as conn, conn:
            conn.execute("DELETE FROM messages WHERE room_id = ?", (room_id,))
            conn.execute("DELETE FROM reactions WHERE room_id = ?", (room_id,))

    # ------------------------------------------------------------------
    # v2.0.0 QQ 化社交存储层
    # ------------------------------------------------------------------
    @staticmethod
    def _role_key(group_room: str, role_name: str) -> str:
        """角色全局唯一键：同一个角色在不同房间是同一身份（私聊/资料共享）。"""
        return group_room + "|" + str(role_name)

    def list_all_roles(self) -> List[Dict[str, Any]]:
        """跨全部群聊房间收集角色（好友列表数据源），同名角色按 group_room 区分。"""
        out: List[Dict[str, Any]] = []
        seen = set()
        with closing(self._get_conn()) as conn:
            rows = conn.execute(
                "SELECT r.room_id, r.name, r.prompt, r.avatar, r.signature, r.mood, "
                "rm.room_name FROM roles r LEFT JOIN rooms rm ON rm.room_id = r.room_id "
                "WHERE r.room_id NOT LIKE ? ORDER BY r.id",
                (DM_PREFIX + "%",),
            ).fetchall()
            for r in rows:
                key = self._role_key(r["room_id"], r["name"])
                if key in seen:
                    continue
                seen.add(key)
                out.append(
                    {
                        "role_key": key,
                        "group_room": r["room_id"],
                        "room_name": r["room_name"] or r["room_id"],
                        "name": r["name"],
                        "prompt": r["prompt"] or "",
                        "avatar": r["avatar"] or "",
                        "signature": r["signature"] or "",
                        "mood": r["mood"] or "",
                    }
                )
        return out

    def find_role(self, role_key: str) -> Optional[Dict[str, Any]]:
        for r in self.list_all_roles():
            if r["role_key"] == role_key:
                return r
        return None

    def _canonical_key(self, room_id: str, who: str) -> str:
        """DM 房间里的角色归一到原群角色 key，保证亲密度/心情/资料跨私聊与群聊一致。"""
        dm = self._dm_parts(room_id)
        if dm:
            return self._role_key(dm["group_room"], who)
        return self._role_key(room_id, who)

    def ensure_profile(self, role_key: str) -> None:
        with closing(self._get_conn()) as conn, conn:
            conn.execute(
                "INSERT OR IGNORE INTO profiles(role_key) VALUES (?)", (role_key,)
            )

    def bump_visits(self, role_key: str) -> int:
        """资料页访问量 +1，返回新值。"""
        self.ensure_profile(role_key)
        with closing(self._get_conn()) as conn, conn:
            c = conn.cursor()
            c.execute(
                "UPDATE profiles SET visits = visits + 1 WHERE role_key = ?", (role_key,)
            )
            row = c.execute(
                "SELECT visits FROM profiles WHERE role_key = ?", (role_key,)
            ).fetchone()
        return int(row["visits"]) if row else 1

    def get_profile(self, role_key: str) -> Dict[str, Any]:
        self.ensure_profile(role_key)
        with closing(self._get_conn()) as conn:
            row = conn.execute(
                "SELECT signature, mood, visits FROM profiles WHERE role_key = ?",
                (role_key,),
            ).fetchone()
        if not row:
            return {"signature": "", "mood": "", "visits": 0}
        return {
            "signature": row["signature"] or "",
            "mood": row["mood"] or "",
            "visits": int(row["visits"] or 0),
        }

    def set_profile(self, role_key: str, signature: Optional[str] = None,
                    mood: Optional[str] = None) -> None:
        self.ensure_profile(role_key)
        with closing(self._get_conn()) as conn, conn:
            c = conn.cursor()
            if signature is not None:
                c.execute(
                    "UPDATE profiles SET signature = ?, updated_at = CURRENT_TIMESTAMP "
                    "WHERE role_key = ?",
                    (str(signature)[:MAX_SIGNATURE_CHARS], role_key),
                )
            if mood is not None:
                c.execute(
                    "UPDATE profiles SET mood = ?, updated_at = CURRENT_TIMESTAMP "
                    "WHERE role_key = ?",
                    (str(mood)[:MAX_MOOD_CHARS], role_key),
                )
            # roles 表里的冗余副本同步更新，保证群聊提示词能直接读到
            group_room, _, name = role_key.partition("|")
            if signature is not None:
                c.execute(
                    "UPDATE roles SET signature = ? WHERE room_id = ? AND name = ?",
                    (str(signature)[:MAX_SIGNATURE_CHARS], group_room, name),
                )
            if mood is not None:
                c.execute(
                    "UPDATE roles SET mood = ? WHERE room_id = ? AND name = ?",
                    (str(mood)[:MAX_MOOD_CHARS], group_room, name),
                )

    def add_moment(self, role_key: str, content: str, image: str = "",
                   visibility: str = "public") -> int:
        with closing(self._get_conn()) as conn, conn:
            c = conn.cursor()
            c.execute(
                "INSERT INTO moments(role_key, content, image, visibility) VALUES (?,?,?,?)",
                (role_key, str(content)[:MAX_MOMENT_CHARS], image or "",
                 visibility if visibility in ("public", "self") else "public"),
            )
            return int(c.lastrowid)

    def delete_moment(self, moment_id: int) -> bool:
        with closing(self._get_conn()) as conn, conn:
            c = conn.cursor()
            c.execute("DELETE FROM moments WHERE id = ?", (moment_id,))
            ok = c.rowcount > 0
            c.execute("DELETE FROM moment_likes WHERE moment_id = ?", (moment_id,))
            c.execute("DELETE FROM moment_comments WHERE moment_id = ?", (moment_id,))
            return ok

    def toggle_moment_like(self, moment_id: int, liker: str) -> bool:
        """点赞/取消点赞，返回 True=已点赞，False=已取消。动态不存在返回 False。"""
        with closing(self._get_conn()) as conn, conn:
            c = conn.cursor()
            if not c.execute("SELECT id FROM moments WHERE id = ?", (moment_id,)).fetchone():
                return False
            exist = c.execute(
                "SELECT id FROM moment_likes WHERE moment_id = ? AND liker = ?",
                (moment_id, liker),
            ).fetchone()
            if exist:
                c.execute("DELETE FROM moment_likes WHERE id = ?", (exist["id"],))
                return False
            c.execute(
                "INSERT INTO moment_likes(moment_id, liker) VALUES (?,?)",
                (moment_id, liker),
            )
            return True

    def add_moment_comment(self, moment_id: int, who: str, content: str,
                           reply_to: int = 0) -> bool:
        content = str(content or "").strip()[:MAX_MOMENT_CHARS]
        if not content:
            return False
        try:
            reply_to = int(reply_to or 0)
        except (TypeError, ValueError):
            reply_to = 0
        with closing(self._get_conn()) as conn, conn:
            c = conn.cursor()
            if not c.execute("SELECT id FROM moments WHERE id = ?", (moment_id,)).fetchone():
                return False
            c.execute(
                "INSERT INTO moment_comments(moment_id, who, content, reply_to) VALUES (?,?,?,?)",
                (moment_id, str(who or "user"), content, reply_to),
            )
            return True

    def load_moments(self, role_key: str = "", limit: int = 60) -> List[Dict[str, Any]]:
        """动态信息流；role_key 为空时返回全部（公开）动态。附带点赞与评论。"""
        with closing(self._get_conn()) as conn:
            c = conn.cursor()
            if role_key:
                rows = c.execute(
                    "SELECT * FROM moments WHERE role_key = ? ORDER BY id DESC LIMIT ?",
                    (role_key, limit),
                ).fetchall()
            else:
                rows = c.execute(
                    "SELECT * FROM moments WHERE visibility = 'public' "
                    "ORDER BY id DESC LIMIT ?",
                    (limit,),
                ).fetchall()
            likes = c.execute("SELECT moment_id, liker FROM moment_likes").fetchall()
            comments = c.execute(
                "SELECT id, moment_id, who, content, reply_to, created_at "
                "FROM moment_comments ORDER BY id"
            ).fetchall()
        like_map: Dict[int, List[str]] = {}
        for r in likes:
            like_map.setdefault(int(r["moment_id"]), []).append(str(r["liker"]))
        comment_map: Dict[int, List[Dict[str, Any]]] = {}
        for r in comments:
            comment_map.setdefault(int(r["moment_id"]), []).append(
                {"id": int(r["id"]), "who": r["who"], "content": r["content"],
                 "reply_to": int(r["reply_to"] or 0), "created_at": r["created_at"]}
            )
        roles = {x["role_key"]: x for x in self.list_all_roles()}
        out = []
        for r in rows:
            rk = str(r["role_key"])
            info = roles.get(rk) or {}
            likers = like_map.get(int(r["id"]), [])
            out.append(
                {
                    "id": int(r["id"]),
                    "role_key": rk,
                    "name": info.get("name") or rk.split("|")[-1],
                    "role_name": info.get("name") or rk.split("|")[-1],
                    "avatar": info.get("avatar") or "",
                    "content": r["content"] or "",
                    "image": r["image"] or "",
                    "visibility": r["visibility"] or "public",
                    "created_at": r["created_at"],
                    "likes": likers,
                    "likes_count": len(likers),
                    "liked": "user" in likers,
                    "comments": comment_map.get(int(r["id"]), []),
                }
            )
        return out

    def ambient_moment_interaction(self) -> List[Dict[str, Any]]:
        """社交闭环：打开动态页时，小概率让某个 AI 角色给旧动态点赞或留言。"""
        try:
            if random.random() >= MOMENT_AMBIENT_CHANCE:
                return []
            roles = self.list_all_roles()
            if len(roles) < 2:
                return []
            with closing(self._get_conn()) as conn:
                rows = conn.execute(
                    "SELECT * FROM moments WHERE visibility = 'public' "
                    "ORDER BY id DESC LIMIT 15"
                ).fetchall()
            if not rows:
                return []
            events = []
            m = random.choice(rows)
            actor = random.choice(roles)
            if actor["role_key"] == str(m["role_key"]):
                return []
            mid = int(m["id"])
            if random.random() < 0.6:
                if self.toggle_moment_like(mid, actor["name"]):
                    events.append(
                        {"type": "like", "moment_id": mid, "who": actor["name"]}
                    )
            else:
                line = random.choice(
                    ("哈哈哈确实", "我也这么觉得！", "有意思", "前排", "说得对", "（路过点个赞）")
                )
                if self.add_moment_comment(mid, actor["name"], line):
                    events.append(
                        {"type": "comment", "moment_id": mid, "who": actor["name"],
                         "content": line}
                    )
            return events
        except Exception as exc:  # 彩蛋逻辑绝不影响主流程
            logger.info("ai_groupchat: 动态环境互动失败（忽略）: %s", exc)
            return []

    # ---- 亲密度与互动标识 ----
    INTIMACY_BADGES = (
        (1, "🔥", "畅聊之火"),
        (7, "🌿", "友谊三叶草"),
        (30, "🚢", "友谊的巨轮"),
    )

    def _today_str(self) -> str:
        return time.strftime("%Y-%m-%d", time.localtime())

    def touch_intimacy(self, role_key: str, points: int = 1) -> Dict[str, Any]:
        """互动一次：加亲密度分，维护连续互动天数（streak）。"""
        self.ensure_profile(role_key)
        today = self._today_str()
        with closing(self._get_conn()) as conn, conn:
            c = conn.cursor()
            row = c.execute(
                "SELECT points, last_active, streak FROM intimacy WHERE role_key = ?",
                (role_key,),
            ).fetchone()
            if not row:
                new_points = max(0, int(points))
                streak = 1
            else:
                new_points = max(0, int(row["points"] or 0) + int(points))
                last = str(row["last_active"] or "")
                if last == today:
                    streak = int(row["streak"] or 1)
                else:
                    yest = time.strftime(
                        "%Y-%m-%d", time.localtime(time.time() - 86400)
                    )
                    streak = int(row["streak"] or 0) + 1 if last == yest else 1
            c.execute(
                "INSERT INTO intimacy(role_key, points, last_active, streak) VALUES (?,?,?,?) "
                "ON CONFLICT(role_key) DO UPDATE SET points = ?, last_active = ?, streak = ?",
                (role_key, new_points, today, streak, new_points, today, streak),
            )
        return {"points": new_points, "streak": streak, "badge": self.intimacy_badge(streak)}

    def intimacy_badge(self, streak: int) -> Dict[str, str]:
        badge = {"icon": "", "name": ""}
        for days, icon, name in self.INTIMACY_BADGES:
            if streak >= days:
                badge = {"icon": icon, "name": name, "days": days}
        return badge

    def get_intimacy(self, role_key: str) -> Dict[str, Any]:
        with closing(self._get_conn()) as conn:
            row = conn.execute(
                "SELECT points, last_active, streak FROM intimacy WHERE role_key = ?",
                (role_key,),
            ).fetchone()
        if not row:
            return {"points": 0, "streak": 0, "badge": {"icon": "", "name": ""}}
        streak = int(row["streak"] or 0)
        if str(row["last_active"] or "") != self._today_str():
            # 昨天也没互动，连续记录已断（今天再互动时重新累计）
            yest = time.strftime("%Y-%m-%d", time.localtime(time.time() - 86400))
            if str(row["last_active"] or "") != yest:
                streak = 0
        return {
            "points": int(row["points"] or 0),
            "streak": streak,
            "badge": self.intimacy_badge(streak),
        }

    # ---- 会话状态（置顶 / 免打扰 / 删除 / 已读水位） ----
    def get_conv_state(self, conv_id: str) -> Dict[str, Any]:
        with closing(self._get_conn()) as conn:
            row = conn.execute(
                "SELECT pinned, muted, hidden, read_id, special_care"
                " FROM conv_state WHERE conv_id = ?",
                (conv_id,),
            ).fetchone()
        if not row:
            return {"pinned": 0, "muted": 0, "hidden": 0, "read_id": 0, "special_care": 0}
        keys = row.keys()
        return {
            "pinned": int(row["pinned"] or 0),
            "muted": int(row["muted"] or 0),
            "hidden": int(row["hidden"] or 0),
            "read_id": int(row["read_id"] or 0),
            "special_care": int((row["special_care"] if "special_care" in keys else 0) or 0),
        }

    def set_conv_state(self, conv_id: str, field: str, value: int) -> Dict[str, Any]:
        if field not in ("pinned", "muted", "hidden", "read_id", "special_care"):
            return self.get_conv_state(conv_id)
        if field == "read_id":
            value = int(value)
            if value < 0:
                # -1 = 一次性拉满已读水位到本房间最大消息 id，避免逐次累加误差
                with closing(self._get_conn()) as conn:
                    value = int(conn.execute(
                        "SELECT COALESCE(MAX(id), 0) AS m FROM messages WHERE room_id = ?",
                        (conv_id,),
                    ).fetchone()["m"])
            value = max(0, value)
        else:
            value = 1 if value else 0
        with closing(self._get_conn()) as conn, conn:
            c = conn.cursor()
            c.execute(
                "INSERT INTO conv_state(conv_id) VALUES (?) ON CONFLICT(conv_id) DO NOTHING",
                (conv_id,),
            )
            if field == "read_id":
                if int(value) < 0:
                    # 特殊值 -1：一次性把已读水位拉到本会话最大消息 id，
                    # 进入会话瞬间清零未读，避免逐次累加的误差
                    mx = c.execute(
                        "SELECT COALESCE(MAX(id), 0) AS m FROM messages WHERE room_id = ?",
                        (conv_id,),
                    ).fetchone()["m"]
                    value = int(mx)
                # 已读水位只前进不后退
                c.execute(
                    "UPDATE conv_state SET read_id = MAX(read_id, ?) WHERE conv_id = ?",
                    (value, conv_id),
                )
            else:
                c.execute(
                    "UPDATE conv_state SET " + field + " = ? WHERE conv_id = ?",
                    (value, conv_id),
                )
        return self.get_conv_state(conv_id)

    # ---- 用户资料（昵称/头像，存 plugin_cfg 键值，不新增表） ----
    def get_user_profile(self) -> Dict[str, Any]:
        with closing(self._get_conn()) as conn:
            c = conn.cursor()
            row = c.execute("SELECT v FROM plugin_cfg WHERE k='user_nickname'").fetchone()
            nick = str(row["v"]) if row and row["v"] else "我"
            row = c.execute("SELECT v FROM plugin_cfg WHERE k='user_avatar'").fetchone()
            avatar = str(row["v"]) if row and row["v"] else ""
        return {"nickname": nick, "avatar": avatar}

    def set_user_profile(self, nickname: Optional[str] = None,
                         avatar: Optional[str] = None) -> Dict[str, Any]:
        with closing(self._get_conn()) as conn, conn:
            c = conn.cursor()
            if nickname is not None:
                c.execute("REPLACE INTO plugin_cfg(k,v) VALUES ('user_nickname', ?)",
                          (str(nickname).strip()[:20] or "我",))
            if avatar is not None:
                c.execute("REPLACE INTO plugin_cfg(k,v) VALUES ('user_avatar', ?)", (avatar,))
        return self.get_user_profile()

    # ---- 好友自定义分组（plugin_cfg 存 JSON：分组名 + 角色 key 列表） ----
    def get_friend_groups(self) -> List[Dict[str, Any]]:
        with closing(self._get_conn()) as conn:
            row = conn.execute("SELECT v FROM plugin_cfg WHERE k='friend_groups'").fetchone()
        if not row or not row["v"]:
            return []
        try:
            data = json.loads(row["v"])
            return data if isinstance(data, list) else []
        except Exception:
            return []

    def set_friend_groups(self, groups: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        clean: List[Dict[str, Any]] = []
        for g in groups or []:
            if not isinstance(g, dict) or not str(g.get("name") or "").strip():
                continue
            clean.append({
                "name": str(g.get("name")).strip()[:20],
                "keys": [str(k) for k in (g.get("keys") or []) if str(k).strip()][:200],
            })
        with closing(self._get_conn()) as conn, conn:
            conn.execute("REPLACE INTO plugin_cfg(k,v) VALUES ('friend_groups', ?)",
                         (json.dumps(clean, ensure_ascii=False),))
        return clean

    # ---- 聊天记录搜索（SQLite LIKE 模糊匹配） ----
    def search_msgs(self, keyword: str, room_id: str = "", limit: int = 20) -> List[Dict[str, Any]]:
        kw = str(keyword or "").strip()
        if not kw:
            return []
        like = "%" + kw.replace("\\", "\\\\").replace("%", r"\%").replace("_", r"\_") + "%"
        sql = ("SELECT m.*, r.room_name FROM messages m "
               "LEFT JOIN rooms r ON r.room_id = m.room_id "
               "WHERE m.content LIKE ? ESCAPE '\\'")
        args: List[Any] = [like]
        if room_id:
            sql += " AND m.room_id = ?"
            args.append(room_id)
        sql += " ORDER BY m.id DESC LIMIT ?"
        args.append(max(1, min(int(limit or 20), 100)))
        with closing(self._get_conn()) as conn:
            rows = conn.execute(sql, args).fetchall()
        out = []
        for r in rows:
            content = r["content"] or ""
            pos = content.find(kw)
            start = max(0, pos - 30) if pos >= 0 else 0
            out.append({
                "id": r["id"], "room_id": r["room_id"],
                "room_name": r["room_name"] or r["room_id"],
                "who": r["who"], "snippet": content[start:start + 120],
                "created_at": r["created_at"],
            })
        return out

    # ---- 离线待回复（作息离线消息机制） ----
    def add_pending(self, room_id: str, role_key: str, content: str) -> None:
        with closing(self._get_conn()) as conn, conn:
            conn.execute(
                "INSERT INTO pending_reply(room_id, role_key, content) VALUES (?,?,?)",
                (room_id, role_key, str(content)[:MAX_MOMENT_CHARS],))

    def take_pending(self, room_id: str) -> List[Dict[str, Any]]:
        with closing(self._get_conn()) as conn:
            rows = conn.execute(
                "SELECT * FROM pending_reply WHERE room_id = ? AND status = 'pending' ORDER BY id",
                (room_id,)).fetchall()
        return [dict(r) for r in rows]

    def rehold_pending(self, pending: List[Dict[str, Any]]) -> None:
        """take_pending 不改变状态，放回即空操作（保留接口语义清晰）。"""
        return None

    def mark_pending_done(self, pending: List[Dict[str, Any]]) -> None:
        ids = [int(p["id"]) for p in pending if p.get("id") is not None]
        if not ids:
            return
        with closing(self._get_conn()) as conn, conn:
            conn.executemany(
                "UPDATE pending_reply SET status = 'done' WHERE id = ?", [(i,) for i in ids])

    # ---- 消息转发（复用 quote 字段存"转发自 xxx"引用标记） ----
    def forward_message(self, msg_id: int, to_room_id: str) -> Optional[Dict[str, Any]]:
        with closing(self._get_conn()) as conn:
            row = conn.execute("SELECT * FROM messages WHERE id = ?", (msg_id,)).fetchone()
            if not row:
                return None
            room = conn.execute(
                "SELECT room_name FROM rooms WHERE room_id = ?", (row["room_id"],)).fetchone()
        src = (room["room_name"] if room and room["room_name"] else row["room_id"])
        text = row["content"] or ("[图片]" if row["image"] else "")
        quote = "FWD::转发自 {0}({1})：{2}".format(row["who"], src, text)[:MAX_QUOTE_CHARS + 60]
        return self.append_msg(to_room_id, "user", "", "", row["image"] or "", "", quote)

    # ---- 私聊房间 ----
    @staticmethod
    def _dm_room_id(group_room: str, role_name: str) -> str:
        return DM_PREFIX + group_room + "@@" + str(role_name)

    def ensure_dm_room(self, role_key: str, role_name: str, avatar: str) -> str:
        """确保私聊房间存在，并把该角色作为唯一成员写入（DM 房间角色表独立）。"""
        group_room, _, _ = role_key.partition("|")
        rid = self._dm_room_id(group_room, role_name)
        role = self.find_role(role_key)
        prompt = (role or {}).get("prompt", "")
        with closing(self._get_conn()) as conn, conn:
            c = conn.cursor()
            c.execute(
                "INSERT OR IGNORE INTO rooms(room_id, room_name) VALUES (?, ?)",
                (rid, role_name),
            )
            exist = c.execute(
                "SELECT id FROM roles WHERE room_id = ? AND name = ?", (rid, role_name)
            ).fetchone()
            if not exist:
                c.execute(
                    "INSERT INTO roles(room_id, name, prompt, avatar) VALUES (?,?,?,?)",
                    (rid, role_name, prompt, avatar),
                )
        return rid

    # ---- 会话 / 好友 / 资料页聚合 ----
    def _dm_parts(self, room_id: str) -> Optional[Dict[str, str]]:
        if not str(room_id).startswith(DM_PREFIX):
            return None
        parts = str(room_id)[len(DM_PREFIX):].split("@@")
        if len(parts) == 2:
            return {"group_room": parts[0], "role_name": parts[1]}
        return None

    def _last_msg(self, room_id: str) -> Optional[Dict[str, Any]]:
        with closing(self._get_conn()) as conn:
            row = conn.execute(
                "SELECT who, content, image, recalled, created_at FROM messages "
                "WHERE room_id = ? ORDER BY id DESC LIMIT 1", (room_id,)
            ).fetchone()
        if not row:
            return None
        if int(row["recalled"] or 0):
            return {"who": row["who"], "content": "撤回了一条消息", "created_at": row["created_at"]}
        content = row["content"] or ("[图片]" if row["image"] else "")
        return {"who": row["who"], "content": content, "created_at": row["created_at"]}

    def list_conversations(self) -> List[Dict[str, Any]]:
        out: List[Dict[str, Any]] = []
        with closing(self._get_conn()) as conn:
            rows = conn.execute(
                "SELECT room_id, room_name, created_at FROM rooms ORDER BY created_at"
            ).fetchall()
        for r in rows:
            rid = r["room_id"]
            state = self.get_conv_state(rid)
            if state["hidden"]:
                continue
            last = self._last_msg(rid)
            dm = self._dm_parts(rid)
            if dm:
                role = self.find_role(self._role_key(dm["group_room"], dm["role_name"]))
                name = dm["role_name"]
                avatar = (role or {}).get("avatar", "")
                role_key = self._role_key(dm["group_room"], dm["role_name"])
                kind = "dm"
            else:
                name = r["room_name"]
                avatar = ""
                role_key = ""
                kind = "group"
            unread = 0
            raw_unread = 0
            if last:
                with closing(self._get_conn()) as conn:
                    mx = conn.execute(
                        "SELECT COALESCE(MAX(id), 0) AS m FROM messages WHERE room_id = ?",
                        (rid,),
                    ).fetchone()["m"]
                raw_unread = max(0, int(mx) - int(state["read_id"]))
                unread = min(raw_unread, 99)  # 后端兜底截断，前端再截一层
            out.append({
                "conv_id": rid, "kind": kind, "name": name, "avatar": avatar,
                "role_key": role_key, "last_msg": last, "unread": unread,
                "pinned": int(state["pinned"]), "muted": int(state["muted"]),
                "special_care": int(state.get("special_care", 0)),
                "unread_overflow": bool(raw_unread > 99),
                "last_at": last["created_at"] if last else r["created_at"],
                "status": _role_status(),
            })
        # 稳定排序：先按时间倒序，再把置顶顶到最前
        out.sort(key=lambda x: x["last_at"] or "", reverse=True)
        out.sort(key=lambda x: 0 if x["pinned"] else 1)
        return out

    def list_friends(self) -> List[Dict[str, Any]]:
        status = _role_status()
        out: List[Dict[str, Any]] = []
        for r in self.list_all_roles():
            prof = self.get_profile(r["role_key"])
            intim = self.get_intimacy(r["role_key"])
            out.append({
                **r,
                "signature": prof["signature"] or r.get("signature", ""),
                "mood": prof["mood"] or r.get("mood", ""),
                "visits": prof["visits"],
                "intimacy": intim,
                "status": status,
            })
        return out

    def get_profile_view(self, role_key: str) -> Dict[str, Any]:
        role = self.find_role(role_key)
        prof = self.get_profile(role_key)
        intim = self.get_intimacy(role_key)
        moments = self.load_moments(role_key)
        total_likes = sum(int(m.get("likes_count") or 0) for m in moments)
        prof = dict(prof, likes=total_likes)
        return {
            "role": role,
            "profile": prof,
            "intimacy": intim,
            "moments": moments,
            "status": _role_status(),
        }

    # ------------------------------------------------------------------
    # 提示词与模型调用
    # ------------------------------------------------------------------
    def _user_moment_block(self, limit: int = 2) -> str:
        """用户最近 N 条公开动态，注入提示词实现"角色刷到你动态"的效果（零额外调用）。"""
        try:
            rows = self.load_moments("user", limit)
        except Exception:
            return "（暂无）"
        rows = [m for m in rows if m.get("visibility") != "self"][:limit]
        if not rows:
            return "（用户还没有发过动态）"
        return "\n".join(
            "- {0}".format((m.get("content") or "[图片]")[:MAX_MOMENT_CHARS]) for m in rows)

    def _recent_comment_block(self, limit_moments: int = 3) -> str:
        """把近期动态的评论区拼进提示词，供模型在楼中楼里继续回复（复用同一次调用）。"""
        try:
            moments = self.load_moments("", 60)
        except Exception:
            return ""
        picked = [m for m in moments if (m.get("comments") or [])][:limit_moments]
        if not picked:
            picked = moments[:limit_moments]
        if not picked:
            return ""
        lines = ["【近期动态评论区（楼中楼）】"]
        for m in picked:
            owner = "用户" if m["role_key"] == "user" else (m.get("name") or m["role_key"])
            lines.append("- 动态#{0}（{1} 发的）：{2}".format(
                m["id"], owner, (m.get("content") or "")[:60]))
            for cm in (m.get("comments") or [])[-4:]:
                who = "用户" if cm.get("who") == "user" else cm.get("who")
                lines.append("    · 评论#{0} {1}：{2}".format(
                    cm.get("id"), who, (cm.get("content") or "")[:60]))
        lines.append(
            "> 角色对评论区有想说的话时放进 moment_replies（带 moment_id 与可选 "
            "reply_to_comment_id），会作为楼中楼回复发到该动态评论区；"
            "不要刻意在聊天里提及，偶尔自然提一句即可。")
        return "\n".join(lines)

    def build_real_rules(self, opts: Dict[str, Any]) -> str:
        """拼「拟真聊天」规则段：分段刷屏 / 连锁接话 / 条数上限 / 时段语感。"""
        sym = opts.get("split_symbol") or ""
        limit = opts.get("max_reply_messages") or MAX_REPLY_MESSAGES_DEFAULT
        parts = ["\n【拟真聊天规则（决定消息像不像真人，务必遵守）】"]
        if sym:
            parts.append(
                "A. 分段刷屏：一条 content 里可以用符号 " + sym + " 把话切成多条消息，"
                "模拟真人连发。例如：「什么？」" + sym + "「你说真的？」" + sym + "「我不信」。"
                "每条控制在 40 字内，只在情绪起伏或话题转折处切，不要把完整句子切碎；"
                "需要输出字面 " + sym + " 时写成两个（" + sym + sym + "）。"
            )
        if opts.get("allow_multi_round", True):
            parts.append(
                "B. 连锁接话：replies 里同一个角色可以出现多次，角色之间也可以互相追问、"
                "反驳、起哄、补刀，形成「A：巴拉巴拉 -> B：（怼A）巴拉巴拉 -> A：什么！巴拉巴拉」"
                "这样的连续互动，不必一轮每人只说一句。用 reply_to 标明每条在回应谁"
                "（填角色名，回应提问者填 user），没有明确对象时填空字符串。"
            )
        parts.append(
            "C. 一次回复总计不超过 " + str(limit) + " 条气泡（分段与连锁都算在内），"
            "宁少而像人，不要灌水；没有角色想说话时返回空数组也可以。"
        )
        if opts.get("time_awareness", True):
            parts.append(
                "D. 现在是 " + _now_desc() + "，让角色的精神状态、语气和话题与这个时段相符"
                "（深夜会困、会催对方睡觉；饭点会聊吃什么；工作日白天会抱怨上班）。"
            )
        return "\n".join(parts) + "\n"

    def build_sys_prompt(self, roles: List[Dict], emojis: List[Dict],
                         opts: Optional[Dict[str, Any]] = None) -> str:
        opts = opts or self._norm_opts(None)
        emoji_text = "\n".join(
            [
                "- 表情名：{0}，描述：{1}".format(e.get("name"), e.get("desc", ""))
                for e in (emojis or [])
                if isinstance(e, dict) and e.get("name")
            ]
        )
        role_desc = "\n".join(
            [
                "- {0}: {1}".format(r.get("name"), r.get("prompt", ""))
                for r in (roles or [])
                if isinstance(r, dict) and r.get("name")
            ]
        )
        if self.allow_yoosung_private:
            private_rule = (
                "【特殊规则】金流星（Yoosung）可以知晓AstrBot原生小窗私聊内容；"
                "其余角色完全不知道私聊内容。"
            )
        else:
            private_rule = (
                "【隔离规则】所有角色，包括金流星，都完全不知道AstrBot小窗私聊内容，"
                "绝不提及私聊相关事情。"
            )

        role_block = role_desc or "（本房间还没有配置角色，请提示用户先在设置里添加角色）"
        emoji_block = emoji_text or "（暂无表情）"
        memory_block = self.global_memory if self.global_memory else "暂无记忆"

        return (
            "\n你是多人角色扮演群聊控制器。\n"
            "【全局共享记忆（所有聊天室都知道这些事）】\n" + memory_block + "\n\n"
            "【用户近期动态】\n" + self._user_moment_block() + "\n\n"
            "【当前房间角色】\n" + role_block + "\n\n"
            "【可用表情库（仅本房间）】\n" + emoji_block + "\n"
            "> 只能从上面表情选名字，没有合适的就填空。\n\n"
            + private_rule + "\n\n"
            "规则：\n"
            "1. 根据消息、全局记忆、房间历史，判断哪些角色发言，可以0/1/多个。\n"
            "2. 人设贴合，自然对话。\n"
            "3. role_name 必须严格等于【当前房间角色】中的某个名字，不要自创角色。\n"
            "4. 消息里出现 @角色名 时，该角色被用户直接点名，本轮必须发言且排在最前。\n"
            "5. 用户可能随消息发送图片；若本轮附带了图片，必须结合图片内容回应，"
            "不要说\u201c我看不到图片\u201d这类话。\n"
            "6. 输出严格JSON，不要解释、不要markdown代码块。\n"
            "7. 【个人状态与动态（可选，不要每轮都给）】只有当某角色的情绪/想法相比上一轮"
            "明显变化时，才在 profile_updates 里给出该角色新的 signature（个性签名，≤40字）"
            "或 mood（当前心情，≤16字）；偶尔（大约十几轮才有一次）用 moment 字段发一条"
            "个人动态说说（≤50字，像 QQ 空间说说，描述当下心情/日常/吐槽），visibility 填 "
            "\"public\"；发动态的同一次回复里可以顺带给 comments 数组（1~3 条），"
            "模拟房间里其他角色在该动态下评论，每条 {role_name, content}，"
            "role_name 必须是本房间角色。没有变化时这些字段省略即可，禁止为了凑字段硬编。\n"
            "8. 【动态评论区（楼中楼）】提示词里会附【近期动态评论区】。角色对某条评论或某条动态"
            "有想说的话时，放进 moment_replies：[{moment_id, reply_to_comment_id(可选，被回复评论的id), "
            "role_name, content}]，这些内容会直接发到该动态的评论区做楼中楼回复，"
            "不会成为聊天消息；不要在聊天里刻意提及动态或评论，确实应景时偶尔自然提一句即可。\n"
            "9. 【用户动态】当【用户近期动态】有内容时，角色可以像刷到朋友说说一样自然提及"
            "（偶尔、自然，不要每轮都提，更不要编造没发生过的互动）。\n"
            "10. 【转发】偶尔（低概率）某角色可以把\"和别人的私聊截图\"转发到群里：在该条 reply 里"
            "加 forward_from 字段（一句话说明转发来源，如「和小美的私聊」），content 写转发的"
            "原文或摘要；不自然时不要硬塞。\n"
            + self.build_real_rules(opts) +
            "JSON格式：\n"
            "{\n"
            '  "replies": [\n'
            "    {\n"
            '      "role_name": "角色名字",\n'
            '      "content": "台词",\n'
            '      "emoji_name": "表情名称或者空字符串",\n'
            '      "reply_to": "这条在回应谁：角色名或user，没有则空字符串",\n'
            '      "forward_from": "可选：转发来源描述，没有则省略"\n'
            "    }\n"
            "  ],\n"
            '  "profile_updates": [\n'
            '    { "role_name": "角色名字", "signature": "新签名可省略", "mood": "新心情可省略" }\n'
            "  ],\n"
            '  "moment": { "role_name": "角色名字", "content": "说说内容", "visibility": "public",\n'
            '               "comments": [ { "role_name": "评论角色", "content": "评论内容" } ] },\n'
            '  "moment_replies": [\n'
            '    { "moment_id": 0, "reply_to_comment_id": 0, "role_name": "角色名字", "content": "楼中楼回复" }\n'
            "  ]\n"
            "}\n"
        )

    def _resolve_provider_id(self) -> str:
        """优先用插件配置里的 provider id，缺失时回退到当前默认模型。"""
        pid = str(self.config.get("llm_provider") or "").strip()
        if pid:
            return pid
        try:
            prov = self.context.get_using_provider()
            if prov is not None:
                return str(prov.meta().id)
        except Exception as exc:
            self.logger.warning("获取默认模型提供者失败: %s", exc)
        return ""

    async def _one_call(
        self, provider_id: str, system_prompt: str, user_prompt: str,
        kw_name: Optional[str], images: List[str]
    ) -> str:
        kwargs: Dict[str, Any] = {}
        if kw_name:
            kwargs[kw_name] = images
        resp = await self.context.llm_generate(
            chat_provider_id=provider_id,
            prompt=user_prompt,
            system_prompt=system_prompt,
            **kwargs
        )
        return (getattr(resp, "completion_text", "") or "").strip()

    async def call_llm(
        self, system_prompt: str, user_prompt: str, images: Optional[List[str]] = None
    ) -> Tuple[str, bool]:
        """调用大模型，返回 (文本, 是否成功带图)。

        带图时依次尝试 AstrBot 各版本用过的关键字参数名
        （image_urls / images / img_urls）；全部失败则自动降级为纯文本重试，
        此时第二个返回值为 False，前端会提示"模型未能识图"。
        """
        provider_id = self._resolve_provider_id()
        if not provider_id:
            raise RuntimeError(
                "未找到可用的模型提供者：请在 WebUI「插件 - ai_groupchat - 插件配置」中填写 llm_provider。"
            )

        imgs = [str(i) for i in (images or []) if i]
        if not imgs or not self.vision_enabled:
            return await self._one_call(provider_id, system_prompt, user_prompt, None, []), True

        last_exc: Optional[Exception] = None
        for kw_name in ("image_urls", "images", "img_urls"):
            try:
                text = await self._one_call(
                    provider_id, system_prompt, user_prompt, kw_name, imgs
                )
                if text:
                    return text, True
                last_exc = RuntimeError("模型返回空内容")
            except TypeError as exc:
                last_exc = exc
                if "unexpected keyword argument" not in str(exc):
                    self.logger.warning("带图调用参数异常(%s)，尝试下一种签名", exc)
            except Exception as exc:  # 模型不支持视觉 / 图片格式不被接受
                last_exc = exc
                self.logger.warning("带图调用失败(%s)，降级为纯文本", exc)
                break

        self.logger.info("ai_groupchat: 带图调用未成功，降级为纯文本重试")
        text = await self._one_call(provider_id, system_prompt, user_prompt, None, [])
        if not text and last_exc:
            raise last_exc
        return text, False

    def _remember(self, chunk: str) -> None:
        self.global_memory = (self.global_memory + chunk)[-MAX_MEMORY_CHARS:]
        if len(self.global_memory) > TRIM_MEMORY_CHARS:
            self.global_memory = self.global_memory[-TRIM_MEMORY_CHARS:]
        self.save_global_memory()

    async def _generate_replies(
        self,
        room_id: str,
        roles,
        emojis,
        extra_hint: str,
        images: Optional[List[str]] = None,
        mentions: Optional[List[str]] = None,
        max_count: int = 0,
        opts: Optional[Dict[str, Any]] = None,
        quote: str = "",
        pending_texts: Optional[List[str]] = None,
    ) -> Dict[str, Any]:
        """跑一轮模型生成，返回展开后的气泡列表。

        展开顺序：模型 replies -> 校验角色名 -> 按分隔符拆成多条（刷屏）
        -> 截断到 max_reply_messages -> 被 @ 未发言补位 -> 单事务入库。
        """
        opts = self._norm_opts(opts)
        room_data = self.load_room(room_id)
        history_text = "\n".join(
            [h["who"] + ": " + h["content"] for h in room_data["history"][-HISTORY_WINDOW:]]
        )
        sys_prompt = self.build_sys_prompt(roles, emojis, opts)

        user_prompt = "本房间聊天历史：\n" + history_text + "\n" + extra_hint
        comment_block = self._recent_comment_block()
        if comment_block:
            user_prompt += "\n" + comment_block + "\n"
        if pending_texts:
            joined = "\n".join("- " + str(t) for t in pending_texts if t)
            if joined:
                user_prompt += (
                    "\n【离线期间的待回复消息】用户在你离线/忙碌时发来了以下消息，"
                    "本轮请逐条回应，并自然带上「刚醒才看到消息」「不好意思刚才在忙」这类语境：\n"
                    + joined + "\n")
        if quote:
            user_prompt += "\n（用户引用了下面这条消息，请针对它回应）：" + quote
        if images:
            user_prompt += "\n（用户随本条消息发送了一张图片，请结合图片内容回应）"
        if mentions:
            user_prompt += (
                "\n【被 @ 点名的角色】" + "、".join(mentions) +
                " —— 这些角色本轮必须发言，且排在 replies 最前面。"
            )
        user_prompt += "\n输出JSON"

        raw, vision_ok = await self.call_llm(
            sys_prompt, user_prompt, images=images if self.vision_enabled else None
        )
        parsed: Dict[str, Any] = {}
        try:
            parsed = _extract_json(raw)
            replies = parsed.get("replies", [])
            if not isinstance(replies, list):
                replies = []
        except Exception as exc:
            self.logger.warning("模型输出解析失败: %s | 原文: %s", exc, raw[:300])
            replies = [
                {"role_name": "系统", "content": "解析失败：" + str(exc), "emoji_name": ""}
            ]

        social = self._absorb_social(room_id, roles, parsed)

        valid_names = {
            r.get("name") for r in (roles or []) if isinstance(r, dict) and r.get("name")
        }
        sym = opts["split_symbol"]
        limit = opts["max_reply_messages"]
        cleaned: List[Dict[str, Any]] = []

        for r in replies:
            if not isinstance(r, dict):
                continue
            name = str(r.get("role_name") or "").strip()
            if not name:
                continue
            if valid_names and name not in valid_names and name != "系统":
                self.logger.info("模型返回了未配置的角色 %s，已跳过", name)
                continue
            reply_to = str(r.get("reply_to", "") or "").strip()
            # reply_to 只允许是已配置角色或 user，防止模型编出"回复 外星人"
            if reply_to and reply_to != "user" and valid_names and reply_to not in valid_names:
                reply_to = ""
            emoji_name = str(r.get("emoji_name", "") or "")
            content = str(r.get("content", ""))
            fwd = str(r.get("forward_from", "") or "").strip()
            quote_fwd = ""
            if fwd and random.randint(1, 100) <= self._cfg_int(
                    "forward_chance", FORWARD_CHANCE_DEFAULT):
                quote_fwd = "FWD::转发自 " + fwd[:60]
            segments = _split_segments(content, sym) if sym else (
                [content.strip()] if content.strip() else []
            )
            for idx, seg in enumerate(segments):
                cleaned.append(
                    {
                        "role_name": name,
                        "content": seg,
                        # 表情只挂在这个角色的第一条气泡上，避免刷屏时每行都贴图
                        "emoji_name": emoji_name if idx == 0 else "",
                        "reply_to": reply_to,
                        # 角色随机转发：引用标记只挂第一条气泡
                        "quote": quote_fwd if idx == 0 else "",
                    }
                )
                if limit > 0 and len(cleaned) >= limit:
                    break
            if limit > 0 and len(cleaned) >= limit:
                break

        # 被 @ 的角色若被模型漏掉，补一条占位提醒，保证"点名必回"的体验
        if mentions and cleaned:
            said = {c["role_name"] for c in cleaned}
            missing = [m for m in mentions if m in valid_names and m not in said]
            if missing:
                cleaned.insert(
                    0,
                    {
                        "role_name": missing[0],
                        "content": "（被点名了，但本轮没生成台词，请再发一次或调整人设 prompt）",
                        "emoji_name": "",
                        "reply_to": "user",
                    },
                )

        if max_count and max_count > 0:
            cleaned = cleaned[:max_count]

        new_msgs = self.append_msgs(room_id, cleaned)

        # 发言角色亲密度打点（user 与 AI 互动一次 +1）
        spoken = {c["role_name"] for c in cleaned if c["role_name"] and c["role_name"] != "系统"}
        intimacy_map: Dict[str, Dict[str, Any]] = {}
        for r in (roles or []):
            if isinstance(r, dict) and r.get("name") in spoken:
                rk = self._canonical_key(room_id, r["name"])
                intimacy_map[rk] = self.touch_intimacy(rk, 1)

        return {
            "ok": True,
            "replies": cleaned,
            "vision": vision_ok,
            "new_msgs": new_msgs,
            "new_history": self.load_room(room_id)["history"],
            "social": social,
            "intimacy": intimacy_map,
        }

    def _absorb_social(
        self, room_id: str, roles: List[Dict[str, Any]], parsed: Dict[str, Any]
    ) -> Dict[str, Any]:
        """采纳模型给出的签名/心情/动态，按概率过滤；落库后回传前端用于刷新资料页。

        - profile_updates: 每个角色按 MOOD_CHANCE_DEFAULT 概率采纳 signature/mood；
        - moment: 按 MOMENT_CHANCE_DEFAULT 概率发一条公开说说；
        - 未过概率 / 字段为空 / 角色不存在：静默忽略，不影响主对话。
        """
        valid_names = {
            r.get("name") for r in (roles or []) if isinstance(r, dict) and r.get("name")
        }
        out: Dict[str, Any] = {"profiles": [], "moment": None}
        mood_chance = self._cfg_int("mood_change_chance", MOOD_CHANCE_DEFAULT)
        moment_chance = self._cfg_int("moment_chance", MOMENT_CHANCE_DEFAULT)

        updates = parsed.get("profile_updates")
        if isinstance(updates, list):
            for u in updates:
                if not isinstance(u, dict):
                    continue
                name = str(u.get("role_name") or "").strip()
                if not name or name not in valid_names:
                    continue
                if random.randint(1, 100) > mood_chance:
                    continue
                rk = self._canonical_key(room_id, name)
                sig = str(u.get("signature") or "").strip()
                mood = str(u.get("mood") or "").strip()
                if not sig and not mood:
                    continue
                self.set_profile(
                    rk,
                    signature=sig[:MAX_SIGNATURE_CHARS] or None,
                    mood=mood[:MAX_MOOD_CHARS] or None,
                )
                out["profiles"].append(
                    {"role_key": rk, "name": name,
                     "signature": sig[:MAX_SIGNATURE_CHARS], "mood": mood[:MAX_MOOD_CHARS]}
                )

        moment = parsed.get("moment")
        if isinstance(moment, dict):
            name = str(moment.get("role_name") or "").strip()
            content = str(moment.get("content") or "").strip()
            if name in valid_names and content and random.randint(1, 100) <= moment_chance:
                rk = self._canonical_key(room_id, name)
                vis = "self" if str(moment.get("visibility") or "public") == "self" else "public"
                mid = self.add_moment(rk, content, "", vis)
                out["moment"] = {"id": mid, "role_key": rk, "name": name,
                                 "content": content, "visibility": vis}
                # 同一次调用顺带生成的其他角色评论：按概率采纳落库，零额外请求
                cmt_chance = self._cfg_int("moment_comment_chance", MOMENT_COMMENT_CHANCE_DEFAULT)
                cmts = moment.get("comments")
                if isinstance(cmts, list) and random.randint(1, 100) <= cmt_chance:
                    added = []
                    for cm in cmts[:3]:
                        if not isinstance(cm, dict):
                            continue
                        cn = str(cm.get("role_name") or "").strip()
                        ct = str(cm.get("content") or "").strip()
                        if cn not in valid_names or not ct:
                            continue
                        if self.add_moment_comment(mid, cn, ct):
                            added.append({"who": cn, "content": ct[:MAX_MOMENT_CHARS]})
                    if added:
                        out["moment"]["comments"] = added

        # 楼中楼：模型在本轮顺带对动态评论区继续回复，复用同一次调用
        mreplies = parsed.get("moment_replies")
        if isinstance(mreplies, list):
            saved = []
            for mr in mreplies[:4]:
                if not isinstance(mr, dict):
                    continue
                name = str(mr.get("role_name") or "").strip()
                content = str(mr.get("content") or "").strip()
                if name not in valid_names or not content:
                    continue
                try:
                    mid = int(mr.get("moment_id"))
                except (TypeError, ValueError):
                    continue
                try:
                    parent = int(mr.get("reply_to_comment_id") or 0)
                except (TypeError, ValueError):
                    parent = 0
                if self.add_moment_comment(mid, name, content, reply_to=parent):
                    saved.append({"moment_id": mid, "who": name,
                                  "content": content[:MAX_MOMENT_CHARS], "reply_to": parent})
            if saved:
                out["moment_replies"] = saved
        return out

    # ------------------------------------------------------------------
    # 业务分发层：直连 handler 与 ui/proxy 代理共用同一份实现
    # ------------------------------------------------------------------
    async def _dispatch(self, path: str, params: dict, body: dict) -> Dict[str, Any]:
        params = params or {}
        body = body or {}

        if path == "/api/rooms":
            return {"ok": True, "rooms": self.list_all_rooms()}

        if path == "/api/new_room":
            rid = str(body.get("room_id") or ("room_" + str(int(time.time() * 1000)))).strip()
            rname = str(body.get("room_name") or "聊天室").strip()
            self._ensure_room(rid, rname)
            return {"ok": True, "room_id": rid}

        if path == "/api/rename_room":
            if not body.get("room_id"):
                return {"ok": False, "msg": "缺少 room_id"}
            self.rename_room(str(body["room_id"]), str(body.get("room_name") or "未命名"))
            return {"ok": True}

        if path == "/api/del_room":
            if not body.get("room_id"):
                return {"ok": False, "msg": "缺少 room_id"}
            self.delete_room(str(body["room_id"]))
            return {"ok": True}

        if path == "/api/room":
            rid = str(params.get("room_id") or body.get("room_id") or "default")
            return dict({"ok": True}, **self.load_room(rid))

        if path == "/api/config":
            o = self._norm_opts(None)
            return {
                "ok": True,
                "vision_enabled": self.vision_enabled,
                "max_image_side": self._cfg_int("max_image_side", 1024),
                "auto_talk_max_rounds": self._cfg_int("auto_talk_max_rounds", 0),
                "split_symbol": o["split_symbol"],
                "allow_multi_round": o["allow_multi_round"],
                "max_reply_messages": o["max_reply_messages"],
                "time_awareness": o["time_awareness"],
                "timezone_offset": self._cfg_int("timezone_offset", DEFAULT_TZ_OFFSET),
                "user_nickname": self.get_user_profile()["nickname"],
            }

        if path == "/api/set_bg":
            rid = str(body.get("room_id") or "default")
            bg = str(body.get("bg") or "none")
            if len(bg) > MAX_IMAGE_CHARS:
                return {"ok": False, "msg": "背景图过大，请换一张小一点的图片"}
            scope = "all" if str(body.get("scope") or "room") == "all" else "room"
            self.set_room_bg(rid, bg, scope)
            return {"ok": True, "bg": self.get_room_bg(rid), "scope": scope}

        if path == "/api/send":
            room_id = str(body.get("room_id") or "default")
            user_msg = str(body.get("content") or "").strip()
            image = str(body.get("image") or "").strip()
            if image and len(image) > MAX_IMAGE_CHARS:
                return {"ok": False, "msg": "图片过大，请压缩后再发送"}
            if not user_msg and not image:
                return {"ok": False, "msg": "消息内容为空"}
            roles = body.get("roles") or []
            emojis = body.get("emojis") or []
            emoji_name = str(body.get("emoji_name") or "")
            quote = str(body.get("quote") or "").strip()[:MAX_QUOTE_CHARS]
            reply_to = str(body.get("reply_to") or "").strip()
            opts = self._norm_opts(body.get("opts"))
            mentions = [str(m).strip() for m in (body.get("mentions") or []) if str(m).strip()]
            self._ensure_room(room_id, room_id)

            # 用户自己也能用分隔符刷屏：拆成多条独立入库，表情与图片只挂第一条
            segs = _split_segments(user_msg, opts["split_symbol"]) if user_msg else []
            if not segs:
                segs = [""]
            user_rows_raw = []
            for idx, seg in enumerate(segs):
                user_rows_raw.append({
                    "role_name": "user", "content": seg,
                    "emoji_name": emoji_name if idx == 0 else "",
                    "image": image if idx == 0 else "",
                    "reply_to": reply_to, "quote": quote if idx == 0 else "",
                })
            # 表情包拆分：emoji+文字同条时强制拆为「大表情 + 文字」两条独立记录
            user_rows = self.append_msgs(room_id, user_rows_raw)

            dm = self._dm_parts(room_id)
            pending: List[Dict[str, Any]] = []
            if dm:
                role_key = self._role_key(dm["group_room"], dm["role_name"])
                if _role_status()["state"] == "sleep":
                    # 离线时段：不调用模型，消息入待回复表，醒来后合并回复
                    for ur in user_rows_raw:
                        if ur["content"]:
                            self.add_pending(room_id, role_key, ur["content"])
                    return {
                        "ok": True, "offline": True,
                        "replies": [], "new_msgs": user_rows,
                        "new_history": self.load_room(room_id)["history"],
                        "social": {"profiles": [], "moment": None},
                        "intimacy": {},
                    }
                pending = self.take_pending(room_id)

            hint = ("用户刚刚说：" + user_msg) if user_msg else "用户刚刚发送了一张图片"
            try:
                result = await self._generate_replies(
                    room_id, roles, emojis, hint,
                    images=[image] if image else None,
                    mentions=mentions,
                    opts=opts,
                    quote=quote,
                    pending_texts=[p["content"] for p in pending],
                )
            except Exception as exc:
                self.logger.exception("send 调用模型失败")
                return {"ok": False, "msg": "模型调用失败：" + str(exc)}
            # 把用户自己的消息也塞进 new_msgs 首位，前端据此回填 id（撤回/表情回应要用）
            result["new_msgs"] = list(user_rows) + list(result.get("new_msgs") or [])
            self.mark_pending_done(pending)
            memo = (
                "\n【房间 " + self.load_room(room_id)["room_name"] + "】用户："
                + (user_msg or "[图片]")
                + ("（@ " + "、".join(mentions) + "）" if mentions else "")
                + " -> " + ";".join([r["content"] for r in result["replies"]])
            )
            self._remember(memo)
            return result

        if path == "/api/auto_talk":
            room_id = str(body.get("room_id") or "default")
            roles = body.get("roles") or []
            emojis = body.get("emojis") or []
            try:
                count = int(body.get("count") or 0)
            except (TypeError, ValueError):
                count = 0
            limit = self._cfg_int("auto_talk_max_rounds", 0)
            if limit > 0 and (count <= 0 or count > limit):
                count = limit
            dm = self._dm_parts(room_id)
            pending = self.take_pending(room_id) if dm else []
            if dm and pending and _role_status()["state"] == "sleep":
                # 仍处于离线时段：放回待回复表，本轮不触发模型
                self.rehold_pending(pending)
                return {"ok": True, "offline": True, "replies": [], "new_msgs": [],
                        "new_history": self.load_room(room_id)["history"],
                        "social": {"profiles": [], "moment": None}, "intimacy": {}}
            try:
                result = await self._generate_replies(
                    room_id, roles, emojis,
                    "没有人说话，让角色自发延续氛围，主动聊一轮。",
                    max_count=count,
                    opts=self._norm_opts(body.get("opts")),
                    pending_texts=[p["content"] for p in pending],
                )
            except Exception as exc:
                self.logger.exception("auto_talk 调用模型失败")
                return {"ok": False, "msg": "模型调用失败：" + str(exc)}
            self.mark_pending_done(pending)
            self._remember(
                "\n【房间 " + self.load_room(room_id)["room_name"] + "】自动对话："
                + ";".join([r["content"] for r in result["replies"]])
            )
            return result

        if path == "/api/summary_room":
            room_id = str(body.get("room_id") or "default")
            room_data = self.load_room(room_id)
            history_text = "\n".join(
                [h["who"] + ": " + h["content"] for h in room_data["history"]]
            )
            if not history_text.strip():
                return {"ok": False, "msg": "暂无对话，无法总结"}
            sys_prompt = (
                "你是对话摘要助手，精简总结这段聊天，保留关键剧情、人物关系、约定，"
                "简短，适合作为记忆摘要，不要多余修饰。"
            )
            try:
                summary = await self.call_llm(
                    sys_prompt, "聊天内容：\n" + history_text + "\n输出摘要"
                )
                summary = summary[0] if isinstance(summary, tuple) else summary
            except Exception as exc:
                self.logger.exception("summary_room 调用模型失败")
                return {"ok": False, "msg": "模型调用失败：" + str(exc)}
            self.add_summary(room_id, summary)
            self._remember("\n【房间摘要｜" + room_data["room_name"] + "】" + summary)
            return {
                "ok": True,
                "summary": summary,
                "summaries": self.load_room(room_id)["summaries"],
            }

        if path == "/api/save_roles":
            self.save_roles(str(body.get("room_id") or "default"), body.get("roles") or [])
            return {"ok": True}

        if path == "/api/update_summary":
            if body.get("id") is None:
                return {"ok": False, "msg": "缺少摘要 id"}
            text = str(body.get("summary") or "").strip()
            if not text:
                return {"ok": False, "msg": "摘要内容不能为空"}
            try:
                sid = int(body["id"])
            except (TypeError, ValueError):
                return {"ok": False, "msg": "摘要 id 非法"}
            if not self.update_summary(sid, text):
                return {"ok": False, "msg": "该摘要不存在或已被删除，请刷新后重试"}
            rid = str(body.get("room_id") or "default")
            return {"ok": True, "summaries": self.load_room(rid)["summaries"]}

        if path == "/api/del_summary":
            if body.get("id") is None:
                return {"ok": False, "msg": "缺少摘要 id"}
            try:
                sid = int(body["id"])
            except (TypeError, ValueError):
                return {"ok": False, "msg": "摘要 id 非法"}
            if not self.delete_summary(sid):
                return {"ok": False, "msg": "该摘要不存在或已被删除，请刷新后重试"}
            rid = str(body.get("room_id") or "default")
            return {"ok": True, "summaries": self.load_room(rid)["summaries"]}

        if path == "/api/save_emojis":
            self.save_emojis(str(body.get("room_id") or "default"), body.get("emojis") or [])
            return {"ok": True}

        if path == "/api/clear":
            self.clear_history(str(body.get("room_id") or "default"))
            return {"ok": True}

        if path == "/api/recall":
            rid = str(body.get("room_id") or "default")
            try:
                mid = int(body.get("msg_id"))
            except (TypeError, ValueError):
                return {"ok": False, "msg": "msg_id 非法"}
            if not self.recall_msg(rid, mid):
                return {"ok": False, "msg": "消息不存在或已被撤回"}
            return {"ok": True, "msg_id": mid}

        if path == "/api/react":
            rid = str(body.get("room_id") or "default")
            try:
                mid = int(body.get("msg_id"))
            except (TypeError, ValueError):
                return {"ok": False, "msg": "msg_id 非法"}
            emoji = str(body.get("emoji") or "").strip()
            if not emoji or len(emoji) > 8:
                return {"ok": False, "msg": "表情不合法"}
            res = self.toggle_reaction(rid, mid, emoji)
            if res is None:
                return {"ok": False, "msg": "消息不存在，可能已被清空"}
            return dict({"ok": True}, **res)

        if path == "/api/reactions":
            rid = str(params.get("room_id") or body.get("room_id") or "default")
            return {"ok": True, "reactions": self.list_reactions(rid)}

        if path == "/api/global_memory":
            return {
                "ok": True,
                "memory": self.global_memory,
                "allow_yoosung_private": self.allow_yoosung_private,
            }

        if path == "/api/set_global_memory":
            self.global_memory = str(body.get("memory") or "")
            self.save_global_memory()
            return {"ok": True}

        if path == "/api/set_switch":
            self.save_switch(bool(body.get("allow", False)))
            return {"ok": True, "allow_yoosung_private": self.allow_yoosung_private}

        # ---------------- v2.0.0 QQ 化社交 ----------------
        if path == "/api/conversations":
            return {"ok": True, "conversations": self.list_conversations()}

        if path == "/api/friends":
            return {"ok": True, "friends": self.list_friends()}

        if path == "/api/profile":
            rk = str(params.get("role_key") or body.get("role_key") or "").strip()
            if not rk:
                return {"ok": False, "msg": "缺少 role_key"}
            return dict({"ok": True}, **self.get_profile_view(rk))

        if path == "/api/visit":
            rk = str(body.get("role_key") or "").strip()
            if not rk:
                return {"ok": False, "msg": "缺少 role_key"}
            return {"ok": True, "visits": self.bump_visits(rk)}

        if path == "/api/moments":
            rk = str(params.get("role_key") or body.get("role_key") or "").strip()
            events = self.ambient_moment_interaction()
            return {"ok": True, "moments": self.load_moments(rk), "events": events}

        if path == "/api/moment_like":
            mid = body.get("moment_id")
            try:
                mid = int(mid)
            except (TypeError, ValueError):
                return {"ok": False, "msg": "moment_id 非法"}
            liked = self.toggle_moment_like(mid, "user")
            return {"ok": True, "liked": liked}

        if path == "/api/moment_comment":
            mid = body.get("moment_id")
            try:
                mid = int(mid)
            except (TypeError, ValueError):
                return {"ok": False, "msg": "moment_id 非法"}
            ok = self.add_moment_comment(mid, "user", str(body.get("content") or ""))
            return {"ok": ok, "msg": "评论不能为空" if not ok else ""}

        if path == "/api/dm":
            rk = str(body.get("role_key") or "").strip()
            role = self.find_role(rk)
            if not role:
                return {"ok": False, "msg": "角色不存在"}
            rid = self.ensure_dm_room(rk, role["name"], role.get("avatar", ""))
            return {"ok": True, "room_id": rid, "role": role}

        if path == "/api/poke":
            rk = str(body.get("role_key") or "").strip()
            role = self.find_role(rk)
            if not role:
                return {"ok": False, "msg": "角色不存在"}
            self.touch_intimacy(rk, 1)
            reply = random.choice(POKE_FALLBACKS)
            return {"ok": True, "reply": reply, "role_name": role["name"]}

        # ---------------- v2.1.0 社交与实用端点 ----------------
        if path == "/api/user_moment":
            content = str(body.get("content") or "").strip()
            image = str(body.get("image") or "").strip()
            if image and len(image) > MAX_IMAGE_CHARS:
                return {"ok": False, "msg": "图片过大，请压缩后再发布"}
            if not content and not image:
                return {"ok": False, "msg": "动态内容不能为空"}
            vis = "self" if str(body.get("visibility") or "public") == "self" else "public"
            mid = self.add_moment("user", content, image, vis)
            return {"ok": True, "moment_id": mid, "moments": self.load_moments("")}

        if path == "/api/user_profile":
            if body:
                if len(str(body.get("avatar") or "")) > MAX_IMAGE_CHARS:
                    return {"ok": False, "msg": "头像图片过大，请换小一点的图"}
                prof = self.set_user_profile(
                    nickname=body.get("nickname") if "nickname" in body else None,
                    avatar=body.get("avatar") if "avatar" in body else None,
                )
                return dict({"ok": True}, **prof)
            return dict({"ok": True}, **self.get_user_profile())

        if path == "/api/friend_groups":
            if body:
                return {"ok": True, "groups": self.set_friend_groups(body.get("groups") or [])}
            return {"ok": True, "groups": self.get_friend_groups()}

        if path == "/api/forward_msg":
            try:
                mid = int(body.get("msg_id"))
            except (TypeError, ValueError):
                return {"ok": False, "msg": "msg_id 非法"}
            to_room = str(body.get("to_room_id") or "").strip()
            if not to_room:
                return {"ok": False, "msg": "缺少目标会话"}
            self._ensure_room(to_room, to_room)
            new_msg = self.forward_message(mid, to_room)
            if not new_msg:
                return {"ok": False, "msg": "原消息不存在"}
            return {"ok": True, "new_msg": new_msg}

        if path == "/api/search_msg":
            kw = str(params.get("keyword") or body.get("keyword") or "")
            rid = str(params.get("room_id") or body.get("room_id") or "")
            return {"ok": True, "results": self.search_msgs(kw, rid)}

        if path == "/api/conv_state":
            cid = str(body.get("conv_id") or "").strip()
            field = str(body.get("field") or "").strip()
            if not cid or field not in ("pinned", "muted", "hidden", "read_id", "special_care"):
                return {"ok": False, "msg": "参数非法"}
            val = body.get("value", 0)
            return {"ok": True, "state": self.set_conv_state(cid, field, int(val or 0))}

        return {"ok": False, "msg": "unknown path: " + str(path)}

    # ---------------------- 直连 handler（保留，向后兼容） ----------------------
    async def api_room_list(self):
        return await self._dispatch("/api/rooms", {}, {})

    async def api_new_room(self):
        return await self._dispatch("/api/new_room", {}, await request.json(default={}) or {})

    async def api_rename_room(self):
        return await self._dispatch("/api/rename_room", {}, await request.json(default={}) or {})

    async def api_del_room(self):
        return await self._dispatch("/api/del_room", {}, await request.json(default={}) or {})

    async def api_get_room(self):
        return await self._dispatch("/api/room", dict(request.query), {})

    async def api_send(self):
        return await self._dispatch("/api/send", {}, await request.json(default={}) or {})

    async def api_auto_talk(self):
        return await self._dispatch("/api/auto_talk", {}, await request.json(default={}) or {})

    async def api_summary_room(self):
        return await self._dispatch("/api/summary_room", {}, await request.json(default={}) or {})

    async def api_save_roles(self):
        return await self._dispatch("/api/save_roles", {}, await request.json(default={}) or {})

    async def api_update_summary(self):
        return await self._dispatch(
            "/api/update_summary", {}, await request.json(default={}) or {}
        )

    async def api_del_summary(self):
        return await self._dispatch(
            "/api/del_summary", {}, await request.json(default={}) or {}
        )

    async def api_save_emojis(self):
        return await self._dispatch("/api/save_emojis", {}, await request.json(default={}) or {})

    async def api_clear_history(self):
        return await self._dispatch("/api/clear", {}, await request.json(default={}) or {})

    async def api_get_global_mem(self):
        return await self._dispatch("/api/global_memory", {}, {})

    async def api_set_global_mem(self):
        return await self._dispatch("/api/set_global_memory", {}, await request.json(default={}) or {})

    async def api_set_switch(self):
        return await self._dispatch("/api/set_switch", {}, await request.json(default={}) or {})

    async def api_set_bg(self):
        return await self._dispatch("/api/set_bg", {}, await request.json(default={}) or {})

    async def api_recall(self):
        return await self._dispatch("/api/recall", {}, await request.json(default={}) or {})

    async def api_react(self):
        return await self._dispatch("/api/react", {}, await request.json(default={}) or {})

    async def api_reactions(self):
        return await self._dispatch("/api/reactions", dict(request.query), {})

    async def api_client_config(self):
        return await self._dispatch("/api/config", dict(request.query), {})

    async def api_conversations(self):
        return await self._dispatch("/api/conversations", dict(request.query), {})

    async def api_friends(self):
        return await self._dispatch("/api/friends", dict(request.query), {})

    async def api_profile(self):
        return await self._dispatch("/api/profile", dict(request.query), {})

    async def api_visit(self):
        return await self._dispatch("/api/visit", {}, await request.json(default={}) or {})

    async def api_moments(self):
        return await self._dispatch("/api/moments", dict(request.query), {})

    async def api_moment_like(self):
        return await self._dispatch("/api/moment_like", {}, await request.json(default={}) or {})

    async def api_moment_comment(self):
        return await self._dispatch("/api/moment_comment", {}, await request.json(default={}) or {})

    async def api_dm(self):
        return await self._dispatch("/api/dm", {}, await request.json(default={}) or {})

    async def api_poke(self):
        return await self._dispatch("/api/poke", {}, await request.json(default={}) or {})

    async def api_conv_state(self):
        return await self._dispatch("/api/conv_state", {}, await request.json(default={}) or {})

    async def api_user_moment(self):
        return await self._dispatch("/api/user_moment", {}, await request.json(default={}) or {})

    async def api_user_profile(self):
        try:
            body = await request.json(default={}) or {}
        except Exception:
            body = {}
        return await self._dispatch("/api/user_profile", dict(request.query), body)

    async def api_friend_groups(self):
        try:
            body = await request.json(default={}) or {}
        except Exception:
            body = {}
        return await self._dispatch("/api/friend_groups", dict(request.query), body)

    async def api_forward_msg(self):
        return await self._dispatch("/api/forward_msg", {}, await request.json(default={}) or {})

    async def api_search_msg(self):
        return await self._dispatch("/api/search_msg", dict(request.query), {})

    # ---------------------- 统一代理端点（前端实际走这条） ----------------------
    async def api_ui_proxy(self):
        """前端 app.js 全部请求的唯一入口。

        请求体形如 {"path": "/api/rooms", "method": "GET", "params": {...}, "body": {...}}
        返回 {"ok": true, "data": <业务结果>}，与前端 unwrap 的逐层下钻逻辑配套。
        """
        try:
            payload = await request.json(default={}) or {}
        except Exception:
            return {"ok": False, "msg": "failed to read request body"}

        path = str(payload.get("path") or "").strip()
        params = payload.get("params") or {}
        body = payload.get("body") or {}
        # 带图请求体积很大，日志只记长度不记内容
        if "image" in body and isinstance(body.get("image"), str):
            self.logger.info(
                "[ai_groupchat bridge] proxy path=%s image_bytes=%d",
                path, len(body["image"])
            )
        else:
            self.logger.info("[ai_groupchat bridge] proxy path=%s", path)

        try:
            result = await self._dispatch(path, params, body)
        except Exception as exc:
            self.logger.exception("proxy dispatch error")
            result = {"ok": False, "msg": str(exc)}
        return {"ok": True, "data": result}

    async def terminate(self) -> None:
        """插件禁用 / 重载时调用；同时停掉可能仍在跑的自主对话由前端负责。"""
        return None
