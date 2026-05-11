// Worktree cloning for `cmdClone`. Implements the convention we agreed on:
//
//   - Any entry in the source worktree that is itself a git repo (i.e.
//     contains a `.git` directory or file) is added as a fresh `git worktree`
//     under a new branch. The new worktree shares the source's object DB
//     but checks out the branch's committed HEAD — uncommitted WIP in the
//     source does NOT carry over. Git itself enforces that the same branch
//     can't be checked out twice, which is what we want.
//
//   - Anything else is plain-copied: CLAUDE.md, scripts, notes, ad-hoc
//     data files at the top level. node_modules and a few ephemerals are
//     always skipped (see SKIP_NAMES). We don't descend into a repo
//     looking for sub-repos — a discovered `.git` is a stopping point.
//
//   - The scan is non-recursive past the first level for plain files: we
//     treat the source worktree as flat enough that "what's a repo" is a
//     top-level question. Nested non-repo subdirs get copied wholesale.
//
// Bots that work on repos *outside* their worktree are explicitly out of
// scope here. The dispatch reply tells the operator they're on their own
// for that case ("your funeral, go wild" per the design discussion).

import { existsSync, mkdirSync, readdirSync, statSync, cpSync } from 'node:fs';
import { join } from 'node:path';

export type CloneScan = {
  // Top-level entries that are themselves git repos. Relative to sourceCwd.
  // Empty string means the source's *root* is the repo.
  repoPaths: string[];
  // Top-level entries to plain-copy (everything that isn't a repo and isn't
  // on the skip list). Relative to sourceCwd.
  copyPaths: string[];
  // Names we skipped wholesale, surfaced so the dispatch reply can mention
  // them ("node_modules will be re-installed").
  skipped: string[];
};

// node_modules: big, derived. .wake-trigger.json: ephemeral. .DS_Store: noise.
// state/: dispatcher-side per-bot state lives elsewhere, but if a bot ever
// writes its own state/ subtree we don't want to leak it into the clone.
const SKIP_NAMES = new Set([
  'node_modules',
  '.wake-trigger.json',
  '.DS_Store',
]);

function isGitRepo(path: string): boolean {
  // .git can be a directory (normal repo) or a file (submodule / linked
  // worktree). Either way, presence at the top level marks the dir as a repo.
  return existsSync(join(path, '.git'));
}

export function scanForClone(sourceCwd: string): CloneScan {
  if (!existsSync(sourceCwd)) {
    throw new Error(`source worktree does not exist: ${sourceCwd}`);
  }
  // Source's root IS a repo: whole worktree is one repo, no sibling copies
  // needed (committed files come along via git worktree add).
  if (isGitRepo(sourceCwd)) {
    return { repoPaths: [''], copyPaths: [], skipped: [] };
  }

  const repoPaths: string[] = [];
  const copyPaths: string[] = [];
  const skipped: string[] = [];

  for (const entry of readdirSync(sourceCwd)) {
    if (SKIP_NAMES.has(entry)) {
      skipped.push(entry);
      continue;
    }
    const full = join(sourceCwd, entry);
    let s;
    try {
      s = statSync(full);
    } catch {
      // Broken symlink or permission denied — skip rather than fail the scan.
      skipped.push(entry);
      continue;
    }
    if (s.isDirectory() && isGitRepo(full)) {
      repoPaths.push(entry);
    } else {
      copyPaths.push(entry);
    }
  }

  return { repoPaths, copyPaths, skipped };
}

export type ExecFn = (
  cmd: string,
  args: string[],
  opts?: { cwd?: string },
) => Promise<{ exitCode: number; stdout: string; stderr: string }>;

export type CopyFn = (src: string, dst: string) => void;

export type ExecuteCloneInput = {
  sourceCwd: string;
  targetCwd: string;
  branch: string;
  scan: CloneScan;
  exec: ExecFn;
  copy?: CopyFn;
};

export type ExecuteCloneResult = {
  worktreesAdded: Array<{ sourcePath: string; targetPath: string; branch: string }>;
  copied: string[];
};

// Default copy implementation: recursive cp that follows the same semantics
// as cp -r. Bun/Node's cpSync handles dirs and files transparently.
function defaultCopy(src: string, dst: string): void {
  cpSync(src, dst, { recursive: true });
}

export async function executeClone(input: ExecuteCloneInput): Promise<ExecuteCloneResult> {
  const { sourceCwd, targetCwd, branch, scan, exec } = input;
  const copy = input.copy ?? defaultCopy;

  if (existsSync(targetCwd)) {
    throw new Error(`target directory already exists: ${targetCwd}`);
  }
  mkdirSync(targetCwd, { recursive: true });

  const worktreesAdded: ExecuteCloneResult['worktreesAdded'] = [];
  for (const rel of scan.repoPaths) {
    const sourceRepo = rel === '' ? sourceCwd : join(sourceCwd, rel);
    const targetRepo = rel === '' ? targetCwd : join(targetCwd, rel);
    // `git -C <source> worktree add <target> -b <branch>` creates the new
    // worktree at HEAD of the source's currently checked-out branch.
    // git itself errors if <branch> already exists; we surface that.
    const result = await exec(
      'git',
      ['-C', sourceRepo, 'worktree', 'add', targetRepo, '-b', branch],
    );
    if (result.exitCode !== 0) {
      throw new Error(
        `git worktree add failed for ${rel || '.'}: ${result.stderr.trim() || result.stdout.trim()}`,
      );
    }
    worktreesAdded.push({ sourcePath: sourceRepo, targetPath: targetRepo, branch });
  }

  const copied: string[] = [];
  for (const rel of scan.copyPaths) {
    copy(join(sourceCwd, rel), join(targetCwd, rel));
    copied.push(rel);
  }

  return { worktreesAdded, copied };
}
