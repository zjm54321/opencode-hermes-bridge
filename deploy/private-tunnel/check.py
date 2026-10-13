#!/usr/bin/env python3
"""Offline core checks for this JSON-subset YAML base; no network, kubectl or release approval."""
import argparse
import ipaddress
import json
from pathlib import Path
import re
import sys

TUNNEL = 'ghcr.io/openai/tunnel-client:v0.0.16@sha256:4605ea909701668d3bdcbe6152558e068e24006aa96ca5518ca67f786a1bce13'


class Invalid(ValueError):
    pass


def require(ok, message):
    if not ok:
        raise Invalid(message)


def environment(container):
    entries = container.get('env', [])
    require(not container.get('envFrom') and len({e['name'] for e in entries}) == len(entries), 'ambiguous environment')
    return {e['name']: {k: v for k, v in e.items() if k != 'name'} for e in entries}


def config_ref(key):
    return {'valueFrom': {'configMapKeyRef': {'name': 'hermes-mcp', 'key': key}}}


def peer(app):
    return {'podSelector': {'matchLabels': {'app': app}}}


def check(base):
    k = json.loads((base / 'kustomization.yaml').read_text())
    require(k['namespace'] == 'ai-services' and k['resources'] == ['resources.yaml'] and set(k) == {'apiVersion', 'kind', 'namespace', 'resources'}, 'local base only')
    resources = json.loads((base / 'resources.yaml').read_text())['items']
    objects = {(r['kind'], r['metadata']['name']): r for r in resources}
    expected = {('ServiceAccount', 'hermes-mcp'), ('ConfigMap', 'hermes-mcp'), ('PersistentVolumeClaim', 'hermes-mcp-private'),
                ('Deployment', 'hermes-mcp'), ('NetworkPolicy', 'hermes-mcp-isolation'), ('NetworkPolicy', 'hermes-agent-from-hermes-mcp')}
    require(set(objects) == expected and len(resources) == 6 and all(r['metadata']['namespace'] == 'ai-services' for r in resources), 'unexpected resources/exposure')
    deployment = objects['Deployment', 'hermes-mcp']['spec']
    require(deployment['replicas'] == 1 and deployment['strategy'] == {'type': 'Recreate'}, 'one writer with Recreate required')
    require(deployment['selector'] == {'matchLabels': {'app': 'hermes-mcp'}} and deployment['template']['metadata']['labels'] == {'app': 'hermes-mcp'}, 'Pod selector mismatch')
    pod = deployment['template']['spec']
    require(not any(pod.get(k) for k in ('hostNetwork', 'hostPID', 'hostIPC', 'shareProcessNamespace', 'automountServiceAccountToken')), 'host access / service account token forbidden')
    require(objects['ServiceAccount', 'hermes-mcp']['automountServiceAccountToken'] is False, 'SA token enabled')
    require(pod['securityContext'] == {'runAsNonRoot': True, 'runAsUser': 10000, 'runAsGroup': 10000, 'seccompProfile': {'type': 'RuntimeDefault'}}, 'private UID/seccomp required; no fsGroup')
    require([c['name'] for c in pod['containers']] == ['mcp', 'tunnel-client'] and [c['name'] for c in pod['initContainers']] == ['volume-roots', 'volume-private'], 'unexpected containers')
    mcp, tunnel = pod['containers']
    roots, private = pod['initContainers']
    for c in [roots, private, mcp, tunnel]:
        security = {'allowPrivilegeEscalation': False, 'readOnlyRootFilesystem': True, 'capabilities': {'drop': ['ALL']}}
        if c is roots:
            security.update(runAsNonRoot=False, runAsUser=0, runAsGroup=0, capabilities={'drop': ['ALL'], 'add': ['CHOWN', 'FOWNER']})
        require(c['securityContext'] == security and not c.get('ports'), 'unsafe container privileges/ports')
        require(all(c['resources'][bound].get(key) for bound in ('requests', 'limits') for key in ('cpu', 'memory')), 'resource limits required')
        require(not any(set(c.get(probe, {})) & {'httpGet', 'tcpSocket', 'grpc'} for probe in ('readinessProbe', 'livenessProbe', 'startupProbe')), 'loopback exec probes only')
    require(roots['command'] == ['bun', '/app/volume-init.mjs', 'roots'] and private['command'] == ['bun', '/app/volume-init.mjs', 'private'], 'unexpected init command')
    require(not environment(roots) and not environment(private), 'initializers need no identity or secrets')
    require(roots['image'] == private['image'] == mcp['image'] and (mcp['image'] == 'REPLACE_ME_MCP_IMAGE' or re.fullmatch(r'[^\s@]+@sha256:[a-f0-9]{64}', mcp['image'])), 'same digest-pinned MCP image required')
    require(tunnel['image'] == TUNNEL and not tunnel.get('command') and tunnel['args'] == ['--control-plane.api-key=file:/run/secrets/tunnel_api_key'], 'official tunnel pin/entrypoint required')
    require(not mcp.get('command') and not mcp.get('args'), 'MCP image entrypoint required')
    me, te = environment(mcp), environment(tunnel)
    for name, value in {'HERMES_MCP_HOST': '127.0.0.1', 'HERMES_MCP_PORT': '8790', 'HERMES_MCP_STATE_DIR': '/private/state',
                        'HERMES_BRIDGE_OUTPUT_DIR': '/private/outputs', 'HERMES_BRIDGE_URL': 'http://hermes-bridge.ai-services.svc.cluster.local:8787'}.items():
        require(me[name] == {'value': value}, 'MCP loopback/backend/private paths changed')
    for name, key in [('PRIVATE_OWNER', 'private-owner'), ('TUNNEL_ID', 'tunnel-id'), ('FILE_ORIGINS', 'file-origins')]:
        require(me[f'HERMES_MCP_{name}'] == config_ref(key), 'MCP config reference changed')
    require(te['CONTROL_PLANE_TUNNEL_ID'] == me['HERMES_MCP_TUNNEL_ID'], 'one shared tunnel-id key required')
    for name, value in {'MCP_SERVER_URL': 'http://127.0.0.1:8790/mcp', 'HEALTH_LISTEN_ADDR': '127.0.0.1:8080', 'ALLOW_REMOTE_UI': 'false', 'OPEN_WEB_UI': 'false'}.items():
        require(te[name] == {'value': value}, 'tunnel loopback/UI configuration changed')
    token = {'valueFrom': {'secretKeyRef': {'name': 'hermes-mcp-bridge', 'key': 'token'}}}
    require(me['HERMES_BRIDGE_TOKEN'] == token and [v for v in me.values() if 'secretKeyRef' in v.get('valueFrom', {})] == [token]
            and not any('secretKeyRef' in v.get('valueFrom', {}) for v in te.values()), 'Bridge bearer belongs only to MCP')
    mounts = {'mcp': [('private-data', '/private'), ('mcp-temp', '/tmp')], 'tunnel-client': [('tunnel-key', '/run/secrets'), ('tunnel-temp', '/tmp')]}
    for c in [roots, private]:
        mounts[c['name']] = [('private-data', '/work/data'), ('mcp-temp', '/work/mcp-temp'), ('tunnel-temp', '/work/tunnel-temp')]
    require(all([(m['name'], m['mountPath']) for m in c['volumeMounts']] == mounts[c['name']] for c in [roots, private, mcp, tunnel]) and tunnel['volumeMounts'][0]['readOnly'] is True, 'private mounts/secret separation changed')
    volumes = {v['name']: {k: value for k, value in v.items() if k != 'name'} for v in pod['volumes']}
    require(set(volumes) == {'private-data', 'mcp-temp', 'tunnel-temp', 'tunnel-key'} and volumes['private-data'] == {'persistentVolumeClaim': {'claimName': 'hermes-mcp-private'}}, 'dedicated PVC only; no profile/host mount')
    require(all(set(volumes[name]) == {'emptyDir'} for name in ('mcp-temp', 'tunnel-temp')) and volumes['tunnel-key'] == {'secret': {'secretName': 'hermes-mcp-tunnel', 'defaultMode': 292, 'items': [{'key': 'api-key', 'path': 'tunnel_api_key'}]}}, 'temporary volume / client key projection changed')
    pvc = objects['PersistentVolumeClaim', 'hermes-mcp-private']['spec']
    require(pvc['accessModes'] == ['ReadWriteOnce'] and pvc['volumeMode'] == 'Filesystem' and not set(pvc) & {'dataSource', 'dataSourceRef', 'volumeName', 'selector'}, 'do not adopt/clone historical volumes')
    isolation = objects['NetworkPolicy', 'hermes-mcp-isolation']['spec']
    require(isolation['podSelector'] == peer('hermes-mcp')['podSelector'] and isolation['policyTypes'] == ['Ingress', 'Egress'] and isolation['ingress'] == [] and len(isolation['egress']) == 3, 'MCP ingress denied; minimal egress only')
    dns, backend, public = isolation['egress']
    tcp8787 = [{'protocol': 'TCP', 'port': 8787}]
    require(dns == {'to': [{'namespaceSelector': {'matchLabels': {'kubernetes.io/metadata.name': 'kube-system'}}, 'podSelector': {'matchLabels': {'k8s-app': 'kube-dns'}}}], 'ports': [{'protocol': 'UDP', 'port': 53}, {'protocol': 'TCP', 'port': 53}]} and backend == {'to': [peer('hermes-agent')], 'ports': tcp8787}, 'DNS/backend egress expanded')
    block = public['to'][0]['ipBlock']
    require(len(public['to']) == 1 and set(public['to'][0]) == {'ipBlock'} and block['cidr'] == '0.0.0.0/0' and public['ports'] == [{'protocol': 'TCP', 'port': 443}], 'public egress TCP443 only')
    exclusions = [ipaddress.ip_network(n) for n in block['except']]
    for n in ['0.0.0.0/8', '10.0.0.0/8', '100.64.0.0/10', '127.0.0.0/8', '169.254.0.0/16', '172.16.0.0/12', '192.0.0.0/24', '192.0.2.0/24', '192.168.0.0/16', '198.18.0.0/15', '198.51.100.0/24', '203.0.113.0/24', '224.0.0.0/3']:
        require(any(ipaddress.ip_network(n).subnet_of(e) for e in exclusions), 'nonpublic egress exclusion missing')
    require(objects['NetworkPolicy', 'hermes-agent-from-hermes-mcp']['spec'] == {**peer('hermes-agent'), 'policyTypes': ['Ingress'], 'ingress': [{'from': [peer('hermes-mcp')], 'ports': tcp8787}]}, 'backend ingress same-namespace MCP only; do not edit old LAN rules')
    require(set(objects['ConfigMap', 'hermes-mcp']['data']) == {'private-owner', 'tunnel-id', 'file-origins'}, 'unexpected ConfigMap keys')
    placeholders = 'REPLACE_ME' in json.dumps(resources)
    print(f'STATIC PASS; placeholders {"remain: fill before use" if placeholders else "not found"}. Offline only; no deployment or runtime/ChatGPT validation.')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--base', type=Path, default=Path(__file__).resolve().parent / 'base')
    try:
        check(parser.parse_args().base)
    except (ValueError, KeyError, TypeError, OSError, IndexError) as error:
        print(f'CHECK FAILED: {error if isinstance(error, Invalid) else "invalid or unreadable input"}', file=sys.stderr)
        sys.exit(1)
