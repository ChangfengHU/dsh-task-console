"""Prepare pinned, licensed compiler assets inside a host-bound project. No network."""
import argparse,hashlib,json,os,pathlib,stat,uuid
DEFAULT_BUNDLE=pathlib.Path(__file__).parent.parent/'runtime-assets'
MANIFEST_SHA256='6def3bb5e1b27cee45277f72b36c2e34918a698f9da8bcd98a5b3d6cc8e53e8f'
TARGETS={'gsap.min.js':'assets/vendor/gsap.min.js','Chinese.ttf':'assets/Chinese.ttf','GSAP-LICENSE.txt':'assets/licenses/GSAP-LICENSE.txt','DROID-NOTICE.txt':'assets/licenses/DROID-NOTICE.txt','GSAP-STANDARD-LICENSE.html':'assets/licenses/GSAP-STANDARD-LICENSE.html','SOURCES.json':'assets/licenses/SOURCES.json'}
class AssetError(ValueError):pass
def digest(data):return hashlib.sha256(data).hexdigest()
def read_file(fd,name,limit):
 h=os.open(name,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK,dir_fd=fd)
 with os.fdopen(h,'rb') as f:
  st=os.fstat(f.fileno())
  if not stat.S_ISREG(st.st_mode) or not 0<st.st_size<=limit:raise AssetError('runtime-asset-not-regular')
  data=f.read(limit+1)
  if len(data)!=st.st_size:raise AssetError('runtime-asset-changed')
  return data

def directory(path):
 p=pathlib.Path(path).absolute()
 if p.resolve()!=p or not p.is_dir():raise AssetError('runtime-asset-real-directory-required')
 return p,os.open(p,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)

def verified_bundle(bundle=DEFAULT_BUNDLE):
 root,fd=directory(bundle)
 try:
  raw=read_file(fd,'manifest.json',65536)
  if digest(raw)!=MANIFEST_SHA256:raise AssetError('runtime-asset-manifest-mismatch')
  manifest=json.loads(raw)
  if manifest.get('schema')!='studio-runtime-assets-v1' or set(manifest['files'])!=set(TARGETS):raise AssetError('runtime-asset-manifest-invalid')
  content={}
  for name,target in TARGETS.items():
   entry=manifest['files'][name];data=read_file(fd,name,8_000_000)
   if entry['target']!=target or len(data)!=entry['bytes'] or digest(data)!=entry['sha256']:raise AssetError('runtime-asset-hash-mismatch')
   content[target]=data
  if not content[TARGETS['gsap.min.js']].startswith(b'/*!\n * GSAP 3.13.0') or content[TARGETS['Chinese.ttf']][:4]!=b'\x00\x01\x00\x00':raise AssetError('runtime-asset-type-invalid')
  if b'Apache License' not in content[TARGETS['DROID-NOTICE.txt']] or b'Standard "No Charge" GSAP License' not in content[TARGETS['GSAP-LICENSE.txt']]:raise AssetError('runtime-asset-license-invalid')
  content['assets/licenses/runtime-assets-manifest.json']=raw
  return content
 finally:os.close(fd)

def parent_fd(root_fd,target):
 parts=target.split('/');fd=os.dup(root_fd)
 try:
  for part in parts[:-1]:
   try:os.mkdir(part,0o755,dir_fd=fd)
   except FileExistsError:pass
   child=os.open(part,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=fd);os.close(fd);fd=child
  return fd,parts[-1]
 except BaseException:os.close(fd);raise

def prepare_execution_assets(project_root,bundle=DEFAULT_BUNDLE):
 content=verified_bundle(bundle);root,root_fd=directory(project_root);opened=[];created=[];temps=[];records=[]
 try:
  # Check every destination before the first new file. Conflicts never overwrite.
  for target,data in content.items():
   fd,name=parent_fd(root_fd,target);opened.append(fd)
   try:previous=read_file(fd,name,8_000_000)
   except FileNotFoundError:previous=None
   if previous is not None and previous!=data:raise AssetError('runtime-asset-output-conflict')
   records.append({'path':target,'absolutePath':str(root/target),'sha256':digest(data),'bytes':len(data),'reused':previous is not None})
  for (target,data),fd,record in zip(content.items(),opened,records):
   if record['reused']:continue
   name=target.split('/')[-1];tmp='.runtime-'+uuid.uuid4().hex;temps.append((fd,tmp))
   h=os.open(tmp,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o644,dir_fd=fd)
   with os.fdopen(h,'wb') as f:f.write(data);f.flush();os.fsync(f.fileno())
   try:os.link(tmp,name,src_dir_fd=fd,dst_dir_fd=fd,follow_symlinks=False);created.append((fd,name))
   except FileExistsError:
    if read_file(fd,name,8_000_000)!=data:raise AssetError('runtime-asset-output-conflict')
    record['reused']=True
   os.fsync(fd)
  return {'ok':True,'schema':'studio-execution-assets-v1','bundleManifestSha256':MANIFEST_SHA256,'gsap':records[0],'font':records[1],'files':records,'qualityApproved':False,'compilerRuntimeVerified':False}
 except BaseException:
  for fd,name in created:os.unlink(name,dir_fd=fd)
  raise
 finally:
  for fd,name in temps:
   try:os.unlink(name,dir_fd=fd)
   except FileNotFoundError:pass
  for fd in opened:os.close(fd)
  os.close(root_fd)

def main():
 p=argparse.ArgumentParser();p.add_argument('--project-root',required=True);p.add_argument('--bundle',default=str(DEFAULT_BUNDLE));a=p.parse_args()
 try:r=prepare_execution_assets(a.project_root,a.bundle)
 except Exception as e:r={'ok':False,'error_code':str(e) if isinstance(e,AssetError) else 'runtime-assets-prepare-failed','qualityApproved':False}
 print(json.dumps(r));return 0 if r['ok'] else 1
if __name__=='__main__':raise SystemExit(main())
