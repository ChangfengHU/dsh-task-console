"""Host-only WAV observer. Credentials never accepted on command line or printed."""
import argparse,json,os,pathlib,sys,urllib.request,urllib.error
from audio_review import observe,payload
from audio_signals import analyze
from observation_cache import observe_cached, source_fingerprint, digest, encoded

VAULT='https://fleet.vyibc.com/mcp/vault'
ENDPOINT='https://dashscope.aliyuncs.com/compatible-mode/v1'

def audio_observer_model():
    model=os.environ.get('STUDIO_AUDIO_OBSERVER_MODEL','qwen3-omni-flash')
    if model not in ('qwen3-omni-flash','qwen3.8-omni-flash'):raise ValueError('Host audio observer model invalid')
    return model

def _credentials():
    p=pathlib.Path(os.environ['STUDIO_VAULT_TOKEN_FILE']).resolve()
    if not p.is_file() or p.stat().st_mode & 0o077:raise PermissionError('Host token file must be private')
    token=p.read_text().strip()
    req=urllib.request.Request(VAULT,data=json.dumps({'jsonrpc':'2.0','id':1,'method':'tools/call','params':{'name':'vyibc-vault_get_config','arguments':{'key':'service:qwen'}}}).encode(),headers={'User-Agent':'curl/8.0','Authorization':'Bearer '+token,'Content-Type':'application/json','Accept':'application/json, text/event-stream'})
    with urllib.request.urlopen(req,timeout=30) as response:raw=response.read(1_000_000).decode()
    try:data=json.loads(raw)
    except json.JSONDecodeError:data=json.loads(next(x[6:] for x in raw.splitlines() if x.startswith('data: ')))
    obj=json.loads(next(x['text'] for x in data['result']['content'] if x.get('type')=='text'))
    if not obj.get('ok'):raise RuntimeError('Vault lookup failed')
    cfg=obj['value'];cfg=json.loads(cfg) if isinstance(cfg,str) else cfg
    return cfg['DASHSCOPE_API_KEY']

def credentials():
    try:return _credentials()
    except Exception as e:
        e.stage='vault';raise

def transport_diagnostics(error):
    """Class/errno only: exception text and URLs may contain credentials."""
    reason=getattr(error,'reason',error)
    allowed={'gaierror','TimeoutError','ConnectionRefusedError','ConnectionResetError',
             'SSLError','SSLEOFError','SSLCertVerificationError','OSError'}
    name=type(reason).__name__
    result={'reason_type':name} if name in allowed else {}
    number=getattr(reason,'errno',None)
    if name in allowed and isinstance(number,int) and not isinstance(number,bool) and -4096<=number<=4096:
        result['reason_errno']=number
    return result

def run(path,start=None,end=None):
    root=pathlib.Path(os.environ['STUDIO_PROJECT_ROOT']).resolve()
    p=pathlib.Path(path).resolve()
    if not p.is_relative_to(root) or not p.is_file() or p.suffix.lower()!='.wav' or p.stat().st_size>5_000_000:raise ValueError('Invalid project audio')
    stat=p.stat();audio=p.read_bytes()
    if p.stat().st_mtime_ns!=stat.st_mtime_ns or len(audio)!=stat.st_size:raise ValueError('Input changed')
    context=None if start is None and end is None else {'start_seconds':start,'end_seconds':end}
    model=audio_observer_model()
    body,duration=payload(audio,model=model,context=context,purpose='media') # Validate before resolving secrets or charging.
    key=credentials()
    # Resolve current authorization even on a hit. Never store credentials or raw payload.
    here=pathlib.Path(__file__).parent
    signature={'endpoint':ENDPOINT,'credential_reference':'service:qwen',
        'request_sha256':digest(encoded(body)),
        'sources':source_fingerprint([here/name for name in
            ('audio_observe_host.py','audio_review.py','audio_signals.py','observation_cache.py')])}
    def fresh():
        if not p.resolve().is_relative_to(root) or digest(p.read_bytes())!=digest(audio):raise ValueError('Input changed before observation')
        try:result=observe(audio,base_url=ENDPOINT,api_key=key,model=model,context=context,purpose='media')
        except Exception as e:
            e.stage='provider';raise
        signals=analyze(audio)
        return {**result,'signals':signals,'warnings':signals['warnings'],
                'credential_reference':'service:qwen','ok':True}
    def validate(result):
        expected={'input_modality':'input_audio','audio_sha256':digest(audio),
            'duration_seconds':duration,'requested_model':body['model'],
            'source_interval':context,'observer_purpose':'media',
            'prompt_sha256':digest(body['messages'][0]['content'][1]['text'].encode())}
        if any(result.get(k)!=v for k,v in expected.items()):raise ValueError('Audio observation identity mismatch')
        if not isinstance(result.get('observation'),str) or not result['observation'].strip() or key in result['observation']:
            raise ValueError('Audio observation text invalid')
        if not p.resolve().is_relative_to(root) or digest(p.read_bytes())!=digest(audio):raise ValueError('Input changed during observation')
    result=observe_cached(signature,fresh,validate)
    return result

def main():
    p=argparse.ArgumentParser();p.add_argument('wav');p.add_argument('--start-seconds',type=float);p.add_argument('--end-seconds',type=float);a=p.parse_args()
    try:result=run(a.wav,a.start_seconds,a.end_seconds)
    except Exception as e:
        result={'ok':False,'error_type':type(e).__name__,'http_status':getattr(e,'code',None),'error_stage':getattr(e,'stage','input'),'quality_pass':False,**transport_diagnostics(e)}
        # Never print exception strings, provider bodies, paths, request or credentials.
    print(json.dumps(result,ensure_ascii=False));return 0 if result.get('ok') else 1
if __name__=='__main__':sys.exit(main())
