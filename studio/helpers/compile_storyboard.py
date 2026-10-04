"""Compile a local, structured storyboard into seekable HyperFrames HTML.
No model calls, arbitrary JS/CSS, synthesis, upload or aesthetic approval.
"""
import argparse, hashlib, html, json, math, os, pathlib, re, shutil, subprocess, tempfile

VERSION='studio-board-v1'
def shape(value,required,optional,label):
 if not isinstance(value,dict): raise ValueError(label+'-must-be-object')
 missing=set(required)-value.keys();unknown=value.keys()-set(required)-set(optional)
 if missing: raise ValueError(label+'-missing-fields:'+','.join(sorted(missing)))
 if unknown: raise ValueError(label+'-unsupported-fields:'+','.join(k if re.fullmatch(r'[A-Za-z_][A-Za-z0-9_]{0,63}',k) else '<non-schema-key>' for k in sorted(unknown)[:32]))
def sha(p): return hashlib.sha256(p.read_bytes()).hexdigest()
def number(v,lo,hi,name):
 if isinstance(v,bool) or not isinstance(v,(int,float)) or not math.isfinite(v) or not lo<=v<=hi: raise ValueError('invalid-'+name)
 return v
def local(root,value):
 if not isinstance(value,str) or pathlib.Path(value).is_absolute(): raise ValueError('relative-source-required')
 p=(root/value).resolve(strict=True)
 if root not in p.parents or not p.is_file(): raise ValueError('source-outside-project')
 return p

def validate_planning_metadata(board):
 """Optional width/height, scriptSha256, scene id/title/purpose and visualRequirements.
 Retained in board.json only; declarations are not rendered or considered fulfilled assets.
 The host separately binds script lines to its frozen record; this checks their supplied digest.
 """
 for key,expected in [('width',1080),('height',1920)]:
  if key in board: number(board[key],expected,expected,key)
 def text(value,field):
  if not isinstance(value,str) or not value.strip(): raise ValueError('invalid-planning-metadata:'+field+' requires nonempty text')
 if 'scriptSha256' in board:
  lines=board.get('script')
  if not isinstance(lines,list) or not lines: raise ValueError('scriptSha256-requires-frozen-lines')
  ids=set();ordered=[]
  for line in lines:
   shape(line,['id','text'],[],'script-line');text(line['id'],'script.id');text(line['text'],'script.text')
   if line['id'] in ids: raise ValueError('scriptSha256-duplicate-line-id')
   ids.add(line['id']);ordered.append({'id':line['id'],'text':line['text']})
  digest=hashlib.sha256(json.dumps(ordered,ensure_ascii=False,separators=(',',':')).encode('utf-8')).hexdigest()
  if board['scriptSha256']!=digest: raise ValueError('scriptSha256-mismatch: use the exact ordered frozen id/text lines')
 scenes=board.get('scenes');ids=set()
 if not isinstance(scenes,list): raise ValueError('invalid-scenes')
 for i,scene in enumerate(scenes):
  if not isinstance(scene,dict): raise ValueError('scene-must-be-object')
  for key in ['id','title','purpose']:
   if key in scene:text(scene[key],f'scenes[{i}].{key}')
  if 'id' in scene:
   if scene['id'] in ids:raise ValueError('duplicate-scene-id')
   ids.add(scene['id'])
 if 'visualRequirements' in board:
  if not scenes or any('id' not in scene for scene in scenes):raise ValueError('visualRequirements-requires-scene-ids')
  items=board['visualRequirements'];requirement_ids=set();covered=set()
  if not isinstance(items,list) or not 1<=len(items)<=200:raise ValueError('invalid-visualRequirements')
  for i,item in enumerate(items):
   shape(item,['id','sceneId','purpose'],[],f'visualRequirements[{i}]')
   for key in ['id','sceneId','purpose']:text(item[key],f'visualRequirements[{i}].{key}')
   if item['id'] in requirement_ids:raise ValueError('duplicate-visualRequirements-id')
   if item['sceneId'] not in ids:raise ValueError('visualRequirements-unknown-scene')
   requirement_ids.add(item['id']);covered.add(item['sceneId'])
  if covered!=ids:raise ValueError('visualRequirements-missing-scene')

def compile_board(root,board,out):
 root=pathlib.Path(root).resolve(strict=True);out=(root/out).resolve()
 if root not in out.parents or out.exists(): raise ValueError('new-project-subdirectory-required')
 shape(board,['schema','duration','gsap','font','script','scenes','audio'],['fps','background','notes','width','height','scriptSha256','visualRequirements'],'board')
 if board.get('schema')!=VERSION: raise ValueError('unsupported-schema')
 validate_planning_metadata(board)
 duration=number(board['duration'],1,180,'duration');fps=number(board.get('fps',30),30,30,'fps')
 records={};media={}
 def source(value,kind):
  p=local(root,value);h=sha(p);suffix=p.suffix.lower()
  allowed={'image':{'.png','.jpg','.jpeg','.webp'},'audio':{'.wav','.mp3','.m4a'},'font':{'.ttf','.otf'},'script':{'.js'}}
  if suffix not in allowed[kind]: raise ValueError('invalid-'+kind+'-source')
  name=('gsap-' if kind=='script' else '')+h+suffix
  records[value]={'sha256':h,'bytes':p.stat().st_size,'kind':kind,'file':'assets/'+name};media[name]=p
  return records[value]['file']
 gsap=source(board['gsap'],'script');font=source(board['font'],'font')
 # Caller supplies the project's deployed GSAP, not arbitrary inline script.
 if 'gsap' not in local(root,board['gsap']).name.lower(): raise ValueError('gsap-runtime-required')
 color=board.get('background','#ffffff')
 if not re.fullmatch(r'#[0-9a-fA-F]{6}',color): raise ValueError('invalid-background')
 nodes=[];commands=[];speech=[];cursor=0;count=0
 scenes=board['scenes']
 if not isinstance(scenes,list) or not 1<=len(scenes)<=60: raise ValueError('invalid-scenes')
 def transforms(d):
  bounds={'x':(-2160,2160),'y':(-3840,3840),'scale':(.01,5),'rotation':(-360,360),'opacity':(0,1)}
  if not isinstance(d,dict) or not d or set(d)-set(bounds): raise ValueError('invalid-transform')
  return {k:number(v,*bounds[k],k) for k,v in d.items()}
 for si,s in enumerate(scenes):
  shape(s,['start','duration','layers'],['notes','id','title','purpose'],'scene')
  start=number(s['start'],0,duration,'scene-start');length=number(s['duration'],.1,duration,'scene-duration')
  if abs(start-cursor)>.001 or start+length>duration+.001:
   raise ValueError(f'scene-gap-overlap-or-overrun: scenes[{si}] start={start:g}, previousEnd={cursor:g}, end={start+length:g}, board.duration={duration:g}; calculate cumulative times programmatically')
  cursor=start+length;layers=s['layers']
  if not isinstance(layers,list) or not layers: raise ValueError('empty-scene')
  # Report the malformed field before subject semantics; otherwise an invented
  # tags array hides the actionable error behind "no visible subject".
  for li,l in enumerate(layers):
   try:
    shape(l,['type','width','height'],['x','y','src','text','role','fontSize','fit','initial','motion','notes'],'layer')
    required=['src'] if l['type']=='image' else ['text'] if l['type']=='text' else []
    absent=[k for k in required if k not in l]
    if absent: raise ValueError('layer-missing-fields:'+','.join(absent))
   except ValueError as e:
    hint='; use a direct role property, e.g. "role":"character", not tags' if isinstance(l,dict) and 'tags' in l else ''
    raise ValueError(f'scenes[{si}].layers[{li}]:{e}'+hint) from None
  if not any(l.get('type')=='image' and l.get('role') in ('character','subject') for l in layers): raise ValueError(f'scenes[{si}]:scene-requires-visible-subject; an image layer needs direct role="character" or role="subject"')
  nodes.append(f'<section id="scene-{si}" class="clip scene" data-start="{start}" data-duration="{length}" data-track-index="{si}">')
  for li,l in enumerate(layers):
   count+=1
   if count>800: raise ValueError('too-many-layers')
   ident=f'layer-{si}-{li}';x=number(l.get('x',0),-2160,2160,'x');y=number(l.get('y',0),-3840,3840,'y')
   w=number(l['width'],1,4320,'width');h=number(l['height'],1,7680,'height')
   if x+w<=0 or x>=1080 or y+h<=0 or y>=1920: raise ValueError('initial-layer-offscreen')
   style=f'position:absolute;left:{x}px;top:{y}px;width:{w}px;height:{h}px;'
   if l['type']=='image':
    src=source(l['src'],'image');fit=l.get('fit','contain')
    if fit not in ('contain','cover'): raise ValueError('invalid-fit')
    nodes.append(f'<img id="{ident}" src="{src}" style="{style}object-fit:{fit}" />')
   elif l['type']=='text':
    text=l['text'];size=number(l.get('fontSize',48),18,160,'font-size')
    if not isinstance(text,str) or len(text)>400: raise ValueError('invalid-text')
    nodes.append(f'<div id="{ident}" style="{style}font-size:{size}px;white-space:pre-wrap">{html.escape(text)}</div>')
   else: raise ValueError('unsupported-layer')
   initial=transforms(l.get('initial',{'x':0,'y':0,'scale':1,'rotation':0,'opacity':1}))
   commands.append(f'tl.set("#{ident}",{json.dumps(initial)},0);')
   last=0
   for motion in l.get('motion',[]):
    shape(motion,['at','duration','to'],['ease'],'motion')
    at=number(motion['at'],0,length,'motion-at');span=number(motion['duration'],.001,length,'motion-duration')
    if at<last-.001 or at+span>length+.001: raise ValueError('overlapping-or-outside-motion')
    last=at+span;v=transforms(motion['to']);ease=motion.get('ease','none')
    if ease not in ('none','power1.inOut','power2.out','sine.inOut'): raise ValueError('unsupported-ease')
    v.update(duration=span,ease=ease);commands.append(f'tl.to("#{ident}",{json.dumps(v)},{start+at});')
  nodes.append('</section>')
 if abs(cursor-duration)>.001: raise ValueError(f'scene-coverage-incomplete: finalEnd={cursor:g}, board.duration={duration:g}')
 tracks=board['audio']
 if not isinstance(tracks,list) or not tracks or len(tracks)>200: raise ValueError('audio-required')
 ids=set();voice_end=0
 for i,a in enumerate(tracks):
  shape(a,['src','role','start'],['trimStart','duration','volume','fadeOut','lineId','text','notes'],f'audio[{i}]')
  if a['role']=='voice':
   absent=[k for k in ('lineId','text') if k not in a]
   if absent: raise ValueError(f'audio[{i}]:voice-missing-fields:'+','.join(absent)+'; copy the exact frozen script line ID and text into the voice track')
  src=source(a['src'],'audio');p=local(root,a['src'])
  probe=json.loads(subprocess.check_output([os.environ.get('FFPROBE_PATH') or 'ffprobe','-v','error','-show_format','-show_streams','-of','json',str(p)],timeout=30))
  if not any(x.get('codec_type')=='audio' for x in probe['streams']): raise ValueError('audio-stream-required')
  actual=float(probe['format']['duration']);start=number(a['start'],0,duration,'audio-start');trim=number(a.get('trimStart',0),0,actual,'trim')
  length=number(a.get('duration',actual-trim),.01,actual,'audio-duration');gain=number(a.get('volume',1),0,2,'volume')
  if trim+length>actual+.025 or start+length>duration+.025:
   raise ValueError(f"audio-overrun: audio[{i}] role={a['role']} src={a['src']!r}, start={start:g}, length={length:g}, trimStart={trim:g}, sourceDuration={actual:g}, end={start+length:g}, board.duration={duration:g}; set an explicit duration for music/sfx, preserve complete voice sources")
  if a['role'] not in ('voice','music','sfx'): raise ValueError('invalid-audio-role')
  if a['role']=='voice':
   if abs(trim)>.001 or abs(length-actual)>.025 or gain<=0: raise ValueError('voice-must-use-complete-source')
   if start<voice_end-.001: raise ValueError(f'voice-overlap: audio[{i}] start={start:g}, previousVoiceEnd={voice_end:g}; use actual ffprobe durations')
   voice_end=start+length
   line=a['lineId'];text=a['text']
   if not isinstance(line,str) or not line or line in ids or not isinstance(text,str) or not text.strip(): raise ValueError('unique-line-and-text-required')
   ids.add(line);speech.append({'id':line,'text':text,'start':start,'end':start+length,'sourcePath':a['src']})
   nodes.append(f'<div id="caption-{i}" class="clip caption" data-start="{start}" data-duration="{length}" data-track-index="90">{html.escape(text)}</div>')
  nodes.append(f'<audio id="audio-{i}" class="clip" src="{src}" data-start="{start}" data-duration="{length}" data-media-start="{trim}" data-volume="{gain}" data-track-index="{100+i}"></audio>')
  fade=number(a.get('fadeOut',0),0,length,'fade-out')
  if fade and gain>1: raise ValueError('fade-volume-must-not-exceed-one-use-premixed-gain')
  if fade:
   commands.append(f'tl.set("#audio-{i}",{{volume:{gain}}},0);tl.to("#audio-{i}",{{volume:0,duration:{fade},ease:"none"}},{start+length-fade});')
 if not speech: raise ValueError('voice-required')
 if board.get('script')!=[{'id':v['id'],'text':v['text']} for v in speech]: raise ValueError('script-voice-coverage-mismatch')
 content=f'''<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><script src="{gsap}"></script><style>
 @font-face{{font-family:Studio;src:url('{font}')}}html,body{{margin:0;background:{color}}}#root{{position:relative;width:1080px;height:1920px;overflow:hidden;font-family:Studio,sans-serif;color:#252525}}.scene{{position:absolute;inset:0;overflow:hidden}}.caption{{position:absolute;left:70px;bottom:160px;width:940px;box-sizing:border-box;padding:16px 24px;background:rgba(255,255,255,.94);color:#222;border-radius:20px;text-align:center;font-size:48px;line-height:1.35;z-index:100}}
 </style></head><body><div id="root" data-composition-id="main" data-start="0" data-width="1080" data-height="1920" data-duration="{duration}">{''.join(nodes)}</div><script>const tl=gsap.timeline({{paused:true}});{''.join(commands)}window.__timelines["main"]=tl;</script></body></html>'''
 # Validate everything before creating output; preserve originals and other revisions.
 out.parent.mkdir(parents=True,exist_ok=True)
 stage=pathlib.Path(tempfile.mkdtemp(prefix='.board-',dir=out.parent))
 try:
  (stage/'assets').mkdir()
  for name,p in media.items():
   data=p.read_bytes()
   if hashlib.sha256(data).hexdigest()!=name.removeprefix('gsap-').split('.')[0]: raise ValueError('source-changed-during-compile')
   (stage/'assets'/name).write_bytes(data)
  (stage/'index.html').write_text(content)
  (stage/'board.json').write_text(json.dumps(board,ensure_ascii=False,indent=2))
  (stage/'speech-plan.json').write_text(json.dumps(speech,ensure_ascii=False,indent=2))
  receipt={'schema':VERSION,'duration':duration,'fps':fps,'assets':records,'qualityApproved':False,'indexSha256':sha(stage/'index.html')}
  (stage/'compile-receipt.json').write_text(json.dumps(receipt,ensure_ascii=False,indent=2))
  stage.rename(out)
 finally:
  if stage.exists(): shutil.rmtree(stage)
 return {'ok':True,'composition':str(out),'qualityApproved':False,'indexSha256':receipt['indexSha256']}

if __name__=='__main__':
 p=argparse.ArgumentParser();p.add_argument('--project-root',required=True);p.add_argument('--board',required=True);p.add_argument('--output',required=True);a=p.parse_args()
 try:
  root=pathlib.Path(a.project_root).resolve(strict=True);board=local(root,a.board)
  if board.stat().st_size>2_000_000: raise ValueError('board-too-large')
  print(json.dumps(compile_board(root,json.loads(board.read_text()),a.output)))
 except Exception as e:
  print(json.dumps({'ok':False,'errorType':type(e).__name__,'reason':str(e)[:200],'qualityApproved':False}));raise SystemExit(1)
