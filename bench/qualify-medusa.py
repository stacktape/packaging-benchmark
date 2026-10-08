"""Qualify the production Medusa backend and Redis worker with owned local databases.

Run from the proof repository. Optional argument: an already built Docker image.
This is correctness qualification, not a speed measurement.
"""
import json
import os
from pathlib import Path
import secrets
import signal
import socket
import subprocess
import sys
import threading
import time
import urllib.request
import urllib.error
import uuid

root = Path('fixtures/medusa').resolve()
image = sys.argv[1] if len(sys.argv) > 1 else None
owner = 'bmmed-' + uuid.uuid4().hex[:10]
output = Path('tmp', owner).resolve()
output.mkdir(parents=True)
password, token = secrets.token_hex(24), secrets.token_hex(24)
secret_values = [password, token]
containers, processes, threads, logs = [], [], [], []
state = {'owner': owner, 'kind': 'medusa-runtime-qualification', 'image': image, 'containers': [], 'cleanupVerified': False}
state_file = output / 'evidence.json'
env_file = output / 'runtime.env'

def persist():
    state_file.write_text(json.dumps(state, indent=2) + '\n')

def run(args):
    p = subprocess.run(args, capture_output=True, text=True)
    if p.returncode:
        error = p.stderr
        for value in secret_values:
            error = error.replace(value, '[redacted]')
        raise RuntimeError(error[-3000:])
    return p.stdout.strip()

def docker(*args):
    return run(['docker', *args])

def container(name, args):
    containers.append(name)
    state['containers'].append(name)
    persist()
    return docker('run', '-d', '--name', name, '--label', 'benchmark-owner=' + owner, *args)

def port(name, container_port):
    d = json.loads(docker('inspect', name))[0]
    return d['NetworkSettings']['Ports'][str(container_port) + '/tcp'][0]['HostPort']

def redact_stream(process, destination):
    with destination.open('w') as stream:
        for line in process.stdout:
            for value in secret_values:
                line = line.replace(value, '[redacted]')
            stream.write(line)
            stream.flush()

def launch(command, cwd, env, log_name):
    p = subprocess.Popen(command, cwd=cwd, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, start_new_session=True)
    processes.append(p)
    t = threading.Thread(target=redact_stream, args=(p, output / log_name), daemon=True)
    t.start()
    threads.append(t)
    return p

def request(url, body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, headers={'Content-Type': 'application/json', 'x-benchmark-token': token})
    try:
        with urllib.request.urlopen(req, timeout=5) as response:
            return json.load(response)
    except urllib.error.HTTPError as error:
        raise RuntimeError(f"HTTP {error.code}: {error.read().decode()[:2000]}") from error

persist()
try:
    docker('network', 'create', '--label', 'benchmark-owner=' + owner, owner)
    env_file.write_text('POSTGRES_PASSWORD=' + password + '\nPOSTGRES_USER=benchmark\nPOSTGRES_DB=medusa\n')
    env_file.chmod(0o600)
    container(owner + '-pg', ['--network', owner, '--env-file', str(env_file), '-p', '127.0.0.1::5432', 'postgres@sha256:f1c3376c26f2609ab9f29f71f824103fe2fcd8ee0346485cb6122a4f93df6f94'])
    container(owner + '-redis', ['--network', owner, '-p', '127.0.0.1::6379', 'redis@sha256:90e7a336d044f1abc9e9dbc05d65566850896d11453bbd1dd0fb7e5059f0e8fb'])
    for _ in range(60):
        p = subprocess.run(['docker', 'exec', owner + '-pg', 'pg_isready', '-U', 'benchmark'], capture_output=True)
        if p.returncode == 0:
            break
        time.sleep(1)
    else:
        raise RuntimeError('Postgres did not become ready.')
    state['postgresVersion'] = docker('exec', owner + '-pg', 'postgres', '--version')
    state['redisVersion'] = docker('exec', owner + '-redis', 'redis-server', '--version')
    pg_host = owner + '-pg:5432' if image else '127.0.0.1:' + port(owner + '-pg', 5432)
    redis_host = owner + '-redis:6379' if image else '127.0.0.1:' + port(owner + '-redis', 6379)
    env = {**os.environ, 'NODE_ENV': 'production', 'DATABASE_URL': 'postgres://benchmark:' + password + '@' + pg_host + '/medusa', 'REDIS_URL': 'redis://' + redis_host, 'JWT_SECRET': secrets.token_hex(24), 'COOKIE_SECRET': secrets.token_hex(24), 'BENCHMARK_TOKEN': token, 'STORE_CORS': '', 'ADMIN_CORS': '', 'AUTH_CORS': '', 'MEDUSA_TELEMETRY_DISABLED': 'true'}
    secret_values.extend([env['JWT_SECRET'], env['COOKIE_SECRET']])
    if image:
        env_file.write_text('\n'.join(k + '=' + v for k, v in env.items() if k in ['NODE_ENV', 'DATABASE_URL', 'REDIS_URL', 'JWT_SECRET', 'COOKIE_SECRET', 'BENCHMARK_TOKEN', 'STORE_CORS', 'ADMIN_CORS', 'AUTH_CORS', 'MEDUSA_TELEMETRY_DISABLED']) + '\n')
        containers.append(owner + '-migration')
        state['containers'].append(owner + '-migration')
        persist()
        migration = launch(['docker', 'run', '--rm', '--name', owner + '-migration', '--label', 'benchmark-owner=' + owner, '--network', owner, '--env-file', str(env_file), image, 'sh', '-lc', 'cd /app/apps/backend/.medusa/server && pnpm predeploy'], root, os.environ, 'migration.log')
    else:
        migration = launch(['pnpm', 'predeploy'], root / 'apps/backend/.medusa/server', env, 'migration.log')
    if migration.wait(timeout=180):
        raise RuntimeError('Migration failed; see migration.log.')
    if image:
        container(owner + '-worker', ['--network', owner, '--env-file', str(env_file), '-e', 'MEDUSA_WORKER_MODE=worker', '-e', 'DISABLE_MEDUSA_ADMIN=true', image])
        container(owner + '-server', ['--network', owner, '--env-file', str(env_file), '-e', 'MEDUSA_WORKER_MODE=server', '-e', 'DISABLE_MEDUSA_ADMIN=false', '-e', 'PORT=9000', '-p', '127.0.0.1::9000', image])
        base = 'http://127.0.0.1:' + port(owner + '-server', 9000)
    else:
        with socket.socket() as available:
            available.bind(('127.0.0.1', 0))
            server_port = available.getsockname()[1]
        launch(['pnpm', 'start'], root / 'apps/backend/.medusa/server', {**env, 'MEDUSA_WORKER_MODE': 'worker', 'DISABLE_MEDUSA_ADMIN': 'true'}, 'worker.log')
        launch(['pnpm', 'start'], root / 'apps/backend/.medusa/server', {**env, 'MEDUSA_WORKER_MODE': 'server', 'DISABLE_MEDUSA_ADMIN': 'false', 'PORT': str(server_port)}, 'server.log')
        base = 'http://127.0.0.1:' + str(server_port)
    for _ in range(120):
        try:
            revision = request(base + '/benchmark/revision')
            assert revision == {'revision': 'base', 'workerMode': 'server'}, revision
            break
        except Exception:
            time.sleep(1)
    else:
        raise RuntimeError('Server did not expose the expected revision.')
    product = request(base + '/benchmark/products', {'nonce': owner})
    for _ in range(90):
        result = request(base + '/benchmark/products?id=' + product['id'])
        metadata = result['products'][0]['metadata']
        if metadata.get('benchmark_worker_mode') == 'worker':
            break
        time.sleep(1)
    else:
        raise RuntimeError('Product subscriber did not run in the separate Redis worker.')
    state.update({'revision': revision, 'product': product, 'workerMetadata': metadata, 'correctnessPassed': True})
    print('Medusa production runtime: revision, database product creation, and separate Redis worker passed.', flush=True)
finally:
    for p in processes:
        if p.poll() is None:
            os.killpg(p.pid, signal.SIGTERM)
            try:
                p.wait(timeout=10)
            except subprocess.TimeoutExpired:
                os.killpg(p.pid, signal.SIGKILL)
                p.wait()
    for t in threads:
        t.join(timeout=5)
    errors = []
    for name in reversed(containers):
        p = subprocess.run(['docker', 'inspect', name], capture_output=True, text=True)
        if p.returncode:
            continue
        d = json.loads(p.stdout)[0]
        try:
            assert d['Config']['Labels'].get('benchmark-owner') == owner
            if name.endswith('-server') or name.endswith('-worker'):
                log = docker('logs', name)
                for value in secret_values:
                    log = log.replace(value, '[redacted]')
                (output / (name.split('-')[-1] + '.log')).write_text(log)
            docker('rm', '-f', '-v', name)
        except Exception as error:
            errors.append(str(error))
    network = subprocess.run(['docker', 'network', 'inspect', owner], capture_output=True, text=True)
    if network.returncode == 0:
        try:
            assert json.loads(network.stdout)[0]['Labels'].get('benchmark-owner') == owner
            docker('network', 'rm', owner)
        except Exception as error:
            errors.append(str(error))
    env_file.unlink(missing_ok=True)
    state['cleanupVerified'] = not errors and all(subprocess.run(['docker', 'inspect', name], capture_output=True).returncode != 0 for name in containers)
    state['cleanupErrors'] = errors
    persist()
    print('Evidence: ' + str(state_file), flush=True)
    if not state['cleanupVerified']:
        raise RuntimeError('Owned Docker cleanup needs recovery: ' + '; '.join(errors))
