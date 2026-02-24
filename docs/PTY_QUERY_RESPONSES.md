# PTY Query Responses (discode `pty` runtime)

## 목적

`src/runtime/pty-runtime.ts`의 `buildTerminalResponse()`가 어떤 터미널 질의(escape query)에
어떻게 응답하는지 명시한다.

이 문서는 `pty` 모드에서의 호환 범위를 고정하기 위한 운영 문서다.

## 범위

- 대상: `runtimeMode = "pty"`
- 비대상: `runtimeMode = "tmux"` (tmux/terminal native behavior 사용)

## 지원 질의와 응답

## DSR / CSI queries

1. `CSI 6 n` (`\x1b[6n`)
- 의미: 커서 위치 요청
- 응답: `CSI <row> ; <col> R` (1-based)

2. `CSI ? 6 n` (`\x1b[?6n`)
- 의미: DEC 커서 위치 요청
- 응답: `CSI <row> ; <col> R` (1-based)

3. `CSI 5 n` (`\x1b[5n`)
- 의미: 장치 상태 요청
- 응답: `CSI 0 n`

## Private mode query (DECRQM-like)

1. `CSI ? <mode> $ p` (`\x1b[?<mode>$p`)
- 의미: private mode 상태 질의
- 응답: `CSI ? <mode> ; <state> $ y`

`state` 규칙:

- `1`: enabled
- `2`: disabled

기본값:

- `?7` (autowrap): 기본 enabled
- `?25` (cursor visible): 기본 enabled
- 그 외는 명시적 set(`CSI ? <mode> h/l`)이 없으면 disabled

## OSC color queries

1. `OSC 10 ; ? ST/BEL` (`\x1b]10;?\x07`)
- 의미: foreground color 질의
- 응답: `OSC 10 ; rgb:rrrr/gggg/bbbb BEL`

2. `OSC 11 ; ? ST/BEL` (`\x1b]11;?\x07`)
- 의미: background color 질의
- 응답: `OSC 11 ; rgb:rrrr/gggg/bbbb BEL`

3. `OSC 4 ; <idx> ; ? ST/BEL` (`\x1b]4;<idx>;?\x07`)
- 의미: xterm palette index 질의
- 응답: `OSC 4 ; <idx> ; rgb:rrrr/gggg/bbbb BEL`
- 인덱스 범위: `0..255`

## 기타 응답

1. Primary DA (`CSI c`, `\x1b[c`)
- 응답: `CSI ?62 ; c`

2. Kitty keyboard capability probe (`CSI ? u`, `\x1b[?u`)
- 응답: `CSI ?0u`

3. Window pixel size probe (`CSI 14 t`, `\x1b[14t`)
- 응답: `CSI 4 ; <heightPx> ; <widthPx> t`
- 값은 현재 cols/rows 기반 추정치

4. Kitty graphics handshake (`APC ... a=q ... ST`)
- 응답: `\x1b_Gi=31337;OK\x1b\\`

## 부분 시퀀스 처리

- 입력 chunk 경계에서 escape sequence가 잘린 경우 `queryCarry`에 보관 후 다음 chunk와 합쳐 처리한다.
- 완결되지 않은 상태에서는 응답을 보내지 않는다.

## 의도적 비지원

- 전체 ANSI/DEC/XTerm 질의를 완전 구현하지 않는다.
- 미지원 질의는 무응답(no-op) 처리한다.

## 테스트 맵핑

관련 테스트:

- `tests/runtime/pty-runtime.test.ts`
  - DSR 응답
  - private mode 응답
  - OSC color query 응답

