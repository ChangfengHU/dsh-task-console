"""Bounded public source-card acquisition; no credentials, catalog writes or quality verdict."""
import copy, hashlib, json, math, os, re, stat, subprocess, time, urllib.parse, urllib.request, uuid
from download_existing_asset import output_parts, open_parent
BASE = 'https://incompetech.com/music/royalty-free/'
MAX_AUDIO = 20_000_000
class SourceError(ValueError):
    def __init__(self, code):
        super().__init__(code); self.code = code

def fail(code): raise SourceError(code)
def sha(data): return hashlib.sha256(data).hexdigest()
class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs): fail('source_redirect_denied')

def public_fetch(url, max_bytes, deadline):
    parsed=urllib.parse.urlsplit(url)
    if parsed.scheme!='https' or parsed.netloc!='incompetech.com' or parsed.fragment or not parsed.path.startswith('/music/royalty-free/'):
        fail('source_host_denied')
    remaining=deadline-time.monotonic()
    if remaining<=0: fail('source_deadline')
    req=urllib.request.Request(url,headers={'User-Agent':'curl/8.0','Accept-Encoding':'identity'})
    chunks=[];total=0
    with urllib.request.build_opener(NoRedirect()).open(req,timeout=min(15,remaining)) as response:
        if response.status!=200: fail('source_http_status')
        while True:
            if time.monotonic()>=deadline: fail('source_deadline')
            chunk=response.read(min(65536,max_bytes+1-total))
            if not chunk: break
            chunks.append(chunk);total+=len(chunk)
            if total>max_bytes: fail('source_size_limit')
    if time.monotonic()>=deadline: fail('source_deadline')
    return b''.join(chunks)

def _get(fetch,url,limit,deadline):
    data=fetch(url,limit,deadline)
    if not isinstance(data,bytes) or not data or len(data)>limit: fail('source_size_limit')
    if time.monotonic()>=deadline: fail('source_deadline')
    return data

def _validate(info, project_use):
    asset=info.get('asset',{}) if isinstance(info,dict) else {}
    if asset.get('kind')!='bgm' or asset.get('object') is not None or info.get('download') is not None: fail('source_card_required')
    if not re.fullmatch(r'(?:[a-f0-9]{64}|[a-f0-9]{32}-[a-f0-9]{64})',str(asset.get('id',''))): fail('source_identity_invalid')
    rights=asset.get('license') or {}
    if rights.get('status')=='user_authorized_private_reference' or rights.get('publication')=='not_for_publication' or rights.get('scope')=='private_reference_only': fail('source_rights_restricted')
    if asset.get('author')!='Kevin MacLeod': fail('source_author_unverified')
    u=urllib.parse.urlsplit(str(asset.get('source_url','')))
    if u.scheme!='https' or u.netloc!='incompetech.com' or u.path!='/music/royalty-free/index.html' or u.fragment: fail('source_track_url_invalid')
    q=urllib.parse.parse_qs(u.query,strict_parsing=True)
    if set(q)!={'isrc'} or len(q['isrc'])!=1 or not re.fullmatch(r'USUAN[0-9]{7}',q['isrc'][0]): fail('source_isrc_invalid')
    isrc=q['isrc'][0]
    if asset.get('isrc',isrc)!=isrc: fail('source_identity_mismatch')
    use=copy.deepcopy(project_use)
    if not isinstance(use,dict) or set(use)!={'purpose','platforms','attributionWillBeIncluded','platformAllowsAttribution','noAdditionalRestrictions','changesDescription'} or use.get('purpose')!='video_soundtrack': fail('project_use_unspecified')
    platforms=use.get('platforms')
    if not isinstance(platforms,list) or not 1<=len(platforms)<=10 or any(not isinstance(p,str) or not p.strip() or len(p)>160 for p in platforms): fail('project_platforms_unspecified')
    if any(use.get(k) is not True for k in ('attributionWillBeIncluded','platformAllowsAttribution','noAdditionalRestrictions')): fail('project_license_requirements_unconfirmed')
    if not isinstance(use.get('changesDescription'),str) or not use['changesDescription'].strip() or len(use['changesDescription'])>1000: fail('project_changes_unspecified')
    return asset,isrc,use,BASE+'index.html?isrc='+isrc

def _resolve(info, project_use, fetch, deadline):
    asset,isrc,use,track_url=_validate(info,project_use)
    track=_get(fetch,track_url,1_000_000,deadline);catalog=_get(fetch,BASE+'pieces.json',4_000_000,deadline);license_page=_get(fetch,BASE+'licenses/',1_000_000,deadline)
    try:
        rows=json.loads(catalog);t=track.decode('utf-8');lic=license_page.decode('utf-8')
        matches=[r for r in rows if isinstance(r,dict) and r.get('isrc')==isrc]
    except (ValueError,UnicodeError,TypeError): fail('source_evidence_invalid')
    if len(matches)!=1: fail('source_catalog_identity_ambiguous')
    row=matches[0];title=row.get('title');filename=row.get('filename')
    # The official catalog identifies tracks by isrc; uuid is not a required field.
    # Keep the unique exact ISRC match above and the exact source-card title below.
    if not isinstance(title,str) or title!=asset.get('title'): fail('source_identity_mismatch')
    if not isinstance(filename,str) or not re.fullmatch(r'[A-Za-z0-9 ()_.,&\-]{1,180}\.mp3',filename) or '..' in filename: fail('source_filename_invalid')
    # Fail closed if the official attribution/download template changes. Candidate CC URLs alone do not pass.
    track_markers=["fetch('pieces.json')","track.isrc === isrcToFind",'${encodeURIComponent(p.filename)}','Attribution Code','"${escapeHtml(p.title || \'\')}" Kevin MacLeod (incompetech.com)','Licensed under Creative Commons: By Attribution 4.0 License','http://creativecommons.org/licenses/by/4.0/']
    license_markers=['No charge. Requires that you credit the music.','function renderCC(titles)','Kevin MacLeod (incompetech.com)','Licensed under Creative Commons: By Attribution 4.0','http://creativecommons.org/licenses/by/4.0/']
    if any(m not in t for m in track_markers) or any(m not in lic for m in license_markers): fail('source_license_evidence_unverified')
    attribution='"'+title+'" Kevin MacLeod (incompetech.com)\nLicensed under Creative Commons: By Attribution 4.0 License\nhttp://creativecommons.org/licenses/by/4.0/'
    return {'schema':'studio-public-source-v1','assetId':asset['id'],'kind':'bgm','isrc':isrc,'title':title,'author':'Kevin MacLeod','sourceCardRights':copy.deepcopy(asset.get('license')),'sourceCardRightsUnchanged':True,'archivePermissionGranted':False,'projectUse':use,'projectUseBasis':'official_track_CC_BY_4.0_with_caller_declared_attribution_and_platform_requirements','platformTermsIndependentlyVerified':False,'attribution':attribution,'changesNotice':use['changesDescription'],'licenseUrl':'https://creativecommons.org/licenses/by/4.0/','downloadUrl':BASE+'mp3-royaltyfree/'+urllib.parse.quote(filename,safe=''),'evidence':[{'url':url,'sha256':sha(data),'bytes':len(data)} for url,data in [(track_url,track),(BASE+'pieces.json',catalog),(BASE+'licenses/',license_page)]],'retrievedAtUnix':time.time(),'qualityApproved':False}

def resolve_source_card(info, project_use, *, fetch=public_fetch):
    return _resolve(info,project_use,fetch,time.monotonic()+60)

def verify_mp3(data):
    if not (data.startswith(b'ID3') or len(data)>1 and data[0]==255 and data[1]&224==224): fail('source_not_mp3')
    try:
        p=subprocess.run([os.environ.get('FFPROBE_PATH') or 'ffprobe','-v','error','-f','mp3','-i','pipe:0','-show_entries','stream=codec_name,codec_type','-of','json'],input=data,capture_output=True,timeout=20)
        streams=json.loads(p.stdout).get('streams',[])
        if p.returncode or len(streams)!=1 or streams[0].get('codec_name')!='mp3' or streams[0].get('codec_type')!='audio': fail('source_not_mp3')
        p=subprocess.run([os.environ.get('FFMPEG_PATH') or 'ffmpeg','-nostdin','-v','error','-xerror','-f','mp3','-i','pipe:0','-progress','pipe:1','-nostats','-f','null','-'],input=data,capture_output=True,timeout=30)
        if p.returncode: fail('source_audio_decode_failed')
        durations=re.findall(rb'(?m)^out_time_us=(\d+)$',p.stdout)
        if not durations or int(durations[-1])<=0: fail('source_audio_duration_unverified')
        return {'codec':'mp3','durationSeconds':int(durations[-1])/1_000_000,'measurement':'ffmpeg_full_decode_out_time'}
    except (OSError,ValueError,subprocess.TimeoutExpired): fail('source_audio_probe_failed')

def _result(receipt, receipt_bytes, reused):
    return {'ok':True,'assetId':receipt['assetId'],'kind':'bgm','path':receipt['path'],'sha256':receipt['sha256'],'bytes':receipt['bytes'],'reused':reused,'newGeneration':0,'qualityApproved':False,'receiptPath':receipt['path']+'.source.json','receiptSha256':sha(receipt_bytes),'sourceAcquisition':receipt}

def _read_regular(fd,name,limit):
    handle=os.open(name,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK,dir_fd=fd)
    with os.fdopen(handle,'rb') as f:
        st=os.fstat(f.fileno())
        if not stat.S_ISREG(st.st_mode) or not 0<st.st_size<=limit: fail('source_existing_unverified')
        data=f.read(limit+1)
        if len(data)!=st.st_size: fail('source_existing_unverified')
        return data

def _reuse(info,project_use,root,parts):
    asset,isrc,use,track_url=_validate(info,project_use)
    fd=open_parent(root,parts)
    try:
        present=[]
        for name in (parts[-1],parts[-1]+'.source.json'):
            try: os.stat(name,dir_fd=fd,follow_symlinks=False);present.append(True)
            except FileNotFoundError: present.append(False)
        if not any(present): return None
        if not all(present): fail('source_existing_unverified')
        try:
            data=_read_regular(fd,parts[-1],MAX_AUDIO);raw=_read_regular(fd,parts[-1]+'.source.json',65536);r=json.loads(raw)
            expected={'schema':'studio-public-source-v1','assetId':asset['id'],'kind':'bgm','isrc':isrc,'title':asset['title'],'author':'Kevin MacLeod','sourceCardRights':asset.get('license'),'sourceCardRightsUnchanged':True,'archivePermissionGranted':False,'projectUse':use,'projectUseBasis':'official_track_CC_BY_4.0_with_caller_declared_attribution_and_platform_requirements','platformTermsIndependentlyVerified':False,'changesNotice':use['changesDescription'],'licenseUrl':'https://creativecommons.org/licenses/by/4.0/','qualityApproved':False,'path':str(root.joinpath(*parts)),'sha256':sha(data),'bytes':len(data),'audioDecodeVerified':True,'newGeneration':0,'attribution':'"'+asset['title']+'" Kevin MacLeod (incompetech.com)\nLicensed under Creative Commons: By Attribution 4.0 License\nhttp://creativecommons.org/licenses/by/4.0/'}
            if any(type(r.get(k)) is not type(v) or r.get(k)!=v for k,v in expected.items()): fail('source_existing_unverified')
            ev=r.get('evidence')
            if not isinstance(ev,list) or len(ev)!=3: fail('source_existing_unverified')
            for item,url,limit in zip(ev,[track_url,BASE+'pieces.json',BASE+'licenses/'],[1_000_000,4_000_000,1_000_000]):
                if not isinstance(item,dict) or set(item)!={'url','sha256','bytes'} or item['url']!=url or not re.fullmatch('[a-f0-9]{64}',str(item['sha256'])) or type(item['bytes']) is not int or not 0<item['bytes']<=limit: fail('source_existing_unverified')
            url=r.get('downloadUrl','');prefix=BASE+'mp3-royaltyfree/'
            if not isinstance(url,str) or not url.startswith(prefix): fail('source_existing_unverified')
            filename=urllib.parse.unquote(url[len(prefix):])
            if not re.fullmatch(r'[A-Za-z0-9 ()_.,&\-]{1,180}\.mp3',filename) or '..' in filename or prefix+urllib.parse.quote(filename,safe='')!=url: fail('source_existing_unverified')
            tech=r.get('technical',{});duration=tech.get('durationSeconds')
            if tech.get('codec')!='mp3' or tech.get('measurement')!='ffmpeg_full_decode_out_time' or type(duration) not in (int,float) or not math.isfinite(duration) or duration<=0: fail('source_existing_unverified')
            if type(r.get('retrievedAtUnix')) not in (int,float) or not math.isfinite(r['retrievedAtUnix']) or r['retrievedAtUnix']<=0: fail('source_existing_unverified')
            if verify_mp3(data)!=tech: fail('source_existing_unverified')
            return _result(r,raw,True)
        except (OSError,ValueError,KeyError,TypeError,AttributeError): fail('source_existing_unverified')
    finally: os.close(fd)

def acquire_source_card(info, root, output, project_use, *, fetch=public_fetch):
    # Validate filesystem boundary before network. Caller must supply its host-bound stage root.
    root,parts=output_parts(root,output,'.mp3')
    reused=_reuse(info,project_use,root,parts)
    if reused is not None: return reused
    receipt=_resolve(info,project_use,fetch,time.monotonic()+60)
    data=_get(fetch,receipt['downloadUrl'],MAX_AUDIO,time.monotonic()+60);technical=verify_mp3(data)
    receipt['technical']=technical
    receipt.update({'path':str(root.joinpath(*parts)),'sha256':sha(data),'bytes':len(data),'audioDecodeVerified':True,'newGeneration':0})
    receipt_bytes=(json.dumps(receipt,ensure_ascii=False,indent=2)+'\n').encode()
    fd=open_parent(root,parts);created=[];temps=[]
    try:
        # Both final names are no-overwrite. Roll back our links if sidecar commit fails.
        for name in (parts[-1],parts[-1]+'.source.json'):
            try: os.stat(name,dir_fd=fd,follow_symlinks=False)
            except FileNotFoundError: continue
            fail('source_output_exists')
        for name,content in [(parts[-1],data),(parts[-1]+'.source.json',receipt_bytes)]:
            tmp='.source-'+uuid.uuid4().hex;temps.append(tmp)
            f=os.open(tmp,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600,dir_fd=fd)
            with os.fdopen(f,'wb') as stream: stream.write(content);stream.flush();os.fsync(stream.fileno())
            os.link(tmp,name,src_dir_fd=fd,dst_dir_fd=fd,follow_symlinks=False);created.append(name)
        os.fsync(fd)
    except BaseException:
        for name in created: os.unlink(name,dir_fd=fd)
        raise
    finally:
        for name in temps:
            try: os.unlink(name,dir_fd=fd)
            except FileNotFoundError: pass
        os.close(fd)
    return _result(receipt,receipt_bytes,False)

def safe_failure(error):
    return {'ok':False,'error_code':error.code if isinstance(error,SourceError) else 'source_acquisition_failed','nextAction':'Verify exact source identity, official permission and project requirements, or select another licensed source. Never substitute silence.','qualityApproved':False}
