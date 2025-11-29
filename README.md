# Claude Code SDK 테스트

Claude Code SDK를 테스트하는 프로젝트입니다.

## 설치

```bash
pnpm install
```

## Claude SDK 테스트

### 간단한 테스트 스크립트
```bash
pnpm test:claude
```

### 통합 테스트 (실제 Claude Code CLI 호출)
```bash
pnpm test:integration
```

**참고**: Claude Code SDK는 로컬 Claude Code CLI를 사용하므로 API 키가 필요 없습니다. 로컬에 Claude Code가 설치되어 있어야 합니다.

통합 테스트는 실제 Claude Code CLI를 호출하여 다음을 검증합니다:
- Claude 함수 호출
- 간단한 프롬프트 응답
- 스트리밍 응답 수신
- 코드 관련 질문 응답
- 긴 응답 스트리밍

## 기술 스택

- TypeScript
- pnpm
- @instantlyeasy/claude-code-sdk-ts - Claude Code SDK
- vitest - 테스트 프레임워크
