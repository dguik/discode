# PTY Runtime Diagnostics Metrics

`discode`의 `pty` 런타임 디버깅을 위해 내부 카운터를 제공한다.

구현 위치:

- `src/runtime/vt-diagnostics.ts`

주요 카운터:

1. `vt_partial_sequence_carry|kind=<escape|csi|osc>`
- VT 파서가 chunk 경계에서 불완전 시퀀스를 carry로 넘긴 횟수

2. `vt_unknown_escape|next=<char>`
- 미지원 ESC 시퀀스의 다음 문자 분포

3. `vt_unknown_csi|final=<char>`
- 미지원 CSI final 문자 분포

4. `pty_query_partial_carry|kind=<escape|csi|osc|apc>`
- query 응답기에서 부분 시퀀스를 carry로 보관한 횟수

5. `pty_query_response|kind=<...>`
- query 응답 전송 횟수(DSR/OSC/private mode 등)

6. `stream_forced_flush`
- stream 서버가 강제 flush를 수행한 횟수

7. `stream_coalesced_skip`
- coalescing 규칙으로 frame 전송을 생략한 횟수

8. `stream_runtime_error`
- runtime buffer 접근 중 예외로 `runtime_error` 응답을 보낸 횟수

테스트:

- `tests/runtime/vt-diagnostics.test.ts`

