# micro-sandbox 아키텍처

## 1. 범위와 지원 환경

`micro-sandbox`는 npm으로 배포되는 범용 프로세스 샌드박스다. 호출자가 선택한 프로그램을 실행하며, 파일 형식 파싱·새니타이징·스토리지·클라우드 연동은 신뢰 코어 밖에 둔다.

- 실행 환경: Linux 커널 5.15 이상, cgroup v2, x86-64 또는 ARM64.
- 개발 도구: Node.js 24.18+ LTS, Rust 1.97.1, Edition 2024.
- 개발 환경: Windows와 Linux에서 TypeScript 테스트와 패키징을 지원하며, 커널 통합 테스트는 Linux가 필요하다.
- 경계: namespace는 호스트 커널을 공유한다. 강화된 프로세스/컨테이너 경계이며 VM 경계는 아니다.

필수 제어를 사용할 수 없으면 fail-closed로 실패한다. 비격리 fallback은 없다.

## 2. 구성 요소

```text
Node.js API
  ├─ 정책 상한, FIFO 큐, runtime, 리소스 profile
  └─ 크기가 제한된 protocol v1
       └─ Rust supervisor
            ├─ 실시간 cgroup 용량 측정 + 예약 원장
            └─ 작업별 launcher 프로세스
                 └─ USER/PID/MNT/NET/IPC/UTS/CGROUP namespace의 clone3 자식
```

장기 실행 supervisor는 호출자 plugin을 로드하거나 파일을 파싱하지 않는다. 각 launcher는 `clone3` 전까지 새 단일 스레드 프로세스이므로 supervisor 스레드 상태를 fork 이후에 건드리지 않는다.

## 3. 공개 실행 모델

`Sandbox.run()`은 명령 또는 등록된 runtime entrypoint, 인자, 정규화된 guest 작업 디렉터리, 명시적 환경 변수, 제한된 stdin, 리소스 override, `AbortSignal`을 받는다. 결과에는 종료 코드, 숫자 signal, timeout/출력 초과 여부, 제한된 stdout/stderr, peak memory, 실행 시간, 적용된 격리 보고서가 들어간다.

Runtime은 호출자가 소유한 root 디렉터리와 entrypoint다. Profile은 호출자가 정의하는 리소스 제한 template이다. 둘 다 parser를 추가하거나 격리를 약화하지 않는다.

## 4. 정책과 용량

정책 순서는 패키지 기본값 → instance 기본값/상한 → profile → 작업 override다. 기본값은 5초, 256 MiB, CPU 0.5, PID 16개, 입력 64 KiB, 전체 출력 256 KiB다. 기본 상한은 30초, 512 MiB, CPU 1, PID 32개, 입력과 전체 출력 각각 512 KiB다. Swap은 항상 0이다.

Supervisor는 매 실행 직전에 위임된 cgroup의 현재/최대 memory와 PID, CPU quota를 읽는다. 무제한 값은 호스트 가용량으로 대체한다. 운영 여유를 위해 80%만 admission 대상으로 사용한다. 동시에 원자적 예약 원장이 활성 작업의 선언 상한을 예약한다. 실시간 용량이나 예약 용량이 부족하면 프로세스를 만들기 전에 `CAPACITY_EXCEEDED`를 반환한다.

Node 계층은 제한된 FIFO 큐와 설정 가능한 동시 실행 수를 제공한다. 최종 강제 경계는 커널 cgroup이다.

## 5. 작업 수명 주기

1. Protocol 크기, 경로, NUL, 환경 변수, base64 입력, 숫자 제한을 검증한다.
2. 실시간 용량을 다시 확인하고 선언된 최대치를 원자적으로 예약한다.
3. 작업 cgroup을 만들고 memory, swap 0, CPU, PID 제한을 기록한다.
4. 전용 launcher를 시작하고 pidfd를 연 뒤 모든 namespace와 `CLONE_INTO_CGROUP`을 사용해 `clone3`를 호출한다.
5. 부모가 한 항목짜리 UID/GID map을 기록하는 동안 자식을 동기화 pipe에서 대기시킨다.
6. Mount propagation을 private으로 만들고 tmpfs root를 생성한다. Runtime 디렉터리를 read-only bind하고 안전한 device만 추가한 뒤 private `/proc`, `/tmp`를 mount하고 `pivot_root`로 호스트 root를 분리한다.
7. 작업 디렉터리를 설정하고 모든 capability set을 0으로 만든다. `no_new_privs`와 seccomp를 적용하고 helper FD는 exec에서 닫은 뒤, 호출자가 shell을 명시하지 않은 한 shell 없이 실행한다.
8. 전체 크기 제한 아래 stdin/stdout/stderr를 동시에 처리한다. Wall time과 취소는 pidfd와 `cgroup.kill`로 프로세스 트리 전체에 적용한다.
9. Namespace init을 회수하고 남은 자식을 종료한다. Peak memory를 읽고 cgroup/staging 디렉터리를 제거한 다음 예약을 반환한다.

격리 자식에는 부모 종료 signal이 설정되며, launcher가 강제 종료되면 supervisor가 cgroup을 재정리한다.

## 6. 파일시스템과 runtime 모델

Runtime root 전체를 그대로 노출하지 않는다. `/bin`, `/sbin`, `/usr`, `/lib`, `/lib64`만 새 tmpfs root에 재귀적으로 read-only bind한다. 호스트 `/etc`, home, 애플리케이션 secret, socket, 상속 환경 변수는 없다. `/tmp`는 private이며 크기가 제한되고 `nodev`, `nosuid`, `noexec`다. `/dev`에는 bind-mounted `null`, `zero`, `random`, `urandom`만 둔다.

0.0.1은 임의 output 파일을 안전하게 회수한다고 과장하지 않고, 크기가 제한된 stdin/stdout/stderr만 공개한다. 대용량 artifact 전송은 샌드박스 경계를 바꾸지 않는 별도 검증 data plane으로 이후 추가할 수 있다.

## 7. 보안 불변 조건

- Network namespace에는 호스트 interface나 route가 없다.
- Effective, permitted, inheritable, bounding, ambient capability mask가 모두 0이어야 한다.
- `no_new_privs`와 baseline seccomp filter는 필수다.
- Mount, namespace 재할당, ptrace, BPF, kernel module, keyring, reboot, swap, kexec, perf, userfaultfd 등 고위험 syscall을 거부한다.
- 경로는 정규화된 절대 guest 경로다. 인자와 환경 변수는 NUL을 거부하고 환경 크기를 제한한다.
- Control frame은 1 MiB, stdout과 stderr는 하나의 전체 출력 budget으로 제한한다.
- Job ID는 cgroup 경로가 되기 전에 제한한다.
- clone3, namespace, 위임 controller, cgroup v2, pivot root, capability 제거, seccomp 중 하나라도 없으면 작업을 중단한다.

Seccomp denylist는 namespace/capability/filesystem 격리를 보강하는 방어 계층이다. VM이나 미래의 모든 커널 취약점에 대한 증명으로 표현하지 않는다.

## 8. 확장성과 예제

확장은 조합으로 해결한다. 호출자 소유 runtime을 등록하고 그 binary를 실행한다. 이미지 재인코딩은 ImageMagick, 코드 실행은 Node·Python·compiler·사용자 executable을 사용할 수 있다. 예제는 범용 작업 요청만 만든다. 해당 도구를 패키지 dependency로 넣지 않는다.

운영자는 안전한 기본값, 강제 상한, queue 용량, 리소스 profile, runtime rootfs, entrypoint, native binary 경로를 바꿀 수 있다. Namespace, network, cgroup, capability, pivot-root, seccomp 제어는 끌 수 없다.

## 9. 배포와 패키징

서비스에는 `cpu`, `memory`, `pids` controller가 활성화된 쓰기 가능한 cgroup v2 하위 트리가 위임되어야 한다. systemd에서는 `Delegate=cpu memory pids`를 사용하고, 만들어진 비어 있는 자식 subtree를 `cgroupRoot` 또는 `MICRO_SANDBOX_CGROUP_ROOT`로 전달한다. Supervisor는 이를 검증하며 약한 모드를 자동 선택하지 않는다.

메인 npm 패키지는 Windows 개발 환경에도 설치되지만 실행은 명확히 거부한다. 선택 dependency인 `micro-sandbox-linux-x64`와 `micro-sandbox-linux-arm64`가 각 ELF binary를 제공한다. CI는 두 아키텍처에서 native build/test를 수행하며, release는 platform 패키지를 먼저 provenance와 함께 배포한다.

## 10. 검증과 릴리즈 게이트

필수 게이트는 엄격한 TypeScript compile, Windows/Linux Node 단위·API 테스트, Rustfmt, warning을 모두 거부하는 Clippy, Rust 단위·통합 테스트, 실제 privileged cgroup/namespace/seccomp 테스트, 취소·timeout 프로세스 트리 정리, 전체 출력 제한, 용량 경쟁 테스트, npm audit, ELF 아키텍처/실행 권한 검사, tarball clean install, 배포된 패키지 smoke test다.

격리가 생략되거나, 출력/control 제한을 우회하거나, 자식·cgroup·staging root가 남거나, x64/ARM64 패키징이 잘못되거나, metadata가 실제와 다르거나, clean consumer가 배포 패키지를 실행하지 못하면 release를 중단한다.
