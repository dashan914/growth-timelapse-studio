#!/usr/bin/env python3
"""Remove only specified historical ZIP attachments after verifying beta.4."""
from __future__ import annotations

import argparse
from dataclasses import dataclass, field
import hashlib
import json
import os
from pathlib import Path
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import zipfile

REPOSITORY = "dashan914/growth-timelapse-studio"
CURRENT_TAG = "v1.2.0-beta.4"
APPLICATION = "growth-timelapse-studio"
OLD_TAGS = frozenset({"v1.1.0-beta.1", "v1.2.0-beta.1", "v1.2.0-beta.2", "v1.2.0-beta.3"})
CURRENT_ZIP = f"{APPLICATION}-{CURRENT_TAG[1:]}-runtime.zip"
REQUIRED_ASSETS = (CURRENT_ZIP, "SHA256SUMS.txt", "install-manifest.json", "INSTALL_AGENT.md")
CURRENT_PAGE = f"https://github.com/{REPOSITORY}/releases/tag/{CURRENT_TAG}"
NOTE_MARKER = f"<!-- growth-old-install-zip-removed:{CURRENT_TAG} -->"
NOTE = f"{NOTE_MARKER}\n旧版官方安装 ZIP 附件已移除，请使用 [1.2.0-beta.4 安装包]({CURRENT_PAGE})。本版本的 Release 记录、标签和源码历史继续保留。\n\n"


class CleanupError(Exception):
    pass


class HttpStatusError(CleanupError):
    def __init__(self, status):
        self.status = status
        super().__init__(f"HTTP {status}")


@dataclass(frozen=True)
class Configuration:
    token: str = field(repr=False)
    repository: str
    tag: str

    @classmethod
    def from_environment(cls, env=None):
        env = os.environ if env is None else env
        result = cls(env.get("GH_TOKEN", ""), env.get("GH_REPO", ""), env.get("GITHUB_REF_NAME", ""))
        result.validate()
        return result

    def validate(self):
        if self.repository != REPOSITORY or self.tag != CURRENT_TAG:
            raise CleanupError("仓库或当前标签不在本脚本的固定允许范围。")
        if not self.token or "\n" in self.token or "\r" in self.token:
            raise CleanupError("缺少有效 GH_TOKEN。")


@dataclass(frozen=True)
class Downloaded:
    sha256: str
    size: int
    prefix: bytes
    data: bytes | None


def asset_url(tag, name):
    return f"https://github.com/{REPOSITORY}/releases/download/{tag}/{name}"


def public_url_allowed(url):
    parsed = urllib.parse.urlsplit(url)
    return (parsed.scheme == "https" and not parsed.username and not parsed.password
            and (parsed.hostname == "github.com" or parsed.hostname == "githubusercontent.com"
                 or (parsed.hostname or "").endswith(".githubusercontent.com")))


class AnonymousHttpsRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, response, code, message, headers, new_url):
        if not public_url_allowed(new_url):
            raise CleanupError("公开附件下载重定向不在 HTTPS GitHub 域名范围。")
        return super().redirect_request(request, response, code, message, headers, new_url)


class NoApiRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args):
        raise CleanupError("固定 GitHub API 不接受重定向。")


class GitHubTransport:
    def __init__(self, config):
        self.token = config.token
        self.api_opener = urllib.request.build_opener(NoApiRedirect())
        self.public_opener = urllib.request.build_opener(AnonymousHttpsRedirect())

    def api(self, method, resource, body=None):
        if method not in {"GET", "DELETE", "PATCH"} or not resource.startswith(f"/repos/{REPOSITORY}/releases"):
            raise CleanupError("API 操作超出固定发行范围。")
        headers = {"Accept": "application/vnd.github+json", "Authorization": f"Bearer {self.token}",
                   "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "growth-release-cleanup",
                   "Cache-Control": "no-cache"}
        payload = None if body is None else json.dumps(body, ensure_ascii=False).encode("utf-8")
        if payload is not None:
            headers["Content-Type"] = "application/json"
        request = urllib.request.Request("https://api.github.com" + resource, data=payload, headers=headers, method=method)
        try:
            with self.api_opener.open(request, timeout=20) as response:
                data = response.read(8 * 1024 * 1024 + 1)
                if len(data) > 8 * 1024 * 1024:
                    raise CleanupError("GitHub API 返回内容过大。")
                return json.loads(data) if data else None
        except urllib.error.HTTPError as error:
            raise HttpStatusError(error.code) from None
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError):
            raise CleanupError("GitHub API 请求或响应未完成。") from None

    def download(self, url):
        if not public_url_allowed(url):
            raise CleanupError("公开附件必须使用 HTTPS GitHub 地址。")
        # This separate opener receives no token, Authorization or cookies.
        request = urllib.request.Request(url, headers={"User-Agent": "growth-release-anonymous-verification", "Cache-Control": "no-cache"})
        keep_bytes = not url.endswith(".zip")
        maximum = 2 * 1024 * 1024 if keep_bytes else 512 * 1024 * 1024
        digest, count, prefix, chunks = hashlib.sha256(), 0, b"", []
        try:
            with self.public_opener.open(request, timeout=20) as response:
                if not public_url_allowed(response.geturl()):
                    raise CleanupError("公开附件的最终地址不是允许的 HTTPS 地址。")
                while True:
                    chunk = response.read(1024 * 1024)
                    if not chunk:
                        break
                    count += len(chunk)
                    if count > maximum:
                        raise CleanupError("公开附件超过本次验证的大小上限。")
                    if len(prefix) < 4:
                        prefix = (prefix + chunk)[:4]
                    digest.update(chunk)
                    if keep_bytes:
                        chunks.append(chunk)
        except urllib.error.HTTPError as error:
            raise HttpStatusError(error.code) from None
        except (urllib.error.URLError, TimeoutError):
            raise CleanupError("匿名 HTTPS 附件下载未完成。") from None
        return Downloaded(digest.hexdigest(), count, prefix, b"".join(chunks) if keep_bytes else None)


def sha256_file(filename):
    digest = hashlib.sha256()
    with filename.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def json_object(data, label):
    try:
        result = json.loads(data)
    except (ValueError, TypeError, UnicodeError):
        raise CleanupError(f"{label} 不是有效 JSON。") from None
    if not isinstance(result, dict):
        raise CleanupError(f"{label} 必须是 JSON 对象。")
    return result


def verify_manifest(data, zip_hash):
    manifest = json_object(data, "外部安装清单")
    release = manifest.get("release", {})
    if (manifest.get("application") != APPLICATION or not isinstance(release, dict)
            or release.get("repository") != REPOSITORY or release.get("tag") != CURRENT_TAG
            or release.get("version") != CURRENT_TAG[1:] or release.get("published") is not True
            or release.get("kind") != "runtime" or release.get("archiveRoot") != APPLICATION
            or release.get("url") != asset_url(CURRENT_TAG, CURRENT_ZIP) or release.get("sha256") != zip_hash):
        raise CleanupError("新版外部清单与固定版本 ZIP 或 SHA256 不一致。")


def verify_checksum(data, zip_hash):
    try:
        lines = [line for line in data.decode("utf-8").splitlines() if line.strip()]
    except (AttributeError, UnicodeError):
        raise CleanupError("SHA256SUMS.txt 不是有效文本。") from None
    if len(lines) != 1:
        raise CleanupError("SHA256SUMS.txt 必须只对应本次固定运行 ZIP。")
    match = re.fullmatch(r"([a-f0-9]{64}) [ *](.+)", lines[0])
    if not match or match.group(1) != zip_hash or match.group(2) != CURRENT_ZIP:
        raise CleanupError("新版 ZIP 与 SHA256SUMS.txt 不一致。")


def verify_local_release(directory):
    files = {}
    for name in REQUIRED_ASSETS:
        filename = directory / name
        if filename.is_symlink() or not filename.is_file():
            raise CleanupError(f"本地 release/ 缺少普通发行文件：{name}。")
        files[name] = {"sha256": sha256_file(filename), "size": filename.stat().st_size}
    try:
        with zipfile.ZipFile(directory / CURRENT_ZIP) as archive:
            runtime = json_object(archive.read(f"{APPLICATION}/RUNTIME_MANIFEST.json"), "运行包内部清单")
            if runtime.get("name") != APPLICATION or runtime.get("version") != CURRENT_TAG[1:] or runtime.get("kind") != "runtime":
                raise CleanupError("本地 ZIP 内部清单不是当前运行版。")
    except (zipfile.BadZipFile, KeyError):
        raise CleanupError("本地运行 ZIP 或内部清单无效。") from None
    verify_manifest((directory / "install-manifest.json").read_bytes(), files[CURRENT_ZIP]["sha256"])
    verify_checksum((directory / "SHA256SUMS.txt").read_bytes(), files[CURRENT_ZIP]["sha256"])
    return files


def valid_id(value):
    return type(value) is int and value > 0


def verify_current_release(config, directory, transport, monotonic, sleep):
    local = verify_local_release(directory)
    release = transport.api("GET", f"/repos/{REPOSITORY}/releases/tags/{CURRENT_TAG}")
    if (not isinstance(release, dict) or release.get("tag_name") != CURRENT_TAG
            or release.get("draft") is not False or not valid_id(release.get("id"))
            or release.get("html_url") != CURRENT_PAGE):
        raise CleanupError("当前新版 Release 尚未公开或身份不一致。")
    assets = release.get("assets")
    if not isinstance(assets, list) or len(assets) != len(REQUIRED_ASSETS):
        raise CleanupError("当前新版 Release 必须具备完整四个发行附件。")
    by_name = {}
    protected_ids = set()
    for item in assets:
        if not isinstance(item, dict) or item.get("name") not in REQUIRED_ASSETS or item.get("name") in by_name:
            raise CleanupError("当前新版附件名称重复或不在固定集合。")
        name = item["name"]
        if (not valid_id(item.get("id")) or item["id"] in protected_ids
                or item.get("state") != "uploaded" or item.get("size") != local[name]["size"]
                or item.get("browser_download_url") != asset_url(CURRENT_TAG, name)):
            raise CleanupError("当前新版附件元数据与本地发行文件不一致。")
        protected_ids.add(item["id"])
        by_name[name] = item
    deadline = monotonic() + 30
    downloaded = {}
    for name in REQUIRED_ASSETS:
        while True:
            try:
                actual = transport.download(asset_url(CURRENT_TAG, name))
                break
            except HttpStatusError as error:
                remaining = deadline - monotonic()
                if error.status != 404 or remaining <= 0:
                    raise CleanupError("新版附件匿名下载验证失败，未开始旧附件清理。") from None
                sleep(min(2, remaining))
        if actual.sha256 != local[name]["sha256"] or actual.size != local[name]["size"]:
            raise CleanupError(f"匿名下载与本地发行文件不一致：{name}。")
        downloaded[name] = actual
    if downloaded[CURRENT_ZIP].prefix != b"PK\x03\x04":
        raise CleanupError("匿名下载结果不是新版运行 ZIP。")
    verify_manifest(downloaded["install-manifest.json"].data, downloaded[CURRENT_ZIP].sha256)
    verify_checksum(downloaded["SHA256SUMS.txt"].data, downloaded[CURRENT_ZIP].sha256)
    return release, protected_ids


def eligible_assets(release, protected_ids):
    tag = release.get("tag_name")
    if tag not in OLD_TAGS:
        return []
    names = {f"{APPLICATION}-{tag[1:]}-{kind}.zip" for kind in ("source", "runtime")}
    assets = release.get("assets")
    if not isinstance(assets, list):
        raise CleanupError("旧 Release 附件列表无效。")
    selected = []
    for item in assets:
        if not isinstance(item, dict) or item.get("name") not in names:
            continue
        if (not valid_id(item.get("id")) or item["id"] in protected_ids
                or item.get("browser_download_url") != asset_url(tag, item["name"])):
            raise CleanupError("旧附件标识不明确，未开始清理。")
        selected.append({"id": item["id"], "name": item["name"]})
    return selected


def plan_cleanup(current, protected_ids, transport):
    plans, seen = [], set()
    for page in range(1, 101):
        rows = transport.api("GET", f"/repos/{REPOSITORY}/releases?per_page=100&page={page}")
        if not isinstance(rows, list):
            raise CleanupError("Release 枚举结果无效。")
        for release in rows:
            if not isinstance(release, dict) or release.get("tag_name") not in OLD_TAGS or release.get("id") == current["id"]:
                continue
            tag, identity = release["tag_name"], release.get("id")
            if not valid_id(identity) or release.get("html_url") != f"https://github.com/{REPOSITORY}/releases/tag/{tag}":
                raise CleanupError("旧 Release 身份不明确。")
            if identity in seen:
                continue
            seen.add(identity)
            plans.append({"releaseId": identity, "tag": tag, "assets": eligible_assets(release, protected_ids)})
        if len(rows) < 100:
            return plans
    raise CleanupError("Release 页数超过安全枚举上限。")


def apply_plans(plans, protected_ids, transport):
    deleted, already_removed, notes = [], [], []
    for plan in plans:
        resource = f"/repos/{REPOSITORY}/releases/{plan['releaseId']}"
        try:
            fresh = transport.api("GET", resource)
        except HttpStatusError as error:
            if error.status == 404:
                continue
            raise
        if not isinstance(fresh, dict) or fresh.get("id") != plan["releaseId"] or fresh.get("tag_name") != plan["tag"]:
            raise CleanupError("旧 Release 在执行前发生变化，已停止后续操作。")
        available = {item["id"]: item for item in eligible_assets(fresh, protected_ids)}
        for item in plan["assets"]:
            if item["id"] not in available:
                already_removed.append(item["name"])
                continue
            if available[item["id"]]["name"] != item["name"]:
                raise CleanupError("旧附件在执行前发生变化，已停止后续操作。")
            try:
                transport.api("DELETE", f"/repos/{REPOSITORY}/releases/assets/{item['id']}")
                deleted.append(item["name"])
            except HttpStatusError as error:
                if error.status != 404:
                    raise
                already_removed.append(item["name"])
        fresh = transport.api("GET", resource)
        if not isinstance(fresh, dict) or fresh.get("tag_name") != plan["tag"] or fresh.get("id") != plan["releaseId"]:
            raise CleanupError("旧 Release 在说明更新前发生变化，已停止。")
        if eligible_assets(fresh, protected_ids):
            raise CleanupError("旧 Release 仍有目标 ZIP，未写入已清理说明；可幂等重试。")
        body = fresh.get("body") or ""
        if not isinstance(body, str):
            raise CleanupError("旧 Release 正文格式无效。")
        if NOTE_MARKER not in body:
            transport.api("PATCH", resource, {"body": NOTE + body})
            notes.append(plan["tag"])
    return {"deleted": deleted, "alreadyRemoved": already_removed, "noted": notes}


def cleanup(config, directory, *, transport=None, apply=False, monotonic=time.monotonic, sleep=time.sleep):
    config.validate()
    transport = transport or GitHubTransport(config)
    current, protected_ids = verify_current_release(config, Path(directory), transport, monotonic, sleep)
    plans = plan_cleanup(current, protected_ids, transport)
    report = {"mode": "apply" if apply else "dry-run", "verifiedCurrentRelease": CURRENT_TAG,
              "repository": REPOSITORY, "plans": plans}
    if apply:
        report.update(apply_plans(plans, protected_ids, transport))
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    modes = parser.add_mutually_exclusive_group()
    modes.add_argument("--dry-run", action="store_true", help="只验证新版并打印计划，不写入 GitHub（默认）")
    modes.add_argument("--apply", action="store_true", help="新版验证通过后删除固定旧 ZIP，并更新旧版说明")
    args = parser.parse_args()
    try:
        report = cleanup(Configuration.from_environment(), Path(__file__).resolve().parent.parent / "release", apply=args.apply)
        print(json.dumps(report, ensure_ascii=False, indent=2))
        return 0
    except CleanupError as error:
        print(f"发行附件清理未完成：{error} 后续操作已停止。", file=sys.stderr)
        return 1
    except Exception:
        # Never echo unexpected request/configuration objects or tokens.
        print("发行附件清理未完成，后续操作已停止。请检查本地发行文件与网络后重试。", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
