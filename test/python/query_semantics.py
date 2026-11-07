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

    def test_relation_filters(self):
        from base.metadata import set_adapter_metadata
        set_adapter_metadata({
            "model_to_table": {"User": "users", "Order": "orders"},
            "relation_map": {
                "User": {
                    "orders": {
                        "modelName": "Order",
                        "relationType": "many",
                        "foreignKey": "userId",
                        "localKey": "id",
                    }
                }
            }
        })
        with sqlite3.connect(":memory:") as db:
            db.execute("CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)")
            db.execute("CREATE TABLE orders (id INTEGER PRIMARY KEY, userId INTEGER, total INTEGER)")
            db.executemany("INSERT INTO users VALUES (?, ?)", [(1, "Alice"), (2, "Bob")])
            db.executemany("INSERT INTO orders VALUES (?, ?, ?)", [(10, 1, 100), (20, 1, 200), (30, 2, 50)])

            # some total >= 150 -> Alice only
            params = {}
            clause = _parse_where("User", {"orders": {"some": {"total": {"gte": 150}}}}, params, "sqlite")
            query = f"SELECT id FROM users WHERE {clause} ORDER BY id"
            ids = [r[0] for r in db.execute(query, list(params.values()))]
            self.assertEqual(ids, [1])

            # none total >= 150 -> Bob only
            params = {}
            clause = _parse_where("User", {"orders": {"none": {"total": {"gte": 150}}}}, params, "sqlite")
            query = f"SELECT id FROM users WHERE {clause} ORDER BY id"
            ids = [r[0] for r in db.execute(query, list(params.values()))]
            self.assertEqual(ids, [2])

if __name__ == "__main__":
    unittest.main()
