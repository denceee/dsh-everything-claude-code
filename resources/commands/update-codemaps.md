<!-- dsh-adaptation -->
> **DSH Prompt** — In DSH this file was a slash command. DSH resolves `/name` through the human-command registry, which never reaches the model, so this is a prompt instead: paste it, or reference the file with @, and the agent follows it as instructions. Its tool names have been mapped to DSH tools.

# Update Codemaps

Analyze the codebase structure and update architecture documentation:

1. Scan all source files for imports, exports, and dependencies
2. Generate token-lean codemaps in the following format:
   - codemaps/architecture.md - Overall architecture
   - codemaps/backend.md - Backend structure  
   - codemaps/frontend.md - Frontend structure
   - codemaps/data.md - Data models and schemas

3. Calculate diff percentage from previous version
4. If changes > 30%, request user approval before updating
5. Add freshness timestamp to each codemap
6. Save reports to .reports/codemap-diff.txt

Use TypeScript/Node.js for analysis. Focus on high-level structure, not implementation details.
