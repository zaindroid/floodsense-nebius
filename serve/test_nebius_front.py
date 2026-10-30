"""The front door's own pieces: the login, and the VM controls against a fake VM."""

from __future__ import annotations

import asyncio
import base64
import importlib
import os
import sys
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from fastapi import FastAPI  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402


def basic(user: str, password: str) -> dict[str, str]:
    return {"authorization": "Basic " + base64.b64encode(f"{user}:{password}".encode()).decode()}


class LoginTest(unittest.TestCase):
    def setUp(self) -> None:
        os.environ["JUDGE_PASSWORD"] = "s3cret"
        from serve.login import Login

        inner = FastAPI()
        inner.get("/health")(lambda: {"ok": True})
        inner.get("/")(lambda: {"ok": True})
        inner.get("/nebius/api/status")(lambda: {"ok": True})
        inner.post("/nebius/api/start")(lambda: {"ok": True})
        inner.get("/thing")(lambda: {"ok": True})
        self.c = TestClient(Login(inner))

    def tearDown(self) -> None:
        os.environ.pop("JUDGE_PASSWORD", None)

    def test_the_demo_needs_the_judge_login(self) -> None:
        self.assertEqual(self.c.get("/thing").status_code, 401)
        self.assertEqual(self.c.get("/thing", headers=basic("judge", "wrong")).status_code, 401)
        self.assertEqual(self.c.get("/thing", headers=basic("judge", "s3cret")).status_code, 200)

    def test_platform_checks_stay_open(self) -> None:
        self.assertEqual(self.c.get("/health").status_code, 200)

    def test_the_entry_page_and_vm_status_are_public_but_starting_is_not(self) -> None:
        self.assertEqual(self.c.get("/").status_code, 200)
        self.assertEqual(self.c.get("/nebius/api/status").status_code, 200)
        self.assertEqual(self.c.post("/nebius/api/start").status_code, 401)

    def test_a_malformed_login_is_refused_not_a_crash(self) -> None:
        for header in ("Basic !!!not-base64", "Bearer x", "Basic " + base64.b64encode("jüdge:pässwort".encode()).decode()):
            self.assertEqual(self.c.get("/thing", headers={"authorization": header}).status_code, 401)


class FakeVm:
    def __init__(self, state: str) -> None:
        self.state = state
        self.calls: list[str] = []

    def instance(self):
        nic = SimpleNamespace(public_ip_address=SimpleNamespace(address="213.239.171.128/32"))
        return SimpleNamespace(status=SimpleNamespace(state=SimpleNamespace(name=self.state), network_interfaces=[nic]))


class Service:
    def __init__(self, vm: FakeVm) -> None:
        self.vm = vm

    async def start(self, _req):
        self.vm.calls.append("start")
        self.vm.state = "STARTING"

    async def stop(self, _req):
        self.vm.calls.append("stop")
        self.vm.state = "STOPPING"


def load(configured: bool):
    env = {"NEBIUS_DEMO_URL": "https://213-239-171-128.sslip.io", "NEBIUS_AUTO_STOP_MIN": "120"}
    if configured:
        env |= {"NEBIUS_INSTANCE_ID": "computeinstance-x", "NEBIUS_SA_ID": "sa", "NEBIUS_SA_PUBLIC_KEY_ID": "pk", "NEBIUS_SA_PRIVATE_KEY": "pem"}
    with mock.patch.dict(os.environ, env, clear=False):
        for k in ("NEBIUS_INSTANCE_ID", "NEBIUS_SA_ID", "NEBIUS_SA_PUBLIC_KEY_ID", "NEBIUS_SA_PRIVATE_KEY", "NEBIUS_SA_CREDENTIALS"):
            if not configured:
                os.environ.pop(k, None)
        import serve.nebius as n

        n = importlib.reload(n)
    return n


class CredentialsTest(unittest.TestCase):
    def test_a_base64_key_reaches_the_sdk_intact(self) -> None:
        pem = "-----BEGIN PRIVATE KEY-----\nAAAA+/==\nBBBB\n-----END PRIVATE KEY-----"
        env = {"NEBIUS_SA_ID": "sa", "NEBIUS_SA_PUBLIC_KEY_ID": "pk", "NEBIUS_SA_PRIVATE_KEY_B64": base64.b64encode(pem.encode()).decode()}
        with mock.patch.dict(os.environ, env):
            os.environ.pop("NEBIUS_SA_CREDENTIALS", None)
            import serve.nebius as n

            creds = importlib.reload(n)._credentials()
        self.assertEqual(Path(creds["service_account_private_key_file_name"]).read_text(), pem + "\n")


class ControlsTest(unittest.TestCase):
    def test_unconfigured_controls_say_so(self) -> None:
        n = load(configured=False)
        c = TestClient(n.app)
        self.assertEqual(c.get("/").status_code, 200)
        self.assertEqual(c.get("/api/status").json()["state"], "NOT_CONFIGURED")
        self.assertEqual(c.post("/api/start").status_code, 503)

    def _wired(self, state: str):
        n = load(configured=True)
        vm = FakeVm(state)

        async def instance():
            return vm.instance()

        async def instances():
            return Service(vm)

        async def answers():
            return vm.state == "RUNNING"

        patches = [mock.patch.object(n, "_instance", instance), mock.patch.object(n, "_instances", instances), mock.patch.object(n, "_demo_answers", answers), mock.patch.object(n, "configured", lambda: True)]
        for p in patches:
            p.start()
            self.addCleanup(p.stop)
        return n, vm, TestClient(n.app)

    def test_start_wakes_a_sleeping_vm_and_sets_its_bedtime(self) -> None:
        n, vm, c = self._wired("STOPPED")
        r = c.post("/api/start").json()
        self.assertTrue(r["requested"])
        self.assertEqual(vm.calls, ["start"])
        self.assertIsNotNone(r["stops_at"])

    def test_the_start_link_starts_the_vm_and_returns_to_the_entry_page(self) -> None:
        n, vm, c = self._wired("STOPPED")
        r = c.get("/start", follow_redirects=False)
        self.assertEqual(r.status_code, 303)
        self.assertEqual(r.headers["location"], "/")
        self.assertEqual(vm.calls, ["start"])

    def test_start_on_a_running_vm_does_not_start_it_again(self) -> None:
        n, vm, c = self._wired("RUNNING")
        self.assertFalse(c.post("/api/start").json()["requested"])
        self.assertEqual(vm.calls, [])

    def test_status_reports_ready_and_the_address_check(self) -> None:
        n, vm, c = self._wired("RUNNING")
        s = c.get("/api/status").json()
        self.assertTrue(s["ready"])
        self.assertTrue(s["ip_matches_url"])

    def test_the_watcher_stops_the_vm_at_its_deadline(self) -> None:
        n, vm, c = self._wired("RUNNING")
        n._stop_at = time.time() - 1

        async def one_round():
            with mock.patch.object(n.asyncio, "sleep", mock.AsyncMock(side_effect=[None, asyncio.CancelledError()])):
                try:
                    await n._watch()
                except asyncio.CancelledError:
                    pass

        asyncio.run(one_round())
        self.assertEqual(vm.calls, ["stop"])

    def test_the_watcher_gives_an_unscheduled_running_vm_a_deadline(self) -> None:
        n, vm, c = self._wired("RUNNING")
        n._stop_at = None

        async def one_round():
            with mock.patch.object(n.asyncio, "sleep", mock.AsyncMock(side_effect=[None, asyncio.CancelledError()])):
                try:
                    await n._watch()
                except asyncio.CancelledError:
                    pass

        asyncio.run(one_round())
        self.assertEqual(vm.calls, [])
        self.assertGreater(n._stop_at, time.time() + 60 * 60)


if __name__ == "__main__":
    unittest.main()
