"""Run-bound dependency preflight and project-local Git setup. No quality approval is issued."""
import hashlib,json,os,pathlib,re,shutil,subprocess,sys,time,urllib.request,urllib.parse,urllib.error,socket,ssl

from prepare_execution_assets import prepare_execution_assets
from download_existing_asset import MCP_URL, proxy_token

NETWORK_EVENTS=[]
def retry_read(label,fn):
    """Retry idempotent reads once on transport failure; never hide denial or bad data."""
    for attempt in (1,2):
        try:
            value=fn()
            NETWORK_EVENTS.append({'operation':label,'attempt':attempt,'ok':True})
            return value
        except Exception as e:
            status=getattr(e,'code',None)
            reason=e.reason if isinstance(e,urllib.error.URLError) else e
            transient=(isinstance(e,urllib.error.HTTPError) and status in (502,503,504,520,522,524)) or (not isinstance(e,urllib.error.HTTPError) and isinstance(reason,(TimeoutError,socket.timeout,ConnectionError,socket.gaierror)))
            if isinstance(reason,ssl.SSLError):transient=False
            NETWORK_EVENTS.append({'operation':label,'attempt':attempt,'ok':False,'error_type':type(e).__name__,'http_status':status,'retrying':transient and attempt==1})
            if not transient or attempt==2:raise
            time.sleep(1)

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self,*args,**kwargs):raise ValueError('Redirect forbidden')
OPENER=urllib.request.build_opener(NoRedirect)

def safe_url(url):
    p=urllib.parse.urlsplit(url)
    if p.scheme!='https' or p.hostname!='cdn.vyibc.com' or p.username or p.password or p.query or p.fragment or p.port not in (None,443):raise ValueError('Unapproved reference URL')
    return url

def digest(path):
    h=hashlib.sha256()
    with open(path,'rb') as f:
        for b in iter(lambda:f.read(1024*1024),b''):h.update(b)
    return h.hexdigest()

def download(url,path,limit=300_000_000):
    safe_url(url)
    tmp=path.with_suffix(path.suffix+'.partial')
    def fetch():
        with OPENER.open(urllib.request.Request(url,headers={'User-Agent':'curl/8.0'}),timeout=60) as r,open(tmp,'wb') as f:
            n=0
            while True:
                b=r.read(1024*1024)
                if not b:break
                n+=len(b)
                if n>limit:raise ValueError('Download exceeds limit')
                f.write(b)
        tmp.replace(path)
    try:
        retry_read('reference_download',fetch)
    finally:
        if tmp.exists():tmp.unlink()

def asset_auth():
    reference=os.environ.get('STUDIO_ASSET_TOKEN_FILE')
    if reference:
        if not pathlib.Path(reference).is_absolute():raise ValueError('Host asset credential path invalid')
        # A bridge credential is accepted only at the fixed assets bootstrap.
        # Invalid explicit references fail closed; no Vault-token substitution.
        return MCP_URL,'Bearer '+proxy_token(reference)
    # Read only the installed server stanza; never export full configuration.
    p=pathlib.Path(os.environ.get('STUDIO_DSH_PROFILE','/home/claude/.dsh/profiles/web/cordis.patch.yml'))
    s=p.read_text();m=re.search(r'(?m)^    - id: mcp-vyibc-cartoon-assets\s*\n(.*?)(?=^    - id:|\Z)',s,re.S)
    if not m:raise ValueError('Installed cartoon-assets server missing')
    block=m.group(1)
    u=re.search(r'(?m)^\s+url:\s*(\S+)\s*$',block)
    a=re.search(r'(?m)^\s+Authorization:\s*(.+)\s*$',block)
    if not u or not a:raise ValueError('Installed server credential missing')
    url=u.group(1).strip('"\'');auth=a.group(1).strip().strip('"\'')
    if url!='https://fleet.vyibc.com/api/hub/plugin-bootstrap/mcp/vyibc-cartoon-assets' or not auth.startswith('Bearer '):raise ValueError('Installed transport unsupported')
    return url,auth

def rpc(name,args):
    url,auth=asset_auth()
    req=urllib.request.Request(url,data=json.dumps({'jsonrpc':'2.0','id':1,'method':'tools/call','params':{'name':name,'arguments':args}}).encode(),headers={'User-Agent':'curl/8.0','Authorization':auth,'Content-Type':'application/json','Accept':'application/json, text/event-stream'})
    def fetch():
        with OPENER.open(req,timeout=45) as r:return r.read(4_000_000).decode()
    raw=retry_read('mcp_'+name,fetch)
    try:d=json.loads(raw)
    except json.JSONDecodeError:d=json.loads(next(x[6:] for x in raw.splitlines() if x.startswith('data: ')))
    if d.get('error'):raise ValueError('MCP protocol error')
    d=d['result']
    if d.get('isError'):raise ValueError('MCP tool failed')
    if 'content' in d:d=json.loads(next(x['text'] for x in d['content'] if x.get('type')=='text'))
    if d.get('ok') is False:raise ValueError('MCP rejected lookup')
    return d

def run_cmd(args,timeout=90):
    r=subprocess.run(args,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=timeout)
    if r.returncode:raise RuntimeError('Media command failed')
    return r.stdout

def write(path,value):
    path.write_text(json.dumps(value,ensure_ascii=False,indent=2));return str(path)

def ensure_project_git(root):
    """Project-only automation identity; preserve an existing effective identity."""
    root=pathlib.Path(root).resolve()
    def git(*args,allow_missing=False):
        r=subprocess.run(['git','-C',str(root),*args],stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=15)
        if r.returncode and not (allow_missing and r.returncode==1):raise RuntimeError('Project Git setup failed')
        return r.stdout.decode().strip()
    marker=root/'.git'
    if marker.is_symlink():raise ValueError('Project Git symlink forbidden')
    if not marker.exists():git('init')
    if pathlib.Path(git('rev-parse','--show-toplevel')).resolve()!=root:raise ValueError('Dedicated project repository required')
    for key,value in [('user.name','DSH Studio Agent'),('user.email','studio-agent@users.noreply.local')]:
        if not git('config','--get',key,allow_missing=True):git('config','--local',key,value)
    git('var','GIT_AUTHOR_IDENT')
    return {'scope':'project_local_git','identity_ready':True,'push_configured':bool(git('remote')),'automatic_push':False}

def verify_smoke_pixels(early,late):
    """Decoded video evidence: a moving yellow block and a font-loaded green badge."""
    def sample(raw):
        if len(raw)!=108*192*3:raise ValueError('Smoke frame dimensions invalid')
        badge=raw[(5*108+5)*3:(5*108+5)*3+3]
        if not (badge[1]>140 and badge[0]<100 and badge[2]<140):raise ValueError('Smoke font load not verified')
        xs=[]
        for y in range(30,40):
            for x in range(108):
                r,g,b=raw[(y*108+x)*3:(y*108+x)*3+3]
                if r>180 and g>120 and b<130:xs.append(x)
        if len(xs)<50:raise ValueError('Smoke animated block missing')
        return sum(xs)/len(xs)
    first,last=sample(early),sample(late)
    if last-first<30:raise ValueError('Smoke GSAP timeline did not advance')
    return {'firstCenterX':first,'lastCenterX':last,'decodedWidth':108,'timeline_verified':True,'font_loaded_verified':True}

def render_hyperframes_smoke(root,out,runtime,ffmpeg,assets):
    if assets.get('ok') is not True:raise ValueError('Execution assets unavailable')
    smoke=out/'hyperframes-smoke';smoke.mkdir(exist_ok=True)
    for name,key in [('gsap.min.js','gsap'),('Chinese.ttf','font')]:
        source=pathlib.Path(assets[key]['absolutePath'])
        if digest(source)!=assets[key]['sha256']:raise ValueError('Execution asset changed')
        shutil.copyfile(source,smoke/name)
    (smoke/'index.html').write_text('''<!doctype html><html><head><style>
    @font-face{font-family:StudioProbe;src:url('Chinese.ttf')}html,body{margin:0;background:#24354b}
    #root{position:relative;width:1080px;height:1920px}#dot{position:absolute;left:100px;top:300px;width:100px;height:100px;background:#ffcc55}
    #font-ready{position:absolute;left:20px;top:20px;width:80px;height:80px;background:#ff0000}
    #chinese{position:absolute;left:80px;top:600px;font-family:StudioProbe;font-size:60px;color:white}
    </style></head><body><div id="root" data-composition-id="smoke" data-width="1080" data-height="1920" data-duration="1"><div id="dot"></div><div id="font-ready"></div><div id="chinese">中文字体动作测试</div></div>
    <script src="gsap.min.js"></script><script>
    window.__timelines={smoke:gsap.timeline({paused:true}).to('#dot',{x:600,duration:1,ease:'none'})};
    document.fonts.load('60px StudioProbe','中文字体动作测试').then(fonts=>{if(fonts.length&&fonts.every(f=>f.status==='loaded'))document.getElementById('font-ready').style.background='#00ff00'});
    </script></body></html>''')
    binary=runtime/'node_modules/hyperframes/bin/hyperframes.mjs'
    env=dict(os.environ);env['FFMPEG_PATH']=ffmpeg;env['PATH']=str(pathlib.Path(ffmpeg).parent)+os.pathsep+env.get('PATH','')
    if env.get('STUDIO_CHROME_EXECUTABLE'):env['PUPPETEER_EXECUTABLE_PATH']=env['STUDIO_CHROME_EXECUTABLE']
    else:env.setdefault('PUPPETEER_EXECUTABLE_PATH','/usr/bin/google-chrome')
    target=smoke/'smoke.mp4'
    completed=subprocess.run([os.environ.get('STUDIO_NODE_EXECUTABLE','/usr/bin/node'),str(binary),'render','--quality','draft','--output',str(target)],cwd=str(smoke),env=env,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=180)
    (smoke/'render.log').write_bytes(completed.stdout+completed.stderr)
    if completed.returncode or not target.is_file():raise RuntimeError('HyperFrames render failed')
    run_cmd([ffmpeg,'-v','error','-i',str(target),'-f','null','-'])
    samples=[run_cmd([ffmpeg,'-v','error','-ss',str(t),'-i',str(target),'-frames:v','1','-vf','scale=108:192','-pix_fmt','rgb24','-f','rawvideo','-']) for t in (.1,.8)]
    verification=verify_smoke_pixels(*samples)
    return {'scope':'actual_hyperframes_smoke_render','path':str(target),'sha256':digest(target),'hyperframes_verified':True,'runtimeAssetsManifestSha256':assets['bundleManifestSha256'],**verification,'quality_pass':False}

def run(task):
    NETWORK_EVENTS.clear()
    cfg=task.get('design',{}).get('studio',task.get('studio',task));root=pathlib.Path(task['cwd'])
    if not root.is_absolute():raise ValueError('Absolute project path required')
    root=root.resolve()
    if not root.is_absolute() or str(root) in ('/','/home/claude'):raise ValueError('Dedicated project required')
    root.mkdir(parents=True,exist_ok=True);out=root/'.studio-host';out.mkdir(mode=0o700,exist_ok=True)
    if out.is_symlink() or out.resolve().parent!=root or any(p.is_symlink() for p in out.rglob('*')):raise ValueError('Invalid evidence directory')
    result={'ok':False,'capabilities':{},'errors':[],'quality_pass':False,'checkedAt':time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime())}
    def check(key,fn):
        try:
            data=fn();data['ok']=True;data['proofPath']=write(out/(key+'-proof.json'),data);result['capabilities'][key]=data
        except Exception as e:
            data={'ok':False,'error_type':type(e).__name__,'http_status':getattr(e,'code',None)};data['proofPath']=write(out/(key+'-proof.json'),data);result['capabilities'][key]=data;result['errors'].append(key)
    check('project_git',lambda:ensure_project_git(root))
    check('execution_assets',lambda:prepare_execution_assets(root))
    def character():
        p=rpc('character_get',{'character_id':cfg['characterId']})
        if p.get('character_id')!=cfg['characterId'] or not p.get('profile'):raise ValueError('Character not found')
        path=out/'character.json';write(path,p)
        a=rpc('asset_get',{'id':p['profile_asset_id']});asset=a['asset'];image=out/'character-reference.png'
        source_url=safe_url(asset['source_url'])
        if asset.get('id') is not None and asset['id']!=p['profile_asset_id']:raise ValueError('Character asset identity mismatch')
        download(source_url,image,20_000_000)
        if digest(image)!=asset['object']['sha256']:raise ValueError('Character image hash mismatch')
        recommendation=p.get('voice_recommendation')
        if recommendation is not None and not isinstance(recommendation,dict):raise ValueError('Invalid character voice recommendation')
        # A missing recommendation is legitimate catalogue metadata, not an
        # approved or selected voice. Preserve None rather than invent a default.
        voice=recommendation.get('voice_id') if recommendation is not None else None
        return {'scope':'actual_character_get','characterId':p['character_id'],'profileVersion':p.get('profile_version'),'profileAssetId':p.get('profile_asset_id'),'profilePath':str(path),'imagePath':str(image),'imageSha256':digest(image),'sourceUrl':source_url,'sourceSha256':digest(image),'sha256':digest(path),'voice':voice,'note':'Profile design-only plans are not generated assets.'}
    def reference():
        sha=cfg['referenceSha256']
        if not re.fullmatch('[a-f0-9]{64}',sha):raise ValueError('Invalid hash')
        url=safe_url(cfg['referenceUrl']);path=out/'reference.mp4'
        if not path.exists() or digest(path)!=sha:download(url,path)
        actual=digest(path)
        if actual!=sha:raise ValueError('Reference hash mismatch')
        return {'scope':'download_sha256','path':str(path),'sha256':actual,'url':url}
    check('character',character);check('reference',reference)
    runtime=pathlib.Path(os.environ.get('STUDIO_RENDER_RUNTIME','/home/claude/dsh-studio-migration/render-runtime'))
    ffmpeg=os.environ.get('FFMPEG_PATH') or str(runtime/'node_modules/ffmpeg-static/ffmpeg')
    probe=os.environ.get('FFPROBE_PATH') or shutil.which('ffprobe')
    def frames():
        if not result['capabilities']['reference']['ok']:raise ValueError('Reference unavailable')
        ref=out/'reference.mp4';image=out/'reference-frame.jpg'
        run_cmd([ffmpeg,'-v','error','-y','-ss','1','-i',str(ref),'-frames:v','1',str(image)])
        meta=json.loads(run_cmd([probe,'-v','error','-show_format','-show_streams','-of','json',str(ref)])) if probe else {'ffprobe_available':False}
        return {'scope':'actual_ffmpeg_frame_decode','path':str(image),'sha256':digest(image),'probe':meta,'perceptual_review':False}
    def render():
        # A real encode/decode, explicitly not a HyperFrames/browser proof.
        path=out/'render-smoke.mp4'
        run_cmd([ffmpeg,'-v','error','-y','-f','lavfi','-i','color=c=0x24354b:s=1080x1920:r=30','-t','0.5','-an','-c:v','libx264','-preset','ultrafast','-pix_fmt','yuv420p',str(path)])
        run_cmd([ffmpeg,'-v','error','-i',str(path),'-f','null','-'])
        return {'scope':'actual_ffmpeg_encode_decode_only','path':str(path),'sha256':digest(path),'hyperframes_verified':False,'quality_pass':False}
    check('frames',frames);check('render',render)
    def hyperframes():
        return render_hyperframes_smoke(root,out,runtime,ffmpeg,result['capabilities']['execution_assets'])
    check('hyperframes',hyperframes)
    result['networkAttempts']=list(NETWORK_EVENTS)
    result['ok']=all(x['ok'] for x in result['capabilities'].values());result['proofPath']=str(out/'preflight.json');write(out/'preflight.json',result)
    return result

def main():
    try:result=run(json.load(sys.stdin))
    except Exception as e:result={'ok':False,'error_type':type(e).__name__,'quality_pass':False}
    print(json.dumps(result,ensure_ascii=False));return 0 if result['ok'] else 1
if __name__=='__main__':sys.exit(main())
