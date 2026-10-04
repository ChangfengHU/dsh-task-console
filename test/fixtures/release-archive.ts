import {execFileSync} from 'node:child_process'
import {createHash} from 'node:crypto'
export function releaseArchive(mode='valid'){
 const commit='a'.repeat(40)
 const bytes=execFileSync('python3',['-I','-c',String.raw`
import sys,io,tarfile,json,hashlib,gzip
mode=sys.argv[1];commit='a'*40
files={'LICENSE':b'fixture license','SOURCE_REVISION':((('b'*40) if mode=='revision' else commit)+'\n').encode()}
manifest={k:hashlib.sha256(v).hexdigest() for k,v in files.items()}
if mode=='member':files['LICENSE']=b'changed bytes'
files['DEPLOY_MANIFEST.json']=json.dumps(manifest).encode()
buf=io.BytesIO()
with tarfile.open(fileobj=buf,mode='w') as tf:
 for name,data in files.items():
  info=tarfile.TarInfo(name);info.size=len(data);tf.addfile(info,io.BytesIO(data))
 if mode=='duplicate':
  info=tarfile.TarInfo('LICENSE');info.size=1;tf.addfile(info,io.BytesIO(b'x'))
 if mode=='traversal':
  info=tarfile.TarInfo('safe/../escape');tf.addfile(info)
 if mode=='link':
  info=tarfile.TarInfo('link');info.type=tarfile.SYMTYPE;info.linkname='LICENSE';tf.addfile(info)
sys.stdout.buffer.write(gzip.compress(buf.getvalue(),mtime=0))
`,mode])
 return {bytes,policy:{archive:'candidate.tgz',archiveSha256:createHash('sha256').update(bytes).digest('hex'),commit}}
}
