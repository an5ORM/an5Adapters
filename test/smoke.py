import os
import sys

ROOT = os.path.dirname(os.path.dirname(__file__))
sys.path.insert(0, os.path.join(ROOT, 'python'))

from base.metadata import set_adapter_metadata
from base.sql import _resolve_table
from table_client import AdapterTableClient

assert os.path.exists(os.path.join(ROOT, 'python')), 'Expected python adapter directory'
assert os.path.exists(os.path.join(ROOT, 'typescript')), 'Expected typescript adapter directory'
assert os.path.exists(os.path.join(ROOT, 'dotnet')), 'Expected dotnet adapter directory'

set_adapter_metadata({
    'model_to_table': {'backgroundJob': '[dbo].[background_jobs]'},
    'model_fields': {'backgroundJob': {'id': {'type': 'string'}}},
})
assert _resolve_table('backgroundJob') == '[dbo].[background_jobs]'

set_adapter_metadata({
    'model_to_table': {'lLMProvider': '[dbo].[llm_providers]'},
    'model_fields': {
        'lLMProvider': [
            {'name': 'id', 'type': 'string', 'isId': False},
            {'name': 'provider', 'type': 'string', 'isId': False},
            {'name': 'apiKey', 'type': 'string?', 'isId': False},
        ]
    },
})

class FakeAdapter:
    def __init__(self, dialect):
        self._dialect = dialect
        self.query = None

    def exec(self, query, params=None):
        self.query = query
        return []

    def execute(self, query, params=None):
        self.query = query
        return 1

mssql = FakeAdapter('mssql')
AdapterTableClient(mssql, 'backgroundJob').find_many(order_by={'createdAt': 'desc'}, take=25, skip=0)
assert 'DESC OFFSET 0 ROWS FETCH NEXT 25 ROWS ONLY' in mssql.query
assert 'DESCORDER' not in mssql.query
assert mssql.query.count('ORDER BY') == 1

postgres = FakeAdapter('postgres')
AdapterTableClient(postgres, 'backgroundJob').find_many(order_by={'createdAt': 'desc'}, take=25, skip=0)
assert 'ORDER BY "createdAt" DESC LIMIT 25 OFFSET 0' in postgres.query

creator = FakeAdapter('mssql')
created = AdapterTableClient(creator, 'lLMProvider').create({'id': '1', 'provider': 'openai', 'apiKey': 'secret'})
assert created['provider'] == 'openai'
assert 'INSERT INTO [dbo].[llm_providers]' in creator.query

set_adapter_metadata({
    'model_to_table': {'legacyModel': '[dbo].[legacy_models]'},
    'model_fields': {'legacyModel': {'id': 'string'}},
})
try:
    AdapterTableClient(FakeAdapter('mssql'), 'legacyModel').create({'id': '1'})
    raise AssertionError('Expected dict-shaped metadata to fail')
except TypeError as exc:
    assert 'Regenerate with @an5/orm >= 1.0.4' in str(exc)

print('an5Adapters smoke test passed')
