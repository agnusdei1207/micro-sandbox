# micro-sandbox 아키텍처

## 목적

`micro-sandbox`는 npm으로 배포되는 범용 Linux 프로세스 샌드박스다. 신뢰할 수 없는 명령, 코드, 파일 처리기를 커널로 격리된 일회성 작업에서 실행한다. 형식별 parser, 저장소 adapter, cloud integration은 포함하지 않는다.

지원 호스트:

- Linux 커널 5.15 이상
- x86-64와 ARM64
- 위임된 subtree가 있는 cgroup v2
- 비특권 user namespace 활성화 또는 명시적으로 설정한 launcher

패키지는 fail-closed로 동작한다. 격리되지 않은 fallback을 sandboxed로 보고하지 않는다.

## 전체 구조

```text
Node.js API
    |
    | 크기가 제한된 버전형 IPC
    v
Rust supervisor (Sandbox 인스턴스마다 자식 프로세스 하나)
    |-- 리소스 측정, 예약 원장, 대기열
    |-- runtime 및 정책 registry
    |-- cgroup 수명 주기와 작업 감시
    `-- 작업마다 일회성 자식 프로세스 하나
          |-- USER, PID, MOUNT, NET, IPC, UTS, CGROUP namespace
          |-- private tmpfs root와 pivot_root
          |-- no_new_privs, capability 제거, seccomp
          `-- 명령, 코드 runtime 또는 sanitizer
```

Supervisor는 신뢰 영역이지만 비신뢰 파일 형식을 파싱하지 않는다. 파서와 사용자 명령은 작업 프로세스 안에서만 실행한다.

## 공개 모델

`createSandbox()`는 supervisor를 지연 실행한다. `sandbox.run()`은 작업을 실행한다. `sandbox.close()`는 새 작업을 막고, 실행 중 작업을 완료하거나 취소한 뒤 모든 리소스를 제거한다.

```ts
await using sandbox = await createSandbox();

const result = await sandbox.run({
  command: "/app/tool",
  args: ["--input", "/workspace/input"],
  files: { "/workspace/input": input },
  outputs: ["/workspace/output"],
});
```

같은 primitive로 네이티브 도구, 등록된 Node/Python runtime, 컴파일, 미디어 변환, 사용자가 제공한 sanitizer를 실행한다.

## 설정

정책은 다음 순서로 합성한다.

1. 안전한 패키지 기본값
2. 인스턴스 기본값과 운영자 상한
3. 이름이 있는 runtime 또는 작업 profile
4. 운영자 상한 안의 작업별 값

기본 제한:

| 리소스 | 기본값 | 기본 상한 |
|---|---:|---:|
| 실행 시간 | 5초 | 30초 |
| 메모리 | 256 MiB | 512 MiB |
| Swap | 0 | 0 |
| CPU quota | 0.5 core | 1 core |
| 프로세스 | 16 | 32 |
| 입력 | 25 MiB | 100 MiB |
| 전체 출력 | 50 MiB | 200 MiB |

운영자는 기본값과 상한을 변경할 수 있다. 작업은 그 범위 안의 값만 요청할 수 있다. 핵심 격리 불변 조건은 끌 수 없다.

## 작업 수명 주기

1. 요청, 경로, runtime digest, 정책, 크기 제한을 검증한다.
2. 유효 cgroup의 CPU, 메모리, PID 잔여량을 읽는다.
3. 용량을 원자적으로 예약하거나 대기열 backpressure를 적용한다.
4. 작업 cgroup을 만들고 설정한다.
5. `clone3()`로 자식을 생성하면서 처음부터 해당 cgroup에 배치한다.
6. 자식이 동기화 파이프에서 대기하는 동안 UID/GID mapping을 기록한다.
7. Mount propagation을 private로 만들고, tmpfs root를 구성하고, 검증된 runtime asset만 bind한 뒤 `pivot_root()`를 호출한다.
8. Network namespace를 단절 상태로 유지하고, 상속 FD를 닫고, `no_new_privs`와 capability 제거 후 profile의 seccomp filter를 적용한다.
9. Supervisor가 실행 시간, 출력, 메모리, CPU, 자손을 제한하며 작업을 실행한다.
10. 선언된 출력만 검증하고 수집한다.
11. pidfd와 `cgroup.kill`로 남은 자손을 종료하고 회수한 뒤 root를 unmount하고 cgroup을 삭제하고 예약을 해제한다.

모든 실패는 같은 정리 경로를 사용한다.

## 보안 불변 조건

- Shell interpolation을 사용하지 않는다.
- 기본적으로 호스트 네트워크를 제공하지 않는다.
- 기본적으로 호스트 파일시스템, 환경변수, FD를 상속하지 않는다.
- 정규화된 guest 절대 경로만 허용하며 `..`, symlink, device, mount 탈출을 막는다.
- Runtime bundle과 custom processor는 시작 시 등록하고 digest를 검증한다.
- 확장 정책은 격리를 강화할 수 있지만 금지 capability나 호스트 접근을 활성화할 수 없다.
- 성공 결과에는 격리 보고서가 포함된다. 필수 제어가 없으면 `ISOLATION_UNAVAILABLE`을 반환한다.
- Namespace는 호스트 커널을 공유하므로 VM 경계는 아니다.

## 용량과 안정성

Rust supervisor가 단일 예약 원장을 소유해 동시 초과 수용을 막는다. 가용 용량은 호스트 가용량과 supervisor의 유효 cgroup 잔여량 중 작은 값에서 운영자 reserve와 활성 예약을 뺀 값이다.

자동 동시성은 CPU quota, 메모리, PID, 현재 작업, Linux pressure stall information을 고려한다. 압력이 높으면 신규 수용을 멈춘다. Overload 정책에 따라 제한된 FIFO 대기열에서 기다리거나 `CAPACITY_EXCEEDED`를 반환한다.

Node client는 heartbeat를 감시한다. Supervisor가 종료되면 활성 작업을 일관되게 실패 처리하고 남은 리소스를 정리하며, 이후 요청에서 재시작할 수 있다. 출력 폭주, 무시된 signal, double fork, OOM, timeout은 cgroup 경계에서 종료한다.

## 확장성

확장은 supervisor에 동적 라이브러리를 로드하지 않고 격리된 실행 파일로 제공한다.

등록 runtime은 불변 rootfs 또는 bundle, entrypoint, digest, 기본 profile, 허용 환경변수 키를 정의한다. 작업 profile은 내장 profile을 상속하며 hard deny 목록 안에서 제한을 조정하거나 검토된 syscall을 추가할 수 있다. 사용자 요청은 runtime, 실행 파일 경로, mount, seccomp 정책을 등록할 수 없다.

내장 profile은 strict native 실행, interpreted code, compilation, media processing을 제공한다. Recipe는 sanitizer나 transcoder 등록 방법을 보여주되 parser, 형식 정책, 저장 위치를 핵심 패키지에 포함하지 않는다.

## 오류와 관측성

API는 `CAPACITY_EXCEEDED`, `POLICY_VIOLATION`, `ISOLATION_UNAVAILABLE`, `TIMEOUT`, `OUT_OF_MEMORY`, `OUTPUT_TOO_LARGE`, `SECCOMP_VIOLATION`, `PROCESSOR_CRASH` 같은 안정된 코드를 사용한다.

결과에는 exit status, 제한된 stdout/stderr, 선언된 출력 파일, 적용된 격리 제어, 리소스 사용량, 실행 시간이 포함된다. Hook은 파일 내용, 비밀값, 상속 환경변수 없이 수명 주기 이벤트를 받는다.

## 배포와 검색 노출

JavaScript 패키지는 Linux x86-64 또는 ARM64용 optional platform package에서 바이너리를 선택한다. 미지원 플랫폼은 초기화 단계에서 명확한 진단으로 실패한다.

npm manifest와 README는 짧고 일관된 description과 핵심 검색어를 사용한다: `sandbox`, `linux-sandbox`, `nodejs-sandbox`, `process-isolation`, `untrusted-code`, `cgroups`, `namespaces`, `seccomp`, `resource-limits`, `rootless`. Repository, homepage, issues, engines, OS, CPU, license, provenance metadata를 정확하게 유지한다. GitHub topics는 주요 npm keyword와 맞춘다.

## 검증 게이트

릴리스 조건:

- Rust와 TypeScript unit test
- Protocol 및 정책 호환성 test
- Linux x86-64와 ARM64 integration test
- Namespace, cgroup, mount, network, seccomp 적용 검증
- Fork, memory, CPU, output, file-count, decompression bomb
- Symlink, path traversal, FD, 환경변수, `/proc`, network 탈출 시도
- Timeout, OOM, supervisor crash, cancellation, cleanup fault injection
- 동시 수용과 리소스 예약 stress test
- 반복 실행 leak 및 soak test
- npm tarball 설치와 smoke test

필수 격리가 생략되거나, 정리 후 자식 또는 cgroup이 남거나, 어느 아키텍처든 실패하거나, npm 압축 산출물이 독립 실행되지 않으면 배포를 막는다.
