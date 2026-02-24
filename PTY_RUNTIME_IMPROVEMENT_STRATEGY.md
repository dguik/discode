# Discode PTY Runtime 개선 전략 (Zellij 차용 기반)

## 1. 목표

`discode`의 `pty` 런타임에서 발생하는 출력 오류/동작 오류를 줄이고, 장기적으로는 안정적인 터미널 호환성 계층을 확보한다.

핵심 목표:

- 화면 렌더 정확도 향상 (커서 위치, 줄바꿈, 스크롤, alt-screen)
- 입력/응답 안정성 향상 (CSI/OSC/DECRQM 질의 응답 포함)
- 회귀 방지 체계 구축 (fixture + snapshot + e2e)
- 필요 시 Rust sidecar로 확장 가능한 구조 확보

---

## 2. 현재 문제 요약

현재 `pty` 런타임은 다음 구조다.

- 실행: `src/runtime/pty-runtime.ts`
- VT 상태/렌더: `src/runtime/vt-screen.ts`
- 스트리밍: `src/runtime/stream-server.ts`
- 메시지 라우팅 시 캡처 사용: `src/bridge/message-router.ts`

문제는 기능 부재 자체보다 **부분 구현된 VT 호환 계층의 경계**에서 자주 발생한다.

- 특정 ANSI/CSI/OSC 시퀀스 처리 누락/불완전
- 상태 머신 경계(부분 시퀀스, pending input, wrap, scroll region) 불안정
- TUI/CLI별 질의 시퀀스 응답 불일치
- 변경 시 재현/검증 자동화 부족

---

## 3. Zellij에서 차용할 원칙

`zellij` 코드를 직접 이식하기보다, 아래 설계 원칙을 차용한다.

1. 파이프라인 분리
- PTY I/O
- ANSI/VT 파싱
- Screen model 업데이트
- 렌더/전송

2. 상태 중심 설계
- “출력 문자열”이 아니라 “터미널 상태”를 1급 객체로 유지
- 커서/스타일/스크롤/alt-screen을 단일 소스에서 관리

3. 명시적 계약
- 입력 이벤트(키, resize)와 출력 이벤트(frame/patch)의 계약 고정
- 미지원 시퀀스는 무시하되, 로깅/메트릭으로 누적

4. 회귀 중심 테스트
- 실제 터미널 출력 fixture 기반 snapshot 비교
- 복잡한 시퀀스(alt-screen, wide-char, query) 전용 테스트 추가

---

## 4. 실행 전략

## 4.1 Phase 1: TS 런타임 하드닝 (즉시 착수)

목표: 현재 구조를 유지하면서 가장 큰 오류를 빠르게 줄인다.

작업:

1. VT 처리 우선순위 버그픽스
- `wrapPending`, `lineFeed`, scroll region 경계 재검증
- `CSI J/K/L/M/S/T`, `CSI r`, `DECSC/DECRC`, alt-screen 전환 시 상태 일관성 점검
- 분할 입력(chunk split) 시 pending 시퀀스 파손 방지

2. query 응답 정책 정비 (`buildTerminalResponse`)
- 현재 지원 쿼리와 응답 포맷 명세화
- 미지원 쿼리는 no-op + debug 카운터
- 과도한 가짜 응답 제거, 필요한 최소 응답만 유지

3. stream 안정성
- `frame-styled`/`patch-styled` 전환 조건 고정
- resize race 시 cursor/frame 불일치 방지
- burst 출력에서 emit coalescing 튜닝

4. 관측성 추가
- `VT_UNKNOWN_SEQUENCE_COUNT`
- `VT_PARTIAL_SEQUENCE_CARRY_COUNT`
- `PTY_QUERY_RESPONSE_COUNT` (타입별)
- `FRAME_PATCH_RATIO`, `FRAME_DROP_COUNT`

산출물:

- `src/runtime/vt-screen.ts` 안정화 패치
- `src/runtime/pty-runtime.ts` query 응답 패치
- `src/runtime/stream-server.ts` 전송 안정화 패치
- 디버그 로그 + 메트릭

---

## 4.2 Phase 2: 테스트 체계 강화 (Phase 1과 병행)

목표: “고친 뒤 다시 깨짐”을 막는다.

작업:

1. VT fixture 테스트 신설
- fixture 입력(ANSI stream) -> expected styled frame snapshot
- 케이스: prompt redraw, progress, alt-screen 진입/이탈, wide-char, scrollback

2. query-response 테스트
- DSR(6n), private mode query, OSC color query 등 현재 지원 범위 검증

3. e2e 시나리오
- 실제 agent CLI(claude/opencode/codex) 출력 캡처
- 재현 케이스를 fixture로 승격

4. failure corpus 운영
- 사용자 보고 로그에서 최소 재현 문자열 수집
- 회귀 테스트로 자동 편입

산출물:

- `tests/runtime/*` 신설 (fixture + snapshot)
- 실패 재현 corpus 문서/데이터

---

## 4.3 Phase 3: 아키텍처 경계 정리 (Hybrid 준비)

목표: TS 구현 한계에 대비해 Rust sidecar로 이동 가능한 인터페이스를 만든다.

작업:

1. Runtime 인터페이스 고정
- `start`, `input(bytes)`, `resize`, `get_frame`, `stop`
- 세션/윈도우 식별자 규약 통일

2. control-plane/stream-plane 분리 강화
- 제어(명령)와 프레임(스트림) 경계 명확화
- serialization format 버전 필드 도입

3. feature flag 도입
- `runtimeMode: pty-ts | pty-rust | tmux`
- 점진 롤아웃 가능하도록 설정 분리

산출물:

- 인터페이스 문서
- 어댑터 레이어
- feature flag + fallback 경로

---

## 4.4 Phase 4: Rust sidecar PoC (선택적, 기준 충족 시)

진입 조건 (아래 중 2개 이상):

- Phase 1/2 후에도 재현 불가/간헐 오류가 지속됨
- VT 호환 요구가 커져 TS 상태머신 유지비가 급증
- 성능 병목이 parser/renderer에 집중됨

PoC 범위:

- 단일 윈도우 PTY + VT 파싱 + styled frame 반환
- UDS/pipe RPC로 Node와 연동
- 기존 `pty-ts` 대비 정확도/CPU 비교

성공 기준:

- 핵심 fixture pass율 상승
- CPU 사용량 개선 또는 동급
- 사용자 체감 오류 감소

---

## 5. 구체 작업 백로그

P0:

1. `vt-screen`의 alt-screen + scroll region 경계 버그 보강
2. `buildTerminalResponse` 응답 범위 문서화/정리
3. stream frame/patch 경계 안정화
4. VT fixture 테스트 최소 20개 확보

P1:

1. wide-char/combining-char 처리 고도화
2. cursor style/state query 대응 확장
3. CLI별(Claude/OpenCode/Codex) 회귀 테스트 세트 구축

P2:

1. runtime 프로토콜 버전 도입
2. Rust sidecar PoC 착수

---

## 6. 리스크와 대응

리스크:

1. TS 구현 복잡도 상승으로 유지보수 비용 증가
2. CLI별 비표준 escape sequence 대응 누락
3. 패치 최적화가 정확도를 훼손할 가능성

대응:

1. “정확도 우선, 최적화 후순위” 원칙 유지
2. 미지원 시퀀스는 silent-ignore 대신 관측 가능하게 처리
3. 변경마다 fixture/e2e 게이트 통과 필수

---

## 7. 완료 기준 (Definition of Done)

다음을 모두 만족하면 1차 개선 완료로 판단:

1. 기존 주요 PTY 오류 재현 케이스 80% 이상 해결
2. VT fixture + e2e 테스트가 CI에서 안정적으로 통과
3. frame/patch 스트림 불일치 이슈가 재현되지 않음
4. 미지원 시퀀스/오류에 대한 메트릭 관측 가능

---

## 8. 권장 진행 순서 (2주 스프린트 예시)

Week 1:

1. P0-1, P0-2 구현
2. 핵심 fixture 10개 작성
3. 재현 로그 수집 파이프라인 정리

Week 2:

1. P0-3 구현
2. fixture 20개 + e2e 시나리오 통합
3. 안정화 후 rollout, 잔존 이슈 평가

---

## 9. 결론

현 시점에서 가장 현실적인 접근은:

1. TS 기반 PTY 런타임을 먼저 단단히 만들고
2. 테스트/관측 체계를 구축한 뒤
3. 필요할 때 Rust sidecar로 이동하는 단계적 전략

즉, “즉시 품질 개선”과 “장기 확장성”을 동시에 확보하는 방향으로 진행한다.
