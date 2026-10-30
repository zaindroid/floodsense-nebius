"""River-history demo memories: every number is in the cited passage, every doc_id in the manifest."""

from __future__ import annotations

import contextlib
import io
import re
import sys
import unittest
from pathlib import Path

import httpx

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "api"))
sys.path.insert(0, str(ROOT / "scripts"))

from app import demo_seed  # noqa: E402

_NUMBER = re.compile(r"\d+(?:[.,]\d+)*")


def _manifest() -> dict[str, dict]:
    """doc_id -> entry, read with the corpus parser when it imports, else a line scan."""
    text = (ROOT / "corpus" / "manifest.yaml").read_text(encoding="utf-8")
    try:
        import rag_corpus

        return {str(e["doc_id"]): e for e in rag_corpus.parse_manifest(text)}
    except ImportError:  # pragma: no cover - scripts/ is in the repo
        out: dict[str, dict] = {}
        current = None
        for line in text.splitlines():
            if line.startswith("- doc_id: "):
                current = line.split(": ", 1)[1].strip()
                out[current] = {"doc_id": current}
            elif current and line.startswith("  ") and ": " in line:
                key, value = line.strip().split(": ", 1)
                out[current][key] = value.strip('"')
        return out


def _paragraph(path: Path, section: int, paragraph: int) -> str:
    """The paragraph rag_ingest stores as page=section, paragraph=paragraph."""
    from rag_ingest import sections_from_html

    sections = sections_from_html(path.read_text(encoding="utf-8"))
    _heading, paragraphs = sections[section - 1]
    return paragraphs[paragraph - 1]


class HistorySeedTest(unittest.TestCase):
    maxDiff = None

    def setUp(self) -> None:
        self.manifest = _manifest()
        self.seeds = [s for s in demo_seed.SEEDS if s["run_id"].startswith("demo-seed-history-")]

    def test_there_are_history_seeds_and_they_are_labelled(self) -> None:
        self.assertGreaterEqual(sum(len(s["claims"]) for s in self.seeds), 50)
        for seed in self.seeds:
            self.assertIn(seed["event_id"], ("LIVE-EU", "EMSR773"))
            ids = [c["claim_id"] for c in seed["claims"]]
            self.assertEqual(len(ids), len(set(ids)), seed["run_id"])
            for claim in seed["claims"]:
                self.assertIn(demo_seed.REVIEWER, claim["entities"])

    def test_every_doc_id_is_in_the_manifest_with_its_url(self) -> None:
        for doc_id, url in demo_seed.HISTORY_URLS.items():
            self.assertIn(doc_id, self.manifest)
            self.assertEqual(self.manifest[doc_id]["url"], url)
        for _slug, _event, _q, items in demo_seed.HISTORY:
            for doc_id, *_rest in items:
                self.assertIn(doc_id, self.manifest)

    def test_every_number_is_in_the_cited_passage(self) -> None:
        missing = []
        for slug, _event, _q, items in demo_seed.HISTORY:
            for doc_id, section, paragraph, _entities, finding in items:
                path = ROOT / "corpus" / str(self.manifest[doc_id]["path"])
                passage = _paragraph(path, section, paragraph)
                # One exception: the event year of an event article (manifest `year`,
                # also in its title and doc_id) may name the event; every other
                # number, including any other year, must be in the paragraph.
                event_year = str(self.manifest[doc_id].get("year"))
                title = str(self.manifest[doc_id]["title"])
                for number in _NUMBER.findall(finding):
                    if number == event_year and title.startswith(event_year):
                        continue
                    if number not in passage:
                        missing.append(f"{slug}: {number} not in {doc_id} s{section} p{paragraph}")
        self.assertEqual(missing, [])

    def test_text_carries_the_citation(self) -> None:
        for seed in self.seeds:
            for claim in seed["claims"]:
                self.assertRegex(
                    claim["text"],
                    r"\[doc wiki-[a-z0-9-]+, section \d+, paragraph \d+, https://en\.wikipedia\.org/",
                )

    def test_seeding_twice_stores_nothing_twice(self) -> None:
        stored: dict[tuple[str, str], int] = {}

        def handler(request: httpx.Request) -> httpx.Response:
            import json

            body = json.loads(request.content)
            new, again = [], []
            for c in body["claims"]:
                key = (body["run_id"], c["claim_id"])
                (again if key in stored else new).append({"claim_id": c["claim_id"]})
                stored.setdefault(key, 1)
            return httpx.Response(200, json={"stored": new, "already_stored": again})

        transport = httpx.MockTransport(handler)
        with contextlib.redirect_stdout(io.StringIO()):
            first = demo_seed.seed_memory("http://engines", transport=transport)
            second = demo_seed.seed_memory("http://engines", transport=transport)
        self.assertEqual(first, sum(len(s["claims"]) for s in demo_seed.SEEDS))
        self.assertEqual(second, 0)


if __name__ == "__main__":
    unittest.main()
