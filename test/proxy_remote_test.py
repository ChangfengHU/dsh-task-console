import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import patch, Mock

spec = importlib.util.spec_from_file_location('proxy_remote', Path(__file__).resolve().parents[1] / 'src/proxy-remote.py')
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)

REQUEST = {'action': 'repair', 'operationId': '11111111-1111-4111-a111-111111111111',
    'operatorMachineId': '00000000000000000000000000000000', 'lineId': 'line-fixture',
    'expectedIp': '203.0.113.10', 'configUrl': 'https://example.invalid/private-fixture'}
SETTINGS = {'expected_ip': REQUEST['expectedIp'], 'config_url': REQUEST['configUrl']}
RAW = {'service_active': True, 'tun_present': True, 'proxy_enabled': True, 'configured': True}


class AdapterTests(unittest.TestCase):
    def operation(self, action='repair'):
        op = m.Operation({**REQUEST, 'action': action})
        op.event = Mock()
        return op

    def setUp(self):
        self.files = patch.object(m, 'root_file', return_value=json.dumps(SETTINGS)); self.files.start()
        self.sleep = patch.object(m.time, 'sleep'); self.sleep.start()

    def tearDown(self):
        self.files.stop(); self.sleep.stop()

    def test_healthy_node_is_reused_without_controller_write(self):
        op = self.operation()
        with patch.object(m, 'controller', return_value=RAW), patch.object(m, 'independent_verify', return_value={'ok': True}):
            op.action = Mock()
            result = op.run()
            self.assertTrue(result['ok']); self.assertTrue(result['reused']); op.action.assert_not_called()

    def test_failed_exit_replaces_then_independently_verifies(self):
        op = self.operation()
        with patch.object(m, 'controller', return_value=RAW), patch.object(m, 'independent_verify', side_effect=[{'ok': False, 'reason': 'proxy-exit-mismatch'}, {'ok': True}]) as verify:
            op.action = Mock(return_value=RAW)
            result = op.run()
            self.assertTrue(result['ok']); self.assertTrue(result['changed']); self.assertEqual(verify.call_count, 2)
            self.assertEqual(op.action.call_args_list[0].args[0], 'replace')

    def test_disabled_node_enables_after_transactional_source_preflight(self):
        op = self.operation(); op.action = Mock(side_effect=[{**RAW, 'proxy_enabled': False}, RAW])
        with patch.object(m, 'controller', return_value=RAW), patch.object(m, 'independent_verify', side_effect=[{'ok': False, 'reason': 'mihomo-inactive'}, {'ok': True}]):
            self.assertTrue(op.run()['ok'])
            self.assertEqual([c.args[0] for c in op.action.call_args_list], ['replace', 'enable'])

    def test_verify_never_repairs_and_stale_config_cannot_pass(self):
        op = self.operation('verify'); op.action = Mock()
        with patch.object(m, 'controller', return_value=RAW), patch.object(m, 'independent_verify', return_value={'ok': False, 'reason': 'proxy-exit-mismatch'}):
            self.assertFalse(op.run()['ok']); op.action.assert_not_called()
        with patch.object(m, 'root_file', return_value=json.dumps({**SETTINGS, 'config_url': 'https://other.invalid'})), patch.object(m, 'controller', return_value=RAW), patch.object(m, 'independent_verify', return_value={'ok': True}):
            self.assertFalse(op.run()['ok']); op.action.assert_not_called()

    def test_auth_failure_does_not_restart_controller(self):
        op = self.operation(); op.recover_controller = Mock()
        with patch.object(m, 'controller', side_effect=m.Refused('controller-request-denied')):
            with self.assertRaisesRegex(m.Refused, 'request-denied'): op.run()
        op.recover_controller.assert_not_called()

    def test_only_not_listening_can_enter_managed_controller_recovery(self):
        op = self.operation(); op.recover_controller = Mock(return_value=RAW)
        with patch.object(m, 'controller', side_effect=[m.Refused('controller-not-listening'), RAW]), patch.object(m, 'independent_verify', return_value={'ok': True}):
            self.assertTrue(op.run()['ok']); op.recover_controller.assert_called_once()
        reader = self.operation('verify'); reader.recover_controller = Mock()
        with patch.object(m, 'controller', side_effect=m.Refused('controller-not-listening')):
            with self.assertRaises(m.Refused): reader.run()
        reader.recover_controller.assert_not_called()

    def test_managed_controller_recovery_only_restarts_exact_known_unit(self):
        op = self.operation()
        unit = '[Service]\nExecStart=/usr/bin/python3 /usr/local/lib/linux-clash-skill/scripts/node_controller.py --port ${CONTROLLER_PORT}\n'
        with patch.object(m.Path, 'exists', return_value=False), patch.object(m, 'root_file', return_value=unit), patch.object(m.subprocess, 'run', return_value=Mock(returncode=0)) as run, patch.object(m, 'controller', return_value=RAW):
            self.assertEqual(op.recover_controller(), RAW)
            self.assertEqual(run.call_args.args[0], ['/usr/bin/systemctl', 'restart', 'linux-clash-node-controller.service'])
        with patch.object(m.Path, 'exists', return_value=False), patch.object(m, 'root_file', return_value='# ' + unit.replace('[Service]\n', '')), patch.object(m.subprocess, 'run') as run:
            with self.assertRaises(m.Refused): op.recover_controller()
            run.assert_not_called()

    def test_self_repair_refuses_before_controller_calls(self):
        op = self.operation(); op.request['operatorMachineId'] = Path('/etc/machine-id').read_text().strip()
        with patch.object(m, 'controller') as controller:
            with self.assertRaisesRegex(m.Refused, 'self-proxy'): op.run()
        controller.assert_not_called()

    def test_lost_post_or_replaced_operation_stays_unknown(self):
        op = self.operation()
        with patch.object(m, 'controller', side_effect=m.Refused('controller-connection-unknown')):
            with self.assertRaises(m.Refused): op.action('replace')
        self.assertTrue(op.uncertain)
        op = self.operation()
        with patch.object(m, 'controller', side_effect=[{'id': 'a'*24}, {'operation': {'id': 'b'*24, 'status': 'succeeded'}}]):
            with self.assertRaisesRegex(m.Refused, 'superseded'): op.action('replace')
        self.assertTrue(op.uncertain)

    def test_busy_post_is_definite_refusal_not_unknown(self):
        op = self.operation()
        with patch.object(m, 'controller', side_effect=m.Refused('controller-busy')):
            with self.assertRaises(m.Refused): op.action('replace')
        self.assertFalse(op.uncertain)

    def test_failed_controller_transaction_is_not_success(self):
        op = self.operation()
        with patch.object(m, 'controller', side_effect=[{'id': 'a'*24}, {'operation': {'id': 'a'*24, 'status': 'failed'}}]):
            with self.assertRaisesRegex(m.Refused, 'transaction-failed'): op.action('replace')
        self.assertFalse(op.uncertain)

    def test_independent_verifier_has_no_timezone_or_proxy_environment_and_rejects_stale_result(self):
        old = {'verified_at': '2020-01-01T00:00:00+00:00', 'tcp_udp_consistent': True, **{k: REQUEST['expectedIp'] for k in m.PATH_FIELDS}}
        with patch.object(m.shutil, 'which', return_value='/usr/bin/fixture'), patch.object(m.subprocess, 'run', return_value=Mock(returncode=0)) as run, patch.object(m, 'read_json', return_value=old):
            result = m.independent_verify(REQUEST['expectedIp'])
            self.assertFalse(result['ok'])
            argv = run.call_args.args[0]; env = run.call_args.kwargs['env']
            self.assertNotIn('--align-timezone', argv)
            self.assertFalse(any('proxy' in key.lower() for key in env))
            self.assertFalse(Path(env['SOP_OUTPUT_DIR']).exists())

    def test_verifier_includes_system_binary_paths_and_missing_tool_never_repairs(self):
        self.assertEqual(m.ENV['PATH'], '/usr/sbin:/usr/bin:/sbin:/bin')
        with patch.object(m.shutil, 'which', return_value=None), patch.object(m.subprocess, 'run') as run:
            result = m.independent_verify(REQUEST['expectedIp'])
            self.assertEqual(result['reason'], 'proxy-verifier-dependency-unavailable')
            run.assert_not_called()
        op = self.operation(); op.action = Mock()
        with patch.object(m, 'controller', return_value=RAW), patch.object(m, 'independent_verify', return_value=result):
            with self.assertRaisesRegex(m.Refused, 'dependency-unavailable'): op.run()
        op.action.assert_not_called()

    def test_snapshot_never_exposes_controller_url_token_or_free_form_message(self):
        secret = 'fixture-secret-not-real'
        raw = {**RAW, 'config_source': secret, 'token': secret, 'last_result': {'generic_exit_ip': secret, 'verified_at': secret}, 'operation': {'message': secret}}
        result = m.snapshot(raw, REQUEST['expectedIp'], True)
        self.assertNotIn(secret, json.dumps(result)); self.assertTrue(result['historicalEvidence']['notCurrentAcceptance'])

    def test_missing_unit_and_pending_controller_transaction_are_not_restarted(self):
        op = self.operation()
        with patch.object(m.Path, 'exists', return_value=True), patch.object(m, 'read_json', return_value={'status': 'running'}), patch.object(m.subprocess, 'run') as run:
            with self.assertRaisesRegex(m.Refused, 'unfinished'): op.recover_controller()
            run.assert_not_called()
        with patch.object(m.Path, 'exists', return_value=False), patch.object(m.subprocess, 'run') as run:
            with self.assertRaisesRegex(m.Refused, 'unit-missing'): op.recover_controller()
            run.assert_not_called()

    def test_missing_or_invalid_verification_is_not_repair_permission(self):
        op = self.operation(); op.action = Mock()
        with patch.object(m, 'controller', return_value=RAW), patch.object(m, 'independent_verify', return_value={'ok': False, 'reason': 'proxy-evidence-invalid'}):
            with self.assertRaisesRegex(m.Refused, 'inconclusive'): op.run()
        op.action.assert_not_called()

    def test_remote_receipt_deduplicates_and_rejects_changed_request(self):
        original_lstat = Path.lstat
        def owned(path):
            info = original_lstat(path)
            return SimpleNamespace(st_uid=0, st_mode=info.st_mode)
        with tempfile.TemporaryDirectory(prefix='proxy-remote-test-') as root, patch.object(m, 'STATE', Path(root)), patch.object(m.Path, 'lstat', owned), patch.object(m, 'root_file', side_effect=lambda p: p.read_text()), patch.object(m, 'emit'), patch.object(m.Operation, 'run', return_value={'ok': True, 'quiescent': True, 'changed': False}) as run:
            first = m.dispatch(dict(REQUEST)); second = m.dispatch(dict(REQUEST))
            self.assertEqual(first, second); self.assertEqual(run.call_count, 1)
            self.assertFalse((Path(root) / 'inflight.json').exists())
            with self.assertRaisesRegex(m.Refused, 'conflict'):
                m.dispatch({**REQUEST, 'expectedIp': '203.0.113.11'})
            self.assertNotIn(REQUEST['configUrl'], (Path(root) / (REQUEST['operationId'] + '.json')).read_text())
            self.assertEqual(m.dispatch({**REQUEST, 'action': 'receipt'}), {**first, 'receiptOperationId': REQUEST['operationId']})
            with self.assertRaisesRegex(m.Refused, 'receipt-owner-mismatch'):
                m.dispatch({**REQUEST, 'action': 'receipt', 'operatorMachineId': 'f' * 32})

    def test_remote_unknown_receipt_keeps_inflight_marker_and_never_replays(self):
        original_lstat = Path.lstat
        def owned(path):
            info = original_lstat(path)
            return SimpleNamespace(st_uid=0, st_mode=info.st_mode)
        def uncertain(operation):
            operation.uncertain = True
            raise m.Refused('controller-connection-unknown')
        with tempfile.TemporaryDirectory(prefix='proxy-remote-test-') as root, patch.object(m, 'STATE', Path(root)), patch.object(m.Path, 'lstat', owned), patch.object(m, 'root_file', side_effect=lambda p: p.read_text()), patch.object(m, 'emit'), patch.object(m.Operation, 'run', uncertain):
            first = m.dispatch(dict(REQUEST))
            self.assertFalse(first['quiescent']); self.assertTrue((Path(root) / 'inflight.json').exists())
            other = m.dispatch({**REQUEST, 'operationId': '22222222-2222-4222-a222-222222222222'})
            self.assertEqual(other['reason'], 'previous-proxy-operation-unresolved')
            self.assertEqual(m.dispatch(dict(REQUEST)), first)

    def test_absent_read_can_be_negatively_fenced_but_missing_repair_cannot(self):
        original_lstat = Path.lstat
        def owned(path):
            info = original_lstat(path)
            return SimpleNamespace(st_uid=0, st_mode=info.st_mode)
        with tempfile.TemporaryDirectory(prefix='proxy-remote-test-') as root, patch.object(m, 'STATE', Path(root)), patch.object(m.Path, 'lstat', owned), patch.object(m, 'root_file', side_effect=lambda p: p.read_text()), patch.object(m.Operation, 'run') as run:
            receipt = {**REQUEST, 'action': 'receipt'}
            self.assertFalse(m.dispatch({**receipt, 'receiptAction': 'repair'})['quiescent'])
            result = m.dispatch({**receipt, 'receiptAction': 'verify'})
            self.assertFalse(result['ok']); self.assertTrue(result['quiescent'])
            self.assertEqual(result['receiptOperationId'], REQUEST['operationId'])
            self.assertEqual(result['reason'], 'verification-unrecorded-and-fenced')
            # A delayed original reader sees this exact tombstone, not a new run.
            self.assertEqual(m.dispatch({**REQUEST, 'action': 'verify'})['reason'], result['reason'])
            run.assert_not_called()

    def test_absent_read_cannot_be_fenced_over_an_inflight_marker_or_active_lock(self):
        original_lstat = Path.lstat
        def owned(path):
            info = original_lstat(path)
            return SimpleNamespace(st_uid=0, st_mode=info.st_mode)
        with tempfile.TemporaryDirectory(prefix='proxy-remote-test-') as root, patch.object(m, 'STATE', Path(root)), patch.object(m.Path, 'lstat', owned):
            marker = Path(root) / 'inflight.json'; marker.write_text('{}')
            receipt = {**REQUEST, 'action': 'receipt', 'receiptAction': 'verify'}
            self.assertFalse(m.dispatch(receipt)['quiescent'])
            self.assertTrue(marker.exists()); marker.unlink()
            with patch.object(m.fcntl, 'flock', side_effect=BlockingIOError()):
                self.assertFalse(m.dispatch(receipt)['quiescent'])
            self.assertFalse((Path(root) / (REQUEST['operationId'] + '.json')).exists())


if __name__ == '__main__': unittest.main()
