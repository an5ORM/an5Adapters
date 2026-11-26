"""Execute the shared query contract against SQLite through the SQL builder."""
from dataclasses import dataclass
import json
from pathlib import Path
import sqlite3
import sys
from typing import Any, List, Optional
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "python"))
from an5_adapter import create_an5_adapter  # noqa: E402
from base.metadata import set_adapter_metadata  # noqa: E402
from base.sql import _parse_where, _build_having  # noqa: E402

FIXTURES = json.loads((Path(__file__).resolve().parents[1] / "fixtures/query-semantics.json").read_text())


@dataclass
class StringFilter:
    equals: Optional[str] = None
    not_: Optional[str] = None
    contains: Optional[str] = None
    starts_with: Optional[str] = None
    ends_with: Optional[str] = None
    in_: Optional[List[str]] = None
    not_in: Optional[List[str]] = None
    gt: Optional[str] = None
    gte: Optional[str] = None
    lt: Optional[str] = None
    lte: Optional[str] = None
    mode: Optional[str] = None


@dataclass
class IntFilter:
    equals: Optional[int] = None
    not_: Optional[int] = None
    in_: Optional[List[int]] = None
    not_in: Optional[List[int]] = None
    gt: Optional[int] = None
    gte: Optional[int] = None
    lt: Optional[int] = None
    lte: Optional[int] = None


@dataclass
class BoolFilter:
    equals: Optional[bool] = None
    not_: Optional[bool] = None


@dataclass
class DateTimeFilter:
    equals: Optional[str] = None
    not_: Optional[str] = None
    in_: Optional[List[str]] = None
    not_in: Optional[List[str]] = None
    gt: Optional[str] = None
    gte: Optional[str] = None
    lt: Optional[str] = None
    lte: Optional[str] = None


@dataclass
class UserWhereInput:
    AND: Optional[List["UserWhereInput"]] = None
    OR: Optional[List["UserWhereInput"]] = None
    NOT: Optional[Any] = None
    id: Optional[Any] = None
    email: Optional[Any] = None
    is_active: Optional[Any] = None
    score: Optional[Any] = None
    created_at: Optional[Any] = None
    orders: Optional[Any] = None


@dataclass
class UserOrderByInput:
    id: Optional[str] = None
    email: Optional[str] = None
    is_active: Optional[str] = None
    score: Optional[str] = None
    created_at: Optional[str] = None


@dataclass
class UserCreateInput:
    email: str
    id: Optional[str] = None
    is_active: Optional[bool] = None
    score: Optional[int] = None
    created_at: Optional[str] = None


@dataclass
class UserUpdateInput:
    email: Optional[str] = None
    is_active: Optional[bool] = None
    score: Optional[int] = None
    created_at: Optional[str] = None


@dataclass
class UserFindManyArgs:
    where: Optional[UserWhereInput] = None
    order_by: Optional[UserOrderByInput] = None
    take: Optional[int] = None
    skip: int = 0
    select: Optional[Any] = None
    include: Optional[Any] = None


@dataclass
class UserFindFirstArgs:
    where: Optional[UserWhereInput] = None
    order_by: Optional[UserOrderByInput] = None
    select: Optional[Any] = None
    include: Optional[Any] = None


TEST_METADATA = {
    "model_to_table": {"User": "users", "user": "users", "Order": "orders", "order": "orders"},
    "model_fields": {
        "user": [
            {"name": "id", "type": "string", "sql": "TEXT", "isOptional": False, "hasDefault": True, "isId": True},
            {"name": "email", "type": "string", "sql": "TEXT", "isOptional": False, "hasDefault": False, "isId": False},
            {"name": "isActive", "type": "boolean", "sql": "INTEGER", "isOptional": False, "hasDefault": True, "isId": False},
            {"name": "score", "type": "number", "sql": "INTEGER", "isOptional": False, "hasDefault": True, "isId": False},
            {"name": "createdAt", "type": "Date", "sql": "TEXT", "isOptional": False, "hasDefault": True, "isId": False},
        ],
        "order": [
            {"name": "id", "type": "string", "sql": "TEXT", "isOptional": False, "hasDefault": True, "isId": True},
            {"name": "userId", "type": "string", "sql": "TEXT", "isOptional": False, "hasDefault": False, "isId": False},
            {"name": "totalAmount", "type": "number", "sql": "INTEGER", "isOptional": False, "hasDefault": True, "isId": False},
            {"name": "createdAt", "type": "Date", "sql": "TEXT", "isOptional": False, "hasDefault": True, "isId": False},
        ],
    },
    "relation_map": {
        "user": {
            "orders": {
                "modelName": "order",
                "relationType": "many",
                "foreignKey": "userId",
                "localKey": "id",
            }
        },
        "order": {
            "user": {
                "modelName": "user",
                "relationType": "one",
                "foreignKey": "userId",
                "localKey": "id",
            }
        },
    },
}


class QuerySemantics(unittest.TestCase):
    def setUp(self):
        set_adapter_metadata({})

    def tearDown(self):
        set_adapter_metadata({})

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

    def test_relation_filters_and_to_one_generated_shape(self):
        set_adapter_metadata(TEST_METADATA)
        db = create_an5_adapter("sqlite:///:memory:")
        try:
            db.execute("CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT, isActive INTEGER, score INTEGER, createdAt TEXT)")
            db.execute("CREATE TABLE orders (id TEXT PRIMARY KEY, userId TEXT, totalAmount INTEGER, createdAt TEXT)")
            db.user.create({"id": "u1", "email": "alice@example.com", "isActive": 1, "score": 100, "createdAt": "2026-01-01"})
            db.user.create({"id": "u2", "email": "bob@example.com", "isActive": 0, "score": 200, "createdAt": "2026-01-02"})
            db.user.create({"id": "u3", "email": "carol@example.com", "isActive": 1, "score": 300, "createdAt": "2026-01-03"})
            db.order.create({"id": "o1", "userId": "u1", "totalAmount": 100, "createdAt": "2026-01-01"})
            db.order.create({"id": "o2", "userId": "u1", "totalAmount": 250, "createdAt": "2026-01-02"})
            db.order.create({"id": "o3", "userId": "u2", "totalAmount": 50, "createdAt": "2026-01-03"})
            db.order.create({"id": "o4", "userId": "", "totalAmount": 75, "createdAt": "2026-01-04"})

            # to-many: some / none / every and nested not inside relation filter
            self.assertEqual(
                [u["id"] for u in db.user.find_many(where={"orders": {"some": {"total_amount": {"gte": 200}}}}, order_by={"id": "asc"})],
                ["u1"],
            )
            self.assertEqual(
                [u["id"] for u in db.user.find_many(where={"orders": {"none": {"total_amount": {"gte": 200}}}}, order_by={"id": "asc"})],
                ["u2", "u3"],
            )
            self.assertEqual(
                [u["id"] for u in db.user.find_many(where={"orders": {"some": {"total_amount": {"not": {"lt": 200}}}}}, order_by={"id": "asc"})],
                ["u1"],
            )

            # to-one using generated RELATION_MAP shape (foreignKey="userId", localKey="id")
            self.assertEqual(
                [o["id"] for o in db.order.find_many(where={"user": {"is": {"email": "alice@example.com"}}}, order_by={"id": "asc"})],
                ["o1", "o2"],
            )
            self.assertEqual(
                [o["id"] for o in db.order.find_many(where={"user": {"is_not": {"email": "alice@example.com"}}}, order_by={"id": "asc"})],
                ["o3", "o4"],
            )
            self.assertEqual(
                [o["id"] for o in db.order.find_many(where={"user": {"is": None}}, order_by={"id": "asc"})],
                ["o4"],
            )
            self.assertEqual(
                [o["id"] for o in db.order.find_many(where={"user": {"isNot": None}}, order_by={"id": "asc"})],
                ["o1", "o2", "o3"],
            )
        finally:
            db.close()

    def test_snake_case_keys_and_typed_dataclasses(self):
        set_adapter_metadata(TEST_METADATA)
        db = create_an5_adapter("sqlite:///:memory:")
        try:
            db.execute("CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT, isActive INTEGER, score INTEGER, createdAt TEXT)")
            db.execute("CREATE TABLE orders (id TEXT PRIMARY KEY, userId TEXT, totalAmount INTEGER, createdAt TEXT)")

            # Create / update / update_many using dataclasses and snake_case keys
            db.user.create(UserCreateInput(id="u1", email="alice@example.com", is_active=True, score=10, created_at="2026-01-01"))
            db.user.create({"id": "u2", "email": "bob@example.com", "is_active": False, "score": 20, "created_at": "2026-01-02"})
            db.user.create({"id": "u3", "email": "amy@other.com", "is_active": True, "score": 30, "created_at": "2026-01-03"})

            db.user.update(where={"id": "u2"}, data=UserUpdateInput(is_active=True, score=25))
            self.assertEqual(db.user.find_first(where={"id": "u2"})["score"], 25)

            res = db.user.update_many(where={"is_active": True}, data={"created_at": "2026-02-01"})
            self.assertEqual(res["count"], 3)

            # Snake-case dict keys in where, order_by, select
            rows = db.user.find_many(
                where={"is_active": True, "created_at": "2026-02-01"},
                order_by={"created_at": "asc", "score": "desc"},
                select=["id", "created_at"],
            )
            self.assertEqual([r["id"] for r in rows], ["u3", "u2", "u1"])
            self.assertEqual(set(rows[0].keys()), {"id", "createdAt"})

            # Typed dataclasses: StringFilter, IntFilter, BoolFilter, DateTimeFilter, AND/OR/NOT, empty default filter
            found = db.user.find_many(
                UserFindManyArgs(
                    where=UserWhereInput(
                        AND=[
                            UserWhereInput(email=StringFilter(starts_with="a", ends_with="example.com", not_="other")),
                            UserWhereInput(score=IntFilter(in_=[10, 25, 30], not_in=[30])),
                        ],
                        OR=[
                            UserWhereInput(is_active=BoolFilter(equals=True)),
                            UserWhereInput(created_at=DateTimeFilter(equals="2026-02-01")),
                        ],
                        NOT=[UserWhereInput(email=StringFilter(contains="other"))],
                        created_at=DateTimeFilter(),  # empty default filter must be ignored
                    ),
                    order_by=UserOrderByInput(score="desc"),
                    take=5,
                    skip=0,
                    select={"id": True, "is_active": True},
                )
            )
            self.assertEqual(found, [{"id": "u1", "isActive": 1}])

            first = db.user.find_first(
                UserFindFirstArgs(
                    where=UserWhereInput(email=StringFilter(contains="example.com")),
                    order_by=UserOrderByInput(score="desc"),
                )
            )
            self.assertEqual(first["id"], "u2")

            # aggregate / group_by with snake_case field keys
            db.order.create({"id": "o1", "user_id": "u1", "total_amount": 40, "created_at": "2026-01-01"})
            db.order.create({"id": "o2", "user_id": "u1", "total_amount": 60, "created_at": "2026-01-02"})
            agg = db.order.aggregate(where={"user_id": "u1"}, _sum={"total_amount": True}, _count={"_all": True, "created_at": True})
            self.assertEqual(agg["_sum"]["totalAmount"], 100.0)
            self.assertEqual(agg["_count"]["_all"], 2)
            self.assertEqual(agg["_count"]["createdAt"], 2)

            grouped = db.order.group_by(by="user_id", _sum={"total_amount": True}, order_by={"user_id": "asc"})
            self.assertEqual(grouped[0]["userId"], "u1")
            self.assertEqual(grouped[0]["_sum"]["totalAmount"], 100.0)
        finally:
            db.close()

    def test_rejects_unknown_fields_and_operators(self):
        set_adapter_metadata(TEST_METADATA)
        with self.assertRaises(ValueError):
            _parse_where("user", {"unknown_column": "x"}, {}, "sqlite")
        with self.assertRaises(ValueError):
            _parse_where("user", {"email": {"badOp": "x"}}, {}, "sqlite")
        with self.assertRaises(ValueError):
            _parse_where("user", {"orders": {"is": {"totalAmount": 10}}}, {}, "sqlite")
        with self.assertRaises(ValueError):
            _parse_where("order", {"user": {"some": {"email": "a@b.com"}}}, {}, "sqlite")
        with self.assertRaises(ValueError):
            _parse_where("user", {"orders": {"bogus": {}}}, {}, "sqlite")

        # Unregistered relation filter when relation_map is cleared must be rejected when model_fields exist
        set_adapter_metadata({"model_to_table": TEST_METADATA["model_to_table"], "model_fields": TEST_METADATA["model_fields"], "relation_map": {}})
        with self.assertRaises(ValueError):
            _parse_where("user", {"orders": {"some": {"totalAmount": {"gte": 10}}}}, {}, "sqlite")

    def test_mode_insensitive_and_dialect_sql(self):
        set_adapter_metadata(TEST_METADATA)
        pg_params = {}
        pg_sql = _parse_where("user", {"email": {"contains": "Alice", "mode": "insensitive"}}, pg_params, "postgres")
        self.assertEqual(pg_sql, '"email" ILIKE %s')
        self.assertEqual(list(pg_params.values()), ["%Alice%"])

        sqlite_params = {}
        sqlite_sql = _parse_where("user", {"email": StringFilter(in_=["ALICE@EXAMPLE.COM", "BOB@EXAMPLE.COM"], mode="insensitive")}, sqlite_params, "sqlite")
        self.assertIn('LOWER("email") IN (LOWER(?), LOWER(?))', sqlite_sql)
        self.assertEqual(list(sqlite_params.values()), ["ALICE@EXAMPLE.COM", "BOB@EXAMPLE.COM"])

        mssql_params = {}
        mssql_sql = _parse_where("user", {"email": {"contains": "Alice", "mode": "insensitive"}}, mssql_params, "mssql")
        self.assertEqual(mssql_sql, "LOWER([email]) LIKE LOWER(?)")
        self.assertEqual(list(mssql_params.values()), ["%Alice%"])

        db = create_an5_adapter("sqlite::memory:")
        try:
            db.execute_raw("CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT NOT NULL, isActive INTEGER, score INTEGER, createdAt TEXT)")
            db.user.create({"id": "u1", "email": "Alice@Example.com", "isActive": True, "score": 10, "createdAt": "2026-01-01"})
            db.user.create({"id": "u2", "email": "bob@example.com", "isActive": True, "score": 20, "createdAt": "2026-01-02"})

            rows = db.user.find_many(where=UserWhereInput(email=StringFilter(contains="alice", mode="insensitive")))
            self.assertEqual([r["id"] for r in rows], ["u1"])

            rows_not = db.user.find_many(where={"email": {"not": "ALICE@EXAMPLE.COM", "mode": "insensitive"}})
            self.assertEqual([r["id"] for r in rows_not], ["u2"])
        finally:
            db.close()

    def test_group_by_having_per_field_count_and_offset_pagination(self):
        set_adapter_metadata(TEST_METADATA)
        db = create_an5_adapter("sqlite::memory:")
        try:
            db.execute_raw("CREATE TABLE orders (id TEXT PRIMARY KEY, userId TEXT NOT NULL, totalAmount INTEGER, createdAt TEXT)")
            db.order.create({"id": "o1", "user_id": "u1", "total_amount": 40, "created_at": "2026-01-01"})
            db.order.create({"id": "o2", "user_id": "u1", "total_amount": 60, "created_at": None})
            db.order.create({"id": "o3", "user_id": "u2", "total_amount": 25, "created_at": "2026-01-03"})
            db.order.create({"id": "o4", "user_id": "u3", "total_amount": 200, "created_at": "2026-01-04"})

            agg = db.order.aggregate(where={"user_id": "u1"}, _count={"_all": True, "created_at": True}, _sum={"total_amount": True})
            self.assertEqual(agg["_count"], {"_all": 2, "createdAt": 1})

            grouped = db.order.group_by(
                by="user_id",
                where={"total_amount": {"gte": 20}},
                having={
                    "OR": [
                        {"_count": {"_all": {"gte": 2}}, "_sum": {"total_amount": {"gte": 100}}},
                        {"user_id": {"in": ["u3"]}},
                    ]
                },
                order_by={"user_id": "asc"},
                _count={"_all": True, "created_at": True},
                _sum={"total_amount": True},
            )
            self.assertEqual([g["userId"] for g in grouped], ["u1", "u3"])
            self.assertEqual(grouped[0]["_count"], {"_all": 2, "createdAt": 1})
            self.assertEqual(grouped[0]["_sum"]["totalAmount"], 100.0)

            paged = db.order.group_by(
                by="user_id",
                having={"_sum": {"total_amount": {"gte": 25}}},
                order_by={"user_id": "asc"},
                skip=1,
            )
            self.assertEqual([g["userId"] for g in paged], ["u2", "u3"])
        finally:
            db.close()

    def test_having_and_operand_validation(self):
        set_adapter_metadata(TEST_METADATA)
        with self.assertRaises(ValueError):
            _parse_where("user", {"email": {"contains": "a", "mode": "fuzzy"}}, {}, "sqlite")
        with self.assertRaises(ValueError):
            _parse_where("user", {"email": ["a", "b"]}, {}, "sqlite")
        with self.assertRaises(ValueError):
            _parse_where("user", {"email": {"contains": 123}}, {}, "sqlite")
        with self.assertRaises(ValueError):
            _parse_where("user", {"score": {"gt": None}}, {}, "sqlite")
        with self.assertRaises(ValueError):
            _parse_where("user", {"email": {"not": ["a"]}}, {}, "sqlite")
        with self.assertRaises(ValueError):
            _parse_where("user", {"email": {"in": "abc"}}, {}, "sqlite")
        with self.assertRaises(ValueError):
            _parse_where("user", {"OR": "not-a-list"}, {}, "sqlite")
        with self.assertRaises(ValueError):
            _build_having({"total_amount": {"gt": 10}}, {}, "sqlite", by_fields=["userId"], model_name="order")
        with self.assertRaises(ValueError):
            _build_having({"_sum": {"_all": {"gt": 10}}}, {}, "sqlite", by_fields=["userId"], model_name="order")
        with self.assertRaises(ValueError):
            _build_having({"_unknown": {"total_amount": {"gt": 1}}}, {}, "sqlite", by_fields=["userId"], model_name="order")
        with self.assertRaises(ValueError):
            _build_having({"_sum": {"missing_field": {"gt": 1}}}, {}, "sqlite", by_fields=["userId"], model_name="order")


if __name__ == "__main__":
    unittest.main()
