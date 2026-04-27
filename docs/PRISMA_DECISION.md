# 📑 Prisma 7 도입 및 아키텍처 결정 보고서

이 문서는 GuardRail AI 프로젝트에서 Prisma 7을 데이터베이스 ORM으로 선택한 이유와, 대안과의 비교 분석 내용을 담고 있습니다.

## 1. Prisma 7 선택 이유 (RATIONALE)

| 항목 | 상세 내용 | 비고 |
| :--- | :--- | :--- |
| **성능 (Performance)** | 엔진 경량화를 통해 Cold Start 속도를 이전 버전 대비 대폭 개선 | 서버리스/컨테이너 최적화 |
| **타입 안정성** | DB 스키마와 TypeScript 코드 간의 완벽한 동기화 보장 | 런타임 에러 방지 |
| **엄격한 검증** | 환경 설정(DB URL 등)이 불완전할 경우 즉시 크래시 유발 | 보안 로그 누락 원천 차단 |
| **TypedSQL 지원** | 복잡한 쿼리도 타입 안정성을 유지하며 작성 가능 | 유지보수성 향상 |

---

## 2. Prisma 제거 시 대안 비교 (PROS & CONS)

Prisma를 제거하고 **Raw SQL** 또는 **Query Builder(Knex 등)**로 전환할 경우의 분석입니다.

### 🟢 장점 (Advantages)
- **인프라 유연성**: 특정 바이너리 호환성(Alpine 등)을 타지 않아 Docker 설정이 매우 간소화됨.
- **빌드 경량화**: Prisma 엔진(약 50~100MB)이 제외되어 전체 이미지 용량이 줄어듦.
- **초기화 속도**: 환경 변수 인식 순서 등의 이슈 없이 즉시 연결 가능.

### 🔴 단점 및 부채 (Disadvantages / Tech Debt)
- **타입 안정성 부재**: DB 컬럼 수정 시 코드 레벨에서 감지 불가 -> 휴먼 에러 발생 가능성 높음.
- **감사 로그(Audit Log) 신뢰성**: 보안상 매우 중요한 감사 로그 작성 시 쿼리 오타 등으로 인한 누락 위험.
- **관리 비용**: 마이그레이션 도구 및 DB 추상화 레이어를 직접 구현해야 하는 '거대 보일러플레이트' 발생.

---

## 3. 발생했던 이슈 및 해결 가이드 (ISSUE LOG)

### ⚠️ Issue: `PrismaClientInitializationError`
- **현상**: Docker 환경에서 `DATABASE_URL`을 인식하지 못하고 컨테이너가 즉시 종료됨.
- **원인**: Prisma 7의 엄격한 유효성 검사와 Docker(Alpine) 환경의 환경 변수 주입 시점 불일치.
- **해결 (Tuning Guide)**: 
  1. **Source Level**: `PrismaClient` 생성 시 `datasources` 옵션을 명시적으로 주입하거나, 환경 변수 존재 여부를 사전에 강제 검증.
  2. **Infra Level**: Docker 베이스 이미지를 `node:22-alpine`에서 `node:22-slim` (Debian 계열)으로 변경하여 바이너리 호환성 확보.

---

## 🏁 최종 권고 (FINAL RECOMMENDATION)

현재의 Prisma 7은 **"초기 설정의 엄격함"**을 대가로 **"장기적인 운영 안정성"**을 얻는 선택입니다. 엔터프라이즈 LLM 게이트웨이로서 **감사 로그의 무결성**이 최우선이므로, 인프라 튜닝을 통해 Prisma 7을 유지하는 것을 권장합니다.
