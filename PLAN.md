# Phi — Product Plan

> 장기 목표를 오늘의 실행으로 연결하는 뽀모도로 기반 생산성 앱

---

## 🎯 Product Vision

미루는 사람이 **오늘 할 일을 작게 쪼개고, 시간을 써가면서, 제 시간에 끝냈는지 확인**할 수 있게 돕는 앱.

핵심 원칙:
- **Goal-driven execution** — 뽀모도로는 도구, 목표 달성이 본질
- **Remove assumption** — 결정 피로를 줄이고, 선택은 최소로
- **Simplicity first** — 미루는 사람은 복잡한 앱을 안 연다

---

## 📐 Current Architecture

### 파일 구조
```
~/Phi/
├── index.html      # 마크업 (탭 3개 + 시트 2개)
├── style.css       # 스타일
├── app.js          # 전체 로직 + Supabase 연동
└── PLAN.md         # 이 문서
```

### 기술 스택
- **Frontend:** Vanilla HTML/CSS/JS (단일 페이지)
- **Font:** Onest (Google Fonts)
- **DB:** Supabase (JS SDK via CDN)
- **Auth:** Google OAuth
- **Hosting:** Vercel (GitHub 연동)

### 탭 구조 (현재)
1. **Today** — 오늘 할 일 + 뽀모도로 타이머
2. **Projects** — 프로젝트 & sub-task 관리
3. **Monthly** — 월간 캘린더 뷰 (Phase 1에서 Weekly → Monthly로 교체)

---

## 🛣 Roadmap

### Phase 1 — Weekly → Monthly View 변경 ✅ 구현 완료 (실환경 검증 + 커밋 정리만 남음)

**목표:** Weekly view를 완전히 삭제하고, Google Calendar 스타일의 Monthly view로 재구축

> 구현 과정에서 초기 스펙이 여러 번 갱신됨. 아래는 **최종 확정 사양** 기준.
> 주요 변경: 요일 `일~토` → `MON~SUN`(월요일 시작), 배경 `white 20% overlay` → `project색 opacity 50%`,
> 형태1·형태2 → **단일 세션바로 통합**, 완료 표시 `취소선` → `✓ 접두사`.

#### 탭 & 라우팅
- [x] 탭 라벨 `weekly` → `monthly` (top-nav "먼슬리", tab-bar "Monthly", view id `monthly-view`)
- [x] 날짜 네비게이션 `data-week-nav` → `data-month-nav`
- [x] localStorage `activeTab` 마이그레이션 (`weekly` → `monthly`)

#### UI 재구축 (기존 Weekly UI 전면 삭제)
- [x] weekly 전용 `.cal-*` 마크업/스타일/로직 제거 (subtask 마감일 팝업 `.cal-*`는 **보존**)
- [x] 하루 시작 시간 pill UI 삭제
- [x] Google Calendar 스타일 월간 그리드
  - [x] 7열 × 5~6행, **MON~SUN (월요일 시작)**
  - [x] 요일 헤더 (카드 상단, 요일 사이 세로 구분선 / 헤더-그리드 사이 가로선 없음)
  - [x] 이전달/다음달 날짜 회색 처리
  - [x] 오늘 날짜 강조 (보라 원형)
  - [x] 흰색 카드 UI (border-radius + subtle shadow, 셀 사이 1px 격자선)
  - [x] 각 달 1일에 영문 약자 접두 ("Aug 1")

#### 세션바 (형태1 뽀모 + 형태2 완료 → 단일 바로 통합)
- [x] **생성 조건:** 뽀모도로 완료 **또는** task check 완료 (한 task = 하루 세션바 1개)
- [x] 배경: 해당 task의 project 색상 + **opacity 50%** (YIQ 기반 자동 텍스트 대비)
- [x] 텍스트: task 내용만, 셀 너비 기준 CSS ellipsis 자동 처리
- [x] **완료 표시: 텍스트 앞 `✓ ` 접두사** (취소선 아님) — check 상태에 따라 토글
- [x] 같은 날 여러 세션바 세로 스택 (Google Calendar 이벤트 스타일)
- [x] **toast (바 클릭):** 전체 task명 + 누적 뽀모도로 시간 노출
  - 시간 표기: 5~55분 `(30m)` / 60분+ `(1h)`·`(1h 35m)`

#### 상태 변경 / task 삭제 규칙
- [x] **uncheck:** 세션바 유지, `✓ `만 제거 (`task_completions.completed=false`로 upsert, 행 유지)
- [x] **뽀모도로 재실행:** 세션바 유지, 누적 시간만 반영
- [x] **task 삭제 시** (세션바는 task가 아닌 기록 기반이라 유지됨)
  - [x] 뽀모도로 시행 후 삭제 → 세션바 + 누적 시간 유지
  - [x] check 완료 후 삭제 → 세션바(`✓`) 유지
  - [x] 뽀모도 check도 안 한 상태 삭제 → 세션바 없음

#### 데이터 연동
- [x] 뽀모도로 완료 → `pomodoro_sessions` 저장 (기존)
- [x] task check 완료 → `task_completions` 저장 (**신규 테이블**, `completed` 플래그 + `unique(user_id, task_id, date)` upsert)
- [x] Monthly 로드 시 `pomodoro_sessions` + `task_completions` 조회 → (date, task) 단위 병합 렌더
- [x] RLS 정책 적용

**DB 스키마 (확정):**
```sql
-- task_completions (신규, SQL 실행 완료)
create table public.task_completions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  task_id uuid not null,
  task_name text not null,
  project_id uuid, project_name text, project_color text,
  date date not null,
  completed boolean not null default true,
  created_at timestamptz not null default now(),
  unique (user_id, task_id, date)
);
```

#### 남은 항목
- [ ] 실환경(로그인 상태) 최종 검증 — Today·Projects·Monthly 세 탭, 형태2 저장/로드, 저장 오류 토스트 해소, subtask 마감일 팝업
- [ ] Phase 1 변경분 커밋 정리 (`bd0c32a`에 `--amend`로 통합, 커밋 메시지에 형태2 포함 반영)

**영향받은 파일:** `index.html`, `style.css`, `app.js` (+ Supabase `task_completions` 테이블)

**참고 레퍼런스:** Google Calendar 월간 뷰

---

### Phase 2a — Projects / Task 관리 CRUD ✅ 완료 (Mobile 확정 바만 보류)

**목표:** 프로젝트/task를 만드는 것뿐 아니라 **관리**(수정·삭제·순서·추가·반복)할 수 있게

#### Project 관리
- [x] 수정: 이름 + 색상 (하나의 Edit modal로 통합 — 2a-4)
  - Edit/New project 시트를 **이름 + 색상만** 남기고 통합
  - subtask 입력 UI + 완료일(targetDate) 필드 **완전 제거** (task는 카드 Add task로, subtask는 2b popover 예정)
  - 색상은 modal 안 swatch로 선택 → 기존 ⋯메뉴 '색상 변경' + 별도 color picker 팝업 제거 (⋯메뉴 = 수정 / 삭제)
- [x] 삭제: 브라우저 `confirm()` 유지
- [x] 드래그로 카드 순서 변경 (헤더만 잡고 이동) (2a-5)
  - `mousedown` 위치가 `.project-header`일 때만 `draggable`을 켜서 드래그 시작 (헤더 밖·⋯메뉴·본문은 드래그 안 됨). 터치는 헤더 롱프레스. 실환경 검증 완료.

#### Task 관리
- 추가 (2a-1)
  - [x] Card view 하단에 `[+ Add task]` input 영역
  - [x] Empty 상태: placeholder 색상 `#cbd5e1`
  - [x] Input 활성화 시: background `#ffffff`, placeholder line `#64748b`
  - [x] Web: Enter로 입력 완료
  - [ ] Mobile: 키보드 위 확정 바 (오른쪽 `v` 체크 아이콘) — 파트 B (보류)
- ~~드래그로 순서 변경 (2a-3)~~ → **현재 skip** (추후 재개)
- ~~삭제~~ → **Phase 2b로 이동** (삭제는 popover에서만 실행, popover가 2b에서 구현됨)

#### 반복 기능 (Recurrence) — 2a-4 ✅ 구현·검증 완료
- [x] 매일 / 매주 / 매월 + 마감일: 카드 하단 Add task input 옆 **캘린더 아이콘**에서 설정
- [x] 기존 `openSubtaskCalendar` 재사용 (프로젝트별 임시 draft에 담아 task 생성 시 병합)
- [x] 데이터: 기존 `tasks.repeat` / `repeat_day` / `repeat_date` 컬럼 그대로 활용
- 실환경 검증 완료: 반복(매주)·날짜만 케이스 데이터 정확, 연속 추가 focus 유지, Supabase 영속성 OK
- ⚠️ 미확인: 실제 한글 IME 조합 후 Enter 흐름 (자동화로 재현 불가) → 필요 시 `isComposing` 가드 추가

**참고:**
- 색상값(`#cbd5e1`·`#64748b`·`#ffffff`)은 CSS 변수화 검토 (미적용)
- 2a-4에서 dead CSS 정리: `.color-picker-popup` 계열 제거 / subtask 전용 CSS(`.subtask-*`)는 캘린더 팝업(`.cal-*`) 재사용 때문에 일부 잔존

**단계:** 2a-1 Task 추가 ✅ → ~~2a-3 Task 드래그~~(skip) → 2a-4 반복 + 모달 통합 ✅ → 2a-5 카드 드래그 헤더 제한 ✅
(2a-2 Task 삭제는 제외 — 2b popover와 함께 / 2a-1 파트 B Mobile 확정 바는 보류)

**의존 관계:** Phase 1 완료 후 시작. Phase 2a 완료 → 검토 → 2b.

---

### Phase 2b — 상세 페이지 & Checklist ⏳ 대기 (2a 완료 후)

**목표:** task를 열어 세부 항목(checklist)과 진행률, 마감일을 관리하고, task를 삭제

- [ ] Task 클릭 시 Popover 상세페이지
  - Web: Project card 옆에 popover (배경 오버레이 없음, dim X) — 원래 화면 위에 살짝 그림자로 떠 있는 느낌
  - Mobile: 전체화면
- [ ] Checklist + 진행률 %
- [ ] Task 마감일 설정
- [ ] **Task 삭제** (popover 안에서 실행 — 2a에서 이관)

**의존 관계:** Phase 2a 완료 후 시작

---

### Phase 3 — UX 디테일 마무리 📋 예정

- [ ] Hover 상태 정리
- [ ] 트랜지션 & 애니메이션
- [ ] Empty state UI (프로젝트 없을 때 / 오늘 할 일 없을 때)
- [ ] 로딩 상태 개선
- [ ] 에러 메시지 처리
- [ ] 반응형 breakpoint 정리 (모바일 / 태블릿 / 웹)

---

## 🎨 Design System

### Color Palette (현재 사용 중)
- **Background:** `#F9F9F7` (theme color)
- **Font:** Onest 400 / 500 / 700

### UI Components
- Bottom sheet (2개: new-project, picker)
- Color picker popup
- Tooltip (session detail)
- Toast

---

## 🧠 Design Principles

1. **탭 이동 없이 완결** — 각 탭은 그 자체로 의미 있는 화면
2. **결정 피로 줄이기** — 뽀모도로 시작 순간엔 선택만, 입력은 X
3. **일관된 시각 언어** — 색상, 폰트, 간격은 CSS 변수로 관리
4. **모바일 우선** — 웹에서도 잘 작동하지만 시작은 모바일 UX

---

## 📝 Working Notes

### 확정된 기획
- 탭 3개 구조 유지
- 뽀모도로 타이머는 Today 탭에서만 노출
- Google OAuth 로그인 유지

### 확정 사항 (Phase 1)
- Monthly view 세션바: project색 **opacity 50%** 배경 + task 텍스트(ellipsis) + `✓ ` 완료 접두사
- 세션바 = 한 task의 하루 1개 (뽀모 완료 **또는** check 완료 시 생성), 뽀모/완료 기록 기반이라 task 삭제 후에도 유지
- 완료 표시는 취소선이 아니라 **`✓ ` 접두사** (uncheck 시 제거)
- 시간(누적 뽀모)은 셀이 아니라 **toast(바 클릭)** 에만 표기: 5~55분 `(XXm)`, 60분+ `(Xh)`·`(Xh XXm)`
- 요일 그리드는 **월요일 시작(MON~SUN)**
- `task_completions` 테이블 신설 (`completed` 플래그 + `unique(user_id, task_id, date)` upsert)

### 검토 필요
- 반복 task의 UX (Today에 어떻게 나타나는지)

### 결정 보류
- Body doubling 기능
- 주간/월간 리포트 자동 생성

---

*Last updated: 2026-08-09*
