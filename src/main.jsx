import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Download, Mic, Play, Square, Trash2, Scissors, SlidersHorizontal, Volume2 } from 'lucide-react';
import './style.css';

const DB_NAME = 'sampler-inteligente-db';
const STORE_NAME = 'samples';
const STEPS = 16;

function Button({ children, onClick, className = '', title, type = 'button' }) {
  return <button type={type} title={title} onClick={onClick} className={`btn ${className}`}>{children}</button>;
}

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) db.createObjectStore(STORE_NAME, { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function saveSample(sample) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).put(sample);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}

async function getSamples() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const req = tx.objectStore(STORE_NAME).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

async function deleteSample(id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).delete(id);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}

function classifyDuration(seconds) { return seconds < 1.5 ? 'corto' : seconds < 5 ? 'medio' : 'largo'; }
function classifyRegister(centroidHz) { return centroidHz < 350 ? 'grave' : centroidHz < 1800 ? 'medio' : 'agudo'; }
function classifyTimbre({ centroidHz, brightness, noisiness }) {
  if (noisiness > 0.28 && brightness > 0.45) return 'ruidoso / percusivo';
  if (brightness > 0.62 || centroidHz > 2200) return 'brillante / metálico';
  if (brightness < 0.32 || centroidHz < 500) return 'oscuro / opaco';
  return 'balanceado / cálido';
}
function getRms(data) { let sum = 0; for (let i = 0; i < data.length; i++) sum += data[i] * data[i]; return Math.sqrt(sum / Math.max(1, data.length)); }
function estimateZeroCrossingRate(data) {
  let crossings = 0;
  for (let i = 1; i < data.length; i++) if ((data[i - 1] < 0 && data[i] >= 0) || (data[i - 1] >= 0 && data[i] < 0)) crossings++;
  return crossings / Math.max(1, data.length);
}

async function analyzeAudio(blob) {
  const arrayBuffer = await blob.arrayBuffer();
  const audioCtx = new AudioContext();
  const audioBuffer = await audioCtx.decodeAudioData(arrayBuffer.slice(0));
  await audioCtx.close();
  const channel = audioBuffer.getChannelData(0);
  const sampleRate = audioBuffer.sampleRate;
  const duration = audioBuffer.duration;
  const frameSize = Math.floor(sampleRate * 0.04);
  const silenceThreshold = 0.016;
  const minSilenceFrames = 4;
  const minSegmentSeconds = 0.2;
  const rmsFrames = [];
  for (let i = 0; i < channel.length; i += frameSize) rmsFrames.push(getRms(channel.slice(i, Math.min(i + frameSize, channel.length))));
  const segments = [];
  let startFrame = null, silenceCount = 0;
  rmsFrames.forEach((rms, idx) => {
    const active = rms > silenceThreshold;
    if (active && startFrame === null) startFrame = idx;
    if (!active && startFrame !== null) silenceCount += 1;
    if (active) silenceCount = 0;
    if (startFrame !== null && silenceCount >= minSilenceFrames) {
      const endFrame = idx - silenceCount;
      const start = (startFrame * frameSize) / sampleRate;
      const end = (endFrame * frameSize) / sampleRate;
      if (end - start >= minSegmentSeconds) segments.push({ start, end });
      startFrame = null; silenceCount = 0;
    }
  });
  if (startFrame !== null) {
    const start = (startFrame * frameSize) / sampleRate;
    const end = duration;
    if (end - start >= minSegmentSeconds) segments.push({ start, end });
  }
  if (segments.length === 0) segments.push({ start: 0, end: duration });
  const slice = channel.slice(0, Math.min(channel.length, sampleRate * 2));
  const zcr = estimateZeroCrossingRate(slice);
  const rms = getRms(slice);
  const centroidHz = Math.min(5000, zcr * sampleRate * 1.8);
  const brightness = Math.min(1, centroidHz / 5000);
  const noisiness = Math.min(1, zcr * 8);
  return {
    duration,
    durationClass: classifyDuration(duration),
    centroidHz: Math.round(centroidHz),
    brightness: Number(brightness.toFixed(2)),
    noisiness: Number(noisiness.toFixed(2)),
    rms: Number(rms.toFixed(3)),
    register: classifyRegister(centroidHz),
    timbre: classifyTimbre({ centroidHz, brightness, noisiness }),
    segments: segments.map((seg, index) => ({ id: `${index + 1}`, name: `Slice ${index + 1}`, start: Number(seg.start.toFixed(3)), end: Number(seg.end.toFixed(3)), duration: Number((seg.end - seg.start).toFixed(3)) }))
  };
}

function downloadJSON(filename, data) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; a.click(); URL.revokeObjectURL(url);
}
function meterBars(value = 0.4) { return Array.from({ length: 12 }).map((_, i) => i / 12 < value); }

function App() {
  const [isRecording, setIsRecording] = useState(false);
  const [samples, setSamples] = useState([]);
  const [filter, setFilter] = useState('todos');
  const [status, setStatus] = useState('Listo para grabar.');
  const [selectedSampleId, setSelectedSampleId] = useState(null);
  const [tempo, setTempo] = useState(95);
  const [isPlayingPattern, setIsPlayingPattern] = useState(false);
  const [activeStep, setActiveStep] = useState(null);
  const [pattern, setPattern] = useState(Array.from({ length: STEPS }, () => ({ sampleId: null, sliceIndex: null })));
  const mediaRecorderRef = useRef(null), chunksRef = useRef([]), audioRefs = useRef({}), intervalRef = useRef(null), stepRef = useRef(0);
  async function refreshSamples() { const updated = await getSamples(); setSamples(updated.map((s) => ({ ...s, url: URL.createObjectURL(s.blob) }))); }
  useEffect(() => { refreshSamples().catch(() => setStatus('No pude cargar las grabaciones.')); return () => clearInterval(intervalRef.current); }, []);
  const selectedSample = samples.find((s) => s.id === selectedSampleId) || samples[0] || null;
  const filteredSamples = useMemo(() => filter === 'todos' ? samples : samples.filter((s) => s.durationClass === filter || s.register === filter || s.timbre === filter), [samples, filter]);
  async function startRecording() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mediaRecorder = new MediaRecorder(stream);
      mediaRecorderRef.current = mediaRecorder; chunksRef.current = [];
      mediaRecorder.ondataavailable = (e) => { if (e.data.size > 0) chunksRef.current.push(e.data); };
      mediaRecorder.onstop = async () => {
        setStatus('Analizando audio...');
        const blob = new Blob(chunksRef.current, { type: 'audio/webm' });
        const analysis = await analyzeAudio(blob);
        const sample = { id: crypto.randomUUID(), name: `Clip ${new Date().toLocaleTimeString()}`, createdAt: new Date().toISOString(), blob, ...analysis };
        await saveSample(sample); await refreshSamples(); setSelectedSampleId(sample.id); setStatus('Clip guardado, fragmentado y clasificado.');
      };
      mediaRecorder.start(); setIsRecording(true); setStatus('Grabando entrada de micrófono...');
    } catch { setStatus('No pude acceder al micrófono. Revisá permisos del navegador.'); }
  }
  function stopRecording() { mediaRecorderRef.current?.stop(); mediaRecorderRef.current?.stream?.getTracks().forEach((track) => track.stop()); setIsRecording(false); }
  function getAudio(sample) { if (!sample) return null; const audio = audioRefs.current[sample.id] || new Audio(sample.url); audioRefs.current[sample.id] = audio; return audio; }
  function playSample(sample) { const audio = getAudio(sample); if (!audio) return; audio.pause(); audio.currentTime = 0; audio.play(); }
  function playSlice(sample, slice) { const audio = getAudio(sample); if (!audio || !slice) return; audio.pause(); audio.currentTime = slice.start; audio.play(); setTimeout(() => audio.pause(), Math.max(80, (slice.end - slice.start) * 1000)); }
  async function removeSample(id) { await deleteSample(id); await refreshSamples(); setPattern((prev) => prev.map((step) => step.sampleId === id ? { sampleId: null, sliceIndex: null } : step)); }
  function assignToStep(stepIndex, sampleId, sliceIndex = null) { setPattern((prev) => { const next = [...prev]; const current = next[stepIndex]; const same = current.sampleId === sampleId && current.sliceIndex === sliceIndex; next[stepIndex] = same ? { sampleId: null, sliceIndex: null } : { sampleId, sliceIndex }; return next; }); }
  function triggerStep(step) { if (!step.sampleId) return; const sample = samples.find((s) => s.id === step.sampleId); if (!sample) return; if (step.sliceIndex !== null && sample.segments?.[step.sliceIndex]) playSlice(sample, sample.segments[step.sliceIndex]); else playSample(sample); }
  function startPattern() { clearInterval(intervalRef.current); setIsPlayingPattern(true); stepRef.current = 0; const stepMs = (60 / tempo / 4) * 1000; intervalRef.current = setInterval(() => { const stepIndex = stepRef.current % STEPS; setActiveStep(stepIndex); triggerStep(pattern[stepIndex]); stepRef.current += 1; }, stepMs); }
  function stopPattern() { clearInterval(intervalRef.current); setIsPlayingPattern(false); setActiveStep(null); }
  function exportPattern() { downloadJSON('patron-sampler-inteligente.json', { tempo, steps: pattern.map((step, index) => { const sample = samples.find((s) => s.id === step.sampleId); const slice = step.sliceIndex !== null ? sample?.segments?.[step.sliceIndex] : null; return { step: index + 1, sampleId: step.sampleId, sampleName: sample?.name || null, sliceIndex: step.sliceIndex, slice }; }) }); }
  const filterOptions = ['todos','corto','medio','largo','grave','agudo','ruidoso / percusivo','brillante / metálico','oscuro / opaco','balanceado / cálido'];
  const tracks = ['AUDIO 1','AUDIO 2','AUDIO 3','AUDIO 4'];
  return <div className="app"><div className="layout"><header className="topbar"><div className="brand"><div className="logo">S</div><div><h1>Sampler Inteligente</h1><p>Session View · análisis tímbrico · pads · slices</p></div></div><div className="transport"><Button onClick={isPlayingPattern ? stopPattern : startPattern} className="playbtn">{isPlayingPattern ? <Square size={16}/> : <Play size={16}/>}</Button><label>BPM <input type="number" min="40" max="220" value={tempo} onChange={(e)=>setTempo(Number(e.target.value))}/></label>{!isRecording ? <Button onClick={startRecording} className="recbtn"><Mic size={16}/> Rec</Button> : <Button onClick={stopRecording} className="stopbtn"><Square size={16}/> Stop</Button>}<Button onClick={exportPattern}><Download size={16}/></Button></div><div className="status">{status}</div></header><main className="main"><aside className="browser"><div className="browser-head"><b>Browser</b><select value={filter} onChange={(e)=>setFilter(e.target.value)}>{filterOptions.map((option)=><option key={option} value={option}>{option}</option>)}</select></div><div className="sample-list">{filteredSamples.length===0 ? <p>Grabá un clip para empezar.</p> : filteredSamples.map((sample)=><button key={sample.id} onClick={()=>setSelectedSampleId(sample.id)} onDoubleClick={()=>playSample(sample)} className={selectedSample?.id===sample.id?'selected':''}><span>{sample.name}</span><small>{sample.durationClass} · {sample.register} · {sample.timbre}</small></button>)}</div></aside><section className="session">{tracks.map((track, trackIndex)=><div key={track} className="track"><div className="track-head"><b>{track}</b><span></span></div><div className="clips">{Array.from({length:6}).map((_,clipIndex)=>{const sample=filteredSamples[trackIndex*6+clipIndex]; return <button key={clipIndex} onClick={()=>sample&&playSample(sample)} onDoubleClick={()=>sample&&setSelectedSampleId(sample.id)} className={sample?'clip filled':'clip'}>{sample ? <><div><b>{sample.name}</b><Play size={13}/></div><div className="wave">{meterBars(sample.rms + sample.brightness / 2).map((on,i)=><i key={i} className={on?'on':''} style={{height:`${20+((i*7)%26)}px`}} />)}</div><small>{sample.register} · {sample.timbre}</small></> : <small>Empty clip slot</small>}</button>})}</div><div className="mixer"><span>VOL <Volume2 size={13}/></span><div><i /></div></div></div>)}</section><aside className="inspector"><div className="inspector-head"><SlidersHorizontal size={16}/><b>Inspector</b></div>{!selectedSample ? <p className="empty">Seleccioná un clip.</p> : <div className="inspect-body"><section className="card"><div className="clip-title"><div><h2>{selectedSample.name}</h2><small>{selectedSample.duration.toFixed(2)}s · {selectedSample.segments?.length || 0} slices</small></div><Button onClick={()=>playSample(selectedSample)} className="playbtn"><Play size={16}/></Button></div><audio controls src={selectedSample.url}/><div className="stats"><span>Duración <b>{selectedSample.durationClass}</b></span><span>Registro <b>{selectedSample.register}</b></span><span>Timbre <b>{selectedSample.timbre}</b></span><span>Centroide <b>{selectedSample.centroidHz} Hz</b></span><span>Brillo / ruido <b>{selectedSample.brightness} / {selectedSample.noisiness}</b></span></div><Button onClick={()=>removeSample(selectedSample.id)}><Trash2 size={16}/> Borrar clip</Button></section><h3><Scissors size={16}/> Slices</h3><div className="slices">{selectedSample.segments?.map((slice,sliceIndex)=><div className="slice" key={slice.id}><div><button onClick={()=>playSlice(selectedSample,slice)}><b>{slice.name}</b><small>{slice.start}s → {slice.end}s</small></button><Button onClick={()=>playSlice(selectedSample,slice)}><Play size={13}/></Button></div><div className="slice-steps">{Array.from({length:STEPS}).map((_,stepIndex)=>{const active=pattern[stepIndex].sampleId===selectedSample.id&&pattern[stepIndex].sliceIndex===sliceIndex; return <button key={stepIndex} onClick={()=>assignToStep(stepIndex,selectedSample.id,sliceIndex)} className={active?'active':''}>{stepIndex+1}</button>})}</div></div>)}</div></div>}</aside></main><footer className="sequencer"><div className="seq-head"><div><b>Step Sequencer</b><p>Asigná slices desde el inspector.</p></div><span>1 bar · 16 steps · {tempo} BPM</span></div><div className="steps">{pattern.map((step,index)=>{const sample=samples.find((s)=>s.id===step.sampleId); const slice=step.sliceIndex!==null ? sample?.segments?.[step.sliceIndex] : null; const isActive=activeStep===index; return <button key={index} onClick={()=>triggerStep(step)} className={`${isActive?'now':''} ${step.sampleId?'has':''}`}><small>STEP {index+1}</small><b>{sample?.name || 'empty'}</b><small>{slice?.name || 'full clip'}</small></button>})}</div></footer></div></div>;
}

createRoot(document.getElementById('root')).render(<App />);
