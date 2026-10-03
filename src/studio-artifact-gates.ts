export interface GateVerdict {
  gate: 'audio' | 'image' | 'composition' | 'render'
  passed: boolean
  evidence: Record<string, unknown>
  reason?: string
}

export function validateAudioGate(artifactPath: string, metadata: Record<string, unknown>): GateVerdict {
  const mean_volume = typeof metadata?.mean_volume === 'number' ? metadata.mean_volume : undefined;
  if (mean_volume !== undefined && mean_volume < -45) {
    return { gate: 'audio', passed: false, evidence: { mean_volume }, reason: `Volume too low: ${mean_volume}dB` };
  }
  return { gate: 'audio', passed: true, evidence: { mean_volume } };
}

export function validateImageGate(artifactPath: string, metadata: Record<string, unknown>): GateVerdict {
  const alpha_channel = metadata?.alpha_channel;
  if (alpha_channel === false) {
    return { gate: 'image', passed: false, evidence: { alpha_channel }, reason: 'Missing alpha channel' };
  }
  return { gate: 'image', passed: true, evidence: { alpha_channel } };
}

export function validateCompositionGate(compositionDir: string): GateVerdict {
  return { gate: 'composition', passed: true, evidence: {} };
}

export function validateRenderGate(videoPath: string, metadata: Record<string, unknown>): GateVerdict {
  return { gate: 'render', passed: true, evidence: {} };
}

export function runStudioGates(artifactPaths: string[], metadata: Record<string, unknown>): GateVerdict[] {
  const verdicts: GateVerdict[] = [];
  for (const p of artifactPaths) {
    if (p.endsWith('.wav') || p.endsWith('.mp3')) verdicts.push(validateAudioGate(p, metadata));
    else if (p.endsWith('.png') || p.endsWith('.jpg')) verdicts.push(validateImageGate(p, metadata));
    else if (p.endsWith('.json') || p.endsWith('.html')) verdicts.push(validateCompositionGate(p));
    else if (p.endsWith('.mp4')) verdicts.push(validateRenderGate(p, metadata));
  }
  return verdicts;
}
