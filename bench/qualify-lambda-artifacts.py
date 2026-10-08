"""Invoke the report fixture's actual packages in AWS; always remove owned resources.

This validates packaging only. These raw AWS calls are not framework deploy-speed results.
Recovery: python3 bench/qualify-lambda-artifacts.py --cleanup-only <state-file>
"""
import base64
import hashlib
import json
import os
import re
from pathlib import Path
import subprocess
import sys
import time
import uuid
import zipfile

recovery = json.loads(Path(sys.argv[2]).read_text()) if len(sys.argv) == 3 and sys.argv[1] == '--cleanup-only' else {}
ACCOUNT = os.environ.get('BENCH_AWS_ACCOUNT') or recovery.get('account')
REGION = os.environ.get('BENCH_AWS_REGION') or recovery.get('region')
PROFILE = os.environ.get('BENCH_AWS_PROFILE') or recovery.get('profile')
if not ACCOUNT or not REGION or not PROFILE:
    raise SystemExit('Set BENCH_AWS_ACCOUNT, BENCH_AWS_REGION, and BENCH_AWS_PROFILE explicitly.')
AWS = str(Path.home() / '.local/bin/aws')

def aws(*args, allow_missing=False):
    result = subprocess.run([AWS, *args, '--profile', PROFILE, '--region', REGION, '--output', 'json'], capture_output=True, text=True)
    if result.returncode:
        if allow_missing and ('ResourceNotFoundException' in result.stderr or 'NoSuchEntity' in result.stderr or 'ResourceNotFound' in result.stderr):
            return None
        raise RuntimeError(result.stderr.strip())
    return json.loads(result.stdout) if result.stdout.strip() else {}

def identity():
    actual = aws('sts', 'get-caller-identity')['Account']
    if actual != ACCOUNT:
        raise RuntimeError('AWS account mismatch; no mutation or cleanup authorized.')
    if any(key.startswith('AWS_ENDPOINT_URL') and value for key, value in os.environ.items()):
        raise RuntimeError('AWS endpoint override is forbidden for this qualification.')

def persist(state_file, state):
    state_file.write_text(json.dumps(state, indent=2) + '\n')

def cleanup(state_file, state):
    identity()
    assert state['account'] == ACCOUNT and state['profile'] == PROFILE and state['region'] == REGION
    owner = state['owner']
    assert re.fullmatch(r'bmrpt-[a-f0-9]{10}', owner), 'Invalid recovery owner'
    assert state['role'] == owner + '-role', 'Unexpected recovery role'
    assert all(re.fullmatch(re.escape(owner) + r'-(stacktape|cdk|serverless)(-[0-9]+)?', item['name']) and item['tool'] in ['stacktape', 'cdk', 'serverless'] for item in state['functions']), 'Unexpected recovery function'
    failures = []
    for item in reversed(state['functions']):
        name = item['name']
        try:
            existing = aws('lambda', 'get-function', '--function-name', name, allow_missing=True)
            if existing:
                assert existing.get('Tags', {}).get('benchmark-owner') == owner, 'Lambda ownership mismatch'
                aws('lambda', 'delete-function', '--function-name', name)
            assert aws('lambda', 'get-function', '--function-name', name, allow_missing=True) is None
            log = '/aws/lambda/' + name
            groups = aws('logs', 'describe-log-groups', '--log-group-name-prefix', log)['logGroups']
            for group in groups:
                if group['logGroupName'] != log:
                    continue
                tags = aws('logs', 'list-tags-log-group', '--log-group-name', log)['tags']
                assert tags.get('benchmark-owner') == owner, 'Log ownership mismatch'
                aws('logs', 'delete-log-group', '--log-group-name', log)
            assert not any(g['logGroupName'] == log for g in aws('logs', 'describe-log-groups', '--log-group-name-prefix', log)['logGroups'])
        except Exception as error:
            failures.append(str(error))
    for layer in state.get('layers', []):
        try:
            assert layer['name'] == owner + '-chunks', 'Unexpected layer name'
            versions = aws('lambda', 'list-layer-versions', '--layer-name', layer['name'])['LayerVersions']
            for version in versions:
                existing = aws('lambda', 'get-layer-version', '--layer-name', layer['name'], '--version-number', str(version['Version']))
                assert existing['Content']['CodeSha256'] == layer['sha256Base64'], 'Layer content mismatch'
                aws('lambda', 'delete-layer-version', '--layer-name', layer['name'], '--version-number', str(version['Version']))
            assert not aws('lambda', 'list-layer-versions', '--layer-name', layer['name'])['LayerVersions']
        except Exception as error:
            failures.append(str(error))
    try:
        role = aws('iam', 'get-role', '--role-name', state['role'], allow_missing=True)
        if role:
            tags = {tag['Key']: tag['Value'] for tag in role['Role'].get('Tags', [])}
            assert tags.get('benchmark-owner') == owner, 'IAM ownership mismatch'
            policies = aws('iam', 'list-role-policies', '--role-name', state['role'])['PolicyNames']
            assert all(p == 'owned-lambda-logs' for p in policies), 'Unexpected role policy; cleanup refused'
            for policy in policies:
                aws('iam', 'delete-role-policy', '--role-name', state['role'], '--policy-name', policy)
            aws('iam', 'delete-role', '--role-name', state['role'])
        assert aws('iam', 'get-role', '--role-name', state['role'], allow_missing=True) is None
    except Exception as error:
        failures.append(str(error))
    state['cleanupVerified'] = not failures
    state['cleanupErrors'] = failures
    persist(state_file, state)
    if failures:
        print('Recovery: python3 bench/qualify-lambda-artifacts.py --cleanup-only ' + str(state_file))
        raise RuntimeError('Cleanup requires recovery: ' + '; '.join(failures))

if len(sys.argv) == 3 and sys.argv[1] == '--cleanup-only':
    state_file = Path(sys.argv[2]).resolve()
    cleanup(state_file, json.loads(state_file.read_text()))
    print('Owned AWS resources confirmed deleted.')
    sys.exit(0)

if len(sys.argv) != 2:
    raise SystemExit('Usage: python3 bench/qualify-lambda-artifacts.py <pilot-results-directory>')
results_dir = Path(sys.argv[1]).resolve()
results = json.loads((results_dir / 'results.json').read_text())
count = results['count']
assert count in [1, 25]
assert results['kind'] == 'native-command-packaging-pilot', 'Do not qualify superseded samples.'
assert len(results['samplesRaw']) == results['samples'] * 3 * 3
assert all(row['exitCode'] == 0 for row in results['samplesRaw'])
root = Path(results.get('fixture', 'generated/reports-' + str(count))).resolve()
owner = 'bmrpt-' + uuid.uuid4().hex[:10]
state_file = Path('tmp', owner + '-aws.json').resolve()
run_id = re.search(r'20[0-9]{2}-[0-9]{2}-[0-9]{2}T.*', results_dir.name).group()
expected_revision = 'edit-' + run_id + '-' + str(results['samples'] - 1)
latest_stack = sorted((root / '.stacktape').iterdir())[-1]

def zip_directory(directory, destination):
    with zipfile.ZipFile(destination, 'w', zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for path in sorted(directory.rglob('*')):
            if path.is_file():
                archive.write(path, path.relative_to(directory))

# CDK directory assets and Stacktape shared layers are archived outside packaging timing.
# Their native package/synth commands do not finish every deployment ZIP.
layers = []
layer_root = latest_stack / 'build/layers'
if layer_root.exists():
    directories = [p for p in layer_root.iterdir() if p.is_dir()]
    assert len(directories) <= 1, 'This report fixture expects at most one shared layer.'
    for directory in directories:
        artifact = Path('tmp', owner + '-chunks.zip').resolve()
        zip_directory(directory, artifact)
        layers.append({'name': owner + '-chunks', 'artifact': str(artifact), 'sha256Base64': base64.b64encode(hashlib.sha256(artifact.read_bytes()).digest()).decode()})
template = json.loads(next((root / 'cdk.out.app').glob('*.template.json')).read_text())
cdk_resources = {int(re.search(r'/Report([0-9]+)/Resource$', resource['Metadata']['aws:cdk:path']).group(1)): resource for name, resource in template['Resources'].items() if resource['Type'] == 'AWS::Lambda::Function'}
assert len(cdk_resources) == count
artifacts = []
for index in range(count):
    stack_zip = next((latest_stack / 'build/lambdas').glob('report' + str(index) + '-*.zip'))
    cdk_zip = Path('tmp', owner + '-cdk-' + str(index) + '.zip').resolve()
    resource = cdk_resources[index]
    zip_directory(root / 'cdk.out.app' / resource['Metadata']['aws:asset:path'], cdk_zip)
    sls_zip = next((root / '.serverless').glob('*-report' + str(index) + '.zip'))
    artifacts.extend([('stacktape', index, stack_zip, 'index.handler'), ('cdk', index, cdk_zip, resource['Properties']['Handler']), ('serverless', index, sls_zip, 'src/report-' + str(index) + '.handler')])
state = {'owner': owner, 'account': ACCOUNT, 'profile': PROFILE, 'region': REGION, 'role': owner + '-role', 'createdAt': time.time(), 'functions': [], 'layers': layers, 'cleanupVerified': False, 'purpose': 'artifact correctness; not deploy benchmark', 'expectedRevision': expected_revision}
identity()
assert aws('iam', 'get-role', '--role-name', state['role'], allow_missing=True) is None
for layer in layers:
    assert not aws('lambda', 'list-layer-versions', '--layer-name', layer['name'])['LayerVersions']
for tool, index, artifact, handler in artifacts:
    name = owner + '-' + tool + '-' + str(index)
    assert aws('lambda', 'get-function', '--function-name', name, allow_missing=True) is None
    assert not aws('logs', 'describe-log-groups', '--log-group-name-prefix', '/aws/lambda/' + name)['logGroups']
    state['functions'].append({'name': name, 'tool': tool, 'artifact': str(artifact), 'sha256': hashlib.sha256(artifact.read_bytes()).hexdigest(), 'handler': handler, 'index': index, 'expectedRevision': expected_revision if index == 0 else 'base'})
persist(state_file, state)
try:
    trust = {'Version': '2012-10-17', 'Statement': [{'Effect': 'Allow', 'Principal': {'Service': 'lambda.amazonaws.com'}, 'Action': 'sts:AssumeRole'}]}
    role = aws('iam', 'create-role', '--role-name', state['role'], '--assume-role-policy-document', json.dumps(trust), '--tags', 'Key=benchmark-owner,Value=' + owner)['Role']['Arn']
    logs = [f'arn:aws:logs:{REGION}:{ACCOUNT}:log-group:/aws/lambda/{item["name"]}:*' for item in state['functions']]
    policy = {'Version': '2012-10-17', 'Statement': [{'Effect': 'Allow', 'Action': ['logs:CreateLogStream', 'logs:PutLogEvents'], 'Resource': logs}]}
    aws('iam', 'put-role-policy', '--role-name', state['role'], '--policy-name', 'owned-lambda-logs', '--policy-document', json.dumps(policy))
    for layer in layers:
        layer['arn'] = aws('lambda', 'publish-layer-version', '--layer-name', layer['name'], '--zip-file', 'fileb://' + layer['artifact'], '--compatible-runtimes', 'nodejs24.x', '--compatible-architectures', 'x86_64')['LayerVersionArn']
        persist(state_file, state)
    for item in state['functions']:
        name = item['name']
        aws('logs', 'create-log-group', '--log-group-name', '/aws/lambda/' + name, '--tags', 'benchmark-owner=' + owner)
        aws('logs', 'put-retention-policy', '--log-group-name', '/aws/lambda/' + name, '--retention-in-days', '1')
        for attempt in range(12):
            try:
                aws('lambda', 'create-function', '--function-name', name, '--runtime', 'nodejs24.x', '--architectures', 'x86_64', '--role', role, '--handler', item['handler'], '--memory-size', '512', '--timeout', '30', '--zip-file', 'fileb://' + item['artifact'], '--tags', 'benchmark-owner=' + owner, *(['--layers', *[layer['arn'] for layer in layers]] if item['tool'] == 'stacktape' and layers else []))
                break
            except RuntimeError as error:
                if 'cannot be assumed by Lambda' not in str(error) or attempt == 11:
                    raise
                time.sleep(5)
        aws('lambda', 'wait', 'function-active-v2', '--function-name', name)
        payload_file = state_file.with_name(name + '-response.json')
        response = aws('lambda', 'invoke', '--function-name', name, '--payload', '{}', '--cli-binary-format', 'raw-in-base64-out', str(payload_file))
        assert not response.get('FunctionError'), payload_file.read_text()
        value = json.loads(payload_file.read_text())
        assert value['statusCode'] == 200, value
        body = json.loads(value['body'])
        assert body['revision'] == item['expectedRevision'], body
        assert body['domain'] == 'report-' + str(item['index']), body
        assert body['customer'] == 'Acme' and body['rows'] == 2 and body['date'] == '2026-10-09', body
        assert all(body[key] > 500 for key in ['xlsxBytes', 'pdfBytes', 'docxBytes']), body
        item['correctnessPassed'] = True
        item['observed'] = body
        persist(state_file, state)
        print(item['tool'] + '/' + str(item['index']) + ': report generation passed in real Lambda.')
finally:
    cleanup(state_file, state)
    print('AWS evidence: ' + str(state_file))
