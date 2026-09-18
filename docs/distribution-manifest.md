# Distribution Manifest v1

이 문서는 로컬 source checkout의 배포 inventory와 실제 bytes를 읽기 전용으로 검증하는 계약을 정의한다. 기존 Worker, handoff 또는 배포 API를 변경하지 않는다. Production canonical ownership inventory는 제공하지 않으며, 실제 목록의 확정·승인·관리 경로는 후속 작업이다.

## 데이터 계약

`DistributionManifest`는 다음 필드만 허용한다.

- `schemaVersion`: 숫자 `1`.
- `releaseLine`: Framework release line. `v0.3` 같은 `v<major>.<minor>` 형식이며 각 숫자는 0 또는 선행 0 없는 양의 정수다. 계약 버전과 별개이고 patch·prerelease·공백은 허용하지 않는다.
- `sourceRepository`: 독립적으로 기대하는 repository 식별자와 정확히 일치하는 문자열. 앞뒤 공백과 제어 문자는 허용하지 않는다.
- `sourceSha`: 소문자 전체 Git commit object ID. SHA-1의 40자리 또는 SHA-256의 64자리이며 축약 SHA는 거부한다.
- `entries`: `sourcePath`, `targetPath`, `classification`, `ownership`, `contentDigest`만 포함하는 파일 목록.
- `manifestDigest`: canonical payload UTF-8 bytes의 소문자 SHA-256 hex 64자리.

각 manifest entry의 `ownership`은 필수 상수 `framework`다. 이 선언만으로 ownership 권위를 부여하지 않으며 독립 trusted 목록과의 일치 검증을 유지한다.

`TrustedOwnershipList`는 manifest와 별도 모델이며 `schemaVersion: 1`, `sourceRepository`, `entries`만 가진다. 각 entry는 `sourcePath`, `targetPath`, `classification`만 가진다. Manifest에서 이 목록을 추출하여 신뢰 목록으로 넘겨서는 안 된다. 호출자가 별도로 승인된 목록과 `expectedSourceRepository`를 제공해야 한다. API 인자를 분리하는 것만으로 호출자의 신뢰 공급 경로가 증명되지는 않는다.

`classification`은 `required` 또는 `optional`이다. 이 값은 inventory에 포함된 파일의 분류이며 이번 verifier의 검증 생략 지시가 아니다. Optional entry도 신뢰 목록에 있다면 manifest에 반드시 존재해야 하고 bytes 검증을 통과해야 한다. 신뢰 목록 밖의 optional 파일을 manifest에 추가할 수도 없다. 선택 가능한 배포 구성을 지원하려면 각 구성에 대해 독립적으로 승인된 정확한 목록을 먼저 제공해야 한다.

모델의 필드는 TypeScript `readonly`이다. 생성 API는 입력을 복사하고 결과와 entry 배열 및 entry 객체를 동결한다. JSON Schema 상수 `distributionManifestSchema`, `trustedOwnershipListSchema`는 모든 객체 수준에서 추가 속성을 금지한다. 런타임 assertion은 스키마 형태 외에도 중복·경로 충돌을 검사한다. Timestamp, 자유형 compatibility, 기타 확장 필드는 v1에서 허용하지 않는다.

경로는 `/`로 구분한 안전한 상대 경로다. 빈 경로·segment, 절대 경로, `.`, `..`, 역슬래시, 콜론, ASCII 공백·제어 문자와 C1 제어 문자를 거부한다. Source와 target 각각 중복 및 파일/하위 경로 충돌을 거부한다. 경로의 대소문자와 Unicode 표기는 정규화하지 않고 정확한 문자열로 비교한다. Target filesystem의 별칭이나 대소문자 충돌 처리, 설치 가능성 판정은 이 verifier의 범위가 아니다.

## Canonical identity와 API

`canonicalSerializeManifestPayload(payload)`는 payload만 받으며 `manifestDigest` 속성이 들어 있으면 거부한다. JSON 키 순서는 `schemaVersion`, `releaseLine`, `sourceRepository`, `sourceSha`, `entries`다. 각 entry의 키 순서는 `sourcePath`, `targetPath`, `classification`, `ownership`, `contentDigest`다. `releaseLine`과 `ownership`도 digest에 포함한다. Entry는 상수 ownership을 제외한 네 필드를 순서대로 비교하여 정렬하며, locale에 의존하지 않는 JavaScript UTF-16 code-unit 사전순 비교를 사용한다. 원본 배열은 변경하지 않는다.

Serialization은 `JSON.stringify` 결과 그대로이며 들여쓰기, BOM, 마지막 newline을 추가하지 않는다. Unicode나 파일 내용을 정규화하지 않는다. 이 문자열을 UTF-8로 인코딩한 bytes에 SHA-256을 적용한다. `manifestDigest` 자체는 digest payload에서 제외한다. `canonicalSerializeManifest(manifest)`는 digest를 재검증하고 canonical payload 키 뒤에 `manifestDigest`를 마지막 키로 추가한다.

- `assertSafeRelativePath`, `assertTrustedOwnershipList`, `assertDistributionManifestPayload`, `assertDistributionManifest`: unknown 입력에 대한 런타임 assertion. 실패하면 예외를 던진다. Manifest assertion은 구조 검증이며 digest 일치 판정은 별도다.
- `sha256Bytes(bytes)`: bytes의 SHA-256. Text decoding이나 newline 변환을 하지 않는다.
- `computeManifestDigest(payload)`: 구조 검증 후 canonical payload digest 계산.
- `createDistributionManifest(payload)`: 정렬·복사·동결한 manifest 생성.
- `verifyManifestDigest(manifest)`: 구조가 잘못되면 예외, 유효한 구조에서 digest가 다르면 `false`.
- `verifyDistributionManifest({ manifest, trustedOwnershipList, sourceRoot, expectedSourceRepository })`: 전체 로컬 검증. 성공 시 `sourceRepository`, `sourceSha`, `manifestDigest`, `verifiedFileCount`를 가진 동결 결과를 반환한다. 실패하면 예외를 던지며 부분 성공 결과를 반환하지 않는다.

Digest는 무결성과 결정적 identity를 제공한다. 서명, publisher 인증 또는 ownership authority를 대신하지 않는다. Repository 식별자도 Git object에 내장된 원격 출처 증명이 아니다. 호출자는 신뢰할 수 있는 절차로 checkout과 기대 repository 식별자를 확보해야 한다.

## 읽기 전용 verifier

`sourceRoot`는 로컬 Git worktree 최상위의 절대 경로여야 한다. Verifier는 다음을 검사한다.

1. Manifest와 독립 신뢰 목록의 구조, 경로, 중복, manifest digest를 검증한다.
2. 두 repository 식별자가 `expectedSourceRepository`와 정확히 일치하는지 검사한다.
3. `sourcePath`, `targetPath`, `classification` tuple 집합이 양방향으로 정확히 같은지 검사한다. 누락·추가·재분류·재매핑을 모두 거부한다.
4. 실제 `HEAD^{commit}`가 manifest의 전체 `sourceSha`와 일치하는지 검사한다.
5. 해당 commit tree에서 각 source가 mode `100644` 또는 `100755`인 일반 blob인지 검사한다. Git symlink, submodule, directory, untracked source는 허용하지 않는다.
6. `git cat-file blob`의 원본 bytes와 실제 worktree 파일 bytes를 직접 비교하고 양쪽의 SHA-256이 `contentDigest`와 일치하는지 검사한다.
7. 검증 종료 시 HEAD를 다시 확인한다.

Root와 source의 경로 구성 요소에서 symlink를 거부한다. 일반 파일 여부를 검사하고 가능한 플랫폼에서는 `O_NOFOLLOW`로 연다. 열린 파일과 경로의 identity 및 변경 정보를 읽기 전후 비교한다. 읽기 실패, Git 실패, 존재하지 않는 파일, timeout, buffer 제한 초과는 모두 실패다. Git 출력은 호출당 64 MiB, 실행 시간은 호출당 30초로 제한한다.

Git 명령은 인자 배열로 실행하며 shell을 사용하지 않는다. 상속된 `GIT_*` 환경 override를 제거하고 replacement object, optional lock, fsmonitor, lazy fetch를 비활성화한다. Checkout, index refresh, filter 실행, fetch, install, upgrade, target write는 수행하지 않는다. 사용되는 명령은 `rev-parse`, `ls-tree`, `cat-file`이다. Target 경로는 inventory 비교 대상으로만 사용하며 실제 target repository에는 접근하지 않는다. Source checkout의 inventory 밖 파일은 존재할 수 있으며 전체 repository의 clean 상태를 요구하지 않는다.

이 API는 동기식이다. 검증 중 source와 Git metadata를 변경하지 않는 안정된 로컬 checkout이 필요하다. 읽기 전후 검사는 일반적인 변경을 탐지하지만 적대적인 동시 filesystem 변경에 대한 원자적 snapshot이나 잠금을 제공하지 않는다. 이후 설치 단계가 생긴다면 검증된 bytes와 실제 소비하는 bytes를 연결하는 별도 계약이 필요하다.

## 테스트와 적용 경계

`test/distribution-manifest.test.ts`는 Node 내장 `node:test` API와 bounded fixture 목록을 사용한다. 임시 directory 안에서만 로컬 Git commit을 구성하고 테스트 종료 시 정리한다. Production 목록은 생성하지 않는다.

테스트는 고정 canonical JSON literal에 대한 독립 SHA-256 기대값과 빈 파일의 고정 SHA-256 hex, 입력 순서 독립성, binary/empty bytes, malformed shape, 추가 속성, 중복·traversal, source repository·HEAD 불일치, ownership 불일치, optional 누락, dirty/untracked/missing source, symlink 및 읽기 전용 동작을 다룬다. 읽기 전용 검사는 성공·실패 전후 checkout과 `.git` 파일 bytes·mode·mtime snapshot을 비교한다. Symlink fixture는 Windows에서 건너뛴다.

후속 통합 환경에서 `npm test`가 이 TypeScript 테스트를 실제로 수집하는지와 기존 regression을 확인하고, `npm run build`로 타입·빌드 호환성을 확인해야 한다. 제공된 Context Pack에는 package 설정이나 기존 test runner 정보가 없으므로 기존 수집 방식과의 호환성은 확인되지 않았다. 이 후보 생성 단계에서는 명령을 실행하지 않았다.

본 변경은 Framework bundle publish, GitHub Release 변경, 네트워크 source 취득, dogfood 수정, SAP RAP verifier 또는 자동 merge를 포함하지 않는다. Production ownership 목록 확정과 후속 배포는 별도 작업이며 최종 merge의 Human-only 경계를 유지한다.
