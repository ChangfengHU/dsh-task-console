"""Compatibility for older hosts freezing an absolute board path.

Only a project-contained real file is converted to a relative CLI argument.
The compiler remains strict and pinned; no data, timing or media is rewritten.
"""
import argparse
import hashlib
import json
import pathlib
import runpy
import sys

COMPILER_SHA256 = 'c3316610961d7d4a1a559248b7a4b05776691c49157a856f7b2fb3f30ca72776'


def relative_board(project_root, board):
    root = pathlib.Path(project_root).resolve(strict=True)
    candidate = pathlib.Path(board)
    if '..' in candidate.parts:
        raise ValueError('board-traversal-denied')
    actual = (root / candidate).resolve(strict=True)
    try:
        relative = actual.relative_to(root)
    except ValueError:
        raise ValueError('board-outside-project') from None
    if not actual.is_file():
        raise ValueError('board-file-required')
    return root, str(relative)


if __name__ == '__main__':
    p = argparse.ArgumentParser()
    p.add_argument('--project-root', required=True)
    p.add_argument('--board', required=True)
    p.add_argument('--output', required=True)
    a = p.parse_args()
    try:
        root, board = relative_board(a.project_root, a.board)
        compiler = pathlib.Path(__file__).with_name('compile_storyboard.py')
        if hashlib.sha256(compiler.read_bytes()).hexdigest() != COMPILER_SHA256:
            raise ValueError('pinned-compiler-changed')
    except Exception as e:
        print(json.dumps({'ok': False, 'reason': str(e)[:200], 'qualityApproved': False}))
        raise SystemExit(1)
    sys.argv = [str(compiler), '--project-root', str(root), '--board', board, '--output', a.output]
    runpy.run_path(str(compiler), run_name='__main__')
