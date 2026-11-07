"""Offline installer safety regressions; no phone, registry or network access.

The fake Termux tree supplies only platform/package-manager probes. Bash, tar,
SHA-256 and Node actually run, so publication, integrity and retry behavior are
tested together. This is not proof of Android compatibility.
"""
from __future__ import annotations

import hashlib
import io
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tarfile
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
BASH = shutil.which("bash") if os.name != "nt" else r"C:\Program Files\Git\bin\bash.exe"
NODE = shutil.which("node")


def posix(path: Path | str) -> str:
    value = str(path).replace("\\", "/")
    return "/" + value[0].lower() + value[2:] if len(value) > 1 and value[1] == ":" else value


def quote(value: str) -> str:
    return "'" + value.replace("'", "'\\''") + "'"


@unittest.skipUnless(BASH and Path(BASH).exists() and NODE, "requires Bash and Node >=22.19")
class InstallerTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="installer-", dir=ROOT / "tests")
        self.base = Path(self.temporary.name)
        self.prefix = self.base / "data/data/com.termux/files/usr"
        self.home = self.prefix.parent / "home"
        self.bin = self.prefix / "bin"
        self.bin.mkdir(parents=True)
        self.home.mkdir()
        self.source = self.base / "source"
        self.source.mkdir()
        (self.source / "app").mkdir()
        (self.source / "example").mkdir()
        (self.source / "app/cli.mjs").write_text("process.stdout.write('fixture app\\n');\n", encoding="utf-8")
        (self.source / "example/package.json").write_text('{"name":"fixture"}\n', encoding="utf-8")
        self.write_manifest()
        self.install_root = self.home / ".termux-pi-test"
        self.npm_log = self.base / "npm.log"
        self.env = dict(os.environ)
        for name in ("PROOT_TMP_DIR", "PROOT_LOADER", "BASH_ENV", "ENV", "CDPATH"):
            self.env.pop(name, None)
        self.env.update(HOME=posix(self.home), PREFIX=posix(self.prefix),
                        PATH=posix(self.bin) + ":/usr/bin:/bin", TEST_NPM_LOG=posix(self.npm_log))
        if os.name == "nt":
            self.env["MSYS"] = "winsymlinks:nativestrict"
        self.stub("id", "printf '10000\\n'\n")
        self.stub("uname", "printf 'Android\\n'\n")
        self.stub("df", "printf 'Filesystem 1024-blocks Used Available Capacity Mounted\\nfixture 9999999 0 9999999 0%% /\\n'\n")
        self.stub("node", f"exec {quote(posix(NODE))} \"$@\"\n")
        self.stub("apt-get", "echo 'unexpected apt-get' >&2; exit 99\n")
        for command in ("rg", "fd", "git"):
            self.stub(command, "exit 0\n")
        self.stub("npm", r'''printf 'install\n' >> "$TEST_NPM_LOG"
[[ ${TEST_NPM_FAIL:-0} == 0 ]] || exit 19
runtime=''
while (($#)); do
  if [[ $1 == --prefix ]]; then runtime=$2; shift 2; else shift; fi
done
mkdir -p "$runtime/node_modules/@earendil-works/pi-coding-agent/dist/bundle"
printf '{"name":"@earendil-works/pi-coding-agent","version":"1.5.0"}\n' > "$runtime/node_modules/@earendil-works/pi-coding-agent/package.json"
printf 'process.stdout.write("fixture pi\\n");\n' > "$runtime/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js"
''')
        self.stub("curl", r'''while (($#)); do
  if [[ $1 == --output ]]; then output=$2; shift 2; else shift; fi
done
cp -- "$TEST_ARCHIVE" "$output"
''')

    def tearDown(self):
        self.temporary.cleanup()

    def stub(self, name, text):
        path = self.bin / name
        path.write_text("#!/bin/bash\nset -e\n" + text, encoding="utf-8", newline="\n")
        path.chmod(0o755)

    def write_manifest(self):
        entries = []
        for folder in ("app", "example"):
            for path in sorted((self.source / folder).rglob("*")):
                if path.is_file():
                    entries.append(f"{hashlib.sha256(path.read_bytes()).hexdigest()}  {path.relative_to(self.source).as_posix()}\n")
        (self.source / "app-manifest.sha256").write_text("".join(entries), encoding="utf-8", newline="\n")

    def run_installer(self, *args, success=True, local=True, env=None):
        command = self.installer_command() + ["--yes", "--skip-configure", "--no-link", "--root", posix(self.install_root)]
        if local:
            command += ["--source-dir", posix(self.source)]
        command += list(args)
        result = subprocess.run(command, env=env or self.env, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=45)
        if success:
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        else:
            self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
        return result

    def installer_command(self):
        # Git Bash prepends its own /usr/bin during startup. Set PATH after
        # startup so the fake platform probes are selected on Windows too.
        return [BASH, "--noprofile", "--norc", "-c", 'export PATH="$PREFIX/bin:/usr/bin:/bin"; source "$@"', "installer-test", posix(ROOT / "install.sh")]

    def assert_clean_staging(self):
        self.assertFalse((self.install_root / ".install-lock").exists())
        self.assertEqual(list(self.install_root.glob(".staging.*")), [])

    def test_non_android_and_root_rejected_before_mutation(self):
        self.stub("uname", "printf 'GNU/Linux\\n'\n")
        self.assertIn("[environment]", self.run_installer(success=False).stderr)
        self.assertFalse(self.install_root.exists())
        self.stub("uname", "printf 'Android\\n'\n")
        self.stub("id", "printf '0\\n'\n")
        self.assertIn("[environment]", self.run_installer(success=False).stderr)
        self.assertFalse(self.install_root.exists())
        self.assertFalse(self.npm_log.exists())

    def test_outside_home_traversal_symlink_and_unmanaged_roots_preserved(self):
        outside = self.base / "outside"
        for target in (posix(outside), posix(self.home) + "/a/../b"):
            self.assertIn("[root]", self.run_installer("--root", target, success=False).stderr)
        self.assertFalse(outside.exists())
        outside.mkdir()
        result = subprocess.run([BASH, "-c", 'ln -s -- "$1" "$2"', "symlink-test", posix(outside), posix(self.home / "linked")], env=self.env, capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("[root]", self.run_installer("--root", posix(self.home / "linked/child"), success=False).stderr)
        self.install_root.mkdir()
        sentinel = self.install_root / "my-file"
        sentinel.write_text("keep", encoding="utf-8")
        self.assertIn("[ownership]", self.run_installer(success=False).stderr)
        self.assertEqual(sentinel.read_text(), "keep")
        self.assertFalse((self.install_root / ".termux-pi-managed").exists())

    def test_repeat_install_keeps_private_config_workspace_and_skips_npm(self):
        self.run_installer()
        for name in ("private/key", "config/settings.json", "projects/work/main.js"):
            path = self.install_root / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text("user data: " + name, encoding="utf-8")
        first_manifest = (self.install_root / "releases/0.1.0/app-manifest.sha256").read_bytes()
        self.run_installer()
        self.assertEqual(self.npm_log.read_text().splitlines(), ["install"])
        for name in ("private/key", "config/settings.json", "projects/work/main.js"):
            self.assertEqual((self.install_root / name).read_text(), "user data: " + name)
        self.assertEqual((self.install_root / "releases/0.1.0/app-manifest.sha256").read_bytes(), first_manifest)
        result = subprocess.run([BASH, "-c", 'readlink "$HOME/.termux-pi-test/current"'], env=self.env, capture_output=True, text=True)
        self.assertEqual(result.stdout.strip(), "releases/0.1.0")
        self.assert_clean_staging()

    def test_corrupt_runtime_is_not_silently_repaired(self):
        self.run_installer()
        package = self.install_root / "runtime/node_modules/@earendil-works/pi-coding-agent/package.json"
        package.write_text('{"name":"@earendil-works/pi-coding-agent","version":"9.9.9"}', encoding="utf-8")
        self.assertIn("[runtime]", self.run_installer(success=False).stderr)
        self.assertIn("9.9.9", package.read_text())
        self.assertEqual(self.npm_log.read_text().splitlines(), ["install"])
        self.assert_clean_staging()

    def test_tampered_payload_never_publishes_or_installs_runtime(self):
        (self.source / "app/cli.mjs").write_text("tampered", encoding="utf-8")
        self.assertIn("[integrity]", self.run_installer(success=False).stderr)
        self.assertFalse((self.install_root / "current").exists())
        self.assertFalse((self.install_root / "runtime").exists())
        self.assertFalse(self.npm_log.exists())
        self.assert_clean_staging()

    def test_npm_failure_leaves_no_partial_runtime_and_retry_succeeds(self):
        env = dict(self.env, TEST_NPM_FAIL="1")
        self.run_installer(success=False, env=env)
        self.assertFalse((self.install_root / "runtime").exists())
        self.assertFalse((self.install_root / "releases/0.1.0").exists())
        self.assert_clean_staging()
        self.run_installer()
        self.assertTrue((self.install_root / "runtime/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js").is_file())
        self.assert_clean_staging()

    def test_unknown_prefix_command_is_not_overwritten(self):
        command = self.bin / "pi-termux"
        command.write_text("user command", encoding="utf-8")
        # Remove the normal isolated-test --no-link for this ownership check.
        args = self.installer_command() + ["--yes", "--skip-configure", "--root", posix(self.install_root), "--source-dir", posix(self.source)]
        result = subprocess.run(args, env=self.env, capture_output=True, text=True, encoding="utf-8", timeout=45)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("[command]", result.stderr)
        self.assertEqual(command.read_text(), "user command")
        self.assertFalse(self.install_root.exists())

    def test_archive_symlink_payload_rejected_without_extracting_target(self):
        archive = self.base / "hostile.tar.gz"
        sentinel = self.base / "outside-target"
        sentinel.write_text("untouched", encoding="utf-8")
        with tarfile.open(archive, "w:gz") as tar:
            manifest = (self.source / "app-manifest.sha256").read_bytes()
            info = tarfile.TarInfo("termux-pi-0.1.0/app-manifest.sha256")
            info.size = len(manifest)
            tar.addfile(info, io.BytesIO(manifest))
            info = tarfile.TarInfo("termux-pi-0.1.0/app/cli.mjs")
            info.type = tarfile.SYMTYPE
            info.linkname = posix(sentinel)
            tar.addfile(info)
        env = dict(self.env, TEST_ARCHIVE=posix(archive))
        result = self.run_installer("--source-url", "https://example.invalid/source.tar.gz", local=False, success=False, env=env)
        self.assertIn("[archive]", result.stderr)
        self.assertEqual(sentinel.read_text(), "untouched")
        self.assertFalse(self.npm_log.exists())
        self.assert_clean_staging()

    def test_downloaded_source_archive_installs_only_verified_payload(self):
        archive = self.base / "source.tar.gz"
        with tarfile.open(archive, "w:gz") as tar:
            for path in sorted(self.source.rglob("*")):
                if path.is_file():
                    tar.add(path, arcname="termux-pi-0.1.0/" + path.relative_to(self.source).as_posix())
            extra = tarfile.TarInfo("termux-pi-0.1.0/private/never-extract")
            extra.size = 6
            tar.addfile(extra, io.BytesIO(b"secret"))
        env = dict(self.env, TEST_ARCHIVE=posix(archive))
        self.run_installer("--source-url", "https://example.invalid/source.tar.gz", local=False, env=env)
        self.assertEqual((self.install_root / "releases/0.1.0/app/cli.mjs").read_bytes(), (self.source / "app/cli.mjs").read_bytes())
        self.assertFalse((self.install_root / "releases/0.1.0/private").exists())
        self.assert_clean_staging()

    def test_release_build_is_reproducible_lf_and_excludes_private_files(self):
        (self.source / "scripts").mkdir()
        shutil.copyfile(ROOT / "scripts/build-release.py", self.source / "scripts/build-release.py")
        shutil.copyfile(ROOT / "install.sh", self.source / "install.sh")
        (self.source / "app/cli.mjs").write_bytes(b"console.log('hello');\r\n")
        (self.source / "private").mkdir()
        (self.source / "private/key").write_text("NEVER SHIP", encoding="utf-8")
        archives = []
        for directory in ("out-a", "out-b"):
            output = self.base / directory
            result = subprocess.run([sys.executable, str(self.source / "scripts/build-release.py"), "--output-dir", str(output)], capture_output=True, text=True, timeout=20)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            archives.append(output / "termux-pi-0.1.0.tar.gz")
        self.assertEqual(archives[0].read_bytes(), archives[1].read_bytes())
        with tarfile.open(archives[0]) as tar:
            self.assertFalse(any("private" in member.name for member in tar))
            self.assertEqual(tar.extractfile("termux-pi-0.1.0/app/cli.mjs").read(), b"console.log('hello');\n")
            self.assertEqual(tar.getmember("termux-pi-0.1.0/install.sh").mode, 0o755)
            self.assertTrue(all(member.mtime == 0 and member.uid == 0 and member.gid == 0 for member in tar))


if __name__ == "__main__":
    unittest.main(verbosity=2)
