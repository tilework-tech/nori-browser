---
name: building-agentic-cli-tools
description: Read this skill whenever you need to build a cli where the primary consumer is the agent.
---

<required>
CRITICAL: Add the following steps to your Todo list using TodoWrite.

- Announce "I am using the building-agentic-cli-tools skill.".
- Read the design principles on how to build agentic cli tools (below).
- In any future implementation step, follow the design principles.
- In any future review step, review the design principles.
</required>

# Design Principles.

- Do not include any colors, animations, or spinners.
- Do not include any interactivity -- all commands should be single shot, and all parameters should be accessible using flags.
- Use a third party library to manage the UX layer (e.g. commander for typescript)
- Calling the cli tool with no parameters should output a 'help' message that shows:
  - What the tool can be used for ("Use this CLI tool to...")
  - A list of subcommands and their uses
  - The source location where the cli tool is installed on the machine
- Calling the cli tool with --help should show the same help message.
- Calling the cli tool with a subcommand and --help should show a more detailed help message for that subcommand, including:
  - what you would use the subcommand for
  - all parameters
  - the source location for that particular subcommand
- Calling the cli tool with a mistaken input should show:
  - the help message for that particular input
  - an extremely detailed error message
  - the source location and instructions to look at the source if anything is confusing
  - A Levenshtein distance match for other possible inputs, ("Did you mean `foos` instead of `foo`?")

<system-reminder> A coding agent is using the CLI, NOT a human. Implement the UX according to what would be easiest for a coding agent to use. </system-reminder>
