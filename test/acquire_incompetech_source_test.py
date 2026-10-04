"""Offline packaged-helper regression; fixtures are NOT acquisition evidence.

No media, network, credentials, or mutation of the packaged helper. The catalog
row preserves the public no-uuid shape observed on 2026-10-03; marker documents
are explicit unit fixtures, not author receipts.
"""
import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

LIVE_HELPERS = Path(__file__).resolve().parents[1] / 'studio' / 'helpers'
AUX_HELPER = LIVE_HELPERS / 'acquire_incompetech_source.py'
sys.path.insert(0, str(LIVE_HELPERS))


def load_module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


aux = load_module('source_acquisition_auxiliary_under_test', AUX_HELPER)
ISRC = 'USUAN1400011'
TITLE = 'Monkeys Spinning Monkeys'
# Exact public row content observed from pieces.json; no uuid is fabricated.
PUBLIC_ROW = {
    'title': TITLE, 'filename': 'Monkeys Spinning Monkeys.mp3', 'length': '00:02:05',
    'instruments': 'Flutes, Violin, Viola, Cello', 'genre': '22', 'bpm': '144',
    'description': 'Loopable happy light fluffy piece with bright flutes and a bunch of pizzicato strings.',
    'feel': 'Bouncy, Bright, Humorous, Uplifting', 'uploaded': '2014-02-03', 'isrc': ISRC,
    'collection': '34', 'sheetmusic': 'Monkeys Spinning Monkeys - Piano Solo.pdf',
    'video': 'https://youtu.be/2eZVbrO6Z1M', 'itunes': None, 'filmmusicURL': None,
}
TRACK_URL = aux.BASE + 'index.html?isrc=' + ISRC
CATALOG_URL = aux.BASE + 'pieces.json'
LICENSE_URL = aux.BASE + 'licenses/'
# Deliberately minimal test-only marker text; never persisted as live evidence.
TRACK_FIXTURE = '\n'.join([
    "fetch('pieces.json')", 'track.isrc === isrcToFind', '${encodeURIComponent(p.filename)}',
    'Attribution Code', '"${escapeHtml(p.title || \'\')}" Kevin MacLeod (incompetech.com)',
    'Licensed under Creative Commons: By Attribution 4.0 License',
    'http://creativecommons.org/licenses/by/4.0/',
]).encode()
LICENSE_FIXTURE = '\n'.join([
    'No charge. Requires that you credit the music.', 'function renderCC(titles)',
    'Kevin MacLeod (incompetech.com)', 'Licensed under Creative Commons: By Attribution 4.0',
    'http://creativecommons.org/licenses/by/4.0/',
]).encode()


class SourceAcquisitionCompatibilityTest(unittest.TestCase):
    def setUp(self):
        self.info = {'asset': {
            'id': 'a' * 64, 'kind': 'bgm', 'object': None, 'author': 'Kevin MacLeod',
            'title': TITLE, 'isrc': ISRC, 'source_url': TRACK_URL,
            'license': {'status': 'not_verified_for_new_project', 'archive_allowed': False,
                        'scope': 'source card; verify license and project scope before use'},
        }, 'download': None}
        self.use = {
            'purpose': 'video_soundtrack', 'platforms': ['test-only private preview'],
            'attributionWillBeIncluded': True, 'platformAllowsAttribution': True,
            'noAdditionalRestrictions': True,
            'changesDescription': 'Test fixture: excerpted and mixed beneath dialogue.',
        }
        self.rows = [copy.deepcopy(PUBLIC_ROW)]
        self.requests = []
        self.track = TRACK_FIXTURE
        self.license = LICENSE_FIXTURE
        self.catalog = None

    def fetch(self, url, limit, deadline):
        self.requests.append(url)
        values = {TRACK_URL: self.track,
                  CATALOG_URL: self.catalog if self.catalog is not None else json.dumps(self.rows).encode(),
                  LICENSE_URL: self.license}
        if url not in values:
            raise AssertionError('Unexpected request; this test must never fetch media: ' + url)
        self.assertGreater(deadline, time.monotonic())
        self.assertLessEqual(len(values[url]), limit)
        return values[url]

    def resolve(self, module=aux):
        return module.resolve_source_card(self.info, self.use, fetch=self.fetch)

    def reject(self, code, operation=None):
        with self.assertRaises(aux.SourceError) as caught:
            (operation or self.resolve)()
        self.assertEqual(caught.exception.code, code)

    def test_actual_no_uuid_catalog_shape_resolves_exact_identity(self):
        self.assertNotIn('uuid', self.rows[0])
        before = copy.deepcopy((self.info, self.use, self.rows))
        receipt = self.resolve()
        self.assertEqual(receipt['isrc'], ISRC)
        self.assertEqual(receipt['title'], TITLE)
        self.assertEqual(receipt['downloadUrl'], aux.BASE + 'mp3-royaltyfree/Monkeys%20Spinning%20Monkeys.mp3')
        self.assertEqual(self.requests, [TRACK_URL, CATALOG_URL, LICENSE_URL])
        self.assertEqual((self.info, self.use, self.rows), before)
        self.assertEqual(receipt['sourceCardRights'], self.info['asset']['license'])
        self.assertTrue(receipt['sourceCardRightsUnchanged'])
        self.assertFalse(receipt['archivePermissionGranted'])
        self.assertFalse(receipt['platformTermsIndependentlyVerified'])
        self.assertFalse(receipt['qualityApproved'])
        self.assertIn('Kevin MacLeod', receipt['attribution'])

    def test_legacy_row_with_uuid_still_resolves(self):
        self.rows[0]['uuid'] = ISRC
        self.assertEqual(self.resolve()['isrc'], ISRC)

    def test_original_test_evidence_bytes_are_hashed_without_substitution(self):
        self.catalog = json.dumps(self.rows, ensure_ascii=False, indent=2).encode()
        receipt = self.resolve()
        for evidence, raw in zip(receipt['evidence'], [self.track, self.catalog, self.license]):
            self.assertEqual(evidence['sha256'], hashlib.sha256(raw).hexdigest())
            self.assertEqual(evidence['bytes'], len(raw))
        self.assertNotIn('uuid', json.loads(self.catalog)[0])

    def test_wrong_catalog_title_rejected(self):
        self.rows[0]['title'] = TITLE + ' (different recording)'
        self.reject('source_identity_mismatch')

    def test_wrong_source_card_title_rejected(self):
        self.info['asset']['title'] = 'Wrong track'
        self.reject('source_identity_mismatch')

    def test_wrong_catalog_isrc_rejected(self):
        self.rows[0]['isrc'] = 'USUAN1400012'
        self.reject('source_catalog_identity_ambiguous')

    def test_wrong_source_card_isrc_rejected_before_fetch(self):
        self.info['asset']['isrc'] = 'USUAN1400012'
        self.reject('source_identity_mismatch')
        self.assertEqual(self.requests, [])

    def test_duplicate_exact_isrc_rejected(self):
        self.rows.append(copy.deepcopy(self.rows[0]))
        self.reject('source_catalog_identity_ambiguous')

    def test_invalid_filename_rejected(self):
        for filename in ['../Monkeys.mp3', 'folder/Monkeys.mp3', 'https://evil.test/a.mp3',
                         'Monkeys%2fSpinning.mp3', 'Monkeys.mp3?token=x', 'Monkeys..mp3',
                         'Monkeys\\Spinning.mp3', 'Monkeys.mp3\x00', '', None]:
            with self.subTest(filename=filename):
                self.rows[0]['filename'] = filename
                self.reject('source_filename_invalid')

    def test_wrong_source_host_rejected_before_fetch(self):
        for url in ['http://incompetech.com/music/royalty-free/index.html?isrc=' + ISRC,
                    'https://evil.test/music/royalty-free/index.html?isrc=' + ISRC,
                    'https://incompetech.com.evil.test/music/royalty-free/index.html?isrc=' + ISRC,
                    'https://user@incompetech.com/music/royalty-free/index.html?isrc=' + ISRC]:
            with self.subTest(url=url):
                self.info['asset']['source_url'] = url
                self.reject('source_track_url_invalid')
        self.assertEqual(self.requests, [])

    def test_public_fetch_host_guard_prevents_network(self):
        with patch.object(aux.urllib.request, 'build_opener', side_effect=AssertionError('Network must not run')):
            for url in ['http://incompetech.com/music/royalty-free/pieces.json',
                        'https://evil.test/music/royalty-free/pieces.json',
                        'https://incompetech.com:443/music/royalty-free/pieces.json',
                        'https://incompetech.com/private/pieces.json',
                        'https://incompetech.com/music/royalty-free/pieces.json#changed']:
                with self.subTest(url=url):
                    self.reject('source_host_denied', lambda: aux.public_fetch(url, 100, time.monotonic() + 10))

    def test_redirect_is_still_denied(self):
        self.reject('source_redirect_denied', lambda: aux.NoRedirect().redirect_request(None, None, None, None, None, None))

    def test_author_template_change_rejected(self):
        self.track = TRACK_FIXTURE.replace(b'Attribution Code', b'Attribution removed')
        self.reject('source_license_evidence_unverified')

    def test_license_template_change_rejected(self):
        self.license = LICENSE_FIXTURE.replace(b'No charge. Requires that you credit the music.', b'Unverified')
        self.reject('source_license_evidence_unverified')

    def test_private_rights_rejected_before_fetch(self):
        for key, value in [('status', 'user_authorized_private_reference'),
                           ('publication', 'not_for_publication'), ('scope', 'private_reference_only')]:
            with self.subTest(key=key):
                original = copy.deepcopy(self.info['asset']['license'])
                self.info['asset']['license'][key] = value
                self.reject('source_rights_restricted')
                self.info['asset']['license'] = original
        self.assertEqual(self.requests, [])

    def test_unconfirmed_attribution_platform_or_restrictions_rejected(self):
        for key in ['attributionWillBeIncluded', 'platformAllowsAttribution', 'noAdditionalRestrictions']:
            with self.subTest(key=key):
                self.use[key] = False
                self.reject('project_license_requirements_unconfirmed')
                self.use[key] = True
        self.assertEqual(self.requests, [])

    def test_project_usage_fields_remain_required(self):
        for key, value, code in [('platforms', [], 'project_platforms_unspecified'),
                                 ('changesDescription', '', 'project_changes_unspecified'),
                                 ('purpose', 'unrelated', 'project_use_unspecified')]:
            with self.subTest(key=key):
                original = self.use[key]
                self.use[key] = value
                self.reject(code)
                self.use[key] = original
        self.assertEqual(self.requests, [])

    def test_wrong_author_rejected(self):
        self.info['asset']['author'] = 'Different author'
        self.reject('source_author_unverified')
        self.assertEqual(self.requests, [])

    def test_archived_asset_is_not_reinterpreted_as_source_card(self):
        self.info['asset']['object'] = {'sha256': 'b' * 64}
        self.reject('source_card_required')
        self.assertEqual(self.requests, [])

    def test_output_boundary_is_checked_before_any_fetch(self):
        from download_existing_asset import DownloadError
        with tempfile.TemporaryDirectory(prefix='source-acquisition-offline-') as raw:
            root = Path(raw).resolve()
            for output in ['../escape.mp3', '/tmp/escape.mp3', 'audio.wav', 'folder\\escape.mp3']:
                with self.subTest(output=output):
                    with self.assertRaises(DownloadError):
                        aux.acquire_source_card(self.info, root, output, self.use, fetch=self.fetch)
            self.assertEqual(list(root.iterdir()), [])
        self.assertEqual(self.requests, [])


if __name__ == '__main__':
    unittest.main()
