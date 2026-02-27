# @agents Plugin 카탈로그

> `agents/plugins/` 하위 73개 플러그인의 실제 내용을 분석하고, 각각의 용도와 사용 판단 기준을 정리한 문서.

---

## 목차

1. [카테고리 요약](#카테고리-요약)
2. [프로젝트 관리 & 워크플로우](#1-프로젝트-관리--워크플로우)
3. [코드 품질 & 리뷰](#2-코드-품질--리뷰)
4. [테스팅](#3-테스팅)
5. [디버깅 & 에러 분석](#4-디버깅--에러-분석)
6. [문서화](#5-문서화)
7. [백엔드 개발](#6-백엔드-개발)
8. [프론트엔드 & 모바일 개발](#7-프론트엔드--모바일-개발)
9. [API 개발](#8-api-개발)
10. [프로그래밍 언어 전문](#9-프로그래밍-언어-전문)
11. [데이터베이스](#10-데이터베이스)
12. [데이터 엔지니어링](#11-데이터-엔지니어링)
13. [보안](#12-보안)
14. [인프라 & 클라우드](#13-인프라--클라우드)
15. [CI/CD & 배포](#14-cicd--배포)
16. [모니터링 & 옵저버빌리티](#15-모니터링--옵저버빌리티)
17. [AI & ML](#16-ai--ml)
18. [SEO & 마케팅](#17-seo--마케팅)
19. [비즈니스 & 분석](#18-비즈니스--분석)
20. [도메인 특화](#19-도메인-특화)
21. [중복 분석 & 선택 가이드](#중복-분석--선택-가이드)

---

## 카테고리 요약

| 카테고리 | 플러그인 수 | 핵심 추천 |
|----------|:---------:|----------|
| 프로젝트 관리 & 워크플로우 | 4 | conductor, agent-teams |
| 코드 품질 & 리뷰 | 4 | comprehensive-review |
| 테스팅 | 2 | tdd-workflows |
| 디버깅 & 에러 분석 | 5 | debugging-toolkit |
| 문서화 | 3 | documentation-generation |
| 백엔드 개발 | 2 | backend-development |
| 프론트엔드 & 모바일 | 3 | frontend-mobile-development |
| API 개발 | 2 | api-scaffolding |
| 프로그래밍 언어 | 10 | 사용 언어에 따라 선택 |
| 데이터베이스 | 3 | database-design |
| 데이터 엔지니어링 | 2 | data-engineering |
| 보안 | 5 | security-scanning |
| 인프라 & 클라우드 | 3 | cloud-infrastructure |
| CI/CD & 배포 | 3 | cicd-automation |
| 모니터링 & 옵저버빌리티 | 2 | observability-monitoring |
| AI & ML | 4 | llm-application-dev |
| SEO & 마케팅 | 4 | 필요 시만 |
| 비즈니스 & 분석 | 4 | 필요 시만 |
| 도메인 특화 | 5 | 필요 시만 |

---

## 1. 프로젝트 관리 & 워크플로우

### conductor
- **설명**: Context-Driven Development(CDD) 프레임워크. `conductor/` 디렉토리에 product.md, tech-stack.md, workflow.md를 생성하고, Track(기능/버그/리팩터) 단위로 Spec → Plan → Implement 사이클을 관리한다. TDD 강제, 태스크별 git commit, 페이즈 간 사용자 승인 게이트 포함.
- **에이전트**: conductor-validator (opus) - 아티팩트 검증
- **커맨드**: `/setup`, `/new-track`, `/implement`, `/status`, `/revert`, `/manage`
- **스킬 3개**: context-driven-development, track-management, workflow-patterns
- **추천**: 중규모 이상 프로젝트에서 체계적 개발 프로세스가 필요할 때. 혼자 개발하더라도 "무엇을 왜 만드는지"를 기록하며 진행하고 싶다면 유용. 단순한 버그 수정이나 스크립트 작성에는 오버헤드.

### agent-teams
- **설명**: 멀티에이전트 팀 오케스트레이션. 병렬 코드 리뷰, 가설 기반 디버깅, 파일 소유권 분리 기반 병렬 기능 개발을 지원. `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` 플래그 필요.
- **에이전트**: team-lead (opus), team-reviewer (opus), team-debugger (opus), team-implementer (opus)
- **커맨드**: `/team-spawn`, `/team-status`, `/team-shutdown`, `/team-review`, `/team-debug`, `/team-feature`, `/team-delegate`
- **스킬 6개**: team-composition-patterns, task-coordination-strategies, parallel-debugging, multi-reviewer-patterns, parallel-feature-development, team-communication-protocols
- **추천**: 복잡한 기능을 여러 에이전트가 병렬로 구현하거나, 다차원 코드 리뷰가 필요할 때. 실험적 기능이므로 안정성을 확인 후 사용. 단순 작업에는 불필요.

### git-pr-workflows
- **설명**: Git 워크플로우 자동화. PR 설명 자동 생성, 코드 리뷰 + PR 생성 파이프라인, 팀 온보딩 프로세스 제공.
- **에이전트**: code-reviewer (opus)
- **커맨드**: `/git-workflow`, `/pr-enhance`, `/onboard`
- **추천**: PR 기반 개발 워크플로우를 사용하는 팀에서 PR 품질을 높이고 싶을 때 유용. `/pr-enhance`만으로도 가치 있음.

### team-collaboration
- **설명**: DX 최적화와 팀 워크플로우. 온보딩 자동화(5분 내 clone-to-running), GitHub 이슈 해결 워크플로우, 비동기 스탠드업 노트 자동 생성.
- **에이전트**: dx-optimizer (sonnet)
- **커맨드**: `/issue`, `/standup-notes`
- **추천**: 팀 리드가 온보딩 경험을 개선하거나, 스탠드업 자동화가 필요할 때. 혼자 개발할 때는 불필요.

---

## 2. 코드 품질 & 리뷰

### comprehensive-review
- **설명**: 아키텍처 + 보안 + 코드 품질 3차원 리뷰를 단일 워크플로우로 오케스트레이션. PR 설명 개선 기능도 포함. `.full-review/state.json`에 상태 저장하여 재개 가능.
- **에이전트**: architect-review (opus), code-reviewer (opus), security-auditor (opus)
- **커맨드**: `/full-review`, `/pr-enhance`
- **추천**: 중요한 PR이나 릴리즈 전 종합 리뷰에 적합. 모든 커밋마다 돌리기에는 무거움.

### code-refactoring
- **설명**: 클린 코드 리팩터링, 기술 부채 분석 및 개선, 장기 세션 컨텍스트 복원. 코드 스멜 탐지(20줄 초과 메서드, 200줄 초과 클래스), SOLID 위반 식별.
- **에이전트**: code-reviewer (opus), legacy-modernizer (sonnet)
- **커맨드**: `/refactor-clean`, `/tech-debt`, `/context-restore`
- **추천**: 레거시 코드를 정리하거나 기술 부채를 체계적으로 관리해야 할 때. `/tech-debt`로 현황 파악 → `/refactor-clean`으로 개선.

### codebase-cleanup
- **설명**: code-refactoring과 유사하나, 의존성 감사(`/deps-audit`)가 추가됨. CVE 스캐닝, 라이선스 호환성 검사, 번들 사이즈 분석 포함.
- **에이전트**: code-reviewer (opus), test-automator (sonnet)
- **커맨드**: `/deps-audit`, `/refactor-clean`, `/tech-debt`
- **추천**: `/deps-audit`가 핵심 차별점. 의존성 보안 감사가 필요하면 이것을, 순수 코드 리팩터링이면 code-refactoring을.

### performance-testing-review
- **설명**: 성능 프로파일링 + AI 기반 코드 리뷰. 멀티 툴 SAST(CodeQL, SonarQube, Semgrep, Snyk) 후 LLM 리뷰 오케스트레이션.
- **에이전트**: performance-engineer (inherit), test-automator (sonnet)
- **커맨드**: `/ai-review`, `/multi-agent-review`
- **추천**: 정적 분석 도구 연동이 필요한 CI 환경에서. `/ai-review`가 다양한 SAST 도구 결과를 종합해줌.

---

## 3. 테스팅

### tdd-workflows
- **설명**: TDD 전체 사이클 관리. Chicago/London School, BDD, ATDD, Outside-In, Inside-Out TDD를 모두 지원. 12단계 워크플로우(4개 승인 체크포인트). 커버리지 목표 80%.
- **에이전트**: tdd-orchestrator (opus), code-reviewer (opus)
- **커맨드**: `/tdd-cycle`, `/tdd-red`, `/tdd-green`, `/tdd-refactor`
- **추천**: TDD를 엄격하게 실천하고 싶을 때. `/tdd-red` → `/tdd-green` → `/tdd-refactor` 순서로 개별 사용도 가능. TDD에 익숙하지 않으면 학습 도구로도 좋음.

### unit-testing
- **설명**: 소스 코드 AST 분석 기반 테스트 자동 생성. Python(pytest), JavaScript(Jest), React(Testing Library) 지원. 커버리지 갭 분석.
- **에이전트**: test-automator (sonnet), debugger (sonnet)
- **커맨드**: `/test-generate`
- **추천**: 기존 코드에 테스트가 없을 때 빠르게 테스트 커버리지를 올리는 용도. TDD보다는 "테스트 없는 레거시 코드에 테스트 추가"에 적합.

---

## 4. 디버깅 & 에러 분석

### debugging-toolkit
- **설명**: AI 지원 디버깅 워크플로우. 에러 분류 → 가설 생성 → 전략 선택(interactive/observability/time-travel/chaos/statistical) → 프로덕션-세이프 조사 → 수정 및 검증. DX 최적화 에이전트도 포함.
- **에이전트**: debugger (sonnet), dx-optimizer (sonnet)
- **커맨드**: `/smart-debug`
- **추천**: 프로덕션 이슈를 체계적으로 분석해야 할 때. 단순 타이포 버그에는 과도하지만, 재현 어려운 간헐적 버그에는 매우 유용.

### error-debugging
- **설명**: 에러 분석, 에러 트래킹 설정(Sentry/DataDog), 멀티에이전트 코드 리뷰 오케스트레이션. 구조화 로깅, 로그 집계 아키텍처(Fluentd → ES/Loki), 인시던트 응답 워크플로우 포함.
- **에이전트**: debugger (sonnet), error-detective (sonnet)
- **커맨드**: `/error-analysis`, `/error-trace`, `/multi-agent-review`
- **추천**: 에러 모니터링 인프라를 새로 구축하거나 개선할 때. Sentry/DataDog 설정 코드가 필요하면 이것.

### error-diagnostics
- **설명**: error-debugging과 거의 동일한 에이전트/커맨드 구성. `/smart-debug`가 추가되어 있으며, 이는 debugging-toolkit의 것과 동일.
- **에이전트**: debugger (sonnet), error-detective (sonnet)
- **커맨드**: `/error-analysis`, `/error-trace`, `/smart-debug`
- **추천**: **error-debugging과 대부분 중복**. 둘 중 하나만 선택하면 됨. `/smart-debug`가 필요하면 error-diagnostics, `/multi-agent-review`가 필요하면 error-debugging.

### distributed-debugging
- **설명**: 마이크로서비스/분산 시스템 전용 디버깅. VS Code 디버그 설정, OpenTelemetry 분산 트레이싱, V8 프로파일러, 힙 스냅샷 분석, Source Map 설정 포함.
- **에이전트**: devops-troubleshooter (sonnet), error-detective (sonnet)
- **커맨드**: `/debug-trace`
- **추천**: Node.js 기반 마이크로서비스를 디버깅할 때 특히 유용. 모놀리스에서는 불필요.

### incident-response
- **설명**: SRE 수준의 인시던트 관리. P0-P3 분류, 5페이즈 워크플로우(탐지/조사/수정/커뮤니케이션/포스트모텀), 12개 산출물, 런북 템플릿 포함.
- **에이전트**: incident-responder, debugger, devops-troubleshooter, error-detective, code-reviewer, test-automator (6개)
- **커맨드**: `/incident-response`, `/smart-fix`
- **추천**: 프로덕션 서비스를 운영하고 온콜 체계가 있는 팀. 인시던트 프로세스 자체를 구축하거나 포스트모텀 문화를 정착시키고 싶을 때.

---

## 5. 문서화

### documentation-generation
- **설명**: 가장 풍부한 문서화 플러그인. OpenAPI 스펙, Mermaid 다이어그램, 10~100+ 페이지 기술 문서, API 레퍼런스, 튜토리얼 생성. 5개 에이전트(api-documenter, docs-architect, mermaid-expert, reference-builder, tutorial-engineer).
- **에이전트**: 5개 (sonnet/haiku)
- **커맨드**: `/doc-generate`
- **스킬 3개**: architecture-decision-records, changelog-automation, openapi-spec-generation
- **추천**: 가장 범용적인 문서화 도구. OpenAPI 스펙, 아키텍처 다이어그램, 기술 문서가 모두 필요하면 이것 하나로 해결.

### code-documentation
- **설명**: 코드 설명과 교육 중심. 알고리즘/디자인 패턴을 Mermaid 플로우차트와 단계별 설명으로 풀어줌. 튜토리얼 생성도 가능.
- **에이전트**: code-reviewer (opus), docs-architect (sonnet), tutorial-engineer (sonnet)
- **커맨드**: `/code-explain`, `/doc-generate`
- **추천**: "이 코드가 뭘 하는 건지 설명해줘" 류의 요청에 적합. 온보딩 문서나 교육 자료 작성 시.

### c4-architecture
- **설명**: C4 모델(Context/Container/Component/Code) 기반 아키텍처 문서 자동 생성. 코드 디렉토리 분석 → 컴포넌트 합성 → 컨테이너 매핑 → 시스템 컨텍스트 순서로 상향식 생성.
- **에이전트**: c4-code (haiku), c4-component (sonnet), c4-container (sonnet), c4-context (sonnet)
- **커맨드**: `/c4-architecture`
- **추천**: 기존 코드베이스의 아키텍처를 체계적으로 문서화하고 싶을 때. 이해관계자 커뮤니케이션용 다이어그램이 필요한 경우.

---

## 6. 백엔드 개발

### backend-development
- **설명**: 8개 에이전트를 갖춘 가장 종합적인 백엔드 플러그인. REST/GraphQL/gRPC 설계, 이벤트 소싱/CQRS, Temporal 워크플로우, TDD, 보안 감사를 모두 커버. 5페이즈 기능 개발 워크플로우 제공.
- **에이전트**: backend-architect, event-sourcing-architect, graphql-architect (opus), performance-engineer, security-auditor (sonnet), tdd-orchestrator (opus), temporal-python-pro, test-automator (sonnet)
- **커맨드**: `/feature-development`
- **스킬 9개**: api-design-principles, architecture-patterns, cqrs-implementation, event-store-design, microservices-patterns, projection-patterns, saga-orchestration, temporal-python-testing, workflow-orchestration-patterns
- **추천**: 백엔드 서비스를 새로 구축하거나 복잡한 기능을 추가할 때의 원스톱 솔루션. 특히 이벤트 소싱이나 Temporal을 사용하는 프로젝트에 강점.

### backend-api-security
- **설명**: 보안 중심 백엔드 코딩. 인증(JWT/OAuth2/OIDC), 인가(RBAC/ABAC), 인젝션 방지, HTTP 보안 헤더, 레이트 리미팅 등 실제 보안 코드 구현에 초점.
- **에이전트**: backend-architect, backend-security-coder (sonnet)
- **추천**: API 보안 구현을 직접 코딩해야 할 때. security-scanning(감사)과는 달리 "보안 코드를 작성"하는 데 특화.

---

## 7. 프론트엔드 & 모바일 개발

### frontend-mobile-development
- **설명**: React 19/Next.js 15 App Router + React Native 개발. 컴포넌트 스캐폴딩(TypeScript, CSS Modules/Tailwind, Jest, Storybook 포함) 커맨드 제공.
- **에이전트**: frontend-developer, mobile-developer
- **커맨드**: `/component-scaffold`
- **스킬 4개**: nextjs-app-router-patterns, react-native-architecture, react-state-management, tailwind-design-system
- **추천**: React/Next.js 또는 React Native 프로젝트의 기본 개발 도구. 컴포넌트 생성 자동화가 편리.

### multi-platform-apps
- **설명**: 웹/iOS/Android/데스크톱 크로스 플랫폼 오케스트레이션. Flutter 전문 에이전트 포함. 3페이즈 워크플로우(공통 설계 → 플랫폼별 병렬 구현 → 테스트).
- **에이전트**: flutter-expert, backend-architect, frontend-developer, ios-developer, mobile-developer, ui-ux-designer
- **커맨드**: `/multi-platform`
- **추천**: 동일 기능을 여러 플랫폼에 동시 구현해야 할 때. Flutter 프로젝트에도 적합. 단일 플랫폼만 대상이면 불필요.

### ui-design
- **설명**: UI/UX 디자인 시스템 구축. Atomic Design, 디자인 토큰(Style Dictionary), 접근성 감사, WCAG 컴플라이언스 포함.
- **에이전트**: ui-designer, accessibility-expert, design-system-architect
- **커맨드**: `/accessibility-audit`, `/create-component`, `/design-review`, `/design-system-setup`
- **스킬 9개**: accessibility-compliance, design-system-patterns, interaction-design, mobile-ios/android-design, react-native-design, responsive-design, visual-design-foundations, web-component-design
- **추천**: 디자인 시스템을 처음 구축하거나 접근성 개선이 필요할 때. 프론트엔드 컴포넌트 라이브러리 프로젝트에 유용.

---

## 8. API 개발

### api-scaffolding
- **설명**: REST/GraphQL API 프로젝트 스캐폴딩. FastAPI, Django REST Framework, GraphQL 전문 에이전트 4개.
- **에이전트**: backend-architect, django-pro, fastapi-pro, graphql-architect
- **스킬 1개**: fastapi-templates
- **추천**: 새 API 프로젝트를 빠르게 시작하고 싶을 때. 특히 FastAPI/Django/GraphQL 선택을 도와줌.

### api-testing-observability
- **설명**: API 문서(OpenAPI 3.1) 자동 생성 및 목 서버 생성.
- **에이전트**: api-documenter (sonnet)
- **커맨드**: `/api-mock`
- **추천**: API 문서화나 테스트용 목 서버가 필요할 때. documentation-generation과 API 문서 기능이 일부 겹침.

---

## 9. 프로그래밍 언어 전문

> 사용 중인 언어에 맞는 플러그인만 설치하면 됨.

### python-development
- **설명**: Python 3.12+ 전문. FastAPI/Django 프로젝트 스캐폴딩, uv 패키지 매니저, ruff 린터. **16개 스킬**로 가장 스킬이 풍부한 플러그인.
- **에이전트**: python-pro (opus), django-pro (opus), fastapi-pro (opus)
- **커맨드**: `/python-scaffold`
- **스킬 16개**: async-python-patterns, python-anti-patterns, python-background-jobs, python-code-style, python-configuration, python-design-patterns, python-error-handling, python-observability, python-packaging, python-performance-optimization, python-project-structure, python-resilience, python-resource-management, python-testing-patterns, python-type-safety, uv-package-manager
- **추천**: Python 프로젝트라면 필수. 스킬이 매우 풍부하여 Best Practice 참조에도 좋음.

### javascript-typescript
- **설명**: JS/TS 전문. Next.js, React+Vite, Node.js API, 라이브러리 프로젝트 스캐폴딩.
- **에이전트**: javascript-pro, typescript-pro (opus)
- **커맨드**: `/typescript-scaffold`
- **추천**: TypeScript/JavaScript 프로젝트에 필수.

### systems-programming
- **설명**: Rust, Go, C, C++ 시스템 프로그래밍. Rust 프로젝트 스캐폴딩(바이너리/라이브러리/워크스페이스/Axum 웹 API).
- **에이전트**: rust-pro (opus), golang-pro (opus), c-pro, cpp-pro
- **커맨드**: `/rust-project`
- **스킬 3개**: go-concurrency-patterns, memory-safety-patterns, rust-async-patterns
- **추천**: Rust 또는 Go 프로젝트에 적합. 특히 Rust 스캐폴딩과 비동기 패턴 스킬이 유용.

### jvm-languages
- **설명**: Java 21+(Virtual Threads, Pattern Matching), Scala 3(Cats Effect, ZIO), C#(ASP.NET Core, Blazor).
- **에이전트**: java-pro (opus), scala-pro, csharp-pro
- **추천**: Java/Spring Boot 또는 Scala/ZIO 프로젝트에 적합.

### dotnet-contribution
- **설명**: .NET 전용 심층 플러그인. C# 12/13, ASP.NET Core Minimal API, EF Core, Dapper, Clean Architecture, MediatR CQRS 패턴.
- **에이전트**: dotnet-architect (sonnet)
- **스킬 1개**: dotnet-backend-patterns (상세 코드 예제 포함)
- **추천**: .NET 백엔드 프로젝트라면 jvm-languages의 csharp-pro보다 이것이 훨씬 상세. .NET 전용이라면 이것을 선택.

### functional-programming
- **설명**: Elixir(OTP/Phoenix/LiveView) + Haskell(GADTs/STM/Megaparsec).
- **에이전트**: elixir-pro, haskell-pro
- **추천**: Elixir 또는 Haskell 프로젝트에서만 유용.

### julia-development
- **설명**: Julia 1.10+ 전문. 과학 컴퓨팅(DifferentialEquations.jl), ML(Flux.jl), GPU(CUDA.jl) 포함. BlueStyle 포맷팅 엄격 적용.
- **에이전트**: julia-pro (sonnet)
- **추천**: Julia 프로젝트에서만 사용.

### web-scripting
- **설명**: PHP 8+ 및 Ruby/Rails 개발.
- **에이전트**: php-pro, ruby-pro
- **추천**: PHP 또는 Ruby/Rails 프로젝트에서만 사용.

### shell-scripting
- **설명**: Bash 5.x(모던 기능) + POSIX sh(이식성 중심) 두 전문 에이전트. ShellCheck, bats-core 테스팅 포함.
- **에이전트**: bash-pro (sonnet), posix-shell-pro (sonnet)
- **스킬 3개**: bash-defensive-patterns, bats-testing-patterns, shellcheck-configuration
- **추천**: 프로덕션 셸 스크립트를 작성해야 할 때. CI 스크립트나 설치 스크립트의 품질을 높이고 싶을 때.

### arm-cortex-microcontrollers
- **설명**: ARM Cortex-M 펌웨어 개발. Teensy 4.x, STM32, nRF52, SAMD. 주변 장치 드라이버, ISR, DMA, FreeRTOS/Zephyr. Cortex-M7 메모리 배리어 요구사항(`__DMB()`, `__DSB()`) 강제.
- **에이전트**: arm-cortex-expert
- **추천**: 임베디드 시스템/IoT 펌웨어 개발에서만 유용. 매우 전문적.

---

## 10. 데이터베이스

### database-design
- **설명**: 기술 선택(관계형/NoSQL/그래프/벡터/시계열 DB) + 스키마 설계. PostgreSQL 전용 상세 스킬(BIGINT PK, TIMESTAMPTZ, RLS, 파티셔닝 등).
- **에이전트**: database-architect (opus), sql-pro
- **스킬 1개**: postgresql (상세 테이블 설계 규칙)
- **추천**: 새 프로젝트의 DB 아키텍처를 설계하거나, PostgreSQL 스키마 Best Practice가 필요할 때.

### database-migrations
- **설명**: 제로 다운타임 마이그레이션. expand-contract 패턴, blue-green 스키마 마이그레이션(트리거), gh-ost/pt-online-schema-change, Flyway/Alembic 스크립트 생성.
- **에이전트**: database-admin (sonnet), database-optimizer
- **커맨드**: `/sql-migrations`, `/migration-observability`
- **추천**: 프로덕션 DB 스키마를 무중단으로 변경해야 할 때. 개발 환경에서의 단순 마이그레이션에는 불필요.

### database-cloud-optimization
- **설명**: DB 쿼리 최적화(EXPLAIN ANALYZE, N+1, 인덱싱) + 클라우드 비용 분석.
- **에이전트**: database-optimizer, cloud-architect (sonnet), backend-architect, database-architect (opus)
- **커맨드**: `/cost-optimize`
- **추천**: 느린 쿼리 최적화나 클라우드 DB 비용 절감이 필요할 때.

---

## 11. 데이터 엔지니어링

### data-engineering
- **설명**: 모던 데이터 스택 구현. Spark/dbt/Airflow/Kafka/Flink/Delta Lake/Iceberg. 데이터 기반 기능 개발 16단계 워크플로우(EDA → 실험 설계 → 구현 → A/B 테스트 → 분석).
- **에이전트**: data-engineer (opus), backend-architect
- **커맨드**: `/data-pipeline`, `/data-driven-feature`
- **스킬 4개**: airflow-dag-patterns, data-quality-frameworks, dbt-transformation-patterns, spark-optimization
- **추천**: ETL/ELT 파이프라인, 데이터 웨어하우스, 실시간 스트리밍이 필요한 프로젝트에 필수.

### data-validation-suite
- **설명**: 입력 검증과 데이터 새니타이제이션 중심. OWASP Top 10 방지 기법.
- **에이전트**: backend-security-coder (sonnet)
- **추천**: backend-api-security와 에이전트가 동일. 데이터 검증만 필요하면 이것, 전체 API 보안이면 backend-api-security 선택.

---

## 12. 보안

### security-scanning
- **설명**: 가장 종합적인 보안 플러그인. 위협 모델링(STRIDE), SAST 스캐닝(Bandit/ESLint/Semgrep/SpotBugs 등), 의존성 취약점 분석, 13단계 보안 하드닝 워크플로우.
- **에이전트**: security-auditor (opus), threat-modeling-expert
- **커맨드**: `/security-sast`, `/security-hardening`, `/security-dependencies`
- **스킬 5개**: attack-tree-construction, sast-configuration, security-requirement-extraction, stride-analysis-patterns, threat-mitigation-mapping
- **추천**: 보안 감사의 원스톱 솔루션. 보안 관련 플러그인 중 하나만 선택해야 한다면 이것.

### security-compliance
- **설명**: 규정 준수(GDPR/HIPAA/SOC2/PCI-DSS) 코드 생성. 동의 관리, PHI 암호화, MFA, 토큰화 등 실제 구현 코드 제공.
- **에이전트**: security-auditor (opus)
- **커맨드**: `/compliance-check`
- **추천**: 특정 규정 준수가 필요한 프로젝트(의료-HIPAA, 유럽-GDPR, 금융-PCI-DSS)에서.

### backend-api-security
- **설명**: API 보안 코딩 전문. 인젝션 방지, 보안 헤더, 인증/인가 구현.
- **에이전트**: backend-architect, backend-security-coder (sonnet)
- **추천**: 백엔드 API의 보안 코드를 직접 작성해야 할 때. security-scanning(감사)과 상호 보완적.

### frontend-mobile-security
- **설명**: 클라이언트 사이드 보안. XSS 방지(DOMPurify, Trusted Types), CSP 설정, CSRF 보호, 모바일 보안.
- **에이전트**: frontend-developer, frontend-security-coder, mobile-security-coder
- **커맨드**: `/xss-scan`
- **추천**: 프론트엔드 보안 점검이 필요할 때. `/xss-scan`으로 React/Vue/Angular 코드의 XSS 취약점 정적 분석 가능.

### accessibility-compliance
- **설명**: WCAG 2.1/2.2 접근성 감사. axe-core 자동화, 키보드 내비게이션, 스크린 리더 호환성 테스트.
- **에이전트**: ui-visual-validator (sonnet)
- **커맨드**: `/accessibility-audit`
- **스킬 2개**: wcag-audit-patterns, screen-reader-testing
- **추천**: 접근성 요구사항이 있는 웹 프로젝트. 공공기관/엔터프라이즈 웹사이트에서 필수.

---

## 13. 인프라 & 클라우드

### cloud-infrastructure
- **설명**: 가장 종합적인 인프라 플러그인. 7개 전문 에이전트(클라우드/K8s/Terraform/네트워크/서비스 메시/하이브리드 클라우드). AWS/Azure/GCP, 서비스 메시(Istio/Linkerd), 비용 최적화.
- **에이전트**: cloud-architect (opus), deployment-engineer (haiku), hybrid-cloud-architect (opus), kubernetes-architect (opus), network-engineer (sonnet), service-mesh-expert, terraform-specialist (opus)
- **스킬 8개**: cost-optimization, hybrid-cloud-networking, istio-traffic-management, linkerd-patterns, mtls-configuration, multi-cloud-architecture, service-mesh-observability, terraform-module-library
- **추천**: 클라우드 인프라 설계의 원스톱 솔루션. 멀티 클라우드, 하이브리드 클라우드, 서비스 메시가 필요하면 이것.

### kubernetes-operations
- **설명**: K8s 매니페스트 생성, Helm 차트, 보안 정책, GitOps 워크플로우.
- **에이전트**: kubernetes-architect (opus)
- **스킬 4개**: helm-chart-scaffolding, k8s-manifest-generator, k8s-security-policies, gitops-workflow
- **추천**: K8s를 직접 운영하고 매니페스트/Helm 차트를 작성해야 할 때. cloud-infrastructure가 상위 레벨 설계라면, 이것은 실제 K8s YAML 생성에 초점.

### developer-essentials
- **설명**: 11개 스킬 모음(auth, testing, git, error handling, SQL, monorepo). 에이전트 1개(monorepo-architect). 커맨드 없음.
- **에이전트**: monorepo-architect
- **스킬 11개**: auth-implementation-patterns, bazel-build-optimization, code-review-excellence, debugging-strategies, e2e-testing-patterns, error-handling-patterns, git-advanced-workflows, monorepo-management, nx-workspace-patterns, sql-optimization-patterns, turborepo-caching
- **추천**: Monorepo(Nx/Turborepo/Bazel) 프로젝트에서, 또는 인증 구현 패턴이 필요할 때. 스킬 라이브러리로서의 가치가 큼.

---

## 14. CI/CD & 배포

### cicd-automation
- **설명**: CI/CD 파이프라인 설계. GitHub Actions, GitLab CI, 시크릿 관리(Vault/AWS Secrets Manager), 배포 파이프라인 아키텍처.
- **에이전트**: cloud-architect (opus), deployment-engineer (haiku), devops-troubleshooter (sonnet), kubernetes-architect (opus), terraform-specialist (opus)
- **커맨드**: `/workflow-automate`
- **스킬 4개**: deployment-pipeline-design, github-actions-templates, gitlab-ci-patterns, secrets-management
- **추천**: CI/CD 파이프라인을 새로 구축하거나 개선할 때. GitHub Actions 또는 GitLab CI 템플릿이 특히 유용.

### deployment-strategies
- **설명**: 배포 패턴(rolling/blue-green/canary) + Terraform 고급 모듈 설계. GitOps, 컨테이너 보안, SBOM 생성.
- **에이전트**: deployment-engineer (haiku), terraform-specialist (opus)
- **추천**: Terraform 모듈 설계나 고급 배포 전략(canary, progressive delivery)이 필요할 때.

### deployment-validation
- **설명**: 배포 전 설정 검증. JSON Schema 기반 검증, 환경별 규칙(dev vs prod), AES-256-GCM 민감 설정 암호화.
- **에이전트**: cloud-architect (sonnet)
- **커맨드**: `/config-validate`
- **추천**: 설정 파일 관리가 복잡한 프로젝트에서 "프로덕션 배포 전 검증 게이트"가 필요할 때.

---

## 15. 모니터링 & 옵저버빌리티

### observability-monitoring
- **설명**: 전체 옵저버빌리티 스택 설정. Prometheus/Grafana, OpenTelemetry/Jaeger, Fluentd, Alertmanager, SLO 매니저, Terraform IaC.
- **에이전트**: observability-engineer, database-optimizer, network-engineer, performance-engineer
- **커맨드**: `/monitor-setup`, `/slo-implement`
- **추천**: 모니터링 인프라를 처음 구축하거나 SLO를 도입할 때 필수.

### application-performance
- **설명**: 애플리케이션 레벨 성능 최적화. 프로파일링(플레임 그래프, 힙 덤프), Core Web Vitals, 캐싱 전략. 3페이즈 워크플로우(프로파일링 → 최적화 → 모니터링).
- **에이전트**: frontend-developer, observability-engineer, performance-engineer
- **커맨드**: `/performance-optimization`
- **추천**: "왜 느린지" 체계적으로 분석하고 싶을 때. observability-monitoring이 인프라라면, 이것은 애플리케이션 코드 수준.

---

## 16. AI & ML

### llm-application-dev
- **설명**: LLM 애플리케이션 개발 전문. RAG(Pinecone/Qdrant/Weaviate/pgvector), LangGraph 에이전트, 프롬프트 엔지니어링, 멀티모달 AI, 시맨틱 캐싱.
- **에이전트**: ai-engineer, prompt-engineer, vector-database-engineer
- **커맨드**: `/langchain-agent`, `/ai-assistant`, `/prompt-optimize`
- **추천**: RAG 시스템이나 AI 에이전트를 구축할 때 필수. LangGraph/CrewAI/Claude Agent SDK 등 에이전트 프레임워크 사용 시.

### machine-learning-ops
- **설명**: ML 파이프라인 전체 라이프사이클. 데이터 준비 → 모델 학습 → 서빙(KServe/Seldon) → 모니터링. MLflow/W&B 실험 추적, Feature Store(Feast/Tecton).
- **에이전트**: data-scientist, ml-engineer, mlops-engineer
- **커맨드**: `/ml-pipeline`
- **추천**: ML 모델을 프로덕션에 배포해야 할 때. MLOps 인프라 구축이 필요한 경우.

### agent-orchestration
- **설명**: 에이전트 시스템 메타 최적화. 컨텍스트 엔지니어링, RAG 파이프라인, 벡터 DB 관리, 에이전트 성능 A/B 테스트 및 단계적 롤아웃.
- **에이전트**: context-manager
- **커맨드**: `/improve-agent`, `/multi-agent-optimize`
- **추천**: AI 에이전트 시스템을 운영하면서 성능을 체계적으로 개선하고 싶을 때. 에이전트를 "만드는" 것이 아니라 "튜닝"하는 도구.

### context-management
- **설명**: 세션 간 프로젝트 컨텍스트 저장/복원. 벡터 DB 연동, 토큰 버짓 관리, 시맨틱 검색 기반 복원.
- **에이전트**: context-manager
- **커맨드**: `/context-save`, `/context-restore`
- **추천**: 장기 프로젝트에서 세션을 넘나들며 컨텍스트를 유지해야 할 때. agent-orchestration과 에이전트가 동일하므로 둘 중 택일.

---

## 17. SEO & 마케팅

### seo-content-creation
- **설명**: SEO 콘텐츠 작성 + 기획 + 감사. E-E-A-T 최적화, 키워드 밀도(0.5-1.5%), 토픽 클러스터, 콘텐츠 캘린더.
- **에이전트**: seo-content-writer (sonnet), seo-content-auditor (sonnet), seo-content-planner (haiku)
- **추천**: SEO 콘텐츠를 직접 작성해야 할 때.

### seo-technical-optimization
- **설명**: 기술 SEO. 키워드 전략, 메타 태그, 사이트 구조, JSON-LD 스키마, 피처드 스니펫 최적화.
- **에이전트**: seo-keyword-strategist (haiku), seo-meta-optimizer (haiku), seo-snippet-hunter (haiku), seo-structure-architect (haiku)
- **추천**: 사이트의 기술 SEO를 개선할 때. 모두 haiku 모델이라 가볍게 실행 가능.

### seo-analysis-monitoring
- **설명**: SEO 모니터링. 권위도 구축(E-E-A-T), 키워드 카니발라이제이션 탐지, 콘텐츠 신선도 분석.
- **에이전트**: seo-authority-builder (sonnet), seo-cannibalization-detector (haiku), seo-content-refresher (haiku)
- **추천**: 기존 콘텐츠의 SEO 성과를 분석하고 개선할 때.

### content-marketing
- **설명**: 콘텐츠 마케팅 전략 + 웹 리서치. 콘텐츠 생성, SNS, 이메일 캠페인, 배포 전략.
- **에이전트**: content-marketer (haiku), search-specialist (haiku)
- **추천**: 마케팅 콘텐츠 전략이 필요할 때. SEO 3종과는 별개로 마케팅 전반 커버.

---

## 18. 비즈니스 & 분석

### startup-business-analyst
- **설명**: 스타트업 비즈니스 분석. TAM/SAM/SOM, 코호트 기반 매출 모델, 유닛 이코노믹스, 투자자 문서, 재무 예측.
- **에이전트**: startup-analyst
- **커맨드**: `/business-case`, `/financial-projections`, `/market-opportunity`
- **스킬 5개**: competitive-landscape, market-sizing-analysis, startup-financial-modeling, startup-metrics-framework, team-composition-analysis
- **추천**: 스타트업 창업자가 투자 유치 자료를 만들거나 시장 분석이 필요할 때.

### business-analytics
- **설명**: KPI 추적, 대시보드 설계, 데이터 스토리텔링. Tableau/Power BI/Looker, 코호트 분석, 이탈 예측.
- **에이전트**: business-analyst (sonnet)
- **스킬 2개**: data-storytelling, kpi-dashboard-design
- **추천**: 비즈니스 메트릭스 분석이나 경영진 보고 자료가 필요할 때.

### hr-legal-compliance
- **설명**: HR 정책 문서(채용/온보딩/평가/PIP), 법률 문서(개인정보보호정책/ToS/DPA/쿠키 정책).
- **에이전트**: hr-pro, legal-advisor
- **스킬 2개**: employment-contract-templates, gdpr-data-handling
- **추천**: 비기술 문서가 필요한 경우에만. 소규모 팀에서 HR/법무 문서를 직접 작성해야 할 때.

### customer-sales-automation
- **설명**: 고객 지원 자동화(챗봇, 티케팅, 감정 분석) + 영업 자동화(콜드 이메일, 팔로업, 이의 처리).
- **에이전트**: customer-support (haiku), sales-automator (haiku)
- **추천**: CRM 자동화나 세일즈 이메일 시퀀스가 필요할 때. 개발자보다는 세일즈/CS 업무에 해당.

---

## 19. 도메인 특화

### blockchain-web3
- **설명**: Solidity 스마트 컨트랙트, DeFi 프로토콜(AMM, 렌딩, 거버넌스), NFT(ERC-721/1155), L2(Polygon, Arbitrum, Optimism). Hardhat/Foundry 테스트.
- **에이전트**: blockchain-developer (opus)
- **스킬 4개**: defi-protocol-templates, nft-standards, solidity-security, web3-testing
- **추천**: Web3/블록체인 프로젝트에서만 사용.

### quantitative-trading
- **설명**: 퀀트 트레이딩. 백테스팅, 포트폴리오 최적화(Markowitz, Black-Litterman), 옵션 프라이싱(Greeks), 리스크 관리.
- **에이전트**: quant-analyst, risk-manager
- **스킬 2개**: backtesting-frameworks, risk-metrics-calculation
- **추천**: 금융 퀀트 프로젝트에서만 사용.

### payment-processing
- **설명**: Stripe/PayPal 결제 연동. 5가지 체크아웃 플로우, 웹훅 처리, 구독 빌링, PCI 컴플라이언스.
- **에이전트**: payment-integration (sonnet)
- **스킬 4개**: stripe-integration, pci-compliance, billing-automation, paypal-integration
- **추천**: 결제 기능을 구현해야 하는 프로젝트에서. Stripe 연동 코드가 상세하게 포함되어 있어 실용적.

### game-development
- **설명**: Unity 6 LTS(URP/HDRP, DOTS/ECS, Netcode) + Minecraft Bukkit/Spigot/Paper 플러그인.
- **에이전트**: unity-developer (opus), minecraft-bukkit-pro (opus)
- **스킬 2개**: unity-ecs-patterns, godot-gdscript-patterns
- **추천**: Unity 게임 또는 Minecraft 서버 플러그인 개발에서만 사용.

### reverse-engineering
- **설명**: 바이너리 분석, 멀웨어 분석, 펌웨어 보안 연구. IDA Pro/Ghidra/radare2, Frida, YARA 룰, binwalk. 방어적/합법적 목적 전용.
- **에이전트**: reverse-engineer (opus), malware-analyst (opus), firmware-analyst (opus)
- **스킬 4개**: anti-reversing-techniques, binary-analysis-patterns, memory-forensics, protocol-reverse-engineering
- **추천**: CTF, 보안 연구, 펌웨어 분석에서만 사용. 매우 전문적.

---

## 중복 분석 & 선택 가이드

### 중복이 많은 영역

#### 디버깅 (5개 플러그인)
| 플러그인 | 핵심 차별점 | 추천 대상 |
|---------|-----------|---------|
| **debugging-toolkit** | `/smart-debug` + DX 최적화 | 범용 디버깅 (1순위) |
| **error-debugging** | 에러 모니터링 설정(Sentry/DataDog) + 멀티에이전트 리뷰 | 에러 인프라 구축 |
| **error-diagnostics** | error-debugging과 90% 동일 + `/smart-debug` | **중복, 제거 고려** |
| **distributed-debugging** | VS Code 디버그 설정, V8 프로파일러, OpenTelemetry | Node.js 분산 시스템 |
| **incident-response** | SRE 인시던트 프로세스 전체 | 프로덕션 운영 팀 |

> **추천**: debugging-toolkit + incident-response로 충분. error-debugging은 Sentry 설정이 필요할 때만.

#### 보안 (5개 플러그인)
| 플러그인 | 핵심 차별점 | 추천 대상 |
|---------|-----------|---------|
| **security-scanning** | 위협 모델링 + SAST + 하드닝 워크플로우 | 종합 보안 (1순위) |
| **security-compliance** | GDPR/HIPAA/SOC2 규정 준수 코드 | 규정 준수 필요 시 |
| **backend-api-security** | API 보안 코드 작성 | 백엔드 보안 코딩 |
| **frontend-mobile-security** | XSS/CSRF/CSP + 모바일 보안 | 프론트엔드 보안 |
| **accessibility-compliance** | WCAG 접근성 감사 | 접근성 요구사항 |

> **추천**: security-scanning 필수 + 필요에 따라 compliance/frontend 추가.

#### 코드 품질 (4개 플러그인)
| 플러그인 | 핵심 차별점 | 추천 대상 |
|---------|-----------|---------|
| **comprehensive-review** | 3차원 리뷰(아키/보안/코드) 오케스트레이션 | 종합 리뷰 (1순위) |
| **code-refactoring** | 리팩터링 + 기술 부채 | 레거시 정리 |
| **codebase-cleanup** | code-refactoring + `/deps-audit` | 의존성 감사 포함 |
| **performance-testing-review** | SAST 도구 연동 + 성능 | CI 통합 리뷰 |

> **추천**: comprehensive-review + codebase-cleanup 조합. code-refactoring과 codebase-cleanup은 커맨드가 겹치므로 하나만.

#### 배포 (3개 플러그인)
| 플러그인 | 핵심 차별점 | 추천 대상 |
|---------|-----------|---------|
| **cicd-automation** | CI/CD 파이프라인 설계 + GitHub Actions/GitLab CI | 파이프라인 구축 (1순위) |
| **deployment-strategies** | Terraform 모듈 + 배포 패턴(canary 등) | IaC + 고급 배포 |
| **deployment-validation** | 배포 전 설정 검증 | 설정 관리 자동화 |

> **추천**: cicd-automation 기본 + 필요 시 나머지 추가.

### 최소 추천 세트 (일반 웹 백엔드 프로젝트)

```
필수:
  - python-development 또는 javascript-typescript (사용 언어)
  - backend-development (백엔드 기능 개발)
  - security-scanning (보안 감사)
  - debugging-toolkit (디버깅)

권장:
  - comprehensive-review (코드 리뷰)
  - cicd-automation (CI/CD)
  - database-design (DB 설계)
  - documentation-generation (문서화)
  - tdd-workflows (테스트)

상황별:
  - conductor (체계적 프로젝트 관리)
  - agent-teams (멀티에이전트 병렬 작업)
  - cloud-infrastructure (클라우드 인프라)
  - observability-monitoring (모니터링)
  - incident-response (온콜 운영)
```
