"""Synthetic GitHub replies only: these tests never make network requests."""
import copy
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import sys
import tempfile
import unittest
import zipfile

SCRIPT = Path(__file__).resolve().parent.parent / "scripts" / "cleanup-old-release-assets.py"
SPEC = importlib.util.spec_from_file_location("synthetic_release_cleanup", SCRIPT)
cleanup = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = cleanup
SPEC.loader.exec_module(cleanup)


def release(tag, identity, assets=None):
    return {"id": identity, "tag_name": tag, "draft": False, "body": "Existing historical notes.",
            "html_url": f"https://github.com/{cleanup.REPOSITORY}/releases/tag/{tag}", "assets": assets or []}


def asset(tag, name, identity, size=123):
    return {"id": identity, "name": name, "state": "uploaded", "size": size,
            "browser_download_url": cleanup.asset_url(tag, name)}


class FakeClock:
    def __init__(self):
        self.elapsed = 0

    def now(self):
        return self.elapsed

    def sleep(self, seconds):
        self.elapsed += seconds


class FakeGitHub:
    def __init__(self, files):
        self.files = files
        self.calls, self.mutations, self.downloads = [], [], []
        self.current = release(cleanup.CURRENT_TAG, 50, [asset(cleanup.CURRENT_TAG, name, 10 + index, len(files[name])) for index, name in enumerate(cleanup.REQUIRED_ASSETS)])
        self.old = []
        for index, tag in enumerate(sorted(cleanup.OLD_TAGS)):
            candidates = [asset(tag, f"{cleanup.APPLICATION}-{tag[1:]}-{kind}.zip", 100 + index * 10 + suffix) for suffix, kind in enumerate(("source", "runtime"))]
            candidates += [asset(tag, "INSTALL_AGENT.md", 102 + index * 10), asset(tag, "do-not-delete.zip", 103 + index * 10),
                           asset(tag, cleanup.CURRENT_ZIP, 104 + index * 10)]
            self.old.append(release(tag, 200 + index, candidates))
        self.unknown = release("v9.9.9", 999, [asset("v9.9.9", f"{cleanup.APPLICATION}-1.2.0-beta.3-source.zip", 901)])
        self.fail_downloads = 0

    def api(self, method, resource, body=None):
        self.calls.append((method, resource))
        if method in {"DELETE", "PATCH"}:
            self.mutations.append((method, resource, body))
        if method == "GET" and resource.endswith("/tags/" + cleanup.CURRENT_TAG):
            return copy.deepcopy(self.current)
        if method == "GET" and "?per_page=100&page=" in resource:
            return copy.deepcopy([self.current] + self.old + [self.unknown])
        identity = int(resource.rsplit("/", 1)[-1])
        if method == "DELETE":
            for row in [self.current] + self.old + [self.unknown]:
                for item in row["assets"]:
                    if item["id"] == identity:
                        row["assets"].remove(item)
                        return None
            raise cleanup.HttpStatusError(404)
        row = next((value for value in [self.current] + self.old + [self.unknown] if value["id"] == identity), None)
        if row is None:
            raise cleanup.HttpStatusError(404)
        if method == "PATCH":
            row["body"] = body["body"]
        return copy.deepcopy(row)

    def download(self, url):
        self.downloads.append(url)
        if self.fail_downloads:
            self.fail_downloads -= 1
            raise cleanup.HttpStatusError(404)
        name = url.rsplit("/", 1)[-1]
        value = self.files[name]
        return cleanup.Downloaded(hashlib.sha256(value).hexdigest(), len(value), value[:4], None if name.endswith(".zip") else value)


class CleanupTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="growth-cleanup-synthetic-")
        self.addCleanup(self.temporary.cleanup)
        self.directory = Path(self.temporary.name)
        archive = self.directory / cleanup.CURRENT_ZIP
        with zipfile.ZipFile(archive, "w") as output:
            output.writestr(f"{cleanup.APPLICATION}/RUNTIME_MANIFEST.json", json.dumps({"name": cleanup.APPLICATION, "version": cleanup.CURRENT_TAG[1:], "kind": "runtime", "files": []}))
            output.writestr(f"{cleanup.APPLICATION}/server.mjs", "// Synthetic runtime artifact, never executed.\n")
        digest = hashlib.sha256(archive.read_bytes()).hexdigest()
        manifest = {"application": cleanup.APPLICATION, "release": {"repository": cleanup.REPOSITORY,
            "version": cleanup.CURRENT_TAG[1:], "tag": cleanup.CURRENT_TAG, "published": True,
            "kind": "runtime", "archiveRoot": cleanup.APPLICATION, "url": cleanup.asset_url(cleanup.CURRENT_TAG, cleanup.CURRENT_ZIP), "sha256": digest}}
        (self.directory / "install-manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
        (self.directory / "SHA256SUMS.txt").write_text(f"{digest}  {cleanup.CURRENT_ZIP}\n", encoding="utf-8")
        (self.directory / "INSTALL_AGENT.md").write_text(f"Synthetic installation guide for {cleanup.CURRENT_TAG}.\n", encoding="utf-8")
        self.files = {name: (self.directory / name).read_bytes() for name in cleanup.REQUIRED_ASSETS}
        self.config = cleanup.Configuration("synthetic-token-never-live", cleanup.REPOSITORY, cleanup.CURRENT_TAG)
        self.clock = FakeClock()

    def run_cleanup(self, remote, apply=False):
        return cleanup.cleanup(self.config, self.directory, transport=remote, apply=apply, monotonic=self.clock.now, sleep=self.clock.sleep)

    def test_any_failed_new_release_verification_prevents_old_release_enumeration_and_all_writes(self):
        for mode in ("draft", "missing-asset", "wrong-zip", "wrong-public-manifest", "wrong-local-checksum"):
            with self.subTest(mode=mode):
                remote = FakeGitHub(copy.deepcopy(self.files))
                if mode == "draft":
                    remote.current["draft"] = True
                elif mode == "missing-asset":
                    remote.current["assets"].pop()
                elif mode == "wrong-zip":
                    remote.files[cleanup.CURRENT_ZIP] += b"changed"
                elif mode == "wrong-public-manifest":
                    remote.files["install-manifest.json"] = b"{}"
                else:
                    (self.directory / "SHA256SUMS.txt").write_text("0" * 64 + "  " + cleanup.CURRENT_ZIP + "\n", encoding="utf-8")
                try:
                    with self.assertRaises(cleanup.CleanupError):
                        self.run_cleanup(remote, apply=True)
                    self.assertEqual(remote.mutations, [])
                    self.assertFalse(any("?per_page=" in resource for _, resource in remote.calls))
                finally:
                    (self.directory / "SHA256SUMS.txt").write_bytes(self.files["SHA256SUMS.txt"])

    def test_apply_deletes_only_exact_allowed_old_zip_assets_and_preserves_other_records(self):
        remote = FakeGitHub(self.files)
        expected = {item["id"] for row in remote.old for item in row["assets"] if item["name"] in {f"{cleanup.APPLICATION}-{row['tag_name'][1:]}-{kind}.zip" for kind in ("source", "runtime")}}
        current = copy.deepcopy(remote.current)
        unknown = copy.deepcopy(remote.unknown)
        result = self.run_cleanup(remote, apply=True)
        deleted = {int(resource.rsplit("/", 1)[-1]) for method, resource, _ in remote.mutations if method == "DELETE"}
        self.assertEqual(deleted, expected)
        self.assertEqual(len(result["deleted"]), 8)
        self.assertEqual(remote.current, current)
        self.assertEqual(remote.unknown, unknown)
        self.assertTrue(all(item["name"] in {"INSTALL_AGENT.md", "do-not-delete.zip", cleanup.CURRENT_ZIP} for row in remote.old for item in row["assets"]))
        for row in remote.old:
            self.assertTrue(row["body"].startswith(cleanup.NOTE_MARKER))
            self.assertIn("Existing historical notes.", row["body"])
            self.assertIn(cleanup.CURRENT_PAGE, row["body"])
        self.assertTrue(all(method != "DELETE" or "/releases/assets/" in resource for method, resource, _ in remote.mutations))

    def test_dry_run_is_read_only_and_anonymous_downloads_never_receive_token_or_cookie(self):
        remote = FakeGitHub(self.files)
        before = copy.deepcopy(remote.old)
        report = self.run_cleanup(remote)
        self.assertEqual(report["mode"], "dry-run")
        self.assertEqual(remote.mutations, [])
        self.assertEqual(remote.old, before)
        self.assertEqual(len(remote.downloads), 4)
        self.assertNotIn(self.config.token, json.dumps(report))
        self.assertNotIn(self.config.token, repr(self.config))

        class Response(io.BytesIO):
            def geturl(inner):
                return cleanup.asset_url(cleanup.CURRENT_TAG, cleanup.CURRENT_ZIP)

        observed = []

        class LocalOnlyOpener:
            def open(inner, request, timeout):
                observed.append({key.lower(): value for key, value in request.header_items()})
                return Response(self.files[cleanup.CURRENT_ZIP])

        transport = cleanup.GitHubTransport(self.config)
        transport.public_opener = LocalOnlyOpener()
        actual = transport.download(cleanup.asset_url(cleanup.CURRENT_TAG, cleanup.CURRENT_ZIP))
        self.assertEqual(actual.sha256, hashlib.sha256(self.files[cleanup.CURRENT_ZIP]).hexdigest())
        self.assertNotIn("authorization", observed[0])
        self.assertNotIn("cookie", observed[0])

    def test_missing_old_releases_and_repeated_completed_cleanup_are_idempotent(self):
        remote = FakeGitHub(self.files)
        remote.old = remote.old[:1]  # Other old tags may already have disappeared.
        first = self.run_cleanup(remote, apply=True)
        self.assertEqual(len(first["deleted"]), 2)
        previous_mutations = copy.deepcopy(remote.mutations)
        second = self.run_cleanup(remote, apply=True)
        self.assertEqual(second["deleted"], [])
        self.assertEqual(second["noted"], [])
        self.assertEqual(remote.mutations, previous_mutations)
        remote.old = []
        self.assertEqual(self.run_cleanup(remote, apply=True)["plans"], [])

    def test_anonymous_404_retries_are_bounded_to_thirty_seconds_before_any_cleanup(self):
        remote = FakeGitHub(self.files)
        remote.fail_downloads = 100
        with self.assertRaises(cleanup.CleanupError):
            self.run_cleanup(remote, apply=True)
        self.assertEqual(self.clock.elapsed, 30)
        self.assertGreater(len(remote.downloads), 1)
        self.assertEqual(remote.mutations, [])
        self.assertFalse(any("?per_page=" in resource for _, resource in remote.calls))

    def test_repository_and_current_tag_are_hard_restricted_before_requests(self):
        for repository, tag in (("someone/another-project", cleanup.CURRENT_TAG), (cleanup.REPOSITORY, "v1.2.0-beta.3")):
            remote = FakeGitHub(self.files)
            with self.assertRaises(cleanup.CleanupError):
                cleanup.cleanup(cleanup.Configuration("synthetic-token", repository, tag), self.directory, transport=remote, apply=True)
            self.assertEqual(remote.calls, [])
            self.assertEqual(remote.mutations, [])


if __name__ == "__main__":
    unittest.main()
