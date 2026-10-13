"""Synthetic offline fixtures only; no cluster, credentials or acceptance claims."""
import copy
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('private_check', HERE / 'check.py')
check = importlib.util.module_from_spec(spec)
spec.loader.exec_module(check)


class Checks(unittest.TestCase):
    def setUp(self):
        self.sandbox = tempfile.TemporaryDirectory(prefix='private-tunnel-check-', dir='/tmp/opencode')
        self.addCleanup(self.sandbox.cleanup)
        self.base = Path(self.sandbox.name)
        (self.base / 'kustomization.yaml').write_text((HERE / 'base/kustomization.yaml').read_text())
        self.document = json.loads((HERE / 'base/resources.yaml').read_text())

    def structure(self):
        (self.base / 'resources.yaml').write_text(json.dumps(self.document))
        return check.structure(self.base)

    def test_base_and_release_fail_closed(self):
        resources, image = self.structure()
        with self.assertRaisesRegex(ValueError, 'unfilled deployment placeholders'):
            check.release(resources, image, json.loads((HERE / 'release-inputs.json.example').read_text()))

    def test_filled_template_still_needs_external_confirmations(self):
        image = 'example.invalid/offline-fixture@sha256:' + '1' * 64
        replacements = {'REPLACE_ME_PRIVATE_OWNER': 'synthetic-owner', 'REPLACE_ME_TUNNEL_ID': 'tunnel_' + 'a' * 32,
                        'REPLACE_ME_DEDICATED_STORAGE_CLASS': 'synthetic-only', check.PLACEHOLDER: image}
        text = json.dumps(self.document)
        for key, value in replacements.items():
            text = text.replace(key, value)
        self.document = json.loads(text)
        resources, image = self.structure()
        inputs = {'scope': 'text-only', 'bunImage': 'oven/bun:1.4.2@sha256:' + '2' * 64,
                  'sourceRevision': '3' * 40, 'mcpImage': image}
        with self.assertRaisesRegex(ValueError, 'external confirmation missing: image_build_and_digest_verified'):
            check.release(resources, image, inputs)
        # Synthetic in-memory evidence demonstrates that text approval cannot imply files approval.
        inputs.update(scope='files', confirmations={key: {'confirmed': True, 'evidence': 'synthetic fixture, not acceptance'} for key in check.COMMON_GATES})
        with self.assertRaisesRegex(ValueError, 'profile_safe_backend_plugin_upgrade_verified'):
            check.release(resources, image, inputs)
        inputs['confirmations'].update({key: {'confirmed': True, 'evidence': 'synthetic fixture, not acceptance'} for key in check.FILE_GATES})
        with self.assertRaisesRegex(ValueError, 'files release requires confirmed nonempty attachment origins'):
            check.release(resources, image, inputs)

    def test_security_regressions_rejected(self):
        original = copy.deepcopy(self.document)
        mutations = [
            lambda pod: pod.update(hostNetwork=True),
            lambda pod: pod['securityContext'].update(fsGroup=10000),
            lambda pod: pod['volumes'][0].update(emptyDir={}),
            lambda pod: pod['containers'][0]['volumeMounts'].append({'name': 'tunnel-key', 'mountPath': '/leak'}),
            lambda pod: pod['containers'][1]['env'][0].update(value='tunnel_' + 'b' * 32),
            lambda pod: pod['containers'][0].update(readinessProbe={'httpGet': {'path': '/health', 'port': 8790}}),
        ]
        for mutate in mutations:
            with self.subTest(mutation=mutate):
                self.document = copy.deepcopy(original)
                pod = next(r for r in self.document['items'] if r['kind'] == 'Deployment')['spec']['template']['spec']
                mutate(pod)
                with self.assertRaises(ValueError):
                    self.structure()


if __name__ == '__main__':
    unittest.main()
