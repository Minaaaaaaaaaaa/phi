'use strict';

// ---------- Constants ----------
const PALETTE = ["#8b7fff", "#00b99a", "#eea200", "#e75533", "#b59eaf"];
const COLOR_PICKER_PALETTE = [
  "#8b7fff", "#00b99a", "#eea200", "#e75533", "#b59eaf",
  "#363144", "#4A90D9", "#E8869A", "#5DBB8A", "#F4A34A"
];
const POMO_WORK = 25 * 60;
const POMO_BREAK = 5 * 60;
const DAY_MS = 24 * 60 * 60 * 1000;

// ---------- Supabase ----------
const SUPABASE_URL = 'https://tljigsgrofmgzctrxojc.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InRsamlnc2dyb2ZtZ3pjdHJ4b2pjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODExNzIwODQsImV4cCI6MjA5Njc0ODA4NH0.Mcn_N8zotTmtXT0AXPUD-l8N68Ox8soteqDv4pvltm4';
const supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

let currentUserId = null;   // auth.uid() for all data operations
let appStarted = false;     // guards one-time data load after first auth
// Ids known to exist in Supabase, used to compute deletes when syncing.
let dbSnapshot = { projectHashes: new Map(), taskHashes: new Map(), todaySig: null };

// ---------- State ----------
let state = {
  projects: [],
  todayTasks: [],
  todayDate: null
};

let pomo = {
  taskId: null,
  workMinutes: 25,
  remaining: POMO_WORK,
  running: false,
  mode: 'work', // 'work' | 'break'
  intervalId: null,
  startTime: null, // "HH:MM" of the first play press of the current work cycle
  startedAt: null, // wall-clock ms (Date.now()) of when the current run started/resumed
  durationMs: 0    // intended duration in ms for the current run, from `remaining` at start/resume
};

let phiSessions = []; // global flat array of completed pomodoro sessions
let weekOffset = 0;   // 0 = current week, -1 = previous, +1 = next
let dayStartHour = 0; // first hour shown at the top of the calendar grid (00:00)

let sheetState = {
  newProject: { subtasks: [], editingId: null, dateRef: { deadline: '', repeat: null, repeatDay: null, repeatDate: null } }
};

// ---------- UI preferences (localStorage) ----------
// Only UI preferences live in localStorage now — all app data is in Supabase.
function loadUIPrefs() {
  const mins = parseInt(localStorage.getItem('pomoWorkMinutes'), 10);
  if (!isNaN(mins)) {
    pomo.workMinutes = mins;
    pomo.remaining = pomo.workMinutes * 60;
  }
  const ds = parseInt(localStorage.getItem('weeklyDayStart'), 10);
  if (!isNaN(ds)) dayStartHour = ds;
}

function saveUIPrefs() {
  localStorage.setItem('pomoWorkMinutes', String(pomo.workMinutes));
}

// ---------- Supabase: load ----------
// Fetch all of the signed-in user's data and rebuild the in-memory `state`
// model (nested projects → tasks, a flat todayTasks id list, and phiSessions).
async function loadFromSupabase() {
  if (!currentUserId) {
    console.warn('[load] skipped — no currentUserId.');
    return;
  }

  // Fetch projects, tasks, and today's today_tasks in parallel. None depends on
  // another's result now that tasks are keyed by user_id rather than by the
  // project ids returned from the projects query.
  const today = todayISO();
  const [projectsRes, tasksRes, todayRes] = await Promise.all([
    supabaseClient.from('projects')
      .select('*')
      .eq('user_id', currentUserId)
      .order('order_index'),
    supabaseClient.from('tasks')
      .select('*')
      .eq('user_id', currentUserId)
      .order('order_index'),
    supabaseClient.from('today_tasks')
      .select('*')
      .eq('user_id', currentUserId)
      .eq('date', today)
  ]);
  if (projectsRes.error) throw projectsRes.error;
  if (tasksRes.error) throw tasksRes.error;
  if (todayRes.error) throw todayRes.error;

  const projects = (projectsRes.data || []).map(p => ({
    id: p.id,
    name: p.name,
    color: p.color,
    targetDate: p.target_date,
    createdAt: p.created_at,
    completedCount: p.completed_count,
    totalCount: p.total_count,
    tasks: []
  }));
  const byId = {};
  projects.forEach(p => { byId[p.id] = p; });

  // Tasks arrive ordered by order_index; pushing per-project preserves each
  // project's task order even though the flat result interleaves projects.
  for (const t of (tasksRes.data || [])) {
    const project = byId[t.project_id];
    if (!project) continue;
    project.tasks.push({
      id: t.id,
      text: t.text,
      completed: !!t.completed,
      deadline: t.deadline || null,
      completedAt: t.completed_at || null,
      repeat: t.repeat || null,
      repeatDay: typeof t.repeat_day === 'number' ? t.repeat_day : null,
      repeatDate: typeof t.repeat_date === 'number' ? t.repeat_date : null,
      repeatSpawnedOn: t.repeat_spawned_on || null
    });
  }

  // Backfill cumulative-completion fields when missing.
  for (const p of projects) {
    if (typeof p.totalCount !== 'number') p.totalCount = p.tasks.length;
    if (typeof p.completedCount !== 'number') {
      p.completedCount = p.tasks.filter(t => t.completed).length;
    }
  }

  state.projects = projects;

  // Today tasks — filtered against the now-populated state.projects.
  state.todayTasks = (todayRes.data || [])
    .map(r => r.task_id)
    .filter(id => findTask(id));
  state.todayDate = today;

  // Pomodoro sessions
  const { data: sessionRows, error: sErr } = await supabaseClient.from('pomodoro_sessions')
    .select('*')
    .eq('user_id', currentUserId);
  if (sErr) throw sErr;
  phiSessions = (sessionRows || []).map(s => ({
    id: s.id,
    projectId: s.project_id,
    taskId: s.task_id,
    taskName: s.task_name,
    projectName: s.project_name,
    projectColor: s.project_color,
    date: s.date,
    startTime: s.start_time,
    endTime: s.end_time,
    minutes: s.minutes
  }));
  invalidateSessionsCache();

  // Snapshot the current rows so syncs can compute both changes and deletions.
  // Built with the same helpers the sync uses, so hashes line up and an
  // unchanged first sync writes nothing.
  dbSnapshot.projectHashes = new Map(buildProjectRows().map(r => [r.id, rowHash(r)]));
  dbSnapshot.taskHashes = new Map(buildTaskRows().map(r => [r.id, rowHash(r)]));
  dbSnapshot.todaySig = todayTasksSignature(today);
}

// ---------- Supabase: sync ----------
// `save()` is called from many mutation sites. Rather than rewrite each one as a
// targeted query, we debounce a full diff-sync of projects/tasks/today_tasks.
let syncTimer = null;
let syncing = false;
let syncDirty = false;
function save() {
  if (!currentUserId) {
    console.warn('[save] skipped — no currentUserId yet (not authenticated). Nothing will persist.');
    return;
  }
  syncDirty = true;
  if (syncTimer) clearTimeout(syncTimer);
  syncTimer = setTimeout(runSync, 400);
}

// Run syncs one at a time; if more changes land mid-sync, loop again so nothing
// is dropped.
async function runSync() {
  syncTimer = null;
  if (syncing) return; // in-flight sync will pick up syncDirty when it loops
  syncing = true;
  while (syncDirty) {
    syncDirty = false;
    await syncToSupabase();
  }
  syncing = false;
}

// today_tasks carries no order, so a date + sorted id set fully identifies the
// day's list. Used to skip the delete+insert round-trips when nothing changed.
function todayTasksSignature(dateKey) {
  return dateKey + '|' + [...state.todayTasks].sort().join(',');
}

// Stable content hash for change detection. Keys are always emitted in the same
// order by the builders below, so JSON.stringify is deterministic here.
function rowHash(obj) {
  return JSON.stringify(obj);
}

// The exact rows a full sync would write. Shared by the sync diff and by the
// post-load snapshot so their hashes line up and the first sync writes nothing.
function buildProjectRows() {
  return state.projects.map((p, i) => ({
    id: p.id,
    user_id: currentUserId,
    name: p.name,
    color: p.color,
    order_index: i,
    target_date: p.targetDate || null,
    created_at: p.createdAt,
    completed_count: p.completedCount || 0,
    total_count: p.totalCount || 0
  }));
}

function buildTaskRows() {
  const rows = [];
  state.projects.forEach(p => {
    p.tasks.forEach((t, i) => {
      rows.push({
        id: t.id,
        project_id: p.id,
        user_id: currentUserId,
        text: t.text,
        completed: !!t.completed,
        deadline: t.deadline || null,
        completed_at: t.completedAt || null,
        order_index: i,
        repeat: t.repeat || null,
        repeat_day: typeof t.repeatDay === 'number' ? t.repeatDay : null,
        repeat_date: typeof t.repeatDate === 'number' ? t.repeatDate : null,
        repeat_spawned_on: t.repeatSpawnedOn || null
      });
    });
  });
  return rows;
}

async function syncToSupabase() {
  if (!currentUserId) {
    console.warn('[sync] aborted — no currentUserId.');
    return;
  }
  const today = todayISO();

  try {
    const projectRows = buildProjectRows();
    const taskRows = buildTaskRows();

    // Upsert only rows whose content changed since the last snapshot (a new id
    // has no snapshot hash, so it counts as changed).
    const changedProjects = projectRows.filter(r => dbSnapshot.projectHashes.get(r.id) !== rowHash(r));
    const changedTasks = taskRows.filter(r => dbSnapshot.taskHashes.get(r.id) !== rowHash(r));

    const curProjectIds = new Set(projectRows.map(r => r.id));
    const curTaskIds = new Set(taskRows.map(r => r.id));
    const delProjects = [...dbSnapshot.projectHashes.keys()].filter(id => !curProjectIds.has(id));
    const delTasks = [...dbSnapshot.taskHashes.keys()].filter(id => !curTaskIds.has(id));

    // Only rewrite today_tasks when the day's list actually changed. This is
    // also FK-safe: any task in delTasks that was in today's list would have
    // been removed from state.todayTasks too, which changes the signature — so
    // todayChanged is true whenever a referenced row needs clearing first.
    const todaySig = todayTasksSignature(today);
    const todayChanged = todaySig !== dbSnapshot.todaySig;

    // Clear today's today_tasks first so deleting tasks can't trip a FK.
    let res;
    if (todayChanged) {
      res = await supabaseClient.from('today_tasks').delete().eq('user_id', currentUserId).eq('date', today);
      if (res.error) throw res.error;
    }

    if (changedProjects.length) {
      res = await supabaseClient.from('projects').upsert(changedProjects);
      if (res.error) throw res.error;
    }
    if (changedTasks.length) {
      res = await supabaseClient.from('tasks').upsert(changedTasks);
      if (res.error) throw res.error;
    }
    if (delTasks.length) {
      res = await supabaseClient.from('tasks').delete().in('id', delTasks);
      if (res.error) throw res.error;
    }
    if (delProjects.length) {
      res = await supabaseClient.from('projects').delete().in('id', delProjects);
      if (res.error) throw res.error;
    }
    if (todayChanged && state.todayTasks.length) {
      const rows = state.todayTasks.map(taskId => ({
        user_id: currentUserId,
        date: today,
        task_id: taskId
      }));
      res = await supabaseClient.from('today_tasks').insert(rows);
      if (res.error) throw res.error;
    }

    dbSnapshot.projectHashes = new Map(projectRows.map(r => [r.id, rowHash(r)]));
    dbSnapshot.taskHashes = new Map(taskRows.map(r => [r.id, rowHash(r)]));
    dbSnapshot.todaySig = todaySig;
  } catch (e) {
    // Log the full Supabase error (message / details / hint / code); an RLS
    // rejection surfaces here as code "42501".
    console.error('[sync] failed:', e, '| message:', e && e.message,
      '| details:', e && e.details, '| hint:', e && e.hint, '| code:', e && e.code);
    showToast('저장 중 오류가 발생했어요. 다시 시도해주세요.');
  }
}

// Insert a single completed pomodoro session.
async function insertSession(s) {
  if (!currentUserId) {
    console.warn('[insertSession] skipped — no currentUserId.');
    return;
  }
  try {
    const { error } = await supabaseClient.from('pomodoro_sessions').insert({
      id: s.id,
      user_id: currentUserId,
      project_id: s.projectId,
      task_id: s.taskId,
      task_name: s.taskName,
      project_name: s.projectName,
      project_color: s.projectColor,
      date: s.date,
      start_time: s.startTime,
      end_time: s.endTime,
      minutes: s.minutes
    });
    if (error) throw error;
  } catch (e) {
    console.error('[insertSession] failed:', e, '| message:', e && e.message,
      '| details:', e && e.details, '| hint:', e && e.hint, '| code:', e && e.code);
    showToast('저장 중 오류가 발생했어요. 다시 시도해주세요.');
  }
}

// ---------- Helpers ----------
function uid() {
  // Prefer a real UUID so ids are compatible with uuid/text columns in Supabase.
  if (window.crypto && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
}

function pad(n) { return String(n).padStart(2, '0'); }

function startOfDay(d) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

function diffDays(a, b) {
  return Math.round((startOfDay(a) - startOfDay(b)) / DAY_MS);
}

function fmtTodayHeader() {
  const d = new Date();
  return d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
}

function fmtDeadline(iso) {
  if (!iso) return '';
  const d = new Date(iso + 'T00:00:00');
  const today = startOfDay(new Date());
  const days = diffDays(d, today);
  if (days === 0) return '오늘';
  if (days < 0) return `${-days}일 지남`;
  if (days < 7) return `${days}일 남음`;
  return fmtKoreanShortDate(d);
}

// True when a deadline is in the past (rendered in red on task rows).
function deadlinePassed(iso) {
  if (!iso) return false;
  const d = new Date(iso + 'T00:00:00');
  return diffDays(d, startOfDay(new Date())) < 0;
}

// Date -> "YYYY-MM-DD" (local time). The single source of truth for ISO keys.
function dateISOFromDate(d) {
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
}

function addDays(iso, days) {
  const d = new Date(iso + 'T00:00:00');
  d.setDate(d.getDate() + days);
  return dateISOFromDate(d);
}

function todayISO() {
  return dateISOFromDate(new Date());
}

function blankSubtask() {
  return { id: uid(), text: '', deadline: '', repeat: null, repeatDay: null, repeatDate: null };
}

// A fresh, incomplete task built from a new-project subtask draft.
function taskFromSubtask(s) {
  return {
    id: uid(),
    text: s.text.trim(),
    completed: false,
    deadline: s.deadline || null,
    completedAt: null,
    repeat: s.repeat || null,
    repeatDay: typeof s.repeatDay === 'number' ? s.repeatDay : null,
    repeatDate: typeof s.repeatDate === 'number' ? s.repeatDate : null
  };
}

// "YYYY-MM-DD" -> "N월 N일"
function fmtKoreanMonthDay(iso) {
  if (!iso) return '';
  return fmtKoreanShortDate(new Date(iso + 'T00:00:00'));
}

function clockHHMM() {
  const d = new Date();
  return pad(d.getHours()) + ':' + pad(d.getMinutes());
}

function findTask(taskId) {
  for (const p of state.projects) {
    const t = p.tasks.find(t => t.id === taskId);
    if (t) return { project: p, task: t };
  }
  return null;
}

function nextColor() {
  return PALETTE[state.projects.length % PALETTE.length];
}

function sortTodayTasks(items) {
  // items: [{ project, task }]
  // Incomplete with deadline (asc) → incomplete without deadline → completed
  return items.slice().sort((a, b) => {
    const ac = a.task.completed ? 1 : 0;
    const bc = b.task.completed ? 1 : 0;
    if (ac !== bc) return ac - bc;
    if (ac === 1) return 0; // both completed: stable
    const ad = a.task.deadline || null;
    const bd = b.task.deadline || null;
    if (ad && !bd) return -1;
    if (!ad && bd) return 1;
    if (!ad && !bd) return 0;
    return ad < bd ? -1 : ad > bd ? 1 : 0;
  });
}

function suggestedTasksForToday() {
  const candidates = [];
  for (const p of state.projects) {
    for (const t of p.tasks) {
      if (!t.completed && !state.todayTasks.includes(t.id)) {
        candidates.push({ project: p, task: t });
      }
    }
  }
  if (candidates.length === 0) return [];

  const withDeadline = candidates
    .filter(c => c.task.deadline)
    .sort((a, b) => a.task.deadline < b.task.deadline ? -1 : 1);
  if (withDeadline.length > 0) return withDeadline.slice(0, 3);

  // Fallback: first incomplete task from each project, up to 3
  const seen = new Set();
  const fallback = [];
  for (const c of candidates) {
    if (seen.has(c.project.id)) continue;
    seen.add(c.project.id);
    fallback.push(c);
    if (fallback.length === 3) break;
  }
  return fallback;
}

function closeAllMenus() {
  document.querySelectorAll('.menu-dropdown.open').forEach(d => d.classList.remove('open'));
}

let toastTimer = null;
function showToast(text) {
  const toast = document.getElementById('toast');
  toast.textContent = text;
  toast.classList.add('show');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toast.classList.remove('show');
    toastTimer = null;
  }, 2500);
}

// ---------- Pomodoro session stats ----------
// phiSessions grouped by projectId, built once and reused. A single render pass
// asks for a project's sessions several times (time stats, today total, heatmap)
// across every project, so grouping up front avoids re-scanning the whole array
// each time. Invalidated whenever phiSessions changes (load + new session).
let _sessionsByProject = null;
function sessionsByProject() {
  if (_sessionsByProject) return _sessionsByProject;
  const map = new Map();
  for (const s of phiSessions) {
    let arr = map.get(s.projectId);
    if (!arr) { arr = []; map.set(s.projectId, arr); }
    arr.push(s);
  }
  _sessionsByProject = map;
  return map;
}
function invalidateSessionsCache() { _sessionsByProject = null; }

// All sessions belonging to a project. Shared by the time stats, today total,
// and heatmap.
function projectSessions(project) {
  return sessionsByProject().get(project.id) || [];
}

function projectTimeStats(project) {
  const all = projectSessions(project);
  if (all.length === 0) return null;
  const totalMin = all.reduce((sum, s) => sum + (s.minutes || 0), 0);
  if (totalMin === 0) return null;
  const distinctDates = new Set(all.map(s => s.date)).size || 1;
  const dailyAvg = Math.round(totalMin / distinctDates);
  return {
    totalMin,
    h: Math.floor(totalMin / 60),
    m: totalMin % 60,
    dailyAvg
  };
}

// ---------- Heatmap ----------
function hexToRgb(hex) {
  let h = String(hex || '').replace('#', '');
  if (h.length === 3) h = h.split('').map(c => c + c).join('');
  const num = parseInt(h, 16);
  if (isNaN(num)) return { r: 0, g: 0, b: 0 };
  return { r: (num >> 16) & 255, g: (num >> 8) & 255, b: num & 255 };
}

// Tint the project color by session count: 0 → grey, 1 → 25%, 2 → 60%, 3+ → 100%.
function heatColor(projectColor, count) {
  if (count <= 0) return '#F0F0F0';
  const { r, g, b } = hexToRgb(projectColor);
  const a = count === 1 ? 0.25 : count === 2 ? 0.6 : 1;
  return `rgba(${r}, ${g}, ${b}, ${a})`;
}

// Total focused minutes logged for a project today (from pomodoroSessions).
function projectTodayMinutes(project) {
  const today = todayISO();
  return projectSessions(project)
    .filter(s => s.date === today)
    .reduce((sum, s) => sum + (s.minutes || 0), 0);
}

// Pomodoro-session counts for the last 10 days (index 0 = oldest, 9 = today).
function heatmapCounts(project) {
  const today = todayISO();
  const days = [];
  for (let i = 9; i >= 0; i--) days.push(addDays(today, -i));
  const all = projectSessions(project);
  const counts = days.map(d => all.filter(s => s.date === d).length);
  return { days, counts };
}

function recordPomoSession(taskId, minutes, startTime) {
  if (!taskId) return;
  const found = findTask(taskId);
  if (!found) return;
  const session = {
    id: uid(),
    projectId: found.project.id,
    taskId: taskId,
    taskName: found.task.text,
    projectName: found.project.name,
    projectColor: found.project.color,
    date: todayISO(),
    startTime: startTime || clockHHMM(),
    endTime: clockHHMM(),
    minutes: minutes
  };
  phiSessions.push(session);
  invalidateSessionsCache();
  insertSession(session);
}

// ---------- Daily cleanup: drop completed sub-tasks ----------
function cleanupCompletedSubtasks() {
  let changed = false;
  for (const p of state.projects) {
    const before = p.tasks.length;
    p.tasks = p.tasks.filter(t => !t.completed);
    if (p.tasks.length !== before) changed = true;
  }
  if (changed) {
    state.todayTasks = state.todayTasks.filter(id => findTask(id));
    if (pomo.taskId && !findTask(pomo.taskId)) setPomoTask(null);
  }
  return changed;
}

// On a day change, keep incomplete Today tasks (they carry over) and drop only
// the completed ones. Tasks whose project/subtask no longer exists are dropped too.
function clearCompletedFromToday() {
  state.todayTasks = state.todayTasks.filter(id => {
    const found = findTask(id);
    return found && !found.task.completed;
  });
}

// ---------- Repeating sub-tasks ----------
function repeatDueToday(task, now) {
  if (task.repeat === 'daily') return true;
  if (task.repeat === 'weekly') return now.getDay() === task.repeatDay;
  if (task.repeat === 'monthly') return now.getDate() === task.repeatDate;
  return false;
}

// For each repeating sub-task that is due today (and hasn't already spawned today),
// add a fresh incomplete instance back to the project and pass the repeat config
// forward to that new instance (so exactly one active template exists per series).
function processRepeatingTasks() {
  const today = todayISO();
  const now = new Date();
  let changed = false;
  for (const p of state.projects) {
    const templates = p.tasks.filter(t => t.repeat);
    for (const src of templates) {
      if (src.repeatSpawnedOn === today) continue;
      if (!repeatDueToday(src, now)) continue;
      p.tasks.push({
        id: uid(),
        text: src.text,
        completed: false,
        deadline: today,
        completedAt: null,
        repeat: src.repeat,
        repeatDay: src.repeatDay,
        repeatDate: src.repeatDate,
        repeatSpawnedOn: today
      });
      // The previous instance is no longer the active template for this series.
      src.repeat = null;
      src.repeatDay = null;
      src.repeatDate = null;
      src.repeatSpawnedOn = null;
      changed = true;
    }
  }
  return changed;
}

function runDailyCleanupIfNeeded() {
  const today = todayISO();
  const last = localStorage.getItem('lastCleanupDate');
  if (last !== today) {
    processRepeatingTasks();
    cleanupCompletedSubtasks();
    localStorage.setItem('lastCleanupDate', today);
    save();
  }
}

let midnightCleanupTimer = null;
function scheduleMidnightCleanup() {
  if (midnightCleanupTimer) clearTimeout(midnightCleanupTimer);
  const now = new Date();
  const nextMidnight = new Date(now);
  nextMidnight.setHours(24, 0, 0, 0); // start of tomorrow
  const ms = (nextMidnight - now) + 1000; // small buffer past 00:00
  midnightCleanupTimer = setTimeout(() => {
    processRepeatingTasks();
    cleanupCompletedSubtasks();
    localStorage.setItem('lastCleanupDate', todayISO());
    save();
    renderToday();
    renderProjects();
    scheduleMidnightCleanup(); // re-arm for the next day
  }, ms);
}

// ---------- Render: Today ----------
// Wire every [data-toggle] checkbox within `container` to toggleTask.
function wireTaskToggles(container) {
  container.querySelectorAll('[data-toggle]').forEach(el => {
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleTask(el.dataset.toggle);
    });
  });
}

function renderToday() {
  document.getElementById('today-date').textContent = fmtTodayHeader();

  const content = document.getElementById('today-content');
  content.innerHTML = '';

  if (state.projects.length === 0) {
    content.innerHTML = `
      <div class="empty-state">
        What will you focus on today?
        <div class="empty-state-cta" id="empty-go-projects">Create your first project →</div>
      </div>`;
    document.getElementById('empty-go-projects').addEventListener('click', () => switchTab('projects'));
    return;
  }

  const tasksForToday = sortTodayTasks(
    state.todayTasks.map(id => findTask(id)).filter(Boolean)
  );

  if (tasksForToday.length === 0) {
    const suggestions = suggestedTasksForToday();
    if (suggestions.length > 0) {
      const card = document.createElement('div');
      card.className = 'suggestion-card';
      card.innerHTML = `
        <div class="suggestion-title">이거 먼저 해보는 건 어때요?</div>
        ${suggestions.map(s => `
          <div class="suggestion-task" data-suggest="${s.task.id}">
            <span class="project-line" style="background:${s.project.color}"></span>
            <span class="task-text">${escapeHtml(s.task.text)}</span>
            ${s.task.deadline ? `<span class="pill deadline-pill">${escapeHtml(fmtDeadline(s.task.deadline))}</span>` : ''}
          </div>`).join('')}`;
      content.appendChild(card);
      card.querySelectorAll('[data-suggest]').forEach(el => {
        el.addEventListener('click', () => {
          const id = el.dataset.suggest;
          if (!state.todayTasks.includes(id)) state.todayTasks.push(id);
          save();
          renderToday();
        });
      });
    } else {
      const empty = document.createElement('div');
      empty.className = 'empty-state';
      empty.innerHTML = `
        What will you focus on today?
        <div class="empty-state-cta" id="empty-add-tasks">Add tasks from your projects →</div>`;
      content.appendChild(empty);
      document.getElementById('empty-add-tasks').addEventListener('click', openPicker);
    }
  } else {
    const allDone = tasksForToday.every(({ task }) => task.completed);
    if (allDone) {
      const celebrate = document.createElement('div');
      celebrate.className = 'celebrate';
      celebrate.innerHTML = `
        <div class="celebrate-emoji">🎉</div>
        <div class="celebrate-text">All done for today!</div>`;
      content.appendChild(celebrate);
    }

    const list = document.createElement('div');
    list.className = 'task-list';
    for (const { project, task } of tasksForToday) {
      const row = document.createElement('div');
      row.className = 'task-row' + (task.completed ? ' completed' : '');
      row.innerHTML = `
        <button class="checkbox ${task.completed ? 'checked' : ''}" data-toggle="${task.id}" aria-label="Toggle"></button>
        <span class="project-line" style="background:${project.color}"></span>
        <span class="task-text" data-focus="${task.id}">${escapeHtml(task.text)}</span>
        <span class="pill project-pill">${escapeHtml(project.name)}</span>`;
      list.appendChild(row);
    }
    content.appendChild(list);
  }

  const addBtn = document.createElement('button');
  addBtn.className = 'add-btn';
  addBtn.id = 'open-picker';
  addBtn.textContent = '+ Add from projects';
  content.appendChild(addBtn);
  document.getElementById('open-picker').addEventListener('click', openPicker);

  // Wire checkboxes + focus
  wireTaskToggles(content);
  content.querySelectorAll('[data-focus]').forEach(el => {
    el.addEventListener('click', () => setPomoTask(el.dataset.focus));
  });
}

// ---------- Render: Projects ----------
function renderProjects() {
  const sub = document.getElementById('projects-subtitle');
  sub.textContent = state.projects.length === 0
    ? 'Tap + to start one'
    : `${state.projects.length}개의 프로젝트`;

  const content = document.getElementById('projects-content');
  content.innerHTML = '';

  if (state.projects.length === 0) {
    content.innerHTML = `
      <div class="empty-state">
        No projects yet.
        <div class="empty-state-cta" id="empty-new-project">Create your first project →</div>
      </div>`;
    document.getElementById('empty-new-project').addEventListener('click', () => openProjectSheet());
    return;
  }

  for (const project of state.projects) {
    const timeStats = projectTimeStats(project);
    const card = document.createElement('div');
    card.className = 'project-card';
    card.dataset.projectId = project.id;

    const expanded = project._expanded || false;
    const visibleTasks = expanded ? project.tasks : project.tasks.slice(0, 5);
    // Time pill: default shows today's focused time; click toggles to daily average.
    const timeMode = project._timeMode || 'today';
    const timeText = (timeMode === 'avg')
      ? fmtMinutesKorean('평균', timeStats ? timeStats.dailyAvg : 0)
      : fmtMinutesKorean('오늘', projectTodayMinutes(project));

    const heat = heatmapCounts(project);
    const heatBoxes = heat.counts.map((c, idx) => {
      const isToday = idx === heat.counts.length - 1;
      const outline = isToday ? `;outline:1.5px solid ${project.color};outline-offset:1.5px` : '';
      return `<div class="heat-box${isToday ? ' today' : ''}" style="background:${heatColor(project.color, c)}${outline}"></div>`;
    }).join('');

    card.innerHTML = `
      <div class="project-header">
        <span class="project-dot" style="background:${project.color}"></span>
        <div class="project-name">${escapeHtml(project.name)}</div>
        <div class="card-menu">
          <button class="menu-trigger" data-menu="${project.id}" aria-label="Project menu">⋯</button>
          <div class="menu-dropdown" data-menu-for="${project.id}">
            <button data-action="color" data-project="${project.id}">색상 변경</button>
            <button data-action="edit" data-project="${project.id}">수정</button>
            <button class="danger" data-action="delete" data-project="${project.id}">삭제</button>
          </div>
        </div>
      </div>
      <div class="project-heat-row">
        <div class="project-heatmap">${heatBoxes}</div>
        <button class="project-time-inline" data-time-toggle="${project.id}">${escapeHtml(timeText)}</button>
      </div>
      <div class="project-tasks">
        ${visibleTasks.map(t => `
          <div class="project-task ${t.completed ? 'completed' : ''}" data-task-row="${t.id}">
            <button class="checkbox ${t.completed ? 'checked' : ''}" data-toggle="${t.id}" aria-label="Toggle"></button>
            <span class="task-text">${escapeHtml(t.text)}</span>
            ${t.deadline ? `<span class="task-deadline${deadlinePassed(t.deadline) ? ' overdue' : ''}">${escapeHtml(fmtDeadline(t.deadline))}</span>` : ''}
          </div>`).join('')}
      </div>
      ${project.tasks.length > 5 ? `<button class="expand-btn" data-expand="${project.id}">${expanded ? 'show less' : 'show more'}</button>` : ''}`;
    content.appendChild(card);
  }

  wireTaskToggles(content);
  content.querySelectorAll('[data-expand]').forEach(el => {
    el.addEventListener('click', () => {
      const p = state.projects.find(x => x.id === el.dataset.expand);
      if (p) {
        p._expanded = !p._expanded;
        renderProjects();
      }
    });
  });
  content.querySelectorAll('[data-time-toggle]').forEach(el => {
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      const p = state.projects.find(x => x.id === el.dataset.timeToggle);
      if (!p) return;
      p._timeMode = (p._timeMode === 'avg') ? 'today' : 'avg';
      renderProjects();
    });
  });
  content.querySelectorAll('[data-menu]').forEach(el => {
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      const id = el.dataset.menu;
      const dropdown = content.querySelector(`[data-menu-for="${id}"]`);
      const wasOpen = dropdown.classList.contains('open');
      closeAllMenus();
      if (!wasOpen) dropdown.classList.add('open');
    });
  });
  content.querySelectorAll('[data-action="color"]').forEach(el => {
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      closeAllMenus();
      openColorPicker(el.dataset.project);
    });
  });
  content.querySelectorAll('[data-action="edit"]').forEach(el => {
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      closeAllMenus();
      openProjectSheet(el.dataset.project);
    });
  });
  content.querySelectorAll('[data-action="delete"]').forEach(el => {
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      closeAllMenus();
      const id = el.dataset.project;
      const project = state.projects.find(p => p.id === id);
      if (!project) return;
      if (confirm(`Delete "${project.name}"?`)) {
        deleteProject(id);
      }
    });
  });

  // Drag-to-reorder for project cards (whole-card; long-press on touch)
  attachCardDrag(content, (from, to) => {
    const [moved] = state.projects.splice(from, 1);
    state.projects.splice(to, 0, moved);
    save();
    renderProjects();
  });
}

function attachCardDrag(container, onReorder) {
  const cards = Array.from(container.querySelectorAll('.project-card'));
  let drag = null;
  let pressTimer = null;
  let pressStart = null;

  const idxOf = el => cards.indexOf(el);
  const clearTargets = () => cards.forEach(c => c.classList.remove('drop-target'));
  const isInteractive = (target) =>
    !!target.closest('button, input, a, .menu-dropdown, .project-task');

  cards.forEach(card => {
    card.draggable = true;

    card.addEventListener('dragstart', (e) => {
      if (isInteractive(e.target)) { e.preventDefault(); return; }
      drag = { type: 'html5', card, from: idxOf(card) };
      card.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      try { e.dataTransfer.setData('text/plain', String(idxOf(card))); } catch (_) {}
    });

    card.addEventListener('dragend', () => {
      card.classList.remove('dragging');
      clearTargets();
      drag = null;
    });

    card.addEventListener('dragover', (e) => {
      if (!drag || drag.type !== 'html5' || drag.card === card) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      clearTargets();
      card.classList.add('drop-target');
    });

    card.addEventListener('drop', (e) => {
      if (!drag || drag.type !== 'html5') return;
      e.preventDefault();
      const to = idxOf(card);
      const from = drag.from;
      clearTargets();
      if (from !== to) onReorder(from, to);
    });

    // Touch: long-press (300ms) on a non-interactive area to start drag
    card.addEventListener('touchstart', (e) => {
      if (isInteractive(e.target)) return;
      if (e.touches.length !== 1) return;
      const t = e.touches[0];
      pressStart = { x: t.clientX, y: t.clientY };
      pressTimer = setTimeout(() => {
        pressTimer = null;
        drag = {
          type: 'touch',
          card,
          from: idxOf(card),
          startY: t.clientY,
          targetIdx: -1
        };
        card.classList.add('dragging');
      }, 300);
    }, { passive: true });

    card.addEventListener('touchmove', (e) => {
      const t = e.touches[0];
      // Before long-press fires: cancel if the user starts scrolling
      if (pressTimer && pressStart) {
        const dx = Math.abs(t.clientX - pressStart.x);
        const dy = Math.abs(t.clientY - pressStart.y);
        if (dx > 8 || dy > 8) {
          clearTimeout(pressTimer);
          pressTimer = null;
          pressStart = null;
        }
        return;
      }
      if (!drag || drag.type !== 'touch' || drag.card !== card) return;
      e.preventDefault();
      const dy = t.clientY - drag.startY;
      card.style.transform = `translateY(${dy}px) scale(1.02)`;
      card.style.position = 'relative';
      let target = -1;
      cards.forEach((other, idx) => {
        if (other === card) return;
        const r = other.getBoundingClientRect();
        if (t.clientY >= r.top && t.clientY <= r.bottom) target = idx;
      });
      clearTargets();
      if (target >= 0) cards[target].classList.add('drop-target');
      drag.targetIdx = target;
    }, { passive: false });

    const finishTouch = () => {
      if (pressTimer) {
        clearTimeout(pressTimer);
        pressTimer = null;
        pressStart = null;
      }
      if (!drag || drag.type !== 'touch' || drag.card !== card) return;
      card.style.transform = '';
      card.style.position = '';
      card.classList.remove('dragging');
      clearTargets();
      const { from, targetIdx } = drag;
      drag = null;
      if (targetIdx >= 0 && targetIdx !== from) onReorder(from, targetIdx);
    };
    card.addEventListener('touchend', finishTouch);
    card.addEventListener('touchcancel', finishTouch);
  });
}

// ---------- Actions ----------
function toggleTask(taskId) {
  const found = findTask(taskId);
  if (!found) return;
  const becameComplete = !found.task.completed;

  // Capture pre-render task-row positions for FLIP animation
  let oldPositions = null;
  if (becameComplete) {
    const cardEl = document.querySelector(`.project-card[data-project-id="${found.project.id}"]`);
    if (cardEl) {
      oldPositions = new Map();
      cardEl.querySelectorAll('.project-task').forEach(el => {
        const id = el.dataset.taskRow;
        if (id) oldPositions.set(id, el.getBoundingClientRect().top);
      });
    }
  }

  found.task.completed = !found.task.completed;
  found.task.completedAt = found.task.completed ? new Date().toISOString() : null;

  // Move newly-completed task to the end of its project's task array
  if (becameComplete) {
    // Cumulative counter only ever grows; un-checking does not decrement it.
    found.project.completedCount = (found.project.completedCount || 0) + 1;
    const tasks = found.project.tasks;
    const idx = tasks.indexOf(found.task);
    if (idx >= 0 && idx < tasks.length - 1) {
      tasks.splice(idx, 1);
      tasks.push(found.task);
    }
  }

  save();
  if (becameComplete && state.todayTasks.includes(taskId)) {
    showToast(`오늘 ${found.task.text} 완료! 🎉`);
  }
  renderToday();
  renderProjects();

  // FLIP: apply inverse transforms synchronously, then animate to 0
  if (oldPositions) {
    const newCardEl = document.querySelector(`.project-card[data-project-id="${found.project.id}"]`);
    if (!newCardEl) return;
    const moving = [];
    newCardEl.querySelectorAll('.project-task').forEach(el => {
      const id = el.dataset.taskRow;
      if (!id) return;
      const oldTop = oldPositions.get(id);
      if (oldTop === undefined) return;
      const newTop = el.getBoundingClientRect().top;
      const delta = oldTop - newTop;
      if (Math.abs(delta) < 0.5) return;
      el.style.transition = 'none';
      el.style.transform = `translateY(${delta}px)`;
      moving.push(el);
    });
    if (moving.length > 0) {
      void newCardEl.offsetHeight; // force reflow
      requestAnimationFrame(() => {
        moving.forEach(el => {
          el.style.transition = 'transform 0.2s ease';
          el.style.transform = '';
        });
      });
    }
  }
}

function deleteProject(projectId) {
  state.projects = state.projects.filter(p => p.id !== projectId);
  state.todayTasks = state.todayTasks.filter(taskId => findTask(taskId));
  if (pomo.taskId && !findTask(pomo.taskId)) {
    setPomoTask(null);
  }
  save();
  renderToday();
  renderProjects();
}

// ---------- Weekly view ----------
const KOR_DAYS_SHORT = ['월', '화', '수', '목', '금', '토', '일'];
const HOURS_VISIBLE = 24; // grid covers 24 hours from dayStartHour (00:00 → next 00:00)

function getWeekDates(offset) {
  const today = startOfDay(new Date());
  const dow = today.getDay(); // 0=Sun..6=Sat
  const mondayIdx = (dow + 6) % 7; // 0=Mon..6=Sun
  const monday = new Date(today);
  monday.setDate(today.getDate() - mondayIdx + (offset * 7));
  const days = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(monday);
    d.setDate(monday.getDate() + i);
    days.push(d);
  }
  return days;
}

function fmtKoreanShortDate(d) {
  return (d.getMonth() + 1) + '월 ' + d.getDate() + '일';
}

// Korean minute/hour label with a prefix, e.g. "평균" or "총":
// under 60 → "NN분", exactly 60 → "1시간", over 60 → "1시간 NN분"
function fmtMinutesKorean(prefix, totalMin) {
  if (totalMin < 60) return `${prefix} ${totalMin}분`;
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return m === 0 ? `${prefix} ${h}시간` : `${prefix} ${h}시간 ${m}분`;
}

function saveDayStart() {
  localStorage.setItem('weeklyDayStart', String(dayStartHour));
}

function startOffsetForTime(hour, minute) {
  // Returns the y-pixel offset (1px = 1min) from the top of the grid for a given clock time.
  let offset = (hour * 60 + minute) - (dayStartHour * 60);
  if (offset < 0) offset += 24 * 60;
  return offset;
}

function renderWeekly() {
  const days = getWeekDates(weekOffset);
  const dayISOs = days.map(dateISOFromDate);
  const todayISOStr = todayISO();

  // Header range
  document.getElementById('weekly-range').textContent =
    fmtKoreanShortDate(days[0]) + ' — ' + fmtKoreanShortDate(days[6]);

  // Day-start pills
  document.querySelectorAll('#cal-start-pills button').forEach(btn => {
    btn.classList.toggle('active', parseInt(btn.dataset.start) === dayStartHour);
  });

  // Day header
  const header = document.getElementById('cal-day-header');
  header.innerHTML = '<div class="cal-day-header-spacer"></div>' +
    days.map((d, i) => {
      const isToday = dateISOFromDate(d) === todayISOStr;
      return `<div class="cal-day-head${isToday ? ' today' : ''}">
        ${KOR_DAYS_SHORT[i]}
        <div class="cal-day-num">${d.getDate()}</div>
      </div>`;
    }).join('');

  // Body
  const body = document.getElementById('cal-body');
  body.innerHTML = '';

  // Time axis column (24 labels: dayStartHour ... dayStartHour-1 next day)
  const timeCol = document.createElement('div');
  timeCol.className = 'cal-time-col';
  for (let h = 0; h <= HOURS_VISIBLE; h++) {
    // Hide the 00:00 label at the very top (h=0) and very bottom (h=24).
    if (h === 0 || h === HOURS_VISIBLE) continue;
    const hour = (dayStartHour + h) % 24;
    const lbl = document.createElement('div');
    lbl.className = 'cal-time-label';
    lbl.textContent = pad(hour) + ':00';
    lbl.style.top = (h * 60) + 'px';
    timeCol.appendChild(lbl);
  }
  body.appendChild(timeCol);

  // 7 day columns
  const dayCols = [];
  days.forEach((d, i) => {
    const col = document.createElement('div');
    col.className = 'cal-day-col' + (dateISOFromDate(d) === todayISOStr ? ' today' : '');
    body.appendChild(col);
    dayCols.push(col);
  });

  // Horizontal hour guide lines (spanning all day cols)
  for (let h = 1; h < HOURS_VISIBLE; h++) {
    const line = document.createElement('div');
    line.className = 'cal-hour-line';
    line.style.top = (h * 60) + 'px';
    body.appendChild(line);
  }

  // Sessions
  const weekSessions = phiSessions.filter(s => dayISOs.includes(s.date));
  for (const s of weekSessions) {
    const colIdx = dayISOs.indexOf(s.date);
    if (colIdx < 0) continue;
    const parts = String(s.startTime || '0:0').split(':');
    const sh = parseInt(parts[0]) || 0;
    const sm = parseInt(parts[1]) || 0;
    const topOffset = startOffsetForTime(sh, sm);
    if (topOffset < 0 || topOffset >= HOURS_VISIBLE * 60) continue;

    const height = Math.max(8, s.minutes);
    const showName = s.minutes >= 25;
    const block = document.createElement('div');
    block.className = 'cal-session' + (showName ? '' : ' tiny');
    block.style.background = s.projectColor || PALETTE[0];
    block.style.top = topOffset + 'px';
    block.style.height = height + 'px';
    block.dataset.sessionId = s.id;

    if (showName) {
      block.innerHTML = `<div class="cal-session-name">${escapeHtml(s.projectName)}</div>`;
    }

    block.addEventListener('click', (e) => {
      e.stopPropagation();
      showSessionTooltip(s);
    });

    dayCols[colIdx].appendChild(block);
  }

  // Now indicator (current week only)
  if (weekOffset === 0) {
    const now = new Date();
    const nowOffset = startOffsetForTime(now.getHours(), now.getMinutes());
    if (nowOffset >= 0 && nowOffset < HOURS_VISIBLE * 60) {
      const nowLine = document.createElement('div');
      nowLine.className = 'cal-now-line';
      nowLine.style.top = nowOffset + 'px';
      body.appendChild(nowLine);
    }
  }

  // Empty state (summary bar removed)
  if (weekSessions.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'cal-empty';
    empty.innerHTML = '아직 집중 기록이 없어요.<br>포모도로를 완료하면 여기에 쌓여요.';
    body.appendChild(empty);
  }

  // Auto-scroll: position the focus time in the middle of the viewport
  requestAnimationFrame(scrollWeeklyToFocus);
}

function scrollWeeklyToFocus() {
  const body = document.getElementById('cal-body');
  if (!body) return;
  // Position 09:00 in the center of the visible area.
  const targetMinute = 9 * 60;
  let offset = startOffsetForTime(Math.floor(targetMinute / 60), targetMinute % 60);
  if (offset < 0) offset = 0;
  if (offset > HOURS_VISIBLE * 60) offset = HOURS_VISIBLE * 60;

  // The document body is the scroller now, so scroll the window to center the
  // target time. cal-body's document-relative top + the in-grid offset, minus
  // half the viewport, lands 09:00 in the middle.
  const bodyTopInDoc = body.getBoundingClientRect().top + window.scrollY;
  const target = bodyTopInDoc + offset - window.innerHeight / 2;
  window.scrollTo(0, Math.max(0, target));
}

function showSessionTooltip(s) {
  const tip = document.getElementById('session-tooltip');
  tip.innerHTML =
    `<strong>${escapeHtml(s.projectName)}</strong> — ${escapeHtml(s.taskName)}<br>` +
    `${escapeHtml(s.startTime)} ~ ${escapeHtml(s.endTime)} (${s.minutes}분)`;
  tip.classList.add('show');
}

// ---------- Pomodoro ----------
function fmtTime(s) {
  const m = Math.floor(s / 60);
  const r = s % 60;
  return pad(m) + ':' + pad(r);
}

function setPomoTask(taskId) {
  // While running, don't allow switching tasks. Internal clears (null) are allowed.
  if (pomo.running && taskId !== null) {
    if (taskId !== pomo.taskId) {
      showToast('집중 중이에요. 타이머를 완료하거나 취소 후 변경해주세요.');
    }
    return;
  }
  pomo.taskId = taskId;
  pomo.remaining = pomo.workMinutes * 60;
  pomo.mode = 'work';
  pomo.startTime = null;
  stopPomo();
  renderPomo();
}

function adjustPomoDuration(delta) {
  if (pomo.running) return;
  const next = Math.min(60, Math.max(5, pomo.workMinutes + delta));
  if (next === pomo.workMinutes) return;
  pomo.workMinutes = next;
  if (pomo.mode === 'work') {
    pomo.remaining = pomo.workMinutes * 60;
  }
  saveUIPrefs();
  renderPomo();
}

function renderPomo() {
  const el = document.getElementById('pomodoro');
  // Only show on today tab
  const todayActive = document.getElementById('today-view').classList.contains('active');
  el.style.display = todayActive ? 'flex' : 'none';

  document.getElementById('pomo-timer').textContent = fmtTime(pomo.remaining);

  const label = document.getElementById('pomo-label');
  const taskEl = document.getElementById('pomo-task');
  const btn = document.getElementById('pomo-btn');

  if (pomo.mode === 'break') {
    label.textContent = 'Break';
    taskEl.textContent = 'Take 5. Stretch, water, breathe.';
    el.classList.add('pomo-break-state');
    btn.classList.add('pomo-break');
  } else {
    label.textContent = 'Focus';
    btn.classList.remove('pomo-break');
    el.classList.remove('pomo-break-state');
    if (pomo.taskId) {
      const found = findTask(pomo.taskId);
      taskEl.textContent = found ? found.task.text : 'No task selected';
    } else {
      taskEl.textContent = 'Tap a task to focus';
    }
  }

  btn.textContent = pomo.running ? '❚❚' : '▶';

  const minus = document.getElementById('pomo-minus');
  const plus = document.getElementById('pomo-plus');
  minus.classList.toggle('hidden', pomo.running);
  plus.classList.toggle('hidden', pomo.running);
}

// Compute remaining whole seconds from the wall clock for the current run.
function pomoRemainingFromClock() {
  const elapsed = Date.now() - pomo.startedAt;
  const remainingMs = pomo.durationMs - elapsed;
  return Math.max(0, Math.ceil(remainingMs / 1000));
}

// One timer tick: recompute remaining from the wall clock (immune to background
// tab throttling), update the display, and complete the phase if time is up.
function tickPomo() {
  if (!pomo.running || pomo.startedAt == null) return;
  pomo.remaining = pomoRemainingFromClock();
  if (pomo.remaining <= 0) {
    completePomoPhase();
    return;
  }
  const el = document.getElementById('pomo-timer');
  if (el) el.textContent = fmtTime(pomo.remaining);
}

// Shared completion logic for both work and break phases.
function completePomoPhase() {
  if (pomo.intervalId) {
    clearInterval(pomo.intervalId);
    pomo.intervalId = null;
  }
  pomo.running = false;
  pomo.startedAt = null;
  if (pomo.mode === 'work') {
    recordPomoSession(pomo.taskId, pomo.workMinutes, pomo.startTime);
    pomo.startTime = null;
    pomo.mode = 'break';
    pomo.remaining = POMO_BREAK;
    renderPomo();
    renderProjects();
    if (document.getElementById('weekly-view').classList.contains('active')) {
      renderWeekly();
    }
  } else {
    pomo.mode = 'work';
    pomo.remaining = pomo.workMinutes * 60;
    renderPomo();
  }
}

function startPomo() {
  if (pomo.running) return;
  pomo.running = true;
  if (pomo.mode === 'work' && !pomo.startTime) {
    pomo.startTime = clockHHMM();
  }
  // Anchor to the wall clock: record the exact start time and the intended
  // duration (from whatever is currently remaining, so resume works too).
  pomo.startedAt = Date.now();
  pomo.durationMs = pomo.remaining * 1000;
  pomo.intervalId = setInterval(tickPomo, 1000);
  renderPomo();
}

function stopPomo() {
  // On pause, capture the remaining time from the wall clock before stopping
  // so a later resume continues from the correct point.
  if (pomo.running && pomo.startedAt != null) {
    pomo.remaining = pomoRemainingFromClock();
  }
  pomo.running = false;
  pomo.startedAt = null;
  if (pomo.intervalId) {
    clearInterval(pomo.intervalId);
    pomo.intervalId = null;
  }
  renderPomo();
}

function togglePomo() {
  if (pomo.running) stopPomo();
  else startPomo();
}

// ---------- Tabs ----------
function switchTab(name) {
  document.querySelectorAll('.tab-btn, .top-nav-links a').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
  document.getElementById('today-view').classList.toggle('active', name === 'today');
  document.getElementById('projects-view').classList.toggle('active', name === 'projects');
  document.getElementById('weekly-view').classList.toggle('active', name === 'weekly');
  // The document body is the scroller; reset it on tab change so each tab opens
  // at the top. Weekly manages its own scroll position via renderWeekly().
  if (name === 'weekly') renderWeekly();
  else window.scrollTo(0, 0);
  renderPomo();
  // hide any open session tooltip on tab change
  document.getElementById('session-tooltip').classList.remove('show');
}

// ---------- Bottom sheets ----------
function openSheet(id) {
  document.getElementById('overlay').classList.add('open');
  document.getElementById(id).classList.add('open');
}

function closeSheets() {
  document.getElementById('overlay').classList.remove('open');
  document.querySelectorAll('.sheet').forEach(s => s.classList.remove('open'));
  document.getElementById('color-picker').classList.remove('open');
  pickerProjectId = null;
}

let pickerProjectId = null;

function openColorPicker(projectId) {
  const project = state.projects.find(p => p.id === projectId);
  if (!project) return;
  pickerProjectId = projectId;
  const cur = (project.color || '').toLowerCase();
  const swatches = document.getElementById('color-swatches');
  swatches.innerHTML = COLOR_PICKER_PALETTE.map(c =>
    `<button class="color-swatch${c.toLowerCase() === cur ? ' selected' : ''}" style="background:${c}" data-color="${c}" aria-label="${c}"></button>`
  ).join('');
  swatches.querySelectorAll('[data-color]').forEach(btn => {
    btn.addEventListener('click', () => {
      const p = state.projects.find(x => x.id === pickerProjectId);
      if (!p) return;
      p.color = btn.dataset.color;
      save();
      closeSheets();
      renderToday();
      renderProjects();
    });
  });
  document.getElementById('overlay').classList.add('open');
  document.getElementById('color-picker').classList.add('open');
}

// ---------- Project sheet (create + edit) ----------
function openProjectSheet(projectId) {
  const editing = projectId ? state.projects.find(p => p.id === projectId) : null;

  if (editing) {
    sheetState.newProject = {
      editingId: projectId,
      dateRef: { deadline: editing.targetDate || '', repeat: null, repeatDay: null, repeatDate: null },
      subtasks: editing.tasks.map(t => ({
        id: t.id,
        text: t.text,
        deadline: t.deadline || '',
        repeat: t.repeat || null,
        repeatDay: typeof t.repeatDay === 'number' ? t.repeatDay : null,
        repeatDate: typeof t.repeatDate === 'number' ? t.repeatDate : null
      }))
    };
    document.getElementById('np-name').value = editing.name;
    document.querySelector('#new-project-sheet .sheet-title').textContent = 'Edit project';
    document.getElementById('np-save').textContent = 'Save changes';
  } else {
    sheetState.newProject = {
      editingId: null,
      dateRef: { deadline: '', repeat: null, repeatDay: null, repeatDate: null },
      subtasks: [blankSubtask(), blankSubtask()]
    };
    document.getElementById('np-name').value = '';
    document.querySelector('#new-project-sheet .sheet-title').textContent = 'New project';
    document.getElementById('np-save').textContent = 'Save project';
  }

  renderProjectDateField();
  renderNewProjectSubtasks();
  openSheet('new-project-sheet');
  if (!editing) {
    setTimeout(() => document.getElementById('np-name').focus(), 350);
  }
}

function renderNewProjectSubtasks() {
  closeSubtaskCalendar();
  const container = document.getElementById('np-subtasks');
  container.innerHTML = '';
  sheetState.newProject.subtasks.forEach((st, idx) => {
    const row = document.createElement('div');
    row.className = 'subtask-row';
    const calIcon = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"></rect><line x1="16" y1="2" x2="16" y2="6"></line><line x1="8" y1="2" x2="8" y2="6"></line><line x1="3" y1="10" x2="21" y2="10"></line></svg>`;
    row.innerHTML = `
      <span class="drag-handle">☰</span>
      <input class="subtask-input" placeholder="Step ${idx + 1}..." data-st-text="${st.id}" value="${escapeHtml(st.text)}">
      <div class="subtask-date-wrap${st.deadline ? ' has-date' : ''}">
        <button class="subtask-cal-btn" data-st-cal="${st.id}" aria-label="Set date">${calIcon}</button>
        ${st.deadline ? `<span class="subtask-date-label">${escapeHtml(fmtKoreanMonthDay(st.deadline))}</span>` : ''}
      </div>
      <button class="remove-subtask" data-st-remove="${st.id}" aria-label="Remove">×</button>`;
    container.appendChild(row);
  });

  container.querySelectorAll('[data-st-text]').forEach(el => {
    el.addEventListener('input', () => {
      const st = sheetState.newProject.subtasks.find(s => s.id === el.dataset.stText);
      if (st) st.text = el.value;
    });
  });
  container.querySelectorAll('[data-st-cal]').forEach(el => {
    el.addEventListener('click', () => {
      const st = sheetState.newProject.subtasks.find(s => s.id === el.dataset.stCal);
      const wrap = el.closest('.subtask-date-wrap');
      if (st && wrap) openSubtaskCalendar(st, wrap);
    });
  });
  container.querySelectorAll('[data-st-remove]').forEach(el => {
    el.addEventListener('click', () => {
      sheetState.newProject.subtasks = sheetState.newProject.subtasks.filter(s => s.id !== el.dataset.stRemove);
      if (sheetState.newProject.subtasks.length === 0) {
        sheetState.newProject.subtasks.push(blankSubtask());
      }
      renderNewProjectSubtasks();
    });
  });

  // Drag-to-reorder for subtasks
  attachDrag(container, '.subtask-row', '.drag-handle', (from, to) => {
    const list = sheetState.newProject.subtasks;
    const [moved] = list.splice(from, 1);
    list.splice(to, 0, moved);
    renderNewProjectSubtasks();
  });
}

// ---------- Custom sub-task calendar popup ----------
let openCalState = null; // { popup, wrapEl }

function closeSubtaskCalendar() {
  if (!openCalState) return;
  openCalState.wrapEl.classList.remove('cal-open');
  openCalState.popup.remove();
  openCalState = null;
}

function openSubtaskCalendar(st, wrapEl, onPick) {
  const handlePick = typeof onPick === 'function' ? onPick : renderNewProjectSubtasks;
  // Toggle off if this row's calendar is already open
  if (openCalState && openCalState.wrapEl === wrapEl) {
    closeSubtaskCalendar();
    return;
  }
  closeSubtaskCalendar();

  const popup = document.createElement('div');
  popup.className = 'subtask-cal-popup';
  wrapEl.appendChild(popup);
  wrapEl.classList.add('cal-open');
  openCalState = { popup, wrapEl };

  const base = st.deadline ? new Date(st.deadline + 'T00:00:00') : new Date();
  let viewYear = base.getFullYear();
  let viewMonth = base.getMonth(); // 0-11
  let repeatExpanded = !!st.repeat;

  function setRepeat(val) {
    if (st.repeat === val) {
      st.repeat = null;
      st.repeatDay = null;
      st.repeatDate = null;
    } else {
      const basis = st.deadline ? new Date(st.deadline + 'T00:00:00') : new Date();
      st.repeat = val;
      st.repeatDay = basis.getDay();
      st.repeatDate = basis.getDate();
    }
  }

  function render() {
    const todayISOv = dateISOFromDate(new Date());
    const startWeekday = new Date(viewYear, viewMonth, 1).getDay();
    const daysInMonth = new Date(viewYear, viewMonth + 1, 0).getDate();
    const daysInPrev = new Date(viewYear, viewMonth, 0).getDate();
    const totalCells = Math.ceil((startWeekday + daysInMonth) / 7) * 7;

    let cells = '';
    for (let i = 0; i < totalCells; i++) {
      const dayNum = i - startWeekday + 1;
      if (dayNum < 1) {
        cells += `<div class="cal-cell muted">${daysInPrev + dayNum}</div>`;
      } else if (dayNum > daysInMonth) {
        cells += `<div class="cal-cell muted">${dayNum - daysInMonth}</div>`;
      } else {
        const iso = dateISOFromDate(new Date(viewYear, viewMonth, dayNum));
        const cls = ['cal-cell'];
        if (iso === todayISOv) cls.push('today');
        if (st.deadline === iso) cls.push('selected');
        cells += `<div class="${cls.join(' ')}" data-pick="${iso}">${dayNum}</div>`;
      }
    }

    const weekdays = ['일', '월', '화', '수', '목', '금', '토']
      .map(w => `<div class="cal-wd">${w}</div>`).join('');
    const pills = [['daily', '매일'], ['weekly', '매주'], ['monthly', '매달']]
      .map(([val, label]) => `<button class="cal-repeat-pill${st.repeat === val ? ' active' : ''}" data-repeat="${val}">${label}</button>`)
      .join('');

    popup.innerHTML = `
      <div class="cal-nav">
        <button class="cal-nav-btn" data-nav="-1" aria-label="Previous month">‹</button>
        <div class="cal-nav-title">${viewYear}년 ${pad(viewMonth + 1)}월</div>
        <button class="cal-nav-btn" data-nav="1" aria-label="Next month">›</button>
      </div>
      <div class="cal-grid cal-weekdays">${weekdays}</div>
      <div class="cal-grid cal-days">${cells}</div>
      <div class="cal-divider"></div>
      <div class="cal-repeat-row" data-repeat-toggle>반복하기</div>
      <div class="cal-repeat-options${repeatExpanded ? '' : ' hidden'}">${pills}</div>`;

    popup.querySelectorAll('[data-nav]').forEach(b => b.addEventListener('click', () => {
      viewMonth += parseInt(b.dataset.nav, 10);
      if (viewMonth < 0) { viewMonth = 11; viewYear--; }
      if (viewMonth > 11) { viewMonth = 0; viewYear++; }
      render();
    }));
    popup.querySelectorAll('[data-pick]').forEach(c => c.addEventListener('click', () => {
      st.deadline = c.dataset.pick;
      closeSubtaskCalendar();
      handlePick();
    }));
    popup.querySelector('[data-repeat-toggle]').addEventListener('click', () => {
      repeatExpanded = !repeatExpanded;
      render();
    });
    popup.querySelectorAll('[data-repeat]').forEach(p => p.addEventListener('click', () => {
      setRepeat(p.dataset.repeat);
      render();
    }));
  }

  render();
}

// Project finish-date field (calendar icon + "N월 N일" label next to the name input)
function renderProjectDateField() {
  const wrap = document.getElementById('np-date-wrap');
  const label = document.getElementById('np-date-label');
  const iso = sheetState.newProject.dateRef.deadline;
  label.textContent = iso ? fmtKoreanMonthDay(iso) : '';
  wrap.classList.toggle('has-date', !!iso);
}

function openProjectDateCalendar() {
  const wrap = document.getElementById('np-date-wrap');
  openSubtaskCalendar(sheetState.newProject.dateRef, wrap, renderProjectDateField);
}

function saveProject() {
  const name = document.getElementById('np-name').value.trim();
  const target = sheetState.newProject.dateRef.deadline;
  if (!name) {
    document.getElementById('np-name').focus();
    return;
  }
  if (!target) {
    openProjectDateCalendar();
    return;
  }

  const editingId = sheetState.newProject.editingId;

  if (editingId) {
    const project = state.projects.find(p => p.id === editingId);
    if (!project) { closeSheets(); return; }
    project.name = name;
    project.targetDate = target;
    // Grow totalCount by however many brand-new sub-tasks were added in this edit.
    const addedCount = sheetState.newProject.subtasks
      .filter(s => s.text.trim() && !project.tasks.find(t => t.id === s.id)).length;
    if (typeof project.totalCount !== 'number') project.totalCount = project.tasks.length;
    if (typeof project.completedCount !== 'number') {
      project.completedCount = project.tasks.filter(t => t.completed).length;
    }
    project.totalCount += addedCount;
    project.tasks = sheetState.newProject.subtasks
      .filter(s => s.text.trim())
      .map(s => {
        const existing = project.tasks.find(t => t.id === s.id);
        if (existing) {
          return {
            ...existing,
            text: s.text.trim(),
            deadline: s.deadline || null,
            repeat: s.repeat || null,
            repeatDay: typeof s.repeatDay === 'number' ? s.repeatDay : null,
            repeatDate: typeof s.repeatDate === 'number' ? s.repeatDate : null
          };
        }
        return taskFromSubtask(s);
      });
    // Drop any todayTasks that pointed to removed subtasks
    state.todayTasks = state.todayTasks.filter(taskId => findTask(taskId));
    if (pomo.taskId && !findTask(pomo.taskId)) setPomoTask(null);
  } else {
    const subtasks = sheetState.newProject.subtasks
      .filter(s => s.text.trim())
      .map(taskFromSubtask);
    const project = {
      id: uid(),
      name,
      color: nextColor(),
      targetDate: target,
      createdAt: new Date().toISOString(),
      tasks: subtasks,
      completedCount: 0,
      totalCount: subtasks.length
    };
    state.projects.push(project);
  }

  save();
  closeSheets();
  renderToday();
  renderProjects();
}

// ---------- Picker sheet ----------
function openPicker() {
  if (state.projects.length === 0) {
    switchTab('projects');
    openProjectSheet();
    return;
  }

  const body = document.getElementById('picker-body');
  body.innerHTML = '';

  const projectsWithIncomplete = state.projects.filter(p => p.tasks.some(t => !t.completed));

  if (projectsWithIncomplete.length === 0) {
    body.innerHTML = `<div class="picker-empty">No open tasks. Create some in Projects.</div>`;
  } else {
    for (const p of projectsWithIncomplete) {
      const group = document.createElement('div');
      group.className = 'picker-group';
      const incomplete = p.tasks.filter(t => !t.completed);
      group.innerHTML = `
        <div class="picker-group-header">
          <span class="project-dot" style="background:${p.color}"></span>
          ${escapeHtml(p.name)}
        </div>
        ${incomplete.map(t => `
          <div class="picker-task ${state.todayTasks.includes(t.id) ? 'selected' : ''}" data-pick="${t.id}">
            <span class="task-text">${escapeHtml(t.text)}</span>
            ${t.deadline ? `<span class="pill deadline-pill">${escapeHtml(fmtDeadline(t.deadline))}</span>` : ''}
          </div>`).join('')}`;
      body.appendChild(group);
    }

    body.querySelectorAll('[data-pick]').forEach(el => {
      el.addEventListener('click', () => {
        const id = el.dataset.pick;
        const idx = state.todayTasks.indexOf(id);
        if (idx >= 0) state.todayTasks.splice(idx, 1);
        else state.todayTasks.push(id);
        save();
        el.classList.toggle('selected');
        renderToday();
      });
    });
  }

  openSheet('picker-sheet');
}

// ---------- HTML escape ----------
function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

// ---------- Drag-and-drop (HTML5 + touch) ----------
function attachDrag(container, itemSelector, handleSelector, onReorder) {
  const items = Array.from(container.querySelectorAll(itemSelector));
  let drag = null;

  const idxOf = el => items.indexOf(el);
  const clearTargets = () => items.forEach(i => i.classList.remove('drop-target'));

  items.forEach(item => {
    const handles = item.querySelectorAll(handleSelector);
    if (!handles.length) return;

    handles.forEach(handle => {
      // Desktop / mouse: enable draggable on press of the handle, clear on dragend
      handle.addEventListener('mousedown', () => { item.draggable = true; });

      // Touch: manual reorder via translateY + hit-test
      handle.addEventListener('touchstart', (e) => {
        if (e.touches.length !== 1) return;
        e.preventDefault();
        const t = e.touches[0];
        drag = {
          type: 'touch',
          item,
          from: idxOf(item),
          startY: t.clientY,
          moved: false,
          targetIdx: -1
        };
        item.classList.add('dragging');
      }, { passive: false });

      handle.addEventListener('touchmove', (e) => {
        if (!drag || drag.type !== 'touch' || drag.item !== item) return;
        e.preventDefault();
        const t = e.touches[0];
        const dy = t.clientY - drag.startY;
        item.style.transform = `translateY(${dy}px)`;
        item.style.zIndex = '20';
        item.style.position = 'relative';
        drag.moved = true;

        let target = -1;
        items.forEach((other, idx) => {
          if (other === item) return;
          const r = other.getBoundingClientRect();
          if (t.clientY >= r.top && t.clientY <= r.bottom) target = idx;
        });
        clearTargets();
        if (target >= 0) items[target].classList.add('drop-target');
        drag.targetIdx = target;
      }, { passive: false });

      const finishTouch = () => {
        if (!drag || drag.type !== 'touch' || drag.item !== item) return;
        item.style.transform = '';
        item.style.zIndex = '';
        item.style.position = '';
        item.classList.remove('dragging');
        clearTargets();
        const { from, targetIdx, moved } = drag;
        drag = null;
        if (moved && targetIdx >= 0 && targetIdx !== from) {
          onReorder(from, targetIdx);
        }
      };
      handle.addEventListener('touchend', finishTouch);
      handle.addEventListener('touchcancel', finishTouch);
    });

    // HTML5 drag events on the item
    item.addEventListener('dragstart', (e) => {
      drag = { type: 'html5', item, from: idxOf(item) };
      item.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      try { e.dataTransfer.setData('text/plain', String(idxOf(item))); } catch (_) {}
    });

    item.addEventListener('dragend', () => {
      item.classList.remove('dragging');
      clearTargets();
      item.draggable = false;
      drag = null;
    });

    item.addEventListener('dragover', (e) => {
      if (!drag || drag.type !== 'html5' || item === drag.item) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      clearTargets();
      item.classList.add('drop-target');
    });

    item.addEventListener('drop', (e) => {
      if (!drag || drag.type !== 'html5') return;
      e.preventDefault();
      const to = idxOf(item);
      const from = drag.from;
      clearTargets();
      if (from !== to) onReorder(from, to);
    });
  });
}

// ---------- Auth ----------
function showLoading(on) {
  document.getElementById('loading-overlay').classList.toggle('show', on);
}

function showLoginScreen() {
  document.getElementById('login-screen').classList.remove('hidden');
}

function hideLoginScreen() {
  document.getElementById('login-screen').classList.add('hidden');
}

async function handleSession(session) {
  if (session && session.user) {
    currentUserId = session.user.id;
    hideLoginScreen();
    if (!appStarted) {
      appStarted = true;
      await startApp();
    }
  } else {
    currentUserId = null;
    appStarted = false;
    showLoginScreen();
  }
}

async function setupAuth() {
  document.getElementById('google-login-btn').addEventListener('click', async () => {
    const { error } = await supabaseClient.auth.signInWithOAuth({ provider: 'google' });
    if (error) {
      console.warn('OAuth error', error);
      showToast('로그인 중 오류가 발생했어요. 다시 시도해주세요.');
    }
  });

  const logoutLink = document.getElementById('logout-link');
  if (logoutLink) {
    logoutLink.addEventListener('click', async () => {
      await supabaseClient.auth.signOut();
      showLoginScreen();
    });
  }

  // Resolve the current session first and fully, so the initial screen is
  // decided by getSession() rather than by an early onAuthStateChange event.
  const { data: { session } } = await supabaseClient.auth.getSession();
  await handleSession(session);
  // Auth check is done — dismiss the boot overlay regardless of the outcome.
  // (In the signed-in branch startApp() already hid it; this covers no-session.)
  showLoading(false);

  // Only now react to *subsequent* login/logout changes.
  supabaseClient.auth.onAuthStateChange((_event, session) => { handleSession(session); });
}

// Loads the signed-in user's data, runs the daily housekeeping, and renders.
async function startApp() {
  showLoading(true);
  try {
    await loadFromSupabase();
  } catch (e) {
    console.warn('Initial load failed', e);
    showToast('저장 중 오류가 발생했어요. 다시 시도해주세요.');
  } finally {
    showLoading(false);
  }
  runDailyCleanupIfNeeded();
  scheduleMidnightCleanup();
  renderToday();
  renderProjects();
  renderPomo();
  if (document.getElementById('weekly-view').classList.contains('active')) {
    renderWeekly();
  }
}

// ---------- Wire events ----------
function init() {
  loadUIPrefs();
  setupAuth();

  document.querySelectorAll('.tab-btn').forEach(b => {
    b.addEventListener('click', () => switchTab(b.dataset.tab));
  });
  document.querySelectorAll('.top-nav-links a').forEach(a => {
    a.addEventListener('click', () => switchTab(a.dataset.tab));
  });

  document.getElementById('new-project-btn').addEventListener('click', () => openProjectSheet());

  document.getElementById('overlay').addEventListener('click', closeSheets);
  document.querySelectorAll('[data-close]').forEach(el => el.addEventListener('click', closeSheets));

  // Close any open menu dropdowns on outside click
  document.addEventListener('click', closeAllMenus);

  document.getElementById('np-cal-btn').addEventListener('click', openProjectDateCalendar);

  document.getElementById('np-add-subtask').addEventListener('click', () => {
    sheetState.newProject.subtasks.push(blankSubtask());
    renderNewProjectSubtasks();
    // focus the newest input
    setTimeout(() => {
      const inputs = document.querySelectorAll('#np-subtasks .subtask-input');
      if (inputs.length) inputs[inputs.length - 1].focus();
    }, 0);
  });

  document.getElementById('np-save').addEventListener('click', saveProject);

  document.getElementById('pomo-btn').addEventListener('click', togglePomo);
  document.getElementById('pomo-minus').addEventListener('click', () => adjustPomoDuration(-5));
  document.getElementById('pomo-plus').addEventListener('click', () => adjustPomoDuration(5));

  document.querySelectorAll('[data-week-nav]').forEach(el => {
    el.addEventListener('click', () => {
      weekOffset += parseInt(el.dataset.weekNav);
      renderWeekly();
    });
  });

  document.querySelectorAll('#cal-start-pills button').forEach(btn => {
    btn.addEventListener('click', () => {
      const v = parseInt(btn.dataset.start);
      if (isNaN(v)) return;
      dayStartHour = v;
      saveDayStart();
      renderWeekly();
    });
  });

  // Re-render weekly when crossing the breakpoint so session-block thresholds update
  let resizeTimer = null;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (document.getElementById('weekly-view').classList.contains('active')) {
        renderWeekly();
      }
    }, 200);
  });

  // When the tab regains focus, immediately reconcile the timer with the wall
  // clock so a throttled background interval can't leave it behind — and if it
  // should have finished while away, complete the phase right away.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;
    if (pomo.running && pomo.startedAt != null) {
      tickPomo();
    }
  });

  // Dismiss session tooltip on outside tap
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.cal-session') && !e.target.closest('.session-tooltip')) {
      document.getElementById('session-tooltip').classList.remove('show');
    }
  });

  // Close the sub-task calendar popup when clicking outside it (or its trigger)
  document.addEventListener('mousedown', (e) => {
    if (openCalState &&
        !e.target.closest('.subtask-cal-popup') &&
        !e.target.closest('.subtask-cal-btn') &&
        !e.target.closest('.np-cal-btn')) {
      closeSubtaskCalendar();
    }
  });

  // Initial data load + render happens in startApp() once authenticated.

  // Check for day change every minute
  setInterval(() => {
    if (!currentUserId) return;
    const today = todayISO();
    if (state.todayDate !== today) {
      clearCompletedFromToday();
      state.todayDate = today;
      save();
      renderToday();
      renderProjects();
    }
  }, 60000);
}

document.addEventListener('DOMContentLoaded', init);
