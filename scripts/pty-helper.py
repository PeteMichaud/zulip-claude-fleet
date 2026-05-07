#!/usr/bin/env python3
"""Pseudo-terminal proxy for spawning interactive CLIs from non-TTY parents.

Usage: pty-helper.py CMD [ARGS...]

The dispatcher (Bun) can't open real PTYs reliably (node-pty hits
posix_spawnp errors on this macOS version, BSD `script` rejects socket
stdin, and Bun's stdio: 'pipe' is a socket pair that fails ioctl). Python's
stdlib `pty.spawn` allocates a master/slave pair and shuttles bytes between
the parent's stdio and the child's PTY, so the child sees a real terminal.

Exit code is forwarded from the child.
"""
import os
import pty
import sys

if len(sys.argv) < 2:
    sys.stderr.write("usage: pty-helper.py CMD [ARGS...]\n")
    sys.exit(2)

status = pty.spawn(sys.argv[1:])
# pty.spawn returns the wait-encoded status. Decode to a plain exit code.
sys.exit(os.WEXITSTATUS(status) if os.WIFEXITED(status) else 1)
