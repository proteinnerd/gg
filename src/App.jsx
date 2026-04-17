import { useState, useEffect, useMemo, useRef } from "react";
import { Users, Plus, Check, X, Zap, ChevronLeft, ChevronRight, Copy, LogOut, Crown, MessageSquare, Send, AtSign, Bell, ArrowLeft, Swords, Coffee, Ban, BarChart3, Coins, Info, Trash2, Edit3, MousePointerClick, Trophy, Flame } from "lucide-react";
import "./storage.js";

// ---------- STORAGE HELPERS ----------
const storage = {
  async get(key, shared = false) {
    try { const r = await window.storage.get(key, shared); return r ? r.value : null; }
    catch { return null; }
  },
  async set(key, value, shared = false) {
    try { await window.storage.set(key, value, shared); return true; } catch { return false; }
  },
};

// ---------- STATUS TYPES (simplified) ----------
const STATUSES = {
  down:  { label: "DOWN TO PLAY", short: "DOWN",  icon: Swords, color: "#39FF7A", bg: "rgba(57,255,122,0.15)", border: "#39FF7A" },
  maybe: { label: "MAYBE",        short: "MAYBE", icon: Coffee, color: "#FFD23F", bg: "rgba(255,210,63,0.12)", border: "#FFD23F" },
  no:    { label: "NOT AVAILABLE",short: "NOPE",  icon: Ban,    color: "#FF4D8D", bg: "rgba(255,77,141,0.10)", border: "#FF4D8D" },
};
const STATUS_KEYS = Object.keys(STATUSES);

const TIME_BLOCKS = [
  { id: "morning",   label: "MORNING" },
  { id: "afternoon", label: "AFTERNOON" },
  { id: "evening",   label: "EVENING" },
];

// ---------- DATE UTILS ----------
const dayKey = (d) => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate()+n); return x; };
const startOfWeek = (d) => { const x = new Date(d); const day = x.getDay(); x.setDate(x.getDate()-day); x.setHours(0,0,0,0); return x; };
const DAY_NAMES = ["SUN","MON","TUE","WED","THU","FRI","SAT"];
const MONTH_NAMES = ["JAN","FEB","MAR","APR","MAY","JUN","JUL","AUG","SEP","OCT","NOV","DEC"];

// Build a 6-row x 7-col calendar grid for the month containing `anchor`.
// Returns array of rows; each row is an array of {date, inMonth}.
const buildMonthGrid = (anchor) => {
  const first = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
  const gridStart = startOfWeek(first); // sunday of the first week shown
  const rows = [];
  for (let r = 0; r < 6; r++) {
    const row = [];
    for (let c = 0; c < 7; c++) {
      const d = addDays(gridStart, r * 7 + c);
      row.push({ date: d, inMonth: d.getMonth() === anchor.getMonth() });
    }
    rows.push(row);
  }
  // trim trailing row if entirely next-month (common for shorter months)
  while (rows.length > 4 && rows[rows.length - 1].every(c => !c.inMonth)) rows.pop();
  return rows;
};
const fmtTime = (ts) => {
  const d = new Date(ts); const now = new Date();
  const sameDay = dayKey(d) === dayKey(now);
  const h = d.getHours(), m = String(d.getMinutes()).padStart(2,'0');
  const t = `${String(h).padStart(2,'0')}:${m}`;
  if (sameDay) return t;
  return `${MONTH_NAMES[d.getMonth()]} ${d.getDate()} · ${t}`;
};

const AVATAR_COLORS = ["#39FF7A","#FF4D8D","#6EE7FF","#FFD23F","#B388FF","#FF8A3D","#7CFFCB","#FF5555"];
const pickColor = (name) => AVATAR_COLORS[(name?.charCodeAt(0) || 0) % AVATAR_COLORS.length];

// Slot can be a string (legacy) or {status, note} — normalize it.
const getSlot = (raw) => {
  if (!raw) return null;
  if (typeof raw === "string") return { status: raw, note: "" };
  return raw;
};

// Strip out any time-block keys that aren't in the current TIME_BLOCKS set.
// Handles schedules saved under old block IDs (early, primetime, late).
const validBlockIds = new Set(TIME_BLOCKS.map(b => b.id));
const migrateSchedule = (sched) => {
  if (!sched || typeof sched !== "object") return {};
  let changed = false;
  const out = {};
  for (const [dayK, blocks] of Object.entries(sched)) {
    if (!blocks || typeof blocks !== "object") continue;
    const kept = {};
    for (const [bid, val] of Object.entries(blocks)) {
      if (validBlockIds.has(bid)) kept[bid] = val;
      else changed = true;
    }
    if (Object.keys(kept).length) out[dayK] = kept;
  }
  return { schedule: out, changed };
};

export default function App() {
  const [screen, setScreen] = useState("loading");
  const [me, setMe] = useState(null);
  const [squads, setSquads] = useState([]);
  const [activeSquad, setActiveSquad] = useState(null);
  const [members, setMembers] = useState([]);
  const [schedule, setSchedule] = useState({});
  const [squadSchedules, setSquadSchedules] = useState({});
  const [weekStart, setWeekStart] = useState(startOfWeek(new Date()));
  const [showJoinCreate, setShowJoinCreate] = useState(false);
  const [toast, setToast] = useState(null);
  const [messages, setMessages] = useState([]);
  const [activity, setActivity] = useState([]);
  const [polls, setPolls] = useState([]);
  const [tosses, setTosses] = useState([]);
  const [clickerScores, setClickerScores] = useState({}); // { handle: count }
  const [infoEntries, setInfoEntries] = useState([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [lastReadTs, setLastReadTs] = useState(0);
  const [mentionAlert, setMentionAlert] = useState(null); // {from, preview}

  const pollRef = useRef(null);
  const myClicksRef = useRef(0); // authoritative current click count for me

  // Try a storage read a few times before concluding the key really doesn't exist.
  // Rare transient errors otherwise kick users back to onboarding and wipe their squads.
  const robustGet = async (key) => {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const r = await window.storage.get(key, false);
        return r ? r.value : null; // r === null means the key really doesn't exist
      } catch (err) {
        // Exception could be "key not found" OR a transient error. Retry with backoff.
        if (attempt < 2) await new Promise(res => setTimeout(res, 150 * (attempt + 1)));
      }
    }
    return null;
  };

  // LOAD ON MOUNT
  useEffect(() => { (async () => {
    const profile = await robustGet("profile:me");
    if (!profile) { setScreen("onboard"); return; }
    let p;
    try { p = JSON.parse(profile); }
    catch { setScreen("onboard"); return; }
    setMe(p);
    const sq = await robustGet("profile:squads");
    let list = [];
    if (sq) {
      try { list = JSON.parse(sq); } catch { list = []; }
    }
    setSquads(list);
    if (list.length) await loadSquad(list[0].code, p);
    setScreen("main");
  })(); }, []);

  // POLL for messages + schedules + activity every 5s when in a squad
  useEffect(() => {
    if (!activeSquad || !me) return;
    const tick = async () => {
      const msgRaw = await storage.get(`squad:${activeSquad}:chat`, true);
      if (msgRaw !== null) {
        const msgs = JSON.parse(msgRaw);
        setMessages(prev => {
          const newOnes = msgs.filter(m => !prev.find(p => p.id === m.id));
          const mentionMe = newOnes.find(m => m.from !== me.handle && (m.mentions || []).includes(me.handle));
          if (mentionMe) {
            setMentionAlert({ from: mentionMe.from, preview: mentionMe.text.slice(0, 80) });
            setTimeout(() => setMentionAlert(null), 5000);
          }
          return msgs;
        });
      }

      const actRaw = await storage.get(`squad:${activeSquad}:activity`, true);
      if (actRaw !== null) setActivity(JSON.parse(actRaw));

      const pollsRaw = await storage.get(`squad:${activeSquad}:polls`, true);
      if (pollsRaw !== null) setPolls(JSON.parse(pollsRaw));

      const tossesRaw = await storage.get(`squad:${activeSquad}:tosses`, true);
      if (tossesRaw !== null) setTosses(JSON.parse(tossesRaw));

      const infoRaw = await storage.get(`squad:${activeSquad}:infoentries`, true);
      if (infoRaw !== null) setInfoEntries(JSON.parse(infoRaw));

      const mRaw = await storage.get(`squad:${activeSquad}:members`, true);
      if (mRaw === null) return; // storage hiccup — keep current state rather than wiping
      const mem = JSON.parse(mRaw);
      setMembers(mem);
      const all = {};
      for (const m of mem) {
        const raw = await storage.get(`squad:${activeSquad}:sched:${m.handle}`, true);
        const parsed = raw ? JSON.parse(raw) : {};
        const { schedule: migrated } = migrateSchedule(parsed);
        all[m.handle] = migrated;
      }
      setSquadSchedules(all);

      // Refresh clicker scores for every member.
      // For MY score, trust the local ref over storage — storage might be
      // stale by up to 400ms (debounced flush window), and during that
      // window reading it back would clobber my pending clicks.
      const scores = {};
      for (const m of mem) {
        if (m.handle === me.handle) {
          scores[m.handle] = myClicksRef.current;
          continue;
        }
        const raw = await storage.get(`squad:${activeSquad}:clicker:${m.handle}`, true);
        scores[m.handle] = raw ? parseInt(raw, 10) : 0;
      }
      setClickerScores(scores);
    };
    tick();
    pollRef.current = setInterval(tick, 5000);
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [activeSquad, me]);

  // unread counter
  useEffect(() => {
    if (!me) return;
    const unread = messages.filter(m => m.from !== me.handle && m.ts > lastReadTs).length;
    setUnreadCount(unread);
  }, [messages, lastReadTs, me]);

  const showToast = (msg) => { setToast(msg); setTimeout(() => setToast(null), 2400); };

  const createProfile = async (handle) => {
    const profile = { handle: handle.trim().slice(0, 16), color: pickColor(handle) };
    await storage.set("profile:me", JSON.stringify(profile));
    setMe(profile);
    setSquads([]);
    setScreen("main");
  };

  const loadSquad = async (code, profile = me) => {
    const mRaw = await storage.get(`squad:${code}:members`, true);
    const mem = mRaw ? JSON.parse(mRaw) : [];
    const isNewMember = profile && !mem.find(x => x.handle === profile.handle);
    if (isNewMember) {
      mem.push({ handle: profile.handle, color: profile.color, joinedAt: Date.now() });
      await storage.set(`squad:${code}:members`, JSON.stringify(mem), true);
      // Log the join in the squad's activity feed
      const info = await storage.get(`squad:${code}:info`, true);
      const squadName = info ? JSON.parse(info).name : code;
      await logActivityFor(code, {
        id: `${Date.now()}-${Math.random().toString(36).slice(2,6)}`,
        from: profile.handle, color: profile.color, ts: Date.now(),
        kind: "joined", squadName,
      });
    }
    setMembers(mem);
    setActiveSquad(code);

    // load + migrate my schedule
    const myRaw = await storage.get(`squad:${code}:sched:${profile.handle}`, true);
    const myRawParsed = myRaw ? JSON.parse(myRaw) : {};
    const { schedule: mineMigrated, changed: mineChanged } = migrateSchedule(myRawParsed);
    setSchedule(mineMigrated);
    if (mineChanged) {
      await storage.set(`squad:${code}:sched:${profile.handle}`, JSON.stringify(mineMigrated), true);
    }

    // load + migrate everyone's schedules
    const all = {};
    for (const m of mem) {
      const raw = await storage.get(`squad:${code}:sched:${m.handle}`, true);
      const parsed = raw ? JSON.parse(raw) : {};
      const { schedule: migrated } = migrateSchedule(parsed);
      all[m.handle] = migrated;
    }
    setSquadSchedules(all);

    const msgRaw = await storage.get(`squad:${code}:chat`, true);
    const msgs = msgRaw ? JSON.parse(msgRaw) : [];
    setMessages(msgs);

    const actRaw = await storage.get(`squad:${code}:activity`, true);
    const acts = actRaw ? JSON.parse(actRaw) : [];
    setActivity(acts);

    const pollsRaw = await storage.get(`squad:${code}:polls`, true);
    setPolls(pollsRaw ? JSON.parse(pollsRaw) : []);

    const tossesRaw = await storage.get(`squad:${code}:tosses`, true);
    setTosses(tossesRaw ? JSON.parse(tossesRaw) : []);

    // Load each member's clicker score
    const scores = {};
    for (const m of mem) {
      const raw = await storage.get(`squad:${code}:clicker:${m.handle}`, true);
      scores[m.handle] = raw ? parseInt(raw, 10) : 0;
    }
    setClickerScores(scores);
    // Seed my authoritative click count from storage
    myClicksRef.current = scores[profile.handle] || 0;

    const infoRaw = await storage.get(`squad:${code}:infoentries`, true);
    setInfoEntries(infoRaw ? JSON.parse(infoRaw) : []);

    const readKey = `profile:lastread:${code}`;
    const lr = await storage.get(readKey);
    setLastReadTs(lr ? parseInt(lr, 10) : 0);
  };

  const markChatRead = async () => {
    const ts = Date.now();
    setLastReadTs(ts);
    await storage.set(`profile:lastread:${activeSquad}`, String(ts));
  };

  const createSquad = async (name) => {
    const code = Math.random().toString(36).slice(2, 7).toUpperCase();
    const squadInfo = { code, name: name.trim().slice(0, 20), createdBy: me.handle, createdAt: Date.now() };
    await storage.set(`squad:${code}:info`, JSON.stringify(squadInfo), true);
    // Pre-add creator to members so loadSquad doesn't double-log as "joined"
    await storage.set(
      `squad:${code}:members`,
      JSON.stringify([{ handle: me.handle, color: me.color, joinedAt: Date.now() }]),
      true
    );
    // Log creation event
    await logActivityFor(code, {
      id: `${Date.now()}-${Math.random().toString(36).slice(2,6)}`,
      from: me.handle, color: me.color, ts: Date.now(),
      kind: "created", squadName: squadInfo.name,
    });
    const newList = [...squads, { code, name: squadInfo.name, role: "owner" }];
    setSquads(newList);
    await storage.set("profile:squads", JSON.stringify(newList));
    await loadSquad(code);
    setShowJoinCreate(false);
    showToast(`SQUAD CREATED — CODE: ${code}`);
  };

  const joinSquad = async (code) => {
    const clean = code.trim().toUpperCase();
    const info = await storage.get(`squad:${clean}:info`, true);
    if (!info) { showToast("SQUAD NOT FOUND"); return; }
    const parsed = JSON.parse(info);
    if (squads.find(s => s.code === clean)) { showToast("ALREADY IN SQUAD"); setShowJoinCreate(false); return; }
    const newList = [...squads, { code: clean, name: parsed.name, role: "member" }];
    setSquads(newList);
    await storage.set("profile:squads", JSON.stringify(newList));
    await loadSquad(clean);
    setShowJoinCreate(false);
    showToast(`JOINED ${parsed.name}`);
  };

  const leaveSquad = async (code) => {
    const mRaw = await storage.get(`squad:${code}:members`, true);
    const mem = mRaw ? JSON.parse(mRaw) : [];
    const updated = mem.filter(x => x.handle !== me.handle);
    await storage.set(`squad:${code}:members`, JSON.stringify(updated), true);
    const info = await storage.get(`squad:${code}:info`, true);
    const squadName = info ? JSON.parse(info).name : code;
    await logActivityFor(code, {
      id: `${Date.now()}-${Math.random().toString(36).slice(2,6)}`,
      from: me.handle, color: me.color, ts: Date.now(),
      kind: "left", squadName,
    });
    const newList = squads.filter(s => s.code !== code);
    setSquads(newList);
    await storage.set("profile:squads", JSON.stringify(newList));
    if (activeSquad === code) {
      if (newList.length) await loadSquad(newList[0].code);
      else { setActiveSquad(null); setMembers([]); setSchedule({}); setSquadSchedules({}); setMessages([]); setActivity([]); setPolls([]); setTosses([]); setInfoEntries([]); setClickerScores({}); }
    }
    showToast("LEFT SQUAD");
  };

  const logActivity = async (entry) => {
    const next = [...activity, entry].slice(-200);
    setActivity(next);
    await storage.set(`squad:${activeSquad}:activity`, JSON.stringify(next), true);
  };

  // Like logActivity but reads/writes directly to storage for a specific squad.
  // Used for events during squad creation/join before state is settled, or for
  // squads that aren't the currently active one.
  const logActivityFor = async (code, entry) => {
    const raw = await storage.get(`squad:${code}:activity`, true);
    const existing = raw ? JSON.parse(raw) : [];
    const next = [...existing, entry].slice(-200);
    await storage.set(`squad:${code}:activity`, JSON.stringify(next), true);
    // if logging for the active squad, reflect in local state
    if (code === activeSquad) setActivity(next);
  };

  // ---------- POLLS ----------
  const createPoll = async (question, options) => {
    const poll = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2,6)}`,
      question: question.trim(),
      options: options.map((text, i) => ({ id: `opt-${i}`, text: text.trim() })),
      createdBy: me.handle,
      createdByColor: me.color,
      createdAt: Date.now(),
      votes: {}, // { [handle]: optionId }
      closed: false,
    };
    // read fresh from storage to avoid races
    const raw = await storage.get(`squad:${activeSquad}:polls`, true);
    const existing = raw ? JSON.parse(raw) : [];
    const next = [poll, ...existing].slice(0, 50);
    setPolls(next);
    await storage.set(`squad:${activeSquad}:polls`, JSON.stringify(next), true);
    await logActivity({
      id: `${Date.now()}-${Math.random().toString(36).slice(2,6)}`,
      from: me.handle, color: me.color, ts: Date.now(),
      kind: "poll_created", pollQuestion: poll.question,
    });
  };

  const votePoll = async (pollId, optionId) => {
    const raw = await storage.get(`squad:${activeSquad}:polls`, true);
    const existing = raw ? JSON.parse(raw) : [];
    const next = existing.map(p => {
      if (p.id !== pollId || p.closed) return p;
      const newVotes = { ...(p.votes || {}) };
      if (newVotes[me.handle] === optionId) delete newVotes[me.handle]; // toggle off
      else newVotes[me.handle] = optionId;
      return { ...p, votes: newVotes };
    });
    setPolls(next);
    await storage.set(`squad:${activeSquad}:polls`, JSON.stringify(next), true);
  };

  const closePoll = async (pollId) => {
    const raw = await storage.get(`squad:${activeSquad}:polls`, true);
    const existing = raw ? JSON.parse(raw) : [];
    const target = existing.find(p => p.id === pollId);
    if (!target || target.createdBy !== me.handle) {
      showToast("ONLY THE CREATOR CAN CLOSE");
      return;
    }
    const next = existing.map(p => p.id === pollId ? { ...p, closed: true } : p);
    setPolls(next);
    await storage.set(`squad:${activeSquad}:polls`, JSON.stringify(next), true);
  };

  const deletePoll = async (pollId) => {
    const raw = await storage.get(`squad:${activeSquad}:polls`, true);
    const existing = raw ? JSON.parse(raw) : [];
    const target = existing.find(p => p.id === pollId);
    if (!target || target.createdBy !== me.handle) {
      showToast("ONLY THE CREATOR CAN DELETE");
      return;
    }
    const next = existing.filter(p => p.id !== pollId);
    setPolls(next);
    await storage.set(`squad:${activeSquad}:polls`, JSON.stringify(next), true);
  };

  // ---------- COIN TOSS (kept for backward compat, unused) ----------
  const tossCoin = async () => {
    const result = Math.random() < 0.5 ? "heads" : "tails";
    const entry = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2,6)}`,
      by: me.handle,
      color: me.color,
      result,
      ts: Date.now(),
    };
    const raw = await storage.get(`squad:${activeSquad}:tosses`, true);
    const existing = raw ? JSON.parse(raw) : [];
    const next = [entry, ...existing].slice(0, 30);
    setTosses(next);
    await storage.set(`squad:${activeSquad}:tosses`, JSON.stringify(next), true);
    return result;
  };

  // ---------- CLICKER ----------
  // Every click updates local state AND writes to storage immediately, so the
  // score is never lost on tab switch, reload, or navigation. The local ref is
  // the source of truth — the 5s poll skips overwriting it for my own handle.
  const addClick = () => {
    if (!activeSquad || !me) return;
    myClicksRef.current += 1;
    const next = myClicksRef.current;
    setClickerScores(prev => ({ ...prev, [me.handle]: next }));
    // Fire-and-forget write. Don't await — keeps the UI snappy on rapid clicks.
    storage.set(`squad:${activeSquad}:clicker:${me.handle}`, String(next), true);
  };

  // ---------- INFO ENTRIES ----------
  const saveInfoEntry = async (entry) => {
    // entry: { id?, title, body }
    const raw = await storage.get(`squad:${activeSquad}:infoentries`, true);
    const existing = raw ? JSON.parse(raw) : [];
    let next;
    if (entry.id) {
      next = existing.map(e => e.id === entry.id ? { ...e, title: entry.title.trim(), body: entry.body.trim(), updatedAt: Date.now(), updatedBy: me.handle } : e);
    } else {
      const newEntry = {
        id: `${Date.now()}-${Math.random().toString(36).slice(2,6)}`,
        title: entry.title.trim(),
        body: entry.body.trim(),
        createdBy: me.handle,
        createdAt: Date.now(),
      };
      next = [newEntry, ...existing].slice(0, 50);
    }
    setInfoEntries(next);
    await storage.set(`squad:${activeSquad}:infoentries`, JSON.stringify(next), true);
  };

  const deleteInfoEntry = async (id) => {
    const raw = await storage.get(`squad:${activeSquad}:infoentries`, true);
    const existing = raw ? JSON.parse(raw) : [];
    const next = existing.filter(e => e.id !== id);
    setInfoEntries(next);
    await storage.set(`squad:${activeSquad}:infoentries`, JSON.stringify(next), true);
  };

  const setBlock = async (date, blockId, status, note = "") => {
    const k = dayKey(date);
    const next = { ...schedule };
    if (!next[k]) next[k] = {};
    const existing = getSlot(next[k][blockId]);
    let action; // "cleared" | "set" | "noted"
    if (existing && existing.status === status && !note && !existing.note) {
      delete next[k][blockId];
      action = "cleared";
    } else {
      next[k][blockId] = { status, note: note || "" };
      action = existing && existing.status === status ? "noted" : "set";
    }
    if (Object.keys(next[k]).length === 0) delete next[k];
    setSchedule(next);
    setSquadSchedules(prev => ({ ...prev, [me.handle]: next }));
    await storage.set(`squad:${activeSquad}:sched:${me.handle}`, JSON.stringify(next), true);

    // log activity (skip "noted" if note didn't change)
    if (action === "cleared") {
      await logActivity({
        id: `${Date.now()}-${Math.random().toString(36).slice(2,6)}`,
        from: me.handle, color: me.color, ts: Date.now(),
        kind: "cleared", dayKey: k, blockId, blockLabel: TIME_BLOCKS.find(b => b.id === blockId)?.label,
      });
    } else if (action === "set") {
      await logActivity({
        id: `${Date.now()}-${Math.random().toString(36).slice(2,6)}`,
        from: me.handle, color: me.color, ts: Date.now(),
        kind: "status", status, note: note || "",
        dayKey: k, blockId, blockLabel: TIME_BLOCKS.find(b => b.id === blockId)?.label,
      });
    } else if (action === "noted" && note !== (existing?.note || "")) {
      await logActivity({
        id: `${Date.now()}-${Math.random().toString(36).slice(2,6)}`,
        from: me.handle, color: me.color, ts: Date.now(),
        kind: "note", status, note,
        dayKey: k, blockId, blockLabel: TIME_BLOCKS.find(b => b.id === blockId)?.label,
      });
    }
  };

  const clearBlock = async (date, blockId) => {
    const k = dayKey(date);
    const next = { ...schedule };
    if (next[k]) {
      delete next[k][blockId];
      if (!Object.keys(next[k]).length) delete next[k];
    }
    setSchedule(next);
    setSquadSchedules(prev => ({ ...prev, [me.handle]: next }));
    await storage.set(`squad:${activeSquad}:sched:${me.handle}`, JSON.stringify(next), true);
    await logActivity({
      id: `${Date.now()}-${Math.random().toString(36).slice(2,6)}`,
      from: me.handle, color: me.color, ts: Date.now(),
      kind: "cleared", dayKey: k, blockId, blockLabel: TIME_BLOCKS.find(b => b.id === blockId)?.label,
    });
  };

  const sendMessage = async (text, mentions) => {
    const msg = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2,7)}`,
      from: me.handle,
      color: me.color,
      text: text.trim(),
      mentions: mentions || [],
      ts: Date.now(),
    };
    const next = [...messages, msg].slice(-200); // keep last 200
    setMessages(next);
    await storage.set(`squad:${activeSquad}:chat`, JSON.stringify(next), true);
  };

  const copyCode = (code) => {
    navigator.clipboard?.writeText(code).catch(()=>{});
    showToast(`COPIED ${code}`);
  };

  const weekDays = useMemo(() => Array.from({length:7}, (_,i) => addDays(weekStart, i)), [weekStart]);

  const blockSummary = useMemo(() => {
    const out = {};
    for (const d of weekDays) {
      const k = dayKey(d);
      out[k] = {};
      for (const b of TIME_BLOCKS) {
        const listed = members.filter(m => getSlot(squadSchedules[m.handle]?.[k]?.[b.id])?.status === "down");
        out[k][b.id] = listed;
      }
    }
    return out;
  }, [weekDays, members, squadSchedules]);

  const styles = `
    :root {
      --bg: #0a0e1a;
      --bg-2: #0f1424;
      --panel: #151a2e;
      --panel-2: #1a2038;
      --border: #252b47;
      --text: #e6e8f0;
      --text-dim: #8a8fa3;
      --text-faint: #4a5070;
      --neon: #39FF7A;
      --pink: #FF4D8D;
      --cyan: #6EE7FF;
      --gold: #FFD23F;
      --purple: #B388FF;
    }
    * { box-sizing: border-box; }
    .gg-root {
      font-family: 'JetBrains Mono', 'Fira Code', ui-monospace, monospace;
      background: var(--bg);
      color: var(--text);
      min-height: 100vh;
      position: relative;
      overflow-x: hidden;
    }
    .gg-root::before {
      content: '';
      position: fixed; inset: 0;
      background:
        repeating-linear-gradient(0deg, rgba(57,255,122,0.025) 0px, rgba(57,255,122,0.025) 1px, transparent 1px, transparent 3px),
        radial-gradient(ellipse at 20% 0%, rgba(57,255,122,0.08), transparent 60%),
        radial-gradient(ellipse at 80% 100%, rgba(255,77,141,0.06), transparent 60%);
      pointer-events: none;
      z-index: 0;
    }
    .gg-root > * { position: relative; z-index: 1; }
    .display-font { font-family: 'Press Start 2P', 'JetBrains Mono', monospace; letter-spacing: 0.02em; }
    .glow-text { text-shadow: 0 0 12px currentColor, 0 0 2px currentColor; }
    .panel { background: linear-gradient(180deg, var(--panel), var(--panel-2)); border: 1px solid var(--border); border-radius: 4px; }
    .btn {
      font-family: inherit; background: transparent; color: var(--text);
      border: 1px solid var(--border); padding: 10px 16px;
      cursor: pointer; font-size: 11px; letter-spacing: 0.12em;
      text-transform: uppercase; transition: all 0.15s;
      display: inline-flex; align-items: center; gap: 8px; border-radius:2px;
    }
    .btn:hover { border-color: var(--neon); color: var(--neon); box-shadow: 0 0 0 1px var(--neon), 0 0 20px rgba(57,255,122,0.25); }
    .btn-primary { background: var(--neon); color: #0a0e1a; border-color: var(--neon); font-weight: 700; }
    .btn-primary:hover { background: #5aff94; color: #0a0e1a; box-shadow: 0 0 24px rgba(57,255,122,0.5); }
    .btn-ghost { border-color: transparent; color: var(--text-dim); }
    .btn-ghost:hover { color: var(--text); border-color: var(--border); box-shadow: none; }
    .input {
      font-family: inherit; background: var(--bg-2); border: 1px solid var(--border);
      color: var(--text); padding: 12px 14px; width: 100%; font-size: 14px;
      letter-spacing: 0.04em; border-radius: 3px;
    }
    .input:focus { outline: none; border-color: var(--neon); box-shadow: 0 0 0 1px var(--neon); }
    .avatar {
      width: 28px; height: 28px; border-radius: 3px;
      display: inline-flex; align-items: center; justify-content: center;
      font-weight: 700; font-size: 11px; color: #0a0e1a;
      font-family: 'Press Start 2P', monospace; letter-spacing: 0;
    }
    @keyframes blink { 0%,50% { opacity: 1; } 51%,100% { opacity: 0; } }
    .blink { animation: blink 1.1s infinite; }
    @keyframes pulse-neon { 0%,100% { box-shadow: 0 0 0 0 rgba(57,255,122,0.6); } 50% { box-shadow: 0 0 0 8px rgba(57,255,122,0); } }
    .pulse-dot { animation: pulse-neon 1.8s infinite; }
    @keyframes shake { 0%,100%{transform:translateX(0)} 20%,60%{transform:translateX(-3px)} 40%,80%{transform:translateX(3px)} }
    .shake { animation: shake 0.5s; }
    .toast {
      position: fixed; bottom: 24px; left: 50%; transform: translateX(-50%);
      background: var(--neon); color: #0a0e1a; padding: 12px 22px;
      font-family: 'Press Start 2P', monospace; font-size: 10px;
      letter-spacing: 0.08em; z-index: 100;
      box-shadow: 0 0 32px rgba(57,255,122,0.6); border-radius: 2px;
    }
    .mention-alert {
      position: fixed; top: 20px; right: 20px; z-index: 100;
      background: var(--panel); border: 1px solid var(--pink);
      padding: 14px 18px; border-radius: 3px; max-width: 320px;
      box-shadow: 0 0 32px rgba(255,77,141,0.4), 0 0 0 1px var(--pink);
      animation: slide-in 0.3s ease-out;
    }
    @keyframes slide-in { from { transform: translateX(120%); } to { transform: translateX(0); } }
    .chip {
      display: inline-flex; align-items: center; gap: 6px;
      padding: 4px 9px; font-size: 10px; letter-spacing: 0.08em;
      text-transform: uppercase; border-radius: 2px;
      border: 1px solid; font-weight: 600;
    }
    .day-cell { transition: background 0.15s, border-color 0.15s; }
    .day-cell:hover { border-color: var(--text-dim); }
    .status-btn {
      border: 1px solid var(--border); background: transparent;
      color: var(--text-dim); cursor: pointer; font-family: inherit;
      padding: 10px 12px; font-size: 10px; letter-spacing: 0.1em;
      text-transform: uppercase; display: flex; align-items: center; gap: 10px;
      border-radius: 2px; transition: all 0.12s; width: 100%;
    }
    .status-btn:hover { filter: brightness(1.25); background: rgba(255,255,255,0.04); }
    @keyframes float-in { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }
    .float-in { animation: float-in 0.3s ease-out; }
    .tab {
      padding: 10px 18px; cursor: pointer; font-size: 11px;
      letter-spacing: 0.12em; text-transform: uppercase;
      color: var(--text-dim); border-bottom: 2px solid transparent;
      transition: all 0.15s; position: relative;
    }
    .tab.active { color: var(--neon); border-bottom-color: var(--neon); }
    .tab:hover { color: var(--text); }
    .badge {
      display:inline-flex; align-items:center; justify-content:center;
      min-width: 18px; height: 18px; border-radius: 9px;
      background: var(--pink); color: #0a0e1a;
      font-size: 10px; font-weight: 700; padding: 0 5px;
      font-family: 'Press Start 2P', monospace;
    }
    .mention-tag {
      color: var(--neon); background: rgba(57,255,122,0.15);
      padding: 1px 5px; border-radius: 2px; font-weight: 700;
    }
    .mention-tag.self {
      color: #0a0e1a; background: var(--neon);
    }
    .chat-input {
      font-family: inherit; background: transparent; border: none;
      color: var(--text); padding: 12px 0; width: 100%;
      font-size: 13px; outline: none; resize: none;
    }
    .sug-item {
      padding: 8px 12px; cursor: pointer; display: flex;
      align-items: center; gap: 10px; font-size: 12px;
    }
    .sug-item:hover, .sug-item.active { background: var(--panel-2); color: var(--neon); }
    .msg-row { padding: 10px 16px; border-bottom: 1px solid rgba(37,43,71,0.5); }
    .msg-row.mentions-me { background: rgba(255,77,141,0.06); border-left: 2px solid var(--pink); }
    @media (max-width: 900px) {
      .week-grid { grid-template-columns: 96px 1fr !important; }
    }
  `;

  const GlobalStyles = () => <style>{styles}</style>;
  const FontLink = () => <link href="https://fonts.googleapis.com/css2?family=Press+Start+2P&family=JetBrains+Mono:wght@400;500;700&display=swap" rel="stylesheet" />;

  if (screen === "loading") {
    return <div className="gg-root" style={{display:'grid',placeItems:'center',minHeight:'100vh'}}>
      <GlobalStyles /><FontLink/>
      <div className="display-font" style={{color:'var(--neon)', fontSize:14}}>LOADING<span className="blink">_</span></div>
    </div>;
  }

  if (screen === "onboard") return <Onboard onCreate={createProfile} styles={styles} />;

  return (
    <div className="gg-root">
      <GlobalStyles />
      <FontLink />

      {/* HEADER */}
      <header style={{borderBottom:'1px solid var(--border)', padding:'18px 24px', display:'flex', justifyContent:'space-between', alignItems:'center', flexWrap:'wrap', gap:12}}>
        <div style={{display:'flex', alignItems:'center', gap:14}}>
          <div className="display-font glow-text" style={{color:'var(--neon)', fontSize:18}}>
            GG<span style={{color:'var(--pink)'}}>/</span>CHECK-IN
          </div>
          <div className="chip" style={{borderColor:'var(--border)', color:'var(--text-dim)'}}>
            <span className="pulse-dot" style={{width:6, height:6, background:'var(--neon)', borderRadius:'50%'}}></span>
            ONLINE
          </div>
        </div>
        <div style={{display:'flex', alignItems:'center', gap:12}}>
          <div style={{display:'flex', alignItems:'center', gap:10}}>
            <div className="avatar" style={{background: me.color}}>{me.handle[0].toUpperCase()}</div>
            <div>
              <div style={{fontSize:11, color:'var(--text-dim)', letterSpacing:'0.1em'}}>PLAYER</div>
              <div style={{fontSize:13, fontWeight:700, letterSpacing:'0.04em'}}>{me.handle}</div>
            </div>
          </div>
        </div>
      </header>

      {/* SQUAD SWITCHER */}
      <div style={{padding:'14px 24px', borderBottom:'1px solid var(--border)', display:'flex', alignItems:'center', gap:10, flexWrap:'wrap'}}>
        <span className="display-font" style={{fontSize:10, color:'var(--text-dim)'}}>SQUAD:</span>
        {squads.length === 0 && <span style={{color:'var(--text-faint)', fontSize:12}}>NO SQUADS — CREATE OR JOIN ONE TO START</span>}
        {squads.map(s => (
          <button
            key={s.code}
            onClick={() => loadSquad(s.code)}
            className="btn"
            style={{
              padding:'6px 12px', fontSize:10,
              borderColor: activeSquad === s.code ? 'var(--neon)' : 'var(--border)',
              color: activeSquad === s.code ? 'var(--neon)' : 'var(--text)',
              boxShadow: activeSquad === s.code ? '0 0 0 1px var(--neon)' : 'none',
            }}
          >
            {s.role === 'owner' && <Crown size={12} />}
            {s.name}
            <span style={{color:'var(--text-faint)', marginLeft:4, fontSize:9}}>#{s.code}</span>
          </button>
        ))}
        <button className="btn btn-primary" style={{padding:'6px 12px', fontSize:10}} onClick={() => setShowJoinCreate(true)}>
          <Plus size={12}/> NEW / JOIN
        </button>
      </div>

      {!activeSquad ? (
        <EmptyState onOpen={() => setShowJoinCreate(true)} />
      ) : (
        <MainView
          me={me}
          squad={squads.find(s => s.code === activeSquad)}
          members={members}
          schedule={schedule}
          squadSchedules={squadSchedules}
          weekStart={weekStart}
          setWeekStart={setWeekStart}
          weekDays={weekDays}
          blockSummary={blockSummary}
          setBlock={setBlock}
          clearBlock={clearBlock}
          copyCode={copyCode}
          leaveSquad={leaveSquad}
          messages={messages}
          sendMessage={sendMessage}
          activity={activity}
          unreadCount={unreadCount}
          markChatRead={markChatRead}
          lastReadTs={lastReadTs}
          polls={polls}
          createPoll={createPoll}
          votePoll={votePoll}
          closePoll={closePoll}
          deletePoll={deletePoll}
          tosses={tosses}
          tossCoin={tossCoin}
          clickerScores={clickerScores}
          addClick={addClick}
          infoEntries={infoEntries}
          saveInfoEntry={saveInfoEntry}
          deleteInfoEntry={deleteInfoEntry}
        />
      )}

      {showJoinCreate && <JoinCreateModal onClose={() => setShowJoinCreate(false)} onCreate={createSquad} onJoin={joinSquad} />}
      {toast && <div className="toast">{toast}</div>}
      {mentionAlert && (
        <div className="mention-alert shake">
          <div style={{display:'flex', alignItems:'center', gap:8, marginBottom:6}}>
            <AtSign size={14} style={{color:'var(--pink)'}}/>
            <div className="display-font" style={{fontSize:9, color:'var(--pink)', letterSpacing:'0.1em'}}>MENTION FROM {mentionAlert.from.toUpperCase()}</div>
            <button className="btn-ghost btn" onClick={() => setMentionAlert(null)} style={{padding:2, marginLeft:'auto'}}>
              <X size={12}/>
            </button>
          </div>
          <div style={{fontSize:12, color:'var(--text)', lineHeight:1.5}}>{mentionAlert.preview}</div>
          <div style={{fontSize:9, color:'var(--text-faint)', marginTop:8, letterSpacing:'0.1em'}}>
            ▸ CHECK THE CHAT TAB
          </div>
        </div>
      )}
    </div>
  );
}

// ====================== ONBOARD ======================
function Onboard({ onCreate, styles }) {
  const [handle, setHandle] = useState("");
  return (
    <div className="gg-root" style={{display:'grid', placeItems:'center', minHeight:'100vh', padding:24}}>
      <style>{styles}</style>
      <link href="https://fonts.googleapis.com/css2?family=Press+Start+2P&family=JetBrains+Mono:wght@400;500;700&display=swap" rel="stylesheet" />
      <div style={{maxWidth:480, width:'100%'}}>
        <div className="display-font glow-text" style={{color:'var(--neon)', fontSize:28, marginBottom:8, textAlign:'center'}}>
          GG<span style={{color:'var(--pink)'}}>/</span>CHECK-IN
        </div>
        <div style={{textAlign:'center', color:'var(--text-dim)', fontSize:12, letterSpacing:'0.15em', marginBottom:40}}>
          ▸ WHEN ARE WE GAMING?
        </div>

        <div className="panel" style={{padding:32}}>
          <div className="display-font" style={{fontSize:11, color:'var(--neon)', marginBottom:16}}>
            ENTER GAMERTAG<span className="blink">_</span>
          </div>
          <input
            className="input"
            placeholder="e.g. ghostwolf_99"
            value={handle}
            onChange={e => setHandle(e.target.value)}
            maxLength={16}
            onKeyDown={e => { if (e.key === "Enter" && handle.trim()) onCreate(handle); }}
            autoFocus
          />
          <div style={{fontSize:10, color:'var(--text-faint)', marginTop:8, letterSpacing:'0.1em'}}>
            16 CHARS MAX · THIS IS HOW YOUR SQUAD WILL SEE YOU
          </div>
          <button
            className="btn btn-primary"
            style={{marginTop:20, width:'100%', justifyContent:'center', padding:'14px'}}
            disabled={!handle.trim()}
            onClick={() => onCreate(handle)}
          >
            <Zap size={14}/> START SESSION
          </button>
        </div>
      </div>
    </div>
  );
}

// ====================== EMPTY STATE ======================
function EmptyState({ onOpen }) {
  return (
    <div style={{display:'grid', placeItems:'center', padding:'80px 24px'}}>
      <div style={{textAlign:'center', maxWidth:480}}>
        <Users size={56} style={{color:'var(--text-faint)', marginBottom:24}} strokeWidth={1.5}/>
        <div className="display-font" style={{fontSize:14, color:'var(--text)', marginBottom:12}}>
          NO SQUAD LOADED
        </div>
        <div style={{color:'var(--text-dim)', fontSize:13, lineHeight:1.7, marginBottom:24}}>
          CREATE A SQUAD TO START POSTING YOUR AVAILABILITY,<br/>
          OR JOIN AN EXISTING ONE WITH A 5-CHAR INVITE CODE.
        </div>
        <button className="btn btn-primary" onClick={onOpen} style={{padding:'14px 24px'}}>
          <Plus size={14}/> CREATE OR JOIN SQUAD
        </button>
      </div>
    </div>
  );
}

// ====================== JOIN/CREATE MODAL ======================
function JoinCreateModal({ onClose, onCreate, onJoin }) {
  const [mode, setMode] = useState("create");
  const [name, setName] = useState("");
  const [code, setCode] = useState("");

  return (
    <div onClick={onClose} style={{position:'fixed', inset:0, background:'rgba(5,8,16,0.85)', zIndex:50, display:'grid', placeItems:'center', padding:24, backdropFilter:'blur(4px)'}}>
      <div onClick={e => e.stopPropagation()} className="panel float-in" style={{width:'100%', maxWidth:440, padding:28}}>
        <div style={{display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:20}}>
          <div className="display-font" style={{color:'var(--neon)', fontSize:12}}>SQUAD.OPS</div>
          <button className="btn-ghost btn" onClick={onClose} style={{padding:4}}><X size={16}/></button>
        </div>

        <div style={{display:'flex', borderBottom:'1px solid var(--border)', marginBottom:20}}>
          <div className={`tab ${mode === 'create' ? 'active' : ''}`} onClick={() => setMode('create')}>+ CREATE</div>
          <div className={`tab ${mode === 'join' ? 'active' : ''}`} onClick={() => setMode('join')}>→ JOIN</div>
        </div>

        {mode === 'create' ? (
          <>
            <div style={{fontSize:10, color:'var(--text-dim)', letterSpacing:'0.12em', marginBottom:8}}>SQUAD NAME</div>
            <input className="input" placeholder="e.g. apex boys" value={name} onChange={e=>setName(e.target.value)} maxLength={20} autoFocus/>
            <div style={{fontSize:10, color:'var(--text-faint)', marginTop:10, lineHeight:1.6}}>
              ▸ YOU'LL GET AN INVITE CODE TO SHARE<br/>
              ▸ SQUAD DATA IS SHARED WITH ALL MEMBERS
            </div>
            <button className="btn btn-primary" style={{marginTop:20, width:'100%', justifyContent:'center', padding:14}} disabled={!name.trim()} onClick={() => onCreate(name)}>
              CREATE SQUAD
            </button>
          </>
        ) : (
          <>
            <div style={{fontSize:10, color:'var(--text-dim)', letterSpacing:'0.12em', marginBottom:8}}>INVITE CODE</div>
            <input className="input" placeholder="ABCDE" value={code} onChange={e=>setCode(e.target.value.toUpperCase())} maxLength={5} style={{fontFamily:"'Press Start 2P', monospace", fontSize:16, letterSpacing:'0.3em', textAlign:'center'}} autoFocus/>
            <div style={{fontSize:10, color:'var(--text-faint)', marginTop:10, lineHeight:1.6}}>
              ▸ 5 CHAR CODE FROM SQUAD OWNER
            </div>
            <button className="btn btn-primary" style={{marginTop:20, width:'100%', justifyContent:'center', padding:14}} disabled={code.length < 5} onClick={() => onJoin(code)}>
              JOIN SQUAD
            </button>
          </>
        )}
      </div>
    </div>
  );
}

// ====================== MAIN VIEW ======================
function MainView({ me, squad, members, schedule, squadSchedules, weekStart, setWeekStart, weekDays, blockSummary, setBlock, clearBlock, copyCode, leaveSquad, messages, sendMessage, activity, unreadCount, markChatRead, lastReadTs, polls, createPoll, votePoll, closePoll, deletePoll, tosses, tossCoin, clickerScores, addClick, infoEntries, saveInfoEntry, deleteInfoEntry }) {
  const [tab, setTab] = useState("mine");
  const [viewMode, setViewMode] = useState("week"); // "week" | "month"
  const [monthAnchor, setMonthAnchor] = useState(() => {
    const d = new Date(); d.setDate(1); d.setHours(0,0,0,0); return d;
  });

  const rangeLabel = `${MONTH_NAMES[weekStart.getMonth()]} ${weekStart.getDate()} → ${MONTH_NAMES[weekDays[6].getMonth()]} ${weekDays[6].getDate()}`;
  const monthLabel = `${MONTH_NAMES[monthAnchor.getMonth()]} ${monthAnchor.getFullYear()}`;

  const bestOverlap = useMemo(() => {
    let best = null;
    for (const d of weekDays) {
      for (const b of TIME_BLOCKS) {
        const count = blockSummary[dayKey(d)]?.[b.id]?.length || 0;
        if (!best || count > best.count) best = { date: d, block: b, count };
      }
    }
    return best && best.count > 0 ? best : null;
  }, [weekDays, blockSummary]);

  // mark chat read when switching TO chat tab
  useEffect(() => {
    if (tab === "chat") markChatRead();
  }, [tab]);

  const showWeekNav = tab === "mine" || tab === "squad";

  return (
    <div style={{padding:'16px 24px 40px', maxWidth:1720, margin:'0 auto'}}>
      {/* SQUAD TOP BAR */}
      <div style={{display:'flex', justifyContent:'space-between', alignItems:'center', flexWrap:'wrap', gap:16, marginBottom:16}}>
        <div>
          <div className="display-font glow-text" style={{color:'var(--neon)', fontSize:16, marginBottom:4}}>
            {squad.name.toUpperCase()}
          </div>
          <div style={{fontSize:11, color:'var(--text-dim)', letterSpacing:'0.1em', display:'flex', alignItems:'center', gap:8, flexWrap:'wrap'}}>
            <span>CODE:</span>
            <button onClick={() => copyCode(squad.code)} className="btn" style={{padding:'3px 8px', fontSize:10, color:'var(--gold)', borderColor:'var(--border)'}}>
              {squad.code} <Copy size={10}/>
            </button>
            <span>·</span>
            <span>{members.length} MEMBER{members.length === 1 ? '' : 'S'}</span>
          </div>
        </div>

        {showWeekNav && (
          <div style={{display:'flex', alignItems:'center', gap:8, flexWrap:'wrap'}}>
            {/* VIEW MODE TOGGLE */}
            <div style={{display:'inline-flex', border:'1px solid var(--border)', borderRadius:2, overflow:'hidden'}}>
              <button
                onClick={() => setViewMode("week")}
                className="btn"
                style={{
                  padding:'8px 12px', fontSize:10, border:'none', borderRadius:0,
                  background: viewMode === "week" ? 'var(--neon)' : 'transparent',
                  color: viewMode === "week" ? '#0a0e1a' : 'var(--text-dim)',
                  fontWeight: viewMode === "week" ? 700 : 400,
                  boxShadow:'none',
                }}
              >WEEK</button>
              <button
                onClick={() => setViewMode("month")}
                className="btn"
                style={{
                  padding:'8px 12px', fontSize:10, border:'none', borderLeft:'1px solid var(--border)', borderRadius:0,
                  background: viewMode === "month" ? 'var(--neon)' : 'transparent',
                  color: viewMode === "month" ? '#0a0e1a' : 'var(--text-dim)',
                  fontWeight: viewMode === "month" ? 700 : 400,
                  boxShadow:'none',
                }}
              >MONTH</button>
            </div>

            {viewMode === "week" ? (
              <>
                <button className="btn" onClick={() => setWeekStart(startOfWeek(new Date()))} style={{padding:'8px 14px', fontSize:10}}>TODAY</button>
                <button className="btn btn-ghost" onClick={() => setWeekStart(addDays(weekStart, -7))} style={{padding:8}}><ChevronLeft size={14}/></button>
                <div className="display-font" style={{fontSize:10, color:'var(--text)', minWidth:140, textAlign:'center'}}>{rangeLabel}</div>
                <button className="btn btn-ghost" onClick={() => setWeekStart(addDays(weekStart, 7))} style={{padding:8}}><ChevronRight size={14}/></button>
              </>
            ) : (
              <>
                <button
                  className="btn"
                  onClick={() => { const d = new Date(); d.setDate(1); d.setHours(0,0,0,0); setMonthAnchor(d); }}
                  style={{padding:'8px 14px', fontSize:10}}
                >THIS MONTH</button>
                <button className="btn btn-ghost" onClick={() => {
                  const d = new Date(monthAnchor); d.setMonth(d.getMonth() - 1); setMonthAnchor(d);
                }} style={{padding:8}}><ChevronLeft size={14}/></button>
                <div className="display-font" style={{fontSize:10, color:'var(--text)', minWidth:120, textAlign:'center'}}>{monthLabel}</div>
                <button className="btn btn-ghost" onClick={() => {
                  const d = new Date(monthAnchor); d.setMonth(d.getMonth() + 1); setMonthAnchor(d);
                }} style={{padding:8}}><ChevronRight size={14}/></button>
              </>
            )}

            <button className="btn" onClick={() => leaveSquad(squad.code)} style={{padding:'8px 12px', fontSize:10, color:'var(--text-dim)'}} title="Leave squad">
              <LogOut size={12}/>
            </button>
          </div>
        )}
        {!showWeekNav && (
          <button className="btn" onClick={() => leaveSquad(squad.code)} style={{padding:'8px 12px', fontSize:10, color:'var(--text-dim)'}} title="Leave squad">
            <LogOut size={12}/> LEAVE
          </button>
        )}
      </div>

      {/* OVERLAP BANNER */}
      {showWeekNav && viewMode === "week" && bestOverlap && bestOverlap.count >= 2 && (
        <div className="panel" style={{padding:'14px 18px', marginBottom:16, borderLeft:'3px solid var(--neon)', display:'flex', alignItems:'center', gap:14, flexWrap:'wrap'}}>
          <Zap size={18} style={{color:'var(--neon)'}}/>
          <div style={{flex:1, minWidth:200}}>
            <div className="display-font" style={{fontSize:10, color:'var(--neon)', marginBottom:3}}>BEST OVERLAP ›</div>
            <div style={{fontSize:13, color:'var(--text)'}}>
              <strong>{DAY_NAMES[bestOverlap.date.getDay()]} {bestOverlap.date.getDate()}</strong> · {bestOverlap.block.label} · <span style={{color:'var(--neon)'}}>{bestOverlap.count} DOWN</span>
            </div>
          </div>
        </div>
      )}

      {/* TABS */}
      <div style={{display:'flex', borderBottom:'1px solid var(--border)', gap:0, overflowX:'auto', scrollbarWidth:'none'}}>
        <div className={`tab ${tab === 'mine' ? 'active' : ''}`} onClick={() => setTab('mine')}>
          ◆ MY WEEK
        </div>
        <div className={`tab ${tab === 'squad' ? 'active' : ''}`} onClick={() => setTab('squad')}>
          ◇ SQUAD VIEW
        </div>
        <div className={`tab ${tab === 'chat' ? 'active' : ''}`} onClick={() => setTab('chat')} style={{display:'flex', alignItems:'center', gap:8}}>
          <MessageSquare size={12}/> CHAT
          {unreadCount > 0 && tab !== 'chat' && <span className="badge">{unreadCount}</span>}
        </div>
        <div className={`tab ${tab === 'activity' ? 'active' : ''}`} onClick={() => setTab('activity')} style={{display:'flex', alignItems:'center', gap:8}}>
          <Bell size={12}/> ACTIVITY
        </div>
        <div className={`tab ${tab === 'polls' ? 'active' : ''}`} onClick={() => setTab('polls')} style={{display:'flex', alignItems:'center', gap:8}}>
          <BarChart3 size={12}/> POLLS
          {polls && polls.some(p => !p.closed) && <span style={{width:6, height:6, borderRadius:'50%', background:'var(--gold)'}}/>}
        </div>
        <div className={`tab ${tab === 'info' ? 'active' : ''}`} onClick={() => setTab('info')} style={{display:'flex', alignItems:'center', gap:8}}>
          <Info size={12}/> INFO
        </div>
        <div className={`tab ${tab === 'clicker' ? 'active' : ''}`} onClick={() => setTab('clicker')} style={{display:'flex', alignItems:'center', gap:8}}>
          <MousePointerClick size={12}/> CLICKER
        </div>
      </div>

      {/* TAB CONTENT */}
      {tab === 'mine' && (
        <>
          {viewMode === "week" ? (
            <MyWeekGrid weekDays={weekDays} schedule={schedule} setBlock={setBlock} clearBlock={clearBlock}/>
          ) : (
            <MyMonthGrid monthAnchor={monthAnchor} schedule={schedule} setBlock={setBlock} clearBlock={clearBlock}/>
          )}
          <Legend/>
        </>
      )}

      {tab === 'squad' && (
        <>
          {viewMode === "week" ? (
            <SquadWeekGrid weekDays={weekDays} members={members} squadSchedules={squadSchedules} blockSummary={blockSummary}/>
          ) : (
            <SquadMonthGrid monthAnchor={monthAnchor} members={members} squadSchedules={squadSchedules}/>
          )}
          <Legend/>
        </>
      )}

      {tab === 'chat' && (
        <div className="panel" style={{marginTop:12, display:'flex', flexDirection:'column', height:'calc(100vh - 280px)', minHeight:500, overflow:'hidden'}}>
          <ChatPanel
            me={me}
            members={members}
            messages={messages}
            sendMessage={sendMessage}
            markChatRead={markChatRead}
            lastReadTs={lastReadTs}
          />
        </div>
      )}

      {tab === 'activity' && (
        <ActivityFeed activity={activity} members={members} me={me}/>
      )}

      {tab === 'polls' && (
        <PollsPanel
          polls={polls}
          me={me}
          createPoll={createPoll}
          votePoll={votePoll}
          closePoll={closePoll}
          deletePoll={deletePoll}
        />
      )}

      {tab === 'clicker' && (
        <ClickerPanel
          squad={squad}
          me={me}
          members={members}
          clickerScores={clickerScores}
          addClick={addClick}
        />
      )}

      {tab === 'info' && (
        <InfoPanel
          entries={infoEntries}
          me={me}
          saveEntry={saveInfoEntry}
          deleteEntry={deleteInfoEntry}
        />
      )}
    </div>
  );
}

// ====================== LEGEND ======================
function Legend() {
  return (
    <div className="panel" style={{padding:'14px 18px', marginTop:16}}>
      <div className="display-font" style={{fontSize:10, color:'var(--text-dim)', marginBottom:10}}>LEGEND</div>
      <div style={{display:'flex', gap:10, flexWrap:'wrap'}}>
        {STATUS_KEYS.map(k => {
          const S = STATUSES[k]; const Icon = S.icon;
          return (
            <div key={k} className="chip" style={{borderColor:S.border, color:S.color, background:S.bg}}>
              <Icon size={11}/> {S.label}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ====================== ACTIVITY FEED ======================
function ActivityFeed({ activity, members, me }) {
  // Render newest first
  const sorted = useMemo(() => [...activity].sort((a,b) => b.ts - a.ts), [activity]);

  if (sorted.length === 0) {
    return (
      <div className="panel" style={{marginTop:12, padding:'60px 24px', textAlign:'center'}}>
        <Bell size={44} style={{color:'var(--text-faint)', marginBottom:18}} strokeWidth={1.5}/>
        <div className="display-font" style={{fontSize:12, color:'var(--text)', marginBottom:10}}>NO ACTIVITY YET</div>
        <div style={{color:'var(--text-dim)', fontSize:12, lineHeight:1.7}}>
          CHECK-INS FROM YOUR SQUAD WILL APPEAR HERE.
        </div>
      </div>
    );
  }

  // format the "when" part of an activity entry like "17.04 evening"
  const formatWhen = (entry) => {
    // entry.dayKey = "YYYY-MM-DD"
    const [y, m, day] = entry.dayKey.split("-");
    return `${day}.${m}`;
  };

  return (
    <div className="panel" style={{marginTop:12, padding:0, overflow:'hidden'}}>
      <div style={{padding:'14px 18px', borderBottom:'1px solid var(--border)', display:'flex', alignItems:'center', gap:10}}>
        <Bell size={14} style={{color:'var(--neon)'}}/>
        <div className="display-font" style={{fontSize:11, color:'var(--neon)'}}>SQUAD ACTIVITY</div>
        <div style={{flex:1}}/>
        <div style={{fontSize:10, color:'var(--text-faint)', letterSpacing:'0.1em'}}>{sorted.length} EVENT{sorted.length === 1 ? '' : 'S'}</div>
      </div>

      <div style={{maxHeight:'calc(100vh - 340px)', minHeight:300, overflowY:'auto'}}>
        {sorted.map(entry => {
          const isMine = entry.from === me.handle;
          const member = members.find(m => m.handle === entry.from);
          const color = entry.color || member?.color || pickColor(entry.from);

          // Membership events render differently (no block/day tag)
          const isMembershipEvent = entry.kind === "joined" || entry.kind === "left" || entry.kind === "created";

          let verb, verbColor, extra = null;
          if (entry.kind === "cleared") {
            verb = "cleared"; verbColor = "var(--text-dim)";
          } else if (entry.kind === "note") {
            const S = STATUSES[entry.status] || STATUSES.down;
            verb = "updated note"; verbColor = "var(--cyan)";
            extra = <span style={{color: S.color, marginLeft:4}}>({S.label.toLowerCase()})</span>;
          } else if (entry.kind === "joined") {
            verb = "joined"; verbColor = "var(--neon)";
            extra = <span style={{color:'var(--gold)', marginLeft:4, fontWeight:700}}>{entry.squadName}</span>;
          } else if (entry.kind === "left") {
            verb = "left"; verbColor = "var(--pink)";
            extra = <span style={{color:'var(--text-dim)', marginLeft:4, fontWeight:700}}>{entry.squadName}</span>;
          } else if (entry.kind === "created") {
            verb = "started the squad"; verbColor = "var(--neon)";
            extra = <span style={{color:'var(--gold)', marginLeft:4, fontWeight:700}}>{entry.squadName}</span>;
          } else {
            // "status"
            const S = STATUSES[entry.status] || STATUSES.down;
            verb = `is ${S.label.toLowerCase()}`;
            verbColor = S.color;
          }

          return (
            <div key={entry.id} style={{
              padding:'12px 18px', borderBottom:'1px solid rgba(37,43,71,0.5)',
              display:'flex', alignItems:'flex-start', gap:12,
              background: isMine ? 'rgba(57,255,122,0.03)' : 'transparent',
            }}>
              <div className="avatar" style={{background: color, width:28, height:28, fontSize:11, flexShrink:0}}>
                {entry.from[0].toUpperCase()}
              </div>
              <div style={{flex:1, minWidth:0}}>
                <div style={{fontSize:13, color:'var(--text)', lineHeight:1.5}}>
                  <span style={{fontWeight:700, color: isMine ? 'var(--neon)' : 'var(--text)'}}>
                    {entry.from}{isMine && <span style={{color:'var(--text-faint)', fontWeight:400, marginLeft:4, fontSize:10}}>(you)</span>}
                  </span>
                  <span style={{color: verbColor, marginLeft:6}}>{verb}</span>
                  {extra}
                  {!isMembershipEvent && (
                    <>
                      <span style={{color:'var(--text-dim)'}}> — </span>
                      <span className="display-font" style={{fontSize:10, color:'var(--gold)'}}>
                        {entry.blockLabel?.toLowerCase()} {formatWhen(entry)}
                      </span>
                    </>
                  )}
                </div>
                {entry.note && (
                  <div style={{
                    marginTop:6, fontSize:12, color:'var(--text)',
                    padding:'6px 10px', background:'var(--bg-2)',
                    borderLeft:`2px solid ${STATUSES[entry.status]?.color || 'var(--neon)'}`,
                    borderRadius:2, display:'inline-block', maxWidth:'100%',
                  }}>
                    “{entry.note}”
                  </div>
                )}
                <div style={{fontSize:10, color:'var(--text-faint)', marginTop:4, letterSpacing:'0.08em'}}>
                  {fmtTime(entry.ts)}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ====================== MY WEEK GRID ======================
function MyWeekGrid({ weekDays, schedule, setBlock, clearBlock }) {
  const [selectedCell, setSelectedCell] = useState(null);
  const [draftNote, setDraftNote] = useState("");
  const popoverRef = useRef(null);
  const today = dayKey(new Date());

  // when opening a cell, seed the draft note from existing
  const openCell = (d, blockId) => {
    const k = dayKey(d);
    const existing = getSlot(schedule[k]?.[blockId]);
    setDraftNote(existing?.note || "");
    setSelectedCell({ date: k, blockId, realDate: d });
  };

  const closeCell = () => { setSelectedCell(null); setDraftNote(""); };

  // Close on click outside popover, or Escape key
  useEffect(() => {
    if (!selectedCell) return;
    const handleDocClick = (e) => {
      // ignore clicks inside the popover or on any day cell (the cell's onClick handles those)
      if (popoverRef.current && popoverRef.current.contains(e.target)) return;
      if (e.target.closest && e.target.closest(".day-cell")) return;
      closeCell();
    };
    const handleKey = (e) => { if (e.key === "Escape") closeCell(); };
    document.addEventListener("mousedown", handleDocClick);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("mousedown", handleDocClick);
      document.removeEventListener("keydown", handleKey);
    };
  }, [selectedCell]);

  return (
    <div className="panel" style={{marginTop:12, padding:0, overflow:'visible'}}>
      <div className="week-grid" style={{display:'grid', gridTemplateColumns:'135px repeat(7, 1fr)', borderBottom:'1px solid var(--border)'}}>
        <div style={{padding:'14px 12px', fontSize:10, color:'var(--text-faint)', letterSpacing:'0.12em'}}>BLOCK</div>
        {weekDays.map(d => {
          const isToday = dayKey(d) === today;
          return (
            <div key={d.toISOString()} style={{
              padding:'12px 8px', textAlign:'center', borderLeft:'1px solid var(--border)',
              background: isToday ? 'rgba(57,255,122,0.05)' : 'transparent',
            }}>
              <div className="display-font" style={{fontSize:9, color: isToday ? 'var(--neon)' : 'var(--text-dim)', marginBottom:4}}>{DAY_NAMES[d.getDay()]}</div>
              <div className="display-font" style={{fontSize:14, color: isToday ? 'var(--neon)' : 'var(--text)'}}>{String(d.getDate()).padStart(2,'0')}</div>
            </div>
          );
        })}
      </div>

      {TIME_BLOCKS.map((block, bi) => (
        <div key={block.id} className="week-grid" style={{
          display:'grid', gridTemplateColumns:'135px repeat(7, 1fr)',
          borderBottom: bi === TIME_BLOCKS.length - 1 ? 'none' : '1px solid var(--border)',
        }}>
          <div style={{padding:'16px 14px', display:'flex', alignItems:'center', borderRight:'1px solid var(--border)'}}>
            <div className="display-font" style={{fontSize:11, color:'var(--text)'}}>{block.label}</div>
          </div>

          {weekDays.map((d, di) => {
            const k = dayKey(d);
            const slot = getSlot(schedule[k]?.[block.id]);
            const S = slot ? STATUSES[slot.status] : null;
            const Icon = S?.icon;
            const isSelected = selectedCell && selectedCell.date === k && selectedCell.blockId === block.id;
            const isLastRow = bi === TIME_BLOCKS.length - 1;
            const isRightEdge = di >= 4; // flip horizontally for Thu-Sat

            return (
              <div
                key={k + block.id}
                className="day-cell"
                onClick={() => isSelected ? closeCell() : openCell(d, block.id)}
                style={{
                  padding:'14px 10px', borderLeft:'1px solid var(--border)',
                  cursor:'pointer', minHeight:110,
                  background: isSelected ? 'var(--panel-2)' : (S ? S.bg : 'transparent'),
                  borderTop: isSelected ? '1px solid var(--neon)' : 'none',
                  borderBottom: isSelected ? '1px solid var(--neon)' : 'none',
                  position:'relative',
                }}
              >
                {S && (
                  <div style={{display:'flex', flexDirection:'column', gap:5, alignItems:'flex-start'}}>
                    <div style={{display:'flex', alignItems:'center', gap:5}}>
                      <Icon size={15} style={{color:S.color}}/>
                      <div className="display-font" style={{fontSize:7, color:S.color, letterSpacing:'0.05em'}}>{S.short}</div>
                    </div>
                    {slot.note && (
                      <div style={{
                        fontSize:10, color:'var(--text)',
                        background:'rgba(0,0,0,0.25)',
                        padding:'2px 5px', borderRadius:2,
                        borderLeft:`2px solid ${S.color}`,
                        maxWidth:'100%', overflow:'hidden',
                        textOverflow:'ellipsis', whiteSpace:'nowrap',
                        lineHeight:1.3,
                      }} title={slot.note}>
                        “{slot.note}”
                      </div>
                    )}
                  </div>
                )}
                {isSelected && (
                  <div ref={popoverRef} style={{
                    position:'absolute',
                    ...(isLastRow
                      ? { bottom: 'calc(100% + 4px)' }
                      : { top: 'calc(100% + 4px)' }),
                    ...(isRightEdge
                      ? { right: 0, left: 'auto' }
                      : { left: 0, right: 'auto' }),
                    zIndex:20, background:'var(--panel)', border:'1px solid var(--neon)',
                    borderRadius:3, padding:8, minWidth:240,
                    boxShadow:'0 8px 32px rgba(0,0,0,0.6), 0 0 0 1px rgba(57,255,122,0.3)',
                  }} onClick={e => e.stopPropagation()}>
                    <div style={{fontSize:9, color:'var(--text-faint)', padding:'4px 4px 8px', letterSpacing:'0.1em'}}>SET STATUS ›</div>
                    {STATUS_KEYS.map(sk => {
                      const Sx = STATUSES[sk]; const IconX = Sx.icon;
                      const isActive = slot?.status === sk;
                      return (
                        <button
                          key={sk}
                          className="status-btn"
                          onClick={() => { setBlock(d, block.id, sk, draftNote); closeCell(); }}
                          style={{
                            borderColor: Sx.border,
                            color: Sx.color,
                            background: isActive ? Sx.bg : 'transparent',
                            marginBottom:4,
                            fontWeight: isActive ? 700 : 400,
                          }}
                        >
                          <IconX size={12}/> {Sx.label}
                          {isActive && <Check size={11} style={{marginLeft:'auto'}}/>}
                        </button>
                      );
                    })}

                    {/* NOTE INPUT */}
                    <div style={{marginTop:8, paddingTop:8, borderTop:'1px solid var(--border)'}}>
                      <div style={{fontSize:10, color:'var(--text)', marginBottom:6, letterSpacing:'0.1em', display:'flex', alignItems:'center', gap:5}}>
                        <MessageSquare size={10}/> NOTE (OPTIONAL)
                      </div>
                      <input
                        className="input"
                        placeholder="e.g. rdy from 18"
                        value={draftNote}
                        onChange={e => setDraftNote(e.target.value)}
                        onKeyDown={e => {
                          if (e.key === "Enter" && slot?.status) {
                            setBlock(d, block.id, slot.status, draftNote);
                            closeCell();
                          }
                          if (e.key === "Escape") closeCell();
                        }}
                        maxLength={60}
                        style={{padding:'8px 10px', fontSize:12}}
                        autoFocus={!!slot}
                      />
                      {slot?.status && (
                        <button
                          className="btn btn-primary"
                          style={{marginTop:6, width:'100%', justifyContent:'center', padding:'8px', fontSize:10}}
                          onClick={() => { setBlock(d, block.id, slot.status, draftNote); closeCell(); }}
                        >
                          <Check size={11}/> SAVE NOTE
                        </button>
                      )}
                    </div>

                    {slot && (
                      <button
                        className="status-btn"
                        onClick={() => { clearBlock(d, block.id); closeCell(); }}
                        style={{color:'var(--text-faint)', fontSize:9, marginTop:4}}
                      >
                        <X size={12}/> CLEAR SLOT
                      </button>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}

// ====================== SQUAD WEEK GRID ======================
function SquadWeekGrid({ weekDays, members, squadSchedules, blockSummary }) {
  const today = dayKey(new Date());

  return (
    <div className="panel" style={{marginTop:12, padding:0, overflow:'hidden'}}>
      <div className="week-grid" style={{display:'grid', gridTemplateColumns:'135px repeat(7, 1fr)', borderBottom:'1px solid var(--border)'}}>
        <div style={{padding:'14px 12px', fontSize:10, color:'var(--text-faint)', letterSpacing:'0.12em'}}>BLOCK</div>
        {weekDays.map(d => {
          const isToday = dayKey(d) === today;
          return (
            <div key={d.toISOString()} style={{
              padding:'12px 8px', textAlign:'center', borderLeft:'1px solid var(--border)',
              background: isToday ? 'rgba(57,255,122,0.05)' : 'transparent',
            }}>
              <div className="display-font" style={{fontSize:9, color: isToday ? 'var(--neon)' : 'var(--text-dim)', marginBottom:4}}>{DAY_NAMES[d.getDay()]}</div>
              <div className="display-font" style={{fontSize:14, color: isToday ? 'var(--neon)' : 'var(--text)'}}>{String(d.getDate()).padStart(2,'0')}</div>
            </div>
          );
        })}
      </div>

      {TIME_BLOCKS.map((block, bi) => (
        <div key={block.id} className="week-grid" style={{
          display:'grid', gridTemplateColumns:'135px repeat(7, 1fr)',
          borderBottom: bi === TIME_BLOCKS.length - 1 ? 'none' : '1px solid var(--border)',
        }}>
          <div style={{padding:'16px 14px', display:'flex', alignItems:'center', borderRight:'1px solid var(--border)'}}>
            <div className="display-font" style={{fontSize:11, color:'var(--text)'}}>{block.label}</div>
          </div>

          {weekDays.map(d => {
            const k = dayKey(d);
            const ready = blockSummary[k]?.[block.id] || [];
            const allSlots = members.map(m => ({
              member: m,
              slot: getSlot(squadSchedules[m.handle]?.[k]?.[block.id]),
            })).filter(x => x.slot);
            const intensity = Math.min(ready.length / Math.max(members.length, 1), 1);

            return (
              <div key={k + block.id} style={{
                padding:'14px 10px', borderLeft:'1px solid var(--border)', minHeight:110,
                background: ready.length > 0 ? `rgba(57,255,122,${0.08 + intensity * 0.18})` : 'transparent',
                position:'relative',
              }}>
                {ready.length >= 2 && (
                  <div style={{position:'absolute', top:4, right:4, fontSize:8, color:'var(--neon)', fontFamily:"'Press Start 2P', monospace"}}>★{ready.length}</div>
                )}
                <div style={{display:'flex', flexWrap:'wrap', gap:4, marginBottom: allSlots.some(x => x.slot.note) ? 5 : 0}}>
                  {allSlots.map(({member, slot}) => {
                    const S = STATUSES[slot.status];
                    return (
                      <div
                        key={member.handle}
                        title={`${member.handle} · ${S.label}${slot.note ? ` — "${slot.note}"` : ''}`}
                        style={{
                          width:22, height:22, borderRadius:2,
                          background: S.color,
                          color: '#0a0e1a',
                          fontSize:10, fontWeight:700,
                          display:'flex', alignItems:'center', justifyContent:'center',
                          fontFamily:"'Press Start 2P', monospace",
                          boxShadow: slot.status === 'down' ? `0 0 8px ${S.color}` : 'none',
                          position:'relative',
                        }}
                      >
                        {member.handle[0].toUpperCase()}
                        {/* member color dot in top-left corner */}
                        <div style={{
                          position:'absolute', top:-2, left:-2,
                          width:7, height:7, borderRadius:'50%',
                          background: member.color,
                          border:'1.5px solid var(--bg-2)',
                        }} title={member.handle}/>
                        {slot.note && (
                          <div style={{
                            position:'absolute', top:-3, right:-3,
                            width:7, height:7, borderRadius:'50%',
                            background: 'var(--cyan)',
                            border:'1.5px solid var(--bg-2)',
                          }}/>
                        )}
                      </div>
                    );
                  })}
                </div>
                {/* show notes compactly */}
                {allSlots.filter(x => x.slot.note).slice(0, 2).map(({member, slot}) => (
                  <div key={member.handle + '-n'} style={{
                    fontSize:9, color:'var(--text-dim)', lineHeight:1.3,
                    whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis',
                  }} title={`${member.handle}: ${slot.note}`}>
                    <span style={{color: member.color, fontWeight:700}}>{member.handle.slice(0,6)}:</span> {slot.note}
                  </div>
                ))}
              </div>
            );
          })}
        </div>
      ))}

      <div style={{borderTop:'1px solid var(--border)', padding:'12px 16px', display:'flex', flexWrap:'wrap', gap:10, alignItems:'center'}}>
        <div className="display-font" style={{fontSize:10, color:'var(--text-dim)'}}>ROSTER:</div>
        {members.map(m => (
          <div key={m.handle} style={{display:'flex', alignItems:'center', gap:6}}>
            <div className="avatar" style={{background:m.color, width:20, height:20, fontSize:9}}>{m.handle[0].toUpperCase()}</div>
            <span style={{fontSize:11, color:'var(--text)'}}>{m.handle}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ====================== MY MONTH GRID ======================
function MyMonthGrid({ monthAnchor, schedule, setBlock, clearBlock }) {
  const [selectedDay, setSelectedDay] = useState(null); // dayKey string
  const rows = useMemo(() => buildMonthGrid(monthAnchor), [monthAnchor]);
  const today = dayKey(new Date());

  return (
    <div style={{marginTop:12}}>
      <div className="panel" style={{padding:0, overflow:'hidden'}}>
        {/* weekday header */}
        <div style={{display:'grid', gridTemplateColumns:'repeat(7, 1fr)', borderBottom:'1px solid var(--border)'}}>
          {DAY_NAMES.map(n => (
            <div key={n} style={{padding:'10px 8px', textAlign:'center', fontSize:9, color:'var(--text-faint)', letterSpacing:'0.14em', fontFamily:"'Press Start 2P', monospace"}}>
              {n}
            </div>
          ))}
        </div>

        {/* grid rows */}
        {rows.map((row, ri) => (
          <div key={ri} style={{display:'grid', gridTemplateColumns:'repeat(7, 1fr)', borderBottom: ri === rows.length - 1 ? 'none' : '1px solid var(--border)'}}>
            {row.map(({date, inMonth}) => {
              const k = dayKey(date);
              const isToday = k === today;
              const daySched = schedule[k] || {};
              const filledBlocks = TIME_BLOCKS.filter(b => getSlot(daySched[b.id]));
              const isSelected = selectedDay === k;

              // Dominant status for cell tint: prefer 'down' > 'maybe' > 'no'
              const priority = ["down","maybe","no"];
              let dominant = null;
              for (const p of priority) {
                if (filledBlocks.some(b => getSlot(daySched[b.id])?.status === p)) { dominant = p; break; }
              }
              const D = dominant ? STATUSES[dominant] : null;

              return (
                <div
                  key={k}
                  onClick={() => setSelectedDay(isSelected ? null : k)}
                  style={{
                    padding:'8px 10px',
                    borderLeft: 'none',
                    borderRight: '1px solid var(--border)',
                    minHeight: 86,
                    cursor: 'pointer',
                    background: isSelected ? 'var(--panel-2)' : (D ? D.bg : 'transparent'),
                    opacity: inMonth ? 1 : 0.35,
                    position: 'relative',
                    outline: isToday ? '1px solid var(--neon)' : 'none',
                    outlineOffset: -1,
                    transition: 'background 0.15s',
                  }}
                >
                  <div style={{display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:6}}>
                    <div className="display-font" style={{
                      fontSize:11,
                      color: isToday ? 'var(--neon)' : (inMonth ? 'var(--text)' : 'var(--text-faint)'),
                    }}>
                      {String(date.getDate()).padStart(2,'0')}
                    </div>
                    {filledBlocks.length > 0 && (
                      <div style={{fontSize:8, color:'var(--text-dim)', fontFamily:"'Press Start 2P', monospace"}}>
                        {filledBlocks.length}/3
                      </div>
                    )}
                  </div>

                  {/* Block dots */}
                  <div style={{display:'flex', flexDirection:'column', gap:3}}>
                    {TIME_BLOCKS.map(b => {
                      const slot = getSlot(daySched[b.id]);
                      const S = slot ? STATUSES[slot.status] : null;
                      return (
                        <div key={b.id} style={{display:'flex', alignItems:'center', gap:5, minHeight:12}}>
                          <div style={{
                            width: 8, height: 8, borderRadius: 2,
                            background: S ? S.color : 'transparent',
                            border: S ? `1px solid ${S.color}` : '1px solid var(--border)',
                            boxShadow: S && slot.status === 'down' ? `0 0 4px ${S.color}` : 'none',
                            flexShrink: 0,
                          }}/>
                          <span style={{
                            fontSize:8, color: S ? S.color : 'var(--text-faint)',
                            letterSpacing:'0.08em', fontFamily:"'Press Start 2P', monospace",
                            textTransform:'uppercase', whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis',
                          }}>
                            {b.label[0]}{slot?.note ? ' •' : ''}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        ))}
      </div>

      {/* DAY DETAIL PANEL */}
      {selectedDay && (
        <MonthDayPanel
          dayKey={selectedDay}
          schedule={schedule}
          setBlock={setBlock}
          clearBlock={clearBlock}
          onClose={() => setSelectedDay(null)}
        />
      )}
    </div>
  );
}

// ====================== MONTH DAY DETAIL PANEL ======================
function MonthDayPanel({ dayKey: dk, schedule, setBlock, clearBlock, onClose }) {
  // Parse dk back to a Date (local midnight)
  const [y, m, d] = dk.split("-").map(Number);
  const date = new Date(y, m - 1, d);
  const daySched = schedule[dk] || {};

  return (
    <div className="panel float-in" style={{marginTop:12, padding:0, overflow:'hidden'}}>
      <div style={{padding:'14px 18px', borderBottom:'1px solid var(--border)', display:'flex', alignItems:'center', gap:10}}>
        <div className="display-font glow-text" style={{fontSize:12, color:'var(--neon)'}}>
          {DAY_NAMES[date.getDay()]} {String(date.getDate()).padStart(2,'0')} {MONTH_NAMES[date.getMonth()]}
        </div>
        <div style={{flex:1}}/>
        <button className="btn btn-ghost" onClick={onClose} style={{padding:4}}><X size={14}/></button>
      </div>

      <div style={{padding:'12px 18px', display:'grid', gridTemplateColumns:'repeat(3, 1fr)', gap:12}}>
        {TIME_BLOCKS.map(block => (
          <MonthBlockEditor
            key={block.id}
            block={block}
            date={date}
            slot={getSlot(daySched[block.id])}
            setBlock={setBlock}
            clearBlock={clearBlock}
          />
        ))}
      </div>
    </div>
  );
}

// Per-block editor card inside MonthDayPanel
function MonthBlockEditor({ block, date, slot, setBlock, clearBlock }) {
  const [draftNote, setDraftNote] = useState(slot?.note || "");

  // sync draftNote when switching days/blocks
  useEffect(() => { setDraftNote(slot?.note || ""); }, [slot?.note, slot?.status]);

  const S = slot ? STATUSES[slot.status] : null;

  return (
    <div style={{
      border: S ? `1px solid ${S.border}` : '1px solid var(--border)',
      borderRadius: 3,
      padding: 12,
      background: S ? S.bg : 'var(--bg-2)',
    }}>
      <div className="display-font" style={{fontSize:10, color: S ? S.color : 'var(--text-dim)', marginBottom:10}}>
        {block.label}
      </div>

      <div style={{display:'flex', flexDirection:'column', gap:5, marginBottom:10}}>
        {STATUS_KEYS.map(sk => {
          const Sx = STATUSES[sk]; const IconX = Sx.icon;
          const isActive = slot?.status === sk;
          return (
            <button
              key={sk}
              className="status-btn"
              onClick={() => setBlock(date, block.id, sk, draftNote)}
              style={{
                borderColor: Sx.border,
                color: Sx.color,
                background: isActive ? 'rgba(0,0,0,0.25)' : 'transparent',
                padding:'8px 10px', fontSize:9,
                fontWeight: isActive ? 700 : 400,
              }}
            >
              <IconX size={11}/> {Sx.label}
              {isActive && <Check size={10} style={{marginLeft:'auto'}}/>}
            </button>
          );
        })}
      </div>

      <div style={{fontSize:10, color:'var(--text)', marginBottom:5, letterSpacing:'0.1em', display:'flex', alignItems:'center', gap:5}}>
        <MessageSquare size={9}/> NOTE
      </div>
      <input
        className="input"
        placeholder="e.g. rdy from 18"
        value={draftNote}
        onChange={e => setDraftNote(e.target.value)}
        onKeyDown={e => {
          if (e.key === "Enter" && slot?.status) setBlock(date, block.id, slot.status, draftNote);
        }}
        maxLength={60}
        style={{padding:'6px 8px', fontSize:11}}
      />
      <div style={{display:'flex', gap:5, marginTop:6}}>
        {slot?.status && (
          <button
            className="btn btn-primary"
            style={{flex:1, justifyContent:'center', padding:'6px', fontSize:9}}
            onClick={() => setBlock(date, block.id, slot.status, draftNote)}
          >
            <Check size={10}/> SAVE
          </button>
        )}
        {slot && (
          <button
            className="btn"
            style={{padding:'6px 10px', fontSize:9, color:'var(--text-faint)'}}
            onClick={() => { clearBlock(date, block.id); setDraftNote(""); }}
          >
            <X size={10}/>
          </button>
        )}
      </div>
    </div>
  );
}

// ====================== SQUAD MONTH GRID ======================
function SquadMonthGrid({ monthAnchor, members, squadSchedules }) {
  const rows = useMemo(() => buildMonthGrid(monthAnchor), [monthAnchor]);
  const today = dayKey(new Date());

  return (
    <div className="panel" style={{marginTop:12, padding:0, overflow:'hidden'}}>
      {/* weekday header */}
      <div style={{display:'grid', gridTemplateColumns:'repeat(7, 1fr)', borderBottom:'1px solid var(--border)'}}>
        {DAY_NAMES.map(n => (
          <div key={n} style={{padding:'10px 8px', textAlign:'center', fontSize:9, color:'var(--text-faint)', letterSpacing:'0.14em', fontFamily:"'Press Start 2P', monospace"}}>
            {n}
          </div>
        ))}
      </div>

      {rows.map((row, ri) => (
        <div key={ri} style={{display:'grid', gridTemplateColumns:'repeat(7, 1fr)', borderBottom: ri === rows.length - 1 ? 'none' : '1px solid var(--border)'}}>
          {row.map(({date, inMonth}) => {
            const k = dayKey(date);
            const isToday = k === today;

            // Compute # down per block + list of down members for the day
            const blockCounts = TIME_BLOCKS.map(b => ({
              block: b,
              down: members.filter(m => getSlot(squadSchedules[m.handle]?.[k]?.[b.id])?.status === "down"),
              maybe: members.filter(m => getSlot(squadSchedules[m.handle]?.[k]?.[b.id])?.status === "maybe"),
            }));
            const maxDown = Math.max(0, ...blockCounts.map(x => x.down.length));
            const anyActivity = blockCounts.some(x => x.down.length + x.maybe.length > 0);

            // Intensity: ratio of best block's down count to total members
            const intensity = Math.min(maxDown / Math.max(members.length, 1), 1);

            return (
              <div
                key={k}
                style={{
                  padding:'8px 10px',
                  borderRight:'1px solid var(--border)',
                  minHeight: 96,
                  background: maxDown > 0 ? `rgba(57,255,122,${0.05 + intensity * 0.2})` : 'transparent',
                  opacity: inMonth ? 1 : 0.35,
                  position:'relative',
                  outline: isToday ? '1px solid var(--neon)' : 'none',
                  outlineOffset: -1,
                }}
              >
                <div style={{display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:6}}>
                  <div className="display-font" style={{
                    fontSize:11,
                    color: isToday ? 'var(--neon)' : (inMonth ? 'var(--text)' : 'var(--text-faint)'),
                  }}>
                    {String(date.getDate()).padStart(2,'0')}
                  </div>
                  {maxDown >= 2 && (
                    <div style={{fontSize:8, color:'var(--neon)', fontFamily:"'Press Start 2P', monospace"}}>
                      ★{maxDown}
                    </div>
                  )}
                </div>

                {anyActivity && (
                  <div style={{display:'flex', flexDirection:'column', gap:3}}>
                    {blockCounts.map(({block, down, maybe}) => {
                      if (down.length === 0 && maybe.length === 0) return (
                        <div key={block.id} style={{height:10}}/>
                      );
                      return (
                        <div key={block.id} style={{display:'flex', alignItems:'center', gap:4, fontSize:9}}>
                          <span style={{
                            fontSize:8, color:'var(--text-faint)', letterSpacing:'0.05em',
                            fontFamily:"'Press Start 2P', monospace", minWidth:10,
                          }}>{block.label[0]}</span>
                          <div style={{display:'flex', gap:2, flexWrap:'wrap', alignItems:'center'}}>
                            {down.slice(0, 4).map(m => (
                              <div
                                key={m.handle}
                                title={`${m.handle} · down · ${block.label.toLowerCase()}`}
                                style={{
                                  width:10, height:10, borderRadius:2,
                                  background: STATUSES.down.color,
                                  boxShadow:`0 0 3px ${STATUSES.down.color}`,
                                  position:'relative',
                                }}
                              >
                                <div style={{
                                  position:'absolute', top:-1, left:-1,
                                  width:4, height:4, borderRadius:'50%',
                                  background: m.color,
                                }}/>
                              </div>
                            ))}
                            {maybe.slice(0, Math.max(0, 4 - down.length)).map(m => (
                              <div
                                key={m.handle}
                                title={`${m.handle} · maybe · ${block.label.toLowerCase()}`}
                                style={{
                                  width:10, height:10, borderRadius:2,
                                  background: STATUSES.maybe.color,
                                  opacity: 0.85,
                                  position:'relative',
                                }}
                              >
                                <div style={{
                                  position:'absolute', top:-1, left:-1,
                                  width:4, height:4, borderRadius:'50%',
                                  background: m.color,
                                }}/>
                              </div>
                            ))}
                            {(down.length + maybe.length) > 4 && (
                              <span style={{fontSize:8, color:'var(--text-dim)', marginLeft:2}}>
                                +{down.length + maybe.length - 4}
                              </span>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      ))}

      {/* roster footer */}
      <div style={{borderTop:'1px solid var(--border)', padding:'12px 16px', display:'flex', flexWrap:'wrap', gap:10, alignItems:'center'}}>
        <div className="display-font" style={{fontSize:10, color:'var(--text-dim)'}}>ROSTER:</div>
        {members.map(m => (
          <div key={m.handle} style={{display:'flex', alignItems:'center', gap:6}}>
            <div className="avatar" style={{background:m.color, width:20, height:20, fontSize:9}}>{m.handle[0].toUpperCase()}</div>
            <span style={{fontSize:11, color:'var(--text)'}}>{m.handle}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ====================== POLLS PANEL ======================
function PollsPanel({ polls, me, createPoll, votePoll, closePoll, deletePoll }) {
  const [creating, setCreating] = useState(false);
  const [question, setQuestion] = useState("");
  const [options, setOptions] = useState(["", ""]);

  const resetForm = () => { setCreating(false); setQuestion(""); setOptions(["", ""]); };

  const submit = () => {
    const cleanOpts = options.map(o => o.trim()).filter(Boolean);
    if (!question.trim() || cleanOpts.length < 2) return;
    createPoll(question, cleanOpts);
    resetForm();
  };

  const updateOption = (i, v) => {
    const next = [...options];
    next[i] = v;
    setOptions(next);
  };
  const addOption = () => { if (options.length < 6) setOptions([...options, ""]); };
  const removeOption = (i) => {
    if (options.length <= 2) return;
    setOptions(options.filter((_, idx) => idx !== i));
  };

  const sorted = useMemo(() => [...polls].sort((a, b) => {
    if (a.closed !== b.closed) return a.closed ? 1 : -1;
    return b.createdAt - a.createdAt;
  }), [polls]);

  return (
    <div style={{marginTop:12}}>
      {/* CREATE */}
      {!creating ? (
        <button className="btn btn-primary" onClick={() => setCreating(true)} style={{padding:'12px 18px', marginBottom:16}}>
          <Plus size={13}/> NEW POLL
        </button>
      ) : (
        <div className="panel" style={{padding:20, marginBottom:16, border:'1px solid var(--neon)', boxShadow:'0 0 0 1px rgba(57,255,122,0.2)'}}>
          <div style={{display:'flex', alignItems:'center', gap:10, marginBottom:14}}>
            <BarChart3 size={14} style={{color:'var(--neon)'}}/>
            <div className="display-font" style={{fontSize:11, color:'var(--neon)'}}>NEW POLL</div>
            <div style={{flex:1}}/>
            <button className="btn btn-ghost" onClick={resetForm} style={{padding:4}}><X size={14}/></button>
          </div>

          <div style={{fontSize:10, color:'var(--text)', marginBottom:6, letterSpacing:'0.1em'}}>QUESTION</div>
          <input
            className="input"
            placeholder="e.g. what are we playing tonight?"
            value={question}
            onChange={e => setQuestion(e.target.value)}
            maxLength={120}
            autoFocus
          />

          <div style={{fontSize:10, color:'var(--text)', marginTop:14, marginBottom:6, letterSpacing:'0.1em'}}>OPTIONS</div>
          {options.map((opt, i) => (
            <div key={i} style={{display:'flex', gap:6, marginBottom:6}}>
              <input
                className="input"
                placeholder={`option ${i + 1}`}
                value={opt}
                onChange={e => updateOption(i, e.target.value)}
                maxLength={60}
                style={{flex:1}}
              />
              {options.length > 2 && (
                <button className="btn btn-ghost" onClick={() => removeOption(i)} style={{padding:'0 10px'}}><X size={12}/></button>
              )}
            </div>
          ))}
          {options.length < 6 && (
            <button className="btn" onClick={addOption} style={{padding:'8px 12px', fontSize:10, marginTop:4}}>
              <Plus size={11}/> ADD OPTION
            </button>
          )}

          <div style={{display:'flex', gap:8, marginTop:18}}>
            <button className="btn btn-primary" onClick={submit} disabled={!question.trim() || options.filter(o => o.trim()).length < 2} style={{flex:1, justifyContent:'center', padding:12}}>
              <Check size={12}/> POST POLL
            </button>
            <button className="btn" onClick={resetForm} style={{padding:12}}>CANCEL</button>
          </div>
        </div>
      )}

      {/* LIST */}
      {sorted.length === 0 ? (
        <div className="panel" style={{padding:'60px 24px', textAlign:'center'}}>
          <BarChart3 size={44} style={{color:'var(--text-faint)', marginBottom:18}} strokeWidth={1.5}/>
          <div className="display-font" style={{fontSize:12, color:'var(--text)', marginBottom:10}}>NO POLLS YET</div>
          <div style={{color:'var(--text-dim)', fontSize:12, lineHeight:1.7}}>
            CREATE A POLL TO SETTLE A DEBATE WITH YOUR SQUAD.
          </div>
        </div>
      ) : (
        sorted.map(poll => <PollCard key={poll.id} poll={poll} me={me} votePoll={votePoll} closePoll={closePoll} deletePoll={deletePoll}/>)
      )}
    </div>
  );
}

function PollCard({ poll, me, votePoll, closePoll, deletePoll }) {
  const votes = poll.votes || {};
  const myVote = votes[me.handle];
  const voteCounts = {};
  poll.options.forEach(o => { voteCounts[o.id] = 0; });
  Object.values(votes).forEach(optId => { if (voteCounts[optId] !== undefined) voteCounts[optId]++; });
  const totalVotes = Object.values(voteCounts).reduce((a, b) => a + b, 0);
  const maxCount = Math.max(0, ...Object.values(voteCounts));
  const isOwner = poll.createdBy === me.handle;

  return (
    <div className="panel" style={{padding:18, marginBottom:12, opacity: poll.closed ? 0.7 : 1}}>
      <div style={{display:'flex', alignItems:'flex-start', gap:10, marginBottom:14}}>
        <div className="avatar" style={{background: poll.createdByColor, width:26, height:26, fontSize:10, flexShrink:0}}>
          {poll.createdBy[0].toUpperCase()}
        </div>
        <div style={{flex:1, minWidth:0}}>
          <div style={{display:'flex', alignItems:'center', gap:8, flexWrap:'wrap', marginBottom:2}}>
            <span style={{fontSize:11, color:'var(--text-dim)'}}>{poll.createdBy} asks</span>
            {poll.closed && <span className="chip" style={{borderColor:'var(--text-faint)', color:'var(--text-faint)', background:'transparent', fontSize:9}}>CLOSED</span>}
          </div>
          <div style={{fontSize:15, color:'var(--text)', fontWeight:700, lineHeight:1.4}}>
            {poll.question}
          </div>
        </div>
        {isOwner && (
          <div style={{display:'flex', gap:4}}>
            {!poll.closed && (
              <button className="btn btn-ghost" onClick={() => closePoll(poll.id)} title="Close poll" style={{padding:'6px 10px', fontSize:9}}>CLOSE</button>
            )}
            <button className="btn btn-ghost" onClick={() => { if (confirm("Delete this poll?")) deletePoll(poll.id); }} title="Delete" style={{padding:6}}>
              <Trash2 size={12}/>
            </button>
          </div>
        )}
      </div>

      <div style={{display:'flex', flexDirection:'column', gap:6}}>
        {poll.options.map(opt => {
          const count = voteCounts[opt.id] || 0;
          const pct = totalVotes > 0 ? Math.round((count / totalVotes) * 100) : 0;
          const isWinning = count > 0 && count === maxCount;
          const isMine = myVote === opt.id;
          return (
            <button
              key={opt.id}
              disabled={poll.closed}
              onClick={() => votePoll(poll.id, opt.id)}
              style={{
                position:'relative', textAlign:'left',
                background:'var(--bg-2)',
                border: `1px solid ${isMine ? 'var(--neon)' : 'var(--border)'}`,
                borderRadius:3, padding:'10px 14px',
                cursor: poll.closed ? 'default' : 'pointer',
                overflow:'hidden',
                transition:'all 0.15s',
                fontFamily:'inherit', color:'var(--text)',
                boxShadow: isMine ? '0 0 0 1px var(--neon)' : 'none',
              }}
              onMouseEnter={e => { if (!poll.closed && !isMine) e.currentTarget.style.borderColor = 'var(--text-dim)'; }}
              onMouseLeave={e => { if (!poll.closed && !isMine) e.currentTarget.style.borderColor = 'var(--border)'; }}
            >
              {/* fill bar */}
              <div style={{
                position:'absolute', top:0, bottom:0, left:0,
                width:`${pct}%`,
                background: isMine ? 'rgba(57,255,122,0.18)' : (isWinning ? 'rgba(255,210,63,0.12)' : 'rgba(110,231,255,0.08)'),
                transition:'width 0.4s',
              }}/>
              <div style={{position:'relative', display:'flex', alignItems:'center', gap:10}}>
                <div style={{flex:1, fontSize:13}}>
                  {opt.text}
                  {isMine && <span style={{color:'var(--neon)', marginLeft:8, fontSize:10, letterSpacing:'0.1em'}}>← YOUR PICK</span>}
                </div>
                <div style={{display:'flex', alignItems:'center', gap:10, fontSize:11, color:'var(--text-dim)', flexShrink:0}}>
                  <span>{count} vote{count === 1 ? '' : 's'}</span>
                  <span className="display-font" style={{fontSize:10, color: isWinning ? 'var(--gold)' : 'var(--text)', minWidth:34, textAlign:'right'}}>
                    {pct}%
                  </span>
                </div>
              </div>
            </button>
          );
        })}
      </div>

      <div style={{marginTop:12, fontSize:10, color:'var(--text-faint)', letterSpacing:'0.08em', display:'flex', gap:10, flexWrap:'wrap'}}>
        <span>{totalVotes} total vote{totalVotes === 1 ? '' : 's'}</span>
        <span>·</span>
        <span>{fmtTime(poll.createdAt)}</span>
        {!poll.closed && !myVote && <span style={{color:'var(--gold)'}}>· TAP TO VOTE</span>}
        {!poll.closed && myVote && <span style={{color:'var(--text-dim)'}}>· TAP AGAIN TO UNVOTE</span>}
      </div>
    </div>
  );
}

// ====================== CLICKER PANEL ======================
function ClickerPanel({ squad, me, members, clickerScores, addClick }) {
  const [burstId, setBurstId] = useState(0);
  const [bursts, setBursts] = useState([]); // {id, x, y}
  const [pressed, setPressed] = useState(false);
  const badgeRef = useRef(null);
  const pressTimerRef = useRef(null);

  const myScore = clickerScores[me.handle] || 0;
  const totalScore = Object.values(clickerScores).reduce((a, b) => a + (b || 0), 0);

  // Sorted leaderboard (desc by score). Always include 'me' even if the
  // members roster hasn't loaded yet — otherwise your own score would
  // silently disappear during transient storage hiccups.
  const ranked = useMemo(() => {
    const rows = members.map(m => ({
      handle: m.handle,
      color: m.color,
      score: clickerScores[m.handle] || 0,
    }));
    if (!rows.find(r => r.handle === me.handle)) {
      rows.push({ handle: me.handle, color: me.color, score: clickerScores[me.handle] || 0 });
    }
    rows.sort((a, b) => b.score - a.score || a.handle.localeCompare(b.handle));
    return rows;
  }, [members, clickerScores, me]);

  const topScore = ranked[0]?.score || 0;

  const handleClick = (e) => {
    addClick();

    // Spawn a floating "+1" particle at the click position
    const rect = badgeRef.current?.getBoundingClientRect();
    let x = 50, y = 50;
    if (rect) {
      const clientX = e.clientX ?? (e.touches && e.touches[0]?.clientX) ?? rect.left + rect.width / 2;
      const clientY = e.clientY ?? (e.touches && e.touches[0]?.clientY) ?? rect.top + rect.height / 2;
      x = ((clientX - rect.left) / rect.width) * 100;
      y = ((clientY - rect.top) / rect.height) * 100;
    }
    const id = burstId + 1;
    setBurstId(id);
    setBursts(prev => [...prev.slice(-20), { id, x, y }]);
    setTimeout(() => {
      setBursts(prev => prev.filter(b => b.id !== id));
    }, 900);

    // Press feedback
    setPressed(true);
    if (pressTimerRef.current) clearTimeout(pressTimerRef.current);
    pressTimerRef.current = setTimeout(() => setPressed(false), 110);
  };

  // Scale down the squad name font if it's long
  const nameLen = squad.name.length;
  const nameFontSize = nameLen <= 8 ? 28 : nameLen <= 12 ? 22 : nameLen <= 16 ? 18 : 15;

  return (
    <div style={{marginTop:12, display:'grid', gridTemplateColumns:'1fr 360px', gap:16}} className="clicker-grid">
      {/* BADGE + MY SCORE */}
      <div className="panel" style={{padding:'28px 24px', display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center', minHeight:460, position:'relative', overflow:'hidden'}}>
        {/* subtle pulsing background */}
        <div style={{
          position:'absolute', inset:0,
          background:'radial-gradient(circle at 50% 45%, rgba(57,255,122,0.08), transparent 65%)',
          pointerEvents:'none',
        }}/>

        <div style={{fontSize:11, color:'var(--text-dim)', letterSpacing:'0.2em', marginBottom:8, fontFamily:"'Press Start 2P', monospace"}}>
          TAP THE BADGE
        </div>

        {/* MY SCORE */}
        <div style={{
          marginBottom:18, textAlign:'center',
          fontFamily:"'Press Start 2P', monospace",
        }}>
          <div style={{fontSize:10, color:'var(--text-faint)', letterSpacing:'0.2em', marginBottom:6}}>YOU</div>
          <div className="glow-text" style={{fontSize:36, color:'var(--neon)', letterSpacing:'0.03em'}}>
            {myScore.toLocaleString()}
          </div>
        </div>

        {/* BADGE */}
        <div
          ref={badgeRef}
          onMouseDown={handleClick}
          onTouchStart={(e) => { e.preventDefault(); handleClick(e); }}
          role="button"
          tabIndex={0}
          onKeyDown={e => { if (e.key === " " || e.key === "Enter") { e.preventDefault(); handleClick(e); } }}
          style={{
            position:'relative',
            width:220, height:220,
            cursor:'pointer',
            userSelect:'none',
            WebkitUserSelect:'none',
            WebkitTapHighlightColor:'transparent',
            transform: pressed ? 'scale(0.93)' : 'scale(1)',
            transition: 'transform 0.09s ease-out',
            outline:'none',
          }}
        >
          {/* Outer ring */}
          <div style={{
            position:'absolute', inset:0,
            borderRadius:'50%',
            background:'conic-gradient(from 0deg, var(--neon), #6EE7FF, var(--gold), var(--neon))',
            padding:4,
            boxShadow:'0 0 48px rgba(57,255,122,0.35), 0 12px 40px rgba(0,0,0,0.5)',
          }}>
            {/* Inner face */}
            <div style={{
              width:'100%', height:'100%',
              borderRadius:'50%',
              background:'radial-gradient(circle at 30% 25%, #1b2440, #0a0e1a 70%)',
              display:'flex', alignItems:'center', justifyContent:'center',
              position:'relative',
              overflow:'hidden',
            }}>
              {/* decorative pixel corners */}
              <div style={{position:'absolute', top:18, left:18, fontSize:10, color:'var(--neon)', fontFamily:"'Press Start 2P', monospace", opacity:0.5}}>◆</div>
              <div style={{position:'absolute', top:18, right:18, fontSize:10, color:'var(--pink)', fontFamily:"'Press Start 2P', monospace", opacity:0.5}}>◆</div>
              <div style={{position:'absolute', bottom:18, left:18, fontSize:10, color:'var(--gold)', fontFamily:"'Press Start 2P', monospace", opacity:0.5}}>◆</div>
              <div style={{position:'absolute', bottom:18, right:18, fontSize:10, color:'var(--cyan)', fontFamily:"'Press Start 2P', monospace", opacity:0.5}}>◆</div>

              {/* SQUAD NAME */}
              <div className="glow-text" style={{
                fontFamily:"'Press Start 2P', monospace",
                fontSize: nameFontSize,
                color:'var(--neon)',
                textAlign:'center',
                padding:'0 24px',
                lineHeight:1.3,
                wordBreak:'break-word',
                letterSpacing:'0.02em',
              }}>
                {squad.name.toUpperCase()}
              </div>
            </div>
          </div>

          {/* +1 burst particles */}
          {bursts.map(b => (
            <div
              key={b.id}
              style={{
                position:'absolute',
                left:`${b.x}%`,
                top:`${b.y}%`,
                transform:'translate(-50%, -50%)',
                pointerEvents:'none',
                animation:'burstRise 0.9s ease-out forwards',
                fontFamily:"'Press Start 2P', monospace",
                fontSize:14,
                color:'var(--neon)',
                textShadow:'0 0 12px var(--neon)',
                fontWeight:700,
                zIndex:5,
              }}
            >
              +1
            </div>
          ))}
        </div>

        <div style={{marginTop:22, fontSize:10, color:'var(--text-faint)', letterSpacing:'0.12em', textAlign:'center', lineHeight:1.8}}>
          ▸ SQUAD TOTAL: <span style={{color:'var(--gold)', fontWeight:700}}>{totalScore.toLocaleString()}</span>
          {topScore > 0 && ranked[0] && (
            <> · 👑 <span style={{color: ranked[0].color, fontWeight:700}}>{ranked[0].handle}</span></>
          )}
        </div>
      </div>

      {/* LEADERBOARD */}
      <div className="panel" style={{display:'flex', flexDirection:'column', minHeight:460, overflow:'hidden'}}>
        <div style={{padding:'14px 18px', borderBottom:'1px solid var(--border)', display:'flex', alignItems:'center', gap:10}}>
          <Trophy size={14} style={{color:'var(--gold)'}}/>
          <div className="display-font" style={{fontSize:11, color:'var(--gold)'}}>HIGHSCORE</div>
          <div style={{flex:1}}/>
          <div style={{fontSize:10, color:'var(--text-faint)', letterSpacing:'0.1em'}}>
            {ranked.length} PLAYER{ranked.length === 1 ? '' : 'S'}
          </div>
        </div>

        <div style={{flex:1, overflowY:'auto'}}>
          {ranked.length === 0 ? (
            <div style={{padding:'40px 20px', textAlign:'center', color:'var(--text-faint)', fontSize:12, lineHeight:1.7}}>
              NO PLAYERS YET.
            </div>
          ) : ranked.map((row, rank) => {
            const isMine = row.handle === me.handle;
            const isLeader = rank === 0 && row.score > 0;
            const pct = topScore > 0 ? (row.score / topScore) * 100 : 0;
            return (
              <div key={row.handle} style={{
                padding:'12px 16px', borderBottom:'1px solid rgba(37,43,71,0.5)',
                display:'flex', alignItems:'center', gap:12,
                background: isMine ? 'rgba(57,255,122,0.05)' : 'transparent',
                position:'relative',
              }}>
                {/* fill bar */}
                <div style={{
                  position:'absolute', left:0, top:0, bottom:0,
                  width:`${pct}%`,
                  background: isLeader ? 'rgba(255,210,63,0.08)' : 'rgba(110,231,255,0.05)',
                  transition:'width 0.3s',
                }}/>

                <div className="display-font" style={{
                  fontSize:11,
                  color: isLeader ? 'var(--gold)' : (rank === 1 ? 'var(--cyan)' : rank === 2 ? 'var(--pink)' : 'var(--text-faint)'),
                  minWidth:26,
                  position:'relative',
                  flexShrink:0,
                }}>
                  {isLeader ? '1st' : rank === 1 ? '2nd' : rank === 2 ? '3rd' : `${rank + 1}th`}
                </div>

                <div className="avatar" style={{background: row.color, width:26, height:26, fontSize:10, flexShrink:0, position:'relative'}}>
                  {row.handle[0].toUpperCase()}
                </div>

                <div style={{flex:1, minWidth:0, position:'relative'}}>
                  <div style={{fontSize:13, color:'var(--text)', fontWeight: isMine ? 700 : 400, display:'flex', alignItems:'center', gap:6}}>
                    <span style={{color: isMine ? 'var(--neon)' : 'var(--text)', whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis'}}>
                      {row.handle}
                    </span>
                    {isMine && <span style={{color:'var(--text-faint)', fontWeight:400, fontSize:10}}>(you)</span>}
                    {isLeader && <Crown size={12} style={{color:'var(--gold)', flexShrink:0}}/>}
                  </div>
                </div>

                <div style={{
                  fontFamily:"'Press Start 2P', monospace",
                  fontSize:12,
                  color: isLeader ? 'var(--gold)' : (isMine ? 'var(--neon)' : 'var(--text)'),
                  flexShrink:0, position:'relative',
                }}>
                  {row.score.toLocaleString()}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      <style>{`
        @keyframes burstRise {
          0%   { opacity: 1; transform: translate(-50%, -50%) scale(0.7); }
          20%  { opacity: 1; transform: translate(-50%, -70%) scale(1.2); }
          100% { opacity: 0; transform: translate(-50%, -160%) scale(1); }
        }
        @media (max-width: 900px) {
          .clicker-grid { grid-template-columns: 1fr !important; }
        }
      `}</style>
    </div>
  );
}

// ====================== INFO PANEL ======================
function InfoPanel({ entries, me, saveEntry, deleteEntry }) {
  const [editing, setEditing] = useState(null); // null | "new" | entry id
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");

  const startNew = () => {
    setTitle(""); setBody("");
    setEditing("new");
  };

  const startEdit = (entry) => {
    setTitle(entry.title);
    setBody(entry.body);
    setEditing(entry.id);
  };

  const cancel = () => { setEditing(null); setTitle(""); setBody(""); };

  const save = () => {
    if (!title.trim() || !body.trim()) return;
    if (editing === "new") {
      saveEntry({ title, body });
    } else {
      saveEntry({ id: editing, title, body });
    }
    cancel();
  };

  // Render a body that auto-detects URLs → clickable links
  const sorted = useMemo(() => [...entries].sort((a, b) => (b.updatedAt || b.createdAt) - (a.updatedAt || a.createdAt)), [entries]);

  return (
    <div style={{marginTop:12}}>
      {/* CREATE / EDIT FORM */}
      {editing ? (
        <div className="panel" style={{padding:20, marginBottom:16, border:'1px solid var(--neon)', boxShadow:'0 0 0 1px rgba(57,255,122,0.2)'}}>
          <div style={{display:'flex', alignItems:'center', gap:10, marginBottom:14}}>
            <Info size={14} style={{color:'var(--neon)'}}/>
            <div className="display-font" style={{fontSize:11, color:'var(--neon)'}}>
              {editing === "new" ? "NEW INFO ENTRY" : "EDIT INFO ENTRY"}
            </div>
            <div style={{flex:1}}/>
            <button className="btn btn-ghost" onClick={cancel} style={{padding:4}}><X size={14}/></button>
          </div>

          <div style={{fontSize:10, color:'var(--text)', marginBottom:6, letterSpacing:'0.1em'}}>TITLE</div>
          <input
            className="input"
            placeholder="e.g. discord server"
            value={title}
            onChange={e => setTitle(e.target.value)}
            maxLength={80}
            autoFocus
          />

          <div style={{fontSize:10, color:'var(--text)', marginTop:14, marginBottom:6, letterSpacing:'0.1em'}}>CONTENT</div>
          <textarea
            className="input"
            placeholder={"one item per line, e.g.\nip: 192.168.1.1:27015\npassword: gamer123\nhttps://discord.gg/abcde"}
            value={body}
            onChange={e => setBody(e.target.value)}
            maxLength={2000}
            rows={5}
            style={{fontFamily:'inherit', resize:'vertical', minHeight:100}}
          />
          <div style={{fontSize:9, color:'var(--text-faint)', marginTop:5, letterSpacing:'0.08em'}}>
            ▸ URLS ARE AUTO-LINKED · {body.length}/2000
          </div>

          <div style={{display:'flex', gap:8, marginTop:18}}>
            <button className="btn btn-primary" onClick={save} disabled={!title.trim() || !body.trim()} style={{flex:1, justifyContent:'center', padding:12}}>
              <Check size={12}/> {editing === "new" ? "POST" : "SAVE"}
            </button>
            <button className="btn" onClick={cancel} style={{padding:12}}>CANCEL</button>
          </div>
        </div>
      ) : (
        <button className="btn btn-primary" onClick={startNew} style={{padding:'12px 18px', marginBottom:16}}>
          <Plus size={13}/> NEW INFO
        </button>
      )}

      {/* LIST */}
      {sorted.length === 0 && !editing ? (
        <div className="panel" style={{padding:'60px 24px', textAlign:'center'}}>
          <Info size={44} style={{color:'var(--text-faint)', marginBottom:18}} strokeWidth={1.5}/>
          <div className="display-font" style={{fontSize:12, color:'var(--text)', marginBottom:10}}>NO INFO YET</div>
          <div style={{color:'var(--text-dim)', fontSize:12, lineHeight:1.7}}>
            POST DISCORD LINKS, SERVER IPS, OR ANY USEFUL SQUAD INFO HERE.
          </div>
        </div>
      ) : (
        <div style={{display:'grid', gridTemplateColumns:'repeat(auto-fill, minmax(340px, 1fr))', gap:12}}>
          {sorted.map(entry => (
            <InfoEntryCard
              key={entry.id}
              entry={entry}
              me={me}
              startEdit={startEdit}
              deleteEntry={deleteEntry}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// Parse an info body into rendered lines with optional copy buttons.
// Each non-empty line becomes { kind, label?, value, copyValue }.
// kind: "labeled" | "url" | "token" | "text"
const parseInfoLines = (text) => {
  const urlRegex = /^(https?:\/\/[^\s]+)$/;
  const tokenLikeRegex = /^\S+$/; // no whitespace at all
  // "label: value" — any short label before a colon
  const colonLabeledRegex = /^([\w\s-]{1,24}):\s*(.+)$/;
  // "label value" — 1 short word of letters/dashes, space, then a value.
  // We require the value to be either a single token OR short (<= ~30 chars)
  // so things like "no griefing please" don't get treated as labeled.
  const spaceLabeledRegex = /^([A-Za-z][A-Za-z-]{1,15})\s+(\S.*)$/;

  return text.split("\n").map((rawLine, idx) => {
    const line = rawLine.trim();
    if (!line) return { kind: "blank", idx };

    // Full URLs get a special kind so the renderer can still linkify them.
    if (urlRegex.test(line)) return { kind: "url", idx, value: line, copyValue: line };

    // "key: value" pairs (but skip if the label is a URL protocol)
    const cm = colonLabeledRegex.exec(line);
    if (cm && !/^https?$/i.test(cm[1].trim())) {
      return { kind: "labeled", idx, label: cm[1].trim(), value: cm[2].trim(), copyValue: cm[2].trim() };
    }

    // Any single-token line (no whitespace) is copyable — codes, PINs, domains, etc.
    if (tokenLikeRegex.test(line)) {
      return { kind: "token", idx, value: line, copyValue: line };
    }

    // "label value" (space-separated). The value part itself must be a single
    // token — otherwise it's prose, not a labeled pair.
    const sm = spaceLabeledRegex.exec(line);
    if (sm) {
      const label = sm[1];
      const value = sm[2];
      if (/^\S+$/.test(value)) {
        return { kind: "labeled", idx, label, value, copyValue: value };
      }
    }

    return { kind: "text", idx, value: line };
  });
};

// Inline value rendering: links are clickable if the value is a URL.
const renderValue = (value) => {
  const urlRegex = /(https?:\/\/[^\s]+)/g;
  const parts = [];
  let lastIdx = 0;
  let m;
  while ((m = urlRegex.exec(value)) !== null) {
    if (m.index > lastIdx) parts.push(value.slice(lastIdx, m.index));
    parts.push(
      <a
        key={m.index}
        href={m[0]}
        target="_blank"
        rel="noopener noreferrer"
        onClick={e => e.stopPropagation()}
        style={{color:'var(--cyan)', textDecoration:'underline', wordBreak:'break-all'}}
      >
        {m[0]}
      </a>
    );
    lastIdx = m.index + m[0].length;
  }
  if (lastIdx < value.length) parts.push(value.slice(lastIdx));
  return parts.length > 0 ? parts : value;
};

function InfoEntryCard({ entry, me, startEdit, deleteEntry }) {
  const [copiedIdx, setCopiedIdx] = useState(null); // index of just-copied line, or 'all'
  const canEdit = entry.createdBy === me.handle || entry.updatedBy === me.handle;
  const lines = useMemo(() => parseInfoLines(entry.body), [entry.body]);
  const copyableCount = lines.filter(l => l.copyValue).length;

  const doCopy = async (text) => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand("copy"); } catch {}
      document.body.removeChild(ta);
    }
  };

  const copyLine = async (idx, text) => {
    await doCopy(text);
    setCopiedIdx(idx);
    setTimeout(() => setCopiedIdx(c => (c === idx ? null : c)), 1400);
  };

  const copyAll = async () => {
    await doCopy(entry.body);
    setCopiedIdx("all");
    setTimeout(() => setCopiedIdx(c => (c === "all" ? null : c)), 1400);
  };

  return (
    <div className="panel" style={{padding:16, display:'flex', flexDirection:'column', gap:10, position:'relative'}}>
      {/* HEADER */}
      <div style={{display:'flex', alignItems:'flex-start', gap:8}}>
        <div style={{flex:1, minWidth:0}}>
          <div className="display-font" style={{fontSize:12, color:'var(--neon)', letterSpacing:'0.05em'}}>
            {entry.title.toUpperCase()}
          </div>
        </div>
        <div style={{display:'flex', gap:2, flexShrink:0}}>
          {copyableCount > 1 && (
            <button
              className="btn btn-ghost"
              onClick={copyAll}
              title="Copy everything"
              style={{
                padding:'4px 8px', fontSize:9,
                color: copiedIdx === "all" ? 'var(--neon)' : 'var(--text-dim)',
                letterSpacing:'0.1em',
              }}
            >
              {copiedIdx === "all" ? <><Check size={11}/> COPIED</> : <><Copy size={11}/> ALL</>}
            </button>
          )}
          <button className="btn btn-ghost" onClick={() => startEdit(entry)} title="Edit" style={{padding:4}}>
            <Edit3 size={11}/>
          </button>
          {canEdit && (
            <button className="btn btn-ghost" onClick={() => { if (confirm("Delete this entry?")) deleteEntry(entry.id); }} title="Delete" style={{padding:4}}>
              <Trash2 size={11}/>
            </button>
          )}
        </div>
      </div>

      {/* LINES */}
      <div style={{display:'flex', flexDirection:'column', gap:6}}>
        {lines.map(line => {
          if (line.kind === "blank") {
            return <div key={line.idx} style={{height:4}}/>;
          }
          if (line.kind === "text") {
            return (
              <div key={line.idx} style={{fontSize:13, color:'var(--text)', lineHeight:1.6, wordBreak:'break-word'}}>
                {renderValue(line.value)}
              </div>
            );
          }
          const justCopied = copiedIdx === line.idx;
          return (
            <div
              key={line.idx}
              style={{
                display:'flex', alignItems:'center', gap:8,
                background: justCopied ? 'rgba(57,255,122,0.1)' : 'var(--bg-2)',
                border: `1px solid ${justCopied ? 'var(--neon)' : 'var(--border)'}`,
                borderRadius:3,
                padding:'8px 10px',
                transition:'all 0.15s',
              }}
            >
              <div style={{flex:1, minWidth:0, display:'flex', alignItems:'baseline', gap:8, flexWrap:'wrap'}}>
                {line.kind === "labeled" && (
                  <span style={{
                    fontSize:10, color:'var(--text-dim)',
                    letterSpacing:'0.1em', textTransform:'uppercase',
                    fontFamily:"'Press Start 2P', monospace",
                    flexShrink:0,
                  }}>
                    {line.label}
                  </span>
                )}
                <span style={{
                  fontSize:13, color:'var(--text)',
                  fontFamily:'ui-monospace, "JetBrains Mono", monospace',
                  wordBreak:'break-all', lineHeight:1.4,
                }}>
                  {renderValue(line.value)}
                </span>
              </div>
              <button
                className="btn btn-ghost"
                onClick={() => copyLine(line.idx, line.copyValue)}
                title={`Copy ${line.kind === "labeled" ? line.label : "value"}`}
                style={{
                  padding:'5px 8px', fontSize:9,
                  color: justCopied ? 'var(--neon)' : 'var(--text-dim)',
                  flexShrink:0, letterSpacing:'0.08em',
                }}
              >
                {justCopied ? <><Check size={11}/> COPIED</> : <Copy size={12}/>}
              </button>
            </div>
          );
        })}
      </div>

      {/* FOOTER */}
      <div style={{fontSize:9, color:'var(--text-faint)', letterSpacing:'0.08em', marginTop:4, paddingTop:8, borderTop:'1px solid var(--border)'}}>
        BY {entry.createdBy.toUpperCase()} · {fmtTime(entry.createdAt)}
        {entry.updatedAt && entry.updatedBy && entry.updatedAt !== entry.createdAt && (
          <span style={{color:'var(--text-dim)'}}> · edited by {entry.updatedBy} {fmtTime(entry.updatedAt)}</span>
        )}
      </div>
    </div>
  );
}

// ====================== CHAT PANEL ======================
function ChatPanel({ me, members, messages, sendMessage, markChatRead, lastReadTs }) {
  const [text, setText] = useState("");
  const [showSuggest, setShowSuggest] = useState(false);
  const [suggestQuery, setSuggestQuery] = useState("");
  const [suggestIdx, setSuggestIdx] = useState(0);
  const inputRef = useRef(null);
  const scrollRef = useRef(null);

  // auto scroll + mark read on messages change
  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    markChatRead();
  }, [messages.length]);

  const suggestions = useMemo(() => {
    const q = suggestQuery.toLowerCase();
    return members.filter(m => m.handle !== me.handle && m.handle.toLowerCase().startsWith(q)).slice(0, 6);
  }, [suggestQuery, members, me]);

  const handleChange = (e) => {
    const v = e.target.value;
    setText(v);
    // detect @mention at cursor
    const caret = e.target.selectionStart;
    const before = v.slice(0, caret);
    const match = before.match(/@(\w*)$/);
    if (match) {
      setShowSuggest(true);
      setSuggestQuery(match[1]);
      setSuggestIdx(0);
    } else {
      setShowSuggest(false);
    }
  };

  const insertMention = (handle) => {
    const caret = inputRef.current?.selectionStart ?? text.length;
    const before = text.slice(0, caret).replace(/@\w*$/, `@${handle} `);
    const after = text.slice(caret);
    const next = before + after;
    setText(next);
    setShowSuggest(false);
    setTimeout(() => {
      inputRef.current?.focus();
      const pos = before.length;
      inputRef.current?.setSelectionRange(pos, pos);
    }, 0);
  };

  const handleKeyDown = (e) => {
    if (showSuggest && suggestions.length) {
      if (e.key === "ArrowDown") { e.preventDefault(); setSuggestIdx((suggestIdx + 1) % suggestions.length); return; }
      if (e.key === "ArrowUp")   { e.preventDefault(); setSuggestIdx((suggestIdx - 1 + suggestions.length) % suggestions.length); return; }
      if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); insertMention(suggestions[suggestIdx].handle); return; }
      if (e.key === "Escape") { setShowSuggest(false); return; }
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleSend = () => {
    const clean = text.trim();
    if (!clean) return;
    // extract mentions
    const found = [];
    const re = /@(\w+)/g;
    let m;
    while ((m = re.exec(clean)) !== null) {
      const handle = m[1];
      if (members.find(x => x.handle === handle) && !found.includes(handle)) found.push(handle);
    }
    sendMessage(clean, found);
    setText("");
    setShowSuggest(false);
  };

  const renderMessageText = (text) => {
    const parts = [];
    const re = /(@\w+)/g;
    let last = 0; let m;
    while ((m = re.exec(text)) !== null) {
      if (m.index > last) parts.push(text.slice(last, m.index));
      const handle = m[1].slice(1);
      const exists = members.find(x => x.handle === handle);
      const isMe = handle === me.handle;
      parts.push(
        <span key={m.index} className={`mention-tag ${isMe ? 'self' : ''}`} style={!exists ? { color: 'var(--text-dim)', background: 'transparent' } : {}}>
          @{handle}
        </span>
      );
      last = m.index + m[1].length;
    }
    if (last < text.length) parts.push(text.slice(last));
    return parts;
  };

  return (
    <>
      {/* chat header */}
      <div style={{padding:'14px 16px', borderBottom:'1px solid var(--border)', display:'flex', alignItems:'center', gap:10}}>
        <MessageSquare size={14} style={{color:'var(--neon)'}}/>
        <div className="display-font" style={{fontSize:11, color:'var(--neon)'}}>SQUAD CHAT</div>
        <div style={{flex:1}}/>
        <div style={{fontSize:10, color:'var(--text-faint)', letterSpacing:'0.1em'}}>
          {messages.length} MSG{messages.length === 1 ? '' : 'S'}
        </div>
      </div>

      {/* messages */}
      <div ref={scrollRef} style={{flex:1, overflowY:'auto', padding:0}}>
        {messages.length === 0 ? (
          <div style={{padding:'40px 20px', textAlign:'center', color:'var(--text-faint)', fontSize:12, lineHeight:1.8}}>
            NO MESSAGES YET.<br/>
            <span style={{fontSize:10}}>TYPE <span className="kbd" style={{padding:'1px 4px', border:'1px solid var(--border)', fontSize:10}}>@</span> TO PING A SQUAD MEMBER.</span>
          </div>
        ) : messages.map(msg => {
          const mentionsMe = (msg.mentions || []).includes(me.handle);
          const isMine = msg.from === me.handle;
          return (
            <div key={msg.id} className={`msg-row ${mentionsMe ? 'mentions-me' : ''}`}>
              <div style={{display:'flex', alignItems:'center', gap:8, marginBottom:5}}>
                <div className="avatar" style={{background: msg.color || pickColor(msg.from), width:22, height:22, fontSize:10}}>
                  {msg.from[0].toUpperCase()}
                </div>
                <div style={{fontSize:12, fontWeight:700, color: isMine ? 'var(--neon)' : 'var(--text)'}}>
                  {msg.from}{isMine && <span style={{color:'var(--text-faint)', fontWeight:400, marginLeft:4, fontSize:10}}>(you)</span>}
                </div>
                <div style={{fontSize:10, color:'var(--text-faint)', marginLeft:'auto'}}>{fmtTime(msg.ts)}</div>
              </div>
              <div style={{fontSize:13, color:'var(--text)', lineHeight:1.5, whiteSpace:'pre-wrap', wordBreak:'break-word', paddingLeft:30}}>
                {renderMessageText(msg.text)}
              </div>
              {mentionsMe && (
                <div style={{paddingLeft:30, marginTop:5, fontSize:9, color:'var(--pink)', letterSpacing:'0.1em', display:'flex', alignItems:'center', gap:4}}>
                  <Bell size={10}/> MENTIONED YOU
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* input */}
      <div style={{borderTop:'1px solid var(--border)', padding:'8px 14px', position:'relative'}}>
        {showSuggest && suggestions.length > 0 && (
          <div style={{
            position:'absolute', bottom:'calc(100% + 4px)', left:14, right:14,
            background:'var(--panel)', border:'1px solid var(--neon)',
            borderRadius:3, padding:4, zIndex:30,
            boxShadow:'0 -4px 20px rgba(0,0,0,0.4), 0 0 0 1px rgba(57,255,122,0.3)',
          }}>
            <div style={{fontSize:9, color:'var(--text-faint)', padding:'4px 8px', letterSpacing:'0.12em'}}>TAG SQUAD MEMBER ›</div>
            {suggestions.map((s, i) => (
              <div key={s.handle} className={`sug-item ${i === suggestIdx ? 'active' : ''}`} onClick={() => insertMention(s.handle)}>
                <div className="avatar" style={{background:s.color, width:20, height:20, fontSize:9}}>{s.handle[0].toUpperCase()}</div>
                <span>{s.handle}</span>
              </div>
            ))}
          </div>
        )}

        <div style={{display:'flex', alignItems:'flex-end', gap:8}}>
          <AtSign size={14} style={{color:'var(--text-faint)', marginBottom:14}}/>
          <textarea
            ref={inputRef}
            className="chat-input"
            placeholder="message squad… use @ to tag"
            value={text}
            onChange={handleChange}
            onKeyDown={handleKeyDown}
            rows={1}
            style={{minHeight:40, maxHeight:120}}
          />
          <button
            className="btn btn-primary"
            onClick={handleSend}
            disabled={!text.trim()}
            style={{padding:'8px 12px', fontSize:10, marginBottom:6}}
          >
            <Send size={12}/>
          </button>
        </div>
      </div>
    </>
  );
}
