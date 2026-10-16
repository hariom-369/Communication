"""Structural checks of the Terraform root that need no provider (CI also runs `terraform
validate`): every module input is declared and every required one is passed, every
`module.<m>.<output>` reference exists, and the `k8s_values` output has exactly the keys
infra/k8s expects (infra/k8s/src/values.ts, minus what the release adds)."""
import glob
import os
import re
import sys

import hcl2

ROOT = os.path.dirname(os.path.abspath(__file__))
errors = []


def clean(value):
    """python-hcl2 keeps the quotes of block labels and adds metadata keys."""
    if isinstance(value, dict):
        return {k.strip('"'): clean(v) for k, v in value.items() if not k.startswith('__')}
    if isinstance(value, list):
        return [clean(v) for v in value]
    return value.strip('"') if isinstance(value, str) else value


def load(path):
    with open(path) as fh:
        return clean(hcl2.load(fh))


def blocks(doc, kind):
    for entry in doc.get(kind, []):
        yield from entry.items()


root = {}
for f in glob.glob(os.path.join(ROOT, '*.tf')):
    for k, v in load(f).items():
        root.setdefault(k, []).extend(v)
root_text = ''.join(open(f).read() for f in glob.glob(os.path.join(ROOT, '*.tf')))

modules = {}
for name, body in blocks(root, 'module'):
    source = body['source']
    path = os.path.normpath(os.path.join(ROOT, source))
    doc = {}
    for f in glob.glob(os.path.join(path, '*.tf')):
        for k, v in load(f).items():
            doc.setdefault(k, []).extend(v)
    variables = dict(blocks(doc, 'variable'))
    outputs = dict(blocks(doc, 'output'))
    modules[name] = outputs
    passed = {k for k in body if k not in ('source', 'providers', 'depends_on', 'count', 'for_each')}
    for k in passed - variables.keys():
        errors.append(f'module.{name}: input {k} is not a variable of {source}')
    for k, v in variables.items():
        if 'default' not in v and k not in passed:
            errors.append(f'module.{name}: required variable {k} not passed')

for m, o in re.findall(r'module\.([a-z0-9_]+)\.([a-z0-9_]+)', root_text):
    if m not in modules:
        errors.append(f'unknown module {m}')
    elif o not in modules[m]:
        errors.append(f'module.{m} has no output {o}')

root_vars = dict(blocks(root, 'variable'))
for v in re.findall(r'\bvar\.([a-z_]+)', root_text):
    if v not in root_vars:
        errors.append(f'undeclared variable var.{v}')
for tfvars in glob.glob(os.path.join(ROOT, 'envs', '*.tfvars')):
    given = load(tfvars).keys()
    for k in given - root_vars.keys():
        errors.append(f'{os.path.basename(tfvars)}: unknown variable {k}')
    for k, v in root_vars.items():
        if 'default' not in v and k not in given:
            errors.append(f'{os.path.basename(tfvars)}: required variable {k} missing')

values_ts = open(os.path.join(ROOT, '..', 'k8s', 'src', 'values.ts')).read()
schema = values_ts[values_ts.index('export const valuesSchema'):]
expected = set(re.findall(r'^  ([a-zA-Z]+):', schema, re.M)) - {'release', 'images', 'apiEnv'}
output_block = root_text[root_text.index('output "k8s_values"'):]
output_block = output_block[: output_block.index('})')]
actual = set(re.findall(r'^\s+([a-zA-Z]+)\s+=', output_block, re.M)) - {'value'}
if actual != expected:
    errors.append(f'k8s_values keys differ: missing {sorted(expected - actual)}, extra {sorted(actual - expected)}')

for e in errors:
    print('error:', e)
print(f'{len(modules)} modules checked, {len(errors)} errors')
sys.exit(1 if errors else 0)
