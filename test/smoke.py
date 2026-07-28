import os
import sys

ROOT = os.path.dirname(os.path.dirname(__file__))
assert os.path.exists(os.path.join(ROOT, 'python')), 'Expected python adapter directory'
assert os.path.exists(os.path.join(ROOT, 'typescript')), 'Expected typescript adapter directory'
assert os.path.exists(os.path.join(ROOT, 'dotnet')), 'Expected dotnet adapter directory'
print('an5Adapters smoke test passed')
