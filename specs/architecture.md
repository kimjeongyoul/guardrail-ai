# Architecture Specification: GuardRail AI (Enterprise Secure Gateway)

## 1. System Overview
GuardRail AI는 기업 내부 사용자와 외부 LLM(OpenAI, Anthropic 등) 사이에서 동작하는 **엔터프라이즈급 보안 게이트웨이**입니다. 10년 차 백엔드 시니어의 역량을 보여줄 수 있도록 **고성능 요청 처리, 데이터 거버넌스(PII 마스킹), 비용 최적화(Semantic Cache), 그리고 가시성(Observability)**에 초점을 맞춥니다.

## 2. Technical Stack & Rationale
- **Gateway Core**: **Node.js (TypeScript + Fastify)** - 고성능 비동기 I/O 처리 및 풍부한 에코시스템을 위해 선택. Fastify는 Node.js 환경에서 가장 빠른 웹 프레임워크 중 하나입니다.
- **Privacy Engine**: **Python (FastAPI + Presidio)** - NLP 기반의 정교한 PII(개인정보) 탐지를 위해 AI 생태계 활용. (Node.js에서 gRPC/Internal API로 호출)
- **Data Storage**:
  - **PostgreSQL**: 감사 로그(Audit Trail) 및 사용자 정책 관리.
  - **Redis**: 실시간 Rate Limiting 및 분산 캐싱.
  - **Vector DB (Qdrant or Milvus)**: 유사 질문 탐지를 통한 Semantic Caching.
- **Observability**: **OpenTelemetry + Prometheus + Grafana** - 분산 트레이싱 및 매트릭스 시각화.
- **Infrastructure**: **Docker & Kubernetes** - 확장 가능한 아키텍처.

## 3. Layered Architecture
- **Inbound Proxy Layer**: 인증, 인가(RBAC), 속도 제한(Rate Limiting).
- **Privacy Shield Layer**: PII 탐지 및 마스킹, 데이터 유출 방지(DLP) 정책 적용.
- **Intelligence Layer**: Semantic Caching, LLM 로드밸런싱 및 Fallback 전략.
- **Analytics & Governance Layer**: 감사 로그 기록, 비용 분석, 성능 모니터링.

## 4. Key Decisions (ADR)
- **[ADR-001] Polyglot Architecture**: 게이트웨이 코어는 Node.js를 사용하고, 보안 엔진은 풍부한 라이브러리를 보유한 Python을 사용하여 하이브리드로 구성.
- **[ADR-002] Asynchronous Logging**: 메인 요청의 지연 시간을 최소화하기 위해 감사 로그는 Kafka 또는 비동기 큐를 통해 처리.