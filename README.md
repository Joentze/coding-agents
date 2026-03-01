# Coding Agent 
Started this repository to document myself building coding agents and using/implementing best practices for agent harnesses

### Getting Started
To get started ensure you have Bun on your machine
```bash
curl -fsSL https://bun.sh/install | bash
```
I'm using [Modal](https://modal.com) for the sandbox environment. The sandbox is using a pre-built Vite Docker image by myself, head to Modal and attain `MODAL_TOKEN_ID` & `MODAL_TOKEN_SECRET`. I'm also using `gpt-5.3-codex` so attain an API key from your OpenAI dashboard as well, `OPENAI_API_KEY`. create an `.env` in root with the following:
```bash
MODAL_TOKEN_ID=...
MODAL_TOKEN_SECRET=...
OPENAI_API_KEY=...
```
Once this is done, you can start using the coding agent through the CLI by running
```bash
bun run index.ts
```

### To-do List
- [x] Basic Coding Agent
  - System prompt for working with Vite sandbox
  - Basic tools for situating codebase (`list-files`, `read-files`, `update-file`, `create-file`, `grep`)
  - CLI interface
- [ ] Coding Agent with Planning
- [ ] Coding Agent with Sandbox Skills & Memory