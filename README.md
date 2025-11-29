# Vibe Coder

## Claude Code 환경 설정

### MCP

```bash
$ claude mcp add slack -s user -- npx -y @modelcontextprotocol/server-slack
```

그리고 환경변수:
- `SLACK_TEAM_ID` (`T0000000000`)
- `SLACK_BOT_TOKEN` (`xoxb-...`)
- `SLACK_APP_TOKEN` (`xapp-...`)

### 전역 프롬프트

```bash
$ cp ./CLAUDE.md ~/.claude/CLAUDE.md
```