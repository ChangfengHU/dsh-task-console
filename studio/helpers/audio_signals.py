"""Deterministic PCM16 observations, never semantic quality verdicts."""
import array,io,math,sys,wave

def dbfs(value):
    return 20*math.log10(value) if value>0 else None

def analyze(audio, silence_dbfs=-55.0, min_silence_seconds=.35, window_seconds=.02, low_energy_dbfs=-45.0):
    # P90 window energy is a signal diagnostic, not perceived loudness or speech coverage.
    # None disables this extra warning without changing pause/clipping observations.
    if low_energy_dbfs is not None and (isinstance(low_energy_dbfs,bool) or not isinstance(low_energy_dbfs,(int,float)) or not math.isfinite(low_energy_dbfs) or low_energy_dbfs>0):
        raise ValueError('Invalid low energy threshold')
    with wave.open(io.BytesIO(audio)) as w:
        if w.getsampwidth()!=2 or w.getcomptype()!='NONE':raise ValueError('PCM16 required')
        rate=w.getframerate();channels=w.getnchannels();nframes=w.getnframes();raw=w.readframes(nframes)
    samples=array.array('h');samples.frombytes(raw)
    if sys.byteorder!='little':samples.byteswap()
    if not nframes or len(samples)!=nframes*channels:raise ValueError('Invalid PCM frames')
    if window_seconds<=0 or min_silence_seconds<0:raise ValueError('Invalid window')
    duration=nframes/rate;window=max(1,round(rate*window_seconds));threshold=10**(silence_dbfs/20)
    segments=[];start=None;window_levels=[]
    for first in range(0,nframes,window):
        end=min(nframes,first+window);chunk=samples[first*channels:end*channels]
        rms=math.sqrt(sum(x*x for x in chunk)/len(chunk))/32768
        window_levels.append(rms)
        if rms<=threshold:
            if start is None:start=first
        elif start is not None:
            if (first-start)/rate>=min_silence_seconds:segments.append((start,first))
            start=None
    if start is not None and (nframes-start)/rate>=min_silence_seconds:segments.append((start,nframes))
    intervals=[{'start_seconds':a/rate,'end_seconds':b/rate,'duration_seconds':(b-a)/rate,'boundary':a==0 or b==nframes,'location':'whole_clip' if a==0 and b==nframes else 'leading' if a==0 else 'trailing' if b==nframes else 'internal'} for a,b in segments]
    peak=max(abs(x) for x in samples)/32768;rms=math.sqrt(sum(x*x for x in samples)/len(samples))/32768
    clipped=sum(x>=32767 or x<=-32768 for x in samples)
    # Nearest-rank percentile: equal-duration windows except the bounded final tail.
    p90=sorted(window_levels)[math.ceil(.9*len(window_levels))-1]
    energy_warnings=[]
    if low_energy_dbfs is not None and peak>0 and rms<=10**(low_energy_dbfs/20):
        energy_warnings.append({'code':'low_overall_energy','rms_dbfs':dbfs(rms),'window_rms_p90_dbfs':dbfs(p90),'threshold_dbfs':low_energy_dbfs,'message':'Whole-clip RMS signal energy is low; quiet passages and silence can lower this average. May be intentional quiet audio or planned silence; compare source, mix intent and playback context. Not proof of missing words or a quality failure.'})
    return {'schema':'studio-audio-signals-v1','duration_seconds':duration,'sample_rate':rate,'channels':channels,'rms_dbfs':dbfs(rms),'window_rms_p90_dbfs':dbfs(p90),'low_energy_warning_threshold_dbfs':low_energy_dbfs,'peak_dbfs':dbfs(peak),'digital_full_scale_samples':clipped,'digital_full_scale_ratio':clipped/len(samples),'silence_threshold_dbfs':silence_dbfs,'minimum_silence_seconds':min_silence_seconds,'window_seconds':window/rate,'silence_intervals':intervals,'warnings':energy_warnings+[{'code':'low_energy_interval','location':s['location'],'start_seconds':s['start_seconds'],'end_seconds':s['end_seconds'],'message':'May be natural pause, planned silence, or lost audio; compare voice/script and adjacent context.'} for s in intervals]+([{'code':'digital_full_scale_samples','message':'Digital full-scale samples observed; inspect sustained clipping and source before declaring distortion.'}] if clipped else []),'quality_verdict':None}
