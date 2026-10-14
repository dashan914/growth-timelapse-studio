// The short reference track is decoded once. Each seek/resume uses an offset
// into that buffer, so it never depends on a media element's pending seek/play.
export class PreviewSoundPlayer {
  constructor({url,createContext,fetchAudio=(...args)=>fetch(...args),onError=()=>{},onState=()=>{}}) {
    Object.assign(this,{url,createContext,fetchAudio,onError,onState});
    this.context=null;this.gain=null;this.buffer=null;this.loading=null;
    this.source=null;this.anchor=null;this.loadError=null;this.resumePending=null;
    this.unlocked=false;this.disposed=false;this.reported=false;
    this.desired={enabled:false,playing:false,time:0,volume:1};
  }
  _context() {
    if(!this.context){
      this.context=this.createContext();
      this.gain=this.context.createGain();this.gain.connect(this.context.destination);
    }
    return this.context;
  }
  preload({retry=false}={}) {
    if(this.disposed)return Promise.resolve(null);
    if(this.buffer)return Promise.resolve(this.buffer);
    if(this.loading)return this.loading;
    if(this.loadError&&!retry)return Promise.reject(this.loadError);
    this.loadError=null;
    this.loading=(async()=>{
      const response=await this.fetchAudio(this.url);
      if(!response.ok)throw new Error('音效文件读取失败。');
      const data=await response.arrayBuffer();
      if(this.disposed)return null;
      const buffer=await this._context().decodeAudioData(data);
      if(this.disposed)return null;
      if(!(buffer.duration>0))throw new Error('音效文件没有有效声音。');
      this.buffer=buffer;this._sync();return buffer;
    })().catch(error=>{
      if(!this.disposed){this.loadError=error;if(this.desired.enabled&&this.desired.playing)this._report(error);this._emit();}
      throw error;
    }).finally(()=>{this.loading=null;});
    this._emit();return this.loading;
  }
  // Call directly from Play/restart/checkbox events, before any async work.
  unlock() {
    if(this.disposed)return Promise.resolve();
    this.reported=false;
    let context;
    try{context=this._context();}catch(error){this._report(error);return Promise.reject(error);}
    this.preload({retry:true}).catch(()=>{});
    if(context.state==='running'){this.unlocked=true;this._sync();return Promise.resolve();}
    if(this.resumePending)return this.resumePending;
    this.resumePending=Promise.resolve(context.resume()).then(()=>{
      if(this.disposed)return;
      this.unlocked=context.state==='running';this._sync();
    }).catch(error=>{if(!this.disposed)this._report(error);throw error;})
      .finally(()=>{this.resumePending=null;});
    return this.resumePending;
  }
  update({enabled,playing,time,volume=1}) {
    this.desired={enabled:Boolean(enabled),playing:Boolean(playing),time:Math.max(0,Number(time)||0),volume:Math.min(1,Math.max(0,Number(volume)||0))};
    if(!this.disposed&&!this.buffer&&!this.loading&&!this.loadError)this.preload().catch(()=>{});
    this._sync();
  }
  pause() {this.desired.playing=false;this._stop();this._emit();}
  _stop() {
    const source=this.source;this.source=null;this.anchor=null;
    if(source){source.onended=null;try{source.stop();}catch{}source.disconnect();}
  }
  _sync() {
    if(this.disposed)return;
    const state=this.desired;
    if(!state.enabled||!state.playing){this._stop();this._emit();return;}
    if(!this.buffer){if(this.loadError)this._report(this.loadError);this._emit();return;}
    if(state.time>=this.buffer.duration){this._stop();this._emit();return;}
    if(!this.unlocked||this.context.state!=='running'){this._stop();this._emit();return;}
    this.gain.gain.value=state.volume;
    const position=this.anchor?this.anchor.offset+this.context.currentTime-this.anchor.clock:state.time;
    // Continuous frame updates leave the source alone. Only a genuine clock
    // discontinuity (including a loop restart) requires a new source.
    if(this.source&&Math.abs(position-state.time)<=.35){this._emit();return;}
    this._stop();
    const source=this.context.createBufferSource();source.buffer=this.buffer;source.loop=false;source.connect(this.gain);
    this.source=source;this.anchor={offset:state.time,clock:this.context.currentTime};
    source.onended=()=>{if(this.source===source){source.disconnect();this.source=null;this.anchor=null;this._emit();}};
    source.start(0,state.time);this._emit();
  }
  snapshot() {
    const state=this.desired,duration=this.buffer?.duration||0;
    const position=this.anchor?Math.min(duration,this.anchor.offset+this.context.currentTime-this.anchor.clock):Math.min(state.time,duration||state.time);
    const status=this.disposed?'closed':!state.enabled?'muted':this.loadError?'error':!this.buffer?'loading':!state.playing?'paused':state.time>=duration?'ended':this.source?'playing':'waiting';
    return {status,position,duration,ready:Boolean(this.buffer),active:Boolean(this.source)&&this.context?.state==='running'};
  }
  _emit(){this.onState(this.snapshot());}
  _report(error){if(!this.reported){this.reported=true;this.onError(error);}}
  dispose(){this.disposed=true;this._stop();this.context?.close?.().catch(()=>{});this._emit();}
}
