"""Direct audio observer. Host passes credentials in memory; no retries or PASS verdict."""
import base64, hashlib, io, json, urllib.request, urllib.parse, wave

PROMPT = '''请直接听取附带音频，不能用预期台词猜测。用简短JSON输出 heard_words、delivery（实际语气/停顿/自然度）、music_masking、artifacts、uncertain。只描述可听到的证据；没有听清必须说明，不判整片通过。'''

MEDIA_PROMPT = '''请直接听取附带音频，不根据文件名、预期台词或用途猜测。用简短JSON输出：heard_words（实际听到的原话；无人声为空）、sound_events（实际声源、音色、节奏与片段内大致时间；不能确定来源就描述声音）、music（是否有音乐及可听到的节奏/乐器特征）、delivery（有人说话时的语气、停顿、自然度；无人声为null）、music_masking、artifacts、uncertain。铃声间歇、节奏留白与无声不是自动判坏；只描述本片段可听证据，不判素材适用性或整片通过。'''

def payload(audio, model='qwen3-omni-flash', max_tokens=400, context=None, purpose='speech'):
    with wave.open(io.BytesIO(audio)) as w:
        duration=w.getnframes()/w.getframerate()
        if w.getsampwidth()!=2 or not 0 < duration <= 10: raise ValueError('PCM16 WAV <=10s required')
    if not 1 <= max_tokens <= 400: raise ValueError('output budget')
    if model not in ('qwen3-omni-flash', 'qwen3.8-omni-flash'): raise ValueError('model not reviewed')
    if purpose not in ('speech','media'):raise ValueError('Unknown observation purpose')
    prompt=PROMPT if purpose=='speech' else MEDIA_PROMPT
    if context is not None:
        start=context.get('start_seconds');end=context.get('end_seconds')
        if isinstance(start,bool) or isinstance(end,bool) or not isinstance(start,(int,float)) or not isinstance(end,(int,float)) or not 0 <= start < end or abs((end-start)-duration)>0.05: raise ValueError('Invalid source interval')
        prompt+=('\n这是完整成片的局部提取，源片区间 ' if purpose=='speech' else '\n这是所提供音频的局部提取，源音频区间 ')+str(start)+'–'+str(end)+' 秒。片段首尾可能位于台词中间，不能单凭切片边界判原片截断。仍应检查片段内部声音；不推测未提供区间。'
    result={'model':model,'messages':[{'role':'user','content':[{'type':'input_audio','input_audio':{'data':'data:audio/wav;base64,'+base64.b64encode(audio).decode(),'format':'wav'}},{'type':'text','text':prompt}]}], 'modalities':['text'],'stream':True,'stream_options':{'include_usage':True},'max_tokens':max_tokens}
    if model=='qwen3-omni-flash': result['enable_thinking']=False
    else: result['reasoning_effort']='none'
    return result, duration

def parse_sse(lines):
    text=[]; usage=None; finish=None; done=False; response_model=None
    for line in lines:
        line=line.decode() if isinstance(line,bytes) else line
        if not line.startswith('data:'):continue
        data=line[5:].strip()
        if data=='[DONE]': done=True; break
        item=json.loads(data)
        if item.get('error'):raise RuntimeError('Provider stream error')
        response_model=item.get('model',response_model)
        if item.get('usage'):usage=item['usage']
        for c in item.get('choices',[]):
            text.append(c.get('delta',{}).get('content') or '')
            finish=c.get('finish_reason') or finish
    if not done or finish!='stop' or not ''.join(text).strip():raise RuntimeError('Incomplete audio observation')
    return {'observation':''.join(text),'usage':usage,'response_model':response_model,'finish_reason':finish}

def observe(audio, *, base_url, api_key, model='qwen3-omni-flash', context=None, purpose='speech', opener=urllib.request.urlopen):
    u=urllib.parse.urlsplit(base_url)
    if u.scheme!='https' or u.username or u.password or u.query or u.fragment or not (u.hostname=='dashscope.aliyuncs.com' or (u.hostname or '').endswith('.maas.aliyuncs.com')):raise ValueError('Unexpected credential destination')
    body,duration=payload(audio,model,context=context,purpose=purpose)
    req=urllib.request.Request(base_url.rstrip('/')+'/chat/completions',data=json.dumps(body).encode(),headers={'Authorization':'Bearer '+api_key,'Content-Type':'application/json'})
    with opener(req,timeout=120) as response: result=parse_sse(response)
    return {'schema':'studio-audio-observation-v1','input_modality':'input_audio','audio_sha256':hashlib.sha256(audio).hexdigest(),'duration_seconds':duration,'requested_model':model,'calibrated':False,'quality_pass':False,'source_interval':context,'observer_purpose':purpose,'prompt_sha256':hashlib.sha256(body['messages'][0]['content'][1]['text'].encode()).hexdigest(),**result}
