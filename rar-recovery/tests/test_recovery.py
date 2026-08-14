"""压缩包密码恢复的单元/集成测试。

用极小候选集，秒级完成。缺工具的格式自动跳过。
从仓库根或 rar-recovery 目录运行：
    python3 -m pytest rar-recovery/tests -q      # 若装了 pytest
    python3 rar-recovery/tests/test_recovery.py  # 直接跑（内置 runner）
"""
from __future__ import annotations

import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from recovery import detect, build_engine, Options
from recovery.engines import NotEncrypted, EngineError
from recovery.candidates import iter_candidates, estimate_total
from recovery.job import JobManager
import tests.make_fixtures as fx  # noqa: E402

PW = fx.PW


def wait(job, timeout=60):
    import time
    t0 = time.time()
    while time.time() - t0 < timeout:
        s = job.snapshot()
        if s["status"] not in ("queued", "running", "extracting"):
            return s
        time.sleep(0.05)
    job.cancel()
    return job.snapshot()


class TestDetect(unittest.TestCase):
    def test_magic_bytes(self):
        d = tempfile.mkdtemp()
        z = fx.make_plain_zip(d)
        if z:
            self.assertEqual(detect(z).kind, "zip")
        # 伪造 RAR5 / RAR4 / 7z 头部
        for magic, ver in [(b"\x52\x61\x72\x21\x1a\x07\x01\x00", 5),
                           (b"\x52\x61\x72\x21\x1a\x07\x00", 4)]:
            p = os.path.join(d, f"fake{ver}.rar")
            with open(p, "wb") as f:
                f.write(magic + b"\x00" * 20)
            info = detect(p)
            self.assertEqual(info.kind, "rar")
            self.assertEqual(info.rar_version, ver)


class TestCandidates(unittest.TestCase):
    def test_order_and_dedup(self):
        opts = Options(strategy="custom", extra_passwords=["myguess", "myguess"],
                       include_dates=False, digits_max=2, wordcombos=False)
        got = list(iter_candidates(opts))
        self.assertEqual(got[0], "myguess")               # 用户猜测最优先
        self.assertEqual(got.count("myguess"), 1)         # 去重
        self.assertIn("00", got)                          # 2 位数字
        self.assertIn("99", got)

    def test_estimate_positive(self):
        self.assertGreater(estimate_total(Options(strategy="fast")), 1000)


class _EngineCase:
    """各格式共用的引擎断言。"""
    def _check_engine(self, path):
        info = detect(path)
        try:
            eng = build_engine(info)
        except EngineError as e:
            self.skipTest(f"缺少工具：{e}")
        # 正确密码 True，错误密码 False（核心：不误报）
        self.assertTrue(eng.test(PW), "正确密码应判为 True")
        self.assertFalse(eng.test("definitely_wrong_" + "z" * 10), "错误密码应判为 False")
        # 自检应通过（加密包）
        eng.self_test()

    def _check_found(self, path):
        opts = Options(strategy="custom", extra_passwords=["nope1", "nope2", PW],
                       include_dates=False, digits_max=0, wordcombos=False)
        job = JobManager().start(path, opts, auto_extract=True)
        s = wait(job)
        self.assertEqual(s["status"], "found")
        self.assertEqual(s["password"], PW)
        self.assertTrue(s["extracted_to"] and os.path.isdir(s["extracted_to"]))
        self.assertGreaterEqual(len(s["extracted_files"]), 1)

    def _check_exhausted(self, path):
        # 候选集不含真实密码 -> 必须报 exhausted，绝不 found（关掉内置字典）
        opts = Options(strategy="custom", extra_passwords=["nope1", "nope2", "nope3"],
                       use_common=False, include_dates=False, digits_max=0, wordcombos=False)
        job = JobManager().start(path, opts, auto_extract=False)
        s = wait(job)
        self.assertEqual(s["status"], "exhausted")
        self.assertIsNone(s["password"])


class TestZipCrypto(unittest.TestCase, _EngineCase):
    @classmethod
    def setUpClass(cls):
        cls.d = tempfile.mkdtemp()
        cls.path = fx.make_zipcrypto(cls.d)
        if not cls.path:
            raise unittest.SkipTest("无 zip 命令")

    def test_engine(self): self._check_engine(self.path)
    def test_found(self): self._check_found(self.path)
    def test_exhausted(self): self._check_exhausted(self.path)


class TestAesZip(unittest.TestCase, _EngineCase):
    @classmethod
    def setUpClass(cls):
        cls.d = tempfile.mkdtemp()
        cls.path = fx.make_aes_zip(cls.d)
        if not cls.path:
            raise unittest.SkipTest("无 pyzipper")

    def test_engine(self): self._check_engine(self.path)
    def test_found(self): self._check_found(self.path)
    def test_exhausted(self): self._check_exhausted(self.path)


class TestRar(unittest.TestCase, _EngineCase):
    @classmethod
    def setUpClass(cls):
        cls.d = tempfile.mkdtemp()
        cls.path = fx.make_rar(cls.d)
        if not cls.path:
            raise unittest.SkipTest("无 rar 命令（无法造测试包）")

    def test_engine(self): self._check_engine(self.path)
    def test_found(self): self._check_found(self.path)
    def test_exhausted(self): self._check_exhausted(self.path)


class TestNotEncrypted(unittest.TestCase):
    def test_plain_zip_selftest(self):
        d = tempfile.mkdtemp()
        p = fx.make_plain_zip(d)
        if not p:
            self.skipTest("无 zip 命令")
        self.assertFalse(detect(p).encrypted)
        eng = build_engine(detect(p))
        with self.assertRaises(NotEncrypted):
            eng.self_test()


if __name__ == "__main__":
    unittest.main(verbosity=2)
