import os
import sys

ROOT = os.path.dirname(os.path.dirname(__file__))
sys.path.insert(0, os.path.join(ROOT, 'python'))

from base.metadata import set_adapter_metadata
from base.sql import _resolve_table

assert os.path.exists(os.path.join(ROOT, 'python')), 'Expected python adapter directory'
assert os.path.exists(os.path.join(ROOT, 'typescript')), 'Expected typescript adapter directory'
assert os.path.exists(os.path.join(ROOT, 'dotnet')), 'Expected dotnet adapter directory'

set_adapter_metadata({
    'model_to_table': {'backgroundJob': '[dbo].[background_jobs]'},
    'model_fields': {'backgroundJob': {'id': {'type': 'string'}}},
})
assert _resolve_table('backgroundJob') == '[dbo].[background_jobs]'

print('an5Adapters smoke test passed')
