# 🛠 Engineering Standards

이 문서는 GuardRail AI 프로젝트의 기술 표준 및 품질 바를 정의합니다.

## 1. Backend Standards
### 1.1. Node.js (Gateway Core)
- **Framework**: Fastify를 사용하여 스키마 기반의 빠른 직렬화와 유효성 검사를 수행합니다.
- **Asynchronous**: 모든 I/O 작업은 `async/await`를 사용하며, Promise 체이닝보다 가독성을 중시합니다.
- **Type Safety**: TypeScript의 `strict` 모드를 활성화하고, 가능한 경우 `zod` 등을 사용하여 런타임 타입 검증을 수행합니다.
- **Event Loop**: 무거운 연산이 이벤트 루프를 차단하지 않도록 주의하며, 필요 시 Worker Threads를 고려합니다.

### 1.2. Python (Privacy Engine)
- **Typing**: `mypy`를 사용하여 모든 함수와 변수에 엄격한 타입 힌트를 적용합니다.
- **Async**: I/O 바운드 작업(API 호출 등)은 반드시 `async/await`를 사용하여 처리합니다.

## 2. API & Communication
- **Contract**: 서비스 간 통신은 가능한 경우 gRPC를 우선 고려하며, 외부 인터페이스는 RESTful 규약을 따릅니다.
- **Validation**: 모든 입력 데이터는 `Request DTO` 레벨에서 엄격하게 검증합니다.

## 3. Observability & Security
- **Tracing**: 모든 요청은 `Trace ID`를 전파하여 마이크로서비스 간 흐름을 추적할 수 있어야 합니다.
- **Logging**: 민감 정보(PII)는 절대 로그에 남기지 않으며, 구조화된 로그(Structured Logging, JSON) 형식을 사용합니다.
- **Secrets**: API 키, DB 접속 정보 등은 `.env`나 환경 변수 대신 Secret Management 도구를 지향합니다.

## 4. Testing Standard
- **Unit Testing**: 비즈니스 로직에 대해 80% 이상의 커버리지를 목표로 합니다.
- **Integration Testing**: Gateway와 Privacy Engine 간의 연동 시나리오를 자동화 테스트로 구성합니다.
- **Load Testing**: `k6` 등을 사용하여 목표 지연 시간(Latency) 및 처리량(Throughput)을 검증합니다.