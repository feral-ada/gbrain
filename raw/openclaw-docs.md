# OpenClaw Docs

Source: https://docs.openclaw.ai/

[Full content from docs here...]

## Afterthought: Hackable Install Details

YES — hackable = full source control

| Aspect | One-liner (npm) | Hackable (git/from-source) |
|--------|-----------------|----------------------------|
| Ownership | Binary package (node_modules) | Full editable repo clone |
| Edit source | No (or messy) | Yes — fork/edit/PR |
| Rebuild | Automatic on update | `pnpm build` after changes |
| Make it yours | Limited | Fork → customize agents/skills/core → self-host |
| Workflow | `openclaw update` | Git pull + local dev loop |

**Can carefully edit?** Yes. Core in `/src`, skills in `/skills`, UI in `/ui`. Use `pnpm link --global` for live testing. Fork recommended for "my own" version.

See §From source for commands.