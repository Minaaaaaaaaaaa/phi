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
let phiCompletions = []; // task-completion marks, for the Monthly "✓" session bars
let monthCursor = null; // Date at the 1st of the month shown in Monthly view (lazy-init)
let activeTab = 'today'; // 'today' | 'projects' | 'monthly'; restored on load

let sheetState = {
  newProject: { editingId: null, color: PALETTE[0] }
};

// Pending deadline/repeat per project's card "+ Add task" input, keyed by
// projectId. The card calendar edits this draft; addTaskToProject merges it into
// the new task and clears it. Shape matches what openSubtaskCalendar expects.
const addTaskDrafts = {};
function getAddTaskDraft(projectId) {
  return addTaskDrafts[projectId] ||
    (addTaskDrafts[projectId] = { deadline: '', repeat: null, repeatDay: null, repeatDate: null });
}

// Shared calendar glyph (used by the card add-task icon).
const CAL_ICON_SVG = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"></rect><line x1="16" y1="2" x2="16" y2="6"></line><line x1="8" y1="2" x2="8" y2="6"></line><line x1="3" y1="10" x2="21" y2="10"></line></svg>`;

// ---------- UI preferences (localStorage) ----------
// Only UI preferences live in localStorage now — all app data is in Supabase.
function loadUIPrefs() {
  const mins = parseInt(localStorage.getItem('pomoWorkMinutes'), 10);
  if (!isNaN(mins)) {
    pomo.workMinutes = mins;
    pomo.remaining = pomo.workMinutes * 60;
  }
  // Guard against a stale/unknown value leaving every view inactive.
  let tab = localStorage.getItem('activeTab');
  if (tab === 'weekly') tab = 'monthly'; // migrate the old tab name
  if (tab === 'today' || tab === 'projects' || tab === 'monthly') activeTab = tab;
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
      // repeatDay/repeatDate are currently unused: the reset model resets on
      // fixed boundaries (weekly=Monday, monthly=1st), not the task's own weekday
      // /date. Kept (written on load/save) for a possible future "custom day".
      repeatDay: typeof t.repeat_day === 'number' ? t.repeat_day : null,
      repeatDate: typeof t.repeat_date === 'number' ? t.repeat_date : null,
      // Date this repeat task's check state was last reset (reuses the old
      // repeat_spawned_on column; see resetRepeatingTasks).
      lastResetOn: t.repeat_spawned_on || null
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

  // Task-completion marks (drive the Monthly "✓" session bars)
  const { data: completionRows, error: cErr } = await supabaseClient.from('task_completions')
    .select('*')
    .eq('user_id', currentUserId);
  if (cErr) throw cErr;
  phiCompletions = (completionRows || []).map(c => ({
    id: c.id,
    taskId: c.task_id,
    taskName: c.task_name,
    projectId: c.project_id,
    projectName: c.project_name,
    projectColor: c.project_color,
    date: c.date,
    completed: c.completed
  }));

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
        repeat_spawned_on: t.lastResetOn || null
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

// Persist a task's completion mark for today. Upserts on (user_id, task_id,
// date) so check -> completed:true and un-check -> completed:false both land on
// the same row (the row is never deleted, so the session bar survives un-check).
async function persistCompletion(c) {
  if (!currentUserId) return;
  try {
    const { error } = await supabaseClient.from('task_completions').upsert({
      user_id: currentUserId,
      task_id: c.taskId,
      task_name: c.taskName,
      project_id: c.projectId,
      project_name: c.projectName,
      project_color: c.projectColor,
      date: c.date,
      completed: c.completed
    }, { onConflict: 'user_id,task_id,date' });
    if (error) throw error;
  } catch (e) {
    console.error('[persistCompletion] failed:', e, '| message:', e && e.message,
      '| details:', e && e.details, '| hint:', e && e.hint, '| code:', e && e.code);
    showToast('저장 중 오류가 발생했어요. 다시 시도해주세요.');
  }
}

// Delete today's completion row for a task. Used when un-checking a task that
// has no pomodoro that day: without a pomodoro the Monthly bar has no reason to
// exist, so the row is removed rather than kept with completed:false.
async function deleteCompletion(taskId, date) {
  if (!currentUserId) return;
  try {
    const { error } = await supabaseClient.from('task_completions')
      .delete()
      .eq('user_id', currentUserId)
      .eq('task_id', taskId)
      .eq('date', date);
    if (error) throw error;
  } catch (e) {
    console.error('[deleteCompletion] failed:', e, '| message:', e && e.message,
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

// Date -> "N월 N일". Canonical short-date formatter (see fmtKoreanMonthDay).
function fmtKoreanShortDate(d) {
  return (d.getMonth() + 1) + '월 ' + d.getDate() + '일';
}

// Minute count -> "<prefix> N분" / "<prefix> N시간 [N분]". Used by the project
// cards' focus-time pill.
function fmtMinutesKorean(prefix, totalMin) {
  if (totalMin < 60) return `${prefix} ${totalMin}분`;
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return m === 0 ? `${prefix} ${h}시간` : `${prefix} ${h}시간 ${m}분`;
}

// True when a deadline is in the past (rendered in red on task rows).
function deadlinePassed(iso) {
  if (!iso) return false;
  const d = new Date(iso + 'T00:00:00');
  return diffDays(d, startOfDay(new Date())) < 0;
}

// Status pill HTML for a task row, or '' if none. Two separate concepts:
//   - deadline  = a one-off task's due date (repeat tasks never carry one)
//   - "오늘"     = a repeat task's per-period tag, always shown (even when
//                 checked): only the task text gets the completed strikethrough,
//                 not this label. Card variant uses the dedicated `task-today`
//                 class so the completed-state rules (hide/strikethrough) skip it.
// `variant`: 'card' -> project cards, 'pill' -> today / picker.
function taskStatusPill(task, variant) {
  if (task.repeat) {
    if (variant === 'card') return `<span class="task-today">today</span>`;
    return `<span class="pill deadline-pill">today</span>`;
  }
  if (task.deadline) {
    const overdue = deadlinePassed(task.deadline);
    if (variant === 'card') {
      return `<span class="task-deadline${overdue ? ' overdue' : ''}">${escapeHtml(fmtDeadline(task.deadline))}</span>`;
    }
    return `<span class="pill deadline-pill">${escapeHtml(fmtDeadline(task.deadline))}</span>`;
  }
  return '';
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

// Set today's completion mark for a task (check -> true, un-check -> false).
// `found` is { project, task }. The row is kept either way so the Monthly
// session bar survives an un-check; only the "✓" prefix (completed flag) changes.
function upsertCompletion(found, completed) {
  const today = todayISO();
  const taskId = found.task.id;

  // Un-checking a task that had no pomodoro today: the bar only existed because
  // of this completion mark, so drop the row entirely (in memory + DB) instead
  // of keeping a completed:false row that would leave an empty bar behind.
  if (!completed) {
    const hasPomo = phiSessions.some(s => s.taskId === taskId && s.date === today);
    if (!hasPomo) {
      const idx = phiCompletions.findIndex(x => x.taskId === taskId && x.date === today);
      if (idx >= 0) phiCompletions.splice(idx, 1);
      deleteCompletion(taskId, today);
      return;
    }
  }

  let c = phiCompletions.find(x => x.taskId === taskId && x.date === today);
  if (c) {
    c.completed = completed;
  } else {
    c = {
      id: uid(),
      taskId: taskId,
      taskName: found.task.text,
      projectId: found.project.id,
      projectName: found.project.name,
      projectColor: found.project.color,
      date: today,
      completed: completed
    };
    phiCompletions.push(c);
  }
  persistCompletion(c);
}

// ---------- Daily cleanup: drop completed sub-tasks ----------
// Repeat tasks are kept even when completed — they persist and get reset (see
// resetRepeatingTasks) rather than deleted.
function cleanupCompletedSubtasks() {
  let changed = false;
  for (const p of state.projects) {
    const before = p.tasks.length;
    p.tasks = p.tasks.filter(t => !t.completed || t.repeat);
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

// ---------- Repeating sub-tasks (reset model) ----------
// A repeat task is a single, persistent task. Instead of spawning copies, its
// check state is reset to incomplete at each period boundary: daily = every
// midnight, weekly = every Monday 00:00, monthly = the 1st at 00:00. Returns the
// ISO date (YYYY-MM-DD) of the most recent boundary on or before `now`.
function repeatBoundaryISO(repeat, now) {
  const d = startOfDay(now);
  if (repeat === 'daily') return dateISOFromDate(d);
  if (repeat === 'weekly') {
    const sinceMonday = (d.getDay() + 6) % 7; // Sun=0..Sat=6 -> days since Monday
    d.setDate(d.getDate() - sinceMonday);
    return dateISOFromDate(d);
  }
  if (repeat === 'monthly') {
    d.setDate(1);
    return dateISOFromDate(d);
  }
  return null;
}

// Reset every repeat task whose latest boundary is newer than its last reset.
// This ONLY flips the task's own completed/completedAt and advances lastResetOn;
// it never touches pomodoro_sessions or task_completions, so the Monthly view's
// per-date history stays intact. Self-gating (lastResetOn) and idempotent, so it
// is safe to run on every app open — catching up any boundaries missed while the
// app was closed (e.g. opened Mon, reopened Thu).
function resetRepeatingTasks() {
  const now = new Date();
  let changed = false;
  for (const p of state.projects) {
    for (const t of p.tasks) {
      if (!t.repeat) continue;
      // Repeat tasks carry no deadline (managed by period). Clears any stale
      // deadline left by the old spawn logic; idempotent thereafter.
      if (t.deadline != null) { t.deadline = null; changed = true; }
      const boundary = repeatBoundaryISO(t.repeat, now);
      if (!boundary) continue;
      if (t.lastResetOn == null) {
        // First encounter: anchor to the current boundary without resetting.
        t.lastResetOn = boundary;
        changed = true;
      } else if (t.lastResetOn < boundary) {
        if (t.completed) { t.completed = false; t.completedAt = null; }
        t.lastResetOn = boundary;
        changed = true;
      }
    }
  }
  return changed;
}

// One-time migration for duplicates left by the old spawn-based logic. Within a
// project, for every text that has at least one repeat task, keep only a single
// repeat task (the last one — the most recent) and drop everything else sharing
// that text (leftover spawned copies, whether repeat or not). Texts with no
// repeat task are left untouched. Idempotent, so safe to run on every open.
function dedupeRepeatTasks() {
  let changed = false;
  for (const p of state.projects) {
    const repeatTexts = new Set(p.tasks.filter(t => t.repeat).map(t => t.text));
    if (repeatTexts.size === 0) continue;
    // The single task to keep per text: the last repeat task with that text.
    const keep = new Map();
    for (const t of p.tasks) {
      if (t.repeat && repeatTexts.has(t.text)) keep.set(t.text, t);
    }
    const before = p.tasks.length;
    p.tasks = p.tasks.filter(t =>
      !repeatTexts.has(t.text) ? true : keep.get(t.text) === t);
    if (p.tasks.length !== before) changed = true;
  }
  if (changed) {
    state.todayTasks = state.todayTasks.filter(id => findTask(id));
    if (pomo.taskId && !findTask(pomo.taskId)) setPomoTask(null);
  }
  return changed;
}

function runDailyCleanupIfNeeded() {
  const today = todayISO();
  // Repeat dedupe + reset are per-task, self-gating and idempotent, so run on
  // every open (this is what catches boundaries missed while the app was closed).
  let changed = dedupeRepeatTasks();
  changed = resetRepeatingTasks() || changed;
  // Deleting completed non-repeat tasks stays a once-a-day job.
  const last = localStorage.getItem('lastCleanupDate');
  if (last !== today) {
    changed = cleanupCompletedSubtasks() || changed;
    localStorage.setItem('lastCleanupDate', today);
  }
  if (changed) save();
}

let midnightCleanupTimer = null;
function scheduleMidnightCleanup() {
  if (midnightCleanupTimer) clearTimeout(midnightCleanupTimer);
  const now = new Date();
  const nextMidnight = new Date(now);
  nextMidnight.setHours(24, 0, 0, 0); // start of tomorrow
  const ms = (nextMidnight - now) + 1000; // small buffer past 00:00
  midnightCleanupTimer = setTimeout(() => {
    resetRepeatingTasks();
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
            ${taskStatusPill(s.task, 'pill')}
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
  closeSubtaskCalendar(); // drop any open card calendar before the DOM is rebuilt
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
            ${taskStatusPill(t, 'card')}
          </div>`).join('')}
      </div>
      ${project.tasks.length > 5 ? `<button class="expand-btn" data-expand="${project.id}">${expanded ? 'show less' : 'show more'}</button>` : ''}
      <div class="add-task-row">
        <input type="text" class="add-task-input" data-add-task="${project.id}" placeholder="+ Add task" autocomplete="off" />
        <div class="add-task-date-wrap${draftHasDate(project.id) ? ' has-date' : ''}" data-add-date-wrap="${project.id}">
          <button type="button" class="add-task-cal-btn" data-add-cal="${project.id}" aria-label="마감일/반복 설정">${CAL_ICON_SVG}</button>
        </div>
      </div>`;
    content.appendChild(card);
  }

  wireTaskToggles(content);
  content.querySelectorAll('.add-task-input[data-add-task]').forEach(input => {
    // Web: Enter submits. (Mobile confirm bar comes in part B.)
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        addTaskToProject(input.dataset.addTask, input.value);
      }
    });
  });
  // Card add-task calendar: reuse the subtask calendar popup on a per-project
  // draft (deadline + repeat), applied to the task on submit.
  content.querySelectorAll('.add-task-cal-btn[data-add-cal]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const pid = btn.dataset.addCal;
      const wrap = btn.closest('.add-task-date-wrap');
      if (!wrap) return;
      openSubtaskCalendar(getAddTaskDraft(pid), wrap, () => {
        wrap.classList.toggle('has-date', draftHasDate(pid));
      });
    });
  });
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

  // Drag-to-reorder for project cards (header handle only; long-press on touch)
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
  // Drag starts only from the card header (excluding its ⋯ menu button), so the
  // rest of the card stays free for tapping tasks, adding tasks, etc.
  const isDragHandle = (target) =>
    !!target.closest('.project-header') && !isInteractive(target);

  cards.forEach(card => {
    // Native DnD reports dragstart's target as the draggable element (the card),
    // not the grabbed descendant — so the header can't be detected there. Instead
    // we flip `draggable` on mousedown based on where the pointer actually landed,
    // so a drag can only originate from the header handle.
    card.draggable = false;
    card.addEventListener('mousedown', (e) => {
      card.draggable = isDragHandle(e.target);
    });

    card.addEventListener('dragstart', (e) => {
      drag = { type: 'html5', card, from: idxOf(card) };
      card.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      try { e.dataTransfer.setData('text/plain', String(idxOf(card))); } catch (_) {}
    });

    card.addEventListener('dragend', () => {
      card.classList.remove('dragging');
      card.draggable = false;
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

    // Touch: long-press (300ms) on the header to start drag
    card.addEventListener('touchstart', (e) => {
      if (!isDragHandle(e.target)) return;
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
    // Mark today's completion (drives the Monthly bar + its "✓" prefix).
    upsertCompletion(found, true);
    const tasks = found.project.tasks;
    const idx = tasks.indexOf(found.task);
    if (idx >= 0 && idx < tasks.length - 1) {
      tasks.splice(idx, 1);
      tasks.push(found.task);
    }
  } else {
    // Un-check keeps the bar but clears the "✓" prefix (completed:false).
    upsertCompletion(found, false);
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

// True when a project's add-task draft has a deadline or a repeat set (drives the
// card calendar icon's "active" state).
function draftHasDate(projectId) {
  const d = addTaskDrafts[projectId];
  return !!(d && (d.deadline || d.repeat));
}

// Add a task to a project from the card's "+ Add task" input, then re-render and
// restore focus on that card's input so tasks can be added back-to-back. Any
// deadline/repeat set on the card calendar (the draft) is merged in and cleared.
function addTaskToProject(projectId, text) {
  const t = text.trim();
  if (!t) return;
  const project = state.projects.find(p => p.id === projectId);
  if (!project) return;
  const draft = addTaskDrafts[projectId] || {};
  project.tasks.push({
    // Repeat tasks are managed by their period, not a due date, so they never
    // carry a deadline (repeat wins if both were picked on the calendar).
    id: uid(), text: t, completed: false, deadline: draft.repeat ? null : (draft.deadline || null), completedAt: null,
    repeat: draft.repeat || null,
    repeatDay: typeof draft.repeatDay === 'number' ? draft.repeatDay : null,
    repeatDate: typeof draft.repeatDate === 'number' ? draft.repeatDate : null,
    // Anchor a new repeat task to today so it isn't reset on the next open.
    lastResetOn: draft.repeat ? todayISO() : null
  });
  project.totalCount = (project.totalCount || 0) + 1;
  delete addTaskDrafts[projectId]; // reset the draft for the next task
  save();
  renderProjects();
  const input = document.querySelector(`.add-task-input[data-add-task="${projectId}"]`);
  if (input) input.focus();
}

// ---------- Monthly view ----------
const MONTH_WEEKDAYS = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN']; // grid starts on Monday

// Focus-duration label per PLAN: under an hour -> "(30m)", an hour or more ->
// "(1h)" / "(1h 35m)".
function fmtSessionDuration(min) {
  if (min < 60) return `(${min}m)`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m === 0 ? `(${h}h)` : `(${h}h ${m}m)`;
}

// Calendar bar background: the project color at the given opacity.
// Form 1 (pomodoro) uses 0.5; form 2 (task completion) uses 0.7.
function barBg(hex, opacity) {
  const { r, g, b } = hexToRgb(hex);
  return `rgba(${r}, ${g}, ${b}, ${opacity})`;
}

// Readable text color for a bar: composite the color at `opacity` over the
// white cell, then pick dark or white by YIQ luminance.
function barTextColor(hex, opacity) {
  const { r, g, b } = hexToRgb(hex);
  const w = 255 * (1 - opacity);
  const R = r * opacity + w, G = g * opacity + w, B = b * opacity + w;
  const yiq = (R * 299 + G * 587 + B * 114) / 1000;
  return yiq >= 150 ? '#1f2937' : '#ffffff';
}

function renderMonthly() {
  if (!monthCursor) {
    const now = new Date();
    monthCursor = new Date(now.getFullYear(), now.getMonth(), 1);
  }
  const year = monthCursor.getFullYear();
  const month = monthCursor.getMonth(); // 0-11

  const title = document.getElementById('month-title');
  if (title) {
    title.textContent = monthCursor.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
  }

  const weekdaysEl = document.getElementById('month-weekdays');
  if (weekdaysEl) {
    weekdaysEl.innerHTML = MONTH_WEEKDAYS
      .map(w => `<div class="month-wd">${w}</div>`).join('');
  }

  const grid = document.getElementById('month-grid');
  if (!grid) return;

  // Monday-based column index: Sun(0)->6, Mon(1)->0, ... Sat(6)->5.
  const startWeekday = (new Date(year, month, 1).getDay() + 6) % 7;
  const daysInMonth  = new Date(year, month + 1, 0).getDate();
  const daysInPrev   = new Date(year, month, 0).getDate();
  // 5 or 6 rows depending on how the month falls across weeks.
  const totalCells = Math.ceil((startWeekday + daysInMonth) / 7) * 7;
  const todayISOStr = todayISO();

  // One bar per (date, task). A bar exists if the task had a pomodoro OR a
  // completion mark that day. Minutes come from pomodoros (sum); the "✓" prefix
  // from the completion mark's current `completed` flag.
  const barsByDate = {};
  const barFor = (date, key) => {
    const byTask = barsByDate[date] || (barsByDate[date] = {});
    return byTask[key] || (byTask[key] = {
      taskName: '', projectColor: PALETTE[0], minutes: 0, completed: false
    });
  };
  for (const s of phiSessions) {
    const bar = barFor(s.date, s.taskId || s.taskName || '');
    bar.minutes += (s.minutes || 0);
    if (s.taskName) bar.taskName = s.taskName;
    if (s.projectColor) bar.projectColor = s.projectColor;
  }
  for (const c of phiCompletions) {
    const bar = barFor(c.date, c.taskId || c.taskName || '');
    if (c.taskName) bar.taskName = c.taskName;
    if (c.projectColor) bar.projectColor = c.projectColor;
    bar.completed = !!c.completed; // current check state -> "✓" prefix
  }

  let html = '';
  for (let i = 0; i < totalCells; i++) {
    const dayNum = i - startWeekday + 1;
    let cellDate, inMonth;
    if (dayNum < 1) {
      cellDate = new Date(year, month - 1, daysInPrev + dayNum);
      inMonth = false;
    } else if (dayNum > daysInMonth) {
      cellDate = new Date(year, month + 1, dayNum - daysInMonth);
      inMonth = false;
    } else {
      cellDate = new Date(year, month, dayNum);
      inMonth = true;
    }
    const iso = dateISOFromDate(cellDate);
    const cls = ['month-cell'];
    if (!inMonth) cls.push('other-month');
    if (iso === todayISOStr) cls.push('today');
    // The 1st of any month shown in the grid gets a 3-letter month prefix
    // (e.g. "Aug 1"); every other day shows just the number.
    const dayOfMonth = cellDate.getDate();
    const dayLabel = dayOfMonth === 1
      ? cellDate.toLocaleDateString('en-US', { month: 'short' }) + ' 1'
      : String(dayOfMonth);
    // Session bars: project color at 50% opacity, task text only (CSS ellipsis
    // clips to the cell). The "✓" prefix follows the task's current check state.
    // The click toast shows the full name + accumulated pomodoro time.
    const dayBars = barsByDate[iso] ? Object.values(barsByDate[iso]) : [];
    const eventsHtml = dayBars.map(b => {
      const color = b.projectColor;
      const name = b.taskName;
      const full = b.minutes > 0 ? `${name} ${fmtSessionDuration(b.minutes)}` : name;
      // Completed tasks get a "✓ " prefix.
      const label = b.completed ? '✓ ' + name : name;
      return `<div class="month-event" style="background:${barBg(color, 0.5)};color:${barTextColor(color, 0.5)}" data-full="${escapeHtml(full)}">`
        + `${escapeHtml(label)}`
        + `</div>`;
    }).join('');
    html += `<div class="${cls.join(' ')}" data-date="${iso}">`
      + `<div class="month-daynum">${dayLabel}</div>`
      + `<div class="month-events">${eventsHtml}</div>`
      + `</div>`;
  }
  grid.innerHTML = html;
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
    if (document.getElementById('monthly-view').classList.contains('active')) {
      renderMonthly();
    }
  } else {
    pomo.mode = 'work';
    pomo.remaining = pomo.workMinutes * 60;
    renderPomo();
  }
}

function startPomo() {
  if (pomo.running) return;
  // A focus (work) session must be tied to a task, otherwise it records nothing
  // and the time is lost. Break sessions don't need a task.
  if (pomo.mode === 'work' && !pomo.taskId) {
    showToast('먼저 집중할 task를 선택해주세요.');
    return;
  }
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
// Which tab is visible, expressed purely as DOM classes. Touches no app data,
// so it can run before the auth/data round-trips have finished.
function applyTabClasses(name) {
  // Keep <html data-tab> in step with .active so the boot rule in style.css and
  // .view.active never point at two different views.
  document.documentElement.setAttribute('data-tab', name);
  document.querySelectorAll('.tab-btn, .top-nav-links a').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
  document.getElementById('today-view').classList.toggle('active', name === 'today');
  document.getElementById('projects-view').classList.toggle('active', name === 'projects');
  document.getElementById('monthly-view').classList.toggle('active', name === 'monthly');
}

function switchTab(name) {
  activeTab = name;
  localStorage.setItem('activeTab', name);
  applyTabClasses(name);
  // The document body is the scroller; reset it on tab change so each tab opens
  // at the top.
  if (name === 'monthly') renderMonthly();
  else window.scrollTo(0, 0);
  renderPomo();
}

// ---------- Bottom sheets ----------
function openSheet(id) {
  document.getElementById('overlay').classList.add('open');
  document.getElementById(id).classList.add('open');
}

function closeSheets() {
  document.getElementById('overlay').classList.remove('open');
  document.querySelectorAll('.sheet').forEach(s => s.classList.remove('open'));
}

// ---------- Project sheet (create + edit) ----------
function openProjectSheet(projectId) {
  const editing = projectId ? state.projects.find(p => p.id === projectId) : null;

  if (editing) {
    sheetState.newProject = { editingId: projectId, color: editing.color || PALETTE[0] };
    document.getElementById('np-name').value = editing.name;
    document.querySelector('#new-project-sheet .sheet-title').textContent = 'Edit project';
    document.getElementById('np-save').textContent = 'Save changes';
  } else {
    sheetState.newProject = { editingId: null, color: nextColor() };
    document.getElementById('np-name').value = '';
    document.querySelector('#new-project-sheet .sheet-title').textContent = 'New project';
    document.getElementById('np-save').textContent = 'Save project';
  }

  renderProjectColorSwatches();
  openSheet('new-project-sheet');
  if (!editing) {
    setTimeout(() => document.getElementById('np-name').focus(), 350);
  }
}

// Render the color swatches inside the project sheet (create + edit). Selecting
// a swatch just updates the in-memory draft color; it's persisted on save.
function renderProjectColorSwatches() {
  const wrap = document.getElementById('np-color-swatches');
  if (!wrap) return;
  const cur = (sheetState.newProject.color || '').toLowerCase();
  wrap.innerHTML = COLOR_PICKER_PALETTE.map(c =>
    `<button type="button" class="color-swatch${c.toLowerCase() === cur ? ' selected' : ''}" style="background:${c}" data-np-color="${c}" aria-label="${c}"></button>`
  ).join('');
  wrap.querySelectorAll('[data-np-color]').forEach(btn => {
    btn.addEventListener('click', () => {
      sheetState.newProject.color = btn.dataset.npColor;
      renderProjectColorSwatches();
    });
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
  const handlePick = typeof onPick === 'function' ? onPick : () => {};
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

// Save the project sheet. The sheet now edits name + color only; tasks are added
// from each card's "+ Add task" input, so a brand-new project starts empty.
function saveProject() {
  const name = document.getElementById('np-name').value.trim();
  if (!name) {
    document.getElementById('np-name').focus();
    return;
  }
  const color = sheetState.newProject.color || nextColor();
  const editingId = sheetState.newProject.editingId;

  if (editingId) {
    const project = state.projects.find(p => p.id === editingId);
    if (!project) { closeSheets(); return; }
    project.name = name;
    project.color = color;
    // targetDate is left untouched (the finish-date field was removed from the UI).
  } else {
    const project = {
      id: uid(),
      name,
      color,
      targetDate: null,
      createdAt: new Date().toISOString(),
      tasks: [],
      completedCount: 0,
      totalCount: 0
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
            ${taskStatusPill(t, 'pill')}
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
  }
  try {
    runDailyCleanupIfNeeded();
    scheduleMidnightCleanup();
    renderToday();
    renderProjects();
    // Restore the tab the user was last on. switchTab() covers renderPomo() and,
    // for monthly, renderMonthly().
    switchTab(activeTab);
  } finally {
    // Lift the boot overlay only once the right tab is rendered, so it never
    // uncovers the wrong one. finally: a render throwing must not strand it.
    showLoading(false);
  }
}

// ---------- Wire events ----------
function init() {
  loadUIPrefs();
  // Reflect the restored tab in the DOM right away — localStorage is synchronous,
  // so this lands before the auth and data round-trips instead of after them.
  // Rendering still happens later in startApp(), once data exists.
  applyTabClasses(activeTab);
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

  document.getElementById('np-save').addEventListener('click', saveProject);

  document.getElementById('pomo-btn').addEventListener('click', togglePomo);
  document.getElementById('pomo-minus').addEventListener('click', () => adjustPomoDuration(-5));
  document.getElementById('pomo-plus').addEventListener('click', () => adjustPomoDuration(5));

  document.querySelectorAll('[data-month-nav]').forEach(el => {
    el.addEventListener('click', () => {
      if (!monthCursor) {
        const now = new Date();
        monthCursor = new Date(now.getFullYear(), now.getMonth(), 1);
      }
      monthCursor.setMonth(monthCursor.getMonth() + parseInt(el.dataset.monthNav, 10));
      renderMonthly();
    });
  });

  // Tapping a session bar shows its full task name + accumulated time. Delegated
  // on the static grid so it survives every renderMonthly() innerHTML rebuild.
  document.getElementById('month-grid').addEventListener('click', (e) => {
    const ev = e.target.closest('.month-event');
    if (ev && ev.dataset.full) showToast(ev.dataset.full);
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

  // Close the sub-task calendar popup when clicking outside it (or its trigger)
  document.addEventListener('mousedown', (e) => {
    if (openCalState &&
        !e.target.closest('.subtask-cal-popup') &&
        !e.target.closest('.subtask-cal-btn') &&
        !e.target.closest('.add-task-cal-btn')) {
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
