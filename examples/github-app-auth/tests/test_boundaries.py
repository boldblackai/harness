"""No AWS/GitHub requests: use disposable files, real Git, and a generated RSA key."""
import contextlib
from concurrent.futures import ThreadPoolExecutor
import copy
import datetime as dt
import io
import json
import os
import pathlib
import stat
import tempfile
import time
import unittest
from unittest import mock

from test_github_app_auth import github_app_auth as auth


POLICY = {"repository_ids": [123], "repositories": ["example/repo"],
          "permissions": {"contents": "write", "pull_requests": "write"},
          "ssm_parameter_prefix": "/example/github"}


def record():
    return {"token": "test-installation-token", "expires_at": "2099-01-01T00:00:00Z",
            "permissions": {**POLICY["permissions"], "metadata": "read"},
            "requested_permissions": POLICY["permissions"], "repository_ids": [123]}


class TemporaryState(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = pathlib.Path(self.temp.name)
        replacements = {"CONFIG_PATH": self.root / "config.json",
                        "IDENTITY_STATE_PATH": self.root / "git-state.json",
                        "CACHE_DIR": self.root / "cache",
                        "TOKEN_PATH": self.root / "cache/token.json",
                        "LOCK_PATH": self.root / "cache/token.lock"}
        for name, value in replacements.items():
            patch = mock.patch.object(auth, name, value)
            patch.start(); self.addCleanup(patch.stop)
        self.policy = copy.deepcopy(POLICY)
        self.write_policy()

    def write_policy(self):
        auth.CONFIG_PATH.write_text(json.dumps(self.policy))


class PolicyTests(TemporaryState):
    def test_empty_or_malformed_policy_fails_closed(self):
        for value in ([], {}, {**POLICY, "repository_ids": []},
                      {**POLICY, "repository_ids": [True]},
                      {**POLICY, "repositories": ["https://github.com/example/repo"]},
                      {**POLICY, "permissions": {"workflows": "write"}},
                      {**POLICY, "permissions": {"contents": {}}},
                      {**POLICY, "ssm_parameter_prefix": "relative/path"}):
            with self.subTest(value=value):
                auth.CONFIG_PATH.write_text(json.dumps(value))
                with self.assertRaises(auth.AuthError):
                    auth._load_policy()

    def test_read_only_repository_policy_is_supported(self):
        self.policy["permissions"] = {"contents": "read"}
        self.write_policy()
        self.assertEqual(auth._load_policy()["permissions"], {"contents": "read"})

    def test_duplicates_rejected(self):
        self.policy["repository_ids"] = [123, 123]
        self.policy["repositories"] = ["example/repo", "example/repo"]
        self.write_policy()
        with self.assertRaises(auth.AuthError):
            auth._load_policy()


class CacheTests(TemporaryState):
    def test_concurrent_callers_mint_once(self):
        def mint(_):
            time.sleep(0.05)
            return record()
        with mock.patch.object(auth, "_mint_token", side_effect=mint) as mint_call, ThreadPoolExecutor(max_workers=6) as pool:
            records = list(pool.map(lambda _: auth._token_record(), range(6)))
        self.assertEqual(mint_call.call_count, 1)
        self.assertTrue(all(item["token"] == records[0]["token"] for item in records))

    def test_cached_token_is_private_and_reused(self):
        with mock.patch.object(auth, "_mint_token", side_effect=lambda _: record()) as mint:
            first = auth._token_record()
            self.assertEqual(auth._token_record(), first)
        mint.assert_called_once()
        self.assertEqual(stat.S_IMODE(auth.CACHE_DIR.stat().st_mode), 0o700)
        self.assertEqual(stat.S_IMODE(auth.TOKEN_PATH.stat().st_mode), 0o600)
        self.assertEqual(stat.S_IMODE(auth.LOCK_PATH.stat().st_mode), 0o600)

    def test_expiring_token_refreshes_before_expiry(self):
        with mock.patch.object(auth, "_mint_token", side_effect=lambda _: record()) as mint:
            data = auth._token_record()
            data["expires_at"] = (dt.datetime.now(dt.timezone.utc) + dt.timedelta(seconds=299)).isoformat()
            auth._write_cached_token(data)
            auth._token_record()
        self.assertEqual(mint.call_count, 2)

    def test_namespace_permissions_and_profile_changes_invalidate_cache(self):
        with mock.patch.object(auth, "_mint_token", side_effect=lambda _: record()) as mint:
            auth._token_record()
            self.policy["ssm_parameter_prefix"] = "/another/app"
            self.write_policy(); auth._token_record()
            self.policy["permissions"] = {"contents": "read"}
            self.write_policy(); auth._token_record()
            with mock.patch.dict(os.environ, {"AWS_PROFILE": "different-profile"}):
                auth._token_record()
        self.assertEqual(mint.call_count, 4)

    def test_unreadable_or_public_cache_is_not_reused(self):
        auth._ensure_cache_dir()
        for value in ("not JSON", "[]", json.dumps(record())):
            auth.TOKEN_PATH.write_text(value)
            auth.TOKEN_PATH.chmod(0o644)
            self.assertIsNone(auth._read_cached_token())

    def test_symlink_cache_directory_is_rejected(self):
        target = self.root / "other"
        target.mkdir()
        auth.CACHE_DIR.symlink_to(target, target_is_directory=True)
        with self.assertRaises(auth.AuthError):
            auth._ensure_cache_dir()

    def test_symlink_token_is_not_read(self):
        auth._ensure_cache_dir()
        target = self.root / "other-token"
        target.write_text(json.dumps(record()))
        auth.TOKEN_PATH.symlink_to(target)
        self.assertIsNone(auth._read_cached_token())


class CredentialTests(TemporaryState):
    def run_credential(self, text):
        output = io.StringIO()
        with mock.patch.object(auth.sys, "stdin", io.StringIO(text)), contextlib.redirect_stdout(output):
            auth._credential("get")
        return output.getvalue()

    def test_only_exact_https_host_and_repository_receive_credentials(self):
        with mock.patch.object(auth, "_token_record", return_value=record()) as token:
            for fields in ("protocol=http\nhost=github.com\npath=example/repo\n",
                           "protocol=https\nhost=github.com.evil.test\npath=example/repo\n",
                           "protocol=https\nhost=github.com\npath=example/other\n",
                           "protocol=https\nhost=github.com\n"):
                self.assertEqual(self.run_credential(fields), "")
            token.assert_not_called()
            result = self.run_credential("protocol=https\nhost=github.com\npath=example/repo.git\n\n")
        self.assertEqual(result, "username=x-access-token\npassword=test-installation-token\n\n")

    def test_child_environment_discards_competing_tokens_and_debugging(self):
        env = {name: "old" for name in ("GH_TOKEN", "GITHUB_TOKEN", "GH_DEBUG", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN")}
        with mock.patch.dict(os.environ, env), mock.patch.object(auth, "_token_record", return_value=record()), \
                mock.patch.object(auth.os, "execve") as execute:
            auth._run_gh(["pr", "list"])
        child = execute.call_args.args[2]
        self.assertEqual(child["GH_TOKEN"], "test-installation-token")
        for key in set(env) - {"GH_TOKEN"}:
            self.assertNotIn(key, child)
        self.assertNotIn("test-installation-token", str(execute.call_args.args[1]))

    def test_auth_git_credential_cannot_bypass_repository_policy(self):
        with self.assertRaises(auth.AuthError):
            auth._run_gh(["auth", "git-credential", "get"])


class GitRestoreTests(TemporaryState):
    def setUp(self):
        super().setUp()
        env = mock.patch.dict(os.environ, {"GIT_CONFIG_GLOBAL": str(self.root / "gitconfig"), "GIT_CONFIG_NOSYSTEM": "1"})
        env.start(); self.addCleanup(env.stop)
        identity = mock.patch.object(auth, "_app_identity", return_value=("test[bot]", "42+test[bot]@users.noreply.github.com"))
        identity.start(); self.addCleanup(identity.stop)

    def test_repeated_setup_and_restore_preserve_all_previous_values(self):
        previous = dict(zip(auth.GIT_KEYS, [["", "custom-helper", ""], ["false"], ["Human"], ["human@example.test"]]))
        for key, values in previous.items():
            auth._set_git_values(key, values)
        with contextlib.redirect_stdout(io.StringIO()):
            auth._configure_git(); auth._configure_git(); auth._restore_git()
        self.assertEqual({key: auth._git_values(key) for key in auth.GIT_KEYS}, previous)

    def test_restore_preserves_later_operator_changes(self):
        with contextlib.redirect_stdout(io.StringIO()):
            auth._configure_git()
            auth._set_git_values("user.name", ["Updated by operator"])
            auth._restore_git()
        self.assertEqual(auth._git_values("user.name"), ["Updated by operator"])
        self.assertEqual(auth._git_values("user.email"), [])

    def test_saved_state_cannot_restore_into_another_global_config(self):
        with contextlib.redirect_stdout(io.StringIO()):
            auth._configure_git()
        with mock.patch.dict(os.environ, {"GIT_CONFIG_GLOBAL": str(self.root / "another-config")}), \
                self.assertRaises(auth.AuthError):
            auth._restore_git()


class MintTests(TemporaryState):
    def test_diagnostic_rejects_mismatched_id_name_pairs(self):
        policy = {**POLICY, "repository_ids": [123, 456], "repositories": ["example/one", "example/two"]}
        response = mock.Mock(status_code=200)
        response.json.return_value = {"total_count": 2, "repositories": [
            {"id": 123, "full_name": "example/two"}, {"id": 456, "full_name": "example/one"}]}
        with mock.patch.object(auth, "_load_policy", return_value=policy), \
                mock.patch.object(auth, "_token_record", return_value=record()), \
                mock.patch.object(auth.requests, "get", return_value=response), self.assertRaises(auth.AuthError):
            auth._diagnose()

    def test_requested_scope_and_redirect_refusal(self):
        response = mock.Mock(status_code=201)
        response.json.return_value = record()
        with mock.patch.object(auth, "_load_app_credentials", return_value=("1", "2", "key")), \
                mock.patch.object(auth, "_app_jwt", return_value="jwt"), \
                mock.patch.object(auth.requests, "post", return_value=response) as post:
            auth._mint_token(POLICY)
        self.assertFalse(post.call_args.kwargs["allow_redirects"])
        self.assertEqual(post.call_args.kwargs["json"], {"repository_ids": [123], "permissions": POLICY["permissions"]})

    def test_broad_missing_malformed_or_expired_token_response_rejected(self):
        for override in ({"permissions": {**POLICY["permissions"], "workflows": "write"}},
                         {"permissions": {"contents": "read"}}, {"permissions": []},
                         {"token": "token\nheader"}, {"expires_at": "2000-01-01T00:00:00Z"},
                         {"expires_at": "2099-01-01T00:00:00"}):
            response = mock.Mock(status_code=201)
            response.json.return_value = {**record(), **override}
            with self.subTest(override=override), \
                    mock.patch.object(auth, "_load_app_credentials", return_value=("1", "2", "key")), \
                    mock.patch.object(auth, "_app_jwt", return_value="jwt"), \
                    mock.patch.object(auth.requests, "post", return_value=response), self.assertRaises(auth.AuthError):
                auth._mint_token(POLICY)

    def test_error_does_not_echo_response_body(self):
        response = mock.Mock(status_code=401, headers={"x-github-request-id": "ABCD:1234"})
        response.json.return_value = {"message": "secret-sentinel"}
        self.assertNotIn("secret-sentinel", str(auth._safe_github_error(response, "token request")))


class SSMAndJWTTests(TemporaryState):
    @classmethod
    def setUpClass(cls):
        cls.key = auth.rsa.generate_private_key(public_exponent=65537, key_size=2048)
        cls.pem = cls.key.private_bytes(
            auth.serialization.Encoding.PEM, auth.serialization.PrivateFormat.PKCS8,
            auth.serialization.NoEncryption()).decode()

    def credentials(self, key=None):
        values = {"GITHUB_APP_ID": "123", "GITHUB_APP_INSTALLATION_ID": "456",
                  "GITHUB_APP_PRIVATE_KEY": self.pem if key is None else key}
        return {"Parameters": [{"Name": POLICY["ssm_parameter_prefix"] + "/" + name, "Value": value}
                               for name, value in values.items()]}

    def test_configured_ssm_names_and_escaped_pem(self):
        with mock.patch.object(auth.boto3, "client") as client:
            client.return_value.get_parameters.return_value = self.credentials(self.pem.replace("\n", "\\n"))
            app, installation, key = auth._load_app_credentials()
        self.assertEqual((app, installation, key), ("123", "456", self.pem))
        params = client.return_value.get_parameters.call_args.kwargs
        self.assertTrue(params["WithDecryption"])
        self.assertEqual(set(params["Names"]), {
            "/example/github/GITHUB_APP_ID", "/example/github/GITHUB_APP_INSTALLATION_ID",
            "/example/github/GITHUB_APP_PRIVATE_KEY"})

    def test_missing_parameters_and_invalid_pem_fail_without_exposing_key(self):
        for response in ({"InvalidParameters": ["key"]}, {"Parameters": []}, self.credentials("secret-sentinel")):
            with mock.patch.object(auth.boto3, "client") as client:
                client.return_value.get_parameters.return_value = response
                with self.assertRaises(auth.AuthError) as error:
                    auth._load_app_credentials()
            self.assertNotIn("secret-sentinel", str(error.exception))

    def test_real_jwt_signature_and_time_window(self):
        with mock.patch.object(auth.time, "time", return_value=1000):
            token = auth._app_jwt("123", self.pem)
        claims = auth.jwt.decode(token, self.key.public_key(), algorithms=["RS256"],
                                 options={"verify_exp": False, "verify_iat": False})
        self.assertEqual(claims, {"iat": 940, "exp": 1540, "iss": "123"})
