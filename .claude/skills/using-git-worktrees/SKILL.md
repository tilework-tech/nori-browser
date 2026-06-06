---
name: using-git-worktrees
description: Use this whenever you need to create an isolated workspace. Optionally symlinks gitignored-but-active content (e.g., `data/`, `.env.local`) from the main worktree to prevent loss on cleanup.
---

<required>
*CRITICAL* Add the following steps to your Todo list using TodoWrite:

1. Find the worktrees directory.

- Check existing directories using the Bash tool: `ls -d .worktrees 2>/dev/null`
- If not found, ask me for permission to create a .worktrees directory
- If given permission, create `.worktrees`.

2. Verify .gitignore before creating a worktree using the Bash tool:

```bash
# Check if directory pattern in .gitignore
grep -q "^\.worktrees/$" .gitignore || grep -q "^worktrees/$" .gitignore
```

- If not found, add the appropriate line to the .gitignore immediately.

3. Create the worktree

- Come up with a good branch name based on the request.
- Create the worktree with the Bash tool: `git worktree add ".worktrees/$BRANCH_NAME" -b "$BRANCH_NAME"
- cd into the newly created path with the Bash tool: `cd $path`

4. Symlink shared gitignored content.

- Read the .gitignore. Find files that need to be symlinked into the worktree, e.g.
  - credentials
  - env files
  - data /  model caches
- Symlink each file from the main worktree.

<system-reminder> Symlinks are bidirectional. If producing data that should be cached in a worktree, we want that data to live in the main worktree. We want to avoid situations where I run multi-hour experiments with checkpoints, only to have those checkpoints deleted on worktree cleanup. </system-reminder>

5. Auto-detect and run project setup.

```bash
# Node.js
if [ -f package.json ]; then npm install; fi

# Rust
if [ -f Cargo.toml ]; then cargo build; fi

# Python
if [ -f requirements.txt ]; then pip install -r requirements.txt; fi
if [ -f pyproject.toml ]; then poetry install; fi

# Go
if [ -f go.mod ]; then go mod download; fi
```

- If there is no obvious project setup, you _MUST_ ask me.

6. Run tests to ensure the worktree is clean.

```bash
# Examples - use project-appropriate command
npm test
cargo test
pytest
go test ./...
```

**If tests fail:** Report failures, ask whether to proceed or investigate.

**If tests pass:** Report ready.

7. Report Location

```
New working directory: <full-path>
Shared symlinks: <list created — e.g., "data/, .env.local" — or "none">
Tests passing (<N> tests, 0 failures)
All commands and tools will now refer to: <full-path>
```

8. Understand that you are now in a new working directory. Your Bash tool instructions from here on out should refer to the worktree directory, NOT your original directory. This is ABSOLUTELY CRITICAL.

</required>

# Maintaining Working Directory in Worktree

CRITICAL: Once you create and enter a worktree, you must stay within
it for the entire session.

Rules:

1. Never use cd .. from within a worktree - It will eventually take
   you outside the worktree boundary
2. Always use absolute paths for commands - Use npm run lint from
   within the worktree, not cd .. && npm run lint
3. If you need to run root-level commands, use the full worktree path:
   <bad-example>
   cd .. && npm run lint
   </bad-example>
   <good-example>
   npm run lint # (from worktree root)
   </good-example>

<good-example>
cd /home/$USER/code/project/.worktrees/branch-name && npm run lint
</good-example>

4. Verify your location frequently:

```bash
pwd  # Should show .worktrees/branch-name in path
git branch  # Should show * on your feature branch, not main
```

5. If you accidentally exit the worktree:

- Immediately recognize it (check if you're on main branch)
- Navigate back: cd /full/path/to/.worktrees/your-branch
- Verify: git branch should show your branch, not main

Red Flags:

- Running git status and seeing "On branch main" when you should be on a feature branch
- Running pwd and NOT seeing .worktrees/ in the path
- Any cd .. command while in a worktree

# Accessing Symlinked Content

Access symlinked content through the relative path from within the worktree. Don't resolve the symlink and use the underlying absolute path.

<good-example>
# Relative path from the worktree root — works regardless of how the chain is configured
checkpoint_path = "data/checkpoints/run_42.json"
</good-example>

<bad-example>
real_path = os.path.realpath("data")
checkpoint_path = f"{real_path}/checkpoints/run_42.json"
</bad-example>

<bad-example>
checkpoint_path = "/absolute/path/to/shared/data/root/<project>/checkpoints/run_42.json"
</bad-example>

If a tool requires an absolute path, construct from the worktree root, not from the resolved symlink target:

<good-example>
absolute_data = f"{os.getcwd()}/data"  # worktree root + relative; the OS follows the chain transparently
</good-example>
