# micro-sandbox 아키텍처

## 범위

`micro-sandbox`는 파일 새니타이저가 아니라 범용 명령 실행 샌드박스입니다. 실행 파일과 런타임 루트는 호출자가 선택하며, 재인코딩·파싱·스토리지·클라우드 연동은 신뢰 코어 밖에서 조합합니다.

- 실행 환경: Linux 5.15+, cgroup v2, x86-64 또는 ARM64
- 도구 체인: Node.js 24.18+ LTS, Rust 1.97.1, Edition 2024
- 보안 경계: 호스트 커널을 공유하는 강화된 프로세스/컨테이너 경계이며 VM은 아님
- 동작 원칙: 필수 제어가 하나라도 실패하면 실행을 거부하며 비격리 fallback은 없음

## 구성

```text
Node.js API
  ├─ 불변 기본값/상한, 제한된 큐, 프로필, 런타임
  └─ 크기가 제한된 protocol v1
       └─ Rust supervisor
            ├─ 실시간 cgroup 용량 + 원자적 예약
            └─ 작업마다 단일 스레드 launcher
                 └─ USER/PID/MNT/NET/IPC/UTS/CGROUP namespace의 clone3 자식
```

Supervisor는 호출자 플러그인이나 파일을 로드하지 않습니다. 새 단일 스레드 launcher가 namespace를 생성하므로 supervisor 스레드 상태를 fork 이후 건드리지 않습니다.

## API와 정책

`Sandbox.run()`은 명령 또는 등록된 런타임, 인자, guest 작업 디렉터리, 명시적 환경 변수, 제한된 stdin, 리소스 override, `AbortSignal`을 받습니다. 결과에는 종료 코드/시그널, timeout·OOM·출력 초과 여부, 제한된 stdout/stderr, 실행 시간, 샘플링한 peak memory, 격리 보고서가 포함됩니다.

정책 순서는 패키지 기본값 → 인스턴스 기본값/상한 → 프로필 → 작업 override입니다. 기본값은 5초, 256 MiB, CPU 0.5, PID 16개, 입력 64 KiB, 전체 출력 256 KiB입니다. 기본 상한은 30초, 512 MiB, CPU 1, PID 32개, 입력/전체 출력 512 KiB입니다. Node 설정을 더 높여도 네이티브 계층은 원시 입력과 합산 출력을 512 KiB로 영구 제한합니다.

Node 큐는 제한되며 동시 실행은 최대 64개입니다. 네이티브 요청 채널과 활성 작업 수도 제한됩니다. 네이티브 예약에는 launcher/supervisor 오버헤드가 포함됩니다. Supervisor는 실행 직전 위임된 cgroup과 모든 cgroup-v2 상위 계층의 남은 용량을 읽고 20%를 운영 여유로 남긴 뒤, 기존 예약과 새 요청을 원자적으로 비교합니다. Swap은 항상 0입니다.

## 작업 수명 주기

1. 제한된 protocol, 숫자 상한, 경로, 환경 변수, 입력, 런타임 루트를 검증합니다.
2. Supervisor가 불투명한 cgroup ID를 생성합니다. 호출자 ID는 파일시스템 경로가 되지 않습니다.
3. 현재 용량을 예약하고 cgroup에 memory, swap 0, CPU, PID 제한을 기록합니다.
4. 보호된 launcher를 시작하고 pidfd를 연 뒤, 모든 필수 namespace와 `CLONE_INTO_CGROUP`을 사용해 `clone3`를 호출합니다.
5. 자식을 멈춘 상태로 1개 항목의 UID/GID map을 기록합니다. 보안 설정 시간도 작업 timeout에 포함됩니다.
6. mount propagation을 private으로 만들고 tmpfs root를 생성합니다. 런타임 디렉터리를 재귀적으로 read-only·`nosuid`·`nodev` bind하고 안전한 device와 private `/proc`, `/tmp`를 추가한 뒤 `pivot_root`로 호스트 root를 분리합니다.
7. 작업 디렉터리를 설정하고 모든 capability를 제거하며 core dump를 끕니다. `no_new_privs`와 seccomp를 적용하고 명시적 환경으로 `execve`합니다.
8. 표준 스트림을 불변 합산 상한 안에서 동시에 처리합니다. Timeout과 취소는 pidfd와 `cgroup.kill`로 프로세스 트리 전체에 적용합니다.
9. Namespace init을 회수하고 남은 자식을 종료합니다. OOM event와 peak memory를 읽고(Linux 5.15에서는 제한된 `memory.current` 샘플링으로 보완), cgroup/staging 상태와 예약을 제거합니다.

RAII guard를 통해 설정·I/O·protocol·취소·supervisor 실패 경로가 모두 kill/reap/cleanup으로 수렴합니다. Supervisor→launcher와 launcher→격리 자식 모두 parent-death signal 및 설정 경쟁 검사를 사용합니다. 시작 시 남은 소유 cgroup도 정리합니다.

## 파일시스템과 syscall 경계

런타임의 `/bin`, `/sbin`, `/usr`, `/lib`, `/lib64`만 mount합니다. Canonical 대상이 canonical 런타임 루트 내부인지 검사하며, 재귀 `mount_setattr`로 중첩 submount까지 read-only·`nosuid`·`nodev`로 만듭니다. 호스트 `/etc`, home, secret, socket, 상속 환경 변수는 노출하지 않습니다. `/tmp`는 private·크기 제한·`nodev`·`nosuid`·`noexec`이고, `/dev`에는 `null`, `zero`, `random`, `urandom`만 둡니다.

모든 capability mask는 0입니다. Seccomp는 기존/신규 mount API, namespace 재할당, namespace 생성 clone, ptrace, BPF, kernel module, keyring, reboot, swap, kexec, perf, userfaultfd 등 고위험 호출을 거부합니다. Network namespace에는 호스트 interface와 route가 없습니다.

Seccomp denylist는 namespace·capability·mount·cgroup 경계를 보강하는 방어 계층입니다. 미래의 모든 커널 취약점에 대한 면역이나 VM과 동일한 격리를 주장하지 않습니다.

## 확장성

확장은 조합으로 처리합니다. 호출자가 원하는 root와 entrypoint를 등록하면 같은 비활성화 불가능한 제어 아래에서 실행됩니다. 이미지 재인코딩은 ImageMagick, 코드 실행은 Node·Python·컴파일러·사용자 실행 파일을 호출할 수 있습니다. 패키지 자체에는 parser, sanitizer, S3 adapter, 런타임 의존성이 없습니다.

공개 API는 의도적으로 제한된 stdin/stdout/stderr만 제공합니다. 임의 artifact 회수는 별도로 설계하고 검증한 data plane이 필요합니다.

## 배포와 릴리스

`cpu`, `memory`, `pids` controller가 위임된 전용 빈 cgroup-v2 하위 트리가 필요합니다. systemd에서는 `Delegate=cpu memory pids`를 사용하고 자식 트리를 `cgroupRoot` 또는 `MICRO_SANDBOX_CGROUP_ROOT`로 전달합니다.

메인 npm 패키지는 Windows 개발을 지원하지만 실제 실행은 지원 Linux가 아니면 거부합니다. x64/ARM64 선택 패키지는 정적 musl ELF를 포함하므로 glibc 사용자 공간에 의존하지 않습니다.

릴리스 게이트는 Windows/Linux strict TypeScript 테스트, Rustfmt, 경고를 거부하는 Clippy, x64/ARM64 Rust 테스트, 양 아키텍처 privileged namespace/cgroup/seccomp 및 공개 API 통합 테스트, 취소/강제 종료 정리, 출력·용량 경쟁, npm audit, 정적 ELF 검증, 패키지 clean install, 태그/버전 일치, SHA-256 checksum을 포함합니다.
