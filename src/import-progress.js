const PHASES=Object.freeze({
  slicer:{label:'检查本机切片器',message:'正在检查所选的本机切片器…'},
  upload:{label:'准备原模型',message:'正在将完整原模型交给本机切片器…'},
  preparing:{label:'检查原模型',message:'正在保留原网格、涂色与盘位…'},
  slicing:{label:'本机切片',message:'正在计算真实墙线、填充和支撑…'},
  read:{label:'读取文件',message:'正在读取本机文件…'},
  inspect:{label:'检查切片工程',message:'正在检查工程中的切片数据…'},
  extract:{label:'提取打印路径',message:'正在读取工程内的原始打印路径…'},
  configuration:{label:'读取切片参数',message:'正在读取工程中的层高、线宽和耗材设置…'},
  parse:{label:'解析打印路径',message:'正在解析层高、线宽和耗材颜色…'},
  index:{label:'建立层索引',message:'正在整理每层打印路径与支撑…'},
  surface:{label:'优化模型显示',message:'正在生成连续表面，保护边角和颜色边界…'},
  model:{label:'载入模型',message:'正在载入模型与原始颜色…'},
  preview:{label:'准备模型预览',message:'正在整理模型与原始颜色…'},
  render:{label:'准备预览',message:'正在准备模型预览…'},
  hashing:{label:'核对原始文件',message:'正在核对工程和原始打印路径…'},
  complete:{label:'切片数据已就绪',message:'正在继续准备模型预览…'}
});
const ALIASES=Object.freeze({reading:'read',directory:'inspect',unpacking:'extract','cad-preview':'preview',inspecting:'inspect',extracting:'extract',parsing:'parse',indexing:'index',rendering:'render'});

function measuredProgress({progress,completed,total}){
  if(typeof progress==='number'&&Number.isFinite(progress)&&progress>=0&&progress<=1)return progress;
  if(typeof completed==='number'&&typeof total==='number'&&Number.isFinite(completed)&&Number.isFinite(total)&&total>0&&completed>=0&&completed<=total)return completed/total;
  return null;
}

/** Compact import feedback. Percentages reflect measured work in this stage,
 * never elapsed time or a weighted estimate across unrelated stages. */
export function createImportProgressUI({document=globalThis.document,onCancel}={}){
  const get=id=>{
    const element=document?.getElementById(id);
    if(!element)throw new Error(`Missing import progress element: ${id}`);
    return element;
  };
  const region=get('import-progress'),phase=get('import-phase'),percent=get('import-percent'),meter=get('import-meter'),message=get('import-message'),cancel=get('cancel-import');
  let active=false,cancelRequested=false,disposed=false;
  function clearMeasurement(){
    meter.removeAttribute('value');percent.textContent='';percent.hidden=true;
    meter.removeAttribute('aria-valuetext');
  }
  function showState(state,busy){
    region.hidden=false;region.dataset.state=state;region.setAttribute('aria-busy',String(busy));
    cancel.hidden=!busy;cancel.disabled=!busy;meter.hidden=!busy;
  }
  function canceling(){
    if(disposed||!active)return;
    cancelRequested=true;showState('canceling',true);clearMeasurement();
    phase.textContent='正在取消导入';meter.setAttribute('aria-label','正在取消导入');
    message.textContent='正在停止读取和处理…';cancel.textContent='正在取消…';cancel.disabled=true;
  }
  function handleCancel(){
    if(disposed||!active||cancelRequested)return;
    canceling();onCancel?.();
  }
  cancel.addEventListener('click',handleCancel);
  function update(detail={}){
    if(disposed||!active||cancelRequested)return;
    const key=ALIASES[detail.phase]||detail.phase,stage=PHASES[key]||{label:'正在导入',message:'正在处理切片工程…'};
    phase.textContent=stage.label;meter.setAttribute('aria-label',`${stage.label}进度`);
    message.textContent=detail.message||stage.message;
    const ratio=key==='configuration'?null:measuredProgress(detail);
    if(ratio===null){clearMeasurement();return;}
    meter.setAttribute('value',String(ratio));
    percent.textContent=`${ratio===1?100:Math.floor(ratio*100)}%`;percent.hidden=false;
    meter.setAttribute('aria-valuetext',`${stage.label}，${percent.textContent}`);
  }
  function finish(state,label,text){
    if(disposed)return;
    active=false;cancelRequested=false;showState(state,false);clearMeasurement();
    phase.textContent=label;message.textContent=text;cancel.textContent='取消导入';
  }
  function reset(){
    active=false;cancelRequested=false;region.hidden=true;region.dataset.state='idle';
    region.setAttribute('aria-busy','false');phase.textContent='正在导入';message.textContent='';
    cancel.hidden=true;cancel.disabled=true;cancel.textContent='取消导入';meter.hidden=false;clearMeasurement();
  }
  reset();
  return {
    get cancelEnabled(){return active&&!cancelRequested&&!disposed;},
    begin(name){
      if(disposed)return;
      active=true;cancelRequested=false;showState('loading',true);cancel.textContent='取消导入';
      update({phase:'read',message:name?`正在读取“${name}”…`:PHASES.read.message});
    },
    update,
    complete(text='已导入，可以预览生长过程。'){finish('complete','导入完成',text);},
    fail(text='未能导入，原项目已保留；请选择 3MF 或 STL 后重试。'){finish('error','导入未完成',text);},
    cancelled(text='已取消切片，原项目已保留。'){finish('cancelled','已取消导入',text);},
    canceling,
    reset,
    dispose(){if(disposed)return;reset();cancel.removeEventListener('click',handleCancel);disposed=true;}
  };
}
