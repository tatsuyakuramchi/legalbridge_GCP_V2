#!/usr/bin/env python3
"""cloudbuild の inline シェルスクリプトを送信前に検査する。

ビルドは 1 回 5〜10 分かかるうえ、失敗しても原因は
`build step N failed: step exited with non-zero status: 127` しか出ない。
127＝command not found で、実際に起きたのは「行継続（\\）の直後にコメント行を
置いたため論理行が切れ、続く --memory=... がコマンドとして実行された」だった。
この種の事故は bash -n と単純な並び検査で送信前に止められる。

使い方: check-cloudbuild.py <cloudbuild.yaml>  （問題があれば exit 1）
"""
import os
import subprocess
import sys
import tempfile

try:
    import yaml
except ImportError:  # PyYAML が無い環境ではスキップ（デプロイ自体は止めない）
    print("check-cloudbuild: PyYAML が無いため検査をスキップします", file=sys.stderr)
    sys.exit(0)


def inline_script(step):
    """step の inline シェルスクリプト本文。無ければ None。"""
    if step.get("script"):
        return step["script"]
    args = step.get("args") or []
    entrypoint = step.get("entrypoint")
    if args and args[0] in ("-c", "-lc", "-ec"):
        return args[-1]
    if entrypoint in ("bash", "sh") and args:
        return args[-1]
    return None


def check(body, label):
    problems = []
    with tempfile.NamedTemporaryFile("w", suffix=".sh", delete=False) as handle:
        handle.write(body)
        path = handle.name
    try:
        result = subprocess.run(["bash", "-n", path], capture_output=True, text=True)
        if result.returncode != 0:
            problems.append(f"{label}: シェル構文エラー\n{result.stderr.strip()}")
    finally:
        os.unlink(path)

    # 行継続の直後のコメントは、そこで論理行が切れる（今回の 127 の原因）。
    lines = body.split("\n")
    for index in range(len(lines) - 1):
        if lines[index].rstrip().endswith("\\") and lines[index + 1].lstrip().startswith("#"):
            problems.append(
                f"{label}: {index + 2} 行目 — 行継続（\\）の直後にコメントがあります。"
                f"コメントはコマンドの前に置いてください: {lines[index + 1].strip()[:60]}"
            )
    return problems


def main():
    if len(sys.argv) != 2:
        print(__doc__)
        return 2
    document = yaml.safe_load(open(sys.argv[1], encoding="utf-8"))
    problems = []
    for index, step in enumerate(document.get("steps", [])):
        body = inline_script(step)
        if body is None:
            continue
        problems += check(body, f"step {index} ({step.get('id') or step.get('name')})")
    for problem in problems:
        print(f"ERROR: {problem}", file=sys.stderr)
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
