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
3. **Weekly** — 주 단위 캘린더 뷰

---

## 🛣 Roadmap

### Phase 1 — Weekly → Monthly View 변경 ⏭ 진행 예정

**목표:** Weekly view를 완전히 삭제하고, Google Calendar 스타일의 Monthly view로 재구축

**작업 범위:**

#### 탭 & 라우팅
- [ ] 탭 라벨 `weekly` → `monthly` 변경 (3곳: top-nav, tab-bar, view id)
- [ ] 날짜 네비게이션 (`data-week-nav` → `data-month-nav`)
- [ ] localStorage의 `activeTab` 값 마이그레이션 (`weekly` → `monthly`)

#### UI 재구축 (기존 Weekly UI는 전면 삭제)
- [ ] 기존 `.cal-*` 관련 마크업/스타일/로직 전부 제거
- [ ] Google Calendar 스타일의 월간 그리드 UI 새로 구축
  - 7열 × 5~6행 그리드 (일~토)
  - 요일 헤더 상단 고정
  - 이전달/다음달 날짜는 회색 처리
  - 오늘 날짜는 강조 표시
- [ ] 하루 시작 시간 pill UI는 삭제 (Monthly view에는 불필요)

#### 뽀모도로 세션 표시
- [ ] 뽀모도로 세션 완료 시 해당 날짜 칸에 자동 표시
- [ ] task 완료(check) 시 별도 상태로 표시

**표시 형태 1 — task 뽀모도로 완료 시:**
- 배경 색상: 해당 task가 속한 project 색상 + white opacity 20% overlay
- 네모 안 텍스트: task 내용 (프로젝트 이름 아님)
- task 이름 옆에 집중 시간 표기

**표시 형태 2 — task check 완료 시:**
- 배경 색상: 해당 task가 속한 project 색상 + white opacity 20% overlay
- 네모 안 텍스트: task 내용 (프로젝트 이름 아님)
- 텍스트 위에 취소선(strikethrough) 표시

**공통 규칙:**
- **시간 표기:**
  - 5분 ~ 55분: `(30m)`, `(45m)` 형식
  - 60분 이상: `(1h)`, `(1h 35m)` 형식
- 같은 날짜에 여러 세션이 있으면 세로로 쌓아서 표시
- 형태는 Google Calendar 이벤트 스타일 (가로로 긴 네모)

#### 데이터 연동
- [ ] 뽀모도로 완료 시 Supabase에 세션 저장
  - task_id, project_id, duration, completed_at
- [ ] Monthly view 로드 시 해당 월의 세션 조회 및 렌더링

**영향받는 파일:**
- `index.html` — weekly view 관련 마크업 전면 교체
- `style.css` — `.cal-*` 스타일 전면 재작성
- `app.js` — 캘린더 렌더링 함수, 세션 표시 로직 신규 작성

**참고 레퍼런스:**
- Google Calendar 월간 뷰 (이벤트가 색상 바로 표시되는 방식)

---

### Phase 2 — Projects 탭 기능 확장 ⏳ 대기

**목표:** 프로젝트를 만드는 것뿐 아니라 **관리**할 수 있는 완성된 CRUD

**작업 범위:**

#### Project
- [ ] Project 수정 (이름, 색상, 마감일)
- [ ] Project 삭제
- [ ] Project 색상 변경 (color picker 이미 있음 — 로직 연결)

#### Task
- [ ] Task 추가 (프로젝트 내부에서)
- [ ] Task 수정
- [ ] Task 삭제
- [ ] Task 완료 표시

#### Subtask
- [ ] Subtask 생성 (현재 new-project-sheet에만 있음 — 개별 추가 UI 필요)
- [ ] Subtask 수정
- [ ] Subtask 삭제
- [ ] Subtask에 예상 시간 입력

#### 반복 기능 (Recurrence)
- [ ] 매일 반복 / 매주 반복 / 매월 반복
- [ ] Supabase 테이블에 recurrence 컬럼 추가

**DB 스키마 변경 예상:**
```sql
ALTER TABLE tasks ADD COLUMN recurrence TEXT;
ALTER TABLE subtasks ADD COLUMN estimated_minutes INT;
```
*실제 스키마는 Claude Code와 상의 후 확정*

**의존 관계:** Phase 1 완료 후 시작

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
- Monthly view 세션 표시: Google Calendar 스타일 색상 바 (project 색상 + task 텍스트 + 집중 시간)
- 시간 표기: 5~55분은 `(XXm)`, 60분 이상은 `(Xh)` 또는 `(Xh XXm)`

### 검토 필요
- 반복 task의 UX (Today에 어떻게 나타나는지)

### 결정 보류
- Body doubling 기능
- 주간/월간 리포트 자동 생성

---

*Last updated: 2025*
