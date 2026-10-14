"""Check, version, publish, and build the extension in the main checkout."""

import argparse
import json
import re
import subprocess
import sys
import tempfile
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent


def run(args, cwd=ROOT, capture=False):
    return subprocess.run(
        args, cwd=cwd, check=True, text=True, stdout=subprocess.PIPE if capture else None
    ).stdout


def git(*args, cwd=ROOT):
    return run(["git", *args], cwd, capture=True).strip()


def require_clean(path):
    if git("status", "--porcelain", cwd=path):
        raise ValueError(f"Commit or resolve uncommitted files in {path} before releasing.")


def version(path):
    value = json.loads((path / "extension/manifest.json").read_text(encoding="utf-8"))["version"]
    if not re.fullmatch(r"\d+\.\d+\.\d+", value):
        raise ValueError(f"Expected a major.minor.patch extension version, got {value!r}.")
    return tuple(map(int, value.split(".")))


def write_version(path, next_version):
    """Record the release version in the manifest and the development package."""
    for name in ("extension/manifest.json", "package.json"):
        target = path / name
        document = json.loads(target.read_text(encoding="utf-8"))
        document["version"] = next_version
        target.write_text(json.dumps(document, indent=2) + "\n", encoding="utf-8")


def main_checkout():
    path = None
    for field in git("worktree", "list", "--porcelain", "-z").split("\0"):
        if field.startswith("worktree "):
            path = Path(field[9:]).resolve()
        elif field == "branch refs/heads/main":
            return path
    raise ValueError("Check out main in the folder your browser loads before releasing.")


def check_package(path, expected_version):
    with zipfile.ZipFile(path / "railway-seat-watch-extension.zip") as archive:
        manifest = json.loads(archive.read("extension/manifest.json"))
        if manifest["version"] != expected_version:
            raise ValueError("The ZIP and release version differ.")
        scripts = {manifest["background"]["service_worker"]}
        for entry in manifest["content_scripts"]:
            scripts.update(entry["js"])
        worker = (path / "extension" / manifest["background"]["service_worker"]).read_text(
            encoding="utf-8"
        )
        for imports in re.findall(r"importScripts\(([^)]*)\)", worker):
            scripts.update(re.findall(r"['\"]([^'\"]+)['\"]", imports))
        missing = {"extension/" + name for name in scripts} - set(archive.namelist())
        if missing:
            raise ValueError("Package missing: " + ", ".join(sorted(missing)))
        for name in archive.namelist():
            source = path / ("LICENSE" if name == "extension/LICENSE" else name)
            if archive.read(name) != source.read_bytes():
                raise ValueError(f"Packaged file differs from the loaded folder: {name}")
        with tempfile.TemporaryDirectory(prefix="rail-watch-package-") as directory:
            archive.extractall(directory)
            run(
                ["node", "--test", "--test-reporter=dot", str(path / "tests/startup.test.cjs")],
                cwd=directory,
            )


def check(path, expected_version, all_tests=True):
    print(f"Building and checking {expected_version} in {path}", flush=True)
    run([sys.executable, "build-extension.py"], cwd=path)
    check_package(path, expected_version)
    if all_tests:
        run(
            [
                "node",
                "--test",
                "--test-reporter=dot",
                *[str(test) for test in sorted((path / "tests").glob("*.test.cjs"))],
            ],
            cwd=path,
        )
    run(["git", "diff", "--check"], cwd=path)


def release(next_release):
    branch = git("branch", "--show-current")
    if not branch:
        raise ValueError("Check out a branch before releasing.")
    main = main_checkout()
    require_clean(ROOT)
    require_clean(main)
    run(["git", "fetch", "origin", "main"])
    run(["git", "merge", "--ff-only", "origin/main"], cwd=main)
    if main != ROOT:
        run(["git", "merge", "--no-edit", "main"])
    current_version = ".".join(map(str, version(ROOT)))
    release_tag = "v" + current_version
    checked_release = git("log", "-1", "--format=%s") == "Release " + current_version
    main_ahead = bool(git("rev-list", "origin/main..HEAD"))
    unreleased = (
        bool(git("rev-list", release_tag + "..HEAD"))
        if git("tag", "--list", release_tag, cwd=main)
        else main_ahead
    )
    tag_pending = (
        checked_release
        and not git("ls-remote", "origin", "refs/tags/" + release_tag, cwd=main).split()
    )
    if not unreleased and not tag_pending:
        raise ValueError(
            "No committed changes to release. Use --check to verify the current build."
        )
    if checked_release:
        if next_release != "patch":
            raise ValueError(
                f"The unpublished {current_version} release is already checked. "
                f"Publish it before using --{next_release}."
            )
        next_version = current_version
        print(f"Retrying the unpublished {next_version} release.", flush=True)
        if main_ahead:
            check(ROOT, next_version)
        require_clean(ROOT)
    else:
        major, minor, patch = max(version(ROOT), version(main))
        if next_release == "major":
            next_version = f"{major + 1}.0.0"
        elif next_release == "minor":
            next_version = f"{major}.{minor + 1}.0"
        else:
            next_version = f"{major}.{minor}.{patch + 1}"
        write_version(ROOT, next_version)
        check(ROOT, next_version)
        release_files = [
            "extension/manifest.json",
            "extension/content.js",
            "extension/ui.js",
            "extension/preview-data.js",
            "package.json",
        ]
        changed = set(git("diff", "HEAD", "--name-only").splitlines())
        if changed - set(release_files):
            raise ValueError(
                "Source files changed during the release. Review them before retrying."
            )
        run(["git", "add", *release_files])
        run(["git", "commit", "-m", "Release " + next_version])
    commit = git("rev-parse", "HEAD")
    if main != ROOT:
        require_clean(main)
        run(["git", "merge", "--ff-only", branch], cwd=main)
    if git("rev-parse", "HEAD", cwd=main) != commit:
        raise ValueError("Main does not contain the checked release commit.")
    check(main, next_version, all_tests=False)
    require_clean(main)
    run(["git", "push", "origin", "main"], cwd=main)
    remote_commit = git("ls-remote", "origin", "refs/heads/main", cwd=main).split()[0]
    if remote_commit != commit:
        raise ValueError("Remote main changed. Check its release before reporting completion.")
    tag = "v" + next_version
    if git("tag", "--list", tag, cwd=main):
        if git("rev-parse", tag + "^{commit}", cwd=main) != commit:
            raise ValueError(f"Tag {tag} already targets another commit.")
    else:
        run(["git", "tag", tag, commit], cwd=main)
    run(["git", "push", "origin", "refs/tags/" + tag], cwd=main)
    print(
        f"\nReleased {next_version} to origin/main at {commit[:7]} and pushed tag {tag}.\n"
        f"Extension folder: {main / 'extension'}\n"
        f"ZIP: {main / 'railway-seat-watch-extension.zip'}\n"
        "Reload the extension, confirm the version, then refresh D-Ticket.\n"
        f"The Publish ZIP release workflow now verifies {tag} and attaches the ZIP to the "
        "GitHub release when it finishes.",
        flush=True,
    )


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--check",
        action="store_true",
        help="Build and check this checkout without versioning, merging, or pushing.",
    )
    bump = parser.add_mutually_exclusive_group()
    bump.add_argument(
        "--minor",
        action="store_true",
        help="Release the next minor version (1.1.0) instead of a patch.",
    )
    bump.add_argument(
        "--major",
        action="store_true",
        help="Release the next major version (2.0.0) instead of a patch.",
    )
    args = parser.parse_args()
    try:
        if args.check:
            if args.minor or args.major:
                parser.error("--check does not change the version")
            check(ROOT, ".".join(map(str, version(ROOT))))
        else:
            release("minor" if args.minor else "major" if args.major else "patch")
    except (
        ValueError,
        OSError,
        KeyError,
        subprocess.CalledProcessError,
        zipfile.BadZipFile,
    ) as error:
        print(f"Release stopped: {error}", file=sys.stderr)
        sys.exit(1)
