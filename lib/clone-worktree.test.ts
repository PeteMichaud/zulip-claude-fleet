import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executeClone, scanForClone, type ExecFn } from './clone-worktree.ts';

// Real `git` shell-out for executeClone tests. We need actual repos on disk
// so `git worktree add` exercises the real semantics, not a mock.
const realExec: ExecFn = async (cmd, args, opts) => {
  const proc = Bun.spawn({ cmd: [cmd, ...args], cwd: opts?.cwd, stdout: 'pipe', stderr: 'pipe' });
  const exitCode = await proc.exited;
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  return { exitCode, stdout, stderr };
};

let tmpRoot = '';

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'clone-worktree-test-'));
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

async function initRepo(path: string, branch = 'main'): Promise<void> {
  mkdirSync(path, { recursive: true });
  await realExec('git', ['init', '-q', '-b', branch], { cwd: path });
  await realExec('git', ['config', 'user.email', 'test@example.com'], { cwd: path });
  await realExec('git', ['config', 'user.name', 'Test'], { cwd: path });
  await realExec('git', ['config', 'commit.gpgsign', 'false'], { cwd: path });
  writeFileSync(join(path, 'README.md'), 'hi\n');
  await realExec('git', ['add', 'README.md'], { cwd: path });
  await realExec('git', ['commit', '-q', '-m', 'init'], { cwd: path });
}

describe('scanForClone', () => {
  test('source-root is a repo: returns single empty-string entry', () => {
    const src = join(tmpRoot, 'self-contained');
    mkdirSync(join(src, '.git'), { recursive: true });
    writeFileSync(join(src, 'CLAUDE.md'), '...');

    const scan = scanForClone(src);
    expect(scan.repoPaths).toEqual(['']);
    expect(scan.copyPaths).toEqual([]);
  });

  test('mixed: top-level CLAUDE.md + sibling repo subdir', () => {
    const src = join(tmpRoot, 'mixed');
    mkdirSync(src, { recursive: true });
    writeFileSync(join(src, 'CLAUDE.md'), '...');
    mkdirSync(join(src, 'scripts'), { recursive: true });
    writeFileSync(join(src, 'scripts', 'helper.sh'), '#!/bin/sh\n');
    mkdirSync(join(src, 'my-repo', '.git'), { recursive: true });
    writeFileSync(join(src, 'my-repo', 'README.md'), '...');

    const scan = scanForClone(src);
    expect(scan.repoPaths).toEqual(['my-repo']);
    expect(scan.copyPaths.sort()).toEqual(['CLAUDE.md', 'scripts']);
  });

  test('multiple repos at top level', () => {
    const src = join(tmpRoot, 'multi');
    mkdirSync(src, { recursive: true });
    mkdirSync(join(src, 'repo-a', '.git'), { recursive: true });
    mkdirSync(join(src, 'repo-b', '.git'), { recursive: true });
    writeFileSync(join(src, 'CLAUDE.md'), '...');

    const scan = scanForClone(src);
    expect(scan.repoPaths.sort()).toEqual(['repo-a', 'repo-b']);
    expect(scan.copyPaths).toEqual(['CLAUDE.md']);
  });

  test('node_modules and .wake-trigger.json are skipped (not copied, not scanned)', () => {
    const src = join(tmpRoot, 'with-deps');
    mkdirSync(src, { recursive: true });
    mkdirSync(join(src, 'node_modules', 'pkg'), { recursive: true });
    writeFileSync(join(src, 'node_modules', 'pkg', 'index.js'), '...');
    writeFileSync(join(src, '.wake-trigger.json'), '{}');
    writeFileSync(join(src, 'CLAUDE.md'), '...');

    const scan = scanForClone(src);
    expect(scan.repoPaths).toEqual([]);
    expect(scan.copyPaths).toEqual(['CLAUDE.md']);
    expect(scan.skipped.sort()).toEqual(['.wake-trigger.json', 'node_modules']);
  });

  test('.git as a file (linked-worktree marker) still counts as a repo', () => {
    // Linked worktrees use `.git` as a file containing `gitdir: …`. Our
    // detection is presence-based so it should treat both forms the same.
    const src = join(tmpRoot, 'linked');
    mkdirSync(src, { recursive: true });
    writeFileSync(join(src, '.git'), 'gitdir: /elsewhere\n');

    const scan = scanForClone(src);
    expect(scan.repoPaths).toEqual(['']);
  });

  test('does not descend into a discovered repo looking for sub-repos', () => {
    const src = join(tmpRoot, 'no-descend');
    mkdirSync(join(src, 'outer-repo', '.git'), { recursive: true });
    // A nested `.git` deep inside the outer repo should NOT register as a
    // separate repo target. Only the top-level outer-repo gets reported.
    mkdirSync(join(src, 'outer-repo', 'nested', 'inner', '.git'), { recursive: true });

    const scan = scanForClone(src);
    expect(scan.repoPaths).toEqual(['outer-repo']);
  });

  test('throws on missing source', () => {
    expect(() => scanForClone(join(tmpRoot, 'does-not-exist'))).toThrow();
  });
});

describe('executeClone', () => {
  test('source-root repo: git worktree add brings committed files to a new branch', async () => {
    const src = join(tmpRoot, 'src');
    await initRepo(src);
    const target = join(tmpRoot, 'clone');

    const scan = scanForClone(src);
    const result = await executeClone({
      sourceCwd: src,
      targetCwd: target,
      branch: 'bot/clone-1',
      scan,
      exec: realExec,
    });

    expect(result.worktreesAdded).toHaveLength(1);
    expect(existsSync(join(target, 'README.md'))).toBe(true);
    // Branch was created and is checked out in the new worktree.
    const branchCheck = await realExec('git', ['-C', target, 'branch', '--show-current']);
    expect(branchCheck.stdout.trim()).toBe('bot/clone-1');
  });

  test('uncommitted WIP in source does not transfer (worktree-add checks out HEAD)', async () => {
    const src = join(tmpRoot, 'src');
    await initRepo(src);
    // Stage AND leave unstaged WIP in source — neither should appear in clone.
    writeFileSync(join(src, 'WIP-staged.md'), 'staged but uncommitted\n');
    await realExec('git', ['-C', src, 'add', 'WIP-staged.md']);
    writeFileSync(join(src, 'WIP-unstaged.md'), 'not even staged\n');

    const target = join(tmpRoot, 'clone');
    await executeClone({
      sourceCwd: src,
      targetCwd: target,
      branch: 'bot/clone-1',
      scan: scanForClone(src),
      exec: realExec,
    });

    expect(existsSync(join(target, 'README.md'))).toBe(true);
    expect(existsSync(join(target, 'WIP-staged.md'))).toBe(false);
    expect(existsSync(join(target, 'WIP-unstaged.md'))).toBe(false);
  });

  test('mixed layout: repo subdirs become worktrees; loose files are copied', async () => {
    const src = join(tmpRoot, 'src');
    mkdirSync(src, { recursive: true });
    writeFileSync(join(src, 'CLAUDE.md'), 'instructions\n');
    mkdirSync(join(src, 'scripts'), { recursive: true });
    writeFileSync(join(src, 'scripts', 'helper.sh'), '#!/bin/sh\necho hi\n');
    const innerRepo = join(src, 'project');
    await initRepo(innerRepo);

    const target = join(tmpRoot, 'clone');
    const scan = scanForClone(src);
    await executeClone({
      sourceCwd: src,
      targetCwd: target,
      branch: 'bot/clone-1',
      scan,
      exec: realExec,
    });

    expect(readFileSync(join(target, 'CLAUDE.md'), 'utf-8')).toBe('instructions\n');
    expect(readFileSync(join(target, 'scripts', 'helper.sh'), 'utf-8')).toContain('echo hi');
    expect(existsSync(join(target, 'project', 'README.md'))).toBe(true);
    const branchCheck = await realExec('git', ['-C', join(target, 'project'), 'branch', '--show-current']);
    expect(branchCheck.stdout.trim()).toBe('bot/clone-1');
  });

  test('throws when target dir already exists', async () => {
    const src = join(tmpRoot, 'src');
    await initRepo(src);
    const target = join(tmpRoot, 'clone');
    mkdirSync(target, { recursive: true });

    await expect(
      executeClone({
        sourceCwd: src,
        targetCwd: target,
        branch: 'bot/clone-1',
        scan: scanForClone(src),
        exec: realExec,
      }),
    ).rejects.toThrow(/already exists/);
  });

  test('surfaces git worktree add failure (e.g. branch already exists)', async () => {
    const src = join(tmpRoot, 'src');
    await initRepo(src);
    // First clone takes the branch; second clone with same branch should fail.
    await executeClone({
      sourceCwd: src,
      targetCwd: join(tmpRoot, 'first'),
      branch: 'bot/dup',
      scan: scanForClone(src),
      exec: realExec,
    });

    await expect(
      executeClone({
        sourceCwd: src,
        targetCwd: join(tmpRoot, 'second'),
        branch: 'bot/dup',
        scan: scanForClone(src),
        exec: realExec,
      }),
    ).rejects.toThrow(/git worktree add failed/);
  });
});
