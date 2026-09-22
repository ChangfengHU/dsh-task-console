"""Read-only acceptance of a no-candidate retirement report and its sent outbox.

Requires the explicit database, session log and Batch; never calls Fleet APIs.
"""
import argparse
import json
import sqlite3
import subprocess
from pathlib import Path

p = argparse.ArgumentParser()
p.add_argument('--db', required=True)
p.add_argument('--session-log', required=True)
p.add_argument('--batch', required=True)
a = p.parse_args()
events = [json.loads(line) for line in subprocess.check_output(
    ['zstd', '-dc', a.session_log], text=True).splitlines()]
observations = []
for event in events:
    if event.get('type') != 'tool/result':
        continue
    for result in event.get('data', {}).get('message', {}).get('content', []):
        for content in result.get('content', []):
            if content.get('type') != 'text':
                continue
            try:
                value = json.loads(content['text'])
            except (ValueError, KeyError):
                continue
            if isinstance(value, dict) and 'candidates' in value and 'deferred' in value:
                assert not result.get('isError') and value.get('ok') is True
                observations.append(value)
assert len(observations) == 1, 'Expected exactly one discovery response'
snapshot = observations[0]
assert snapshot['candidates'] == [], 'This smoke test requires the no-candidate case'
db = sqlite3.connect(Path(a.db).resolve().as_uri() + '?mode=ro', uri=True)
db.row_factory = sqlite3.Row
runs = db.execute('SELECT task_id,status,summary FROM task_runs WHERE task_id IN (?,?)',
                  (a.batch + '#0', a.batch + '#1')).fetchall()
assert len(runs) == 2 and all(r['status'] == 'done' for r in runs), 'Both roles must finish'
summary = next(r['summary'] for r in runs if r['task_id'] == a.batch + '#0')
counts = {'在线': 0, '不可达': 0, '未知': 0}
for node in snapshot['deferred']:
    reach = node.get('reachability', {})
    state = {'reachable': '在线', 'unreachable': '不可达'}.get(reach.get('state'), '未知') if reach.get('fresh') is True else '未知'
    counts[state] += 1
    lines = [line for line in summary.splitlines() if line.startswith(node.get('ip') or node['id'])]
    assert len(lines) == 1, 'Missing or duplicated node: ' + node['id']
    line = lines[0]
    assert state in line, 'Wrong state: ' + node['id']
    if state != '未知':
        seconds = reach['onlineSeconds' if state == '在线' else 'offlineSeconds']
        assert str(seconds) in line and str(reach['lastObservedAt']) in line, 'Wrong observation: ' + node['id']
    assert reach.get('reason', '') in line
rows = db.execute('SELECT state,attempts,markdown FROM dsh_task_notifications WHERE batch_id=?', (a.batch,)).fetchall()
assert len(rows) == 1 and rows[0]['state'] == 'sent' and rows[0]['attempts'] == 1
assert summary in rows[0]['markdown'], 'Sent report differs from the frozen summary'
assert '/runs/' + a.batch + '/report' in rows[0]['markdown'], 'Missing report link'
print(json.dumps({'batch': a.batch, 'checked': len(snapshot['deferred']), 'states': counts,
                  'candidates': 0, 'notification': 'sent', 'verifiedRawObservations': True}, ensure_ascii=False))
