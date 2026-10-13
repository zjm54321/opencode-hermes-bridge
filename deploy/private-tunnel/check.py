#!/usr/bin/env python3
"""Offline, stdlib-only checks of this JSON-subset YAML base. Never invokes kubectl/network.

Structure PASS is not release approval. --release-inputs requires non-secret external
attestations; this tool cannot authenticate those attestations or inspect a cluster.
"""
import argparse
import ipaddress
import json
from pathlib import Path
import re
import sys
import unicodedata

HERE = Path(__file__).resolve().parent
TUNNEL = 'ghcr.io/openai/tunnel-client:v0.0.16@sha256:4605ea909701668d3bdcbe6152558e068e24006aa96ca5518ca67f786a1bce13'
PLACEHOLDER = 'REPLACE_ME_MCP_IMAGE'
COMMON_GATES = (
    'image_build_and_digest_verified', 'dedicated_pvc_backup_and_binding_verified',
    'volume_init_on_target_storage_verified', 'cni_dns_backend_egress_and_existing_rules_verified',
    'secrets_provisioned_out_of_band', 'owner_tunnel_account_permissions_verified',
    'existing_hermes_identity_preserved', 'chatgpt_text_acceptance_verified',
)
FILE_GATES = ('profile_safe_backend_plugin_upgrade_verified', 'backend_capabilities_assets_true',
              'chatgpt_original_file_roundtrip_verified', 'file_origins_verified')


class CheckError(ValueError):
    """Fixed diagnostic text only; never interpolate input document values."""


def require(condition, message):
    if not condition:
        raise CheckError(message)


def load(path):
    return json.loads(path.read_text())


def env(container):
    entries = container.get('env', [])
    result = {entry['name']: {k: v for k, v in entry.items() if k != 'name'} for entry in entries}
    require(len(result) == len(entries) and not container.get('envFrom'), 'duplicate env / envFrom forbidden')
    return result


def config_ref(key):
    return {'valueFrom': {'configMapKeyRef': {'name': 'hermes-mcp', 'key': key}}}


def peer(app):
    return {'podSelector': {'matchLabels': {'app': app}}}


def structure(base):
    k = load(base / 'kustomization.yaml')
    require(k == {'apiVersion': 'kustomize.config.k8s.io/v1beta1', 'kind': 'Kustomization',
                  'namespace': 'ai-services', 'resources': ['resources.yaml']}, 'unexpected kustomization inputs')
    document = load(base / 'resources.yaml')
    require(document['apiVersion'] == 'v1' and document['kind'] == 'List', 'expected resource List')
    resources = document['items']
    expected = {('ServiceAccount', 'hermes-mcp'), ('ConfigMap', 'hermes-mcp'),
                ('PersistentVolumeClaim', 'hermes-mcp-private'), ('Deployment', 'hermes-mcp'),
                ('NetworkPolicy', 'hermes-mcp-isolation'), ('NetworkPolicy', 'hermes-agent-from-hermes-mcp')}
    objects = {(r['kind'], r['metadata']['name']): r for r in resources}
    require(set(objects) == expected and len(resources) == len(expected), 'unexpected resources; no Service/Ingress/Secret allowed')
    require(all(r['metadata']['namespace'] == 'ai-services' for r in resources), 'namespace must be ai-services')
    require(objects['ServiceAccount', 'hermes-mcp']['automountServiceAccountToken'] is False, 'SA token enabled')
    deployment = objects['Deployment', 'hermes-mcp']['spec']
    require(deployment['replicas'] == 1 and deployment['strategy'] == {'type': 'Recreate'}, 'single-writer/Recreate required')
    require(deployment['selector'] == {'matchLabels': {'app': 'hermes-mcp'}}
            and deployment['template']['metadata']['labels'] == {'app': 'hermes-mcp'}, 'unexpected Pod labels')
    pod = deployment['template']['spec']
    require(pod['serviceAccountName'] == 'hermes-mcp' and pod['automountServiceAccountToken'] is False, 'Pod token enabled')
    require(all(pod.get(k, False) is False for k in ('hostNetwork', 'hostPID', 'hostIPC', 'shareProcessNamespace')), 'host/shared-process access')
    require(pod['securityContext'] == {'runAsNonRoot': True, 'runAsUser': 10000, 'runAsGroup': 10000,
                                      'seccompProfile': {'type': 'RuntimeDefault'}}, 'unexpected Pod security / fsGroup')
    require([c['name'] for c in pod['containers']] == ['mcp', 'tunnel-client'], 'unexpected runtime containers')
    require([c['name'] for c in pod['initContainers']] == ['volume-roots', 'volume-private'], 'unexpected initialization')
    mcp, tunnel = pod['containers']
    roots, private = pod['initContainers']
    for c in [roots, private, mcp, tunnel]:
        sc = c['securityContext']
        expected_sc = {'allowPrivilegeEscalation': False, 'readOnlyRootFilesystem': True, 'capabilities': {'drop': ['ALL']}}
        if c is roots:
            expected_sc.update(runAsNonRoot=False, runAsUser=0, runAsGroup=0)
            expected_sc['capabilities']['add'] = ['CHOWN', 'FOWNER']
        require(sc == expected_sc, 'container security differs from reviewed capability/UID boundary')
        require(not c.get('ports') and not c.get('lifecycle'), 'ports/lifecycle forbidden')
        require(all(c['resources'][bound].get(key) for bound in ('requests', 'limits') for key in ('cpu', 'memory')), 'resources missing')
        for key in ('livenessProbe', 'readinessProbe', 'startupProbe'):
            require(key not in c or set(c[key]).isdisjoint({'httpGet', 'tcpSocket', 'grpc'}), 'use loopback exec probes only')
    require(roots['command'] == ['bun', '/app/volume-init.mjs', 'roots']
            and private['command'] == ['bun', '/app/volume-init.mjs', 'private'], 'unsafe init command')
    require(all(c['image'] == mcp['image'] for c in [roots, private]), 'init must use same MCP image')
    require(mcp['image'] == PLACEHOLDER or re.fullmatch(r'[^\s@]+@sha256:[a-f0-9]{64}', mcp['image']), 'MCP image needs digest')
    require(tunnel['image'] == TUNNEL and 'command' not in tunnel
            and tunnel['args'] == ['--control-plane.api-key=file:/run/secrets/tunnel_api_key'], 'official tunnel image/entrypoint/key path changed')
    require('command' not in mcp and 'args' not in mcp, 'MCP image entrypoint must be used')
    me, te, pe = env(mcp), env(tunnel), env(private)
    require(not env(roots), 'root initializer must receive no configuration or secrets')
    common = {f'HERMES_MCP_{name}': config_ref(key) for name, key in
              [('AUTH_MODE', 'auth-mode'), ('PRIVATE_OWNER', 'private-owner'), ('TUNNEL_ID', 'tunnel-id')]}
    require(pe == common and all(me.get(k) == v for k, v in common.items()), 'shared identity ConfigMap references required')
    fixed = {'HERMES_MCP_HOST': '127.0.0.1', 'HERMES_MCP_PORT': '8790', 'HERMES_MCP_HTTP_DOWNLOADS': '0',
             'HERMES_MCP_STATE_DIR': '/private/state', 'HERMES_BRIDGE_OUTPUT_DIR': '/private/outputs',
             'HERMES_BRIDGE_URL': 'http://hermes-bridge.ai-services.svc.cluster.local:8787', 'HOME': '/tmp', 'TMPDIR': '/tmp'}
    expected_me = {**common, **{k: {'value': v} for k, v in fixed.items()},
                   'HERMES_MCP_FILE_ORIGINS': config_ref('file-origins'),
                   'HERMES_BRIDGE_TOKEN': {'valueFrom': {'secretKeyRef': {'name': 'hermes-mcp-bridge', 'key': 'token'}}}}
    require(me == expected_me, 'MCP configuration/secret boundary changed')
    tfixed = {'MCP_SERVER_URL': 'http://127.0.0.1:8790/mcp', 'HEALTH_LISTEN_ADDR': '127.0.0.1:8080',
              'ALLOW_REMOTE_UI': 'false', 'OPEN_WEB_UI': 'false', 'HOME': '/tmp', 'TMPDIR': '/tmp',
              **{f'XDG_{k}_HOME': f'/tmp/{v}' for k, v in [('CONFIG', 'config'), ('CACHE', 'cache'), ('STATE', 'state')]},
              'XDG_RUNTIME_DIR': '/tmp/run'}
    require(te == {**{k: {'value': v} for k, v in tfixed.items()}, 'CONTROL_PLANE_TUNNEL_ID': config_ref('tunnel-id')}, 'tunnel configuration/secret boundary changed')
    require(mcp['readinessProbe']['exec']['command'] == ['bun', '/app/probe.mjs']
            and mcp['livenessProbe']['exec']['command'] == ['bun', '/app/probe.mjs', '--live'], 'loopback combined probe required')
    expected_mounts = {
        'mcp': [{'name': 'private-data', 'mountPath': '/private'}, {'name': 'mcp-temp', 'mountPath': '/tmp'}],
        'tunnel-client': [{'name': 'tunnel-key', 'mountPath': '/run/secrets', 'readOnly': True}, {'name': 'tunnel-temp', 'mountPath': '/tmp'}],
    }
    for c in [roots, private]:
        expected_mounts[c['name']] = [{'name': n, 'mountPath': p} for n, p in
                                     [('private-data', '/work/data'), ('mcp-temp', '/work/mcp-temp'), ('tunnel-temp', '/work/tunnel-temp')]]
    require(all(c['volumeMounts'] == expected_mounts[c['name']] for c in [roots, private, mcp, tunnel]), 'mount/secret separation changed')
    require(pod['volumes'] == [
        {'name': 'private-data', 'persistentVolumeClaim': {'claimName': 'hermes-mcp-private'}},
        {'name': 'mcp-temp', 'emptyDir': {'medium': 'Memory', 'sizeLimit': '128Mi'}},
        {'name': 'tunnel-temp', 'emptyDir': {'medium': 'Memory', 'sizeLimit': '64Mi'}},
        {'name': 'tunnel-key', 'secret': {'secretName': 'hermes-mcp-tunnel', 'defaultMode': 292, 'items': [{'key': 'api-key', 'path': 'tunnel_api_key'}]}}
    ], 'dedicated PVC/private temporary volumes/secret projection required')
    pvc = objects['PersistentVolumeClaim', 'hermes-mcp-private']['spec']
    require(pvc['accessModes'] == ['ReadWriteOnce'] and pvc['volumeMode'] == 'Filesystem'
            and pvc.get('storageClassName') and not any(k in pvc for k in ('dataSource', 'dataSourceRef', 'volumeName', 'selector')), 'PVC must not adopt/clone old state')
    isolation = objects['NetworkPolicy', 'hermes-mcp-isolation']['spec']
    require(isolation['podSelector'] == peer('hermes-mcp')['podSelector'] and isolation['policyTypes'] == ['Ingress', 'Egress']
            and isolation['ingress'] == [] and len(isolation['egress']) == 3, 'MCP ingress must be denied')
    dns, backend, public = isolation['egress']
    require(dns == {'to': [{'namespaceSelector': {'matchLabels': {'kubernetes.io/metadata.name': 'kube-system'}},
                            'podSelector': {'matchLabels': {'k8s-app': 'kube-dns'}}}],
                    'ports': [{'protocol': 'UDP', 'port': 53}, {'protocol': 'TCP', 'port': 53}]}, 'DNS egress expanded')
    require(backend == {'to': [peer('hermes-agent')], 'ports': [{'protocol': 'TCP', 'port': 8787}]}, 'backend egress expanded')
    block = public['to'][0]['ipBlock']
    require(len(public['to']) == 1 and set(public['to'][0]) == {'ipBlock'} and block['cidr'] == '0.0.0.0/0'
            and public['ports'] == [{'protocol': 'TCP', 'port': 443}], 'public egress must be IPv4 TCP443 only')
    networks = [ipaddress.ip_network(n) for n in block['except']]
    for network in ['0.0.0.0/8', '10.0.0.0/8', '100.64.0.0/10', '127.0.0.0/8', '169.254.0.0/16', '172.16.0.0/12',
                    '192.0.0.0/24', '192.0.2.0/24', '192.168.0.0/16', '198.18.0.0/15', '198.51.100.0/24', '203.0.113.0/24', '224.0.0.0/3']:
        require(any(ipaddress.ip_network(network).subnet_of(n) for n in networks), 'nonpublic egress exclusion missing')
    require(objects['NetworkPolicy', 'hermes-agent-from-hermes-mcp']['spec'] == {
        **peer('hermes-agent'), 'policyTypes': ['Ingress'], 'ingress': [{'from': [peer('hermes-mcp')], 'ports': [{'protocol': 'TCP', 'port': 8787}]}]
    }, 'backend ingress must be same-namespace MCP-only additive rule')
    config = objects['ConfigMap', 'hermes-mcp']['data']
    require(set(config) == {'auth-mode', 'private-owner', 'tunnel-id', 'file-origins'} and config['auth-mode'] == 'private-tunnel', 'config keys/auth mode changed')
    owner = config['private-owner']
    require(isinstance(owner, str) and owner and owner.strip() == owner and len(owner.encode()) <= 256
            and not any(unicodedata.category(c) in ('Cc', 'Cf') for c in owner), 'invalid private owner')
    require(config['tunnel-id'] == 'REPLACE_ME_TUNNEL_ID' or re.fullmatch(r'tunnel_[a-z0-9]{32}', config['tunnel-id']), 'invalid tunnel ID')
    origins = json.loads(config['file-origins'])
    require(isinstance(origins, list) and len(origins) <= 32 and all(isinstance(o, str) and re.fullmatch(r'https://[a-zA-Z0-9.-]+(?::[0-9]+)?', o) for o in origins), 'invalid exact HTTPS attachment origins')
    return resources, mcp['image']


def release(resources, image, inputs):
    require('REPLACE_ME' not in json.dumps(resources), 'unfilled deployment placeholders')
    require(inputs.get('scope') in ('text-only', 'files'), 'choose release scope: text-only or files')
    require(re.fullmatch(r'oven/bun:1\.4\.2@sha256:[a-f0-9]{64}', inputs.get('bunImage', '')), 'verified Bun digest required')
    require(re.fullmatch(r'[a-f0-9]{40}', inputs.get('sourceRevision', '')), 'locked source revision required')
    require(inputs.get('mcpImage') == image and re.fullmatch(r'[^\s@]+@sha256:[a-f0-9]{64}', image), 'built MCP digest must match base')
    confirmations = inputs.get('confirmations', {})
    config = next(r['data'] for r in resources if r['kind'] == 'ConfigMap')
    origins = json.loads(config['file-origins'])
    gates = COMMON_GATES + (FILE_GATES if inputs['scope'] == 'files' else (('file_origins_verified',) if origins else ()))
    for key in gates:
        value = confirmations.get(key, {})
        evidence = value.get('evidence', '')
        require(value.get('confirmed') is True and isinstance(evidence, str) and evidence.strip()
                and not re.search(r'REPLACE_ME|TODO|placeholder', evidence, re.I), f'external confirmation missing: {key}')
    require(inputs['scope'] != 'files' or origins, 'files release requires confirmed nonempty attachment origins')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--base', type=Path, default=HERE / 'base')
    parser.add_argument('--release-inputs', type=Path, help='non-secret release evidence JSON; never a Secret manifest')
    args = parser.parse_args()
    try:
        resources, image = structure(args.base)
        if args.release_inputs:
            inputs = load(args.release_inputs)
            release(resources, image, inputs)
            print(f"RELEASE INPUTS PASS ({inputs['scope']}); attestations are not independently verified; no deployment performed.")
        else:
            print('STRUCTURE PASS; placeholders allowed. NOT production approval or evidence of ChatGPT/files readiness.')
    except (ValueError, KeyError, TypeError, OSError, IndexError) as error:
        # Never echo document values: input files must not become a secret-report channel.
        message = str(error) if isinstance(error, CheckError) else 'invalid or unreadable input structure'
        print(f'CHECK FAILED: {message}', file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
