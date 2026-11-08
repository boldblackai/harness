from __future__ import annotations

import contextlib
import importlib.machinery
import importlib.util
import io
import json
import pathlib
import unittest
from unittest import mock


HELPER_PATH = (
    pathlib.Path(__file__).resolve().parents[1]
    / "bin"
    / "github-app-auth"
)
LOADER = importlib.machinery.SourceFileLoader("github_app_auth", str(HELPER_PATH))
SPEC = importlib.util.spec_from_loader("github_app_auth", LOADER)
assert SPEC is not None and SPEC.loader is not None
github_app_auth = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(github_app_auth)


class Response:
    status_code = 200
    headers: dict[str, str] = {}

    def json(self) -> dict[str, object]:
        return {
            "total_count": 1,
            "repositories": [{"id": 123, "full_name": "example/repo"}],
        }


class GitHubAppAuthTests(unittest.TestCase):
    def test_auth_status_runs_safe_diagnostic(self) -> None:
        with (
            mock.patch.object(github_app_auth, "_diagnose") as diagnose,
            mock.patch.object(github_app_auth.os, "execve") as execve,
            self.assertRaises(SystemExit) as raised,
        ):
            github_app_auth._run_gh(["auth", "status"])

        self.assertEqual(raised.exception.code, 0)
        diagnose.assert_called_once_with(force_refresh=False)
        execve.assert_not_called()

    def test_main_forwards_option_like_gh_arguments_verbatim(self) -> None:
        with (
            mock.patch.object(
                github_app_auth.sys,
                "argv",
                ["github-app-auth", "gh", "--version"],
            ),
            mock.patch.object(github_app_auth, "_run_gh") as run_gh,
        ):
            github_app_auth.main()

        run_gh.assert_called_once_with(["--version"])

    def test_auth_status_show_token_is_still_safe(self) -> None:
        with (
            mock.patch.object(github_app_auth, "_diagnose") as diagnose,
            mock.patch.object(github_app_auth.os, "execve") as execve,
            self.assertRaises(SystemExit) as raised,
        ):
            github_app_auth._run_gh(["auth", "status", "--show-token"])

        self.assertEqual(raised.exception.code, 0)
        diagnose.assert_called_once_with(force_refresh=False)
        execve.assert_not_called()

    def test_mutating_and_token_export_auth_commands_remain_blocked(self) -> None:
        blocked = ("login", "logout", "refresh", "setup-git", "switch", "token")
        with mock.patch.object(github_app_auth, "_token_record") as token_record:
            for command in blocked:
                with self.subTest(command=command), self.assertRaises(
                    github_app_auth.AuthError
                ):
                    github_app_auth._run_gh(["auth", command])

        token_record.assert_not_called()

    def test_normal_gh_command_uses_token_only_in_child_environment(self) -> None:
        sentinel = "installation-token-sentinel"
        with (
            mock.patch.object(
                github_app_auth, "_token_record", return_value={"token": sentinel}
            ),
            mock.patch.object(github_app_auth.os, "execve") as execve,
        ):
            github_app_auth._run_gh(["pr", "list"])

        executable, arguments, environment = execve.call_args.args
        self.assertEqual(executable, github_app_auth.REAL_GH)
        self.assertEqual(arguments, [github_app_auth.REAL_GH, "pr", "list"])
        self.assertEqual(environment["GH_TOKEN"], sentinel)

    def test_diagnostic_output_never_contains_token(self) -> None:
        sentinel = "installation-token-sentinel"
        policy = {
            "repository_ids": [123],
            "repositories": ["example/repo"],
            "permissions": {"contents": "write", "pull_requests": "write"},
        }
        record = {
            "token": sentinel,
            "expires_at": "2099-01-01T00:00:00Z",
            "permissions": {
                "contents": "write",
                "metadata": "read",
                "pull_requests": "write",
            },
        }
        output = io.StringIO()
        with (
            mock.patch.object(github_app_auth, "_load_policy", return_value=policy),
            mock.patch.object(
                github_app_auth, "_token_record", return_value=record
            ) as token_record,
            mock.patch.object(github_app_auth.requests, "get", return_value=Response()),
            contextlib.redirect_stdout(output),
        ):
            github_app_auth._diagnose(force_refresh=False)

        token_record.assert_called_once_with(force_refresh=False)
        self.assertNotIn(sentinel, output.getvalue())
        self.assertEqual(json.loads(output.getvalue())["authentication"], "ok")


if __name__ == "__main__":
    unittest.main()
