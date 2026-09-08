/** Private Batch input bridge. Only an active installer binding may resolve it. */
import Database from 'better-sqlite3'
import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'
import type { CredentialLease } from './fleet-onboard-tools.ts'

export async function taskCredential(ip: string, sessionId: string, root = join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'task-console')): Promise<CredentialLease> {
  const absent = { available: false }
  if (!sessionId.startsWith('task-')) return absent
  let db: Database.Database | undefined
  try {
    db = new Database(join(root, 'task.db'), { readonly: true, fileMustExist: true })
    const binding = db.prepare(`SELECT c.batch_id FROM dsh_run_bindings b
      JOIN task_runs r ON r.id = b.core_run_id JOIN tasks t ON t.id = r.task_id
      JOIN dsh_card_bindings c ON c.card_id = t.id
      WHERE b.session_id = ? AND t.assignee = 'fleet-installer' AND t.current_run_id = r.id
      AND r.status = 'running' AND t.status = 'running'`).get(sessionId) as { batch_id: string } | undefined
    if (!binding || !/^b-chat-[a-f0-9]{20}$/.test(binding.batch_id)) return absent
    const path = join(root, 'private-inputs', `${binding.batch_id}.json`)
    const info = await stat(path)
    if (!info.isFile() || (info.mode & 0o077) || info.uid !== process.getuid?.()) return absent
    const value = JSON.parse(await readFile(path, 'utf8'))
    const credential = value.expiresAt > Date.now() && value.credentials?.find((c: any) => c.ip === ip)
    return credential ? { available: true, source: 'intake', material: Buffer.from(JSON.stringify(credential)) } : absent
  } catch { return absent } finally { db?.close() }
}
