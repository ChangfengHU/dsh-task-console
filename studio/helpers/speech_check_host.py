"""Host-only, hash-bound short-utterance coverage check; never a performance verdict.
Expected words remain local and are never included in the model prompt.
Use complete utterance windows <=10 seconds; an uncertain crop must be checked again
with adjacent context rather than silently waiving an unmatched boundary word.
"""
import argparse,difflib,hashlib,json,os,pathlib,sys,unicodedata
from audio_observe_host import credentials,ENDPOINT
from audio_review import payload,observe
from audio_signals import analyze

SPEECH_MAX_SECONDS = 10

def normalize(text):
    if not isinstance(text,str):raise ValueError('Text must be a string')
    return ''.join(c.lower() for c in unicodedata.normalize('NFKC',text) if unicodedata.category(c)[0] in 'LN')

def heard_words(observation):
    raw=observation['observation'].strip()
    if raw.startswith('```'):
        lines=raw.splitlines();raw='\n'.join(lines[1:-1]) if lines[-1]=='```' else raw
    data=json.loads(raw)
    words=data.get('heard_words')
    if isinstance(words,list) and all(isinstance(word,str) for word in words):return ''.join(words)
    if not isinstance(words,str):raise ValueError('Unstructured heard words')
    return words

def compare(audio,expected_text,observation,stage='final',context=None):
    if stage not in ('source','final'):raise ValueError('Invalid stage')
    _,duration=payload(audio,context=context)
    if duration>SPEECH_MAX_SECONDS:raise ValueError(f'Coverage windows must be <={SPEECH_MAX_SECONDS} seconds')
    expected=normalize(expected_text)
    if not expected or len(expected)>400:raise ValueError('Expected speech required, <=400 normalized characters')
    audio_hash=hashlib.sha256(audio).hexdigest()
    if observation.get('audio_sha256')!=audio_hash:raise ValueError('Observation audio hash mismatch')
    if observation.get('input_modality')!='input_audio' or observation.get('finish_reason')!='stop':raise ValueError('Direct completed audio observation required')
    words=heard_words(observation);actual=normalize(words);signals=analyze(audio);issues=[]
    for op,a,b,c,d in difflib.SequenceMatcher(None,expected,actual,autojunk=False).get_opcodes():
        if op!='equal':issues.append({'code':'speech_'+op,'expected':expected[a:b],'observed':actual[c:d],'expected_span':[a,b],'observed_span':[c,d],'status':'unresolved'})
    if signals['peak_dbfs'] is None or any(s['location']=='whole_clip' for s in signals['silence_intervals']):
        issues.append({'code':'no_audible_signal','status':'unresolved'})
    # An internal pause alone is never a missing-speech conclusion.
    # Matching words prove content coverage only, not timing, emotion, or naturalness.
    return {'schema':'studio-speech-coverage-v1','ok':True,'stage':stage,'audio_sha256':audio_hash,'script_sha256':hashlib.sha256(expected.encode()).hexdigest(),'expected_text_sha256':hashlib.sha256(expected_text.encode()).hexdigest(),'source_interval':context,'duration_seconds':duration,'heard_words':words,'expected_normalized':expected,'observed_normalized':actual,'issues':issues,'signals':signals,'content_gate':'blocked' if issues else 'pass','quality_pass':False,'performance_pass':False,'observation':observation,'scope':'short-utterance content only; no whole-film, timing or performance approval'}

def run(path,expected_text,stage='final',start=None,end=None):
    root=pathlib.Path(os.environ['STUDIO_PROJECT_ROOT']).resolve();p=pathlib.Path(path).resolve()
    if root!=p and root not in p.parents:raise ValueError('Audio outside project')
    if not p.is_file() or p.suffix.lower()!='.wav' or p.stat().st_size>5_000_000:raise ValueError('Invalid project WAV')
    stat=p.stat();audio=p.read_bytes()
    if p.stat().st_mtime_ns!=stat.st_mtime_ns or len(audio)!=stat.st_size:raise ValueError('Input changed')
    context=None if start is None and end is None else {'start_seconds':start,'end_seconds':end}
    _,duration=payload(audio,context=context)
    if duration>SPEECH_MAX_SECONDS or not normalize(expected_text) or len(normalize(expected_text))>400 or stage not in ('source','final'):raise ValueError('Invalid coverage input')
    key=credentials()
    try:result=observe(audio,base_url=ENDPOINT,api_key=key,context=context)
    except Exception as e:
        e.stage='provider';raise
    result['credential_reference']='service:qwen'
    return compare(audio,expected_text,result,stage,context)

def main():
    p=argparse.ArgumentParser();p.add_argument('wav');p.add_argument('--expected-text',required=True);p.add_argument('--stage',choices=['source','final'],default='final');p.add_argument('--start-seconds',type=float);p.add_argument('--end-seconds',type=float);a=p.parse_args()
    try:r=run(a.wav,a.expected_text,a.stage,a.start_seconds,a.end_seconds)
    except Exception as e:r={'ok':False,'error_type':type(e).__name__,'http_status':getattr(e,'code',None),'error_stage':getattr(e,'stage','input'),'quality_pass':False,'content_gate':'blocked'}
    print(json.dumps(r,ensure_ascii=False));return 0 if r.get('ok') else 1
if __name__=='__main__':sys.exit(main())
