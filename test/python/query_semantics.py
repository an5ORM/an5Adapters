"""Execute the shared query contract against SQLite through the SQL builder."""
import json
from pathlib import Path
import sqlite3
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "python"))
from base.sql import _parse_where

FIXTURES = json.loads((Path(__file__).resolve().parents[1] / "fixtures/query-semantics.json").read_text())

class QuerySemantics(unittest.TestCase):
    def test_shared_contract(self):
        with sqlite3.connect(":memory:") as db:
            db.execute("CREATE TABLE users (id INTEGER, score INTEGER)")
            db.executemany("INSERT INTO users VALUES (?, ?)", [(r["id"], r["score"]) for r in FIXTURES["rows"]])
            for case in FIXTURES["cases"]:
                with self.subTest(case=case["name"]):
                    params = {}
                    clause = _parse_where("User", case["where"], params, "sqlite")
                    query = "SELECT id FROM users" + (" WHERE " + clause if clause else "") + " ORDER BY id"
                    ids = [r[0] for r in db.execute(query, list(params.values()))]
                    self.assertEqual(ids, case["ids"])

if __name__ == "__main__":
    unittest.main()
